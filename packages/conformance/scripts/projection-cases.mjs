/**
 * Projection oracle cases: a Vega projection spec (`projections: [{ name: 'p', ...params }]`)
 * built by real vega (the vega-geo Projection transform over vega-projection's
 * registry) and by Aster's `buildProjection`, then compared on the projection's
 * properties, projected points and path strings over `GEOMS`. Consumed by
 * `differential-projection.test.mts` (live, same engine; see there for why nothing is recorded).
 */

const poly = (ring) => ({ type: 'Polygon', coordinates: [ring] })
const feature = (g, props = {}) => ({ type: 'Feature', properties: props, geometry: g })
const US = poly([[-125, 32], [-118, 48], [-100, 49], [-95, 30], [-110, 28], [-125, 32]])
const EU = poly([[-10, 35], [40, 35], [40, 70], [-10, 60], [-10, 35]])
const ASIA = poly([[60, -10], [150, -10], [150, 50], [70, 40], [60, -10]])
const WORLD = poly([[-170, 10], [-60, 15], [-50, 70], [-160, 65], [-170, 10]])
const POINT = { type: 'Point', coordinates: [-95, 38] }
const LINE = { type: 'LineString', coordinates: [[-120, 30], [-100, 40], [-80, 35]] }
const MULTI = { type: 'MultiPolygon', coordinates: [[US.coordinates[0]], [EU.coordinates[0]]] }
const FC = { type: 'FeatureCollection', features: [feature(US), feature(EU), feature(ASIA)] }
export const GEOMS = { us: US, eu: EU, asia: ASIA, world: WORLD, point: POINT, line: LINE, multi: MULTI, fc: FC }

export const POINTS = [[-95, 38], [0, 0], [10, 50], [120, -30], [-170, 60], [179, 10]]
const TYPES = ['albers', 'albersusa', 'albersUsa', 'AlbersUSA', 'azimuthalequalarea', 'azimuthalEqualArea', 'azimuthalequidistant', 'azimuthalEquidistant',
  'conicconformal', 'conicConformal', 'conicequalarea', 'conicEqualArea', 'conicequidistant', 'conicEquidistant', 'equalearth', 'equalEarth', 'EqualEarth',
  'equirectangular', 'Equirectangular', 'gnomonic', 'identity', 'mercator', 'Mercator', 'MERCATOR', 'mollweide', 'naturalearth1', 'naturalEarth1', 'NaturalEarth1',
  'orthographic', 'orthoGraphic', 'stereographic', 'transversemercator', 'transverseMercator']
const UNKNOWN = ['robinson', 'albers-usa', 'natural-earth', 'conic-equal-area', 'azimuthal-equal-area', 'x', 'mercatorr', 'naturalEarth2']

export const cases = []
const add = (name, params) => cases.push({ name, params })

for (const t of TYPES) add(`type/${t}`, { type: t })
for (const t of UNKNOWN) add(`unknown/${t}`, { type: t })
add('type/missing', {})
add('type/empty-string', { type: '' })
add('type/non-string', { type: 5 })

const PROPS = [
  ['scale', 120], ['translate', [210, 90]], ['center', [-95, 38]], ['rotate', [-20, 30]], ['rotate3', [-20, 30, 15]],
  ['precision', 0.5], ['clipAngle', 60], ['reflectX', true], ['reflectY', true], ['clipExtent', [[10, 10], [200, 150]]],
]
for (const t of ['mercator', 'naturalEarth1', 'orthographic', 'albers', 'albersUsa', 'equalEarth', 'identity', 'azimuthalEqualArea', 'transverseMercator', 'mollweide']) {
  for (const [k, v] of PROPS) add(`prop/${t}/${k}`, { type: t, [k === 'rotate3' ? 'rotate' : k]: v })
  add(`prop/${t}/all`, { type: t, scale: 150, translate: [200, 120], center: [10, 20], rotate: [-10, -5], precision: 0.1, reflectX: false })
}
for (const t of ['albers', 'conicEqualArea', 'conicConformal', 'conicEquidistant']) {
  add(`parallels/${t}`, { type: t, parallels: [20, 50] })
  add(`parallels/${t}-center`, { type: t, parallels: [10, 40], center: [-20, 35], scale: 300 })
}
add('prop/null-ignored', { type: 'mercator', scale: null, translate: null })
add('prop/ignored-unknown-key', { type: 'mercator', frobnicate: 5, scale: 77 })
add('prop/not-a-property-pointRadius', { type: 'mercator', pointRadius: 9 })

// fit / size / extent (the geometry value is inlined in the spec)
for (const t of ['mercator', 'naturalEarth1', 'equalEarth', 'orthographic', 'albers', 'equirectangular', 'identity', 'azimuthalEqualArea', 'stereographic']) {
  for (const [g, geo] of Object.entries(GEOMS)) {
    if (g === 'point' && t !== 'mercator') continue
    add(`fit/${t}/size/${g}`, { type: t, size: [300, 200], fit: geo })
  }
  add(`fit/${t}/extent`, { type: t, extent: [[20, 10], [380, 290]], fit: FC })
  add(`fit/${t}/size-and-extent`, { type: t, size: [300, 200], extent: [[5, 5], [100, 80]], fit: FC })
  add(`fit/${t}/array-of-geometries`, { type: t, size: [300, 200], fit: [US, EU, ASIA] })
  add(`fit/${t}/array-of-features`, { type: t, size: [300, 200], fit: [feature(US), feature(EU)] })
  add(`fit/${t}/array-mixed`, { type: t, size: [300, 200], fit: [feature(US), EU, FC] })
  add(`fit/${t}/array-single`, { type: t, size: [300, 200], fit: [FC] })
  add(`fit/${t}/array-with-null`, { type: t, size: [300, 200], fit: [US, null, EU] })
}
add('fit/no-size-no-extent', { type: 'mercator', fit: FC })
add('fit/falsy', { type: 'mercator', size: [300, 200], fit: null })
add('fit/empty-array', { type: 'mercator', size: [300, 200], fit: [] })
add('fit/after-explicit-scale', { type: 'mercator', scale: 999, translate: [1, 1], size: [300, 200], fit: US })
add('fit/rotate-then-fit', { type: 'orthographic', rotate: [-60, -20], size: [300, 300], fit: WORLD })
add('fit/center-then-fit', { type: 'mercator', center: [-100, 40], size: [300, 200], fit: US })
add('fit/clipExtent-kept', { type: 'mercator', clipExtent: [[0, 0], [250, 150]], size: [300, 200], fit: US })
add('fit/clipAngle-fit', { type: 'azimuthalEqualArea', clipAngle: 90, rotate: [-100, -30], size: [300, 300], fit: WORLD })
add('fit/albersusa-us', { type: 'albersUsa', size: [300, 200], fit: feature(poly([[-122, 37], [-74, 40], [-80, 28], [-104, 30], [-122, 37]])) })
add('fit/albersusa-territories', { type: 'albersUsa', size: [300, 200], fit: [feature(poly([[-158, 20], [-155, 20], [-155, 22], [-158, 22], [-158, 20]])), feature(poly([[-150, 62], [-140, 62], [-140, 68], [-150, 68], [-150, 62]]))] })

// pointRadius
add('pointRadius/applies-to-path', { type: 'mercator', scale: 100, translate: [100, 100], pointRadius: 7 })
add('pointRadius/with-fit', { type: 'mercator', size: [300, 200], fit: FC, pointRadius: 3 })

