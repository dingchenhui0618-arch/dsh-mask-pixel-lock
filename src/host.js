// Host half of dsh-mask-pixel-lock.
//
// Two surfaces sit on the same verification core:
//
//   * the `mask_pixel_lock_verify` tool, so an agent can prove a local edit
//     before shipping it;
//   * a `/dsh-mask-pixel-lock` route plus the conversation-view panel, so a
//     person can run the same check and open the evidence.
//
// Both surfaces only read local PNGs and write into an output directory. The
// route never serves an arbitrary path: media is looked up by record id.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { InputError } from './core/compare.js'
import { buildSummary, toToolValue, verifyFiles } from './core/verify.js'
import { TOOL_VERSION } from './core/version.js'

export const name = 'dsh-mask-pixel-lock'

const API = '/dsh-mask-pixel-lock'
const MAX_RECORDS = 40

export function apply(ctx, config) {
  const records = []
  const stats = { runs: 0, pass: 0, fail: 0, empty: 0, errors: 0 }
  let sequence = 0

  function remember(report) {
    sequence += 1
    const id = recordId(sequence, report.id)
    const record = {
      id,
      at: report.createdAt,
      verdict: report.verdict,
      reason: report.reason,
      label: report.label,
      inputs: {
        original: report.inputs.original.path,
        generated: report.inputs.generated.path,
        mask: report.inputs.mask.path,
      },
      protectedPixels: report.comparison ? report.comparison.protectedPixels : 0,
      changedPixels: report.comparison ? report.comparison.changedPixels : 0,
      exactChangedPixels: report.comparison ? report.comparison.exactChangedPixels : 0,
      maxDelta: report.comparison ? report.comparison.maxDelta : 0,
      tolerance: report.policy.tolerance,
      proofDigest: report.proof ? report.proof.proofDigest : null,
      protectedDigestEqual: report.proof ? report.proof.protectedPixels.equal : null,
      outputDir: report.outputs.dir,
      heatmap: report.outputs.heatmap,
      reportHtml: report.outputs.reportHtml,
      reportJson: report.outputs.reportJson,
      heatmapUrl: report.outputs.heatmap ? API + '/heatmap/' + id : null,
      reportUrl: API + '/report/' + id,
      jsonUrl: API + '/json/' + id,
    }
    records.unshift(record)
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS
    stats.runs += 1
    if (report.verdict === 'pass') stats.pass += 1
    else if (report.verdict === 'fail') stats.fail += 1
    else stats.empty += 1
    return record
  }

  function recordId(seq, reportId) {
    return String(seq).padStart(3, '0') + '-' + String(reportId).slice(0, 12)
  }

  function statePayload() {
    return {
      version: TOOL_VERSION,
      stats,
      latest: records[0] || null,
      records: records.slice(0, 30),
      defaults: {
        maskMode: 'edit',
        maskThreshold: 127,
        tolerance: 0,
        ignoreAlpha: false,
      },
    }
  }

  function findRecord(id) {
    for (const record of records) if (record.id === id) return record
    return undefined
  }

  function absolutePath(path) {
    return resolve(process.cwd(), path)
  }

  // ---- tool ---------------------------------------------------------------
  const tools = safeGet(ctx, 'tools')
  if (tools && typeof tools.register === 'function') {
    ctx.effect(function () {
      return tools.register({
        name: 'mask_pixel_lock_verify',
        description:
          '证明一次局部改图没有动蒙版外的像素：输入原图、生成图、蒙版三张 PNG，逐像素比较蒙版外区域，' +
          '返回 PASS/FAIL、差异统计、差异热力图，并写出带 SHA-256 像素证明的 report.json 与 report.html。' +
          'maskMode=edit（默认）表示蒙版内是可改区；maskMode=lock 表示蒙版内是受保护区。' +
          '只支持 PNG（8/16 位、全部标准颜色类型、含 Adam7 隔行）；图片必须已经存在，不联网、不上传。',
        parameters: {
          type: 'object',
          properties: {
            original: { type: 'string', description: '原图 PNG 的路径（绝对路径，或相对宿主进程 cwd）。' },
            generated: { type: 'string', description: '生成图 PNG 的路径。尺寸必须与原图一致。' },
            mask: { type: 'string', description: '蒙版 PNG 的路径。尺寸必须与原图一致；墨量 = 亮度 × alpha/255。' },
            outputDir: { type: 'string', description: '可选输出目录。默认在生成图旁边新建 mask-pixel-lock-<时间>。' },
            maskMode: {
              type: 'string',
              enum: ['edit', 'lock'],
              default: 'edit',
              description: 'edit：蒙版内可改、蒙版外受保护（默认）。lock：蒙版内受保护、蒙版外可改。',
            },
            maskThreshold: {
              type: 'integer',
              minimum: 0,
              maximum: 255,
              default: 127,
              description: '蒙版墨量达到该值才算被覆盖，默认 127。',
            },
            tolerance: {
              type: 'integer',
              minimum: 0,
              maximum: 255,
              default: 0,
              description: '通道差超过该值才算变化，默认 0（严格逐字节相等）。',
            },
            ignoreAlpha: {
              type: 'boolean',
              default: false,
              description: '为 true 时只比较 RGB，忽略 alpha 通道。',
            },
            label: { type: 'string', description: '这次校验的说明，会写进报告。' },
          },
          required: ['original', 'generated', 'mask'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            const text = value && typeof value.summary === 'string'
              ? value.summary
              : (value && typeof value === 'object' ? JSON.stringify(value) : String(value))
            return [{ type: 'text', text }]
          },
        },
        async execute(args) {
          const report = verifyFiles(verifyOptions(args || {}))
          remember(report)
          return toToolValue(report)
        },
      })
    })
  }

  // ---- HTTP route ---------------------------------------------------------
  const webServer = safeGet(ctx, 'webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(function () {
      let disposeRoute
      try {
        disposeRoute = webServer.register({
          kind: 'prefix',
          path: API,
          handler: async function (req, res) {
            try {
              const segments = segmentsOf(req.url)
              if (req.method === 'GET' && (segments.length === 0 || segments[0] === 'state')) {
                sendJson(res, 200, statePayload())
                return
              }
              if (req.method === 'GET' && segments[0] === 'heatmap') {
                const record = findRecord(segments[1] || '')
                if (!record || !record.heatmap) return sendJson(res, 404, { error: 'no such heatmap' })
                sendFile(res, absolutePath(record.heatmap), 'image/png')
                return
              }
              if (req.method === 'GET' && segments[0] === 'report') {
                const record = findRecord(segments[1] || '')
                if (!record) return sendJson(res, 404, { error: 'no such report' })
                sendFile(res, absolutePath(record.reportHtml), 'text/html; charset=utf-8')
                return
              }
              if (req.method === 'GET' && segments[0] === 'json') {
                const record = findRecord(segments[1] || '')
                if (!record) return sendJson(res, 404, { error: 'no such report' })
                sendFile(res, absolutePath(record.reportJson), 'application/json; charset=utf-8')
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }

              const body = await readBody(req)
              if (segments[0] === 'clear') {
                records.length = 0
                stats.runs = 0
                stats.pass = 0
                stats.fail = 0
                stats.empty = 0
                stats.errors = 0
                sendJson(res, 200, { ok: true, state: statePayload() })
                return
              }
              if (segments[0] !== 'verify') {
                sendJson(res, 404, { error: 'unknown method' })
                return
              }

              const report = verifyFiles(verifyOptions(body))
              remember(report)
              sendJson(res, 200, { ok: true, record: records[0], report: toToolValue(report), state: statePayload() })
            } catch (error) {
              const message = String((error && error.message) || error)
              if (error instanceof InputError) {
                stats.errors += 1
                sendJson(res, 400, { ok: false, error: { code: error.code, message }, state: statePayload() })
              } else {
                stats.errors += 1
                sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message }, state: statePayload() })
              }
            }
          },
        })
      } catch (error) {
        disposeRoute = undefined
      }
      return function () {
        if (typeof disposeRoute === 'function') disposeRoute()
        records.length = 0
      }
    })
  }
}

// The tool and the HTTP body call the argument `outputDir`; the public
// verifyFiles() API calls it `outDir`. Accept both, but do not leak the alias
// into the report policy.
function verifyOptions(input) {
  const options = Object.assign({}, input)
  if (options.outputDir !== undefined && options.outDir === undefined) {
    options.outDir = String(options.outputDir)
  }
  delete options.outputDir
  return options
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch (error) {
    return undefined
  }
}

function segmentsOf(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-mask-pixel-lock\/?/, '')
  return rest.split('/').filter((part) => part.length > 0)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendFile(res, filePath, contentType) {
  try {
    const bytes = readFileSync(filePath)
    res.statusCode = 200
    res.setHeader('content-type', contentType)
    res.setHeader('cache-control', 'no-store')
    res.end(bytes)
  } catch (error) {
    sendJson(res, 404, { error: 'file not found' })
  }
}

function readBody(req) {
  return new Promise(function (resolveBody) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) req.destroy()
    })
    req.on('end', function () {
      try {
        resolveBody(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolveBody({})
      }
    })
    req.on('error', function () {
      resolveBody({})
    })
  })
}

export { buildSummary }
