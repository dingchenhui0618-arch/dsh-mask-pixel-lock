#!/usr/bin/env node
// Command-line front end for the same verifier the plugin exposes.
//
// Exit codes are part of the contract:
//   0  PASS   — every protected pixel is identical (or within tolerance)
//   1  FAIL   — at least one protected pixel changed
//   2  ERROR  — bad input (missing file, not a PNG, mask size mismatch, …)
//   3  EMPTY  — there were no protected pixels, so nothing was proven

import { buildSummary } from '../src/core/report.js'
import { TOOL_VERSION } from '../src/core/version.js'
import { verifyFiles } from '../src/core/verify.js'

const USAGE = `dsh-mask-pixel-lock ${TOOL_VERSION}

用法:
  mask-pixel-lock --original <before.png> --generated <after.png> --mask <mask.png> [选项]

选项:
  --out <dir>          输出目录（默认在生成图旁边新建 mask-pixel-lock-<时间>）
  --mask-mode <mode>   edit（默认，蒙版内可改）或 lock（蒙版内受保护）
  --threshold <0-255>  蒙版墨量阈值，默认 127
  --tolerance <0-255>  通道差容差，默认 0（严格逐字节相等）
  --ignore-alpha       只比较 RGB
  --label <text>       写进报告的说明
  --json               把完整 report.json 打到 stdout
  --help               显示本帮助
  --version            显示版本

退出码: 0=PASS, 1=FAIL, 2=ERROR, 3=EMPTY

示例:
  mask-pixel-lock --original examples/before.png --generated examples/after.png \\
    --mask examples/mask.png --out examples/report-pass --label "主体缩小，背景不动"
`

function parseArgs(argv) {
  const options = { maskMode: 'edit', tolerance: 0, maskThreshold: 127, ignoreAlpha: false }
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined
    const value = () => {
      if (inline !== undefined) return inline
      i += 1
      if (i >= argv.length) throw new Error(name + ' 需要一个值')
      return argv[i]
    }
    if (name === '--original') options.original = value()
    else if (name === '--generated') options.generated = value()
    else if (name === '--mask') options.mask = value()
    else if (name === '--out') options.outDir = value()
    else if (name === '--mask-mode') options.maskMode = value()
    else if (name === '--threshold') options.maskThreshold = Number(value())
    else if (name === '--tolerance') options.tolerance = Number(value())
    else if (name === '--label') options.label = value()
    else if (name === '--ignore-alpha') options.ignoreAlpha = true
    else if (name === '--json') json = true
    else if (name === '--help' || name === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else if (name === '--version' || name === '-v') {
      process.stdout.write(TOOL_VERSION + '\n')
      process.exit(0)
    } else {
      throw new Error('未知参数: ' + arg + '\n\n' + USAGE)
    }
  }
  return { options, json }
}

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write('mask-pixel-lock: ' + error.message + '\n')
  process.exit(2)
}

try {
  const report = verifyFiles(parsed.options)
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(buildSummary(report) + '\n')
  }
  if (report.verdict === 'pass') process.exitCode = 0
  else if (report.verdict === 'fail') process.exitCode = 1
  else process.exitCode = 3
} catch (error) {
  process.stderr.write('mask-pixel-lock: ' + ((error && error.message) || error) + '\n')
  process.exitCode = 2
}
