/**
 * Canvas append-paint oracle (audit C22).
 *
 * The contract: whatever the canvas shows after `renderSceneToCanvasAppend`
 * returned true - the prior frames' paint plus the appended items - must be what a
 * full repaint of the new scene shows. With a recording context (no clearRect
 * semantics needed: an append adds paint records, a full repaint replaces them)
 * that is a multiset equality of paint records (absolute geometry + paint state +
 * clip), checked after every step of random scene sequences driven through a
 * session and through a stream. A stale item left at its old position, a
 * changed guide painted on top of its old self, or a missed in-place edit in
 * ANOTHER group all show up as extra/missing records.
 *
 * The reference is a full repaint of a scene evaluated from a freshly compiled
 * chart, so a wrong incremental scene fails here too.
 *
 * Z-order is not visible to a multiset: the real-Chromium pixel check lives in
 * packages/conformance/scripts/browser-canvas-append.mts (gate `canvas-append`).
 */
import { describe, it, expect } from 'vitest'
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from './canvas.js'
import { makeRecorder, diffPaintMultisets, type PaintRecord } from './canvas-record.testlib.js'
import { canvasScenario } from './canvas-append-scenario.testlib.js'
import type { SceneRoot } from './types.js'

const full = (scene: SceneRoot): PaintRecord[] => {
  const { ctx, records } = makeRecorder()
  renderSceneToCanvas(scene, ctx, { batchSymbols: false })
  return records
}

export interface CanvasFailure { seed: number; driver: string; step: number; ops: string[]; detail: string }

export function runCanvasScenario(seed: number, nSteps: number, driver: 'session' | 'stream'): { failure: CanvasFailure | null; appended: number } {
  let snap: ReturnType<typeof snapshotCanvasScene> | null = null
  let painted: PaintRecord[] = []
  let appended = 0
  for (const st of canvasScenario(seed, nSteps, driver)) {
    let how = 'initial paint'
    if (snap == null) painted = full(st.scene)
    else {
      const { ctx, records } = makeRecorder()
      const ok = renderSceneToCanvasAppend(snap, st.scene, ctx, { dpr: 1, batchSymbols: false })
      if (ok) { painted = painted.concat(records); appended++; how = 'append path' } else { painted = full(st.scene); how = 'full repaint' }
    }
    snap = snapshotCanvasScene(st.scene)
    const d = diffPaintMultisets(full(st.fresh()), painted)
    if (d) return { failure: { seed, driver, step: st.step, ops: st.ops, detail: `${how}: ${d}` }, appended }
  }
  return { failure: null, appended }
}

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
const SEEDS = Number(env('ASTER_CANVAS_ORACLE_SEEDS') ?? 60)
const STEPS = Number(env('ASTER_CANVAS_ORACLE_STEPS') ?? 12)
const START = Number(env('ASTER_CANVAS_ORACLE_START') ?? 1)
const ONE = env('ASTER_CANVAS_ORACLE_SEED')

describe('canvas append paint === full repaint (audit C22)', () => {
  const seeds = ONE != null ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => START + i)
  for (const driver of ['session', 'stream'] as const) {
    it(`${driver}: ${seeds.length} seeds x ${STEPS} steps`, () => {
      const failures: string[] = []
      let appended = 0
      for (const seed of seeds) {
        const res = runCanvasScenario(seed, STEPS, driver)
        appended += res.appended
        const f = res.failure
        if (f) failures.push(`seed=${f.seed} step ${f.step} after ops ${f.ops.join(',')}\n    ${f.detail}`)
        if (failures.length >= 5) break
      }
      expect(failures.join('\n'), `${failures.length} failing seed(s)`).toBe('')
      // not vacuous: the append path must actually engage in the generated sequences
      if (ONE == null) expect(appended).toBeGreaterThan(seeds.length)
    }, 300_000)
  }
})
