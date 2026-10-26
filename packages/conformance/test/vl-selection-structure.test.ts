// @vitest-environment node
/**
 * What @aster/vl emits for selections is vega-lite's own output, piece by piece: the store datasets, every signal
 * (with its handlers, in vega-lite's order), the brush and voronoi marks, the `interactive` / `clip` / cursor of the
 * marks, the scales' `domainRaw` and the legends' interactive encodes. The corpus tests prove the two Vega specs
 * RENDER alike; this one proves the interaction wiring (which a static render cannot show) is the same text.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'

const ROOT = join(__dirname, '..', 'corpus')
const specs = readdirSync(ROOT)
  .filter((f) => f.endsWith('.vl.json') && (f.startsWith('vlx-sel-') || f === 'select-interval.vl.json'))
  .sort()
  .map((f) => [f.replace('.vl.json', ''), JSON.parse(readFileSync(join(ROOT, f), 'utf8'))] as const)

const signalsOf = (s: any): Array<[string, unknown]> => (s.signals ?? []).map((x: any) => [x.name, x])
const storesOf = (s: any): unknown[] => (s.data ?? []).filter((d: any) => /_store$/.test(d.name))
const marksOf = (s: any): unknown[] =>
  (s.marks ?? []).map((m: any) => ({
    name: m.name, type: m.type, interactive: m.interactive, clip: m.clip, cursor: m.encode?.update?.cursor,
    encode: /brush|voronoi/.test(m.name) ? m.encode : undefined, transform: m.transform,
  }))
const scalesOf = (s: any): unknown[] => (s.scales ?? []).map((m: any) => ({ name: m.name, domainRaw: m.domainRaw }))
const legendsOf = (s: any): unknown[] => (s.legends ?? []).map((l: any) => l.encode)

describe('selection output is vega-lite\'s output', () => {
  it('covers the whole corpus of selection specs', () => {
    expect(specs.length).toBeGreaterThanOrEqual(50)
  })
  for (const [name, spec] of specs) {
    it(name, () => {
      const want = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
      const got = compile(JSON.parse(JSON.stringify(spec))) as any
      expect(signalsOf(got).map(([n]) => n), 'signal names, in order').toEqual(signalsOf(want).map(([n]) => n))
      expect(signalsOf(got)).toEqual(signalsOf(want))
      expect(storesOf(got)).toEqual(storesOf(want))
      expect(marksOf(got)).toEqual(marksOf(want))
      expect(scalesOf(got)).toEqual(scalesOf(want))
      expect(legendsOf(got)).toEqual(legendsOf(want))
    })
  }
})
