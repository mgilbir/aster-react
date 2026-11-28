// @vitest-environment node
/**
 * A transform output named `__proto__` (C546): vega writes every output as `tuple[name] = value`, so the name sets the tuple's
 * prototype (a value that is no object is dropped) and never touches Object.prototype. Every transform that names its outputs
 * must do the same, the formula among them; what is compared is the datasets (own keys, then a field read through the prototype),
 * and Object.prototype afterwards.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'

type Obj = Record<string, unknown>
const ROWS = [{ k: 'x', v: 1, t: 1e12 }, { k: 'y', v: 2, t: 2e12 }, { k: 'x', v: 3, t: 3e12 }]
const P = '__proto__'
const PIPES: Record<string, Obj[]> = {
  'formula of a string, then grouped by it': [{ type: 'formula', expr: 'datum.k', as: P }, { type: 'aggregate', groupby: [P], fields: ['v'], ops: ['sum'], as: ['s'] }],
  'formula of an object, then a field read through it': [{ type: 'formula', expr: '{w: datum.v * 10}', as: P }, { type: 'formula', expr: 'datum.w', as: 'got' }],
  'fold': [{ type: 'fold', fields: ['v'], as: [P, 'value'] }],
  'project': [{ type: 'project', fields: ['k', 'v'], as: [P, 'v'] }],
  'window': [{ type: 'window', ops: ['row_number'], as: [P] }],
  'joinaggregate': [{ type: 'joinaggregate', ops: ['count'], as: [P] }],
  'aggregate as': [{ type: 'aggregate', groupby: ['k'], ops: ['count'], as: [P] }],
  'bin': [{ type: 'bin', field: 'v', extent: [0, 4], as: [P, 'b1'] }],
  'timeunit': [{ type: 'timeunit', field: 't', units: ['year'], as: [P, 'u1'] }],
  'stack': [{ type: 'stack', field: 'v', as: [P, 'y1'] }],
  'identifier': [{ type: 'identifier', as: P }],
  'regression': [{ type: 'regression', x: 'v', y: 'v', as: [P, 'y'] }],
}

/** Each row's own keys and values, and what its prototype is (a Date, a plain object, Object.prototype). */
const own = (rows: unknown): string => JSON.stringify((rows as Obj[]).map((r) => {
  const proto = Object.getPrototypeOf(r)
  const kind = proto === Object.prototype ? 'Object.prototype' : proto instanceof Date || Object.prototype.toString.call(proto) === '[object Date]' ? 'a Date' : JSON.stringify(Object.entries(proto ?? {}))
  return [Object.entries(r), kind]
}))
async function viaVega(spec: Obj): Promise<unknown> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: vega.None })
  await view.runAsync()
  const rows = view.data('src')
  view.finalize()
  return rows
}

describe('an output named __proto__ is written as vega writes it', () => {
  for (const [name, transform] of Object.entries(PIPES)) {
    it(name, async () => {
      const spec = { data: [{ name: 'src', values: ROWS, transform }] }
      const want = own(await viaVega(spec))
      const got = own(datasetsOfScene(evaluateChart(compileChart(structuredClone(spec) as never), {})).get('src'))
      expect(got).toBe(want)
      expect(Object.keys(Object.prototype)).toEqual([])
      expect(({} as Obj).w).toBeUndefined()
    })
  }
})
