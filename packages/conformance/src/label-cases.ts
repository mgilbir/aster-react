/**
 * Generated `label` specs (seeded) for label-generated-vs-vega.test.ts: the mark the labels belong to (every mark type the layout
 * can take a boundary from, a facet of lines or areas, or a dataset's tuples), the marks to avoid (every type the layout can draw,
 * inside a group or not, the base mark itself), the anchors, offsets (negative ones put a label inside), padding (including null),
 * method, lineAnchor, markIndex, sort, avoidBaseMark, the view and the size the layout is given, and the labels' font size and text.
 */
export type Spec = Record<string, unknown>
export interface LabelCase { id: string; spec: Spec; mark: string | null; dataset: string | null; kind: string }

export function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'middle', 'right', 'bottom-left', 'bottom', 'bottom-right']
const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'arrow', 'wedge', 'stroke']
const COLOURS = ['#4682b4', '#cc3311', '#999999', '#228833', 'rgba(0,0,0,0.5)', '#000']
const NAMES = ['a', 'bb', 'Ccc', 'dddd', 'Eeeeee', 'ff fff', 'ggggggggg', 'hh hh hh hh', 'Mi', 'WWWWWW', 'j', 'kkkkkkkkkkkkkkk']

/**
 * `exact` keeps to what the coverage-only canvas reproduces pixel for pixel against a browser's: no text among the marks drawn
 * (glyph coverage is not modelled, see `AlphaCanvas.fillText`) and no area label by search (floodfill / reduced-search read single
 * pixels of the area's outline, so antialiasing differences move the label).
 */
export function labelCase(seed: number, exact = false, force: { kind?: string; method?: string } = {}): LabelCase {
  const r = stream(seed * 6151 + 29)
  const int = (n: number): number => Math.floor(r() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!
  const chance = (p: number): boolean => r() < p
  const between = (a: number, b: number): number => Math.round((a + r() * (b - a)) * 100) / 100
  const subset = <T,>(xs: readonly T[], max: number): T[] => {
    const out: T[] = []
    for (let n = 1 + int(max); out.length < n; ) { const x = pick(xs); out.push(x) }
    return out
  }

  // (a view of a fractional size: the layout reads its canvas at a stride that is not the canvas's -- vega does too; only a browser's canvas pins it)
  const frac = exact && chance(0.2) ? 0.5 : 0
  const W = pick([160, 240, 320, 420, 600, 900]) + frac
  const H = pick([120, 200, 300, 380, 520]) + frac
  const pad = pick([0, 5, 20])
  const frame = { width: W, height: H, padding: pad, autosize: 'none' }
  const scales = [
    { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
  ]
  const n = pick([6, 14, 30, 60, 120])
  const rows = Array.from({ length: n }, (_, id) => ({
    id, name: `${pick(NAMES)}${chance(0.5) ? id : ''}`, x: between(chance(0.1) ? -10 : 0, chance(0.1) ? 110 : 100), y: between(chance(0.1) ? -10 : 0, chance(0.1) ? 110 : 100),
    v: between(0, 1), s: between(8, 90), w: between(4, 70), h: between(4, 40),
    path: `M${between(0, 40)},${between(0, 40)}l${between(5, 40)},${between(-10, 30)}l${between(-30, 0)},${between(5, 40)}z`,
  }))
  const px = (f = 'x'): Spec => ({ scale: 'x', field: f })
  const py = (f = 'y'): Spec => ({ scale: 'y', field: f })
  const stroked = chance(0.5)
  const paintOf = (): Spec => ({
    ...(chance(0.8) ? { fill: { value: pick(COLOURS) } } : {}),
    ...(stroked || chance(0.3) ? { stroke: { value: pick(COLOURS) }, strokeWidth: { value: pick([0.5, 1, 2, 4, 9]) } } : {}),
    ...(chance(0.15) ? { fillOpacity: { value: pick([0, 0.5]) } } : {}),
    ...(chance(0.15) ? { strokeOpacity: { value: pick([0, 0.5]) } } : {}),
    ...(chance(0.1) ? { opacity: { value: pick([0, 0.4]) } } : {}),
  })

  // marks to draw and avoid, one of each kind the layout can draw
  const avoidKinds: Array<(name: string) => Spec> = [
    (name) => ({ name, type: 'symbol', from: { data: 'd' }, encode: { enter: { x: px(), y: py(), size: { field: 's' }, shape: { value: pick(SHAPES) }, angle: { value: pick([0, 30, 90]) }, ...paintOf() } } }),
    (name) => ({ name, type: 'rect', from: { data: 'd' }, encode: { enter: { x: px(), width: { field: 'w' }, y: py(), height: { field: 'h' }, ...paintOf(), cornerRadius: { value: pick([0, 0, 4]) } } } }),
    (name) => ({ name, type: 'rule', from: { data: 'd' }, encode: { enter: { x: px(), x2: { signal: 'datum.w * 3 + 10' }, y: py(), stroke: { value: '#777' }, strokeWidth: { value: pick([1, 3, 12, 14]) }, strokeDash: { value: pick([[], [6, 4], [2, 8], [40, 30], [14, 40]]) }, ...(chance(0.3) ? { strokeDashOffset: { value: pick([5, 20]) } } : {}), strokeCap: { value: pick(['butt', 'round', 'square']) } } } }),
    (name) => ({ name, type: 'arc', from: { data: 'd' }, encode: { enter: { x: px(), y: py(), innerRadius: { signal: 'datum.w / 4' }, outerRadius: { signal: 'datum.w / 2 + 6' }, startAngle: { signal: 'datum.v * 3' }, endAngle: { signal: 'datum.v * 3 + 1 + datum.h / 10' }, angle: { value: pick([0, 0, 30, -20]) }, ...paintOf(), padAngle: { value: pick([0, 0.05]) }, cornerRadius: { value: pick([0, 3]) } } } }),
    (name) => ({ name, type: 'text', from: { data: 'd' }, encode: { enter: { x: px(), y: py(), text: { value: pick(['MMMMM', 'ii', 'multi\nline']) }, fontSize: { value: pick([8, 12, 18]) }, angle: { value: pick([0, 0, 45, 90]) }, align: { value: pick(['left', 'center', 'right']) }, baseline: { value: pick(['top', 'middle', 'bottom', 'alphabetic']) }, fill: { value: '#000' }, ...(chance(0.3) ? { stroke: { value: '#f00' } } : {}) } } }),
    (name) => ({ name, type: 'path', from: { data: 'd' }, encode: { enter: { x: px(), y: py(), path: { field: 'path' }, angle: { value: pick([0, 20]) }, scaleX: { value: pick([1, 1.5]) }, ...paintOf(), strokeJoin: { value: pick(['miter', 'round', 'bevel']) } } } }),
    (name) => ({ name, type: 'line', from: { data: 'd' }, sort: { field: 'datum.x' }, encode: { enter: { x: px(), y: py(), stroke: { value: '#c33' }, strokeWidth: { value: pick([1, 3, 10]) }, strokeDash: { value: pick([[], [], [30, 30], [8, 20]]) }, interpolate: { value: pick(['linear', 'step', 'monotone', 'basis']) } } } }),
    (name) => ({ name, type: 'area', from: { data: 'd' }, sort: { field: 'datum.x' }, encode: { enter: { x: px(), y: py(), y2: { signal: 'height' }, fill: { value: '#9ecae1' }, ...(chance(0.4) ? { stroke: { value: '#000' } } : {}), interpolate: { value: pick(['linear', 'cardinal']) } } } }),
    (name) => ({ name, type: 'trail', from: { data: 'd' }, sort: { field: 'datum.x' }, encode: { enter: { x: px(), y: py(), size: { signal: '2 + datum.w / 4' }, fill: { value: '#555' } } } }),
  ]
  const drawable = exact ? avoidKinds.filter((_, i) => i !== 4) : avoidKinds
  const avoidMarks = (count: number): Spec[] => Array.from({ length: count }, (_, i) => pick(drawable)(`av${i}`))

  const kinds = ['symbol', 'symbol', 'rect', 'rule', 'arc', 'text', 'path', 'line', 'area', 'group-line', 'group-line', 'group-area', 'tuples'] as const
  const kind = force.kind ?? pick(exact ? kinds.filter((k) => k !== 'text') : kinds)
  const fontSize = pick([7, 9, 11, 14, 20])
  const textEnc = {
    text: { field: 'datum.name' }, fontSize: { value: fontSize },
    ...(chance(0.25) ? { fontWeight: { value: 'bold' } } : {}),
    ...(chance(0.15) ? { angle: { value: pick([0, 90]) } } : {}),
    ...(chance(0.2) ? { fill: { value: '#000' } } : {}),
  }
  const positions = 1 + int(5)
  const label: Spec = {
    type: 'label',
    size: chance(0.8) ? [W, H] : [Math.max(60, W + pick([-60, 40])), Math.max(60, H + pick([-40, 60]))],
    ...(chance(0.7) ? { anchor: chance(0.04) ? pick<string[]>([[], ['nowhere', 'top'], ['top', 'nowhere']]) : subset(ANCHORS, positions) } : {}),
    ...(chance(0.8) ? { offset: chance(0.04) ? pick<number[]>([[], [0], [null as never, 3]]) : Array.from({ length: 1 + int(4) }, () => pick([0, 1, 2, 5, 9, -2, -6, 0.5])) } : {}),
    ...(chance(0.5) ? { padding: pick([0, 0, 5, 20, 100, null]) } : {}),
    ...(chance(0.35) ? { avoidBaseMark: chance(0.4) } : {}),
    ...(chance(0.3) ? { sort: { field: kind === 'tuples' ? pick(['x', 'y', 'fontSize']) : kind.startsWith('group') ? 'datum.key' : pick(['datum.datum.v', 'datum.datum.id', 'datum.x']), order: pick(['ascending', 'descending']) } } : {}),
  }
  const avoids = chance(0.55) ? avoidMarks(1 + int(3)) : []
  if (avoids.length) label.avoidMarks = avoids.map((m) => m.name as string)

  if (kind === 'tuples') {
    const tuples = rows.map((p) => ({ text: p.name, x: (p.x / 100) * W, y: (p.y / 100) * H, fontSize }))
    // no mark behind the tuples: only the marks named in avoidMarks (drawn by the view) hold the labels off
    const spec: Spec = { ...frame, data: [{ name: 'd', values: rows }, { name: 'src', values: tuples }, { name: 'lab', source: 'src', transform: [label] }], scales, marks: avoids }
    return { id: `label-${seed}`, spec, mark: null, dataset: 'lab', kind }
  }

  if (kind === 'group-line' || kind === 'group-area') {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const k = 2 + int(4)
    const T = 4 + int(14)
    const series = names.slice(0, k).flatMap((c, i) => Array.from({ length: T }, (_, t) => ({ c, t, v: 10 + i * 15 + between(0, 12) + t * between(-1, 1.5) })))
    const area = kind === 'group-area'
    // a second mark in each group, so markIndex has something to choose: the line then the symbols (index 0 is the line), the symbols
    // then the line (index 1 is), or two sets of symbols (the label is placed by the bounds of the group)
    const layer = area ? pick(['alone', 'with symbols']) : pick(['alone', 'with symbols', 'symbols first', 'symbols only'])
    // (a line's bounds are not vega's to the last digits yet -- the engine measures the path it writes, rounded -- so a group whose
    // bounds place the label holds no line)
    const markIndex = layer === 'symbols first' || layer === 'symbols only' ? 1 : 0
    const curve = pick(['linear', 'monotone', 'step'])
    const main: Spec = area
      ? { type: 'area', from: { data: 'series' }, encode: { enter: { x: { scale: 'gx', field: 't' }, y: { scale: 'gy', field: 'y0' }, y2: { scale: 'gy', field: 'y1' }, fill: { scale: 'c', field: 'c' }, ...(chance(0.5) ? { stroke: { value: 'white' } } : {}), interpolate: { value: curve } } } }
      : { type: 'line', from: { data: 'series' }, encode: { enter: { x: { scale: 'gx', field: 't' }, y: { scale: 'gy', field: 'v' }, stroke: { scale: 'c', field: 'c' }, strokeWidth: { value: pick([1, 2, 5]) }, interpolate: { value: curve } } } }
    const dots = (dy: number): Spec => ({ type: 'symbol', from: { data: 'series' }, encode: { enter: { x: { scale: 'gx', field: 't' }, y: { scale: 'gy', field: area ? 'y1' : 'v', offset: dy }, size: { value: 30 }, fill: { value: '#333' } } } })
    const inner: Spec[] = layer === 'alone' ? [main] : layer === 'with symbols' ? [main, dots(0)] : layer === 'symbols first' ? [dots(0), main] : [dots(0), dots(6)]
    const useIndex = markIndex === 1
    const groupLabel: Spec = {
      ...label,
      ...(area ? { method: ((m) => force.method ?? m)(pick(exact ? ['naive'] : ['naive', 'floodfill', 'reduced-search'])) } : { lineAnchor: pick(['start', 'end']) }),
      ...(useIndex ? { markIndex } : {}),
      ...(area && chance(0.5) ? { markIndex: 0 } : {}),
    }
    const spec: Spec = {
      ...frame,
      data: [
        { name: 'd', values: series },
        ...(area ? [{ name: 'stacked', source: 'd', transform: [{ type: 'stack', groupby: ['t'], field: 'v', sort: { field: 'c' } }] }] : []),
        { name: 'pts', values: rows },
      ],
      scales: [
        { name: 'gx', type: 'linear', domain: [-1, T], range: 'width' },
        { name: 'gy', type: 'linear', domain: [0, area ? 200 : 100], range: 'height' },
        { name: 'c', type: 'ordinal', domain: names.slice(0, k), range: 'category' },
        ...scales,
      ],
      marks: [
        { name: 'groups', type: 'group', from: { facet: { name: 'series', data: area ? 'stacked' : 'd', groupby: 'c' } }, marks: inner },
        ...avoids.map((m) => (m.from ? { ...m, from: { data: 'pts' } } : m)),
        { name: 'lab', type: 'text', from: { data: 'groups' }, encode: { enter: { ...textEnc, text: { field: 'datum.c' } } }, transform: [groupLabel] },
      ],
    }
    // the group itself is a mark to avoid
    if (chance(0.25)) (groupLabel.avoidMarks as string[] | undefined) ? (groupLabel.avoidMarks as string[]).push('groups') : (groupLabel.avoidMarks = ['groups'])
    return { id: `label-${seed}`, spec, mark: 'lab', dataset: null, kind }
  }

  // a flat mark of `kind`, one item per row
  const baseByKind: Record<string, Spec> = {
    symbol: avoidKinds[0]!('base'), rect: avoidKinds[1]!('base'), rule: avoidKinds[2]!('base'), arc: avoidKinds[3]!('base'), text: avoidKinds[4]!('base'),
    path: avoidKinds[5]!('base'), line: avoidKinds[6]!('base'), area: avoidKinds[7]!('base'), trail: avoidKinds[8]!('base'),
  }
  const base = baseByKind[kind]!
  // (known gaps outside the label transform, found by this generator and left out of the base mark: the item bounds of an arc with a
  // corner radius, pad angle or angle, of a trail, and the order of the items of a sorted line / area, which a mark of `from: base` reads)
  if (kind === 'arc') { const e = (base.encode as { enter: Spec }).enter; delete e.cornerRadius; delete e.padAngle; delete e.angle }
  delete base.sort
  if (chance(0.25)) (label.avoidMarks as string[] | undefined) ? (label.avoidMarks as string[]).push('base') : (label.avoidMarks = ['base'])
  const spec: Spec = {
    ...frame, data: [{ name: 'd', values: rows }], scales,
    marks: [base, ...avoids, { name: 'lab', type: 'text', from: { data: 'base' }, encode: { enter: textEnc }, transform: [label] }],
  }
  return { id: `label-${seed}`, spec, mark: 'lab', dataset: null, kind }
}
