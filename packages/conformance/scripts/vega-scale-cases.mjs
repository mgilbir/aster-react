/**
 * Inputs of the LIVE vega-scale differential (`differential-vega-scale.test.mts`): op programs
 * run against the scale classes of the pinned `vega-scale` and of Aster's port, in the same
 * process. Inputs only, no recorded outputs (V8's Math.pow/exp/log differ in the last bit
 * between Node versions; see `differential-util.mts`). Formerly recorded by `gen-vectors.mjs`
 * into `vega-scale.json` (43 scale + 2 scaleTz + 68 scheme + 60 vsticks cases; the counts
 * are pinned by the test's coverage floor).
 *
 * `dates` marks time/utc scales: numeric op args arrive as epoch millis and are handed to
 * the scale as Date objects.
 */

export const scalePrograms = [
  // linear
  { type: 'linear', ops: [['domain', [0, 10]], ['range', [0, 100]], ['call', 5], ['call', 12], ['call', -2], ['invert', 50], ['invert', 25], ['ticks', 5], ['tickFormat', 5, null, 2.5, 7.5, 1e-7], ['clamp', true], ['call', 200], ['invert', 200]] },
  { type: 'linear', ops: [['domain', [1, 2, 4, 8]], ['range', [0, 10, 30, 70]], ['call', 3], ['call', 9], ['invert', 20]] },
  { type: 'linear', ops: [['domain', [10, 0]], ['range', [100, 0]], ['call', 7], ['invert', 70], ['ticks', 4]] },
  { type: 'linear', ops: [['domain', [3.7, 19.2]], ['nice', 5], ['domain'], ['ticks', 5]] },
  { type: 'linear', ops: [['domain', [0.129, 0.831]], ['rangeRound', [0, 100]], ['call', 0.5], ['range'], ['clamp', true], ['call', 0.9]] },
  { type: 'linear', ops: [['domain', [0, 1]], ['range', ['red', 'blue']], ['call', 0.25], ['call', 0.75]] },
  { type: 'linear', ops: [['domain', [0, 1]], ['range', [0, 1]], ['unknown', 'n/a'], ['call', null], ['call', undefined], ['call', 'x']] },
  // log
  { type: 'log', ops: [['domain', [1, 10]], ['range', [0, 100]], ['call', 2], ['call', 5], ['invert', 30.103], ['ticks', 4], ['tickFormat', 4, null, 2, 5, 0.2]] },
  { type: 'log', ops: [['base', 2], ['domain', [1, 8]], ['range', [0, 100]], ['call', 4], ['ticks', 3]] },
  { type: 'log', ops: [['domain', [-100, -1]], ['range', [0, 100]], ['call', -10], ['invert', 50], ['ticks', 4]] },
  { type: 'log', ops: [['domain', [0.1, 100]], ['nice'], ['domain'], ['range', [0, 90]], ['ticks', 10]] },
  // pow / sqrt / symlog
  { type: 'pow', ops: [['domain', [0, 10]], ['range', [0, 100]], ['exponent', 2], ['call', 5], ['invert', 25], ['ticks', 5]] },
  { type: 'pow', ops: [['exponent', 3], ['domain', [0, 2]], ['range', [0, 8]], ['call', 1.5]] },
  { type: 'sqrt', ops: [['domain', [0, 100]], ['range', [0, 100]], ['call', 25], ['invert', 50], ['exponent']] },
  { type: 'symlog', ops: [['domain', [-10, 10]], ['range', [0, 100]], ['call', 5], ['call', -5], ['invert', 75]] },
  { type: 'symlog', ops: [['constant', 10], ['domain', [-100, 100]], ['range', [0, 100]], ['call', 50], ['invert', 25]] },
  // identity
  { type: 'identity', ops: [['domain', [0, 5]], ['call', 3], ['invert', 3], ['range'], ['domain']] },
  // time / utc
  { type: 'time', dates: true, ops: [['domain', [Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)]], ['range', [0, 300]], ['call', Date.UTC(2024, 1, 1)], ['invert', 150], ['ticks', 4], ['tickFormat', 4, null, Date.UTC(2024, 0, 15)], ['nice', 4], ['domain']] },
  { type: 'time', dates: true, ops: [['domain', [Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31)]], ['range', [0, 600]], ['ticks', 6]] },
  { type: 'utc', dates: true, ops: [['domain', [Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)]], ['range', [0, 300]], ['call', Date.UTC(2024, 1, 1)], ['invert', 150], ['ticks', 4], ['tickFormat', 4, null, Date.UTC(2024, 0, 15)], ['nice', 4], ['domain']] },
  { type: 'utc', dates: true, ops: [['domain', [Date.UTC(2024, 0, 1, 12), Date.UTC(2024, 0, 3, 6)]], ['range', [0, 200]], ['ticks', 8], ['tickFormat', null, null, Date.UTC(2024, 0, 2, 18, 30)]] },
  // sequential / diverging families
  { type: 'sequential', ops: [['domain', [0, 1]], ['range', [0, 1]], ['call', 0.25]] },
  { type: 'sequential', ops: [['domain', [0, 100]], ['range', [0, 1]], ['call', 37], ['range'], ['rangeRound', [0, 255]], ['call', 50]] },
  { type: 'sequential-log', ops: [['domain', [1, 100]], ['range', [0, 1]], ['call', 10]] },
  { type: 'sequential-symlog', ops: [['domain', [-10, 10]], ['range', [0, 1]], ['call', 5]] },
  { type: 'sequential-pow', ops: [['exponent', 2], ['domain', [0, 10]], ['range', [0, 1]], ['call', 5]] },
  { type: 'sequential-sqrt', ops: [['domain', [0, 100]], ['range', [0, 1]], ['call', 25]] },
  { type: 'diverging-linear', ops: [['domain', [0, 0.5, 1]], ['range', ['brown', 'white', 'steelblue']], ['call', 0.25], ['call', 0.75], ['range']] },
  { type: 'diverging-log', ops: [['domain', [0.1, 1, 10]], ['range', [0, 0.5, 1]], ['call', 1]] },
  { type: 'diverging-pow', ops: [['exponent', 2], ['domain', [0, 50, 100]], ['range', [0, 0.5, 1]], ['call', 25]] },
  { type: 'diverging-symlog', ops: [['domain', [-10, 0, 10]], ['range', [0, 0.5, 1]], ['call', -5]] },
  // quantile / quantize / threshold / bin-ordinal
  { type: 'quantile', ops: [['domain', [3, 6, 2, 9, 0, 4, 7, 1]], ['range', [0, 1, 2, 3]], ['call', 2.5], ['call', 8], ['invertExtent', 1], ['quantiles'], ['call', NaN]] },
  { type: 'quantize', ops: [['domain', [0, 100]], ['range', ['a', 'b', 'c', 'd']], ['call', 10], ['call', 99], ['call', -5], ['invertExtent', 'b'], ['thresholds']] },
  { type: 'threshold', ops: [['domain', [0.5, 2.5]], ['range', ['low', 'mid', 'high']], ['call', 0.1], ['call', 1], ['call', 5], ['invertExtent', 'mid'], ['copy', [1, 9]], ['call', 9.5]] },
  { type: 'bin-ordinal', ops: [['domain', [0, 1, 2, 3]], ['range', [10, 20]], ['call', 0.5], ['call', 2.5], ['tickFormat', 5, null, 0.5, 2.5]] },
  // ordinal
  { type: 'ordinal', ops: [['domain', ['a', 'b', 'c']], ['range', [0, 1, 2]], ['call', 'a'], ['call', 'b'], ['call', 'x'], ['unknown', 'other'], ['call', 'x'], ['copy', ['p', 'q']], ['call', 'p']] },
  { type: 'ordinal', ops: [['domain', ['a', 'b', 'c', 'd']], ['range', ['x', 'y']], ['call', 'c'], ['call', 'd']] },
  // band / point
  { type: 'band', ops: [['domain', ['a', 'b', 'c']], ['range', [0, 100]], ['bandwidth'], ['step'], ['call', 'b'], ['invert', 50], ['invertRange', [0, 33]], ['invertRange', [10, 60]], ['invertRange', [90, 99]]] },
  { type: 'band', ops: [['domain', ['a', 'b', 'c', 'd', 'e']], ['range', [0, 100]], ['paddingInner', 0.2], ['paddingOuter', 0.1], ['bandwidth'], ['step'], ['invert', 10], ['invertRange', [5, 55]]] },
  { type: 'band', ops: [['domain', ['a', 'b', 'c']], ['rangeRound', [0, 100]], ['round', true], ['bandwidth'], ['step'], ['call', 'a'], ['call', 'c']] },
  { type: 'band', ops: [['domain', ['a', 'b', 'c']], ['range', [100, 0]], ['call', 'b'], ['invert', 50], ['invertRange', [10, 60]]] },
  { type: 'band', ops: [['domain', ['a', 'b', 'c']], ['range', [0, 100]], ['align', 0], ['bandwidth'], ['align', 1], ['bandwidth'], ['padding', 0.5], ['bandwidth']] },
  { type: 'point', ops: [['domain', ['a', 'b', 'c']], ['range', [0, 100]], ['bandwidth'], ['step'], ['call', 'a'], ['invert', 33], ['padding', 0.5], ['step']] },
]

// run under America/New_York: DST-adjacent floors of time scales
export const scaleTzPrograms = [
  { type: 'time', dates: true, ops: [['domain', [Date.UTC(2024, 2, 9, 12), Date.UTC(2024, 2, 12, 12)]], ['range', [0, 300]], ['ticks', 4], ['nice', 3], ['domain']] },
  { type: 'time', dates: true, ops: [['domain', [Date.UTC(2024, 10, 2, 12), Date.UTC(2024, 10, 4, 12)]], ['range', [0, 300]], ['ticks', 6], ['tickFormat', null, null, Date.UTC(2024, 10, 3, 5)]] },
]

// scheme registry: discrete palettes verbatim; continuous interpolators sampled
export const schemeNames = [
  'blues', 'greens', 'greys', 'oranges', 'purples', 'reds',
  'blueGreen', 'bluePurple', 'greenBlue', 'orangeRed', 'purpleBlue', 'purpleBlueGreen',
  'purpleRed', 'redPurple', 'yellowGreen', 'yellowOrangeBrown', 'yellowOrangeRed',
  'blueOrange', 'brownBlueGreen', 'purpleGreen', 'purpleOrange', 'redBlue', 'redGrey',
  'yellowGreenBlue', 'redYellowBlue', 'redYellowGreen', 'pinkYellowGreen', 'spectral',
  'viridis', 'magma', 'inferno', 'plasma', 'cividis', 'rainbow', 'sinebow', 'turbo',
  'browns', 'tealBlues', 'teals', 'warmGreys', 'goldGreen', 'goldOrange', 'goldRed',
  'lightGreyRed', 'lightGreyTeal', 'lightMulti', 'lightOrange', 'lightTealBlue',
  'darkBlue', 'darkGold', 'darkGreen', 'darkMulti', 'darkRed',
  'accent', 'category10', 'category20', 'category20b', 'category20c', 'dark2',
  'observable10', 'paired', 'pastel1', 'pastel2', 'set1', 'set2', 'set3',
  'tableau10', 'tableau20',
]

/**
 * vega-scale tick helpers (tickCount, tickValues, bandSpace). Each case is
 * `[op, type, domain, ...args]`, as the replay's `vsticks` kind had it.
 * NOTE: tickLog is internal to vega-scale 8.1.2 (not exported); its behaviour is pinned
 * through the log-scale tickFormat cases in `scalePrograms`.
 */
export const vstickCases = []
// tickCount with numeric count and minStep
for (const [type, domain] of [
  ['linear', [0, 100]], ['linear', [0.13, 0.87]], ['linear', [1, 2, 4, 8]],
  ['log', [1, 1000]], ['log', [1, 10, 100]],
  ['pow', [0, 64]], ['symlog', [-100, 100]], ['sqrt', [0, 100]],
]) {
  for (const [count, minStep] of [[5], [10], [3, 5], [10, 2], [10, 30]]) {
    vstickCases.push({ op: 'tickCount', type, domain, count, minStep: minStep ?? null })
  }
}
// tickCount on binned scales
vstickCases.push({ op: 'tickCount', type: 'linear', domain: [0, 100], count: 10, minStep: null, bins: [0, 10, 20] })
// tickValues: plain, binned, interval (string converted through tickCount)
for (const [type, domain, count, dates] of [
  ['linear', [0, 100], 10], ['linear', [0, 100], 3], ['linear', [1, 2, 4, 8], 5],
  ['log', [1, 1000], 5], ['sqrt', [0, 100], 7],
  ['time', [Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)], 4, true],
  ['utc', [Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)], 4, true],
]) {
  vstickCases.push({ op: 'tickValues', type, domain, count, dates: !!dates })
}
for (const [type, domain, interval, step] of [
  ['time', [Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1)], 'month', null],
  ['time', [Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 10)], 'day', 2],
  ['utc', [Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1)], 'month', null],
  ['utc', [Date.UTC(2024, 0, 1, 0), Date.UTC(2024, 0, 2, 0)], 'hours', 3],
  ['time', [Date.UTC(2024, 0, 1), Date.UTC(2034, 0, 1)], 'year', null],
  ['linear', [0, 10], 'month', null], // error path: non-temporal interval
]) {
  vstickCases.push({ op: 'tickValuesInterval', type, domain, interval, step, dates: type === 'time' || type === 'utc' })
}
for (const [count, pi, po] of [[5, 0, 0], [5, 0.2, 0], [5, 0.2, 0.1], [0, 0, 0], [1, 1, 1], [10, 0.5, 0.25]]) {
  vstickCases.push({ op: 'bandSpace', count, paddingInner: pi, paddingOuter: po })
}
