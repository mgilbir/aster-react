/**
 * `@aster-charts/core/internal/testing` (not public API: no semver, no published declarations): engine functions that only this
 * repo's conformance gates and browser scripts call, kept off every public entry.
 *
 * `sceneIntersect` is vega-scenegraph's `intersect` over a scene (the body of the `intersect()` expression function): the conformance
 * gates compare it with the real one.
 */
export { sceneIntersect } from './scene-intersect.js'
