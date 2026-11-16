/**
 * The check behind parts-needed.test.ts (the corpus) and gallery/parts-needed.gallery.test.ts (the vendored galleries): every part of
 * the engine (engine-parts.ts in @aster-charts/core) that a chart reads is one `specNeeds` names, and a chart drawn with just the
 * parts it names is the chart drawn with all of them.
 *
 * What a chart "reads" is what the engine itself asks for, found from empty slots: a spec is drawn with every part in its slot,
 * then again as a browser build of the shells would draw it, with the slots empty; each "part ... is not loaded" failure names the
 * part to load, which is loaded and the drawing repeated until it succeeds. "Drawn" is everything a mounted chart does with the
 * engine: the evaluation, the SVG, a canvas (a recording 2D context), the hit index picking a grid over the view, and, for a chart
 * with signals, the signal loop answering pointer, click, drag, double-click and wheel events over the view (in jsdom), with the
 * signals and the datasets those events changed evaluated and drawn again. A handler that fails reports through the loop's logger
 * instead of throwing; its errors are part of what is compared, and a missing part among them is loaded like any other.
 */
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import {
  createChartSession, renderSceneToSvg, specNeeds, loadParts, partLoaded, withdrawParts, ENGINE_PARTS, type EnginePart,
} from '@aster-charts/core/lean'
import { buildHitIndex } from '@aster-charts/core/lean/hit'
import { bindSceneSignals } from '@aster-charts/core/signals'
import type { RuntimeInput, SceneRoot, VgSpec } from '@aster-charts/core'
import { makeRecorder } from '../../core/src/canvas-record.testlib.js'

/**
 * The parts a spec can make the engine read (the canvas renderer is asked for by `renderer="canvas"` and the signal loop by a chart
 * that binds it: `specNeeds(...).eventLoop`; this check draws with both, as `@aster-charts/core/canvas` and `/lean/signals` carry them).
 */
export const SPEC_PARTS = ENGINE_PARTS.filter((p) => p !== 'canvas' && p !== 'signals')
export const MISSING = /the "(\w+)" part of the engine is not loaded/

/** What the host gives each drawing: made fresh per drawing (a random source must start over each time). */
export type InputOf = () => RuntimeInput
/** What each drawing runs inside (a frozen clock, for a spec that reads the time). */
export type Around = <T>(draw: () => T) => T
const plainly: Around = (draw) => draw()

const replacer = (k: string, v: unknown): unknown => (k === 'runtime' || k === 'compiled' ? undefined : typeof v === 'function' ? '[fn]' : v)
const text = (v: unknown): string => { try { return JSON.stringify(v, replacer) ?? 'undefined' } catch { return '[cyclic]' } }

/** The item under each point of a grid over the view. */
function picks(scene: SceneRoot, w: number, h: number): string {
  const index = buildHitIndex(scene)
  const out: string[] = []
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const hit = index.pick((w * i) / 8, (h * j) / 8) as { marktype?: string; role?: string; datum?: unknown } | null
      out.push(hit ? `${hit.marktype}/${hit.role}/${text(hit.datum ?? null).slice(0, 80)}` : '-')
    }
  }
  return out.join('|')
}

/** The events a user's pointer makes over the view: a sweep, a click, a drag, a double click, a wheel turn, and leaving. */
function events(w: number, h: number): Array<[string, number, number, Record<string, unknown>?]> {
  const out: Array<[string, number, number, Record<string, unknown>?]> = []
  for (let i = 1; i <= 4; i++) for (const t of ['pointermove', 'mousemove']) out.push([t, (w * i) / 5, (h * i) / 5])
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) out.push([t, w / 2, h / 2])
  for (const t of ['pointerdown', 'mousedown']) out.push([t, w / 4, h / 4])
  for (const t of ['pointermove', 'mousemove']) out.push([t, (w * 3) / 5, (h * 3) / 5])
  for (const t of ['pointerup', 'mouseup', 'click', 'dblclick']) out.push([t, (w * 3) / 5, (h * 3) / 5])
  out.push(['wheel', w / 2, h / 2, { deltaY: 120 }])
  for (const t of ['pointerout', 'mouseout', 'pointerleave', 'mouseleave']) out.push([t, -10, -10])
  return out
}

function dispatch(el: Element, type: string, x: number, y: number, extra?: Record<string, unknown>): void {
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }
  const Ctor = type === 'wheel' ? window.WheelEvent : type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : window.MouseEvent
  el.dispatchEvent(new Ctor(type, init))
}

/**
 * Everything a mounted chart does with the engine, as text: what it draws (svg, canvas), what it picks, and, for a chart with
 * signals, what the signal loop makes of a user's pointer (the signals and datasets it changes, the chart they draw, the errors).
 */
export function drawn(spec: VgSpec, inputOf: InputOf): string {
  const session = createChartSession()
  const input = inputOf()
  const scene = session.evaluate(spec, input)
  const svg = renderSceneToSvg(scene)
  const w = Math.max(1, Number((scene as { width?: number }).width) || 200)
  const h = Math.max(1, Number((scene as { height?: number }).height) || 200)
  const out = [svg, picks(scene, w, h)]
  const recorder = makeRecorder()
  renderSceneToCanvas(scene, recorder.ctx)
  out.push(text(recorder.records))
  if (specNeeds(spec).eventLoop && typeof document !== 'undefined') {
    const host = document.createElement('div')
    host.innerHTML = svg
    const el = host.firstElementChild
    if (el) {
      const signals: Record<string, unknown> = {}
      const data: Record<string, unknown[]> = {}
      const errors: string[] = []
      const index = buildHitIndex(scene)
      const binding = bindSceneSignals(el, scene, {}, {
        onSignal: (name, value) => { signals[name] = value },
        onData: (name, rows) => { data[name] = rows },
        logger: { error: (...m: unknown[]) => errors.push(m.map(String).join(' ')), warn: () => {}, info: () => {}, debug: () => {} } as never,
      }, { pick: (x, y) => index.pick(x, y) as never })
      try {
        for (const [type, x, y, extra] of events(w, h)) dispatch(el, type, x, y, extra)
      } finally {
        binding.release()
      }
      // a part the loop's handlers missed is a part like any other: the caller loads it and draws again
      const missing = errors.find((e) => MISSING.test(e))
      if (missing) throw new Error(missing)
      const after = createChartSession().evaluate(spec, { ...inputOf(), signals: { ...input.signals, ...signals }, data: { ...input.data, ...data } })
      out.push(text(signals), text(Object.keys(data)), errors.join('\n'), renderSceneToSvg(after), picks(after, w, h))
    }
  }
  return out.join('\n')
}

/** Every part in its slot again (`withdrawParts` gives back what it took; loading puts back what a check took since). */
export async function restoreAll(): Promise<void> {
  await loadParts(SPEC_PARTS.filter((p) => !partLoaded(p)))
}

/** The parts the engine reads for `spec`, found one failure at a time from empty slots. */
export async function discovered(spec: VgSpec, inputOf: InputOf, around: Around = plainly): Promise<{ read: Set<EnginePart>; out: string } | { error: string }> {
  const read = new Set<EnginePart>()
  withdrawParts(SPEC_PARTS)
  try {
    for (;;) {
      try {
        return { read, out: around(() => drawn(spec, inputOf)) }
      } catch (e) {
        const m = MISSING.exec(e instanceof Error ? e.message : String(e))
        if (!m || read.has(m[1] as EnginePart)) return { error: e instanceof Error ? e.message : String(e) }
        read.add(m[1] as EnginePart)
        await loadParts([m[1] as EnginePart])
      }
    }
  } finally {
    await restoreAll()
  }
}

export interface PartsReport {
  /** what went wrong, one line per spec and fault */
  wrong: string[]
  /** specs compared (drawn with every part, then from empty slots) */
  compared: number
  /** per part: the specs that read it, and the specs whose `specNeeds` names it */
  read: Record<EnginePart, number>
  named: Record<EnginePart, number>
}

/**
 * The check over a list of specs: for each one that draws with every part, the parts it reads must all be named by `specNeeds`, and
 * drawing with just the parts read, and with just the parts named, must equal drawing with all of them.
 */
export async function checkParts(specs: ReadonlyArray<{ name: string; spec: VgSpec }>, inputOf: InputOf, options: { limits?: boolean; random?: boolean }, around: Around = plainly): Promise<PartsReport> {
  const wrong: string[] = []
  const read = Object.fromEntries(SPEC_PARTS.map((p) => [p, 0])) as Record<EnginePart, number>
  const named = { ...read }
  let compared = 0
  for (const { name, spec } of specs) {
    // (a turn of the event loop per spec: a long check must not starve the test runner's own messages)
    await new Promise((resolve) => setImmediate(resolve))
    let all: string
    try { all = around(() => drawn(spec, inputOf)) } catch { continue } // a spec that does not draw at all says nothing about parts
    const needs = new Set(specNeeds(spec, options).parts)
    const found = await discovered(spec, inputOf, around)
    if ('error' in found) { wrong.push(`${name}: draws with every part but not by loading them one at a time: ${found.error.slice(0, 160)}`); continue }
    compared++
    for (const p of found.read) read[p]++
    for (const p of needs) if (p in named) named[p]++
    const missed = [...found.read].filter((p) => !needs.has(p))
    if (missed.length) wrong.push(`${name}: the engine read [${missed}], which specNeeds does not name ([${[...needs]}])`)
    if (found.out !== all) wrong.push(`${name}: drawing with just [${[...found.read]}] differs from drawing with every part`)
    // and with exactly what specNeeds names (what the shells load)
    withdrawParts(SPEC_PARTS)
    try {
      await loadParts([...needs])
      if (around(() => drawn(spec, inputOf)) !== all) wrong.push(`${name}: drawing with the parts specNeeds names differs from drawing with every part`)
    } catch (e) {
      wrong.push(`${name}: does not draw with the parts specNeeds names: ${String(e).slice(0, 160)}`)
    } finally {
      await restoreAll()
    }
  }
  return { wrong, compared, read, named }
}
