/**
 * Inputs of the LIVE d3-geo / d3-contour differential (`differential-d3-geo.test.mts`):
 * op programs run against a projection of the pinned `d3-geo` and of Aster's port, plus
 * marching-squares grids for `d3-contour`. Inputs only; formerly recorded by `gen-vectors.mjs`
 * into `d3-geo.json` (18 geo + 30 contour cases).
 */

// Shared GeoJSON samples, referenced by name in the op programs.
export const geoSamples = {
  poly1: { type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] },
  polyAntimeridian: { type: 'Polygon', coordinates: [[[170, -20], [-170, -20], [-170, 20], [170, 20], [170, -20]]] },
  mpoly: { type: 'MultiPolygon', coordinates: [
    [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
    [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
  ] },
  line: { type: 'LineString', coordinates: [[-120, 40], [-100, 35], [-80, 30], [-60, 45]] },
  points: { type: 'MultiPoint', coordinates: [[0, 0], [45, 45], [-120, -60], [179.9, 60]] },
  sphere: { type: 'Sphere' },
}
geoSamples.feature = { type: 'Feature', geometry: geoSamples.poly1 }
geoSamples.collection = { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: geoSamples.poly1 },
  { type: 'Feature', geometry: geoSamples.line },
] }

export const geoPrograms = [
  { type: 'mercator', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 0]], ['invert', [200, 150]], ['path', 'sphere'], ['bounds', 'poly1'], ['centroid', 'poly1'], ['area', 'poly1'], ['measure', 'line']] },
  { type: 'mercator', ops: [['scale', 100], ['translate', [200, 150]], ['path', 'polyAntimeridian'], ['clipAngle', 60], ['path', 'polyAntimeridian'], ['precision', 0.1], ['path', 'line']] },
  { type: 'mercator', ops: [['scale', 200], ['translate', [200, 150]], ['reflectX', true], ['path', 'poly1'], ['reflectY', true], ['path', 'poly1'], ['reflectX', false]] },
  { type: 'mercator', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'points'], ['path', 'feature'], ['path', 'collection']] },
  { type: 'albers', ops: [['path', 'poly1'], ['call', [-96, 38.7]], ['invert', [480, 250]], ['centroid', 'mpoly'], ['bounds', 'mpoly']] },
  { type: 'albersUsa', ops: [['path', 'poly1'], ['call', [-96, 38.7]], ['call', [-150, 62]], ['call', [-157, 20]], ['invert', [480, 250]], ['precision', 0.5], ['path', 'line']] },
  { type: 'azimuthalEqualArea', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['path', 'sphere'], ['call', [0, 0]], ['invert', [200, 150]], ['clipAngle', 90], ['path', 'sphere']] },
  { type: 'azimuthalEquidistant', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 90]], ['invert', [200, 150]]] },
  { type: 'conicConformal', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['parallels', [30, 30]], ['call', [0, 30]], ['rotate', [10, -20]], ['path', 'poly1']] },
  { type: 'conicEqualArea', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 33]], ['invert', [200, 150]]] },
  { type: 'conicEquidistant', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 14]], ['invert', [200, 150]]] },
  { type: 'equalEarth', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['path', 'sphere'], ['call', [0, 0]], ['invert', [200, 150]]] },
  { type: 'equirectangular', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [10, 20]], ['invert', [200, 150]], ['rotate', [0, 0, 45]], ['path', 'line']] },
  { type: 'gnomonic', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 0]], ['invert', [200, 150]]] },
  { type: 'naturalEarth1', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['path', 'sphere'], ['call', [0, 0]], ['invert', [200, 150]]] },
  { type: 'orthographic', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['path', 'sphere'], ['call', [0, 45]], ['invert', [200, 150]], ['rotate', [-45, -30]], ['path', 'sphere']] },
  { type: 'stereographic', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 0]], ['invert', [200, 150]]] },
  { type: 'transverseMercator', ops: [['scale', 200], ['translate', [200, 150]], ['path', 'poly1'], ['call', [0, 0]], ['invert', [200, 150]], ['center', [10, 0]], ['path', 'poly1']] },
]

// d3-contour: marching squares over fixed grids
export const contourGrids = {
  peak: [0.1, 0.2, 0.3, 0.2, 0.1, 0.2, 0.5, 0.8, 0.5, 0.2, 0.3, 0.8, 1.0, 0.8, 0.3, 0.2, 0.5, 0.8, 0.5, 0.2, 0.1, 0.2, 0.3, 0.2, 0.1],
  mixed: [1, 2, NaN, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7],
  flat: new Array(16).fill(2.5),
}
/** `[values, thresholds, size, smooth]` per case */
export const contourCases = []
for (const [gridName, values] of Object.entries(contourGrids)) {
  for (const size of [[5, 5], [4, 6]]) {
    if (gridName === 'flat' && size[0] === 4) continue
    for (const thresholds of [[0.3], [0.25, 0.5, 0.75], [0.5]]) {
      for (const smooth of [true, false]) {
        contourCases.push({ grid: gridName, values, thresholds, size, smooth })
      }
    }
  }
}
