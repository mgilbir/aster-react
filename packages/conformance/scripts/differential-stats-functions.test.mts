/**
 * LIVE differential for the distribution functions of the expression language (vega-statistics 2.0.0 through
 * vega-functions): `density*`, `cumulative*`, `quantile*` and `sample*` for the normal, log-normal and uniform
 * distributions. Real vega evaluates each as a signal expression; Aster runs `compileExpr` after the transforms
 * addon registered the functions. The results are compared with the strict `exact` image (NaN, -0, undefined are
 * distinct). `sample*` draw from a seeded generator on both sides, so the same numbers go through both.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '../../core/src/addon-transforms.ts'
import { compileExpr, type ExpressionRuntime } from '../../core/src/expression.ts'
import { exact, quietLogger } from './differential-util.mts'

const runtime: ExpressionRuntime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}
const NAMES = ['a', 'b', 'c'] as const

async function viaVega(code: string, args: unknown[]): Promise<unknown> {
  const errors: unknown[][] = []
  const view = new vega.View(
    vega.parse({ signals: [...NAMES.map((name) => ({ name, value: null })), { name: 'out', update: code }] } as never),
    { logger: quietLogger(errors) as never },
  )
  args.forEach((v, i) => view.signal(NAMES[i]!, v))
  await view.runAsync()
  return errors.length ? { $: 'throw' } : exact(() => view.signal('out'))
}
function viaAster(code: string, args: unknown[]): unknown {
  const params: Record<string, unknown> = {}
  args.forEach((v, i) => { params[NAMES[i]!] = v })
  const got = exact(() => compileExpr(code, runtime)(undefined, params)) as { $?: string } | null
  return got?.$ === 'throw' ? { $: 'throw' } : got
}
const call = (fn: string, n: number) => `${fn}(${NAMES.slice(0, n).join(', ')})`

/** mulberry32: the same stream for both sides. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const XS: unknown[] = [0, 0.5, 1, -1, 2.5, 1e-9, 7.5, 40, -40, 0.999999, 1.000001, NaN, Infinity, -Infinity, null, undefined, '0.3', true, [], {}]
const PS: unknown[] = [0, 1, 0.5, 0.025, 0.975, 0.9999999, 1e-12, -0.1, 1.1, NaN, null, undefined, '0.2', Infinity]
const PARAMS: unknown[][] = [[], [0], [1], [0, 1], [2, 0.5], [null, null], [undefined, 3], [-3, 2], [0, 0], ['1', '2'], [5, 1], [NaN], [1, NaN], [3, 1.5]]
const UNIFORM_PARAMS: unknown[][] = [[], [0], [5], [0, 1], [2, 6], [6, 2], [null, null], [undefined, 3], [-3, 2], [0, 0], [2, 2], ['1', '3'], [NaN]]

describe('distribution functions vs real vega (live)', () => {
  for (const dist of ['Normal', 'LogNormal']) {
    for (const kind of ['density', 'cumulative']) {
      it(`${kind}${dist}`, async () => {
        for (const x of XS) for (const ps of PARAMS) {
          const args = [x, ...ps]
          const code = call(`${kind}${dist}`, args.length)
          expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
        }
      })
    }
    it(`quantile${dist}`, async () => {
      for (const p of PS) for (const ps of PARAMS) {
        const args = [p, ...ps]
        const code = call(`quantile${dist}`, args.length)
        expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
      }
    })
  }
  for (const kind of ['density', 'cumulative']) {
    it(`${kind}Uniform`, async () => {
      for (const x of XS) for (const ps of UNIFORM_PARAMS) {
        const args = [x, ...ps]
        const code = call(`${kind}Uniform`, args.length)
        expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
      }
    })
  }
  it('quantileUniform', async () => {
    for (const p of PS) for (const ps of UNIFORM_PARAMS) {
      const args = [p, ...ps]
      const code = call('quantileUniform', args.length)
      expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
    }
  })
  it('the quantile of a cumulative is the value, over a grid (the functions are mutually consistent in Aster too)', () => {
    for (let p = 0.01; p < 1; p += 0.01) {
      const q = compileExpr('quantileNormal(a, 3, 2)', runtime)(undefined, { a: p }) as number
      const back = compileExpr('cumulativeNormal(a, 3, 2)', runtime)(undefined, { a: q }) as number
      expect(Math.abs(back - p)).toBeLessThan(1e-6)
    }
  })
  for (const fn of ['sampleNormal', 'sampleLogNormal', 'sampleUniform']) {
    it(fn, async () => {
      const argSets: unknown[][] = fn === 'sampleUniform' ? UNIFORM_PARAMS : PARAMS
      const prev = Math.random;
      (vega as unknown as { setRandom(r: () => number): void }).setRandom(seeded(7))
      Math.random = seeded(7)
      try {
        for (let round = 0; round < 3; round++) for (const args of argSets) {
          const code = call(fn, args.length)
          // (each side draws from its own stream; both started from the same seed and are called in lockstep)
          const want = await viaVega(code, args)
          expect(viaAster(code, args), `${fn} ${JSON.stringify(args)}`).toEqual(want)
        }
      } finally {
        Math.random = prev;
        (vega as unknown as { setRandom(r: () => number): void }).setRandom(prev)
      }
    })
  }
})
