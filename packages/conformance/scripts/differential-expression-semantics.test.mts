/**
 * LIVE differential for the reading of the expression language the engine follows (vega's code generator), on the points where it
 * differed (C32, C125, C89): the same spec runs in a real vega View and through Aster's `evaluateChart`, and the formula
 * column, the filter's rows and the signal values must agree, row by row, error for error.
 *
 *  - a regular expression literal is fresh on every evaluation, as the generated code writes it: `g` and `y` literals start
 *    each row at lastIndex 0, and an evaluation is not affected by an earlier one of the same text (the trees are cached by text);
 *  - `in` and `instanceof` are JavaScript's operators (vega-interpreter has neither; the code generator writes them as they are);
 *  - `sequence` sizes its array by the count `| 0`, as d3-array's `range` does.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/evaluate.ts'
import { datasetsOfScene } from '../../core/src/runtime.ts'

type Spec = Record<string, unknown>
type Row = Record<string, unknown>

const ROWS: Row[] = [
  { s: 'a', n: 1, arr: [1, 2], o: { k: 1 } }, { s: 'aa', n: 2, arr: [], o: {} }, { s: 'ba', n: 0, arr: [0], o: { s: 2 } },
  { s: 'b', n: 3, arr: [3, 4, 5], o: { length: 1 } }, { s: 'a', n: 4, arr: [1], o: { k: 0 } }, { s: '', n: 5, arr: [2, 2], o: { toString: 1 } },
]

/** What a value is, comparably: an error is its name. */
const show = (v: unknown): string => (v instanceof Error ? `throw ${v.name}` : JSON.stringify(v, (_k, x) => (x === undefined ? '[undef]' : x)))

async function vegaRun(spec: Spec, dataset: string | null, signal: string | null): Promise<{ rows: unknown; signal: unknown; errors: string[] }> {
  const errors: string[] = []
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  view.logger({ error: (e: unknown) => { errors.push(String((e as Error)?.name ?? e)) }, warn() {}, info() {}, debug() {}, level() { return 0 } } as never)
  try {
    await view.runAsync()
    return { rows: dataset ? view.data(dataset).map((r: Row) => ({ ...r })) : null, signal: signal ? view.signal(signal) : null, errors }
  } catch (e) {
    // (an expression that throws in a transform rejects vega's run: the evaluation failed)
    return { rows: null, signal: null, errors: [...errors, String((e as Error).name)] }
  } finally {
    view.finalize()
  }
}

function asterRun(spec: Spec, dataset: string | null, signal: string | null): { rows: unknown; signal: unknown; errors: string[] } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String((a.find((x) => x instanceof Error) as Error | undefined)?.name ?? a[0])) }, warn() {} }
  const scene = evaluateChart(compileChart(structuredClone(spec) as never), { logger } as never)
  const data = datasetsOfScene(scene) as Map<string, Row[]>
  return { rows: dataset ? (data.get(dataset) ?? []).map((r) => ({ ...r })) : null, signal: signal ? (scene as unknown as { signalParams: Record<string, unknown> }).signalParams[signal] : null, errors }
}

/** (a mark reads the dataset, so the engine evaluates it) */
const read = { marks: [{ type: 'rect', from: { data: 't' } }] }
const formulaSpec = (expr: string): Spec => ({ data: [{ name: 't', values: ROWS, transform: [{ type: 'formula', as: 'out', expr }] }], ...read })
const filterSpec = (expr: string): Spec => ({ data: [{ name: 't', values: ROWS, transform: [{ type: 'filter', expr }] }], ...read })
const signalSpec = (expr: string): Spec => ({ signals: [{ name: 'out', update: expr }] })

/** The formula column, the filter's kept rows, or the signal, as each side has it (and whether each logged an error). */
async function both(spec: Spec, dataset: string | null, signal: string | null): Promise<[unknown, unknown]> {
  const v = await vegaRun(spec, dataset, signal)
  const a = asterRun(spec, dataset, signal)
  // (a failed evaluation is compared as failed: what each side kept of it is its own business)
  const pick = (r: { rows: unknown; signal: unknown; errors: string[] }): unknown => (r.errors.length > 0 ? { failed: true } : {
    out: dataset ? (r.rows as Row[]).map((row) => show(row.out ?? row.s)) : show(r.signal), failed: false,
  })
  return [pick(a), pick(v)]
}

describe('a regular expression literal is fresh on every evaluation (C32)', () => {
  const PATTERNS = ['a', '^a', 'a$', 'b', '(?:a)']
  const FLAGS = ['', 'g', 'y', 'gy', 'gi', 'gm', 'yi']
  for (const pattern of PATTERNS) {
    for (const flags of FLAGS) {
      const expr = `test(/${pattern}/${flags}, datum.s)`
      it(`formula and filter ${expr}`, async () => {
        for (const spec of [formulaSpec(expr), filterSpec(expr)]) {
          const [aster, vg] = await both(spec, 't', null)
          expect(aster).toEqual(vg)
          // (the tree is cached by its text: a second evaluation of the same text is not affected by the first)
          const [again] = await both(spec, 't', null)
          expect(again).toEqual(vg)
        }
      })
    }
  }
  it('replace and split with a global literal row after row', async () => {
    for (const expr of ["replace(datum.s, /a/g, 'x')", "length(split(datum.s, /a/g))", "replace(datum.s, /a/y, 'x')"]) {
      const [aster, vg] = await both(formulaSpec(expr), 't', null)
      expect(aster, expr).toEqual(vg)
    }
  })
})

describe('`in` and `instanceof` are the language\'s operators (C125, DECISIONS Q7)', () => {
  const EXPRS = [
    "'s' in datum", "'zz' in datum", "datum.n in datum.arr", "0 in datum.arr",
    "'length' in datum.arr", "'k' in datum.o", "datum.s in datum.o", "'a' in datum.n", "'a' in datum.s", 'datum.s instanceof datum.n',
    "!('s' in datum) || datum.n > 2", "('k' in datum.o) ? 1 : 2",
  ]
  for (const expr of EXPRS) {
    it(`formula ${expr}`, async () => {
      const [aster, vg] = await both(formulaSpec(expr), 't', null)
      expect(aster).toEqual(vg)
    })
    it(`filter ${expr}`, async () => {
      const [aster, vg] = await both(filterSpec(expr), 't', null)
      expect(aster).toEqual(vg)
    })
  }
})

describe('`in` with a key that names an Object.prototype member', () => {
  // vega's parser crashes on these (`Operator not defined: undefined`: it rewrites a string literal naming an Object.prototype member,
  // the upstream crash ARCHITECTURE.md lists); the code generator's reading is JavaScript's `in`, which finds the inherited member
  it('is JavaScript\'s `in` (vega.parse crashes on it)', async () => {
    for (const key of ['toString', 'constructor']) {
      await expect(vegaRun(formulaSpec(`'${key}' in datum`), 't', null)).rejects.toThrow(/Operator not defined/)
      const a = asterRun(formulaSpec(`'${key}' in datum`), 't', null)
      expect(a.errors).toEqual([])
      expect((a.rows as Row[]).map((r) => r.out)).toEqual(ROWS.map(() => true))
    }
  })
})

describe('`sequence` allocates what d3-array\'s range allocates (C89, C707)', () => {
  const EXPRS = [
    'length(sequence(0, 4294967296 + 5))', 'length(sequence(4294967301))', 'length(sequence(0, 1/0))', 'length(sequence(0, 10, 0))',
    'length(sequence(0, 0/0))', 'length(sequence(0, 3e9))', 'length(sequence(0, 2147483648))', 'length(sequence(10, 0, -3))', 'sequence(1, 2, 0.25)',
  ]
  for (const expr of EXPRS) {
    it(expr, async () => {
      const [aster, vg] = await both(signalSpec(expr), null, 'out')
      expect(aster).toEqual(vg)
    })
  }
})
