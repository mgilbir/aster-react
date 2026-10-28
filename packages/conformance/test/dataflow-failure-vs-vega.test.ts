// @vitest-environment node
/**
 * A transform or an encode that throws (`datum["o"]["v"]` on a row without `o`) stops vega's dataflow pass: it logs the error,
 * the operators ranked after the failing one never run, and the view renders what the pass had made. Aster must contain the
 * same failure the same way (not an empty chart where vega draws content, nor content where vega stops).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, evaluateChart, compileChart, datasetsOfScene } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

/** the rows of each spec dataset in Aster's evaluation, as plain objects (vega's `view.data(name)`) */
function asterDatasets(spec: any): Record<string, unknown[]> {
  const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(spec))), { logger: { error: () => {}, warn: () => {} } } as never)
  const all = datasetsOfScene(scene)
  const out: Record<string, unknown[]> = {}
  for (const d of spec.data ?? []) out[d.name] = JSON.parse(JSON.stringify(all.get(d.name) ?? null))
  return out
}

const BAD = 'datum["o"]["v"]>0'
const base = (): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 100,
  height: 50,
  data: [{ name: 't', values: [{ o: { v: 1 }, x: 1 }, { o: { v: 2 }, x: 2 }, { x: 4 }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 5], range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 10 } } } }],
})
const CASES: Record<string, (s: any) => void> = {
  'a filter that throws': (s) => { s.data[0].transform = [{ type: 'filter', expr: BAD }] },
  'a filter that throws, then a filter that does not': (s) => { s.data[0].transform = [{ type: 'filter', expr: 'datum.x>0' }, { type: 'filter', expr: BAD }, { type: 'formula', expr: 'datum.x*2', as: 'z' }] },
  'a formula that throws': (s) => { s.data[0].transform = [{ type: 'formula', expr: 'datum["o"]["v"]', as: 'q' }] },
  'a collect sorted by a nested field': (s) => { s.data[0].transform = [{ type: 'collect', sort: { field: 'o.v' } }] },
  'an aggregate grouped by a nested field': (s) => { s.data[0].transform = [{ type: 'aggregate', groupby: ['o.v'] }] },
  'a dataset derived from the failing one': (s) => {
    s.data[0].transform = [{ type: 'filter', expr: BAD }]
    s.data.push({ name: 'u', source: 't', transform: [{ type: 'formula', expr: 'datum.x', as: 'k' }] })
    s.marks[0].from.data = 'u'
  },
  'a sibling dataset declared after the failing one': (s) => {
    s.data.push({ name: 'u', values: [{ x: 1 }, { x: 3 }] }, { name: 'w', source: 't', transform: [{ type: 'filter', expr: BAD }] })
    s.marks[0].from.data = 'u'
    s.marks.push({ type: 'symbol', from: { data: 'w' }, encode: { update: { x: { value: 5 }, y: { value: 30 } } } })
  },
  'a sibling dataset declared before the failing one': (s) => {
    s.data.unshift({ name: 'u', values: [{ x: 1 }, { x: 3 }] })
    s.data[1].transform = [{ type: 'filter', expr: BAD }]
    s.marks[0].from.data = 'u'
    s.marks.push({ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 5 }, y: { value: 30 } } } })
  },
  'a scale domain over the failing dataset, with an axis': (s) => {
    s.data[0].transform = [{ type: 'filter', expr: BAD }]
    s.scales[0].domain = { data: 't', field: 'x' }
    s.axes = [{ orient: 'bottom', scale: 'x' }]
    s.padding = 5
  },
  'a mark encode that throws on its third item': (s) => { s.marks[0].encode.update.y = { signal: 'datum["o"]["v"]' } },
}

describe('a throwing expression is contained like vega contains it', () => {
  for (const [name, edit] of Object.entries(CASES)) {
    it(name, async () => {
      const spec = base()
      edit(spec)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors.length, 'the case must make vega log an error').toBeGreaterThan(0)
      const mine = renderSpec(JSON.parse(JSON.stringify(spec))) as string
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      // what each dataset ended with: the render cannot tell a dataset that ran from one that did not (every mark is ranked after every dataset)
      expect(asterDatasets(spec)).toEqual(vega.datasets)
    }, 30_000)
  }
  it('the same data with the guarded expression keeps the rows that pass', async () => {
    const spec = base()
    spec.data[0].transform = [{ type: 'filter', expr: 'datum["o"] && datum["o"]["v"]>0' }]
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
    expect(vega.errors).toEqual([])
    expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(renderSpec(JSON.parse(JSON.stringify(spec))) as string)).slice(0, 3)).toEqual([])
  })
})

// The failure composes with the signal-ordered build: vega ranks a dataset after the dataset whose extent signal it reads,
// wherever the two are declared, and a throw stops everything ranked after it (not what was declared after it).
describe('a throwing transform and the signal-ordered dataset build', () => {
  const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 300, height: 120, padding: 5, autosize: 'none' }
  const bars = (data: string, y = 10): any => ({ type: 'rect', from: { data }, encode: { update: { x: { scale: 'x', field: 'v' }, width: { value: 4 }, y: { value: y }, height: { value: 8 }, fill: { value: 'firebrick' } } } })
  const scaleX = (data: string): any => ({ name: 'x', type: 'linear', domain: { data, field: 'v' }, range: 'width' })
  const seq = (extra: any[] = []): any => ({ name: 'seq', transform: [{ type: 'sequence', start: { signal: 'ext[0]' }, stop: { signal: 'ext[1] + 1' }, as: 'v' }, ...extra] })
  const base = (extra: any[] = []): any => ({ name: 'base', values: [{ x: 3 }, { x: 9 }, { x: 5 }], transform: [...extra, { type: 'extent', field: 'x', signal: 'ext' }] })
  const BADROW = { type: 'filter', expr: 'datum["o"]["v"]>0' }
  const CASES2: Record<string, any> = {
    'the throw is downstream of the dataset the signals order first': {
      ...frame, data: [seq([BADROW]), base()], scales: [scaleX('seq')], marks: [bars('seq')],
    },
    'the throw is in a dataset derived from the signal-ordered one': {
      ...frame, data: [seq(), { name: 'late', source: 'seq', transform: [BADROW] }, base()], scales: [scaleX('seq')], marks: [bars('seq'), bars('late', 40)],
    },
    'the throw is upstream: the writer of the signal fails before its extent': {
      ...frame, data: [seq(), base([{ type: 'formula', expr: 'datum["o"]["v"]', as: 'q' }])], scales: [scaleX('seq')], marks: [bars('seq')],
    },
    'the throw is in a dataset declared between the reader and the writer': {
      ...frame, data: [seq(), { name: 'bad', values: [{ x: 1 }], transform: [BADROW] }, base()], scales: [scaleX('seq')], marks: [bars('seq')],
    },
    'a dataset declared before the throw runs even when it is ordered after a later writer': {
      ...frame, data: [seq(), base(), { name: 'bad', values: [{ x: 1 }], transform: [BADROW] }, { name: 'after', values: [{ v: 1 }] }],
      scales: [scaleX('seq')], marks: [bars('seq'), bars('after', 40)],
    },
    'a dataset derived from a reader that is ranked after the throw is ranked after it too': {
      ...frame, data: [seq(), { name: 'late', source: 'seq' }, { name: 'bad', values: [{ x: 1 }], transform: [BADROW] }, base()], scales: [scaleX('seq')], marks: [bars('seq'), bars('late', 40)],
    },
    'two throws: the first one in rank order stops the pass': {
      ...frame, data: [{ name: 'ok', values: [{ v: 1 }] }, { name: 'bad1', values: [{ x: 1 }], transform: [BADROW] }, { name: 'bad2', values: [{ x: 1 }], transform: [BADROW] }, { name: 'ok2', values: [{ v: 3 }] }],
      scales: [scaleX('ok')], marks: [bars('ok')],
    },
  }
  for (const [name, spec] of Object.entries(CASES2)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors.length, 'the case must make vega log an error').toBeGreaterThan(0)
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(spec)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors.length, 'the engine logs the failure').toBeGreaterThan(0)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      // what each dataset ended with: the render cannot tell a dataset that ran from one that did not (every mark is ranked after every dataset)
      expect(asterDatasets(spec)).toEqual(vega.datasets)
    }, 30_000)
  }
})

// A dataset that vega re-ranked past the scales and marks (it reads a signal a later dataset writes) throws after the marks that
// read nothing late ran, and vega draws them. Aster stops all of them (a known gap, see datasetRanksOf), so only the datasets are
// compared here: they are what the rank decides.
describe('a throw in a dataset re-ranked past the scales and marks: the datasets', () => {
  it('the datasets declared before it, after it and the writer it waits for', async () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega/v5.json', width: 300, height: 120,
      data: [
        { name: 'seq', transform: [{ type: 'sequence', start: { signal: 'ext[0]' }, stop: { signal: 'ext[1] + 1' }, as: 'v' }, { type: 'filter', expr: 'datum["o"]["v"]>0' }] },
        { name: 'plain', values: [{ v: 2 }] },
        { name: 'base', values: [{ x: 3 }, { x: 9 }], transform: [{ type: 'extent', field: 'x', signal: 'ext' }] },
      ],
      marks: [{ type: 'rect', from: { data: 'plain' }, encode: { update: { x: { value: 1 }, width: { value: 4 }, y: { value: 10 }, height: { value: 8 } } } }],
    }
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
    expect(vega.errors.length).toBeGreaterThan(0)
    expect(vega.datasets.plain).not.toBeNull()
    expect(vega.datasets.seq).toBeNull()
    expect(asterDatasets(spec)).toEqual(vega.datasets)
  }, 30_000)
})
