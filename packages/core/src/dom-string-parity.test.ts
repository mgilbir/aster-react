// @vitest-environment jsdom
/**
 * DOM descriptor vs string renderer parity (audit C43, T2).
 *
 * `dom.ts` claimed the two renderers "can never drift". They did: the first
 * `patchSceneDom` over a string-rendered <svg> rewrote attributes (gradient
 * direction, dashes, linecaps, frame radius, ...). For every scene of the
 * conformance corpus (Vega and Vega-Lite specs, plus hand-built scenes covering
 * what the corpus does not), the DOM the patch path produces must be
 * attribute-for-attribute identical to the parsed output of `renderSceneToSvg`.
 *
 * There is NO allow-list of tolerated differences: the two renderers take every
 * attribute from one per-mark list (render.ts), so any difference is a bug.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as vl from 'vega-lite'
import { compileChart, evaluateChart } from './index.js'
import './addon-geo.js'
import './addon-transforms.js'
import { loadSpecData } from './addon-load.js'
import { parityDiff } from './dom-canon.testlib.js'
import type { SceneRoot } from './types.js'

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../conformance/corpus')

describe('DOM descriptor === string renderer (audit C43)', () => {
  it('holds for every scene of the conformance corpus', async () => {
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
    expect(files.length).toBeGreaterThan(300)
    const failures: string[] = []
    let checked = 0
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
      let spec = doc.spec ?? doc
      if (f.endsWith('.vl.json')) spec = vl.compile(spec).spec
      let scene: SceneRoot
      try {
        scene = evaluateChart(compileChart(await loadSpecData(spec)), {})
      } catch (e) {
        failures.push(`${f}: could not build the scene: ${(e as Error).message}`)
        continue
      }
      checked++
      let d: string | null
      try { d = parityDiff(scene) } catch (e) { d = `threw ${(e as Error).message}` }
      if (d) failures.push(`${f}: ${d}`)
    }
    expect(checked).toBeGreaterThan(300)
    expect(failures.join('\n'), `${failures.length} corpus scene(s) differ between the string and DOM renderers`).toBe('')
  }, 600_000)
})
