/**
 * Test-only scenario driver for the canvas append oracles (excluded from the
 * published build). Produces, step by step, the scene a session or a stream
 * delivers for a random spec and random row edits, plus a way to build the
 * reference scene from scratch. The caller paints: the vitest oracle with a
 * recording context, the Chromium gate with real canvases.
 */
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { applyOp, clone, genSpec, inputOf, int, mulberry32, pick, rowOf, type MarkKind, type Op, type World } from './scene-fuzz.testlib.js'
import type { SceneRoot } from './types.js'

export const CANVAS_KINDS: readonly MarkKind[] = ['symbol', 'symbol', 'text', 'rule', 'rect']
// Append-heavy, with in-place edits of OTHER datasets (editU) and of existing rows.
export const CANVAS_OPS: Op[] = ['append', 'append', 'append', 'append', 'append', 'editU', 'editU', 'edit', 'noop', 'remove', 'insert', 'shuffle']

export interface CanvasStep {
  step: number
  ops: string[]
  /** The scene the session/stream delivered at this step (step -1: the initial scene). */
  scene: SceneRoot
  /** The same state evaluated from a freshly compiled chart. */
  fresh(): SceneRoot
}

export function* canvasScenario(seed: number, nSteps: number, driver: 'session' | 'stream'): Generator<CanvasStep> {
  const r = mulberry32(seed * 104729 + (driver === 'stream' ? 7 : 0))
  const g = genSpec(r, false, CANVAS_KINDS, { dataDomains: seed % 3 === 0 })
  let world: World = {
    t: Array.from({ length: int(r, 4, 12) }, () => rowOf(r, false)),
    u: Array.from({ length: int(r, 2, 6) }, () => rowOf(r, false)),
  }
  const ops: string[] = []
  const freshOf = (w: World) => (): SceneRoot => evaluateChart(compileChart(clone(g.spec) as never), inputOf(w))
  const session = createChartSession()
  const stream = driver === 'stream' ? createChartStream(clone(g.spec) as never, { initial: inputOf(world) }) : null
  let scene: SceneRoot = stream ? stream.flush()!.scene : session.evaluate(clone(g.spec) as never, inputOf(world))
  yield { step: -1, ops: [], scene, fresh: freshOf(world) }
  for (let step = 0; step < nSteps; step++) {
    const op = pick(r, CANVAS_OPS)
    ops.push(op)
    const before = world
    world = applyOp(r, world, op, false)
    // Often TWO edits in one update: an append together with an in-place change elsewhere (C22).
    if (r() < 0.45) { const op2 = pick(r, CANVAS_OPS); ops.push(op2); world = applyOp(r, world, op2, false) }
    if (stream) {
      const pureAppend = ops.length > 0 && world.u === before.u && world.t.length > before.t.length
        && world.t.slice(0, before.t.length).every((row, i) => row === before.t[i])
      if (pureAppend) stream.push({ append: { t: clone(world.t.slice(before.t.length)) } })
      else stream.push({ data: { t: clone(world.t), u: clone(world.u) } })
      scene = stream.flush()?.scene ?? scene
    } else {
      scene = session.evaluate(clone(g.spec) as never, inputOf(world))
    }
    yield { step, ops: ops.slice(), scene, fresh: freshOf(world) }
  }
}
