/**
 * The recorded oracle vectors (packages/core/testdata/vectors, written by gen-vectors.mjs) say what they are named (C445):
 *  - the value codec keeps every Date, an invalid one included (its time is NaN, which JSON writes as null: an invalid Date
 *    was replayed as the epoch, so `isDate(new Date('not a date'))` was checked as `isDate(new Date(0))`);
 *  - the topojson mesh vectors named `interior` hold the arcs two geometries share, and the `exterior` ones the arcs one geometry
 *    has alone, each recomputed here from the real topojson-client.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as topojson from 'topojson-client'
import { dec, enc } from './vector-codec.mjs'

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'testdata', 'vectors')
const load = (f: string): { suites: Record<string, { cases: Array<{ args: unknown[]; want: unknown; variant?: string }> }> } =>
  JSON.parse(readFileSync(join(VECTORS, f), 'utf8'))
const roundTrip = (v: unknown): unknown => dec(JSON.parse(JSON.stringify(enc(v))))

describe('the vector codec', () => {
  it('round-trips dates through JSON, invalid ones included', () => {
    for (const d of [new Date(0), new Date(-1), new Date(8.64e15), new Date(-8.64e15), new Date(Date.UTC(2024, 1, 29, 12)), new Date('not a date'), new Date(NaN)]) {
      const back = roundTrip(d) as Date
      expect(back).toBeInstanceOf(Date)
      expect(Object.is(back.getTime(), d.getTime()), `${d.getTime()} -> ${back.getTime()}`).toBe(true)
    }
    expect(roundTrip([new Date('x'), { d: new Date('y') }])).toEqual([new Date(NaN), { d: new Date(NaN) }])
  })

  it('round-trips the numbers JSON cannot write', () => {
    for (const n of [NaN, Infinity, -Infinity, -0, 0, 1.5]) expect(Object.is(roundTrip(n), n), String(n)).toBe(true)
  })

  it('no recorded Date lost its time (null), and the invalid Date of isDate is recorded as one', () => {
    for (const f of ['vega-util.json', 'vega-time.json', 'd3-dsv.json', 'vega-format.json', 'd3-format.json', 'd3-color.json', 'topojson-client.json']) {
      expect(readFileSync(join(VECTORS, f), 'utf8'), f).not.toMatch(/"\$": "date",\s*"ms": null/)
    }
    const isDate = load('vega-util.json').suites.isDate!.cases.map((c) => dec(c.args[0]))
    expect(isDate.some((d) => d instanceof Date && Number.isNaN(d.getTime())), 'isDate is checked on an invalid Date').toBe(true)
  })
})

describe('the topojson mesh vectors are the meshes they are named', () => {
  const topo = load('topojson-client.json').suites
  const filters: Record<string, ((a: unknown, b: unknown) => boolean) | undefined> = {
    interior: (a, b) => a !== b,
    exterior: (a, b) => a === b,
    any: undefined,
    byName: (a, b) => (a as { properties?: { name?: string } }).properties?.name === (b as { properties?: { name?: string } }).properties?.name,
  }
  const recompute = (c: { args: unknown[]; variant?: string }): unknown => {
    const [t, name] = c.args.map(dec) as [{ objects: Record<string, never> }, string]
    return enc(topojson.mesh(t as never, t.objects[name], filters[c.variant!] as never))
  }

  it('every filtered mesh equals topojson-client with the filter its name says', () => {
    for (const c of topo.topoMeshFiltered!.cases) expect(c.want, `topoMeshFiltered ${c.variant}`).toEqual(recompute(c))
  })

  it('the interior and the outer mesh of the squares are recorded, and differ', () => {
    const interior = topo.topoMeshFiltered!.cases.find((c) => c.variant === 'interior')
    // (a29's recording holds the outer mesh as the `exterior` cases of the same suite, not as a suite of its own)
    const outer = topo.topoMeshFiltered!.cases.find((c) => c.variant === 'exterior')
    expect(interior).toBeDefined()
    expect(outer).toBeDefined()
    expect(interior!.want).not.toEqual(outer!.want)
  })
})
