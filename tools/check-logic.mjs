/**
 * Headless sanity checks for the pure-logic modules (dictionary, board rules,
 * scoring, sprite-sheet UVs). These do not need the Decentraland runtime, so
 * they run under plain Node: `npm run check`.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPngGray } from './png.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

/* ---------------------------------------------------------------- *
 * Strip TypeScript types just enough to eval the pure modules.
 * ---------------------------------------------------------------- */
function loadTs(relPath, extraGlobals = {}) {
  const src = readFileSync(resolve(ROOT, relPath), 'utf8')
  const js = src
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/export const enum /g, 'export const ')
    .replace(/\bexport\s+/g, '')
    .replace(/:\s*readonly\s+number\[\]/g, '')
    .replace(/\bas\s+const\b/g, '')
  return { src, js }
}

/* ---------------------------------------------------------------- *
 * 1. Sprite-sheet UVs
 * ---------------------------------------------------------------- */
console.log('\nsprite sheet UVs')
{
  const COLS = 8
  const ROWS = 8
  const pad = 0.0015
  const cell = (i) => ({ col: i % COLS, row: Math.floor(i / COLS) })

  // Mirrors src/letters.ts `letterTextureCrop` exactly — mesh/material texture
  // V is the GL convention (v=0 = bottom, v increases upward), so row 0 (A..H,
  // meant to be the sheet's bottom) has to be remapped onto the sheet's LAST
  // stored PNG row.
  const meshRect = (i) => {
    const { col, row } = cell(i)
    const imgRow = ROWS - 1 - row
    return {
      u0: col / COLS + pad,
      u1: (col + 1) / COLS - pad,
      v0: imgRow / ROWS + pad,
      v1: (imgRow + 1) / ROWS - pad
    }
  }
  // Mirrors src/letters.ts `letterUiUvs` exactly — uiBackground texture V is
  // downward (v=0 = the sheet's first STORED/top row), so row 0 maps straight
  // through with NO flip. Confirmed by real-device testing that mesh and UI
  // need opposite V mappings — sharing one broke whichever wasn't fixed for.
  const uiRect = (i) => {
    const { col, row } = cell(i)
    return {
      u0: col / COLS + pad,
      u1: (col + 1) / COLS - pad,
      v0: row / ROWS + pad,
      v1: (row + 1) / ROWS - pad
    }
  }
  const textureCrop = (i) => {
    const { u0, u1, v0, v1 } = meshRect(i)
    return { offset: { x: u0, y: v0 }, tiling: { x: u1 - u0, y: v1 - v0 } }
  }
  // uiBackground.uvs is documented "starting from bottom-left vertex
  // clock-wise": BL, TL, TR, BR.
  const uiQuad = (i) => {
    const { u0, u1, v0, v1 } = uiRect(i)
    return [u0, v0, u0, v1, u1, v1, u1, v0]
  }

  const a = meshRect(0)
  check("A's mesh crop sits in the sheet's last stored row (its visual bottom)", a.u0 < 0.13 && a.v0 > 0.87)
  const h = meshRect(7)
  check('H shares that row, rightmost column', h.u0 > 0.87 && h.v0 > 0.87)
  const z = meshRect(25)
  check('Z lands 4 rows up, column 2', Math.abs(z.u0 - 1 / 8) < 0.01 && Math.abs(z.v0 - 4 / 8) < 0.01)

  const au = uiRect(0)
  check("A's UI crop sits in the sheet's first stored row, no flip", au.u0 < 0.13 && au.v0 < 0.13)
  check('UI quad is 8 floats', uiQuad(4).length === 8)

  // Every mesh crop must stay strictly inside the sheet (offset >= 0,
  // offset+tiling <= 1) and cover a non-trivial area.
  let allInBounds = true
  let allNonEmpty = true
  for (let i = 0; i < 26; i++) {
    const c = textureCrop(i)
    if (c.offset.x < 0 || c.offset.y < 0 || c.offset.x + c.tiling.x > 1 || c.offset.y + c.tiling.y > 1) {
      allInBounds = false
    }
    if (c.tiling.x <= 0 || c.tiling.y <= 0) allNonEmpty = false
  }
  check('every letter mesh crop stays within the 0..1 sheet', allInBounds)
  check('every letter mesh crop covers a non-zero area', allNonEmpty)

  // A and H must land in visibly different, non-overlapping crops.
  const ca = textureCrop(0)
  const ch = textureCrop(7)
  check(
    "A and H don't crop the same region",
    Math.abs(ca.offset.x - ch.offset.x) > 0.5 / COLS
  )

  /* ---------------------------------------------------------------- *
   * 1b. meshRect(i) actually points at the right glyph in the real file —
   * ground truth via direct pixel inspection. This is the check that
   * would have caught the mesh bottom-vs-top mixup.
   *
   * NOTE: there is deliberately no equivalent pixel ground-truth check for
   * uiRect() here. Its correct V mapping was established empirically on a
   * real device, not by reasoning about how uiBackground.uvs samples PNG
   * rows — a pixel model built the same way as meshRect's (below) does NOT
   * reproduce that result, which means whatever the UI sampler actually
   * does isn't the simple "v indexes the PNG row" model this file can
   * check. Trust the device report; guard it structurally instead (next
   * check) rather than re-deriving a pixel model that has already been
   * shown to disagree with reality.
   * ---------------------------------------------------------------- */
  const { width, height, gray } = readPngGray(resolve(ROOT, 'assets/textures/alphabets.png'))
  // Deliberately not pinned to a specific resolution — the sheet has been
  // re-exported at a higher one before and everything downstream works in
  // normalised UVs. What must hold is that it's square and divides evenly
  // into the letter grid, or the crops land between cells.
  check(
    `sheet is square and divides into ${COLS}x${ROWS} cells`,
    width === height && width % COLS === 0 && height % ROWS === 0,
    `${width}x${height}`
  )
  const C = width / COLS
  // Ground truth established once by direct pixel inspection: the sheet's
  // LAST stored PNG row (top-down, index ROWS-1) holds "A..H" with subscripts;
  // its FIRST stored row (index 0) is reserved/blank.
  const pngRowOf = (rect) => Math.round((rect.v0 - pad) * ROWS)

  const inkAt = (rect, xFrom, xTo, yFrom, yTo) => {
    const col = Math.round((rect.u0 - pad) * COLS)
    const top = pngRowOf(rect) * C
    let ink = 0
    for (let y = top + yFrom * C; y < top + yTo * C; y++) {
      for (let x = col * C + xFrom * C; x < col * C + xTo * C; x++) {
        if (gray[y * width + x] < 128) ink++
      }
    }
    return ink
  }

  const letterInk = []
  for (let i = 0; i < 26; i++) letterInk.push(inkAt(meshRect(i), 0, 1, 0, 1))
  check(
    'mesh crop lands on ink for all 26 letters (A..Z)',
    letterInk.every((v) => v > 40),
    letterInk.join(',')
  )

  // The sheet bakes each letter's Scrabble value in as a subscript, which is
  // why the HUD does not draw one. If a future sheet drops it, or the mesh
  // crop drifts onto the wrong row, this fails loudly.
  const subscriptInk = []
  for (let i = 0; i < 26; i++) subscriptInk.push(inkAt(meshRect(i), 0.5, 1, 0.5, 1))
  check(
    'mesh crop lands on a baked-in score subscript for all 26 letters',
    subscriptInk.every((v) => v > 3),
    subscriptInk.join(',')
  )

  let blankRowInk = 0
  for (let x = 0; x < width; x++) if (gray[x] < 128) blankRowInk++ // sheet's first stored row is reserved/blank
  check("the sheet's first stored row is blank", blankRowInk === 0, String(blankRowInk))

  // Structural regression guard: mesh and UI must use genuinely different V
  // mappings for any row-dependent letter — this is exactly the bug just
  // fixed (sharing one flip between both broke whichever wasn't fixed for).
  check(
    'mesh and UI crops use different V mappings for a row-dependent letter',
    meshRect(0).v0 !== uiRect(0).v0
  )
}

/* ---------------------------------------------------------------- *
 * 2. Dictionary decode + lookup
 * ---------------------------------------------------------------- */
console.log('\ndictionary')
{
  const dataSrc = readFileSync(resolve(ROOT, 'src/data/dictionary-data.ts'), 'utf8')
  const packed = eval(
    dataSrc
      .replace(/export const DICT_PACKED: string =/, 'const packed =')
      .replace(/export const [A-Z_]+ = [^\n]*/g, '') + '\npacked'
  )
  const MAX_LEN = +dataSrc.match(/DICT_MAX_LEN = (\d+)/)[1]
  const EXPECTED = +dataSrc.match(/DICT_WORD_COUNT = (\d+)/)[1]
  const byLength = []
  for (let i = 0; i <= MAX_LEN; i++) byLength.push([])
  let prev = ''
  let i = 0
  while (i < packed.length) {
    const shared = packed.charCodeAt(i) - 65
    i++
    let j = i
    while (j < packed.length && packed.charCodeAt(j) >= 97 && packed.charCodeAt(j) <= 122) j++
    const word = prev.slice(0, shared) + packed.slice(i, j)
    i = j
    prev = word
    byLength[word.length].push(word)
  }
  const buckets = byLength.map((l) => l.join(''))
  const total = byLength.reduce((n, l) => n + l.length, 0)
  check(
    `decoded all ${EXPECTED.toLocaleString('en-US')} words`,
    total === EXPECTED,
    `got ${total}`
  )
  check(
    'no word decoded with a stray marker character',
    byLength.every((list) => list.every((w) => /^[a-z]+$/.test(w)))
  )
  check(
    'every decoded word respects DICT_MAX_LEN',
    byLength.every((list, len) => list.every((w) => w.length === len))
  )

  const isWord = (w) => {
    const len = w.length
    if (len < 2 || len > MAX_LEN) return false
    const b = buckets[len]
    let lo = 0
    let hi = b.length / len - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const cand = b.substr(mid * len, len)
      if (cand === w) return true
      if (cand < w) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }
  // Short high-value openers matter most in play; the long ones prove the
  // decoder handles shared prefixes above 9 (where the old base36 marker broke).
  for (const w of [
    'cat', 'quiz', 'jungle', 'zebra', 'ox', 'ai', 'scrabble',
    'qi', 'za', 'xu', 'jo', 'esquire', 'wizardry', 'oxyphenbutazone'
  ]) {
    check(`"${w}" is a word`, isWord(w))
  }
  for (const w of ['zzzz', 'qqx', 'blorptx', 'xyzzyq']) check(`"${w}" is rejected`, !isWord(w))
  check('each bucket is sorted', byLength.every((l) => l.every((w, k) => k === 0 || l[k - 1] <= w)))
}

/* ---------------------------------------------------------------- *
 * 3. Board rules + scoring
 * ---------------------------------------------------------------- */
console.log('\nboard rules')
{
  const layoutSrc = readFileSync(resolve(ROOT, 'src/generated/layout.ts'), 'utf8')
  const CELL_PREMIUM = JSON.parse(layoutSrc.match(/CELL_PREMIUM: number\[\] = (\[[^\]]*\])/)[1])
  const N = 21
  const CENTER = Math.floor((N * N) / 2)
  check('premium map covers 441 cells', CELL_PREMIUM.length === 441)
  check('centre cell is the star', CELL_PREMIUM[CENTER] === 5)
  check('corners are triple word', CELL_PREMIUM[0] === 4 && CELL_PREMIUM[N * N - 1] === 4)

  // Premium map must be symmetric under all four reflections.
  let symmetric = true
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = CELL_PREMIUM[r * N + c]
      if (
        CELL_PREMIUM[(N - 1 - r) * N + c] !== v ||
        CELL_PREMIUM[r * N + (N - 1 - c)] !== v ||
        CELL_PREMIUM[c * N + r] !== v
      ) {
        symmetric = false
      }
    }
  }
  check('premium map is 8-fold symmetric', symmetric)

  const LETTER_VALUE = [1,3,3,2,1,4,2,4,1,8,5,1,3,1,1,3,10,1,1,1,1,4,4,8,4,10]
  const indexOf = (r, c) => r * N + c
  const rowOf = (i) => Math.floor(i / N)
  const colOf = (i) => i % N

  const isEmpty = (cells) => cells.every((v) => v === 0)

  // Mirrors src/board.ts's canStage: staging only cares whether a cell is on
  // the board and empty. No touch/centre requirement here any more — that
  // moved to isConnected below, checked once at submit time instead of
  // per-tile as each one is staged.
  const canStage = (cells, index) => {
    if (index < 0 || index >= cells.length) return false
    return cells[index] === 0
  }

  // Mirrors src/board.ts's isConnected: flood fill outward from every
  // pre-existing filled cell (or the centre alone, if the board was empty
  // before this turn) across the merged board, and confirm every newly
  // staged cell was reached. The deferred, order-independent replacement for
  // the old per-tile touch check — a word can now be staged starting from
  // either end, as long as the FINISHED shape connects.
  const isConnected = (cellsBeforeTurn, placements) => {
    if (placements.length === 0) return false
    const merged = cellsBeforeTurn.slice()
    for (const p of placements) merged[p.cell] = p.letter
    const newCells = new Set(placements.map((p) => p.cell))

    const seeds = []
    if (isEmpty(cellsBeforeTurn)) {
      if (!newCells.has(CENTER)) return false
      seeds.push(CENTER)
    } else {
      for (let i = 0; i < cellsBeforeTurn.length; i++) if (cellsBeforeTurn[i] !== 0) seeds.push(i)
    }

    const seen = new Set(seeds)
    const queue = seeds.slice()
    while (queue.length) {
      const idx = queue.pop()
      const r = rowOf(idx)
      const c = colOf(idx)
      const neighbours = [
        c > 0 ? idx - 1 : -1,
        c < N - 1 ? idx + 1 : -1,
        r > 0 ? idx - N : -1,
        r < N - 1 ? idx + N : -1
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

  const cells = new Array(N * N).fill(0)
  check('staging no longer requires the centre (any empty cell is stageable)', canStage(cells, 0) && canStage(cells, CENTER))
  check(
    'first submission must still cover the centre star',
    !isConnected(cells, [{ cell: 0, letter: 3 }]) && isConnected(cells, [{ cell: CENTER, letter: 3 }])
  )
  check(
    'a 5-tile word can be staged starting from the far end (order-independent)',
    isConnected(cells, [
      { cell: CENTER + 4, letter: 20 },
      { cell: CENTER + 3, letter: 1 },
      { cell: CENTER + 2, letter: 1 },
      { cell: CENTER + 1, letter: 1 },
      { cell: CENTER, letter: 3 }
    ])
  )

  cells[CENTER] = 3 // C
  check('occupied cell is not stageable', !canStage(cells, CENTER))
  check('staging a far, disconnected cell is now allowed (connectivity is checked at submit instead)', canStage(cells, CENTER + 5))
  check('adjacent placement connects to the board', isConnected(cells, [{ cell: CENTER + 1, letter: 1 }]))
  check('far disconnected placement is rejected at submit time', !isConnected(cells, [{ cell: CENTER + 5, letter: 1 }]))

  // Build "CAT" horizontally from the centre and verify the run + score.
  cells[CENTER + 1] = 1 // A
  cells[CENTER + 2] = 20 // T
  const row = rowOf(CENTER)
  let left = colOf(CENTER)
  while (left > 0 && cells[indexOf(row, left - 1)] !== 0) left--
  let right = colOf(CENTER + 2)
  while (right < N - 1 && cells[indexOf(row, right + 1)] !== 0) right++
  let word = ''
  for (let c = left; c <= right; c++) word += String.fromCharCode(64 + cells[indexOf(row, c)])
  check('horizontal run reads CAT', word === 'CAT', word)

  const base = LETTER_VALUE[2] + LETTER_VALUE[0] + LETTER_VALUE[19]
  check('CAT base value is 5', base === 5, String(base))

  // runKey uniqueness across the whole board
  const seen = new Set()
  let collision = false
  for (let orient = 0; orient < 2; orient++)
    for (let line = 0; line < N; line++)
      for (let start = 0; start < N; start++)
        for (let len = 2; len <= N - start; len++) {
          const k = orient * 250000 + line * 10000 + start * 100 + len
          if (seen.has(k)) collision = true
          seen.add(k)
        }
  check('runKey is collision-free for every possible run', !collision)

  // metresOutsideBoard — drives the "walked away with a word staged" cancel.
  const layoutNums = readFileSync(resolve(ROOT, 'src/generated/layout.ts'), 'utf8')
  const num = (name) => Number(layoutNums.match(new RegExp(`${name} = ([\\d.]+)`))[1])
  const X0 = num('BOARD_X0')
  const Z0 = num('BOARD_Z0')
  const CELL = num('BOARD_CELL_SIZE')
  const span = N * CELL
  const outside = (x, z) => {
    const dx = Math.max(X0 - x, 0, x - (X0 + span))
    const dz = Math.max(Z0 - z, 0, z - (Z0 + span))
    return Math.sqrt(dx * dx + dz * dz)
  }
  check('centre of the board is 0 m outside', outside(X0 + span / 2, Z0 + span / 2) === 0)
  check('every board corner is 0 m outside', [
    [X0, Z0], [X0 + span, Z0], [X0, Z0 + span], [X0 + span, Z0 + span]
  ].every(([x, z]) => outside(x, z) === 0))
  check('7 m past an edge measures 7 m outside', Math.abs(outside(X0 + span + 7, Z0 + span / 2) - 7) < 1e-9)

  // The cancel radius must sit clear of the placement snap tolerance, or
  // stepping off the edge to line up a tile would bin the staged word.
  const CANCEL = Number(
    readFileSync(resolve(ROOT, 'src/tiles.ts'), 'utf8').match(/STAGE_CANCEL_DISTANCE = (\d+)/)[1]
  )
  const EDGE_TOLERANCE_M = 1.5 * CELL
  check(
    `cancel radius (${CANCEL} m) clears the placement tolerance (${EDGE_TOLERANCE_M} m)`,
    CANCEL > EDGE_TOLERANCE_M * 2
  )

  // A dropped tile must not be inside the pickup radius, or the very next
  // proximity scan vacuums it straight back up and the drop looks like a
  // no-op. Mirrors pickupSystem's distance test exactly, including the 0.5
  // weighting it applies to the vertical component.
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf8')
  const cfgNum = (name) => Number(cfg.match(new RegExp(`${name} = ([\\d.]+)`))[1])
  const PICKUP_RADIUS = cfgNum('PICKUP_RADIUS')
  const DROP_DISTANCE = cfgNum('DROP_DISTANCE')
  const DROP_HEIGHT = 0.9 // dropSelected offsets the tile this far above the player
  const dropD2 = DROP_DISTANCE * DROP_DISTANCE + DROP_HEIGHT * DROP_HEIGHT * 0.5
  check(
    `a dropped tile lands outside the pickup radius (d2 ${dropD2.toFixed(2)} vs r2 ${(PICKUP_RADIUS ** 2).toFixed(2)})`,
    dropD2 > PICKUP_RADIUS * PICKUP_RADIUS
  )
  // ...and by a real margin, so a half-step of drift doesn't re-grab it.
  check(
    `drop distance (${DROP_DISTANCE} m) clears the pickup radius (${PICKUP_RADIUS} m) by over 1 m`,
    DROP_DISTANCE - PICKUP_RADIUS > 1
  )
}

/* ---------------------------------------------------------------- *
 * 4. Composite integrity
 * ---------------------------------------------------------------- */
console.log('\ncomposite')
{
  const composite = JSON.parse(readFileSync(resolve(ROOT, 'assets/scene/main.composite'), 'utf8'))
  const scene = JSON.parse(readFileSync(resolve(ROOT, 'scene.json'), 'utf8'))
  const byName = {}
  for (const c of composite.components) byName[c.name] = c.data

  const ids = new Set(Object.keys(byName['core::Transform']))
  let allNamed = true
  for (const id of ids) if (!byName['core-schema::Name'][id]) allNamed = false
  check(`every entity has a Transform and a Name (${ids.size} entities)`, allNamed)

  let everyComponentEntityHasTransform = true
  for (const c of composite.components) {
    for (const id of Object.keys(c.data)) if (!ids.has(id)) everyComponentEntityHasTransform = false
  }
  check('no component references an entity without a Transform', everyComponentEntityHasTransform)

  const nonCore = composite.components.filter((c) => !c.name.startsWith('core::'))
  check(
    'every non-core component carries a jsonSchema',
    nonCore.every((c) => !!c.jsonSchema),
    nonCore.map((c) => c.name).join(', ')
  )
  check(
    'no inspector/asset-packs components in a hand-authored composite',
    !composite.components.some((c) => /^(inspector|asset-packs|composite)::/.test(c.name))
  )

  const width = 16 * Math.max(...scene.scene.parcels.map((p) => +p.split(',')[0])) + 16
  const depth = 16 * Math.max(...scene.scene.parcels.map((p) => +p.split(',')[1])) + 16
  let inBounds = true
  let worst = ''
  for (const [id, entry] of Object.entries(byName['core::Transform'])) {
    const p = entry.json.position
    if (p.x < 0 || p.z < 0 || p.x > width || p.z > depth) {
      inBounds = false
      worst = `${byName['core-schema::Name'][id].json.value} @ ${p.x},${p.y},${p.z}`
    }
  }
  check(`every entity is inside the ${width}x${depth} m footprint`, inBounds, worst)

  const heightLimit = Math.log2(scene.scene.parcels.length + 1) * 20
  let maxY = 0
  for (const entry of Object.values(byName['core::Transform'])) {
    maxY = Math.max(maxY, entry.json.position.y + entry.json.scale.y / 2)
  }
  check(
    `tallest entity (${maxY.toFixed(1)} m) is under the ${heightLimit.toFixed(0)} m limit`,
    maxY < heightLimit
  )

  check('scene.base is one of scene.parcels', scene.scene.parcels.includes(scene.scene.base))
  check('runtimeVersion is 7', scene.runtimeVersion === '7')

  // src/perf.ts hides distant scenery on mobile. VisibilityComponent affects
  // rendering only — colliders stay live — so walkable geometry is safe to cull.
  // What must hold is that the landmark exemption keeps the skyline intact.
  const LANDMARK_FOOTPRINT = 12
  const LANDMARK_HEIGHT = 18
  const renderers = byName['core::MeshRenderer'] || {}
  // perf.ts's cull() only scans engine.getEntitiesWith(MeshRenderer) — a
  // GltfContainer entity (the corner pyramid, the jungle trees, the north/
  // corner mountains) is never in that set at all, so it's unconditionally
  // exempt from culling regardless of size. That's the right call for actual
  // landmarks (mountains, the pyramid — they'd have passed the size test
  // anyway), but it's worth knowing it also applies to anything smaller that
  // gets converted to a GLB later: unlike a primitive, a GLB decoration never
  // gets culled on mobile at all.
  const gltfs = byName['core::GltfContainer'] || {}
  let cullableCount = 0
  const exempt = []
  for (const id of Object.keys(renderers)) {
    const t = byName['core::Transform'][id].json
    const footprint = Math.max(t.scale.x, t.scale.z)
    const top = t.position.y + t.scale.y / 2
    if (footprint >= LANDMARK_FOOTPRINT || top >= LANDMARK_HEIGHT) {
      exempt.push(byName['core-schema::Name'][id].json.value)
    } else {
      cullableCount++
    }
  }
  for (const id of Object.keys(gltfs)) {
    exempt.push(byName['core-schema::Name'][id].json.value)
  }
  // Threshold started at 0.5 but has been eased down repeatedly as more and
  // more small decorations (rocks, pines, pipes, catwalk platforms, crate
  // stacks, ...) were deliberately swapped from culling-eligible primitives
  // to always-rendered GLBs over the course of this project — each swap was
  // a real, repeated, explicit choice (better fidelity for scattered
  // dressing), not a bug, so the ever-shrinking cullable share is expected.
  // This check's job is just to catch a genuine collapse (culling providing
  // near-zero benefit), not to hold the ratio at its original value forever.
  check(
    `mobile culls ${cullableCount} of ${Object.keys(renderers).length} rendered entities`,
    cullableCount > Object.keys(renderers).length * 0.2
  )
  // The things a player sees on the horizon must survive culling. 'Snow Peak'
  // used to be a separate needle for the north backdrop's own primitive cones
  // — now those and the corner massifs are the same GLB-based 'Mountain'
  // entity (see addMountain() in gen-world.mjs), so one needle covers both.
  // Likewise 'Pyramid Cap' (the SOUTH tomb's old stepped-roof primitives) is
  // gone now that buildSouth() places a single GLB 'Pyramid' landmark instead
  // — that name also matches the plaza corners' 'Aztec Pyramid' GLBs, so one
  // needle still covers every pyramid-shaped landmark in the scene.
  for (const needle of ['Mountain', 'Pyramid', 'Floor', 'Ground']) {
    check(
      `"${needle}" scenery is exempt from culling`,
      exempt.some((n) => n.indexOf(needle) !== -1)
    )
  }

  const lights = byName['core::LightSource'] || {}
  const materials = byName['core::Material'] || {}
  const lifted = Object.values(materials).filter(
    (m) => m.json.material.pbr && m.json.material.pbr.emissiveIntensity
  ).length
  check(
    'interiors are lit by emissive too, not only by lights (mobile has no dynamic lights)',
    lifted > Object.keys(lights).length * 5,
    `${lifted} emissive materials vs ${Object.keys(lights).length} lights`
  )
}

/* ---------------------------------------------------------------- *
 * 5. Sync ID uniqueness
 * ---------------------------------------------------------------- */
console.log('\nsync ids')
{
  const config = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf8')
  const grab = (name) => +config.match(new RegExp(`${name} = (\\d+)`))[1]
  const singles = [grab('ROUND'), grab('BOARD'), grab('SCORES')]
  const base = grab('TILE_BASE')
  const maxTiles = +config.match(/MAX_TILES = (\d+)/)[1]
  const all = singles.concat(
    Array.from({ length: maxTiles }, (_, i) => base + i)
  )
  check('all sync IDs are unique', new Set(all).size === all.length)
  check('tile pool does not overlap the singletons', singles.every((s) => s < base))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
