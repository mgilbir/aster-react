/** The specs of the composite-mark matrix (boxplot, errorbar, errorband: extent x orientation x input form x part x composition); the test compares each against vega-lite 6.4.3. */

const DATA = {
  values: Array.from({ length: 48 }, (_, i) => ({
    c: ['A', 'B', 'C'][i % 3],
    g: i % 2 ? 'p' : 'q',
    x: i % 5,
    k: i % 4,
    v: [3, 5, 4, 6, 5, 4, 7, 5, 6, 4, 5, 6, 40, 5, 6, 4, -30, 5, 4, 6][i % 20]! + (i % 7),
    w: (i * 3) % 11,
    lo: (i % 7) - 2,
    hi: (i % 7) + 6,
    e: (i % 3) + 1,
    t: `${2000 + (i % 4)}-0${1 + (i % 3)}-01`,
  })),
}
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const tm = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'temporal', ...extra })

type Case = [string, Record<string, any>]
export type Cases = Case[]
/** Every group of cases, in order. */
export const GROUPS: Array<[title: string, cases: Cases]> = []
function group(title: string, body: (add: (name: string, spec: Record<string, any>) => void) => void): void {
  const cases: Cases = []
  body((name, spec) => cases.push([name, spec]))
  GROUPS.push([title, cases])
}

// --- boxplot ---------------------------------------------------------------------------------------------------------------------
const BOX_EXTENTS: Array<[string, unknown]> = [['the default extent', undefined], ['min-max', 'min-max'], ['0', 0], ['0.5', 0.5], ['1.5', 1.5], ['3', 3]]
const BOX_ORIENTS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['vertical, x nominal', { x: n('c'), y: q('v') }, {}],
  ['horizontal, y nominal', { y: n('c'), x: q('v') }, {}],
  ['1D vertical', { y: q('v') }, {}],
  ['1D horizontal', { x: q('v') }, {}],
  ['temporal x', { x: tm('t', { timeUnit: 'year' }), y: q('v') }, {}],
  ['ordinal x', { x: { field: 'k', type: 'ordinal' }, y: q('v') }, {}],
  ['both quantitative, orient vertical', { x: q('x'), y: q('v') }, { orient: 'vertical' }],
  ['both quantitative, orient horizontal', { x: q('v'), y: q('x') }, { orient: 'horizontal' }],
  ['both quantitative, no orient', { x: q('x'), y: q('v') }, {}],
  ['quantitative x with a nominal y, orient vertical', { x: q('v'), y: n('c') }, { orient: 'vertical' }],
]
group('@aster/vl == vega-lite: boxplot, extent x orientation', (add) => {
  for (const [en, extent] of BOX_EXTENTS) {
    for (const [on, encoding, md] of BOX_ORIENTS) {
      add(`${on}, ${en}`, { data: DATA, mark: { type: 'boxplot', ...(extent !== undefined ? { extent } : {}), ...md }, encoding })
    }
  }
})

const BOX_PARTS: Case[] = [
  ['box false', { mark: { type: 'boxplot', box: false } }],
  ['box object', { mark: { type: 'boxplot', box: { fill: 'orange', stroke: 'black' } } }],
  ['median false', { mark: { type: 'boxplot', median: false } }],
  ['median object', { mark: { type: 'boxplot', median: { color: 'red', size: 5 } } }],
  ['rule false', { mark: { type: 'boxplot', rule: false } }],
  ['rule object', { mark: { type: 'boxplot', rule: { stroke: 'blue', strokeDash: [2, 2] } } }],
  ['ticks true', { mark: { type: 'boxplot', ticks: true } }],
  ['ticks object', { mark: { type: 'boxplot', ticks: { size: 8, color: 'green' } } }],
  ['outliers false', { mark: { type: 'boxplot', outliers: false } }],
  ['outliers object', { mark: { type: 'boxplot', outliers: { size: 80, color: 'red' } } }],
  ['size', { mark: { type: 'boxplot', size: 30 } }],
  ['color', { mark: { type: 'boxplot', color: 'purple' } }],
  ['opacity', { mark: { type: 'boxplot', opacity: 0.4 } }],
  ['clip', { mark: { type: 'boxplot', clip: true } }],
  ['invalid filter', { mark: { type: 'boxplot', invalid: 'filter' } }],
  ['invalid show', { mark: { type: 'boxplot', invalid: null } }],
  ['min-max with ticks', { mark: { type: 'boxplot', extent: 'min-max', ticks: true } }],
  ['min-max, no rule', { mark: { type: 'boxplot', extent: 'min-max', rule: false } }],
  ['min-max, outliers set', { mark: { type: 'boxplot', extent: 'min-max', outliers: true } }],
  ['config.boxplot', { config: { boxplot: { size: 22, extent: 2, box: { fill: 'pink' }, median: { color: 'black' }, outliers: { size: 20 }, rule: { strokeWidth: 3 }, ticks: { size: 6 } } }, mark: 'boxplot' }],
  ['config.boxplot min-max', { config: { boxplot: { extent: 'min-max', ticks: true } }, mark: 'boxplot' }],
  ['config.mark.color and size', { config: { mark: { color: 'teal', size: 12 } }, mark: 'boxplot' }],
  ['mark.extent over config.boxplot.extent', { config: { boxplot: { extent: 3 } }, mark: { type: 'boxplot', extent: 0.5 } }],
]
const BOX_ENCODINGS: Array<[string, Record<string, unknown>]> = [
  ['plain', { x: n('c'), y: q('v') }],
  ['colour', { x: n('c'), y: q('v'), color: n('g') }],
  ['colour value', { x: n('c'), y: q('v'), color: { value: 'firebrick' } }],
  ['size', { x: n('c'), y: q('v'), size: { value: 9 } }],
  ['colour and size', { x: n('c'), y: q('v'), color: n('g'), size: { value: 9 } }],
]
group('@aster/vl == vega-lite: boxplot, every part and mark property', (add) => {
  for (const [pn, p] of BOX_PARTS) {
    for (const [en, encoding] of BOX_ENCODINGS) {
      add(`${pn}, ${en}`, { data: DATA, ...p, encoding })
    }
  }
})

const BOX_TOOLTIPS: Case[] = [
  ['no tooltip', {}],
  ['a raw tooltip field', { tooltip: n('g') }],
  ['an array of raw tooltips', { tooltip: [n('g'), q('w')] }],
  ['an aggregate tooltip', { tooltip: q('w', { aggregate: 'mean' }) }],
  ['an array with aggregate and raw', { tooltip: [q('w', { aggregate: 'max' }), n('g')] }],
  ['an array of aggregates', { tooltip: [q('w', { aggregate: 'max' }), q('x', { aggregate: 'min' })] }],
  ['a tooltip value', { tooltip: { value: 'fixed' } }],
  ['a titled tooltip', { tooltip: n('g', { title: 'Group' }) }],
  ['a detail', { detail: n('g') }],
  ['a detail and a tooltip', { detail: n('g'), tooltip: n('g') }],
  ['a timeUnit group', { detail: tm('t', { timeUnit: 'year' }) }],
  ['an aggregate colour', { color: q('w', { aggregate: 'mean' }) }],
  ['an opacity field', { opacity: n('g') }],
  ['a titled colour', { color: n('g', { title: 'Colour' }) }],
  ['a conditional colour', { color: { condition: { test: 'datum.v > 4', value: 'red' }, value: 'grey' } }],
  ['a conditional colour with a field', { color: { condition: { test: 'datum.v > 4', field: 'g', type: 'nominal' }, value: 'grey' } }],
  ['a detail array', { detail: [n('g'), q('w')] }],
  ['a count colour', { color: { aggregate: 'count', type: 'quantitative' } }],
  ['the same field twice, in another key order', { detail: n('g'), color: { type: 'nominal', field: 'g' } }],
  ['the same field with a sort and without', { color: n('g', { sort: 'descending' }), detail: n('g') }],
  ['an aggregate size', { size: q('w', { aggregate: 'mean' }) }],
  ['a time unit tooltip', { tooltip: tm('t', { timeUnit: 'year' }) }],
]
group('@aster/vl == vega-lite: boxplot tooltips and groupings', (add) => {
  for (const [tn, extra] of BOX_TOOLTIPS) {
    for (const [en, extent] of [['default', undefined], ['min-max', 'min-max']] as const) {
      add(`${tn}, ${en}`, { data: DATA, mark: { type: 'boxplot', ...(extent ? { extent } : {}) }, encoding: { x: n('c'), y: q('v'), ...extra } })
    }
  }
})

group('@aster/vl == vega-lite: boxplot in a layer, a facet, with axis and scale options', (add) => {
  const CASES: Case[] = [
    ['titled continuous axis', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v', { title: 'Value' }) } }],
    ['axis options on the continuous channel', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v', { axis: { title: 'V!', grid: false } }) } }],
    ['scale options on the continuous channel', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v', { scale: { zero: false, domain: [-40, 50] } }) } }],
    ['log scale', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('w', { scale: { type: 'sqrt' } }) } }],
    ['an aggregate on the continuous channel', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }],
    ['a field with a space', { data: { values: DATA.values.map((d) => ({ ...d, 'my v': d.v })) }, mark: 'boxplot', encoding: { x: n('c'), y: q('my v') } }],
    ['a filter transform before', { data: DATA, transform: [{ filter: 'datum.v > 0' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['a calculate before', { data: DATA, transform: [{ calculate: 'datum.v * 2', as: 'v2' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v2') } }],
    ['with width and height', { data: DATA, width: 200, height: 120, mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['with a step width', { data: DATA, width: { step: 30 }, mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['with a title', { data: DATA, title: 'Boxes', mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['a layer with a rule', { data: DATA, layer: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: 'rule', encoding: { y: q('v', { aggregate: 'mean' }) } }] }],
    ['a layer sharing the encoding', { data: DATA, encoding: { x: n('c'), y: q('v') }, layer: [{ mark: 'boxplot' }, { mark: { type: 'point', color: 'red' }, encoding: { y: q('v', { aggregate: 'median' }) } }] }],
    ['a layer of two boxplots', { data: DATA, layer: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: { type: 'boxplot', color: 'red' }, encoding: { x: n('c'), y: q('w') } }] }],
    ['a layer with the boxplot second', { data: DATA, layer: [{ mark: 'point', encoding: { x: n('c'), y: q('v') } }, { mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }] }],
    ['a column facet by the encoding', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v'), column: n('g') } }],
    ['a row facet by the encoding', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v'), row: n('g') } }],
    ['a facet spec', { data: DATA, facet: { column: n('g') }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q('v') } } }],
    ['an hconcat', { data: DATA, hconcat: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: 'boxplot', encoding: { x: n('g'), y: q('w') } }] }],
    ['a selection on the unit', { data: DATA, params: [{ name: 'sel', select: 'interval' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['no field on the continuous channel', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: { aggregate: 'count', type: 'quantitative' } } }],
    ['two nominal axes', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: n('g') } }],
    ['config.mark.invalid', { data: DATA, config: { mark: { invalid: 'show' } }, mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['config.axis and view', { data: DATA, config: { axis: { grid: false }, view: { stroke: null } }, mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
  ]
  for (const [name, spec] of CASES) add(name, spec)
})

// --- errorbar and errorband ---------------------------------------------------------------------------------------------------------
const KINDS = ['errorbar', 'errorband'] as const
const EXTENTS = ['stderr', 'stdev', 'ci', 'iqr'] as const
const ERROR_ORIENTS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['vertical, x nominal', { x: n('c'), y: q('v') }, {}],
  ['horizontal, y nominal', { y: n('c'), x: q('v') }, {}],
  ['1D vertical', { y: q('v') }, {}],
  ['1D horizontal', { x: q('v') }, {}],
  ['x quantitative, y quantitative, orient vertical', { x: q('x'), y: q('v') }, { orient: 'vertical' }],
  ['x quantitative, y quantitative, orient horizontal', { x: q('v'), y: q('x') }, { orient: 'horizontal' }],
  ['x quantitative, y quantitative, no orient', { x: q('x'), y: q('v') }, {}],
  ['temporal x', { x: tm('t'), y: q('v') }, {}],
  ['temporal x with a time unit', { x: tm('t', { timeUnit: 'year' }), y: q('v') }, {}],
  ['ordinal x', { x: { field: 'k', type: 'ordinal' }, y: q('v') }, {}],
  ['y with a mean aggregate', { x: n('c'), y: q('v', { aggregate: 'mean' }) }, {}],
]
group('@aster/vl == vega-lite: errorbar and errorband, extent x orientation', (add) => {
  for (const kind of KINDS) {
    for (const extent of EXTENTS) {
      for (const [on, encoding, md] of ERROR_ORIENTS) {
        add(`${kind} ${extent}, ${on}`, { data: DATA, mark: { type: kind, extent, ...md }, encoding })
      }
    }
  }
  for (const kind of KINDS) {
    for (const [on, encoding, md] of ERROR_ORIENTS) {
      add(`${kind} with the default extent, ${on}`, { data: DATA, mark: { type: kind, ...md }, encoding })
    }
  }
  for (const kind of KINDS) {
    for (const center of ['mean', 'median']) {
      for (const extent of [...EXTENTS, undefined]) {
        add(`${kind} ${extent ?? 'default'} around the ${center}`, { data: DATA, mark: { type: kind, center, ...(extent ? { extent } : {}) }, encoding: { x: n('c'), y: q('v') } })
      }
    }
  }
})

group('@aster/vl == vega-lite: errorbar and errorband over aggregated input', (add) => {
  const FORMS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['y and y2', { x: n('c'), y: q('lo'), y2: { field: 'hi' } }, {}],
    ['x and x2', { y: n('c'), x: q('lo'), x2: { field: 'hi' } }, {}],
    ['y and y2 over a continuous x', { x: q('x'), y: q('lo'), y2: { field: 'hi' } }, {}],
    ['y and yError', { x: n('c'), y: q('v'), yError: { field: 'e' } }, {}],
    ['y, yError and yError2', { x: n('c'), y: q('v'), yError: { field: 'e' }, yError2: { field: 'w' } }, {}],
    ['x and xError', { y: n('c'), x: q('v'), xError: { field: 'e' } }, {}],
    ['x, xError and xError2', { y: n('c'), x: q('v'), xError: { field: 'e' }, xError2: { field: 'w' } }, {}],
    ['y and yError over a temporal x', { x: tm('t'), y: q('v'), yError: { field: 'e' } }, {}],
    ['y, y2 and a colour', { x: n('c'), y: q('lo'), y2: { field: 'hi' }, color: n('g') }, {}],
    ['y, yError and a colour', { x: n('c'), y: q('v'), yError: { field: 'e' }, color: n('g') }, {}],
    ['y, yError and a tooltip', { x: n('c'), y: q('v'), yError: { field: 'e' }, tooltip: n('g') }, {}],
    ['y and y2, orient set', { x: n('c'), y: q('lo'), y2: { field: 'hi' } }, { orient: 'vertical' }],
    ['y and y2 with a title', { x: n('c'), y: q('lo', { title: 'Range' }), y2: { field: 'hi' } }, {}],
    ['both x2 and y2', { x: q('lo'), x2: { field: 'hi' }, y: q('lo'), y2: { field: 'hi' } }, {}],
    ['y2 with a nominal y', { x: n('c'), y: n('g'), y2: { field: 'hi' } }, {}],
    ['xError and yError', { x: q('v'), xError: { field: 'e' }, y: q('w'), yError: { field: 'e' } }, {}],
    ['y2 and yError', { x: n('c'), y: q('lo'), y2: { field: 'hi' }, yError: { field: 'e' } }, {}],
    ['yError2 without yError', { x: n('c'), y: q('v'), yError2: { field: 'e' } }, {}],
    ['xError on a nominal x', { x: n('c'), y: q('v'), xError: { field: 'e' } }, {}],
  ]
  for (const kind of KINDS) {
    for (const [fn, encoding, md] of FORMS) {
      add(`${kind}, ${fn}`, { data: DATA, mark: { type: kind, ...md }, encoding })
    }
  }
})

group('@aster/vl == vega-lite: errorbar and errorband, parts, options, tooltips and compositions', (add) => {
  const ENC = { x: n('c'), y: q('v') }
  const BAR: Case[] = [
    ['ticks on', { mark: { type: 'errorbar', ticks: true }, encoding: ENC }],
    ['ticks object', { mark: { type: 'errorbar', ticks: { size: 12, color: 'red' } }, encoding: ENC }],
    ['rule off', { mark: { type: 'errorbar', rule: false, ticks: true }, encoding: ENC }],
    ['rule object', { mark: { type: 'errorbar', rule: { strokeWidth: 3, stroke: 'blue' } }, encoding: ENC }],
    ['both off', { mark: { type: 'errorbar', rule: false, ticks: false }, encoding: ENC }],
    ['thickness', { mark: { type: 'errorbar', thickness: 4 }, encoding: ENC }],
    ['size', { mark: { type: 'errorbar', size: 20, ticks: true }, encoding: ENC }],
    ['color, opacity and clip', { mark: { type: 'errorbar', color: 'orange', opacity: 0.5, clip: true }, encoding: ENC }],
    ['config.errorbar', { config: { errorbar: { rule: { strokeWidth: 2 }, ticks: { size: 7 }, extent: 'ci' } }, mark: 'errorbar', encoding: ENC }],
    ['config.errorbar.center', { config: { errorbar: { center: 'median' } }, mark: 'errorbar', encoding: ENC }],
    ['colour', { mark: 'errorbar', encoding: { ...ENC, color: n('g') } }],
    ['colour value', { mark: 'errorbar', encoding: { ...ENC, color: { value: 'teal' } } }],
    ['opacity value', { mark: 'errorbar', encoding: { ...ENC, opacity: { value: 0.6 } } }],
    ['size value', { mark: { type: 'errorbar', ticks: true }, encoding: { ...ENC, size: { value: 15 } } }],
    ['a detail', { mark: 'errorbar', encoding: { ...ENC, detail: n('g') } }],
    ['a raw tooltip', { mark: 'errorbar', encoding: { ...ENC, tooltip: n('g') } }],
    ['a tooltip array', { mark: 'errorbar', encoding: { ...ENC, tooltip: [n('g'), q('w')] } }],
    ['a tooltip array with an aggregate', { mark: 'errorbar', encoding: { ...ENC, tooltip: [q('w', { aggregate: 'max' }), q('x', { aggregate: 'min' })] } }],
    ['a detail array', { mark: 'errorbar', encoding: { ...ENC, detail: [n('g'), q('w')] } }],
    ['a count colour', { mark: 'errorbar', encoding: { ...ENC, color: { aggregate: 'count', type: 'quantitative' } } }],
    ['the same field twice, in another key order', { mark: 'errorbar', encoding: { ...ENC, detail: n('g'), color: { type: 'nominal', field: 'g' } } }],
    ['the same field with a sort and without', { mark: 'errorbar', encoding: { ...ENC, color: n('g', { sort: 'descending' }), detail: n('g') } }],
    ['a conditional colour with a field', { mark: 'errorbar', encoding: { ...ENC, color: { condition: { test: 'datum.v > 4', field: 'g', type: 'nominal' }, value: 'grey' } } }],
    ['an aggregate size', { mark: 'errorbar', encoding: { ...ENC, size: q('w', { aggregate: 'mean' }) } }],
    ['a time unit tooltip', { mark: 'errorbar', encoding: { ...ENC, tooltip: tm('t', { timeUnit: 'year' }) } }],
    ['a tooltip value', { mark: 'errorbar', encoding: { ...ENC, tooltip: { value: 'x' } } }],
    ['a titled continuous channel', { mark: 'errorbar', encoding: { x: n('c'), y: q('v', { title: 'Value' }) } }],
    ['axis and scale on the continuous channel', { mark: 'errorbar', encoding: { x: n('c'), y: q('v', { axis: { grid: false }, scale: { zero: false } }) } }],
    ['a time unit on x', { mark: 'errorbar', encoding: { x: tm('t', { timeUnit: 'year' }), y: q('v') } }],
    ['a field with a space', { data: { values: DATA.values.map((d) => ({ ...d, 'my v': d.v })) }, mark: 'errorbar', encoding: { x: n('c'), y: q('my v') } }],
    ['a filter before', { transform: [{ filter: 'datum.v > 0' }], mark: 'errorbar', encoding: ENC }],
    ['with width and height', { width: 150, height: 100, mark: 'errorbar', encoding: ENC }],
    ['with a title', { title: 'Errors', mark: 'errorbar', encoding: ENC }],
  ]
  const BAND: Case[] = [
    ['2D', { mark: 'errorband', encoding: { x: q('x'), y: q('v') } }],
    ['2D with borders', { mark: { type: 'errorband', borders: true }, encoding: { x: q('x'), y: q('v') } }],
    ['2D with border object', { mark: { type: 'errorband', borders: { stroke: 'red', strokeDash: [4, 2] } }, encoding: { x: q('x'), y: q('v') } }],
    ['2D with a band object', { mark: { type: 'errorband', band: { fill: 'green', opacity: 0.1 } }, encoding: { x: q('x'), y: q('v') } }],
    ['2D without a band', { mark: { type: 'errorband', band: false, borders: true }, encoding: { x: q('x'), y: q('v') } }],
    ['2D with interpolate', { mark: { type: 'errorband', interpolate: 'monotone', borders: true }, encoding: { x: q('x'), y: q('v') } }],
    ['2D with tension', { mark: { type: 'errorband', interpolate: 'cardinal', tension: 0.3 }, encoding: { x: q('x'), y: q('v') } }],
    ['2D horizontal', { mark: { type: 'errorband', orient: 'horizontal' }, encoding: { x: q('v'), y: q('x') } }],
    ['1D (a rect)', { mark: 'errorband', encoding: { y: q('v') } }],
    ['1D with borders (rules)', { mark: { type: 'errorband', borders: true }, encoding: { y: q('v') } }],
    ['1D horizontal', { mark: 'errorband', encoding: { x: q('v') } }],
    ['1D colour', { mark: 'errorband', encoding: { y: q('v'), color: n('g') } }],
    ['nominal x (a rect per category)', { mark: 'errorband', encoding: { x: n('c'), y: q('v') } }],
    ['colour', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), color: n('g') } }],
    ['colour value', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), color: { value: 'purple' } } }],
    ['a tooltip array', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), tooltip: [n('g'), q('w')] } }],
    ['a detail array', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), detail: [n('g'), q('w')] } }],
    ['a conditional colour with a field', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), color: { condition: { test: 'datum.v > 4', field: 'g', type: 'nominal' }, value: 'grey' } } }],
    ['a tooltip', { mark: 'errorband', encoding: { x: q('x'), y: q('v'), tooltip: n('g') } }],
    ['color, opacity and clip on the mark', { mark: { type: 'errorband', color: 'orange', opacity: 0.5, clip: true, borders: true }, encoding: { x: q('x'), y: q('v') } }],
    ['config.errorband', { config: { errorband: { band: { opacity: 0.6 }, borders: { strokeWidth: 2 } } }, mark: 'errorband', encoding: { x: q('x'), y: q('v') } }],
    ['config.errorbar.center affects an errorband', { config: { errorbar: { center: 'median' } }, mark: 'errorband', encoding: { x: q('x'), y: q('v') } }],
    ['a titled continuous channel', { mark: 'errorband', encoding: { x: q('x'), y: q('v', { title: 'Value' }) } }],
    ['a time unit on x', { mark: 'errorband', encoding: { x: tm('t', { timeUnit: 'year' }), y: q('v') } }],
    ['temporal x', { mark: 'errorband', encoding: { x: tm('t'), y: q('v') } }],
    ['y and y2', { mark: 'errorband', encoding: { x: q('x'), y: q('lo'), y2: { field: 'hi' } } }],
    ['y and yError', { mark: { type: 'errorband', borders: true }, encoding: { x: q('x'), y: q('v'), yError: { field: 'e' } } }],
    ['with width and height', { width: 150, height: 100, mark: 'errorband', encoding: { x: q('x'), y: q('v') } }],
  ]
  for (const [name, s] of BAR) add(`errorbar: ${name}`, { data: DATA, ...s })
  for (const [name, s] of BAND) add(`errorband: ${name}`, { data: DATA, ...s })

  const COMPOSE: Case[] = []
  for (const kind of KINDS) {
    const enc = kind === 'errorband' ? { x: q('x'), y: q('v') } : { x: n('c'), y: q('v') }
    COMPOSE.push(
      [`${kind} in a layer with a point`, { data: DATA, layer: [{ mark: { type: kind }, encoding: enc }, { mark: { type: 'point', color: 'red' }, encoding: { x: enc.x, y: q('v', { aggregate: 'mean' }) } }] }],
      [`${kind} in a layer, the layer sharing the encoding`, { data: DATA, encoding: enc, layer: [{ mark: kind }, { mark: 'point', encoding: { y: q('v', { aggregate: 'mean' }) } }] }],
      [`${kind} after a point in a layer`, { data: DATA, layer: [{ mark: 'point', encoding: { x: enc.x, y: q('v', { aggregate: 'mean' }) } }, { mark: kind, encoding: enc }] }],
      [`${kind} and a line in a layer (with a time unit)`, { data: DATA, layer: [{ mark: { type: 'line', point: true }, encoding: { x: tm('t', { timeUnit: 'year' }), y: q('v', { aggregate: 'mean' }) } }, { mark: kind, encoding: { x: tm('t', { timeUnit: 'year' }), y: q('v') } }] }],
      [`${kind} in a layer, the layer's colour`, { data: DATA, encoding: { ...enc, color: n('g') }, layer: [{ mark: kind }, { mark: 'point', encoding: { y: q('v', { aggregate: 'mean' }) } }] }],
      [`${kind} faceted by a column`, { data: DATA, mark: kind, encoding: { ...enc, column: n('g') } }],
      [`${kind} faceted by a row`, { data: DATA, mark: kind, encoding: { ...enc, row: n('g') } }],
      [`${kind} in a facet spec`, { data: DATA, facet: { column: n('g') }, spec: { mark: kind, encoding: enc } }],
      [`${kind} in an hconcat`, { data: DATA, hconcat: [{ mark: kind, encoding: enc }, { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
      [`${kind} with a selection`, { data: DATA, params: [{ name: 'sel', select: 'interval' }], mark: kind, encoding: enc }],
      [`${kind} over a layer of the same composite, the same statistics`, { data: DATA, layer: [{ mark: { type: kind, extent: 'stderr' }, encoding: enc }, { mark: { type: kind, extent: 'stderr', color: 'red' }, encoding: enc }] }],
    )
  }
  for (const [name, spec] of COMPOSE) add(name, spec)
})



// --- path overlays and stack order: the other rewrites of composite.ts ------------------------------------------------------------

group('path overlays: line, area, trail and rule with points or a line', (add) => {
  const POINTS: Array<[string, unknown]> = [['point true', true], ['point transparent', 'transparent'], ['point object', { size: 80, color: 'red' }], ['point false', false]]
  for (const mark of ['line', 'area', 'trail', 'rule'] as const) {
    for (const [pn, point] of POINTS) {
      add(`${mark} with ${pn}`, { data: DATA, mark: { type: mark, point }, encoding: mark === 'rule' ? { x: q('x'), y: q('v'), y2: { field: 'w' } } : { x: q('x'), y: q('v', { aggregate: 'mean' }) } })
      add(`${mark} with ${pn}, coloured`, { data: DATA, mark: { type: mark, point }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }), color: n('g') } })
    }
  }
  for (const [ln, line] of [['line true', true], ['line object', { strokeWidth: 3, color: 'black' }], ['line false', false]] as const) {
    add(`area with ${ln}`, { data: DATA, mark: { type: 'area', line }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } })
    add(`area with ${ln} and a point, coloured and stacked`, { data: DATA, mark: { type: 'area', line, point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }), color: n('g') } })
    add(`area with ${ln}, horizontal`, { data: DATA, mark: { type: 'area', line, orient: 'horizontal' }, encoding: { y: q('x'), x: q('v', { aggregate: 'sum' }), color: n('g') } })
  }
  add('area with a mark opacity and a line', { data: DATA, mark: { type: 'area', line: true, opacity: 0.4 }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } })
  add('area with a mark fillOpacity and a point', { data: DATA, mark: { type: 'area', point: true, fillOpacity: 0.5 }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } })
  add('config.line.point', { data: DATA, config: { line: { point: true } }, mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } })
  add('config.line.point object', { data: DATA, config: { line: { point: { size: 100 } } }, mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } })
  add('config.area.line and config.area.point', { data: DATA, config: { area: { line: { strokeWidth: 4 }, point: true } }, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } })
  add('a shape channel adds points to a line', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }), shape: n('g') } })
  add('a line with a point and a selection', { data: DATA, params: [{ name: 'sel', select: 'interval' }], mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } })
  add('a ranged area with a line and points', { data: DATA, mark: { type: 'area', line: true, point: true }, encoding: { x: q('x'), y: q('lo'), y2: { field: 'hi' } } })
  add('a ranged horizontal area with a line', { data: DATA, mark: { type: 'area', line: true, orient: 'horizontal' }, encoding: { y: q('x'), x: q('lo'), x2: { field: 'hi' } } })
  add('a line with a point and a clip, tooltip and interpolation', { data: DATA, mark: { type: 'line', point: true, clip: true, interpolate: 'monotone', tooltip: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } })
  add('an area with a line and interpolation and tension', { data: DATA, mark: { type: 'area', line: true, interpolate: 'cardinal', tension: 0.5 }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } })
  add('a line with a point in a layer sharing the encoding', { data: DATA, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) }, layer: [{ mark: { type: 'line', point: true } }, { mark: { type: 'rule', color: 'red' } }] })
  add('a line with a point in a layer, the layer coloured', { data: DATA, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }), color: n('g') }, layer: [{ mark: { type: 'line', point: true } }, { mark: 'point' }] })
  add('a line with a point in a layer, the layer sharing a field only', { data: DATA, encoding: { x: q('x') }, layer: [{ mark: { type: 'line', point: true }, encoding: { y: q('v', { aggregate: 'mean' }) } }] })
  add('a line with a point faceted by a column', { data: DATA, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }), column: n('g') } })
  add('a line with a point faceted by a row, with a size', { data: DATA, width: 200, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }), row: n('g') } })
  add('a line with a point in an hconcat', { data: DATA, hconcat: [{ mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }] })
  add('a line with a point in a facet spec', { data: DATA, facet: { column: n('g') }, spec: { mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } } })
  add('a normalized stacked area with a line', { data: DATA, mark: { type: 'area', line: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum', stack: 'normalize' }), color: n('g') } })
  add('a centred stacked area with points', { data: DATA, mark: { type: 'area', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum', stack: 'center' }), color: n('g') } })
  add('an unstacked area with a line', { data: DATA, mark: { type: 'area', line: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum', stack: null }), color: n('g') } })
})

group('stack order follows a colour domain', (add) => {
  const ORDERS: Array<[string, unknown]> = [['a list', ['C', 'A', 'B']], ['a shorter list', ['B', 'A']], ['a list with an unknown value', ['Z', 'C', 'A', 'B']]]
  for (const [on, domain] of ORDERS) {
    add(`a stacked bar, ${on}`, { data: DATA, mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
    add(`a horizontal stacked bar, ${on}`, { data: DATA, mark: 'bar', encoding: { y: n('g'), x: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
    add(`a stacked bar with an explicit horizontal orient, ${on}`, { data: DATA, mark: { type: 'bar', orient: 'horizontal' }, encoding: { y: n('g'), x: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
    add(`a stacked area, ${on}`, { data: DATA, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
    add(`grouped bars with an x offset, ${on}`, { data: DATA, mark: 'bar', encoding: { x: n('g'), xOffset: n('c'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
    add(`grouped bars with a y offset, ${on}`, { data: DATA, mark: 'bar', encoding: { y: n('g'), yOffset: n('c'), x: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain } }) } })
  }
  add('a stacked bar with an order channel', { data: DATA, mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }), order: q('w', { aggregate: 'sum' }) } })
  add('a stacked bar with a quantitative colour domain', { data: DATA, mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: q('x', { scale: { domain: [0, 5] } }) } })
  add('a stacked bar with a sorted offset', { data: DATA, mark: 'bar', encoding: { x: n('g'), xOffset: n('c', { sort: 'descending' }), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } })
  add('a stacked bar in a layer sharing the encoding', { data: DATA, encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) }, layer: [{ mark: 'bar' }, { mark: { type: 'text', dy: -4 }, encoding: { text: q('v', { aggregate: 'sum' }) } }] })
  add('stacked bars in a layer, the domain on the second', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }) } }, { mark: 'bar', encoding: { x: n('g'), y: q('w', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['B', 'C', 'A'] } }) } }] })
  add('a stacked bar in an hconcat', { data: DATA, hconcat: [{ mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } }, { mark: 'point', encoding: { x: q('x'), y: q('y' as string) } }] })
  add('a stacked bar in a facet spec', { data: DATA, facet: { column: n('k') }, spec: { mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } } })
  add('a stacked bar with a calculate before', { data: DATA, transform: [{ calculate: 'datum.v * 2', as: 'v2' }], mark: 'bar', encoding: { x: n('g'), y: q('v2', { aggregate: 'sum' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } })
  add('a normalized stacked bar', { data: DATA, mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum', stack: 'normalize' }), color: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } })
})

/**
 * Specs on which Aster and vega-lite differ today, so they are in no group above. They are compiled by the refactor guards (the compiled
 * Vega is pinned from before a rewrite) and not compared with vega-lite:
 *  - a composite mark over a nested field (`o.v`): vega-lite's own render has no data for it (an axis from 0 to 0);
 *  - errorbar over a binned channel: refused by Aster;
 *  - a boxplot whose parts are all switched off: vega-lite draws an empty 10 x 10 view, Aster draws the empty plot;
 *  - a config opacity: Aster repeats it in the mark's encode, vega-lite leaves it to the config's style (the render is the same);
 *  - a named line with points: vega-lite names the line's mark after the unit (`lines_marks`), Aster after the layer;
 *  - a stacked bar coloured by `fill` alone: vega-lite names the scale `fill`, Aster `color`.
 */
export const ASTER_ONLY: Cases = [
  ['a named line with points', { data: DATA, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) }, name: 'lines' }],
  ['area with config.area.opacity and a line', { data: DATA, config: { area: { line: true, opacity: 0.2 } }, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } }],
  ['area with config.mark.opacity and points', { data: DATA, config: { area: { point: true }, mark: { opacity: 0.9 } }, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } }],
  ['stacked bar with a fill domain', { data: DATA, mark: 'bar', encoding: { x: n('g'), y: q('v', { aggregate: 'sum' }), fill: n('c', { scale: { domain: ['C', 'A', 'B'] } }) } }],
  ['boxplot with every part off', { data: DATA, mark: { type: 'boxplot', box: false, median: false, rule: false, outliers: false }, encoding: { x: n('c'), y: q('v') } }],
  ['boxplot over a nested field', { data: { values: DATA.values.map((d) => ({ ...d, o: { v: d.v } })) }, mark: 'boxplot', encoding: { x: n('c'), y: q('o.v') } }],
  ['errorbar over a nested field', { data: { values: DATA.values.map((d) => ({ ...d, o: { v: d.v } })) }, mark: 'errorbar', encoding: { x: n('c'), y: q('o.v') } }],
  ['errorbar over a binned x', { data: DATA, mark: 'errorbar', encoding: { x: q('x', { bin: true }), y: q('v') } }],
]
