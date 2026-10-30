/**
 * Scales as the chart engine uses them: the registry of scale types, tick and label helpers, interpolators and colour
 * schemes. This module is the public surface; the parts live in `scale-registry.ts` (types and kinds),
 * `scale-ticks.ts`, `scale-labels.ts` (legends), `scale-colors.ts` (interpolators, schemes, gradients) and the
 * constructors in `scale-continuous.ts`, `scale-calendar.ts` and `scale-discrete.ts`.
 */
export * from './scale-registry.js'
export * from './scale-ticks.js'
export * from './scale-labels.js'
export * from './scale-colors.js'
export { bandSpace } from './scale-discrete.js'
