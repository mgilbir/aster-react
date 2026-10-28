/**
 * The scales a group mark declares are visible to the expressions of its content (`bandwidth('cx')`, `scale('cx', v)`,
 * `domain('cx')`, `range('cx')`), shadowing the enclosing ones and gone outside the group. Every case is judged against real vega
 * with the strict canonicalizer.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const VALUES = [{ g: 'u', a: 'p', v: 3 }, { g: 'u', a: 'q', v: 5 }, { g: 'w', a: 'p', v: 4 }, { g: 'w', a: 'r', v: 8 }, { g: 'w', a: 's', v: 1 }]
const rect = (update: Record<string, unknown>): Spec => ({
  type: 'rect', from: { data: 'facet' },
  encode: { update: { y: { value: 0 }, height: { value: 8 }, fill: { value: 'tomato' }, ...update } },
})
const grouped = (groupScales: unknown[], rootScales: unknown[], content: Spec[], size = 60): Spec => ({
  padding: 5, autosize: 'pad',
  signals: [{ name: 'step', value: 14 }],
  data: [{ name: 'table', values: VALUES }],
  scales: rootScales,
  marks: [{
    type: 'group',
    from: { facet: { name: 'facet', data: 'table', groupby: ['g'] } },
    encode: { update: { width: { value: size }, height: { value: 30 }, stroke: { value: '#ccc' } } },
    scales: groupScales,
    marks: content,
  }],
})
const cx = { name: 'cx', type: 'band', domain: { data: 'facet', field: 'a', sort: true }, range: { step: { signal: 'step' } }, paddingInner: 0.1 }

const CASES: Array<[string, Spec]> = [
  ['bandwidth of a group scale', grouped([cx], [], [rect({ x: { scale: 'cx', field: 'a' }, width: { signal: "bandwidth('cx')" } })])],
  ['scale() of a group scale', grouped([cx], [], [rect({ x: { signal: "scale('cx', datum.a)" }, width: { value: 6 } })])],
  ['domain() and range() of a group scale', grouped([cx], [], [rect({ x: { value: 0 }, width: { signal: "length(domain('cx')) * 10 + range('cx')[1] / 100" } })])],
  ['a group scale over a root scale of the same name', grouped([{ ...cx, name: 'k' }], [{ name: 'k', type: 'linear', domain: [0, 10], range: [0, 100] }], [rect({ x: { value: 0 }, width: { signal: "bandwidth('k')" } })])],
  ['a root scale read inside a group that has scales', grouped([cx], [{ name: 'k', type: 'linear', domain: [0, 10], range: [0, 100] }], [rect({ x: { signal: "scale('k', 4)" }, width: { signal: "bandwidth('cx')" } })])],
  ['a nested group scale shadows the outer one', grouped([cx], [], [{
    type: 'group', from: { data: 'facet' }, encode: { update: { width: { value: 20 }, height: { value: 10 } } },
    scales: [{ name: 'cx', type: 'band', domain: ['z'], range: [0, 20] }],
    marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: "bandwidth('cx')" }, height: { value: 4 }, fill: { value: 'navy' } } } }],
  }, rect({ x: { scale: 'cx', field: 'a' }, width: { signal: "bandwidth('cx')" } })])],
]

describe('the scales of a group are visible to its expressions like in vega', () => {
  it.each(CASES)('%s', async (_n, spec) => {
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
  })
})
