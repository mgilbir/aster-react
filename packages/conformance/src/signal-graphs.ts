/**
 * Generated event-driven signal graphs (seeded): signals declared in a shuffled order, derived (`update`) signals over an acyclic
 * order, and `on` entries from timers, clicks, signals, expressions over signals and merged signals, with and without `force`,
 * and a dataset written by `setdata` / `modify`. Used by signal-dataflow-vs-vega.test.ts.
 */
export type Spec = Record<string, unknown>

/** mulberry32 */
function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Gen {
  int(n: number): number
  pick<T>(xs: readonly T[]): T
  chance(p: number): boolean
  shuffle<T>(xs: T[]): T[]
}
function gen(seed: number): Gen {
  const r = stream(seed)
  const g: Gen = {
    int: (n) => Math.floor(r() * n),
    pick: (xs) => xs[g.int(xs.length)]!,
    chance: (p) => r() < p,
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = g.int(i + 1)
        ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
      }
      return xs
    },
  }
  return g
}

const DELAYS = [200, 300, 500, 700] as const

/** a small numeric expression over some signals (kept bounded, so a cycle through streams cannot run away) */
function expression(g: Gen, names: readonly string[], self?: string): string {
  const x = (): string => (self !== undefined && g.chance(0.4) ? self : g.pick(names))
  switch (g.int(8)) {
    case 0: return `(${x()} + 1) % 7`
    case 1: return `(${x()} + ${x()}) % 5`
    case 2: return `${x()} > ${x()} ? ${x()} : ${x()} + 1`
    case 3: return `abs(${x()} - ${x()})`
    case 4: return `${x()} === ${x()} ? 0 : 1`
    case 5: return `(${x()} * 2 + 1) % 6`
    case 6: return `max(${x()}, ${x()})`
    default: return `${x()} % 3`
  }
}

export interface Case { id: string; spec: Spec; times: number[]; clicks: number[] }

/** One generated graph. `withData` adds a dataset written by `setdata` / `modify` and read by derived signals. */
export function generate(seed: number): Case {
  const g = gen(seed)
  const n = 3 + g.int(5)
  const names = Array.from({ length: n }, (_, i) => `s${i}`)
  // the order the derived signals may read each other in (acyclic); the DECLARATION order is shuffled apart from it
  const order = g.shuffle([...names])
  const rank = new Map(order.map((nm, i) => [nm, i]))
  const withData = g.chance(0.35)
  const readers = withData ? ['d0'] : []
  const signals: Spec[] = []
  const sources = new Set<string>()
  const free = (text: string): boolean => !sources.has(text)
  const used = (text: string): string => { sources.add(text); return text }
  for (const name of names) {
    const sig: Spec = { name, value: g.int(4) }
    const on: Spec[] = []
    if (g.chance(0.5) && rank.get(name)! > 0) {
      // derived: reads signals earlier in `order` only (and the dataset reader, when it is earlier than all of them)
      const below = names.filter((m) => rank.get(m)! < rank.get(name)!)
      sig.update = expression(g, below)
      delete sig.value
    }
    const entries = g.int(4)
    for (let k = 0; k < entries; k++) {
      const others = g.chance(0.8) ? names : [...names, ...readers]
      const update = expression(g, others, name)
      // a signal source must come earlier in `order` than the signal it feeds (vega rejects a cycle of dataflow edges); a timer or a
      // click has no such edge, and the update may read any signal: that is where the cycles are.
      // Each source (a signal, or an expression) feeds ONE handler: the handlers of one source have the same rank, and which of them
      // vega's queue pops first depends on everything else in it (every mark that reads a signal), which is not a property of the
      // signal graph.
      const below = names.filter((m) => rank.get(m)! < rank.get(name)!)
      const kind = below.length ? g.int(10) : g.int(4)
      let events: unknown
      if (kind <= 3) events = g.chance(0.5) ? `timer:${g.pick(DELAYS)}` : { type: 'timer', throttle: g.pick(DELAYS) }
      else if (kind <= 6) { const src = g.pick(below); events = free(src) ? { signal: used(src) } : 'click' }
      else if (kind === 7) { const [a, b] = g.shuffle([...below, ...below]); const text = `${a} || ${b}`; events = free(text) ? { signal: used(text) } : 'click' }
      else if (kind === 8) {
        const [a, b, c] = g.shuffle([...below, ...below, ...below])
        const list = [a!, b!, ...(g.chance(0.4) ? [c!] : [])]
        const text = '[' + list.join(',') + ']'
        events = free(text) ? (used(text), list.map((signal) => ({ signal }))) : 'click'
      }
      else events = 'click'
      on.push({ events, update, ...(g.chance(0.4) ? { force: true } : {}) })
    }
    if (on.length) sig.on = on
    signals.push(sig)
  }
  const data: Spec[] = []
  if (withData) {
    data.push({ name: 'rows', values: [{ v: 0 }] })
    // a derived reader of the dataset, a writer through `setdata` and a writer through `modify`
    signals.push({ name: 'd0', update: "data('rows')[0] ? data('rows')[0].v : -1" })
    const writer = g.pick(names)
    const w = signals.find((s) => s.name === writer)!
    const how = g.chance(0.5)
      ? `setdata('rows', [{v: ${expression(g, names)}}])`
      : `modify('rows', {v: ${expression(g, names)}}, true)`
    const earlier = names.filter((m) => rank.get(m)! < rank.get(writer)!)
    const from = earlier.filter(free)
    const entry = { events: g.chance(0.5) || !from.length ? `timer:${g.pick(DELAYS)}` : { signal: used(g.pick(from)) }, update: how }
    w.on = [...((w.on as Spec[] | undefined) ?? []), entry]
    // a writer's value is the function's (1), which a handler may not mind
  }
  g.shuffle(signals)
  const shown = [...names, ...readers]
  const spec: Spec = {
    width: 200, height: 40, padding: 5, autosize: 'none',
    signals,
    ...(data.length ? { data } : {}),
    marks: [{ type: 'text', encode: { update: { x: { value: 2 }, y: { value: 14 }, fill: { value: '#000' }, text: { signal: `join([${shown.join(',')}], ' ')` } } } }],
  }
  const t1 = 400 + g.int(500)
  const times = [t1, t1 + 700 + g.int(900)]
  const clicks = [150 + g.int(250), 900 + g.int(400)]
  return { id: `graph-${seed}`, spec, times, clicks }
}


/**
 * Hand-written graphs, one for each rule of the run loop that a random graph reaches only now and then. Each is run at several
 * instants (a rule may show only on the second tick).
 */
export const HAND: Case[] = [
  {
    // a source whose own update leaves it at the value it was made with does not pulse in the first run: its handler's FIRST
    // invocation is still to be skipped (vega: `op.skip(true)` on the handler, "skip first invocation")
    id: 'hand-first-invocation-skipped',
    spec: frame([
      { name: 'c', value: 0, on: [{ events: { type: 'timer', throttle: 300 }, update: 'c + 1' }] },
      { name: 'a', value: 0, update: 'c > 1 ? c : 0' },
      { name: 'b', value: 0, on: [{ events: { signal: 'a' }, update: 'b + 1' }] },
    ], ['a', 'b', 'c']),
    times: [700, 1300, 2000], clicks: [],
  },
  {
    // a handler that computes what it computed last time assigns it and does not pulse: a signal read from the target is left as it was
    id: 'hand-assignment-without-pulse-leaves-a-dependent-stale',
    spec: frame([
      { name: 's', value: 0, on: [{ events: { type: 'timer', throttle: 200 }, update: 's + 1' }] },
      { name: 't', value: 0, on: [{ events: { signal: 's' }, update: '3' }, { events: { type: 'timer', throttle: 300 }, update: '7' }] },
      { name: 'd', update: 't * 2' },
    ], ['s', 't', 'd']),
    times: [250, 450, 650, 850, 1250], clicks: [],
  },
  {
    // two streams that tick together are two runs, the second reading what the first left
    id: 'hand-two-timers-two-runs',
    spec: frame([
      { name: 'x', value: 1, on: [{ events: { type: 'timer', throttle: 200 }, update: 'x + y' }] },
      { name: 'y', value: 1, on: [{ events: { type: 'timer', throttle: 400 }, update: 'x' }] },
      { name: 'z', update: 'x - y' },
    ], ['x', 'y', 'z']),
    times: [450, 850, 1250], clicks: [],
  },
  {
    // a cycle through the streams: each reads the other's last value
    id: 'hand-cycle-through-streams',
    spec: frame([
      { name: 'p', value: 0, on: [{ events: { type: 'timer', throttle: 300 }, update: '(q + 1) % 5' }] },
      { name: 'q', value: 0, on: [{ events: { signal: 'p' }, update: '(p + q) % 5' }] },
      { name: 'r', value: 0, on: [{ events: { signal: 'q' }, update: 'p * 2 + q' }] },
    ], ['p', 'q', 'r']),
    times: [350, 650, 1250, 1850], clicks: [],
  },
  {
    // an expression as a source pulses when ITS value changes, not when something it reads does; a forced handler pulses regardless
    id: 'hand-expression-source-and-force',
    spec: frame([
      { name: 'a', value: 0, on: [{ events: { type: 'timer', throttle: 200 }, update: 'a + 1' }] },
      { name: 'b', value: 1 },
      { name: 'n', value: 0, on: [{ events: { signal: 'b || a' }, update: 'n + 1' }] },
      { name: 'm', value: 0, on: [{ events: { signal: 'a % 2' }, update: 'm + 1' }] },
      { name: 'f', value: 0, on: [{ events: { signal: 'a % 2' }, update: '5', force: true }] },
      { name: 'g', update: 'f + 1' },
      { name: 'cnt', value: 0, on: [{ events: { signal: 'f' }, update: 'cnt + 1' }] },
    ], ['a', 'b', 'cnt', 'f', 'g', 'm', 'n']),
    times: [250, 650, 1050, 1450], clicks: [],
  },
  {
    // `setdata` in the update of a derived signal, read by another: the reader is ranked after the dataset, and the data are the new ones for it
    id: 'hand-setdata-then-reader',
    spec: frame([
      { name: 'k', value: 0, on: [{ events: { type: 'timer', throttle: 300 }, update: 'k + 1' }] },
      { name: 'w', update: "setdata('rows', [{v: k * 10}])" },
      { name: 'r', update: "data('rows')[0] ? data('rows')[0].v : -1" },
    ], ['k', 'r'], [{ name: 'rows', values: [{ v: 0 }] }]),
    times: [350, 650, 1250], clicks: [],
  },
  {
    // `modify` is a run of its own after the one that asked for it
    id: 'hand-modify-is-a-later-run',
    spec: frame([
      { name: 'k', value: 0, on: [{ events: { type: 'timer', throttle: 300 }, update: "k + modify('rows', {v: k + 1}, true)" }] },
      { name: 'r', update: "data('rows')[0] ? data('rows')[0].v : -1" },
    ], ['k', 'r'], [{ name: 'rows', values: [{ v: 0 }] }]),
    times: [350, 650, 1250], clicks: [],
  },
]

function frame(signals: Spec[], shown: string[], data: Spec[] = []): Spec {
  return {
    width: 200, height: 40, padding: 5, autosize: 'none',
    signals,
    ...(data.length ? { data } : {}),
    marks: [{ type: 'text', encode: { update: { x: { value: 2 }, y: { value: 14 }, fill: { value: '#000' }, text: { signal: `join([${shown.join(',')}], ' ')` } } } }],
  }
}
