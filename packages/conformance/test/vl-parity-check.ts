// @vitest-environment node
/** The check of the compiler-parity suites: one spec through vega-lite and through @aster-charts/vl, the structure, the expressions and the render compared. */
import { expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { expressionDiff } from './vl-expressions.js'
import { AXIS_STEPS, DATA_NODE_KINDS, EXPRESSION_SITES, INTERACTION, NODE_SHAPES, SIZE_TREE } from './vl-parity-structure.js'

/** Which text-layout properties the text marks encode themselves (the rest is the config's / the style's). */
const TEXT_PROPS = (vg: any): string[] => {
  const out: string[] = []
  const walk = (ms: any[]): void => {
    for (const m of ms ?? []) {
      if (m.type === 'text') for (const k of ['align', 'baseline', 'dx', 'dy']) if (m.encode?.update?.[k] !== undefined) out.push(k)
      walk(m.marks)
    }
  }
  walk(vg.marks)
  return out.sort()
}
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
export const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

export async function check(spec: Record<string, any>): Promise<void> {
  const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
  const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
  expect(plain(SIZE_TREE(ours)), 'size / layout of the compiled Vega, in every group').toEqual(plain(SIZE_TREE(oracle)))
  expect(plain(INTERACTION(ours, 'aster')), 'signals with values, bindings or handlers, and the interactive / cursor of each mark').toEqual(plain(INTERACTION(oracle, 'vega-lite')))
  expect(plain(AXIS_STEPS(ours)), 'axis tick steps').toEqual(plain(AXIS_STEPS(oracle)))
  expect(TEXT_PROPS(ours), 'text properties the marks encode').toEqual(TEXT_PROPS(oracle))
  expect(DATA_NODE_KINDS(ours), 'data-shaping transforms').toEqual(DATA_NODE_KINDS(oracle))
  expect(NODE_SHAPES(ours, 'aster'), 'what the data-shaping transforms group and compute').toEqual(NODE_SHAPES(oracle, 'vega-lite'))
  expect(EXPRESSION_SITES(ours, 'aster'), 'the kinds of site the expressions are at').toEqual(EXPRESSION_SITES(oracle, 'vega-lite'))
  const exprDiff = expressionDiff(ours, oracle)
  if (exprDiff !== '') expect.fail(`compiled expressions differ:\n${exprDiff}`)
  const [ref, mine, refChecked] = await Promise.all([renderWithVega(oracle), renderWithVegaChecked(plain(ours)), renderWithVegaChecked(oracle)])
  const inherited = new Set([...refChecked.errors, ...refChecked.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}
