/**
 * Encode entries whose meaning is the code vega writes for them, against the real vega-parser (C27, C397).
 *
 * vega-parser encode/entry.js turns an entry into the TEXT of an expression and parses it. Three kinds of entry mean nothing but
 * that text, so they are generated here over every form vega's grammar takes:
 *   - a colour object, `{color: {r, g, b}}` / `{h, s, l}` / `{h, c, l}` / `{l, a, b}` (vega writes `(rgb(r,g,b)+'')`), each part an
 *     entry of any kind -- a value, a field, a signal, a scale, with modifiers, an entry with no value (written as nothing: a parse
 *     error), a bare number (the same), a part that is not there (vega's parser fails);
 *   - an `exponent`, `mult`, `offset` or `band` that is not a number or an entry: written as it is (`offset: "5"` adds 5; `"3+1"`
 *     binds as text does; `"abc"` names a signal that is not there; `"1+"` does not parse; a list is an entry with no value);
 *   - a `value` that is an object: written as the object (`{value: {signal: "1+1"}}` is that object, not 2).
 * Each case is compiled and rendered by both engines: the channel's value on every item, or the error both give, at the same
 * stage (vega's parser refuses what it cannot write: Aster's compile must, not its evaluation).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>

const PARTS: unknown[] = [
  { value: 120 }, { value: 0.5 }, { value: 0 }, { field: 'v' }, { field: 'v', mult: 20, offset: 5 }, { signal: 'sv * 2' },
  { scale: 'lin', field: 'v' }, { scale: 'band', field: 'k', band: 0.5 }, { value: 40, exponent: '2', round: true }, {}, 7, undefined, null,
]
const SPACES: Array<[string, string[]]> = [['rgb', ['r', 'g', 'b']], ['hsl', ['h', 's', 'l']], ['hcl', ['h', 'c', 'l']], ['lab', ['l', 'a', 'b']]]
const PROPS: unknown[] = ['5', '3+1', 'sv', 'datum.v', true, false, [3], {}, { signal: 'sv' }, { value: 2, offset: '1' }, 'abc', '1+', 2.5, '-2']

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function colorCase(seed: number): Spec {
  const r = stream(seed * 31 + 7)
  const [, keys] = SPACES[seed % SPACES.length]!
  const color: Record<string, unknown> = {}
  // (mostly every part there; sometimes one left out, which vega's parser fails on)
  for (const k of keys) {
    const p = PARTS[Math.floor(r() * (r() < 0.85 ? PARTS.length - 2 : PARTS.length))]
    if (p !== undefined) color[k] = p
  }
  const entry: Spec = { color }
  if (r() < 0.2) entry.signal = "'red'"
  return entry
}

function propertyCase(seed: number): Spec {
  const r = stream(seed * 131 + 3)
  const p = PROPS[seed % PROPS.length]
  const key = (['exponent', 'mult', 'offset', 'band'] as const)[Math.floor(seed / PROPS.length) % 4]!
  const entry: Spec = key === 'band' ? { scale: 'band', field: 'k' } : r() < 0.5 ? { field: 'v' } : { value: 3 }
  entry[key] = p
  if (r() < 0.3) entry.round = true
  return entry
}

const VALUES: unknown[] = [{ signal: '1+1' }, { a: 1 }, [1, 2], { field: 'v' }, 'text', 0, null]

function spec(fill: Spec, x: Spec): Spec {
  return {
    width: 100, height: 60, padding: 0, autosize: 'none',
    signals: [{ name: 'sv', value: 4 }],
    data: [{ name: 't', values: [{ v: 2, k: 'a' }, { v: 7, k: 'b' }] }],
    scales: [{ name: 'lin', type: 'linear', domain: [0, 10], range: [0, 200] }, { name: 'band', type: 'band', domain: ['a', 'b'], range: [0, 100] }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { fill, x, y: { value: 0 }, width: { value: 5 }, height: { value: 5 } } } }],
  }
}

type Outcome = { error: string } | { items: Array<[unknown, unknown]> }

async function vegaOutcome(s: Spec): Promise<Outcome> {
  let view: vega.View | undefined
  let runtime: unknown
  // (where it fails is part of the answer: vega's parser refuses a spec before any item exists)
  try { runtime = vega.parse(s as never) } catch (e) { return { error: `parse: ${(e as Error).message}` } }
  try {
    view = new vega.View(runtime as never, { renderer: 'none' })
    await view.runAsync()
    const mark = (view.scenegraph() as unknown as { root: { items: Array<{ items: Array<{ items: Array<{ fill: unknown; x: unknown }> }> }> } }).root.items[0]!.items[0]!
    return { items: mark.items.map((it) => [it.fill, it.x]) }
  } catch (e) {
    return { error: (e as Error).message }
  } finally {
    view?.finalize()
  }
}

function asterOutcome(s: Spec): Outcome {
  let chart: ReturnType<typeof compileChart>
  try { chart = compileChart(s as never) } catch (e) { return { error: `parse: ${(e as Error).message}` } }
  try {
    const scene = evaluateChart(chart, { logger: { error: (e: unknown) => { throw e }, warn() {}, info() {}, debug() {} } as never })
    const mark = scene.items[0]!
    return { items: (mark.items ?? []).map((it) => [(it as { fill?: unknown }).fill ?? null, (it as { x?: unknown }).x ?? null]) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

const same = (a: Outcome, b: Outcome): boolean => JSON.stringify(a) === JSON.stringify(b)

describe('encode entries vega writes as code (C27, C397)', () => {
  it('colour objects in every space, with every kind of part: the colour vega makes, or its parse error', async () => {
    const bad: string[] = []
    let coloured = 0
    let refused = 0
    for (let seed = 0; seed < 240; seed++) {
      const fill = colorCase(seed)
      const [want, got] = await forEngines(spec(fill, { value: 1 }), (o, a) => Promise.all([vegaOutcome(o), Promise.resolve(asterOutcome(a))]))
      if (!same(want, got)) bad.push(`${JSON.stringify(fill)}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
      if ('items' in want && want.items.some(([f]) => typeof f === 'string' && f.startsWith('rgb'))) coloured++
      if ('error' in want) refused++
    }
    expect(bad).toEqual([])
    // (not vacuous: most cases are colours, and some are vega's errors)
    expect(coloured).toBeGreaterThan(60)
    expect(refused).toBeGreaterThan(10)
  }, 60_000)

  it('exponent, mult, offset and band written as text, a list or an empty entry: the number vega makes, or its error', async () => {
    const bad: string[] = []
    const CASES = PROPS.length * 4 * 2
    for (let seed = 0; seed < CASES; seed++) {
      const x = propertyCase(seed)
      const [want, got] = await forEngines(spec({ value: 'red' }, x), (o, a) => Promise.all([vegaOutcome(o), Promise.resolve(asterOutcome(a))]))
      if (!same(want, got)) bad.push(`${JSON.stringify(x)}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
    }
    expect(bad).toEqual([])
  }, 60_000)

  it('`format` is no key of an entry: a field is its value (vega has no such key; Aster had one of its own)', async () => {
    const bad: string[] = []
    for (const x of [{ field: 'v', format: '.2f' }, { field: 'v', format: '%Y', formatType: 'time' }, { field: 'k', format: 'd' }]) {
      const [want, got] = await forEngines(spec({ value: 'red' }, x), (o, a) => Promise.all([vegaOutcome(o), Promise.resolve(asterOutcome(a))]))
      if (!same(want, got)) bad.push(`${JSON.stringify(x)}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
    }
    expect(bad).toEqual([])
  })

  it('a value that is an object is that object', async () => {
    const bad: string[] = []
    for (const v of VALUES) {
      const [want, got] = await forEngines(spec({ value: 'red' }, { value: v }), (o, a) => Promise.all([vegaOutcome(o), Promise.resolve(asterOutcome(a))]))
      if (!same(want, got)) bad.push(`${JSON.stringify(v)}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
    }
    expect(bad).toEqual([])
  })
})
