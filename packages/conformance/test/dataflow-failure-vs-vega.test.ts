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
  'a filter that throws, with a title and a legend': (s) => {
    s.data[0].transform = [{ type: 'filter', expr: BAD }]
    s.title = { text: 'T' }
    s.scales.push({ name: 'col', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] })
    s.legends = [{ fill: 'col' }]
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

// A mark whose encode throws stops the pass at that operator. vega-runtime connects an operator to one made after it by re-ranking it
// (and what hangs off it) past everything created so far: a scale over data of its own scope is that, so the encode that reads it
// is ranked after every operator that reads no such scale, the guides and the title over scales with literal domains among them,
// and before the guides over a scale that is itself ranked late (made after this mark's encode). The item that threw keeps the
// channels it set before the failing one, with the edges (`y2`) never turned into a size: it draws as a zero-height rect.
describe('a mark encode that throws where a scale is ranked late', () => {
  const THROWS = { signal: 'datum["nosuch"]["x"]' }
  const frame = (extra: any): any => ({
    $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 120, padding: 5,
    data: [{ name: 't', values: [1, 2, 3, 4].map((v, i) => ({ v, k: 'r' + i })) }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { value: 0 }, y2: { value: 60 }, fill: THROWS } } }],
    ...extra,
  })
  const bandX = { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 }
  const lateColour = { name: 'colour', type: 'linear', domain: { data: 't', field: 'v' }, range: { scheme: 'blues' } }
  const literalColour = { name: 'colour', type: 'linear', domain: [1, 4], range: { scheme: 'blues' } }
  const CASES3: Record<string, any> = {
    'an edge (y2) set before the property that throws is never made a height': frame({
      scales: [], marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { value: 1 }, width: { value: 10 }, y: { value: 0 }, y2: { value: 60 }, fill: THROWS } } }],
    }),
    'a gradient legend over a late scale has its group, title and an unmade gradient': frame({
      scales: [bandX, lateColour], legends: [{ fill: 'colour', type: 'gradient', title: 'T' }],
    }),
    'a gradient legend over a scale that is not late is made whole': frame({
      scales: [bandX, literalColour], legends: [{ fill: 'colour', type: 'gradient', title: 'T' }],
    }),
    'a symbol legend over a late scale': frame({
      scales: [bandX, { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'v' }, range: 'category' }], legends: [{ fill: 'colour' }],
    }),
    'a discrete legend over a late scale': frame({
      scales: [bandX, { name: 'q', type: 'quantize', domain: { data: 't', field: 'v' }, range: ['#eee', '#999', '#333'] }], legends: [{ fill: 'q' }],
    }),
    'a legend over a scale that is not late and one that is': frame({
      scales: [bandX, lateColour, { name: 'o', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }],
      legends: [{ fill: 'o' }, { fill: 'colour', type: 'gradient' }],
    }),
    'an axis and a title': frame({ scales: [bandX], axes: [{ orient: 'bottom', scale: 'x' }], title: { text: 'T' } }),
    'a group whose scales are its own, with a legend, an axis and a title': {
      $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 120, padding: 5,
      data: [{ name: 't', values: [1, 2, 3, 4].map((v, i) => ({ v, k: 'r' + i })) }],
      marks: [{
        type: 'group', encode: { enter: { width: { value: 200 }, height: { value: 100 } } },
        scales: [bandX, lateColour], legends: [{ fill: 'colour', type: 'gradient' }], axes: [{ orient: 'bottom', scale: 'x' }], title: { text: 'T' },
        marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { value: 0 }, y2: { value: 60 }, fill: THROWS } } }],
      }],
    },
    'a group over the scales of the view: they are not late for its instance': {
      $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 120, padding: 5,
      data: [{ name: 't', values: [1, 2, 3, 4].map((v, i) => ({ v, k: 'r' + i })) }],
      scales: [bandX, lateColour],
      marks: [{
        type: 'group', encode: { enter: { width: { value: 200 }, height: { value: 100 } } },
        legends: [{ fill: 'colour', type: 'gradient' }], title: { text: 'T' },
        marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { value: 0 }, y2: { value: 60 }, fill: THROWS } } }],
      }],
    },
    // (vega calls the colour scale with a domain that has no finite end: the interpolator it builds from the extent of text that reads
    // as infinities is not a function of the value, and the scale call throws)
    'a gradient legend whose scale cannot be called': frame({
      data: [{ name: 't', values: [{ v: 'Infinity', k: 'r0' }, { v: '-Infinity', k: 'r1' }, { v: 1, k: 'r2' }, { v: 2, k: 'r3' }] }],
      scales: [bandX, lateColour], legends: [{ fill: 'colour', type: 'gradient' }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { value: 0 }, y2: { value: 60 }, fill: { scale: 'colour', field: 'v' } } } }],
    }),
  }
  for (const [name, spec] of Object.entries(CASES3)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors.length, 'the case must make vega log an error').toBeGreaterThan(0)
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(spec)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors.length, 'the engine logs the failure').toBeGreaterThan(0)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 4)).toEqual([])
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
