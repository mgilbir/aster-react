/**
 * `intersect()` over arc and path outlines on regions of any size. A spec reaches it with numbers of its choosing: the
 * `intersect(box, opt, group)` expression function is open to every signal handler (signals.ts) and its box is any
 * expression value, and an arc's radii or a path are any encode value. Testing every lattice point of the box/bounds region, as
 * vega does, never ends past 2^52 or for an infinite region and takes hours for a few million pixels squared. The region's
 * rows are now tested crossing by crossing (the same answer: the winding test only changes at crossings); a region past 2^52,
 * or work past the built-in `latticeTests` ceiling, is refused with an AsterLimitError (docs/LIMITS.md).
 */
import { describe, expect, it, vi } from 'vitest'

const calls = { n: 0 }
vi.mock('./path-flatten.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./path-flatten.js')>()
  return { ...real, insidePolys: (...a: Parameters<typeof real.insidePolys>) => { calls.n++; return real.insidePolys(...a) } }
})

// (the parts of the engine the public entries carry, imported after the mock: see scripts/vitest-core-parts.setup.mjs)
await import('./parts-all.js')
const { sceneIntersect } = await import('./scene-intersect.js')
const { sceneIntersect: legacyIntersect } = await import('./legacy-scene-intersect.testlib.js')
const { compileChart } = await import('./compiler.js')
const { evaluateChart } = await import('./evaluate.js')
const { mulberry32 } = await import('./scene-fuzz.testlib.js')
const { AsterLimitError } = await import('./limits.js')
const { readFileSync } = await import('node:fs')
const { dirname, join } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
type SceneRoot = import('./types.js').SceneRoot
type Node = { marktype?: string; items?: unknown[]; [key: string]: unknown }

const loadStallScene = (): { box: number[][]; scene: SceneRoot & { items: Node[] } } =>
  JSON.parse(readFileSync(join(here, '../testdata/intersect-stall-scene.json'), 'utf8'), (_k, v) =>
    (v === '#Infinity' ? Infinity : v === '#-Infinity' ? -Infinity : v === '#NaN' ? NaN : v === '#-0' ? -0 : v))

const sceneOf = (marks: unknown[]): SceneRoot => evaluateChart(compileChart({ width: 400, height: 300, padding: 0, autosize: 'none', marks } as never), {})
const arc = (encode: Record<string, unknown>): unknown => ({ type: 'arc', encode: { enter: { x: { value: 0 }, y: { value: 0 }, fill: { value: 'red' }, ...encode } } })

describe('intersect() terminates on any region, and agrees with the lattice test where that ends', () => {
  it('an arc whose bounds reach Number.MAX_VALUE ends: its region is refused, not walked', () => {
    // (an arc item at x Infinity with a negative inner radius and a 5px stroke has bounds that run from MAX_VALUE to Infinity in
    // x, and `x++` never moves past MAX_VALUE: the old walk -- and vega's -- never ended on a box that meets them without
    // enclosing them. The item is one of a hand-built scene once drawn by the random generator, frozen in testdata with its
    // non-finite numbers as "#Infinity"; it is tested ALONE here, and under every box: a finite one has a finite region.)
    const { box, scene } = loadStallScene()
    const arcs = scene.items.filter((m) => m.marktype === 'arc')
    const infinite = (arcs[0]!.items as Array<{ datum?: { i?: number } }>).find((it) => it.datum?.i === 22)!
    const alone = { ...scene, items: [{ ...arcs[0]!, items: [infinite] }] } as unknown as SceneRoot
    expect(sceneIntersect(alone, box, null, null)).toHaveLength(0)
    expect(sceneIntersect(alone, [[1e300, 30], [1e308, 40]], null, null)).toHaveLength(0)
    for (const region of [[[1e308, 30], [Infinity, 40]], [[0, 30], [Infinity, 40]], [[-Infinity, 30], [Infinity, 40]]]) {
      expect(() => sceneIntersect(alone, region, null, null), JSON.stringify(region)).toThrow(AsterLimitError)
      expect(() => sceneIntersect(alone, region, null, null)).toThrow('intersect() lattice tests (a region beyond 2^52)')
    }
    // (a box that encloses the bounds needs no lattice at all)
    expect(sceneIntersect(alone, [[-Infinity, -Infinity], [Infinity, Infinity]], null, null)).toHaveLength(1)
    // an infinite box and infinite radii end too
    const inf = sceneOf([arc({ outerRadius: { signal: '1e309' }, startAngle: { value: 0 }, endAngle: { value: 1 } })])
    expect(sceneIntersect(inf, [[-Infinity, -Infinity], [Infinity, Infinity]], null, null)).toEqual(legacyIntersect(inf, [[-Infinity, -Infinity], [Infinity, Infinity]], null, null))
  })

  it('a group at x Infinity that the box cannot meet changes nothing: the arcs drawn after it are tested against the box as it was', () => {
    // (the scene's first mark is a group at x Infinity, then arcs and a shape. The old walk moved the box into the group without
    // asking whether the box met it -- `translate(-Infinity)` and back leave NaN -- and the NaN box met an infinite arc and was
    // refused. vega visits a group mark only if its bounds meet the box: the answer is the answer without the group.)
    const { box, scene } = loadStallScene()
    const without = { ...scene, items: scene.items.filter((m) => m.marktype !== 'group') } as unknown as SceneRoot
    const got = sceneIntersect(scene, box, null, null)
    expect(got).toHaveLength(2)
    expect(got).toEqual(sceneIntersect(without, box, null, null))
  })

  it('a region of millions of pixels squared is tested by its rows: a thin diagonal strip with no lattice point inside', () => {
    // (y - x is never an integer inside the strip: no lattice point is in it, so the point-by-point test visits all 9e6)
    const scene = sceneOf([{ type: 'path', encode: { enter: { path: { value: 'M0,0.5L3000,3000.5L3000,3000.7L0,0.7Z' }, fill: { value: 'red' } } } }])
    calls.n = 0
    expect(sceneIntersect(scene, [[1, 0], [3000, 3001]], null, null)).toHaveLength(0)
    expect(calls.n).toBeLessThan(100_000)
  })

  it('work past the built-in ceiling is refused, the same with limits as without', () => {
    // (a fine outline of ~2,000 edges over ~40,000 rows: 8e7 edge tests for the rows' crossings alone)
    const scene = sceneOf([arc({ x: { value: 0 }, y: { value: 0 }, outerRadius: { value: 20000 }, innerRadius: { value: 19999.5 }, startAngle: { value: 0 }, endAngle: { value: 6.2 } })])
    expect(() => sceneIntersect(scene, [[-20001, -20001], [-19990, 20001]], null, null)).toThrow(/intersect\(\) lattice tests [0-9]+ > 50000000/)
  })

  it('agrees with the point-by-point test on random arcs, paths and boxes it can finish', () => {
    const r = mulberry32(7)
    const paths = ['M0,0L60,10L20,70Z', 'M5,5h40v30h-40z', 'M0,0 A 30 30 0 0 1 60 0 L 60 60 Z', 'M0,0C25,-40 75,-40 100,0S175,40 200,0Z', 'M10,10L90,10L10,90L90,90Z']
    let hits = 0
    for (let i = 0; i < 300; i++) {
      const marks = [
        arc({ x: { value: r() * 300 }, y: { value: r() * 200 }, outerRadius: { value: r() * 90 }, innerRadius: { value: r() * 30 },
          startAngle: { value: r() * 6 }, endAngle: { value: r() * 6 }, cornerRadius: { value: r() * 5 }, padAngle: { value: r() * 0.1 } }),
        { type: 'path', encode: { enter: { x: { value: r() * 200 }, y: { value: r() * 150 }, path: { value: paths[i % paths.length] }, fill: { value: 'blue' },
          scaleX: { value: 0.3 + r() * 2 }, scaleY: { value: 0.3 + r() * 2 }, angle: { value: r() * 90 } } } },
      ]
      const scene = sceneOf(marks)
      const x = r() * 380, y = r() * 280
      const box = [[x, y], [x + r() * 60, y + r() * 60]]
      const got = sceneIntersect(scene, box, null, null)
      expect(got).toEqual(legacyIntersect(scene, box, null, null))
      hits += got.length
    }
    expect(hits).toBeGreaterThan(10)
  })
})
