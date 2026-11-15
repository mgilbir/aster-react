// @vitest-environment node
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

// Whether a view's datasets may draw from a random source the host injected is a question about their code (transforms, a
// `{signal}` values), never about their rows: rows draw nothing, whatever their strings spell. So with `input.random` the work an
// evaluation does -- here, the reads of a row field its formula uses -- does not depend on what the rows say, and the scan does not
// read the rows at all.
describe('rows never make a dataset look like it draws random numbers', () => {
  const run = (word: string, random: boolean): { reads: number; svg: string } => {
    let reads = 0
    const values = Array.from({ length: 20 }, (_, i) => {
      const r: Record<string, unknown> = { k: i === 3 ? word : 'v', [word === 'key' ? 'sampleNormal' : 'other']: 1 }
      Object.defineProperty(r, 'x', { enumerable: true, get: () => { reads++; return i } })
      return r
    })
    const spec = {
      autosize: { type: 'fit', contains: 'padding' }, width: 200, height: 100,
      data: [{ name: 't', values, transform: [{ type: 'formula', expr: 'datum.x * 2', as: 'y' }] }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'y' }, range: 'width' }],
      axes: [{ scale: 'x', orient: 'bottom' }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'y' }, width: { value: 2 }, y: { value: 0 }, height: { value: 5 } } } }],
    } as unknown as VgSpec
    let s = 1
    const source = (): number => (s = (s * 16807) % 2147483647) / 2147483647
    return { svg: renderSpec(spec, random ? { random: source } : {}) as string, reads }
  }

  it('the same reads and the same chart whether a row spells random, sample, ci0 or an add-on function, or nothing', () => {
    const plain = run('v', true)
    const noSource = run('v', false)
    expect(plain.reads).toBe(noSource.reads)
    expect(plain.svg).toBe(noSource.svg)
    for (const word of ['random', 'sample', 'sampleNormal', 'ci0', 'wordcloud', 'key']) {
      const r = run(word, true)
      expect(r.reads, word).toBe(plain.reads)
      expect(r.svg, word).toBe(plain.svg)
    }
  })
})
