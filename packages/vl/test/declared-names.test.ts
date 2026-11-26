// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { GLOBAL_NAMES, declaredSignals, readNames, refuseUndeclaredNames } from '../src/declared.js'
import { isRows } from '../src/rows.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The check as it was written before the two jobs shared one walk: the signals are collected by a walk of their own, the first time a non-global name is read. */
function reference(out: Obj): string | undefined {
  let declared: Set<string> | undefined
  let message: string | undefined
  const check = (expr: string, where: string): void => {
    if (message !== undefined) return
    for (const name of readNames(expr)) {
      if (GLOBAL_NAMES.has(name)) continue
      if (declared === undefined) declaredSignals(out, (declared = new Set<string>()))
      if (declared.has(name)) continue
      message = `${where}: the expression ${JSON.stringify(expr)} reads "${name}", which no parameter or signal declares (declare it in \`params\`)`
      return
    }
  }
  const walk = (node: unknown, path: string, inTransform: boolean): void => {
    if (message !== undefined) return
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`, inTransform)); return }
    if (!isObj(node)) return
    for (const [k, v] of Object.entries(node)) {
      const at = path === '' ? k : `${path}.${k}`
      if (typeof v === 'string') {
        if ((k === 'signal' && !inTransform) || k === 'expr' || k === 'test' || k === 'update' || k === 'init') check(v, at)
      } else if (k === 'filter' && Array.isArray(v) && typeof node.type === 'string') {
        for (const f of v) if (typeof f === 'string') check(f, at)
      } else if (k === 'value' || k === 'default' || k === 'keyvals') {
        // a literal
      } else if (v !== null && typeof v === 'object' && !isRows(v)) walk(v, at, k === 'transform')
    }
  }
  walk(out, '', false)
  return message
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

const KEYS = ['signals', 'transform', 'signal', 'expr', 'test', 'update', 'init', 'filter', 'value', 'default', 'keyvals', 'marks', 'encode', 'type', 'data', 'scales', 'layout', 'on']
const EXPRS = ['datum.x > 1', 'width * 2', 'foo + 1', 'bar', 'datum.a === "x"', 'sel ? foo : 0', 'f(x)', '{k: foo}', 'a.b + baz', 'x / 2', '"foo" + bar', '1e3 + qux', 'datum["foo"]', 'height']
const NAMES = ['foo', 'bar', 'sel', 'baz', 'x', 'qux']

function generate(rnd: () => number, depth: number): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const r = rnd()
  if (depth <= 0 || r < 0.18) return rnd() < 0.5 ? pick(EXPRS) : pick(NAMES)
  if (r < 0.4) return Array.from({ length: Math.floor(rnd() * 4) }, () => generate(rnd, depth - 1))
  const o: Obj = {}
  for (let i = 0, n = 1 + Math.floor(rnd() * 5); i < n; i++) {
    const k = pick(KEYS)
    if (k === 'signals') o[k] = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ name: pick(NAMES), value: 0 }))
    else if (k === 'type') o[k] = pick(['bin', 'filter', 'extent', 'timer'])
    else if (k === 'signal') o[k] = rnd() < 0.6 ? pick(NAMES) : generate(rnd, depth - 1)
    else o[k] = generate(rnd, depth - 1)
  }
  return o
}

describe('the check that an expression reads only declared names', () => {
  it('refuses, with the same words, the expression the two-walk version refused, and nothing else, over generated specs', () => {
    const rnd = lcg(20261126)
    let refused = 0
    for (let n = 0; n < 3000; n++) {
      const spec = generate(rnd, 4) as Obj
      if (!isObj(spec)) continue
      const want = reference(spec)
      let got: string | undefined
      try { refuseUndeclaredNames(spec) } catch (e) { got = (e as Error).message.replace(/^\[aster\/vl\] /, '') }
      expect(got, JSON.stringify(spec)).toBe(want)
      if (want !== undefined) refused++
    }
    // (the generator reaches both outcomes often enough for the comparison to mean something)
    expect(refused).toBeGreaterThan(150)
  })
})
