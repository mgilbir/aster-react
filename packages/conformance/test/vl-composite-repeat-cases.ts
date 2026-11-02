/**
 * The specs of the composite-marks-in-a-repeat matrix: every composite mark (boxplot, errorbar, errorband) x every form of repeat
 * (a list, a row, a column, a grid, a layer) x the places a repeated field can sit (a channel's field, an error channel, a grouping,
 * a faceting channel) x the compositions around it (a facet, a concat, a layer, another repeat). The test compares each against vega-lite 6.4.3.
 */

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
  })),
}
const q = (field: unknown, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: unknown, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const ref = (name: string) => ({ repeat: name })

type Case = [string, Record<string, any>]
export const GROUPS: Array<[title: string, cases: Case[]]> = []
function group(title: string, body: (add: (name: string, spec: Record<string, any>) => void) => void): void {
  const cases: Case[] = []
  body((name, spec) => cases.push([name, spec]))
  GROUPS.push([title, cases])
}

type Unit = Record<string, any>
/** The composite units, each with the repeated field `r` (a `{repeat}` reference) in the place named. */
const UNITS: Array<[string, (r: unknown) => Unit]> = [
  ['boxplot', (r) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q(r) } })],
  ['boxplot horizontal', (r) => ({ mark: 'boxplot', encoding: { y: n('c'), x: q(r) } })],
  ['boxplot 1D', (r) => ({ mark: 'boxplot', encoding: { y: q(r) } })],
  ['boxplot min-max with colour', (r) => ({ mark: { type: 'boxplot', extent: 'min-max' }, encoding: { x: n('c'), y: q(r), color: n('g') } })],
  ['boxplot grouped by the repeated field', (r) => ({ mark: 'boxplot', encoding: { x: n(r), y: q('v') } })],
  ['boxplot coloured by the repeated field', (r) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q('v'), color: n(r) } })],
  ['boxplot with a repeated tooltip', (r) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q('v'), tooltip: q(r, { aggregate: 'mean' }) } })],
  ['boxplot with an aggregate', (r) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q(r, { aggregate: 'mean' }) } })],
  ['errorbar', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q(r) } })],
  ['errorbar horizontal', (r) => ({ mark: 'errorbar', encoding: { y: n('c'), x: q(r) } })],
  ['errorbar stdev', (r) => ({ mark: { type: 'errorbar', extent: 'stdev', ticks: true }, encoding: { x: n('c'), y: q(r) } })],
  ['errorbar iqr with a point', (r) => ({ mark: { type: 'errorbar', extent: 'iqr', rule: { strokeWidth: 3 } }, encoding: { x: n('c'), y: q(r) } })],
  ['errorbar ci', (r) => ({ mark: { type: 'errorbar', extent: 'ci' }, encoding: { x: n('c'), y: q(r) } })],
  ['errorbar with y2', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q(r), y2: q('hi') } })],
  ['errorbar with yError', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q('v'), yError: q(r) } })],
  ['errorbar with yError and yError2', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q('v'), yError: q('lo'), yError2: q(r) } })],
  ['errorbar with a repeated y2', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q('lo'), y2: q(r) } })],
  ['errorbar with colour', (r) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q(r), color: n('g') } })],
  ['errorband', (r) => ({ mark: 'errorband', encoding: { x: q('x'), y: q(r) } })],
  ['errorband with borders', (r) => ({ mark: { type: 'errorband', borders: true, extent: 'stdev' }, encoding: { x: q('x'), y: q(r) } })],
  ['errorband horizontal', (r) => ({ mark: 'errorband', encoding: { y: q('x'), x: q(r) } })],
  ['errorband with y and yError', (r) => ({ mark: 'errorband', encoding: { x: q('x'), y: q('v'), yError: q(r) } })],
  ['errorband with y2', (r) => ({ mark: 'errorband', encoding: { x: q('x'), y: q(r), y2: q('hi') } })],
  ['errorband with colour', (r) => ({ mark: { type: 'errorband', opacity: 0.4 }, encoding: { x: q('x'), y: q(r), color: n('g') } })],
]

// a list: `repeat: [..]` names its variable `repeat`
group('@aster/vl == vega-lite: a composite mark in a repeat over a list', (add) => {
  for (const [name, unit] of UNITS) {
    add(`${name}`, { data: DATA, repeat: ['v', 'w'], spec: unit(ref('repeat')) })
    add(`${name}, columns 1`, { data: DATA, repeat: ['v', 'w'], columns: 1, spec: unit(ref('repeat')) })
  }
})

group('@aster/vl == vega-lite: a composite mark in a column repeat', (add) => {
  for (const [name, unit] of UNITS) add(`${name}`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: unit(ref('column')) })
})

group('@aster/vl == vega-lite: a composite mark in a row repeat', (add) => {
  for (const [name, unit] of UNITS) add(`${name}`, { data: DATA, repeat: { row: ['v', 'w'] }, spec: unit(ref('row')) })
})

group('@aster/vl == vega-lite: a composite mark in a grid repeat', (add) => {
  for (const [name, unit] of UNITS) {
    add(`${name}, the row variable`, { data: DATA, repeat: { row: ['v', 'w'], column: ['x', 'k'] }, spec: unit(ref('row')) })
    add(`${name}, the column variable`, { data: DATA, repeat: { row: ['v', 'w'], column: ['x', 'k'] }, spec: unit(ref('column')) })
  }
  const field = (r: string, c: string) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q(ref(r)), color: n(ref(c)) } })
  add('boxplot reading both variables', { data: DATA, repeat: { row: ['v', 'w'], column: ['g', 'c'] }, spec: field('row', 'column') })
  add('errorbar reading both variables', { data: DATA, repeat: { row: ['v', 'w'], column: ['g', 'c'] }, spec: { mark: 'errorbar', encoding: { x: n(ref('column')), y: q(ref('row')) } } })
  add('errorband reading both variables', { data: DATA, repeat: { row: ['v', 'w'], column: ['v', 'x'] }, spec: { mark: 'errorband', encoding: { x: q(ref('column')), y: q(ref('row')) } } })
})

group('@aster/vl == vega-lite: a composite mark in a layer repeat', (add) => {
  for (const [name, unit] of UNITS) add(`${name}`, { data: DATA, repeat: { layer: ['v', 'w'] }, spec: unit(ref('layer')) })
  add('a boxplot layer repeat with a colour by the layer', { data: DATA, repeat: { layer: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('layer')), color: { datum: ref('layer'), type: 'nominal' } } } })
  add('an errorbar layer repeat, three layers', { data: DATA, repeat: { layer: ['v', 'w', 'x'] }, spec: { mark: 'errorbar', encoding: { x: n('c'), y: q(ref('layer')), color: { datum: ref('layer'), type: 'nominal' } } } })
})

group('@aster/vl == vega-lite: a composite mark under other compositions inside a repeat', (add) => {
  const box = (r: string) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q(ref(r)) } })
  const bar = (r: string) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q(ref(r)) } })
  const band = (r: string) => ({ mark: 'errorband', encoding: { x: q('x'), y: q(ref(r)) } })
  for (const [kind, unit] of [['boxplot', box], ['errorbar', bar], ['errorband', band]] as const) {
    add(`${kind}: a layer of the composite and a rule`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { layer: [unit('column'), { mark: 'rule', encoding: { y: q(ref('column'), { aggregate: 'mean' }) } }] } })
    add(`${kind}: a layer sharing the encoding`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { encoding: { x: kind === 'errorband' ? q('x') : n('c') }, layer: [{ mark: kind, encoding: { y: q(ref('column')) } }, { mark: { type: 'point', color: 'red' }, encoding: { y: q(ref('column'), { aggregate: 'median' }) } }] } })
    add(`${kind}: a layer of two composites`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { layer: [unit('column'), { ...unit('column'), mark: { type: kind, color: 'red' } }] } })
    add(`${kind}: a facet inside the repeat`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { facet: { column: n('g') }, spec: unit('column') } })
    add(`${kind}: a facet row inside the repeat`, { data: DATA, repeat: { row: ['v', 'w'] }, spec: { facet: { row: n('g') }, spec: unit('row') } })
    add(`${kind}: a facet channel in the repeated unit`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { ...unit('column'), encoding: { ...unit('column').encoding, column: n('g') } } })
    add(`${kind}: a row channel in the repeated unit`, { data: DATA, repeat: { column: ['v', 'w'] }, spec: { ...unit('column'), encoding: { ...unit('column').encoding, row: n('g') } } })
    add(`${kind}: a concat holding the repeat`, { data: DATA, hconcat: [{ repeat: { column: ['v', 'w'] }, spec: unit('column') }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] })
    add(`${kind}: a vconcat holding the repeat`, { data: DATA, vconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('v') } }, { repeat: ['v', 'w'], spec: unit('repeat') }] })
    add(`${kind}: a repeat in a repeat`, { data: DATA, repeat: { row: ['g', 'c'] }, spec: { repeat: { column: ['v', 'w'] }, spec: { ...unit('column'), encoding: { ...unit('column').encoding, color: n(ref('row')) } } } })
    add(`${kind}: a list repeat holding a column repeat`, { data: DATA, repeat: ['g', 'c'], spec: { repeat: { column: ['v', 'w'] }, spec: { ...unit('column'), encoding: { ...unit('column').encoding, color: n(ref('repeat')) } } } })
    add(`${kind}: a layer repeat inside a column repeat`, { data: DATA, repeat: { column: ['g', 'c'] }, spec: { repeat: { layer: ['v', 'w'] }, spec: { ...unit('layer'), encoding: { ...unit('layer').encoding, color: n(ref('column')) } } } })
    add(`${kind}: a layer repeat of a layer`, { data: DATA, repeat: { layer: ['v', 'w'] }, spec: { layer: [unit('layer'), { mark: 'rule', encoding: { y: q(ref('layer'), { aggregate: 'mean' }) } }] } })
  }
})

group('@aster/vl == vega-lite: a composite mark in a repeat, with sizes, config, transforms and selections', (add) => {
  const box = { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column')) } }
  add('width and height on the repeated spec', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { ...box, width: 120, height: 90 } })
  add('a step width', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { ...box, width: { step: 20 } } })
  add('a title on the repeat', { data: DATA, title: 'Repeated', repeat: { column: ['v', 'w'] }, spec: box })
  add('a title on the repeated spec', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { ...box, title: 'Boxes' } })
  add('config.boxplot', { data: DATA, config: { boxplot: { size: 20, extent: 'min-max' } }, repeat: { column: ['v', 'w'] }, spec: box })
  add('config.errorbar', { data: DATA, config: { errorbar: { ticks: true, rule: { stroke: 'red' } } }, repeat: { column: ['v', 'w'] }, spec: { mark: 'errorbar', encoding: { x: n('c'), y: q(ref('column')) } } })
  add('a filter transform before the repeat', { data: DATA, transform: [{ filter: 'datum.v > 0' }], repeat: { column: ['v', 'w'] }, spec: box })
  add('a transform in the repeated spec', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { transform: [{ filter: 'datum.x > 0' }], ...box } })
  add('a calculate in the repeated spec', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { transform: [{ calculate: 'datum.v * 2', as: 'v2' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v2') } } })
  add('resolve independent scales', { data: DATA, repeat: { column: ['v', 'w'] }, resolve: { scale: { y: 'independent' } }, spec: box })
  add('resolve shared scales', { data: DATA, repeat: { column: ['v', 'w'] }, resolve: { scale: { y: 'shared' } }, spec: box })
  add('a colour legend shared across the repeat', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column')), color: n('g') } } })
  add('a titled repeated channel', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column'), { title: 'The value' }) } } })
  add('a scale option on the repeated channel', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column'), { scale: { zero: false } }) } } })
  add('an axis option on the repeated channel', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'errorbar', encoding: { x: n('c'), y: q(ref('column'), { axis: { title: 'Y', grid: false } }) } } })
  add('a repeated field with an aggregate-free sort on x', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c', { sort: 'descending' }), y: q(ref('column')) } } })
  add('a repeat with a spacing', { data: DATA, repeat: { column: ['v', 'w'] }, spacing: 30, spec: box })
  add('a repeat with align none', { data: DATA, repeat: { column: ['v', 'w'] }, align: 'none', spec: box })
  add('a repeat with center', { data: DATA, repeat: { column: ['v', 'w'] }, center: true, spec: box })
  add('an interval selection in the repeated boxplot', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { params: [{ name: 'brush', select: 'interval' }], ...box } })
  add('a selection in a layer with a repeated errorband', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { layer: [{ params: [{ name: 'brush', select: 'interval' }], mark: 'point', encoding: { x: q('x'), y: q(ref('column')) } }, { mark: 'errorband', encoding: { x: q('x'), y: q(ref('column')) } }] } })
  add('a selection filtering a repeated boxplot', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { layer: [{ params: [{ name: 'brush', select: 'interval' }], mark: 'point', encoding: { x: n('c'), y: q(ref('column')) } }, { transform: [{ filter: { param: 'brush' } }], mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column')) } }] } })
  add('a bound selection in a repeated errorbar', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { params: [{ name: 'grid', select: 'interval', bind: 'scales' }], mark: 'errorbar', encoding: { x: n('c'), y: q(ref('column')) } } })
})

// --- what a composite mark in a repeat needs from the views around it ---------------------------------------------------------------
// (none of these is a composite mark in a repeat itself: each is a part of the view a repeated composite sits in)

group('@aster/vl == vega-lite: a view with no scale on a channel, in a concat, a repeat and a facet', (add) => {
  const ONE_D: Array<[string, (f: unknown) => Unit]> = [
    ['y only', (f) => ({ mark: 'point', encoding: { y: q(f) } })],
    ['x only', (f) => ({ mark: 'point', encoding: { x: q(f) } })],
    ['y only rule', (f) => ({ mark: 'rule', encoding: { y: q(f) } })],
    ['y only with an x value', (f) => ({ mark: 'point', encoding: { y: q(f), x: { value: 5 } } })],
    ['y only, axis off', (f) => ({ mark: 'point', encoding: { y: q(f, { axis: null }) } })],
    ['y only, grid off', (f) => ({ mark: 'point', encoding: { y: q(f, { axis: { grid: false } }) } })],
    ['y nominal only', () => ({ mark: 'point', encoding: { y: n('c') } })],
    ['no position', (f) => ({ mark: 'text', encoding: { text: q(f) } })],
    ['boxplot 1D', (f) => ({ mark: 'boxplot', encoding: { y: q(f) } })],
    ['errorbar 1D horizontal', (f) => ({ mark: 'errorbar', encoding: { x: q(f) } })],
  ]
  for (const [name, unit] of ONE_D) {
    add(`${name}, hconcat`, { data: DATA, hconcat: [unit('v'), unit('w')] })
    add(`${name}, vconcat`, { data: DATA, vconcat: [unit('v'), unit('w')] })
    add(`${name}, concat in two columns`, { data: DATA, columns: 2, concat: [unit('v'), unit('w'), unit('x')] })
    add(`${name}, list repeat`, { data: DATA, repeat: ['v', 'w'], spec: unit(ref('repeat')) })
    add(`${name}, grid repeat`, { data: DATA, repeat: { row: ['v', 'w'], column: ['x', 'k'] }, spec: unit(ref('row')) })
    add(`${name}, a facet`, { data: DATA, facet: { column: n('g') }, spec: unit('v') })
  }
})

group('@aster/vl == vega-lite: the legend of a layer of composite marks', (add) => {
  const box = (colour: string) => ({ mark: 'boxplot', encoding: { x: n('c'), y: q('v'), color: n(colour) } })
  const bar = (colour: string) => ({ mark: 'errorbar', encoding: { x: n('c'), y: q('v'), color: n(colour) } })
  const point = (colour: string) => ({ mark: 'point', encoding: { x: n('c'), y: q('v'), color: n(colour) } })
  add('two boxplots coloured by different fields', { data: DATA, layer: [box('g'), box('c')] })
  add('three boxplots coloured by different fields', { data: DATA, layer: [box('g'), box('c'), box('k')] })
  add('two boxplots, the same field', { data: DATA, layer: [box('g'), box('g')] })
  add('a boxplot between two points', { data: DATA, layer: [point('g'), box('c'), point('k')] })
  add('two errorbars coloured by different fields', { data: DATA, layer: [bar('g'), bar('c')] })
  add('a boxplot and an errorbar', { data: DATA, layer: [box('g'), bar('c')] })
  add('a layer repeat of boxplots coloured by the repeated field', { data: DATA, repeat: { layer: ['g', 'c', 'k'] }, spec: box(ref('layer') as never) })
  add('a column repeat of boxplots coloured by the repeated field', { data: DATA, repeat: { column: ['g', 'c', 'k'] }, spec: box(ref('column') as never) })
})

group('@aster/vl == vega-lite: a datum colour in a composite mark, a datum condition', (add) => {
  const datum = { datum: 'a series', type: 'nominal' }
  add('a boxplot with a datum colour', { data: DATA, mark: 'boxplot', encoding: { x: n('c'), y: q('v'), color: datum } })
  add('a boxplot with a datum colour, min-max', { data: DATA, mark: { type: 'boxplot', extent: 'min-max' }, encoding: { x: n('c'), y: q('v'), color: datum } })
  add('an errorbar with a datum colour', { data: DATA, mark: 'errorbar', encoding: { x: n('c'), y: q('v'), color: datum } })
  add('an errorband with a datum colour', { data: DATA, mark: 'errorband', encoding: { x: q('x'), y: q('v'), color: datum } })
  add('a layer of boxplots with datum colours', { data: DATA, layer: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v'), color: { datum: 'one', type: 'nominal' } } }, { mark: 'boxplot', encoding: { x: n('c'), y: q('w'), color: { datum: 'two', type: 'nominal' } } }] })
  add('a layer repeat of boxplots with the repeated field as the datum', { data: DATA, repeat: { layer: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('layer')), color: { datum: ref('layer'), type: 'nominal' } } } })
  add('a datum condition on shape of a point', { data: DATA, mark: 'point', encoding: { x: n('c'), y: q('v'), shape: { condition: { test: 'datum.v > 4', datum: 'square', type: 'nominal' }, value: 'circle' } } })
  for (const channel of ['color', 'size', 'opacity', 'strokeWidth', 'strokeDash']) {
    for (const mark of channel === 'size' ? ['point'] : ['point', 'bar']) {
      add(`a datum condition on ${channel} of a ${mark}`, { data: DATA, mark, encoding: { x: n('c'), y: q('v'), [channel]: { condition: { test: 'datum.v > 4', datum: 'hi', type: 'nominal' }, value: 1 } } })
    }
  }
})

group('@aster/vl == vega-lite: the views a repeat names', (add) => {
  const point = (e: Record<string, unknown>) => ({ mark: 'point', encoding: e })
  add('a repeat in a repeat', { data: DATA, repeat: { row: ['g', 'c'] }, spec: { repeat: { column: ['v', 'w'] }, spec: point({ x: q('x'), y: q(ref('column')), color: n(ref('row')) }) } })
  add('a list repeat in a list repeat', { data: DATA, repeat: ['g', 'c'], spec: { repeat: ['v', 'w'], spec: point({ x: q('x'), y: q(ref('repeat')) }) } })
  add('a layer repeat in a column repeat', { data: DATA, repeat: { column: ['g', 'c'] }, spec: { repeat: { layer: ['v', 'w'] }, spec: point({ x: q('x'), y: q(ref('layer')), color: n(ref('column')) }) } })
  add('a column repeat in a layer-less list repeat, three deep', { data: DATA, repeat: { row: ['g', 'c'] }, spec: { repeat: { column: ['v', 'w'] }, spec: { repeat: { layer: ['x', 'k'] }, spec: point({ x: q(ref('layer')), y: q(ref('column')), color: n(ref('row')) }) } } })
  add('a hconcat of a repeat and a view', { data: DATA, hconcat: [{ repeat: { column: ['v', 'w'] }, spec: point({ x: q('x'), y: q(ref('column')) }) }, point({ x: q('x'), y: q('v') })] })
  add('a repeat of an hconcat', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { hconcat: [point({ x: q('x'), y: q(ref('column')) }), point({ x: q('k'), y: q(ref('column')) })] } })
  add('a named repeated spec', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { name: 'inner', ...point({ x: q('x'), y: q(ref('column')) }) } })
})

group('@aster/vl == vega-lite: aggregates the views of a composition share', (add) => {
  const bar = (f: string, extra: Record<string, unknown> = {}, extent = 'ci') => ({ mark: { type: 'errorbar', extent }, encoding: { x: n('c'), y: q(f), ...extra } })
  for (const extent of ['ci', 'stdev', 'stderr', 'iqr']) {
    add(`${extent}: two errorbars side by side`, { data: DATA, hconcat: [bar('v', {}, extent), bar('w', {}, extent)] })
    add(`${extent}: four errorbars in a grid`, { data: DATA, columns: 2, concat: ['v', 'w', 'x', 'k'].map((f) => bar(f, {}, extent)) })
    add(`${extent}: a layer of two errorbars`, { data: DATA, layer: [bar('v', {}, extent), bar('w', {}, extent)] })
    add(`${extent}: errorbars grouped alike and differently`, { data: DATA, hconcat: [bar('v', {}, extent), bar('w', { color: n('g') }, extent), bar('x', {}, extent)] })
    add(`${extent}: the same errorbar twice`, { data: DATA, hconcat: [bar('v', {}, extent), bar('v', {}, extent)] })
  }
  add('errorbands side by side', { data: DATA, hconcat: [{ mark: { type: 'errorband', extent: 'ci' }, encoding: { x: q('x'), y: q('v') } }, { mark: { type: 'errorband', extent: 'ci' }, encoding: { x: q('x'), y: q('w') } }] })
  add('bars of sums side by side', { data: DATA, hconcat: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }, { mark: 'bar', encoding: { x: n('c'), y: q('w', { aggregate: 'mean' }) } }] })
  add('a repeat of bars of aggregates', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: 'bar', encoding: { x: n('c'), y: q(ref('column'), { aggregate: 'sum' }) } } })
  add('a repeat of errorbars, grouped by a colour', { data: DATA, repeat: { column: ['v', 'w'] }, spec: { mark: { type: 'errorbar', extent: 'ci' }, encoding: { x: n('c'), y: q(ref('column')), color: n('g') } } })
})
