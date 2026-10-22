// CLI contract tests: exit codes, the machine-readable first line and --json.

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { encodePng } from '../src/core/png.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'mask-pixel-lock.mjs')
const W = 4
const H = 3

function png(fn) {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const color = fn(x, y)
      const p = (y * W + x) * 4
      rgba[p] = color[0]
      rgba[p + 1] = color[1]
      rgba[p + 2] = color[2]
      rgba[p + 3] = 255
    }
  }
  return encodePng(W, H, rgba)
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mask-pixel-lock-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = join(dir, 'before.png')
  const generated = join(dir, 'after.png')
  const mask = join(dir, 'mask.png')
  const emptyMask = join(dir, 'empty-mask.png')
  writeFileSync(original, png((x, y) => [x * 30, y * 40, 10]))
  writeFileSync(generated, png((x, y) => (x === 1 && y === 1 ? [9, 9, 9] : [x * 30, y * 40, 10])))
  writeFileSync(mask, png((x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0])))
  writeFileSync(emptyMask, png(() => [255, 255, 255]))
  return { dir, original, generated, mask, emptyMask }
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' })
}

test('CLI exits 0 on PASS and prints the machine-readable first line', (t) => {
  const files = fixture(t)
  const result = run([
    '--original', files.original,
    '--generated', files.generated,
    '--mask', files.mask,
    '--out', join(files.dir, 'pass'),
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^MASK_PIXEL_LOCK=PASS/)
  assert.match(result.stdout, /像素证明 相等/)
  assert.ok(result.stdout.includes(join(files.dir, 'pass').split('\\').join('/')), 'the --out directory is used')
})

test('CLI exits 1 on FAIL', (t) => {
  const files = fixture(t)
  const changed = join(files.dir, 'changed.png')
  const bytes = png((x, y) => (x === 0 && y === 0 ? [1, 2, 3] : [x * 30, y * 40, 10]))
  writeFileSync(changed, bytes)
  const result = run([
    '--original', files.original,
    '--generated', changed,
    '--mask', files.mask,
    '--out', join(files.dir, 'fail'),
  ])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /^MASK_PIXEL_LOCK=FAIL/)
})

test('CLI exits 3 when the mask leaves nothing protected', (t) => {
  const files = fixture(t)
  const result = run([
    '--original', files.original,
    '--generated', files.generated,
    '--mask', files.emptyMask,
    '--out', join(files.dir, 'empty'),
  ])
  assert.equal(result.status, 3, result.stderr)
  assert.match(result.stdout, /^MASK_PIXEL_LOCK=EMPTY/)
})

test('CLI exits 2 on bad input and writes the reason to stderr', (t) => {
  const files = fixture(t)
  const result = run([
    '--original', files.original,
    '--generated', join(files.dir, 'missing.png'),
    '--mask', files.mask,
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /生成图文件不存在/)
})

test('CLI --json prints a parseable report and no summary text', (t) => {
  const files = fixture(t)
  const result = run([
    '--original', files.original,
    '--generated', files.generated,
    '--mask', files.mask,
    '--out', join(files.dir, 'json'),
    '--tolerance', '2',
    '--label', 'json run',
    '--json',
  ])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.verdict, 'pass')
  assert.equal(report.label, 'json run')
  assert.equal(report.policy.tolerance, 2)
  assert.equal(report.schema, 'dsh-mask-pixel-lock/report@1')
})

test('CLI help and version are successful', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mask-pixel-lock --original/)
  const version = run(['--version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/)
})
