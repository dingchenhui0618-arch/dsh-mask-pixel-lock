// Heatmap renderer.
//
// The heatmap is evidence, not decoration, so its colours have fixed meaning:
//
//   near-black      protected pixel, unchanged
//   dark blue-gray  editable (masked) pixel — deliberately dim, it is not evidence
//   amber → red     protected pixel that changed; hotter = larger channel delta
//
// A one-level change must remain visible, therefore the smallest non-zero
// delta already starts at full amber rather than scaling the whole ramp down.

import { encodePng } from './png.js'

const UNCHANGED = [12, 14, 18, 255]
const EDITABLE = [22, 30, 42, 255]

export function renderHeatmap(original, generated, lock, options) {
  const settings = options || {}
  const ignoreAlpha = settings.ignoreAlpha === true
  const width = original.width
  const height = original.height
  if (generated.width !== width || generated.height !== height) {
    throw new Error('heatmap needs images of identical dimensions')
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4
    if (lock[i] !== 1) {
      rgba[p] = EDITABLE[0]
      rgba[p + 1] = EDITABLE[1]
      rgba[p + 2] = EDITABLE[2]
      rgba[p + 3] = EDITABLE[3]
      continue
    }

    const delta = channelDelta(original.rgba, generated.rgba, p, ignoreAlpha)
    if (delta === 0) {
      rgba[p] = UNCHANGED[0]
      rgba[p + 1] = UNCHANGED[1]
      rgba[p + 2] = UNCHANGED[2]
      rgba[p + 3] = UNCHANGED[3]
    } else {
      const t = Math.min(1, delta / 128)
      rgba[p] = 255
      rgba[p + 1] = Math.round(214 * (1 - t))
      rgba[p + 2] = delta <= 2 ? 32 : 0
      rgba[p + 3] = 255
    }
  }
  return encodePng(width, height, rgba)
}

function channelDelta(a, b, p, ignoreAlpha) {
  let delta = Math.abs(a[p] - b[p])
  const dg = Math.abs(a[p + 1] - b[p + 1])
  const db = Math.abs(a[p + 2] - b[p + 2])
  const da = ignoreAlpha ? 0 : Math.abs(a[p + 3] - b[p + 3])
  if (dg > delta) delta = dg
  if (db > delta) delta = db
  if (da > delta) delta = da
  return delta
}
