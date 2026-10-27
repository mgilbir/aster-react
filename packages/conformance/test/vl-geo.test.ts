// @vitest-environment node
/**
 * Maps: the projections @aster/vl emits must be vega-lite's.
 *
 * Two differentials against vega-lite 6.4.3, both on the compile output rather than a single value:
 *  1. every `.vl.json` corpus spec (maps and not): the `projections` array, and the projection each
 *     geoshape / geopoint refers to, equal vega-lite's;
 *  2. seeded random layer trees (geoshapes, point layers, rules, texts; per-layer, per-unit and
 *     config projections; fitted and explicit scale / translate; conflicting properties that stop two
 *     layers sharing a projection): the same comparison, then the emitted Vega is rendered through real
 *     vega and must draw what vega-lite's output draws.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVegaChecked, renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { genSpec } from './vl-geo-gen.js'

const ROOT = join(__dirname, '..')

/** Dataset names differ between the compilers (and do not matter); a fit reads them only through `data('name')`. */
const normFit = (s: string): string => s.replace(/data\('[^']*'\)/g, "data('?')")

/** The projections of a compiled spec, in order, with dataset names erased. */
function projectionsOf(vg: any): unknown[] {
  return (vg.projections ?? []).map((p: any) => ({ ...p, ...(p.fit ? { fit: { signal: normFit(p.fit.signal) } } : {}) }))
}

/** [kind, projection] of every geoshape / geopoint in the tree, in document order. */
function usesOf(vg: any): string[] {
  const out: string[] = []
  const walk = (o: any): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    if ((o.type === 'geoshape' || o.type === 'geopoint') && typeof o.projection === 'string') out.push(`${o.type}:${o.projection}`)
    for (const v of Object.values(o)) walk(v)
  }
  // (document order: datasets before marks, as both compilers emit them)
  walk(vg.data)
  walk(vg.marks)
  return out
}

describe('emitted projections match vega-lite: the corpus', () => {
  for (const dir of ['corpus', 'corpus-vega-only']) {
    let files: string[] = []
    try { files = readdirSync(join(ROOT, dir)).filter((x) => x.endsWith('.vl.json')).sort() } catch { /* no such dir */ }
    for (const f of files) {
      it(`${dir}/${f.replace('.vl.json', '')}`, () => {
        const doc = JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8'))
        const spec = doc.$schema ? doc : (doc.spec ?? doc)
        const expected = (vl as any).compile(spec).spec
        const ours = compile(spec as never)
        expect(projectionsOf(ours)).toEqual(projectionsOf(expected))
        expect(usesOf(ours).sort()).toEqual(usesOf(expected).sort())
      })
    }
  }
})

const SEEDS = Array.from({ length: 120 }, (_, i) => 9001 + i * 7)

describe('emitted projections match vega-lite: random layer trees', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const spec = JSON.parse(JSON.stringify(genSpec(seed)))
      const expected = (vl as any).compile(spec).spec
      const ours = compile(JSON.parse(JSON.stringify(spec)))
      expect(projectionsOf(ours)).toEqual(projectionsOf(expected))
      expect(usesOf(ours).sort()).toEqual(usesOf(expected).sort())
    })
  }
})

describe('random layer trees draw what vega-lite draws (real vega on both)', () => {
  for (const seed of SEEDS.filter((_, i) => i % 3 === 0)) {
    it(`seed ${seed}`, async () => {
      const spec = JSON.parse(JSON.stringify(genSpec(seed)))
      const expected = (vl as any).compile(spec).spec
      const ours = JSON.parse(JSON.stringify(compile(JSON.parse(JSON.stringify(spec)))))
      const oursRun = await renderWithVegaChecked(ours)
      const oracleSvg = await renderWithVega(expected)
      expect(oursRun.errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(oursRun.svg))).toEqual([])
    })
  }
})
