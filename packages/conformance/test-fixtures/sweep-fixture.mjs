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
  // oracle renders, Aster refuses ("unsupported transform type force"): a ci0 name must not hide it
  'ci-crash': [c('x-aggregate-ci0', chart({ transform: [{ type: 'force' }] }))],
  // same crash on a non-ci name (control for the masking test)
  'plain-crash': [c('x-plain', chart({ transform: [{ type: 'force' }] }))],
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

export function generate() {
  const name = process.env.FIXTURE ?? 'good'
  const cases = FIXTURES[name]
  if (!cases) throw new Error(`unknown FIXTURE ${name}`)
  return { cases, skips: [] }
}
