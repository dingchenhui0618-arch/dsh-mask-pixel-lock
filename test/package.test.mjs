// Packaging checks: zero runtime dependencies, a build that matches src/, and
// the two halves the harness loads.

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the package declares no runtime or dev dependencies', () => {
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.name, 'dsh-mask-pixel-lock')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.license, 'MIT')
})

test('the bundle manifest and client inject are declared', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const injected of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-layout']) {
    assert.ok(pkg.dsh.client.inject.includes(injected), injected)
  }
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: dsh-mask-pixel-lock/)
  assert.match(patch, /name: dsh-mask-pixel-lock/)
})

test('lib/ is a current copy of src/', () => {
  assert.equal(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8'), readFileSync(join(ROOT, 'src', 'host.js'), 'utf8'))
  const sourceFiles = readdirSync(join(ROOT, 'src', 'core')).filter((file) => file.endsWith('.js')).sort()
  const builtFiles = readdirSync(join(ROOT, 'lib', 'core')).filter((file) => file.endsWith('.js')).sort()
  assert.deepEqual(builtFiles, sourceFiles)
  for (const file of sourceFiles) {
    assert.equal(
      readFileSync(join(ROOT, 'lib', 'core', file), 'utf8'),
      readFileSync(join(ROOT, 'src', 'core', file), 'utf8'),
      file,
    )
  }
})

test('the built client bundle is a self-contained module-loader factory', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
  assert.match(bundle, /id: "dsh-mask-pixel-lock"/)
  assert.doesNotMatch(bundle, /require\((['"])\.\//)
  assert.doesNotThrow(() => new Function(bundle))
})

test('the built host half exports the harness plugin contract', async () => {
  const host = await import('../lib/index.js')
  assert.equal(host.name, 'dsh-mask-pixel-lock')
  assert.equal(typeof host.apply, 'function')
  const version = await import('../lib/core/version.js')
  assert.equal(version.TOOL_VERSION, pkg.version)
})

test('display metadata and icon are exported without activating the plugin', () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(ROOT, 'locale', locale + '.json'), 'utf8'))
    assert.equal(typeof meta.meta.title, 'string')
    assert.ok(meta.meta.title.length > 0)
    assert.ok(meta.meta.description.length > 20)
  }
  const icon = readFileSync(join(ROOT, 'icon.svg'), 'utf8')
  assert.match(icon, /^<svg[^>]+viewBox="0 0 64 64"/)
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const entry of ['icon.svg', 'locale/*.json']) {
    assert.ok(pkg.files.includes(entry), entry)
  }
})

test('the CLI is declared as a bin and is executable source', () => {
  assert.equal(pkg.bin['mask-pixel-lock'], './bin/mask-pixel-lock.mjs')
  const bin = readFileSync(join(ROOT, 'bin', 'mask-pixel-lock.mjs'), 'utf8')
  assert.match(bin, /^#!\/usr\/bin\/env node/)
  assert.match(bin, /process\.exitCode = 3/)
})
