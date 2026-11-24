// @vitest-environment node
/**
 * A name with a backslash of its own (C184, C442): a field path with an escaped backslash (`x\\y` in the spec reads the column `x\y`), or
 * an output / dataset holding one. vega-lite 6.4.3 writes a field into Vega's `field` properties without escaping a backslash, so Vega
 * reads another column wherever vega-lite does that (a scale domain, an aggregate, a bin, a facet ...), and the right one where vega-lite
 * writes an expression or passes the path on as written. Every place a spec names something (vl-name-places.ts, and the channels and
 * transform parts below) x a few such names is classified against vega-lite through real Vega, with a control - the same spec with an
 * ordinary name of the same length, its SVG compared with the name as written put back, its datasets with the column put back:
 *  - vega-lite fails, or draws other than the control: @aster-charts/vl refuses with a VLCompileError naming it (DECISIONS Q9), or, where
 *    Vega rejects vega-lite's output (a parameter named in an expression), Vega rejects @aster-charts/vl's with the same messages;
 *  - vega-lite draws the control's chart: @aster-charts/vl draws the same SVG.
 * The other escapes - of a letter (`x\y`, the column `xy`), a dot, a bracket - are read right by vega-lite in most places, and lost
 * where it writes the path as a literal name (an output, a regression's or a flatten's field, a repeat, a dot in a parse key).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { NAME_PLACES } from './vl-name-places.js'

type Spec = Record<string, unknown>
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }
/** The column a one-piece field path reads (vega's splitAccessPath: a backslash escapes the next character). */
const column = (path: string): string => path.replace(/\\(.)/g, '$1')
/** As the spec writes them: `x\\y`, `\\ab`, `ab\\` (escaped backslashes), `x\y` (an escaped letter), `a\.b`, `a\[0\]`. */
const NAMES = ['x\\\\y', '\\\\ab', 'ab\\\\', 'x\\y', 'a\\.b', 'a\\[0\\]']

const num = (c: string) => [{ [c]: 4, k: 'a', v: 1 }, { [c]: 6, k: 'b', v: 2 }, { [c]: 9, k: 'a', v: 3 }]
const str = (c: string) => [{ [c]: 'A', k: 1, v: 1 }, { [c]: 'B', k: 3, v: 2 }]
const MORE: Record<string, (N: string, col: string) => Spec> = {
  href: (N, col) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, href: { field: N, type: 'nominal' } } }),
  url: (N, col) => ({ data: { values: str(col) }, mark: 'image', encoding: { x: { field: 'k', type: 'quantitative' }, url: { field: N, type: 'nominal' } } }),
  description: (N, col) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, description: { field: N, type: 'nominal' } } }),
  key: (N, col) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, key: { field: N, type: 'nominal' } } }),
  strokeDash: (N, col) => ({ data: { values: str(col) }, mark: 'line', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, strokeDash: { field: N, type: 'nominal' } } }),
  angle: (N, col) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, angle: { field: N, type: 'quantitative' } } }),
  xOffset: (N, col) => ({ data: { values: str(col) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, xOffset: { field: N, type: 'nominal' } } }),
  radius: (N, col) => ({ data: { values: num(col) }, mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative' }, radius: { field: N, type: 'quantitative' } } }),
  'text format': (N, col) => ({ data: { values: num(col) }, mark: 'text', encoding: { x: { field: 'k', type: 'nominal' }, text: { field: N, type: 'quantitative', format: '.2f' } } }),
  'tooltip array': (N, col) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, tooltip: [{ field: N, type: 'quantitative' }, { field: 'v', type: 'quantitative' }] } }),
  'text aggregate': (N, col) => ({ data: { values: num(col) }, mark: 'text', encoding: { x: { field: 'k', type: 'nominal' }, text: { field: N, type: 'quantitative', aggregate: 'sum' } } }),
  'tooltip timeUnit': (N, col) => ({ data: { values: [{ [col]: '2020-01-05', v: 1 }] }, mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' }, tooltip: { field: N, type: 'temporal', timeUnit: 'month' } } }),
  'tooltip condition': (N, col) => ({ data: { values: num(col) }, params: [{ name: 'p', select: 'point' }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, tooltip: { condition: { param: 'p', field: N, type: 'quantitative' }, value: 'none' } } }),
  'order sort': (N, col) => ({ data: { values: num(col) }, mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, order: { field: N, type: 'quantitative', sort: 'descending' } } }),
  'order aggregate': (N, col) => ({ data: { values: num(col) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative', aggregate: 'sum' }, color: { field: 'k', type: 'nominal' }, order: { field: N, type: 'quantitative', aggregate: 'sum' } } }),
  'filter range': (N, col) => ({ data: { values: num(col) }, transform: [{ filter: { field: N, range: [5, 10] } }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'filter timeUnit': (N, col) => ({ data: { values: [{ [col]: '2020-01-05', v: 1 }, { [col]: '2020-03-05', v: 2 }] }, transform: [{ filter: { field: N, timeUnit: 'month', equal: 'March' } }], mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' } } }),
  'joinaggregate groupby': (N, col) => ({ data: { values: str(col) }, transform: [{ joinaggregate: [{ op: 'sum', field: 'v', as: 's' }], groupby: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 's', type: 'quantitative' } } }),
  'lookup fields': (N, col) => ({ data: { values: str('c') }, transform: [{ lookup: 'c', from: { data: { values: [{ c: 'A', [col]: 5 }, { c: 'B', [col]: 7 }] }, key: 'c', fields: [N] } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, tooltip: { field: N, type: 'quantitative' } } }),
  'fold as': (N) => ({ data: { values: num('v') }, transform: [{ fold: ['v'], as: [N, 'val'] }], mark: 'point', encoding: { x: { field: 'val', type: 'quantitative' }, tooltip: { field: N, type: 'nominal' } } }),
  'window groupby': (N, col) => ({ data: { values: str(col) }, transform: [{ window: [{ op: 'rank', as: 'r' }], groupby: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'r', type: 'quantitative' } } }),
  'window sort': (N, col) => ({ data: { values: num(col) }, transform: [{ window: [{ op: 'rank', as: 'r' }], sort: [{ field: N }] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'r', type: 'quantitative' } } }),
  'aggregate groupby': (N, col) => ({ data: { values: str(col) }, transform: [{ aggregate: [{ op: 'sum', field: 'v', as: 's' }], groupby: [N] }], mark: 'point', encoding: { x: { field: 's', type: 'quantitative' } } }),
  loess: (N, col) => ({ data: { values: num(col) }, transform: [{ loess: N, on: 'v' }], mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } }),
  'impute key': (N, col) => ({ data: { values: num(col) }, transform: [{ impute: 'v', key: N, value: 0 }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'regression on': (N, col) => ({ data: { values: num(col) }, transform: [{ regression: 'v', on: N }], mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } }),
  'loess on': (N, col) => ({ data: { values: num(col) }, transform: [{ loess: 'v', on: N }], mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } }),
  'extent field': (N, col) => ({ data: { values: num(col) }, transform: [{ extent: N, param: 'e' }, { calculate: 'e[1] - datum.v', as: 'm' }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'm', type: 'quantitative' } } }),
  'sequence as': (N) => ({ data: { sequence: { start: 1, stop: 4, as: N } }, mark: 'point', encoding: { x: { field: N, type: 'quantitative' } } }),
  'pivot value': (N, col) => ({ data: { values: str(col) }, transform: [{ pivot: 'k', value: N }], mark: 'point', encoding: { x: { field: '1', type: 'nominal' } } }),
}
const PLACES: Record<string, (N: string, col: string) => Spec> = { ...NAME_PLACES, ...MORE }

/** The spec's every string equal to `from` (whole, or in a parameter's expression) replaced by `to`. */
const sub = (spec: Spec, from: string, to: string): Spec =>
  JSON.parse(JSON.stringify(spec).replaceAll(JSON.stringify(from), JSON.stringify(to)).replaceAll(`${JSON.stringify(from).slice(1, -1)} *`, `${to} *`))

async function vegaLite(spec: Spec): Promise<{ svg: string; data: string } | { failed: string }> {
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

describe('a name with a backslash is refused where vega-lite\'s chart reads another column, and drawn as vega-lite draws it elsewhere', () => {
  for (const [place, make] of Object.entries(PLACES)) {
    it(place, async () => {
      const problems: string[] = []
      for (const N of NAMES) {
        const col = column(N)
        const spec = make(N, col)
        const ref = await vegaLite(spec)
        // (the control: an ordinary name as long as the name as written, or as the column, for what is drawn of either; vega-lite draws
        // the name as written in titles and the column in descriptions and fold keys, and the rows hold the column: both are put back)
        const json = (s: string): string => JSON.stringify(s).slice(1, -1)
        const named = (s: string, ...forms: string[]): string => forms.reduce((t, f) => t.replaceAll(f, '\u0000'), s)
        let right = false
        for (const ctrlName of new Set(['q'.repeat(N.length), 'q'.repeat(col.length)])) {
          const ctrl = await vegaLite(sub(sub(spec, N, ctrlName), col, ctrlName))
          if ('failed' in ctrl) throw new Error(`${place}: the control with an ordinary name does not draw (${ctrl.failed})`)
          if (!('failed' in ref) && named(ctrl.svg, ctrlName) === named(ref.svg, N, col) && named(ctrl.data, ctrlName) === named(ref.data, json(N), json(col))) right = true
        }
        let ours: Spec | undefined
        let error: unknown
        try {
          ours = compile(plain(spec)) as Spec
        } catch (e) {
          error = e
        }
        if (!right) {
          const why = 'failed' in ref ? ref.failed : 'vega-lite draws other than with an ordinary name'
          // (a parameter's name in an expression is the expression's text: where Vega rejects vega-lite's output for it, as for any
          // undeclared signal, @aster-charts/vl's is rejected with the same messages)
          if (ours !== undefined && 'failed' in ref && ref.failed.startsWith('vega: ')) {
            const mine = await renderWithVegaChecked(plain(ours))
            if (`vega: ${mine.errors.join('; ')}` === ref.failed) continue
          }
          if (!(error instanceof VLCompileError) || !error.message.includes(JSON.stringify(N))) problems.push(`${JSON.stringify(N)}: ${why}, so it must be refused by name; got ${error ? String(error) : 'a chart'}`)
          continue
        }
        if (error !== undefined) { problems.push(`${JSON.stringify(N)}: vega-lite draws it right, but @aster-charts/vl throws ${String(error)}`); continue }
        const mine = await renderWithVegaChecked(plain(ours))
        if (mine.errors.length || mine.svg !== (ref as { svg: string }).svg) problems.push(`${JSON.stringify(N)}: vega-lite draws it right, and @aster-charts/vl draws ${mine.errors.length ? `errors ${mine.errors.join('; ')}` : 'another SVG'}`)
      }
      expect(problems).toEqual([])
    }, 120_000)
  }
})
