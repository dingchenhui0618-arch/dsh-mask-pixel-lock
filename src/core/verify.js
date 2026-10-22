// File-level orchestration: read three PNGs, scope the mask, compare, render the
// heatmap, build the hash proof and write the report bundle.
//
// Everything here is synchronous on purpose. The images are local files, the
// work is pure CPU, and a single call keeps the evidence (read bytes → hashes →
// pixels) tied to one immutable snapshot.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { buildLockMap, comparePixels, InputError } from './compare.js'
import { renderHeatmap } from './heatmap.js'
import { PngError, decodePng } from './png.js'
import { buildProof, sha256Hex } from './proof.js'
import { buildHtmlReport, buildSummary, toToolValue } from './report.js'
import { TOOL_VERSION } from './version.js'

export const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_EMBED_BYTES = 4 * 1024 * 1024
const REPORT_SCHEMA = 'dsh-mask-pixel-lock/report@1'

/**
 * Verify that every pixel outside the editable mask is unchanged.
 *
 * @param {object} options
 * @param {string} options.original   original PNG path
 * @param {string} options.generated  generated PNG path
 * @param {string} options.mask       mask PNG path
 * @param {string} [options.outDir]   output directory (default: beside generated)
 * @param {'edit'|'lock'} [options.maskMode]
 * @param {number} [options.maskThreshold]
 * @param {number} [options.tolerance]
 * @param {boolean} [options.ignoreAlpha]
 * @param {string} [options.label]
 * @returns {object} the full report
 */
export function verifyFiles(options) {
  const started = Date.now()
  if (options === null || typeof options !== 'object') {
    throw new InputError('verifyFiles needs an options object', 'BAD_ARGUMENT')
  }
  const originalPath = requiredPath(options.original, 'original')
  const generatedPath = requiredPath(options.generated, 'generated')
  const maskPath = requiredPath(options.mask, 'mask')

  const originalFile = readPng(originalPath, '原图')
  const generatedFile = readPng(generatedPath, '生成图')
  const maskFile = readPng(maskPath, '蒙版')

  if (maskFile.image.width !== originalFile.image.width || maskFile.image.height !== originalFile.image.height) {
    throw new InputError(
      '蒙版尺寸 ' + maskFile.image.width + 'x' + maskFile.image.height +
        ' 与原图 ' + originalFile.image.width + 'x' + originalFile.image.height + ' 不一致；无法确定保护范围',
      'MASK_DIMENSION',
    )
  }

  const policy = {
    maskMode: options.maskMode === 'lock' ? 'lock' : 'edit',
    maskThreshold: integerInRange(options.maskThreshold, 127, 0, 255, '蒙版阈值'),
    tolerance: integerInRange(options.tolerance, 0, 0, 255, '容差'),
    ignoreAlpha: options.ignoreAlpha === true,
  }
  const label = typeof options.label === 'string' && options.label.trim().length > 0
    ? options.label.trim().slice(0, 120)
    : '蒙版外像素未改动证明'
  const createdAt = new Date().toISOString()
  const outDir = resolveOutputDir(options.outDir, generatedPath, createdAt)

  const inputs = {
    original: describeInput(originalPath, originalFile),
    generated: describeInput(generatedPath, generatedFile),
    mask: describeInput(maskPath, maskFile),
  }

  if (
    originalFile.image.width !== generatedFile.image.width ||
    originalFile.image.height !== generatedFile.image.height
  ) {
    const report = {
      schema: REPORT_SCHEMA,
      id: sha256Hex(createdAt + originalFile.sha + generatedFile.sha).slice(0, 16),
      createdAt,
      durationMs: Date.now() - started,
      tool: { name: 'dsh-mask-pixel-lock', version: TOOL_VERSION },
      verdict: 'fail',
      reason: 'dimensions-differ',
      label,
      inputs,
      policy,
      comparison: null,
      dimensions: {
        original: { width: originalFile.image.width, height: originalFile.image.height },
        generated: { width: generatedFile.image.width, height: generatedFile.image.height },
      },
      proof: null,
      outputs: {},
      warnings: [
        '原图与生成图尺寸不同，逐像素比对无法进行。尺寸变化本身就是一次未受控的改图。',
      ],
    }
    const outputs = writeOutputs(outDir, report, null, originalFile, generatedFile, maskFile)
    report.outputs = outputs
    writeReportFiles(outDir, report, originalFile, generatedFile, maskFile, null)
    return report
  }

  const scope = buildLockMap(maskFile.image, { mode: policy.maskMode, threshold: policy.maskThreshold })
  const comparison = comparePixels(originalFile.image, generatedFile.image, scope.lock, {
    tolerance: policy.tolerance,
    ignoreAlpha: policy.ignoreAlpha,
  })

  const heatmap = renderHeatmap(originalFile.image, generatedFile.image, scope.lock, {
    ignoreAlpha: policy.ignoreAlpha,
  })

  const proof = buildProof({
    originalBytes: originalFile.bytes,
    generatedBytes: generatedFile.bytes,
    maskBytes: maskFile.bytes,
    original: originalFile.image,
    generated: generatedFile.image,
    lock: scope.lock,
    policy,
    comparison,
  })

  const report = {
    schema: REPORT_SCHEMA,
    id: proof.proofDigest.slice(0, 16),
    createdAt,
    durationMs: Date.now() - started,
    tool: { name: 'dsh-mask-pixel-lock', version: TOOL_VERSION },
    verdict: comparison.verdict,
    reason:
      comparison.verdict === 'fail'
        ? 'protected-pixels-changed'
        : comparison.verdict === 'empty'
          ? 'no-protected-pixels'
          : null,
    label,
    inputs,
    policy,
    comparison,
    dimensions: {
      width: originalFile.image.width,
      height: originalFile.image.height,
    },
    scope: {
      markedPixels: scope.marked,
      protectedPixels: scope.protectedPixels,
      editablePixels: comparison.editablePixels,
    },
    proof,
    outputs: {},
    warnings: comparison.warnings,
  }

  const outputs = writeOutputs(outDir, report, heatmap, originalFile, generatedFile, maskFile)
  report.outputs = outputs
  writeReportFiles(outDir, report, originalFile, generatedFile, maskFile, heatmap)
  report.summary = buildSummary(report)
  return report
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InputError('缺少 ' + name + ' 路径', 'MISSING_PATH')
  }
  return resolve(value.trim())
}

function integerInRange(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new InputError(label + '必须是 ' + min + '..' + max + ' 之间的整数', 'BAD_ARGUMENT')
  }
  return number
}

function readPng(filePath, label) {
  let info
  try {
    info = statSync(filePath)
  } catch (error) {
    throw new InputError(label + '文件不存在或不可读：' + filePath, 'READ_FAILED')
  }
  if (!info.isFile()) throw new InputError(label + '路径不是文件：' + filePath, 'READ_FAILED')
  if (info.size > MAX_FILE_BYTES) {
    throw new InputError(label + '文件超过 ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + ' MB 上限', 'TOO_LARGE')
  }
  let bytes
  try {
    bytes = readFileSync(filePath)
  } catch (error) {
    throw new InputError(label + '读取失败：' + ((error && error.message) || error), 'READ_FAILED')
  }
  let image
  try {
    image = decodePng(bytes)
  } catch (error) {
    if (error instanceof PngError) {
      throw new InputError(label + '不是可用的 PNG：' + error.message, error.code || 'BAD_PNG')
    }
    throw error
  }
  return { bytes, image, sha: sha256Hex(bytes), size: bytes.length }
}

function describeInput(filePath, file) {
  return {
    path: displayPath(filePath),
    bytes: file.size,
    sha256: file.sha,
    width: file.image.width,
    height: file.image.height,
    colorType: file.image.colorType,
    bitDepth: file.image.bitDepth,
    interlace: file.image.interlace,
  }
}

function displayPath(filePath) {
  const rel = relative(process.cwd(), filePath)
  const inside = rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)
  return (inside ? rel : filePath).split(sep).join('/')
}

function resolveOutputDir(requested, generatedPath, createdAt) {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\..+$/, '')
  const base = typeof requested === 'string' && requested.trim().length > 0
    ? resolve(requested.trim())
    : join(dirname(generatedPath), 'mask-pixel-lock-' + stamp)
  let candidate = base
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = base + '-' + suffix
    suffix += 1
  }
  mkdirSync(candidate, { recursive: true })
  return candidate
}

function writeOutputs(dir, report, heatmap, originalFile, generatedFile, maskFile) {
  const heatmapPath = heatmap === null ? null : join(dir, 'heatmap.png')
  if (heatmap !== null) writeFileSync(heatmapPath, heatmap)
  return {
    dir: displayPath(dir),
    heatmap: heatmapPath === null ? null : displayPath(heatmapPath),
    reportJson: displayPath(join(dir, 'report.json')),
    reportHtml: displayPath(join(dir, 'report.html')),
  }
}

function writeReportFiles(dir, report, originalFile, generatedFile, maskFile, heatmap) {
  const jsonPath = join(dir, 'report.json')
  const htmlPath = join(dir, 'report.html')

  const assets = {
    original: embedAsset(originalFile.bytes, displayPath(report.inputs.original.path), MAX_EMBED_BYTES),
    generated: embedAsset(generatedFile.bytes, displayPath(report.inputs.generated.path), MAX_EMBED_BYTES),
    mask: embedAsset(maskFile.bytes, displayPath(report.inputs.mask.path), MAX_EMBED_BYTES),
    heatmap: heatmap === null ? null : { buffer: heatmap, path: report.outputs.heatmap, embedded: true },
  }

  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  writeFileSync(htmlPath, buildHtmlReport(report, assets), 'utf8')
}

function embedAsset(bytes, path, limit) {
  return { buffer: bytes.length <= limit ? bytes : null, path, embedded: bytes.length <= limit }
}

export { buildSummary, toToolValue, TOOL_VERSION }
