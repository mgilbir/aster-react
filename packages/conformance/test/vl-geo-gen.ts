/**
 * Seeded random Vega-Lite layer trees of maps (geoshapes, point layers, rules, texts; per-layer,
 * per-unit and config projections; fitted and explicit scale / translate; conflicting properties that
 * stop two layers sharing a projection), for the vl-geo differentials.
 */

// --- random layer trees -------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const REGIONS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'a', v: 3 }, geometry: { type: 'Polygon', coordinates: [[[-10, 35], [-11, 48], [9, 50], [10, 36], [-10, 35]]] } },
    { type: 'Feature', properties: { name: 'b', v: 7 }, geometry: { type: 'Polygon', coordinates: [[[10, 36], [9, 50], [31, 50], [30, 38], [10, 36]]] } },
  ],
}
const POINTS = [
  { lon: -5, lat: 40, n: 3, c: 'x', lon2: 12, lat2: 44 },
  { lon: 20, lat: 45, n: 8, c: 'y', lon2: -3, lat2: 38 },
  { lon: 5, lat: 48, n: 5, c: 'x', lon2: 25, lat2: 40 },
]
const TYPES = ['mercator', 'equirectangular', 'orthographic', 'naturalEarth1', 'albers', 'stereographic', 'conicEqualArea', 'transverseMercator', 'equalEarth']

function genProjection(r: () => number): Record<string, unknown> | undefined {
  const k = r()
  if (k < 0.15) return undefined
  const p: Record<string, unknown> = {}
  if (r() < 0.8) p.type = TYPES[Math.floor(r() * TYPES.length)]
  if (r() < 0.25) p.rotate = [Math.round(r() * 40 - 20), Math.round(r() * 40 - 20), 0]
  if (r() < 0.2) p.center = [Math.round(r() * 20 - 10), Math.round(r() * 20 + 30)]
  if (r() < 0.15) p.precision = [0.1, 0.5][Math.floor(r() * 2)]
  if (r() < 0.15) p.clipAngle = [45, 60, 90][Math.floor(r() * 3)]
  if (r() < 0.2) p.scale = 40 + Math.round(r() * 120)
  if (r() < 0.2) p.translate = [100 + Math.round(r() * 100), 80 + Math.round(r() * 60)]
  return p
}

function genUnit(r: () => number): Record<string, unknown> {
  const pos = { longitude: { field: 'lon', type: 'quantitative' }, latitude: { field: 'lat', type: 'quantitative' } }
  const k = r()
  const proj = genProjection(r)
  const unit: Record<string, unknown> = proj ? { projection: proj } : {}
  if (k < 0.3) return { ...unit, data: { values: REGIONS, format: { property: 'features' } }, mark: { type: 'geoshape', fill: r() < 0.5 ? 'lightgray' : 'seagreen' }, ...(r() < 0.4 ? { encoding: { color: { field: 'properties.v', type: 'quantitative' } } } : {}) }
  const data = { values: POINTS }
  if (k < 0.55) return { ...unit, data, mark: 'circle', encoding: { ...pos, ...(r() < 0.5 ? { size: { field: 'n', type: 'quantitative' } } : {}) } }
  if (k < 0.7) return { ...unit, data, mark: 'point', encoding: { ...pos, tooltip: { field: 'c', type: 'nominal' } } }
  if (k < 0.85) return { ...unit, data, mark: 'text', encoding: { ...pos, text: { field: 'c', type: 'nominal' } } }
  return { ...unit, data, mark: 'rule', encoding: { ...pos, longitude2: { field: 'lon2' }, latitude2: { field: 'lat2' } } }
}

export function genSpec(seed: number): Record<string, unknown> {
  const r = rng(seed)
  const spec: Record<string, unknown> = { width: 260, height: 180 }
  const shape = r()
  if (shape < 0.2) Object.assign(spec, genUnit(r))
  else {
    const children: Record<string, unknown>[] = []
    const n = 2 + Math.floor(r() * 3)
    for (let i = 0; i < n; i++) {
      if (r() < 0.2 && i > 0) children.push({ layer: [genUnit(r), genUnit(r)], ...(r() < 0.4 ? { projection: genProjection(r) } : {}) })
      else children.push(genUnit(r))
    }
    spec.layer = children
    if (r() < 0.6) {
      const lp = genProjection(r)
      if (lp) spec.projection = lp
    }
  }
  if (r() < 0.2) spec.config = { projection: { type: TYPES[Math.floor(r() * TYPES.length)] } }
  return spec
}

