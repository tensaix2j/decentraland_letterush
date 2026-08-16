/** Central tuning + identity constants for Scrabble Parkour. */

/** Stable sync IDs. Singletons get low reserved IDs; the tile pool owns 100..199. */
export const enum SyncId {
  ROUND = 1,
  BOARD = 2,
  SCORES = 3,
  TILE_BASE = 100
}

/**
 * Maximum letter tiles in existence at once (world + every player's bag).
 *
 * Each live tile costs 2 Material components at runtime (an opaque backing +
 * an alpha-tested glyph decal — see view.ts). Those count against the
 * scene's material budget same as anything else, so this got dialed back
 * down from 100 (200 materials) while the world's static material count was
 * also being cut — 50 tiles was a middle ground between "always something to
 * find" and not eating half the remaining budget on the tile pool alone.
 * Bumped to 60 per explicit request — West's anchor count grew (fortress
 * spawns + moving-platform spawns), so there's more room to spread tiles out
 * before this becomes the bottleneck again.
 */
export const MAX_TILES = 60
/**
 * Tiles a single player may carry.
 *
 * The mobile bag row always renders exactly this many slots in one line
 * across the full screen width, so this number is also a layout constraint:
 * at 10 the row ran under the explorer's own E/F touch buttons in the
 * bottom-right. 8 keeps it clear of them.
 */
export const MAX_INVENTORY = 8
/** How often the host tops the world back up to MAX_TILES. */
export const SPAWN_INTERVAL_MS = 60_000
/** How many tiles a single top-up may add. */
export const SPAWN_BATCH = 10
/** Round length before the board wipes and scores reset. */
export const ROUND_LENGTH_MS = 10 * 60_000
/**
 * Distance at which a player scoops up a loose tile.
 *
 * Kept comfortably under DROP_DISTANCE: a dropped tile that lands inside this
 * radius gets vacuumed straight back up on the next proximity scan, so the
 * drop appears to do nothing at all.
 */
export const PICKUP_RADIUS = 2
/**
 * How far in front of the player a dropped tile lands.
 *
 * Must stay clear of PICKUP_RADIUS by enough that the drop survives the very
 * next scan even standing perfectly still — see the assertion in
 * tools/check-logic.mjs, which accounts for the pickup test's vertical
 * weighting too.
 */
export const DROP_DISTANCE = 3.2
/** A held tile whose owner has vanished this long is returned to the wild. */
export const ABANDON_MS = 20_000
/**
 * An IN_WORLD tile that's sat uncollected this long gets re-anchored to a
 * fresh zone spot. Without this, a tile dropped somewhere unreachable
 * (dropSelected() has no reachability check — it just lands DROP_DISTANCE in
 * front of the player, which can be off a ledge, inside geometry, over a
 * moving-platform gap, etc.) sits IN_WORLD forever: spawnTiles()'s budget is
 * MAX_TILES minus every non-FREE tile, reachable or not, so a few bad drops
 * quietly eat into the cap and crowd out new spawns at legitimate anchors —
 * the world visibly "runs out" of findable tiles well before MAX_TILES is
 * really in play. Long enough that a tile freshly spawned at a real anchor in
 * a currently-unvisited zone corner isn't yanked away before anyone's had a
 * fair chance to reach it; short enough to recycle a truly lost tile well
 * inside a single round rather than let it squat for the full ROUND_LENGTH_MS.
 */
export const STALE_WORLD_MS = 3 * 60_000
/** Host loop cadence. */
export const HOST_TICK_MS = 1000

export const TEXTURE_ALPHABET = 'assets/textures/alphabets.png'
/** UI-only sheet — same 26 letters, but with a white rounded tile background
 * baked in behind each glyph (the 3D mesh crop above stays on the transparent
 * one, since 3D tiles paint their own opaque backing separately — see
 * view.ts). Different layout than TEXTURE_ALPHABET, not a straight recolor —
 * see `letterUiUvs` in letters.ts for the cell mapping. */
export const TEXTURE_ALPHABET_UI = 'assets/textures/alphabets_ui.png'

/** Tile status stored in the synced TileState component. */
export const enum TileStatus {
  /** Unused pool slot — does not count toward MAX_TILES. */
  FREE = 0,
  /** Lying in one of the four zones, waiting to be picked up. */
  IN_WORLD = 1,
  /** In a player's bag. */
  HELD = 2
}

/** MessageBus topics. */
export const MSG_SUBMIT = 'sp:submit'
export const MSG_REJECT = 'sp:reject'
export const MSG_TOAST = 'sp:toast'
export const MSG_ROUND_END = 'sp:round_end'

/**
 * One turn's worth of not-yet-committed board placements, sent together for
 * host-side validation. Placing a tile (E) only stages it locally; nothing
 * reaches the host until the player submits (F), at which point every
 * placement in the turn is checked and committed — or rejected — as a unit.
 *
 * `tile` is the tile's index in the shared pool (its sync ID is
 * `SyncId.TILE_BASE + tile`), which is what lets the HOST be the one to
 * consume the tiles on a successful commit. The submitting client
 * deliberately leaves them HELD: if this message is lost, or the host
 * disconnects before answering, nothing has been destroyed and the tiles are
 * still sitting in the player's bag.
 */
export type SubmitRequest = {
  placements: { cell: number; letter: number; tile: number }[]
  address: string
  name: string
  nonce: number
}

/** Host's answer when a submission fails validation. Addressed to one player. */
export type RejectMessage = {
  address: string
  reason: string
}

export type ToastMessage = {
  address: string
  name: string
  word: string
  points: number
}

/** Sent once by the host when a round's clock runs out, naming that round's
 * top scorer so every client can put up a big "winner" banner. `points === 0`
 * means nobody scored — clients show a no-winner message instead of a name. */
export type RoundEndMessage = {
  roundId: number
  name: string
  points: number
}
