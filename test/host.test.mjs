// Host-half tests. They drive the real apply() against a stub ctx: the tool,
// the HTTP route, the record ring and the unload path all run without a
// harness process.

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host.js'
import { encodePng } from '../src/core/png.js'

const W = 4
const H = 3

function png(fn) {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const color = fn(x, y)
      const p = (y * W + x) * 4
      rgba.set(color, p)
      rgba[p + 3] = 255
    }
  }
  return encodePng(W, H, rgba)
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mask-pixel-lock-host-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function scene(dir, options) {
  const settings = options || {}
  const before = png((x, y) => [x * 20, y * 30, 100])
  const after = png((x, y) => {
    if (x === 1 && y === 1) return [200, 10, 10]
    if (settings.changeProtected && x === 0 && y === 0) return [1, 2, 3]
    return [x * 20, y * 30, 100]
  })
  const mask = png((x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0]))
  return {
    original: join(dir, 'before.png'),
    generated: join(dir, 'after.png'),
    mask: join(dir, 'mask.png'),
    write() {
      writeFileSync(this.original, before)
      writeFileSync(this.generated, after)
      writeFileSync(this.mask, mask)
      return this
    },
  }
}

function setup(options) {
  const settings = options || {}
  const tools = []
  const routes = []
  const disposers = []
  const services = {
    tools: {
      register(definition) {
        tools.push(definition)
        return function () {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    webServer: {
      register(route) {
        if (settings.registerThrows === true) throw new Error('webServer.register is unavailable')
        routes.push(route)
        return function () {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  const ctx = {
    get(name) {
      if (settings.hideTools === true && name === 'tools') return undefined
      if (settings.hideWebServer === true && name === 'webServer') return undefined
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }
  apply(ctx, {})
  return {
    tools,
    routes,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    async callTool(args) {
      assert.equal(tools.length, 1, 'the tool is registered')
      return tools[0].execute(args, { callId: 'c1', name: 'mask_pixel_lock_verify', arguments: args, signal: { aborted: false } })
    },
    async route(method, url, body) {
      assert.equal(routes.length, 1, 'the route is registered')
      const res = {
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
        end(data) {
          this.body = Buffer.isBuffer(data) ? data : Buffer.from(String(data === undefined ? '' : data))
        },
      }
      const req = {
        method,
        url,
        on(event, callback) {
          if (event === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body)))
          if (event === 'end') callback()
          return this
        },
      }
      await routes[0].handler(req, res)
      return res
    },
  }
}

test('registers one tool with the mask-pixel-lock contract', () => {
  const h = setup()
  const tool = h.tools[0]
  assert.equal(tool.name, 'mask_pixel_lock_verify')
  assert.match(tool.description, /蒙版/)
  assert.deepEqual(tool.parameters.required, ['original', 'generated', 'mask'])
  assert.equal(tool.parameters.properties.maskMode.enum.join(','), 'edit,lock')
  assert.equal(typeof tool.output.render, 'function')
  const rendered = tool.output.render({}, { summary: 'MASK_PIXEL_LOCK=PASS' })
  assert.deepEqual(rendered, [{ type: 'text', text: 'MASK_PIXEL_LOCK=PASS' }])
})

test('the tool returns a compact verdict and records it in the state route', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  const value = await h.callTool({ original: files.original, generated: files.generated, mask: files.mask, outputDir: join(dir, 'out') })
  assert.equal(value.ok, true)
  assert.equal(value.verdict, 'pass')
  assert.match(value.summary, /^MASK_PIXEL_LOCK=PASS/)
  assert.equal(value.comparison.protectedPixels, W * H - 1)
  assert.equal(value.comparison.histogram, undefined)
  assert.equal(value.outputs.dir, join(dir, 'out').split('\\').join('/'))

  const state = JSON.parse((await h.route('GET', '/dsh-mask-pixel-lock/state')).body.toString())
  assert.equal(state.stats.runs, 1)
  assert.equal(state.stats.pass, 1)
  assert.equal(state.records.length, 1)
  assert.equal(state.latest.verdict, 'pass')
  assert.equal(state.latest.proofDigest, value.proof.proofDigest)
  assert.match(state.latest.heatmapUrl, new RegExp('/heatmap/' + state.latest.id + '$'))
  assert.match(state.latest.reportUrl, new RegExp('/report/' + state.latest.id + '$'))
})

test('the tool reports a changed protected pixel as FAIL', async (t) => {
  const dir = workspace(t)
  const files = scene(dir, { changeProtected: true }).write()
  const h = setup()
  const value = await h.callTool({ original: files.original, generated: files.generated, mask: files.mask, outputDir: join(dir, 'out') })
  assert.equal(value.verdict, 'fail')
  assert.equal(value.ok, false)
  assert.equal(value.comparison.changedPixels, 1)
  const state = JSON.parse((await h.route('GET', '/dsh-mask-pixel-lock/state')).body.toString())
  assert.equal(state.stats.fail, 1)
})

test('a bad tool argument rejects and does not create a record', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  await assert.rejects(
    h.callTool({ original: files.original, generated: join(dir, 'missing.png'), mask: files.mask }),
    (error) => error.code === 'READ_FAILED',
  )
  const state = JSON.parse((await h.route('GET', '/dsh-mask-pixel-lock/state')).body.toString())
  assert.equal(state.stats.runs, 0)
  assert.equal(state.records.length, 0)
})

test('the verify route runs a check and serves heatmap, report and JSON by id', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  const response = await h.route('POST', '/dsh-mask-pixel-lock/verify', {
    original: files.original,
    generated: files.generated,
    mask: files.mask,
    outputDir: join(dir, 'out'),
    label: 'route run',
  })
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body.toString())
  assert.equal(payload.ok, true)
  assert.equal(payload.record.verdict, 'pass')
  assert.equal(payload.state.stats.runs, 1)

  const heatmap = await h.route('GET', payload.record.heatmapUrl)
  assert.equal(heatmap.statusCode, 200)
  assert.equal(heatmap.headers['content-type'], 'image/png')
  assert.deepEqual(Array.from(heatmap.body.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const report = await h.route('GET', payload.record.reportUrl)
  assert.equal(report.statusCode, 200)
  assert.match(report.headers['content-type'], /text\/html/)
  assert.match(report.body.toString(), /PASS/)
  assert.match(report.body.toString(), /route run/)

  const json = await h.route('GET', payload.record.jsonUrl)
  assert.equal(json.statusCode, 200)
  assert.equal(JSON.parse(json.body.toString()).verdict, 'pass')
})

test('the verify route returns a structured 400 for input errors', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  const response = await h.route('POST', '/dsh-mask-pixel-lock/verify', {
    original: files.original,
    generated: files.generated,
    mask: join(dir, 'nope.png'),
  })
  assert.equal(response.statusCode, 400)
  const payload = JSON.parse(response.body.toString())
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'READ_FAILED')
  assert.equal(payload.state.stats.errors, 1)
})

test('clear empties records and counters', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  await h.callTool({ original: files.original, generated: files.generated, mask: files.mask, outputDir: join(dir, 'out') })
  const cleared = await h.route('POST', '/dsh-mask-pixel-lock/clear', {})
  assert.equal(cleared.statusCode, 200)
  const state = JSON.parse(cleared.body.toString())
  assert.equal(state.state.records.length, 0)
  assert.equal(state.state.stats.runs, 0)
})

test('unknown methods and unknown record ids are rejected', async (t) => {
  const h = setup()
  const state = await h.route('GET', '/dsh-mask-pixel-lock')
  assert.equal(state.statusCode, 200)
  const wrong = await h.route('GET', '/dsh-mask-pixel-lock/nope')
  assert.equal(wrong.statusCode, 405)
  const traversal = await h.route('GET', '/dsh-mask-pixel-lock/heatmap/../../etc/passwd')
  assert.equal(traversal.statusCode, 404)
})

test('a web server that refuses the route leaves the tool working', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup({ registerThrows: true })
  assert.equal(h.routes.length, 0)
  const value = await h.callTool({ original: files.original, generated: files.generated, mask: files.mask, outputDir: join(dir, 'out') })
  assert.equal(value.verdict, 'pass')
})

test('a host without a tools service still serves the panel route', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup({ hideTools: true })
  assert.equal(h.tools.length, 0)
  const response = await h.route('POST', '/dsh-mask-pixel-lock/verify', {
    original: files.original,
    generated: files.generated,
    mask: files.mask,
    outputDir: join(dir, 'out'),
  })
  assert.equal(response.statusCode, 200)
})

test('unloading disposes the tool, the route and the record ring', async (t) => {
  const dir = workspace(t)
  const files = scene(dir).write()
  const h = setup()
  await h.callTool({ original: files.original, generated: files.generated, mask: files.mask, outputDir: join(dir, 'out') })
  assert.equal(h.tools.length, 1)
  assert.equal(h.routes.length, 1)
  h.dispose()
  assert.equal(h.tools.length, 0)
  assert.equal(h.routes.length, 0)
})
