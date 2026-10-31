/**
 * Generated Vega specs for the guide and layout differentials (guide-generated-vs-vega.test.ts, trellis-generated-vs-vega.test.ts):
 * axes and legends over the whole parameter space, and grids of groups (facets, nested groups, headers, footers, titles).
 * Every case is a pure function of its seed, so a failure names the seed and replays.
 */
type Spec = Record<string, unknown>
type Rand = () => number

/**
 * GUIDE_FULL=1 widens the generators to the cases where the engine is known to differ from vega (see the notes at each site), so a
 * refactor can be checked against the build it replaces on the whole space, not only against vega on the part where they agree.
 */
const GAPS = (process.env.GUIDE_FULL ?? '').split(',')
const G = (n: string): boolean => GAPS.includes('1') || GAPS.includes(n)

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const chance = (r: Rand, p: number): boolean => r() < p
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
/** Sometimes a signal instead of a value, so the guide's `update` block and the signal path are met. */
const maybeSignal = (r: Rand, v: unknown, p = 0.12): unknown => (chance(r, p) ? { signal: JSON.stringify(v) } : v)

const COLORS = ['red', '#336699', 'rgba(0,128,0,0.5)', 'orange', '#000', 'steelblue', 'transparent', 'hsl(30,60%,40%)']
const FONTS = ['serif', 'monospace', 'sans-serif', 'Arial']
const WEIGHTS = ['normal', 'bold', 300, 700]
const ALIGN = ['left', 'center', 'right']
const BASELINE = ['top', 'middle', 'bottom', 'alphabetic', 'line-top', 'line-bottom']
const DASHES = [[2, 2], [4, 1, 1, 1], [6, 3], []]
const CAPS = ['butt', 'round', 'square']
const NUMBER_FORMATS = ['d', '.1f', ',.0f', '.2s', '$,.2f', '+.1%', '%', '.3~g', '04d', 'e', 's', 'g', 'r', '', 'p', 'f', '~s', ',']
const TIME_FORMATS = ['%Y', '%b %d', '%H:%M', '%a %e', '%B', '%Y-%m-%d']

const DAY = 86_400_000
const T0 = Date.UTC(2020, 0, 1)

function dataRows(r: Rand): Spec[] {
  const n = int(r, 3, 14)
  const cats = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi']
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(r() * 2000) / 10 + 1,
    y: Math.round(r() * 1000) / 10 + 1,
    z: int(r, 1, 9),
    c: cats[i % cats.length],
    t: T0 + int(r, 0, 900) * DAY,
  }))
}

interface PositionScale { name: string; kind: string; spec: Spec }

function positionScale(r: Rand, name: string, length: 'width' | 'height', kinds: readonly string[]): PositionScale {
  const kind = pick(r, kinds)
  const reverse = chance(r, 0.2)
  const range: unknown = chance(r, 0.4) ? [reverse ? { signal: length } : 0, reverse ? 0 : { signal: length }] : reverse ? [{ signal: length }, 0] : length
  const field = name === 'sx' ? 'x' : 'y'
  const spec: Spec = { name, type: kind, range }
  switch (kind) {
    case 'band':
    case 'point':
      spec.domain = { data: 'rows', field: 'c' }
      if (chance(r, 0.5)) spec.padding = pick(r, [0, 0.1, 0.3, 0.6])
      if (kind === 'band' && chance(r, 0.3)) spec.paddingInner = pick(r, [0, 0.2, 0.5])
      if (chance(r, 0.2)) spec.round = true
      break
    case 'time':
    case 'utc':
      spec.domain = { data: 'rows', field: 't' }
      if (chance(r, 0.3)) spec.nice = pick(r, [true, 'month', 'week'])
      break
    case 'log':
      spec.domain = [pick(r, [1, 2, 5]), pick(r, [200, 1000, 5000])]
      if (chance(r, 0.3)) spec.base = pick(r, [2, 10])
      break
    case 'symlog':
      spec.domain = [pick(r, [-50, 0, 3]), pick(r, [200, 1000])]
      break
    default:
      spec.domain = chance(r, 0.5) ? { data: 'rows', field } : [pick(r, [0, -20, 10]), pick(r, [100, 250, 1000])]
      if (chance(r, 0.4)) spec.nice = chance(r, 0.7) ? true : int(r, 2, 8)
      if (chance(r, 0.15)) spec.zero = true
      if (kind === 'pow') spec.exponent = pick(r, [0.5, 2])
      if (chance(r, 0.15)) spec.padding = int(r, 1, 12)
  }
  return { name, kind, spec }
}

/** A guide property that has a text-ish choice list, or is absent. */
function maybe<T>(r: Rand, p: number, make: () => T): T | undefined {
  return chance(r, p) ? make() : undefined
}

function setIf(o: Spec, key: string, v: unknown): void {
  if (v !== undefined) o[key] = v
}

function axisProps(r: Rand, orient: string, kind: string, other: PositionScale): Spec {
  const a: Spec = {}
  const horizontal = orient === 'top' || orient === 'bottom'
  const P = 0.3
  setIf(a, 'orient', undefined)
  setIf(a, 'grid', maybe(r, 0.5, () => chance(r, 0.85)))
  if (a.grid !== false && chance(r, 0.15)) a.gridScale = other.name
  setIf(a, 'gridColor', maybe(r, P, () => pick(r, COLORS)))
  setIf(a, 'gridWidth', maybe(r, P, () => pick(r, [0.5, 1, 2, 4])))
  setIf(a, 'gridDash', maybe(r, P, () => pick(r, DASHES)))
  setIf(a, 'gridDashOffset', maybe(r, 0.1, () => pick(r, [1, 3])))
  setIf(a, 'gridOpacity', maybe(r, P, () => pick(r, [0, 0.2, 0.7, 1])))
  setIf(a, 'gridCap', maybe(r, 0.1, () => pick(r, CAPS)))
  setIf(a, 'domain', maybe(r, 0.2, () => chance(r, 0.4)))
  setIf(a, 'domainColor', maybe(r, P, () => pick(r, COLORS)))
  setIf(a, 'domainWidth', maybe(r, P, () => pick(r, [0.5, 1, 3])))
  setIf(a, 'domainDash', maybe(r, 0.15, () => pick(r, DASHES)))
  setIf(a, 'domainDashOffset', maybe(r, 0.1, () => 2))
  setIf(a, 'domainOpacity', maybe(r, 0.2, () => pick(r, [0.3, 0.8])))
  setIf(a, 'domainCap', maybe(r, 0.1, () => pick(r, CAPS)))
  setIf(a, 'ticks', maybe(r, 0.2, () => chance(r, 0.4)))
  setIf(a, 'tickColor', maybe(r, P, () => pick(r, COLORS)))
  setIf(a, 'tickWidth', maybe(r, P, () => pick(r, [0.5, 1, 3])))
  setIf(a, 'tickDash', maybe(r, 0.15, () => pick(r, DASHES)))
  setIf(a, 'tickDashOffset', maybe(r, 0.1, () => 1))
  setIf(a, 'tickOpacity', maybe(r, 0.2, () => pick(r, [0.4, 1])))
  setIf(a, 'tickCap', maybe(r, 0.1, () => pick(r, CAPS)))
  setIf(a, 'tickSize', maybe(r, 0.4, () => maybeSignal(r, pick(r, [0, 2, 5, 9, 14]))))
  setIf(a, 'tickRound', maybe(r, 0.2, () => chance(r, 0.5)))
  setIf(a, 'tickCount', maybe(r, 0.4, () => (kind === 'time' || kind === 'utc') && chance(r, 0.5) ? pick(r, ['month', 'week', { interval: 'day', step: 10 }, 'year']) : maybeSignal(r, int(r, 1, 12))))
  setIf(a, 'tickMinStep', maybe(r, 0.1, () => pick(r, [1, 5, 10])))
  if (kind === 'band' || kind === 'point') {
    setIf(a, 'bandPosition', maybe(r, 0.3, () => pick(r, [0, 0.25, 0.5, 1])))
    setIf(a, 'tickBand', maybe(r, 0.3, () => pick(r, ['center', 'extent'])))
    setIf(a, 'tickExtra', maybe(r, 0.2, () => chance(r, 0.5)))
  } else {
    setIf(a, 'tickExtra', maybe(r, 0.1, () => chance(r, 0.5)))
  }
  setIf(a, 'tickOffset', maybe(r, 0.2, () => pick(r, [-2, 1, 4])))
  setIf(a, 'labels', maybe(r, 0.15, () => chance(r, 0.3)))
  setIf(a, 'labelColor', maybe(r, P, () => pick(r, COLORS)))
  setIf(a, 'labelOpacity', maybe(r, 0.2, () => pick(r, [0.4, 1])))
  setIf(a, 'labelAngle', maybe(r, 0.35, () => maybeSignal(r, pick(r, [-90, -45, 0, 30, 90, 270]))))
  setIf(a, 'labelAlign', maybe(r, 0.25, () => pick(r, ALIGN)))
  setIf(a, 'labelBaseline', maybe(r, 0.25, () => pick(r, BASELINE)))
  setIf(a, 'labelFont', maybe(r, 0.2, () => pick(r, FONTS)))
  setIf(a, 'labelFontSize', maybe(r, 0.35, () => pick(r, [8, 10, 13, 18])))
  setIf(a, 'labelFontWeight', maybe(r, 0.2, () => pick(r, WEIGHTS)))
  setIf(a, 'labelFontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(a, 'labelLimit', maybe(r, 0.25, () => pick(r, [0, 20, 40, 200])))
  setIf(a, 'labelLineHeight', maybe(r, 0.1, () => pick(r, [8, 20])))
  setIf(a, 'labelPadding', maybe(r, 0.3, () => maybeSignal(r, pick(r, [0, 2, 8, 15]))))
  setIf(a, 'labelOffset', maybe(r, 0.2, () => pick(r, [-4, 3])))
  setIf(a, 'labelOverlap', maybe(r, 0.5, () => pick(r, [true, false, 'parity', 'greedy'])))
  setIf(a, 'labelSeparation', maybe(r, 0.2, () => pick(r, [-2, 0, 5, 30])))
  setIf(a, 'labelBound', maybe(r, 0.3, () => pick(r, [true, false, 0, 3, 20])))
  setIf(a, 'labelFlush', maybe(r, 0.35, () => pick(r, [true, false, 0, 3, 10])))
  setIf(a, 'labelFlushOffset', maybe(r, 0.25, () => pick(r, [0, 2, 6])))
  if (kind === 'time' || kind === 'utc') {
    setIf(a, 'format', maybe(r, 0.5, () => pick(r, TIME_FORMATS)))
    setIf(a, 'formatType', maybe(r, 0.4, () => pick(r, ['time', 'utc'])))
  } else if (kind !== 'band' && kind !== 'point') {
    setIf(a, 'format', maybe(r, 0.5, () => pick(r, NUMBER_FORMATS)))
    setIf(a, 'formatType', maybe(r, 0.1, () => 'number'))
  }
  if (chance(r, 0.15)) a.labelExpr = pick(r, ['datum.label + "!"', 'upper(datum.label)', 'datum.index'])
  if (chance(r, 0.12) && kind !== 'band' && kind !== 'point') a.values = [pick(r, [1, 10]), pick(r, [20, 40]), pick(r, [60, 90])]
  setIf(a, 'title', maybe(r, 0.6, () => pick(r, ['A title', 'Longer axis title goes here', ['two', 'lines'], 'ñ ü', ''])))
  setIf(a, 'titleAnchor', maybe(r, 0.3, () => pick(r, ['start', 'middle', 'end', null])))
  setIf(a, 'titleAngle', maybe(r, 0.25, () => pick(r, [0, 90, -90, 45])))
  setIf(a, 'titleAlign', maybe(r, 0.2, () => pick(r, ALIGN)))
  setIf(a, 'titleBaseline', maybe(r, 0.2, () => pick(r, BASELINE)))
  setIf(a, 'titleColor', maybe(r, 0.2, () => pick(r, COLORS)))
  setIf(a, 'titleOpacity', maybe(r, 0.15, () => 0.6))
  setIf(a, 'titleFont', maybe(r, 0.15, () => pick(r, FONTS)))
  setIf(a, 'titleFontSize', maybe(r, 0.3, () => pick(r, [9, 12, 16])))
  setIf(a, 'titleFontWeight', maybe(r, 0.2, () => pick(r, WEIGHTS)))
  setIf(a, 'titleFontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(a, 'titleLimit', maybe(r, 0.2, () => pick(r, [30, 80, 500])))
  setIf(a, 'titleLineHeight', maybe(r, 0.1, () => 18))
  setIf(a, 'titlePadding', maybe(r, 0.35, () => maybeSignal(r, pick(r, [0, 3, 10, 24]))))
  setIf(a, 'titleX', maybe(r, 0.1, () => pick(r, [-10, 5, 30])))
  setIf(a, 'titleY', maybe(r, 0.1, () => pick(r, [-10, 5, 30])))
  setIf(a, 'offset', maybe(r, 0.35, () => maybeSignal(r, pick(r, [-6, 0, 4, 12]))))
  setIf(a, 'position', maybe(r, 0.2, () => pick(r, [0, 15, { signal: '10 + 5' }])))
  setIf(a, 'translate', maybe(r, 0.2, () => pick(r, [0, 0.5, 1, -0.5])))
  setIf(a, 'minExtent', maybe(r, 0.25, () => pick(r, [0, 10, 40])))
  setIf(a, 'maxExtent', maybe(r, 0.2, () => pick(r, [0, 20, 35, 200])))
  setIf(a, 'zindex', maybe(r, 0.3, () => pick(r, [0, 1])))
  if (chance(r, 0.1)) a.aria = false
  if (chance(r, 0.1)) a.description = 'axis for ' + (horizontal ? 'x' : 'y')
  if (chance(r, 0.12)) {
    const part = pick(r, ['axis', 'ticks', 'labels', 'title', 'domain', 'grid'])
    const e: Spec = {}
    if (chance(r, 0.5)) e.name = 'p' + part
    if (chance(r, 0.4)) e.interactive = true
    if (chance(r, 0.5)) e.update = { opacity: { value: 0.8 }, ...(part === 'labels' || part === 'title' ? { fill: { value: 'green' } } : { stroke: { value: 'green' } }) }
    if (chance(r, 0.3)) e.enter = { strokeWidth: { value: 2 } }
    a.encode = { [part]: e }
  }
  return a
}

export interface GuideCase { id: string; seed: number; spec: Spec; kind: string }

const AXIS_CONFIGS: Spec[] = [
  {},
  { axis: { labelFontSize: 11, tickColor: '#888', domainColor: '#444', titleFontSize: 14, labelPadding: 3, tickSize: 7 } },
  { axisX: { labelAngle: -30, grid: true }, axisY: { titlePadding: 12, gridDash: [3, 3] }, axisBand: { tickExtra: true } },
  { axisTop: { labelColor: 'blue' }, axisBottom: { offset: 3 }, axisLeft: { minExtent: 25 }, axisRight: { domain: false } },
  { style: { 'guide-label': { fill: 'purple', fontSize: 9 }, 'guide-title': { fontWeight: 'bold' } } },
  // blocks whose keys are read as flags (a truthy signal is a flag whatever it holds) and as label overlap, flush and alignment
  { axis: { titleColor: 'teal', labelFontSize: 10 }, axisX: { labels: false, labelFlush: 5, ticks: false, titleFont: 'serif' }, axisY: { domain: false, labelAlign: 'center', labelBaseline: 'top', labelBound: 2, labelColor: 'brown' }, style: { 'guide-label': { fill: 'purple', fontSize: 9 }, 'guide-title': { fontWeight: 'bold', fill: 'navy' } } },
  { axisTop: { grid: true, labelOverlap: 'parity', titleFontSize: 20 }, axisLeft: { labelFlush: 0, labelFontSize: 9, ticks: false }, axisBottom: { labelBound: true, domain: false, gridDash: [2, 2] }, axisRight: { labels: false, tickSize: 3, titleColor: 'green' }, axisBand: { labelOverlap: 'greedy', grid: true }, style: { 'guide-title': { fontSize: 13 } } },
]

/** An axis chart: a few axes of random orients over random scales, with random sizing and padding. */
export function axisCase(seed: number): GuideCase {
  const r = mulberry32(seed * 7919 + 17)
  const width = int(r, 80, 320)
  const height = int(r, 60, 240)
  const sx = positionScale(r, 'sx', 'width', ['linear', 'linear', 'band', 'point', 'time', 'utc', 'log', 'symlog', 'sqrt', 'pow'])
  const sy = positionScale(r, 'sy', 'height', ['linear', 'linear', 'band', 'point', 'log', 'time', 'sqrt'])
  const config = pick(r, AXIS_CONFIGS)
  const axes: Spec[] = []
  const nAxes = int(r, 1, 4)
  const used = new Set<string>()
  for (let i = 0; i < nAxes; i++) {
    const orient = pick(r, ['bottom', 'bottom', 'left', 'left', 'top', 'right'])
    // (two axes on one side are fine; the same guide twice is not interesting)
    const horizontal = orient === 'top' || orient === 'bottom'
    const own = horizontal ? sx : sy
    const other = horizontal ? sy : sx
    const props = axisProps(r, orient, own.kind, other)
    const signalOrient = chance(r, 0.2)
    const axis: Spec = { scale: own.name, orient: signalOrient ? { signal: JSON.stringify(orient) } : orient, ...props }
    axes.push(axis)
    used.add(orient)
  }
  const spec: Spec = {
    width, height, padding: pick(r, [0, 5, 20, { left: 4, top: 10, right: 0, bottom: 2 }]),
    autosize: pick(r, ['pad', 'pad', 'none', 'fit', { type: 'fit', contains: 'padding' }, { type: 'pad', resize: true }, 'fit-x', 'fit-y']),
    background: chance(r, 0.1) ? '#eef' : undefined,
    config,
    data: [{ name: 'rows', values: dataRows(r) }],
    scales: [sx.spec, sy.spec],
    axes,
    marks: chance(r, 0.6) ? [{ type: 'symbol', from: { data: 'rows' }, encode: { update: {
      x: { scale: 'sx', field: sx.kind === 'band' || sx.kind === 'point' ? 'c' : sx.kind === 'time' || sx.kind === 'utc' ? 't' : 'x', ...(sx.kind === 'band' ? { band: 0.5 } : {}) },
      y: { scale: 'sy', field: sy.kind === 'band' || sy.kind === 'point' ? 'c' : sy.kind === 'time' ? 't' : 'y', ...(sy.kind === 'band' ? { band: 0.5 } : {}) },
      size: { value: 40 }, fill: { value: 'steelblue' },
    } } }] : [],
  }
  if (spec.background === undefined) delete spec.background
  return { id: `axis-${seed}`, seed, spec, kind: `${sx.kind}/${sy.kind}` }
}

// --- legends ----------------------------------------------------------------------------------------------------------------

const LEGEND_ORIENTS = ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'] as const

function legendProps(r: Rand, type: string, scaleKinds: string[]): Spec {
  const l: Spec = {}
  const P = 0.3
  setIf(l, 'orient', maybe(r, 0.8, () => pick(r, LEGEND_ORIENTS)))
  setIf(l, 'direction', maybe(r, 0.4, () => pick(r, ['vertical', 'horizontal'])))
  setIf(l, 'offset', maybe(r, 0.3, () => pick(r, [0, 5, 20])))
  setIf(l, 'padding', maybe(r, 0.3, () => pick(r, [0, 3, 10])))
  setIf(l, 'cornerRadius', maybe(r, 0.2, () => pick(r, [0, 4, 10])))
  setIf(l, 'fillColor', maybe(r, 0.25, () => pick(r, COLORS)))
  setIf(l, 'strokeColor', maybe(r, 0.25, () => pick(r, COLORS)))
  setIf(l, 'legendX', maybe(r, 0.2, () => pick(r, [0, 10, 100])))
  setIf(l, 'legendY', maybe(r, 0.2, () => pick(r, [0, 10, 60])))
  setIf(l, 'title', maybe(r, 0.7, () => pick(r, ['Legend', 'A long legend title here', ['two', 'lines'], 'ü'])))
  setIf(l, 'titleOrient', maybe(r, 0.5, () => pick(r, ['top', 'left', 'right', 'bottom'])))
  setIf(l, 'titleAnchor', maybe(r, 0.4, () => pick(r, ['start', 'middle', 'end'])))
  setIf(l, 'titleAlign', maybe(r, 0.2, () => pick(r, ALIGN)))
  setIf(l, 'titleBaseline', maybe(r, 0.2, () => pick(r, BASELINE)))
  setIf(l, 'titleLimit', maybe(r, 0.25, () => pick(r, [20, 60, 300])))
  setIf(l, 'titlePadding', maybe(r, 0.3, () => pick(r, [0, 2, 12])))
  setIf(l, 'titleColor', maybe(r, 0.2, () => pick(r, COLORS)))
  setIf(l, 'titleOpacity', maybe(r, 0.1, () => 0.5))
  setIf(l, 'titleFont', maybe(r, 0.15, () => pick(r, FONTS)))
  setIf(l, 'titleFontSize', maybe(r, 0.3, () => pick(r, [9, 12, 17])))
  setIf(l, 'titleFontWeight', maybe(r, 0.2, () => pick(r, WEIGHTS)))
  setIf(l, 'titleFontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(l, 'titleLineHeight', maybe(r, 0.1, () => 20))
  setIf(l, 'labelColor', maybe(r, 0.25, () => pick(r, COLORS)))
  setIf(l, 'labelOpacity', maybe(r, 0.1, () => 0.5))
  setIf(l, 'labelFont', maybe(r, 0.15, () => pick(r, FONTS)))
  setIf(l, 'labelFontSize', maybe(r, 0.3, () => pick(r, [8, 11, 16])))
  setIf(l, 'labelFontWeight', maybe(r, 0.15, () => pick(r, WEIGHTS)))
  setIf(l, 'labelFontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(l, 'labelLimit', maybe(r, 0.25, () => pick(r, [10, 40, 200])))
  setIf(l, 'labelOffset', maybe(r, 0.3, () => pick(r, [0, 4, 12])))
  setIf(l, 'labelOverlap', maybe(r, 0.3, () => pick(r, [true, false, 'parity', 'greedy'])))
  setIf(l, 'labelSeparation', maybe(r, 0.15, () => pick(r, [0, 6, 20])))
  setIf(l, 'tickCount', maybe(r, 0.3, () => pick(r, [2, 3, 6, 10])))
  setIf(l, 'tickMinStep', maybe(r, 0.1, () => pick(r, [1, 20])))
  setIf(l, 'zindex', maybe(r, 0.2, () => pick(r, [0, 1])))
  if (chance(r, 0.08)) l.aria = false
  if (chance(r, 0.08)) l.description = 'a legend'
  if (type === 'symbol') {
    setIf(l, 'columns', maybe(r, 0.5, () => maybeSignal(r, pick(r, [0, 1, 2, 3, 5]), 0.1)))
    setIf(l, 'columnPadding', maybe(r, 0.4, () => pick(r, [0, 5, 20])))
    setIf(l, 'rowPadding', maybe(r, 0.4, () => pick(r, [0, 2, 12])))
    setIf(l, 'gridAlign', maybe(r, 0.3, () => pick(r, ['all', 'each', 'none'])))
    setIf(l, 'clipHeight', maybe(r, 0.25, () => pick(r, [10, 20, 40])))
    setIf(l, 'symbolType', maybe(r, 0.4, () => pick(r, ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'stroke', 'M0,0L8,0L4,6Z'])))
    setIf(l, 'symbolSize', maybe(r, 0.4, () => pick(r, [20, 100, 300])))
    setIf(l, 'symbolFillColor', maybe(r, 0.3, () => pick(r, COLORS)))
    setIf(l, 'symbolStrokeColor', maybe(r, 0.3, () => pick(r, COLORS)))
    setIf(l, 'symbolStrokeWidth', maybe(r, 0.3, () => pick(r, [0, 1, 3])))
    setIf(l, 'symbolOffset', maybe(r, 0.3, () => pick(r, [0, 5, 12])))
    setIf(l, 'symbolOpacity', maybe(r, 0.15, () => 0.5))
    setIf(l, 'symbolDash', maybe(r, 0.1, () => [2, 2]))
    setIf(l, 'symbolDashOffset', maybe(r, 0.05, () => 1))
    setIf(l, 'symbolLimit', maybe(r, 0.15, () => pick(r, [2, 3, 5])))
    setIf(l, 'labelAlign', maybe(r, 0.15, () => pick(r, ALIGN)))
    setIf(l, 'labelBaseline', maybe(r, 0.15, () => pick(r, BASELINE)))
  } else {
    setIf(l, 'gradientLength', maybe(r, 0.5, () => pick(r, [60, 120, 300])))
    setIf(l, 'gradientThickness', maybe(r, 0.4, () => pick(r, [6, 16, 30])))
    setIf(l, 'gradientStrokeColor', maybe(r, 0.3, () => pick(r, COLORS)))
    setIf(l, 'gradientStrokeWidth', maybe(r, 0.3, () => pick(r, [0, 1, 3])))
    setIf(l, 'gradientOpacity', maybe(r, 0.15, () => 0.7))
    if (scaleKinds.includes('time')) setIf(l, 'format', maybe(r, 0.5, () => pick(r, TIME_FORMATS)))
    else setIf(l, 'format', maybe(r, 0.5, () => pick(r, NUMBER_FORMATS)))
    setIf(l, 'formatType', maybe(r, 0.15, () => (scaleKinds.includes('time') ? 'time' : 'number')))
  }
  if (type === 'symbol') {
    setIf(l, 'format', maybe(r, 0.3, () => pick(r, NUMBER_FORMATS)))
    if (chance(r, 0.1)) l.values = [pick(r, [1, 2]), pick(r, [3, 4]), pick(r, [5, 6])]
  }
  if (chance(r, 0.12)) {
    const part = pick(r, type === 'symbol' ? ['legend', 'title', 'labels', 'symbols', 'entries'] : ['legend', 'title', 'labels', 'gradient'])
    const e: Spec = {}
    if (chance(r, 0.5)) e.name = 'p' + part
    if (chance(r, 0.4)) e.interactive = true
    if (chance(r, 0.5)) e.update = { opacity: { value: 0.8 } }
    if (chance(r, 0.3)) e.enter = { strokeWidth: { value: 2 }, stroke: { value: 'green' } }
    l.encode = { [part]: e }
  }
  void P
  return l
}

const LEGEND_CONFIGS: Spec[] = [
  {},
  { legend: { layout: { anchor: 'middle', margin: 12 } } },
  { legend: { layout: { left: { anchor: 'end', direction: 'horizontal', bounds: 'full' }, right: { offset: 4, margin: 3, center: true } }, symbolBaseFillColor: 'tomato', symbolBaseStrokeColor: '#222' } },
  { legend: { layout: { top: { frame: 'bounds', anchor: 'middle', bounds: 'full' }, bottom: { direction: 'vertical', center: { row: true, column: true } } }, titleFontSize: 14, labelFontSize: 10, padding: 6, gradientDirection: 'horizontal', symbolDirection: 'horizontal' } },
  { legend: { orient: 'bottom', columns: 2, symbolType: 'diamond', rowPadding: 4, columnPadding: 9, cornerRadius: 5, fillColor: '#fafafa', strokeColor: '#999' } },
]

/** A chart of one to four legends over color, size, shape and opacity scales of every kind. */
export function legendCase(seed: number): GuideCase {
  const r = mulberry32(seed * 104729 + 3)
  const width = int(r, 120, 360)
  const height = int(r, 90, 260)
  const nLegends = chance(r, 0.55) ? 1 : int(r, 2, 4)
  const scales: Spec[] = []
  const legends: Spec[] = []
  const kinds: string[] = []
  const cats = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
  for (let i = 0; i < nLegends; i++) {
    const channel = pick(r, ['fill', 'fill', 'stroke', 'size', 'shape', 'opacity', 'strokeWidth', 'strokeDash', 'fill+size'])
    const color = channel === 'fill' || channel === 'stroke' || channel === 'fill+size'
    const kind = pick(r, color
      ? ['ordinal', 'linear', 'sqrt', 'log', 'time', 'quantize', 'quantile', 'threshold', 'bin-ordinal', 'sequential']
      : ['ordinal', 'linear', 'sqrt', 'log', 'time', 'quantize', 'quantile', 'threshold', 'bin-ordinal'])
    const name = `s${i}`
    const ncat = int(r, 1, cats.length)
    let scale: Spec
    let sk = kind
    const isColor = channel === 'fill' || channel === 'stroke' || channel === 'fill+size'
    const num = (): Spec => ({ type: 'linear', domain: [pick(r, [0, -10, 1]), pick(r, [10, 100, 12345])] })
    const range: unknown = channel === 'size' ? [20, pick(r, [200, 600])]
      : channel === 'fill+size' || isColor ? (kind === 'ordinal' || kind === 'point' || kind === 'band' ? { scheme: pick(r, ['category10', 'tableau10', 'set2']) } : { scheme: pick(r, ['blues', 'viridis', 'redyellowblue', 'plasma']) })
      : channel === 'shape' ? ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'wedge']
      : channel === 'opacity' ? [0.2, 1]
      : channel === 'strokeWidth' ? [1, 6]
      : [[1, 0], [4, 2], [6, 3, 1, 3], [2, 2], [8, 4], [3, 3, 1, 3], [1, 1]]
    switch (kind) {
      case 'ordinal': case 'point': case 'band': case 'bin-ordinal':
        scale = { type: kind === 'bin-ordinal' ? 'bin-ordinal' : kind, domain: kind === 'bin-ordinal' ? [0, 10, 20, 30, 40].slice(0, ncat + 2) : cats.slice(0, ncat), range }
        if (kind === 'point' || kind === 'band') scale.range = isColor ? { scheme: 'blues' } : [0, 100]
        break
      case 'quantize': scale = { type: 'quantize', domain: [0, 100], range: isColor ? { scheme: 'blues', count: int(r, 2, 7) } : channel === 'shape' || channel === 'strokeDash' ? range : [1, 2, 3, 4].slice(0, int(r, 2, 4)).map((v) => v * (channel === 'size' ? 100 : 0.25)) }; break
      case 'quantile': scale = { type: 'quantile', domain: { data: 'rows', field: 'x' }, range: isColor ? { scheme: 'blues', count: int(r, 2, 6) } : [0.2, 0.5, 0.8, 1] }; break
      case 'threshold': scale = { type: 'threshold', domain: [10, 30, 70].slice(0, int(r, 1, 3)), range: isColor ? ['#eee', '#aaa', '#555', '#000'] : [0.2, 0.4, 0.6, 1] }; break
      case 'time': scale = { type: 'time', domain: [T0, T0 + 800 * DAY], range: isColor ? { scheme: 'viridis' } : [10, 100] }; break
      case 'log': scale = { type: 'log', domain: [1, 1000], range: isColor ? { scheme: 'blues' } : [1, 100] }; break
      case 'sequential': scale = { type: 'sequential', domain: [0, 100], range: { scheme: 'magma' } }; break
      default: scale = { ...num(), type: kind, range: isColor ? { scheme: 'blues' } : channel === 'shape' ? undefined : range }
    }
    if (scale.range === undefined) delete scale.range
    if ((channel === 'shape' || channel === 'strokeDash') && !['ordinal', 'quantize', 'threshold', 'bin-ordinal', 'quantile'].includes(kind)) {
      scale = { type: 'ordinal', domain: cats.slice(0, ncat), range }
      sk = 'ordinal'
    }
    if (chance(r, 0.15)) scale.zero = false
    if (chance(r, 0.3) && (scale.type === 'linear' || scale.type === 'sqrt')) scale.nice = true
    scales.push({ name, ...scale })
    kinds.push(`${channel}:${sk}`)
    // (a gradient legend is for a scale with a continuous or discretizing range)
    const type = pick(r, sk === 'ordinal' || sk === 'bin-ordinal' && false ? [undefined, 'symbol'] : [undefined, undefined, 'symbol', 'gradient', 'gradient', 'symbol'])
    const effective = type ?? 'symbol'
    const legend: Spec = {}
    if (channel === 'fill+size') { legend.fill = name; legend.size = name } else legend[channel] = name
    if (type) legend.type = type
    if (channel === 'fill' && !type && chance(r, 0.5)) delete legend.type
    Object.assign(legend, legendProps(r, effective === 'gradient' ? 'gradient' : 'symbol', [sk]))
    legends.push(legend)
  }
  const spec: Spec = {
    width, height, padding: pick(r, [0, 5, 20]),
    // (vega's `pad` autosize does not grow the view for an `orient: none` legend that overflows it; Aster's does, see the report)
    autosize: legends.some((l) => l.orient === 'none') && !G('none') ? 'none' : pick(r, ['pad', 'pad', 'none', 'fit', 'fit-x', 'fit-y', { type: 'fit', contains: 'padding' }]),
    config: pick(r, LEGEND_CONFIGS),
    data: [{ name: 'rows', values: dataRows(r) }],
    scales, legends,
    marks: chance(r, 0.4) ? [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: 'width' }, height: { signal: 'height' }, fill: { value: '#f4f4f4' } } } }] : [],
  }
  return { id: `legend-${seed}`, seed, spec, kind: kinds.join(',') }
}

// --- grids of groups -----------------------------------------------------------------------------------------------------------

function alignValue(r: Rand): unknown {
  return pick(r, ['all', 'each', 'none', { row: pick(r, ['all', 'each', 'none']), column: pick(r, ['all', 'each', 'none']) }])
}

function titleSpec(r: Rand, text: string, extra: Spec = {}): Spec {
  const t: Spec = { text, ...extra }
  setIf(t, 'anchor', maybe(r, 0.4, () => pick(r, ['start', 'middle', 'end'])))
  setIf(t, 'orient', maybe(r, 0.4, () => pick(r, ['top', 'bottom', 'left', 'right'])))
  setIf(t, 'frame', maybe(r, 0.3, () => pick(r, ['bounds', 'group'])))
  setIf(t, 'offset', maybe(r, 0.4, () => pick(r, [0, 4, 12, -3])))
  setIf(t, 'fontSize', maybe(r, 0.3, () => pick(r, [9, 12, 18])))
  setIf(t, 'subtitle', maybe(r, 0.25, () => pick(r, ['sub', ['two', 'line sub']])))
  setIf(t, 'subtitlePadding', maybe(r, 0.2, () => pick(r, [0, 4, 10])))
  setIf(t, 'limit', maybe(r, 0.1, () => pick(r, [20, 100])))
  setIf(t, 'angle', maybe(r, 0.1, () => 45))
  setIf(t, 'dx', maybe(r, 0.1, () => 3))
  setIf(t, 'dy', maybe(r, 0.1, () => -3))
  return t
}

/** An inner cell: marks plus optional axes and legends inside it. */
function cellContent(r: Rand, depth: number, cellW: number, cellH: number): Spec {
  const content: Spec = {}
  const marks: Spec[] = [{ type: 'rect', from: { data: 'cell' }, encode: { update: { x: { scale: 'cx', field: 'x' }, y: { scale: 'cy', field: 'y' }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'steelblue' } } } }]
  if (depth > 0 && chance(r, 0.3)) {
    marks.push({
      type: 'group', encode: { update: { x: { value: 3 }, y: { value: 3 }, width: { value: Math.max(10, cellW / 3) }, height: { value: Math.max(10, cellH / 3) }, stroke: { value: '#888' } } },
      marks: [{ type: 'symbol', encode: { update: { x: { value: 4 }, y: { value: 4 }, fill: { value: 'tomato' } } } }],
    })
  }
  content.marks = marks
  const axes: Spec[] = []
  if (chance(r, 0.6)) axes.push({ scale: 'cx', orient: pick(r, ['bottom', 'top']), ...(chance(r, 0.5) ? { grid: true } : {}), ...(chance(r, 0.4) ? { title: 'X' } : {}), ...(chance(r, 0.3) ? { tickCount: 3 } : {}) })
  if (chance(r, 0.6)) axes.push({ scale: 'cy', orient: pick(r, ['left', 'right']), ...(chance(r, 0.5) ? { grid: true } : {}), ...(chance(r, 0.4) ? { title: 'Y' } : {}), ...(chance(r, 0.3) ? { labelFlush: true } : {}) })
  if (axes.length) content.axes = axes
  if (chance(r, 0.2)) content.legends = [{ fill: 'cc', orient: pick(r, G('none6') ? ['right', 'bottom', 'top-left', 'top-right', 'bottom-left', 'none'] : ['right', 'bottom', 'top-left', 'top-right', 'bottom-left']), title: 'L' }]
  return content
}

function cellScopeScales(width: unknown, height: unknown): Spec[] {
  return [
    { name: 'cx', type: 'linear', domain: [0, 100], range: [0, width] },
    { name: 'cy', type: 'linear', domain: [0, 100], range: [height, 0] },
    { name: 'cc', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
  ]
}

/** A facet (or a hand-made grid of groups) with headers, footers and titles, laid out by `layout`. */
export function trellisCase(seed: number): GuideCase {
  const r = mulberry32(seed * 15485863 + 5)
  const nCats = int(r, 1, 7)
  const nRows = chance(r, 0.5) ? int(r, 1, 4) : 1
  const cw = int(r, 30, 90)
  const ch = int(r, 25, 70)
  const cats = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, nCats)
  const rowCats = ['r1', 'r2', 'r3', 'r4'].slice(0, nRows)
  const values: Spec[] = []
  for (const c of cats) for (const rc of rowCats) for (let i = 0; i < int(r, 1, 4); i++) values.push({ c, rc, x: int(r, 0, 100), y: int(r, 0, 100) })
  const twoD = nRows > 1 || chance(r, 0.3)
  const headers: Spec[] = []
  const layout: Spec = {}
  setIf(layout, 'padding', maybe(r, 0.7, () => (chance(r, 0.5) ? pick(r, [0, 5, 15]) : { row: pick(r, [0, 4, 20]), column: pick(r, [0, 8, 25]) })))
  setIf(layout, 'bounds', maybe(r, 0.6, () => pick(r, ['full', 'flush'])))
  setIf(layout, 'align', maybe(r, 0.7, () => alignValue(r)))
  setIf(layout, 'center', maybe(r, 0.5, () => (chance(r, 0.5) ? chance(r, 0.5) : { row: chance(r, 0.5), column: chance(r, 0.5) })))
  if (!twoD) setIf(layout, 'columns', maybe(r, 0.8, () => pick(r, [1, 2, 3, 4, 0])))
  else layout.columns = nCats
  setIf(layout, 'headerBand', maybe(r, 0.3, () => (chance(r, 0.5) ? pick(r, [0, 0.5, 1]) : { row: pick(r, [0, 0.5, 1]), column: pick(r, [0, 0.5, 1]) })))
  setIf(layout, 'footerBand', maybe(r, 0.3, () => (chance(r, 0.5) ? pick(r, [0, 0.5, 1]) : { row: pick(r, [0, 0.5, 1]), column: pick(r, [0, 0.5, 1]) })))
  setIf(layout, 'titleBand', maybe(r, 0.3, () => (chance(r, 0.5) ? pick(r, [0, 0.5, 1]) : { row: pick(r, [0, 0.5, 1]), column: pick(r, [0, 0.5, 1]) })))
  setIf(layout, 'titleAnchor', maybe(r, 0.3, () => (chance(r, 0.5) ? pick(r, ['start', 'end']) : { row: pick(r, ['start', 'end']), column: pick(r, ['start', 'end']) })))
  setIf(layout, 'offset', maybe(r, 0.5, () => ({
    ...(chance(r, 0.6) ? { rowHeader: pick(r, [0, 4, 10]) } : {}), ...(chance(r, 0.6) ? { columnHeader: pick(r, [0, 4, 10]) } : {}),
    ...(chance(r, 0.6) ? { rowFooter: pick(r, [0, 4, 10]) } : {}), ...(chance(r, 0.6) ? { columnFooter: pick(r, [0, 4, 10]) } : {}),
    ...(chance(r, 0.6) ? { rowTitle: pick(r, [0, 6, 14]) } : {}), ...(chance(r, 0.6) ? { columnTitle: pick(r, [0, 6, 14]) } : {}),
  })))
  const inCell = cellContent(r, 1, cw, ch)
  const facetField = twoD ? { aggregate: { cross: true }, groupby: ['c', 'rc'] } : { groupby: 'c' }
  const colData = { name: 'colDomain', source: 'rows', transform: [{ type: 'aggregate', groupby: ['c'] }] }
  const rowData = { name: 'rowDomain', source: 'rows', transform: [{ type: 'aggregate', groupby: ['rc'] }] }
  const marks: Spec[] = []
  // headers, footers and titles of the columns (and of the rows when there are some)
  const hdr = (role: string, ds: string, field: string, orient: string, withText: boolean): Spec => ({
    type: 'group', role, from: { data: ds },
    sort: { field: `datum["${field}"]`, order: 'ascending' },
    title: withText ? titleSpec(r, `${field}: ` + '"x"', { orient, text: { signal: `parent["${field}"]` }, anchor: pick(r, ['start', 'middle', 'end']) }) : undefined,
    encode: { update: { width: { signal: 'child_width' } , ...(chance(r, 0.3) ? { height: { value: int(r, 5, 25) } } : {}) } },
    ...(chance(r, 0.35) ? { axes: [{ scale: role.includes('column') ? 'cx' : 'cy', orient: role.includes('column') ? pick(r, ['top', 'bottom']) : pick(r, ['left', 'right']), domain: chance(r, 0.5), labels: chance(r, 0.5), ticks: chance(r, 0.5) }] } : {}),
  })
  // (a header per column: more headers than the grid has columns are dropped by the layout, a situation of its own that vega-lite never makes)
  const columnsFit = G('cols') || layout.columns === undefined || layout.columns === 0 || (layout.columns as number) >= nCats
  const chooseHeaders = (): void => {
    if (!columnsFit) return
    if (chance(r, 0.6)) marks.push(hdr('column-header', 'colDomain', 'c', 'top', true))
    if (chance(r, 0.3)) marks.push(hdr('column-footer', 'colDomain', 'c', 'bottom', chance(r, 0.5)))
    if (twoD && chance(r, 0.6)) marks.push(hdr('row-header', 'rowDomain', 'rc', 'left', true))
    if (twoD && chance(r, 0.3)) marks.push(hdr('row-footer', 'rowDomain', 'rc', 'right', chance(r, 0.5)))
  }
  chooseHeaders()
  for (const m of marks) if (m.title === undefined) delete m.title
  const titles: Spec[] = []
  if (chance(r, 0.5)) titles.push({ type: 'group', role: 'column-title', title: titleSpec(r, 'Columns', { orient: 'top', frame: 'group', anchor: 'middle' }) })
  if (twoD && chance(r, 0.5)) titles.push({ type: 'group', role: 'row-title', title: titleSpec(r, 'Rows', { orient: 'left', frame: 'group', anchor: 'middle' }) })
  for (const t of titles) {
    // (the title mark of a facet: the group has nothing but a title)
    const tt = t.title as Spec
    if (tt.anchor === undefined) tt.anchor = 'middle'
  }
  const cell: Spec = {
    type: 'group', name: 'cells', style: 'cell',
    from: { facet: { name: 'cell', data: 'rows', ...facetField } },
    ...(chance(r, 0.4) ? { title: titleSpec(r, 'cell', { text: { signal: 'parent.c' } }) } : {}),
    sort: chance(r, 0.5) ? { field: ['datum.c', 'datum.rc'], order: ['ascending', 'ascending'] } : undefined,
    encode: { update: {
      width: { value: cw }, height: { value: ch },
      ...(chance(r, 0.4) ? { stroke: { value: '#ccc' } } : {}), ...(chance(r, 0.3) ? { fill: { value: '#fafafa' } } : {}), ...(chance(r, 0.1) ? { clip: { value: true } } : {}),
    } },
    scales: cellScopeScales(cw, ch),
    ...inCell,
  }
  if (cell.sort === undefined) delete cell.sort
  const data = [{ name: 'rows', values }, colData, ...(twoD ? [rowData] : [])]
  const frame: Spec = {
    type: 'group', name: 'frame',
    encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } },
    signals: [{ name: 'child_width', value: cw }, { name: 'child_height', value: ch }],
    scales: cellScopeScales(cw, ch),
    layout, marks: [...marks, ...titles, cell],
    ...(chance(r, 0.4) ? { title: titleSpec(r, 'Frame title') } : {}),
  }
  const spec: Spec = {
    width: 200, height: 120, padding: pick(r, [0, 5, 12]),
    autosize: pick(r, ['pad', 'none', 'pad', { type: 'pad', resize: true }, 'fit', 'fit-x', 'fit-y', { type: 'fit', contains: 'padding' }]),
    data, marks: [frame],
  }
  return { id: `trellis-${seed}`, seed, spec, kind: twoD ? 'cross' : 'wrap' }
}

// --- titles --------------------------------------------------------------------------------------------------------------------

/** A chart whose view title (and subtitle) is given every property a title has, against axes and a legend that widen the view bounds. */
export function titleCase(seed: number): GuideCase {
  const r = mulberry32(seed * 49979687 + 11)
  const t: Spec = { text: pick(r, ['A title', ['two', 'lines'], 'A much longer title than the others, to cut']) }
  setIf(t, 'subtitle', maybe(r, 0.5, () => pick(r, ['a subtitle', ['sub', 'lines'], 'x'])))
  setIf(t, 'orient', maybe(r, 0.8, () => pick(r, ['top', 'bottom', 'left', 'right'])))
  setIf(t, 'anchor', maybe(r, 0.7, () => pick(r, ['start', 'middle', 'end'])))
  setIf(t, 'frame', maybe(r, 0.6, () => pick(r, ['bounds', 'group'])))
  setIf(t, 'offset', maybe(r, 0.6, () => pick(r, [0, 5, 20, -4])))
  setIf(t, 'subtitlePadding', maybe(r, 0.4, () => pick(r, [0, 3, 12])))
  setIf(t, 'limit', maybe(r, 0.3, () => pick(r, [20, 80, 400])))
  setIf(t, 'angle', maybe(r, 0.2, () => pick(r, [0, 30, 90])))
  setIf(t, 'align', maybe(r, 0.2, () => pick(r, ALIGN)))
  setIf(t, 'baseline', maybe(r, 0.2, () => pick(r, BASELINE)))
  setIf(t, 'dx', maybe(r, 0.2, () => pick(r, [-5, 7])))
  setIf(t, 'dy', maybe(r, 0.2, () => pick(r, [-5, 7])))
  setIf(t, 'color', maybe(r, 0.3, () => pick(r, COLORS)))
  setIf(t, 'font', maybe(r, 0.2, () => pick(r, FONTS)))
  setIf(t, 'fontSize', maybe(r, 0.4, () => pick(r, [9, 14, 22])))
  setIf(t, 'fontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(t, 'fontWeight', maybe(r, 0.3, () => pick(r, WEIGHTS)))
  setIf(t, 'lineHeight', maybe(r, 0.2, () => pick(r, [12, 26])))
  setIf(t, 'subtitleColor', maybe(r, 0.3, () => pick(r, COLORS)))
  setIf(t, 'subtitleFont', maybe(r, 0.2, () => pick(r, FONTS)))
  setIf(t, 'subtitleFontSize', maybe(r, 0.3, () => pick(r, [8, 12, 18])))
  setIf(t, 'subtitleFontStyle', maybe(r, 0.1, () => 'italic'))
  setIf(t, 'subtitleFontWeight', maybe(r, 0.2, () => pick(r, WEIGHTS)))
  setIf(t, 'subtitleLineHeight', maybe(r, 0.2, () => pick(r, [10, 24])))
  if (chance(r, 0.15)) t.zindex = pick(r, [0, 1])
  if (chance(r, 0.1)) t.aria = false
  if (chance(r, 0.1)) t.description = 'a title'
  if (chance(r, 0.2)) t.style = pick(r, ['guide-title', 'guide-label'])
  if (chance(r, 0.2)) {
    const part = pick(r, ['group', 'title', 'subtitle'])
    const e: Spec = {}
    if (chance(r, 0.5)) e.name = 'p' + part
    if (chance(r, 0.4)) e.interactive = true
    if (chance(r, 0.5)) e.update = { opacity: { value: 0.8 } }
    if (chance(r, 0.3)) e.enter = { fill: { value: 'green' } }
    t.encode = { [part]: e }
  }
  const width = int(r, 100, 300)
  const height = int(r, 80, 220)
  const spec: Spec = {
    width, height, padding: pick(r, [0, 5, 20]), autosize: pick(r, ['pad', 'pad', 'none', { type: 'pad', resize: true }]),
    config: pick(r, [{}, { title: { color: 'steelblue', fontSize: 16, anchor: 'start', offset: 7 } }, { style: { 'group-title': { fontWeight: 'normal' }, 'group-subtitle': { fill: 'gray' } } }]),
    title: t,
    data: [{ name: 'rows', values: dataRows(r) }],
    scales: [
      { name: 'sx', type: 'linear', domain: { data: 'rows', field: 'x' }, range: 'width' },
      { name: 'sy', type: 'linear', domain: { data: 'rows', field: 'y' }, range: 'height' },
      { name: 'cc', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
    ],
    axes: [{ scale: 'sx', orient: 'bottom', title: 'x' }, { scale: 'sy', orient: pick(r, ['left', 'right']), title: 'y' }],
    legends: chance(r, 0.5) ? [{ fill: 'cc', orient: pick(r, ['right', 'bottom', 'top-left']), title: 'legend' }] : [],
  }
  return { id: `title-${seed}`, seed, spec, kind: String(t.orient ?? 'top') }
}
