/**
 * Mark geometry, old implementation vs new, consumer by consumer (see geometry-differential.testlib.ts): the vega corpus, random
 * specs through the evaluator (and their incremental updates, where items are reused), random hand-built scenes that reach the
 * renderers without the evaluator's normalisation (NaN, infinities, -0, strings, every curve, custom symbol paths, rounded and
 * clipped rects, arcs with corners and pads...), transition frames (one scene object rewritten in place), and the canvas append path.
 * Each scene is also drawn twice in a row, so a cached geometry is compared as well as a fresh one.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import './addon-transforms.js'
import './addon-geo.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createSceneTransition } from './transition.js'
import type { SceneRoot } from './types.js'
import { diffAppend, diffScene, marksOf, type Diff } from './geometry-differential.testlib.js'
import { applyOp, genSpec, inputOf, int, mulberry32, OPS, pick, rowOf, type World } from './scene-fuzz.testlib.js'
import { randomScene } from './geometry-scenes.testlib.js'
import { CORPUS_UNLOADABLE, isDataNotLoaded, vegaCorpusFiles } from './corpus.testlib.js'
import { buildHitIndex } from './hit.js'
import { renderSceneToSvg } from './render.js'
import { diffStats } from './geometry-differential.testlib.js'
import { sceneIntersect } from './scene-intersect.js'
import { AsterLimitError } from './limits.js'

type Rnd = () => number

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

const CORPUS = vegaCorpusFiles()

describe('mark geometry: old vs new, every consumer', () => {
  it('the corpus is there', () => { expect(CORPUS.length).toBeGreaterThan(300) })

  for (const [lo, hi] of runs(0, CORPUS.length - 1, 60)) {
    it(`the vega corpus, specs ${lo}-${hi}`, () => {
      const fails: string[] = []
      const r = mulberry32(11 + lo)
      const files = CORPUS.slice(lo, hi + 1)
      let drawn = 0
      for (const file of files) {
        const doc = JSON.parse(readFileSync(file, 'utf8'))
        let scene: SceneRoot
        // (a spec that cannot be evaluated is a failure, not a skip: only a url dataset has nothing to draw)
        try { scene = evaluateChart(compileChart(doc.spec ?? doc), {}) } catch (e) {
          if (!isDataNotLoaded(e)) throw e
          continue
        }
        drawn++
        report(file.split('/').pop()!, diffScene(scene, r), fails)
      }
      expect(fails).toEqual([])
      expect(drawn + files.filter((f) => CORPUS_UNLOADABLE.some((n) => f.endsWith(n))).length).toBe(files.length)
    }, 60_000)
  }

  it('every spec of the corpus is drawn but the ones without data, and it draws the marks of the add-ons too', () => {
    const skipped: string[] = []
    const marks: Record<string, number> = {}
    for (const file of CORPUS) {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      let scene: SceneRoot
      try { scene = evaluateChart(compileChart(doc.spec ?? doc), {}) } catch (e) {
        if (!isDataNotLoaded(e)) throw e
        skipped.push(file.split('/').pop()!)
        continue
      }
      for (const { mark } of marksOf(scene)) marks[String(mark.marktype)] = (marks[String(mark.marktype)] ?? 0) + (mark.items ?? []).length
    }
    expect(skipped.sort()).toEqual(CORPUS_UNLOADABLE)
    // items drawn by mark type (measured 636 / 554 / 513 / 402 / 114 / 100 / 80 / 58 / 22 / 8 / 2): the projected shapes and the
    // labelled, forced and contoured marks of the add-ons are in it, and a change that made specs throw or draw nothing is not
    for (const [type, floor] of Object.entries({ area: 600, rect: 520, line: 480, symbol: 380, text: 100, path: 90, shape: 70, arc: 50, rule: 20, trail: 8, image: 2 })) {
      expect(marks[type] ?? 0, type).toBeGreaterThanOrEqual(floor)
    }
  })

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
      let unusable = 0 // generated specs that threw: each is a spec the walk did not compare
      for (let seed = lo; seed <= hi; seed++) {
        const r = mulberry32(1000 + seed)
        const g = genSpec(r, r() < 0.2)
        const chart = compileChart(g.spec as never)
        let world: World = { t: Array.from({ length: int(r, 1, 25) }, () => rowOf(r, g.dense)), u: Array.from({ length: 3 }, () => rowOf(r, g.dense)) }
        let prev: SceneRoot
        try { prev = evaluateChart(chart, inputOf(world)) } catch { unusable++; continue }
        diffTwice(prev, r, `${g.label} seed ${seed}`, fails)
        for (let step = 0; step < 4; step++) {
          world = applyOp(r, world, pick(r, OPS), g.dense)
          let next: SceneRoot
          try { next = evaluateChart(chart, inputOf(world)) } catch { unusable++; break }
          diffTwice(next, r, `${g.label} seed ${seed} step ${step}`, fails, { intersect: false, label2: false })
          report(`${g.label} seed ${seed} step ${step}`, diffAppend(prev, next), fails)
          prev = next
        }
      }
      expect(fails).toEqual([])
      expect(unusable, 'generated specs that threw and were not compared').toBe(0)
    }, 60_000)
  }

  for (const [lo, hi] of runs(1, 40, 10)) {
    it(`transition frames: one scene object rewritten in place, frame after frame, seeds ${lo}-${hi}`, () => {
      const fails: string[] = []
      let unusable = 0
      for (let seed = lo; seed <= hi; seed++) {
        const r = mulberry32(5000 + seed)
        const g = genSpec(r, false)
        const chart = compileChart(g.spec as never)
        const world: World = { t: Array.from({ length: int(r, 2, 15) }, () => rowOf(r, false)), u: [rowOf(r, false)] }
        let a: SceneRoot, b: SceneRoot
        try {
          a = evaluateChart(chart, inputOf(world))
          b = evaluateChart(chart, inputOf({ t: world.t.map((row) => ({ ...row, v: int(r, 0, 24), x: int(r, 0, 12) })), u: world.u }))
        } catch { unusable++; continue }
        const tr = createSceneTransition(a, b)
        for (const t of [0, 0.25, 0.5, 0.75, 1]) diffTwice(tr.at(t), r, `${g.label} seed ${seed} t=${t}`, fails, { intersect: false, label2: false })
      }
      expect(fails).toEqual([])
      expect(unusable, 'generated specs that threw and were not compared').toBe(0)
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

describe('a trail with a negative size', () => {
  // A trail's size is a radius, and a negative radius is an error in d3-path and in vega (`negative radius: -1`): every renderer and
  // the hit index throw it, as `vega.toSVG` does (the audit ran both: scratch negative-trail.mjs). It is a plain Error, listed in
  // docs/ERRORS.md. The generated scenes keep their trail sizes non-negative; this is the one place it is exercised.
  const spec = (sizes: number[]): never => ({
    width: 100, height: 100, autosize: 'none', padding: 0,
    data: [{ name: 't', values: sizes.map((s, i) => ({ i, s })) }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: 'width' }],
    marks: [{ type: 'trail', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'i' }, y: { value: 50 }, size: { field: 's' }, fill: { value: 'red' } } } }],
  }) as never
  it('throws "negative radius" out of the SVG, not an [aster] error', () => {
    expect(() => renderSceneToSvg(evaluateChart(compileChart(spec([6, -2, 4])), {}))).toThrow(/^negative radius: -1$/)
  })
  it('throws it out of the hit index too, and answers when every size is not negative', () => {
    const bad = evaluateChart(compileChart(spec([6, -2, 4])), {})
    expect(() => buildHitIndex(bad)).toThrow(/^negative radius: -1$/)
    const good = evaluateChart(compileChart(spec([6, 0, 4])), {})
    expect(renderSceneToSvg(good)).toContain('<path')
    expect(buildHitIndex(good).size()).toBeGreaterThan(0)
  })
})

describe('the differential compares values, not error messages', () => {
  it('fewer than 0.5% of its consumer calls had both implementations throw', () => {
    // (diffStats counts this whole file's runs so far: the scenes above are the corpus, the random specs and the hand-built scenes)
    expect(diffStats.scenes, 'scenes compared').toBeGreaterThan(500)
    expect(diffStats.bothThrew, `of ${diffStats.calls} calls`).toBeLessThan(diffStats.calls * 0.005)
  })
})
