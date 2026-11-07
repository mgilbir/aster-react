/**
 * The format of a guide's labels, against the pinned real Vega, in this process, over generated guides.
 *
 * vega gives an axis's `format` and `formatType` to its AxisTicks operator and a legend's to its LegendEntries operator, as the values
 * they hold (a signal's whatever its type), and those read them through the scale's label format: a time multi-format on a calendar
 * (a falsy specifier is the default one, an object overrides it per unit, anything else is refused), a span-aware number format on a
 * continuous scale, a plain number format elsewhere when there is a specifier, and the text of the value otherwise. A specifier the
 * format refuses (`zzz%%`, `NaN`, `[object Object]`) makes the operator throw: vega logs it once, the pass stops there (the guide and
 * what comes after it are not made; a gradient whose labels are ranked last keeps its gradient and title), and the caption of a guide
 * whose group item holds a format the caption's format refuses is not written at all. A title's text, or a label's, may call the
 * format functions (`format`, `timeFormat`, `utcFormat`) or a function the host registered (a Vega-Lite custom format type).
 *
 * Generated: axes over linear, log, band, time and utc scales; legends of symbols, sizes, gradients over numbers and dates, and bands of
 * discretizing scales; titles; each with a format and a format type drawn from literals and signals (valid, refused, of every type),
 * in the view or in a group, with other marks and guides around it. Compared: the picture (strict canonicalizer), what was logged
 * (count, class and text), and the evaluation of the chart with the incremental engine, twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, registerExpressionFunction, renderSceneToSvg, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

/** A custom format type, as Vega-Lite compiles one: a function the host registers, which refuses what it cannot format. */
const custom = (v: unknown, spec?: unknown): string => {
  if (spec === 'bad') throw new Error(`custom format refused ${String(v)}`)
  return `<${String(spec ?? '')}:${String(v)}>`
}
const offs: Array<() => void> = []
beforeAll(() => {
  ;(vega as unknown as { expressionFunction: (n: string, f: unknown) => void }).expressionFunction('asterCustomFormat', custom)
  offs.push(registerExpressionFunction('asterCustomFormat', custom as never))
})
afterAll(() => { for (const off of offs) off() })

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = { level() { return 2 }, error: (...a: unknown[]) => { errors.push(String(a[0])); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

type Outcome = { svg?: string; threw?: string; errors: string[] }
const logInto = (errors: string[]) => ({ error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} })
function onAster(spec: Spec): Outcome {
  const errors: string[] = []
  try { return { svg: renderSpec(structuredClone(spec) as never, { logger: logInto(errors) } as never), errors } } catch (e) { return { threw: (e as Error).message, errors } }
}
function onChart(chart: ReturnType<typeof compileChart>): Outcome {
  const errors: string[] = []
  try { return { svg: renderSceneToSvg(evaluateChart(chart, { logger: logInto(errors) } as never)), errors } } catch (e) { return { threw: (e as Error).message, errors } }
}

const SCALES: Spec[] = [
  { name: 'x', type: 'linear', domain: [0, 4], range: [0, 90] },
  { name: 'l', type: 'log', domain: [1, 1000], range: [0, 90] },
  { name: 'b', type: 'band', domain: ['a', 'b', 'c'], range: [0, 90] },
  { name: 't', type: 'time', domain: [0, 4e10], range: [0, 90] },
  { name: 'u', type: 'utc', domain: [1e11, 1e11 + 9e8], range: [0, 90] },
  { name: 'c', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] },
  { name: 'g', type: 'linear', domain: [0, 4], range: ['white', 'black'] },
  { name: 'tg', type: 'time', domain: [0, 4e10], range: ['white', 'black'] },
  { name: 'q', type: 'quantize', domain: [0, 4], range: ['#eee', '#9bd', '#06c'] },
  { name: 'th', type: 'threshold', domain: [1, 2], range: ['#eee', '#9bd', '#06c'] },
  { name: 'sz', type: 'linear', domain: [0, 4], range: [10, 200] },
]
const AXIS_SCALES = ['x', 'l', 'b', 't', 'u']
const LEGENDS: Spec[] = [{ fill: 'c' }, { fill: 'g' }, { fill: 'tg' }, { fill: 'q' }, { fill: 'th' }, { size: 'sz' }, { stroke: 'g', type: 'symbol' }]

/** Format specifiers: valid and refused, for numbers and for dates, and values that are no specifier. */
const LITERALS: unknown[] = ['.2f', ',d', '$.1s', '.0%', 'zzz%%', '.2q', '%Y', '%b %d', '%Q%', '', 42, 0, { year: '%y' }, { month: '%b', year: '%Y' }, { foo: 1 }]
/** Signals that hold a specifier, or something else (a number, NaN, an object, an array, a boolean, null), or throw. */
const SIGNALS: string[] = ["'.1f'", "'zzz%%'", "'%Y'", '0/0', '42', '{}', "{year: '%y'}", '[1]', 'true', 'false', 'null', "''", 'fmt', 'null.x',
  "timeUnitSpecifier(['year', 'month'])", "timeUnitSpecifier(['year', 'bogus'])", "timeUnitSpecifier(['week', 'month'])"]
const TYPES: unknown[] = ['number', 'time', 'utc', 'asterCustomFormat', 'nosuch', { signal: "'time'" }, { signal: "'utc'" }, { signal: "'number'" }, { signal: 'null' }]

function format(r: Rng): Spec {
  const out: Spec = {}
  if (r.chance(0.9)) out.format = r.chance(0.5) ? r.pick(LITERALS) : { signal: r.pick(SIGNALS) }
  if (r.chance(0.5)) out.formatType = r.pick(TYPES)
  // (the other signals the guide's ticks or entries operator is given, which throw before the format is read)
  if (r.chance(0.08)) out[r.pick(['tickCount', 'values', 'tickMinStep', 'symbolLimit'])] = { signal: 'null.y' }
  return out
}

/** A title, or a label text, that calls a format function: the built-in ones and the host's. */
function formatCall(r: Rng, value: string): string {
  const spec = r.pick(["'.2f'", "'zzz%%'", "'%Y'", "'%Q%'", '0/0', '{}', "{year: '%y'}", 'fmt', "'bad'", "''"])
  return `${r.pick(['format', 'timeFormat', 'utcFormat', 'asterCustomFormat'])}(${value}, ${spec})`
}

function guide(r: Rng, scope: Spec): string {
  const kind = r.pick(['axis', 'axis', 'legend', 'legend', 'title'])
  if (kind === 'axis') {
    const a: Spec = { scale: r.pick(AXIS_SCALES), orient: r.pick(['bottom', 'left', 'top', 'right']), ...format(r) }
    if (r.chance(0.3)) a.title = 'axis'
    if (r.chance(0.2)) a.encode = { labels: { update: { text: { signal: formatCall(r, 'datum.value') } } } }
    if (r.chance(0.2)) a.values = r.pick([[1, 2], [0, 1e10, 2e10]])
    ;((scope.axes ??= []) as Spec[]).push(a)
  } else if (kind === 'legend') {
    const l: Spec = { ...r.pick(LEGENDS), ...format(r) }
    if (r.chance(0.3)) l.title = 'legend'
    if (r.chance(0.2)) l.orient = r.pick(['left', 'top', 'bottom'])
    if (r.chance(0.15)) l.encode = { labels: { update: { text: { signal: formatCall(r, 'datum.value') } } } }
    ;((scope.legends ??= []) as Spec[]).push(l)
  } else {
    scope.title = r.chance(0.6) ? { text: { signal: formatCall(r, r.pick(['3.5', '1e10', '0/0'])) } } : { text: 'T', subtitle: { signal: formatCall(r, '2') } }
  }
  return kind
}

const rect = (fill: string): Spec => ({ type: 'rect', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'a' }, width: { value: 6 }, height: { value: 6 }, fill: { value: fill } } } })

function specOf(r: Rng): { spec: Spec; kinds: string[] } {
  const kinds: string[] = []
  const view: Spec = {
    width: 90, height: 50, padding: 4, autosize: r.pick(['none', 'pad']),
    signals: [{ name: 'fmt', value: r.pick(['.1f', 'zzz%%', '%Y', null, 3]) }],
    scales: SCALES,
    data: [{ name: 'd', values: [{ a: 1 }, { a: 3 }] }],
    marks: [rect('teal')],
  }
  // the guide in the view, or in a group (with marks before and after it, and more guides around it)
  const inGroup = r.chance(0.35)
  const scope: Spec = inGroup ? { type: 'group', encode: { update: { x: { value: 5 }, width: { value: 60 }, height: { value: 30 } } }, marks: [rect('navy')] } : view
  for (let i = r.between(1, 3); i > 0; i--) kinds.push(guide(r, scope))
  if (inGroup) (view.marks as Spec[]).push(scope, rect('orange'))
  if (inGroup && r.chance(0.5)) kinds.push(guide(r, view))
  return { spec: view, kinds }
}

describe("a guide's format is read as vega reads it", () => {
  it(`${scaled(400)} generated guides with formats`, { timeout: 600_000 }, async () => {
    const r = makeRng(0xf0a7)
    const bad: string[] = []
    let logged = 0
    let refusedFormat = 0
    let drawn = 0
    for (let c = 0; c < scaled(400); c++) {
      const { spec } = specOf(r)
      const tag = `#${c} ${JSON.stringify({ axes: spec.axes, legends: spec.legends, title: spec.title, group: (spec.marks as Spec[])[1] })}`
      const want = await onVega(spec)
      const got = onAster(spec)
      const chart = compileChart(structuredClone(spec) as never)
      const first = onChart(chart)
      const again = onChart(chart)
      if (JSON.stringify(first) !== JSON.stringify(got)) { bad.push(`${tag}: the evaluation with the incremental engine differs: ${JSON.stringify([got.threw, got.errors, first.threw, first.errors])}`); continue }
      if (JSON.stringify(again) !== JSON.stringify(first)) { bad.push(`${tag}: the second evaluation differs: ${JSON.stringify([first.errors, again.errors])}`); continue }
      if (got.threw !== undefined) { bad.push(`${tag}: aster threw ${got.threw} (vega logged ${JSON.stringify(want.errors)})`); continue }
      if (want.errors.length) logged++
      if (want.errors.some((e) => e.includes('invalid format') || e.includes('Invalid time multi-format'))) refusedFormat++
      if (JSON.stringify(got.errors) !== JSON.stringify(want.errors)) { bad.push(`${tag}: vega logged ${JSON.stringify(want.errors)}, aster ${JSON.stringify(got.errors)}`); continue }
      drawn++
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg!))
      if (d.length) bad.push(`${tag}: ${d.slice(0, 3).join(' | ')}`)
    }
    expect(bad, `${bad.length} of ${scaled(400)} differ:\n${bad.slice(0, 8).join('\n')}`).toEqual([])
    // (not vacuous: many specs make vega log a refused format, and many are drawn without an error)
    expect(refusedFormat).toBeGreaterThan(scaled(400) * 0.15)
    expect(drawn - logged).toBeGreaterThan(scaled(400) * 0.2)
  })
})
