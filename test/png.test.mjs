// PNG decoder/encoder compatibility tests.
//
// The fixtures were produced by Pillow (and by a small independent Python
// writer for filters, 16-bit and Adam7), so a green test means the JavaScript
// decoder agrees with a second implementation, not merely with its own encoder.

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PngError, crc32, decodePng, encodePng } from '../src/core/png.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'fixtures.json'), 'utf8'))
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

for (const [name, expected] of Object.entries(FIXTURES)) {
  test('decodes ' + name + ' to the expected RGBA bytes', () => {
    const image = decodePng(fixture(name))
    assert.equal(image.width, expected.width, 'width')
    assert.equal(image.height, expected.height, 'height')
    assert.equal(image.bitDepth, expected.bitDepth, 'bit depth')
    assert.equal(image.colorType, expected.colorType, 'colour type')
    assert.equal(image.rgba.length, expected.rgbaBytes, 'RGBA byte count')
    assert.equal(sha(Buffer.from(image.rgba)), expected.rgbaSha256, 'RGBA digest')
  })
}

test('crc32 matches the published PNG IEND checksum', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082)
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('encoded PNG carries the expected header and survives a round trip', () => {
  const width = 7
  const height = 5
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4
      rgba[p] = (x * 37) % 256
      rgba[p + 1] = (y * 53) % 256
      rgba[p + 2] = (x * y * 11) % 256
      rgba[p + 3] = 255 - ((x * 7 + y * 3) % 128)
    }
  }
  const bytes = encodePng(width, height, rgba)
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR')
  const image = decodePng(bytes)
  assert.equal(image.width, width)
  assert.equal(image.height, height)
  assert.equal(image.bitDepth, 8)
  assert.equal(image.colorType, 6)
  assert.equal(image.interlace, 0)
  assert.deepEqual(Buffer.from(image.rgba), Buffer.from(rgba))
})

test('a bad CRC is rejected with a named error', () => {
  assert.throws(
    () => decodePng(fixture('bad-crc.png')),
    (error) => error instanceof PngError && error.code === 'BAD_CRC',
  )
})

test('a truncated file is rejected', () => {
  assert.throws(
    () => decodePng(fixture('truncated.png')),
    (error) => error instanceof PngError && (error.code === 'TRUNCATED' || error.code === 'BAD_CRC'),
  )
})

test('a non-PNG input is rejected', () => {
  assert.throws(
    () => decodePng(Buffer.from('GIF89a not a png')),
    (error) => error instanceof PngError && error.code === 'NOT_PNG',
  )
})

test('encodePng validates its arguments', () => {
  assert.throws(() => encodePng(0, 1, new Uint8Array(0)), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => encodePng(2, 2, new Uint8Array(15)), (error) => error.code === 'BAD_ARGUMENT')
})

test('16-bit samples keep the most significant byte', () => {
  const image = decodePng(fixture('gray-16.png'))
  // First sample in the fixture is 1234; its high byte is 4.
  assert.deepEqual(Array.from(image.rgba.subarray(0, 4)), [4, 4, 4, 255])
})

test('palette transparency is applied', () => {
  const image = decodePng(fixture('palette-trns.png'))
  assert.equal(image.rgba[3], 0, 'first palette index is fully transparent')
  assert.ok(image.rgba.includes(255), 'other indices stay opaque')
})

test('interlaced images decode to the same pixels as the flat equivalent', () => {
  const flat = decodePng(fixture('rgba.png'))
  const interlaced = decodePng(fixture('interlaced.png'))
  assert.equal(interlaced.interlace, 1)
  assert.deepEqual(Buffer.from(interlaced.rgba), Buffer.from(flat.rgba))
})
