// Client-half tests: load the real CommonJS module with a harness-shaped
// require(), then check registration, style injection and teardown without a
// browser or React DOM.

import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const require = createRequire(import.meta.url)
const CSS = require(join(ROOT, 'src', 'client-css.cjs'))
const SOURCE = readFileSync(join(ROOT, 'src', 'client.cjs'), 'utf8')

function fakeReact() {
  return {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(value) { return [value, function () {}] },
    useEffect() {},
  }
}

function loadClient(React, documentRef) {
  const module = { exports: {} }
  const requireFn = function (id) {
    if (id === 'react') return React
    if (id === './client-css.cjs') return CSS
    throw new Error('unexpected require: ' + id)
  }
  new Function('require', 'module', 'exports', 'document', SOURCE)(requireFn, module, module.exports, documentRef)
  return module.exports
}

function fakeDocument() {
  const appended = []
  const documentRef = {
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        textContent: '',
        remove() {
          const index = appended.indexOf(this)
          if (index >= 0) appended.splice(index, 1)
        },
      }
    },
    head: {
      appendChild(node) { appended.push(node) },
    },
  }
  return { documentRef, appended }
}

function stubCtx(options) {
  const settings = options || {}
  const effects = []
  const registrations = []
  return {
    effects,
    registrations,
    ctx: {
      effect(fn) {
        const dispose = fn()
        const wrapped = typeof dispose === 'function' ? dispose : function () {}
        effects.push(wrapped)
        return wrapped
      },
      slots: {
        inject(slot, fn) {
          assert.equal(slot, 'conversation.view')
          const dispose = fn()
          effects.push(typeof dispose === 'function' ? dispose : function () {})
        },
        register(registration, component) {
          if (settings.registerThrows === true) throw new Error('slot contract changed')
          registrations.push({ registration, component })
          return function () {
            const index = registrations.indexOf(registrations[registrations.length - 1])
            if (index >= 0) registrations.splice(index, 1)
          }
        },
      },
    },
  }
}

test('the client module exports the harness contract', () => {
  const client = loadClient(fakeReact(), fakeDocument().documentRef)
  assert.equal(client.name, 'dsh-mask-pixel-lock')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
})

test('apply injects the stylesheet and registers the 像素锁 conversation view', () => {
  const { documentRef, appended } = fakeDocument()
  const client = loadClient(fakeReact(), documentRef)
  const stub = stubCtx()
  client.apply(stub.ctx)

  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.plugin, 'dsh-mask-pixel-lock')
  assert.match(appended[0].textContent, /\.mpl-root/)
  assert.match(appended[0].textContent, /\.mpl-hero-pass/)
  assert.equal(stub.registrations.length, 1)
  assert.deepEqual(stub.registrations[0].registration, {
    name: 'conversation.view',
    id: 'mask-pixel-lock',
    order: 31,
    label: '像素锁',
  })
  assert.equal(typeof stub.registrations[0].component, 'function')
})

test('unloading removes the style and the slot registration', () => {
  const { documentRef, appended } = fakeDocument()
  const client = loadClient(fakeReact(), documentRef)
  const stub = stubCtx()
  client.apply(stub.ctx)
  assert.equal(appended.length, 1)
  assert.equal(stub.registrations.length, 1)

  for (const dispose of stub.effects.splice(0)) dispose()
  assert.equal(appended.length, 0)
  assert.equal(stub.registrations.length, 0)
})

test('a changed slot contract degrades the panel instead of aborting the client', () => {
  const { documentRef, appended } = fakeDocument()
  const client = loadClient(fakeReact(), documentRef)
  const stub = stubCtx({ registerThrows: true })
  const originalWarn = console.warn
  console.warn = function () {}
  try {
    assert.doesNotThrow(() => client.apply(stub.ctx))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(appended.length, 1)
  assert.equal(stub.registrations.length, 0)
})

test('the component tree mentions the three inputs and the verdict vocabulary', () => {
  const source = readFileSync(join(ROOT, 'src', 'client.cjs'), 'utf8')
  for (const phrase of ['原图 PNG', '生成图 PNG', '蒙版 PNG', '像素证明', '差异热力图', 'PASS', 'EMPTY']) {
    assert.ok(source.includes(phrase), 'client source mentions ' + phrase)
  }
})
