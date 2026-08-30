/**
 * Shared, CRDT-synced game state.
 *
 * Four singleton entities carry the whole game: the round clock, the board, the
 * scoreboard, and a fixed pool of MAX_TILES tile entities. Splitting them keeps a board
 * write from clobbering a concurrent score write (CRDT resolution is
 * last-write-wins per component).
 *
 * Every synced entity uses a STABLE explicit sync ID and is created exactly once
 * inside main() — never destroyed and recreated.
 */

import { engine, Entity, Schemas, Transform } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Vector3 } from '@dcl/sdk/math'
import { BOARD_CELLS } from './generated/layout'
import { MAX_TILES, SyncId, TileStatus } from './config'

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export const RoundState = engine.defineComponent('scrabbleparkour::RoundState', {
  /** Increments on every reset; clients use it to know they must re-render. */
  roundId: Schemas.Int,
  /** Unix ms at which the current round ends. 0 = not initialised yet. */
  endsAt: Schemas.Int64,
  /** Unix ms of the next scheduled tile top-up. */
  nextSpawnAt: Schemas.Int64
})

export const BoardState = engine.defineComponent('scrabbleparkour::BoardState', {
  /** One entry per cell, row-major. 0 = empty, 1..26 = letter A..Z. */
  cells: Schemas.Array(Schemas.Int)
})

export const ScoreState = engine.defineComponent('scrabbleparkour::ScoreState', {
  addresses: Schemas.Array(Schemas.String),
  names: Schemas.Array(Schemas.String),
  points: Schemas.Array(Schemas.Int),
  words: Schemas.Array(Schemas.Int),
  /** Packed IDs of word runs already scored this round (see board.ts runKey). */
  scoredRuns: Schemas.Array(Schemas.Int)
})

export const TileState = engine.defineComponent('scrabbleparkour::TileState', {
  /** 0 = A .. 25 = Z. Meaningless while status is FREE. */
  letter: Schemas.Int,
  /** See TileStatus. */
  status: Schemas.Int,
  /** Lower-cased wallet address of the holder while status is HELD. */
  holder: Schemas.String,
  /** Round this tile belongs to — stale tiles are recycled on reset. */
  roundId: Schemas.Int,
  /** Unix ms of the last state change; drives abandonment reclaim. */
  updatedAt: Schemas.Int64
})

/* ------------------------------------------------------------------ *
 * Singletons
 * ------------------------------------------------------------------ */

export let roundEntity: Entity
export let boardEntity: Entity
export let scoreEntity: Entity
export const tileEntities: Entity[] = []

const EMPTY_BOARD: number[] = new Array(BOARD_CELLS).fill(0)

/** Create every synced entity. MUST be called from main(). */
export function createSyncedState(): void {

  //console.log("JDEBUG: createSyncedState");  
  
  roundEntity = engine.addEntity()
  RoundState.create(roundEntity, { roundId: 0, endsAt: 0, nextSpawnAt: 0 })
  syncEntity(roundEntity, [RoundState.componentId], SyncId.ROUND)

  boardEntity = engine.addEntity()
  BoardState.create(boardEntity, { cells: EMPTY_BOARD.slice() })
  syncEntity(boardEntity, [BoardState.componentId], SyncId.BOARD)

  scoreEntity = engine.addEntity()
  ScoreState.create(scoreEntity, {
    addresses: [],
    names: [],
    points: [],
    words: [],
    scoredRuns: []
  })
  syncEntity(scoreEntity, [ScoreState.componentId], SyncId.SCORES)

  for (let i = 0; i < MAX_TILES; i++) {
    const tile = engine.addEntity()
    Transform.create(tile, {
      position: Vector3.create(0, -50, 0),
      scale: Vector3.create(0.75, 0.75, 0.75)
    })
    TileState.create(tile, {
      letter: 0,
      status: TileStatus.FREE,
      holder: '',
      roundId: 0,
      updatedAt: 0
    })
    syncEntity(tile, [Transform.componentId, TileState.componentId], SyncId.TILE_BASE + i)
    tileEntities.push(tile)
  }
  //console.log("JDEBUG: createSyncedState Done");  
  
}

/* ------------------------------------------------------------------ *
 * Read helpers
 * ------------------------------------------------------------------ */

export function getBoardCells(): readonly number[] {
  const state = BoardState.getOrNull(boardEntity)
  return state ? state.cells : EMPTY_BOARD
}

export function getRound() {
  return RoundState.getOrNull(roundEntity)
}

export type ScoreRow = { address: string; name: string; points: number; words: number }

export function getLeaderboard(): ScoreRow[] {
  const s = ScoreState.getOrNull(scoreEntity)
  if (!s) return []
  const rows: ScoreRow[] = []
  for (let i = 0; i < s.addresses.length; i++) {
    rows.push({
      address: s.addresses[i],
      name: s.names[i] || 'Player',
      points: s.points[i] || 0,
      words: s.words[i] || 0
    })
  }
  rows.sort((a, b) => b.points - a.points)
  return rows
}

/** Number of tiles that count against MAX_TILES (everything not in a FREE slot). */
export function liveTileCount(): number {
  let n = 0
  for (const tile of tileEntities) {
    const t = TileState.getOrNull(tile)
    if (t && t.status !== TileStatus.FREE) n++
  }
  return n
}

export function emptyBoard(): number[] {
  return EMPTY_BOARD.slice()
}
