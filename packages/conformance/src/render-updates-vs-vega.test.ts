// @vitest-environment jsdom
/**
 * Aster's three renderers against real vega 6.3.1, on generated specs and the incremental updates that follow them (DECISIONS Q30: the
 * renderers' reference is upstream, not a copy of Aster's own earlier code). For every state of every scenario, vega renders the spec
 * with that state's rows from scratch, and Aster renders the scene its incremental path made -- a compiled chart evaluated again with
 * the new rows, or a chart session as `<Chart>` drives it -- so the items and the caches the renderers keep on them are the reused ones:
 *  - the SVG string (`renderSceneToSvg`) against vega's SVG;
 *  - the DOM: one `<svg>` element patched from state to state (`patchSceneDom`, the descriptors it caches on reused items), item by
 *    item and with `denseMarks` (the chunk caches of dense symbol marks), serialized, against vega's SVG;
 *  - the canvas: what `renderSceneToCanvas` paints (batched and item by item, at a pixel ratio of 1 and 2) against what vega-scenegraph's
 *    canvas code paints, on a recording context (canvas-recorder.ts) that keeps every paint with the state that decides its pixels;
 *  - the endpoints of a scene transition (`createSceneTransition`, a scene object rewritten in place): its last frame is the state after,
 *    drawn as vega draws it (the frames before have no upstream; transition-frames in
 *    geometry-differential.test.ts hold them to a cold copy);
 *  - the canvas append path: when `renderSceneToCanvasAppend` takes a state on top of the previous painting, what is on the canvas
 *    then (the previous painting and the appended paint) against vega's painting of the state, as a multiset (z-order: the Chromium
 *    gate `canvas-append`).
 * SVG and DOM are compared in the strict canonical form (normalize.ts), the canvas in the canonical form of canvas-canonical.ts; neither
 * drops anything that can change a pixel.
 *
 * The specs are scene-fuzz.testlib.ts's (every mark the renderers draw over two datasets, axes, legends, a background, dense symbol
 * marks of 256 to 700 items), with data-driven scale domains for a third of them and `autosize: pad` for a quarter (the view sized by
 * the bounds of what it draws); the updates are its row edits (insert, remove, append, truncate, shuffle, replace, an edit of the other
 * dataset, nothing). The `circle` mark kind the generator also has is not a vega mark (vega's renderer has no `circle`; DECISIONS Q9):
 * it has no upstream to be compared with and is left out.
 *
 *   ASTER_RENDER_VEGA_SEEDS=240   seeds (a whole number, at least 120; default 120)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { compileChart, createChartStream, evaluateChart, renderSceneToSvg, type SceneRoot } from '@aster-charts/core'
import { createChartSession, patchSceneDom } from '@aster-charts/core/dom'
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from '@aster-charts/core/canvas'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { recorder, vegaDraw, type Painted } from './canvas-recorder.js'
import { canonicalPaints } from './canvas-canonical.js'
import { createSceneTransition } from '@aster-charts/core/transition'
import { coldCopy } from '../../core/src/geometry-differential.testlib.js'
import { applyOp, genSpec, int, MARKS, mulberry32, OPS, pick, rowOf, type MarkKind, type World } from '../../core/src/scene-fuzz.testlib.js'

type Spec = Record<string, unknown>
type VegaView = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void; scenegraph(): { root: unknown } }
const quiet = { level() { return this }, error() { return this }, warn() { return this }, info() { return this }, debug() { return this } }
/** The canvas records keep numbers to this many decimals: more than float error shows in a pixel, so rounding never decides a comparison. */
const DIGITS = 9
/** What two canvas numbers may differ by: float error (Aster's trail finds an arc's centre from its ends, 1e-7 px off vega's), never a visible shift. */
const ABS_EPS = 1e-6, REL_EPS = 1e-9

/** The kinds of mark vega draws (scene-fuzz's `circle` is an Aster-only extension, see the header). */
const KINDS: readonly MarkKind[] = MARKS.filter((k) => k !== 'circle')

/**
 * How the scenes are made, as a host makes them: a compiled chart evaluated again with the rows (`evaluateChart`), a chart session given
 * the rows as data (`<Chart data>`) or inline in the spec (`<Chart spec>` with `values`), or a stream (an append pushed as one).
 */
type Driver = 'chart' | 'session' | 'session-inline' | 'stream'
const DRIVERS: readonly Driver[] = ['chart', 'session', 'session-inline', 'stream']
interface Scenario { label: string; spec: Spec; dense: boolean; driver: Driver; states: World[]; ops: string[] }

export function scenario(seed: number): Scenario {
  const r = mulberry32(1000 + seed)
  const g = genSpec(r, r() < 0.2, KINDS, { dataDomains: seed % 3 === 0 })
  if (seed % 4 === 1) g.spec.autosize = 'pad'
  // (a dense symbol mark both filled and stroked, opaque, every third time: where its symbols overlap, one is drawn over the other's outline)
  if (g.dense && seed % 3 === 1) {
    const upd = (g.spec.marks as Array<{ encode: { update: Record<string, unknown> } }>)[0]!.encode.update
    delete upd.opacity
    delete upd.fillOpacity
    upd.fill = { value: '#4c78a8' }
    upd.stroke = { value: '#222' }
    upd.strokeWidth = { value: 1.5 }
  }
  let world: World = { t: Array.from({ length: int(r, 1, 25) }, () => rowOf(r, g.dense)), u: Array.from({ length: 3 }, () => rowOf(r, g.dense)) }
  const states = [world]
  const ops: string[] = []
  for (let step = 0; step < 4; step++) {
    const op = pick(r, OPS)
    ops.push(op)
    world = applyOp(r, world, op, g.dense)
    states.push(world)
  }
  const label = `${g.label}${g.dense && seed % 3 === 1 ? ' filled+stroked' : ''}${g.spec.autosize === 'pad' ? ' pad' : ''}${seed % 3 === 0 ? ' data-domains' : ''}`
  return { label, spec: g.spec, dense: g.dense, driver: DRIVERS[Math.floor(seed / 2) % DRIVERS.length]!, states, ops }
}

const withRows = (spec: Spec, w: World): Spec => ({
  ...structuredClone(spec),
  data: (spec.data as Array<Record<string, unknown>>).map((d) => ({ ...d, values: structuredClone(w[d.name as 't' | 'u']) })),
})

/** vega's SVG of `spec`, and what its canvas code paints at pixel ratio 1 and 2 (or what it threw). */
async function vegaOutput(spec: Spec): Promise<{ svg: string; canvas: Painted[]; canvas2: Painted[] } | Error> {
  let view: VegaView
  try {
    view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(spec as never), { renderer: 'none', logger: quiet })
    await view.runAsync()
  } catch (e) { return e as Error }
  try {
    const svg = await view.toSVG()
    // (where vega's renderer puts the scene: its padding, and the shift `autosize` makes, as its SVG's first group says)
    const [, ox, oy] = /<g[^>]*transform="translate\(([^,]+),([^)]+)\)"/.exec(svg) ?? [0, '0', '0']
    const paint = (dpr: number): Painted[] => {
      const { ctx, painted } = recorder({ state: true, digits: DIGITS })
      const c = ctx as unknown as { scale(x: number, y: number): void; translate(x: number, y: number): void }
      if (dpr !== 1) c.scale(dpr, dpr)
      c.translate(+ox!, +oy!)
      vegaDraw((vega as unknown as { Marks: Parameters<typeof vegaDraw>[0] }).Marks, ctx, view.scenegraph().root)
      return painted
    }
    return { svg, canvas: paint(1), canvas2: paint(2) }
  } catch (e) {
    return e as Error
  } finally {
    view.finalize()
  }
}

// (jsdom's serializer invents a prefix for the xlink namespace: the same attribute)
const serialize = (el: Element): string => new XMLSerializer().serializeToString(el as unknown as Node)
  .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')

function svgDiff(oracle: string, aster: string): string[] {
  try {
    return diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(aster))
  } catch (e) {
    return [`canonicalizeSvg threw: ${(e as Error).message}`]
  }
}

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g
/** Two records that are the same but for numbers within float error of each other (ABS_EPS + REL_EPS of the larger). */
function sameWithinFloatError(a: string, b: string): boolean {
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false
  const x = a.match(NUMBER) ?? [], y = b.match(NUMBER) ?? []
  return x.length === y.length && x.every((v, i) => Math.abs(Number(v) - Number(y[i])) <= ABS_EPS + REL_EPS * Math.max(Math.abs(Number(v)), Math.abs(Number(y[i]))))
}

function sequenceDiff(oracle: string[], aster: string[]): string | null {
  const n = Math.max(oracle.length, aster.length)
  for (let i = 0; i < n; i++) {
    const a = oracle[i], b = aster[i]
    if (a === b || (a !== undefined && b !== undefined && sameWithinFloatError(a, b))) continue
    // (from a little before the first character that differs)
    let k = 0
    while (a !== undefined && b !== undefined && k < a.length && a[k] === b[k]) k++
    const at = Math.max(0, k - 80)
    return `record ${i} of ${oracle.length} / ${aster.length}, from character ${at}: vega ${a?.slice(at, at + 260)} / aster ${b?.slice(at, at + 260)}`
  }
  return null
}

const multisetDiff = (oracle: string[], aster: string[]): string | null => sequenceDiff(oracle.slice().sort(), aster.slice().sort())

/** What the runs saw, checked at the end: every kind of mark, every renderer path, the append path taken. */
const seen = { states: 0, kinds: new Set<string>(), drivers: new Set<string>(), denseBatched: 0, canvasBatched: 0, appended: 0, transitions: 0, pad: 0, denseFilledStroked: 0 }

async function runScenario(seed: number): Promise<string[]> {
  const sc = scenario(seed)
  const out: string[] = []
  const fail = (step: number, where: string, detail: string): void => { out.push(`seed ${seed} (${sc.label}, ${sc.driver}) step ${step} [${sc.ops.slice(0, step).join(' ')}] ${where}: ${detail.slice(0, 700)}`) }
  const chart = compileChart(structuredClone(sc.spec) as never)
  const session = createChartSession()
  const dataOf = (w: World): { t: World['t']; u: World['u'] } => ({ t: structuredClone(w.t), u: structuredClone(w.u) })
  const stream = sc.driver === 'stream' ? createChartStream(structuredClone(sc.spec) as never, { initial: { data: dataOf(sc.states[0]!) } }) : null
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const elDense = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  let prev: SceneRoot | null = null
  let painting: { snapshot: ReturnType<typeof snapshotCanvasScene>; painted: Painted[] } | null = null
  for (const [step, world] of sc.states.entries()) {
    const want = await vegaOutput(withRows(sc.spec, world))
    let scene: SceneRoot
    try {
      if (sc.driver === 'chart') scene = evaluateChart(chart, { data: dataOf(world) })
      else if (sc.driver === 'session') scene = session.evaluate(structuredClone(sc.spec) as never, { data: dataOf(world) })
      else if (sc.driver === 'session-inline') scene = session.evaluate(withRows(sc.spec, world) as never, {})
      else {
        const before = sc.states[step - 1]
        if (before !== undefined) {
          // (rows added at the end and nothing else changed: pushed as an append, as a host that streams them would)
          const append = world.u === before.u && world.t.length > before.t.length && before.t.every((row, i) => row === world.t[i])
          stream!.push(append ? { append: { t: structuredClone(world.t.slice(before.t.length)) } } : { data: dataOf(world) })
        }
        // (a flush with nothing queued returns null: the scene is the one before)
        scene = stream!.flush()?.scene ?? prev!
      }
    } catch (e) {
      fail(step, 'evaluate', `Aster threw "${(e as Error).message}", vega ${want instanceof Error ? `threw "${want.message}"` : 'drew the state'}`)
      return out
    }
    if (want instanceof Error) { fail(step, 'vega', `vega threw "${want.message}", Aster drew the state`); return out }
    seen.states++
    for (const m of sc.spec.marks as Array<{ type: string }>) seen.kinds.add(m.type)
    if (sc.spec.autosize === 'pad') seen.pad++
    seen.drivers.add(sc.driver)
    if (sc.label.includes('filled+stroked') && world.t.length >= 512) seen.denseFilledStroked++

    const s = svgDiff(want.svg, renderSceneToSvg(scene))
    if (s.length) fail(step, 'svg string', s.slice(0, 3).join(' | '))
    patchSceneDom(el, scene, {})
    const perItem = serialize(el)
    const d = svgDiff(want.svg, perItem)
    if (d.length) fail(step, 'dom (patched)', d.slice(0, 3).join(' | '))
    patchSceneDom(elDense, scene, { denseMarks: true })
    const dense = serialize(elDense)
    if ((dense.match(/<path/g) ?? []).length < (perItem.match(/<path/g) ?? []).length) seen.denseBatched++
    const dd = svgDiff(want.svg, dense)
    if (dd.length) fail(step, 'dom (patched, denseMarks)', dd.slice(0, 3).join(' | '))

    const vegaPaint = canonicalPaints(want.canvas)
    for (const [name, opts, oracle] of [
      ['canvas', {}, vegaPaint],
      ['canvas (item by item)', { batchSymbols: false }, vegaPaint],
      ['canvas (dpr 2)', { dpr: 2 }, canonicalPaints(want.canvas2)],
    ] as const) {
      const { ctx, painted } = recorder({ state: true, digits: DIGITS })
      renderSceneToCanvas(scene, ctx, opts)
      if (name === 'canvas' && painted.length < want.canvas.length) seen.canvasBatched++
      const c = sequenceDiff(oracle, canonicalPaints(painted))
      if (c !== null) fail(step, name, c)
    }
    if (painting !== null) {
      const appended = recorder({ state: true, digits: DIGITS })
      if (renderSceneToCanvasAppend(painting.snapshot, scene, appended.ctx)) {
        seen.appended++
        const c = multisetDiff(vegaPaint, canonicalPaints([...painting.painted, ...appended.painted]))
        if (c !== null) fail(step, 'canvas append (multiset)', c)
      }
    }
    // (the canvas as this state left it, and the snapshot the append path takes of it -- now, before the next evaluation advances the
    // arrays it shares with this scene)
    const full = recorder({ state: true, digits: DIGITS })
    renderSceneToCanvas(scene, full.ctx)
    painting = { snapshot: snapshotCanvasScene(scene), painted: full.painted }
    if (prev !== null) {
      // (a transition rewrites its scenes in place: it gets copies. Its first frame is not the state before: the items that enter are there
      // at no opacity, and it takes the size of the state after. Its last frame is the state after.)
      const tr = createSceneTransition(coldCopy(prev), coldCopy(scene))
      const last = svgDiff(want.svg, renderSceneToSvg(tr.at(1)))
      if (last.length) fail(step, 'transition (last frame)', last.slice(0, 3).join(' | '))
      seen.transitions++
    }
    prev = scene
  }
  return out
}

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
function seedCount(): number {
  const raw = env('ASTER_RENDER_VEGA_SEEDS')
  if (raw === undefined) return 120
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 120) throw new Error(`ASTER_RENDER_VEGA_SEEDS must be a whole number of at least 120, got "${raw}"`)
  return n
}
const SEEDS = seedCount()
const RUN = 10

describe('the canvas comparison sees a shift of half a thousandth of a pixel (it is sized to float error)', () => {
  it('1e-7 is the same number, 0.0005 is not', () => {
    expect(sameWithinFloatError('M10.0000001,5', 'M10,5')).toBe(true)
    expect(sameWithinFloatError('M10.0005,5', 'M10,5')).toBe(false)
    expect(sameWithinFloatError('M1e3,5', 'M1000.0005,5')).toBe(false)
  })
  it('a drawing moved by 0.0005 px is a difference', async () => {
    const sc = scenario(2)
    const want = await vegaOutput(withRows(sc.spec, sc.states[0]!))
    if (want instanceof Error) throw want
    const scene = evaluateChart(compileChart(structuredClone(sc.spec) as never), { data: { t: structuredClone(sc.states[0]!.t), u: structuredClone(sc.states[0]!.u) } })
    const draw = (shift: number): string[] => {
      const { ctx, painted } = recorder({ state: true, digits: DIGITS })
      ;(ctx as unknown as { translate(x: number, y: number): void }).translate(shift, 0)
      renderSceneToCanvas(scene, ctx, {})
      return canonicalPaints(painted)
    }
    expect(sequenceDiff(draw(0), draw(0))).toBeNull()
    expect(sequenceDiff(draw(0), draw(0.0005))).not.toBeNull()
    expect(sequenceDiff(canonicalPaints(want.canvas), draw(0))).toBeNull()
  })
})

describe('Aster renders generated specs and their incremental updates as vega does: SVG, DOM, canvas', () => {
  for (let lo = 1; lo <= SEEDS; lo += RUN) {
    const hi = Math.min(SEEDS, lo + RUN - 1)
    it(`seeds ${lo}-${hi}`, async () => {
      const fails: string[] = []
      for (let seed = lo; seed <= hi; seed++) fails.push(...(await runScenario(seed)))
      expect(fails).toEqual([])
    }, 120_000)
  }

  it('the runs drew every kind of vega mark, through every driver, sized views, batched symbols (filled and stroked too) and appends', () => {
    expect(seen.states).toBe(SEEDS * 5)
    expect([...seen.kinds].sort()).toEqual([...new Set(KINDS)].sort())
    expect([...seen.drivers].sort()).toEqual([...DRIVERS].sort())
    expect(seen.pad).toBeGreaterThan(0)
    expect(seen.denseBatched).toBeGreaterThan(0)
    expect(seen.canvasBatched).toBeGreaterThan(0)
    expect(seen.appended).toBeGreaterThan(0)
    expect(seen.transitions).toBeGreaterThan(SEEDS * 3)
    expect(seen.denseFilledStroked).toBeGreaterThan(0)
  })
})
