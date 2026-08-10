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
/** Pass --with-models after running tools/fetch-models.sh to layer GLB props on top. */
const WITH_MODELS = process.argv.includes('--with-models')

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
    // A textured surface (e.g. the board's baked grid) uses the mesh's own
    // default UVs directly — no offset/tiling crop needed, since the whole
    // face should show the whole image, not a sub-rectangle of an atlas.
    if (opts.textureSrc) {
      pbr.texture = { tex: { $case: 'texture', texture: { src: opts.textureSrc } } }
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

/** Place a downloaded GLB prop. No-ops unless --with-models and the file exists. */
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

/* ================================================================== *
 * CENTER — Aztec plaza + 21x21 Scrabble board
 * ================================================================== */

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

  // Aztec stepped pyramids at the four plaza corners
  const pyramidSpots = [
    [x0 + 8, z0 + 8], [x0 + BLOCK - 8, z0 + 8],
    [x0 + 8, z0 + BLOCK - 8], [x0 + BLOCK - 8, z0 + BLOCK - 8]
  ]
  for (const [px, pz] of pyramidSpots) {
    for (let step = 0; step < 4; step++) {
      const w = 13 - step * 2
      slab(`Aztec Pyramid Step ${step}`, px, pz, w, w, 0.05 + (step + 1) * 1.3, C.aztecStone, 1.3)
    }
    add({
      name: 'Aztec Idol',
      pos: [px, 8.6, pz],
      scale: [1.4, 2.2, 1.4],
      color: C.aztecJade,
      emissive: [0.05, 0.35, 0.25],
      emissiveIntensity: 1.2,
      metallic: 0.4,
      roughness: 0.3,
      collider: 3
    })
  }

  // Glyph pillar ring around the board
  const ringR = BOARD_SPAN / 2 + 7.5
  const PILLAR_COUNT = 7
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const a = (i / PILLAR_COUNT) * Math.PI * 2
    const px = cx + Math.cos(a) * ringR
    const pz = cz + Math.sin(a) * ringR
    const h = rf(4, 6.5)
    add({
      name: 'Aztec Pillar',
      pos: [px, h / 2 + 0.05, pz],
      scale: [1.1, h, 1.1],
      color: C.aztecStone,
      collider: 3
    })
    add({
      name: 'Aztec Pillar Glyph',
      pos: [px, h + 0.5, pz],
      scale: [1.35, 0.8, 1.35],
      rot: yawQuat(i * (360 / PILLAR_COUNT)),
      color: i % 3 === 0 ? C.aztecGold : C.aztecJade,
      metallic: 0.5,
      roughness: 0.35,
      collider: 3
    })
  }

  // Four ceremonial gateways aligned with the four gameplay zones
  const gates = [
    { name: 'Gate North (Ice)', x: cx, z: z0 + BLOCK - 1.5, yaw: 0, color: C.ice },
    { name: 'Gate South (Desert)', x: cx, z: z0 + 1.5, yaw: 0, color: C.sand },
    { name: 'Gate East (Jungle)', x: x0 + BLOCK - 1.5, z: cz, yaw: 90, color: C.jungleLeaf },
    { name: 'Gate West (Foundry)', x: x0 + 1.5, z: cz, yaw: 90, color: C.indYellow }
  ]
  for (const g of gates) {
    const rot = yawQuat(g.yaw)
    const off = g.yaw === 0 ? [-3.5, 3.5] : [0, 0]
    const offZ = g.yaw === 0 ? [0, 0] : [-3.5, 3.5]
    for (let s = 0; s < 2; s++) {
      add({
        name: `${g.name} Post`,
        pos: [g.x + off[s], 3.05, g.z + offZ[s]],
        scale: [1.2, 6, 1.2],
        rot,
        color: C.aztecStone,
        collider: 3
      })
    }
    add({
      name: `${g.name} Lintel`,
      pos: [g.x, 6.4, g.z],
      scale: g.yaw === 0 ? [9, 1.2, 1.6] : [1.6, 1.2, 9],
      color: g.color,
      emissive: g.color,
      emissiveIntensity: 0.8,
      metallic: 0.3,
      roughness: 0.4,
      collider: 3
    })
    add({
      name: `${g.name} Sign`,
      pos: [g.x, 8.2, g.z],
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
  const wallH = 3.6

  for (const run of mergeWallRuns(wall, W, H)) {
    const lenC = run.c1 - run.c0 + 1
    const lenR = run.r1 - run.r0 + 1
    const px = ox + (run.c0 + lenC / 2) * step
    const pz = oz + (run.r0 + lenR / 2) * step
    add({
      name: 'Jungle Hedge',
      pos: [px, wallH / 2 + 0.05, pz],
      scale: [lenC * step, wallH, lenR * step],
      color: rnd() < 0.5 ? C.jungleHedge : C.jungleHedge2,
      roughness: 0.95,
      lift: CORRIDOR_LIFT,
      collider: 3
    })
  }

  // Passage cells become tile anchors + occasional foliage
  for (let r = 1; r < H; r += 2) {
    for (let c = 1; c < W; c += 2) {
      if (wall[r][c]) continue
      const px = ox + (c + 0.5) * step
      const pz = oz + (r + 0.5) * step
      addAnchor('EAST', px, 0.05, pz)
      if (rnd() < 0.12) {
        const h = rf(1.4, 2.6)
        add({
          name: 'Jungle Fern',
          pos: [px + rf(-0.3, 0.3), h / 2 + 0.05, pz + rf(-0.3, 0.3)],
          scale: [0.9, h, 0.9],
          mesh: 'cylinder',
          radiusTop: 0.05,
          radiusBottom: 0.35,
          color: C.jungleLeaf,
          collider: 0
        })
      }
    }
  }

  // Canopy trees around the maze perimeter
  for (let i = 0; i < 8; i++) {
    const edge = ri(0, 3)
    let px, pz
    if (edge === 0) (px = rf(x0 + 3, x0 + BLOCK - 3)), (pz = rf(z0 + 2.5, z0 + 4))
    else if (edge === 1) (px = rf(x0 + 3, x0 + BLOCK - 3)), (pz = rf(z0 + BLOCK - 4, z0 + BLOCK - 2.5))
    else if (edge === 2) (px = rf(x0 + 2.5, x0 + 4)), (pz = rf(z0 + 3, z0 + BLOCK - 3))
    else (px = rf(x0 + BLOCK - 4, x0 + BLOCK - 2.5)), (pz = rf(z0 + 3, z0 + BLOCK - 3))
    const h = rf(7, 13)
    add({
      name: 'Jungle Tree Trunk',
      pos: [px, h / 2 + 0.05, pz],
      scale: [1, h, 1],
      mesh: 'cylinder',
      radiusTop: 0.28,
      radiusBottom: 0.45,
      color: C.jungleTrunk,
      collider: 3
    })
    for (let k = 0; k < 1; k++) {
      add({
        name: 'Jungle Canopy',
        pos: [clampWorld(px + rf(-1.2, 1.2), 3), h + rf(-1, 1.4), clampWorld(pz + rf(-1.2, 1.2), 3)],
        scale: [rf(3, 5), rf(2, 3), rf(3, 5)],
        mesh: 'sphere',
        color: C.jungleLeaf,
        roughness: 0.95,
        collider: 0
      })
    }
  }

  // Ruin blocks for flavour
  for (let i = 0; i < 7; i++) {
    add({
      name: 'Jungle Ruin Block',
      pos: [rf(x0 + 3, x0 + BLOCK - 3), rf(0.4, 1.2), rf(z0 + 3, z0 + BLOCK - 3)],
      scale: [rf(1.5, 3), rf(0.8, 2.2), rf(1.5, 3)],
      rot: yawQuat(rf(0, 360)),
      color: C.jungleStone,
      collider: 0
    })
  }
}

/* ================================================================== *
 * WEST — Industrial parkour
 * ================================================================== */
function buildWest() {
  const { x0, z0 } = ZONES.WEST
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Foundry Floor', cx, cz, BLOCK, BLOCK, 0.05, C.indGround, 0.5)

  // Perimeter factory walls
  const wallH = 16
  const sides = [
    [cx, z0 + 0.6, BLOCK, 1.2],
    [cx, z0 + BLOCK - 0.6, BLOCK, 1.2],
    [x0 + 0.6, cz, 1.2, BLOCK]
  ]
  for (const [px, pz, sx, sz] of sides) {
    add({
      name: 'Foundry Wall',
      pos: [px, wallH / 2 + 0.05, pz],
      scale: [sx, wallH, sz],
      color: C.indSteelDark,
      metallic: 0.5,
      roughness: 0.6,
      collider: 3
    })
  }

  // Ascending platform course, four spiralling tiers
  const PLATFORM_COUNT = 14
  let y = 1.6
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
    add({
      name: 'Catwalk Platform',
      pos: [px, y, pz],
      scale: [sx, 0.4, sz],
      rot: yawQuat(rf(0, 90)),
      color: i % 5 === 0 ? C.indYellow : C.indSteel,
      metallic: 0.7,
      roughness: 0.4,
      collider: 3
    })
    addAnchor('WEST', px, y + 0.2, pz)
    if (i % 7 === 3) {
      // hazard-striped guard rail
      add({
        name: 'Guard Rail',
        pos: [px, y + 0.9, pz + sz / 2],
        scale: [sx, 1.2, 0.12],
        color: C.indYellow,
        emissive: [0.5, 0.4, 0.05],
        emissiveIntensity: 0.6,
        metallic: 0.6,
        collider: 0
      })
    }
  }

  // Moving platforms (Tween ping-pong) between tiers
  for (let i = 0; i < 6; i++) {
    const px = rf(x0 + 10, x0 + BLOCK - 10)
    const pz = rf(z0 + 10, z0 + BLOCK - 10)
    const py = 3 + i * 2.6
    const dx = rf(6, 11)
    add({
      name: 'Moving Platform',
      pos: [px, py, pz],
      scale: [3.4, 0.4, 3.4],
      color: C.indRust,
      metallic: 0.6,
      roughness: 0.5,
      collider: 3,
      tween: {
        duration: 4200,
        easingFunction: 6, // EF_EASESINE
        mode: {
          $case: 'move',
          move: {
            start: { x: r3(px), y: r3(py), z: r3(pz) },
            end: { x: r3(Math.min(px + dx, x0 + BLOCK - 4)), y: r3(py), z: r3(pz) }
          }
        },
        playing: true
      },
      tweenSequence: { sequence: [], loop: 1 } // TL_YOYO
    })
  }

  // Silos, pipes and stacks
  for (let i = 0; i < 6; i++) {
    const px = rf(x0 + 5, x0 + BLOCK - 5)
    const pz = rf(z0 + 5, z0 + BLOCK - 5)
    const h = rf(9, 20)
    add({
      name: 'Silo',
      pos: [px, h / 2 + 0.05, pz],
      scale: [rf(3.5, 6), h, rf(3.5, 6)],
      mesh: 'cylinder',
      radiusTop: 0.5,
      radiusBottom: 0.5,
      color: i % 3 === 0 ? C.indRust : C.indSteel,
      metallic: 0.75,
      roughness: 0.45,
      collider: 3
    })
    addAnchor('WEST', px, h + 0.1, pz)
  }
  for (let i = 0; i < 7; i++) {
    const px = rf(x0 + 4, x0 + BLOCK - 4)
    const pz = rf(z0 + 4, z0 + BLOCK - 4)
    const len = rf(8, 22)
    const horizontal = rnd() < 0.5
    add({
      name: 'Pipe Run',
      pos: [px, rf(2, 14), pz],
      scale: horizontal ? [len, 1, 1] : [1, 1, len],
      rot: eulerQuat(0, 0, 90),
      mesh: 'cylinder',
      radiusTop: 0.4,
      radiusBottom: 0.4,
      color: C.indPipe,
      metallic: 0.8,
      roughness: 0.35,
      collider: 0
    })
  }
  // Crate stacks (climbable)
  for (let i = 0; i < 5; i++) {
    const px = rf(x0 + 4, x0 + BLOCK - 4)
    const pz = rf(z0 + 4, z0 + BLOCK - 4)
    const stack = ri(1, 3)
    for (let s = 0; s < stack; s++) {
      add({
        name: 'Steel Crate',
        pos: [px + rf(-0.3, 0.3), 0.85 + s * 1.7, pz + rf(-0.3, 0.3)],
        scale: [1.7, 1.7, 1.7],
        rot: yawQuat(rf(0, 90)),
        color: s % 2 ? C.indRust : C.indSteelDark,
        metallic: 0.6,
        roughness: 0.5,
        collider: 3
      })
    }
    addAnchor('WEST', px, 0.85 + stack * 1.7, pz)
  }
}

/* ================================================================== *
 * SOUTH — Egyptian multi-storey maze tower
 * ================================================================== */
function buildSouth() {
  const { x0, z0 } = ZONES.SOUTH
  const cx = x0 + BLOCK / 2
  const cz = z0 + BLOCK / 2
  slab('Desert Sand', cx, cz, BLOCK, BLOCK, 0.05, C.sand, 0.5)

  const FLOORS = 4
  const FLOOR_H = 5.2
  const INSET = 3 // tower footprint inset from the block edge
  const span = BLOCK - INSET * 2 // 58
  // Same reasoning as the jungle maze: this grid gets rebuilt on all 4
  // floors, so its wall-segment count is the single biggest chunk of the
  // scene's material budget. 9x9 still reads as a proper tomb maze per floor.
  const cols = 3
  const rows = 3

  for (let f = 0; f < FLOORS; f++) {
    const baseY = 0.05 + f * FLOOR_H
    // storey slab (skip ground floor — the sand already covers it)
    if (f > 0) {
      add({
        name: `Tower Floor ${f}`,
        pos: [cx, baseY - 0.25, cz],
        scale: [span, 0.5, span],
        color: C.sandstoneDark,
        lift: INTERIOR_LIFT,
        collider: 3
      })
    }

    const { wall, W, H } = generateMaze(cols, rows)
    braidMaze(wall, W, H, 0.2)
    const step = span / W
    const ox = x0 + INSET
    const oz = z0 + INSET
    const wallH = FLOOR_H - 0.6

    // Entrance on the north face (facing the plaza) for the ground floor
    if (f === 0) wall[H - 1][Math.floor(W / 2)] = false

    // Stair shaft: clear a 3x3 patch of wall cells and build a ramp up
    const sc = ri(2, W - 5)
    const sr = ri(2, H - 5)
    for (let r = sr; r < sr + 3; r++) for (let c = sc; c < sc + 3; c++) wall[r][c] = false

    for (const run of mergeWallRuns(wall, W, H)) {
      const lenC = run.c1 - run.c0 + 1
      const lenR = run.r1 - run.r0 + 1
      add({
        name: `Tomb Wall F${f}`,
        pos: [
          ox + (run.c0 + lenC / 2) * step,
          baseY + wallH / 2,
          oz + (run.r0 + lenR / 2) * step
        ],
        scale: [lenC * step, wallH, lenR * step],
        color: rnd() < 0.15 ? C.sandstoneDark : C.sandstone,
        roughness: 0.9,
        lift: INTERIOR_LIFT,
        collider: 3
      })
    }

    // Ramp to the next storey
    if (f < FLOORS - 1) {
      const rx = ox + (sc + 1.5) * step
      const rz = oz + (sr + 1.5) * step
      const rampLen = 7.5
      const pitch = -Math.atan2(FLOOR_H, rampLen) * (180 / Math.PI)
      add({
        name: `Tomb Ramp F${f}`,
        pos: [rx, baseY + FLOOR_H / 2, rz],
        scale: [3.2, 0.35, rampLen + 1],
        rot: eulerQuat(pitch, 0, 0),
        color: C.sandstoneDark,
        collider: 3
      })
      add({
        name: `Ramp Torch F${f}`,
        pos: [rx + 2.2, baseY + 1.8, rz],
        scale: [0.35, 1.2, 0.35],
        color: C.egyptGold,
        emissive: [1, 0.55, 0.1],
        emissiveIntensity: 3,
        collider: 0,
        light: { color: [1, 0.72, 0.4], intensity: 2600, range: 16 }
      })
    }

    // Tile anchors on every open passage cell of this storey, plus a scattering
    // of braziers so the corridors are actually navigable.
    const storeyCells = []
    for (let r = 1; r < H; r += 2) {
      for (let c = 1; c < W; c += 2) {
        if (wall[r][c]) continue
        const ax = ox + (c + 0.5) * step
        const az = oz + (r + 0.5) * step
        addAnchor('SOUTH', ax, baseY, az)
        storeyCells.push([ax, az])
      }
    }
    // The renderer only draws the handful of lights nearest the player, so
    // spreading several per storey costs little and removes the dead spots.
    const braziers = 3
    for (let b = 0; b < braziers; b++) {
      const cell = storeyCells[Math.floor((b + 0.5) * (storeyCells.length / braziers))]
      if (!cell) continue
      add({
        name: `Tomb Brazier F${f}`,
        pos: [cell[0], baseY + 0.55, cell[1]],
        scale: [0.7, 1.1, 0.7],
        mesh: 'cylinder',
        radiusTop: 0.45,
        radiusBottom: 0.2,
        color: C.egyptGold,
        emissive: [1, 0.6, 0.15],
        emissiveIntensity: 2.6,
        metallic: 0.7,
        roughness: 0.3,
        collider: 3,
        light: { color: [1, 0.78, 0.5], intensity: 3200, range: 18 }
      })
    }
  }

  // Outer shell walls with an open north face
  const topY = 0.05 + FLOORS * FLOOR_H
  const shell = [
    [cx, z0 + INSET, span, 0.8],
    [x0 + INSET, cz, 0.8, span],
    [x0 + BLOCK - INSET, cz, 0.8, span]
  ]
  for (const [px, pz, sx, sz] of shell) {
    add({
      name: 'Tomb Outer Wall',
      pos: [px, topY / 2, pz],
      scale: [sx, topY, sz],
      color: C.sandstone,
      roughness: 0.9,
      collider: 3
    })
  }

  // Stepped pyramid roof
  for (let step2 = 0; step2 < 7; step2++) {
    const w = span - step2 * 7
    if (w <= 4) break
    slab(`Pyramid Cap ${step2}`, cx, cz, w, w, topY + (step2 + 1) * 2.4, C.sandstone, 2.4)
  }
  add({
    name: 'Pyramid Capstone',
    pos: [cx, topY + 18.5, cz],
    scale: [3, 3, 3],
    color: C.egyptGold,
    emissive: [0.9, 0.7, 0.2],
    emissiveIntensity: 2,
    metallic: 0.9,
    roughness: 0.2,
    collider: 3
  })
  addAnchor('SOUTH', cx, topY + 20, cz)

  // Obelisks and palms outside the tower
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const px = cx + Math.cos(a) * 29
    const pz = cz + Math.sin(a) * 29
    if (px < x0 + 1 || px > x0 + BLOCK - 1 || pz < z0 + 1 || pz > z0 + BLOCK - 1) continue
    const h = rf(8, 12)
    add({
      name: 'Obelisk',
      pos: [px, h / 2 + 0.05, pz],
      scale: [1.4, h, 1.4],
      color: C.sandstoneDark,
      collider: 3
    })
    add({
      name: 'Obelisk Tip',
      pos: [px, h + 0.85, pz],
      scale: [1.5, 1.6, 1.5],
      mesh: 'cylinder',
      radiusTop: 0,
      radiusBottom: 0.5,
      color: C.egyptGold,
      metallic: 0.85,
      roughness: 0.25,
      collider: 0
    })
  }
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
    const h = rf(24, 44)
    add({
      name: 'Snow Peak',
      pos: [px, h / 2 + 0.05, rf(z0 + BLOCK - 9, z0 + BLOCK - 3)],
      scale: [rf(10, 18), h, rf(10, 18)],
      mesh: 'cylinder',
      radiusTop: 0,
      radiusBottom: 0.5,
      color: i % 2 ? C.rock : C.snow,
      roughness: 0.95,
      collider: 3
    })
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
    const s = rf(2.6, 4.6)
    add({
      name: 'Ice Floe',
      pos: [px, y, pz],
      scale: [s, 0.45, s],
      rot: yawQuat(rf(0, 90)),
      color: i % 4 === 0 ? C.iceDeep : C.ice,
      metallic: 0.15,
      roughness: 0.12,
      alpha: 0.92,
      collider: 3
    })
    addAnchor('NORTH', px, y + 0.25, pz)
  }

  // Floating rotating ice discs (extra jumps)
  for (let i = 0; i < 8; i++) {
    const dx = rf(x0 + 8, x0 + BLOCK - 8)
    const dz = rf(z0 + 6, z0 + BLOCK - 18)
    const dy = 4 + i * 3.2
    add({
      name: 'Frozen Disc',
      pos: [dx, dy, dz],
      scale: [5, 0.4, 5],
      mesh: 'cylinder',
      radiusTop: 0.5,
      radiusBottom: 0.5,
      color: C.ice,
      metallic: 0.2,
      roughness: 0.1,
      collider: 3,
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

  // Ice spikes & boulders
  for (let i = 0; i < 7; i++) {
    const sx = rf(x0 + 3, x0 + BLOCK - 3)
    const sz = rf(z0 + 3, z0 + BLOCK - 12)
    const h = rf(3, 9)
    add({
      name: 'Ice Spike',
      pos: [sx, h / 2 + 0.05, sz],
      scale: [rf(1.2, 2.6), h, rf(1.2, 2.6)],
      mesh: 'cylinder',
      radiusTop: 0,
      radiusBottom: 0.5,
      color: C.iceDeep,
      metallic: 0.2,
      roughness: 0.12,
      alpha: 0.9,
      collider: 3
    })
  }
  for (let i = 0; i < 7; i++) {
    add({
      name: 'Snow Boulder',
      pos: [rf(x0 + 3, x0 + BLOCK - 3), rf(0.6, 1.6), rf(z0 + 3, z0 + BLOCK - 12)],
      scale: [rf(2, 4), rf(1.6, 3), rf(2, 4)],
      mesh: 'sphere',
      color: rnd() < 0.5 ? C.snow : C.rockDark,
      roughness: 0.95,
      collider: 3
    })
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

    // Layered mountain massif — pure backdrop (no anchors/gameplay here), so
    // this is one of the cheapest places to cut material count.
    for (let i = 0; i < 7; i++) {
      const mx = cx + rf(-20, 20)
      const mz = cz + rf(-20, 20)
      const h = rf(20, 52)
      const rad = rf(11, 24)
      add({
        name: `${name} Mountain`,
        pos: [mx, h / 2 + 0.05, mz],
        scale: [rad, h, rad],
        mesh: 'cylinder',
        radiusTop: rnd() < 0.4 ? 0.12 : 0,
        radiusBottom: 0.5,
        color: i % 3 === 0 ? C.rock : C.rockDark,
        roughness: 0.95,
        collider: 3
      })
      if (h > 34) {
        add({
          name: `${name} Snowcap`,
          pos: [mx, h - 2.5, mz],
          scale: [rad * 0.4, 7, rad * 0.4],
          mesh: 'cylinder',
          radiusTop: 0,
          radiusBottom: 0.5,
          color: C.snow,
          roughness: 0.9,
          collider: 0
        })
      }
    }
    // Scattered boulders
    for (let i = 0; i < 6; i++) {
      add({
        name: `${name} Boulder`,
        pos: [cx + rf(-28, 28), rf(0.8, 2), cz + rf(-28, 28)],
        scale: [rf(2, 5), rf(1.6, 4), rf(2, 5)],
        mesh: 'sphere',
        rot: yawQuat(rf(0, 360)),
        color: C.rock,
        roughness: 0.95,
        collider: 3
      })
    }
  }
}

/* ================================================================== *
 * Optional GLB dressing, scattered along the tile anchors of each zone
 * ================================================================== */
function buildDecoration() {
  if (!WITH_MODELS) return

  const scatter = (zone, count, fn) => {
    const list = anchors[zone]
    if (!list.length) return
    for (let i = 0; i < count; i++) {
      const a = list[Math.floor(rnd() * list.length)]
      fn(a[0], a[1] - 1.0, a[2], i)
    }
  }

  scatter('EAST', 70, (x, y, z, i) => {
    const slug = i % 3 === 0 ? 'fern' : i % 3 === 1 ? 'jungle-plant-06' : 'parque'
    const scale = slug === 'parque' ? 0.5 : rf(0.8, 1.4)
    addModel('Jungle Prop', slug, [x + rf(-0.5, 0.5), y, z + rf(-0.5, 0.5)], {
      scale: [scale, scale, scale],
      rot: yawQuat(rf(0, 360))
    })
  })

  scatter('WEST', 45, (x, y, z, i) => {
    const slug = i % 2 === 0 ? 'wm-barrel-glb' : 'crate'
    addModel('Foundry Prop', slug, [x + rf(-0.6, 0.6), y, z + rf(-0.6, 0.6)], {
      scale: [1, 1, 1],
      rot: yawQuat(rf(0, 360)),
      solid: true
    })
  })

  scatter('SOUTH', 40, (x, y, z, i) => {
    const slug = i % 2 === 0 ? 'statue' : 'pebble-03'
    const scale = slug === 'pebble-03' ? 0.05 : rf(0.7, 1.1)
    addModel('Tomb Prop', slug, [x + rf(-0.5, 0.5), y, z + rf(-0.5, 0.5)], {
      scale: [scale, scale, scale],
      rot: yawQuat(rf(0, 360))
    })
  })

  scatter('NORTH', 45, (x, y, z, i) => {
    const slug = i % 3 === 0 ? 'pine' : i % 3 === 1 ? 'cp6' : 'cp8'
    const scale = slug === 'pine' ? rf(0.5, 0.9) : rf(0.8, 1.6)
    addModel('Frozen Prop', slug, [x + rf(-0.6, 0.6), y, z + rf(-0.6, 0.6)], {
      scale: [scale, scale, scale],
      rot: yawQuat(rf(0, 360))
    })
  })
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
  WEST: 'The Foundry'
}

/** Candidate tile spawn positions (already offset ~1 m above the surface). */
export const TILE_ANCHORS: Record<ZoneName, [number, number, number][]> = {
  NORTH: ${JSON.stringify(anchorsOut.NORTH)},
  SOUTH: ${JSON.stringify(anchorsOut.SOUTH)},
  EAST: ${JSON.stringify(anchorsOut.EAST)},
  WEST: ${JSON.stringify(anchorsOut.WEST)}
}

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
    `GLB props: ${WITH_MODELS ? Object.keys(gltfContainers).length : 'disabled (pass --with-models)'}`
)
if (missingModels.size) {
  console.log(
    `\nMissing GLBs (run tools/fetch-models.sh first): ${Array.from(missingModels).join(', ')}`
  )
}
