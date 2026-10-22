// Zero-dependency PNG decoder/encoder.
//
// The verifier must read exactly what the image file says, so this module
// implements the PNG container and scanline filters directly on top of
// node:zlib. It accepts every standard colour type at 8 or 16 bits, with or
// without Adam7 interlacing, and always exposes pixels as RGBA8. 16-bit
// samples keep their most significant byte, which is the only lossy step and
// is disclosed in the report.
//
// The encoder is intentionally small: RGBA8, filter 0, one IDAT. It is used
// for the heatmap and for test fixtures, not as a general image writer.

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_PIXELS = 64 * 1000 * 1000

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ALLOWED_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
]

export class PngError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PngError'
    this.code = code || 'PNG_ERROR'
  }
}

export function crc32(buffer, start, end) {
  const from = start === undefined ? 0 : start
  const to = end === undefined ? buffer.length : end
  let c = 0xffffffff
  for (let i = from; i < to; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function readU32(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

function isColorType(value) {
  return value === 0 || value === 2 || value === 3 || value === 4 || value === 6
}

/**
 * Decode a PNG into { width, height, bitDepth, colorType, interlace, rgba }.
 * `rgba` is a Uint8Array of width * height * 4 bytes, always non-premultiplied.
 */
export function decodePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('not a PNG file (missing 8-byte signature)', 'NOT_PNG')
  }

  let offset = 8
  let header
  let palette
  let transparency
  const idat = []
  let ended = false

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new PngError('truncated PNG: chunk header', 'TRUNCATED')
    const length = readU32(buffer, offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new PngError('truncated PNG: chunk data', 'TRUNCATED')
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(dataStart, dataEnd)
    const storedCrc = readU32(buffer, dataEnd)
    const actualCrc = crc32(buffer, offset + 4, dataEnd)
    if (storedCrc !== actualCrc) {
      throw new PngError('PNG chunk ' + type + ' has a bad CRC', 'BAD_CRC')
    }

    if (type === 'IHDR') {
      if (header !== undefined) throw new PngError('duplicate IHDR chunk', 'BAD_IHDR')
      if (length !== 13) throw new PngError('IHDR chunk must be 13 bytes', 'BAD_IHDR')
      header = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new PngError('PLTE chunk has an invalid length', 'BAD_PLTE')
      }
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      ended = true
      break
    }
    // Unknown ancillary chunks are ignored, as the PNG specification allows.
    offset = dataEnd + 4
  }

  if (header === undefined) throw new PngError('PNG has no IHDR chunk', 'BAD_IHDR')
  if (idat.length === 0) throw new PngError('PNG has no IDAT chunk', 'NO_IDAT')
  if (!ended) throw new PngError('PNG has no IEND chunk', 'TRUNCATED')

  const { width, height, bitDepth, colorType, compression, filter, interlace } = header
  if (width === 0 || height === 0) throw new PngError('PNG dimensions must be positive', 'BAD_IHDR')
  if (width * height > MAX_PIXELS) {
    throw new PngError('PNG is too large: ' + width + 'x' + height + ' exceeds the 64-megapixel limit', 'TOO_LARGE')
  }
  if (!isColorType(colorType)) {
    throw new PngError('unsupported PNG colour type: ' + colorType, 'UNSUPPORTED')
  }
  if (!ALLOWED_DEPTHS[colorType].includes(bitDepth)) {
    throw new PngError(
      'unsupported PNG bit depth ' + bitDepth + ' for colour type ' + colorType +
        ' (allowed: ' + ALLOWED_DEPTHS[colorType].join(', ') + ')',
      'UNSUPPORTED',
    )
  }
  if (compression !== 0 || filter !== 0) {
    throw new PngError('unsupported PNG compression/filter method', 'UNSUPPORTED')
  }
  if (interlace !== 0 && interlace !== 1) {
    throw new PngError('unsupported PNG interlace method: ' + interlace, 'UNSUPPORTED')
  }
  if (colorType === 3 && palette === undefined) throw new PngError('palette PNG has no PLTE chunk', 'BAD_PLTE')

  let inflated
  try {
    inflated = inflateSync(Buffer.concat(idat))
  } catch (error) {
    throw new PngError('IDAT decompression failed: ' + ((error && error.message) || error), 'BAD_ZLIB')
  }

  const channels = CHANNELS[colorType]
  // Sub-byte samples (palette 1/2/4-bit, gray 1/2/4-bit) are packed; filters
  // still work on whole bytes with a bpp of 1.
  const bytesPerSample = bitDepth >= 8 ? bitDepth / 8 : 1
  const filterBpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const rgba = new Uint8Array(width * height * 4)
  const passes = interlace === 1 ? ADAM7 : [{ x0: 0, y0: 0, dx: 1, dy: 1 }]
  let rawOffset = 0

  for (const pass of passes) {
    const passWidth = Math.ceil((width - pass.x0) / pass.dx)
    const passHeight = Math.ceil((height - pass.y0) / pass.dy)
    if (passWidth <= 0 || passHeight <= 0) continue
    const rowBytes = Math.ceil((passWidth * channels * bitDepth) / 8)
    const passLength = passHeight * (rowBytes + 1)
    if (rawOffset + passLength > inflated.length) {
      throw new PngError('PNG image data is shorter than its header requires', 'TRUNCATED')
    }
    const rows = unfilter(inflated.subarray(rawOffset, rawOffset + passLength), rowBytes, passHeight, filterBpp)
    rawOffset += passLength

    for (let py = 0; py < passHeight; py += 1) {
      const y = pass.y0 + py * pass.dy
      const rowStart = py * rowBytes
      for (let px = 0; px < passWidth; px += 1) {
        const x = pass.x0 + px * pass.dx
        const base = rowStart + px * channels * bytesPerSample
        const out = (y * width + x) * 4
        let r
        let g
        let b
        let a = 255

        if (colorType === 3) {
          const index = readSampleAt(rows, rowStart, px, bitDepth)
          const paletteOffset = index * 3
          if (paletteOffset + 2 >= palette.length) {
            throw new PngError('palette index ' + index + ' is out of range', 'BAD_PLTE')
          }
          r = palette[paletteOffset]
          g = palette[paletteOffset + 1]
          b = palette[paletteOffset + 2]
          if (transparency !== undefined && index < transparency.length) a = transparency[index]
        } else if (colorType === 0) {
          const raw = readSampleAt(rows, rowStart, px, bitDepth)
          const value = scaleSample(raw, bitDepth)
          r = value
          g = value
          b = value
          if (transparency !== undefined && transparency.length >= 2) {
            const key = transparency.readUInt16BE(0)
            if (raw === key) a = 0
          }
        } else if (colorType === 4) {
          const value = sampleMsb(rows, base, bitDepth)
          r = value
          g = value
          b = value
          a = sampleMsb(rows, base + bytesPerSample, bitDepth)
        } else if (colorType === 2) {
          r = sampleMsb(rows, base, bitDepth)
          g = sampleMsb(rows, base + bytesPerSample, bitDepth)
          b = sampleMsb(rows, base + bytesPerSample * 2, bitDepth)
          if (transparency !== undefined && transparency.length >= 6) {
            const keyR = bitDepth === 16 ? transparency.readUInt16BE(0) : transparency[1]
            const keyG = bitDepth === 16 ? transparency.readUInt16BE(2) : transparency[3]
            const keyB = bitDepth === 16 ? transparency.readUInt16BE(4) : transparency[5]
            const rawR = bitDepth === 16 ? rows.readUInt16BE(base) : rows[base]
            const rawG = bitDepth === 16 ? rows.readUInt16BE(base + 2) : rows[base + 1]
            const rawB = bitDepth === 16 ? rows.readUInt16BE(base + 4) : rows[base + 2]
            if (rawR === keyR && rawG === keyG && rawB === keyB) a = 0
          }
        } else {
          r = sampleMsb(rows, base, bitDepth)
          g = sampleMsb(rows, base + bytesPerSample, bitDepth)
          b = sampleMsb(rows, base + bytesPerSample * 2, bitDepth)
          a = sampleMsb(rows, base + bytesPerSample * 3, bitDepth)
        }

        rgba[out] = r
        rgba[out + 1] = g
        rgba[out + 2] = b
        rgba[out + 3] = a
      }
    }
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    channels,
    hasAlpha: colorType === 4 || colorType === 6 || (colorType === 3 && transparency !== undefined),
    rgba,
  }
}

// Return the raw sample value for a single-channel row (gray or palette).
// Sub-byte samples are packed most-significant-bit first.
function readSampleAt(rows, rowStart, pixelIndex, bitDepth) {
  if (bitDepth === 8) return rows[rowStart + pixelIndex]
  if (bitDepth === 16) return rows.readUInt16BE(rowStart + pixelIndex * 2)
  const bitOffset = pixelIndex * bitDepth
  const byte = rows[rowStart + (bitOffset >> 3)]
  const shift = 8 - bitDepth - (bitOffset & 7)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

// Map a raw sample to the 8-bit value used by the RGBA working buffer.
function scaleSample(value, bitDepth) {
  if (bitDepth === 8) return value
  if (bitDepth === 16) return value >> 8
  const max = (1 << bitDepth) - 1
  return Math.round((value * 255) / max)
}

// 16-bit samples expose their most significant byte, which is the first byte
// of the big-endian sample.
function sampleMsb(rows, offset) {
  return rows[offset]
}

function unfilter(data, rowBytes, height, bpp) {
  const out = Buffer.alloc(rowBytes * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    const filterType = data[offset]
    offset += 1
    const rowStart = y * rowBytes
    const prevStart = rowStart - rowBytes
    for (let x = 0; x < rowBytes; x += 1) {
      const value = data[offset + x]
      const left = x >= bpp ? out[rowStart + x - bpp] : 0
      const up = y > 0 ? out[prevStart + x] : 0
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0
      let predictor
      if (filterType === 0) predictor = 0
      else if (filterType === 1) predictor = left
      else if (filterType === 2) predictor = up
      else if (filterType === 3) predictor = Math.floor((left + up) / 2)
      else if (filterType === 4) predictor = paeth(left, up, upLeft)
      else throw new PngError('unknown PNG scanline filter: ' + filterType, 'BAD_FILTER')
      out[rowStart + x] = (value + predictor) & 0xff
    }
    offset += rowBytes
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Encode RGBA8 pixels as a PNG (colour type 6, filter 0, one IDAT).
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError('encodePng needs positive integer dimensions', 'BAD_ARGUMENT')
  }
  if (width * height > MAX_PIXELS) throw new PngError('encodePng image is too large', 'TOO_LARGE')
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) {
    throw new PngError('encodePng needs a Uint8Array of width * height * 4 bytes', 'BAD_ARGUMENT')
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const compressed = deflateSync(raw, { level: 9 })

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
