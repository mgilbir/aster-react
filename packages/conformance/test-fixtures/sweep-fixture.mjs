/**
 * Synthetic sweeps for scripts/run-sweep.test.mjs. Selected with the sweep name
 * `../../test-fixtures/sweep-fixture` plus the FIXTURE env var; they exist only to
 * drive run-sweep.ts through each verdict path.
 */
const rows = [{ a: 1, b: 2 }]
const chart = (extra = {}) => ({
  width: 60, height: 40, padding: 2, autosize: 'none', background: 'white',
  data: [{ name: 't', values: rows, ...extra }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 10 }, y: { value: 10 }, size: { value: 30 }, fill: { value: 'steelblue' } } } }],
})
const c = (name, spec) => ({ name, family: 'fixture', property: name, spec })

const FIXTURES = {
  // both engines render the same thing
  good: [c('plain-a', chart()), c('plain-b', chart())],
  // oracle renders (it logs the unknown op), Aster refuses ("unsupported aggregate op bogus"): a ci0 name must not hide it
  'ci-crash': [c('x-aggregate-ci0', chart({ transform: [{ type: 'aggregate', ops: ['bogus'], fields: ['a'] }] }))],
  // same crash on a non-ci name (control for the masking test)
  'plain-crash': [c('x-plain', chart({ transform: [{ type: 'aggregate', ops: ['bogus'], fields: ['a'] }] }))],
  // the oracle crashes on a data set named like a member of Object.prototype, Aster renders it (a documented deviation): a node-error
  // (an unknown mark type no longer serves: Aster refuses it as vega does, C238)
  'node-error': [c('plain-a', chart()), c('oracle-only-crash', { width: 10, height: 10, data: [{ name: 'toString', values: [{ a: 1 }] }] })],
  // oracle is genuinely random, so two engines legitimately differ on a ci case
  'ci-random': [c('x-aggregate-ci1', {
    width: 80, height: 40, padding: 2, autosize: 'none', background: 'white',
    marks: [{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: "'' + random()" } } } }],
  })],
}

// deterministic oracle, deterministic Aster difference: the engine is handed the same
// chart with a different fill (`ourSpec`), so the verdict path is exercised without
// depending on a renderer defect that a later change may fix
const differBase = {
  width: 60, height: 40, padding: 2, autosize: 'none', background: 'white',
  data: [{ name: 't', values: rows }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 10 }, y: { value: 10 }, size: { value: 30 }, fill: { value: 'steelblue' } } } }],
}
FIXTURES['ci-differ'] = [{
  ...c('x-aggregate-ci0', differBase),
  ourSpec: { ...differBase, marks: [{ ...differBase.marks[0], encode: { update: { ...differBase.marks[0].encode.update, fill: { value: 'tomato' } } } }] },
}]

// signals-sweep cases (a `writes` list): the oracle draws, writes the signal, draws again; the engine
// does the same through a session
const writeChart = (autosize = 'pad') => ({
  width: 60, height: 40, padding: 2, autosize, background: 'white',
  signals: [{ name: 'px', value: 10 }],
  marks: [{ type: 'rect', encode: { update: { x: { signal: 'px' }, y: { value: 10 }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'steelblue' } } } }],
})
const w = (name, spec, value, extra = {}) => ({ ...c(name, spec), writes: [{ name: 'px', value }], ...extra })
// the write stays inside the view: vega's second render and the engine agree
FIXTURES['write-ok'] = [w('move-inside', writeChart('none'), 30)]
// the write moves the rect far outside the view: with autosize pad vega's FRESH render grows the view,
// its incremental second render keeps the first run's size. The engine (a pure function of its
// inputs) equals the fresh one: 'retained', not 'ok' and not 'differ'
FIXTURES['write-retained'] = [w('move-outside', writeChart('pad'), 400)]
// the engine differs from BOTH vega renders: always a difference
FIXTURES['write-differ'] = [w('move-inside', writeChart('none'), 30, {
  ourSpec: { ...writeChart('none'), marks: [{ type: 'rect', encode: { update: { x: { signal: 'px' }, y: { value: 10 }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'tomato' } } } }] },
})]

// vega writes a text angle that is a word verbatim (`rotate(sideways)`): its document is not an SVG anyone can
// judge. When the ORACLE's document is the unjudgeable one there is nothing to compare: an oracle-side failure
// (a node-error); when only the engine's is, it stays a difference
const angled = (angle) => ({
  width: 60, height: 40, padding: 2, autosize: 'none', background: 'white',
  marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { value: 'hi' }, angle: { value: angle } } } }],
})
FIXTURES['oracle-unjudgeable'] = [c('plain-a', chart()), c('sideways', angled('sideways'))]
FIXTURES['ours-unjudgeable'] = [{ ...c('sideways', angled(0)), ourSpec: angled('sideways') }]

// C61: the engine's side has its transform removed, and both specs share ONE rows table (as a generator's module-level table
// does). The oracle's `stack` writes y0/y1 onto those rows; a runner that hands Aster rows the oracle has run on hands it the
// oracle's answers, and an Aster with no stack "agrees". Each engine must get its own copy, taken before either runs: this
// case must differ.
const stackRows = [{ k: 'a', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3 }]
const stacked = (transform) => ({
  width: 60, height: 40, padding: 2, autosize: 'none', background: 'white',
  data: [{ name: 't', values: stackRows, transform }],
  scales: [{ name: 'y', type: 'linear', domain: [0, 6], range: 'height' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 5 }, width: { value: 10 }, y: { scale: 'y', field: 'y1' }, y2: { scale: 'y', field: 'y0' }, fill: { value: 'steelblue' } } } }],
})
FIXTURES['transform-removed'] = [{ ...c('stacked', stacked([{ type: 'stack', groupby: ['k'], field: 'v' }])), ourSpec: stacked([]) }]
// the same table read by two cases: the second case's oracle has no stack, its engine has one. Neither may read what the first
// case's oracle wrote onto the table (with y0/y1 left on the rows, the second oracle would draw the stack it does not run)
FIXTURES['shared-table'] = [
  c('a-stacked', stacked([{ type: 'stack', groupby: ['k'], field: 'v' }])),
  { ...c('b-unstacked', stacked([])), ourSpec: stacked([{ type: 'stack', groupby: ['k'], field: 'v' }]) },
]
// the same through the Vega-Lite path: both compilers read one input spec
const vlStacked = { data: { values: stackRows }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative', aggregate: 'sum' } }, width: 40, height: 40 }
FIXTURES['vl-transform-removed'] = [{ ...c('vl-stacked', vlStacked), lite: true, ourSpec: { ...vlStacked, encoding: { ...vlStacked.encoding, y: { field: 'v', type: 'quantitative' } } } }]

export function generate() {
  const name = process.env.FIXTURE ?? 'good'
  const cases = FIXTURES[name]
  if (!cases) throw new Error(`unknown FIXTURE ${name}`)
  return { cases, skips: [] }
}
