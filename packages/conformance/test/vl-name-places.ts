/**
 * The places a Vega-Lite spec names a field, a dataset, an output (`as`) or a parameter, each a spec built around one name: every
 * channel kind, sorts, conditions, every transform's fields and outputs, datasets, parse keys, repeats, parameters and selections. Shared
 * by the tests of names Vega mistakes (vl-prototype-names, vl-escaped-names). `N` is the name as the spec writes it; `col` the column
 * the rows hold for it (the same, unless the name is a path with escapes).
 */
type Spec = Record<string, unknown>
type Row = Record<string, unknown>

const num = (N: string): Row[] => [{ [N]: 4, k: 'a', t: '2020-01-05' }, { [N]: 6, k: 'b', t: '2020-02-05' }, { [N]: 9, k: 'a', t: '2020-03-05' }]
const str = (N: string): Row[] => [{ [N]: 'A', k: 1, t: '2020-01-05' }, { [N]: 'B', k: 3, t: '2020-02-05' }]
const date = (N: string): Row[] => [{ [N]: '2020-01-05', k: 1 }, { [N]: '2020-03-05', k: 3 }]
export const NAME_PLACES: Record<string, (N: string, col?: string) => Spec> = {
  'x nominal': (N, col = N) => ({ data: { values: str(col) }, mark: 'bar', encoding: { x: { field: N, type: 'nominal' }, y: { field: 'k', type: 'quantitative' } } }),
  'y quantitative': (N, col = N) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'color nominal': (N, col = N) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, color: { field: N, type: 'nominal' } } }),
  'tooltip': (N, col = N) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, tooltip: { field: N, type: 'quantitative' } } }),
  'detail': (N, col = N) => ({ data: { values: str(col) }, mark: 'line', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'k', type: 'quantitative' }, detail: { field: N, type: 'nominal' } } }),
  'text': (N, col = N) => ({ data: { values: str(col) }, mark: 'text', encoding: { x: { field: 'k', type: 'quantitative' }, text: { field: N, type: 'nominal' } } }),
  'aggregate sum': (N, col = N) => ({ data: { values: num(col) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative', aggregate: 'sum' } } }),
  'bin': (N, col = N) => ({ data: { values: num(col) }, mark: 'bar', encoding: { x: { field: N, type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } } }),
  'timeUnit channel': (N, col = N) => ({ data: { values: date(col) }, mark: 'point', encoding: { x: { field: N, type: 'temporal', timeUnit: 'month' }, y: { field: 'k', type: 'quantitative' } } }),
  'temporal channel': (N, col = N) => ({ data: { values: date(col) }, mark: 'point', encoding: { x: { field: N, type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'sort by field': (N, col = N) => ({ data: { values: num(col) }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal', sort: { field: N, op: 'sum' } }, y: { field: N, type: 'quantitative' } } }),
  'timeUnit transform': (N, col = N) => ({ data: { values: date(col) }, transform: [{ timeUnit: 'month', field: N, as: 'm' }], mark: 'point', encoding: { x: { field: 'm', type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'calculate as': (N) => ({ data: { values: num('v') }, transform: [{ calculate: 'datum.v * 2', as: N }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'filter field': (N, col = N) => ({ data: { values: str(col) }, transform: [{ filter: { field: N, equal: 'A' } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'k', type: 'quantitative' } } }),
  'aggregate transform field': (N, col = N) => ({ data: { values: num(col) }, transform: [{ aggregate: [{ op: 'sum', field: N, as: 's' }], groupby: ['k'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'aggregate transform as': (N) => ({ data: { values: num('v') }, transform: [{ aggregate: [{ op: 'sum', field: 'v', as: N }], groupby: ['k'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'fold': (N, col = N) => ({ data: { values: num(col) }, transform: [{ fold: [N] }], mark: 'bar', encoding: { x: { field: 'key', type: 'nominal' }, y: { field: 'value', type: 'quantitative' } } }),
  'window as': (N) => ({ data: { values: num('v') }, transform: [{ window: [{ op: 'rank', as: N }] }], mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'bin transform field': (N, col = N) => ({ data: { values: num(col) }, transform: [{ bin: true, field: N, as: 'b' }], mark: 'bar', encoding: { x: { field: 'b', type: 'quantitative' }, y: { aggregate: 'count', type: 'quantitative' } } }),
  'joinaggregate field': (N, col = N) => ({ data: { values: num(col) }, transform: [{ joinaggregate: [{ op: 'sum', field: N, as: 's' }] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'lookup key': (N, col = N) => ({ data: { values: str(col) }, transform: [{ lookup: N, from: { data: { values: [{ [col]: 'A', w: 5 }, { [col]: 'B', w: 7 }] }, key: N, fields: ['w'] } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'w', type: 'quantitative' } } }),
  'size': (N, col = N) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, size: { field: N, type: 'quantitative' } } }),
  'opacity': (N, col = N) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, opacity: { field: N, type: 'quantitative' } } }),
  'shape': (N, col = N) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, shape: { field: N, type: 'nominal' } } }),
  'x2': (N, col = N) => ({ data: { values: num(col) }, mark: 'bar', encoding: { y: { field: 'k', type: 'nominal' }, x: { field: 'v', type: 'quantitative' }, x2: { field: N } } }),
  'theta': (N, col = N) => ({ data: { values: num(col) }, mark: 'arc', encoding: { theta: { field: N, type: 'quantitative' }, color: { field: 'k', type: 'nominal' } } }),
  'row facet': (N, col = N) => ({ data: { values: str(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, row: { field: N, type: 'nominal' } } }),
  'order': (N, col = N) => ({ data: { values: num(col) }, mark: 'line', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'k', type: 'nominal' }, order: { field: N, type: 'quantitative' } } }),
  'condition field': (N, col = N) => ({ data: { values: str(col) }, params: [{ name: 'p', select: 'point' }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, color: { condition: { param: 'p', field: N, type: 'nominal' }, value: 'grey' } } }),
  'bin color': (N, col = N) => ({ data: { values: num(col) }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, color: { field: N, type: 'quantitative', bin: true } } }),
  'timeUnit transform as': (N) => ({ data: { values: date('d') }, transform: [{ timeUnit: 'month', field: 'd', as: N }], mark: 'point', encoding: { x: { field: N, type: 'temporal' }, y: { field: 'k', type: 'quantitative' } } }),
  'window field': (N, col = N) => ({ data: { values: num(col) }, transform: [{ window: [{ op: 'sum', field: N, as: 's' }] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's', type: 'quantitative' } } }),
  'pivot': (N, col = N) => ({ data: { values: str(col) }, transform: [{ pivot: N, value: 'k' }], mark: 'point', encoding: { x: { field: 'A', type: 'quantitative' } } }),
  'impute': (N, col = N) => ({ data: { values: num(col) }, transform: [{ impute: N, key: 'k', value: 0 }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'density': (N, col = N) => ({ data: { values: num(col) }, transform: [{ density: N }], mark: 'area', encoding: { x: { field: 'value', type: 'quantitative' }, y: { field: 'density', type: 'quantitative' } } }),
  'regression': (N, col = N) => ({ data: { values: [{ [col]: 4, v: 1 }, { [col]: 6, v: 2 }, { [col]: 9, v: 4 }] }, transform: [{ regression: N, on: 'v' }], mark: 'line', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'quantile': (N, col = N) => ({ data: { values: num(col) }, transform: [{ quantile: N }], mark: 'point', encoding: { x: { field: 'prob', type: 'quantitative' }, y: { field: 'value', type: 'quantitative' } } }),
  'flatten': (N, col = N) => ({ data: { values: [{ [col]: [1, 2], k: 'a' }] }, transform: [{ flatten: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'stack transform': (N, col = N) => ({ data: { values: num(col) }, transform: [{ stack: N, groupby: ['k'], as: ['s0', 's1'] }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 's0', type: 'quantitative' }, y2: { field: 's1' } } }),
  'lookup as': (N) => ({ data: { values: str('c') }, transform: [{ lookup: 'c', from: { data: { values: [{ c: 'A', w: 5 }] }, key: 'c', fields: ['w'] }, as: [N] }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: N, type: 'quantitative' } } }),
  'parse key': (N, col = N) => ({ data: { values: num(col), format: { parse: { [N]: 'number' } } }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: N, type: 'quantitative' } } }),
  'repeat': (N, col = N) => ({ data: { values: num(col) }, repeat: [N], spec: { mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }),
  'extent param': (N) => ({ data: { values: num('v') }, transform: [{ extent: 'v', param: N }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'dataset name': (N) => ({ datasets: { [N]: num('v') }, data: { name: N }, mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }),
  'param name': (N) => ({ data: { values: num('v') }, params: [{ name: N, value: 5 }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, size: { value: { expr: `${N} * 20` } } } }),
  'selection name': (N) => ({ data: { values: num('v') }, params: [{ name: N, select: 'point' }], mark: 'point', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { condition: { param: N, value: 'red' }, value: 'grey' } } }),
  'selection fields': (N, col = N) => ({ data: { values: str(col) }, params: [{ name: 'p', select: { type: 'point', fields: [N] } }], mark: 'point', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: N, type: 'nominal' }, color: { condition: { param: 'p', value: 'red' }, value: 'grey' } } }),
}

