/**
 * The authoritative loop. Exactly one client runs this at a time — see
 * players.ts for how the host is elected. It owns:
 *   - the round clock and the 10-minute reset
 *   - topping the world back up to MAX_TILES tiles every 60 s
 *   - applying board placements and awarding points
 *   - reclaiming tiles held by players who disconnected, and tiles sitting
 *     uncollected in the world too long (see STALE_WORLD_MS)
 */

import { Transform } from '@dcl/sdk/ecs'
import { engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { MessageBus } from '@dcl/sdk/message-bus'
import { isStateSyncronized } from '@dcl/sdk/network'
import {
  ABANDON_MS,
  HOST_TICK_MS,
  MAX_TILES,
  MSG_REJECT,
  MSG_ROUND_END,
  MSG_SUBMIT,
  MSG_TOAST,
  RejectMessage,
  RoundEndMessage,
  SubmitRequest,
  ROUND_LENGTH_MS,
  SPAWN_BATCH,
  SPAWN_INTERVAL_MS,
  STALE_WORLD_MS,
  TileStatus,
  ToastMessage
} from './config'
import {
  BOARD_X0,
  BOARD_Z0,
  BOARD_N,
  BOARD_CELL_SIZE,
  FIXED_LETTER_ANCHORS,
  GUARANTEED_SPAWNS,
  TILE_ANCHORS,
  ZONE_NAMES,
  ZoneName
} from './generated/layout'
import {
  BoardState,
  RoundState,
  ScoreState,
  TileState,
  boardEntity,
  emptyBoard,
  roundEntity,
  scoreEntity,
  tileEntities
} from './state'
import { connectedAddresses, isHost } from './players'
import { evaluateSubmission } from './board'
import { drawLetter, charToLetter } from './letters'

let bus: MessageBus
let accum = 0
let zoneCursor = 0
const handledNonces = new Set<string>()

export function setupHost(messageBus: MessageBus): void {
  bus = messageBus
  bus.on(MSG_SUBMIT, (request: SubmitRequest) => {
    if (!isHost()) return
    applySubmit(request)
  })
  engine.addSystem(hostSystem)
}

function hostSystem(dt: number): void {
  accum += dt * 1000
  if (accum < HOST_TICK_MS) return
  accum = 0
  if (!isStateSyncronized()) return
  if (!isHost()) return

  const round = RoundState.getOrNull(roundEntity)
  if (!round) return
  const now = Date.now()

  if (round.endsAt === 0) {
    startRound(1, now)
    return
  }
  if (now >= round.endsAt) {
    startRound(round.roundId + 1, now)
    return
  }
  if (now >= round.nextSpawnAt) {
    spawnTiles()
    RoundState.getMutable(roundEntity).nextSpawnAt = now + SPAWN_INTERVAL_MS
  }

  reclaimAbandonedTiles(now)
}

/* ------------------------------------------------------------------ *
 * Round lifecycle
 * ------------------------------------------------------------------ */

function startRound(roundId: number, now: number): void {
  // roundId === 1 is the very first round the scene ever runs — there is no
  // previous round to declare a winner for.
  if (roundId > 1) {
    const previous = ScoreState.getOrNull(scoreEntity)
    let bestIndex = -1
    if (previous && previous.addresses.length) {
      bestIndex = 0
      for (let i = 1; i < previous.points.length; i++) {
        if (previous.points[i] > previous.points[bestIndex]) bestIndex = i
      }
    }
    const announcement: RoundEndMessage = {
      roundId: roundId - 1,
      name: bestIndex >= 0 ? previous!.names[bestIndex] || 'Player' : '',
      points: bestIndex >= 0 ? previous!.points[bestIndex] || 0 : 0
    }
    bus.emit(MSG_ROUND_END, announcement)
  }

  BoardState.getMutable(boardEntity).cells = emptyBoard()

  const scores = ScoreState.getMutable(scoreEntity)
  scores.addresses = []
  scores.names = []
  scores.points = []
  scores.words = []
  scores.scoredRuns = []

  for (const tile of tileEntities) {
    const state = TileState.getMutable(tile)
    state.status = TileStatus.FREE
    state.holder = ''
    state.roundId = roundId
    state.updatedAt = now
    Transform.getMutable(tile).position = Vector3.create(0, -50, 0)
  }

  // Fixed-letter landmarks (pyramid tunnel ends) go straight back out
  // immediately — they don't wait for the batched spawnTiles() cycle like
  // ordinary tiles, so they're guaranteed to be there from the start of
  // every round, not just "eventually" a few seconds in.
  for (let i = 0; i < FIXED_LETTER_ANCHORS.length; i++) placePinnedTile(i, now, roundId)

  // Guaranteed-spawn spots — same immediate treatment, explicitly required
  // to always have a tile from the moment a round starts.
  for (let i = 0; i < GUARANTEED_SPAWNS.length; i++) placeGuaranteedTile(i, now, roundId)

  // DEBUG ONLY — remove when done debugging. Drops 3 easy, always-available
  // pickup tiles just north of the board (past its top edge) so there's no
  // need to trek out to a zone every time the round resets while testing.
  spawnDebugTiles(roundId, now)

  const round = RoundState.getMutable(roundEntity)
  round.roundId = roundId
  round.endsAt = now + ROUND_LENGTH_MS
  round.nextSpawnAt = 0

  handledNonces.clear()
}

// DEBUG ONLY — remove this whole function when done debugging.
function spawnDebugTiles(roundId: number, now: number): void {
  const boardCenterX = BOARD_X0 + (BOARD_N * BOARD_CELL_SIZE) / 2
  const northZ = BOARD_Z0 + BOARD_N * BOARD_CELL_SIZE + 3 // a few metres past the board's north edge
  const offsets = [-4, 0, 4]
  for (let n = 0; n < offsets.length && n < tileEntities.length; n++) {
    const tile = tileEntities[n]
    Transform.getMutable(tile).position = Vector3.create(boardCenterX + offsets[n], 0.9, northZ)
    const state = TileState.getMutable(tile)
    state.letter = drawLetter()
    state.status = TileStatus.IN_WORLD
    state.holder = ''
    state.roundId = roundId
    state.updatedAt = now
  }
}

/* ------------------------------------------------------------------ *
 * Tile spawning
 * ------------------------------------------------------------------ */

// x/z of every tile currently lying in the world — an anchor near one of
// these is "occupied" and must not get a second tile stacked on top of it.
// That used to happen because anchors were picked purely at random each
// spawn/reclaim, with no check for whether a still-uncollected tile from an
// earlier cycle was already sitting there; a player picking up the visible
// tile would silently also end up carrying the hidden one stacked underneath.
function liveTilePositions(): Array<[number, number]> {
  const positions: Array<[number, number]> = []
  for (const tile of tileEntities) {
    const state = TileState.getOrNull(tile)
    if (!state || state.status !== TileStatus.IN_WORLD) continue
    const t = Transform.getOrNull(tile)
    if (t) positions.push([t.position.x, t.position.z])
  }
  return positions
}

/**
 * Fixed-letter landmarks (currently the pyramid's two tunnel ends — see
 * gen-world.mjs's SOUTH_PYRAMID_Q_LOCAL/Z_LOCAL) reserve the LAST
 * `FIXED_LETTER_ANCHORS.length` slots of the tile pool. Those tile entities
 * never go through the normal random zone/anchor/letter spawn path — they
 * always return to their own designated spot with their own designated
 * letter. Computed lazily (not a top-level const) because tileEntities isn't
 * populated until createSyncedState() runs, which happens before
 * setupHost() but after this module's own top-level code runs.
 */
function pinnedTileIndex(i: number): number {
  return tileEntities.length - FIXED_LETTER_ANCHORS.length + i
}

/** Which FIXED_LETTER_ANCHORS entry `index` is reserved for, or -1 if it's an ordinary tile slot. */
function pinnedAnchorIndexFor(index: number): number {
  const start = tileEntities.length - FIXED_LETTER_ANCHORS.length
  return index >= start ? index - start : -1
}

/** Place fixed-letter landmark `i` at its designated spot, in the world, right now.
 * `roundId` is omitted (left untouched) for the reclaim case, which never touched it before either. */
function placePinnedTile(i: number, now: number, roundId?: number): void {
  const fixed = FIXED_LETTER_ANCHORS[i]
  const tile = tileEntities[pinnedTileIndex(i)]
  Transform.getMutable(tile).position = Vector3.create(fixed.pos[0], fixed.pos[1], fixed.pos[2])
  const state = TileState.getMutable(tile)
  state.letter = charToLetter(fixed.letter)
  state.status = TileStatus.IN_WORLD
  state.holder = ''
  if (roundId !== undefined) state.roundId = roundId
  state.updatedAt = now
}

/**
 * Guaranteed-spawn spots (see gen-world.mjs's addGuaranteedSpawn) reserve the
 * `GUARANTEED_SPAWNS.length` slots immediately BEFORE the fixed-letter block
 * above — same idea (a dedicated tile entity permanently tied to one spot),
 * except the letter is drawn fresh each placement instead of fixed. These
 * exist for spots the user has explicitly required to always have a tile,
 * not just be eligible for the random zone/anchor picker like the ordinary
 * `anchors` pool.
 */
function guaranteedTileIndex(i: number): number {
  return tileEntities.length - FIXED_LETTER_ANCHORS.length - GUARANTEED_SPAWNS.length + i
}

/** Which GUARANTEED_SPAWNS entry `index` is reserved for, or -1 if it isn't one. */
function guaranteedAnchorIndexFor(index: number): number {
  const start = tileEntities.length - FIXED_LETTER_ANCHORS.length - GUARANTEED_SPAWNS.length
  const end = tileEntities.length - FIXED_LETTER_ANCHORS.length
  return index >= start && index < end ? index - start : -1
}

/** Place guaranteed-spawn `i` at its designated spot, in the world, right now, with a freshly drawn letter.
 * `roundId` is omitted (left untouched) for the reclaim case, matching placePinnedTile. */
function placeGuaranteedTile(i: number, now: number, roundId?: number): void {
  const spot = GUARANTEED_SPAWNS[i]
  const tile = tileEntities[guaranteedTileIndex(i)]
  Transform.getMutable(tile).position = Vector3.create(spot.pos[0], spot.pos[1], spot.pos[2])
  const state = TileState.getMutable(tile)
  state.letter = drawLetter()
  state.status = TileStatus.IN_WORLD
  state.holder = ''
  if (roundId !== undefined) state.roundId = roundId
  state.updatedAt = now
}

// Big enough to cover the +/-0.3 m spawn jitter on both the existing tile and
// the new one, so two tiles can never end up close enough to visually overlap
// even if they land at slightly different anchors.
const CLEAR_RADIUS_SQ = 1

/** Pick an anchor from `zone` that nothing is currently sitting on, if one exists. */
function pickClearAnchor(
  zone: ZoneName,
  occupied: Array<[number, number]>
): readonly [number, number, number] {
  const anchors = TILE_ANCHORS[zone]
  const clear = anchors.filter((anchor) =>
    occupied.every(([ox, oz]) => {
      const dx = ox - anchor[0]
      const dz = oz - anchor[2]
      return dx * dx + dz * dz >= CLEAR_RADIUS_SQ
    })
  )
  // If the whole zone happens to be full, fall back to any anchor rather than
  // skip the spawn — a rare visible overlap beats a tile never appearing.
  const pool = clear.length ? clear : anchors
  return pool[Math.floor(Math.random() * pool.length)]
}

function spawnTiles(): void {
  const round = RoundState.getOrNull(roundEntity)
  if (!round) return

  let live = 0
  const free: number[] = []
  for (let i = 0; i < tileEntities.length; i++) {
    const state = TileState.getOrNull(tileEntities[i])
    if (!state) continue
    if (state.status === TileStatus.FREE) free.push(i)
    else live++
  }

  const budget = Math.min(SPAWN_BATCH, MAX_TILES - live, free.length)
  const now = Date.now()
  const occupied = liveTilePositions()

  for (let n = 0; n < budget; n++) {
    const index = free[n]

    // A fixed-letter landmark that got picked up and submitted/consumed —
    // send it straight back to its own designated spot+letter instead of
    // the normal random zone/anchor/letter treatment.
    const pinned = pinnedAnchorIndexFor(index)
    if (pinned !== -1) {
      placePinnedTile(pinned, now, round.roundId)
      const fixed = FIXED_LETTER_ANCHORS[pinned]
      occupied.push([fixed.pos[0], fixed.pos[2]])
      continue
    }

    // A guaranteed-spawn spot that got picked up and submitted/consumed —
    // same immediate-return treatment, fresh random letter.
    const guaranteed = guaranteedAnchorIndexFor(index)
    if (guaranteed !== -1) {
      placeGuaranteedTile(guaranteed, now, round.roundId)
      const spot = GUARANTEED_SPAWNS[guaranteed]
      occupied.push([spot.pos[0], spot.pos[2]])
      continue
    }

    const zone = ZONE_NAMES[zoneCursor % ZONE_NAMES.length] as ZoneName
    zoneCursor++
    if (!TILE_ANCHORS[zone].length) continue
    const anchor = pickClearAnchor(zone, occupied)

    const px = anchor[0] + (Math.random() - 0.5) * 0.6
    const pz = anchor[2] + (Math.random() - 0.5) * 0.6
    Transform.getMutable(tileEntities[index]).position = Vector3.create(px, anchor[1], pz)
    const state = TileState.getMutable(tileEntities[index])
    state.letter = drawLetter()
    state.status = TileStatus.IN_WORLD
    state.holder = ''
    state.roundId = round.roundId
    state.updatedAt = now

    // This batch's own placement blocks its anchor for the rest of the batch too.
    occupied.push([px, pz])
  }
}

/**
 * Return tiles to the wild when their holder is no longer in the scene, AND
 * re-anchor tiles that have sat IN_WORLD uncollected too long (see
 * STALE_WORLD_MS's own comment in config.ts — this is what stops a tile
 * dropped somewhere unreachable from squatting on the MAX_TILES budget for
 * the rest of the round).
 */
function reclaimAbandonedTiles(now: number): void {
  const present = connectedAddresses()
  const occupied = liveTilePositions()
  for (let index = 0; index < tileEntities.length; index++) {
    const tile = tileEntities[index]
    const state = TileState.getOrNull(tile)
    if (!state) continue

    const heldAbandoned =
      state.status === TileStatus.HELD &&
      present.indexOf(state.holder) === -1 &&
      now - state.updatedAt >= ABANDON_MS
    const worldStale = state.status === TileStatus.IN_WORLD && now - state.updatedAt >= STALE_WORLD_MS
    if (!heldAbandoned && !worldStale) continue

    // A fixed-letter landmark abandoned/stale — back to its own spot, not a
    // random zone (never touches roundId here, matching what this function
    // already did for ordinary tiles below).
    const pinned = pinnedAnchorIndexFor(index)
    if (pinned !== -1) {
      placePinnedTile(pinned, now)
      const fixed = FIXED_LETTER_ANCHORS[pinned]
      occupied.push([fixed.pos[0], fixed.pos[2]])
      continue
    }

    // A guaranteed-spawn spot abandoned/stale — same treatment, back to its
    // own fixed position with a fresh letter.
    const guaranteed = guaranteedAnchorIndexFor(index)
    if (guaranteed !== -1) {
      placeGuaranteedTile(guaranteed, now)
      const spot = GUARANTEED_SPAWNS[guaranteed]
      occupied.push([spot.pos[0], spot.pos[2]])
      continue
    }

    const zone = ZONE_NAMES[zoneCursor++ % ZONE_NAMES.length] as ZoneName
    if (!TILE_ANCHORS[zone].length) continue
    const anchor = pickClearAnchor(zone, occupied)
    Transform.getMutable(tile).position = Vector3.create(anchor[0], anchor[1], anchor[2])
    const mutable = TileState.getMutable(tile)
    mutable.status = TileStatus.IN_WORLD
    mutable.holder = ''
    mutable.updatedAt = now
    occupied.push([anchor[0], anchor[2]])
  }
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

/**
 * Authoritatively validate and commit (or reject) a whole submitted turn.
 *
 * The submitting client already ran this same check locally before sending —
 * this is the re-check against the CURRENT board, which only disagrees in a
 * genuine race (another player's submission landed in between).
 *
 * Rejection costs the player nothing: their tiles are still HELD by them, so
 * there is no refund to perform and no way for a dropped message to destroy
 * them. Consuming the tiles is the LAST thing done, only once the word is
 * known good — see `consumeTiles`.
 */
function applySubmit(request: SubmitRequest): void {
  const key = `${request.address}:${request.nonce}`
  if (handledNonces.has(key)) return
  handledNonces.add(key)

  const board = BoardState.getOrNull(boardEntity)
  const scores = ScoreState.getOrNull(scoreEntity)
  if (!board || !scores) return

  // Every cell in the submission must still be empty on the authoritative board.
  for (const p of request.placements) {
    if (p.cell < 0 || p.cell >= board.cells.length || board.cells[p.cell] !== 0) {
      reject(request, 'Someone else took that square')
      return
    }
  }

  // ...and every tile must really be in the submitter's bag, carrying the
  // letter they claim. Stops a malformed or hostile client conjuring letters,
  // and catches the harmless case where the host hasn't yet received the CRDT
  // update for a tile picked up a moment ago (the player just resubmits).
  if (!ownsTiles(request)) {
    reject(request, 'Those tiles are not in your bag')
    return
  }

  const result = evaluateSubmission(board.cells, request.placements, scores.scoredRuns)
  if (!result.ok) {
    reject(request, result.reason)
    return
  }

  const cells = board.cells.slice()
  for (const p of request.placements) cells[p.cell] = p.letter + 1
  BoardState.getMutable(boardEntity).cells = cells
  consumeTiles(request)

  if (result.points > 0) {
    const mutable = ScoreState.getMutable(scoreEntity)
    let index = mutable.addresses.indexOf(request.address)
    if (index === -1) {
      mutable.addresses.push(request.address)
      mutable.names.push(request.name)
      mutable.points.push(0)
      mutable.words.push(0)
      index = mutable.addresses.length - 1
    }
    mutable.names[index] = request.name
    mutable.points[index] = (mutable.points[index] || 0) + result.points
    mutable.words[index] = (mutable.words[index] || 0) + result.words.length
    for (const runKey of result.newRunKeys) mutable.scoredRuns.push(runKey)
    // Keep the scored-run list bounded so the component stays small.
    if (mutable.scoredRuns.length > 400) {
      mutable.scoredRuns = mutable.scoredRuns.slice(mutable.scoredRuns.length - 400)
    }

    const toast: ToastMessage = {
      address: request.address,
      name: request.name,
      word: result.words[0],
      points: result.points
    }
    bus.emit(MSG_TOAST, toast)
  }
}

/** True when every tile named in the request is HELD by the submitter with the claimed letter. */
function ownsTiles(request: SubmitRequest): boolean {
  const seen = new Set<number>()
  for (const p of request.placements) {
    if (p.tile < 0 || p.tile >= tileEntities.length) return false
    if (seen.has(p.tile)) return false // the same tile used twice in one turn
    seen.add(p.tile)
    const state = TileState.getOrNull(tileEntities[p.tile])
    if (!state) return false
    if (state.status !== TileStatus.HELD) return false
    if (state.holder !== request.address) return false
    if (state.letter !== p.letter) return false
  }
  return true
}

/**
 * Retire the submitted tiles back to the free pool. Only ever called after a
 * submission has been fully validated AND the board write has happened, so
 * there is no window in which a tile is destroyed for a word that didn't land.
 */
function consumeTiles(request: SubmitRequest): void {
  const now = Date.now()
  for (const p of request.placements) {
    const tile = tileEntities[p.tile]
    const mutable = TileState.getMutable(tile)
    mutable.status = TileStatus.FREE
    mutable.holder = ''
    mutable.updatedAt = now
    Transform.getMutable(tile).position = Vector3.create(0, -50, 0)
  }
}

/**
 * Tell the submitter their turn didn't land. Nothing else is needed: their
 * tiles were never taken away, so this is purely so they see WHY rather than
 * watching their staged word silently pop back into their bag.
 */
function reject(request: SubmitRequest, reason: string): void {
  const message: RejectMessage = { address: request.address, reason }
  bus.emit(MSG_REJECT, message)
}
