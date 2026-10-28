/**
 * vega-scenegraph path/trail.js draws a trail through a d3-path buffer: the cap arcs are `arc(x, y, r, t - PI, t)` and
 * `arc(x, y, r, t, t + PI)` with `t = atan2(uy, ux)` of the NORMALISED normal vector, and the large-arc flag of each
 * `A` command is `+(da >= PI)` of that float difference -- which for a half circle is a coin the last bit of `t` tosses.
 * The picture is the same either way; the path string (and what the canonicalizer compares) is not. Trails of arbitrary
 * direction, repeated points and gaps are drawn by vega and by the engine and must agree to the last flag.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

function points(n: number, seed: number): Array<{ x: number; y: number; s: number; ok: boolean }> {
  const out: Array<{ x: number; y: number; s: number; ok: boolean }> = []
  let x = 20
  for (let i = 0; i < n; i++) {
    x += 3 + ((i * 7 + seed) % 11)
    let y = 100 + 60 * Math.sin((i + seed) * 0.37) + ((i * 13 + seed) % 9)
    if (i === 20 || i === 21) { x = out[out.length - 1]!.x; y = out[out.length - 1]!.y } // a repeated point
    out.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, s: Math.round((1 + ((i * 5) % 9) * 1.7) * 100) / 100, ok: i % 17 !== 5 })
  }
  return out
}

const spec = (seed: number, n: number): Record<string, unknown> => ({
  width: 400, height: 220, padding: 5, autosize: 'none',
  data: [{ name: 't', values: points(n, seed) }],
  marks: [
    { type: 'trail', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { field: 's' }, fill: { value: 'steelblue' } } } },
    { type: 'trail', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { signal: 'datum.y - 70' }, size: { field: 's' }, defined: { signal: 'datum.ok' }, fill: { value: 'tomato' } } } },
  ],
})

async function vegaSvg(s: Record<string, unknown>): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(s as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

describe('trail marks vs vega', () => {
  for (const seed of [0, 1, 2, 3, 5, 8, 13]) {
    it(`a trail of 60 points (seed ${seed}) has vega's path, flag for flag`, async () => {
      const s = spec(seed, 60)
      const want = await vegaSvg(structuredClone(s))
      const got = renderSpec(structuredClone(s) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
      // not vacuous: the cap arcs are there
      expect(want.match(/A[\d.]+,[\d.]+,0,[01],1,/g)?.length ?? 0).toBeGreaterThan(50)
    })
  }
})
