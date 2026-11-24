// @vitest-environment jsdom
/**
 * No consumer parses path text Aster generated: the canvas renderer, the hit index (query, queryMark, pick), bounds, the label
 * painter and `intersect()` read mark geometry as computed numbers. The only strings any of them parses are those a scene
 * carries (a path mark's or a shape's `path`, a legend leaf's path, a group's clip path): `parsePathData` is wrapped to record
 * every string it is given, and each must be a `path` or `clipPathD` of the scene drawn.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const parsed: string[] = []
vi.mock('./path-data.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./path-data.js')>()
  return { ...real, parsePathData: (d: string) => { parsed.push(d); return real.parsePathData(d) } }
})

// (the parts of the engine the public entries carry, imported after the mock: see scripts/vitest-core-parts.setup.mjs)
await import('./parts-all.js')
await import('./part-canvas.js')
// (the add-ons too: the projected shapes, labels and forced layouts of the corpus are consumers' input as well)
await import('./addon-transforms.js')
await import('./addon-geo.js')
const { CORPUS_UNLOADABLE, isDataNotLoaded, vegaCorpusFiles } = await import('./corpus.testlib.js')
const { compileChart } = await import('./compiler.js')
const { evaluateChart } = await import('./evaluate.js')
const { renderSceneToCanvas } = await import('./canvas.js')
const { buildHitIndex } = await import('./hit.js')
const { Bounds, boundLeaf, boundTypedMark } = await import('./bounds.js')
const { drawMark } = await import('./label-draw.js')
const { sceneIntersect } = await import('./scene-intersect.js')
const { loggingContext, marksOf, probePoints } = await import('./geometry-differential.testlib.js')
const { mulberry32 } = await import('./scene-fuzz.testlib.js')
type SceneRoot = import('./types.js').SceneRoot

/** Every path string the scene carries. */
function carried(scene: SceneRoot): Set<string> {
  const out = new Set<string>()
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const r = n as Record<string, unknown>
    if (typeof r.path === 'string') out.add(r.path)
    if (typeof r.clipPathD === 'string') out.add(r.clipPathD)
    if (Array.isArray(r.items)) for (const c of r.items) walk(c)
  }
  for (const g of scene.items ?? []) walk(g)
  return out
}

function consumeAll(scene: SceneRoot): void {
  renderSceneToCanvas(scene, loggingContext().ctx)
  renderSceneToCanvas(scene, loggingContext().ctx, { batchSymbols: false })
  const ix = buildHitIndex(scene)
  for (const [x, y] of probePoints(scene, mulberry32(3))) { ix.query(x, y); ix.queryMark(x, y); ix.pick(x, y) }
  for (const { mark } of marksOf(scene)) {
    boundTypedMark(new Bounds(), mark)
    for (const it of mark.items ?? []) boundLeaf(new Bounds(), it, true)
    drawMark(mark, loggingContext().ctx as never)
  }
  sceneIntersect(scene, [[0, 0], [scene.width, scene.height]], null, null)
}

describe('no consumer parses generated path text', () => {
  it('across the vega corpus', () => {
    const names = vegaCorpusFiles()
    const offenders: string[] = []
    const failed: string[] = []
    let checked = 0
    let parsedAny = 0
    for (const file of names) {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      let scene: SceneRoot
      try { scene = evaluateChart(compileChart(doc.spec ?? doc), {}) } catch (e) {
        if (!isDataNotLoaded(e)) throw e
        continue
      }
      parsed.length = 0
      // (a consumer that throws on a scene of the corpus is a failure, not a scene to leave out)
      try { consumeAll(scene) } catch (e) { failed.push(`${file.split('/').pop()}: ${(e as Error).message}`); continue }
      checked++
      const allowed = carried(scene)
      if (allowed.size > 0 && parsed.length > 0) parsedAny++
      for (const d of parsed) if (!allowed.has(d) && offenders.length < 10) offenders.push(`${file.split('/').pop()}: ${d.slice(0, 80)}`)
    }
    expect(failed).toEqual([])
    // every spec but the ones without data is consumed (a count, not a floor on a file count)
    expect(checked).toBe(names.length - CORPUS_UNLOADABLE.length)
    // the scenes that carry path text do reach the wrapped parser (the guard watches something)
    expect(parsedAny).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  }, 300_000)
})
