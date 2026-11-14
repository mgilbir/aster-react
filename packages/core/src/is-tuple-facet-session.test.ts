import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { VgSpec } from './types.js'

// A chart that only asks of Vega-Lite's `facet` signal registers tuples only when the host sets `facet` to an object it does not
// know: a later evaluation that does must answer as a first one, whatever the evaluations before it kept
const spec = {
  width: 100, height: 60,
  data: [{ name: 't', values: [] }, { name: 'u', values: [], transform: [{ type: 'formula', expr: 'datum.k', as: 'kk' }] }, { name: 'v', values: [] }],
  signals: [{ name: 'facet', value: {}, on: [{ events: [{ source: 'scope', type: 'pointermove' }], update: 'isTuple(facet) ? facet : group("cell").datum' }] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { signal: "'' + isTuple(facet)" } } } }, { type: 'symbol', from: { data: 'u' } }],
} as unknown as VgSpec

describe("isTuple(facet) set by the host, in a session", () => {
  // (t is drawn as it is, u through a formula, v not drawn at all: vega ingests the rows of each)
  for (const name of ['t', 'u', 'v'] as const) it(`a row of ${name} the host gives, after evaluations that did not register`, () => {
    const rows = [Object.freeze({ k: 'a' }), Object.freeze({ k: 'b' })]
    const session = createChartSession()
    const copy = (): object[] => rows.map((r) => ({ ...r }))
    const data = { t: name === 't' ? rows : copy(), u: name === 'u' ? rows : copy(), v: name === 'v' ? rows : copy() }
    expect(renderSceneToSvg(session.evaluate(spec, { data }))).toContain('>false<')
    expect(renderSceneToSvg(session.evaluate(spec, { data, signals: { facet: { k: 'x' } } }))).toContain('>false<')
    const svg = renderSceneToSvg(session.evaluate(spec, { data, signals: { facet: rows[1] } }))
    expect(svg).toContain('>true<')
    expect(svg).not.toContain('>false<')
  })
})
