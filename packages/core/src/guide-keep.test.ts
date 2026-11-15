/**
 * The view's own axes are kept from the evaluation before when nothing they are made from changed: a pointer move that writes a
 * signal no axis reads (the chart-bench survival chart's `hoverX`) leaves each axis group the object it was, where every evaluation
 * built both axes again (65 ms of a 60-move sweep in Chromium at the layer below).
 *
 * Every input an axis is made from is changed in turn, and each change must make the axis again: a signal it names (in a title, in
 * an encode), the scale it draws (and any other scale), the view's size, the text measurer (given with the input, or set for every
 * chart), the default locale, the time zone, the URL policy its links are vetted under, a dataset an expression reads by name,
 * whether tuples are registered, `limits`, a view that fits its viewport. After every step the
 * scene, its SVG and its definitions equal a fresh evaluation's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './render.js'
import { createChartSession } from './session.js'
import { defaultLocale, resetDefaultLocale } from './locale.js'
import { setTextMetricsProvider } from './text-metrics.js'
import type { RuntimeInput, SceneGroup, SceneRoot, VgSpec } from './types.js'

const SPEC = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [
    { name: 'hoverX', value: null },
    { name: 't', value: 'Days' },
    { name: 'dom', value: 100 },
    { name: 'lab', value: 'black' },
    { name: 'cdom', value: 'a' },
  ],
  data: [{ name: 'pts', values: [{ x: 1, y: 2 }, { x: 50, y: 3 }, { x: 80, y: 7 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { signal: '[0, dom]' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    { name: 'c', type: 'ordinal', domain: { signal: '[cdom, "b"]' }, range: ['red', 'blue'] },
  ],
  axes: [
    { scale: 'x', orient: 'bottom', title: { signal: 't' } },
    { scale: 'y', orient: 'left', grid: true, title: 'Survival', encode: { labels: { update: { fill: { signal: 'lab' } } } } },
  ],
  marks: [{
    type: 'rect', from: { data: 'pts' },
    encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 2 }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, fill: { scale: 'c', value: 'a' }, opacity: { signal: 'hoverX == null ? 1 : 0.5' } } },
  }],
} as unknown as VgSpec

const axesOf = (scene: SceneRoot): SceneGroup[] => scene.items.filter((g) => g.role === 'axis')

/** Everything of a scene a host reads, as text: own enumerable properties in their order (functions and scale maps aside). */
function readable(scene: SceneRoot): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(scene, (k, v) => {
    if (k === 'runtime' || k === 'compiled' || k === '__scaleMap' || k === '__scales' || k === 'signalParams' || k === '__gen' || k === '__itemGen') return undefined
    if (typeof v === 'function') return '[fn]'
    if (v !== null && typeof v === 'object') { if (seen.has(v)) return '[seen]'; seen.add(v) }
    return v
  })
}

function expectFresh(spec: VgSpec, scene: SceneRoot, input: RuntimeInput): void {
  const fresh = evaluateChart(compileChart(spec), input)
  expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(fresh))
  expect(readable(scene)).toBe(readable(fresh))
  expect(JSON.stringify(scene.defs ?? [])).toBe(JSON.stringify(fresh.defs ?? []))
}

/** Evaluate `before`, then `after`, through one session: which of the axes are the objects they were, and the check against a fresh evaluation. */
function kept(spec: VgSpec, before: RuntimeInput, after: RuntimeInput, between?: () => void): boolean[] {
  const session = createChartSession()
  const a = axesOf(session.evaluate(spec, before))
  expect(a.length).toBeGreaterThan(0)
  between?.()
  const scene = session.evaluate(spec, after)
  expectFresh(spec, scene, after)
  const b = axesOf(scene)
  expect(b.length).toBe(a.length)
  return b.map((g, i) => g === a[i])
}

const zone = process.env.TZ
afterEach(() => {
  resetDefaultLocale()
  setTextMetricsProvider(null)
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe('the view\'s axes are kept while nothing they are made from changes', () => {
  it('a signal no axis reads keeps both axes, over many moves', () => {
    const session = createChartSession()
    let prev = axesOf(session.evaluate(SPEC, {}))
    for (let i = 0; i < 12; i++) {
      const input = { signals: { hoverX: i * 7.5 } }
      const scene = session.evaluate(SPEC, input)
      expectFresh(SPEC, scene, input)
      const now = axesOf(scene)
      expect(now.map((g, k) => g === prev[k])).toEqual([true, true])
      prev = now
    }
  })

  it('a signal an axis names makes that axis again, and only it', () => {
    expect(kept(SPEC, {}, { signals: { t: 'Months' } })).toEqual([false, true])
    expect(kept(SPEC, {}, { signals: { lab: 'red' } })).toEqual([true, false])
  })

  it('a scale made again makes every axis again', () => {
    expect(kept(SPEC, {}, { signals: { dom: 120 } })).toEqual([false, false])
    // (a scale no axis draws: an encode may read any scale by name)
    expect(kept(SPEC, {}, { signals: { cdom: 'z' } })).toEqual([false, false])
  })

  it('the view\'s size', () => {
    expect(kept(SPEC, { width: 300, height: 200 }, { width: 320, height: 200 })).toEqual([false, false])
  })

  it('the text measurer given with the input, or set for every chart', () => {
    const narrow = { measure: (text: string) => text.length * 5 }
    const wide = { measure: (text: string) => text.length * 9 }
    expect(kept(SPEC, { textMetrics: narrow }, { textMetrics: narrow, signals: { hoverX: 3 } })).toEqual([true, true])
    expect(kept(SPEC, { textMetrics: narrow }, { textMetrics: wide })).toEqual([false, false])
    expect(kept(SPEC, {}, { signals: { hoverX: 3 } }, () => setTextMetricsProvider(wide))).toEqual([false, false])
  })

  it('the default locale and the time zone', () => {
    const fr = { decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' €'] }
    const frTime = {
      dateTime: '%A %e %B %Y à %X', date: '%d/%m/%Y', time: '%H:%M:%S', periods: ['AM', 'PM'],
      days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], shortDays: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
      months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
      shortMonths: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    }
    const decimals = { ...SPEC, axes: [{ scale: 'y', orient: 'left', format: ',.2f' }] } as unknown as VgSpec
    expect(kept(decimals, {}, { signals: { hoverX: 1 } }, () => defaultLocale(fr, frTime))).toEqual([false])
    const time = {
      ...SPEC,
      scales: [{ name: 'x', type: 'time', domain: [86400000 * 40.3, 86400000 * 41.9], range: 'width' }, ...(SPEC as { scales: unknown[] }).scales.slice(1)],
      axes: [{ scale: 'x', orient: 'bottom', tickCount: 6 }],
    } as unknown as VgSpec
    process.env.TZ = 'UTC'
    expect(kept(time, {}, { signals: { hoverX: 1 } }, () => { process.env.TZ = 'Asia/Kathmandu' })).toEqual([false])
  })

  it('the URL policy the links of an axis are vetted under', () => {
    const linked = { ...SPEC, axes: [{ scale: 'x', orient: 'bottom', encode: { labels: { update: { href: { value: 'https://example.com/a' } } } } }] } as unknown as VgSpec
    expect(kept(linked, { urlPolicy: {} }, { urlPolicy: {}, signals: { hoverX: 2 } })).toEqual([true])
    expect(kept(linked, { urlPolicy: {} }, { urlPolicy: { allow: () => true } })).toEqual([false])
  })

  it('a dataset an expression of the axis reads by name', () => {
    const counted = { ...SPEC, axes: [{ scale: 'x', orient: 'bottom', title: { signal: "'n = ' + length(data('pts'))" } }] } as unknown as VgSpec
    const rows = [{ x: 1, y: 2 }, { x: 50, y: 3 }]
    expect(kept(counted, { data: { pts: rows } }, { data: { pts: rows }, signals: { hoverX: 2 } })).toEqual([true])
    expect(kept(counted, { data: { pts: rows } }, { data: { pts: [...rows, { x: 60, y: 1 }] } })).toEqual([false])
  })

  it('whether tuples are registered', () => {
    // (a spec that asks whether `facet` is a tuple registers tuples only while the host's `facet` is an object of its own)
    const asks = { ...SPEC, signals: [...(SPEC as { signals: unknown[] }).signals, { name: 'facet' }, { name: 'q', update: 'isTuple(facet)' }] } as unknown as VgSpec
    expect(kept(asks, { signals: { facet: { a: 1 } } }, { signals: { facet: { a: 1 }, hoverX: 2 } })).toEqual([true, true])
    expect(kept(asks, {}, { signals: { facet: { a: 1 } } })).toEqual([false, false])
  })

  it('a pass counted against limits, a view that fits its viewport', () => {
    expect(kept(SPEC, {}, { signals: { hoverX: 2 }, limits: {} })).toEqual([false, false])
    const fit = { ...SPEC, autosize: 'fit' } as unknown as VgSpec
    expect(kept(fit, {}, { signals: { hoverX: 2 } })).toEqual([false, false])
  })
})
