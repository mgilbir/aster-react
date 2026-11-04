/**
 * Layouts vega cannot take, against the pinned real Vega, in this process, over generated grids.
 *
 * vega lays a group mark's items out one after the other in one operator, each its grid (the cells, then the row headers, the column
 * headers, the row footers, the column footers and the titles) and then its guides. A grid throws where vega's arithmetic does: a
 * `columns` that is no count makes `Array(columns)` throw before any cell moves (`RangeError: Invalid array length`), and a column header
 * or footer that finds no cell at or before its place (a grid with more columns than cells, or more column strips than cells) reads the
 * position of a cell that is not there (`TypeError: Cannot read properties of undefined (reading 'x')`, `'bounds'` with a band). The
 * error is logged once and the pass stops at that operator, which is ranked after every instance below the mark's items: those are made
 * and laid out, the items before the failing one are laid out, the failing one only as far as its grid got, and nothing above the mark
 * is laid out (the view is not sized). A symbol legend lays its entries out in a grid of its own, which throws the same way. More strips
 * than the grid has columns (rows) are a warning, `Grid headers exceed limit: <n>`, logged each time the layout runs.
 *
 * Generated: grids in the view and in groups (nested in one another), cells from data, facets and plain groups (two marks of them at
 * times, or none), headers, footers and titles of every role from data of every size, the layout's columns (none, counts, fractional,
 * negative, text, a signal), bands, offsets, bounds and alignment, and guides around them (axes, legends whose entries have columns of
 * their own, titles), under every autosize. Compared: what was logged (errors and warnings, in order), the picture (strict
 * canonicalizer), and the evaluation of the chart with the incremental engine, twice.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; log: string[] }> {
  const log: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { log.push(`error ${String(a[0])}`); return logger },
    warn: (...a: unknown[]) => { log.push(`warn ${a.map(String).join(' ')}`); return logger },
    info: () => logger, debug: () => logger,
  }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), log }
  } finally {
    view.finalize()
  }
}

type Outcome = { svg?: string; threw?: string; log: string[] }
const loggerInto = (log: string[]) => ({
  error: (...a: unknown[]) => { log.push(`error ${String(a[0])}`) },
  warn: (...a: unknown[]) => { log.push(`warn ${a.map(String).join(' ')}`) },
})
function onAster(spec: Spec): Outcome {
  const log: string[] = []
  try { return { svg: renderSpec(structuredClone(spec) as never, { logger: loggerInto(log) } as never), log } } catch (e) { return { threw: (e as Error).message, log } }
}
function onChart(chart: ReturnType<typeof compileChart>): Outcome {
  const log: string[] = []
  try { return { svg: renderSceneToSvg(evaluateChart(chart, { logger: loggerInto(log) } as never)), log } } catch (e) { return { threw: (e as Error).message, log } }
}

const DATA: Spec[] = [0, 1, 2, 3, 4, 5].map((n) => ({ name: `d${n}`, values: Array.from({ length: n }, (_, i) => ({ a: i + 1, k: 'pq'[i % 2] })) }))
const COLORS = ['teal', 'crimson', 'goldenrod', 'slateblue', 'seagreen']

/** The content of a cell: a mark or two, and at times a guide, a title or a grid of its own. */
function cellContent(r: Rng, depth: number): Spec {
  const marks: Spec[] = [{ type: 'rect', encode: { update: { x: { value: 2 }, y: { value: 2 }, width: { value: 6 }, height: { value: 5 }, fill: { value: r.pick(COLORS) } } } }]
  const out: Spec = { marks }
  if (r.chance(0.2)) out.axes = [{ scale: 'x', orient: r.pick(['bottom', 'left']), tickCount: 2 }]
  if (r.chance(0.15)) out.title = { text: 'c', fontSize: 7 }
  if (depth < 1 && r.chance(0.2)) Object.assign(out, grid(r, depth + 1))
  return out
}

/** A header, a footer or a title group, from data of some size. */
function strip(r: Rng, role: string): Spec {
  if (role.endsWith('title')) return { type: 'group', role, title: { text: role, fontSize: 7 } }
  return {
    type: 'group', role, from: { data: `d${r.int(6)}` },
    encode: { update: { width: { value: r.pick([8, 14]) }, height: { value: r.pick([5, 9]) } } },
    ...(r.chance(0.6) ? { title: { text: { signal: "'' + parent.a" }, fontSize: 6 } } : {}),
  }
}

const COLUMNS: unknown[] = [undefined, undefined, 0, 1, 2, 3, 4, 5, 6, 1.5, -1, 'abc', { signal: 'cols' }]

/** A grid: its layout, cells (from data, a facet, or plain groups; one mark of them, two or none) and the strips around them. */
function grid(r: Rng, depth: number): Spec {
  const layout: Spec = { padding: r.pick([0, 3, { row: 2, column: 5 }]) }
  const columns = r.pick(COLUMNS)
  if (columns !== undefined) layout.columns = columns
  if (r.chance(0.4)) layout.bounds = r.pick(['full', 'flush'])
  if (r.chance(0.3)) layout.align = r.pick(['all', 'each', 'none'])
  if (r.chance(0.25)) layout.headerBand = r.pick([0, 0.5, 1, { column: 0.5 }])
  if (r.chance(0.25)) layout.footerBand = r.pick([0, 0.5, { row: 1 }])
  if (r.chance(0.3)) layout.offset = r.pick([4, { columnHeader: 3, rowFooter: 6 }, { columnTitle: 5 }])
  const marks: Spec[] = []
  // (the column strips are the ones that find no cell, in a grid with more columns than cells)
  const strips = ['column-header', 'row-header', 'column-footer', 'row-footer', 'column-title', 'row-title'].filter((role) => r.chance(role.startsWith('column-') && !role.endsWith('title') ? 0.45 : 0.25))
  for (const role of strips) marks.push(strip(r, role))
  for (let i = r.pick([0, 1, 1, 1, 2]); i > 0; i--) {
    const kind = r.pick(['data', 'data', 'facet', 'plain'])
    const cell: Spec = {
      type: 'group', encode: { update: { width: { value: r.pick([12, 20]) }, height: { value: r.pick([8, 14]) }, stroke: { value: '#999' } } },
      ...cellContent(r, depth),
    }
    if (kind === 'data') cell.from = { data: `d${r.int(6)}` }
    else if (kind === 'facet') cell.from = { facet: { data: `d${r.between(1, 5)}`, name: `f${depth}${i}`, groupby: 'k' } }
    marks.splice(r.int(marks.length + 1), 0, cell)
  }
  return { layout, marks }
}

function legend(r: Rng): Spec {
  const l: Spec = { fill: r.pick(['c', 'c', 'g']) }
  if (r.chance(0.4)) l.columns = r.pick([0, 1, 2, 1.5, -2, { signal: 'cols' }])
  if (r.chance(0.3)) l.title = 'legend'
  return l
}

function specOf(r: Rng): Spec {
  const spec: Spec = {
    width: 120, height: 70, padding: 4, autosize: r.pick(['none', 'pad', 'pad', 'fit']),
    signals: [{ name: 'cols', value: r.pick([2, 1.5, 3, -1]) }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 4], range: [0, 20] },
      { name: 'c', type: 'ordinal', domain: ['p', 'q', 'r'], range: ['red', 'blue', 'green'] },
      { name: 'g', type: 'linear', domain: [0, 4], range: ['white', 'black'] },
    ],
    data: DATA,
  }
  const inView = r.chance(0.5)
  const g = grid(r, 0)
  if (inView) Object.assign(spec, g)
  else {
    const holder: Spec = { type: 'group', encode: { update: { x: { value: 6 }, width: { value: 60 }, height: { value: 40 } } }, ...g }
    if (r.chance(0.4)) holder.legends = [legend(r)]
    if (r.chance(0.3)) holder.title = { text: 'holder', fontSize: 8 }
    // (a group mark of several items: they are laid out one after the other)
    if (r.chance(0.3)) holder.from = { data: `d${r.between(1, 3)}` }
    spec.marks = [holder, ...(r.chance(0.5) ? [{ type: 'group', marks: [{ type: 'rect', encode: { update: { width: { value: 4 }, height: { value: 4 }, fill: { value: 'orange' } } } }] }] : [])]
  }
  if (r.chance(0.5)) spec.axes = [{ scale: 'x', orient: r.pick(['bottom', 'top', 'left']) }]
  if (r.chance(0.5)) spec.legends = [legend(r)]
  if (r.chance(0.4)) spec.title = { text: 'view' }
  return spec
}

describe('a layout vega cannot take is logged and stops the pass where vega stops', () => {
  it(`${scaled(500)} generated grids`, { timeout: 900_000 }, async () => {
    const r = makeRng(0x1a7)
    const bad: string[] = []
    const errors = new Map<string, number>()
    let warned = 0
    for (let c = 0; c < scaled(500); c++) {
      const spec = specOf(r)
      const tag = `#${c} ${JSON.stringify(spec).slice(0, 900)}`
      const want = await onVega(spec)
      const got = onAster(spec)
      const chart = compileChart(structuredClone(spec) as never)
      const first = onChart(chart)
      const again = onChart(chart)
      if (JSON.stringify(first) !== JSON.stringify(got)) { bad.push(`${tag}: the evaluation with the incremental engine differs: ${JSON.stringify([got.threw, got.log, first.threw, first.log])}`); continue }
      if (JSON.stringify(again) !== JSON.stringify(first)) { bad.push(`${tag}: the second evaluation differs: ${JSON.stringify([first.log, again.log])}`); continue }
      if (got.threw !== undefined) { bad.push(`${tag}: aster threw ${got.threw}`); continue }
      for (const line of want.log) if (line.startsWith('error')) errors.set(line.replace(/\(reading.*/, ''), (errors.get(line.replace(/\(reading.*/, '')) ?? 0) + 1)
      if (want.log.some((l) => l.startsWith('warn Grid headers'))) warned++
      if (JSON.stringify(got.log) !== JSON.stringify(want.log)) { bad.push(`${tag}: vega logged ${JSON.stringify(want.log)}, aster ${JSON.stringify(got.log)}`); continue }
      let d: string[]
      try {
        d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg!))
      } catch (e) {
        d = [`not comparable: ${(e as Error).message}`]
      }
      if (d.length) bad.push(`${tag}: ${d.slice(0, 3).join(' | ')}`)
    }
    expect(bad, `${bad.length} of ${scaled(500)} differ:\n${bad.slice(0, 6).join('\n')}`).toEqual([])
    // (not vacuous: both of vega's layout errors are drawn many times, and so is the warning)
    expect(errors.get('error RangeError: Invalid array length') ?? 0, JSON.stringify([...errors])).toBeGreaterThan(scaled(500) * 0.05)
    expect(errors.get('error TypeError: Cannot read properties of undefined ') ?? 0, JSON.stringify([...errors])).toBeGreaterThan(scaled(500) * 0.03)
    expect(warned).toBeGreaterThan(scaled(500) * 0.05)
  })
})
