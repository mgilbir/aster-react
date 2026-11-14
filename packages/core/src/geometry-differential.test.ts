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

describe('mark geometry: old vs new, every consumer', () => {
  it('the vega corpus', () => {
    const dirs = ['../../conformance/corpus', '../../conformance/corpus-vega-only'].map((d) => join(here, d))
    const names = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.vg.json')).map((f) => join(d, f)))
    expect(names.length).toBeGreaterThan(300)
    const fails: string[] = []
    let checked = 0
    const r = mulberry32(11)
    for (const file of names) {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      let scene: SceneRoot
      try { scene = evaluateChart(compileChart(doc.spec ?? doc), {}) } catch { continue }
      checked++
      report(file.split('/').pop()!, diffScene(scene, r), fails)
    }
    expect(checked).toBeGreaterThan(300)
    expect(fails).toEqual([])
  }, 600_000)

  it('random hand-built scenes', () => {
    const fails: string[] = []
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed)
      diffTwice(randomScene(r), r, `seed ${seed}`, fails, { intersect: false })
      diffTwice(randomScene(r, true), r, `seed ${seed} (finite)`, fails)
    }
    expect(fails).toEqual([])
  }, 600_000)

  it('random specs and their incremental updates (reused items), with the canvas append path', () => {
    const fails: string[] = []
    for (let seed = 1; seed <= 60; seed++) {
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
  }, 600_000)

  it('transition frames: one scene object rewritten in place, frame after frame', () => {
    const fails: string[] = []
    for (let seed = 1; seed <= 40; seed++) {
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
  }, 600_000)
})
