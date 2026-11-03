/**
 * Generated specs whose marks are painted with the gradient of a scale: `{gradient: <scale>, start, stop, count}` entries and
 * `gradient(scale, start, stop, count)` expressions, over the kinds of scale there are (continuous, sequential, discretizing,
 * discrete), the options of the entry, the marks that paint, and the ways to name the scale. Shared by the SVG differential
 * (differential-gradient.test.mts, in jsdom) and the canvas one (browser-canvas-parity.mts, in Chromium).
 */
import { makeRng, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

const COLORS = ['#e45756', '#4c78a8', '#f58518', '#54a24b', 'purple', 'gold', 'teal']

/** A scale named `g` of a random kind (and a domain for it to draw its gradient over). */
function scaleOf(r: Rng): { scale: Spec; kind: string } {
  const colors = (n: number): string[] => Array.from({ length: n }, () => r.pick(COLORS))
  const interp = r.pick<Spec | undefined>([undefined, undefined, { interpolate: 'hcl' }, { interpolate: 'lab' }, { interpolate: 'hsl' }, { interpolate: { type: 'rgb', gamma: 2 } }])
  const kind = r.pick([
    'linear', 'linear', 'linear', 'pow', 'sqrt', 'log', 'symlog', 'time', 'utc', 'sequential', 'sequential', 'identity',
    'quantize', 'quantile', 'threshold', 'bin-ordinal', 'ordinal', 'band', 'point', 'linear-flat', 'linear-reversed', 'sequential-flat',
  ])
  const n = r.between(2, 4)
  switch (kind) {
    case 'log': return { kind, scale: { name: 'g', type: 'log', domain: r.pick([[1, 100], [0.5, 50], [10, 10000]]), range: colors(n), ...interp, ...(r.chance(0.3) ? { base: 2 } : {}) } }
    case 'pow': return { kind, scale: { name: 'g', type: 'pow', exponent: r.pick([0.5, 2, 3]), domain: [0, r.pick([10, 100])], range: colors(n), ...interp } }
    case 'sqrt': return { kind, scale: { name: 'g', type: 'sqrt', domain: [0, r.pick([10, 100])], range: colors(n), ...interp } }
    case 'symlog': return { kind, scale: { name: 'g', type: 'symlog', domain: [-20, 100], range: colors(n), ...interp } }
    case 'time': return { kind, scale: { name: 'g', type: 'time', domain: [Date.UTC(2020, 0, 1), Date.UTC(2021, 5, 1)], range: colors(n), ...interp } }
    case 'utc': return { kind, scale: { name: 'g', type: 'utc', domain: [Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 20)], range: colors(n) } }
    case 'sequential': return { kind, scale: { name: 'g', type: 'sequential', domain: r.pick([[0, 10], [5, 50], [-3, 3]]), range: { scheme: r.pick(['blues', 'viridis', 'magma', 'greens', 'inferno', 'turbo']) } } }
    case 'identity': return { kind, scale: { name: 'g', type: 'identity', domain: [0, 4] } }
    case 'quantize': return { kind, scale: { name: 'g', type: 'quantize', domain: [0, r.pick([10, 100])], range: colors(r.between(2, 6)) } }
    case 'quantile': return { kind, scale: { name: 'g', type: 'quantile', domain: [1, 2, 3, 5, 8, 13, 21, 34], range: colors(r.between(2, 5)) } }
    case 'threshold': return { kind, scale: { name: 'g', type: 'threshold', domain: r.pick([[3, 6], [1, 4, 9]]), range: colors(r.pick([3, 4])) } }
    case 'bin-ordinal': return { kind, scale: { name: 'g', type: 'bin-ordinal', domain: { binned: true, step: 5, start: 0, stop: 20 } as unknown as number[], range: colors(4) } }
    case 'ordinal': return { kind, scale: { name: 'g', type: 'ordinal', domain: r.pick([['a', 'b', 'c'], [1, 2, 3, 4], [0, 10]]), range: colors(r.between(2, 4)) } }
    case 'band': return { kind, scale: { name: 'g', type: 'band', domain: r.pick([['a', 'b', 'c'], [1, 2, 3]]), range: colors(3) } }
    case 'point': return { kind, scale: { name: 'g', type: 'point', domain: ['a', 'b', 'c', 'd'], range: colors(4) } }
    case 'linear-flat': return { kind, scale: { name: 'g', type: 'linear', domain: [5, 5], range: colors(2), ...interp } }
    case 'linear-reversed': return { kind, scale: { name: 'g', type: 'linear', domain: [10, 0], range: colors(n), ...interp } }
    case 'sequential-flat': return { kind, scale: { name: 'g', type: 'sequential', domain: [3, 3], range: { scheme: 'blues' } } }
    default: return { kind, scale: { name: 'g', type: 'linear', domain: r.pick([[0, 10], [0, 1], [-5, 5], [0, 100], [0.5, 0.75]]), range: colors(n), ...interp, ...(r.chance(0.2) ? { clamp: true } : {}) } }
  }
}

const POINT = [0, 0.25, 0.5, 0.75, 1, 0.1, -0.5, 1.5]

/** The options of a gradient entry: which of start, stop and count are given, and with what. */
function options(r: Rng): { start?: number[]; stop?: number[]; count?: unknown } {
  const o: { start?: number[]; stop?: number[]; count?: unknown } = {}
  if (r.chance(0.5)) o.start = [r.pick(POINT), r.pick(POINT)]
  if (r.chance(0.5)) o.stop = [r.pick(POINT), r.pick(POINT)]
  if (r.chance(0.5)) o.count = r.pick([0, 1, 2, 3, 5, 8, 15, 40, 100, '4', -2, null])
  // (a count after a start or a stop that is not there is `gradient("g",,5)`, a syntax error of vega's: some specs have it, most do not)
  if (o.count !== undefined && r.chance(0.9)) {
    o.start ??= [r.pick(POINT), r.pick(POINT)]
    o.stop ??= [r.pick(POINT), r.pick(POINT)]
  }
  return o
}

/** The paint of a channel from the gradient of the scale: an entry of one of its shapes, or an expression. */
function paint(r: Rng, kind: string): unknown {
  const o = options(r)
  // (a gradient that fails in a signal that is made after the scales stops the pass where the marks that read it are ranked: not what is judged here)
  const failsInSignal = kind === 'ordinal' || kind === 'band' || kind === 'point'
  const form = r.pick(['entry', 'entry', 'entry', 'signal-name', 'field-name', 'expression', 'expression-signal-args', 'conditional', 'radial', 'radial', ...(failsInSignal ? [] : ['shared'])])
  const args = [o.start, o.stop, o.count]
  while (args.length && args[args.length - 1] === undefined) args.pop()
  const call = `gradient('g'${args.length ? ', ' + args.map((a) => (a === undefined ? 'null' : JSON.stringify(a))).join(', ') : ''})`
  switch (form) {
    case 'signal-name': return { gradient: { signal: "'g'" }, ...o }
    case 'field-name': return { gradient: { datum: 'sname' }, ...o }
    case 'expression': return { signal: call }
    case 'expression-signal-args': return { signal: `gradient('g', [0, 0], [${r.pick(['kx', '1 - kx', 'kx / 2'])}, 1], ${r.pick(['kc', '3', 'kc * 2'])})` }
    case 'conditional': return [{ test: 'datum.a > 1', gradient: 'g', ...o }, { value: r.pick(COLORS) }]
    case 'shared': return { signal: 'shared' }
    // (the stops of a scale, as a radial gradient: the object `gradient()` makes is an object like any other)
    case 'radial': {
      const at = r.pick(['0.5', '0.3', '0.7'])
      const radial = r.pick([`{gradient: 'radial'}`, `{gradient: 'radial', x1: ${at}, y1: ${at}, r1: 0.05, x2: 0.5, y2: 0.5, r2: ${r.pick(['0.5', '0.8'])}}`, `{gradient: 'radial', r1: 0.2, r2: 0.6}`])
      return { signal: `merge(${call}, ${radial})` }
    }
    default: return { gradient: 'g', ...o, ...(kind === 'ordinal' && r.chance(0.2) ? { value: 'red' } : {}) }
  }
}

const MARKS: Array<{ type: string; fill: boolean; stroke: boolean; base: Record<string, unknown> }> = [
  { type: 'rect', fill: true, stroke: true, base: { width: { value: 24 }, height: { value: 30 } } },
  { type: 'symbol', fill: true, stroke: true, base: { size: { value: 1200 } } },
  { type: 'area', fill: true, stroke: true, base: { y2: { value: 55 } } },
  { type: 'line', fill: false, stroke: true, base: { strokeWidth: { value: 6 } } },
  { type: 'text', fill: true, stroke: false, base: { text: { value: 'Gg' }, fontSize: { value: 28 }, fontWeight: { value: 'bold' } } },
  { type: 'rule', fill: false, stroke: true, base: { x2: { value: 40 }, strokeWidth: { value: 8 } } },
  { type: 'arc', fill: true, stroke: true, base: { innerRadius: { value: 6 }, outerRadius: { value: 22 }, startAngle: { value: 0 }, endAngle: { value: 4 } } },
  { type: 'trail', fill: true, stroke: false, base: { size: { value: 8 } } },
  { type: 'path', fill: true, stroke: true, base: { path: { value: 'M0,0L30,5L20,30Z' } } },
  { type: 'group', fill: true, stroke: true, base: { width: { value: 40 }, height: { value: 40 } } },
]

export interface GradientCase {
  label: string
  spec: Spec
  /** the kind of scale (what `scaleOf` drew) */
  kind: string
}

/** The kinds whose stops are not colours a canvas can take (a number is no colour: `addColorStop` throws, in vega's canvas too). */
export const UNPAINTABLE_KINDS: ReadonlySet<string> = new Set(['identity', 'band', 'point'])

export function gradientSpec(r: Rng): GradientCase {
  const { scale, kind } = scaleOf(r)
  const marks: Spec[] = []
  const labels: string[] = []
  const count = r.between(1, 3)
  for (let i = 0; i < count; i++) {
    const m = r.pick(MARKS)
    const update: Record<string, unknown> = { x: { scale: 'x', field: 'a' }, y: { value: 10 + i * 12 }, ...m.base }
    const channels: string[] = []
    if (m.fill && (!m.stroke || r.chance(0.7))) channels.push('fill')
    if (m.stroke && (!m.fill || r.chance(0.5) || channels.length === 0)) channels.push('stroke')
    for (const ch of channels) update[ch] = paint(r, kind)
    if (channels.includes('stroke') && m.type !== 'line' && m.type !== 'rule') update.strokeWidth = { value: r.pick([1, 3]) }
    labels.push(`${m.type}(${channels.join('+')})`)
    marks.push({ type: m.type, from: { data: 't' }, encode: { update } })
  }
  const spec: Spec = {
    // (with `pad` the view grows to the bounds of what it holds: a gradient must not change them)
    width: 150, height: 70, padding: r.pick([0, 4, 10]), autosize: r.pick(['none', 'pad', 'pad']),
    signals: [
      { name: 'kx', value: r.pick([0.5, 1, 0.2]) }, { name: 'kc', value: r.pick([2, 4, 7]) },
      { name: 'shared', update: "gradient('g', [0, 0], [0, 1], 4)" },
    ],
    data: [{ name: 't', values: [{ a: 1, sname: 'g' }, { a: 2, sname: 'g' }, { a: 3, sname: 'g' }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: [0, 110] }, scale],
    marks,
  }
  return { label: `${kind} ${JSON.stringify(scale.domain)}: ${labels.join(', ')}`, spec, kind }
}

export { makeRng }
