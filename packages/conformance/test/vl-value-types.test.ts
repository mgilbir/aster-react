// @vitest-environment node
/**
 * Values of the wrong type, or null where vega-lite reads "unset" (C245): schema-invalid inputs that compiled to a chart other than
 * vega-lite's. Each is now refused with a VLCompileError naming its path, over the views it applies to (a unit, a layer, a concat); the
 * same spec with a value of the right type draws as vega-lite draws it.
 */
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const data = { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }] }
const enc = { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } }
type Spec = Record<string, unknown>
const withY = (y: Record<string, unknown>): Record<string, unknown> => ({ ...enc, y: { ...enc.y, ...y } })
const withX = (x: Record<string, unknown>): Record<string, unknown> => ({ ...enc, x: { ...enc.x, ...x } })

/** [what, the path the refusal names, (bad or good) => a unit's parts] */
const CASES: Array<[string, RegExp, (good: boolean) => Spec]> = [
  ['name 5', /name: must be a string/, (g) => ({ name: g ? 'n' : 5 })],
  ['description 5', /description: must be a string/, (g) => ({ description: g ? 'd' : 5 })],
  ['padding null', /padding: must be/, (g) => ({ padding: g ? 5 : null })],
  ['config.view 5', /config\.view: must be an object/, (g) => ({ config: { view: g ? { stroke: null } : 5 } })],
  ['config.font 5', /config\.font: must be a string/, (g) => ({ config: { font: g ? 'serif' : 5 } })],
  ['config.numberFormat 5', /config\.numberFormat: must be a string/, (g) => ({ config: { numberFormat: g ? '.1f' : 5 } })],
  ['config.axis.grid null', /config\.axis\.grid: must be a boolean/, (g) => ({ config: { axis: { grid: g ? false : null } } })],
  ['axis.format 5', /axis\.format: must be/, (g) => ({ encoding: withY({ axis: { format: g ? '.1f' : 5 } }) })],
  ['axis.labelAngle a string', /axis\.labelAngle: must be/, (g) => ({ encoding: withY({ axis: { labelAngle: g ? 30 : 'str' } }) })],
  ['opacity value a string', /opacity\.value: must be/, (g) => ({ encoding: { ...enc, opacity: { value: g ? 0.5 : 'str' } } })],
  ['scale.paddingInner null', /scale\.paddingInner: must be/, (g) => ({ encoding: withX({ scale: { paddingInner: g ? 0.3 : null } }) })],
  ['scale.padding null', /scale\.padding: must be/, (g) => ({ encoding: withX({ scale: { padding: g ? 0.3 : null } }) })],
]
const VIEWS: Array<[string, (parts: Spec) => Spec]> = [
  ['unit', (p) => ({ data, mark: 'bar', encoding: enc, ...p })],
  ['layer', (p) => { const { encoding, config, padding, ...rest } = p; return { data, ...(config ? { config } : {}), ...(padding !== undefined ? { padding } : {}), layer: [{ mark: 'bar', encoding: encoding ?? enc, ...rest }, { mark: 'tick', encoding: enc }] } }],
  ['concat', (p) => { const { encoding, config, padding, ...rest } = p; return { data, ...(config ? { config } : {}), ...(padding !== undefined ? { padding } : {}), hconcat: [{ mark: 'bar', encoding: encoding ?? enc, ...rest }, { mark: 'bar', encoding: enc }] } }],
]

describe('a value of the wrong type is refused by its path; the right type draws as vega-lite draws it', () => {
  for (const [what, says, parts] of CASES) {
    for (const [vName, view] of VIEWS) {
      it(caseName(what, vName), async () => {
        const bad = view(parts(false))
        expect(() => compile(JSON.parse(JSON.stringify(bad)))).toThrow(VLCompileError)
        expect(() => compile(JSON.parse(JSON.stringify(bad)))).toThrow(says)
        await drawsLikeVegaLite(view(parts(true)))
      }, 30_000)
    }
  }
  it('facet spacing a string', () => {
    expect(() => compile({ data, facet: { column: { field: 'a', type: 'nominal' } }, spacing: 'str', spec: { mark: 'bar', encoding: enc } } as never)).toThrow(/spacing: must be/)
  })
})
