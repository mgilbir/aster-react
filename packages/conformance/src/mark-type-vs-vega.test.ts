// @vitest-environment node
/**
 * A mark's `type` against vega (C238): vega draws its twelve mark types and fails on anything else -- an unknown name, a name of
 * Vega-Lite's (`circle`, `square`, `bar`, `tick`, `point`, `geoshape`), another spelling, a missing or non-string type -- when it
 * renders (`Cannot read properties of undefined (reading 'tag')`), at the top level and inside a group. Aster must draw exactly the
 * types vega draws and refuse the rest with vega's text, never draw an empty or a guessed mark.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import '@aster-charts/core/geo'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>

const VEGA_TYPES = ['arc', 'area', 'group', 'image', 'line', 'path', 'rect', 'rule', 'shape', 'symbol', 'text', 'trail']
const NOT_TYPES: unknown[] = ['circle', 'square', 'bar', 'tick', 'point', 'geoshape', 'bogus', '', 'Rect', 'SYMBOL', ' rect', 'rect ', 'marks', 'legend', 'axis', 'title', 0, 1, true, null, { type: 'rect' }, ['re', 'ct'], [], ['circle']]
/** vega looks a type up by name: a list holding one name is that type, drawn with quirks of its own (see the deviation below). */
const LISTED_TYPES: unknown[] = [['rect'], [['symbol']], ['text'], ['rule'], ['group']]
const MISSING = Symbol('missing')

const mark = (type: unknown): Obj => ({
  ...(type === MISSING ? {} : { type }),
  // (a shape mark draws the shape a geoshape transform makes; without one vega fails reading it)
  ...(type === 'shape' ? { from: { data: 'pt' }, transform: [{ type: 'geoshape', projection: 'p' }] } : {}),
  encode: { update: { x: { value: 10 }, y: { value: 10 }, x2: { value: 30 }, y2: { value: 30 }, size: { value: 100 }, fill: { value: 'red' }, text: { value: 'a' } } },
})
const DATA = [{ name: 'pt', values: [{ type: 'Point', coordinates: [10, 10] }] }]
const BASE = { width: 50, height: 50, data: DATA, projections: [{ name: 'p', type: 'identity' }] }
const specs = (type: unknown): Record<string, Obj> => ({
  'at the top level': { ...BASE, marks: [mark(type)] },
  'inside a group': { ...BASE, marks: [{ type: 'group', marks: [mark(type)] }] },
  'beside a valid mark': { ...BASE, marks: [mark('rect'), mark(type)] },
})

async function vegaOutcome(spec: Obj): Promise<string> {
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: vega.None })
    await view.runAsync()
    await view.toSVG()
    view.finalize()
    return 'ok'
  } catch (e) {
    return (e as Error).message
  }
}
function asterOutcome(spec: Obj): string {
  try {
    renderSpec(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return (e as Error).message
  }
}

describe('a mark type is drawn or refused as vega draws or refuses it', () => {
  for (const type of [...VEGA_TYPES, ...NOT_TYPES, MISSING]) {
    for (const [where, spec] of Object.entries(specs(type))) {
      it(`${type === MISSING ? 'no type' : JSON.stringify(type)} ${where}`, async () => {
        const want = await vegaOutcome(spec)
        // (not vacuous: vega draws exactly its own types)
        expect(want === 'ok', `vega: ${want}`).toBe(VEGA_TYPES.includes(type as string))
        expect(asterOutcome(spec)).toBe(want)
        if (want === 'ok') {
          const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
          await view.runAsync()
          expect(diffCanonical(canonicalizeSvg(await view.toSVG()), canonicalizeSvg(renderSpec(structuredClone(spec) as never)))).toEqual([])
          view.finalize()
        }
      })
    }
  }

  it('a type written as a list holding a name is refused (a documented deviation: vega looks it up by name and draws it with quirks of its own)', async () => {
    for (const type of LISTED_TYPES) {
      const spec = { width: 50, height: 50, marks: [{ ...mark(type), ...(String(type) === 'group' ? { marks: [mark('rect')] } : {}) }] }
      expect(await vegaOutcome(spec), JSON.stringify(type)).toBe('ok')
      expect(asterOutcome(spec), JSON.stringify(type)).toBe("Cannot read properties of undefined (reading 'tag')")
    }
  })
})
