// @vitest-environment jsdom
/**
 * DOM patch oracle (audit C3, T2).
 *
 * The contract: patching a live <svg> step by step with `patchSceneDom` yields
 * the SAME DOM as building the final scene from scratch. The reference is built
 * from a freshly compiled chart (never from the incremental scene's own cached
 * descriptors), so a stale descriptor, a positional skip or a mis-keyed
 * reuse shows up as a DOM difference.
 *
 * Random scene sequences come from a session (`createChartSession`) over random
 * specs and row edits (insert/remove/append/edit/shuffle/...), the generator idea
 * of incremental-oracle.test.ts, widened to every mark the descriptor builder
 * handles and run both per-item and with `denseMarks`.
 *
 * Knobs: ASTER_DOM_ORACLE_SEEDS (default 40), ASTER_DOM_ORACLE_STEPS (default 10),
 * ASTER_DOM_ORACLE_SEED (one seed), ASTER_DOM_ORACLE_START.
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { patchSceneDom, renderSceneToDomElement } from './addon-dom.js'
import { createChartSession } from './session.js'
import { canon, firstDomDiff } from './dom-canon.testlib.js'
import type { DomRenderOptions } from './dom.js'
import type { SceneRoot } from './types.js'
import { applyOp, clone, genSpec, inputOf, int, mulberry32, OPS, pick, rowOf, type World } from './scene-fuzz.testlib.js'

export interface DomFailure { seed: number; label: string; step: number; ops: string[]; detail: string }

/** Run one scenario. `fromString` mounts the first scene the way <Chart> does (string, then patch). */
export function runDomScenario(seed: number, nSteps: number, dense: boolean, fromString: boolean): DomFailure | null {
  const r = mulberry32(seed * 7919 + (dense ? 1 : 0))
  const g = genSpec(r, dense)
  const options: DomRenderOptions = dense ? { denseMarks: true, denseChunkSize: 32 } : {}
  let world: World = {
    t: Array.from({ length: dense ? int(r, 520, 700) : int(r, 3, 9) }, () => rowOf(r, dense)),
    u: Array.from({ length: int(r, 1, 4) }, () => rowOf(r, dense)),
  }
  const ops: string[] = []
  const session = createChartSession()
  const fresh = (w: World): Element => {
    const scene = evaluateChart(compileChart(clone(g.spec) as never), inputOf(w))
    return renderSceneToDomElement(scene, document, options)
  }
  const svgNs = 'http://www.w3.org/2000/svg'
  let svg: Element
  let scene: SceneRoot = session.evaluate(clone(g.spec) as never, inputOf(world))
  if (fromString) {
    const host = document.createElement('div')
    // mount through the string renderer exactly like <Chart>
    host.innerHTML = renderSceneToSvg(scene)
    svg = host.firstElementChild!
  } else {
    svg = document.createElementNS(svgNs, 'svg')
    patchSceneDom(svg, scene, options)
  }
  const fail = (step: number, detail: string): DomFailure => ({ seed, label: g.label, step, ops: ops.slice(), detail })
  for (let step = 0; step < nSteps; step++) {
    const op = pick(r, OPS)
    ops.push(op)
    world = applyOp(r, world, op, dense)
    scene = session.evaluate(clone(g.spec) as never, inputOf(world))
    patchSceneDom(svg, scene, options)
    const d = firstDomDiff(canon(fresh(world)), canon(svg))
    if (d) return fail(step, d)
  }
  return null
}

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
const SEEDS = Number(env('ASTER_DOM_ORACLE_SEEDS') ?? 40)
const STEPS = Number(env('ASTER_DOM_ORACLE_STEPS') ?? 10)
const START = Number(env('ASTER_DOM_ORACLE_START') ?? 1)
const ONE = env('ASTER_DOM_ORACLE_SEED')

describe('patched DOM === DOM built fresh from the final scene (audit C3)', () => {
  const seeds = ONE != null ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => START + i)
  for (const dense of [false, true]) {
    for (const fromString of [false, true]) {
      const name = `${dense ? 'dense' : 'per-item'} marks, mounted from ${fromString ? 'the SVG string' : 'an empty svg'}`
      it(`${name}: ${seeds.length} seeds x ${STEPS} steps`, () => {
        const failures: string[] = []
        // dense scenarios build 500+ element scenes: fewer seeds keep the suite fast
        for (const seed of dense ? seeds.slice(0, Math.max(4, Math.ceil(seeds.length / 4))) : seeds) {
          const f = runDomScenario(seed, STEPS, dense, fromString)
          if (f) failures.push(`seed=${f.seed} [${f.label}] step ${f.step} after ops ${f.ops.join(',')}\n    ${f.detail}`)
          if (failures.length >= 5) break
        }
        expect(failures.join('\n'), `${failures.length} failing seed(s)`).toBe('')
      }, 300_000)
    }
  }
})
