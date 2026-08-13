/**
 * Letter values, the draw bag, and sprite-sheet UV maths.
 *
 * `assets/textures/alphabets.png` is a 512x512 sheet laid out as an 8x8 grid of
 * 64px cells with A in the BOTTOM-LEFT, running left-to-right then upward.
 * Letter index 0 = A ... 25 = Z.
 *
 * Each cell already renders the letter's Scrabble value as a subscript, so
 * nothing downstream draws one — the 3D tiles and the HUD both just show the
 * cropped glyph. LETTER_VALUE below must stay in step with what the sheet says;
 * `npm run check` asserts the subscripts are present.
 */

export const SHEET_COLS = 8
export const SHEET_ROWS = 8

/** Standard Scrabble letter values, indexed A..Z. */
export const LETTER_VALUE: number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10
]

/** Standard Scrabble tile frequencies (blanks excluded), indexed A..Z. */
const LETTER_FREQ: number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1
] 

const CUMULATIVE: number[] = (() => {
  const out: number[] = []
  let total = 0
  for (const f of LETTER_FREQ) {
    total += f
    out.push(total)
  }
  return out
})()
const FREQ_TOTAL = CUMULATIVE[CUMULATIVE.length - 1]

/** Draw a weighted-random letter index (0 = A .. 25 = Z). */
export function drawLetter(): number {
  const roll = Math.random() * FREQ_TOTAL
  for (let i = 0; i < CUMULATIVE.length; i++) {
    if (roll < CUMULATIVE[i]) return i
  }
  return 4 // 'E'
}

export function letterChar(index: number): string {
  return String.fromCharCode(65 + index)
}

export function charToLetter(ch: string): number {
  const c = ch.toUpperCase().charCodeAt(0)
  return c >= 65 && c <= 90 ? c - 65 : -1
}

/**
 * Column/row of a glyph's cell, index order bottom-up (row 0 = A..H, the
 * sheet's bottom-stored row; row 3 = Y, Z, ...).
 */
function letterCell(index: number): { col: number; row: number } {
  const i = Math.max(0, Math.min(63, index))
  return { col: i % SHEET_COLS, row: Math.floor(i / SHEET_COLS) }
}

/** A tiny inset stops neighbouring glyphs bleeding in through bilinear filtering. */
const PAD = 0.0015

/**
 * 8-value UV array for a single `MeshRenderer.setPlane()` face, cropped to
 * one glyph cell.
 *
 * This replaces an attempt at cropping a single 6-face box directly. Real-
 * device testing went through two rounds and never got a box fully right on
 * Godot Explorer: a 48-value array (4 corners * 6 faces) left one face
 * correct and the rest uncropped; doubling it to 96 (matching
 * `PBMeshRenderer_BoxMesh`'s own doc comment, "6 faces * 2 sides * 4
 * vertices") made the previously-correct face wrong too, while the others
 * stayed uncropped — and Decentraland's own materials doc separately
 * describes a box needing only 48 ("Each of the 6 faces of the cube takes 4
 * pairs of coordinates... All of these 48 values"), contradicting the
 * generated type's comment. With two official sources disagreeing and both
 * lengths failing in-world, a box's per-face vertex order isn't something
 * this project can reliably target.
 *
 * A plane sidesteps all of it: Decentraland's own materials doc gives a
 * complete, working example of a plane's uvs (8 values — 4 corners, listed
 * twice for the plane's 2 sides, in the SAME order both times, not
 * reversed). One crop, one winding, no per-face guessing — see view.ts's
 * `DECAL_FACES`, which builds a letter out of 5 of these (top + 4 sides, no
 * bottom — tiles only ever yaw, never pitch or roll, so the underside is
 * never seen) instead of one 6-face box.
 *
 * The corner order below is NOT the docs' own example order (bottom-left
 * first) — an earlier version of this function used that and, on Godot
 * Explorer, came out both mirrored and cropped to a tiny sliver of the cell
 * instead of the full glyph. Reversing the 4 corners' traversal direction is
 * exactly the box attempt's top-left-first order, which was the one face
 * that DID crop correctly on Godot back when this used a 6-face box (see
 * above) — reusing that proven-on-Godot order here fixed both symptoms at
 * once, which makes sense: walking the same 4 points in the opposite
 * direction against a fixed vertex sequence is a reflection, not just a
 * different starting corner.
 *
 * IMPORTANT: mesh texture V is the standard GL convention — v=0 is the BOTTOM
 * of the texture, v increases UPWARD. This is the opposite of `letterUiUvs`
 * below, which is downward. Confirmed by real-device testing: sharing one V
 * mapping between the two broke whichever one wasn't fixed for. Row 0 (A..H,
 * meant to be the sheet's bottom) has to land on the sheet's LAST stored PNG
 * row here, since PNG rows are stored top-down but v=0 reads as bottom.
 *
 * `flip` exists because that GL convention turned out to only be half the
 * story: Decentraland has two independent official client codebases —
 * Unity Explorer (desktop-only) and Godot Explorer (desktop/mobile/VR) — and
 * they were confirmed, side by side, to sample a mesh's V axis in OPPOSITE
 * directions. Godot renders correctly with `flip = true` (the mapping
 * below); Unity needs `flip = false` — i.e. row used directly, no bottom-up
 * inversion — to show the same letter. See view.ts for which platforms get
 * which.
 */
export function letterPlaneUvs(index: number, flip: boolean): number[] {
  const { col, row } = letterCell(index)
  const imgRow = flip ? SHEET_ROWS - 1 - row : row
  const u0 = col / SHEET_COLS + PAD
  const u1 = (col + 1) / SHEET_COLS - PAD
  const v0 = imgRow / SHEET_ROWS + PAD
  const v1 = (imgRow + 1) / SHEET_ROWS - PAD

  // Top-left, top-right, bottom-right, bottom-left — the reverse of the
  // docs' own example order; see the function comment above for why.
  const quad = [u0, v1, u1, v1, u1, v0, u0, v0]
  return [...quad, ...quad]
}

/**
 * 8 floats for `uiBackground.uvs`, which the protocol documents as
 * "starting from bottom-left vertex clock-wise" — bottom-left, TOP-left,
 * top-right, bottom-right.
 *
 * IMPORTANT: 2D UI texture V is downward — v=0 is the TOP of the texture,
 * matching the PNG's own top-to-bottom row storage directly. This is the
 * opposite of `letterPlaneUvs` above (mesh V is upward/GL-style). Row 0
 * (A..H) maps straight onto row 0 here with NO flip — do not share a V
 * mapping between this and the mesh crop; that was tried and broke one or
 * the other depending on which direction was "fixed" last.
 */
export function letterUiUvs(index: number): number[] {
  const { col, row } = letterCell(index)
  const u0 = col / SHEET_COLS + PAD
  const u1 = (col + 1) / SHEET_COLS - PAD
  const v0 = row / SHEET_ROWS + PAD
  const v1 = (row + 1) / SHEET_ROWS - PAD
  return [u0, v0, u0, v1, u1, v1, u1, v0]
}
