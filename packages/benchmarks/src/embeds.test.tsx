/**
 * The two aster rows of the browser benchmarks must be two configurations: `aster` is string mode (`incremental={false}`), `asterDom` is
 * the incremental patcher. They were the same one (C304), so the published difference between them was noise.
 * The embed is rendered with <Chart> replaced by a probe that records the props it was given.
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const seen: Array<Record<string, unknown>> = []
vi.mock('@aster-charts/react', () => ({
  Chart: (props: Record<string, unknown>) => { seen.push(props); return null },
}))

const { BenchEmbed, ASTER_INCREMENTAL } = await import('./embeds.js')

const spec = { width: 10, height: 10, data: [{ name: 't', values: [{ v: 1 }] }], marks: [] }

describe('the aster benchmark embeds', () => {
  for (const responsive of [false, true]) {
    it(`pass different \`incremental\` values to <Chart> (${responsive ? 'responsive' : 'fixed size'})`, () => {
      const modes: Record<string, unknown> = {}
      for (const name of ['aster', 'asterDom'] as const) {
        seen.length = 0
        renderToStaticMarkup(<BenchEmbed name={name} spec={spec} width={100} height={50} responsive={responsive} />)
        expect(seen.length, name).toBe(1)
        expect('incremental' in seen[0]!, `${name} must pass incremental explicitly (the default is true)`).toBe(true)
        modes[name] = seen[0]!.incremental
      }
      expect(modes).toEqual({ aster: false, asterDom: true })
    })
  }

  it('the table of modes is what the benchmark README states', () => {
    expect(ASTER_INCREMENTAL).toEqual({ aster: false, asterDom: true })
  })
})
