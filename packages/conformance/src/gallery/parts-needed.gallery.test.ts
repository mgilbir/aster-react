// @vitest-environment jsdom
/**
 * Part of the gallery gate (`pnpm conformance:gallery`, which runs it with vitest.gallery.config.mjs after the cache is verified): the
 * check of parts-needed.test.ts over the vendored Vega and Vega-Lite galleries. Every gallery spec, its data loaded from the pinned
 * datasets (Vega-Lite through @aster-charts/vl, as `<Chart>` compiles it), is drawn with every part and from empty slots
 * (parts-needed.testlib.ts: evaluation, svg, canvas, picks, and the signal loop answering a user's pointer), with the gate's seeded
 * random source and frozen clock: every part the drawing reads must be named by `specNeeds`, and a drawing with just the named parts
 * must equal one with all of them.
 */
import { describe, expect, it } from 'vitest'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile } from '@aster-charts/vl'
import type { VgSpec } from '@aster-charts/core'
import { checkLoad, checkParts } from '../parts-needed.testlib.js'
import { BASE_URL, fileFetch, listGallery, readSpec } from './lib.js'
import { seededRandom, withFrozenClock } from './seeded.js'

describe('specNeeds names every part the engine reads, over the galleries', async () => {
  const gallery = listGallery()
  const specs: Array<{ name: string; spec: VgSpec }> = []
  const raw: Array<{ name: string; spec: VgSpec }> = []
  for (const g of gallery) {
    try {
      const src = readSpec(g)
      const vg = g.kind === 'vl' ? (compile(JSON.parse(JSON.stringify(src)) as never) as Record<string, unknown>) : src
      raw.push({ name: g.id, spec: vg as VgSpec })
      specs.push({ name: g.id, spec: await loadSpecData(JSON.parse(JSON.stringify(vg)) as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL }) as VgSpec })
    } catch { /* a spec that does not compile or load is the static path's to report, not a case of parts */ }
  }

  it('covers the galleries', () => {
    expect(gallery.length).toBeGreaterThan(700)
    expect(specs.length).toBeGreaterThan(650)
  })

  it('loads a spec\'s data with the parts the loader reads, whatever is already in the page', async () => {
    const { wrong, loaded } = await checkLoad(raw, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
    console.log(`[parts-needed.gallery] loader: ${loaded} of ${raw.length} specs loaded from empty slots`)
    expect(wrong.slice(0, 20).join('\n'), `${wrong.length} wrong`).toBe('')
    expect(loaded).toBeGreaterThan(650)
  }, 3_600_000)

  it('names every part the drawing reads, and draws with just those what it draws with all', async () => {
    const input = () => ({ random: seededRandom(), urlPolicy: { baseURL: BASE_URL } })
    const { wrong, compared, read, named } = await checkParts(specs, input, { random: true }, withFrozenClock)
    console.log(`[parts-needed.gallery] ${compared} of ${specs.length} specs; read ${JSON.stringify(read)}; named ${JSON.stringify(named)}`)
    expect(wrong.slice(0, 20).join('\n'), `${wrong.length} wrong`).toBe('')
    expect(compared).toBeGreaterThan(650)
    // not vacuous: the galleries read every family a spec can name
    for (const p of ['aggregate', 'window', 'reshape', 'time', 'curves', 'color', 'scales', 'legend', 'layout', 'selections'] as const) {
      expect(read[p], `${p} is read by some gallery specs`).toBeGreaterThan(2)
    }
  }, 3_600_000)
})
