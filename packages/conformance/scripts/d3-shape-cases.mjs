/**
 * Inputs of the LIVE d3-shape differential (`differential-d3-shape.test.mts`): every curve
 * family across point sets of varied size (gaps, duplicate points, fractional coordinates),
 * plus area generation. Inputs only; formerly recorded by `gen-vectors.mjs` into
 * `d3-shape.json` (247 line + 9 area cases).
 */

export const curveFamilies = [
  ['curveBasis', {}], ['curveBasisClosed', {}], ['curveBasisOpen', {}],
  ['curveBundle', {}], ['curveBundle', { beta: 0.5 }], ['curveBundle', { beta: 0 }],
  ['curveCardinal', {}], ['curveCardinal', { tension: 0.7 }],
  ['curveCardinalClosed', {}], ['curveCardinalClosed', { tension: 0.3 }],
  ['curveCardinalOpen', {}], ['curveCardinalOpen', { tension: 0.3 }],
  ['curveCatmullRom', {}], ['curveCatmullRom', { alpha: 0.3 }], ['curveCatmullRom', { alpha: 1 }],
  ['curveCatmullRomClosed', {}], ['curveCatmullRomClosed', { alpha: 0.7 }],
  ['curveCatmullRomOpen', {}], ['curveCatmullRomOpen', { alpha: 0.7 }],
  ['curveLinear', {}], ['curveLinearClosed', {}],
  ['curveMonotoneX', {}], ['curveMonotoneY', {}],
  ['curveNatural', {}], ['curveStep', {}], ['curveStepAfter', {}], ['curveStepBefore', {}],
]

export const pointSets = [
  [],
  [[0, 0]],
  [[0, 0], [10, 10]],
  [[0, 0], [10, 10], [20, 0]],
  [[136, 137], [205, 131.923], [241, 125.864], [274.891, 111.908], [305, 116.538]],
  [[0, 0], [10, 10], [10, 10], [20, 0]],       // duplicate points (monotone skips)
  [[0, 0], [-15.5, 22.25], [1000.125, -3.5], [7, 7], [7, 7], [0, 0]],
  [[5, 5], [5, 5], [5, 5]],                     // all coincident
  [[100, 0], [0, 100], [100, 200], [0, 300]],   // zigzag
]

/** line().defined: splits into segments (third element of each point) */
export const gapPoints = [[0, 0, true], [10, 10, true], [20, 20, false], [30, 30, true], [40, 40, true]]
export const gapCurves = [['curveLinear', {}], ['curveBasis', {}], ['curveMonotoneX', {}], ['curveStep', {}]]

/** area(): x, y0, y1 per point; closes back along y0 */
export const areaPoints = [
  [[0, 0, 50], [10, 10, 60], [20, 20, 70]],
  [[136, 137, 40], [205, 131.923, 45], [241, 125.864, 50]],
  [[0, 0, 50], [10, 10, 60], [20, 20, 70], [30, 30, 80, false], [40, 40, 90]],
]
export const areaCurves = [['curveLinear', {}], ['curveBasis', {}], ['curveMonotoneX', {}]]
