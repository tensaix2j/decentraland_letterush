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
 */
const LETTER_TEXTURES = Array.from({ length: 26 }, (_, i) => {
  const crop = letterTextureCrop(i)
  return Material.Texture.Common({
    src: TEXTURE_ALPHABET,
    wrapMode: TextureWrapMode.TWM_CLAMP,
    offset: crop.offset,
    tiling: crop.tiling
  })
})

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
    VisibilityComponent.create(child, { visible: false })
    tileVisuals.push({ child, letter: -1, visible: false })
  }

  engine.addSystem(tileVisualSystem)
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
      VisibilityComponent.createOrReplace(visual.child, { visible: shouldShow })
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
 * board's reading direction — a half turn lines them up.
 */
const BOARD_LETTER_YAW = 180

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
    rotation: Quaternion.fromEulerDegrees(0, BOARD_LETTER_YAW, 0),
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
  for (const entity of boardLetterEntities.values()) engine.removeEntity(entity)
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
  }
}

export function clearAllStagedLetters(): void {
  for (const entity of stagedLetterEntities.values()) engine.removeEntity(entity)
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
