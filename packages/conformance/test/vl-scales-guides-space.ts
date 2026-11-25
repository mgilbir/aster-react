/**
 * The specs of the scale, bin, config and guide differential (vl-scales-guides.test.ts): each is compiled and drawn by vega-lite 6.4.3 and
 * by Aster (vl-composite-compare.ts). The lists are made by crossing the inputs a rule reads, so that a rule is asked wherever it is read:
 * every channel a bin can be on, every scale property that takes an `{expr}`, every config block a style is merged from.
 */
export const DATA = {
  values: Array.from({ length: 30 }, (_, i) => ({
    q: (i * 7) % 13 + 1, q2: (i * 3) % 11 - 3, n: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'u' : 'v', o: i % 4, b0: i % 6, b1: (i % 6) + 1,
    t: `2020-0${1 + (i % 9)}-1${i % 9}`,
  })),
}
export type Case = [string, Record<string, any>]
export const GROUPS: Array<[title: string, cases: Case[]]> = []
const group = (title: string, list: Array<[string, Record<string, any>]>, data: unknown = DATA): void => {
  GROUPS.push([`@aster-charts/vl == vega-lite: ${title}`, list.map(([name, spec]) => [name, { data, ...spec }] as Case)])
}
const q = (field = 'q', extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field = 'n', extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const t = (field = 't', extra: Record<string, unknown> = {}) => ({ field, type: 'temporal', ...extra })

// --- bins (C53, C172) -----------------------------------------------------------------------------------------------------------

function crossed1(): void {
  const list: Case[] = []
  const BINS: Array<[string, unknown]> = [['bin', true], ['maxbins 4', { maxbins: 4 }], ['maxbins 20', { maxbins: 20 }]]
  // a field binned twice, two ways, over every pair of channels that can carry a bin
  for (const [an, a] of BINS) {
    for (const [bn, b] of BINS) {
      for (const other of ['color', 'size', 'opacity', 'strokeWidth', 'y', 'x'] as const) {
        const first = other === 'x' ? 'y' : 'x'
        if (an === bn && other !== 'x' && other !== 'y') continue
        const positional = other === 'x' || other === 'y'
        // (a binned position and a binned channel, over a count: the aggregate groups by both bins)
        const encoding: Record<string, unknown> = { [first]: q('q', { bin: a }), [other]: q('q', { bin: b }) }
        if (positional) encoding.size = { aggregate: 'count' }
        else encoding[first === 'x' ? 'y' : 'x'] = { aggregate: 'count', type: 'quantitative' }
        list.push([`${first} ${an} + ${other} ${bn}`, { mark: 'point', encoding }])
      }
    }
  }
  list.push(['a histogram coloured by its own bin', { mark: 'bar', encoding: { x: q('q', { bin: true }), y: { aggregate: 'count' }, color: q('q', { bin: true }) } }])
  group('a field binned twice', list)
}
crossed1()
function crossed2(): void {
  // a binned ordinal / nominal field on every channel that has a scale (binRequiresRange): the text of the bin is the value
  const list: Case[] = []
  const MARK_OF: Record<string, string> = { shape: 'point', angle: 'point', strokeDash: 'line', theta: 'arc', radius: 'arc' }
  for (const channel of ['x', 'y', 'color', 'fill', 'stroke', 'opacity', 'size', 'strokeWidth', 'shape', 'angle', 'strokeDash', 'theta', 'radius']) {
    for (const type of ['nominal', 'ordinal']) {
      const mark = MARK_OF[channel] ?? 'point'
      const base: Record<string, unknown> = channel === 'theta' || channel === 'radius' ? {} : { x: channel === 'x' ? undefined : q('q2'), y: channel === 'y' ? undefined : q('q2') }
      for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k]
      list.push([`${channel} ${type} binned`, { mark, encoding: { ...base, [channel]: { field: 'q', type, bin: { maxbins: 3 } } } }])
    }
  }
  group('a binned ordinal or nominal field on every channel', list)
}
crossed2()

// --- scale properties that take an expression, and config.scale (C171, C174) ----------------------------------------------------------

function crossed3(): void {
  // (an expression that names no signal: the specs then carry no parameter whose place among the signals is not what is asked here)
  const PARAMS = {}
  const list: Case[] = []
  for (const mark of ['bar', 'point', 'tick', 'rect']) {
    for (const [pn, prop] of [['padding', { padding: { expr: '0.3' } }], ['paddingInner', { paddingInner: { expr: '0.3' } }], ['paddingOuter', { paddingOuter: { expr: '0.3' } }], ['both', { paddingInner: { expr: '0.3' }, paddingOuter: { expr: '0.3 / 3' } }]] as const) {
      list.push([`${mark} band ${pn} as an expression`, { ...PARAMS, mark, encoding: { x: n('n', { scale: prop }), y: q('q2') } }])
    }
    list.push([`${mark} continuous padding as an expression`, { ...PARAMS, mark, encoding: { x: q('q', { scale: { padding: { expr: '3 * 4' } } }), y: q('q2') } }])
  }
  list.push(['a scheme as an expression', { ...PARAMS, mark: 'point', encoding: { x: q('q'), y: q('q2'), color: q('q', { scale: { scheme: { expr: "'viridis'" } } }) } }])
  list.push(['a scheme as an expression, a discrete scale', { ...PARAMS, mark: 'point', encoding: { x: q('q'), y: q('q2'), color: n('n', { scale: { scheme: { expr: "'viridis'" } } }) } }])
  group('scale properties given as expressions', list)

  const cfg: Case[] = []
  const XS: Array<[string, Record<string, unknown>]> = [
    ['x', q('q')], ['x zero false', q('q', { scale: { zero: false } })], ['x zero true', q('q', { scale: { zero: true } })], ['x domain', q('q', { scale: { domain: [20, 100] } })],
    ['x nice true', q('q', { scale: { nice: true } })], ['x nice false', q('q', { scale: { nice: false } })], ['x binned', q('q', { bin: true })],
    ['x descending', q('q', { sort: 'descending' })], ['x nominal', n('n')], ['x nominal descending', n('n', { sort: 'descending' })], ['x time', t('t')], ['x log', q('q', { scale: { type: 'log' } })],
  ]
  const CONFIGS: Array<[string, Record<string, unknown>]> = [
    ['zero true', { zero: true }], ['zero false', { zero: false }], 
    ['clamp', { clamp: true }], ['clamp an expression', { clamp: { expr: 'false' } }], ['round', { round: true }], ['round false', { round: false }],
    ['xReverse', { xReverse: true }], ['xReverse false', { xReverse: false }], ['xReverse an expression', { xReverse: { expr: 'false' } }],
    ['continuousPadding', { continuousPadding: 12 }], ['bandPaddingInner', { bandPaddingInner: 0.4 }], ['bandPaddingInner an expression', { bandPaddingInner: { expr: '0.3' } }],
    ['barBandPaddingInner an expression', { barBandPaddingInner: { expr: '0.3' } }], ['bandPaddingOuter', { bandPaddingOuter: 0.3 }],
  ]
  for (const mark of ['point', 'bar', 'line', 'area']) {
    for (const [xn, x] of XS) {
      for (const [cn, c] of CONFIGS) {
        // (an area or a line over a nominal x has no continuous dimension: the same rules, over fewer shapes)
        cfg.push([`${mark}, ${xn}, config.scale ${cn}`, { ...PARAMS, mark, encoding: { x, y: q('q2') }, config: { scale: c } }])
      }
    }
  }
  group('config.scale against what the encoding says', cfg)
}
crossed3()

// --- polar scales (C173, C224) --------------------------------------------------------------------------------------------------------

function crossed4(): void {
  const list: Case[] = []
  for (const channel of ['theta', 'radius'] as const) {
    for (const scale of [undefined, { reverse: true }, { reverse: false }, { type: 'band' }, { type: 'point' }, { type: 'band', reverse: true }, { type: 'point', reverse: true }]) {
      for (const sort of [undefined, 'descending']) {
        const def = n('n', { ...(scale ? { scale } : {}), ...(sort ? { sort } : {}) })
        list.push([`arc ${channel} ${JSON.stringify(scale)} ${sort ?? ''}`, { mark: 'arc', encoding: { [channel]: def, color: n('n') } }])
        list.push([`text ${channel} ${JSON.stringify(scale)} ${sort ?? ''}`, { mark: 'text', encoding: { [channel]: def, text: n('n') } }])
      }
    }
  }
  list.push(['an arc layer and a text layer over a nominal theta', { layer: [{ mark: 'arc', encoding: { theta: n('n'), color: n('n') } }, { mark: 'text', encoding: { theta: n('n'), text: n('n') } }] }])
  list.push(['an arc layer and a text layer over a nominal radius', { layer: [{ mark: 'arc', encoding: { radius: n('n'), color: n('n') } }, { mark: 'text', encoding: { radius: n('n'), text: n('n') } }] }])
  group('polar scales', list)
}
crossed4()

// --- the ends of a range (C223) ----------------------------------------------------------------------------------------------------------

function crossed5(): void {
  const list: Case[] = []
  for (const type of ['linear', 'quantize', 'quantile', 'threshold', 'ordinal', 'sqrt', 'bin-ordinal'] as const) {
    for (const channel of ['opacity', 'size', 'strokeWidth', 'angle'] as const) {
      const fieldType = type === 'ordinal' ? 'nominal' : 'quantitative'
      const scale: Record<string, unknown> = { type, rangeMin: 0.1, rangeMax: channel === 'opacity' ? 1 : 50, ...(type === 'threshold' ? { domain: [5, 10] } : {}) }
      list.push([`${channel} on a ${type} scale with both ends`, { mark: 'point', encoding: { x: q('q'), y: q('q2'), [channel]: { field: type === 'ordinal' ? 'n' : 'q', type: fieldType, scale } } }])
    }
  }
  group('rangeMin and rangeMax on the scale types that take them and on those that drop them', list)
}
crossed5()

// --- order arrays and stacks over pre-binned data (C558, C221) ----------------------------------------------------------------------

function crossed6(): void {
  const list: Case[] = []
  // (an `order` written as a list: a15 drew it as vega-lite does, unordered; a14 refuses it with DECISIONS Q9's reason, and its differential
  // and README pin that refusal. OPEN DECISION for the lead, STACK-LOG step 24: the three cases return here if the list is accepted again.)
  const prebinned = { field: 'b0', type: 'quantitative', bin: 'binned' }
  // (a bar or a tick over a pre-binned position with no second channel is laid out by its relative band size: DECISIONS / ROUTED, the encoding lane's)
  for (const mark of ['area', 'line', 'point', 'rule']) {
    list.push([`${mark}: a measure and a pre-binned y`, { mark, encoding: { x: q('q'), y: prebinned } }])
    list.push([`${mark}: a pre-binned x and a measure`, { mark, encoding: { y: q('q'), x: prebinned } }])
  }
  for (const mark of ['area', 'line', 'point', 'rule', 'bar', 'tick']) {
    list.push([`${mark}: a measure and a pre-binned y with y2`, { mark, encoding: { x: q('q'), y: prebinned, y2: q('b1') } }])
  }
  group('order lists and pre-binned positions', list)
}
crossed6()

// --- casts (C169) ----------------------------------------------------------------------------------------------------------------------

function crossed7(): void {
  const rows = { values: [{ a: 'A', b: 28, c: '3' }, { a: 'B', b: '17', c: '' }, { a: 'C', b: ' ', c: '5' }, { a: 'D', b: 'x', c: '6' }, { a: 'A', b: 4, c: '2' }, { a: 'B', b: 9, c: '8' }, { a: 'C', b: 11, c: '1' }] }
  const list: Case[] = []
  for (const mark of ['point', 'bar', 'line', 'area', 'tick', 'text', 'rule']) {
    for (const aggregate of [undefined, 'sum', 'mean', 'min', 'max', 'median', 'distinct', 'count'] as const) {
      const y = aggregate === undefined ? q('b') : aggregate === 'count' ? { aggregate, type: 'quantitative' } : q('b', { aggregate })
      list.push([`${mark} ${aggregate ?? 'raw'} on a column with strings in it`, { mark: mark === 'text' ? { type: 'text', text: 'x' } : mark, encoding: { x: n('a'), y, ...(mark === 'line' || mark === 'area' ? {} : {}) } }])
      list.push([`${mark} ${aggregate ?? 'raw'}, quantitative x`, { mark: mark === 'text' ? { type: 'text', text: 'x' } : mark, encoding: { x: q('c'), y } }])
    }
  }
  list.push(['an explicit format.parse of a string column', { data: { ...rows, format: { parse: { c: 'string' } } }, mark: 'point', encoding: { x: q('c'), y: q('b') } }])
  list.push(['an explicit format.parse of a number column', { data: { ...rows, format: { parse: { b: 'number' } } }, mark: 'point', encoding: { x: q('c'), y: q('b') } }])
  list.push(['an explicit format.parse: null', { data: { ...rows, format: { parse: null } }, mark: 'point', encoding: { x: q('c'), y: q('b') } }])
  group('the casts of the data', list, rows)
}
crossed7()

// --- guides (C175, C429, C430, C432, C535, C557) ---------------------------------------------------------------------------------------

function crossed8(): void {
  const list: Case[] = []
  // (an array of values is of one kind: dates written as strings, or as DateTime objects)
  const values = ['2020-02-01', '2020-05-01', '2020-07-04']
  const dateTimes = [{ year: 2020, month: 5 }, { year: 2020, month: 7, date: 4 }]
  list.push(['axis.values of a temporal x', { mark: 'point', encoding: { x: t('t', { axis: { values } }), y: q('q') } }])
  list.push(['axis.values of a temporal x as DateTime objects', { mark: 'point', encoding: { x: t('t', { axis: { values: dateTimes } }), y: q('q') } }])
  list.push(['legend.values of a temporal colour as DateTime objects', { mark: 'point', encoding: { x: q('q'), y: q('q2'), color: t('t', { legend: { values: dateTimes } }) } }])
  list.push(['axis.values of a temporal y', { mark: 'point', encoding: { y: t('t', { axis: { values } }), x: q('q') } }])
  list.push(['axis.values of a temporal x with a time unit', { mark: 'point', encoding: { x: t('t', { timeUnit: 'month', axis: { values: [1, 3] } }), y: q('q') } }])
  list.push(['axis.values of a quantitative x', { mark: 'point', encoding: { x: q('q', { axis: { values: [1, 5, 9] } }), y: q('q2') } }])
  list.push(['axis.values of a nominal x', { mark: 'point', encoding: { x: n('n', { axis: { values: ['A', 'C'] } }), y: q('q2') } }])
  list.push(['legend.values of a temporal colour', { mark: 'point', encoding: { x: q('q'), y: q('q2'), color: t('t', { legend: { values } }) } }])
  list.push(['legend.values of a quantitative colour', { mark: 'point', encoding: { x: q('q'), y: q('q2'), color: q('q', { legend: { values: [2, 6] } }) } }])
  list.push(['legend.values of a temporal size', { mark: 'point', encoding: { x: q('q'), y: q('q2'), size: t('t', { legend: { values } }) } }])
  for (const orient of ['bottom', 'top']) {
    list.push([`axis.offset, ${orient}`, { mark: 'point', encoding: { x: q('q', { axis: { offset: 7, orient } }), y: q('q2', { axis: { offset: 5 } }) } }])
  }
  for (const [name, config] of [['axisTop', { axisTop: { labelAngle: 20 } }], ['axisBottom', { axisBottom: { labelAngle: 20 } }], ['axisX over axisTop', { axisTop: { labelAngle: 20 }, axisX: { labelAngle: 40 } }], ['axis under axisTop', { axis: { labelAngle: 10 }, axisTop: { labelAngle: 20 } }], ['axisLeft', { axisLeft: { labelAngle: 30 } }], ['axisRight', { axisRight: { labelAngle: 30 } }]] as const) {
    for (const orient of ['top', 'bottom']) {
      list.push([`${name} on an axis at the ${orient}`, { mark: 'bar', encoding: { x: n('n', { axis: { orient } }), y: q('q') }, config }])
    }
    list.push([`${name} on a y axis at the right`, { mark: 'bar', encoding: { y: n('n', { axis: { orient: 'right' } }), x: q('q') }, config }])
  }
  for (const gradientOpacity of [undefined, 0.5]) {
    for (const where of ['legend', 'config'] as const) {
      list.push([`gradientOpacity ${gradientOpacity} in the ${where}`, { mark: 'point', encoding: { x: q('q'), y: q('q2'), color: q('q', where === 'legend' && gradientOpacity !== undefined ? { legend: { gradientOpacity } } : {}) }, ...(where === 'config' && gradientOpacity !== undefined ? { config: { legend: { gradientOpacity } } } : {}) }])
    }
  }
  list.push(['a gradient size legend with a gradientOpacity', { mark: 'point', encoding: { x: q('q'), y: q('q2'), size: q('q', { legend: { type: 'gradient', gradientOpacity: 0.4 } }) } }])
  list.push(['config.legend.title null', { mark: 'point', encoding: { x: q('q'), y: q('q2'), color: n('n') }, config: { legend: { title: null } } }])
  list.push(['axis.style', { mark: 'point', encoding: { x: q('q', { axis: { style: 'foo' } }), y: q('q2', { axis: { style: ['foo', 'baz'], labelColor: 'blue' } }) }, config: { style: { foo: { labelColor: 'red', tickColor: 'green' }, baz: { labelFontSize: 14 } } } }])
  for (const fieldTitle of ['verbal', 'plain', 'functional'] as const) {
    for (const aggregate of ['count', 'sum', undefined] as const) {
      const y = aggregate === 'count' ? { aggregate, type: 'quantitative' } : q('q', aggregate ? { aggregate } : {})
      list.push([`fieldTitle ${fieldTitle} on ${aggregate ?? 'a raw field'}`, { mark: 'bar', encoding: { x: n('n', { timeUnit: undefined }), y, color: q('q2', { bin: true }) }, config: { fieldTitle } }])
    }
  }
  group('axes and legends', list)
}
crossed8()

// --- config (C170) and the autosize of a composition (C433) -------------------------------------------------------------------------------

function crossed9(): void {
  const list: Case[] = []
  const title = { text: 'Title', subtitle: 'Sub' }
  const unit = { mark: 'bar', title, encoding: { x: n('n'), y: q('q'), color: n('g') } }
  const TITLES: Array<[string, Record<string, unknown>]> = [
    ['colours and sizes', { color: 'red', fontSize: 20, subtitleColor: 'blue', subtitleFontSize: 8 }],
    ['align, baseline, limit, angle, offsets', { align: 'right', baseline: 'top', limit: 20, angle: 10, dx: 5, dy: 5 }],
    ['frame, zindex, aria, spacing', { frame: 'group', zindex: 1, aria: false, lineHeight: 30, subtitlePadding: 20, subtitleFont: 'serif', subtitleFontStyle: 'italic', subtitleFontWeight: 'bold', subtitleLineHeight: 20 }],
    ['anchor, offset, orient', { anchor: 'start', offset: 30, orient: 'bottom' }],
  ]
  for (const [name, cfg] of TITLES) {
    list.push([`config.title: ${name}`, { ...unit, config: { title: cfg } }])
    list.push([`config.title: ${name}, with config.font`, { ...unit, config: { font: 'serif', title: cfg } }])
    list.push([`config.title: ${name}, with a style of the title`, { ...unit, config: { title: cfg, style: { 'group-title': { fontSize: 30, fontStyle: 'italic' } } } }])
  }
  list.push(['config.font with config.title.font', { ...unit, config: { font: 'serif', title: { font: 'monospace' } } }])
  for (const [name, style] of [['cell', { cell: { stroke: 'red', strokeWidth: 5 } }], ['guide-label', { 'guide-label': { fill: 'red', fontSize: 14 } }], ['guide-title', { 'guide-title': { fill: 'blue' } }], ['group-title', { 'group-title': { fill: 'green' } }], ['text', { text: { fill: 'red' } }]] as const) {
    list.push([`config.style ${name}`, { ...unit, config: { style } }])
    list.push([`config.style ${name} with config.font`, { ...unit, config: { font: 'serif', style } }])
    list.push([`config.style ${name} with config.view`, { ...unit, config: { view: { fill: '#eee', stroke: 'red' }, style } }])
    list.push([`config.style ${name} with config.title`, { ...unit, config: { title: { color: 'red' }, style } }])
  }
  list.push(['config.autosize', { ...unit, config: { autosize: 'fit' } }])
  list.push(['config.autosize, an object', { ...unit, config: { autosize: { type: 'fit', contains: 'padding' } } }])
  const pt = { mark: 'point', encoding: { x: q('q'), y: q('q2') } }
  for (const autosize of ['fit', 'fit-x', 'fit-y', 'pad', 'none', { type: 'fit' }, { type: 'fit', contains: 'padding' }, { type: 'fit-x', resize: true }, { type: 'fit-y' }, { type: 'pad', resize: true }, { type: 'none' }]) {
    const label = JSON.stringify(autosize)
    list.push([`hconcat, autosize ${label}`, { autosize, hconcat: [pt, pt] }])
    list.push([`vconcat, autosize ${label}`, { autosize, vconcat: [pt, pt] }])
    list.push([`repeat, autosize ${label}`, { autosize, repeat: ['q', 'q2'], spec: { mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' }, y: q('q2') } } }])
    list.push([`facet, autosize ${label}`, { autosize, facet: { column: { field: 'g' } }, spec: pt }])
  }
  group('config assembly and the autosize of a composition', list)
}
crossed9()

// --- scales the cells of a facet own, and a domain read from a parameter ---------------------------------------------------------------

function crossed10(): void {
  const list: Case[] = []
  const pt = (extra: Record<string, unknown> = {}) => ({ mark: 'point', encoding: { x: q('q'), y: q('q2'), ...extra } })
  for (const resolve of [{ x: 'independent' }, { y: 'independent' }, { x: 'independent', y: 'independent' }] as const) {
    for (const columns of [undefined, 2]) {
      list.push([`a wrapped facet, scales ${JSON.stringify(resolve)}${columns ? `, ${columns} columns` : ''}`, { facet: n('g'), ...(columns ? { columns } : {}), spec: pt(), resolve: { scale: resolve } }])
      list.push([`a wrapped facet, axes ${JSON.stringify(resolve)}${columns ? `, ${columns} columns` : ''}`, { facet: n('g'), ...(columns ? { columns } : {}), spec: pt(), resolve: { axis: resolve } }])
    }
  }
  list.push(['a wrapped facet, independent colour', { facet: n('g'), columns: 2, spec: pt({ color: n('n') }), resolve: { scale: { color: 'independent' } } }])
  list.push(['an interval parameter as the domain of another view', { layer: [{ params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], ...pt() }, { mark: 'line', encoding: { x: q('q', { scale: { domain: { param: 'brush' } } }), y: q('q2') } }] }])
  group('facets with scales of their own', list)
}
crossed10()
