// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { compileFrozen, objects } from './helpers.js'

const CONFORMANCE = join(__dirname, '..', '..', 'conformance')
const SYMBOLS = new Set(['circle', 'square', 'cross', 'diamond', 'triangle', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'stroke', 'arrow', 'wedge'])
const corpus: Array<[string, any]> = []
for (const dir of ['corpus', 'corpus-vega-only']) {
  const d = join(CONFORMANCE, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d).filter((x) => x.endsWith('.vl.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), 'utf8'))
    corpus.push([f.replace('.vl.json', ''), doc.$schema ? doc : (doc.spec ?? doc)])
  }
}

describe('symbol marks and legends never carry a shape Vega cannot draw', () => {
  for (const [name, spec] of corpus) {
    it(name, () => {
      const vg = compileFrozen(spec)
      for (const o of objects(vg)) {
        const shape = o.encode?.update?.shape
        for (const s of Array.isArray(shape) ? shape : [shape]) {
          if (s && typeof s.value === 'string') expect(SYMBOLS.has(s.value) || /^[Mm]/.test(s.value), `${name}: shape ${s.value}`).toBe(true)
        }
        if (typeof o.symbolType === 'string') expect(SYMBOLS.has(o.symbolType) || /^[Mm]/.test(o.symbolType), `${name}: symbolType ${o.symbolType}`).toBe(true)
      }
    })
  }
  it('a point mark keeps the default shape', () => {
    const vg = compileFrozen({ data: { values: [{ x: 1, y: 2 }] }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } })
    expect(vg.marks[0].encode.update.shape).toBeUndefined()
  })
})
