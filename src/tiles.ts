/**
 * Client-side tile handling: walking over a tile picks it up, E stages it on
 * the board cell you are standing on, F either submits the staged word(s) (if
 * any are staged) or drops the selected bag tile (if none are). On desktop
 * [1] drops the selected tile outright and [2]/[3] cycle the selection.
 *
 * Placing a tile is NOT a submission by itself — it only stages a local
 * preview. Nothing reaches the host, and the tile never actually leaves your
 * bag's underlying state, until you submit. On submit every word the staged
 * tiles form (checked both horizontally and vertically, same as real
 * Scrabble) has to be real; if any of them isn't, the whole turn is rejected
 * and every staged tile goes back to your bag. See board.ts's
 * `evaluateSubmission` for the actual rule.
 *
 * Pickups are written straight to the CRDT by the client that owns the
 * action. Two players grabbing the same tile in the same frame resolve
 * last-write-wins, so every pickup is re-verified a moment later and silently
 * rolled back if someone else won.
 */

import { engine, Entity, InputAction, inputSystem, PointerEventType, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { MessageBus } from '@dcl/sdk/message-bus'
import {
  DROP_DISTANCE,
  MAX_INVENTORY,
  MSG_REJECT,
  MSG_ROUND_END,
  MSG_SUBMIT,
  MSG_TOAST,
  PICKUP_RADIUS,
  RejectMessage,
  RoundEndMessage,
  SubmitRequest,
  TileStatus,
  ToastMessage
} from './config'
import { TileState, tileEntities, getBoardCells, getRound } from './state'
import { myAddress, myName, myPosition } from './players'
import { targetCell, mergeStaged, evaluateSubmission, metresOutsideBoard, Placement } from './board'
import { letterChar } from './letters'
import { showHighlight, showStagedLetter, clearStagedLetter, clearAllStagedLetters } from './view'
import { quality } from './platform'
import {
  playAcceptedSound,
  playPickupSound,
  playPlaceSound,
  playRejectedSound,
  playSelectSound,
  playVictorySound
} from './sfx'

let bus: MessageBus

export type InventorySlot = { entity: Entity; letter: number }
type StagedPlacement = { entity: Entity; letter: number; cell: number }

let inventory: InventorySlot[] = []
let selected = 0
/** Cell the next placement would land on, refreshed every frame. */
let hoveredCell = -1
let hoverLegal = false
let hoverReason = ''
let nonceCounter = 1

/** This turn's not-yet-submitted placements. Purely local until submit. */
let staged: StagedPlacement[] = []
/** Tiles currently staged — excluded from `inventory` display, but their
 * TileState is untouched (still HELD by us) right through submission; only
 * the host ever retires them, and only once the word has landed. */
const stagedEntities = new Set<Entity>()

/** How long to wait for the host to rule on a submitted turn before assuming
 * it was lost. Generous: a wrong guess here just delays the player, it can't
 * cost them tiles. */
const SUBMIT_TIMEOUT_MS = 8000
/** Deadline for the turn currently out with the host; 0 when nothing is in flight. */
let awaitingHostUntil = 0

export const isAwaitingHost = (): boolean => awaitingHostUntil !== 0

/**
 * Metres beyond the board's edge at which a staged-but-unsubmitted word is
 * given back. Comfortably clear of the 1.5-cell tolerance `targetCell`
 * already allows, so stepping just off the edge to line up a placement never
 * cancels — this is for someone who has actually left to go tile hunting.
 */
const STAGE_CANCEL_DISTANCE = 10

/** Filled cells last time we looked, for spotting another player's commit. */
let lastFilledCount = -1

function filledCellCount(): number {
  const cells = getBoardCells()
  let n = 0
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) n++
  return n
}

/**
 * Hand a staged word back, unsubmitted. Safe at any time: staged tiles are
 * still HELD by us in TileState, so this is purely local bookkeeping.
 */
function cancelStaging(reason: string): void {
  if (!staged.length) return
  unstageAll()
  pushToast(reason, false, 3000)
}

/** Pending pickups awaiting the contest re-check: entity -> deadline ms. */
const pendingPickups = new Map<Entity, number>()

/* ------------------------------------------------------------------ *
 * Public read API (consumed by the UI)
 * ------------------------------------------------------------------ */

export const getInventory = (): InventorySlot[] => inventory
export const getSelectedIndex = (): number => selected
export const getHoveredCell = (): number => hoveredCell
export const getHoverReason = (): string => hoverReason
export const getStagedCount = (): number => staged.length

export function selectSlot(index: number): void {
  if (index >= 0 && index < inventory.length) {
    selected = index
    playSelectSound()
  }
}

export function cycleSelection(delta: number): void {
  if (!inventory.length) return
  selected = (selected + delta + inventory.length) % inventory.length
  playSelectSound()
}

/**
 * Drop the tile from the LOCAL inventory the instant we act on it, instead of
 * waiting for `inventorySystem`'s next throttled scan (up to `inventoryInterval`
 * seconds away, worse on mobile) to notice the TileState write. The scan still
 * runs afterwards and is a harmless no-op here — it's what re-adds the tile if
 * the host later rejects the placement and refunds it.
 */
function removeFromInventory(entity: Entity): void {
  inventory = inventory.filter((s) => s.entity !== entity)
  if (selected >= inventory.length) selected = Math.max(0, inventory.length - 1)
}

/** Undo staging for every currently-staged tile: back in the bag, right away. */
function unstageAll(): void {
  for (const s of staged) {
    stagedEntities.delete(s.entity)
    clearStagedLetter(s.cell)
    if (!inventory.some((slot) => slot.entity === s.entity)) {
      inventory.push({ entity: s.entity, letter: s.letter })
    }
  }
  inventory.sort((a, b) => (a.entity as number) - (b.entity as number))
  staged = []
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export type Toast = { text: string; until: number; good: boolean }
let toasts: Toast[] = []

export function pushToast(text: string, good = true, ms = 3500): void {
  toasts.push({ text, until: Date.now() + ms, good })
  if (toasts.length > 4) toasts.shift()
}

export function activeToasts(): Toast[] {
  const now = Date.now()
  toasts = toasts.filter((t) => t.until > now)
  return toasts
}

/* ------------------------------------------------------------------ *
 * Winner banner — a big, brief, centre-screen announcement when a
 * round's clock runs out, separate from the small scrolling toasts.
 * ------------------------------------------------------------------ */

const WINNER_BANNER_MS = 6000
let winnerBanner: { text: string; until: number } | null = null

/** Current winner banner text, or null when none should be shown. */
export function getWinnerBanner(): string | null {
  if (!winnerBanner) return null
  if (Date.now() >= winnerBanner.until) {
    winnerBanner = null
    return null
  }
  return winnerBanner.text
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export function setupTileInteractions(messageBus: MessageBus): void {
  bus = messageBus

  bus.on(MSG_TOAST, (msg: ToastMessage) => {
    const mine = msg.address === myAddress()
    pushToast(
      `${mine ? 'You' : msg.name} scored ${msg.points} with ${msg.word.toUpperCase()}`,
      true,
      4000
    )
  })

  // The host rules against a turn. Our tiles were never taken away, so all
  // this has to do is undo the local staging and say why — previously this
  // toast was pushed on the HOST's client instead of the submitter's, so the
  // player whose word was rejected saw their tiles reappear with no
  // explanation at all.
  bus.on(MSG_REJECT, (msg: RejectMessage) => {
    if (msg.address !== myAddress()) return
    if (!awaitingHostUntil) return
    awaitingHostUntil = 0
    unstageAll()
    playRejectedSound()
    pushToast(`${msg.reason} — tiles returned`, false, 3000)
  })

  bus.on(MSG_ROUND_END, (msg: RoundEndMessage) => {
    winnerBanner = {
      text: msg.points > 0 ? `${msg.name.toUpperCase()} WINS — ${msg.points} PTS` : 'NO WINNER THIS ROUND',
      until: Date.now() + WINNER_BANNER_MS
    }
    playVictorySound()
  })

  engine.addSystem(inventorySystem)
  engine.addSystem(pickupSystem)
  engine.addSystem(inputSystemTick)
}

/* ------------------------------------------------------------------ *
 * Systems
 * ------------------------------------------------------------------ */

let inventoryAccum = 0
let lastKnownRoundId = -1
function inventorySystem(dt: number): void {
  inventoryAccum += dt
  if (inventoryAccum < quality().inventoryInterval) return
  inventoryAccum = 0

  // A round reset reassigns every tile (including anything staged but not yet
  // submitted) out from under whoever was holding it. Drop any local staging
  // state rather than leave ghost preview cubes on a board that just cleared.
  const round = getRound()
  if (round && round.roundId !== lastKnownRoundId) {
    lastKnownRoundId = round.roundId
    awaitingHostUntil = 0
    lastFilledCount = filledCellCount()
    if (staged.length) {
      stagedEntities.clear()
      clearAllStagedLetters()
      staged = []
    }
  }

  // Someone else's submission landed. Their letters can change what our staged
  // tiles spell, whether they still connect, and whether the squares we picked
  // are even free — rather than let the player submit into a board that moved
  // under them and eat a rejection, hand the word back now while they can see
  // why. Skipped while our OWN turn is in flight: the fill count changes when
  // our commit lands too, and `resolvePendingSubmit` owns that case.
  //
  // Counting filled cells is a sound change detector because cells are only
  // ever added within a round; the only removal is a round reset, handled above.
  const filled = filledCellCount()
  if (lastFilledCount >= 0 && filled !== lastFilledCount && staged.length && !awaitingHostUntil) {
    cancelStaging('Another player took a square — your tiles are back')
  }
  lastFilledCount = filled

  const me = myAddress()
  const next: InventorySlot[] = []
  if (me) {
    for (const tile of tileEntities) {
      if (stagedEntities.has(tile)) continue // shown on the board instead, not the bag
      const state = TileState.getOrNull(tile)
      if (state && state.status === TileStatus.HELD && state.holder === me) {
        next.push({ entity: tile, letter: state.letter })
      }
    }
  }
  next.sort((a, b) => (a.entity as number) - (b.entity as number))
  inventory = next
  if (selected >= inventory.length) selected = Math.max(0, inventory.length - 1)

  // Resolve contested pickups.
  const now = Date.now()
  for (const [entity, deadline] of pendingPickups) {
    if (now < deadline) continue
    pendingPickups.delete(entity)
    const state = TileState.getOrNull(entity)
    if (state && state.status === TileStatus.HELD && state.holder !== me) {
      pushToast('Someone grabbed that tile first', false, 2000)
    }
  }
}

let pickupAccum = 0
function pickupSystem(dt: number): void {
  pickupAccum += dt
  if (pickupAccum < quality().pickupInterval) return
  pickupAccum = 0

  if (inventory.length >= MAX_INVENTORY) return
  const me = myAddress()
  const pos = myPosition()
  if (!me || !pos) return
  const round = getRound()
  if (!round) return

  let bestTile: Entity | null = null
  let bestDist = PICKUP_RADIUS * PICKUP_RADIUS

  for (const tile of tileEntities) {
    const state = TileState.getOrNull(tile)
    if (!state || state.status !== TileStatus.IN_WORLD) continue
    const t = Transform.getOrNull(tile)
    if (!t) continue
    const dx = t.position.x - pos.x
    const dy = t.position.y - pos.y
    const dz = t.position.z - pos.z
    const d2 = dx * dx + dy * dy * 0.5 + dz * dz
    if (d2 < bestDist) {
      bestDist = d2
      bestTile = tile
    }
  }

  if (!bestTile) return
  const mutable = TileState.getMutable(bestTile)
  mutable.status = TileStatus.HELD
  mutable.holder = me
  mutable.roundId = round.roundId
  mutable.updatedAt = Date.now()
  pendingPickups.set(bestTile, Date.now() + 1200)
  playPickupSound()
  pushToast(`Picked up ${letterChar(mutable.letter)}`, true, 1500)
}

let targetAccum = 0
function inputSystemTick(dt: number): void {
  // Key polling must stay per-frame or presses get dropped; only the placement
  // target recalculation is throttled, and only on mobile.
  targetAccum += dt
  const interval = quality().targetInterval
  const refreshTarget = interval === 0 || targetAccum >= interval
  if (refreshTarget) targetAccum = 0

  // Cheap when nothing is in flight, and must not be throttled: this is what
  // notices the host's board write and clears the staged previews before they
  // double up on the real letters.
  resolvePendingSubmit()

  const pos = refreshTarget ? myPosition() : null

  // Walked off to go tile hunting with a word still staged? Give it back
  // rather than leave preview cubes stranded on the board and the tiles
  // missing from the bag. Not done while a turn is in flight — those tiles
  // are the host's business now, and `resolvePendingSubmit` will settle them.
  if (pos && staged.length && !awaitingHostUntil && metresOutsideBoard(pos) > STAGE_CANCEL_DISTANCE) {
    cancelStaging('Too far from the board — your tiles are back')
  }

  // Where a placement would land, allowing for a snap to the nearest legal cell.
  // Staged-but-not-yet-submitted tiles count as occupied here too, so the
  // player can keep building a word across cells they've already placed this
  // turn without the target snapping back onto one of them.
  if (pos) {
    const virtualCells = staged.length ? mergeStaged(getBoardCells(), staged) : getBoardCells()
    const target = targetCell(pos, virtualCells)
    hoveredCell = target.cell
    hoverLegal = target.legal
    hoverReason = target.reason
    showHighlight(target.cell, target.legal && inventory.length > 0)
  }

  // Keyboard shortcuts (desktop only — a phone has no number keys). Nothing
  // here is keyboard-ONLY: dropping is also on F when nothing is staged, and
  // selection on mobile is done by tapping the bag row directly.
  //
  // [1] drop, [2] previous, [3] next. Dropping gets the first key because
  // it's the one you reach for under pressure — holding a letter you can't
  // use while the clock runs down. 2-back/3-forward reads more naturally in
  // ascending order than the reverse.
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
    dropSelected()
  }
  if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) {
    cycleSelection(-1)
  }
  if (inputSystem.isTriggered(InputAction.IA_ACTION_5, PointerEventType.PET_DOWN)) {
    cycleSelection(1)
  }
  if (inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)) {
    // F does double duty: submit the staged word if there is one, otherwise
    // drop the selected bag tile — no separate button for either on mobile.
    if (staged.length > 0) submitStaged()
    else dropSelected()
  }
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    placeSelected()
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export function dropSelected(): void {
  const slot = inventory[selected]
  if (!slot) {
    pushToast('Nothing to drop', false, 1500)
    return
  }
  const playerTransform = Transform.getOrNull(engine.PlayerEntity as Entity)
  const pos = myPosition()
  if (!pos) return

  const forward = playerTransform
    ? Vector3.rotate(Vector3.Forward(), playerTransform.rotation as Quaternion)
    : Vector3.Forward()

  const target = Vector3.create(
    pos.x + forward.x * DROP_DISTANCE,
    pos.y + 0.9,
    pos.z + forward.z * DROP_DISTANCE
  )

  Transform.getMutable(slot.entity).position = target
  const state = TileState.getMutable(slot.entity)
  state.status = TileStatus.IN_WORLD
  state.holder = ''
  state.updatedAt = Date.now()
  removeFromInventory(slot.entity)
  pushToast(`Dropped ${letterChar(slot.letter)}`, true, 1500)
}

/**
 * Stage the selected tile onto the cell the player is standing on. This is
 * NOT a submission — the tile is only shown on the board as a local preview;
 * its TileState stays exactly as it was (still HELD by this player), so
 * nothing needs to be sent over the network yet and there is nothing to undo
 * if the player never submits. Press F to actually submit the turn.
 */
export function placeSelected(): void {
  if (awaitingHostUntil) {
    pushToast('Waiting on your last word…', false, 1500)
    return
  }

  const slot = inventory[selected]
  const pos = myPosition()
  const round = getRound()
  if (!slot || !pos || !round) {
    if (!slot) pushToast('Your bag is empty — go find tiles', false, 2000)
    return
  }

  const virtualCells = staged.length ? mergeStaged(getBoardCells(), staged) : getBoardCells()
  const target = targetCell(pos, virtualCells)
  if (target.cell < 0) {
    pushToast('Walk onto the board to place a tile', false, 2000)
    return
  }
  if (!target.legal) {
    pushToast(target.reason || 'No free square here', false, 2200)
    return
  }

  staged.push({ entity: slot.entity, letter: slot.letter, cell: target.cell })
  stagedEntities.add(slot.entity)
  removeFromInventory(slot.entity)
  showStagedLetter(target.cell, slot.letter)
  playPlaceSound()
  pushToast('Press F to submit', true, 2500)
}

/**
 * Submit this turn's staged placements. Every word they form — checked both
 * horizontally and vertically through each staged cell — is validated
 * locally first (board.ts's `evaluateSubmission`, the same rule the host
 * re-checks authoritatively). If anything doesn't check out, the whole turn
 * is cancelled and every staged tile goes straight back to the bag — nothing
 * is sent to the host, since nothing was ever removed from TileState.
 */
export function submitStaged(): void {
  if (!staged.length) return
  if (awaitingHostUntil) return // one turn in flight at a time

  const placements: Placement[] = staged.map((s) => ({ cell: s.cell, letter: s.letter }))
  const check = evaluateSubmission(getBoardCells(), placements, [])

  if (!check.ok) {
    // Purely local rejection — nothing was ever sent, so just put them back.
    // Same sound as a host rejection: from the player's side it's the same
    // event, and they shouldn't have to care which side caught it.
    unstageAll()
    playRejectedSound()
    pushToast(`${check.reason} — tiles returned`, false, 3000)
    return
  }

  // NOTE: the tiles stay HELD by us here, on purpose. An earlier version set
  // them FREE the moment F was pressed, which meant a dropped message or a
  // host that vanished mid-flight destroyed them outright with no way back.
  // Now the HOST retires them, and only after it has committed the board — so
  // the worst case is the timeout below handing them back untouched.
  const request: SubmitRequest = {
    placements: staged.map((s) => ({
      cell: s.cell,
      letter: s.letter,
      tile: tileEntities.indexOf(s.entity)
    })),
    address: myAddress(),
    name: myName(),
    nonce: nonceCounter++
  }
  // Set BEFORE emitting, not after. MessageBus.emit notifies local observers
  // synchronously (sender 'self'), so when the submitter IS the host, its own
  // applySubmit — and any resulting MSG_REJECT — runs inside this emit call.
  // Arming the deadline afterwards meant the host's own rejections hit the
  // `if (!awaitingHostUntil) return` guard and were silently swallowed.
  awaitingHostUntil = Date.now() + SUBMIT_TIMEOUT_MS
  bus.emit(MSG_SUBMIT, request)
  playPlaceSound()
}

/**
 * Resolve a turn that's out with the host.
 *
 * Success needs no reply message: the host's board write is CRDT-synced, so
 * seeing our own cells filled in is the confirmation, and `syncBoardVisuals`
 * has already drawn the real letters — the staged previews just have to go
 * before they double up on them.
 *
 * Failure arrives as MSG_REJECT. The timeout is only for the case where no
 * answer comes at all (host left, message dropped); since the tiles were
 * never given away, recovering is just dropping the local staging and letting
 * `inventorySystem` rebuild the bag from TileState.
 */
function resolvePendingSubmit(): void {
  if (!awaitingHostUntil) return

  const cells = getBoardCells()
  const committed = staged.every((s) => cells[s.cell] !== 0)

  if (committed) {
    for (const s of staged) {
      stagedEntities.delete(s.entity)
      clearStagedLetter(s.cell)
    }
    staged = []
    awaitingHostUntil = 0
    playAcceptedSound()
    // Re-baseline so our own commit isn't mistaken for another player's on the
    // next inventorySystem pass.
    lastFilledCount = filledCellCount()
    return
  }

  if (Date.now() >= awaitingHostUntil) {
    for (const s of staged) {
      stagedEntities.delete(s.entity)
      clearStagedLetter(s.cell)
    }
    staged = []
    awaitingHostUntil = 0
    pushToast('No answer from the host — your tiles are still in your bag', false, 3000)
  }
}
