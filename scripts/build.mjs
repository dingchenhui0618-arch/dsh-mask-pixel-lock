#!/usr/bin/env node
// Dependency-free build.
//
// The host half is plain ESM whose only imports are node: builtins and its own
// sibling modules, so copying src/ into lib/ is a complete build — no bundler,
// no devDependency that can fail to install.
//
// The client half is CommonJS loaded through window.__ModuleLoader__ with a
// harness-provided require(), so it must carry no relative require of its own.
// The one relative require (the stylesheet) is inlined below, and the build
// fails loudly if that require disappears or if another relative import sneaks
// in.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'core'), { recursive: true })

// host.js becomes index.js; the core modules keep their names and layout.
await copyFile(join(root, 'src', 'host.js'), join(out, 'index.js'))
for (const file of await readdir(join(root, 'src', 'core'))) {
  if (!file.endsWith('.js')) continue
  await copyFile(join(root, 'src', 'core', file), join(out, 'core', file))
}

const cssModule = await import(pathToFileURL(join(root, 'src', 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs did not export a non-empty CSS string')
}

const clientSource = await readFile(join(root, 'src', 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./client-css.cjs — update scripts/build.mjs')
}

const requires = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
const unexpected = requires.filter((id) => id !== 'react' && id !== './client-css.cjs')
if (unexpected.length > 0) {
  throw new Error('src/client.cjs has requires the harness bundle cannot resolve: ' + unexpected.join(', '))
}

const bundle = wrapClient(clientSource.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// Compile the client bundle and import the host module: a broken build fails
// here rather than in the browser, where the error is much harder to read.
new Function(bundle)
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('invalid host plugin export: expected name "' + pkg.name + '" and an apply() function')
}

const version = await import(pathToFileURL(join(out, 'core', 'version.js')).href)
if (version.TOOL_VERSION !== pkg.version) {
  throw new Error('src/core/version.js (' + version.TOOL_VERSION + ') does not match package.json (' + pkg.version + ')')
}

console.log('Built ' + pkg.name + ' ' + pkg.version + ': lib/index.js, lib/core/*.js and lib/client.js')
