/**
 * The expression functions the opt-in add-ons register, by add-on. Two readers: the expression compiler, which names the add-on
 * to load when a spec calls one that is not there (instead of "Unrecognized function"), and `@aster/core/addons`, which reads a
 * spec's expressions for these calls to know what to load. A table of names only (no add-on code), so that neither pays for the add-ons.
 * `addons-needed.test.ts` checks it against what the add-ons actually register.
 */
export const ADDON_FUNCTIONS: Readonly<Record<string, 'transforms' | 'geo'>> = Object.freeze({
  // @aster/core/transforms: the distributions (stats-functions.ts) and the tree lookups (transform-extra.ts)
  sampleNormal: 'transforms', densityNormal: 'transforms', cumulativeNormal: 'transforms', quantileNormal: 'transforms',
  sampleLogNormal: 'transforms', densityLogNormal: 'transforms', cumulativeLogNormal: 'transforms', quantileLogNormal: 'transforms',
  sampleUniform: 'transforms', densityUniform: 'transforms', cumulativeUniform: 'transforms', quantileUniform: 'transforms',
  treePath: 'transforms', treeAncestors: 'transforms',
  // @aster/core/geo (addon-geo.ts)
  geoArea: 'geo', geoBounds: 'geo', geoCentroid: 'geo', geoScale: 'geo', geoShape: 'geo', pathShape: 'geo',
})
