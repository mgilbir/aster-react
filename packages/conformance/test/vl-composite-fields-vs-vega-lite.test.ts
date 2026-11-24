// @vitest-environment node
/**
 * Composite marks (boxplot, errorbar, errorband) over every form a field name takes - plain, nested (`o.v`), a name with a dot in it
 * (`a\.b`) - on the measure, the category and the colour, with titles, parameters and detail lists, GENERATED from a seed and drawn by
 * real vega from vega-lite's output and from @aster-charts/vl's (audit C59 C60 C189 C190 C300 C390 C444, and the `{expr}` mark properties
 * of a06d's expression corpus). A spec vega-lite refuses, or whose output vega cannot run, must be refused here, not drawn.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { withOracleRandom } from '../src/gallery/seeded.js'
import { oracleOf, pick, plain, sameDrawing, stream } from './vl-a16-helpers.js'

const ROWS = Array.from({ length: 45 }, (_, i) => {
  const c = ['a', 'b', 'c'][i % 3]!
  const g = i % 2 ? 'm' : 'f'
  const v = [4, 9, 6, 31, 7, 5, 8, 12, -15, 6, 7, 40, 5, 6][i % 14]! + (i % 5) * 3
  return { c, g, v, w: (i * 7) % 13, i, ts: `2012-0${1 + (i % 3)}-0${1 + (i % 5)}`, o: { c, g }, 'c.d': c }
})
const NESTED = { values: ROWS.map((r) => ({ ...r, a: { b: r.v } })) }
const DOTTED = { values: ROWS.map((r) => ({ ...r, 'a.b': r.v })) }

type Form = 'plain' | 'nested' | 'dotted'
const MEASURE: Record<Form, string> = { plain: 'v', nested: 'a.b', dotted: 'a\\.b' }
const CATEGORY: Record<Form, string> = { plain: 'c', nested: 'o.c', dotted: 'c\\.d' }
const COLOR: Record<Form, string> = { plain: 'g', nested: 'o.g', dotted: 'g' }

function genSpec(seed: number): { spec: Record<string, any>; measure: Form; mark: string } {
  const r = stream(seed)
  const mark = pick(r, ['boxplot', 'boxplot', 'errorbar', 'errorband'] as const)
  const measure = pick(r, ['plain', 'nested', 'dotted'] as const)
  const category = pick(r, ['plain', 'nested', 'dotted'] as const)
  const horizontal = r() < 0.3
  const title = pick(r, [undefined, undefined, null, 'My measure'] as const)
  const md: Record<string, unknown> = { type: mark }
  if (mark === 'boxplot') {
    const extent = pick(r, [undefined, 'min-max', 1.5, 3] as const)
    if (extent !== undefined) md.extent = extent
    if (r() < 0.2) md.outliers = false
    if (r() < 0.2) md.size = 20
  } else {
    const extent = pick(r, [undefined, 'stderr', 'stdev', 'ci', 'iqr'] as const)
    if (extent !== undefined) md.extent = extent
    if (mark === 'errorbar' && r() < 0.3) md.ticks = true
    if (mark === 'errorband' && r() < 0.3) md.borders = true
  }
  const m: Record<string, unknown> = { field: MEASURE[measure], type: 'quantitative', ...(title !== undefined ? { title } : {}) }
  const k: Record<string, unknown> = { field: CATEGORY[category], type: 'nominal' }
  const encoding: Record<string, unknown> = horizontal ? { x: m, y: k } : { x: k, y: m }
  const colorForm = pick(r, [undefined, undefined, 'plain', 'nested'] as const)
  if (colorForm !== undefined) encoding.color = { field: COLOR[colorForm], type: 'nominal' }
  if (r() < 0.2) encoding.detail = [{ field: 'ts', timeUnit: 'month', type: 'ordinal' }, { field: 'g' }]
  const spec: Record<string, any> = { data: measure === 'dotted' ? DOTTED : NESTED, mark: md, encoding }
  if (r() < 0.3) {
    spec.params = [{ name: 'cut', value: -20, bind: { input: 'range', min: -30, max: 30 } }]
    spec.transform = [{ filter: `datum.w >= 0 && ${r() < 0.5 ? 'cut < 10' : 'cut < 0'}` }]
  }
  return { spec, measure, mark }
}

const SEEDS = Array.from({ length: 140 }, (_, i) => 4100 + i * 13)

/** What the marks of a Vega spec draw, as numbers: the scene without the text (descriptions and tooltips name the fields). */
async function geometryOf(vg: Record<string, unknown>): Promise<unknown> {
  const vega = await import('vega')
  // (a bootstrap interval, `ci0` / `ci1`, draws random numbers: each run reads the same seeded stream from its start)
  const scene = await withOracleRandom(async () => {
    const view = new vega.View(vega.parse(plain(vg) as never), { renderer: 'none' })
    await view.runAsync()
    const json = JSON.parse((view as unknown as { scenegraph(): { toJSON(): string } }).scenegraph().toJSON()) as unknown
    view.finalize()
    return json
  })
  const TEXTUAL = new Set(['description', 'ariaRoleDescription', 'tooltip', 'text', 'name', 'key', 'datum', 'aria', 'ariaRole'])
  const clean = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(clean)
    if (n === null || typeof n !== 'object') return n
    return Object.fromEntries(Object.entries(n as Record<string, unknown>).filter(([k]) => !TEXTUAL.has(k)).map(([k, v]) => [k, clean(v)]))
  }
  return clean(scene)
}

/** The same spec over a plain column of the measure (the measure's own text kept as its title, so the axes read the same). */
function twinOf(spec: Record<string, any>, measure: Form): Record<string, any> {
  const twin = plain(spec)
  twin.data = NESTED
  for (const ch of ['x', 'y']) if (twin.encoding[ch].type === 'quantitative') twin.encoding[ch] = { ...twin.encoding[ch], field: 'v', title: twin.encoding[ch].title !== undefined ? twin.encoding[ch].title : MEASURE[measure] }
  return twin
}

describe('composite marks over every form of field name draw what vega-lite draws', () => {
  for (const seed of SEEDS) {
    const { spec, measure } = genSpec(seed)
    it(`seed ${seed}: ${JSON.stringify(spec.mark)} of ${JSON.stringify(spec.encoding)}`, async () => {
      // A measure that is a nested path or a column with a dot in its name is read by vega-lite's statistics before the flat copy they read
      // is made, unless a channel names the measure: then its aggregates read nothing, and it draws no bar, or nulls (the bars of an error
      // mark; the box of a boxplot with no outliers or a min-max one). Where the oracle does not draw what it draws over a plain column, the
      // bars must be the plain column's; everywhere else the picture is the oracle's.
      const twin = twinOf(spec, measure)
      const oracle = oracleOf(spec)
      const oracleTwin = oracleOf(twin)
      const oracleRight = measure === 'plain'
        || ('vega' in oracle && 'vega' in oracleTwin && JSON.stringify(await geometryOf(oracle.vega)) === JSON.stringify(await geometryOf(oracleTwin.vega)))
      if (oracleRight) await sameDrawing(spec)
      else expect(await geometryOf(compile(plain(spec) as never) as never)).toEqual(await geometryOf(compile(twin as never) as never))
    }, 30_000)
  }
})

describe('what a composite mark does with its parameters', () => {
  const unit = { data: NESTED, mark: 'boxplot', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }
  it('keeps a variable parameter its filter, its title or its mark properties read', async () => {
    for (const mark of ['boxplot', 'errorbar', 'errorband']) {
      await sameDrawing({ ...unit, mark, params: [{ name: 'cut', value: 5 }], transform: [{ filter: 'datum.v > cut' }] })
      await sameDrawing({ ...unit, mark, params: [{ name: 't', value: 'Title' }], title: { text: { expr: 't' } } })
      await sameDrawing({ ...unit, mark: { type: mark, color: { expr: 'k' } }, params: [{ name: 'k', value: 'teal' }] })
      await sameDrawing({ ...unit, mark, padding: { expr: 'k' }, params: [{ name: 'k', value: 17 }] })
    }
  })
  it('keeps them for a unit faceted by a channel', () => sameDrawing({ ...unit, encoding: { ...unit.encoding, column: { field: 'g', type: 'nominal' } }, params: [{ name: 'cut', value: 5 }], transform: [{ filter: 'datum.v > cut' }] }))
  it('refuses a selection parameter, which vega-lite drops with a warning', () => {
    for (const mark of ['boxplot', 'errorbar', 'errorband']) {
      expect(() => compile({ ...unit, mark, params: [{ name: 'brush', select: 'interval' }] } as never), mark).toThrow(/selection parameter "brush" on a/)
      expect(() => compile({ ...unit, mark, params: [{ name: 'cut', value: 5 }, { name: 'brush', select: 'point' }] } as never), mark).toThrow(/selection parameter "brush"/)
    }
  })
})

describe('what a composite mark with nothing to draw does', () => {
  const enc = { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['an errorbar with the rule off and no ticks', { type: 'errorbar', rule: false }],
    ['an errorband with the band off and no borders', { type: 'errorband', band: false }],
    ['a boxplot with every part off', { type: 'boxplot', box: false, median: false, rule: false, ticks: false, outliers: false }],
    ['a min-max boxplot with every part off', { type: 'boxplot', extent: 'min-max', box: false, median: false, rule: false, ticks: false }],
  ]
  for (const [name, mark] of cases) it(`refuses ${name}`, () => expect(() => compile({ data: NESTED, mark, encoding: enc } as never)).toThrow(/every part of the .* is switched off/))
})
