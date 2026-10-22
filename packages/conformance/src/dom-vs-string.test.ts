// @vitest-environment jsdom
/**
 * The DOM descriptors (what `patchSceneDom` and `renderSceneToDomElement` build) must
 * describe the same document as the string renderer. They keep separate attribute
 * lists (audit C43/T2); this compares the two over the whole corpus under the strict
 * canonicalizer so the lists cannot drift on anything that paints.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { loadSpecData } from '@aster/core/load'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')

describe('DOM descriptors vs string renderer (strict canonical form)', () => {
  // one test per corpus scene: a single loop over all 419 exceeded the 5 s default under a parallel suite
  for (const f of readdirSync(CORPUS).filter((n) => n.endsWith('.json')).sort()) {
    it(f, async () => {
      const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'))
      const spec = f.endsWith('.vl.json') ? (vl.compile(raw as never).spec as Record<string, unknown>) : raw
      const loaded = await loadSpecData(spec as never)
      const scene = evaluateChart(compileChart(loaded as never))
      // jsdom's serializer invents a prefix (ns1:) for the xlink namespace; it is the same attribute
      const dom = new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
        .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')
      expect(diffCanonical(canonicalizeSvg(renderSceneToSvg(scene)), canonicalizeSvg(dom))).toEqual([])
    })
  }
})
