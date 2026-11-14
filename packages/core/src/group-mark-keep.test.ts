/**
 * A top-level group mark whose subtree reads nothing that changed is kept whole: its group items are the very objects the evaluation
 * before returned, and nothing inside it is made again. Everything the subtree reads keeps it from being kept when it changes.
 *
 * Each chart puts a signal `s` at one place a group's subtree can read it (the group's encode, a mark's encode inside, a dataset's
 * transform inside, a scale inside, an axis, a title, a layout, a facet aggregate, a clip, a nested group, a gradient), and has a
 * second signal `other` that nothing in the group reads. Writing `other` keeps the group (no encode in it runs, its own included: a
 * counting function says so, and the group items are the same objects); writing `s` makes it again (its own encode runs). After every step the scene equals a
 * fresh evaluation of the same input (every property of every node, and the SVG), and the datasets the scene reports do too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import { defaultLocale, resetDefaultLocale } from './locale.js'
import type { RuntimeInput, SceneGroup, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

let encodes = 0
let dispose: (() => void) | undefined
beforeAll(() => { dispose = registerExpressionFunction('gmCount', () => { encodes++; return 1 }) })
afterAll(() => dispose?.())

const SKIP = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1) ?? null)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP.has(k)) continue
    const n = norm((v as Row)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}
const datasets = (s: SceneRoot): unknown => norm(Object.fromEntries(datasetsOfScene(s)))

const ROWS: Row[] = Array.from({ length: 24 }, (_, i) => ({ g: 'abc'[i % 3], h: 'xy'[i % 2], v: (i * 7) % 50, w: i }))
const count = { signal: 'gmCount()' }

/** The top-level group items (the cells), in scene order. */
const groupItems = (scene: SceneRoot): SceneGroup[] => scene.items.filter((g) => g.marktype === 'group' && (g as { markIndex?: unknown }).markIndex !== undefined && g.role !== 'mark')

const base = (marks: unknown[], extra: Partial<Record<string, unknown>> = {}): VgSpec => ({
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [{ name: 's', value: 1 }, { name: 'other', value: 0 }],
  data: [{ name: 't', values: ROWS }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 50], range: [0, 80] }, { name: 'y', type: 'linear', domain: [0, 30], range: [60, 0] }],
  marks: [...marks, { type: 'text', encode: { update: { text: { signal: "'other ' + other" }, x: { value: 5 }, y: { value: 5 } } } }],
  ...extra,
}) as unknown as VgSpec

const leaf = (enc: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'symbol', name: 'pt', from: { data: 'part' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'w' }, size: count, ...enc } } })
const facet = (inner: Record<string, unknown> = {}, enc: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'group', name: 'cell', from: { facet: { name: 'part', data: 't', groupby: 'g' } },
  encode: { update: { x: { signal: "indexof(['a','b','c'], datum.g) * 95" }, width: { value: 90 }, height: { value: 80 }, stroke: { value: '#ccc' }, strokeOpacity: count, ...enc } },
  marks: [leaf()],
  ...inner,
})

/** Where `s` is read, in each chart. */
const CHARTS: Record<string, VgSpec> = {
  "the group's own encode": base([facet({}, { fillOpacity: { signal: 's / 4' } })]),
  'a mark inside it': base([facet({ marks: [leaf({ opacity: { signal: 's / 4' } })] })]),
  'a dataset of the group': base([facet({ data: [{ name: 'sub', source: 'part', transform: [{ type: 'filter', expr: 'datum.w > s' }] }], marks: [{ ...leaf(), from: { data: 'sub' } }] })]),
  'a scale of the group': base([facet({ scales: [{ name: 'lx', type: 'linear', domain: [0, { signal: '50 * s' }], range: [0, 80] }], marks: [leaf({ x: { scale: 'lx', field: 'v' } })] })]),
  'an axis of the group': base([facet({ axes: [{ scale: 'x', orient: 'bottom', title: { signal: "'s=' + s" }, tickCount: 3 }] })]),
  'a title of the group': base([facet({ title: { text: { signal: "'cell ' + s" } } })]),
  'a facet aggregate': base([facet({ from: { facet: { name: 'part', data: 't', groupby: 'g', aggregate: { fields: ['v'], ops: ['sum'], as: ['sv'] } } }, marks: [leaf({ opacity: { signal: 'parent.sv > 10 * s ? 1 : 0.5' } })] })]),
  'a clip': base([facet({ clip: { signal: 's > 1' } })]),
  'a group inside the group': base([facet({ marks: [{ type: 'group', encode: { update: { width: { value: 40 }, height: { value: 40 } } }, marks: [leaf({ fillOpacity: { signal: 's / 3' } })] }] })]),
  'a gradient inside it': base([facet({ marks: [leaf({ fill: { signal: "{gradient: 'linear', stops: [{offset: 0, color: 'red'}, {offset: 1, color: s > 1 ? 'blue' : 'green'}]}" } })] })]),
  'a layout inside it': base([{
    type: 'group', name: 'grid', encode: { update: { width: { value: 280 }, height: { value: 180 } } },
    layout: { columns: { signal: 's > 1 ? 3 : 2' }, padding: 4 },
    marks: [facet()],
  }]),
  // (a mark after the group reads its items by the group mark's name: a kept group still names them)
  "the group's encode, its items read by a mark after it": base([facet({}, { fillOpacity: { signal: 's / 4' } }), { type: 'rule', from: { data: 'cell' }, encode: { update: { x: { field: 'x' }, y: { value: 0 }, y2: { field: 'fillOpacity', mult: 40 } } } }]),
}

describe('a top-level group mark is kept whole when nothing its subtree reads changed', () => {
  for (const [where, spec] of Object.entries(CHARTS)) {
    it(`s read by ${where}`, () => {
      const session = createChartSession()
      let prev = session.evaluate(spec, {})
      const steps: Array<{ input: RuntimeInput; keeps: boolean }> = [
        { input: { signals: { other: 1 } }, keeps: true },
        { input: { signals: { other: 2 } }, keeps: true },
        { input: { signals: { other: 2, s: 3 } }, keeps: false },
        { input: { signals: { other: 3, s: 3 } }, keeps: true },
        { input: { signals: { other: 3, s: 1 } }, keeps: false },
        { input: { signals: { other: 3, s: 1 }, data: { t: ROWS.map((r, i) => (i === 2 ? { ...r, v: 49 } : r)) } }, keeps: false },
        { input: { signals: { other: 4, s: 1 }, data: { t: ROWS.map((r, i) => (i === 2 ? { ...r, v: 49 } : r)) } }, keeps: true },
      ]
      // (the rows of the last two steps are one array: a host that changes nothing gives the same one)
      steps[6]!.input.data = steps[5]!.input.data
      for (const [k, { input, keeps }] of steps.entries()) {
        const what = `${where}, step ${k + 1}`
        const before = encodes
        const scene = session.evaluate(spec, input)
        const encoded = encodes - before
        const fresh = evaluateChart(compileChart(spec), input)
        expect(norm(scene), what).toEqual(norm(fresh))
        expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(fresh))
        expect(datasets(scene), what).toEqual(datasets(fresh))
        const was = groupItems(prev)
        const now = groupItems(scene)
        expect(now.length, what).toBeGreaterThan(0)
        if (keeps) {
          expect(encoded, `${what}: nothing inside the kept group is encoded`).toBe(0)
          expect(now.every((g, i) => g === was[i]), `${what}: the group items are the ones before`).toBe(true)
        } else {
          expect(encoded, `${what}: the group is made again`).toBeGreaterThan(0)
        }
        prev = scene
      }
    })
  }

  it('the default locale and the time zone are read by what a group formats', () => {
    const spec = base([facet({ marks: [{ type: 'text', from: { data: 'part' }, encode: { update: { text: { signal: "format(datum.v * 1000.5, ',.1f') + ' ' + timeFormat(datum.w * 86400000 * 40, '%b %H')" }, x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'w' }, fillOpacity: count } } }] })])
    const session = createChartSession()
    const first = session.evaluate(spec, { signals: { other: 1 } })
    const before = encodes
    try {
      defaultLocale({ decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] }, { dateTime: '%A, der %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['AM', 'PM'], days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'], shortMonths: ['Jan', 'Feb', 'Mrz', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'] })
      const scene = session.evaluate(spec, { signals: { other: 2 } })
      expect(encodes - before, 'another locale: made again').toBeGreaterThan(0)
      expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), { signals: { other: 2 } })))
      expect(renderSceneToSvg(scene)).not.toBe(renderSceneToSvg(first))
    } finally {
      resetDefaultLocale()
    }
    const tz = process.env.TZ
    try {
      process.env.TZ = 'Asia/Kathmandu'
      const at = encodes
      const scene = session.evaluate(spec, { signals: { other: 3 } })
      expect(encodes - at, 'another time zone: made again').toBeGreaterThan(0)
      expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), { signals: { other: 3 } })))
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})
