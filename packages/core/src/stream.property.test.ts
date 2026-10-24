/**
 * Stream batch-order property test (audit C18, C91).
 *
 * A random sequence of push / flush / pause / resume calls runs against a real
 * `createChartStream` under every backpressure policy. The reference applies the
 * SAME surviving batches one at a time (snapshot, then append, then the
 * explicit pulse, then signals/size/domainRaw) to plain row arrays and
 * evaluates a freshly compiled chart from scratch. The stream's flushed scene
 * must deep-equal that reference, whatever the policy folded or dropped.
 *
 * Policy semantics the reference encodes:
 *  - coalesce: nothing is lost, the whole queue folds into one flush;
 *  - drop-oldest / drop-newest: whole batches are discarded, the rest applies;
 *  - error: an over-capacity push throws and the batch is not queued.
 *
 * Explicit pulses and in-place row edits are only generated when the policy
 * cannot lose a batch (a lost pulse would be a host lie, not a stream bug).
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { renderSceneToSvg } from './index.js'
import { diffRows } from './pulse.js'
import { AsterStreamBackpressureError, createChartStream, type StreamBatch, type StreamPolicy, type StreamPulse } from './stream.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Row = { id: number; x: number; v: number; g: string }
type Rnd = () => number

function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, a: readonly T[]): T => a[Math.floor(r() * a.length)]!
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))

const SKIP_KEYS = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined) return undefined
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}
function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: expected ${JSON.stringify(a)?.slice(0, 120)} got ${JSON.stringify(b)?.slice(0, 120)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length expected ${a.length} got ${b.length}`
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d }
    return null
  }
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}
const key = (scene: SceneRoot): { n: unknown; svg: string } => ({ n: norm(scene), svg: renderSceneToSvg(scene) })

// ---------------------------------------------------------------------------
// Specs: a plain scatter, a grouped aggregate, and a window (re-derives).
// ---------------------------------------------------------------------------

const common = {
  width: 240, height: 120, padding: 5, autosize: 'none',
  signals: [{ name: 'thr', value: 2 }, { name: 'sig', value: 0 }],
  data: [{ name: 't' }, { name: 'u' }],
}
const symbols = (data: string, x: string, y: string): unknown => ({
  type: 'symbol', from: { data }, encode: { update: { x: { scale: 'sx', field: x }, y: { scale: 'sy', field: y } } },
})
export const SPECS: Record<string, unknown> = {
  scatter: {
    ...common,
    data: [{ name: 't' }, { name: 'u' }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: 'datum.v > thr' }, { type: 'formula', expr: 'datum.x + sig', as: 'f' }] }],
    scales: [
      { name: 'sx', type: 'linear', domain: { data: 'd', field: 'f' }, range: 'width', zero: false },
      { name: 'sy', type: 'linear', domain: { fields: [{ data: 'd', field: 'v' }, { data: 'u', field: 'v' }] }, range: 'height' },
    ],
    marks: [symbols('d', 'f', 'v'), symbols('u', 'x', 'v')],
  },
  aggregate: {
    ...common,
    data: [{ name: 't' }, { name: 'u' }, { name: 'a', source: 't', transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'x'], ops: ['sum', 'max'], as: ['s', 'm'] }] }],
    scales: [
      { name: 'sx', type: 'linear', domain: { data: 'a', field: 'm' }, range: 'width' },
      { name: 'sy', type: 'linear', domain: { data: 'a', field: 's' }, range: 'height', nice: true },
    ],
    marks: [symbols('a', 'm', 's'), symbols('u', 'x', 'v')],
  },
  window: {
    ...common,
    data: [{ name: 't' }, { name: 'u' }, { name: 'w', source: 't', transform: [{ type: 'window', groupby: ['g'], ops: ['sum', 'row_number'], fields: ['v', null], as: ['cs', 'rn'] }] }],
    scales: [
      { name: 'sx', type: 'linear', domain: { data: 'w', field: 'rn' }, range: 'width' },
      { name: 'sy', type: 'linear', domain: { data: 'w', field: 'cs' }, range: 'height' },
    ],
    marks: [symbols('w', 'rn', 'cs'), symbols('u', 'x', 'v')],
  },
}

// ---------------------------------------------------------------------------
// Reference: apply surviving batches one at a time to plain arrays.
// ---------------------------------------------------------------------------

interface World {
  data: Record<'t' | 'u', Row[]>
  signals: Record<string, unknown>
  width?: number
  height?: number
  domainRaw: Record<string, unknown[]>
}
const emptyWorld = (): World => ({ data: { t: [], u: [] }, signals: {}, domainRaw: {} })
const cloneWorld = (w: World): World => ({
  data: { t: w.data.t.slice(), u: w.data.u.slice() }, signals: { ...w.signals }, width: w.width, height: w.height,
  domainRaw: { ...w.domainRaw },
})

function applyOne(w: World, b: StreamBatch): void {
  for (const [n, rows] of Object.entries(b.data ?? {})) w.data[n as 't' | 'u'] = (rows as Row[]).slice()
  for (const [n, rows] of Object.entries(b.append ?? {})) w.data[n as 't' | 'u'] = [...w.data[n as 't' | 'u'], ...(rows as Row[])]
  // pulses carry no data of their own
  if (b.signals) Object.assign(w.signals, b.signals)
  if (b.width != null) w.width = b.width
  if (b.height != null) w.height = b.height
  for (const [n, d] of Object.entries(b.domainRaw ?? {})) { if (d == null) delete w.domainRaw[n]; else w.domainRaw[n] = d }
}

function reference(spec: unknown, w: World): SceneRoot {
  const input: RuntimeInput = {
    data: JSON.parse(JSON.stringify(w.data)),
    ...(Object.keys(w.signals).length ? { signals: { ...w.signals } } : {}),
    ...(w.width != null ? { width: w.width } : {}),
    ...(w.height != null ? { height: w.height } : {}),
    ...(Object.keys(w.domainRaw).length ? { domainRaw: w.domainRaw } : {}),
  }
  return evaluateChart(compileChart(structuredClone(spec) as VgSpec), input)
}

// ---------------------------------------------------------------------------
// Batch generator (the host's view = rows of every accepted push).
// ---------------------------------------------------------------------------

let nextId = 1
const genRow = (r: Rnd): Row => ({ id: nextId++, x: int(r, 0, 50), v: int(r, 0, 9), g: pick(r, ['A', 'B', 'C', 'D']) })
const genRows = (r: Rnd, n: number): Row[] => Array.from({ length: n }, () => genRow(r))

function toStreamPulse(prev: Row[], next: Row[]): StreamPulse | null {
  const d = diffRows(prev, next)
  if (!d) return null
  return {
    changed: d.changed,
    ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}),
    ...(d.addedRanges ? { added: d.addedRanges } : {}), ...(d.removedRanges ? { removed: d.removedRanges } : {}),
    ...(d.appendOnly ? { appendOnly: true, baseLength: d.baseLength } : {}),
  }
}

/** A new array: some rows edited (fresh objects), some reused, some dropped/inserted/swapped. */
function mutateRows(r: Rnd, rows: Row[], mode: string): Row[] {
  const out = rows.slice()
  if (mode === 'edit') {
    for (let k = 0; k < Math.max(1, int(r, 0, 3)) && out.length; k++) {
      const i = int(r, 0, out.length - 1)
      out[i] = { ...out[i]!, v: int(r, 0, 9), x: int(r, 0, 50) }
    }
  } else if (mode === 'remove') {
    if (out.length) out.splice(int(r, 0, out.length - 1), int(r, 1, 3))
  } else if (mode === 'insert') {
    out.splice(int(r, 0, out.length), 0, ...genRows(r, int(r, 1, 3)))
  } else if (mode === 'swap') {
    if (out.length > 1) { const i = int(r, 0, out.length - 2); [out[i], out[i + 1]] = [out[i + 1]!, out[i]!] }
  } else if (mode === 'fresh') {
    return genRows(r, int(r, 0, 12))
  }
  return out
}

type Mode = { policy: StreamPolicy; capacity: number; pulses: boolean }

function genBatch(r: Rnd, view: World, mode: Mode): { batch: StreamBatch; inPlace: boolean } {
  const kinds = ['append', 'append', 'append2', 'snapshot', 'snapshot', 'snapshot2', 'signals', 'size', 'domain', 'empty'] as string[]
  if (mode.pulses) kinds.push('snap+pulse', 'snap+pulse', 'append+pulse', 'edit+pulse', 'edit+pulse', 'edit+append', 'edit+append', 'edit+snap', 'pulse+twice')
  const kind = pick(r, kinds)
  const batch: StreamBatch = {}
  let inPlace = false
  const t = view.data.t
  switch (kind) {
    case 'append': batch.append = { t: genRows(r, int(r, 1, 6)) }; break
    case 'append2': batch.append = { t: genRows(r, int(r, 0, 4)), u: genRows(r, int(r, 1, 4)) }; break
    case 'snapshot': batch.data = { t: mutateRows(r, t, pick(r, ['edit', 'remove', 'insert', 'swap', 'fresh'])) }; break
    case 'snapshot2':
      batch.data = { t: mutateRows(r, t, 'edit'), u: mutateRows(r, view.data.u, pick(r, ['edit', 'remove', 'insert', 'fresh'])) }
      if (r() < 0.5) batch.append = { u: genRows(r, 2) }
      break
    case 'signals': batch.signals = pick(r, [{ sig: int(r, 0, 5) }, { thr: int(r, 0, 6) }, { sig: 1, thr: 3 }]); break
    case 'size': batch.width = int(r, 100, 300); if (r() < 0.5) batch.height = int(r, 60, 200); break
    case 'domain': batch.domainRaw = { sx: r() < 0.5 ? [0, int(r, 10, 60)] : null }; break
    case 'empty': break
    case 'snap+pulse': {
      const next = mutateRows(r, t, pick(r, ['edit', 'edit', 'remove', 'insert', 'swap']))
      batch.data = { t: next }
      const p = toStreamPulse(structuredClone(t), next)
      if (p) batch.pulse = { t: p }
      break
    }
    case 'append+pulse': {
      const rows = genRows(r, int(r, 1, 5))
      batch.append = { t: rows }
      batch.pulse = { t: { changed: [], appendOnly: true, baseLength: t.length, added: [[t.length, t.length + rows.length]] } }
      break
    }
    case 'edit+pulse': case 'edit+append': case 'edit+snap': {
      if (!t.length) { batch.append = { t: genRows(r, 3) }; break }
      const idx = [...new Set([int(r, 0, t.length - 1), int(r, 0, t.length - 1)])].sort((a, b) => a - b)
      for (const i of idx) { t[i]!.v = int(r, 0, 9); t[i]!.x = int(r, 0, 50) }
      inPlace = true
      batch.pulse = { t: { changed: idx } }
      if (kind === 'edit+append') batch.append = { t: genRows(r, int(r, 1, 4)) }
      if (kind === 'edit+snap') batch.data = { t: t.slice() }
      break
    }
    case 'pulse+twice': {
      // announce an in-place edit of an existing row together with an edit of
      // a row appended in the same batch (the second index lies in the added range)
      if (!t.length) { batch.append = { t: genRows(r, 3) }; break }
      const i = int(r, 0, t.length - 1)
      t[i]!.v = int(r, 0, 9)
      inPlace = true
      const rows = genRows(r, 3)
      rows[1]!.v = 9
      batch.append = { t: rows }
      batch.pulse = { t: { changed: [i, t.length + 1] } }
      break
    }
  }
  return { batch, inPlace }
}

// ---------------------------------------------------------------------------

const POLICIES: StreamPolicy[] = ['coalesce', 'drop-oldest', 'drop-newest', 'error']
const SEEDS = Number((typeof process !== 'undefined' ? process.env.ASTER_STREAM_SEEDS : undefined) ?? 25)
const OPS = 24
const TRACE = typeof process !== 'undefined' && !!process.env.ASTER_STREAM_TRACE
const ONE_SEED = typeof process !== 'undefined' && process.env.ASTER_STREAM_SEED ? Number(process.env.ASTER_STREAM_SEED) : null

function runSeed(seed: number, specName: string, policy: StreamPolicy, pulses: boolean): string | null {
  const r = mulberry32(seed * 7919 + policy.length)
  const capacity = pulses ? 1000 : pick(r, [1, 2, 3, 5])
  const mode: Mode = { policy, capacity, pulses }
  const spec = SPECS[specName]
  const stream = createChartStream(structuredClone(spec) as VgSpec, { policy, capacity })
  let committed = emptyWorld()           // state as of the last successful flush
  let queue: StreamBatch[] = []          // mirror of the surviving queue
  let view = emptyWorld()                // the host's own view (every accepted push)
  let dropped = 0
  let paused = false
  const log: string[] = []
  const trace: string[] = []
  const fail = (msg: string): string => `seed=${seed} spec=${specName} policy=${policy} pulses=${pulses} cap=${capacity}\n${msg}\nops: ${log.join(' ')}${TRACE ? `\n${trace.join('\n')}` : ''}`

  const doFlush = (): string | null => {
    const out = stream.flush()
    if (!out) return queue.length || !committed ? null : null
    const w = cloneWorld(committed)
    for (const b of queue) applyOne(w, b)
    let expected: SceneRoot
    try { expected = reference(spec, w) } catch (e) { return fail(`reference threw ${(e as Error).message}`) }
    const a = key(expected), b = key(out.scene)
    const d = firstDiff(a.n, b.n)
    if (d) return fail(`scene differs after flush of ${queue.length} batch(es): ${d}`)
    if (a.svg !== b.svg) return fail('svg differs')
    committed = w
    queue = []
    return null
  }

  stream.flush(); // prime (empty world)
  for (let step = 0; step < OPS; step++) {
    const op = pick(r, ['push', 'push', 'push', 'push', 'flush', 'flush', 'pause', 'resume'])
    log.push(op)
    if (op === 'pause') { paused = true; continue }
    if (op === 'resume') { paused = false; continue }
    if (op === 'flush') {
      if (TRACE) trace.push('flush')
      if (paused) continue
      const e = doFlush(); if (e) return e
      continue
    }
    const { batch, inPlace } = genBatch(r, view, mode)
    log.push(JSON.stringify(Object.keys(batch)))
    if (TRACE) trace.push(`push ${JSON.stringify(batch)}${inPlace ? `  [t after in-place edit: ${JSON.stringify(view.data.t)}]` : ''}`)
    const wasAcceptable = stream.canAccept()
    let accepted: boolean
    try { accepted = stream.push(batch) } catch (e) {
      if (!(e instanceof AsterStreamBackpressureError) || policy !== 'error') throw e
      accepted = false
    }
    // mirror
    if (policy === 'coalesce') { queue.push(batch) }
    else if (queue.length >= capacity) {
      if (policy === 'drop-newest' || policy === 'error') { dropped += policy === 'drop-newest' ? 1 : 0; if (accepted) return fail('push accepted over capacity') }
      else { while (queue.length >= capacity) { queue.shift(); dropped++ } queue.push(batch) }
    } else queue.push(batch)
    if ((policy === 'drop-newest' || policy === 'error') && wasAcceptable !== accepted) return fail(`canAccept()=${wasAcceptable} but push accepted=${accepted}`)
    if (accepted || policy === 'drop-oldest') applyOne(view, batch)
    if (!accepted && (policy === 'drop-newest' || policy === 'error')) {
      // the host never saw its batch applied: nothing to track
    }
    if (stream.stats().dropped !== dropped) return fail(`stats.dropped ${stream.stats().dropped} != ${dropped}`)
  }
  return doFlush()
}

describe('stream batch order (property)', () => {
  for (const specName of Object.keys(SPECS)) {
    for (const policy of POLICIES) {
      for (const pulses of [false, true]) {
        if (pulses && (policy === 'drop-oldest' || policy === 'drop-newest')) continue
        it(`${specName} / ${policy} / ${pulses ? 'explicit pulses + in-place edits' : 'snapshots and appends'}`, () => {
          const fails: string[] = []
          for (let s = ONE_SEED ?? 1; s <= (ONE_SEED ?? SEEDS) && fails.length < 2; s++) {
            const e = runSeed(s, specName, policy, pulses)
            if (e) fails.push(e)
          }
          expect(fails.join('\n---\n')).toBe('')
        })
      }
    }
  }
})
