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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './render.js'
import { createChartSession } from './session.js'
import { defaultLocale, resetDefaultLocale } from './locale.js'
import { setTextMetricsProvider } from './text-metrics.js'
import { installAllParts } from './install-parts.testlib.js'
import type { RuntimeInput, SceneGroup, SceneRoot, VgSpec } from './types.js'

/** How many axes, legends and titles were made (the builders, counted as they are called). */
const built = vi.hoisted(() => ({ n: 0 }))
vi.mock('./guide-axis.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./guide-axis.js')>()
  return { ...real, buildAxis: (...a: Parameters<typeof real.buildAxis>) => { built.n++; return real.buildAxis(...a) } }
})
vi.mock('./guide-legend.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./guide-legend.js')>()
  return { ...real, buildLegend: (...a: Parameters<typeof real.buildLegend>) => { built.n++; return real.buildLegend(...a) } }
})
vi.mock('./guide-title.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./guide-title.js')>()
  return { ...real, buildTitle: (...a: Parameters<typeof real.buildTitle>) => { built.n++; return real.buildTitle(...a) } }
})

installAllParts()

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

// --- legends, titles and the guides of group marks ----------------------------------------------------------------------------

/**
 * The view's legends and title, and a group mark's axes, legend and title (per instance: a facet cell each), are kept the same way.
 * A legend is placed after it is made, against the bounds of the content and the axes beside the plot and beside the other legends
 * of its orient: the legends of a scope are kept together, only while each is kept and they are placed against the same anchors.
 * A title sits against the bounds of everything else in its scope: it is kept only while those bounds are what they were.
 */
const GUIDED = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [
    { name: 'hoverX', value: null },
    { name: 'lfill', value: 'black' },
    { name: 'ltitle', value: 'Kind' },
    { name: 'ttl', value: 'Chart' },
    { name: 'gcol', value: 'black' },
    { name: 'reach', value: 0 },
    { name: 'lx', value: 20 },
  ],
  data: [{ name: 'pts', values: [{ k: 'a', x: 1, y: 2 }, { k: 'a', x: 50, y: 3 }, { k: 'b', x: 80, y: 7 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
    { name: 's', type: 'linear', domain: [0, 10], range: [10, 200] },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }],
  legends: [
    { fill: 'c', title: { signal: 'ltitle' }, encode: { labels: { update: { fill: { signal: 'lfill' } } } } },
    { size: 's', orient: 'bottom', title: 'Size' },
    { fill: 'c', orient: 'none', legendX: { signal: 'lx' }, legendY: 10 },
  ],
  title: { text: { signal: 'ttl' } },
  marks: [
    {
      type: 'group', from: { facet: { name: 'cell', data: 'pts', groupby: 'k', aggregate: { fields: ['x'], ops: ['sum'], as: ['sx'] } } },
      encode: { update: { x: { signal: '-reach' }, width: { value: 120 }, height: { value: 80 }, y: { value: 0 } } },
      // (every part of the cells' axis reads `gcol`: made again, no part of it is the same as before)
      axes: [{ scale: 'x', orient: 'top', title: 'g', tickColor: { signal: 'gcol' }, labelColor: { signal: 'gcol' }, domainColor: { signal: 'gcol' }, titleColor: { signal: 'gcol' } }],
      legends: [{ fill: 'c', orient: 'left' }],
      title: { text: { signal: "'cell ' + parent.k + ': ' + parent.sx" } },
      // (the cells read `hoverX`: every move makes them again, and their guides are kept, or not, on their own)
      marks: [{ type: 'symbol', from: { data: 'cell' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { scale: 'c', field: 'k' }, opacity: { signal: 'hoverX == null ? 1 : 0.5' } } } }],
    },
    { type: 'rect', encode: { update: { x: { value: 0 }, width: { value: 4 }, y: { value: 0 }, height: { value: 4 }, opacity: { signal: 'hoverX == null ? 1 : 0.5' } } } },
  ],
} as unknown as VgSpec

/** The guides of a scene by kind: the view's legends and title, then each cell's axes, legend and title, in order. */
function guidesOf(scene: SceneRoot): Record<'legends' | 'title' | 'cells', SceneGroup[]> {
  const cells: SceneGroup[] = []
  const collect = (g: SceneGroup): void => {
    for (const c of (g.items ?? []) as SceneGroup[]) {
      if (c.role === 'axis' || c.role === 'legend' || c.role === 'title') cells.push(c)
    }
  }
  // (each cell of the group mark is a group item of the view, role `scope`)
  for (const g of scene.items) if (g.role === 'scope') collect(g)
  return {
    legends: scene.items.filter((g) => g.role === 'legend'),
    title: scene.items.filter((g) => g.role === 'title'),
    cells,
  }
}

/** Evaluate `before`, then `after`, through one session: which guides of each kind are the objects they were (checked against fresh). */
function keptGuides(spec: VgSpec, before: RuntimeInput, after: RuntimeInput): Record<'legends' | 'title' | 'cells', boolean[]> {
  const session = createChartSession()
  const a = guidesOf(session.evaluate(spec, before))
  const scene = session.evaluate(spec, after)
  expectFresh(spec, scene, after)
  const b = guidesOf(scene)
  const same = (k: 'legends' | 'title' | 'cells'): boolean[] => {
    expect(b[k].length).toBe(a[k].length)
    return b[k].map((g, i) => g === a[k][i])
  }
  return { legends: same('legends'), title: same('title'), cells: same('cells') }
}

const all = (n: number, v: boolean): boolean[] => Array.from({ length: n }, () => v)

describe('legends, titles and the guides of group marks are kept while nothing they are made from changes', () => {
  it('the scene has what the cases below read: three legends, a title, two cells with an axis, a legend and a title each', () => {
    const g = guidesOf(evaluateChart(compileChart(GUIDED), {}))
    expect([g.legends.length, g.title.length, g.cells.length]).toEqual([3, 1, 6])
  })

  it('a signal no guide reads keeps every one of them, over many moves', () => {
    const session = createChartSession()
    built.n = 0
    let prev = guidesOf(session.evaluate(GUIDED, {}))
    // (one axis, three legends and a title of the view; an axis, a legend and a title in each of the two cells)
    expect(built.n).toBe(11)
    for (let i = 0; i < 8; i++) {
      const input = { signals: { hoverX: i * 7.5 } }
      const scene = session.evaluate(GUIDED, input)
      expectFresh(GUIDED, scene, input)
      const now = guidesOf(scene)
      expect(now.legends.map((g, k) => g === prev.legends[k])).toEqual(all(3, true))
      expect(now.title.map((g, k) => g === prev.title[k])).toEqual([true])
      expect(now.cells.map((g, k) => g === prev.cells[k])).toEqual(all(6, true))
      prev = now
    }
    // (the cells' guides are also put back by value where they equal the ones before, so their identity alone does not tell a kept
    // guide from one made again: the builders do)
    built.n = 0
    session.evaluate(GUIDED, { signals: { hoverX: 99 } })
    expect(built.n).toBe(0)
  })

  it('a signal a legend names makes every legend of the view again (they are placed together); the title stays where it sits', () => {
    expect(keptGuides(GUIDED, {}, { signals: { lfill: 'red' } })).toEqual({ legends: all(3, false), title: [true], cells: all(6, true) })
  })

  it('an `orient: none` legend\'s place, read from a signal', () => {
    expect(keptGuides(GUIDED, {}, { signals: { lx: 40 } }).legends).toEqual(all(3, false))
  })

  it('a legend that changes size moves the title that sits against it', () => {
    expect(keptGuides(GUIDED, {}, { signals: { ltitle: 'A much longer legend title' } })).toEqual({ legends: all(3, false), title: [false], cells: all(6, true) })
  })

  it('the bounds the legends are placed against: cells that move past the plot move them, and the title', () => {
    // (the cells' own guides sit where they sat in their cells: kept)
    expect(keptGuides(GUIDED, {}, { signals: { reach: 40 } })).toEqual({ legends: all(3, false), title: [false], cells: all(6, true) })
  })

  it('a signal the title names makes the title again, and only it', () => {
    expect(keptGuides(GUIDED, {}, { signals: { ttl: 'Other' } })).toEqual({ legends: all(3, true), title: [false], cells: all(6, true) })
  })

  it('a signal a group mark\'s axis names makes that axis again in every cell, and only it', () => {
    const got = keptGuides(GUIDED, {}, { signals: { gcol: 'red' } })
    expect(got.legends).toEqual(all(3, true))
    // (per cell: its axis, its legend, its title)
    expect(got.cells).toEqual([false, true, true, false, true, true])
  })

  it('a group title\'s datum: a cell whose rows changed makes its title again, the other cell keeps its own', () => {
    const rows = [{ k: 'a', x: 1, y: 2 }, { k: 'b', x: 80, y: 7 }]
    const got = keptGuides(GUIDED, { data: { pts: rows } }, { data: { pts: [{ k: 'a', x: 5, y: 2 }, rows[1]] } })
    // (the facet datum of cell `a` sums another x; cell `b`'s is what it was)
    expect(got.cells[2]).toBe(false)
    expect(got.cells[5]).toBe(true)
  })

  it('a pass counted against limits makes every guide again, and counts it', () => {
    // the view's legends and title: made again
    const got = keptGuides(GUIDED, {}, { signals: { hoverX: 2 }, limits: {} })
    expect([got.legends, got.title]).toEqual([all(3, false), [false]])
    // The cells' guides are also compared with the cells before by value, which puts the old nodes back where they are equal, so their
    // identity tells nothing here: what a pass under limits must not skip is counting their items. A session's pass needs as many
    // items as one whose cell guides each read the signal that moves (they can never be kept) needs.
    const live = JSON.parse(JSON.stringify(GUIDED)) as { marks: Array<Record<string, any>> }
    const reads = { opacity: { signal: 'hoverX == null ? 1 : 1' } }
    const cell = live.marks[0]!
    cell.axes[0].encode = { labels: { update: reads } }
    cell.legends[0].encode = { labels: { update: reads } }
    cell.title.encode = { title: { update: reads } }
    const fits = (spec: VgSpec, maxItems: number): boolean => {
      const session = createChartSession()
      session.evaluate(spec, {})
      try {
        session.evaluate(spec, { signals: { hoverX: 2 }, limits: { maxItems } })
        return true
      } catch (e) {
        if ((e as Error).name !== 'AsterLimitError') throw e
        return false
      }
    }
    let lo = 1
    let hi = 100_000
    while (lo < hi) { const mid = (lo + hi) >> 1; if (fits(live as unknown as VgSpec, mid)) hi = mid; else lo = mid + 1 }
    expect([fits(GUIDED, lo - 1), fits(GUIDED, lo)]).toEqual([false, true])
  })

  it('a view that fits its viewport makes its legends and title again on every pass', () => {
    const fit = { ...GUIDED, autosize: 'fit' } as unknown as VgSpec
    const got = keptGuides(fit, {}, { signals: { hoverX: 2 } })
    expect([got.legends, got.title]).toEqual([all(3, false), [false]])
  })
})
