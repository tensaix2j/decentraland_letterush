/**
 * Everything visual that is driven by synced state.
 *
 * Synced tile entities carry position + state only. Their appearance lives on a
 * LOCAL child entity, so the idle spin/bob animation costs no network traffic
 * and never fights the CRDT for ownership of the parent Transform.
 */

import {
  engine,
  Entity,
  Material,
  MaterialTransparencyMode,
  MeshRenderer,
  TextureWrapMode,
  Transform,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlatform } from '@dcl/sdk/platform'
import { TEXTURE_ALPHABET, TileStatus } from './config'
import { letterTextureCrop } from './letters'
import { BOARD_CELL_SIZE, BOARD_Y } from './generated/layout'
import { cellCenter } from './board'
import { TileState, tileEntities, getBoardCells } from './state'
import { quality } from './platform'

/**
 * A letter tile is TWO stacked boxes, not one:
 *
 *  - a solid, untextured "backing" — this is the tile's actual color. It has
 *    to exist as separate opaque geometry because the sheet's background is
 *    transparent, and an alpha-tested texture on a single box would punch a
 *    hole straight through to whatever is behind the tile, not reveal a color.
 *  - a slightly larger "decal" — the same box shape, alpha-tested against the
 *    sprite sheet, carrying only the glyph. Its transparent area lets the
 *    backing underneath show through.
 *
 * The decal sits at INNER_SCALE⁻¹ relative to the backing (i.e. strictly
 * outside it) so their surfaces never sit exactly coplanar — avoids z-fighting
 * on the glyph itself, which IS opaque and does render at the decal's surface.
 */
const INNER_SCALE = 0.9

/** Side length of a letter cube resting on the board — same shape as a pickable tile. */
const BOARD_LETTER_SIZE = 1.3

/**
 * Crop via the material's `texture.offset`/`texture.tiling`, NOT custom mesh
 * UVs. An earlier version supplied a 96-value per-face UV array to
 * `MeshRenderer.setBox` on the assumption every face shares one winding —
 * wrong in-world: the top face cropped correctly, the sides did not, so the
 * box's default per-face winding is not uniform the way that assumes.
 *
 * `final_uv = offset + input_uv * tiling` is an affine remap applied to
 * whatever UV each face already has — and `MeshRenderer.setBox()` called with
 * no `uvs` argument uses the engine's own built-in unwrap, which is
 * necessarily self-consistent since it's the renderer's own primitive. So
 * every face already spans a full, correctly-oriented 0..1 range on its own,
 * and remapping that through one shared transform crops the same rectangle
 * everywhere regardless of any individual face's winding or starting corner.
 * The mesh keeps its default UVs; only the texture changes.
 *
 * Rebuildable, not a one-time const: see `applyPlatformFixes` below —
 * Unity Explorer and Godot Explorer sample this V axis in opposite
 * directions, and which one a client is can't be known until a few frames
 * after startup, so this may get rebuilt once with the corrected flip.
 */
function buildLetterTextures(flip: boolean) {
  return Array.from({ length: 26 }, (_, i) => {
    const crop = letterTextureCrop(i, flip)
    return Material.Texture.Common({
      src: TEXTURE_ALPHABET,
      wrapMode: TextureWrapMode.TWM_CLAMP,
      offset: crop.offset,
      tiling: crop.tiling
    })
  })
}

/** Confirmed correct for Godot Explorer (desktop/mobile/VR) — see letters.ts. */
let flipV = true
let LETTER_TEXTURES = buildLetterTextures(flipV)

const backingOf = new Map<Entity, Entity>()
const decalOf = new Map<Entity, Entity>()

function ensureLetterVisual(parent: Entity): { backing: Entity; decal: Entity } {
  let backing = backingOf.get(parent)
  if (!backing) {
    backing = engine.addEntity()
    Transform.create(backing, {
      position: Vector3.create(0, 0, 0),
      scale: Vector3.create(INNER_SCALE, INNER_SCALE, INNER_SCALE),
      parent
    })
    MeshRenderer.setBox(backing)
    Material.setPbrMaterial(backing, {
      albedoColor: Color4.White(),
      metallic: 0,
      roughness: 0.8
    })
    backingOf.set(parent, backing)
  }

  let decal = decalOf.get(parent)
  if (!decal) {
    decal = engine.addEntity()
    Transform.create(decal, {
      position: Vector3.create(0, 0, 0),
      scale: Vector3.create(1, 1, 1),
      parent
    })
    MeshRenderer.setBox(decal)
    decalOf.set(parent, decal)
  }

  return { backing, decal }
}

const DECAL_MATERIAL = (letterIndex: number) => ({
  texture: LETTER_TEXTURES[letterIndex],
  albedoColor: Color4.White(),
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_TEST,
  alphaTest: 0.5,
  emissiveColor: Color3.create(0.15, 0.15, 0.15),
  emissiveIntensity: 0.35,
  metallic: 0,
  roughness: 0.75,
  specularIntensity: 0.2
})

/**
 * Style `parent`'s letter visual. Creates the backing + decal pair on first use.
 *
 * Tried dropping the backing for on-board letters specifically, on the theory
 * that the board's own surface right underneath would show through the
 * transparent part of the decal and the backing would be redundant there.
 * That's not how alpha test works: it doesn't reveal whatever texture is
 * physically underneath in world space, it just makes that part of the
 * surface invisible from the camera's point of view — so it showed whatever
 * was behind the tile from wherever the player was looking (sky, background
 * geometry, etc.), not the grid texture. Confirmed wrong by a real-device
 * report ("was white, now it's transparent"). Every letter, on the board or
 * loose in the world, needs the same opaque backing behind its decal.
 */
function styleAsLetter(parent: Entity, letterIndex: number): void {
  const { decal } = ensureLetterVisual(parent)
  Material.setPbrMaterial(decal, DECAL_MATERIAL(letterIndex))
  activeLetterIndex.set(parent, letterIndex)
}

/**
 * Every currently-styled letter parent and which glyph it's showing —
 * covers loose tiles, board letters, and staged previews alike. The only
 * reason this exists is `applyPlatformFixes`: when the V-flip correction
 * lands a few frames after everything above has already been drawn once with
 * the (possibly wrong) default, this is what gets walked to redraw it right.
 * Entries are removed alongside their entity wherever this file destroys one.
 */
const activeLetterIndex = new Map<Entity, number>()

/**
 * Unity Explorer and Godot Explorer were confirmed, side by side, to disagree
 * on TWO independent things for a letter cube, both traced to the same root
 * cause — they sample a mesh material's V axis in opposite directions:
 *
 *  - `letterTextureCrop`'s offset/tiling (see that function's comment) — which
 *    LETTER shows.
 *  - The board letter yaw (see `boardYaw` below) — which WAY the glyph faces,
 *    since the box's default UV unwrap on opposite faces is itself mirrored
 *    by the same V flip, so getting the crop right and getting the facing
 *    right are two separate corrections, not one.
 *
 * `getPlatform()` only resolves a few frames after scene start (it's an async
 * round trip to the runtime), so neither can just be read once at module
 * load; this polls until an answer arrives, corrects whichever of the two
 * this client needs, and redraws/re-rotates everything already on screen.
 *
 * Unity Explorer has no mobile or VR build, so `desktop` is the only
 * `getPlatform()` value it can ever report — branching on that alone is
 * enough to separate it from Godot Explorer's desktop/mobile/VR builds,
 * which all confirmed the opposite (default) behaviour for both.
 */
let platformFixDone = false
function applyPlatformFixes(): void {
  if (platformFixDone) return
  const platform = getPlatform()
  if (platform === null) return // not resolved yet — keep polling
  platformFixDone = true

  const isUnity = platform === 'desktop'

  const shouldFlip = !isUnity
  if (shouldFlip !== flipV) {
    flipV = shouldFlip
    LETTER_TEXTURES = buildLetterTextures(flipV)
    for (const [parent, letterIndex] of activeLetterIndex) {
      styleAsLetter(parent, letterIndex)
    }
  }

  const correctYaw = isUnity ? BOARD_LETTER_YAW_UNITY : BOARD_LETTER_YAW_GODOT
  if (correctYaw !== boardYaw) {
    boardYaw = correctYaw
    const rotation = Quaternion.fromEulerDegrees(0, boardYaw, 0)
    for (const entity of boardLetterEntities.values()) Transform.getMutable(entity).rotation = rotation
    for (const entity of stagedLetterEntities.values()) Transform.getMutable(entity).rotation = rotation
  }
}

/* ------------------------------------------------------------------ *
 * Loose tiles in the four zones
 * ------------------------------------------------------------------ */

type TileVisual = { child: Entity; letter: number; visible: boolean }
const tileVisuals: TileVisual[] = []
let spinTime = 0

export function setupTileVisuals(): void {
  for (const tile of tileEntities) {
    const child = engine.addEntity()
    Transform.create(child, {
      position: Vector3.create(0, 0, 0),
      scale: Vector3.create(1, 1, 1),
      parent: tile
    })
    styleAsLetter(child, 0)
    // propagateToChildren MUST be explicit. `child` carries no mesh of its
    // own — the actual renderers are `backing`/`decal`, grandchildren created
    // inside styleAsLetter. Per PBVisibilityComponent's own spec: an entity
    // with no OWN visibility component is only hidden by a PARENT that has
    // propagate=true; with it left at the default (false), backing/decal
    // have no own component and no propagating ancestor, so the spec's own
    // fallback rule makes them "visible" regardless of what `child` says.
    // Godot Explorer happened to cascade hidden state through the hierarchy
    // anyway (ordinary scene-graph behaviour for it); Unity Explorer applied
    // the spec literally, so a "picked up" tile stayed rendered in the world
    // on desktop while correctly vanishing from it on mobile.
    VisibilityComponent.create(child, { visible: false, propagateToChildren: true })
    tileVisuals.push({ child, letter: -1, visible: false })
  }

  engine.addSystem(tileVisualSystem)
  engine.addSystem(applyPlatformFixes)
}

let spinAccum = 0
function tileVisualSystem(dt: number): void {
  spinTime += dt

  // Visibility and letter changes must be picked up promptly, but the idle
  // spin/bob is cosmetic — on mobile it updates at 10 Hz instead of per frame,
  // which is 40 fewer Transform writes on most frames.
  spinAccum += dt
  const spinInterval = quality().spinInterval
  const animate = spinInterval === 0 || spinAccum >= spinInterval
  if (animate) spinAccum = 0

  for (let i = 0; i < tileEntities.length; i++) {
    const state = TileState.getOrNull(tileEntities[i])
    const visual = tileVisuals[i]
    const shouldShow = !!state && state.status === TileStatus.IN_WORLD

    if (shouldShow !== visual.visible) {
      visual.visible = shouldShow
      // propagateToChildren: true here too — see the comment in
      // setupTileVisuals. createOrReplace with only `visible` set would drop
      // back to the field's own default (propagate=false) on every toggle.
      VisibilityComponent.createOrReplace(visual.child, { visible: shouldShow, propagateToChildren: true })
    }
    if (!shouldShow || !state) continue

    if (state.letter !== visual.letter) {
      visual.letter = state.letter
      styleAsLetter(visual.child, state.letter)
    }

    if (!animate) continue
    const t = Transform.getMutable(visual.child)
    t.rotation = Quaternion.fromEulerDegrees(0, ((spinTime * 55 + i * 37) % 360), 0)
    t.position.y = Math.sin(spinTime * 1.8 + i) * 0.14
  }
}

/* ------------------------------------------------------------------ *
 * Letters resting on the board
 * ------------------------------------------------------------------ */

/**
 * Yaw applied to every letter resting on the board.
 *
 * Board rows run along +Z (row 0 is the low-Z edge), so the direction that
 * reads as "up"/the top of the board is -Z. The box's default unwrap puts the
 * glyph the other way round, which left placed letters facing away from the
 * board's reading direction — a half turn lines them up. Confirmed on Godot
 * Explorer (desktop/mobile/VR).
 *
 * Unity Explorer needs the OTHER half turn — same root cause as the
 * offset/tiling V-flip in `letterTextureCrop`: its mesh V axis runs the
 * opposite way, which flips the box's default UV unwrap on the faces this
 * yaw is compensating for, so the correction has to invert too. See
 * `applyPlatformFixes`, which is what actually decides which of these two a
 * given client uses at runtime — `boardYaw` starts on the Godot value and
 * only changes if the client turns out to be Unity.
 */
const BOARD_LETTER_YAW_GODOT = 180
const BOARD_LETTER_YAW_UNITY = 0
let boardYaw = BOARD_LETTER_YAW_GODOT

/**
 * How much of a committed letter still shows above the board surface.
 *
 * A word that has been accepted is seated INTO the board rather than left
 * standing on it, so only this sliver of the cube protrudes and you read it
 * off the top face. Staged previews deliberately keep sitting proud of the
 * surface, which makes "not submitted yet" and "locked in" tell apart at a
 * glance without any extra UI.
 *
 * The cube keeps its true cube shape either way — the visible top face is a
 * full undistorted square, which is the whole reason this isn't done by
 * squashing the box's height instead.
 */
const BOARD_LETTER_PROTRUSION = 0.05

/**
 * A letter cube on the board. `inset` seats it into the surface (committed,
 * scored letters); otherwise it rests on top (a staged preview).
 */
function createBoardLetterEntity(cell: number, inset: boolean): Entity {
  const entity = engine.addEntity()
  const centre = cellCenter(cell)
  // A proper cube, same shape as the pickable tiles — the flattened box this
  // used to be (1.7 x 0.8 x 1.7) squashed the glyph's default box UV unevenly
  // and made the texture look stretched/distorted on a placed tile.
  const side = BOARD_LETTER_SIZE
  // Seated: put the cube's TOP face `PROTRUSION` above the board, so the bulk
  // of it disappears below the surface. Resting: sit the whole cube on top.
  const y = inset ? BOARD_Y + BOARD_LETTER_PROTRUSION - side / 2 : BOARD_Y + side / 2
  Transform.create(entity, {
    position: Vector3.create(centre.x, y, centre.z),
    rotation: Quaternion.fromEulerDegrees(0, boardYaw, 0),
    scale: Vector3.create(side, side, side)
  })
  return entity
}

const boardLetterEntities = new Map<number, Entity>()
const boardLetterValues = new Map<number, number>()

/** Reconcile the rendered board with the synced cell array. Cheap when nothing changed. */
export function syncBoardVisuals(): void {
  const cells = getBoardCells()
  for (let i = 0; i < cells.length; i++) {
    const value = cells[i]
    const shown = boardLetterValues.get(i) || 0
    if (value === shown) continue

    if (value === 0) {
      const existing = boardLetterEntities.get(i)
      if (existing) {
        engine.removeEntity(existing)
        boardLetterEntities.delete(i)
        activeLetterIndex.delete(existing)
      }
      boardLetterValues.delete(i)
      continue
    }

    let entity = boardLetterEntities.get(i)
    if (!entity) {
      // Committed: seated into the board.
      entity = createBoardLetterEntity(i, true)
      boardLetterEntities.set(i, entity)
    }
    styleAsLetter(entity, value - 1)
    boardLetterValues.set(i, value)
  }
}

/** Drop every rendered letter — used when a round resets. */
export function clearBoardVisuals(): void {
  for (const entity of boardLetterEntities.values()) {
    engine.removeEntity(entity)
    activeLetterIndex.delete(entity)
  }
  boardLetterEntities.clear()
  boardLetterValues.clear()
}

/* ------------------------------------------------------------------ *
 * Staged (not-yet-submitted) letters — a purely local preview.
 *
 * These never touch synced state: the tile stays HELD by the player in
 * TileState the whole time it's staged, and the board write only happens on
 * a successful submit. So a rejected/cancelled submission needs no server
 * round trip to undo — just remove these preview entities.
 * ------------------------------------------------------------------ */

const stagedLetterEntities = new Map<number, Entity>()

export function showStagedLetter(cell: number, letterIndex: number): void {
  let entity = stagedLetterEntities.get(cell)
  if (!entity) {
    // Staged: left standing proud of the board until it's actually accepted.
    entity = createBoardLetterEntity(cell, false)
    stagedLetterEntities.set(cell, entity)
  }
  styleAsLetter(entity, letterIndex)
}

export function clearStagedLetter(cell: number): void {
  const entity = stagedLetterEntities.get(cell)
  if (entity) {
    engine.removeEntity(entity)
    stagedLetterEntities.delete(cell)
    activeLetterIndex.delete(entity)
  }
}

export function clearAllStagedLetters(): void {
  for (const entity of stagedLetterEntities.values()) {
    engine.removeEntity(entity)
    activeLetterIndex.delete(entity)
  }
  stagedLetterEntities.clear()
}

/* ------------------------------------------------------------------ *
 * Cell highlight under the player's feet
 * ------------------------------------------------------------------ */

let highlight: Entity | null = null
let beam: Entity | null = null
let highlightCell = -2
let highlightValid = false

const OK_FILL = Color4.create(0.2, 1, 0.5, 0.55)
const OK_GLOW = Color4.create(0.2, 1, 0.5, 1)
const BAD_FILL = Color4.create(1, 0.3, 0.25, 0.5)
const BAD_GLOW = Color4.create(1, 0.3, 0.25, 1)

/**
 * The pad alone is nearly invisible on a phone held at arm's length, so the
 * target also gets a tall translucent beam that reads from across the plaza.
 */
export function setupHighlight(): void {
  highlight = engine.addEntity()
  Transform.create(highlight, {
    position: Vector3.create(0, -50, 0),
    scale: Vector3.create(BOARD_CELL_SIZE - 0.05, 0.06, BOARD_CELL_SIZE - 0.05)
  })
  MeshRenderer.setBox(highlight)
  VisibilityComponent.create(highlight, { visible: false })

  beam = engine.addEntity()
  Transform.create(beam, {
    position: Vector3.create(0, -50, 0),
    scale: Vector3.create(BOARD_CELL_SIZE * 0.34, 5, BOARD_CELL_SIZE * 0.34)
  })
  MeshRenderer.setBox(beam)
  VisibilityComponent.create(beam, { visible: false })

  paintHighlight(true)
}

function paintHighlight(valid: boolean): void {
  if (!highlight || !beam) return
  Material.setPbrMaterial(highlight, {
    albedoColor: valid ? OK_FILL : BAD_FILL,
    emissiveColor: valid ? OK_GLOW : BAD_GLOW,
    emissiveIntensity: 2.2,
    roughness: 1
  })
  Material.setPbrMaterial(beam, {
    albedoColor: valid
      ? Color4.create(0.2, 1, 0.5, 0.18)
      : Color4.create(1, 0.3, 0.25, 0.16),
    emissiveColor: valid ? OK_GLOW : BAD_GLOW,
    emissiveIntensity: 1.4,
    roughness: 1
  })
}

export function showHighlight(cell: number, valid: boolean): void {
  if (!highlight || !beam) return

  if (cell < 0) {
    if (highlightCell !== -1) {
      highlightCell = -1
      VisibilityComponent.createOrReplace(highlight, { visible: false })
      VisibilityComponent.createOrReplace(beam, { visible: false })
    }
    return
  }

  // Only touch components when something actually changed — this runs every frame.
  if (cell !== highlightCell) {
    const centre = cellCenter(cell)
    Transform.getMutable(highlight).position = Vector3.create(centre.x, BOARD_Y + 0.06, centre.z)
    Transform.getMutable(beam).position = Vector3.create(centre.x, BOARD_Y + 2.5, centre.z)
    if (highlightCell < 0) {
      VisibilityComponent.createOrReplace(highlight, { visible: true })
      VisibilityComponent.createOrReplace(beam, { visible: true })
    }
    highlightCell = cell
  }
  if (valid !== highlightValid) {
    highlightValid = valid
    paintHighlight(valid)
  }
}
