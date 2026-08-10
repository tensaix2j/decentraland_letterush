import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

export function readPngGray(path) {
  const buf = readFileSync(path)
  let pos = 8
  let width = 0, height = 0, depth = 0, colorType = 0
  let palette = null
  let trns = null // per-palette-index alpha (colorType 3 only); index not listed = opaque
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const bpp = Math.max(1, Math.ceil((depth * channels) / 8))
  const rowBytes = Math.ceil((width * channels * depth) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(rowBytes * height)
  let prev = Buffer.alloc(rowBytes)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1))
    const cur = Buffer.alloc(rowBytes)
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    cur.copy(out, y * rowBytes)
    prev = cur
  }
  const gray = new Uint8Array(width * height)
  const alpha = new Uint8Array(width * height).fill(255) // opaque unless a tRNS says otherwise
  const perByte = 8 / depth
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value
      if (depth < 8) {
        const byte = out[y * rowBytes + Math.floor(x / perByte)]
        const shift = 8 - depth * ((x % perByte) + 1)
        value = (byte >> shift) & ((1 << depth) - 1)
      } else value = out[y * rowBytes + x * channels]
      if (colorType === 3 && palette) {
        const o = value * 3
        gray[y * width + x] = (palette[o] * 299 + palette[o + 1] * 587 + palette[o + 2] * 114) / 1000
        if (trns) alpha[y * width + x] = value < trns.length ? trns[value] : 255
      } else {
        gray[y * width + x] = value
      }
    }
  }
  // "ink" callers care about visible marks — a fully transparent pixel is never
  // ink regardless of what color its RGB happens to hold underneath.
  for (let i = 0; i < gray.length; i++) {
    if (alpha[i] < 128) gray[i] = 255
  }
  return { width, height, gray, alpha }
}
