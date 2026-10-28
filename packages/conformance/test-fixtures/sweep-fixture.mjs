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
  // oracle renders, Aster refuses ("unsupported transform type nest"): a ci0 name must not hide it
  'ci-crash': [c('x-aggregate-ci0', chart({ transform: [{ type: 'nest', keys: ['a'] }] }))],
  // same crash on a non-ci name (control for the masking test)
  'plain-crash': [c('x-plain', chart({ transform: [{ type: 'nest', keys: ['a'] }] }))],
  // the oracle crashes on an unknown mark, Aster renders it: a node-error
  'node-error': [c('plain-a', chart()), c('oracle-only-crash', { width: 10, height: 10, marks: [{ type: 'nosuchmark' }] })],
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

export function generate() {
  const name = process.env.FIXTURE ?? 'good'
  const cases = FIXTURES[name]
  if (!cases) throw new Error(`unknown FIXTURE ${name}`)
  return { cases, skips: [] }
}
