/**
 * LIVE generated differential for TopoJSON decoding (topojson-client 3.1.0): `feature` and `mesh` over random
 * topologies (quantized or not, every geometry type, nested collections, shared and reversed arcs, arcs too short to
 * be valid) and over the two real topologies that ship with vega-datasets (us-10m, world-110m), including
 * the border and outline filters the Vega-Lite and Vega examples use. Output is compared deep (-0 and NaN told apart)
 * AND by key order, i.e. the serialized form must be identical; a malformed topology must fail on both sides.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import * as upstream from 'topojson-client'
import { feature, mesh } from '../../core/src/topojson.ts'
import { enc } from './differential-util.mts'
import { seeded } from './upstream.mts'

// generated differentials are heavy; a loaded machine must not turn them into timeouts
vi.setConfig({ testTimeout: 120_000 })

type Topology = any
type Filter = (a: unknown, b: unknown) => boolean

function image(f: () => unknown): unknown {
  try {
    const v = f()
    return { value: enc(v), text: JSON.stringify(v) }
  } catch {
    // the text of a TypeError depends on how the failing access was written, not on the format
    return { threw: true }
  }
}

function randomTopology(r: ReturnType<typeof seeded>): Topology {
  const arcCount = 1 + r.int(7)
  const arcs = Array.from({ length: arcCount }, () => Array.from({ length: r.int(5) }, () => [r.int(20) - 5, r.int(20) - 5]))
  const quantized = r.int(2) === 0
  const arcRef = (): number => { const k = r.int(arcCount); return r.int(2) ? k : ~k }
  const ring = (): number[] => Array.from({ length: 1 + r.int(3) }, arcRef)
  const geometry = (depth = 0): any => {
    const type = r.pick(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection', null])
    const extra = r.int(5) === 0 ? { id: r.int(100), properties: { k: r.int(9) } } : r.int(8) === 0 ? { bbox: [0, 1, 2, 3] } : {}
    switch (type) {
      case 'Point': return { type, coordinates: [r.int(9), r.int(9)], ...extra }
      case 'MultiPoint': return { type, coordinates: [[r.int(9), r.int(9)], [r.int(9), r.int(9), 5]], ...extra }
      case 'LineString': return { type, arcs: ring(), ...extra }
      case 'MultiLineString': return { type, arcs: [ring(), ring()], ...extra }
      case 'Polygon': return { type, arcs: [ring(), ring()].slice(0, 1 + r.int(2)), ...extra }
      case 'MultiPolygon': return { type, arcs: [[ring()], [ring(), ring()]], ...extra }
      case 'GeometryCollection': return { type, geometries: depth > 1 ? [] : [geometry(depth + 1), geometry(depth + 1)], ...extra }
      default: return { type: null }
    }
  }
  const topology: Topology = {
    type: 'Topology',
    arcs,
    objects: { a: { type: 'GeometryCollection', geometries: Array.from({ length: 1 + r.int(4) }, () => geometry(1)) }, b: geometry() },
  }
  if (quantized) topology.transform = { scale: [r.pick([0.5, 1, 0.1]), r.pick([2, 1, 0.3])], translate: [r.pick([1, 0, -180]), r.pick([-1, 0, 90])] }
  if (r.int(3) === 0) topology.bbox = [0, 0, 1, 1]
  return topology
}

const FILTERS: Array<[string, Filter | undefined]> = [
  ['no filter', undefined],
  ['borders', (a, b) => a !== b],
  ['outline', (a, b) => a === b],
  ['first only', (a) => (a as { id?: number }).id === undefined],
]

describe('topojson feature and mesh vs topojson-client (generated)', () => {
  it('agree on every random topology', () => {
    const r = seeded(12345)
    let ok = 0
    let failed = 0
    for (let i = 0; i < 3000; i++) {
      const t = JSON.parse(JSON.stringify(randomTopology(r)))
      const probes: Array<[string, () => unknown, () => unknown]> = [
        ['feature a', () => upstream.feature(t, t.objects.a), () => feature(t, t.objects.a)],
        ['feature b', () => upstream.feature(t, t.objects.b), () => feature(t, t.objects.b)],
        ['feature by name', () => upstream.feature(t, t.objects.a), () => feature(t, 'a')],
        ['mesh all', () => upstream.mesh(t), () => mesh(t)],
        ...FILTERS.flatMap(([name, filter]): Array<[string, () => unknown, () => unknown]> => [
          [`mesh a ${name}`, () => upstream.mesh(t, t.objects.a, filter), () => mesh(t, t.objects.a, filter)],
          [`mesh b ${name}`, () => upstream.mesh(t, t.objects.b, filter), () => mesh(t, t.objects.b, filter)],
          [`mesh by name ${name}`, () => upstream.mesh(t, t.objects.a, filter), () => mesh(t, 'a', filter)],
        ]),
      ]
      for (const [name, want, got] of probes) {
        const w = image(want)
        expect(image(got), `${name} ${JSON.stringify(t)}`).toEqual(w)
        if ('threw' in (w as object)) failed++
        else ok++
      }
    }
    // both outcomes are exercised: valid decodes (the bulk) and malformed topologies refused alike
    expect(ok).toBeGreaterThan(20000)
    expect(failed).toBeGreaterThan(50)
  })

  it('does not change the topology it decodes', () => {
    const r = seeded(99)
    for (let i = 0; i < 300; i++) {
      const t = randomTopology(r)
      const before = JSON.stringify(t)
      try { mesh(t, t.objects.a, (a, b) => a !== b); feature(t, t.objects.a); mesh(t) } catch { /* malformed */ }
      expect(JSON.stringify(t)).toBe(before)
    }
  })
})

describe('topojson feature and mesh vs topojson-client (real topologies)', () => {
  const dir = fileURLToPath(new URL('../node_modules/vega-datasets/data/', import.meta.url))
  for (const file of ['us-10m.json', 'world-110m.json']) {
    const topology: Topology = JSON.parse(readFileSync(dir + file, 'utf8'))
    for (const name of Object.keys(topology.objects)) {
      const object = topology.objects[name]
      it(`${file} / ${name}`, () => {
        expect(image(() => feature(topology, object))).toEqual(image(() => upstream.feature(topology, object)))
        expect(image(() => feature(topology, name))).toEqual(image(() => upstream.feature(topology, object)))
        for (const [filterName, filter] of FILTERS) {
          expect(image(() => mesh(topology, object, filter)), filterName).toEqual(image(() => upstream.mesh(topology, object, filter)))
        }
        expect(image(() => mesh(topology))).toEqual(image(() => upstream.mesh(topology)))
      })
    }
    it(`${file}: the objects are non-trivial`, () => {
      const f = feature(topology, Object.keys(topology.objects)[0]!) as { features?: unknown[] } & Record<string, unknown>
      expect(JSON.stringify(f).length).toBeGreaterThan(10000)
    })
  }
})
