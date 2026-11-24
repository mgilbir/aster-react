// @vitest-environment node
/**
 * Geo work a tiny spec multiplies is bounded, with or without `limits` (C242): a projection whose `precision` resamples every
 * segment into tens of thousands of positions, over a graticule of many lines, ran in one uninterruptible call until the address
 * space ran out. Each case runs in a child with a hard kill (attack.testkit.ts) and must be refused with an AsterLimitError
 * promptly; an ordinary map under the same settings still draws.
 */
import { describe, it, expect } from 'vitest'
import { attack, expectLimit } from './attack.testkit.js'

const T = 60_000

const amplified = (meridians: number) => ({
  width: 100, height: 100,
  projections: [{ name: 'p', type: 'orthographic', scale: 1e12, precision: 1e-9, clipAngle: 0 }],
  data: [{ name: 'g', transform: [{ type: 'graticule', extent: [[0, 0], [meridians, 80]], step: [1, 90] }] }],
  marks: [{ type: 'shape', from: { data: 'g' }, transform: [{ type: 'geoshape', projection: 'p' }] }],
})

const ordinary = {
  width: 300, height: 200,
  projections: [{ name: 'p', type: 'naturalEarth1', scale: 50, translate: [150, 100] }],
  data: [{ name: 'g', transform: [{ type: 'graticule' }] }],
  marks: [{ type: 'shape', from: { data: 'g' }, transform: [{ type: 'geoshape', projection: 'p' }] }],
}

describe('geo work a spec multiplies is bounded', () => {
  for (const [setting, limits] of [['no limits', undefined], ['maxTimeMs alone', { maxTimeMs: 200 }], ['maxMarks alone', { maxMarks: 100 }]] as const) {
    it(`resampling into millions of positions is refused (${setting})`, async () => {
      const r = await attack(`return core.renderSpec(${JSON.stringify(amplified(2000))}${limits ? `, { limits: ${JSON.stringify(limits)} }` : ''}).length`)
      expect(r.stderr).not.toMatch(/heap out of memory|FATAL/)
      expectLimit(r, /geo positions|maxTimeMs/)
      expect(r.cpuMs, `cpu ${r.cpuMs} ms`).toBeLessThan(2000)
    }, T)
    it(`an ordinary map still draws (${setting})`, async () => {
      const r = await attack(`return core.renderSpec(${JSON.stringify(ordinary)}${limits ? `, { limits: ${JSON.stringify(limits)} }` : ''}).length`)
      expect(r.threw, JSON.stringify(r.threw)).toBeNull()
      expect(r.value as number).toBeGreaterThan(10_000)
    }, T)
  }

  it('maxRows replaces the ceiling and counts the positions made', async () => {
    const r = await attack(`return core.renderSpec(${JSON.stringify(amplified(60))}, { limits: { maxRows: 100000 } }).length`)
    expectLimit(r, /maxRows .*geo positions/)
  }, T)
})
