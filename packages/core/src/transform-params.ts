/**
 * The parameters of each transform, in the order vega reads them. A spec is read by vega through the definition of each transform, not
 * through the spec's own keys: the parameters are taken one by one in the order the definition lists them (so the first
 * expression to be refused is the first of the definition, whatever order the author wrote the keys in), and a key the definition
 * does not list is never read.
 *
 * A name is written with what the parser reads in its value: `=` an expression (a text), `~` a field or other value that may be given
 * as `{expr: text}`, `?` a comparator (`{field, order}` whose parts may be `{signal}` or `{expr}`), `@` the name of a projection (or a
 * scale) of the scope, `^` the name of a data set of the scope, `#` the data set a lookup indexes (with the `key` after it), `*` objects of
 * sub-parameters (see `SUB_PARAMS`); a bare name takes a value, or a `{signal}` for one. `!` before the name: the parameter is required;
 * `[]` after it: it is a list (of such values; a `{signal}` stands for a whole list but for sub-parameters, which must be a list). `transform-params.test.ts` and the live differential `differential-transform-params.test.mts` hold the table
 * to the definitions of the pinned vega.
 */
import { transformTypeOf } from './transform-names.js'

const PARAMS: Readonly<Record<string, string>> = {
  aggregate: '~groupby[] ops[] aggregate_params[] ~fields[] as[] drop cross ~key',
  bin: '!~field interval anchor maxbins base divide[] !extent[] span step steps[] minstep nice name as[]',
  collect: '?sort',
  countpattern: '!~field case pattern stopwords as[]',
  cross: '=filter as[]',
  density: 'extent[] steps minsteps maxsteps method *distribution as[]',
  dotbin: '!~field ~groupby[] step smooth as',
  extent: '!~field',
  filter: '!=expr',
  flatten: '!~fields[] index as[]',
  fold: '!~fields[] as[]',
  formula: '!=expr !as initonly',
  impute: '!~field !~key keyvals[] ~groupby[] method value',
  joinaggregate: '~groupby[] ~fields[] ops[] as[] ~key',
  kde: '~groupby[] !~field cumulative counts bandwidth extent[] resolve steps minsteps maxsteps as[]',
  lookup: '#from key ~values[] !~fields[] as[] default',
  pivot: '~groupby[] !~field !~value op limit ~key',
  project: '~fields[] as[]',
  quantile: '~groupby[] !~field probs[] step as[]',
  sample: 'size',
  sequence: '!start !stop step as',
  timeunit: '!~field interval units[] step maxbins extent[] inferUnits timezone as[]',
  window: '?sort ~groupby[] ops[] params[] aggregate_params[] ~fields[] as[] frame[] ignorePeers',
  identifier: '!as',
  linkpath: '~sourceX ~sourceY ~targetX ~targetY orient shape require as',
  pie: '~field startAngle endAngle sort as[]',
  stack: '~field ~groupby[] ?sort offset as[]',
  contour: '!size[] values[] ~x ~y ~weight cellSize bandwidth count nice thresholds[] smooth',
  geojson: '~fields[] ~geojson',
  geopath: '@projection ~field ~pointRadius as',
  geopoint: '!@projection !~fields[] as[]',
  geoshape: '@projection ~field ~pointRadius as',
  graticule: 'extent[] extentMajor[] extentMinor[] step[] stepMajor[] stepMinor[] precision',
  heatmap: '~field ~color ~opacity resolve as',
  isocontour: '~field thresholds[] levels nice resolve zero smooth ~scale ~translate[] as',
  kde2d: '!size[] !~x !~y ~weight ~groupby[] cellSize bandwidth[] counts as',
  force: 'static restart iterations alpha alphaMin alphaTarget velocityDecay *forces[] as[]',
  label: '!size[] ?sort anchor[] offset[] padding lineAnchor markIndex avoidBaseMark ^avoidMarks[] method as[]',
  nest: '~keys[] generate',
  pack: '~field ?sort padding ~radius size[] as[]',
  partition: '~field ?sort padding round size[] as[]',
  stratify: '!~key !~parentKey',
  tree: '~field ?sort method size[] nodeSize[] separation as[]',
  treelinks: '',
  treemap: '~field ?sort method padding paddingInner paddingOuter paddingTop paddingRight paddingBottom paddingLeft ratio round size[] as[]',
  loess: '!~x !~y ~groupby[] bandwidth as[]',
  regression: '!~x !~y ~groupby[] method order extent[] params as[]',
  voronoi: '!~x !~y size[] extent[] as',
  wordcloud: 'size[] ~font ~fontStyle ~fontWeight ~fontSize fontSizeRange[] ~rotate ~text spiral ~padding as[]',
  crossfilter: '!~fields[] !query[]',
  resolvefilter: '!ignore !filter',
}

/** The kinds of sub-parameter object a parameter written `*name` takes (by `<type>.<name>`, nested ones by the path to them), each told by its key. */
const SUB_PARAMS: Readonly<Record<string, ReadonlyArray<{ key: Readonly<Record<string, string>>; params: string }>>> = {
  'density.distribution': [{ key: {function: 'normal'}, params: 'mean stdev' }, { key: {function: 'lognormal'}, params: 'mean stdev' }, { key: {function: 'uniform'}, params: 'min max' }, { key: {function: 'kde'}, params: '!~field ^from bandwidth' }, { key: {function: 'mixture'}, params: '*distributions[] weights[]' }],
  'density.distribution.distributions': [{ key: {function: 'normal'}, params: 'mean stdev' }, { key: {function: 'lognormal'}, params: 'mean stdev' }, { key: {function: 'uniform'}, params: 'min max' }, { key: {function: 'kde'}, params: '!~field ^from bandwidth' }],
  'force.forces': [{ key: {force: 'center'}, params: 'x y' }, { key: {force: 'collide'}, params: '~radius strength iterations' }, { key: {force: 'nbody'}, params: '~strength theta distanceMin distanceMax' }, { key: {force: 'link'}, params: '^links ~id ~distance ~strength iterations' }, { key: {force: 'x'}, params: 'strength ~x' }, { key: {force: 'y'}, params: 'strength ~y' }],
}

export type ParamKind = 'expression' | 'field' | 'compare' | 'value'

/** What a parameter names in the scope, when it names something: a projection, a data set, the data set a lookup indexes. */
export type ParamRef = 'projection' | 'data' | 'index'

export interface TransformParam {
  readonly name: string
  readonly kind: ParamKind
  readonly required: boolean
  readonly list: boolean
  readonly ref?: ParamRef
  /** the kinds of object a sub-parameter can be, each told by its key */
  readonly sub?: ReadonlyArray<SubParams>
}

export interface SubParams {
  readonly key: Readonly<Record<string, string>>
  readonly params: readonly TransformParam[]
}

const KINDS: Readonly<Record<string, ParamKind>> = { '=': 'expression', '~': 'field', '?': 'compare' }
const REFS: Readonly<Record<string, ParamRef>> = { '@': 'projection', '^': 'data', '#': 'index' }
const cache = new Map<string, readonly TransformParam[]>()

function readParams(words: string, path: string): readonly TransformParam[] {
  return words.split(' ').filter(Boolean).map((word) => {
    const required = word.startsWith('!')
    let w = required ? word.slice(1) : word
    const list = w.endsWith('[]')
    if (list) w = w.slice(0, -2)
    const mark = w[0]!
    const kind = KINDS[mark]
    const ref = REFS[mark]
    const name = kind || ref || mark === '*' ? w.slice(1) : w
    const sub = mark === '*' ? (SUB_PARAMS[`${path}.${name}`] ?? []).map((s) => ({ key: s.key, params: readParams(s.params, `${path}.${name}`) })) : undefined
    return { name, kind: kind ?? 'value', required, list, ...(ref ? { ref } : {}), ...(sub ? { sub } : {}) }
  })
}

/** The parameters a transform of that type has, in the order vega reads them (a type that is none is refused as the spec is). */
export function transformParams(type: unknown): readonly TransformParam[] {
  const canonical = transformTypeOf(type)
  let params = cache.get(canonical)
  if (params === undefined) {
    params = readParams(PARAMS[canonical] ?? '', canonical)
    cache.set(canonical, params)
  }
  return params
}
