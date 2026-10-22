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
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.json')).sort()
  const failures: string[] = []
  it(`all ${files.length} corpus scenes describe the same document`, async () => {
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'))
      const spec = f.endsWith('.vl.json') ? (vl.compile(raw as never).spec as Record<string, unknown>) : raw
      const loaded = await loadSpecData(spec as never)
      const scene = evaluateChart(compileChart(loaded as never))
      const str = renderSceneToSvg(scene)
      // jsdom's serializer invents a prefix (ns1:) for the xlink namespace; it is the same attribute
      const dom = new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
        .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')
      const d = diffCanonical(canonicalizeSvg(str), canonicalizeSvg(dom))
      if (d.length) failures.push(`${f}: ${d[0]!.slice(0, 200)}`)
    }
    expect(failures.slice(0, 15), `${failures.length} of ${files.length} differ`).toEqual([])
  })
})
