/**
 * Synthetic sweeps for scripts/run-sweep-specs.test.mjs: how a generated case carries its chart (`spec` object or `specText`
 * JSON). Selected with the sweep name `../../test-fixtures/sweep-spec-contract` plus the FIXTURE env var.
 */
const chart = {
  width: 60, height: 40, padding: 2, autosize: 'none', background: 'white',
  data: [{ name: 't', values: [{ v: 0 }, { v: -0 }] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { signal: "1 / datum.v < 0 ? 'negative zero' : 'zero'" } } } }],
}
const base = { family: 'fixture', property: 'x' }

const FIXTURES = {
  // the chart as text, the way values.mjs carries it
  'spec-text': [{ ...base, name: 'as-text', specText: JSON.stringify(chart) }],
  // a case with neither field: nothing to render
  'no-spec': [{ ...base, name: 'as-object', spec: chart }, { ...base, name: 'nothing-at-all' }],
  // text that is not JSON
  'bad-text': [{ ...base, name: 'as-object', spec: chart }, { ...base, name: 'broken-text', specText: '{"width": ' }],
  // text that is JSON but not a chart
  'text-not-an-object': [{ ...base, name: 'a-number', specText: '7' }],
}

export function generate() {
  const name = process.env.FIXTURE ?? 'spec-text'
  const cases = FIXTURES[name]
  if (!cases) throw new Error(`unknown FIXTURE ${name}`)
  return { cases, skips: [] }
}
