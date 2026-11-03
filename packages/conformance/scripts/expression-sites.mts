/**
 * Every place a Vega spec holds an expression, and the expressions to put there, for the live differentials against
 * `vega.parse` (differential-parse-errors.test.mts, and jsdom-parse-errors-handlers.test.mts for the handlers of signals).
 *
 * A site is a function from the text of an expression to a whole spec. A pool is a list of texts: broken ones (vega refuses
 * with `Expression parse error: <text>`), unknown functions and signals, expressions vega's code generator refuses for other
 * reasons, and good ones. The two engines must give the same outcome at every site for every text.
 */
import * as vega from 'vega'
import { compileChart } from '@aster/core'

export type Spec = Record<string, unknown>

/** Syntax errors: vega refuses with `Expression parse error: <the text it parsed>`. */
export const BAD = ['1 +', 'a b', '(1', 'x..y', ')', '"abc', '1 +* 2', 'a ? b', "datum['a'", '{a: }', 'f(1,)', '1 2', '!', 'a.', '[1,', '#', 'a = 1']
/** Expressions every site accepts. */
export const GOOD = ['1', 'datum.a', 'width', '2 + 2 * 2', "'x'", 'if(true, 1, 2)', 'event.x > 1', '[1, 2]', '{a: 1}', 'datum.a ? 1 : 0']
/**
 * What vega's parser refuses after reading an expression whole: a function it does not know, a name that is no signal of the
 * scope, the code generator's own refusals (the order of the checks is part of the contract), and expressions that look odd and
 * are accepted. `s` is a signal of the spec, `cs` one of its config, `gs` one of a group, `ext` one a transform makes.
 */
export const SEMANTIC = [
  // an unknown function
  'foo(1)', 'foo()', '1 + foo(2)', 'bar(foo(1))', 'foo(bar(1))', 'isInvalid(1)', '_format(1)', '_if(1, 2, 3)', 'Math.abs(1)',
  // a name that is no signal
  'nosuch', 'nosuch + 1', 's + nosuch', 'nosuch + other', 'other + nosuch', '{a: nosuch}', '[nosuch]', 'datum[nosuch]', 'nosuch.x', 'nosuch[s]', 's ? nosuch : 1',
  'cursor', 'parent', 'gs', 'ext', 'abs(nosuch)',
  // both: the code generator reads the tree in order, and reads the names when it is done
  'nosuch + foo()', 'foo() + nosuch', 'abs(nosuch, foo())', 's ? nosuch : foo()',
  // the code generator's other refusals
  '_', '_ + nosuch', 'a.b()', 'datum.f(1)', '(1)()', '1()', "'x'()", 'clamp(1)', 'clamp(1, 2, 3, 4)', 'if(1)', 'if(1, 2, 3, 4)', 'if(nosuch)', 'clamp(nosuch)',
  '{__proto__: 1}', '{a: nosuch, constructor: 1}', '{toString: 1}', "{'__proto__': 1}", '{valueOf: foo()}',
  // arguments it never reads, and ones it reads whole
  'date(1, foo())', 'date(foo())', 'length(1, foo())', 'upper(1, foo())', "substring('a', foo())", 'test(1, foo())', 'trim(1, nosuch)', 'abs(1, foo())',
  // the first argument it needs and does not have
  'upper()', 'date()', 'length()', 'test()', 'trim()', 'utcyear()', "_scale('x')", '_range()', '_bandwidth()', 'scale()', 'bandwidth()',
  // the calls that name a data set or a scale
  'data(s)', 'data()', "data('nosuch')", 'indata(s, "a", 1)', "indata('d', s, 1)", 'indata()', 'treePath(s)', 'vlSelectionTest(s)', 'vlSelectionTest()',
  "scale('x')", 'scale(nosuch)', "scale('nosuch', 1)", "_scale('x', foo())", "_scale(nosuch, 1)", "_bandwidth('x', foo())", '_range(foo())',
  // a name every object has, called
  'toString(1)', 'constructor(1)', 'isPrototypeOf(1)',
  // a hole in an array literal
  '[1,,2]',
  // words that are no names of a signal, and words that are literals
  'undefined', 'Infinity', 'this', 'Math.PI', 'window', 'null + true', 'event.vega.view()', 'item().mark.group', 'a b + s',
  // accepted
  's', 'cs', 'width + height', 'padding', 'autosize', 'background', 'PI + E', 'NaN', 'MAX_VALUE + MIN_VALUE', 'event.x', 'datum.nosuch', 'event.nosuch',
  'xy()', 'view()', 'item()', 'abs(s)', 'sqrt(s) + s', "format(1, ',')", 'pluck([], "a")', 'length([1])', '_range("x")', '_bandwidth("x")', "_scale('x', 1)",
  // functions vega has and Aster has not written; the add-on's, loaded or not; the registry's
  'warn(1)', 'info(1)', 'debug(1)', 'screen()', 'flush(1)', 'sampleNormal(0, 1)', 'geoCentroid("p", [0, 0])',
]

const rect = (update: Spec, extra: Spec = {}): Spec => ({ type: 'rect', from: { data: 'd' }, encode: { update: { x: { value: 1 }, width: { value: 1 }, height: { value: 1 }, ...update } }, ...extra })
const linear = { name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }
export const base = (o: Spec = {}): Spec => ({
  width: 100, height: 100,
  config: { signals: [{ name: 'cs', value: 0 }] },
  data: [{ name: 'd', values: [{ a: 1 }] }],
  scales: [linear],
  signals: [{ name: 's', value: 1 }, { name: 'a b', value: 1 }],
  marks: [],
  ...o,
})
const inGroup = (o: Spec): Spec => base({ marks: [{ type: 'group', ...o }] })

const raw = (on: Spec): Spec => base({ signals: [{ name: 's', value: 1 }, { name: 't', value: 0, on: [on] }] })
const handler = (events: unknown, update: unknown = '1', more: Spec = {}): Spec => raw({ events, update, ...more })

/** Where a spec holds an expression, other than in a handler of a signal. */
export const SITES: Record<string, (e: string) => Spec> = {
  signalInit: (e) => base({ signals: [{ name: 't', init: e }] }),
  signalUpdate: (e) => base({ signals: [{ name: 't', update: e }] }),
  formula: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'formula', expr: e, as: 'x' }] }] }),
  filter: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }] }),
  crossFilter: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'cross', filter: e }] }] }),
  fieldExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'aggregate', groupby: [{ expr: e, as: 'g' }] }] }] }),
  projectExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'project', fields: [{ expr: e }], as: ['z'] }] }] }),
  sortFieldExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'collect', sort: { field: { expr: e } } }] }] }),
  paramSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'bin', field: 'a', extent: [0, 1], maxbins: { signal: e } }] }] }),
  paramPointRadius: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'geopath', pointRadius: { expr: e } }] }] }),
  groupData: (e) => inGroup({ data: [{ name: 'gd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }] }),
  triggerInsert: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', insert: e }] }] }),
  triggerRemove: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', remove: e }] }] }),
  triggerToggle: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', toggle: e }] }] }),
  triggerModify: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', modify: e, values: 'datum' }] }] }),
  triggerValues: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', insert: 'datum', values: e }] }] }),
  triggerTrigger: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: e, remove: true }] }] }),
  markTrigger: (e) => base({ marks: [rect({}, { name: 'm', on: [{ trigger: e, modify: 'datum' }] })] }),
  markTriggerModify: (e) => base({ marks: [rect({}, { name: 'm', on: [{ trigger: 's', modify: e }] })] }),
  encSignal: (e) => base({ marks: [rect({ x: { signal: e } })] }),
  encSignalScale: (e) => base({ marks: [rect({ x: { scale: 'x', signal: e } })] }),
  encSignalOffset: (e) => base({ marks: [rect({ x: { scale: 'x', field: 'a', offset: { signal: e } } })] }),
  encSignalMult: (e) => base({ marks: [rect({ x: { field: 'a', mult: { signal: e }, round: true } })] }),
  encSignalExponent: (e) => base({ marks: [rect({ x: { signal: 's', exponent: { signal: e } } })] }),
  encSignalBand: (e) => base({ scales: [{ name: 'b', type: 'band', domain: ['a'], range: [0, 1] }], marks: [rect({ x: { scale: 'b', field: 'a', band: { signal: e } } })] }),
  encScaleSignal: (e) => base({ marks: [rect({ x: { scale: { signal: e }, field: 'a' } })] }),
  encFieldSignal: (e) => base({ marks: [rect({ x: { field: { signal: e } } })] }),
  encColor: (e) => base({ marks: [rect({ fill: { color: { r: { signal: e }, g: { value: 1 }, b: { value: 2 } } } })] }),
  encGradient: (e) => base({ scales: [{ name: 'c', type: 'linear', domain: [0, 1], range: ['red', 'blue'] }], marks: [rect({ fill: { gradient: 'c', start: [0, 0], stop: [1, 1], count: { signal: e } } })] }),
  encRule: (e) => base({ marks: [rect({ x: [{ test: e, value: 1 }, { value: 2 }] })] }),
  encRuleSignal: (e) => base({ marks: [rect({ x: [{ test: 'true', signal: e }, { value: 2 }] })] }),
  encEnter: (e) => base({ marks: [{ type: 'rect', encode: { enter: { x: { signal: e } }, hover: { y: { signal: '1' } } } }] }),
  encSecondChannel: (e) => base({ marks: [rect({ y: { signal: '2' }, x: { signal: e } })] }),
  encGroupMark: (e) => inGroup({ marks: [rect({ x: { signal: e } })] }),
  axisEncode: (e) => base({ axes: [{ scale: 'x', orient: 'bottom', encode: { labels: { update: { text: { signal: e } } } } }] }),
  legendEncode: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', encode: { labels: { update: { text: { signal: e } } } } }] }),
  legendEncodeSymbols: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', type: 'symbol', encode: { symbols: { update: { size: { signal: e } } } } }] }),
  titleEncode: (e) => base({ title: { text: 'x', encode: { title: { update: { fill: { signal: e } } } } } }),
  scaleDomain: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  scaleDomainItem: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, { signal: e }], range: [0, 1] }] }),
  scaleRange: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: { signal: e } }] }),
  scaleRound: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1], round: { signal: e } }] }),
  scaleZero: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1], zero: { signal: e } }] }),
  scaleSecond: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }, { name: 'y', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  axisValues: (e) => base({ axes: [{ scale: 'x', orient: 'bottom', values: { signal: e } }] }),
  axisTitle: (e) => base({ axes: [{ scale: 'x', orient: 'bottom', title: { signal: e } }] }),
  axisTickCount: (e) => base({ axes: [{ scale: 'x', orient: 'bottom', tickCount: { signal: e } }] }),
  legendTitle: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', title: { signal: e } }] }),
  title: (e) => base({ title: { text: { signal: e } } }),
  markClip: (e) => base({ marks: [{ type: 'group', clip: { signal: e } }] }),
  markZindex: (e) => base({ marks: [rect({}, { zindex: { signal: e } })] }), // (a z-index is not parsed)
  markInteractive: (e) => base({ marks: [rect({}, { interactive: { signal: e } })] }),
  markSort: (e) => base({ marks: [rect({}, { sort: { field: { signal: e } } })] }),
  markLayout: (e) => base({ marks: [{ type: 'group', layout: { columns: { signal: e } } }] }),
  projection: (e) => base({ projections: [{ name: 'p', type: 'mercator', scale: { signal: e } }] }),
  dataUrl: (e) => base({ data: [{ name: 'd', url: { signal: e } }] }),
  dataValues: (e) => base({ data: [{ name: 'd', values: { signal: e } }] }),
  dataFormat: (e) => base({ data: [{ name: 'd', values: [], format: { type: { signal: e } } }] }),
  viewWidth: (e) => ({ ...base(), width: { signal: e } }),
  viewPadding: (e) => ({ ...base(), padding: { signal: e } }),
  viewAutosize: (e) => ({ ...base(), autosize: { signal: e } }),
  viewBackground: (e) => ({ ...base(), background: { signal: e } }),
  viewWidthMerged: (e) => ({ ...base(), signals: [{ name: 'width', update: e }] }),
  configSignal: (e) => ({ ...base(), config: { signals: [{ name: 'cs', value: 0, update: e }] } }),
  bindProp: (e) => base({ signals: [{ name: 't', value: 0, bind: { input: 'range', min: { signal: e } } }] }),
  inGroupScale: (e) => inGroup({ scales: [{ name: 'gx', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  inGroupAxis: (e) => inGroup({ scales: [{ name: 'gx', type: 'linear', domain: [0, 1], range: [0, 1] }], axes: [{ scale: 'gx', orient: 'bottom', values: { signal: e } }] }),
  inGroupSignal: (e) => inGroup({ signals: [{ name: 'gs', value: 1 }, { name: 'g', update: e }] }),
  inGroupMarkEncode: (e) => inGroup({ signals: [{ name: 'gs', value: 1 }], marks: [rect({ x: { signal: e } })] }),
  inGroupOwnEncode: (e) => inGroup({ signals: [{ name: 'gs', value: 1 }], encode: { update: { x: { signal: e } } } }),
  inGroupLambda: (e) => inGroup({ signals: [{ name: 'gs', value: 1 }], scales: [{ name: 'gx', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  inGroupLambdaInChild: (e) => inGroup({ signals: [{ name: 'gs', value: 1 }], marks: [{ type: 'group', scales: [{ name: 'hx', type: 'linear', domain: { signal: e }, range: [0, 1] }] }] }),
  inChildSeenByParent: (e) => base({ signals: [{ name: 't', update: e }], marks: [{ type: 'group', signals: [{ name: 'gs', value: 1 }] }] }),
  inSiblingGroup: (e) => base({ marks: [{ type: 'group', signals: [{ name: 'gs', value: 1 }] }, { type: 'group', signals: [{ name: 'g2', update: e }] }] }),
  inFacetGroup: (e) => base({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'd', groupby: 'a' } }, signals: [{ name: 'g', update: e }] }] }),
  inLegendEntries: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', encode: { symbols: { update: { size: { signal: e } } } } }] }),
  // a transform's own signal is a signal from the next expression on
  transformSignalThen: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: 'a', signal: 'ext' }, { type: 'filter', expr: e }] }] }),
  transformSignalBefore: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }, { type: 'extent', field: 'a', signal: 'ext' }] }] }),
  transformSignalNextData: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: 'a', signal: 'ext' }] }, { name: 'e', source: 'd', transform: [{ type: 'filter', expr: e }] }] }),
  transformSignalEarlierData: (e) => base({ data: [{ name: 'e', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }, { name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: 'a', signal: 'ext' }] }] }),
  transformSignalInSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: 'a', signal: 'ext' }] }], signals: [{ name: 't', update: e }] }),
  transformSignalLambda: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'bin', field: 'a', extent: [0, 1], maxbins: { signal: e } }, { type: 'extent', field: 'a', signal: 'ext' }] }] }),
  // the same expression twice, in two places: the first one in vega's order is the one reported
  orderSignalThenMark: (e) => base({ signals: [{ name: 't', update: e }], marks: [rect({ x: { signal: '(' } })] }),
  orderMarkThenLambda: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: { signal: ')' }, range: [0, 1] }], marks: [rect({ x: { signal: e } })] }),
  orderTransformThenSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }], signals: [{ name: 't', update: '(' }] }),
  orderLambdaAfterExpression: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: { signal: e }, range: [0, 1] }], signals: [{ name: 't', update: 'nosuch2 + (' }] }),
  orderSignalsInOrder: (e) => base({ signals: [{ name: 't', update: e }, { name: 'u', update: 'foo()' }, { name: 'v', update: '(' }] }),
  orderMarkInteractiveClip: (e) => base({ marks: [{ type: 'group', clip: { signal: e }, interactive: { signal: 'nosuch7' } }] }),
  orderMarkClipSort: (e) => base({ marks: [rect({}, { clip: { signal: 'nosuch8' }, sort: { field: { signal: e } } })] }),
  orderMarkSortLayout: (e) => base({ marks: [{ type: 'group', layout: { columns: { signal: 'nosuch9' } }, sort: { field: { signal: e } } }] }),
  markSortExpr: (e) => base({ marks: [rect({}, { sort: { field: { expr: e } } })] }),
  markSortOrderExpr: (e) => base({ marks: [rect({}, { sort: { field: 'a', order: { expr: e } } })] }),
  markSortSignalThenExpr: (e) => base({ marks: [rect({}, { sort: { field: [{ signal: 'nosuch10' }, { expr: e }] } })] }),
  markEncodeThenTransform: (e) => base({ marks: [rect({ x: { signal: e } }, { transform: [{ type: 'wordcloud', fontSize: { expr: 'foo()' } }] })] }),
  markTransformThenSort: (e) => base({ marks: [rect({}, { transform: [{ type: 'wordcloud', text: { expr: e } }], sort: { field: { expr: 'foo()' } } })] }),
  markOverlap: (e) => base({ marks: [rect({}, { overlap: { separation: { signal: e } } })] }),
  markTransformSignal: (e) => base({ marks: [rect({}, { transform: [{ type: 'wordcloud', signal: 'ext' }] }), rect({ x: { signal: e } })] }),
  // the parameters of a transform are read in the order of its definition, not of the spec's keys
  paramOrderWordcloud: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'wordcloud', padding: { expr: 'foo()' }, fontSize: { expr: e } }] }] }),
  paramOrderWordcloudAll: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'wordcloud', padding: { expr: '1 +' }, rotate: { expr: 'nosuch' }, fontSize: { expr: 'foo()' }, fontWeight: { expr: e }, text: { expr: '(' } }] }] }),
  paramOrderWordcloudReversed: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'wordcloud', text: { expr: e }, padding: { expr: '1 +' }, font: { expr: 'foo()' } }] }] }),
  paramOrderLambdas: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'bin', field: 'a', maxbins: { signal: e }, extent: [0, { signal: 'nosuch11' }] }] }] }),
  paramOrderAggregate: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'aggregate', fields: [{ expr: e }], groupby: [{ expr: 'foo()' }] }] }] }),
  paramOrderStack: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'stack', sort: { field: { expr: e } }, field: { expr: 'nosuch12' } }] }] }),
  paramOrderLookup: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }] }, { name: 'e', values: [{ a: 1 }], transform: [{ type: 'lookup', fields: [{ expr: e }], values: [{ expr: 'foo()' }], from: 'd', key: 'a' }] }] }),
  paramUnknownKey: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: 'a', nosuchparam: { expr: e } }] }] }),
  paramExprNotAllowed: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'bin', field: 'a', extent: [0, 1], maxbins: { expr: e } }] }] }),
  paramExprSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: { signal: e } }] }] }),
  paramFieldSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'extent', field: { signal: e } }] }] }),
  orderExprBeforeLambda: (e) => base({ marks: [rect({ x: { signal: e } }, { clip: { signal: 'nosuch3' } })] }),
}

const AXIS_PROPERTIES = [
  'aria', 'description', 'orient', 'bandPosition', 'domain', 'domainCap', 'domainColor', 'domainDash', 'domainDashOffset', 'domainOpacity', 'domainWidth',
  'format', 'formatType', 'grid', 'gridCap', 'gridColor', 'gridDash', 'gridDashOffset', 'gridOpacity', 'gridScale', 'gridWidth',
  'labels', 'labelAlign', 'labelAngle', 'labelBaseline', 'labelBound', 'labelColor', 'labelFlush', 'labelFlushOffset', 'labelFont', 'labelFontSize',
  'labelFontStyle', 'labelFontWeight', 'labelLimit', 'labelLineHeight', 'labelOffset', 'labelOpacity', 'labelOverlap', 'labelPadding', 'labelSeparation',
  'maxExtent', 'minExtent', 'offset', 'position', 'tickBand', 'tickCap', 'tickColor', 'tickCount', 'tickDash', 'tickDashOffset', 'tickExtra', 'tickMinStep',
  'tickOffset', 'tickOpacity', 'tickRound', 'ticks', 'tickSize', 'tickWidth', 'title', 'titleAlign', 'titleAnchor', 'titleAngle', 'titleBaseline', 'titleColor',
  'titleFont', 'titleFontSize', 'titleFontStyle', 'titleFontWeight', 'titleLimit', 'titleLineHeight', 'titleOpacity', 'titlePadding', 'titleX', 'titleY',
  'translate', 'values', 'zindex',
]
const LEGEND_PROPERTIES = [
  'aria', 'description', 'type', 'direction', 'orient', 'format', 'formatType', 'title', 'titleAlign', 'titleAnchor', 'titleBaseline', 'titleColor', 'titleFont',
  'titleFontSize', 'titleFontStyle', 'titleFontWeight', 'titleLimit', 'titleLineHeight', 'titleOpacity', 'titleOrient', 'titlePadding',
  'clipHeight', 'columns', 'columnPadding', 'rowPadding', 'gridAlign', 'gradientLength', 'gradientOpacity', 'gradientStrokeColor', 'gradientStrokeWidth',
  'gradientThickness', 'symbolType', 'symbolSize', 'symbolOpacity', 'symbolFillColor', 'symbolStrokeColor', 'symbolStrokeWidth', 'symbolDash',
  'symbolDashOffset', 'symbolLimit', 'symbolOffset', 'tickCount', 'tickMinStep', 'values', 'labelAlign', 'labelBaseline', 'labelColor', 'labelFont',
  'labelFontSize', 'labelFontStyle', 'labelFontWeight', 'labelLimit', 'labelOffset', 'labelOpacity', 'labelOverlap', 'labelSeparation',
  'legendX', 'legendY', 'offset', 'padding', 'cornerRadius', 'fillColor', 'strokeColor', 'zindex',
]
const TITLE_PROPERTIES = [
  'aria', 'description', 'orient', 'anchor', 'frame', 'offset', 'align', 'angle', 'baseline', 'color', 'dx', 'dy', 'font', 'fontSize', 'fontStyle',
  'fontWeight', 'limit', 'lineHeight', 'zindex', 'subtitle', 'subtitleColor', 'subtitleFont', 'subtitleFontSize', 'subtitleFontStyle',
  'subtitleFontWeight', 'subtitleLineHeight', 'subtitlePadding',
]

const ordinal = { name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }
const ramp = { name: 'g', type: 'linear', domain: [0, 1], range: ['red', 'blue'] }
const steps = { name: 'q', type: 'quantize', domain: [0, 1], range: ['red', 'blue'] }
const sizes = { name: 'z', type: 'linear', domain: [0, 1], range: [10, 100] }
const band = { name: 'b', type: 'band', domain: ['a'], range: [0, 1] }
const guideSpec = (guide: 'axes' | 'legends', scales: Spec[], g: Spec, more: Spec = {}): Spec => base({ scales, [guide]: [g], ...more })

/** The ways an axis can be made: the marks it has, its orient, its scale. */
const AXIS_VARIANTS: Record<string, Spec> = {
  plain: {}, grid: { grid: true }, 'no ticks': { ticks: false }, 'no labels': { labels: false }, 'no domain': { domain: false }, titled: { title: 'T' },
  'grid only': { grid: true, ticks: false, labels: false, domain: false }, overlap: { labelOverlap: true }, bound: { labelBound: 3 },
  flush: { labelFlush: true }, 'flush, aligned': { labelFlush: true, labelAlign: 'left' }, 'tick band': { tickBand: 'extent' }, left: { orient: 'left' },
}
/** The ways a legend can be made: its type, its channels, its title. */
const LEGEND_VARIANTS: Record<string, { scales: Spec[]; legend: Spec }> = {
  symbol: { scales: [ordinal], legend: { fill: 'c' } },
  'symbol, titled': { scales: [ordinal], legend: { fill: 'c', title: 'T' } },
  gradient: { scales: [ramp], legend: { fill: 'g' } },
  'gradient, titled': { scales: [ramp], legend: { fill: 'g', title: 'T' } },
  discrete: { scales: [steps], legend: { fill: 'q' } },
  size: { scales: [sizes], legend: { size: 'z' } },
  'fill and size': { scales: [ordinal, sizes], legend: { fill: 'c', size: 'z' } },
  'stroke and shape': { scales: [ordinal, { name: 'h', type: 'ordinal', domain: [0, 1], range: ['circle', 'square'] }], legend: { stroke: 'c', shape: 'h' } },
  'typed gradient': { scales: [ordinal], legend: { fill: 'c', type: 'gradient' } },
  horizontal: { scales: [ordinal], legend: { fill: 'c', direction: 'horizontal' } },
  'own size': { scales: [ordinal], legend: { fill: 'c', symbolSize: 50, encode: { symbols: { update: { strokeWidth: { value: 3 } } }, labels: { update: { fontSize: { value: 12 } } } } } },
}

/**
 * Every property an axis, a legend and the title can have, as `{signal: <the expression>}`, in each of the ways a guide is made. vega
 * reads a property only in the marks the guide has, and writes some of them into a longer expression (an axis whose `orient` is a
 * signal, the positions of a band, a legend's sizes), so what a syntax error is quoted as differs from property to property.
 */
export const GUIDE_CASES: Array<{ name: string; property: string; make: (e: string) => Spec }> = [
  ...Object.entries(AXIS_VARIANTS).flatMap(([variant, extra]) => AXIS_PROPERTIES.map((property) => ({
    name: `axis [${variant}] ${property}`, property,
    make: (e: string): Spec => guideSpec('axes', [linear], { scale: 'x', orient: property === 'orient' ? undefined : 'bottom', ...extra, [property]: { signal: e } }),
  }))),
  ...AXIS_PROPERTIES.map((property) => ({
    name: `axis [orient signal] ${property}`, property,
    make: (e: string): Spec => guideSpec('axes', [linear], { scale: 'x', orient: { signal: 's' }, [property]: { signal: e } }),
  })),
  ...AXIS_PROPERTIES.map((property) => ({
    name: `axis [band] ${property}`, property,
    make: (e: string): Spec => guideSpec('axes', [band], { scale: 'b', orient: 'bottom', [property]: { signal: e } }),
  })),
  ...Object.entries(LEGEND_VARIANTS).flatMap(([variant, { scales, legend }]) => LEGEND_PROPERTIES.map((property) => ({
    name: `legend [${variant}] ${property}`, property,
    make: (e: string): Spec => guideSpec('legends', scales, { ...legend, [property]: { signal: e } }),
  }))),
  ...['plain', 'subtitled'].flatMap((variant) => TITLE_PROPERTIES.map((property) => ({
    name: `title [${variant}] ${property}`, property,
    make: (e: string): Spec => base({ title: { text: 't', ...(variant === 'subtitled' ? { subtitle: 'u' } : {}), [property]: { signal: e } } }),
  }))),
]

/**
 * Guides made at random: a few settings that decide which marks a guide has and what it reads (flags, alignments, the type of a
 * legend), and one property that holds an expression. Only one is broken, so that the order two refusals come in does not matter.
 */
const AXIS_SETTINGS: Array<[string, unknown[]]> = [
  ['orient', ['top', 'bottom', 'left', 'right', { signal: 's' }]], ['grid', [true, false, { signal: 's' }]], ['ticks', [true, false]], ['labels', [true, false]],
  ['domain', [true, false]], ['title', ['T', { signal: 's' }]], ['labelFlush', [true, false, 0, 4, { signal: 's' }]], ['labelAlign', ['left']], ['labelBaseline', ['top']],
  ['labelOverlap', [true, 'parity']], ['labelBound', [3, { signal: 's' }]], ['tickBand', ['extent', 'center', { signal: 's' }]], ['tickExtra', [true]],
  ['bandPosition', [0.5, { signal: 's' }]], ['tickOffset', [1, { signal: 's' }]], ['labelFlushOffset', [2, { signal: 's' }]], ['gridScale', ['x']],
]
const LEGEND_SETTINGS: Array<[string, unknown[]]> = [
  ['title', ['T']], ['direction', ['horizontal', 'vertical']], ['type', ['symbol', 'gradient', 'discrete']], ['labelOverlap', [true, 'parity', false]],
  ['symbolSize', [50, { signal: 's' }]], ['symbolStrokeWidth', [2, { signal: 's' }]], ['labelFontSize', [12, { signal: 's' }]], ['columns', [2, { signal: 's' }]],
  ['symbolType', ['square']], ['labelAlign', ['left']], ['gridAlign', ['all']], ['rowPadding', [3]], ['clipHeight', [30]],
]
const LEGEND_SCALES: Array<{ scales: Spec[]; legend: Spec }> = [
  { scales: [ordinal], legend: { fill: 'c' } }, { scales: [ramp], legend: { fill: 'g' } }, { scales: [steps], legend: { fill: 'q' } },
  { scales: [sizes], legend: { size: 'z' } }, { scales: [ordinal, sizes], legend: { fill: 'c', size: 'z' } },
  { scales: [ordinal, { name: 'h', type: 'ordinal', domain: [0, 1], range: ['circle', 'square'] }], legend: { stroke: 'c', shape: 'h' } },
]

/** A guide made from the random draws of `r`: its spec, and the property that holds the expression. */
export function randomGuide(r: { int(n: number): number; pick<T>(list: readonly T[]): T }, expression: string): { spec: Spec; property: string } {
  const legend = r.int(2) === 0
  const settings = legend ? LEGEND_SETTINGS : AXIS_SETTINGS
  const properties = legend ? LEGEND_PROPERTIES : AXIS_PROPERTIES
  const guide: Spec = {}
  for (let k = r.int(5); k > 0; k--) {
    const [name, values] = r.pick(settings)
    guide[name] = r.pick(values)
  }
  const property = r.pick(properties)
  if (!(property in guide) || r.int(2) === 0) guide[property] = { signal: expression }
  else return randomGuide(r, expression)
  if (legend) {
    const { scales, legend: channels } = r.pick(LEGEND_SCALES)
    return { spec: guideSpec('legends', scales, { ...channels, ...guide }), property }
  }
  const banded = r.int(4) === 0
  return { spec: guideSpec('axes', [banded ? band : linear], { scale: banded ? 'b' : 'x', ...(guide.orient === undefined ? { orient: 'bottom' } : {}), ...guide }), property }
}

const SELECTORS = ['mousedown', 'window:keydown', '@m:click', 'rect:click', 'click[event.x > 0]', 'click{10}']
/** Where the handler of a signal holds an expression or an event selector. */
export const HANDLER_SITES: Record<string, (e: string) => Spec> = {
  onUpdate: (e) => handler('mousedown', e),
  onUpdateExpr: (e) => handler('mousedown', { expr: e }),
  onUpdateSignal: (e) => handler('mousedown', { signal: e }),
  onUpdateValue: (e) => handler('mousedown', { value: e }),
  onEventFilterSelector: (e) => handler(`mousedown[${e}]`),
  onEventFilterSelectorTwo: (e) => handler(`mousedown[event.x > 0][${e}]`),
  onEventFilterSelectorMarked: (e) => handler(`rect:mousedown[${e}]`),
  onEventFilterSelectorNamed: (e) => handler(`@m:mousedown[${e}]`),
  onEventFilterSelectorWindow: (e) => handler(`window:mousedown[${e}]`),
  onEventFilterSelectorMerged: (e) => handler(`mouseup, mousedown[${e}]`),
  onEventFilterSelectorBetween: (e) => handler(`[mousedown, mouseup[${e}]] > mousemove`),
  onEventFilterSelectorBetweenFilter: (e) => handler(`[mousedown, mouseup] > mousemove[${e}]`),
  onEventSelector: (e) => handler(e),
  onEventSelectorMerged: (e) => handler(`mousedown, ${e}`),
  onEventSelectorBetween: (e) => handler(`[${e}, mouseup] > mousemove`),
  onEventFilter: (e) => handler({ type: 'mousedown', filter: e }),
  onEventFilterList: (e) => handler({ type: 'mousedown', filter: ['event.x > 0', e] }),
  onEventMark: (e) => handler({ type: 'mousedown', marktype: 'rect', markname: 'm', filter: e }),
  onEventMarkOnly: (e) => handler({ type: 'mousedown', marktype: 'rect', markname: e }),
  onEventSourceScope: (e) => handler({ source: 'scope', type: 'mousedown', filter: e }),
  onEventMerge: (e) => handler([{ type: 'mouseup' }, { type: 'mousedown', filter: e }]),
  onEventMergeObject: (e) => handler({ merge: [{ type: 'mouseup' }, { type: 'mousedown', filter: e }] }),
  onEventBetween: (e) => handler({ type: 'mousemove', between: [{ type: 'mousedown' }, { type: 'mouseup', filter: e }] }),
  onEventBetweenOwnFilter: (e) => handler({ type: 'mousemove', filter: e, between: [{ type: 'mousedown', filter: 'nosuch4' }, { type: 'mouseup' }] }),
  onEventNested: (e) => handler({ stream: { type: 'mousedown', filter: e } }),
  onEventNestedFilter: (e) => handler({ stream: { type: 'mousedown' }, filter: e }),
  onEventTimer: (e) => handler({ type: 'timer', throttle: 100, filter: e }),
  onEventSignal: (e) => handler({ signal: e }),
  onEventSignals: (e) => handler([{ signal: 's' }, { signal: e }]),
  onEventSignalAndStream: (e) => handler([{ signal: e }, { type: 'mousedown', filter: 'foo()' }]),
  onEventStreamAndSignal: (e) => handler([{ type: 'mousedown', filter: e }, { signal: 'nosuch5' }]),
  onEventScale: (e) => handler({ scale: e }),
  onEventScaleAndSignal: (e) => handler([{ scale: 'x' }, { signal: e }]),
  onEventScales: (e) => handler([{ scale: 'x' }, { scale: e }]),
  onUpdateThenFilter: (e) => handler({ type: 'mousedown', filter: 'foo()' }, e),
  onUpdateThenSelector: (e) => handler('mousedown[nosuch6]', e),
  onSecond: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: 'mousedown', update: '1' }, { events: 'mouseup', update: e }] }] }),
  onTwoSignals: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: 'mousedown', update: e }] }, { name: 'u', value: 0, on: [{ events: 'mouseup', update: 'foo()' }] }] }),
  onAfterUpdate: (e) => base({ signals: [{ name: 't', value: 0, update: '1', on: [{ events: 'mousedown', update: e }] }] }),
  onOuter: (e) => inGroup({ signals: [{ name: 's', push: 'outer', on: [{ events: 'mousedown', update: e }] }] }),
  onInGroup: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: { type: 'mousedown', filter: e }, update: '1' }] }] }),
  onInGroupSelector: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: `mousedown[${e}]`, update: '1' }] }] }),
  onInGroupUpdate: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: 'mousedown', update: e }] }] }),
  onInGroupWindow: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: `window:mousedown[${e}]`, update: '1' }] }] }),
  onConfigSignal: (e) => ({ ...base(), config: { signals: [{ name: 'cs', value: 0, on: [{ events: 'mousedown', update: e }] }] } }),
  onViewSignal: (e) => base({ signals: [{ name: 'width', on: [{ events: 'mousedown', update: e }] }] }),
}

/** Where the text is the name of a mark's encode set: the handler is accepted, and the engine does not bind it. */
export const UNBOUND_HANDLER_SITES: Record<string, (e: string) => Spec> = {
  onEncode: (e) => raw({ events: 'mousedown', encode: e }),
}

/**
 * What a handler vega accepts may still report when it is bound, by site: a selector's source that is no CSS selector (the pool's
 * texts are valid expressions, not always valid selectors), and the encode set of a handler, which the engine does not run.
 */
export const BIND_TIME_REPORTS: Record<string, RegExp> = {
  onEncode: /`encode` updates/,
  onEventSelector: /Invalid selector/,
  onEventSelectorMerged: /Invalid selector/,
  onEventSelectorBetween: /Invalid selector/,
}

/** Handlers that are wrong in the way they are written, whatever the expression. */
export const HANDLER_SHAPES: Record<string, Spec> = {
  noEvents: raw({ update: '1' }),
  emptyEvents: handler(''),
  noUpdate: raw({ events: 'mousedown' }),
  nullUpdate: handler('mousedown', null),
  numberUpdate: handler('mousedown', 5),
  emptyObjectUpdate: handler('mousedown', {}),
  encodeAndUpdate: handler('mousedown', '1', { encode: 'e' }),
  encodeOnly: raw({ events: 'mousedown', encode: 'e' }),
  streamWithoutType: handler({ filter: '1' }),
  streamNumber: handler(5),
  streamEmptyObject: handler({}),
  betweenOne: handler({ type: 'mousemove', between: [{ type: 'mousedown' }] }),
  betweenThree: handler({ type: 'mousemove', between: [{ type: 'a' }, { type: 'b' }, { type: 'c' }] }),
  betweenBad: handler({ type: 'mousemove', between: [{ type: 'a' }, {}] }),
  initAndUpdate: base({ signals: [{ name: 't', init: '1', update: '2' }] }),
  widthInitAndUpdate: { ...base(), width: { signal: 's' }, signals: [{ name: 'width', init: '1' }] },
  unknownScale: handler({ scale: 'nosuch' }),
  unknownScaleInGroup: base({ marks: [{ type: 'group', signals: [{ name: 'g', on: [{ events: { scale: 'nosuch' }, update: '1' }] }] }] }),
  scaleOfParent: base({ marks: [{ type: 'group', signals: [{ name: 'g', on: [{ events: { scale: 'x' }, update: '1' }] }] }] }),
  scaleOfChild: base({ signals: [{ name: 't', on: [{ events: { scale: 'gx' }, update: '1' }] }], marks: [{ type: 'group', scales: [{ name: 'gx', type: 'linear', domain: [0, 1], range: [0, 1] }] }] }),
  projectionSource: base({ projections: [{ name: 'p', type: 'mercator' }], signals: [{ name: 't', on: [{ events: { scale: 'p' }, update: '1' }] }] }),
  ...Object.fromEntries(SELECTORS.map((s) => [`selector ${s}`, handler(s)])),
}

/**
 * The outcome of parsing a spec in vega, as a message. A refusal that is raised while the expression code is being written leaves
 * the code generator holding the names it had read (it clears them only when it finishes), and the next expression then asks
 * for them: a parse of a plain spec first sees to it that every outcome is what the spec alone gives.
 */
export function vegaOutcome(spec: Spec): string {
  try { vega.parse({ signals: [{ name: 'flush', update: '1' }] } as never) } catch { /* the leftover names of an earlier refusal */ }
  try {
    vega.parse(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export function asterOutcome(spec: Spec): string {
  try {
    compileChart(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
