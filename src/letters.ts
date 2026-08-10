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
 * Crop for a mesh's base `texture` (NOT `uiBackground`, NOT `emissiveTexture`).
 *
 * This deliberately does NOT touch mesh UVs. An earlier version supplied a
 * custom 96-value array to `MeshRenderer.setBox` (one quad repeated across all
 * 6 faces x 2 sides) on the theory that every face shares the same vertex
 * winding — confirmed wrong in-world: the top face cropped correctly, the side
 * faces did not, meaning the box's default per-face UV winding is NOT uniform
 * across faces the way a flat "repeat this quad everywhere" array assumes.
 *
 * `Texture.offset`/`Texture.tiling` sidestep the problem entirely: the proto
 * defines `final_uv = offset + input_uv * tiling`, applied per-vertex on
 * whatever UV each face already has by default. Since `MeshRenderer.setBox()`
 * with no `uvs` argument uses the engine's own built-in box unwrap — which is
 * necessarily self-consistent, being the renderer's own primitive — every face
 * already spans a full, correctly-oriented 0..1 range on its own. Remapping
 * that through a single shared affine transform crops the same sub-rectangle
 * everywhere, independent of any face's individual winding or starting corner.
 * The mesh is left with its default UVs; only the material's texture changes.
 *
 * IMPORTANT: mesh texture V is the standard GL convention — v=0 is the BOTTOM
 * of the texture, v increases UPWARD. This is the opposite of `letterUiUvs`
 * below, which is downward. Confirmed by real-device testing: sharing one V
 * mapping between the two broke whichever one wasn't fixed for. Row 0 (A..H,
 * meant to be the sheet's bottom) has to land on the sheet's LAST stored PNG
 * row here, since PNG rows are stored top-down but v=0 reads as bottom.
 */
export type TextureCrop = { offset: { x: number; y: number }; tiling: { x: number; y: number } }

export function letterTextureCrop(index: number): TextureCrop {
  const { col, row } = letterCell(index)
  const imgRow = SHEET_ROWS - 1 - row
  const u0 = col / SHEET_COLS + PAD
  const u1 = (col + 1) / SHEET_COLS - PAD
  const v0 = imgRow / SHEET_ROWS + PAD
  const v1 = (imgRow + 1) / SHEET_ROWS - PAD
  return { offset: { x: u0, y: v0 }, tiling: { x: u1 - u0, y: v1 - v0 } }
}

/**
 * 8 floats for `uiBackground.uvs`, which the protocol documents as
 * "starting from bottom-left vertex clock-wise" — bottom-left, TOP-left,
 * top-right, bottom-right.
 *
 * IMPORTANT: 2D UI texture V is downward — v=0 is the TOP of the texture,
 * matching the PNG's own top-to-bottom row storage directly. This is the
 * opposite of `letterTextureCrop` above (mesh V is upward/GL-style). Row 0
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
