// End-to-end verifier tests: real PNG files in, report bundle out.

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { InputError } from '../src/core/compare.js'
import { decodePng, encodePng } from '../src/core/png.js'
import { buildSummary, toToolValue } from '../src/core/report.js'
import { TOOL_VERSION } from '../src/core/version.js'
import { verifyFiles } from '../src/core/verify.js'

const WIDTH = 8
const HEIGHT = 6

function background(x, y) {
  return [(x * 21 + y * 7) % 256, (y * 37 + 40) % 256, (x * 11 + y * 19 + 90) % 256, 255]
}

function editable(x, y) {
  return x >= 2 && x <= 4 && y >= 1 && y <= 3
}

function makeImage(change) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const color = background(x, y)
      const p = (y * WIDTH + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        rgba[p + channel] = typeof change === 'function' ? change(x, y, channel, color) : color[channel]
      }
    }
  }
  return encodePng(WIDTH, HEIGHT, rgba)
}

function makeMask(marked) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = marked(x, y) ? 255 : 0
      const p = (y * WIDTH + x) * 4
      rgba[p] = value
      rgba[p + 1] = value
      rgba[p + 2] = value
      rgba[p + 3] = 255
    }
  }
  return encodePng(WIDTH, HEIGHT, rgba)
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mask-pixel-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(dir, name, buffer) {
  const path = join(dir, name)
  writeFileSync(path, buffer)
  return path
}

function scene(dir, options) {
  const settings = options || {}
  const original = write(dir, 'before.png', makeImage((x, y, channel, color) => (editable(x, y) ? (color[channel] + 30) % 256 : color[channel])))
  const generated = write(dir, 'after.png', makeImage((x, y, channel, color) => {
    if (editable(x, y)) return (color[channel] + 70) % 256
    if (settings.changeProtected !== undefined && settings.changeProtected(x, y)) {
      return Math.min(255, color[channel] + (settings.amount === undefined ? 1 : settings.amount))
    }
    return color[channel]
  }))
  const mask = write(dir, 'mask.png', makeMask(settings.marked || editable))
  return { original, generated, mask }
}

test('a background-preserving edit passes and writes all three artifacts', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const outDir = join(dir, 'out')
  const report = verifyFiles(Object.assign({ outDir, label: '主体缩小，背景不动' }, files))

  assert.equal(report.verdict, 'pass')
  assert.equal(report.reason, null)
  assert.equal(report.label, '主体缩小，背景不动')
  assert.equal(report.comparison.protectedPixels, WIDTH * HEIGHT - 9)
  assert.equal(report.comparison.changedPixels, 0)
  assert.equal(report.proof.protectedPixels.equal, true)
  assert.equal(report.proof.protectedPixels.count, WIDTH * HEIGHT - 9)
  assert.match(report.id, /^[a-f0-9]{16}$/)
  assert.equal(report.tool.version, TOOL_VERSION)

  const heatmapPath = resolve(report.outputs.heatmap)
  const jsonPath = resolve(report.outputs.reportJson)
  const htmlPath = resolve(report.outputs.reportHtml)
  assert.ok(existsSync(heatmapPath))
  assert.equal(report.outputs.dir, outDir.split('\\').join('/'))

  const heatmap = decodePng(readFileSync(heatmapPath))
  assert.equal(heatmap.width, WIDTH)
  assert.equal(heatmap.height, HEIGHT)
  const protectedPixel = (0 * WIDTH + 0) * 4
  assert.deepEqual(Array.from(heatmap.rgba.subarray(protectedPixel, protectedPixel + 4)), [12, 14, 18, 255])
  const editablePixel = (1 * WIDTH + 2) * 4
  assert.deepEqual(Array.from(heatmap.rgba.subarray(editablePixel, editablePixel + 4)), [22, 30, 42, 255])

  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.equal(parsed.verdict, 'pass')
  assert.equal(parsed.schema, 'dsh-mask-pixel-lock/report@1')
  assert.equal(parsed.proof.proofDigest, report.proof.proofDigest)

  const html = readFileSync(htmlPath, 'utf8')
  assert.match(html, /PASS/)
  assert.match(html, /逐字节相同，哈希证明相等/)
  assert.match(html, /data:image\/png;base64,/)
  assert.match(html, /主体缩小，背景不动/)

  const summary = buildSummary(report)
  assert.match(summary, /^MASK_PIXEL_LOCK=PASS/)
  assert.match(summary, /像素证明 相等/)

  const value = toToolValue(report)
  assert.equal(value.ok, true)
  assert.equal(value.comparison.changedPixels, 0)
  assert.equal(value.comparison.histogram, undefined)
})

test('one changed protected pixel fails with sample coordinates and a hot heatmap pixel', (t) => {
  const dir = workspace(t)
  const files = scene(dir, { changeProtected: (x, y) => x === 0 && y === 0, amount: 1 })
  const report = verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files))

  assert.equal(report.verdict, 'fail')
  assert.equal(report.reason, 'protected-pixels-changed')
  assert.equal(report.comparison.changedPixels, 1)
  assert.equal(report.comparison.exactChangedPixels, 1)
  assert.equal(report.comparison.maxDelta, 1)
  assert.deepEqual(report.comparison.bbox, { x: 0, y: 0, w: 1, h: 1 })
  assert.equal(report.comparison.samples[0].x, 0)
  assert.equal(report.proof.protectedPixels.equal, false)

  const heatmap = decodePng(readFileSync(resolve(report.outputs.heatmap)))
  assert.deepEqual(Array.from(heatmap.rgba.subarray(0, 4)), [255, 212, 32, 255])

  const html = readFileSync(resolve(report.outputs.reportHtml), 'utf8')
  assert.match(html, /FAIL/)
  assert.match(html, /\(0, 0\)/)

  const summary = buildSummary(report)
  assert.match(summary, /^MASK_PIXEL_LOCK=FAIL/)
  assert.match(summary, /变化 1/)
})

test('tolerance admits a small delta but the pixel proof still reports inequality', (t) => {
  const dir = workspace(t)
  const files = scene(dir, { changeProtected: (x, y) => x === 7 && y === 5, amount: 2 })

  const tolerant = verifyFiles(Object.assign({ outDir: join(dir, 'tolerant'), tolerance: 2 }, files))
  assert.equal(tolerant.verdict, 'pass')
  assert.equal(tolerant.comparison.changedPixels, 0)
  assert.equal(tolerant.comparison.exactChangedPixels, 1)
  assert.equal(tolerant.proof.protectedPixels.equal, false)
  assert.match(tolerant.warnings.join('\n'), /容差为 2/)

  const strict = verifyFiles(Object.assign({ outDir: join(dir, 'strict'), tolerance: 1 }, files))
  assert.equal(strict.verdict, 'fail')
  assert.equal(strict.comparison.changedPixels, 1)
})

test('tolerance changes the policy digest but not the pixel digest', (t) => {
  const dir = workspace(t)
  const files = scene(dir, { changeProtected: (x, y) => x === 7 && y === 5, amount: 2 })
  const a = verifyFiles(Object.assign({ outDir: join(dir, 'a'), tolerance: 0 }, files))
  const b = verifyFiles(Object.assign({ outDir: join(dir, 'b'), tolerance: 2 }, files))
  assert.equal(a.proof.protectedPixels.original, b.proof.protectedPixels.original)
  assert.notEqual(a.proof.proofDigest, b.proof.proofDigest)
})

test('the same run twice produces the same proof digest', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const a = verifyFiles(Object.assign({ outDir: join(dir, 'a') }, files))
  const b = verifyFiles(Object.assign({ outDir: join(dir, 'b') }, files))
  assert.equal(a.proof.proofDigest, b.proof.proofDigest)
  assert.equal(a.proof.protectedPixels.original, b.proof.protectedPixels.original)
})

test('different editable pixels do not change the protected-pixel digest', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const other = write(dir, 'after-2.png', makeImage((x, y, channel, color) => (editable(x, y) ? (color[channel] + 120) % 256 : color[channel])))
  const a = verifyFiles(Object.assign({ outDir: join(dir, 'a') }, files))
  const b = verifyFiles(Object.assign({ outDir: join(dir, 'b') }, files, { generated: other }))
  assert.equal(a.proof.protectedPixels.original, b.proof.protectedPixels.original)
  assert.equal(a.proof.protectedPixels.generated, b.proof.protectedPixels.generated)
  assert.notEqual(a.proof.files.generated, b.proof.files.generated)
  assert.notEqual(a.proof.proofDigest, b.proof.proofDigest)
})

test('an all-editable mask is reported as EMPTY and exits through the empty path', (t) => {
  const dir = workspace(t)
  const files = scene(dir, { marked: () => true })
  const report = verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files))
  assert.equal(report.verdict, 'empty')
  assert.equal(report.reason, 'no-protected-pixels')
  assert.equal(report.comparison.protectedPixels, 0)
  assert.match(report.warnings.join('\n'), /没有可证明的对象/)
  assert.match(buildSummary(report), /^MASK_PIXEL_LOCK=EMPTY/)
})

test('dimension changes produce a FAIL report rather than a crash', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const wide = write(dir, 'wide.png', encodePng(WIDTH + 1, HEIGHT, new Uint8Array((WIDTH + 1) * HEIGHT * 4).fill(255)))
  const report = verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files, { generated: wide }))
  assert.equal(report.verdict, 'fail')
  assert.equal(report.reason, 'dimensions-differ')
  assert.equal(report.comparison, null)
  assert.equal(report.proof, null)
  assert.equal(report.outputs.heatmap, null)
  assert.ok(existsSync(resolve(report.outputs.reportHtml)))
  assert.match(readFileSync(resolve(report.outputs.reportHtml), 'utf8'), /尺寸/)
})

test('a mask with the wrong dimensions is an input error', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const small = write(dir, 'small-mask.png', encodePng(2, 2, new Uint8Array(16).fill(255)))
  assert.throws(
    () => verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files, { mask: small })),
    (error) => error instanceof InputError && error.code === 'MASK_DIMENSION',
  )
})

test('missing files, non-PNG files and missing arguments are input errors', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  assert.throws(
    () => verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files, { original: join(dir, 'nope.png') })),
    (error) => error.code === 'READ_FAILED',
  )
  const text = write(dir, 'note.png', Buffer.from('definitely not a png'))
  assert.throws(
    () => verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files, { mask: text })),
    (error) => error.code === 'NOT_PNG',
  )
  assert.throws(() => verifyFiles({ original: files.original }), (error) => error.code === 'MISSING_PATH')
})

test('alpha-only changes fail by default and pass when alpha is ignored', (t) => {
  const dir = workspace(t)
  const original = write(dir, 'before.png', makeImage((x, y, channel, color) => color[channel]))
  const generated = write(dir, 'after.png', makeImage((x, y, channel, color) => (channel === 3 && x === 0 && y === 0 ? 128 : color[channel])))
  const mask = write(dir, 'mask.png', makeMask(editable))

  const strict = verifyFiles({ original, generated, mask, outDir: join(dir, 'strict') })
  assert.equal(strict.verdict, 'fail')
  assert.equal(strict.comparison.maxDelta, 127)

  const ignored = verifyFiles({ original, generated, mask, outDir: join(dir, 'ignored'), ignoreAlpha: true })
  assert.equal(ignored.verdict, 'pass')
  assert.equal(ignored.proof.protectedPixels.channels, 3)
  assert.equal(ignored.proof.protectedPixels.equal, true)
  assert.equal(ignored.policy.ignoreAlpha, true)
})

test('lock mode protects the painted area instead of the unpainted area', (t) => {
  const dir = workspace(t)
  const original = write(dir, 'lock-before.png', makeImage((x, y, channel, color) => color[channel]))
  const mask = write(dir, 'lock-mask.png', makeMask(editable))
  const outside = write(dir, 'lock-outside.png', makeImage((x, y, channel, color) =>
    x === 0 && y === 0 ? Math.min(255, color[channel] + 9) : color[channel]))
  const inside = write(dir, 'lock-inside.png', makeImage((x, y, channel, color) =>
    editable(x, y) ? (color[channel] + 40) % 256 : color[channel]))

  // In lock mode the painted rectangle is the protected area, so a change
  // outside it passes and a change inside it fails.
  const passed = verifyFiles({ original, generated: outside, mask, outDir: join(dir, 'passed'), maskMode: 'lock' })
  assert.equal(passed.verdict, 'pass')
  assert.equal(passed.comparison.protectedPixels, 9)

  const failed = verifyFiles({ original, generated: inside, mask, outDir: join(dir, 'failed'), maskMode: 'lock' })
  assert.equal(failed.verdict, 'fail')
  assert.equal(failed.comparison.changedPixels, 9)
})

test('an existing output directory is never overwritten', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const outDir = join(dir, 'out')
  const first = verifyFiles(Object.assign({ outDir }, files))
  const second = verifyFiles(Object.assign({ outDir }, files))
  assert.equal(first.outputs.dir, outDir.split('\\').join('/'))
  assert.equal(second.outputs.dir, (outDir + '-2').split('\\').join('/'))
})

test('the report contains no image payloads in JSON, only paths and hashes', (t) => {
  const dir = workspace(t)
  const files = scene(dir)
  const report = verifyFiles(Object.assign({ outDir: join(dir, 'out') }, files))
  const text = readFileSync(resolve(report.outputs.reportJson), 'utf8')
  assert.ok(text.length < 200 * 1024, 'report.json stays small')
  assert.doesNotMatch(text, /base64/)
  assert.match(text, /"proofDigest"/)
})
