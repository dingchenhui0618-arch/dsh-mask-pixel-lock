// Human- and machine-readable report rendering.
//
// The HTML report is fully self-contained: the comparison page is the artifact
// a person opens to check the verdict, so it must not depend on the harness,
// a server, or a network. Images are embedded when they are small enough; the
// report still points at the files when they are not.

const MIME = 'image/png'

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0%'
  if (value < 0.0001) return '<0.01%'
  return (value * 100).toFixed(2) + '%'
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

const VERDICT = {
  pass: { label: '通过', en: 'PASS', mark: '✓', sentence: '蒙版外像素逐字节一致' },
  fail: { label: '未通过', en: 'FAIL', mark: '!', sentence: '蒙版外存在被改动的像素' },
  empty: { label: '无证据', en: 'EMPTY', mark: '∅', sentence: '蒙版外没有受保护像素，这次校验证明不了任何东西' },
}

export function verdictInfo(verdict) {
  return VERDICT[verdict] || VERDICT.fail
}

export function buildSummary(report) {
  const info = verdictInfo(report.verdict)
  const lines = ['MASK_PIXEL_LOCK=' + info.en]
  if (report.reason === 'dimensions-differ') {
    lines.push('原图与生成图尺寸不同：' + report.dimensions.original.width + 'x' + report.dimensions.original.height +
      ' vs ' + report.dimensions.generated.width + 'x' + report.dimensions.generated.height)
  } else if (report.comparison !== null) {
    lines.push(
      '受保护像素 ' + report.comparison.protectedPixels +
      ' / 变化 ' + report.comparison.changedPixels +
      ' / 最大通道差 ' + report.comparison.maxDelta +
      ' / 容差 ' + report.policy.tolerance,
    )
  }
  if (report.proof) {
    lines.push('像素证明 ' + (report.proof.protectedPixels.equal ? '相等' : '不同') + ' · ' + report.proof.protectedPixels.original)
    lines.push('证明摘要 ' + report.proof.proofDigest)
  }
  if (report.outputs) {
    if (report.outputs.heatmap) lines.push('热力图 ' + report.outputs.heatmap)
    if (report.outputs.reportHtml) lines.push('报告 ' + report.outputs.reportHtml)
  }
  for (const warning of report.warnings || []) lines.push('注意 ' + warning)
  return lines.join('\n')
}

/**
 * Build the self-contained HTML comparison page.
 * `assets` = { original, generated, mask, heatmap } where each value is
 * { buffer, path, embedded } (heatmap is always embedded).
 */
export function buildHtmlReport(report, assets) {
  const info = verdictInfo(report.verdict)
  const comparison = report.comparison
  const proof = report.proof
  const output = report.outputs || {}
  const created = report.createdAt || ''
  const duration = Number.isFinite(report.durationMs) ? report.durationMs + ' ms' : '—'

  const metrics = report.reason === 'dimensions-differ'
    ? [
        ['原图尺寸', report.dimensions.original.width + ' × ' + report.dimensions.original.height],
        ['生成图尺寸', report.dimensions.generated.width + ' × ' + report.dimensions.generated.height],
        ['结论', '尺寸不一致，无法做像素比对'],
      ]
    : [
        ['受保护像素', formatNumber(comparison.protectedPixels)],
        ['可编辑像素', formatNumber(comparison.editablePixels)],
        ['变化像素', formatNumber(comparison.changedPixels)],
        ['变化比例', formatPercent(comparison.changedRatio)],
        ['最大通道差', comparison.maxDelta + ' / 255'],
        ['平均通道差', comparison.meanDelta.toFixed(3)],
      ]

  const verdictDetail = report.reason === 'dimensions-differ'
    ? '原图与生成图的尺寸不同，逐像素比对无法进行。请先确认生成过程没有改变画布尺寸。'
    : report.verdict === 'pass'
      ? (report.policy.tolerance > 0 && comparison.exactChangedPixels > 0
          ? '所有受保护像素都在容差 ' + report.policy.tolerance + ' 之内；但其中 ' + comparison.exactChangedPixels +
            ' 个像素确实发生了变化，因此哈希证明不相等。这是一个「宽容通过」，不是严格相等。'
          : '蒙版之外的每一个像素都与原图逐字节相同，哈希证明相等。')
      : report.verdict === 'empty'
        ? '蒙版覆盖了整张图片（或阈值把所有像素都判为可编辑），没有可保护的像素。'
        : '有 ' + comparison.changedPixels + ' 个蒙版外像素超出了容差 ' + report.policy.tolerance +
          '，最大通道差 ' + comparison.maxDelta + '。'

  const histogram = comparison ? buildHistogram(comparison.histogram) : ''
  const samples = comparison && comparison.samples.length > 0 ? buildSamples(comparison.samples) : ''
  const warnings = (report.warnings || []).length > 0
    ? '<div class="callout warn"><b>注意</b><ul>' + report.warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul></div>'
    : ''

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蒙版外像素证明 · ${escapeHtml(info.en)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f5f7fb;color:#0f172a;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:36px 28px 56px}
.brand{display:flex;align-items:center;gap:10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b}
.brand .dot{width:8px;height:8px;border-radius:50%;background:#0f172a}
h1{font-size:26px;line-height:1.25;margin:14px 0 6px;letter-spacing:-.02em}
.sub{color:#64748b;font-size:13px}
.verdict{display:flex;gap:18px;align-items:flex-start;margin:24px 0 18px;padding:20px 22px;border-radius:14px;border:1px solid;background:#fff}
.verdict .mark{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:24px;font-weight:700;flex:none;color:#fff}
.verdict h2{margin:0;font-size:19px;letter-spacing:.01em}
.verdict p{margin:4px 0 0;color:#475569;font-size:13px;max-width:72ch}
.verdict.pass{border-color:#bbf7d0;background:linear-gradient(180deg,#f0fdf4,#fff)}
.verdict.pass .mark{background:#16a34a}
.verdict.fail{border-color:#fecaca;background:linear-gradient(180deg,#fef2f2,#fff)}
.verdict.fail .mark{background:#dc2626}
.verdict.empty{border-color:#fde68a;background:linear-gradient(180deg,#fffbeb,#fff)}
.verdict.empty .mark{background:#d97706}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin:18px 0}
.metric{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px}
.metric b{display:block;font-size:21px;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.metric span{display:block;margin-top:3px;color:#64748b;font-size:11px}
section{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;margin:14px 0}
section h3{margin:0 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#475569}
.policy{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid #e2e8f0;background:#f8fafc;border-radius:999px;padding:4px 11px;font-size:12px;color:#334155}
.chip b{font-weight:600;color:#0f172a}
.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
figure{margin:0}
figure img{width:100%;display:block;border-radius:10px;border:1px solid #e2e8f0;background:#0b0d12}
figcaption{display:flex;justify-content:space-between;gap:8px;margin-top:7px;font-size:12px;color:#475569}
figcaption code{color:#94a3b8;font-size:11px}
.missing{display:grid;place-items:center;min-height:150px;border:1px dashed #cbd5e1;border-radius:10px;color:#94a3b8;font-size:12px;text-align:center;padding:16px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eef2f7;vertical-align:top}
th{color:#64748b;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.mono,code.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
.hash{display:grid;grid-template-columns:130px 1fr;gap:6px 14px;font-size:12px}
.hash dt{color:#64748b}
.hash dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#64748b;margin-top:10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.swatch{width:13px;height:13px;border-radius:4px;display:inline-block}
.bars{display:grid;gap:7px}
.bar{display:grid;grid-template-columns:58px 1fr 64px;gap:10px;align-items:center;font-size:11px;color:#64748b}
.bar .track{height:8px;border-radius:999px;background:#f1f5f9;overflow:hidden}
.bar .fill{height:100%;background:#f59e0b;border-radius:999px}
.callout{border-radius:10px;padding:12px 14px;font-size:12px;margin-top:12px}
.callout.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
.callout ul{margin:6px 0 0;padding-left:18px}
footer{margin-top:26px;color:#94a3b8;font-size:11px;line-height:1.8}
footer code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media print{body{background:#fff}main{padding:0}section,.verdict,.metric{break-inside:avoid}}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="dot"></span>dsh-mask-pixel-lock <span style="color:#cbd5e1">/</span> 蒙版外像素证明</div>
  <h1>${escapeHtml(report.label || '蒙版外像素未改动证明')}</h1>
  <div class="sub">${escapeHtml(created)} · 用时 ${escapeHtml(duration)} · 报告 ${escapeHtml(report.id)}</div>

  <div class="verdict ${escapeHtml(report.verdict)}">
    <div class="mark">${escapeHtml(info.mark)}</div>
    <div>
      <h2>${escapeHtml(info.en)} · ${escapeHtml(info.label)}</h2>
      <p>${escapeHtml(verdictDetail)}</p>
    </div>
  </div>

  <div class="grid">
    ${metrics.map(([label, value]) => `<div class="metric"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('')}
  </div>

  <section>
    <h3>判定依据</h3>
    <div class="policy">
      <span class="chip">蒙版语义 <b>${report.policy.maskMode === 'lock' ? '蒙版内=保护' : '蒙版外=保护'}</b></span>
      <span class="chip">蒙版阈值 <b>${report.policy.maskThreshold}</b></span>
      <span class="chip">容差 <b>${report.policy.tolerance}</b></span>
      <span class="chip">Alpha <b>${report.policy.ignoreAlpha ? '忽略' : '参与比对'}</b></span>
      <span class="chip">比较通道 <b>${report.policy.ignoreAlpha ? 'RGB' : 'RGBA'}</b></span>
    </div>
  </section>

  <section>
    <h3>图像对照</h3>
    <div class="figures">
      ${figure('原图', 'original', assets.original, report.inputs.original)}
      ${figure('生成图', 'generated', assets.generated, report.inputs.generated)}
      ${figure('差异热力图', 'heatmap', assets.heatmap, output.heatmap ? { path: output.heatmap } : undefined)}
    </div>
    <div class="legend">
      <span><i class="swatch" style="background:#0c0e12"></i>蒙版外未变</span>
      <span><i class="swatch" style="background:#f59e0b"></i>变化（小）</span>
      <span><i class="swatch" style="background:#ef4444"></i>变化（大）</span>
      <span><i class="swatch" style="background:#161e2a"></i>可编辑区（蒙版内）</span>
    </div>
  </section>

  ${histogram}

  ${proof ? `<section>
    <h3>哈希证明</h3>
    <dl class="hash">
      <dt>原图文件 sha256</dt><dd>${escapeHtml(proof.files.original)}</dd>
      <dt>生成图文件 sha256</dt><dd>${escapeHtml(proof.files.generated)}</dd>
      <dt>蒙版文件 sha256</dt><dd>${escapeHtml(proof.files.mask)}</dd>
      <dt>受保护像素摘要</dt><dd>${escapeHtml(proof.protectedPixels.count)} 个 × ${escapeHtml(proof.protectedPixels.channels)} 通道 = ${escapeHtml(proof.protectedPixels.original)}</dd>
      <dt>生成图摘要</dt><dd>${escapeHtml(proof.protectedPixels.generated)}</dd>
      <dt>摘要相等</dt><dd>${proof.protectedPixels.equal ? '是 — 受保护像素逐字节相同' : '否 — 受保护像素存在差异'}</dd>
      <dt>证明摘要</dt><dd>${escapeHtml(proof.proofDigest)}</dd>
    </dl>
    <div class="callout" style="background:#f8fafc;border:1px solid #e2e8f0;color:#475569">
      像素摘要按「尺寸 + 比较通道 + 受保护像素的 RGBA 扫描线顺序」规范化计算，与 PNG 编码器、压缩级别和文件元数据无关。
      文件 sha256 证明的是字节没换；像素摘要证明的是蒙版外内容没变。证明摘要把两者和判定策略绑定在一起。
      这是本地完整性证明，不是数字签名：能改写报告的人也能重算摘要。
    </div>
  </section>` : ''}

  ${samples}

  ${warnings}

  <footer>
    由 dsh-mask-pixel-lock ${escapeHtml(report.tool.version)} 生成 · ${escapeHtml(output.dir || '')}<br>
    <code>${escapeHtml(output.reportJson || '')}</code> · <code>${escapeHtml(output.reportHtml || '')}</code><br>
    输入：${escapeHtml(report.inputs.original.path)} → ${escapeHtml(report.inputs.generated.path)} · 蒙版 ${escapeHtml(report.inputs.mask.path)}
  </footer>
</main>
</body>
</html>
`
  return html.replace(/[ \t]+$/gm, '')
}

function figure(title, kind, asset, meta) {
  if (asset === undefined || asset === null) return ''
  const embedded = asset.embedded && asset.buffer
  const body = embedded
    ? `<img alt="${escapeHtml(title)}" src="data:${MIME};base64,${asset.buffer.toString('base64')}">`
    : `<div class="missing">${escapeHtml((meta && meta.path) || asset.path || '未嵌入')}<br>图片体积超过内嵌上限，请直接打开文件。</div>`
  const path = (meta && meta.path) || asset.path || ''
  const sha = meta && meta.sha256 ? meta.sha256.slice(0, 12) : ''
  return `<figure>${body}<figcaption><span>${escapeHtml(title)}</span><code>${escapeHtml(sha || path)}</code></figcaption></figure>`
}

function buildHistogram(histogram) {
  const max = histogram.reduce((best, bucket) => Math.max(best, bucket.count), 0)
  if (max === 0) return ''
  return `<section>
    <h3>通道差分布（受保护像素）</h3>
    <div class="bars">
      ${histogram.map((bucket) => {
        const width = max === 0 ? 0 : (bucket.count / max) * 100
        return `<div class="bar"><span>${escapeHtml(bucket.label)}</span><span class="track"><span class="fill" style="width:${width.toFixed(2)}%"></span></span><span>${formatNumber(bucket.count)}</span></div>`
      }).join('')}
    </div>
  </section>`
}

function buildSamples(samples) {
  return `<section>
    <h3>变化最大的像素（最多 20 个）</h3>
    <table>
      <thead><tr><th>坐标</th><th>通道差</th><th>原图 RGBA</th><th>生成图 RGBA</th></tr></thead>
      <tbody>
        ${samples.map((sample) => `<tr>
          <td class="mono">(${sample.x}, ${sample.y})</td>
          <td class="mono">${sample.delta}</td>
          <td class="mono">${sample.original.join(', ')}</td>
          <td class="mono">${sample.generated.join(', ')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>`
}

/** Compact value returned to the model by the tool. */
export function toToolValue(report) {
  return {
    ok: report.verdict === 'pass',
    verdict: report.verdict,
    reason: report.reason,
    label: report.label,
    inputs: {
      original: report.inputs.original.path,
      generated: report.inputs.generated.path,
      mask: report.inputs.mask.path,
    },
    policy: report.policy,
    comparison: report.comparison === null
      ? null
      : {
          protectedPixels: report.comparison.protectedPixels,
          editablePixels: report.comparison.editablePixels,
          changedPixels: report.comparison.changedPixels,
          exactChangedPixels: report.comparison.exactChangedPixels,
          changedRatio: report.comparison.changedRatio,
          maxDelta: report.comparison.maxDelta,
          meanDelta: report.comparison.meanDelta,
          bbox: report.comparison.bbox,
          samples: report.comparison.samples.slice(0, 8),
        },
    proof: report.proof,
    outputs: report.outputs,
    warnings: report.warnings,
    summary: buildSummary(report),
  }
}
