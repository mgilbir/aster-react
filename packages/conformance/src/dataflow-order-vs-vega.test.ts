/**
 * vega's dataflow orders operators by what they read: a transform parameter or expression that reads a signal an
 * `extent` / `bin` / `geojson` of ANOTHER dataset writes runs after that dataset, wherever the two are declared, and
 * a signal computed from the written one is up to date by then. The engine builds datasets in an order it derives from
 * the same reads. Each spec runs in real vega and in the engine; the picture must be equal and the engine must not
 * log an error on the way (the first pass of a build in declaration order read a signal that did not exist yet).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function vegaSvg(spec: Spec): Promise<{ svg: string; errors: unknown[] }> {
  const errors: unknown[] = []
  const logger = { level: () => logger, error: (...a: unknown[]) => { errors.push(a); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally { view.finalize() }
}

function engineSvg(spec: Spec): { svg: string; errors: unknown[] } {
  const errors: unknown[] = []
  const svg = renderSpec(structuredClone(spec) as never, { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } })
  return { svg, errors }
}

const bars = (data: string): Spec => ({
  type: 'rect', from: { data },
  encode: { update: { x: { scale: 'x', field: 'v' }, width: { value: 4 }, y: { signal: 'datum.v * 3' }, height: { value: 8 }, fill: { value: 'firebrick' } } },
})
const frame = { width: 300, height: 120, padding: 5, autosize: 'none' }
const scaleX = (data: string): Spec => ({ name: 'x', type: 'linear', domain: { data, field: 'v' }, range: 'width' })

/** D_k = sequence from the extent D_(k-1) wrote; the datasets are declared last to first. */
function chain(n: number): Spec {
  const data: Spec[] = []
  for (let k = n; k >= 2; k--) {
    data.push({
      name: `d${k}`,
      transform: [
        { type: 'sequence', start: { signal: `s${k - 1}[0]` }, stop: { signal: `s${k - 1}[1] + 2` }, as: 'v' },
        { type: 'extent', field: 'v', signal: `s${k}` },
      ],
    })
  }
  data.push({ name: 'd1', values: [{ v: 1 }, { v: 2 }], transform: [{ type: 'extent', field: 'v', signal: 's1' }] })
  return { ...frame, data, scales: [scaleX(`d${n}`)], marks: [bars(`d${n}`)] }
}

const CASES: Array<[string, Spec]> = [
  ['a reader declared before the writer', {
    ...frame,
    data: [
      { name: 'seq', transform: [{ type: 'sequence', start: { signal: 'ext[0]' }, stop: { signal: 'ext[1] + 1' }, as: 'v' }] },
      { name: 'base', values: [{ x: 3 }, { x: 9 }, { x: 5 }], transform: [{ type: 'extent', field: 'x', signal: 'ext' }] },
    ],
    scales: [scaleX('seq')], marks: [bars('seq')],
  }],
  ['through a signal computed from the written one', {
    ...frame,
    signals: [{ name: 'span', update: 'ext[1] - ext[0]' }],
    data: [
      { name: 'seq', transform: [{ type: 'sequence', start: { signal: 'ext[0]' }, stop: { signal: 'ext[1] + 1' }, as: 'v' }] },
      { name: 'late', source: 'seq', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * span' }] },
      { name: 'base', values: [{ x: 3 }, { x: 9 }, { x: 5 }], transform: [{ type: 'extent', field: 'x', signal: 'ext' }] },
    ],
    scales: [{ name: 'x', type: 'linear', domain: { data: 'late', field: 'w' }, range: 'width' }],
    marks: [{ ...bars('late'), encode: { update: { x: { scale: 'x', field: 'w' }, width: { value: 4 }, y: { value: 10 }, height: { value: 8 }, fill: { value: 'red' } } } }],
  }],
  ['a sequence step read from a signal computed from another dataset\'s extent', {
    ...frame,
    data: [
      { name: 'grid', transform: [{ type: 'sequence', start: { signal: 'xe[0]' }, stop: { signal: 'xe[1] + 1' }, step: { signal: 'stp' }, as: 'v' }] },
      { name: 'src', values: [{ x: 1 }, { x: 4 }, { x: 8 }, { x: 13 }], transform: [{ type: 'extent', field: 'x', signal: 'xe' }] },
    ],
    signals: [{ name: 'stp', update: '(xe[1] - xe[0]) / 3' }],
    scales: [scaleX('grid')], marks: [bars('grid')],
  }],
  ['a chain of 5 datasets, declared last to first', chain(5)],
]

describe('dataset build order follows the signals datasets write (vs vega)', () => {
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(spec)
      expect(want.errors).toEqual([])
      const got = engineSvg(spec)
      expect(got.errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))).toEqual([])
    })
  }
})
