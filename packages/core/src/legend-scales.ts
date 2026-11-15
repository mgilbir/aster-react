/**
 * The channels a legend can describe, in priority order: the first one the spec names gives the legend its scale. A module of its own
 * because the runtime reads it on every path, and the legend builder that also reads it is loaded on demand (engine-parts.ts).
 */
export const LEGEND_SCALES = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const
