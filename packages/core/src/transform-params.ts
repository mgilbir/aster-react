/**
 * The parameters of each transform, in the order vega reads them. A spec is read by vega through the definition of each transform, not
 * through the spec's own keys: the parameters are taken one by one in the order the definition lists them (so the first
 * expression to be refused is the first of the definition, whatever order the author wrote the keys in), and a key the definition
 * does not list is never read.
 *
 * A name is written with what the parser reads in its value: `=` an expression (a text), `~` a field or other value that may be given
 * as `{expr: text}`, `?` a comparator (`{field, order}` whose parts may be `{signal}` or `{expr}`); a bare name takes a value, or
 * a `{signal}` for one. `transform-params.test.ts` and the live differential `differential-transform-params.test.mts` hold the table
 * to the definitions of the pinned vega.
 */
import { transformTypeOf } from './transform-names.js'

const PARAMS: Readonly<Record<string, string>> = {
  aggregate: '~groupby ops aggregate_params ~fields as drop cross ~key',
  bin: '~field interval anchor maxbins base divide extent span step steps minstep nice name as',
  collect: '?sort',
  countpattern: '~field case pattern stopwords as',
  cross: '=filter as',
  density: 'extent steps minsteps maxsteps method distribution as',
  dotbin: '~field ~groupby step smooth as',
  extent: '~field',
  filter: '=expr',
  flatten: '~fields index as',
  fold: '~fields as',
  formula: '=expr as initonly',
  impute: '~field ~key keyvals ~groupby method value',
  joinaggregate: '~groupby ~fields ops as ~key',
  kde: '~groupby ~field cumulative counts bandwidth extent resolve steps minsteps maxsteps as',
  lookup: 'from key ~values ~fields as default',
  pivot: '~groupby ~field ~value op limit ~key',
  project: '~fields as',
  quantile: '~groupby ~field probs step as',
  sample: 'size',
  sequence: 'start stop step as',
  timeunit: '~field interval units step maxbins extent inferUnits timezone as',
  window: '?sort ~groupby ops params aggregate_params ~fields as frame ignorePeers',
  identifier: 'as',
  linkpath: '~sourceX ~sourceY ~targetX ~targetY orient shape require as',
  pie: '~field startAngle endAngle sort as',
  stack: '~field ~groupby ?sort offset as',
  contour: 'size values ~x ~y ~weight cellSize bandwidth count nice thresholds smooth',
  geojson: '~fields ~geojson',
  geopath: 'projection ~field ~pointRadius as',
  geopoint: 'projection ~fields as',
  geoshape: 'projection ~field ~pointRadius as',
  graticule: 'extent extentMajor extentMinor step stepMajor stepMinor precision',
  heatmap: '~field ~color ~opacity resolve as',
  isocontour: '~field thresholds levels nice resolve zero smooth ~scale ~translate as',
  kde2d: 'size ~x ~y ~weight ~groupby cellSize bandwidth counts as',
  force: 'static restart iterations alpha alphaMin alphaTarget velocityDecay forces as',
  label: 'size ?sort anchor offset padding lineAnchor markIndex avoidBaseMark avoidMarks method as',
  nest: '~keys generate',
  pack: '~field ?sort padding ~radius size as',
  partition: '~field ?sort padding round size as',
  stratify: '~key ~parentKey',
  tree: '~field ?sort method size nodeSize separation as',
  treelinks: '',
  treemap: '~field ?sort method padding paddingInner paddingOuter paddingTop paddingRight paddingBottom paddingLeft ratio round size as',
  loess: '~x ~y ~groupby bandwidth as',
  regression: '~x ~y ~groupby method order extent params as',
  voronoi: '~x ~y size extent as',
  wordcloud: 'size ~font ~fontStyle ~fontWeight ~fontSize fontSizeRange ~rotate ~text spiral ~padding as',
  crossfilter: '~fields query',
  resolvefilter: 'ignore filter',
}

export type ParamKind = 'expression' | 'field' | 'compare' | 'value'

export interface TransformParam {
  readonly name: string
  readonly kind: ParamKind
}

const KINDS: Readonly<Record<string, ParamKind>> = { '=': 'expression', '~': 'field', '?': 'compare' }
const cache = new Map<string, readonly TransformParam[]>()

/** The parameters a transform of that type has, in the order vega reads them (a type that is none is refused as the spec is). */
export function transformParams(type: unknown): readonly TransformParam[] {
  const canonical = transformTypeOf(type)
  let params = cache.get(canonical)
  if (params === undefined) {
    params = (PARAMS[canonical] ?? '').split(' ').filter(Boolean).map((word) => {
      const kind = KINDS[word[0]!]
      return kind ? { name: word.slice(1), kind } : { name: word, kind: 'value' as const }
    })
    cache.set(canonical, params)
  }
  return params
}
