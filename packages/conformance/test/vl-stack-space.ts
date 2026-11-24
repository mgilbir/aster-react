/**
 * The specs of the stacking differential (vl-stack.test.ts): every stackable (and not stackable) mark over a pair of position
 * channels drawn from a pool of unaggregated and aggregated measures, a bin, a nominal field and each stack option, with and without a
 * colour to stack by and a second position channel that ranges the mark. Each is compiled and drawn by vega-lite 6.4.3 and by Aster.
 */
export const DATA = { values: Array.from({ length: 24 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 - 3, n: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'u' : 'v', o: i % 4, b0: i % 6, b1: (i % 6) + 1 })) }
export type Case = [string, Record<string, any>]

const q = (extra: Record<string, unknown> = {}) => ({ field: 'q', type: 'quantitative', ...extra })
const n = { field: 'n', type: 'nominal' }
const DEFS: Array<[string, Record<string, unknown> | undefined]> = [
  ['none', undefined],
  ['nominal', n],
  ['measure', q()],
  ['sum', q({ aggregate: 'sum' })],
  ['count', { aggregate: 'count', type: 'quantitative' }],
  ['bin', q({ bin: true })],
  ['stack zero', q({ stack: 'zero' })],
  ['stack normalize', q({ stack: 'normalize' })],
  ['stack center', q({ stack: 'center' })],
  ['stack false', q({ stack: false })],
  ['sum, stack normalize', q({ aggregate: 'sum', stack: 'normalize' })],
]
const SECONDS: Array<[string, Record<string, unknown> | undefined]> = [['', undefined], ['second', { field: 'q2', type: 'quantitative' }]]
export const STACK_MARKS = ['bar', 'area', 'line', 'point', 'circle', 'square', 'tick', 'rule', 'text', 'rect', 'trail'] as const

/** One list of cases per mark. */
export function stackCases(mark: string): Case[] {
  const out: Case[] = []
  for (const [xn, x] of DEFS) {
    for (const [yn, y] of DEFS) {
      if (x === undefined && y === undefined) continue
      for (const colour of [false, true]) {
        for (const [sn, s] of SECONDS) {
          for (const on of s === undefined ? [undefined] : (['x2', 'y2'] as const)) {
            const encoding: Record<string, unknown> = { ...(x ? { x } : {}), ...(y ? { y } : {}), ...(colour ? { color: n } : {}) }
            if (on !== undefined) {
              if (!(on === 'x2' ? x : y)) continue
              encoding[on] = s
            }
            const mk = mark === 'text' ? { text: 'x' } : {}
            out.push([`x ${xn}, y ${yn}${colour ? ', colour' : ''}${sn ? `, ${on}` : ''}`, { data: DATA, mark: mark === 'text' ? { type: 'text', ...mk } : mark, encoding }])
          }
        }
      }
    }
  }
  return out
}
