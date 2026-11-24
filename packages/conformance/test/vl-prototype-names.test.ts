// @vitest-environment node
/**
 * A field, a dataset, an output (`as`) or a parameter named as a member of Object.prototype (`constructor`, `toString`, `valueOf`,
 * `__proto__` ...), in every place a spec names one (C442). Vega keeps names in plain objects, so its handling of these is irregular:
 * vega-lite 6.4.3's output fails in Vega, or draws a chart that is not the chart of an ordinary name, in most places, and is right in a
 * few. Each place x each member is classified against vega-lite through real Vega, with a control - the same spec with an ordinary name
 * of the same length (so text is laid out alike), its SVG and its datasets compared with the name put back:
 *  - vega-lite fails, or draws other than the control: @aster-charts/vl refuses with a VLCompileError naming it (DECISIONS Q9);
 *  - vega-lite draws the control's chart: @aster-charts/vl draws the same SVG.
 * Either way nothing is written to Object.prototype.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'

type Spec = Record<string, unknown>
type Row = Record<string, unknown>
const NAMES = Object.getOwnPropertyNames(Object.prototype)
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }

const num = (N: string): Row[] => [{ [N]: 4, k: 'a', t: '2020-01-05' }, { [N]: 6, k: 'b', t: '2020-02-05' }, { [N]: 9, k: 'a', t: '2020-03-05' }]
const str = (N: string): Row[] => [{ [N]: 'A', k: 1, t: '2020-01-05' }, { [N]: 'B', k: 3, t: '2020-02-05' }]
const date = (N: string): Row[] => [{ [N]: '2020-01-05', k: 1 }, { [N]: '2020-03-05', k: 3 }]
const CONTEXTS: Record<string, (N: string) => Spec> = {
  'x nominal': (N) => ({ data: { values: str(N) }, mark: 'bar', encoding: { x: { field: N, type: 'nominal' }, y: { field: 'k', type: 'quantitative' } } }),
  'y quantitative': (N) => ({ data: { values: num(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'color nominal': (N) => ({ data: { values: str(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, color: { field: N, type: 'nominal' } } }),
  'tooltip': (N) => ({ data: { values: num(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, tooltip: { field: N, type: 'quantitative' } } }),
  'detail': (N) => ({ data: { values: str(N) }, mark: 'line', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'k', type: 'quantitative' }, detail: { field: N, type: 'nominal' } } }),
  'text': (N) => ({ data: { values: str(N) }, mark: 'text', encoding: { x: { field: 'k', type: 'quantitative' }, text: { field: N, type: 'nominal' } } }),
  'aggregate sum': (N) => ({ data: { values: num(N) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative', aggregate: 'sum' } } }),
  'bin': (N) => ({ data: { values: num(N) }, mark: 'bar', encoding: { x: { field: N, type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } } }),
  'timeUnit channel': (N) => ({ data: { values: date(N) }, mark: 'point', encoding: { x: { field: N, type: 'temporal', timeUnit: 'month' }, y: { field: 'k', type: 'quantitative' } } }),
  'temporal channel': (N) => ({ data: { values: date(N) }, mark: 'point', encoding: { x: { field: N, type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'sort by field': (N) => ({ data: { values: num(N) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal', sort: { field: N, op: 'sum' } }, y: { field: N, type: 'quantitative' } } }),
  'timeUnit transform': (N) => ({ data: { values: date(N) }, transform: [{ timeUnit: 'month', field: N, as: 'm' }], mark: 'point', encoding: { x: { field: 'm', type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'calculate as': (N) => ({ data: { values: num('v') }, transform: [{ calculate: 'datum.v * 2', as: N }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'filter field': (N) => ({ data: { values: str(N) }, transform: [{ filter: { field: N, equal: 'A' } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'k', type: 'quantitative' } } }),
  'aggregate transform field': (N) => ({ data: { values: num(N) }, transform: [{ aggregate: [{ op: 'sum', field: N, as: 's' }], groupby: ['k'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'aggregate transform as': (N) => ({ data: { values: num('v') }, transform: [{ aggregate: [{ op: 'sum', field: 'v', as: N }], groupby: ['k'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'fold': (N) => ({ data: { values: num(N) }, transform: [{ fold: [N] }], mark: 'bar', encoding: { x: { field: 'key', type: 'nominal' }, y: { field: 'value', type: 'quantitative' } } }),
  'window as': (N) => ({ data: { values: num('v') }, transform: [{ window: [{ op: 'rank', as: N }] }], mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'bin transform field': (N) => ({ data: { values: num(N) }, transform: [{ bin: true, field: N, as: 'b' }], mark: 'bar', encoding: { x: { field: 'b', type: 'quantitative' }, y: { aggregate: 'count', type: 'quantitative' } } }),
  'joinaggregate field': (N) => ({ data: { values: num(N) }, transform: [{ joinaggregate: [{ op: 'sum', field: N, as: 's' }] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'lookup key': (N) => ({ data: { values: str(N) }, transform: [{ lookup: N, from: { data: { values: [{ [N]: 'A', w: 5 }, { [N]: 'B', w: 7 }] }, key: N, fields: ['w'] } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'w', type: 'quantitative' } } }),
  'size': (N) => ({ data: { values: num(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, size: { field: N, type: 'quantitative' } } }),
  'opacity': (N) => ({ data: { values: num(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, opacity: { field: N, type: 'quantitative' } } }),
  'shape': (N) => ({ data: { values: str(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, shape: { field: N, type: 'nominal' } } }),
  'x2': (N) => ({ data: { values: num(N) }, mark: 'bar', encoding: { y: { field: 'k', type: 'nominal' }, x: { field: 'v', type: 'quantitative' }, x2: { field: N } } }),
  'theta': (N) => ({ data: { values: num(N) }, mark: 'arc', encoding: { theta: { field: N, type: 'quantitative' }, color: { field: 'k', type: 'nominal' } } }),
  'row facet': (N) => ({ data: { values: str(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, row: { field: N, type: 'nominal' } } }),
  'order': (N) => ({ data: { values: num(N) }, mark: 'line', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'k', type: 'nominal' }, order: { field: N, type: 'quantitative' } } }),
  'condition field': (N) => ({ data: { values: str(N) }, params: [{ name: 'p', select: 'point' }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, color: { condition: { param: 'p', field: N, type: 'nominal' }, value: 'grey' } } }),
  'bin color': (N) => ({ data: { values: num(N) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, color: { field: N, type: 'quantitative', bin: true } } }),
  'timeUnit transform as': (N) => ({ data: { values: date('d') }, transform: [{ timeUnit: 'month', field: 'd', as: N }], mark: 'point', encoding: { x: { field: N, type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'window field': (N) => ({ data: { values: num(N) }, transform: [{ window: [{ op: 'sum', field: N, as: 's' }] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'pivot': (N) => ({ data: { values: str(N) }, transform: [{ pivot: N, value: 'k' }], mark: 'point', encoding: { x: { field: 'A', type: 'quantitative' } } }),
  'impute': (N) => ({ data: { values: num(N) }, transform: [{ impute: N, key: 'k', value: 0 }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'density': (N) => ({ data: { values: num(N) }, transform: [{ density: N }], mark: 'area', encoding: { x: { field: 'value', type: 'quantitative' }, y: { field: 'density', type: 'quantitative' } } }),
  'regression': (N) => ({ data: { values: [{ [N]: 4, v: 1 }, { [N]: 6, v: 2 }, { [N]: 9, v: 4 }] }, transform: [{ regression: N, on: 'v' }], mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'quantile': (N) => ({ data: { values: num(N) }, transform: [{ quantile: N }], mark: 'point', encoding: { x: { field: 'prob', type: 'quantitative' }, y: { field: 'value', type: 'quantitative' } } }),
  'flatten': (N) => ({ data: { values: [{ [N]: [1, 2], k: 'a' }] }, transform: [{ flatten: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'stack transform': (N) => ({ data: { values: num(N) }, transform: [{ stack: N, groupby: ['k'], as: ['s0', 's1'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's0', type: 'quantitative' }, y2: { field: 's1' } } }),
  'lookup as': (N) => ({ data: { values: str('c') }, transform: [{ lookup: 'c', from: { data: { values: [{ c: 'A', w: 5 }] }, key: 'c', fields: ['w'] }, as: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'parse key': (N) => ({ data: { values: num(N), format: { parse: { [N]: 'number' } } }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'repeat': (N) => ({ data: { values: num(N) }, repeat: [N], spec: { mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }),
  'extent param': (N) => ({ data: { values: num('v') }, transform: [{ extent: 'v', param: N }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'dataset name': (N) => ({ datasets: { [N]: num('v') }, data: { name: N }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'param name': (N) => ({ data: { values: num('v') }, params: [{ name: N, value: 5 }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, size: { value: { expr: `${N} * 20` } } } }),
  'selection name': (N) => ({ data: { values: num('v') }, params: [{ name: N, select: 'point' }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { condition: { param: N, value: 'red' }, value: 'grey' } } }),
  'selection fields': (N) => ({ data: { values: str(N) }, params: [{ name: 'p', select: { type: 'point', fields: [N] } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: N, type: 'nominal' }, color: { condition: { param: 'p', value: 'red' }, value: 'grey' } } }),
}

/** The spec with the name `from` (a whole string, or a parameter in an expression) replaced by `to`. */
const sub = (spec: Spec, from: string, to: string): Spec => JSON.parse(JSON.stringify(spec).replaceAll(`"${from}"`, `"${to}"`).replaceAll(`${from} *`, `${to} *`))

/**
 * Run `f` (vega-lite, or real Vega) and put the built-in prototypes back as they were: real Vega, given these names, can write to
 * Object.prototype itself, and a later case would run in a broken process. (@aster-charts/vl's own compile is checked not to write.)
 */
async function restoringPrototypes<T>(f: () => Promise<T>): Promise<T> {
  const saved = [Object.prototype, Array.prototype, Function.prototype].map((p) => [p, Object.getOwnPropertyDescriptors(p)] as const)
  try {
    return await f()
  } finally {
    for (const [p, descriptors] of saved) {
      for (const key of Reflect.ownKeys(p)) if (!Object.hasOwn(descriptors, key)) delete (p as Record<PropertyKey, unknown>)[key]
      for (const key of Reflect.ownKeys(descriptors)) Object.defineProperty(p, key, (descriptors as Record<PropertyKey, PropertyDescriptor>)[key]!)
    }
  }
}

/** vega-lite's chart of `spec`, or why there is none. */
const vegaLite = (spec: Spec): Promise<{ svg: string; data: string } | { failed: string }> => restoringPrototypes(() => vegaLite0(spec))
async function vegaLite0(spec: Spec): Promise<{ svg: string; data: string } | { failed: string }> {
  let out: Spec
  try {
    out = (vl as any).compile(plain(spec), { logger: quiet }).spec
  } catch (e) {
    return { failed: `vega-lite: ${(e as Error).message}` }
  }
  const r = await renderWithVegaChecked(out)
  if (r.errors.length) return { failed: `vega: ${r.errors.join('; ')}` }
  return { svg: r.svg, data: JSON.stringify(Object.values(r.datasets)) }
}

const prototypeKeys = (): string => Reflect.ownKeys(Object.prototype).map(String).sort().join(',')

describe('a name that is a member of Object.prototype is refused where vega-lite\'s chart is wrong, and drawn as vega-lite draws it elsewhere', () => {
  for (const [place, make] of Object.entries(CONTEXTS)) {
    it(place, async () => {
      const problems: string[] = []
      for (const N of NAMES) {
        const spec = make(N)
        const ref = await vegaLite(spec)
        const ctrlName = 'q'.repeat(N.length)
        const ctrl = await vegaLite(sub(spec, N, ctrlName))
        if ('failed' in ctrl) throw new Error(`${place}: the control with an ordinary name does not draw (${ctrl.failed})`)
        const right = !('failed' in ref) && ctrl.svg.replaceAll(ctrlName, N) === ref.svg && ctrl.data.replaceAll(ctrlName, N) === ref.data
        const before = prototypeKeys()
        let ours: Spec | undefined
        let error: unknown
        try {
          ours = compile(plain(spec)) as Spec
        } catch (e) {
          error = e
        }
        if (prototypeKeys() !== before) problems.push(`${N}: Object.prototype changed`)
        if (!right) {
          const why = 'failed' in ref ? ref.failed : 'vega-lite draws other than with an ordinary name'
          if (!(error instanceof VLCompileError) || !error.message.includes(JSON.stringify(N))) problems.push(`${N}: ${why}, so it must be refused by name; got ${error ? String(error) : 'a chart'}`)
          continue
        }
        if (error !== undefined) { problems.push(`${N}: vega-lite draws it right, but @aster-charts/vl throws ${String(error)}`); continue }
        const mine = await restoringPrototypes(() => renderWithVegaChecked(plain(ours)))
        if (mine.errors.length || mine.svg !== (ref as { svg: string }).svg) problems.push(`${N}: vega-lite draws it right, and @aster-charts/vl draws ${mine.errors.length ? `errors ${mine.errors.join('; ')}` : 'another SVG'}`)
      }
      expect(problems).toEqual([])
    }, 120_000)
  }
})
