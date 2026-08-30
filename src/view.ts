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
  Name,
  TextureWrapMode,
  Transform,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlatform } from '@dcl/sdk/platform'
import { TEXTURE_ALPHABET, TEXTURE_ALPHABET_UI, TileStatus } from './config'
import { letterPlaneUvs } from './letters'
import { BOARD_CELL_SIZE, BOARD_Y } from './generated/layout'
import { cellCenter } from './board'
import { TileState, tileEntities, getBoardCells } from './state'
import { quality } from './platform'

/**
 * A letter tile is a box PLUS 5 planes, not one shape:
 *
 *  - a solid, untextured "backing" box — this is the tile's actual color. It
 *    has to exist as separate opaque geometry because the sheet's background
 *    is transparent, and an alpha-tested texture on a single shape would
 *    punch a hole straight through to whatever is behind the tile, not
 *    reveal a color.
 *  - 5 "decal" planes glued to the backing's top + 4 side faces (no bottom —
 *    see `DECAL_FACES`), alpha-tested against the sprite sheet, carrying only
 *    the glyph. Each plane's transparent area lets the backing underneath
 *    show through.
 *
 * This used to be a single 6-face box for the decal instead of 5 planes.
 * Real-device testing on Godot Explorer never got a box's per-face UVs fully
 * right (see letters.ts's `letterPlaneUvs` for the two failed attempts and
 * why); a plane only needs one crop, applied once, with no per-face winding
 * to guess at, so 5 of them replaced the 1 box.
 *
 * Each decal plane sits exactly on the backing's outer surface (offset 0.5 —
 * see `DECAL_FACES`) while the backing itself is inset to INNER_SCALE — so
 * the decal is still strictly outside the backing and their surfaces never
 * sit exactly coplanar, avoiding z-fighting on the glyph itself, which IS
 * opaque and does render at the decal's surface.
 */
const INNER_SCALE = 0.9

/** Side length of a letter cube resting on the board — same shape as a pickable tile. */
const BOARD_LETTER_SIZE = 1.3

/**
 * Crop via custom mesh UVs (`MeshRenderer.setPlane(face, uvs)`), NOT the
 * material's `texture.offset`/`texture.tiling`. A letter change only ever
 * rewrites each decal face's mesh from here on — the Material is bound once
 * per face, in `ensureLetterVisual`, and never touched again after that.
 *
 * An earlier version of this file did the crop via offset/tiling specifically
 * to dodge per-face UV winding not being uniform on a box (see letters.ts)
 * — an unrelated later investigation identified swapping the whole Material
 * on every letter change (which offset/tiling requires, since each letter
 * needs a differently-parameterized `Texture.Common`) as the cause of a ~1s
 * wrong-letter flash on some clients. Rewriting only a mesh's uvs avoids
 * that: the Material component's value never changes after setup.
 *
 * `TEXTURE_ALPHABET_MATERIAL_TEXTURE` is the one, unchanging texture
 * reference every decal face's Material points at forever.
 */
const TEXTURE_ALPHABET_MATERIAL_TEXTURE = Material.Texture.Common({
  src: TEXTURE_ALPHABET,
  wrapMode: TextureWrapMode.TWM_CLAMP
})

/**
 * Committed board letters use this instead, per explicit user request:
 * TEXTURE_ALPHABET's own glyph pixels are opaque BLACK on an otherwise fully
 * transparent sheet (confirmed by direct pixel inspection — no white in it at
 * all beyond a handful of stray antialiasing pixels), which was reportedly
 * hard to make out once a tile is inset into the board. This sheet carries
 * the exact same glyph pixels at the exact same 8x8 cell coordinates
 * (confirmed pixel-for-pixel identical against TEXTURE_ALPHABET), so
 * `letterPlaneUvs` crops it correctly with zero changes — the only
 * difference is an opaque white rounded chip baked in behind each glyph,
 * giving the glyph its own guaranteed-contrast backdrop independent of
 * whatever's around it. Scoped to committed board letters only (see
 * `syncBoardVisuals`) — loose/held tiles and staged (not-yet-submitted)
 * board previews keep the plain sheet, ask if those should switch too.
 */
const TEXTURE_ALPHABET_UI_MATERIAL_TEXTURE = Material.Texture.Common({
  src: TEXTURE_ALPHABET_UI,
  wrapMode: TextureWrapMode.TWM_CLAMP
})

/**
 * Under the OLD material-offset/tiling crop, Godot needed `flip = true` and
 * Unity needed `flip = false` — that asymmetry came from each engine's OWN
 * default box UV unwrap running a different V direction, which the material
 * remap was layered on top of. The decal doesn't go through any default UV
 * anymore (mesh UVs are supplied explicitly, per letter, on planes) — that
 * indirection is gone, so the platform asymmetry it caused should be gone
 * too. Real-device testing on Godot mobile with the inherited `true` default
 * showed wrong crops (small/wrong-cell glyphs) alongside Unity being
 * correct at `false`, consistent with both platforms now wanting the same,
 * unflipped value. No longer toggled by `applyPlatformFixes` — see there.
 */
let flipV = false

/**
 * The 4 side faces + top of a 1×1×1 cube, as plane transforms relative to
 * the parent. No bottom face — tiles only ever yaw (never pitch or roll, see
 * `boardYaw` below), so the underside is never visible; skipping it halves
 * the per-letter `MeshRenderer.setPlane()` writes for no visual cost.
 *
 * A plane is double-sided with an IDENTICAL (non-mirrored) crop on both
 * sides — confirmed by Decentraland's own worked example for a plane's uvs,
 * see `letterPlaneUvs` in letters.ts — so which of a plane's two default
 * sides ends up facing outward doesn't matter, only which axis it's tipped
 * around does, and a bare 90°/180° axis rotation (never a reflection) can't
 * mirror the glyph either way.
 *
 * The unrotated default was first assumed to lie flat (normal along Y); a
 * real-device check showed every face (including the un-rotated "top" one)
 * came out standing perpendicular to the surface it should sit flush on —
 * meaning the true default stands vertically instead, normal along Z (the
 * common "picture frame" convention most engines use for a bare quad/plane).
 * Rotations below now start from THAT assumption: +Z/-Z need none at all
 * (only a position offset — being double-sided, the same un-rotated plane
 * works facing either way), top needs a 90° tip around X to lie flat, and
 * ±X needs a 90° turn around Y to face sideways instead of along Z.
 */
const DECAL_FACES: { position: Vector3; rotation: Quaternion }[] = [
  { position: Vector3.create(0, 0.5, 0), rotation: Quaternion.fromEulerDegrees(90, 0, 0) }, // top
  { position: Vector3.create(0, 0, 0.5), rotation: Quaternion.fromEulerDegrees(0, 0, 0) }, // +Z
  { position: Vector3.create(0, 0, -0.5), rotation: Quaternion.fromEulerDegrees(0, 0, 0) }, // -Z
  { position: Vector3.create(0.5, 0, 0), rotation: Quaternion.fromEulerDegrees(0, 90, 0) }, // +X
  { position: Vector3.create(-0.5, 0, 0), rotation: Quaternion.fromEulerDegrees(0, -90, 0) } // -X
]

const backingOf = new Map<Entity, Entity>()
const decalOf = new Map<Entity, Entity[]>()

function ensureLetterVisual(parent: Entity, useUiTexture: boolean): { backing: Entity; decals: Entity[] } {
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

  let decals = decalOf.get(parent)
  if (!decals) {
    // Material is bound once here, at creation, from whichever sheet this
    // parent should use — see styleAsLetter, which only ever rewrites mesh
    // uvs afterward, never the Material itself.
    const material = useUiTexture ? DECAL_MATERIAL_BOARD : DECAL_MATERIAL
    decals = DECAL_FACES.map(({ position, rotation }) => {
      const face = engine.addEntity()
      Transform.create(face, { position, rotation, scale: Vector3.create(1, 1, 1), parent })
      MeshRenderer.setPlane(face)
      Material.setPbrMaterial(face, material)
      return face
    })
    decalOf.set(parent, decals)
  }

  return { backing, decals }
}

/**
 * Bound to every decal face exactly once, at creation, right above. Never
 * touched again after that — see `styleAsLetter`, which crops by rewriting
 * each face's mesh UVs instead of swapping this out for a differently-cropped
 * Material.
 */
const DECAL_MATERIAL = {
  texture: TEXTURE_ALPHABET_MATERIAL_TEXTURE,
  albedoColor: Color4.White(),
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_TEST,
  alphaTest: 0.5,
  emissiveColor: Color3.create(0.15, 0.15, 0.15),
  emissiveIntensity: 0.35,
  metallic: 0,
  roughness: 0.75,
  specularIntensity: 0.2
}

/** Same as DECAL_MATERIAL but pointed at the white-backed sheet — see
 * TEXTURE_ALPHABET_UI_MATERIAL_TEXTURE's own comment for why. Used only for
 * committed board letters, via `ensureLetterVisual`'s `useUiTexture` flag. */
const DECAL_MATERIAL_BOARD = {
  ...DECAL_MATERIAL,
  texture: TEXTURE_ALPHABET_UI_MATERIAL_TEXTURE
}

/**
 * Style `parent`'s letter visual. Creates the backing + decal faces on first use.
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
 *
 * Only ever touches each decal face's mesh (`MeshRenderer.setPlane`'s uvs) —
 * never its Material, which is bound once in `ensureLetterVisual` and left
 * alone. That's what makes staging/re-styling an existing entity cheap: it's
 * a mesh data rewrite, not a Material component swap.
 */
function styleAsLetter(parent: Entity, letterIndex: number, useUiTexture = false): void {
  const { decals } = ensureLetterVisual(parent, useUiTexture)
  const uvs = letterPlaneUvs(letterIndex, flipV)
  for (const face of decals) MeshRenderer.setPlane(face, uvs)
  activeLetterIndex.set(parent, letterIndex)
}

/**
 * Every currently-styled letter parent and which glyph it's showing —
 * covers loose tiles, board letters, and staged previews alike.
 *
 * Currently unread: this existed for `applyPlatformFixes` to redraw
 * everything once a platform-dependent V-flip correction resolved a few
 * frames after the initial (possibly wrong) draw. That flip is no longer
 * platform-dependent (see `let flipV = false` above) so nothing walks this
 * map right now — kept rather than deleted since the crop's platform
 * behaviour has flipped back and forth more than once already this project,
 * and this is the thing that would need to come back first if it does again.
 */
const activeLetterIndex = new Map<Entity, number>()

/**
 * Unity Explorer and Godot Explorer used to disagree on TWO independent
 * things for a letter cube — the crop's V-flip and the board letter yaw —
 * both traced to each engine's own default box UV unwrap running in a
 * different direction. Both corrections were removed once the decal moved
 * from a box with a default unwrap to planes with an explicit, per-face UV
 * (see `let flipV = false` and `BOARD_LETTER_YAW` above): real-device
 * testing confirmed both platforms actually want the SAME value now that
 * the thing that made them differ no longer applies.
 *
 * A THIRD instance of the exact same root cause turned up: the board's grid
 * texture (gen-world.mjs's "Board Cells Base") is a single baked image on a
 * STATIC composite-authored box, using that mesh's own default UV unwrap —
 * unlike the letter decals, this is authored once at build time, not
 * recreated at runtime, so it can't be moved to an explicit-UV plane the
 * same way without hand-computing a whole-image crop for a composite entity
 * (composites don't currently carry custom box/plane uvs in this project's
 * generator). Real-device testing confirmed Unity Explorer renders it
 * correctly as authored; Godot Explorer needs a further 180° turn (mobile
 * confirmed — desktop/VR Godot presumably the same, since it's one
 * codebase, though not separately tested). The composite is byte-identical
 * for every client, so there's no way to bake a per-platform difference
 * into it directly — this corrects it here at runtime instead, the same way
 * the crop flip and board yaw used to work before they were unified away.
 * Every composite entity carries a `Name` component (asserted by
 * check-logic.mjs), which is how a specific composite-authored entity gets
 * found from code at all here.
 */
let platformFixDone = false
function applyPlatformFixes(): void {
  if (platformFixDone) return
  const platform = getPlatform()
  if (platform === null) return // not resolved yet — keep polling
  platformFixDone = true

  const isUnity = platform === 'desktop'
  if (!isUnity) {
    for (const [entity, name] of engine.getEntitiesWith(Name)) {
      if (name.value === 'Board Cells Base') {
        Transform.getMutable(entity).rotation = Quaternion.fromEulerDegrees(0, 180, 0)
        break
      }
    }
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
    // own — the actual renderers are `backing`/the decal faces, grandchildren
    // created inside styleAsLetter. Per PBVisibilityComponent's own spec: an
    // entity with no OWN visibility component is only hidden by a PARENT
    // that has propagate=true; with it left at the default (false), backing/
    // decal faces have no own component and no propagating ancestor, so the spec's own
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
 * reads as "up"/the top of the board is -Z. This used to need a
 * platform-dependent half turn — Godot Explorer wanted 180°, Unity Explorer
 * wanted 0° — traced (like the old crop V-flip) to each engine's OWN default
 * box UV unwrap running a different direction. Now that the decal is planes
 * with an explicit, per-face UV (no default box unwrap involved at all — see
 * `DECAL_FACES` and `letterPlaneUvs`), that indirection is gone, same as it
 * was for the crop flip. Real-device testing after the box → plane change
 * confirmed it: Unity stayed correct at 0°, and Godot — inheriting the old
 * 180° default — needed a further 180° to read correctly, landing back on
 * 0°. Both platforms now use the same value; see `applyPlatformFixes`,
 * which no longer touches this at all as a result.
 */
const BOARD_LETTER_YAW = 0
let boardYaw = BOARD_LETTER_YAW

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
    styleAsLetter(entity, value - 1, true) // committed board letter — white-backed sheet, see TEXTURE_ALPHABET_UI_MATERIAL_TEXTURE
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

const OK_FILL = Color4.create(0.2, 1, 0.5, 0.85)
const OK_GLOW = Color4.create(0.2, 1, 0.5, 1)
const BAD_FILL = Color4.create(1, 0.3, 0.25, 0.85)
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
      ? Color4.create(0.2, 1, 0.5, 0.45)
      : Color4.create(1, 0.3, 0.25, 0.42),
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
