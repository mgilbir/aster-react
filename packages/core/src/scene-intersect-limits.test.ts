/**
 * `intersect()` over arc and path outlines on regions of any size. A spec reaches it with numbers of its choosing: the
 * `intersect(box, opt, group)` expression function is open to every signal handler (signals.ts) and its box is any
 * expression value, and an arc's radii or a path are any encode value. Testing every lattice point of the box/bounds region, as
 * vega does, never ends for an infinite region and takes hours for a few million pixels squared. The region's rows are now
 * tested crossing by crossing (the same answer: the winding test only changes at crossings), with a budget past which the
 * item is taken as intersecting (vega's own answer without a canvas).
 */
import { describe, expect, it, vi } from 'vitest'

const calls = { n: 0 }
vi.mock('./path-flatten.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./path-flatten.js')>()
  return { ...real, insidePolys: (...a: Parameters<typeof real.insidePolys>) => { calls.n++; return real.insidePolys(...a) } }
})

const { sceneIntersect } = await import('./scene-intersect.js')
const { sceneIntersect: legacyIntersect } = await import('./legacy-scene-intersect.testlib.js')
const { compileChart } = await import('./compiler.js')
const { evaluateChart } = await import('./evaluate.js')
const { mulberry32 } = await import('./scene-fuzz.testlib.js')
const { randomScene } = await import('./geometry-scenes.testlib.js')
const { probePoints } = await import('./geometry-differential.testlib.js')
type SceneRoot = import('./types.js').SceneRoot

const sceneOf = (marks: unknown[]): SceneRoot => evaluateChart(compileChart({ width: 400, height: 300, padding: 0, autosize: 'none', marks } as never), {})
const arc = (encode: Record<string, unknown>): unknown => ({ type: 'arc', encode: { enter: { x: { value: 0 }, y: { value: 0 }, fill: { value: 'red' }, ...encode } } })

describe('intersect() terminates on any region, and agrees with the lattice test where that ends', () => {
  it('the scene that stalled the old walk ends: a NaN group offset (a NaN box) over an arc whose bounds reach Number.MAX_VALUE', () => {
    // (randomScene(112): a group item at x NaN, and an arc with a negative inner radius and a 5px stroke, whose bounds run from
    // MAX_VALUE to Infinity in x: `x++` never moves past MAX_VALUE, so the old walk -- and vega's -- never ended)
    const r = mulberry32(112)
    const scene = randomScene(r)
    probePoints(scene, r)
    const boxes: number[][][] = []
    for (let i = 0; i < 6; i++) { const x = r() * scene.width, y = r() * scene.height; boxes.push([[x, y], [x + r() * scene.width * 0.6, y + r() * scene.height * 0.6]]) }
    for (const box of boxes) expect(Array.isArray(sceneIntersect(scene, box, null, null))).toBe(true)
    // an infinite box and infinite radii end too
    const inf = sceneOf([arc({ outerRadius: { signal: '1e309' }, startAngle: { value: 0 }, endAngle: { value: 1 } })])
    expect(sceneIntersect(inf, [[-Infinity, -Infinity], [Infinity, Infinity]], null, null)).toEqual(legacyIntersect(inf, [[-Infinity, -Infinity], [Infinity, Infinity]], null, null))
  })

  it('a region of millions of pixels squared is tested by its rows: a thin diagonal strip with no lattice point inside', () => {
    // (y - x is never an integer inside the strip: no lattice point is in it, so the point-by-point test visits all 9e6)
    const scene = sceneOf([{ type: 'path', encode: { enter: { path: { value: 'M0,0.5L3000,3000.5L3000,3000.7L0,0.7Z' }, fill: { value: 'red' } } } }])
    calls.n = 0
    expect(sceneIntersect(scene, [[1, 0], [3000, 3001]], null, null)).toHaveLength(0)
    expect(calls.n).toBeLessThan(100_000)
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
