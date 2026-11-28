// @vitest-environment node
/**
 * A facet's headers, against vega-lite 6.4.3 through real Vega: the facet kinds (a wrapped facet, with and without columns; a row; a
 * column; a facet in the encoding) x every header property (the title's and the labels') x where it is given (the field def's header,
 * config.header, the channel's own config - headerFacet / headerRow / headerColumn - and another channel's, which must not apply) (C52),
 * and the header title turned off (`header: null`, a title null or empty in the header or the config) (C167).
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 9 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], g: ['p', 'q', 'r'][Math.floor(i / 3)], b: (i * 7) % 13 + 1, u: (i * 5) % 11 + 1, t: `2020-0${(i % 9) + 1}-15` }))
const data = { values: rows }
const pt = { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'u', type: 'quantitative' } } }

type Kind = 'wrapped' | 'wrapped in 2 columns' | 'row' | 'column' | 'encoding facet'
const KINDS: Kind[] = ['wrapped', 'wrapped in 2 columns', 'row', 'column', 'encoding facet']
/** The spec of a facet kind, its field def's header and the config. */
function facet(kind: Kind, header: unknown, config?: Record<string, unknown>, field: Record<string, unknown> = { field: 'g', type: 'nominal' }): Record<string, unknown> {
  const def = { ...field, ...(header !== undefined ? { header } : {}) }
  const cfg = config ? { config } : {}
  switch (kind) {
    case 'wrapped': return { data, facet: def, spec: pt, ...cfg }
    case 'wrapped in 2 columns': return { data, facet: def, columns: 2, spec: pt, ...cfg }
    case 'row': return { data, facet: { row: def }, spec: pt, ...cfg }
    case 'column': return { data, facet: { column: def }, spec: pt, ...cfg }
    case 'encoding facet': return { data, ...pt, encoding: { ...pt.encoding, facet: def }, ...cfg }
  }
}
/** The config key of a facet kind's own headers. */
const ownConfig = (kind: Kind): string => (kind === 'row' ? 'headerRow' : kind === 'column' ? 'headerColumn' : 'headerFacet')
const otherConfig = (kind: Kind): string => (kind === 'row' ? 'headerColumn' : kind === 'column' ? 'headerFacet' : 'headerRow')

const PROPS: Array<[string, unknown]> = [
  ['titleColor', 'red'], ['titleFontSize', 17], ['titleFont', 'serif'], ['titleFontStyle', 'italic'], ['titleFontWeight', 'normal'], ['titleLimit', 20],
  ['titleLineHeight', 30], ['titlePadding', 25], ['titleAnchor', 'start'], ['titleAnchor', 'end'], ['titleAngle', 30], ['titleAlign', 'left'],
  ['titleBaseline', 'bottom'], ['titleOrient', 'bottom'], ['titleOrient', 'right'],
  ['labelColor', 'blue'], ['labelFontSize', 15], ['labelFont', 'serif'], ['labelFontStyle', 'italic'], ['labelFontWeight', 'bold'], ['labelLimit', 10],
  ['labelLineHeight', 25], ['labelPadding', 20], ['labelAnchor', 'start'], ['labelAnchor', 'end'], ['labelAngle', 45], ['labelAngle', -30],
  ['labelAlign', 'right'], ['labelBaseline', 'top'], ['labelOrient', 'bottom'], ['labelOrient', 'left'], ['labelExpr', "'<' + datum.label + '>'"],
  ['orient', 'bottom'], ['format', '.1f'],
]

const cases: Array<[string, Record<string, unknown>]> = []
for (const kind of KINDS) {
  for (const [prop, value] of PROPS) {
    // (a number format formats the value of a quantitative field)
    const field = prop === 'format' ? { field: 'u', type: 'ordinal' } : undefined
    cases.push([caseName(kind, `header.${prop} ${JSON.stringify(value)}`), facet(kind, { [prop]: value }, undefined, field)])
    if (prop === 'orient' || prop === 'labelExpr' || prop === 'format') continue
    cases.push([caseName(kind, `config.header.${prop} ${JSON.stringify(value)}`), facet(kind, undefined, { header: { [prop]: value } })])
    cases.push([caseName(kind, `config.${ownConfig(kind)}.${prop} ${JSON.stringify(value)}`), facet(kind, undefined, { [ownConfig(kind)]: { [prop]: value } })])
    cases.push([caseName(kind, `config.${otherConfig(kind)}.${prop} (another channel's)`), facet(kind, undefined, { [otherConfig(kind)]: { [prop]: value } })])
  }
  // the channel's own config over config.header, and the header over both
  cases.push([caseName(kind, 'own config over config.header'), facet(kind, undefined, { header: { labelColor: 'red', titleColor: 'red' }, [ownConfig(kind)]: { labelColor: 'blue', titleColor: 'green' } })])
  cases.push([caseName(kind, 'the header over the configs'), facet(kind, { labelColor: 'orange' }, { header: { labelColor: 'red' }, [ownConfig(kind)]: { labelColor: 'blue' } })])
  // (C167) the title turned off
  for (const [name, header, config] of [
    ['header: null', null, undefined],
    ['header.title null', { title: null }, undefined],
    ['header.title empty', { title: '' }, undefined],
    ['config.header.title null', undefined, { header: { title: null } }],
    ['config.header.title empty', undefined, { header: { title: '' } }],
    [`config.${ownConfig(kind)}.title null`, undefined, { [ownConfig(kind)]: { title: null } }],
    ['config.header.title null, the field def titled', undefined, { header: { title: null } }],
    ['config.header.title a string (not the text: the default is)', undefined, { header: { title: 'Cfg' } }],
    ['header.title over a null config title', { title: 'Mine' }, { header: { title: null } }],
    ['header.labels false', { labels: false }, undefined],
  ] as const) {
    const field = name.endsWith('the field def titled') ? { field: 'g', type: 'nominal', title: 'Group' } : undefined
    cases.push([caseName(kind, name), facet(kind, header, config, field)])
  }
}
// a row and a column together, their configs apart
cases.push(['row and column: headerRow and headerColumn apart', { data, facet: { row: { field: 'g', type: 'nominal' }, column: { field: 'a', type: 'nominal' } }, spec: pt, config: { headerRow: { labelColor: 'red', titleOrient: 'right' }, headerColumn: { labelColor: 'blue', titleAnchor: 'end' }, headerFacet: { labelColor: 'green' } } }])
cases.push(['row and column: config.header.title null', { data, facet: { row: { field: 'g', type: 'nominal' }, column: { field: 'a', type: 'nominal' } }, spec: pt, config: { header: { title: null } } }])
cases.push(['wrapped temporal facet: a header time format', { data, facet: { field: 't', type: 'temporal', timeUnit: 'month', header: { format: '%b' } }, spec: pt }])
cases.push(['wrapped temporal facet: config.headerFacet time format', { data, facet: { field: 't', type: 'temporal', timeUnit: 'month' }, spec: pt, config: { headerFacet: { format: '%B' } } }])

describe('a facet\'s headers draw as vega-lite draws them', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
