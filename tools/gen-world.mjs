/**
 * Procedural world generator for "Scrabble Parkour".
 *
 * Emits:
 *   assets/scene/main.composite   — every static entity in the scene
 *   src/generated/layout.ts       — layout constants + tile spawn anchors used by runtime code
 *
 * Run with:  npm run gen:world      (or: node tools/gen-world.mjs)
 *
 * Everything is deterministic: change SEED to reroll the mazes / parkour courses.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED = 20260810
/**
 * GLB prop dressing (fetched via tools/fetch-models.sh) is layered on by
 * default. Pass --no-models to skip it and fall back to the bare procedural
 * geometry — e.g. before fetch-models.sh has been run, or for a faster
 * iteration loop that doesn't care about decoration.
 */
const WITH_MODELS = !process.argv.includes('--no-models')

/* ------------------------------------------------------------------ *
 * Deterministic RNG
 * ------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rnd = mulberry32(SEED)
const rf = (lo, hi) => lo + rnd() * (hi - lo)
const ri = (lo, hi) => Math.floor(rf(lo, hi + 1))
const pick = (arr) => arr[ri(0, arr.length - 1)]

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */
const PARCEL = 16
const GRID = 12 // 12 x 12 parcels
const WORLD = GRID * PARCEL // 192 m
const BLOCK = 64 // each zone is 4 x 4 parcels

const ZONES = {
  CENTER: { x0: 64, z0: 64 },
  NORTH: { x0: 64, z0: 128 }, // ice / snow parkour
  SOUTH: { x0: 64, z0: 0 }, // egyptian desert tower
  EAST: { x0: 128, z0: 64 }, // jungle maze
  WEST: { x0: 0, z0: 64 } // industrial parkour
}
const CORNERS = [
  { x0: 0, z0: 0, name: 'SouthWest' },
  { x0: 128, z0: 0, name: 'SouthEast' },
  { x0: 0, z0: 128, name: 'NorthWest' },
  { x0: 128, z0: 128, name: 'NorthEast' }
]

// Scrabble board: 21 x 21 cells of 2 m, centred in the CENTER block.
const BOARD_N = 21
const CELL = 2
const BOARD_SPAN = BOARD_N * CELL // 42
const BOARD_X0 = ZONES.CENTER.x0 + (BLOCK - BOARD_SPAN) / 2 // 75
const BOARD_Z0 = ZONES.CENTER.z0 + (BLOCK - BOARD_SPAN) / 2 // 75
const BOARD_Y = 0.28 // top surface of a board cell

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */
const C = {
  // center / aztec
  plazaStone: [0.62, 0.56, 0.44],
  aztecStone: [0.55, 0.48, 0.38],
  aztecDark: [0.36, 0.31, 0.24],
  aztecJade: [0.16, 0.55, 0.42],
  aztecGold: [0.85, 0.68, 0.24],
  boardFrame: [0.29, 0.2, 0.13],
  cellNormal: [0.85, 0.79, 0.63],
  cellDL: [0.55, 0.78, 0.92],
  cellTL: [0.16, 0.44, 0.78],
  cellDW: [0.94, 0.55, 0.55],
  cellTW: [0.83, 0.2, 0.18],
  cellStar: [0.95, 0.78, 0.25],
  // jungle
  jungleGround: [0.19, 0.34, 0.16],
  jungleHedge: [0.13, 0.42, 0.19],
  jungleHedge2: [0.17, 0.5, 0.24],
  jungleTrunk: [0.29, 0.21, 0.13],
  jungleLeaf: [0.2, 0.6, 0.25],
  jungleStone: [0.35, 0.4, 0.32],
  // industrial
  indGround: [0.24, 0.24, 0.26],
  indSteel: [0.45, 0.47, 0.5],
  indSteelDark: [0.28, 0.3, 0.33],
  indRust: [0.55, 0.31, 0.16],
  indYellow: [0.85, 0.68, 0.12],
  indPipe: [0.38, 0.4, 0.44],
  // egypt
  sand: [0.83, 0.72, 0.45],
  sandstone: [0.78, 0.65, 0.4],
  sandstoneDark: [0.6, 0.48, 0.29],
  egyptGold: [0.87, 0.72, 0.28],
  egyptLapis: [0.15, 0.28, 0.6],
  // ice
  snow: [0.92, 0.95, 0.98],
  ice: [0.65, 0.85, 0.95],
  iceDeep: [0.4, 0.68, 0.85],
  rock: [0.42, 0.44, 0.48],
  rockDark: [0.3, 0.32, 0.36]
}

/* ------------------------------------------------------------------ *
 * Composite builder
 * ------------------------------------------------------------------ */
let nextId = 512
const transforms = {}
const meshRenderers = {}
const meshColliders = {}
const materials = {}
const names = {}
const textShapes = {}
const billboards = {}
const tweens = {}
const tweenSequences = {}
const gltfContainers = {}
const lightSources = {}

/**
 * Every entity still needs its own `core::Material` component entry — that's
 * an ECS invariant, not something a generator script can get around. What
 * WAS wasteful is that every one of those entries carried a brand new `pbr`
 * object, even when hundreds of entities (every "Ground" tile, every wall
 * segment of the same stone colour, ...) specify the exact same colour/
 * metallic/roughness/emissive combination. The scene's material budget is
 * counted against how many distinct materials get uploaded to the GPU, and
 * an engine can only recognise "these are the same material" cheaply if it's
 * actually the same value — so this interns every `pbr` object by its
 * content and hands out the shared instance instead of a fresh one each
 * time. Same visuals, far fewer distinct materials.
 */
const materialCache = new Map()
function internMaterial(pbr) {
  const key = JSON.stringify(pbr)
  let shared = materialCache.get(key)
  if (!shared) {
    shared = pbr
    materialCache.set(key, shared)
  }
  return shared
}

/** Noon. Seconds since midnight; the skybox is pinned here so nothing goes dark. */
const SKYBOX_FIXED_TIME = 43200
/**
 * Enclosed spaces get no sky light no matter what the skybox says, so interior
 * surfaces carry an emissive lift of their own albedo.
 *
 * This is doing more work than it looks: scene dynamic lights are NOT rendered
 * on mobile, so on a phone the braziers below contribute nothing and the lift is
 * the ONLY thing keeping the tomb navigable. Tuned to be readable with no lights
 * at all; on desktop the lights sit on top of it.
 */
const INTERIOR_LIFT = 0.55
const CORRIDOR_LIFT = 0.22

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 }
function yawQuat(deg) {
  const h = (deg * Math.PI) / 360
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }
}
function eulerQuat(xDeg, yDeg, zDeg) {
  const hx = (xDeg * Math.PI) / 360
  const hy = (yDeg * Math.PI) / 360
  const hz = (zDeg * Math.PI) / 360
  const cx = Math.cos(hx),
    sx = Math.sin(hx)
  const cy = Math.cos(hy),
    sy = Math.sin(hy)
  const cz = Math.cos(hz),
    sz = Math.sin(hz)
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz
  }
}

const usedNames = new Set()
function uniqueName(base) {
  let n = base
  let i = 2
  while (usedNames.has(n)) n = `${base}_${i++}`
  usedNames.add(n)
  return n
}

/**
 * Add a primitive entity.
 * opts: { name, pos:[x,y,z], scale:[x,y,z], rot, mesh:'box'|'cylinder'|'sphere'|'plane',
 *         color, emissive, emissiveIntensity, metallic, roughness, collider:0|1|2|3,
 *         radiusTop, radiusBottom, text, fontSize, billboard, tween }
 */
function add(opts) {
  const id = String(nextId++)
  const [px, py, pz] = opts.pos
  const [sx, sy, sz] = opts.scale || [1, 1, 1]

  if (px < 0 || pz < 0 || px > WORLD || pz > WORLD) {
    throw new Error(`Out of bounds entity "${opts.name}" at ${px},${py},${pz}`)
  }

  transforms[id] = {
    json: {
      position: { x: r3(px), y: r3(py), z: r3(pz) },
      scale: { x: r3(sx), y: r3(sy), z: r3(sz) },
      rotation: opts.rot || IDENTITY_ROT,
      parent: 0
    }
  }
  names[id] = { json: { value: uniqueName(opts.name) } }

  const meshKind = opts.mesh || 'box'
  if (meshKind !== 'none') {
    meshRenderers[id] = { json: { mesh: meshJson(meshKind, opts) } }
  }
  if (opts.collider !== 0) {
    meshColliders[id] = {
      json: {
        collisionMask: opts.collider === undefined ? 2 : opts.collider,
        mesh: meshJson(meshKind === 'plane' ? 'box' : meshKind, opts)
      }
    }
  }
  if (opts.color) {
    const [r, g, b] = opts.color
    const pbr = {
      albedoColor: { r: r3(r), g: r3(g), b: r3(b), a: opts.alpha === undefined ? 1 : opts.alpha },
      metallic: opts.metallic === undefined ? 0 : opts.metallic,
      roughness: opts.roughness === undefined ? 0.85 : opts.roughness
    }
    // `lift` self-illuminates a surface with its own colour — the cheap way to
    // stop an enclosed room reading as pitch black.
    if (opts.lift) {
      pbr.emissiveColor = { r: r3(r), g: r3(g), b: r3(b) }
      pbr.emissiveIntensity = opts.lift
    }
    if (opts.emissive) {
      pbr.emissiveColor = { r: opts.emissive[0], g: opts.emissive[1], b: opts.emissive[2] }
      pbr.emissiveIntensity = opts.emissiveIntensity || 1.5
    }
    // A textured surface with no `textureTiling` (e.g. the board's baked
    // grid) uses the mesh's own default UVs directly — the whole face shows
    // the whole image once, since it's a single baked picture, not a
    // repeating material. `textureTiling: [x, y]` opts into TWM_REPEAT and
    // scales the UV so the image repeats that many times across the surface
    // instead of stretching one copy over it — for tileable materials like
    // sand/stone on walls whose size varies a lot (a short wall run and a
    // 20 m one would otherwise show the same single stretched copy).
    if (opts.textureSrc) {
      const texture = { src: opts.textureSrc }
      if (opts.textureTiling) {
        texture.wrapMode = 0 // TextureWrapMode.TWM_REPEAT
        texture.tiling = { x: opts.textureTiling[0], y: opts.textureTiling[1] }
      }
      pbr.texture = { tex: { $case: 'texture', texture } }
    }
    materials[id] = { json: { material: { $case: 'pbr', pbr: internMaterial(pbr) } } }
  }
  if (opts.text) {
    textShapes[id] = {
      json: {
        text: opts.text,
        fontSize: opts.fontSize || 4,
        textColor: { r: 1, g: 0.95, b: 0.8, a: 1 }
      }
    }
  }
  if (opts.light) {
    lightSources[id] = {
      json: {
        active: true,
        color: {
          r: opts.light.color[0],
          g: opts.light.color[1],
          b: opts.light.color[2]
        },
        intensity: opts.light.intensity,
        range: opts.light.range,
        shadow: false,
        type: { $case: 'point', point: {} }
      }
    }
  }
  if (opts.billboard) billboards[id] = { json: { billboardMode: opts.billboard } }
  if (opts.tween) tweens[id] = { json: opts.tween }
  if (opts.tweenSequence) tweenSequences[id] = { json: opts.tweenSequence }
  return id
}

function meshJson(kind, opts) {
  if (kind === 'cylinder') {
    return {
      $case: 'cylinder',
      cylinder: {
        radiusTop: opts.radiusTop === undefined ? 0.5 : opts.radiusTop,
        radiusBottom: opts.radiusBottom === undefined ? 0.5 : opts.radiusBottom
      }
    }
  }
  if (kind === 'sphere') return { $case: 'sphere', sphere: {} }
  // `uvs` must be present (even empty) or the protobuf encoder throws at build time.
  if (kind === 'plane') return { $case: 'plane', plane: { uvs: [] } }
  return { $case: 'box', box: { uvs: [] } }
}

/** Metres of surface per texture repeat, for tileable materials (sand, stone, ...). */
const TILE_METRES = 4
/** [x, y] repeat count for a `textureTiling`-driven surface of this world size. */
const tileRepeat = (widthM, heightM) => [
  Math.max(1, widthM / TILE_METRES),
  Math.max(1, heightM / TILE_METRES)
]

const r3 = (n) => Math.round(n * 1000) / 1000
/** Keep a coordinate safely inside the scene footprint. */
const clampWorld = (n, margin = 1) => Math.min(Math.max(n, margin), WORLD - margin)

/** Ground-level floor slab whose TOP surface sits at `top`. */
function slab(name, cx, cz, sx, sz, top, color, thickness = 0.4) {
  return add({
    name,
    pos: [cx, top - thickness / 2, cz],
    scale: [sx, thickness, sz],
    color,
    collider: 3
  })
}

/* ------------------------------------------------------------------ *
 * Optional GLB decoration
 * ------------------------------------------------------------------ */
const missingModels = new Set()

/** Place a downloaded GLB prop. No-ops if --no-models was passed, or the file doesn't exist. */
function addModel(name, slug, pos, opts = {}) {
  if (!WITH_MODELS) return null
  const src = `assets/Models/${slug}.glb`
  if (!existsSync(resolve(ROOT, src))) {
    missingModels.add(slug)
    return null
  }
  const id = add({
    name,
    pos,
    scale: opts.scale || [1, 1, 1],
    rot: opts.rot || IDENTITY_ROT,
    mesh: 'none',
    collider: 0
  })
  gltfContainers[id] = {
    json: {
      src,
      visibleMeshesCollisionMask: opts.solid ? 3 : 0,
      invisibleMeshesCollisionMask: 3
    }
  }
  return id
}

/* ------------------------------------------------------------------ *
 * Tile spawn anchors (collected per zone, written to layout.ts)
 * ------------------------------------------------------------------ */
const anchors = { NORTH: [], SOUTH: [], EAST: [], WEST: [] }
const addAnchor = (zone, x, y, z) => anchors[zone].push([r3(x), r3(y + 1.0), r3(z)])

/**
 * Landmark spawn points that always hold the SAME letter — unlike the
 * regular `anchors` pool (random position picked from the zone, random
 * letter drawn per spawn), these are meant as a fixed, findable reward: the
 * host always keeps a tile with this exact letter sitting at this exact
 * spot. Written to layout.ts as FIXED_LETTER_ANCHORS; host.ts pins one
 * dedicated tile entity per entry to it (see host.ts's reservation of the
 * last `FIXED_LETTER_ANCHORS.length` tileEntities indices).
 */
const fixedLetterAnchors = []
const addFixedLetterAnchor = (zone, letter, x, y, z) =>
  fixedLetterAnchors.push({ zone, letter, pos: [r3(x), r3(y + 1.0), r3(z)] })

/**
 * Spawn points that must ALWAYS hold a tile, every round — unlike the
 * regular `anchors` pool (which is just eligible for the random
 * zone-cursor/free-anchor picker, so it might go a while without a tile
 * actually landing there), these get a dedicated reserved tile entity, same
 * mechanism as fixedLetterAnchors above, except the letter is drawn at
 * random each time rather than fixed. Written to layout.ts as
 * GUARANTEED_SPAWNS; host.ts reserves one dedicated tileEntities index per
 * entry, placed immediately at the start of every round and respawned
 * immediately (not through the batched spawnTiles() cycle) whenever
 * collected.
 */
const guaranteedSpawns = []
const addGuaranteedSpawn = (zone, x, y, z) => guaranteedSpawns.push({ zone, pos: [r3(x), r3(y + 1.0), r3(z)] })

/* ================================================================== *
 * CENTER — Aztec plaza + 21x21 Scrabble board
 * ================================================================== */

/**
 * >>> ADJUST THE CORNER PYRAMID SCALE HERE. <<<
 *
 * The model's own geometry (assets/models/aztech_pyramid.glb, measured
 * directly from its glTF accessors) is small: at PYRAMID_SCALE = [1,1,1] the
 * visible mesh is only about 1.1 m wide/deep and 0.6 m tall, with its base
 * already sitting at local y = 0 — so PYRAMID_SCALE is a plain multiplier of
 * those numbers (e.g. 12 ⇒ roughly 13 m wide/deep, 7 m tall) and PYRAMID_Y
 * shouldn't need to move to compensate for scale.
 *
 * The old stacked-slab pyramid this replaces was ~13 m wide at the base and
 * ~5.2 m tall, which is where the starting value of 12 came from — tune it
 * to taste once you can see the actual model in-world.
 */
const PYRAMID_MODEL_SRC = 'assets/models/aztech_pyramid.glb'
const PYRAMID_SCALE = [12, 12, 12]
const PYRAMID_ROT = IDENTITY_ROT
const PYRAMID_Y = 0.05 // plaza floor top — matches slab('Plaza Floor', ...) below

/**
 * assets/models/arch.glb replaces the primitive post+lintel gates at the
 * plaza's 4 zone entrances. Its own pivot sits at the base centre of the
 * opening (measured minY = -0.0674, negligible — flat ground placement, same
 * as the trees/mountains/pine). Native size is close to square (width
 * 1.0125 x height 1.0184 x depth 0.189, all measured from the glTF
 * accessors), so ARCH_TARGET_HEIGHT alone drives a uniform scale and the
 * opening stays roughly as wide as it is tall.
 *
 * It ships its own dedicated "*_collider" nodes (one per post + the lintel),
 * so — same convention as the pyramid/mountains/platform — no explicit
 * collision mask is set below.
 *
 * >>> ADJUST GATE SIZE HERE <<<
 */
const ARCH_MODEL_SRC = 'assets/models/arch.glb'
const ARCH_NATIVE_HEIGHT = 1.0184
const ARCH_TARGET_HEIGHT = 7 // metres — matches the old post+lintel gate's overall height
if (!existsSync(resolve(ROOT, ARCH_MODEL_SRC))) {
  throw new Error(`Missing ${ARCH_MODEL_SRC} — the plaza's 4 gateways need this model.`)
}

// Premium-square pattern, defined on the 11x11 top-left quadrant and mirrored.
const key = (a, b) => a * 100 + b
const TW = new Set([key(0, 0), key(0, 7), key(7, 0), key(0, 10), key(10, 0), key(7, 7)])
const DW = new Set([
  key(1, 1), key(2, 2), key(3, 3), key(4, 4), key(5, 5), key(6, 6), key(8, 8), key(9, 9)
])
const TL = new Set([
  key(1, 5), key(5, 1), key(1, 9), key(9, 1), key(5, 9), key(9, 5), key(3, 9), key(9, 3)
])
const DL = new Set([
  key(0, 3), key(3, 0), key(2, 6), key(6, 2), key(3, 7), key(7, 3),
  key(6, 10), key(10, 6), key(2, 10), key(10, 2), key(8, 4), key(4, 8)
])

/** 0 = normal, 1 = DL, 2 = TL, 3 = DW, 4 = TW, 5 = centre star */
function premiumAt(row, col) {
  if (row === 10 && col === 10) return 5
  const qr = Math.min(row, BOARD_N - 1 - row)
  const qc = Math.min(col, BOARD_N - 1 - col)
  const k = key(qr, qc)
  if (TW.has(k)) return 4
  if (DW.has(k)) return 3
  if (TL.has(k)) return 2
  if (DL.has(k)) return 1
  return 0
}
function buildCenter() {
  const { x0, z0 } = ZONES.CENTER
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2

  slab('Plaza Floor', cx, cz, BLOCK, BLOCK, 0.05, C.plazaStone, 0.5)

  // Raised board podium + frame
  slab('Board Podium', cx, cz, BOARD_SPAN + 6, BOARD_SPAN + 6, 0.16, C.aztecDark, 0.4)
  slab('Board Base', cx, cz, BOARD_SPAN + 1.2, BOARD_SPAN + 1.2, 0.2, C.boardFrame, 0.2)

  // The 441 cells used to each be their own individually-coloured entity — one
  // Material component apiece — which alone was closing in on the scene's
  // material budget. The whole board (grid lines AND premium-square colours)
  // is now one baked texture (assets/textures/grid.png, maintained directly by
  // hand) painted across a single entity: 441 materials down to 1.
  //
  // premiumAt() itself is still exported as CELL_PREMIUM to
  // src/generated/layout.ts — scoring logic (board.ts) needs to know where
  // the bonus squares are regardless of how they're drawn, it just no
  // longer drives an entity here.
  add({
    name: 'Board Cells Base',
    pos: [cx, BOARD_Y - 0.04, cz],
    scale: [BOARD_SPAN, 0.08, BOARD_SPAN],
    color: [1, 1, 1],
    textureSrc: 'assets/textures/grid.png',
    roughness: 0.8,
    collider: 3
  })

  // Aztec pyramids at the four plaza corners — a single hand-placed GLB
  // (assets/models/aztech_pyramid.glb), replacing the old 4-step stacked-slab
  // primitive. Unlike the decorative props in the four zones (addModel(),
  // skipped entirely if --no-models is passed or the file's missing), this
  // is core plaza geometry now, so it's placed directly and unconditionally
  // — the scene shouldn't lose its corner landmarks over a flag or a missed
  // download.
  if (!existsSync(resolve(ROOT, PYRAMID_MODEL_SRC))) {
    throw new Error(`Missing ${PYRAMID_MODEL_SRC} — the plaza's corner pyramids need this model.`)
  }
  const pyramidSpots = [
    [x0 + 8, z0 + 8], [x0 + BLOCK - 8, z0 + 8],
    [x0 + 8, z0 + BLOCK - 8], [x0 + BLOCK - 8, z0 + BLOCK - 8]
  ]
  for (const [px, pz] of pyramidSpots) {
    const id = add({
      name: 'Aztec Pyramid',
      pos: [px, PYRAMID_Y, pz],
      scale: PYRAMID_SCALE,
      rot: PYRAMID_ROT,
      mesh: 'none', // geometry comes from the glTF below, not a primitive
      collider: 0 // collision comes from the model's own collider mesh (see gltfContainers below), not a generic box
    })
    // No explicit collision masks — PBGltfContainer's own defaults
    // (visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: CL_POINTER
    // | CL_PHYSICS) already do exactly what this model wants: collide against
    // its dedicated low-poly "obj_collider" node, not the detailed visible
    // mesh. Setting them explicitly here would just be restating the default.
    gltfContainers[id] = { json: { src: PYRAMID_MODEL_SRC } }
  }

  // The glyph pillar ring that used to circle the board here (7x "Aztec
  // Pillar" + "Aztec Pillar Glyph" primitives, radius 28.5m from board
  // centre) was removed: at that radius two of the seven pillars land only
  // ~6.5m from a corner pyramid's footprint edge — about the same as the
  // pyramid's own half-width at its current scale — so they read as
  // clashing/overlapping the pyramid. It dated back to when the corner
  // pyramids were small stacked-slab primitives; now that they're a much
  // bigger GLB landmark, the ring is redundant clutter as well as a clash.

  // Four ceremonial gateways aligned with the four gameplay zones — arch.glb
  // (ARCH_MODEL_SRC, above) replaces the old primitive post+lintel pairs.
  // The per-zone lintel tint (g.color) doesn't carry over: the GLB uses its
  // own single baked material, so there's no per-instance recolor the way a
  // primitive's `color` field allowed. The floating zone-name Sign is kept
  // for wayfinding, just repositioned to sit above the new arch height.
  const gates = [
    { name: 'Gate North (Mountain)', x: cx, z: z0 + BLOCK - 1.5, yaw: 0 },
    { name: 'Gate South (Desert)', x: cx, z: z0 + 1.5, yaw: 0 },
    { name: 'Gate East (Jungle)', x: x0 + BLOCK - 1.5, z: cz, yaw: 90 },
    { name: 'Gate West (Fortress)', x: x0 + 1.5, z: cz, yaw: 90 }
  ]
  const archScale = ARCH_TARGET_HEIGHT / ARCH_NATIVE_HEIGHT
  for (const g of gates) {
    const id = add({
      name: g.name,
      pos: [g.x, 0.05, g.z],
      scale: [archScale, archScale, archScale],
      rot: yawQuat(g.yaw),
      mesh: 'none', // geometry comes from the glTF below, not a primitive
      collider: 0
    })
    gltfContainers[id] = { json: { src: ARCH_MODEL_SRC } }
    add({
      name: `${g.name} Sign`,
      pos: [g.x, ARCH_TARGET_HEIGHT + 1.2, g.z],
      scale: [1, 1, 1],
      mesh: 'none',
      collider: 0,
      text: g.name.replace('Gate ', ''),
      fontSize: 4,
      billboard: 2
    })
  }
}

/* ================================================================== *
 * Maze helper — recursive backtracker on a (2n+1) wall grid
 * ================================================================== */
function generateMaze(cols, rows) {
  const W = cols * 2 + 1
  const H = rows * 2 + 1
  const wall = Array.from({ length: H }, () => new Array(W).fill(true))
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false))
  const stack = [[0, 0]]
  seen[0][0] = true
  wall[1][1] = false
  while (stack.length) {
    const [cr, cc] = stack[stack.length - 1]
    const opts = []
    if (cr > 0 && !seen[cr - 1][cc]) opts.push([-1, 0])
    if (cr < rows - 1 && !seen[cr + 1][cc]) opts.push([1, 0])
    if (cc > 0 && !seen[cr][cc - 1]) opts.push([0, -1])
    if (cc < cols - 1 && !seen[cr][cc + 1]) opts.push([0, 1])
    if (!opts.length) {
      stack.pop()
      continue
    }
    const [dr, dc] = pick(opts)
    const nr = cr + dr
    const nc = cc + dc
    seen[nr][nc] = true
    wall[cr * 2 + 1 + dr][cc * 2 + 1 + dc] = false
    wall[nr * 2 + 1][nc * 2 + 1] = false
    stack.push([nr, nc])
  }
  return { wall, W, H }
}

/** Add extra loops so the maze is fun to run rather than a pure dead-end tree. */
function braidMaze(wall, W, H, chance) {
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (!wall[r][c]) continue
      if ((r % 2 === 1) === (c % 2 === 1)) continue // only knock out edge walls
      if (rnd() < chance) wall[r][c] = false
    }
  }
}

/** Merge wall cells into horizontal runs, then leftover vertical runs. */
function mergeWallRuns(wall, W, H) {
  const used = Array.from({ length: H }, () => new Array(W).fill(false))
  const runs = []
  for (let r = 0; r < H; r++) {
    let c = 0
    while (c < W) {
      if (!wall[r][c] || used[r][c]) {
        c++
        continue
      }
      let end = c
      while (end + 1 < W && wall[r][end + 1] && !used[r][end + 1]) end++
      if (end > c) {
        for (let k = c; k <= end; k++) used[r][k] = true
        runs.push({ r0: r, c0: c, r1: r, c1: end })
      }
      c = end + 1
    }
  }
  for (let c = 0; c < W; c++) {
    let r = 0
    while (r < H) {
      if (!wall[r][c] || used[r][c]) {
        r++
        continue
      }
      let end = r
      while (end + 1 < H && wall[end + 1][c] && !used[end + 1][c]) end++
      for (let k = r; k <= end; k++) used[k][c] = true
      runs.push({ r0: r, c0: c, r1: end, c1: c })
      r = end + 1
    }
  }
  return runs
}

/**
 * The 3 canopy tree GLBs (assets/models/tree_0/1/2.glb), replacing the old
 * trunk-cylinder + canopy-sphere primitive pair. Per explicit user
 * direction, all 3 are treated as pivoted at their own base (bottom-centre =
 * local (0,0,0)) regardless of what the currently-committed files measure —
 * the files in assets/models/ are expected to be replaced with correctly-
 * pivoted exports, so no per-model offset is applied here. If trees still
 * look sunk/floating after that swap, re-measure and add a `nativeMinY`
 * offset back in (see addPine/the mountains/the rocks for that pattern).
 *
 * >>> ADJUST TREE SIZE HERE <<< — see `targetHeight` where TREE_MODELS is
 * used, in buildEast() below. Scale is derived from targetHeight and
 * nativeHeight, so all 3 variants come out the same final height regardless
 * of how tall their raw meshes happen to be.
 */
const TREE_MODELS = [
  { src: 'assets/models/tree_0.glb', nativeHeight: 0.382 },
  { src: 'assets/models/tree_1.glb', nativeHeight: 0.422 },
  { src: 'assets/models/tree_2.glb', nativeHeight: 0.489 }
]

/**
 * assets/models/platform_2.glb replaces the jungle maze's flat-colored box
 * wall runs, per explicit user request ("regardless of stretch"). Measured
 * directly from the file: it's a floating-island/disc shape (node name
 * "Island01"), pivoted at its TOP (local maxY ~0, the body hangs DOWN from
 * there to local minY -0.7735) — the OPPOSITE of hedge.glb/the trees, which
 * are bottom-pivoted. Placement below accounts for that (position.y is the
 * wall's TOP, not its base).
 *
 * Two things worth flagging even though stretch itself was explicitly
 * waived: it carries 2 materials per instance (double hedge.glb's 1, so
 * budget cost per wall run is double what that alternative would have
 * been), and its own dedicated collider is a CYLINDER (`Cylinder_collider`),
 * not a box. Scaling a cylinder non-uniformly to fill a long rectangular
 * wall run leaves the footprint's corners uncovered — unlike hedge.glb's
 * clean unit-cube collider, this one won't reliably block a player who
 * walks into a wall run's far corner. That's a real gameplay gap, not just
 * a visual one — worth testing in-client specifically at the ends of the
 * longer merged runs.
 */
const PLATFORM2_MODEL_SRC = 'assets/models/platform_2.glb'
if (!existsSync(resolve(ROOT, PLATFORM2_MODEL_SRC))) {
  throw new Error(`Missing ${PLATFORM2_MODEL_SRC} — the jungle maze's walls need this model.`)
}
const PLATFORM2_NATIVE = { width: 0.887, height: 0.7772, depth: 0.914 } // measured, see header comment

/* ================================================================== *
 * EAST — Jungle maze
 * ================================================================== */
function buildEast() {
  const { x0, z0 } = ZONES.EAST
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Jungle Ground', cx, cz, BLOCK, BLOCK, 0.05, C.jungleGround, 0.5)

  // Wall runs already get merged into fewer, longer hedge entities below, but
  // a 19x19 grid still produces well over 200 of them once braiding fragments
  // things — a big chunk of the scene's material budget for one maze. 13x13
  // keeps a real maze (wider corridors, same amount of ground covered) for a
  // large cut in segment count.
  const cols = 6
  const rows = 6
  const { wall, W, H } = generateMaze(cols, rows)
  braidMaze(wall, W, H, 0.16)
  // open a doorway on the west side facing the plaza
  wall[Math.floor(H / 2)][0] = false

  const step = (BLOCK - 4) / W // ~1.58 m per wall cell
  const ox = x0 + 2
  const oz = z0 + 2
  // 3.6m was a uniform height for every hedge run — per direct user report,
  // players were simply jumping clean over it, making the maze's walls a
  // non-obstacle. 3.6m sits right around what a running double-jump can
  // clear, which explains it: it wasn't a hard barrier, just a low hurdle.
  // Mixed per-run heights fix that with real variety instead of one bigger
  // number: WALL_HEIGHT_MULT 1x keeps this same climbable-onto height (a
  // player can still scale/stand on these — useful as shortcuts or vantage
  // points, not a bug), while 2x (7.2m) and 3x (10.8m) go well past any
  // jump/double-jump combo, so the maze always has some genuinely impassable
  // walls forcing real navigation. Chosen per wall RUN (not per cell), so an
  // entire merged hedge segment reads as one consistent height rather than
  // jittering cell to cell.
  //
  // This IS still "random" (pick() off the seeded rnd() stream), but that's
  // exactly the "random in a consistent way" the user asked for: gen-world.mjs
  // is a build-time script, not something that re-rolls per player visit —
  // it bakes ONE static main.composite from the fixed SEED constant above,
  // so the exact same wall gets the exact same height for every player,
  // every time, until someone deliberately reruns the generator (or changes
  // SEED). Nothing about this varies at runtime/per session.
  const WALL_BASE_H = 3.6
  const WALL_HEIGHT_MULT = [1, 2, 3]

  // Rectangles for every wall run's footprint + its own rolled height
  // (world-space, XZ), captured so the canopy-tree loop below can tell
  // whether a candidate spot lands on top of a wall and needs to sit at that
  // wall's own top height instead of ground level, rather than looking
  // buried in it.
  const wallRects = []

  for (const run of mergeWallRuns(wall, W, H)) {
    const lenC = run.c1 - run.c0 + 1
    const lenR = run.r1 - run.r0 + 1
    const px = ox + (run.c0 + lenC / 2) * step
    const pz = oz + (run.r0 + lenR / 2) * step
    const halfW = (lenC * step) / 2
    const halfD = (lenR * step) / 2
    const wallH = WALL_BASE_H * pick(WALL_HEIGHT_MULT)
    wallRects.push({ x0: px - halfW, x1: px + halfW, z0: pz - halfD, z1: pz + halfD, h: wallH })
    const id = add({
      name: 'Jungle Hedge',
      // TOP-pivoted (body hangs down from here) — see PLATFORM2_MODEL_SRC.
      pos: [px, wallH + 0.05, pz],
      scale: [(lenC * step) / PLATFORM2_NATIVE.width, wallH / PLATFORM2_NATIVE.height, (lenR * step) / PLATFORM2_NATIVE.depth],
      rot: yawQuat(0),
      mesh: 'none', // geometry comes from the glTF below, not a primitive
      collider: 0
    })
    gltfContainers[id] = {
      json: {
        src: PLATFORM2_MODEL_SRC,
        // Dedicated cylinder collider — see PLATFORM2_MODEL_SRC's own
        // comment on why this may not fully block a run's corners.
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 3
      }
    }
  }

  // A light dusting of jungle-plant-06 against/on top of a few wall runs —
  // hard-capped at 3 total per explicit request (was much heavier before:
  // a per-face pass plus a separate per-top pass, on top of a 70-instance
  // ground scatter in buildDecoration(), all deemed too ugly/busy). Uses the
  // same wallRects footprints as groundYAt below rather than reasoning about
  // platform_2.glb's actual scaled mesh shape — good enough for a "leans
  // against/sits on the wall" approximation. Optional dressing, gated behind
  // --no-models like every other addModel() call.
  const MAX_WALL_PLANTS = 3
  let wallPlantsPlaced = 0
  for (const r of wallRects) {
    if (wallPlantsPlaced >= MAX_WALL_PLANTS) break
    if (rnd() < 0.7) continue // only a few walls get a plant at all
    const onTop = rnd() < 0.5
    let px, pz, py
    if (onTop) {
      px = rf(r.x0, r.x1)
      pz = rf(r.z0, r.z1)
      py = r.h + 0.05
    } else {
      const alongX = r.x1 - r.x0 >= r.z1 - r.z0
      if (alongX) {
        px = rf(r.x0, r.x1)
        pz = rnd() < 0.5 ? r.z0 - 0.15 : r.z1 + 0.15 // hug one long face
      } else {
        pz = rf(r.z0, r.z1)
        px = rnd() < 0.5 ? r.x0 - 0.15 : r.x1 + 0.15
      }
      py = 0.05 // ground-pivoted model — sits at the floor, not floating partway up the face
    }
    const scale = rf(0.9, 1.5)
    addModel('Jungle Wall Plant', 'jungle-plant-06', [px, py, pz], {
      scale: [scale, scale, scale],
      rot: yawQuat(rf(0, 360))
    })
    wallPlantsPlaced++
  }

  /** Ground Y a tree/prop at (px,pz) should sit at — that wall's own
   * top height if it falls inside a hedge's footprint, plain ground
   * otherwise. */
  function groundYAt(px, pz) {
    for (const r of wallRects) {
      if (px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1) return r.h + 0.05
    }
    return 0.05
  }

  // Passage cells become tile anchors
  for (let r = 1; r < H; r += 2) {
    for (let c = 1; c < W; c += 2) {
      if (wall[r][c]) continue
      const px = ox + (c + 0.5) * step
      const pz = oz + (r + 0.5) * step
      addAnchor('EAST', px, 0.05, pz)
    }
  }

  // Forced spawns supplied directly by the user (exact final world-space
  // positions, verified reachable by them in-client) — must ALWAYS have a
  // tile every round, so these use addGuaranteedSpawn (reserved tile slot,
  // same mechanism as the SOUTH pyramid's fixed Q/Z letters) rather than the
  // regular addAnchor pool the maze-passage loop above uses. Same -1.0 m
  // correction, to cancel addGuaranteedSpawn's own +1.0 m pickup clearance
  // and land exactly where specified.
  const EAST_GUARANTEED_TILE_SPAWNS = [
    [156, 0.5, 100],
    [183, 0.5, 101],
    [174, 0.5, 73]
  ]
  for (const [px, py, pz] of EAST_GUARANTEED_TILE_SPAWNS) {
    addGuaranteedSpawn('EAST', px, py - 1.0, pz)
  }

  // Canopy trees around the maze perimeter — 3 hand-placed GLB variants
  // (TREE_MODELS, above), replacing the old trunk-cylinder + canopy-sphere
  // primitive pair. Unconditional/required, same treatment as the plaza's
  // corner pyramid: this is core zone dressing now, not an optional prop
  // gated by --no-models, so the jungle shouldn't go bald over a flag.
  for (const t of TREE_MODELS) {
    if (!existsSync(resolve(ROOT, t.src))) {
      throw new Error(`Missing ${t.src} — the jungle's canopy trees need this model.`)
    }
  }
  /** Places one canopy tree at (px, groundY, pz), random model + yaw, target
   * height in metres. Shared by the random perimeter loop and the fixed
   * user-picked spots below so both stay in sync with TREE_MODELS. */
  function placeTree(px, pz, groundY, targetHeight) {
    const tree = pick(TREE_MODELS)
    const scale = targetHeight / tree.nativeHeight
    const id = add({
      name: 'Jungle Tree',
      pos: [px, groundY, pz], // treated as pivoted at bottom-centre — see TREE_MODELS
      scale: [scale, scale, scale],
      rot: yawQuat(rf(0, 360)),
      mesh: 'none', // geometry comes from the glTF below, not a primitive
      collider: 0
    })
    gltfContainers[id] = {
      json: {
        src: tree.src,
        // Unlike the corner pyramid, these ship no dedicated collider mesh —
        // collide against the visible geometry directly.
        visibleMeshesCollisionMask: 3
      }
    }
  }

  // Every canopy tree's (x, y, z) is now a hard-coded, hand-placed spot —
  // NOT drawn from the shared seeded RNG stream. This used to be an 8-tree
  // random-edge loop plus a handful of exact user-picked spots, but ANY
  // unrelated code change earlier in this same generator (e.g. the jungle
  // wall-plant sprinkle, which also draws from this stream) shifts how many
  // rnd() calls happen before this loop runs, which silently reshuffled
  // every "randomly" placed tree's position on the next regen — exactly the
  // "carefully placed trees are all wrong again" complaint. Baking the
  // random ones down to literal numbers (their last-generated positions,
  // with 2 of them corrected per explicit request below) makes tree
  // placement immune to that for good. Y values are real in-client
  // heights (including sitting on 2x/3x-height wall tops) — placed as
  // given, not run through groundYAt.
  const EAST_FIXED_TREES = [
    [133, 10.3, 110], // was a random tree that landed near 133,10.9,119 — moved per explicit request
    [132.13, 10.85, 67.73],
    [147.78, 10.85, 67.16],
    [189.34, 10.85, 123.84],
    [188.09, 3.65, 79.58],
    [155.12, 10.85, 66.63],
    [188.23, 3.65, 72.36],
    [132.62, 10.85, 124.12],
    [132, 11, 100],
    [133, 3.7, 84],
    [151, 10.9, 91], // was 150,10,92 — moved per explicit request
    [150, 10, 110],
    [169, 10, 102]
  ]
  for (const [px, py, pz] of EAST_FIXED_TREES) {
    placeTree(px, pz, py, rf(8, 15))
  }

  // Loose rocks for flavour (used to be grey "ruin block" box primitives).
  // Non-collidable, same as the boxes they replaced — they scatter across
  // the whole zone including maze corridors, and blocking those would trap
  // players.
  for (let i = 0; i < 7; i++) {
    addRock(rf(x0 + 3, x0 + BLOCK - 3), rf(z0 + 3, z0 + BLOCK - 3), 0.05, rf(0.8, 2.2), false)
  }
}

/**
 * assets/models/platform_1.glb replaces the "Catwalk Platform" and "Moving
 * Platform" primitives. Unlike platform_0 (used in the ice zone, pivoted at
 * its TOP surface per the user), this one measures base-anchored: minY = 0
 * exactly, footprint 2.5 x 2.5m, thickness 0.5m.
 */
const FOUNDRY_PLATFORM_MODEL_SRC = 'assets/models/platform_1.glb'
const FOUNDRY_PLATFORM_NATIVE_WIDTH = 2.5
const FOUNDRY_PLATFORM_NATIVE_THICKNESS = 0.5
if (!existsSync(resolve(ROOT, FOUNDRY_PLATFORM_MODEL_SRC))) {
  throw new Error(`Missing ${FOUNDRY_PLATFORM_MODEL_SRC} — the Foundry's catwalk/moving platforms need this model.`)
}

/**
 * Place a foundry platform with its base at `baseY`, footprint scaled
 * independently in X/Z (`widthX`/`widthZ`, so it can stay a non-square plate
 * like the old catwalk tiles could), held to `thickness` metres tall
 * regardless of footprint so it keeps reading as a thin plate rather than a
 * block. Extra `add()` fields (rot, tween) merge in via `extra`.
 */
function addFoundryPlatform(px, baseY, pz, widthX, widthZ, thickness, extra = {}) {
  const id = add({
    name: 'Foundry Platform',
    pos: [px, baseY, pz],
    scale: [widthX / FOUNDRY_PLATFORM_NATIVE_WIDTH, thickness / FOUNDRY_PLATFORM_NATIVE_THICKNESS, widthZ / FOUNDRY_PLATFORM_NATIVE_WIDTH],
    mesh: 'none',
    collider: 0,
    ...extra
  })
  gltfContainers[id] = { json: { src: FOUNDRY_PLATFORM_MODEL_SRC } }
  return id
}

/**
 * assets/models/fortress.glb — a medieval "wonder"-style castle, added as
 * the West zone's new landmark base (per explicit user decision to retheme
 * this zone from industrial to medieval; the existing "Foundry" walls/floor/
 * naming below are UNCHANGED for now — not part of that request).
 *
 * Measured via the model's own glTF node transforms: local bounds are
 * X[-42.2091, 42.2091], Y[-2.9163, 56.8868], Z[-35.9061, 36.1903] — a
 * native footprint of 84.4 x 72.1 m and a height of 59.8 m.
 *
 * That footprint does NOT fit the 64x64 m zone at native scale (84.4 m wide
 * alone already overflows a 64 m block, and centring it would push past
 * x=0, off the world entirely). FORTRESS_SCALE instead targets a 54 m
 * footprint width — comfortable clearance from the existing perimeter walls
 * — which brings the height down to ~38 m in the process, since this is a
 * single uniform scale (not stretched per-axis, to avoid distorting the
 * model). X is already centred in the model's local space (min/max are
 * symmetric); Z is not quite (local centre sits at +0.1421, not 0) — both
 * are corrected for at placement time below.
 */
const FORTRESS_MODEL_SRC = 'assets/models/fortress.glb'
const FORTRESS_NATIVE_WIDTH = 84.4182
const FORTRESS_MIN_Y = -2.9163
const FORTRESS_Z_CENTRE_OFFSET = 0.1421
const FORTRESS_TARGET_WIDTH = 54
const FORTRESS_SCALE = FORTRESS_TARGET_WIDTH / FORTRESS_NATIVE_WIDTH
if (!existsSync(resolve(ROOT, FORTRESS_MODEL_SRC))) {
  throw new Error(`Missing ${FORTRESS_MODEL_SRC} — the West zone's landmark needs this model.`)
}

/* ================================================================== *
 * WEST — Industrial parkour (retheming to medieval in progress — see
 * FORTRESS_MODEL_SRC above; walls/floor/naming below still read "Foundry")
 * ================================================================== */
function buildWest() {
  const { x0, z0 } = ZONES.WEST
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Foundry Floor', cx, cz, BLOCK, BLOCK, 0.05, C.indGround, 0.5)

  // Fortress landmark — see FORTRESS_MODEL_SRC's own comment for the sizing
  // trade-off (54 m footprint, ~38 m tall as a result of fitting that
  // footprint with one uniform scale).
  //
  // fortressY is pinned to 0 per explicit user request. The floor slab's top
  // surface sits at y=0.05, and the model's own local minY (-2.9163, scaled
  // by FORTRESS_SCALE) is about -1.865 — so at y=0 the fortress's visible
  // base sits roughly 1.865 m below the floor, not flush with it.
  const fortressX = cx
  const fortressY = 0
  const fortressZ = cz - FORTRESS_Z_CENTRE_OFFSET * FORTRESS_SCALE
  const fortressId = add({
    name: 'Fortress',
    pos: [fortressX, fortressY, fortressZ],
    scale: [FORTRESS_SCALE, FORTRESS_SCALE, FORTRESS_SCALE],
    rot: IDENTITY_ROT,
    mesh: 'none',
    collider: 0
  })
  gltfContainers[fortressId] = { json: { src: FORTRESS_MODEL_SRC, visibleMeshesCollisionMask: 3 } }

  // A prior pass added 6 more tile spawns up an "interior staircase" it
  // thought it found by parsing the glTF's mesh bounding boxes — removed per
  // explicit user report that tiles were spawning unreachable, underneath
  // the fortress stairs / inside its walls. That guess was never visually
  // confirmed as open interior space, only inferred from bounding-box shapes
  // stacked in Y — exactly the kind of thing that goes wrong without eyes on
  // the actual render. Only the user-supplied coordinates below (which they
  // tested themselves) remain.

  // Extra fortress spawn points supplied directly by the user (world-space
  // coordinates they found reachable, presumably by walking the model
  // in-client). Given as the exact spot the tile should appear, so — unlike
  // the two loops above, which hand addAnchor a raw floor Y — these get a
  // -1.0 m correction to cancel out addAnchor's own +1.0 m pickup clearance
  // and land exactly where specified.
  const FORTRESS_USER_TILE_SPAWNS = [
    [11, 22, 118],
    [32, 15, 118],
    [53, 15, 119],
    [53, 15, 104],
    [53, 15, 88],
    [53, 15, 73],
    [11, 22, 73],
    [32, 15, 73],
    [11, 11, 97],
    [21, 11, 73]
  ]
  for (const [px, py, pz] of FORTRESS_USER_TILE_SPAWNS) {
    addAnchor('WEST', px, py - 1.0, pz)
  }

  // Second batch of user-supplied fortress spots, added later with the
  // explicit requirement that these ALWAYS have a tile every round — a
  // stronger guarantee than the regular pool above (which is only
  // eligible for the random anchor picker, so it might sit empty a while).
  // Uses addGuaranteedSpawn, not addAnchor: reserved tileEntities slots in
  // host.ts, same mechanism as the SOUTH pyramid's fixed Q/Z letters.
  const WEST_GUARANTEED_TILE_SPAWNS = [
    [13, 27, 100],
    [47, 30, 77],
    [54, 15, 88]
  ]
  for (const [px, py, pz] of WEST_GUARANTEED_TILE_SPAWNS) {
    addGuaranteedSpawn('WEST', px, py - 1.0, pz)
  }

  // Perimeter factory walls — removed per explicit user request (the dark
  // steel-blue "Foundry Wall" boxes no longer fit the medieval retheme).

  // Both the static climb below and the moving platforms further down share
  // this same lift. Raised 1.5 m per explicit user request from the +15 m
  // that put the course roughly level with the fortress's upper-middle
  // (~36.4 m roofline above y=0 — see FORTRESS_MODEL_SRC's comment for the
  // native-height math). At +16.5 m the static course runs 18.1-30 m and the
  // moving platforms 19.5-32.5 m.
  const MOVING_PLATFORM_LIFT = 16.5

  // Ascending platform course, four spiralling tiers
  const PLATFORM_COUNT = 14
  let y = 1.6 + MOVING_PLATFORM_LIFT
  let ang = rf(0, Math.PI * 2)
  let radius = 8
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    ang += rf(0.45, 0.75)
    radius = 8 + ((i / PLATFORM_COUNT) * 18)
    const px = cx + Math.cos(ang) * radius
    const pz = cz + Math.sin(ang) * radius
    if (px < x0 + 3 || px > x0 + BLOCK - 3 || pz < z0 + 3 || pz > z0 + BLOCK - 3) continue
    y += rf(0.55, 1.15)
    const sx = rf(2.4, 4.2)
    const sz = rf(2.4, 4.2)
    // Base-anchored model, so the platform's base sits at y - 0.2 to keep its
    // 0.4m-thick top surface exactly where it was (y + 0.2, matching the
    // addAnchor line right below, unchanged from the old centre-pivoted primitive).
    addFoundryPlatform(px, y - 0.2, pz, sx, sz, 0.4, { rot: yawQuat(rf(0, 90)) })
    addAnchor('WEST', px, y + 0.2, pz)
  }

  // Moving platforms (Tween ping-pong) between tiers.
  //
  // MOVING_PLATFORM_LIFT applied on top of the original 3 + i*2.6 heights
  // (3-16 m) puts these at 19.5-32.5 m.
  //
  // These are exactly the kind of spot the user singled out as the BEST tile
  // spawns — guaranteed reachable, since reaching them is the whole point of
  // the climb, unlike a guessed interior coordinate. Anchor is at the
  // platform's STARTING position (px, pz), matching the static tier loop
  // above; the platform itself still tweens out from under it once spawned,
  // same as any other anchor here (none of them are entity-parented to
  // what's under them).
  for (let i = 0; i < 6; i++) {
    const px = rf(x0 + 10, x0 + BLOCK - 10)
    const pz = rf(z0 + 10, z0 + BLOCK - 10)
    const py = 3 + i * 2.6 + MOVING_PLATFORM_LIFT
    const dx = rf(6, 11)
    const baseY = py - 0.2 // base-anchored model — see the Catwalk Platform loop above

    // i===0 (this seed lands it around 25,19,96) reported as blocking the
    // user's exit near the fortress — dropped per explicit request. Still
    // burns the same rf() draws above so every OTHER platform here, and
    // every zone generated after this one, keeps its exact existing layout
    // (this is one shared seeded RNG stream for the whole world — skipping
    // the draws entirely would reshuffle everything downstream, not just
    // this platform).
    if (i === 0) continue

    addFoundryPlatform(px, baseY, pz, 3.4, 3.4, 0.4, {
      tween: {
        duration: 4200,
        easingFunction: 6, // EF_EASESINE
        mode: {
          $case: 'move',
          move: {
            start: { x: r3(px), y: r3(baseY), z: r3(pz) },
            end: { x: r3(Math.min(px + dx, x0 + BLOCK - 4)), y: r3(baseY), z: r3(pz) }
          }
        },
        playing: true
      },
      tweenSequence: { sequence: [], loop: 1 } // TL_YOYO
    })
    addAnchor('WEST', px, py + 0.2, pz)
  }

  // Silos ("big pillars", pipe.glb) — removed per explicit user request
  // (retheming to medieval; industrial pipes no longer fit). This was the
  // last remaining use of pipe.glb in the West zone — the earlier "thin
  // background pipe runs" were already removed in an prior pass. Also drops
  // 6 tile-spawn anchors that used to sit on top of these; not replaced
  // here since it wasn't asked for, but worth knowing WEST's anchor count
  // just went down as a side effect.
  //
  // Crate stacks (climbable) — also removed per explicit user request
  // (retheming to medieval; crate.glb no longer fits). Was the last
  // remaining use of crate.glb/addCrate in the file, so that function and
  // CRATE_MODEL_SRC were deleted too. Drops another 5 tile-spawn anchors.
}

/**
 * A storey slab with a rectangular hole left open, tiled as up to 4
 * axis-aligned pieces around the hole rather than one solid box (there's no
 * boolean/CSG subtraction available to `add()`, so a real hole means not
 * covering that rectangle with geometry at all).
 *
 * Without this, every tomb ramp dead-ended into a solid ceiling: the storey
 * above covered its ENTIRE footprint with no opening anywhere, regardless of
 * where the ramp below it actually arrived — a ramp to nowhere.
 */
function addFloorRing(labelPrefix, y, textureSrc, outer, hole) {
  const pieces = [
    // West/east strips run the full depth; north/south only span the gap
    // BETWEEN them, so the 4 pieces tile the ring without corner overlap.
    { x0: outer.x0, x1: hole.x0, z0: outer.z0, z1: outer.z1, name: 'West' },
    { x0: hole.x1, x1: outer.x1, z0: outer.z0, z1: outer.z1, name: 'East' },
    { x0: hole.x0, x1: hole.x1, z0: outer.z0, z1: hole.z0, name: 'North' },
    { x0: hole.x0, x1: hole.x1, z0: hole.z1, z1: outer.z1, name: 'South' }
  ]
  for (const p of pieces) {
    const sx = p.x1 - p.x0
    const sz = p.z1 - p.z0
    if (sx <= 0.05 || sz <= 0.05) continue // hole flush with this edge — nothing to fill
    add({
      name: `${labelPrefix} ${p.name}`,
      pos: [(p.x0 + p.x1) / 2, y, (p.z0 + p.z1) / 2],
      scale: [sx, 0.5, sz],
      // White, not the old sandstone tint — a colour tint here would multiply
      // into the texture and colour-cast it. lift's emissive ambient boost
      // (mobile has no dynamic lights) follows the same colour, so it's now a
      // neutral white glow instead of a warm sandstone one.
      color: [1, 1, 1],
      textureSrc,
      // Each ring piece already has its own true sx/sz here (unlike the wall
      // runs, which only have one dimension to work with per shared UV
      // transform) — so this repeats correctly on every piece, not just an
      // approximation of the whole floor's footprint.
      textureTiling: tileRepeat(sx, sz),
      lift: INTERIOR_LIFT,
      collider: 3
    })
  }
}

/**
 * assets/models/pyramid.glb replaces the ENTIRE old multi-storey maze tower
 * (walls, floor rings, ramps, stepped roof, capstone — see buildSouth()
 * below) with a single solid landmark. Per explicit user decision: the
 * interior gameplay (the tower's walkable maze + its tile-spawn anchors)
 * is being redesigned separately later, not rebuilt here — this pass is
 * exterior-only. `TILE_ANCHORS.SOUTH` is empty until that happens;
 * src/host.ts already skips a zone with no anchors during tile spawn/
 * reclaim (`if (!TILE_ANCHORS[zone].length) continue`), so the game runs
 * fine with the desert temporarily anchor-less, it just won't spawn tiles
 * there yet.
 *
 * The model measures suspiciously close to the OLD building's exact
 * footprint/height already (58 x 41 x 58, vs the old 58 x 58 span and
 * ~40.9m to the capstone) — SOUTH_PYRAMID_SCALE is 1 as a result; adjust it
 * here if that changes.
 *
 * Its pivot is NOT centred and NOT base-anchored (measured via the full
 * glTF node transform): local bounds are X[-29.14, 28.86], Y[-8.62, 32.38],
 * Z[-50.01, 7.99]. So placement needs 2 corrections: lower `pos.y` by
 * |minY| to put the base on the ground, and shift `pos.z` by the
 * geometric-centre offset (-21.01) so the pyramid's actual middle lands on
 * the zone centre rather than its pivot.
 *
 * No dedicated "*_collider" node (single mesh, single primitive, unlike the
 * corner pyramid/mountains/gates) — needs an explicit collision mask, same
 * as the trees/rocks/pines.
 */
const SOUTH_PYRAMID_MODEL_SRC = 'assets/models/pyramid.glb'
const SOUTH_PYRAMID_SCALE = 1
const SOUTH_PYRAMID_MIN_Y = -8.6222
const SOUTH_PYRAMID_Z_CENTRE_OFFSET = -21.0126
if (!existsSync(resolve(ROOT, SOUTH_PYRAMID_MODEL_SRC))) {
  throw new Error(`Missing ${SOUTH_PYRAMID_MODEL_SRC} — the South zone's landmark needs this model.`)
}

/**
 * Real floor points for tile-spawn anchors inside the carved pyramid — the
 * bounding-box-with-margin guess this replaces put anchors inside walls
 * (nothing visible/reachable) and right up against a ceiling (one tile
 * poking half through it). This time the mesh's actual triangles were read:
 * for every triangle in the model, compute its face normal, keep only the
 * ones pointing mostly straight up (normal.y > 0.7 — genuine floors, not
 * walls or the sloped ceiling), and cluster by height. That surfaced one
 * dominant, contiguous floor — these are ITS 42 triangle centroids (world
 * X/Z, already carrying `pyramidX`/`pyramidZ` baked in isn't right, they're
 * offsets from the pyramid's pivot the same way SOUTH_PYRAMID_MIN_Y is: add
 * pyramidX/pyramidZ at placement time, same as everywhere else in this file).
 * All 42 sit within 0.05m of local Y -8.59 (world ~0.08m — essentially
 * ground level, so this is the entrance-floor room), with ~7.4m of clearance
 * to the nearest ceiling above it — comfortably safe for addAnchor's own
 * +1.0m tile-height lift.
 *
 * There's a second floor cluster higher up, at local Y ~1.59 — the upper
 * gallery reached by the ramp that spurs off to the left of the entrance
 * (per the actual carved layout: entrance -> left goes up a ramp to this
 * upper floor, right spirals inward on the ground floor). It's smaller (12
 * triangle centroids) and more fragmented than the ground floor, but is a
 * single connected component in its own right, so it's included as its own
 * anchor cluster below.
 */
const SOUTH_PYRAMID_FLOOR_Y = -8.59
// [-2.11, -15.21] deliberately removed from this pool — it's the deepest
// point of this tunnel by actual WALKING distance along the spiral (see
// SOUTH_PYRAMID_Q_LOCAL below — a Dijkstra shortest-path over the connected
// floor mesh, starting from the entrance, not straight-line distance) and is
// reserved below as the fixed 'Q' landmark instead of a random-letter spawn.
// [-21.96, -42.35] was the original (wrong) pick — far in a straight line
// from the entrance, but only 16th-farthest of 42 by real path length,
// because it turned out to be reachable via a much more direct stretch of
// the spiral. It's back in this regular pool now.
const SOUTH_PYRAMID_FLOOR_POINTS = [
  [1.15, 2.21], [-0.77, -1.38], [0.51, 2.21], [-0.14, 2.21], [0.5, -6.6], [-0.77, -8.23],
  [11.1, -6.6], [14.33, -8.23], [3.81, -6.6], [5.84, -8.23], [-3.74, -8.23], [-5.43, -6.6],
  [-9.11, -8.23], [-11.1, -6.6], [-21.15, -8.23], [-23.12, -6.6], [-15.11, -8.23], [-17.14, -6.6],
  [19.42, -6.6], [21.28, -8.23], [21.28, -19.51], [19.42, -29.16], [21.28, -40.58], [19.42, -42.35],
  [-21.96, -42.35], [-24.05, -40.58], [5.09, -42.35], [-7.39, -40.58], [-24.05, -37.58], [-21.96, -36.34],
  [-24.05, -33.15], [-21.96, -31.18], [-10.44, -31.18], [-1.02, -33.15], [11.18, -26.35], [13.95, -23.49],
  [11.18, -31.18], [13.95, -33.15], [11.18, -17.92], [13.95, -15.21], [3.15, -17.92]
]

// Upper gallery — reached via the ramp left of the entrance. Real triangle
// centroids of the connected upper-floor component (see SOUTH_PYRAMID_FLOOR_Y
// comment above for how these clusters were found).
const SOUTH_PYRAMID_UPPER_FLOOR_Y = 1.59
// [-16.1, -37.1] deliberately removed — the deepest point of THIS tunnel,
// reserved below as the fixed 'Z' landmark, same reasoning as the 'Q' one.
const SOUTH_PYRAMID_UPPER_FLOOR_POINTS = [
  [-14.12, -35.46], [-2.56, -37.1], [7.32, -37.1], [7.32, -22.8], [7.32, -11.2], [-9.82, -11.2],
  [-3.79, -14.24], [4.78, -14.24], [4.78, -28.31], [4.78, -35.46], [-7.35, -35.46]
]

// The two tunnel-end landmarks: 'Q' at the deepest point of the ground-floor
// spiral, 'Z' at the deepest point of the upper gallery. High Scrabble value
// (10 each) as an extra nudge, on top of just being a guaranteed findable
// letter, to reward exploring all the way in rather than stopping at the
// entrance room.
//
// Both are placed directly in world space now (see their addFixedLetterAnchor
// calls below), not derived from local pyramid-space + scale arithmetic —
// each started from a mesh-analysis guess (a Dijkstra shortest-path over the
// connected floor mesh, from the entrance, for a true walking-distance
// "deepest point" rather than a naive straight-line one, which for the
// spiral specifically landed on a spot barely a third of the way in since
// the spiral's geometric centre sits close to the entrance in a straight
// line despite needing the whole wound path on foot), and each then got
// corrected/nudged from actual in-world testing. Once a spot needs manual
// correction, world space is one less thing to get wrong versus re-deriving
// local-space offsets.

// Exterior entrance-roof terrace — the flat portico roof directly above the
// entrance colonnade. There are actually TWO stacked quads here with nearly
// identical XZ footprint (x[-8.03,7.76], z roughly [-3,8]), 2.3m apart in Y —
// the lower one (y=2.79) turned out to be a hidden step buried inside the
// solid mass, not the surface the player actually stands on (confirmed by
// the first attempt spawning tiles that read as "buried"). This is the
// UPPER of the two (verts span x[-8.03,7.76] z[-4.20,7.99] at this Y), which
// is the real walkable roof. Points are a 4x3 grid inset 1.6m from the
// quad's true edges (not triangle centroids, since it's a simple flat
// rectangle rather than a fragmented cluster).
const SOUTH_PYRAMID_ENTRANCE_ROOF_Y = 5.07
const SOUTH_PYRAMID_ENTRANCE_ROOF_POINTS = [
  [-6.43, -2.6], [-6.43, 1.9], [-6.43, 6.39], [-2.23, -2.6], [-2.23, 1.9], [-2.23, 6.39],
  [1.96, -2.6], [1.96, 1.9], [1.96, 6.39], [6.16, -2.6], [6.16, 1.9], [6.16, 6.39]
]

/* ================================================================== *
 * SOUTH — Egyptian desert, single pyramid landmark
 * ================================================================== */
function buildSouth() {
  const { x0, z0 } = ZONES.SOUTH
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Desert Sand', cx, cz, BLOCK, BLOCK, 0.05, C.sand, 0.5)

  const pyramidX = cx
  const pyramidY = 0.05 - SOUTH_PYRAMID_MIN_Y * SOUTH_PYRAMID_SCALE
  const pyramidZ = cz - SOUTH_PYRAMID_Z_CENTRE_OFFSET * SOUTH_PYRAMID_SCALE

  const id = add({
    name: 'Pyramid',
    pos: [pyramidX, pyramidY, pyramidZ],
    scale: [SOUTH_PYRAMID_SCALE, SOUTH_PYRAMID_SCALE, SOUTH_PYRAMID_SCALE],
    rot: IDENTITY_ROT,
    mesh: 'none',
    collider: 0
  })
  gltfContainers[id] = { json: { src: SOUTH_PYRAMID_MODEL_SRC, visibleMeshesCollisionMask: 3 } }

  // Tile-spawn anchors — real floor points, see SOUTH_PYRAMID_FLOOR_POINTS above.
  const floorY = pyramidY + SOUTH_PYRAMID_FLOOR_Y * SOUTH_PYRAMID_SCALE
  for (const [lx, lz] of SOUTH_PYRAMID_FLOOR_POINTS) {
    addAnchor('SOUTH', pyramidX + lx * SOUTH_PYRAMID_SCALE, floorY, pyramidZ + lz * SOUTH_PYRAMID_SCALE)
  }

  // Upper-gallery anchors — reached via the ramp left of the entrance.
  const upperFloorY = pyramidY + SOUTH_PYRAMID_UPPER_FLOOR_Y * SOUTH_PYRAMID_SCALE
  for (const [lx, lz] of SOUTH_PYRAMID_UPPER_FLOOR_POINTS) {
    addAnchor('SOUTH', pyramidX + lx * SOUTH_PYRAMID_SCALE, upperFloorY, pyramidZ + lz * SOUTH_PYRAMID_SCALE)
  }

  // Entrance-roof terrace anchors — exterior, atop the entrance colonnade.
  const entranceRoofY = pyramidY + SOUTH_PYRAMID_ENTRANCE_ROOF_Y * SOUTH_PYRAMID_SCALE
  for (const [lx, lz] of SOUTH_PYRAMID_ENTRANCE_ROOF_POINTS) {
    addAnchor('SOUTH', pyramidX + lx * SOUTH_PYRAMID_SCALE, entranceRoofY, pyramidZ + lz * SOUTH_PYRAMID_SCALE)
  }

  // Fixed 'Q'/'Z' landmarks at the two tunnels' deepest points.
  //
  // 'Q' started from the SOUTH_PYRAMID_Q_LOCAL mesh-derived point, then got a
  // small manual nudge to (99, 0.2, 36.3) directly in world space per
  // in-world testing — same reasoning as 'Z' below for going world-space
  // once a mesh-derived pick needs correcting: no local/pyramid-offset
  // arithmetic to get wrong on the way to the final spot.
  addFixedLetterAnchor('SOUTH', 'Q', 99, 0.2, 36.3)
  // Given directly in WORLD space (not derived from SOUTH_PYRAMID_Z_LOCAL /
  // upperFloorY like everything else here) — the mesh-analysis pick above
  // landed on the wrong spot (component 41 turned out to be a disconnected
  // landing, not the actual continuation of the ramp upward; its
  // floor-normal filter likely dropped the sloped ramp surface itself,
  // since a ramp's normal isn't within the >0.7 "floor" threshold). This is
  // the real uphill tunnel's deepest point, reported directly from in-world
  // testing rather than re-derived from the model.
  addFixedLetterAnchor('SOUTH', 'Z', 107, 10.3, 40)

  // Forced spawn supplied directly by the user (exact final world-space
  // position) — must ALWAYS have a tile every round, so this uses
  // addGuaranteedSpawn (reserved tile slot) rather than the mesh-derived
  // addAnchor loops above. Same -1.0 m correction to cancel the internal
  // +1.0 m pickup clearance.
  addGuaranteedSpawn('SOUTH', 96, 0.2 - 1.0, 46)
}

/**
 * The 3 mountain GLBs (assets/models/mountain_0/1/2.glb), replacing the
 * primitive cone mountains in both the north backdrop (buildNorth) and the
 * four corner massifs (buildCorners). `nativeHeight` was measured by walking
 * each file's full node hierarchy (rotation + the ~100x scale baked into
 * every node + translation) down to the visible mesh's accessor bounds —
 * these aren't flat local-space numbers like the trees, the GLBs bake in
 * their own large scale and a -90° X rotation from the Blender export.
 *
 * All 3 are pivoted at their own base (measured minY was -0.04, -0.01, -0.04
 * — negligible), so, like the trees, placement is just ground level.
 *
 * Each model already ships its own baked "*_collider" node (same convention
 * as the corner pyramid) — see the placement code below for why no explicit
 * collision mask is set. mountain_1/mountain_2 also already bake in their own
 * snow-cap material, which is why the old procedural white "Snowcap" cone
 * for tall corner mountains is gone: it would now be redundant.
 *
 * >>> ADJUST MOUNTAIN SIZE HERE <<< — see `targetHeight` at each of the two
 * call sites below (buildNorth's backdrop wall and buildCorners' massifs
 * have separate ranges, same as the primitives they replace did).
 */
const MOUNTAIN_MODELS = [
  { src: 'assets/models/mountain_0.glb', nativeHeight: 1.37, nativeWidth: 1.496, nativeDepth: 1.117 },
  { src: 'assets/models/mountain_1.glb', nativeHeight: 1.911, nativeWidth: 1.079, nativeDepth: 1.103 },
  { src: 'assets/models/mountain_2.glb', nativeHeight: 2.445, nativeWidth: 3.575, nativeDepth: 2.463 }
]
for (const m of MOUNTAIN_MODELS) {
  if (!existsSync(resolve(ROOT, m.src))) {
    throw new Error(`Missing ${m.src} — the north backdrop and corner mountains need this model.`)
  }
}

// Zone rectangles with real built structures a mountain's rotated footprint
// must not spill into. NORTH (ice) is deliberately excluded — that zone is
// itself a mountain backdrop, so overlap there isn't a visual clash.
const MOUNTAIN_CLASH_RECTS = {
  'CENTER (pyramid)': { x0: 64, x1: 128, z0: 64, z1: 128 },
  'EAST (jungle maze)': { x0: 128, x1: 192, z0: 64, z1: 128 },
  'WEST (Foundry)': { x0: 0, x1: 64, z0: 64, z1: 128 },
  'SOUTH (desert tomb)': { x0: 64, x1: 128, z0: 0, z1: 64 }
}

/** Rotated-footprint half-extents for a mountain at `scale`/`yaw` (degrees). */
function mountainFootprint(mountain, px, pz, scale, yaw) {
  const rad = (yaw * Math.PI) / 180
  const halfW = (Math.abs(mountain.nativeWidth * Math.cos(rad)) + Math.abs(mountain.nativeDepth * Math.sin(rad))) * scale * 0.5
  const halfD = (Math.abs(mountain.nativeWidth * Math.sin(rad)) + Math.abs(mountain.nativeDepth * Math.cos(rad))) * scale * 0.5
  return { xMin: px - halfW, xMax: px + halfW, zMin: pz - halfD, zMax: pz + halfD }
}

// Buffer added around each clash rect before testing. A mountain's real
// silhouette is an irregular natural shape, not a clean box, so clearing the
// AABB by a hair (this happened before adding the margin: some corner
// massifs sat as close as 0.6m from the actual wall) still reads as visually
// "eating into" the wall. The margin forces genuine breathing room.
const MOUNTAIN_CLASH_MARGIN = 4
function footprintClashes(fp) {
  return Object.values(MOUNTAIN_CLASH_RECTS).some(
    r =>
      fp.xMin < r.x1 + MOUNTAIN_CLASH_MARGIN &&
      fp.xMax > r.x0 - MOUNTAIN_CLASH_MARGIN &&
      fp.zMin < r.z1 + MOUNTAIN_CLASH_MARGIN &&
      fp.zMax > r.z0 - MOUNTAIN_CLASH_MARGIN
  )
}

const DEBUG_MOUNTAINS = process.env.DEBUG_MOUNTAINS === '1'
const mountainDebugLog = []

/**
 * Place one of the MOUNTAIN_MODELS at `[px, pz]`, scaled to `targetHeight`
 * metres tall. Self-healing: if the rotated footprint would spill within
 * MOUNTAIN_CLASH_MARGIN metres of a neighbouring zone's built structures
 * (see MOUNTAIN_CLASH_RECTS), the scale is shrunk in 15% steps (down to a
 * 0.1x floor, so it never fully vanishes) until it clears every zone with
 * margin to spare. This runs automatically on every generation — with the
 * fixed SEED, the same clash always resolves the same way, and any future
 * edit that shifts the RNG stream just re-resolves against whichever
 * mountain ends up in the way, with no hand-maintained index table to keep
 * in sync.
 */
function addMountain(px, pz, targetHeight, label, i) {
  const mountain = pick(MOUNTAIN_MODELS)
  let scale = targetHeight / mountain.nativeHeight
  const yaw = rf(0, 360)
  let shrunk = false
  let fp = mountainFootprint(mountain, px, pz, scale, yaw)
  while (footprintClashes(fp) && scale > (targetHeight / mountain.nativeHeight) * 0.1) {
    scale *= 0.85
    shrunk = true
    fp = mountainFootprint(mountain, px, pz, scale, yaw)
  }
  const id = add({
    name: 'Mountain',
    pos: [px, 0.05, pz], // all 3 models are pivoted at their own base — see MOUNTAIN_MODELS
    scale: [scale, scale, scale],
    rot: yawQuat(yaw),
    mesh: 'none', // geometry comes from the glTF below, not a primitive
    collider: 0
  })
  // No explicit collision masks — PBGltfContainer's own defaults already do
  // the right thing here (see the corner pyramid, which uses the same
  // model-ships-its-own-collider convention): the model's baked
  // "*_collider" node is invisible-but-solid by default, the visible
  // geometry isn't, and setting masks explicitly would just restate that.
  gltfContainers[id] = { json: { src: mountain.src } }
  if (DEBUG_MOUNTAINS) {
    mountainDebugLog.push({
      key: `${label}#${i}`,
      id,
      px: +px.toFixed(1),
      pz: +pz.toFixed(1),
      scale: +scale.toFixed(2),
      src: mountain.src.split('/').pop(),
      xMin: +fp.xMin.toFixed(1),
      xMax: +fp.xMax.toFixed(1),
      zMin: +fp.zMin.toFixed(1),
      zMax: +fp.zMax.toFixed(1),
      overridden: shrunk
    })
  }
  return id
}

/**
 * Loose boulder/rock dressing. Unlike the trees/pyramid/mountains, these two
 * models' pivot is NOT at their base — their own baked node transform floats
 * the mesh above the origin (measured via full glTF node-chain transforms,
 * min Y in each model's own post-transform space): rock_0 = 0.1166,
 * rock_1 = 0.8454. Ignoring that (the same mistake made once already for the
 * tree models, before it turned out those genuinely were base-anchored) would
 * float these noticeably above the ground, so `addRock` compensates by
 * lowering `pos.y` by `nativeMinY * scale`.
 */
const ROCK_MODELS = [
  { src: 'assets/models/rock_0.glb', nativeHeight: 0.4235, nativeMinY: 0.1166 },
  { src: 'assets/models/rock_1.glb', nativeHeight: 0.723, nativeMinY: 0.8454 }
]
for (const m of ROCK_MODELS) {
  if (!existsSync(resolve(ROOT, m.src))) {
    throw new Error(`Missing ${m.src} — boulder/rock dressing needs this model.`)
  }
}

/**
 * Place one of the ROCK_MODELS at `[px, pz]`, its base sitting at `groundY`,
 * scaled to `targetHeight` metres tall. `collidable` defaults to true (loose
 * boulders you should bump into); pass false for rocks scattered through
 * tight spaces (e.g. the jungle maze corridors) where blocking movement
 * would be a problem, matching what the box primitives they replaced did.
 */
function addRock(px, pz, groundY, targetHeight, collidable = true) {
  const rock = pick(ROCK_MODELS)
  const scale = targetHeight / rock.nativeHeight
  const id = add({
    name: 'Rock',
    pos: [px, groundY - rock.nativeMinY * scale, pz],
    scale: [scale, scale, scale],
    rot: yawQuat(rf(0, 360)),
    mesh: 'none', // geometry comes from the glTF below, not a primitive
    collider: 0
  })
  // No dedicated "*_collider" node in either model (single mesh, single
  // primitive) — unlike the pyramid/mountains, these DO need an explicit
  // collision mask, same as the jungle trees.
  gltfContainers[id] = { json: { src: rock.src, visibleMeshesCollisionMask: collidable ? 3 : 0 } }
  return id
}

/**
 * assets/models/pine.glb replaces the old "Ice Spike" primitive — a blue
 * cylinder-cone (radiusTop 0) in the ice zone. Despite the cone shape and
 * blue tint, that primitive was frozen-icicle dressing, not a tree; swapping
 * it for a pine changes the zone's read from "icy spires" to "snow-dusted
 * pines," which is what was asked for. Base-anchored like the trees/mountains
 * (measured minY = -0.0178, negligible), no dedicated collider node so it
 * needs an explicit mask like the jungle trees/rocks.
 */
const PINE_MODEL = { src: 'assets/models/pine.glb', nativeHeight: 2.4938, nativeMinY: -0.0178 }
if (!existsSync(resolve(ROOT, PINE_MODEL.src))) {
  throw new Error(`Missing ${PINE_MODEL.src} — the ice zone's pines need this model.`)
}

/**
 * Place a pine at `[px, pz]`, its base sitting at `groundY`, scaled to
 * `targetHeight` metres tall. `skip` still burns the rotation rf() draw
 * below (same as a normal call) but doesn't actually create the entity —
 * used to drop one specific pine from the random loop without reshuffling
 * every pine/rock/etc. placed after it off this one shared seeded RNG
 * stream.
 */
function addPine(px, pz, groundY, targetHeight, skip = false) {
  const scale = targetHeight / PINE_MODEL.nativeHeight
  const rot = yawQuat(rf(0, 360))
  if (skip) return null
  const id = add({
    name: 'Pine',
    pos: [px, groundY - PINE_MODEL.nativeMinY * scale, pz],
    scale: [scale, scale, scale],
    rot,
    mesh: 'none',
    collider: 0
  })
  gltfContainers[id] = { json: { src: PINE_MODEL.src, visibleMeshesCollisionMask: 3 } }
  return id
}

/**
 * assets/models/platform_0.glb replaces both jump-platform primitives in the
 * ice zone ("Ice Floe" and "Frozen Disc"). Its own pivot is at the TOP
 * SURFACE centre (confirmed both by the user and by measuring: the visible
 * mesh's maxY is ~0.003, essentially 0), unlike every other GLB swapped in
 * so far — so `pos.y` here is the walkable surface height directly, no base
 * offset math needed. It ships a dedicated "Island01_collider" node, so —
 * same as the pyramid/mountains — no explicit collision mask is set.
 */
const PLATFORM_MODEL = { src: 'assets/models/platform_0.glb', nativeWidth: 0.8871, nativeDepth: 0.9085 }
if (!existsSync(resolve(ROOT, PLATFORM_MODEL.src))) {
  throw new Error(`Missing ${PLATFORM_MODEL.src} — the ice zone's jump platforms need this model.`)
}

/** Place a platform at `[px, topY, pz]` (topY = its walkable top surface), footprint sized to targetWidth metres. Extra `add()` fields (e.g. tween) merge in via `extra`. */
function addPlatform(px, topY, pz, targetWidth, extra = {}) {
  const scale = targetWidth / PLATFORM_MODEL.nativeWidth
  const id = add({
    name: 'Ice Platform',
    pos: [px, topY, pz],
    scale: [scale, scale, scale],
    rot: yawQuat(rf(0, 360)),
    mesh: 'none',
    collider: 0,
    ...extra
  })
  gltfContainers[id] = { json: { src: PLATFORM_MODEL.src } }
  return id
}

/* ================================================================== *
 * NORTH — Ice & snowy mountain parkour
 * ================================================================== */
function buildNorth() {
  const { x0, z0 } = ZONES.NORTH
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Snow Field', cx, cz, BLOCK, BLOCK, 0.05, C.snow, 0.5)

  // Backdrop mountain wall along the far (north) edge
  for (let i = 0; i < 9; i++) {
    const px = x0 + 3 + i * ((BLOCK - 6) / 8)
    addMountain(px, rf(z0 + BLOCK - 9, z0 + BLOCK - 3), rf(24, 44), 'NorthBackdrop', i)
  }

  // Ascending ice-floe course climbing toward the peaks
  const FLOE_COUNT = 12
  let y = 1.4
  let px = cx
  let pz = z0 + 6
  for (let i = 0; i < FLOE_COUNT; i++) {
    px += rf(-7, 7)
    pz += rf(0.5, 3.2)
    px = Math.min(Math.max(px, x0 + 5), x0 + BLOCK - 5)
    pz = Math.min(Math.max(pz, z0 + 4), z0 + BLOCK - 14)
    y += rf(0.7, 1.5)
    addPlatform(px, y, pz, rf(2.6, 4.6))
    addAnchor('NORTH', px, y + 0.25, pz)
  }

  // Floating rotating ice discs (extra jumps)
  for (let i = 0; i < 8; i++) {
    const dx = rf(x0 + 8, x0 + BLOCK - 8)
    const dz = rf(z0 + 6, z0 + BLOCK - 18)
    const dy = 4 + i * 3.2
    addPlatform(dx, dy, dz, 5, {
      tween: {
        duration: 9000,
        easingFunction: 0,
        mode: {
          $case: 'rotate',
          rotate: { start: yawQuat(0), end: yawQuat(180) }
        },
        playing: true
      },
      tweenSequence: { sequence: [{ duration: 9000, easingFunction: 0, mode: { $case: 'rotate', rotate: { start: yawQuat(180), end: yawQuat(360) } } }], loop: 0 }
    })
    addAnchor('NORTH', dx, dy + 0.3, dz)
  }

  // Pines & boulders
  for (let i = 0; i < 7; i++) {
    // i===6 (this seed lands it around 88.5,135.3, the one reported near
    // 87,0.1,135) dropped per explicit request — see addPine's skip param.
    addPine(rf(x0 + 3, x0 + BLOCK - 3), rf(z0 + 3, z0 + BLOCK - 12), 0.05, rf(3, 9), i === 6)
  }
  for (let i = 0; i < 7; i++) {
    addRock(rf(x0 + 3, x0 + BLOCK - 3), rf(z0 + 3, z0 + BLOCK - 12), 0.05, rf(1.6, 3))
  }

  // Forced spawns supplied directly by the user (exact final world-space
  // positions) — must ALWAYS have a tile every round, so these use
  // addGuaranteedSpawn (reserved tile slot) rather than the regular
  // addAnchor pool the floe/disc loops above use.
  //
  // (107, 137, 146) was a decimal-point typo, corrected first to (107, 13.7,
  // 146) then bumped to (107, 15, 146) per explicit follow-up — both sit in
  // the floe course's height range; 137 never did.
  const NORTH_GUARANTEED_TILE_SPAWNS = [
    [115, 23, 166],
    [85, 11, 136],
    [107, 15, 146]
  ]
  for (const [px, py, pz] of NORTH_GUARANTEED_TILE_SPAWNS) {
    addGuaranteedSpawn('NORTH', px, py - 1.0, pz)
  }
}

/* ================================================================== *
 * CORNERS — mountains and decoration
 * ================================================================== */
function buildCorners() {
  for (const corner of CORNERS) {
    const { x0, z0, name } = corner
    const cx = x0 + BLOCK / 2
    const cz = z0 + BLOCK / 2
    slab(`${name} Ground`, cx, cz, BLOCK, BLOCK, 0.05, C.rockDark, 0.5)

    // Layered mountain massif — pure backdrop (no anchors/gameplay here).
    // mountain_1/mountain_2 already bake in their own snow-cap material (see
    // MOUNTAIN_MODELS), so there's no separate procedural "Snowcap" accent to
    // add on top anymore — the old primitive only added one for h > 34
    // specifically because a plain rock cone had no snow of its own.
    for (let i = 0; i < 7; i++) {
      const mx = cx + rf(-20, 20)
      const mz = cz + rf(-20, 20)
      addMountain(mx, mz, rf(20, 52), name, i)
    }
    // Scattered boulders
    for (let i = 0; i < 6; i++) {
      addRock(cx + rf(-28, 28), cz + rf(-28, 28), 0.05, rf(1.6, 4))
    }
  }
}

/* ================================================================== *
 * Optional GLB dressing, scattered along the tile anchors of each zone
 * ================================================================== */
function buildDecoration() {
  if (!WITH_MODELS) return

  // The 70-instance EAST ground scatter (fern/jungle-plant-06/parque, later
  // just jungle-plant-06) and the WEST/SOUTH/NORTH prop scatter were all
  // dropped per explicit request — too busy/ugly. The only jungle-plant-06
  // left is the hard-capped-at-3 wall sprinkle up in buildEast() (see
  // MAX_WALL_PLANTS). Nothing left to scatter here for now.
}

/* ================================================================== *
 * Emit
 * ================================================================== */
buildCenter()
buildEast()
buildWest()
buildSouth()
buildNorth()
buildCorners()
buildDecoration()

const components = []
// Non-core components (anything not prefixed `core::`) must carry their jsonSchema
// or the SDK build cannot resolve the component definition.
const JSON_SCHEMAS = {
  'core-schema::Name': {
    type: 'object',
    properties: { value: { type: 'string', serializationType: 'utf8-string' } },
    serializationType: 'map'
  }
}
const push = (name, data) => {
  if (!Object.keys(data).length) return
  const entry = { name, data }
  if (JSON_SCHEMAS[name]) entry.jsonSchema = JSON_SCHEMAS[name]
  components.push(entry)
}
push('core::Transform', transforms)
push('core::GltfContainer', gltfContainers)
push('core::LightSource', lightSources)
push('core::MeshRenderer', meshRenderers)
push('core::MeshCollider', meshColliders)
push('core::Material', materials)
push('core::TextShape', textShapes)
push('core::Billboard', billboards)
push('core::Tween', tweens)
push('core::TweenSequence', tweenSequences)
push('core-schema::Name', names)

const composite = { version: 1, components }
mkdirSync(resolve(ROOT, 'assets/scene'), { recursive: true })
writeFileSync(resolve(ROOT, 'assets/scene/main.composite'), JSON.stringify(composite))

if (DEBUG_MOUNTAINS) {
  // addMountain() already auto-shrinks any footprint that clashes with
  // MOUNTAIN_CLASH_RECTS, so this should report nothing left uncleared. It's
  // kept as a sanity check (e.g. in case a mountain hit the 0.15x shrink
  // floor and still clashes) rather than as the primary fix mechanism.
  const overlaps = (m, r) => m.xMin < r.x1 && m.xMax > r.x0 && m.zMin < r.z1 && m.zMax > r.z0
  console.log('\n=== Mountain footprints still spilling into a neighbouring named zone (should be empty) ===')
  let any = false
  for (const m of mountainDebugLog) {
    const hits = Object.entries(MOUNTAIN_CLASH_RECTS).filter(([, r]) => overlaps(m, r))
    if (hits.length) {
      any = true
      console.log(
        `${m.key.padEnd(16)} id=${m.id} pos=(${m.px},${m.pz}) scale=${m.scale} ${m.src}` +
          ` footprint x[${m.xMin},${m.xMax}] z[${m.zMin},${m.zMax}]` +
          (m.overridden ? ' [SHRUNK]' : '') +
          ` -> still spills into: ${hits.map(([n]) => n).join(', ')}`
      )
    }
  }
  if (!any) console.log('(none — every clash was auto-resolved)')
  console.log(`\nMountains auto-shrunk this run: ${mountainDebugLog.filter(m => m.overridden).length} of ${mountainDebugLog.length}`)
}

// Trim anchor lists to keep the generated module small but still varied.
function thin(list, max) {
  if (list.length <= max) return list
  const out = []
  const stride = list.length / max
  for (let i = 0; i < max; i++) out.push(list[Math.floor(i * stride)])
  return out
}
const anchorsOut = {
  NORTH: thin(anchors.NORTH, 90),
  SOUTH: thin(anchors.SOUTH, 110),
  EAST: thin(anchors.EAST, 110),
  WEST: thin(anchors.WEST, 90)
}

const layoutTs = `// AUTO-GENERATED by tools/gen-world.mjs — do not edit by hand.
// Regenerate with: npm run gen:world

export const PARCEL_SIZE = ${PARCEL}
export const PARCEL_GRID = ${GRID}
export const WORLD_SIZE = ${WORLD}
export const BLOCK_SIZE = ${BLOCK}

export const BOARD_N = ${BOARD_N}
export const BOARD_CELL_SIZE = ${CELL}
export const BOARD_X0 = ${BOARD_X0}
export const BOARD_Z0 = ${BOARD_Z0}
export const BOARD_Y = ${BOARD_Y}
export const BOARD_CELLS = ${BOARD_N * BOARD_N}

/** Skybox time of day, in seconds since midnight. 43200 = noon. */
export const SKYBOX_FIXED_TIME = ${SKYBOX_FIXED_TIME}

export const ZONE_NAMES = ['NORTH', 'SOUTH', 'EAST', 'WEST'] as const
export type ZoneName = (typeof ZONE_NAMES)[number]

export const ZONE_LABEL: Record<ZoneName, string> = {
  NORTH: 'Frozen Peaks',
  SOUTH: 'Sunken Tomb',
  EAST: 'Jungle Labyrinth',
  WEST: 'Fortress'
}

/** Candidate tile spawn positions (already offset ~1 m above the surface). */
export const TILE_ANCHORS: Record<ZoneName, [number, number, number][]> = {
  NORTH: ${JSON.stringify(anchorsOut.NORTH)},
  SOUTH: ${JSON.stringify(anchorsOut.SOUTH)},
  EAST: ${JSON.stringify(anchorsOut.EAST)},
  WEST: ${JSON.stringify(anchorsOut.WEST)}
}

/** Landmark spawn points that always hold the same letter (see gen-world.mjs's
 * addFixedLetterAnchor) — host.ts pins one dedicated tile entity per entry. */
export const FIXED_LETTER_ANCHORS: { zone: ZoneName; letter: string; pos: [number, number, number] }[] = ${JSON.stringify(fixedLetterAnchors)}

/** Spawn points that must always hold SOME tile (random letter) every round —
 * see gen-world.mjs's addGuaranteedSpawn. host.ts reserves one dedicated
 * tile entity per entry, same mechanism as FIXED_LETTER_ANCHORS above. */
export const GUARANTEED_SPAWNS: { zone: ZoneName; pos: [number, number, number] }[] = ${JSON.stringify(guaranteedSpawns)}

/** Premium multiplier map, one entry per board cell (0 normal, 1 DL, 2 TL, 3 DW, 4 TW, 5 star). */
export const CELL_PREMIUM: number[] = ${JSON.stringify(
  Array.from({ length: BOARD_N * BOARD_N }, (_, i) => premiumAt(Math.floor(i / BOARD_N), i % BOARD_N))
)}
`
mkdirSync(resolve(ROOT, 'src/generated'), { recursive: true })
writeFileSync(resolve(ROOT, 'src/generated/layout.ts'), layoutTs)

const bytes = JSON.stringify(composite).length
console.log(
  `main.composite: ${nextId - 512} entities, ${(bytes / 1024 / 1024).toFixed(2)} MB\n` +
    `anchors: N=${anchorsOut.NORTH.length} S=${anchorsOut.SOUTH.length} ` +
    `E=${anchorsOut.EAST.length} W=${anchorsOut.WEST.length}\n` +
    `lights: ${Object.keys(lightSources).length}   skybox: fixed at ${SKYBOX_FIXED_TIME}s (noon)\n` +
    `GLB props: ${WITH_MODELS ? Object.keys(gltfContainers).length : 'disabled (--no-models)'}`
)
if (missingModels.size) {
  console.log(
    `\nMissing GLBs (run tools/fetch-models.sh first): ${Array.from(missingModels).join(', ')}`
  )
}
