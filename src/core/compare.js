// Pure pixel comparison. No I/O, no PNG knowledge beyond the RGBA buffers.
//
// The contract is deliberately narrow: the mask says which pixels a generator
// was allowed to touch; every other pixel is evidence. A changed protected
// pixel is a failure even when the change is one level in one channel.

export const MAX_TOLERANCE = 255

export class InputError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'InputError'
    this.code = code || 'INPUT_ERROR'
  }
}

/**
 * Turn a decoded mask image into a 1-byte lock map.
 *
 * Mask ink is luminance * alpha / 255, so an opaque black/white mask and a
 * transparent-backed painted mask both mean the same thing. `mode: 'edit'`
 * (default) marks the editable area and protects the rest; `mode: 'lock'`
 * marks the protected area directly.
 */
export function buildLockMap(mask, options) {
  const settings = options || {}
  const mode = settings.mode === 'lock' ? 'lock' : 'edit'
  const threshold = Number.isInteger(settings.threshold) ? settings.threshold : 127
  if (threshold < 0 || threshold > 255) {
    throw new InputError('mask threshold must be an integer between 0 and 255', 'BAD_THRESHOLD')
  }

  const { width, height, rgba } = mask
  const total = width * height
  const lock = new Uint8Array(total)
  let marked = 0
  for (let i = 0; i < total; i += 1) {
    const p = i * 4
    const luminance = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]
    const ink = Math.round((luminance * rgba[p + 3]) / 255)
    const hit = ink >= threshold
    const protectedPixel = mode === 'lock' ? hit : !hit
    if (hit) marked += 1
    if (protectedPixel) lock[i] = 1
  }
  return { lock, marked, protectedPixels: mode === 'lock' ? marked : total - marked, mode, threshold }
}

/**
 * Compare every protected pixel. Returns counts, extrema, a histogram and the
 * first few changed samples; the caller decides what the verdict is called.
 */
export function comparePixels(original, generated, lock, options) {
  const settings = options || {}
  const tolerance = Number.isInteger(settings.tolerance) ? settings.tolerance : 0
  if (tolerance < 0 || tolerance > MAX_TOLERANCE) {
    throw new InputError('tolerance must be an integer between 0 and 255', 'BAD_TOLERANCE')
  }
  const compareAlpha = settings.ignoreAlpha !== true

  if (original.width !== generated.width || original.height !== generated.height) {
    throw new InputError('original and generated images must have identical dimensions', 'DIMENSION_MISMATCH')
  }
  if (lock.length !== original.width * original.height) {
    throw new InputError('lock map does not match the image dimensions', 'BAD_LOCK_MAP')
  }

  const total = original.width * original.height
  const width = original.width
  const histogram = [
    { label: '0', min: 0, max: 0, count: 0 },
    { label: '1', min: 1, max: 1, count: 0 },
    { label: '2-3', min: 2, max: 3, count: 0 },
    { label: '4-7', min: 4, max: 7, count: 0 },
    { label: '8-15', min: 8, max: 15, count: 0 },
    { label: '16-31', min: 16, max: 31, count: 0 },
    { label: '32-63', min: 32, max: 63, count: 0 },
    { label: '64-127', min: 64, max: 127, count: 0 },
    { label: '128-255', min: 128, max: 255, count: 0 },
  ]

  let protectedPixels = 0
  let changedPixels = 0
  let exactChangedPixels = 0
  let maxDelta = 0
  let sumDelta = 0
  const perChannelMax = { r: 0, g: 0, b: 0, a: 0 }
  let minX = width
  let minY = original.height
  let maxX = -1
  let maxY = -1
  let maskMinX = width
  let maskMinY = original.height
  let maskMaxX = -1
  let maskMaxY = -1
  const samples = []

  for (let i = 0; i < total; i += 1) {
    if (lock[i] !== 1) continue
    protectedPixels += 1
    const p = i * 4
    const dr = Math.abs(original.rgba[p] - generated.rgba[p])
    const dg = Math.abs(original.rgba[p + 1] - generated.rgba[p + 1])
    const db = Math.abs(original.rgba[p + 2] - generated.rgba[p + 2])
    const da = compareAlpha ? Math.abs(original.rgba[p + 3] - generated.rgba[p + 3]) : 0
    let delta = dr
    if (dg > delta) delta = dg
    if (db > delta) delta = db
    if (da > delta) delta = da

    const x = i % width
    const y = (i - x) / width
    if (x < maskMinX) maskMinX = x
    if (x > maskMaxX) maskMaxX = x
    if (y < maskMinY) maskMinY = y
    if (y > maskMaxY) maskMaxY = y

    sumDelta += delta
    if (dr > perChannelMax.r) perChannelMax.r = dr
    if (dg > perChannelMax.g) perChannelMax.g = dg
    if (db > perChannelMax.b) perChannelMax.b = db
    if (da > perChannelMax.a) perChannelMax.a = da
    if (delta > maxDelta) maxDelta = delta

    const bucket = histogram.find((entry) => delta >= entry.min && delta <= entry.max)
    if (bucket !== undefined) bucket.count += 1

    if (delta > 0) exactChangedPixels += 1
    if (delta <= tolerance) continue

    changedPixels += 1
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    offerSample(samples, {
      x,
      y,
      delta,
      original: [original.rgba[p], original.rgba[p + 1], original.rgba[p + 2], original.rgba[p + 3]],
      generated: [generated.rgba[p], generated.rgba[p + 1], generated.rgba[p + 2], generated.rgba[p + 3]],
    })
  }

  let verdict = 'pass'
  if (protectedPixels === 0) verdict = 'empty'
  else if (changedPixels > 0) verdict = 'fail'

  const warnings = []
  if (verdict === 'empty') {
    warnings.push('蒙版外没有受保护像素：这次校验没有可证明的对象，不能当作通过。')
  }
  if (tolerance > 0 && exactChangedPixels > 0) {
    warnings.push(
      '容差为 ' + tolerance + '，有 ' + exactChangedPixels + ' 个受保护像素发生了容差内的变化；哈希证明仍会显示两边像素不同。',
    )
  }

  return {
    verdict,
    tolerance,
    compareAlpha,
    totalPixels: total,
    protectedPixels,
    editablePixels: total - protectedPixels,
    unchangedPixels: protectedPixels - exactChangedPixels,
    changedPixels,
    exactChangedPixels,
    changedRatio: protectedPixels === 0 ? 0 : changedPixels / protectedPixels,
    exactChangedRatio: protectedPixels === 0 ? 0 : exactChangedPixels / protectedPixels,
    maxDelta,
    meanDelta: protectedPixels === 0 ? 0 : sumDelta / protectedPixels,
    perChannelMax,
    region: maskMaxX >= 0
      ? { x: maskMinX, y: maskMinY, w: maskMaxX - maskMinX + 1, h: maskMaxY - maskMinY + 1 }
      : null,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    histogram,
    samples,
    warnings,
  }
}

const SAMPLE_LIMIT = 20

function offerSample(list, sample) {
  if (list.length < SAMPLE_LIMIT) {
    list.push(sample)
    if (list.length === SAMPLE_LIMIT) list.sort((a, b) => b.delta - a.delta)
    return
  }
  const last = list[list.length - 1]
  if (sample.delta <= last.delta) return
  list[list.length - 1] = sample
  for (let i = list.length - 1; i > 0 && list[i].delta > list[i - 1].delta; i -= 1) {
    const swap = list[i]
    list[i] = list[i - 1]
    list[i - 1] = swap
  }
}

/**
 * The max channel delta at one pixel. Exported so the heatmap and the tests can
 * use exactly the same definition as the comparison.
 */
export function pixelDelta(original, generated, index, ignoreAlpha) {
  const p = index * 4
  let delta = Math.abs(original.rgba[p] - generated.rgba[p])
  const dg = Math.abs(original.rgba[p + 1] - generated.rgba[p + 1])
  const db = Math.abs(original.rgba[p + 2] - generated.rgba[p + 2])
  const da = ignoreAlpha === true ? 0 : Math.abs(original.rgba[p + 3] - generated.rgba[p + 3])
  if (dg > delta) delta = dg
  if (db > delta) delta = db
  if (da > delta) delta = da
  return delta
}
