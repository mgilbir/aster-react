// @vitest-environment jsdom
/**
 * A family of the engine chosen at runtime: a curve, a colour scheme or interpolator, a scale's range, a date format, a calendar or
 * colour expression function, a transform's parameters, each read from a signal (set by the host, or by a handler of the signal loop).
 * What the first value of the signal needs says nothing about what the next one needs, so `specNeeds` must name the whole family for
 * such a spec: a chart drawn with just the parts it names must equal the chart drawn with every part, for every value the signal
 * takes, including the values of other members of the family (parts-needed.testlib.ts: drawn from empty slots, the parts read
 * found one failure at a time, and the signal loop answering clicks over the view).
 */
import { describe, expect, it } from 'vitest'
import { specNeeds, type EnginePart } from '@aster-charts/core/lean'
import type { VgSpec } from '@aster-charts/core'
import { checkParts } from './parts-needed.testlib.js'

const POINTS = Array.from({ length: 12 }, (_, i) => ({ x: i, y: (i * 37) % 11, c: ['a', 'b', 'c'][i % 3], d: Date.UTC(2020, i, 1 + i), s: `2021-0${1 + (i % 9)}-1${i % 10}` }))
const VIEW = { width: 240, height: 120, padding: 4, autosize: 'none' }
const X = { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }
const Y = { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' }

interface Case {
  name: string
  /** the family the signal chooses within */
  family: EnginePart
  /** the spec, with `cycle` a handler that moves the signal on a click (else only the host sets it) */
  spec: (signal: string, cycle: boolean) => VgSpec
  /** the values the signal takes, the first one its own (often one that needs no part at all) */
  values: unknown[]
  /** whether the signal's first value draws without the family (so naming it is owed to the signal alone) */
  firstNeedsNone?: boolean
}

const signalled = (name: string, value: unknown, more: object = {}): object => ({ name, value, ...more })
/** A click on the view moves the signal to the next value (what a handler of the signal loop does). */
let cycle = true
const cycling = (name: string, values: unknown[]): object => (!cycle ? {} : {
  on: [{ events: 'click', update: values.map((v, i) => `${name} === ${JSON.stringify(v)} ? ${JSON.stringify(values[(i + 1) % values.length])} : `).join('') + JSON.stringify(values[0]) }],
})

/**
 * The signal `name`, moved on a click through `values` (any JSON values, arrays included: a counter signal steps through the list and
 * the signal reads the list at it), or only set by the host when `cycle` is off.
 */
const stepping = (name: string, values: unknown[]): object[] => (!cycle ? [signalled(name, values[0])] : [
  signalled(`${name}Step`, 0, { on: [{ events: 'click', update: `(${name}Step + 1) % ${values.length}` }] }),
  signalled(name, values[0], { update: `${JSON.stringify(values)}[${name}Step]` }),
])

/** an axis's formatType and format, which go together */
const FORMAT_PAIRS = [['number', ',.0f'], ['time', '%b %Y'], ['utc', '%Y-%m-%d'], ['time', '%a %d']]

const CURVES = ['linear', 'linear-closed', 'basis', 'basis-closed', 'basis-open', 'bundle', 'cardinal', 'cardinal-closed', 'cardinal-open',
  'catmull-rom', 'catmull-rom-closed', 'catmull-rom-open', 'monotone', 'natural', 'step', 'step-after', 'step-before']

const CASES: Case[] = [
  {
    name: 'interpolate of a line and an area by signal',
    family: 'curves',
    values: CURVES,
    firstNeedsNone: true,
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'linear', cycling(s, CURVES))], data: [{ name: 't', values: POINTS }], scales: [X, Y],
      marks: [
        { type: 'area', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, fill: { value: '#ccc' }, interpolate: { signal: s } } } },
        { type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'black' }, interpolate: { signal: s }, tension: { value: 0.3 } } } },
      ],
    } as VgSpec),
  },
  {
    name: 'a colour scheme by signal, from a list of colours to ramps',
    family: 'color',
    values: ['category10', 'tableau10', 'blues', 'viridis', 'redblue', 'rainbow'],
    firstNeedsNone: true,
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'category10', cycling(s, ['category10', 'blues', 'viridis']))], data: [{ name: 't', values: POINTS }],
      scales: [X, Y, { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: { scheme: { signal: s } } }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { scale: 'c', field: 'c' } } } }],
    } as VgSpec),
  },
  {
    name: "a scale's colour interpolator by signal",
    family: 'color',
    values: ['rgb', 'hcl', 'hcl-long', 'lab', 'hsl', 'hsl-long', 'cubehelix', 'cubehelix-long'],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'rgb', cycling(s, ['rgb', 'hcl', 'lab']))], data: [{ name: 't', values: POINTS }],
      scales: [X, Y, { name: 'c', type: 'linear', domain: { data: 't', field: 'y' }, range: ['#3366cc', '#ffcc00'], interpolate: { signal: s } }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 8 }, y: { scale: 'y', field: 'y' }, y2: { value: 120 }, fill: { scale: 'c', field: 'y' } } } }],
      legends: [{ fill: 'c' }],
    } as VgSpec),
  },
  {
    name: "a numeric scale's interpolator by signal, from number and round to colour spaces",
    family: 'color',
    values: ['number', 'round', 'hcl', 'rgb', 'lab'],
    firstNeedsNone: true,
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'number', cycling(s, ['number', 'hcl', 'round']))], data: [{ name: 't', values: POINTS }],
      scales: [X, Y, { name: 'w', type: 'linear', domain: { data: 't', field: 'y' }, range: [2, 30], interpolate: { signal: s } }],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, text: { scale: 'w', field: 'y' } } } }],
    } as VgSpec),
  },
  {
    name: "a continuous scale's range by signal, from numbers to colours",
    family: 'color',
    values: [[0, 50], [10, 90], ['#000', '#f00'], ['steelblue', 'orange', 'green']],
    firstNeedsNone: true,
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: stepping(s, [[0, 50], [10, 90], ['#000', '#f00'], ['steelblue', 'orange', 'green']]), data: [{ name: 't', values: POINTS }],
      scales: [X, Y, { name: 'v', type: 'linear', domain: { data: 't', field: 'y' }, range: { signal: s } }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 8 }, y: { scale: 'y', field: 'y' }, y2: { value: 120 }, fill: { scale: 'v', field: 'y' } } } }],
    } as VgSpec),
  },
  {
    name: "an axis's format and formatType by signal",
    family: 'time',
    values: FORMAT_PAIRS,
    firstNeedsNone: true,
    spec: (s, c) => (cycle = c, {
      // (a click moves the pair: a type and a format that do not go together are an error in vega too)
      ...VIEW, signals: [...stepping(`${s}Pair`, FORMAT_PAIRS), signalled(`${s}Type`, 'number', cycle ? { update: `${s}Pair[0]` } : {}), signalled(`${s}Format`, ',.0f', cycle ? { update: `${s}Pair[1]` } : {})], data: [{ name: 't', values: POINTS }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'd' }, range: 'width' }, Y],
      axes: [{ scale: 'x', orient: 'bottom', format: { signal: `${s}Format` }, formatType: { signal: `${s}Type` } }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'd' }, y: { scale: 'y', field: 'y' } } } }],
    } as VgSpec),
  },
  {
    name: 'a date format and a calendar unit from expressions',
    family: 'time',
    values: ['%Y', '%B %d', '%H:%M', '%x'],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, '%Y', cycling(s, ['%Y', '%B %d'])), signalled('unit', 'month')], data: [{ name: 't', values: POINTS, transform: [
        { type: 'formula', as: 'parsed', expr: "utcParse(datum.s, '%Y-%m-%d')" },
        { type: 'formula', as: 'next', expr: 'timeOffset(unit, datum.d, 1)' },
      ] }],
      scales: [X, Y],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, text: { signal: `timeFormat(datum.next, ${s}) + ' ' + utcFormat(datum.parsed, ${s})` } } } }],
    } as VgSpec),
  },
  {
    name: "scale() of a sequential colour scale in an expression",
    family: 'color',
    values: [0, 3, 7, 10],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 0, cycling(s, [0, 5, 10]))], data: [{ name: 't', values: POINTS }],
      scales: [X, Y, { name: 'c', type: 'sequential', domain: [0, 10], range: { scheme: 'viridis' } }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { signal: `scale('c', (datum.y + ${s}) % 10)` } } } }],
    } as VgSpec),
  },
  {
    name: 'aggregate ops by signal',
    family: 'aggregate',
    values: ['mean', 'sum', 'max', 'q1', 'distinct', 'stdev'],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'mean', cycling(s, ['mean', 'max', 'q1']))], data: [{ name: 't', values: POINTS, transform: [{ type: 'aggregate', groupby: ['c'], fields: ['y'], ops: [{ signal: s }], as: ['v'] }] }],
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
    } as VgSpec),
  },
  {
    name: 'window ops by signal',
    family: 'window',
    values: ['rank', 'row_number', 'sum', 'lag', 'cume_dist', 'first_value'],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [signalled(s, 'rank', cycling(s, ['rank', 'sum', 'lag']))], data: [{ name: 't', values: POINTS, transform: [{ type: 'window', sort: { field: 'x' }, ops: [{ signal: s }], fields: ['y'], as: ['w'] }] }],
      scales: [X, { name: 'y', type: 'linear', domain: { data: 't', field: 'w' }, range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'w' } } } }],
    } as VgSpec),
  },
  {
    name: 'bin, stack and impute parameters by signal',
    family: 'reshape',
    values: [['zero', 5, 'value'], ['center', 10, 'mean'], ['normalize', 20, 'max']],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: [
        signalled(`${s}Offset`, 'zero', cycling(`${s}Offset`, ['zero', 'center', 'normalize'])), signalled(`${s}Bins`, 5, cycling(`${s}Bins`, [5, 10, 20])),
        signalled(`${s}Method`, 'value', cycling(`${s}Method`, ['value', 'mean', 'max'])),
      ],
      data: [{ name: 't', values: POINTS, transform: [
        { type: 'bin', field: 'y', extent: [0, 11], maxbins: { signal: `${s}Bins` } },
        { type: 'impute', field: 'y', key: 'x', groupby: ['c'], method: { signal: `${s}Method` }, value: 0 },
        { type: 'stack', groupby: ['x'], field: 'y', offset: { signal: `${s}Offset` } },
      ] }],
      scales: [X, { name: 'y', type: 'linear', domain: [0, 30], range: 'height' }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 6 }, y: { scale: 'y', field: 'y0' }, y2: { scale: 'y', field: 'y1' } } } }],
    } as VgSpec),
  },
  {
    name: 'timeunit units by signal',
    family: 'time',
    values: [['year'], ['year', 'month'], ['month', 'date'], ['week']],
    spec: (s, c) => (cycle = c, {
      ...VIEW, signals: stepping(s, [['year'], ['year', 'month'], ['month', 'date'], ['week']]), data: [{ name: 't', values: POINTS, transform: [{ type: 'timeunit', field: 'd', units: { signal: s } }] }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'unit0' }, range: 'width' }, Y],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'unit0' }, y: { scale: 'y', field: 'y' } } } }],
    } as VgSpec),
  },
]

/** The host's signal values for one value of a case (the format case sets two signals). */
function signalsOf(c: Case, sig: string, v: unknown): Record<string, unknown> {
  if (c.family === 'time' && Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /^(number|time|utc)$/.test(v[0])) return { [`${sig}Type`]: v[0], [`${sig}Format`]: v[1] }
  if (c.family === 'reshape') { const [o, b, m] = v as [string, number, string]; return { [`${sig}Offset`]: o, [`${sig}Bins`]: b, [`${sig}Method`]: m } }
  return { [sig]: v }
}

describe('a family chosen by a signal is named whole, and draws the same with what is named as with everything', () => {
  for (const c of CASES) {
    for (const handler of [false, true]) {
      it(`${c.name}${handler ? ', and moved on by a click' : ', set by the host'}`, async () => {
        const sig = 'pick'
        const spec = c.spec(sig, handler)
        // the title says what the spec has: the handler variant carries a handler on a click, the host-set one carries none
        expect(JSON.stringify(spec).includes('"events":"click"'), 'a click handler is in the spec of the handler variant only').toBe(handler)
        expect(specNeeds(spec).parts, 'the detector names the family').toContain(c.family)
        const readBy: Array<readonly EnginePart[]> = []
        for (const v of c.values) {
          const report = await checkParts([{ name: `${c.name} = ${JSON.stringify(v)}`, spec }], () => ({ signals: signalsOf(c, sig, v) }), {})
          expect(report.wrong.join('\n'), `value ${JSON.stringify(v)}`).toBe('')
          expect(report.compared, `value ${JSON.stringify(v)} draws`).toBe(1)
          readBy.push(Object.keys(report.read).filter((p) => report.read[p as EnginePart] > 0) as EnginePart[])
        }
        // not vacuous: some value reads the family; and where the first value draws without it, naming it is owed to the signal
        expect(readBy.some((r) => r.includes(c.family)), `some value reads ${c.family}: ${JSON.stringify(readBy)}`).toBe(true)
        if (c.firstNeedsNone && !handler) expect(readBy[0], 'the first value draws without the family').not.toContain(c.family)
      }, 120_000)
    }
  }
})
