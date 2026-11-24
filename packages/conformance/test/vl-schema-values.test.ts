// @vitest-environment node
/**
 * Values the Vega-Lite schema forbids are refused by their path; what Aster lets through draws vega-lite's chart (C245).
 *
 * Every position of nine base specs (a bar with every block, a layer, selections, a facet, a concat of compositions, every
 * transform, a map, a boxplot, an errorbar) is given each of a set of wrong-typed values, and the result is held three ways:
 *  - a refusal by the schema check names the position (or the object that holds it), and the schema - read independently of the
 *    generated table, by vl/test/schema-oracle.ts - forbids that spec;
 *  - a spec the schema forbids that Aster still compiles (a form vega-lite reads beyond its schema: scripts/schema-table.mjs
 *    EXTENSIONS, or a property the definition does not have, which vega-lite ignores) draws what vega-lite draws, in real Vega;
 * Before the schema check, about 180 such mutations (audit vl-rest1 mutate2.mjs) drew a chart other than vega-lite's.
 */
import { describe, expect, it } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { drawsLikeVegaLite } from './vl-composition-render.js'
import { schemaOracle } from '../../vl/test/schema-oracle.js'
import { extendedSchema, pinnedSchema } from '../../vl/scripts/schema-table.mjs'

type Spec = Record<string, unknown>
const strict = schemaOracle(extendedSchema(pinnedSchema().schema), 'strict')

const V = [{ a: 'A', b: 28, c: 'x', t: '2020-01-01' }, { a: 'B', b: 55, c: 'y', t: '2020-02-01' }]
const BASES: Record<string, Spec> = {
  bar: { $schema: 'x', title: 'T', description: 'd', name: 'n', width: 200, height: { step: 10 }, padding: 5, background: 'white', autosize: { type: 'fit' }, usermeta: {}, datasets: { d: V }, data: { name: 'd' },
    transform: [{ filter: { field: 'b', gt: 1 } }, { calculate: 'datum.b*2', as: 'b2' }, { bin: true, field: 'b', as: 'bb' }, { timeUnit: 'month', field: 't', as: 'm' }, { aggregate: [{ op: 'sum', field: 'b', as: 's' }], groupby: ['a', 'c'] }],
    mark: { type: 'bar', tooltip: true, color: 'red', opacity: 0.5 },
    encoding: { x: { field: 'a', type: 'nominal', sort: { field: 's', op: 'sum', order: 'descending' }, axis: { labelAngle: 0, title: 'x', grid: true, format: 'd' }, scale: { paddingInner: 0.1, domain: ['A', 'B'] } }, y: { field: 's', type: 'quantitative', stack: 'zero', scale: { type: 'linear', zero: true, nice: true, domain: [0, 100] }, title: 'Y' },
      color: { field: 'c', type: 'nominal', legend: { title: 'L', orient: 'right' }, scale: { scheme: 'category10', range: ['red', 'blue'] }, condition: { test: 'datum.s > 3', value: 'red' } }, tooltip: [{ field: 'a', type: 'nominal' }], order: { field: 's', sort: 'ascending' }, opacity: { value: 0.3 }, size: { datum: 3 } },
    config: { axis: { grid: false }, view: { stroke: null, continuousWidth: 100 }, bar: { fill: 'red' }, scale: { bandPaddingInner: 0.2 }, legend: { orient: 'top' }, range: { category: ['red'] }, style: { foo: { fill: 'x' } }, title: { anchor: 'start' }, mark: { opacity: 1 }, font: 'x', padding: 3, header: { labelAngle: 0 }, numberFormat: 'd', timeFormat: '%Y', countTitle: 'c', lineBreak: '\n', aria: false } },
  layer: { data: { values: V }, params: [{ name: 'p', value: 3, bind: { input: 'range', min: 0, max: 10 } }], layer: [{ mark: 'line', encoding: { x: { field: 't', type: 'temporal', timeUnit: 'yearmonth' }, y: { field: 'b', type: 'quantitative', aggregate: 'mean' } } }, { mark: { type: 'text', dy: -5 }, encoding: { text: { field: 'b', type: 'quantitative', format: '.1f' }, x: { field: 't', type: 'temporal' }, y: { field: 'b', type: 'quantitative' } } }, { mark: 'rule', encoding: { y: { datum: 30 }, strokeDash: { value: [2, 2] } } }], resolve: { scale: { y: 'independent' } }, encoding: { color: { field: 'c', type: 'nominal' } } },
  sel: { data: { values: V }, params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] }, value: { x: [1, 2] } }, { name: 'pt', select: { type: 'point', fields: ['c'], on: 'mouseover', clear: 'mouseout', toggle: true, nearest: false }, bind: 'legend' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'brush', field: 'c', type: 'nominal', empty: false }, value: 'grey' }, size: { condition: [{ param: 'pt', value: 3 }, { test: { field: 'b', lt: 3 }, value: 4 }], value: 1 } } },
  facet: { data: { values: V }, facet: { row: { field: 'c', type: 'nominal', header: { title: 'h' }, sort: 'descending' } }, spec: { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } }, spacing: 3, align: 'all', bounds: 'full', center: true, resolve: { scale: { x: 'independent' } }, title: { text: 'T', anchor: 'start' } },
  concat: { data: { values: V }, concat: [{ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' } } }, { repeat: ['b'], columns: 1, spec: { mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }, { hconcat: [{ mark: 'arc', encoding: { theta: { field: 'b', type: 'quantitative' } }, view: { stroke: 'red' } }] }], columns: 2 },
  trans: { data: { values: V, format: { type: 'json', parse: { t: 'date' } } }, transform: [{ window: [{ op: 'rank', as: 'r' }], sort: [{ field: 'b', order: 'descending' }], frame: [null, 0], groupby: ['c'] }, { joinaggregate: [{ op: 'mean', field: 'b', as: 'mb' }] }, { stack: 'b', groupby: ['a'], as: ['s0', 's1'], offset: 'zero', sort: [{ field: 'c' }] }, { fold: ['b', 'r'], as: ['k', 'v'] }, { flatten: ['z'], as: ['zz'] }, { pivot: 'c', value: 'b', groupby: ['a'], op: 'sum', limit: 3 }, { impute: 'b', key: 'a', method: 'value', value: 0, groupby: ['c'], keyvals: [1], frame: [-1, 1] }, { lookup: 'a', from: { data: { values: V }, key: 'a', fields: ['b'] }, as: ['q'], default: 0 }, { sample: 10 }, { density: 'b', groupby: ['c'], extent: [0, 1], bandwidth: 1, as: ['v', 'd'] }, { loess: 'b', on: 'b', bandwidth: 0.3 }, { regression: 'b', on: 'b', method: 'poly', order: 2, extent: [0, 1], params: false }, { quantile: 'b', probs: [0.5], step: 0.1 }, { extent: 'b', param: 'ex' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative', impute: { value: 0 } } } },
  geo: { data: { sphere: true }, projection: { type: 'mercator', rotate: [0, 0], center: [0, 0], scale: 100, translate: [1, 1], clipExtent: [[0, 0], [1, 1]] }, mark: 'geoshape' },
  box: { data: { values: V }, mark: { type: 'boxplot', extent: 1.5 }, encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
  err: { data: { values: V }, mark: { type: 'errorbar', extent: 'ci', ticks: true }, encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
}
const WRONG: unknown[] = [null, 5, -1, 'str', '', true, [], [null], [5], {}, { a: 1 }, { expr: 'x' }, [[]]]

const paths = (o: unknown, p: string[] = []): string[][] => {
  const out: string[][] = []
  if (o !== null && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (p.length && (p[p.length - 1] === 'values' || p[p.length - 1] === 'datasets')) continue
      out.push([...p, k], ...paths((o as Spec)[k], [...p, k]))
    }
  }
  return out
}
const setAt = (o: Spec, p: string[], v: unknown): Spec => {
  const c = structuredClone(o)
  let cur = c as Record<string, unknown>
  for (const k of p.slice(0, -1)) cur = cur[k] as Record<string, unknown>
  cur[p[p.length - 1]!] = v
  return c
}
/** `a.b[2].c` for the path ['a', 'b', '2', 'c'] (the form a refusal names it in). */
const pathText = (p: string[]): string => p.reduce((s, k) => (/^\d+$/.test(k) ? `${s}[${k}]` : s ? `${s}.${k}` : k), '')

describe('a value the schema forbids is refused by its path; one Aster lets through draws vega-lite\'s chart', () => {
  for (const [name, base] of Object.entries(BASES)) {
    it(name, async () => {
      expect(strict(base), 'the base spec is one the schema allows').toBe(true)
      let refusedBySchema = 0
      const drawnOtherwise: string[] = []
      for (const p of paths(base)) {
        for (const w of WRONG) {
          // (the rows of inline data are data, not spec: what is in them is the runtime's - null-rows-vs-vega.test.ts)
          if ((p[p.length - 1] === 'values' || p[p.length - 2] === 'datasets') && Array.isArray(w) && w.length > 0) continue
          const m = setAt(base, p, w)
          const at = pathText(p)
          let error: unknown
          try {
            compile(structuredClone(m) as never)
          } catch (e) {
            error = e
          }
          const valid = strict(m)
          if (error !== undefined) {
            expect(error, `${at} = ${JSON.stringify(w)}`).toBeInstanceOf(VLCompileError)
            const msg = (error as Error).message
            if (msg.endsWith('(Vega-Lite 6.4.3 schema)')) {
              refusedBySchema++
              expect(valid, `${at} = ${JSON.stringify(w)}: the schema allows it, yet: ${msg}`).toBe(false)
              const named = msg.slice('[aster/vl] '.length, msg.indexOf(': '))
              expect(at === named || at.startsWith(named) || named === '<spec>' || named.startsWith(at), `${at} = ${JSON.stringify(w)}: ${msg}`).toBe(true)
            }
          } else if (!valid) {
            try {
              await drawsLikeVegaLite(m)
            } catch (e) {
              drawnOtherwise.push(`${at} = ${JSON.stringify(w)}: ${(e as Error).message.split('\n')[0]}`)
            }
          }
        }
      }
      expect(refusedBySchema, 'the schema check refuses something here').toBeGreaterThanOrEqual(3)
      expect(drawnOtherwise.join('\n')).toBe('')
    }, 300_000)
  }
})
