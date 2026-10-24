/**
 * The structural half of vega-parser, replayed against the pinned oracle (audit C80).
 *
 * vega-parser reads every scope list through vega-util `array()` (a lone object is the one-element
 * list, null is empty) and `Scope.getData` throws `Undefined data set name: "<name>"` for a data set
 * that is not declared in the scope chain, before any view exists. Each case runs through
 * `vega.parse` and through the engine: they must agree on whether the spec is refused, on the
 * message, and (when it renders) on the picture. The limits pre-flight must agree with the runtime
 * about what the spec contains.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import { AsterLimitError, checkSpecLimits, compileChart, renderSpec, SpecParseError } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<{ svg: string } | { error: string }> {
  try {
    const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
      vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
    try {
      await view.runAsync()
      return { svg: await view.toSVG() }
    } finally { view.finalize() }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function engine(spec: Spec): { svg: string } | { error: string; name: string } {
  try { return { svg: renderSpec(spec as never, { logger: { error: () => {}, warn: () => {} } }) } } catch (e) {
    return { error: (e as Error).message, name: (e as Error).name }
  }
}

const rect = (from?: unknown, extra: Spec = {}): Spec => ({
  type: 'rect', ...(from === undefined ? {} : { from }), ...extra,
  encode: { update: { x: { value: 4 }, y: { value: 6 }, width: { value: 20 }, height: { value: 10 }, fill: { value: '#c33' } } },
})
const frame = (more: Spec): Spec => ({ width: 120, height: 80, padding: 5, autosize: 'none', ...more })
const T = { name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 9 }] }

const REFUSED: Array<[string, Spec]> = [
  ['README-style: unnamed data object, scale and mark over data0', frame({
    data: { values: [{ a: 'A', b: 28 }] },
    scales: [{ name: 'x', type: 'band', domain: { data: 'data0', field: 'a' }, range: 'width' }],
    marks: [rect({ data: 'data0' })],
  })],
  ['the same with the array form (unnamed data set is still unnamed)', frame({
    data: [{ values: [{ a: 'A', b: 28 }] }],
    scales: [{ name: 'x', type: 'band', domain: { data: 'data0', field: 'a' }, range: 'width' }],
    marks: [rect({ data: 'data0' })],
  })],
  ['mark from an undeclared data set', frame({ marks: [rect({ data: 'nope' })] })],
  ['mark from nothing named', frame({ marks: [rect({})] })],
  ['facet over an undeclared data set', frame({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'nope', groupby: 'k' } }, marks: [rect({ data: 'f' })] }] })],
  ['scale domain over an undeclared data set', frame({ scales: [{ name: 's', type: 'linear', domain: { data: 'nope', field: 'a' }, range: [0, 1] }] })],
  ['scale domain fields over an undeclared data set', frame({ scales: [{ name: 's', type: 'linear', domain: { fields: [{ data: 'nope', field: 'a' }] }, range: [0, 1] }] })],
  ['scale domain fields (strings) over an undeclared data set', frame({ scales: [{ name: 's', type: 'ordinal', domain: { data: 'nope', fields: ['a'] }, range: [0, 1] }] })],
  ['derived data set from an undeclared source', frame({ data: [{ name: 'd', source: 'nope' }] })],
  ['derived data set from one declared LATER', frame({ data: [{ name: 'd', source: 'e' }, { name: 'e', values: [{ a: 1 }] }], marks: [rect({ data: 'd' })] })],
  ['lookup into an undeclared data set', frame({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'lookup', from: 'nope', key: 'a', fields: ['a'], as: ['b'] }] }] })],
  ['a data set cannot look itself up', frame({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'lookup', from: 'd', key: 'a', fields: ['a'], as: ['b'] }] }] })],
  ['a named mark used before it is declared', frame({ marks: [rect({ data: 'm1' }), rect(undefined, { name: 'm1' })] })],
  ['a group data set used outside its group', frame({ marks: [{ type: 'group', data: [{ name: 'g', values: [{ a: 1 }] }] }, rect({ data: 'g' })] })],
  ['a facet name used outside its group', frame({ data: [T], marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } } }, rect({ data: 'f' })] })],
  ['a nested group data set used by a sibling group', frame({ marks: [
    { type: 'group', data: [{ name: 'g', values: [{ a: 1 }] }], marks: [rect({ data: 'g' })] },
    { type: 'group', marks: [rect({ data: 'g' })] },
  ] })],
  ['label avoidMarks naming an undeclared mark', frame({ marks: [{ ...rect(undefined, { name: 'a' }), type: 'text' }, { type: 'text', transform: [{ type: 'label', avoidMarks: ['nope'], size: { signal: '[10,10]' } }] }] })],
]

const RENDERED: Array<[string, Spec]> = [
  ['data as a lone object', frame({ data: T, marks: [rect({ data: 't' })] })],
  ['data as a lone unnamed object, no reference', frame({ data: { values: [{ a: 1 }] }, marks: [rect()] })],
  ['an unnamed data set makes `from: {}` resolve (vega keys data sets by String(name))', frame({ data: { values: [{ a: 1 }] }, marks: [rect({})] })],
  ['data: null', frame({ data: null, marks: [rect()] })],
  ['data: a string', frame({ data: 'x', marks: [rect()] })],
  ['data: a number', frame({ data: 5, marks: [rect()] })],
  ['marks as a lone object', frame({ data: [T], marks: rect({ data: 't' }) })],
  ['marks: null', frame({ marks: null })],
  ['scales and marks as lone objects',
    frame({ data: [T], scales: { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }, marks: rect({ data: 't' }) })],
  ['axes and legends as lone objects',
    frame({ data: [T], scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }], axes: { scale: 'x', orient: 'bottom' }, marks: [rect({ data: 't' })] })],
  ['signals and projections as lone objects',
    frame({ signals: { name: 'w', value: 5 }, projections: { name: 'p', type: 'mercator' }, marks: [rect()] })],
  ['a group with lone-object lists',
    frame({ marks: { type: 'group', data: { name: 'g', values: [{ a: 1 }] }, scales: { name: 's', type: 'linear', domain: { data: 'g', field: 'a' }, range: [0, 10] }, marks: rect({ data: 'g' }) } })],
  ['a group data set used inside its group, and a facet name inside its facet', frame({ data: [T], marks: [
    { type: 'group', data: [{ name: 'g', values: [{ a: 1 }] }], marks: [rect({ data: 'g' })] },
    { type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } }, marks: [rect({ data: 'f' })] },
  ] })],
  ['a derived data set from an earlier one', frame({ data: [T, { name: 'd', source: 't', transform: [{ type: 'filter', expr: 'datum.v > 5' }] }], marks: [rect({ data: 'd' })] })],
  ['a lookup into an earlier data set', frame({ data: [T, { name: 'u', values: [{ k: 'a' }], transform: [{ type: 'lookup', from: 't', key: 'k', fields: ['k'], as: ['hit'] }] }], marks: [rect({ data: 'u' })] })],
]

describe('vega-parser refuses a spec that uses a data set it never declared', () => {
  for (const [name, spec] of REFUSED) {
    it(name, async () => {
      const want = await oracle(spec)
      expect(want).toHaveProperty('error')
      const got = engine(spec)
      expect(got).toHaveProperty('error')
      expect((got as { name: string }).name).toBe('SpecParseError')
      expect((got as { error: string }).error).toBe((want as { error: string }).error)
      // the limits pre-flight does not have to refuse it; compileChart is the single place that does
      expect(() => compileChart(spec as never)).toThrow(SpecParseError)
    })
  }
})

describe('vega-util array(): scope lists given as a lone object, null or a scalar', () => {
  for (const [name, spec] of RENDERED) {
    it(name, async () => {
      const want = await oracle(spec)
      expect(want).toHaveProperty('svg')
      const got = engine(spec)
      expect(got).toHaveProperty('svg')
      expect(diffCanonical(canonicalizeSvg((got as { svg: string }).svg), canonicalizeSvg((want as { svg: string }).svg))).toEqual([])
    })
  }
})

describe('a named mark is a data set for the marks after it', () => {
  // Only the scoping is pinned here (accepted after, refused before: see REFUSED); what a mark draws over the
  // items of another mark is a separate piece of runtime behaviour.
  it('accepted by vega.parse and by the engine when it is declared first', async () => {
    const spec = frame({ marks: [rect(undefined, { name: 'm1' }), rect({ data: 'm1' })] })
    expect(await oracle(spec)).toHaveProperty('svg')
    expect(engine(spec)).toHaveProperty('svg')
  })
})

describe('the limits pre-flight agrees with the runtime about what the spec contains', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: 'a', v: i }))
  const forms: Array<[string, (n: number) => Spec]> = [
    ['data as a lone object', (n) => frame({ data: { name: 't', values: rows(n) }, marks: [rect({ data: 't' })] })],
    ['data as an array', (n) => frame({ data: [{ name: 't', values: rows(n) }], marks: [rect({ data: 't' })] })],
    ['group data as a lone object inside lone-object marks', (n) => frame({ marks: { type: 'group', data: { name: 't', values: rows(n) }, marks: rect({ data: 't' }) } })],
  ]
  for (const [name, make] of forms) {
    it(`${name}: maxRows is enforced by checkSpecLimits AND by renderSpec`, () => {
      expect(() => checkSpecLimits(make(50) as never, { maxRows: 10 })).toThrow(AsterLimitError)
      expect(() => renderSpec(make(50) as never, { limits: { maxRows: 10 } })).toThrow(AsterLimitError)
      expect(() => checkSpecLimits(make(5) as never, { maxRows: 10 })).not.toThrow()
      expect(() => renderSpec(make(5) as never, { limits: { maxRows: 10 } })).not.toThrow()
    })
  }

  it('maxMarks counts marks given as a lone object, nested ones too', () => {
    const spec = frame({ marks: { type: 'group', marks: [rect(), rect(), rect()] } })
    expect(() => checkSpecLimits(spec as never, { maxMarks: 2 })).toThrow(AsterLimitError)
    expect(() => renderSpec(spec as never, { limits: { maxMarks: 2 } })).toThrow(AsterLimitError)
    expect(() => checkSpecLimits(spec as never, { maxMarks: 4 })).not.toThrow()
  })
})

describe('the README minimal example', () => {
  it('runs as written, and vega draws the same picture', async () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const block = /### Minimal Example\s+```ts\n([\s\S]*?)```/.exec(readme)?.[1]
    expect(block).toBeTruthy()
    const body = block!.replace(/^import .*$/m, '')
    const run = new Function('renderSpec', `${body}\nreturn { spec, svg }`) as (r: typeof renderSpec) => { spec: Spec; svg: string }
    const { spec, svg } = run(renderSpec)
    expect(svg.startsWith('<svg')).toBe(true)
    const want = await oracle(spec)
    expect(want).toHaveProperty('svg')
    expect(diffCanonical(canonicalizeSvg(svg), canonicalizeSvg((want as { svg: string }).svg))).toEqual([])
  })
})
