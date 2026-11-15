/**
 * `specNeeds(spec).parts` (what the React shells load before a chart's first render, @aster-charts/core/lean) never misses a part the
 * engine reads, and a chart rendered with just the parts it names is the chart rendered with all of them.
 *
 * The ground truth is the engine itself, as in addons-needed.test.ts. Every corpus spec (Vega, and Vega-Lite through the pinned
 * vega-lite compiler) is evaluated with every part in its slot, then again as a browser build of the shells would: with the slots
 * empty, each "part ... is not loaded" failure names the part to load, which is then loaded and the evaluation repeated until it
 * succeeds. The parts loaded that way are the ones the spec reads. `specNeeds` must name every one of them (it may name more: it
 * reads the structure, and a field-driven symbol shape may or may not be a path), and an evaluation with exactly the parts it names
 * must draw the same svg and pick the same items as the one with all of them. The same again under `limits`, where the regular-
 * expression screen runs.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import {
  createChartSession, renderSceneToSvg, specNeeds, loadParts, partLoaded, withdrawParts, ENGINE_PARTS, type EnginePart,
} from '@aster-charts/core/lean'
import { buildHitIndex } from '@aster-charts/core/lean/hit'
import type { RuntimeInput, SceneRoot, SpecLimits, VgSpec } from '@aster-charts/core'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')
const CORPUS_VEGA_ONLY = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus-vega-only')
/** The parts a spec can ask for (the canvas renderer is asked for by `renderer="canvas"`, not by a spec). */
const SPEC_PARTS = ENGINE_PARTS.filter((p) => p !== 'canvas')
const MISSING = /the "(\w+)" part of the engine is not loaded/
/** Generous limits: the screen runs, nothing a corpus spec does is refused for its size. */
const LIMITS: SpecLimits = { maxRows: 10_000_000, maxTimeMs: 600_000 }

/** What a chart draws and picks: its svg, and the item under each point of a grid over the view. */
function drawn(scene: SceneRoot): string {
  const svg = renderSceneToSvg(scene)
  const index = buildHitIndex(scene)
  const w = Math.max(1, Number((scene as { width?: number }).width) || 200)
  const h = Math.max(1, Number((scene as { height?: number }).height) || 200)
  const picks: string[] = []
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const hit = index.pick((w * i) / 8, (h * j) / 8) as { marktype?: string; role?: string; datum?: unknown } | null
      picks.push(hit ? `${hit.marktype}/${hit.role}/${JSON.stringify(hit.datum ?? null)?.slice(0, 80)}` : '-')
    }
  }
  return `${svg}\n${picks.join('|')}`
}

const evaluate = (spec: VgSpec, input: RuntimeInput): string => drawn(createChartSession().evaluate(spec, input))

/** Every part in its slot again (`withdrawParts` gives back what it took; loading puts back what a test took since). */
async function restoreAll(): Promise<void> {
  await loadParts(SPEC_PARTS.filter((p) => !partLoaded(p)))
}

/** The parts the engine reads for `spec`, found one failure at a time from empty slots. */
async function discovered(spec: VgSpec, input: RuntimeInput): Promise<{ read: Set<EnginePart>; out: string } | { error: string }> {
  const read = new Set<EnginePart>()
  withdrawParts(SPEC_PARTS)
  try {
    for (;;) {
      try {
        return { read, out: evaluate(spec, input) }
      } catch (e) {
        const m = MISSING.exec(e instanceof Error ? e.message : String(e))
        if (!m || read.has(m[1] as EnginePart)) return { error: e instanceof Error ? e.message : String(e) }
        read.add(m[1] as EnginePart)
        await loadParts([m[1] as EnginePart])
      }
    }
  } finally {
    await restoreAll()
  }
}

describe('specNeeds names every part the engine reads, over the whole corpus', async () => {
  const specs: Array<{ name: string; spec: VgSpec }> = []
  for (const dir of [CORPUS, CORPUS_VEGA_ONLY]) {
    for (const f of readdirSync(dir).sort()) {
      const kind = f.endsWith('.vl.json') ? 'vl' : f.endsWith('.vg.json') ? 'vg' : null
      if (!kind) continue
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as VgSpec
      let spec = (doc.$schema ? doc : ((doc as { spec?: VgSpec }).spec ?? doc)) as VgSpec
      if (kind === 'vl') {
        try { spec = vl.compile(spec as never).spec as unknown as VgSpec } catch { continue }
      }
      try { specs.push({ name: f, spec: await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS) as VgSpec }) } catch { /* a spec whose data cannot load is not a rendering case */ }
    }
  }

  it('covers the corpus', () => { expect(specs.length).toBeGreaterThan(900) })

  for (const [mode, input] of [['without limits', {}], ['under limits', { limits: LIMITS }]] as const) {
    it(`${mode}: names every part the evaluation reads, and draws with just those what it draws with all`, async () => {
      const wrong: string[] = []
      const counts = Object.fromEntries(SPEC_PARTS.map((p) => [p, 0])) as Record<EnginePart, number>
      const named = { ...counts }
      let compared = 0
      for (const { name, spec } of specs) {
        let all: string
        try { all = evaluate(spec, input) } catch { continue } // a spec that does not evaluate at all says nothing about parts
        const needs = new Set(specNeeds(spec, { limits: 'limits' in input }).parts)
        const found = await discovered(spec, input)
        if ('error' in found) { wrong.push(`${name}: evaluates with every part but not by loading them one at a time: ${found.error.slice(0, 160)}`); continue }
        compared++
        for (const p of found.read) counts[p]++
        for (const p of needs) named[p]++
        const missed = [...found.read].filter((p) => !needs.has(p))
        if (missed.length) wrong.push(`${name}: the engine read [${missed}], which specNeeds does not name ([${[...needs]}])`)
        if (found.out !== all) wrong.push(`${name}: drawing with just [${[...found.read]}] differs from drawing with every part`)
        // and with exactly what specNeeds names (what the shells load)
        withdrawParts(SPEC_PARTS)
        try {
          await loadParts([...needs])
          const out = evaluate(spec, input)
          if (out !== all) wrong.push(`${name}: drawing with the parts specNeeds names differs from drawing with every part`)
        } catch (e) {
          wrong.push(`${name}: does not evaluate with the parts specNeeds names: ${String(e).slice(0, 160)}`)
        } finally {
          await restoreAll()
        }
      }
      console.log(`[parts-needed] ${mode}: ${compared} specs; read ${JSON.stringify(counts)}; named ${JSON.stringify(named)}`)
      expect(wrong.slice(0, 12).join('\n'), `${wrong.length} wrong`).toBe('')
      expect(compared).toBeGreaterThan(900)
      // not vacuous: the parts a spec's evaluation can read are read by some corpus specs, and most specs read none of them
      expect(counts.legend).toBeGreaterThan(50)
      expect(counts.layout).toBeGreaterThan(5)
      expect(counts.svgpath).toBeGreaterThan(3) // (a legend brings the path reader with it: part-legend.ts)
      expect(counts.selections).toBeGreaterThan(5)
      if ('limits' in input) expect(counts.regex).toBeGreaterThan(0)
      else expect(counts.regex).toBe(0)
      // how much more than needed is loaded (the detector reads structure, so it may over-name; it must not over-name wildly)
      for (const p of ['legend', 'layout', 'selections'] as const) expect(named[p], `${p}: named ${named[p]}, read ${counts[p]}`).toBeLessThanOrEqual(counts[p] * 1.1 + 2)
      // (the screen: only a call that may hand it a regular expression; not every `join(a, ', ')` of a Vega-Lite spec)
      expect(named.regex, `regex: named ${named.regex}, read ${counts.regex}`).toBeLessThanOrEqual('limits' in input ? 20 : 0)
    }, 900_000)
  }
})
