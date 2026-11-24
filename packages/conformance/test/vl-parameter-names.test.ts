// @vitest-environment node
/**
 * Parameter names that are not identifiers (`my-param`, `my brush`, `a.b`, `1st`, `é ü` ...), which the Vega-Lite schema allows (C83).
 * vega-lite 6.4.3 names a selection's signals and store through varName (`my brush` -> `my_brush`), and a variable or an extent
 * parameter's signal by its name as written: Vega takes any signal name, and the chart is drawn as with any other name. Every name x
 * every kind of parameter and every way a spec refers to one (a condition, a filter, a scale domain, a legend or input binding, a bound
 * scale) is drawn by vega-lite and by @aster-charts/vl through real Vega, and the bound inputs are the same signals.
 * An expression cannot name such a parameter (`my-param * 20` is a subtraction), and a selection named `datum` or `event` is
 * shadowed in the expressions vega-lite writes for it: vega-lite's output then fails in Vega, as any expression that names an
 * undeclared signal does, and so does @aster-charts/vl's, with the same messages (or it is refused).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

type Spec = Record<string, unknown>
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }
const data = { values: Array.from({ length: 8 }, (_, i) => ({ a: 'ABC'[i % 3], b: i + 2, c: (i * 5) % 7 + 1 })) }
const q = (field: string) => ({ field, type: 'quantitative' })
const n = (field: string) => ({ field, type: 'nominal' })
const NAMES = ['my-param', 'my brush', 'a.b', '1st', 'x\\y', 'é ü', 'if', 'datum', 'event', 'my_brush', 'cell']

const KINDS: Record<string, (P: string) => Spec> = {
  'a bound variable': (P) => ({ data, params: [{ name: P, value: 5, bind: { input: 'range', min: 1, max: 10 } }], mark: 'point', encoding: { x: q('b'), y: q('c') } }),
  'a variable with an expr': (P) => ({ data, params: [{ name: P, expr: '3' }], mark: 'point', encoding: { x: q('b'), y: q('c') } }),
  'an interval in a condition': (P) => ({ data, params: [{ name: P, select: 'interval' }], mark: 'point', encoding: { x: q('b'), y: q('c'), color: { condition: { param: P, field: 'a', type: 'nominal' }, value: 'grey' } } }),
  'a point bound to the legend': (P) => ({ data, params: [{ name: P, select: { type: 'point', fields: ['a'] }, bind: 'legend' }], mark: 'point', encoding: { x: q('b'), y: q('c'), color: n('a'), opacity: { condition: { param: P, value: 1 }, value: 0.2 } } }),
  'a point bound to an input': (P) => ({ data, params: [{ name: P, select: { type: 'point', fields: ['a'] }, bind: { input: 'select', options: ['A', 'B'] } }], mark: 'point', encoding: { x: q('b'), y: q('c'), opacity: { condition: { param: P, value: 1 }, value: 0.2 } } }),
  'an interval bound to the scales': (P) => ({ data, params: [{ name: P, select: 'interval', bind: 'scales' }], mark: 'point', encoding: { x: q('b'), y: q('c') } }),
  'a filter by a selection in another view': (P) => ({ data, vconcat: [{ params: [{ name: P, select: 'interval' }], mark: 'point', encoding: { x: q('b'), y: q('c') } }, { transform: [{ filter: { param: P } }], mark: 'point', encoding: { x: q('b'), y: q('c') } }] }),
  'a scale domain from a selection': (P) => ({ data, vconcat: [{ params: [{ name: P, select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: q('b'), y: q('c') } }, { mark: 'point', encoding: { x: { ...q('b'), scale: { domain: { param: P } } }, y: q('c') } }] }),
  'an extent': (P) => ({ data, transform: [{ extent: 'b', param: P }], mark: 'point', encoding: { x: q('b'), y: q('c') } }),
  'a test predicate': (P) => ({ data, params: [{ name: P, select: 'point' }], mark: 'point', encoding: { x: q('b'), y: q('c'), color: { condition: { test: { param: P, empty: false }, value: 'red' }, value: 'grey' } } }),
}

/** The names of the signals bound to an input or to the legend. */
const boundSignals = (vg: Spec): string[] => ((vg.signals ?? []) as Spec[]).filter((s) => s.bind !== undefined).map((s) => String(s.name)).sort()

/**
 * vega-lite's output fails in Vega when an expression names the parameter (or when the name is one Vega's expressions reserve, `datum`,
 * `event`, `this`): then @aster-charts/vl refuses the spec, or its output fails in Vega with the same messages. Otherwise both draw alike.
 */
async function drawsOrFailsLikeVegaLite(spec: Spec): Promise<void> {
  const ref = await renderWithVegaChecked((vl as any).compile(plain(spec), { logger: quiet }).spec)
  if (ref.errors.length === 0) {
    await drawsLikeVegaLite(spec)
    expect(boundSignals(compile(plain(spec)) as Spec)).toEqual(boundSignals((vl as any).compile(plain(spec), { logger: quiet }).spec))
    return
  }
  let ours: Spec
  try {
    ours = compile(plain(spec)) as Spec
  } catch (e) {
    expect(e).toBeInstanceOf(VLCompileError)
    return
  }
  expect((await renderWithVegaChecked(plain(ours))).errors).toEqual(ref.errors)
}

describe('a parameter whose name is not an identifier is drawn as vega-lite draws it', () => {
  for (const P of NAMES) {
    for (const [kind, make] of Object.entries(KINDS)) it(caseName(JSON.stringify(P), kind), () => drawsOrFailsLikeVegaLite(make(P)), 30_000)
    it(caseName(JSON.stringify(P), 'named in an expression'), () => drawsOrFailsLikeVegaLite({ data, params: [{ name: P, value: 5 }], mark: 'point', encoding: { x: q('b'), y: q('c'), size: { value: { expr: `${P} * 20` } } } }), 30_000)
  }
})
