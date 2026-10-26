// @vitest-environment node
/**
 * Animations (the `time` channel and its timer selection): what @aster/vl emits must be vega-lite 6.4.3's, piece by piece.
 *
 * Over every `vlx-anim-*` corpus spec and 150 seeded random animation specs (marks, time field types and time units, selection
 * forms and names, frame rates, `empty`, other transforms, named views, variable parameters) the animation's parts are compared
 * with vega-lite's output:
 *  - the signals of the animation (clock, tuple, modify...): same definitions;
 *  - the store dataset and the frame dataset (its filter and what it derives from);
 *  - the `time` scale: type, domain field and its range step;
 *  - what the marks read (`<main>_curr`; a path group's facet keeps the main dataset), `interactive` and the pointer cursor.
 * and the first frame of the emitted Vega is rendered by real vega, with its timers stopped before they tick, and must be what
 * vega-lite's output draws.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const ROOT = join(__dirname, '..')

const ANIM_SIGNALS = ['unit', 'anim_clock', 'last_tick_at', 'is_playing', 'eased_anim_clock', 'min_extent', 'max_range_extent', 'anim_value']

/** A named view prefixes its scales; vega-lite writes that prefix into the signals that read them. */
const unprefix = (s: string, name: string | undefined): string => (name ? s.replaceAll(`${name}_time`, 'time') : s)

function parts(vg: any, selection: string, viewName: string | undefined): unknown {
  const sig = (n: string): unknown => {
    const s = (vg.signals ?? []).find((x: any) => x.name === n)
    return s ? JSON.parse(unprefix(JSON.stringify(s), viewName)) : null
  }
  const names = [...ANIM_SIGNALS, selection, `${selection}_domain`, `${selection}_tuple`, `${selection}_tuple_fields`, `${selection}_modify`]
  const data = (vg.data ?? []).filter((d: any) => d.name === `${selection}_store` || d.name.endsWith('_curr'))
  const marks: unknown[] = []
  const walk = (ms: any[]): void => {
    for (const m of ms ?? []) {
      // (a named view names its path groups after itself: that is a name, not a behaviour)
      const unname = (s: string | undefined): string | undefined => s?.replace(/^data_\d+/, 'main').replace(/^faceted_path_.*main$/, 'faceted_path_main')
      const from = m.from ? { ...m.from, ...(m.from.data !== undefined ? { data: unname(m.from.data) } : {}), ...(m.from.facet ? { facet: { ...m.from.facet, name: unname(m.from.facet.name), data: unname(m.from.facet.data) } } : {}) } : undefined
      marks.push({ type: m.type, from, interactive: m.interactive, cursor: m.encode?.update?.cursor })
      walk(m.marks)
    }
  }
  walk(vg.marks)
  const time = (vg.scales ?? []).find((s: any) => /(^|_)time$/.test(s.name))
  return {
    signals: Object.fromEntries(names.map((n) => [n, sig(n)])),
    store: data.filter((d: any) => d.name === `${selection}_store`),
    frame: data.filter((d: any) => d.name.endsWith('_curr')).map((d: any) => ({ source: d.source.replace(/^data_\d+/, 'main'), transform: d.transform })),
    scale: time ? { type: time.type, field: time.domain?.field, sort: time.domain?.sort, range: time.range } : null,
    marks,
  }
}

// --- the corpus ------------------------------------------------------------------

const corpus = readdirSync(join(ROOT, 'corpus')).filter((f) => f.startsWith('vlx-anim-') && f.endsWith('.vl.json')).sort()

describe('emitted animation parts match vega-lite: the corpus', () => {
  it('has the animation corpus', () => expect(corpus.length).toBeGreaterThanOrEqual(16))
  for (const f of corpus) {
    it(f.replace('.vl.json', ''), () => {
      const spec = JSON.parse(readFileSync(join(ROOT, 'corpus', f), 'utf8'))
      const sel = spec.params[0].name
      const want = parts((vl as any).compile(spec).spec, sel, spec.name)
      expect(parts(compile(spec as never), sel, spec.name)).toEqual(want)
    })
  }
})

// --- random animations -------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

const ROWS = [1990, 1991, 1992].flatMap((year, y) => ['a', 'b', 'c'].map((country, c) => ({ year, date: `${year}-06-15`, country, region: c % 2 ? 'w' : 'e', pop: 10 + 7 * c + 3 * y, life: 50 + 4 * c + 2 * y, fert: 5 - c * 0.5 - y * 0.3 })))

function genSpec(seed: number): Record<string, any> {
  const r = rng(seed)
  const name = pick(r, ['anim', 'play', 'clock_sel'])
  const timeKind = pick(r, ['ordinal', 'nominal', 'quantitative', 'temporal', 'unit'] as const)
  const timeField = timeKind === 'temporal' || timeKind === 'unit' ? 'date' : 'year'
  const time: Record<string, unknown> = timeKind === 'unit' ? { field: 'date', type: 'temporal', timeUnit: 'year' } : { field: timeField, type: timeKind }
  // a time unit is projected by `fields` (the raw field), anything else may use `encodings`
  const select: Record<string, unknown> = { type: 'point', on: pick(r, ['timer', 'timer{100}', { type: 'timer' }, { type: 'timer', throttle: 50 }]) }
  if (timeKind !== 'unit' && r() < 0.4) select.encodings = ['time']
  else select.fields = [timeField]
  const mark = pick(r, ['point', 'circle', 'square', 'tick', 'text', 'bar', 'line', 'area', 'rule'] as const)
  const xy: Record<string, unknown> = mark === 'bar'
    ? { x: { field: 'country', type: 'nominal' }, y: { field: 'pop', type: 'quantitative' } }
    : mark === 'line' || mark === 'area'
      ? { x: { field: 'year', type: 'quantitative' }, y: { field: 'pop', type: 'quantitative' }, ...(r() < 0.6 ? { color: { field: 'country', type: 'nominal' } } : {}) }
      : { x: { field: 'life', type: 'quantitative' }, y: { field: 'fert', type: 'quantitative' } }
  const enc: Record<string, unknown> = { ...xy, time }
  if (mark === 'text') enc.text = { field: 'country', type: 'nominal' }
  if (mark !== 'line' && mark !== 'area' && mark !== 'bar' && r() < 0.5) enc.color = { field: 'region', type: 'nominal' }
  const transform: unknown[] = []
  if (r() < 0.3) transform.push({ filter: 'datum.pop > 9' })
  if (r() < 0.2) transform.push({ calculate: 'datum.pop * 2', as: 'pop2' })
  transform.push({ filter: r() < 0.25 ? { param: name, empty: false } : { param: name } })
  const spec: Record<string, any> = {
    width: 240, height: 160, data: { values: ROWS }, params: [{ name, select }], transform, mark: mark === 'point' && r() < 0.5 ? { type: 'point', filled: true } : mark, encoding: enc,
  }
  if (r() < 0.3) spec.config = { scale: { framesPerSecond: pick(r, [1, 2, 4, 10, 0.5]) } }
  if (r() < 0.2) spec.name = pick(r, ['chart', 'view_1'])
  if (r() < 0.2) spec.params.push({ name: 'k', value: 2 })
  return spec
}

const SEEDS = Array.from({ length: 150 }, (_, i) => 31000 + i * 11)

describe('emitted animation parts match vega-lite: random animations', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const spec = genSpec(seed)
      const want = parts((vl as any).compile(spec).spec, spec.params[0].name, spec.name)
      expect(parts(compile(JSON.parse(JSON.stringify(spec))), spec.params[0].name, spec.name)).toEqual(want)
    })
  }
})

describe('the first frame of random animations is what vega-lite draws (real vega on both)', () => {
  for (const seed of SEEDS.filter((_, i) => i % 5 === 0)) {
    it(`seed ${seed}`, async () => {
      const spec = genSpec(seed)
      const oracle = await renderWithVega(JSON.parse(JSON.stringify((vl as any).compile(spec).spec)))
      const ours = await renderWithVega(JSON.parse(JSON.stringify(compile(JSON.parse(JSON.stringify(spec))))))
      expect(diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))).toEqual([])
    })
  }
})
