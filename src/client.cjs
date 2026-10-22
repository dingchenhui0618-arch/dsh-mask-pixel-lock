// Client half of dsh-mask-pixel-lock: the 像素锁 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness. The host half owns all state; this
// side renders /dsh-mask-pixel-lock/state and posts one verification request.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-mask-pixel-lock'
const POLL_MS = 2000

const VERDICT = {
  pass: { label: '通过', en: 'PASS', mark: '✓', cls: 'pass' },
  fail: { label: '未通过', en: 'FAIL', mark: '!', cls: 'fail' },
  empty: { label: '无证据', en: 'EMPTY', mark: '∅', cls: 'empty' },
}

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-mask-pixel-lock] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function post(path, body) {
  return fetch(API + '/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        const message = data && data.error && data.error.message ? data.error.message : 'HTTP ' + res.status
        const failure = new Error(message)
        failure.code = data && data.error && data.error.code
        throw failure
      }
      return data
    })
  })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function pad(n) { return n < 10 ? '0' + n : String(n) }

function clock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  return sameDay ? time : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + time
}

function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}

function shortHash(value) {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.slice(0, 16) + '…'
}

function Stat(props) {
  return h('div', { className: 'mpl-stat' + (props.tone ? ' ' + props.tone : '') },
    h('b', null, num(props.value)),
    h('span', null, props.label),
  )
}

function Badge(props) {
  return h('span', { className: 'mpl-badge mpl-' + props.verdict }, VERDICT[props.verdict].label)
}

function Records(props) {
  const records = props.records
  if (records.length === 0) {
    return h('div', { className: 'mpl-empty' }, '还没有校验记录。填入三张 PNG 的路径，或在对话里让 agent 调用 mask_pixel_lock_verify。')
  }
  return h('div', { className: 'mpl-list' }, records.map(function (record) {
    const selected = props.selected === record.id
    return h('button', {
      key: record.id,
      type: 'button',
      className: 'mpl-row' + (selected ? ' mpl-selected' : ''),
      onClick: function () { props.onSelect(record.id) },
    },
      record.heatmapUrl
        ? h('img', { className: 'mpl-thumb', src: record.heatmapUrl, alt: '' })
        : h('span', { className: 'mpl-thumb mpl-thumb-empty' }, '—'),
      h('span', { className: 'mpl-row-main' },
        h('span', { className: 'mpl-row-top' },
          h('b', { className: 'mpl-row-label' }, record.label || '未命名校验'),
          h(Badge, { verdict: record.verdict }),
        ),
        h('span', { className: 'mpl-row-meta' },
          clock(record.at) + ' · 保护 ' + num(record.protectedPixels) + ' · 变化 ' + num(record.changedPixels) +
          ' · 最大差 ' + num(record.maxDelta) + ' · 容差 ' + num(record.tolerance),
        ),
      ),
      h('span', { className: 'mpl-row-hash' }, shortHash(record.proofDigest)),
    )
  }))
}

function Field(props) {
  return h('label', { className: 'mpl-field' },
    h('span', null, props.label),
    h('input', {
      type: 'text',
      value: props.value,
      placeholder: props.placeholder || '',
      spellCheck: false,
      onChange: function (event) { props.onChange(event.target.value) },
    }),
  )
}

function Panel() {
  const [state, setState] = React.useState(snap)
  const [selected, setSelected] = React.useState(null)
  const [form, setForm] = React.useState({
    original: '',
    generated: '',
    mask: '',
    maskMode: 'edit',
    tolerance: '0',
    maskThreshold: '127',
    ignoreAlpha: false,
    label: '',
  })
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState('')

  React.useEffect(function () { return subscribe(setState) }, [])

  const data = state.data
  const stats = (data && data.stats) || { runs: 0, pass: 0, fail: 0, empty: 0, errors: 0 }
  const records = (data && data.records) || []
  const latest = (data && data.latest) || null
  const current = records.find(function (record) { return record.id === selected }) || latest

  function setField(name, value) {
    setForm(function (previous) {
      const next = Object.assign({}, previous)
      next[name] = value
      return next
    })
  }

  function run() {
    if (busy) return
    if (form.original.trim() === '' || form.generated.trim() === '' || form.mask.trim() === '') {
      setFormError('原图、生成图、蒙版三个路径都必须填写。')
      return
    }
    setBusy(true)
    setFormError('')
    post('verify', {
      original: form.original.trim(),
      generated: form.generated.trim(),
      mask: form.mask.trim(),
      maskMode: form.maskMode,
      tolerance: Number(form.tolerance === '' ? 0 : form.tolerance),
      maskThreshold: Number(form.maskThreshold === '' ? 127 : form.maskThreshold),
      ignoreAlpha: form.ignoreAlpha,
      label: form.label.trim(),
    })
      .then(function (result) {
        if (result && result.record) setSelected(result.record.id)
        load()
      })
      .catch(function (error) {
        setFormError(String((error && error.message) || error))
      })
      .finally(function () { setBusy(false) })
  }

  function clear() {
    if (busy) return
    post('clear', {})
      .then(function () { setSelected(null); load() })
      .catch(function (error) { setFormError(String((error && error.message) || error)) })
  }

  const info = current ? VERDICT[current.verdict] || VERDICT.fail : null
  const heroSub = current
    ? current.reason === 'dimensions-differ'
      ? '原图与生成图尺寸不同，无法逐像素比对'
      : '受保护 ' + num(current.protectedPixels) + ' · 变化 ' + num(current.changedPixels) +
        ' · 最大通道差 ' + num(current.maxDelta) + ' · 容差 ' + num(current.tolerance)
    : '还没有校验记录'
  const heroPath = current
    ? (current.inputs.original + ' → ' + current.inputs.generated)
    : '原图 → 生成图 · 蒙版决定哪里可以改'

  return h('div', { className: 'mpl-root' },
    h('div', { className: 'mpl-head' },
      h('div', null,
        h('div', { className: 'mpl-title' }, '像素锁'),
        h('div', { className: 'mpl-sub' }, '蒙版外逐像素比对 · SHA-256 像素证明'),
      ),
      h('div', { className: 'mpl-spacer' }),
      data ? h('span', { className: 'mpl-version' }, 'v' + data.version) : null,
      h('button', { className: 'mpl-btn', type: 'button', onClick: function () { load() } }, '刷新'),
      h('button', { className: 'mpl-btn', type: 'button', onClick: clear, disabled: busy }, '清空'),
    ),

    state.error ? h('div', { className: 'mpl-error' }, '与 host 通信失败：' + state.error) : null,
    formError ? h('div', { className: 'mpl-error' }, formError) : null,

    current ? h('div', { className: 'mpl-hero mpl-hero-' + info.cls },
      h('div', { className: 'mpl-hero-mark' }, info.mark),
      h('div', { className: 'mpl-hero-body' },
        h('div', { className: 'mpl-hero-line' },
          h('b', null, info.en),
          h('span', { className: 'mpl-hero-label' }, info.label),
          h('span', { className: 'mpl-hero-time' }, clock(current.at)),
        ),
        h('div', { className: 'mpl-hero-sub' }, heroSub),
        h('div', { className: 'mpl-hero-path' }, heroPath),
      ),
      h('div', { className: 'mpl-hero-actions' },
        h('a', { className: 'mpl-link', href: current.reportUrl, target: '_blank', rel: 'noreferrer' }, '打开报告 ↗'),
        h('a', { className: 'mpl-link mpl-link-quiet', href: current.jsonUrl, target: '_blank', rel: 'noreferrer' }, 'JSON'),
      ),
    ) : h('div', { className: 'mpl-hero mpl-hero-idle' },
      h('div', { className: 'mpl-hero-mark' }, '·'),
      h('div', { className: 'mpl-hero-body' },
        h('div', { className: 'mpl-hero-line' }, h('b', null, 'READY'), h('span', { className: 'mpl-hero-label' }, '等待第一次校验')),
        h('div', { className: 'mpl-hero-sub' }, '三张 PNG 进去，出来一句可 grep 的结论和一份可复核的证明'),
        h('div', { className: 'mpl-hero-path' }, heroPath),
      ),
    ),

    h('div', { className: 'mpl-stats' },
      h(Stat, { label: '校验', value: stats.runs }),
      h(Stat, { label: '通过', value: stats.pass, tone: 'mpl-good' }),
      h(Stat, { label: '未通过', value: stats.fail, tone: stats.fail > 0 ? 'mpl-bad' : '' }),
      h(Stat, { label: '无证据', value: stats.empty }),
      h(Stat, { label: '出错', value: stats.errors }),
    ),

    h('div', { className: 'mpl-columns' },
      h('div', { className: 'mpl-card mpl-form-card' },
        h('h4', null, '新校验'),
        h(Field, {
          label: '原图 PNG',
          value: form.original,
          placeholder: 'D:\\shots\\before.png',
          onChange: function (value) { setField('original', value) },
        }),
        h(Field, {
          label: '生成图 PNG',
          value: form.generated,
          placeholder: 'D:\\shots\\after.png',
          onChange: function (value) { setField('generated', value) },
        }),
        h(Field, {
          label: '蒙版 PNG',
          value: form.mask,
          placeholder: '白色 = 可改区（默认）',
          onChange: function (value) { setField('mask', value) },
        }),
        h('div', { className: 'mpl-options' },
          h('label', { className: 'mpl-field mpl-field-compact' },
            h('span', null, '蒙版语义'),
            h('select', {
              value: form.maskMode,
              onChange: function (event) { setField('maskMode', event.target.value) },
            },
              h('option', { value: 'edit' }, '蒙版内 = 可改'),
              h('option', { value: 'lock' }, '蒙版内 = 保护'),
            ),
          ),
          h('label', { className: 'mpl-field mpl-field-compact' },
            h('span', null, '容差'),
            h('input', {
              type: 'number', min: 0, max: 255, value: form.tolerance,
              onChange: function (event) { setField('tolerance', event.target.value) },
            }),
          ),
          h('label', { className: 'mpl-field mpl-field-compact' },
            h('span', null, '蒙版阈值'),
            h('input', {
              type: 'number', min: 0, max: 255, value: form.maskThreshold,
              onChange: function (event) { setField('maskThreshold', event.target.value) },
            }),
          ),
          h('label', { className: 'mpl-check' },
            h('input', {
              type: 'checkbox', checked: form.ignoreAlpha,
              onChange: function (event) { setField('ignoreAlpha', event.target.checked) },
            }),
            h('span', null, '忽略 alpha'),
          ),
        ),
        h(Field, {
          label: '说明（可选）',
          value: form.label,
          placeholder: '例如：只缩小主体，背景光影不动',
          onChange: function (value) { setField('label', value) },
        }),
        h('div', { className: 'mpl-form-foot' },
          h('button', { className: 'mpl-btn mpl-primary', type: 'button', onClick: run, disabled: busy }, busy ? '校验中…' : '开始校验'),
          h('span', { className: 'mpl-hint' }, '路径按宿主进程 cwd 解析；只接受 PNG。'),
        ),
      ),

      h('div', { className: 'mpl-card mpl-preview-card' },
        h('div', { className: 'mpl-preview-head' },
          h('h4', null, '差异热力图'),
          current && current.heatmapUrl
            ? h('a', { className: 'mpl-link mpl-link-quiet', href: current.heatmapUrl, target: '_blank', rel: 'noreferrer' }, '原图 ↗')
            : null,
        ),
        current && current.heatmapUrl
          ? h('div', { className: 'mpl-preview' },
              h('img', { src: current.heatmapUrl, alt: '蒙版外差异热力图' }),
              h('div', { className: 'mpl-legend' },
                h('span', null, h('i', { className: 'mpl-swatch', style: { background: '#0c0e12' } }), '未变'),
                h('span', null, h('i', { className: 'mpl-swatch', style: { background: '#f59e0b' } }), '小变化'),
                h('span', null, h('i', { className: 'mpl-swatch', style: { background: '#ef4444' } }), '大变化'),
                h('span', null, h('i', { className: 'mpl-swatch', style: { background: '#161e2a' } }), '可编辑区'),
              ),
            )
          : h('div', { className: 'mpl-empty mpl-empty-preview' }, '校验完成后，这里显示蒙版外的差异热力图。'),
        current ? h('div', { className: 'mpl-proof' },
          h('div', { className: 'mpl-proof-row' },
            h('span', null, '像素证明'),
            h('code', null, current.protectedDigestEqual === true ? '相等 · ' : current.protectedDigestEqual === false ? '不同 · ' : ''),
            h('code', null, shortHash(current.proofDigest)),
          ),
          h('div', { className: 'mpl-proof-row' },
            h('span', null, '输出目录'),
            h('code', null, current.outputDir),
          ),
          h('div', { className: 'mpl-proof-links' },
            h('a', { className: 'mpl-link mpl-link-quiet', href: current.reportUrl, target: '_blank', rel: 'noreferrer' }, 'report.html'),
            h('a', { className: 'mpl-link mpl-link-quiet', href: current.jsonUrl, target: '_blank', rel: 'noreferrer' }, 'report.json'),
            current.heatmapUrl ? h('a', { className: 'mpl-link mpl-link-quiet', href: current.heatmapUrl, target: '_blank', rel: 'noreferrer' }, 'heatmap.png') : null,
          ),
        ) : null,
      ),
    ),

    h('div', { className: 'mpl-card' },
      h('div', { className: 'mpl-list-head' },
        h('h4', null, '最近校验'),
        h('span', { className: 'mpl-hint' }, records.length + ' 条'),
      ),
      h(Records, { records: records, selected: current ? current.id : null, onSelect: setSelected }),
    ),
  )
}

function apply(ctx) {
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mask-pixel-lock'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'mask-pixel-lock', order: 31, label: '像素锁' },
        Panel,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-mask-pixel-lock] could not register the 像素锁 view; the tool still runs on the host', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-mask-pixel-lock',
  inject: ['slots'],
  apply: apply,
}
