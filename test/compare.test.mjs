import { strict as assert } from 'node:assert'
import test from 'node:test'
import { InputError, buildLockMap, comparePixels, pixelDelta } from '../src/core/compare.js'

function image(width, height, color) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = typeof color === 'function' ? color(x, y) : color
      const p = (y * width + x) * 4
      rgba[p] = value[0]
      rgba[p + 1] = value[1]
      rgba[p + 2] = value[2]
      rgba[p + 3] = value[3]
    }
  }
  return { width, height, rgba }
}

function mask(width, height, isMarked) {
  return image(width, height, (x, y) => (isMarked(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255]))
}

test('edit mode protects exactly the pixels outside the mask', () => {
  const scope = buildLockMap(mask(4, 3, (x, y) => x >= 1 && x <= 2 && y === 1), { mode: 'edit', threshold: 127 })
  assert.equal(scope.marked, 2)
  assert.equal(scope.protectedPixels, 10)
  assert.deepEqual(Array.from(scope.lock), [
    1, 1, 1, 1,
    1, 0, 0, 1,
    1, 1, 1, 1,
  ])
})

test('lock mode protects exactly the painted pixels', () => {
  const scope = buildLockMap(mask(4, 3, (x, y) => x >= 1 && x <= 2 && y === 1), { mode: 'lock' })
  assert.equal(scope.protectedPixels, 2)
  assert.deepEqual(Array.from(scope.lock), [
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ])
})

test('mask ink is luminance times alpha, so a transparent painted mask marks nothing', () => {
  const transparentWhite = image(3, 1, [255, 255, 255, 0])
  const opaqueWhite = image(3, 1, [255, 255, 255, 255])
  assert.equal(buildLockMap(transparentWhite, { mode: 'edit' }).marked, 0)
  assert.equal(buildLockMap(opaqueWhite, { mode: 'edit' }).marked, 3)
  assert.equal(buildLockMap(transparentWhite, { mode: 'lock' }).protectedPixels, 0)
})

test('the mask threshold is inclusive', () => {
  const grey = image(2, 1, [127, 127, 127, 255])
  assert.equal(buildLockMap(grey, { threshold: 127 }).marked, 2)
  assert.equal(buildLockMap(grey, { threshold: 128 }).marked, 0)
})

test('a threshold outside 0..255 is rejected', () => {
  assert.throws(() => buildLockMap(mask(1, 1, () => false), { threshold: 256 }), (error) => error.code === 'BAD_THRESHOLD')
})

test('identical images pass with a zero delta', () => {
  const original = image(5, 4, (x, y) => [x * 10, y * 20, 128, 255])
  const scope = buildLockMap(mask(5, 4, (x, y) => x === 0 && y === 0))
  const comparison = comparePixels(original, original, scope.lock)
  assert.equal(comparison.verdict, 'pass')
  assert.equal(comparison.protectedPixels, 19)
  assert.equal(comparison.changedPixels, 0)
  assert.equal(comparison.exactChangedPixels, 0)
  assert.equal(comparison.maxDelta, 0)
  assert.equal(comparison.meanDelta, 0)
  assert.equal(comparison.bbox, null)
  assert.deepEqual(comparison.warnings, [])
  assert.ok(comparison.histogram[0].count === 19, 'all protected pixels land in the zero bucket')
})

test('one changed protected pixel fails and reports its coordinates', () => {
  const original = image(5, 4, [10, 20, 30, 255])
  const generated = image(5, 4, (x, y) => (x === 3 && y === 2 ? [10, 20, 31, 255] : [10, 20, 30, 255]))
  const scope = buildLockMap(mask(5, 4, (x, y) => x === 0 && y === 0))
  const comparison = comparePixels(original, generated, scope.lock)
  assert.equal(comparison.verdict, 'fail')
  assert.equal(comparison.changedPixels, 1)
  assert.equal(comparison.maxDelta, 1)
  assert.deepEqual(comparison.bbox, { x: 3, y: 2, w: 1, h: 1 })
  assert.equal(comparison.samples.length, 1)
  assert.deepEqual(comparison.samples[0], {
    x: 3,
    y: 2,
    delta: 1,
    original: [10, 20, 30, 255],
    generated: [10, 20, 31, 255],
  })
  assert.deepEqual(comparison.perChannelMax, { r: 0, g: 0, b: 1, a: 0 })
})

test('changes inside the editable mask are ignored', () => {
  const original = image(3, 3, [0, 0, 0, 255])
  const generated = image(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  const scope = buildLockMap(mask(3, 3, (x, y) => x === 1 && y === 1))
  const comparison = comparePixels(original, generated, scope.lock)
  assert.equal(comparison.verdict, 'pass')
  assert.equal(comparison.changedPixels, 0)
  assert.equal(comparison.editablePixels, 1)
})

test('tolerance admits small deltas but keeps the strict count and a warning', () => {
  const original = image(2, 1, [100, 100, 100, 255])
  const generated = image(2, 1, [102, 100, 100, 255])
  const scope = buildLockMap(mask(2, 1, () => false))
  const comparison = comparePixels(original, generated, scope.lock, { tolerance: 2 })
  assert.equal(comparison.verdict, 'pass')
  assert.equal(comparison.changedPixels, 0)
  assert.equal(comparison.exactChangedPixels, 2)
  assert.equal(comparison.maxDelta, 2)
  assert.match(comparison.warnings.join('\n'), /容差/)
})

test('alpha is compared by default and can be ignored', () => {
  const original = image(2, 1, [10, 20, 30, 255])
  const generated = image(2, 1, [10, 20, 30, 10])
  const scope = buildLockMap(mask(2, 1, () => false))
  assert.equal(comparePixels(original, generated, scope.lock).verdict, 'fail')
  const ignored = comparePixels(original, generated, scope.lock, { ignoreAlpha: true })
  assert.equal(ignored.verdict, 'pass')
  assert.equal(ignored.perChannelMax.a, 0)
})

test('an all-editable mask is EMPTY, not PASS', () => {
  const original = image(2, 2, [0, 0, 0, 255])
  const scope = buildLockMap(mask(2, 2, () => true))
  const comparison = comparePixels(original, original, scope.lock)
  assert.equal(comparison.verdict, 'empty')
  assert.equal(comparison.protectedPixels, 0)
  assert.match(comparison.warnings.join('\n'), /没有受保护像素/)
})

test('the histogram counts every protected pixel exactly once', () => {
  const original = image(4, 1, [0, 0, 0, 255])
  const generated = image(4, 1, (x) => [x, x * 2, x * 4, 255])
  const scope = buildLockMap(mask(4, 1, () => false))
  const comparison = comparePixels(original, generated, scope.lock)
  const total = comparison.histogram.reduce((sum, bucket) => sum + bucket.count, 0)
  assert.equal(total, comparison.protectedPixels)
  assert.equal(comparison.changedPixels, 3)
  assert.equal(comparison.maxDelta, 12)
})

test('the 20 samples kept are the largest deltas, in descending order', () => {
  const original = image(25, 1, [0, 0, 0, 255])
  const generated = image(25, 1, (x) => [x, 0, 0, 255])
  const scope = buildLockMap(mask(25, 1, () => false))
  const comparison = comparePixels(original, generated, scope.lock)
  assert.equal(comparison.samples.length, 20)
  assert.deepEqual(comparison.samples.map((sample) => sample.delta), Array.from({ length: 20 }, (_, i) => 24 - i))
  assert.equal(comparison.samples[0].x, 24)
})

test('dimension mismatches and malformed lock maps are rejected', () => {
  const a = image(2, 2, [0, 0, 0, 255])
  const b = image(3, 2, [0, 0, 0, 255])
  assert.throws(() => comparePixels(a, b, new Uint8Array(4)), (error) => error.code === 'DIMENSION_MISMATCH')
  assert.throws(() => comparePixels(a, a, new Uint8Array(3)), (error) => error.code === 'BAD_LOCK_MAP')
})

test('out-of-range tolerance is rejected', () => {
  assert.throws(() => comparePixels(image(1, 1, [0, 0, 0, 255]), image(1, 1, [0, 0, 0, 255]), new Uint8Array([0]), { tolerance: 256 }), (error) => error.code === 'BAD_TOLERANCE')
  assert.ok(InputError)
})

test('pixelDelta uses the same max-channel definition as the comparison', () => {
  const a = image(1, 1, [10, 20, 30, 40])
  const b = image(1, 1, [11, 25, 27, 41])
  assert.equal(pixelDelta(a, b, 0, false), 5)
  assert.equal(pixelDelta(a, b, 0, true), 5)
  const alphaOnly = image(1, 1, [10, 20, 30, 200])
  assert.equal(pixelDelta(a, alphaOnly, 0, false), 160)
  assert.equal(pixelDelta(a, alphaOnly, 0, true), 0)
})
