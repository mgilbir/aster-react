/**
 * Mark geometry, old implementation vs new, consumer by consumer (see geometry-differential.testlib.ts): the vega corpus, random
 * specs through the evaluator (and their incremental updates, where items are reused), random hand-built scenes that reach the
 * renderers without the evaluator's normalisation (NaN, infinities, -0, strings, every curve, custom symbol paths, rounded and
 * clipped rects, arcs with corners and pads...), transition frames (one scene object rewritten in place), and the canvas append path.
 * Each scene is also drawn twice in a row, so a cached geometry is compared as well as a fresh one.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createSceneTransition } from './transition.js'
import type { SceneRoot } from './types.js'
import { diffAppend, diffScene, type Diff } from './geometry-differential.testlib.js'
import { applyOp, genSpec, inputOf, int, mulberry32, OPS, pick, rowOf, type World } from './scene-fuzz.testlib.js'
import { randomScene } from './geometry-scenes.testlib.js'
import { sceneIntersect } from './scene-intersect.js'
import { AsterLimitError } from './limits.js'

type Rnd = () => number
const here = dirname(fileURLToPath(import.meta.url))

function report(label: string, diffs: Diff[], sink: string[]): void {
  for (const d of diffs) if (sink.length < 20) sink.push(`${label} [${d.consumer}] ${d.detail.slice(0, 400)}`)
}

/** Both draws: fresh, then again on the same scene (cached geometry). */
function diffTwice(scene: SceneRoot, r: Rnd, label: string, sink: string[], opts?: Parameters<typeof diffScene>[2]): void {
  report(label, diffScene(scene, r, opts), sink)
  report(`${label} (again)`, diffScene(scene, r, opts), sink)
}

// --- the tests ---------------------------------------------------------------------------------------------------------------

/** [from, to] in runs of `size`: each run is its own test, so no test holds the worker for long (it answers its RPCs between them). */
const runs = (from: number, to: number, size: number): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let a = from; a <= to; a += size) out.push([a, Math.min(to, a + size - 1)])
  return out
}

const CORPUS = ['../../conformance/corpus', '../../conformance/corpus-vega-only'].map((d) => join(here, d))
  .flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.vg.json')).map((f) => join(d, f)))

describe('mark geometry: old vs new, every consumer', () => {
  it('the corpus is there', () => { expect(CORPUS.length).toBeGreaterThan(300) })

  for (const [lo, hi] of runs(0, CORPUS.length - 1, 60)) {
    it(`the vega corpus, specs ${lo}-${hi}`, () => {
      const fails: string[] = []
      const r = mulberry32(11 + lo)
      for (const file of CORPUS.slice(lo, hi + 1)) {
        const doc = JSON.parse(readFileSync(file, 'utf8'))
        let scene: SceneRoot
        try { scene = evaluateChart(compileChart(doc.spec ?? doc), {}) } catch { continue }
        report(file.split('/').pop()!, diffScene(scene, r), fails)
      }
      expect(fails).toEqual([])
    }, 60_000)
  }

  for (const [lo, hi] of runs(1, 400, 25)) {
    it(`random hand-built scenes, seeds ${lo}-${hi}`, () => {
      const fails: string[] = []
      for (let seed = lo; seed <= hi; seed++) {
        const r = mulberry32(seed)
        // (intersect: the legacy copy cannot take a non-finite scene: see the next describe)
        diffTwice(randomScene(r), r, `seed ${seed}`, fails, { intersect: false })
        diffTwice(randomScene(r, true), r, `seed ${seed} (finite)`, fails)
      }
      expect(fails).toEqual([])
    }, 60_000)
  }

  for (const [lo, hi] of runs(1, 60, 10)) {
    it(`random specs and their incremental updates (reused items), with the canvas append path, seeds ${lo}-${hi}`, () => {
      const fails: string[] = []
      for (let seed = lo; seed <= hi; seed++) {
        const r = mulberry32(1000 + seed)
        const g = genSpec(r, r() < 0.2)
        const chart = compileChart(g.spec as never)
        let world: World = { t: Array.from({ length: int(r, 1, 25) }, () => rowOf(r, g.dense)), u: Array.from({ length: 3 }, () => rowOf(r, g.dense)) }
        let prev: SceneRoot
        try { prev = evaluateChart(chart, inputOf(world)) } catch { continue }
        diffTwice(prev, r, `${g.label} seed ${seed}`, fails)
        for (let step = 0; step < 4; step++) {
          world = applyOp(r, world, pick(r, OPS), g.dense)
          let next: SceneRoot
          try { next = evaluateChart(chart, inputOf(world)) } catch { break }
          diffTwice(next, r, `${g.label} seed ${seed} step ${step}`, fails, { intersect: false, label2: false })
          report(`${g.label} seed ${seed} step ${step}`, diffAppend(prev, next), fails)
          prev = next
        }
      }
      expect(fails).toEqual([])
    }, 60_000)
  }

  for (const [lo, hi] of runs(1, 40, 10)) {
    it(`transition frames: one scene object rewritten in place, frame after frame, seeds ${lo}-${hi}`, () => {
      const fails: string[] = []
      for (let seed = lo; seed <= hi; seed++) {
        const r = mulberry32(5000 + seed)
        const g = genSpec(r, false)
        const chart = compileChart(g.spec as never)
        const world: World = { t: Array.from({ length: int(r, 2, 15) }, () => rowOf(r, false)), u: [rowOf(r, false)] }
        let a: SceneRoot, b: SceneRoot
        try {
          a = evaluateChart(chart, inputOf(world))
          b = evaluateChart(chart, inputOf({ t: world.t.map((row) => ({ ...row, v: int(r, 0, 24), x: int(r, 0, 12) })), u: world.u }))
        } catch { continue }
        const tr = createSceneTransition(a, b)
        for (const t of [0, 0.25, 0.5, 0.75, 1]) diffTwice(tr.at(t), r, `${g.label} seed ${seed} t=${t}`, fails, { intersect: false, label2: false })
      }
      expect(fails).toEqual([])
    }, 60_000)
  }
})

describe('sceneIntersect on non-finite scenes', () => {
  // The legacy copy of intersect() hangs on these (seed 112), so the differential leaves it out for them. The current one is checked
  // here on its own: it ends on every NaN / infinite arc, shape and path, quickly, and refuses only with an AsterLimitError (a
  // region beyond 2^52 or a walk past its ceiling); it never throws anything else.
  const BOXES: Array<[[number, number], [number, number]]> = [[[0, 0], [300, 200]], [[10, 10], [20, 20]], [[-1e9, -1e9], [1e9, 1e9]], [[0, 0], [0, 0]], [[250, 150], [40, 30]], [[Number.NEGATIVE_INFINITY, 0], [100, Number.POSITIVE_INFINITY]]]
  for (const [lo, hi] of [[1, 100], [101, 200], [201, 300], [301, 400]] as const) {
    it(`seeds ${lo}-${hi}: each call ends within 500 ms and throws only AsterLimitError`, () => {
      let calls = 0
      let refused = 0
      let found = 0
      let worst = 0
      for (let seed = lo; seed <= hi; seed++) {
        const scene = randomScene(mulberry32(seed), false)
        for (const box of BOXES) {
          const t0 = performance.now()
          try {
            const hit = sceneIntersect(scene, box, null, null)
            expect(Array.isArray(hit), `seed ${seed}`).toBe(true)
            found += hit.length
          } catch (e) {
            if (!(e instanceof AsterLimitError)) throw new Error(`seed ${seed} box ${JSON.stringify(box)}: ${(e as Error).name}: ${(e as Error).message}`)
            refused++
          }
          worst = Math.max(worst, performance.now() - t0)
          calls++
        }
      }
      expect(calls).toBe((hi - lo + 1) * BOXES.length)
      expect(worst, 'slowest call (ms)').toBeLessThan(500)
      expect(refused, 'refusals are rare: the scenes are answered').toBeLessThan(calls / 10)
      expect(found, 'items found').toBeGreaterThan(100)
    }, 60_000)
  }
})
