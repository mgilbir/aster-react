/**
 * GENERATED live differential of the spherical measures (`geoBounds`, `geoArea`, `geoCentroid` with no projection) over geometry
 * holding EMPTY rings (`[]`) beside real ones (C152), against d3-geo in one process.
 *
 * d3 closes an empty ring onto the vertices and the range an earlier ring left behind, in the same call or in an EARLIER CALL, so its
 * answer for a geometry with an empty ring depends on what was measured before. Aster's does not: an empty ring adds nothing (a
 * deviation docs/ARCHITECTURE.md lists), so every measure equals d3's for the same geometry with its empty rings taken out, and it
 * never throws (the bounds threw a TypeError when the first polygon of a geometry had only empty rings).
 */
import * as d3 from 'd3-geo'
import { describe, expect, it } from 'vitest'
import { sphereArea, sphereBounds, sphereCentroid } from '../../core/src/geo-sphere-measures.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

type Ring = number[][]
type Geometry = { type: string; coordinates?: unknown; geometries?: Geometry[] } | { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; geometry: Geometry }> }

function ring(r: Rng): Ring {
  const x = r.between(-170, 150)
  const y = r.between(-70, 60)
  const w = r.between(1, 20)
  const h = r.between(1, 15)
  const pts = [[x, y], [x, y + h], [x + w, y + h], [x + w, y]]
  return r.chance(0.5) ? [...pts, [x, y]] : pts
}

/** A list of rings, real and empty, with whether an empty one comes before any real ring. */
function rings(r: Rng, n: number): Ring[] {
  return Array.from({ length: n }, () => (r.chance(0.35) ? [] : ring(r)))
}

function geometry(r: Rng, depth = 0): Geometry {
  switch (r.int(depth > 1 ? 2 : 4)) {
    case 0: return { type: 'Polygon', coordinates: rings(r, r.between(1, 3)) }
    case 1: return { type: 'MultiPolygon', coordinates: Array.from({ length: r.between(1, 3) }, () => rings(r, r.between(1, 2))) }
    case 2: return { type: 'GeometryCollection', geometries: Array.from({ length: r.between(1, 3) }, () => geometry(r, depth + 1)) }
    default: return { type: 'FeatureCollection', features: Array.from({ length: r.between(1, 3) }, () => ({ type: 'Feature', geometry: geometry(r, depth + 1) })) }
  }
}

/** Every ring in the order a measure visits them. */
function ringsOf(g: Geometry): Ring[] {
  if (g.type === 'FeatureCollection') return (g as { features: Array<{ geometry: Geometry }> }).features.flatMap((f) => ringsOf(f.geometry))
  if (g.type === 'GeometryCollection') return (g as { geometries: Geometry[] }).geometries.flatMap(ringsOf)
  if (g.type === 'Polygon') return (g as { coordinates: Ring[] }).coordinates
  return (g as { coordinates: Ring[][] }).coordinates.flat()
}

/** The geometry with its empty rings taken out (a polygon left with none taken out with them). */
function withoutEmpty(g: Geometry): Geometry {
  if (g.type === 'FeatureCollection') return { ...g, features: (g as { features: Array<{ type: 'Feature'; geometry: Geometry }> }).features.map((f) => ({ ...f, geometry: withoutEmpty(f.geometry) })) }
  if (g.type === 'GeometryCollection') return { ...g, geometries: (g as { geometries: Geometry[] }).geometries.map(withoutEmpty) }
  if (g.type === 'Polygon') {
    const kept = (g as { coordinates: Ring[] }).coordinates.filter((x) => x.length)
    return kept.length ? { type: 'Polygon', coordinates: kept } : { type: 'MultiPolygon', coordinates: [] }
  }
  return { type: 'MultiPolygon', coordinates: (g as { coordinates: Ring[][] }).coordinates.map((p) => p.filter((x) => x.length)).filter((p) => p.length) }
}

describe('spherical measures over empty rings vs d3-geo (generated, live)', () => {
  it('equal to d3 for the geometry without its empty rings, and never a throw', () => {
    const r = makeRng(0x152)
    let withEmpty = 0
    compareCases('empty rings', scaled(3000), () => {
      const g = geometry(r)
      if (ringsOf(g).some((x) => x.length === 0)) withEmpty++
      const clean = withoutEmpty(g)
      return {
        label: JSON.stringify(g),
        oracle: () => [d3.geoBounds(structuredClone(clean as never)), d3.geoArea(structuredClone(clean as never)), d3.geoCentroid(structuredClone(clean as never))],
        aster: () => [sphereBounds(structuredClone(g)), sphereArea(structuredClone(g)), sphereCentroid(structuredClone(g))],
      }
    })
    expect(withEmpty).toBeGreaterThan(scaled(3000) * 0.4)
  })
})
