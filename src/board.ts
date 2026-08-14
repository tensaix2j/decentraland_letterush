/**
 * Board geometry and Scrabble rules.
 *
 * Placement is turn-based. `canStage`/`targetCell` gate individual tiles as
 * they're staged — but ONLY for being on the board and empty, nothing more —
 * so a whole word can be staged in any order, starting from either end.
 * Nothing is committed to the shared board yet at this point.
 *
 * A whole turn's staged tiles are validated together, all at once, by
 * `evaluateSubmission`: `isConnected` first confirms the finished shape
 * actually links back to the existing board (or covers the centre star, if
 * this is the first move of the round) — the deferred, order-independent
 * replacement for what used to be a per-tile "must touch an already-placed
 * tile" check at staging time (see `isConnected`'s own comment for why that
 * was changed: it forced players to build outward in placement order,
 * starting from the point of contact, which meant a 5-letter word ending on
 * an existing tile had to be placed back-to-front). Then every horizontal
 * and vertical run of 2+ letters touching a newly staged cell is collected,
 * and if any one of them isn't a real word the ENTIRE submission is
 * rejected — the caller is expected to return every staged tile to the
 * player's bag rather than commit anything. A run that IS a real word but was
 * already scored earlier this round still counts toward validity, it just
 * pays no additional points (stops a word being farmed by re-forming it).
 */

import { Vector3 } from '@dcl/sdk/math'
import {
  BOARD_N,
  BOARD_CELL_SIZE,
  BOARD_X0,
  BOARD_Z0,
  BOARD_Y,
  CELL_PREMIUM
} from './generated/layout'
import { LETTER_VALUE, letterChar } from './letters'
import { isWord, MAX_WORD_LEN } from './dictionary'

export const CENTER_CELL = Math.floor((BOARD_N * BOARD_N) / 2)

export const enum Premium {
  NONE = 0,
  DOUBLE_LETTER = 1,
  TRIPLE_LETTER = 2,
  DOUBLE_WORD = 3,
  TRIPLE_WORD = 4,
  STAR = 5
}

export const PREMIUM_LABEL = ['', 'DL', 'TL', 'DW', 'TW', '★']

export const rowOf = (index: number) => Math.floor(index / BOARD_N)
export const colOf = (index: number) => index % BOARD_N
export const indexOf = (row: number, col: number) => row * BOARD_N + col

/** Centre of a board cell in world space (y is the top of the cell). */
export function cellCenter(index: number): Vector3 {
  return Vector3.create(
    BOARD_X0 + colOf(index) * BOARD_CELL_SIZE + BOARD_CELL_SIZE / 2,
    BOARD_Y,
    BOARD_Z0 + rowOf(index) * BOARD_CELL_SIZE + BOARD_CELL_SIZE / 2
  )
}

/** The cell the player is standing on, or -1 if they are off the board. */
export function cellAtPosition(pos: Vector3): number {
  const col = Math.floor((pos.x - BOARD_X0) / BOARD_CELL_SIZE)
  const row = Math.floor((pos.z - BOARD_Z0) / BOARD_CELL_SIZE)
  if (col < 0 || col >= BOARD_N || row < 0 || row >= BOARD_N) return -1
  if (pos.y > BOARD_Y + 6 || pos.y < BOARD_Y - 3) return -1
  return indexOf(row, col)
}

/** How far outside the board edge still counts as "on" it, in cells. */
const EDGE_TOLERANCE = 1.5
/**
 * How far the target may snap to find a legal cell, in cells.
 *
 * Was 2 (up to ~4 m, at BOARD_CELL_SIZE=2m, in any direction). The highlight
 * pad + beam (view.ts's showHighlight) always renders at whatever cell this
 * snaps to, so a radius of 2 could park the target visibly far from the
 * player's actual feet whenever the cell directly underfoot wasn't legal —
 * reported as the highlight feeling disconnected/confusing. 1 keeps the
 * forgiving-placement behavior (still snaps off the exact square you're
 * standing on) while keeping the snap to the immediate 8 neighbouring cells,
 * so the highlight never strays far from where you're actually standing.
 */
const SNAP_RADIUS = 1

export type Target = { cell: number; legal: boolean; reason: string }

/**
 * The cell a placement should go to, given where the player is standing.
 *
 * Standing exactly on a 2 m square is fiddly with a touch joystick, so this
 * does not simply return the cell underfoot: if that one is illegal (off the
 * board, or already taken — see `canStage`) it searches outward for the
 * nearest empty cell within SNAP_RADIUS. Now that staging no longer checks
 * touch/connectivity, this snap mostly only matters for standing on an
 * already-occupied cell; almost every other empty cell on the board is
 * directly legal to stage on regardless of distance from anything else.
 */
export function targetCell(pos: Vector3, cells: readonly number[]): Target {
  const rawCol = (pos.x - BOARD_X0) / BOARD_CELL_SIZE
  const rawRow = (pos.z - BOARD_Z0) / BOARD_CELL_SIZE

  if (
    rawCol < -EDGE_TOLERANCE ||
    rawCol > BOARD_N + EDGE_TOLERANCE ||
    rawRow < -EDGE_TOLERANCE ||
    rawRow > BOARD_N + EDGE_TOLERANCE ||
    pos.y > BOARD_Y + 6 ||
    pos.y < BOARD_Y - 3
  ) {
    return { cell: -1, legal: false, reason: '' }
  }

  const col = Math.min(BOARD_N - 1, Math.max(0, Math.floor(rawCol)))
  const row = Math.min(BOARD_N - 1, Math.max(0, Math.floor(rawRow)))
  const under = indexOf(row, col)

  const direct = canStage(cells, under)
  if (direct.ok) return { cell: under, legal: true, reason: '' }

  let best = -1
  let bestDist = Infinity
  for (let dr = -SNAP_RADIUS; dr <= SNAP_RADIUS; dr++) {
    for (let dc = -SNAP_RADIUS; dc <= SNAP_RADIUS; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= BOARD_N || c < 0 || c >= BOARD_N) continue
      const candidate = indexOf(r, c)
      if (!canStage(cells, candidate).ok) continue
      // Distance from where the player actually is, not from the cell centre,
      // so the snap always picks the one they are closest to.
      const dx = rawCol - (c + 0.5)
      const dz = rawRow - (r + 0.5)
      const d2 = dx * dx + dz * dz
      if (d2 < bestDist) {
        bestDist = d2
        best = candidate
      }
    }
  }

  if (best !== -1) return { cell: best, legal: true, reason: '' }
  return { cell: under, legal: false, reason: direct.reason }
}

/**
 * How many metres the player is outside the board's footprint — 0 while they
 * are anywhere over it. Used to decide when someone has walked far enough away
 * that a half-finished word should be handed back rather than left staged.
 */
export function metresOutsideBoard(pos: Vector3): number {
  const span = BOARD_N * BOARD_CELL_SIZE
  const dx = Math.max(BOARD_X0 - pos.x, 0, pos.x - (BOARD_X0 + span))
  const dz = Math.max(BOARD_Z0 - pos.z, 0, pos.z - (BOARD_Z0 + span))
  return Math.sqrt(dx * dx + dz * dz)
}

export function isBoardEmpty(cells: readonly number[]): boolean {
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) return false
  return true
}

export type PlacementCheck = { ok: boolean; reason: string }

/**
 * Whether `index` is a legal cell to STAGE a tile onto — on the board and
 * empty, nothing more. Used to be `canPlace`, and used to also require the
 * cell touch an already-filled one (or be the centre star, on the board's
 * first-ever placement). That per-tile check ran the instant each tile was
 * staged, which meant it had to touch something that existed AT THAT MOMENT
 * — forcing players to build outward in placement order, starting from
 * whichever end touched the board. Connectivity (and the centre-star
 * requirement) is now checked once, for the whole turn's placements
 * together, at submit time — see `isConnected` — so staging itself only
 * needs to rule out cells that are off the board or already taken.
 */
export function canStage(cells: readonly number[], index: number): PlacementCheck {
  if (index < 0 || index >= cells.length) return { ok: false, reason: 'Off the board' }
  if (cells[index] !== 0) return { ok: false, reason: 'Cell already taken' }
  return { ok: true, reason: '' }
}

/** Overlay a set of not-yet-committed placements onto `cells`, without mutating it. */
export function mergeStaged(
  cells: readonly number[],
  staged: readonly { cell: number; letter: number }[]
): number[] {
  const merged = cells.slice()
  for (const p of staged) merged[p.cell] = p.letter + 1
  return merged
}

export type Run = {
  /** 0 = horizontal, 1 = vertical */
  orient: number
  /** row for horizontal runs, column for vertical runs */
  line: number
  start: number
  length: number
  word: string
}

/** Unique, compact identifier for a run so it can only ever score once. */
export function runKey(run: Run): number {
  return run.orient * 250_000 + run.line * 10_000 + run.start * 100 + run.length
}

/** The maximal horizontal and vertical runs of 2+ letters through `index`. */
export function runsThrough(cells: readonly number[], index: number): Run[] {
  const row = rowOf(index)
  const col = colOf(index)
  const out: Run[] = []

  let left = col
  while (left > 0 && cells[indexOf(row, left - 1)] !== 0) left--
  let right = col
  while (right < BOARD_N - 1 && cells[indexOf(row, right + 1)] !== 0) right++
  if (right > left) {
    let word = ''
    for (let c = left; c <= right; c++) word += letterChar(cells[indexOf(row, c)] - 1)
    out.push({ orient: 0, line: row, start: left, length: right - left + 1, word })
  }

  let top = row
  while (top > 0 && cells[indexOf(top - 1, col)] !== 0) top--
  let bottom = row
  while (bottom < BOARD_N - 1 && cells[indexOf(bottom + 1, col)] !== 0) bottom++
  if (bottom > top) {
    let word = ''
    for (let r = top; r <= bottom; r++) word += letterChar(cells[indexOf(r, col)] - 1)
    out.push({ orient: 1, line: col, start: top, length: bottom - top + 1, word })
  }

  return out
}

export const premiumAt = (index: number): number => CELL_PREMIUM[index] || 0

/**
 * Points a run is worth. Unlike a single-tile placement, a batch submission
 * can drop more than one NEW tile into the same run (the main word being
 * spelled is exactly this case) — every premium square among the newly
 * placed cells applies, not just one, same as real Scrabble stacking
 * multiple bonus squares in one word.
 */
function scoreRun(cells: readonly number[], run: Run, newCells: ReadonlySet<number>): number {
  let base = 0
  let wordMult = 1
  for (let k = 0; k < run.length; k++) {
    const idx = run.orient === 0 ? indexOf(run.line, run.start + k) : indexOf(run.start + k, run.line)
    let value = LETTER_VALUE[cells[idx] - 1] || 0
    if (newCells.has(idx)) {
      const premium = premiumAt(idx)
      if (premium === Premium.DOUBLE_LETTER) value *= 2
      if (premium === Premium.TRIPLE_LETTER) value *= 3
      if (premium === Premium.DOUBLE_WORD || premium === Premium.STAR) wordMult *= 2
      if (premium === Premium.TRIPLE_WORD) wordMult *= 3
    }
    base += value
  }
  let total = base * wordMult
  if (run.length >= 7) total += 15 // long-word bonus
  return total
}

export type Placement = { cell: number; letter: number }

/**
 * Whether `placements`, taken together, connect back to the board as it
 * stood before this turn — or, if the board was empty before this turn,
 * whether they cover the centre star. This is the deferred, order-
 * independent replacement for the old per-tile "must touch an already-
 * placed tile" check that used to live in `canStage` (née `canPlace`).
 *
 * That old check ran the instant each tile was staged, so it had to touch
 * something that existed AT THAT MOMENT — which forced players to build a
 * word outward in placement order, starting from wherever it touched the
 * board. A 5-letter word whose connection point was at the far end had to
 * be placed back-to-front to satisfy it. Checking connectivity once, here,
 * against the FINISHED shape instead of tile-by-tile as it's built, removes
 * that ordering requirement while keeping the actual rule intact: a
 * submission still has to connect to the existing board (or cover the
 * centre, on the first move of the round) to be valid.
 *
 * Implementation: flood-fill outward from every pre-existing filled cell
 * (or, if the board was empty before this turn, from the centre star alone)
 * across the merged board, and confirm every newly placed cell was reached.
 * This also correctly accepts a branching placement — e.g. a perpendicular
 * word hung off a letter placed earlier in the same turn — since the flood
 * fill walks through this turn's own new cells too, not just the old board.
 */
export function isConnected(cellsBeforeTurn: readonly number[], placements: readonly Placement[]): boolean {
  if (placements.length === 0) return false
  const merged = mergeStaged(cellsBeforeTurn, placements)
  const newCells = new Set(placements.map((p) => p.cell))

  const seeds: number[] = []
  if (isBoardEmpty(cellsBeforeTurn)) {
    if (!newCells.has(CENTER_CELL)) return false
    seeds.push(CENTER_CELL)
  } else {
    for (let i = 0; i < cellsBeforeTurn.length; i++) if (cellsBeforeTurn[i] !== 0) seeds.push(i)
  }

  const seen = new Set<number>(seeds)
  const queue = seeds.slice()
  while (queue.length) {
    const idx = queue.pop() as number
    const row = rowOf(idx)
    const col = colOf(idx)
    const neighbours = [
      col > 0 ? idx - 1 : -1,
      col < BOARD_N - 1 ? idx + 1 : -1,
      row > 0 ? idx - BOARD_N : -1,
      row < BOARD_N - 1 ? idx + BOARD_N : -1
    ]
    for (const n of neighbours) {
      if (n < 0 || seen.has(n) || merged[n] === 0) continue
      seen.add(n)
      queue.push(n)
    }
  }

  for (const cell of newCells) if (!seen.has(cell)) return false
  return true
}

export type SubmissionResult = {
  ok: boolean
  /** Why the submission was rejected — empty when ok is true. */
  reason: string
  points: number
  words: string[]
  newRunKeys: number[]
}

/**
 * Validate and score a batch of not-yet-committed placements against the
 * board as it stood before this turn.
 *
 * Every horizontal and vertical run of 2+ letters that touches any of the
 * new cells is collected (deduplicated — three tiles placed in the same row
 * would each otherwise report the same run). If there are none, or any one
 * of them isn't a real word, the WHOLE submission is rejected — nothing is
 * scored and nothing should be committed to the board; the caller is
 * expected to return every staged tile to the player's bag. This is the
 * turn-based replacement for the old rule where an unfinished/invalid word
 * was simply left on the board worth nothing — now it has to be a real word
 * to land at all.
 *
 * Runs listed in `alreadyScored` are excluded from scoring (but still count
 * toward validity) so a word cannot be farmed by re-forming it.
 */
export function evaluateSubmission(
  cells: readonly number[],
  placements: readonly Placement[],
  alreadyScored: readonly number[]
): SubmissionResult {
  const reject = (reason: string): SubmissionResult => ({ ok: false, reason, points: 0, words: [], newRunKeys: [] })

  if (!isConnected(cells, placements)) {
    return reject(isBoardEmpty(cells) ? 'The first word must cover the centre star' : 'Tiles must connect to other word on the board')
  }

  const merged = mergeStaged(cells, placements)
  const newCells = new Set(placements.map((p) => p.cell))

  const seenKeys = new Set<number>()
  const runs: Run[] = []
  for (const p of placements) {
    for (const run of runsThrough(merged, p.cell)) {
      const k = runKey(run)
      if (seenKeys.has(k)) continue
      seenKeys.add(k)
      runs.push(run)
    }
  }

  if (runs.length === 0) {
    return reject('Tiles must form a word of at least 2 letters')
  }
  for (const run of runs) {
    if (run.length > MAX_WORD_LEN) return reject(`"${run.word}" is too long`)
    if (!isWord(run.word)) return reject(`"${run.word}" is not a word`)
  }

  const result: SubmissionResult = { ok: true, reason: '', points: 0, words: [], newRunKeys: [] }
  for (const run of runs) {
    const k = runKey(run)
    result.words.push(run.word)
    if (alreadyScored.indexOf(k) !== -1) continue
    result.points += scoreRun(merged, run, newCells)
    result.newRunKeys.push(k)
  }
  return result
}
