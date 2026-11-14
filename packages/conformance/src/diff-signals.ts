/**
 * The signal phase of the incremental-diff gate: a generated sequence of signal writes through one chart session, as `<Chart>`
 * drives it on every pointer move, a bound input or a selection, compared after every step with a chart compiled and evaluated
 * afresh with the same input. What is compared is everything a host can read of an evaluation: the SVG, the scene itself
 * (normalised: every own property of every node, the generation stamps aside, and the order of each node's keys), the datasets and
 * the signal values the scene carries, what the hit index finds on a grid of points (query, queryMark, pick and tooltip, by the item's place in the scene)
 * and the accessible tree (as it is, and with every mark of more than two items summarised as one node).
 *
 * The writes: every top-level signal the spec declares (but the view's own size, padding, autosize and background), each given
 * values of its own kind -- a number near its value (a range binding's range), a boolean, a binding's option, a pair for a pair,
 * a datum, a point and null for what a pointer handler writes -- and every Vega-Lite selection store, given tuples made from the
 * rows (a point selection's values, an interval's extents). Each step writes one to three of them; the last step writes back
 * the first values.
 */
import { buildA11yTree, compileChart, datasetsOfScene, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import type { RuntimeInput, SceneGroup, SceneNode, SceneRoot, VgSpec } from '@aster-charts/core'
import { buildHitIndex } from '@aster-charts/core/hit'
import { createChartSession } from '@aster-charts/core/dom'
import { canonicalizeSvg } from './normalize.js'

type Row = Record<string, unknown>
type Rand = () => number

/** The view's own signals: writing them is a change of size, which the row phase and the sweeps cover. */
const VIEW_SIGNALS = new Set(['width', 'height', 'padding', 'autosize', 'background'])

/** Scene keys that say how a node was made, not what it is: the generation stamps and the caches renderers leave on items. */
const VOLATILE = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source', '__editGen', '__engineItems'])

/** A value as JSON-able data, every own enumerable key sorted (a cycle or a very deep value ends in a marker). */
function normalise(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'bigint') return `[${v}n]`
  if (typeof v === 'function') return '[fn]'
  if (typeof v === 'symbol') return '[symbol]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = normalise(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (VOLATILE.has(k)) continue
    const n = normalise((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}

interface Write { name: string; kind: 'signal' | 'store'; values: (rand: Rand) => unknown }

const pick = <T>(rand: Rand, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

/** A random row of the rows, or `{}`. */
const rowOf = (rand: Rand, rows: readonly Row[]): Row => (rows.length ? pick(rand, rows) : {})

/** The numbers the rows hold in `field` (a plain name), for the extents of an interval and the values near a signal's. */
function numbersIn(rows: readonly Row[], field: string): number[] {
  const out: number[] = []
  for (const r of rows) { const v = r[field]; if (typeof v === 'number' && Number.isFinite(v)) out.push(v) }
  return out
}

/** The values a top-level signal is written with, by what it is (its value, its binding, its handlers). */
function signalWrite(def: Record<string, unknown>, rows: readonly Row[], view: { width: number; height: number }): Write {
  const name = String(def.name)
  const value = def.value
  const bind = (def.bind ?? null) as Record<string, unknown> | null
  const pointer = Array.isArray(def.on) && def.on.length > 0
  const handlers = JSON.stringify(def.on ?? '')
  return {
    name,
    kind: 'signal',
    values: (rand) => {
      if (bind && Array.isArray(bind.options) && bind.options.length) return pick(rand, bind.options)
      if (bind && bind.input === 'range') {
        const min = typeof bind.min === 'number' ? bind.min : 0
        const max = typeof bind.max === 'number' ? bind.max : 100
        const step = typeof bind.step === 'number' && bind.step > 0 ? bind.step : (max - min) / 100
        return Math.min(max, min + Math.round((rand() * (max - min)) / step) * step)
      }
      if (bind && bind.input === 'checkbox') return rand() < 0.5
      if (typeof value === 'boolean') return rand() < 0.5
      if (typeof value === 'number') return pick(rand, [value, value * (0.5 + rand()), Math.round(rand() * Math.max(10, Math.abs(value) * 2)), 0])
      if (Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === 'number')) {
        const a = rand() * view.width
        const b = rand() * view.width
        return pick(rand, [[Math.min(a, b), Math.max(a, b)], value, []])
      }
      if (typeof value === 'string') return pick(rand, [value, '', 'x'])
      if (pointer) {
        // what a pointer handler writes: a number (a coordinate, an inverted value), a datum, a point, a row's field, or null
        const row = rowOf(rand, rows)
        const numericFields = Object.keys(row).filter((k) => typeof row[k] === 'number')
        const choices: unknown[] = [null, rand() * view.width, { x: rand() * view.width, y: rand() * view.height }]
        if (/datum/.test(handlers)) choices.push(row)
        if (numericFields.length) choices.push(row[pick(rand, numericFields)])
        return pick(rand, choices)
      }
      return pick(rand, [value ?? null, null])
    },
  }
}

/** A Vega-Lite selection's store: tuples made from the rows, as the selection's handlers make them (see the `_tuple_fields` signal). */
function storeWrite(store: string, signals: readonly Record<string, unknown>[], rows: readonly Row[]): Write | null {
  const sel = store.slice(0, -'_store'.length)
  const fieldsDef = signals.find((s) => s.name === `${sel}_tuple_fields`)
  const fields = Array.isArray(fieldsDef?.value) ? (fieldsDef!.value as Array<{ field?: unknown; type?: unknown }>) : null
  if (fields === null || !fields.length || fields.some((f) => typeof f.field !== 'string')) return null
  // the unit the selection lives in: the one its tuple names (`unit: "layer_0"`), else the one any of its handlers name
  const text = JSON.stringify(signals.filter((s) => typeof s.name === 'string' && (s.name as string).startsWith(sel)))
  const unit = /unit\s*:\s*\\?"([^"\\]+)\\?"/.exec(text)?.[1] ?? /\\"unit\\"\s*:\s*\\"([^"\\]+)/.exec(text)?.[1] ?? ''
  return {
    name: store,
    kind: 'store',
    values: (rand) => {
      const n = pick(rand, [0, 1, 1, 2])
      const tuples: Row[] = []
      for (let k = 0; k < n; k++) {
        const values = fields.map((f) => {
          const field = f.field as string
          if (f.type === 'R' || f.type === 'R-RE' || f.type === 'R-LE' || f.type === 'R-E') {
            const xs = numbersIn(rows, field)
            if (!xs.length) return [0, 1]
            const a = pick(rand, xs)
            const b = pick(rand, xs)
            return [Math.min(a, b), Math.max(a, b)]
          }
          return rowOf(rand, rows)[field]
        })
        tuples.push({ unit, fields, values })
      }
      return tuples
    },
  }
}

/** Every node of the scene by its place (`0.3.1`): what the hit index finds is compared by where it is. */
function placesOf(scene: SceneRoot): Map<object, string> {
  const out = new Map<object, string>()
  const walk = (nodes: readonly SceneNode[] | undefined, at: string): void => {
    ;(nodes ?? []).forEach((n, i) => {
      const here = `${at}.${i}`
      if (n !== null && typeof n === 'object' && !out.has(n)) out.set(n, here)
      walk((n as SceneGroup).items, here)
    })
  }
  walk(scene.items, 'r')
  return out
}

/** What the hit index finds at a grid of points and a few random ones, by place. */
function hits(scene: SceneRoot, points: ReadonlyArray<readonly [number, number]>): string[] {
  const index = buildHitIndex(scene)
  const places = placesOf(scene)
  const name = (t: { item: object; marktype: string; kind?: string; fromData?: boolean } | null): string =>
    t === null ? '-' : `${places.get(t.item) ?? '?'}/${t.marktype}/${t.kind ?? ''}/${t.fromData === true ? 'd' : ''}`
  return points.map(([x, y]) => [index.query(x, y), index.queryMark(x, y), index.pick(x, y), index.tooltip(x, y)].map(name).join(' '))
}

/** The order of every node's own keys (the generation stamps and the renderers' caches aside): a host that lists them sees it. */
function keyOrders(v: unknown, out: string[], depth = 0): string[] {
  // (an object held in two places is listed in both: which objects a scene shares is not what this compares; a cycle ends at the depth)
  if (v === null || typeof v !== 'object' || depth > 40) return out
  if (Array.isArray(v)) { for (const x of v) keyOrders(x, out, depth + 1); return out }
  const keys = Object.keys(v).filter((k) => !VOLATILE.has(k))
  out.push(keys.join(','))
  for (const k of keys) keyOrders((v as Record<string, unknown>)[k], out, depth + 1)
  return out
}

/** What a host reads of an evaluation, normalised. */
function readOf(scene: SceneRoot, points: ReadonlyArray<readonly [number, number]>): Record<string, string> {
  const svg = canonicalizeSvg(renderSceneToSvg(scene))
  const datasets: Record<string, unknown> = {}
  for (const [k, v] of datasetsOfScene(scene)) datasets[k] = normalise(v)
  return {
    svg: `${svg.root}\u0000${svg.records.join('\u0000')}`,
    scene: JSON.stringify(normalise(scene)),
    keys: keyOrders(scene.items, []).join('\n'),
    datasets: JSON.stringify(datasets),
    signals: JSON.stringify(normalise((scene as unknown as { signalParams?: unknown }).signalParams)),
    hits: hits(scene, points).join('\n'),
    a11y: JSON.stringify(normalise(buildA11yTree(scene))),
    // (a mark of more items than the threshold is one node, its box the union of its items')
    a11ySummary: JSON.stringify(normalise(buildA11yTree(scene, new Map(), { summaryThreshold: 2 }))),
  }
}

/** Where two texts first differ, line by line, for the report: the session's line and the fresh chart's. */
function firstDifference(inc: string, fresh: string): string {
  const a = inc.split('\n')
  const b = fresh.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return ` (line ${i + 1}: session ${JSON.stringify((a[i] ?? '').slice(0, 160))}, fresh ${JSON.stringify((b[i] ?? '').slice(0, 160))})`
  }
  return ''
}

interface SignalPhaseResult { compared: number; skipped: number; mismatch?: string }

/**
 * The signal phase for one spec: null when it has nothing to write. `data` is the spec's inline dataset, given to every step as the
 * same array (as a host that changes only signals does).
 */
export function signalChangesMatch(spec: Record<string, unknown>, data: { name: string; rows: Row[] } | null, rand: Rand, steps = 6): SignalPhaseResult | null {
  // `now()` is the wall clock: two evaluations of a spec that reads it (an animation's last tick) differ by the milliseconds between
  // them, whatever either kept. The clock stands still while the phase runs, so what is compared is what the evaluations made of it.
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  try {
    return signalSteps(spec, data, rand, steps)
  } finally {
    Date.now = realNow
  }
}

function signalSteps(spec: Record<string, unknown>, data: { name: string; rows: Row[] } | null, rand: Rand, steps: number): SignalPhaseResult | null {
  const signals = ((spec.signals ?? []) as Array<Record<string, unknown>>).filter((s) => typeof s.name === 'string')
  const datasets = ((spec.data ?? []) as Array<{ name?: unknown }>).map((d) => d.name).filter((n): n is string => typeof n === 'string')
  const rows = data?.rows ?? []
  const view = { width: typeof spec.width === 'number' ? spec.width : 200, height: typeof spec.height === 'number' ? spec.height : 200 }
  const writes: Write[] = []
  for (const s of signals) if (!VIEW_SIGNALS.has(s.name as string)) writes.push(signalWrite(s, rows, view))
  for (const d of datasets) if (d.endsWith('_store')) { const w = storeWrite(d, signals, rows); if (w) writes.push(w) }
  if (!writes.length) return null

  const session = createChartSession()
  const signalValues: Record<string, unknown> = {}
  const storeValues: Record<string, unknown[]> = {}
  const inputOf = (): RuntimeInput => ({
    ...(data !== null || Object.keys(storeValues).length ? { data: { ...(data !== null ? { [data.name]: data.rows } : {}), ...storeValues } } : {}),
    ...(Object.keys(signalValues).length ? { signals: { ...signalValues } } : {}),
  })
  const attempt = <T>(f: () => T): { ok: true; value: T } | { ok: false; error: string } => {
    try { return { ok: true, value: f() } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  const first = attempt(() => session.evaluate(spec as unknown as VgSpec, inputOf()))
  if (!first.ok) return { compared: 0, skipped: steps + 1 }
  // the points the hit index is asked about: a grid over the whole SVG and a few anywhere in it
  const width = (first.value as { width?: number }).width ?? view.width
  const height = (first.value as { height?: number }).height ?? view.height
  const points: Array<[number, number]> = []
  for (let i = 0; i < 7; i++) for (let j = 0; j < 5; j++) points.push([((i + 0.5) / 7) * width, ((j + 0.5) / 5) * height])
  for (let k = 0; k < 8; k++) points.push([rand() * width, rand() * height])

  const initial: Array<[Write, unknown]> = []
  let compared = 0
  let skipped = 0
  for (let step = 0; step <= steps; step++) {
    let what: string
    if (step < steps) {
      const n = 1 + Math.floor(rand() * Math.min(3, writes.length))
      const chosen = new Set<Write>()
      while (chosen.size < n) chosen.add(pick(rand, writes))
      const parts: string[] = []
      for (const w of chosen) {
        const v = w.values(rand)
        if (!initial.some(([x]) => x === w)) initial.push([w, w.kind === 'store' ? storeValues[w.name] : signalValues[w.name]])
        if (w.kind === 'store') storeValues[w.name] = v as unknown[]
        else signalValues[w.name] = v
        parts.push(`${w.name}=${JSON.stringify(v)?.slice(0, 60)}`)
      }
      what = `step ${step + 1}: ${parts.join(', ')}`
    } else {
      // back to where the sequence started: what was kept since must be what a fresh chart makes of the first input
      for (const [w, v] of initial) {
        if (w.kind === 'store') { if (v === undefined) delete storeValues[w.name]; else storeValues[w.name] = v as unknown[] }
        else if (v === undefined) delete signalValues[w.name]
        else signalValues[w.name] = v
      }
      what = 'back to the first values'
    }
    const input = inputOf()
    const inc = attempt(() => readOf(session.evaluate(spec as unknown as VgSpec, input), points))
    const full = attempt(() => readOf(evaluateChart(compileChart(spec as unknown as VgSpec), input), points))
    if (!inc.ok && !full.ok) { skipped++; continue }
    if (!inc.ok || !full.ok) return { compared, skipped, mismatch: `${what}: only the ${inc.ok ? 'fresh chart' : 'session'} threw (${(inc.ok ? (full as { error: string }).error : inc.error).slice(0, 120)})` }
    for (const key of Object.keys(full.value)) {
      if (inc.value[key] !== full.value[key]) return { compared, skipped, mismatch: `${what}: the ${key} differs${firstDifference(inc.value[key]!, full.value[key]!)}` }
    }
    compared++
  }
  return { compared, skipped }
}
