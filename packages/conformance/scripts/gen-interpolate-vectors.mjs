/**
 * Records oracle vectors for the interpolator table `vega-scale`'s `interpolate(type,
 * gamma)` reads (the d3-interpolate namespace), written to
 * `packages/core/testdata/vectors/spec-level/vega-interpolate.json`. Replayed by
 * `packages/core/src/interpolate-vectors.test.ts`.
 *
 *   pnpm --filter @aster/conformance run vectors:interpolate
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ = 'UTC'
const here = dirname(fileURLToPath(import.meta.url))
const vega = await import('vega')

function enc(v) {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { $: 'baddate' } : { $: 'date', ms: v.getTime() }
  if (typeof v === 'function') return { $: 'fn' }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, enc)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = enc(v[k])
    return o
  }
  return v
}
const attempt = (f) => {
  try {
    return enc(f())
  } catch {
    return { $: 'throw' }
  }
}

const T = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, -0.2, 1.3, 0.333333]
const colors = [['#ff0000', '#0000ff'], ['#ffffe0', '#8b0000'], ['steelblue', 'orange'], ['#808080', '#00ff00'], ['white', 'black'], ['rgba(255,0,0,0.5)', 'rgba(0,0,255,1)'], ['#ff0000', 'nonsense'], ['gray', 'gray'], ['hsl(10,50%,50%)', 'hsl(200,80%,30%)']]
const palettes = [['#ffffe0', '#6a9', '#8b0000'], ['red', 'green', 'blue', 'yellow'], ['#fff', '#000'], ['#123', '#456', '#789', '#abc', '#def']]
const nums = [[0, 10], [10, 0], [-5, 5], [3, 3], [1e6, 1e-6]]

const cases = []
const add = (name, gamma, args) => cases.push({ name, gamma, args })
for (const n of ['rgb', 'hsl', 'hsl-long', 'lab', 'hcl', 'hcl-long', 'cubehelix', 'cubehelix-long']) {
  for (const pair of colors) add(n, undefined, pair)
  for (const g of [0.5, 1, 2.2]) for (const pair of colors.slice(0, 4)) add(n, g, pair)
}
for (const n of ['rgb-basis', 'rgb-basis-closed']) for (const p of palettes) add(n, undefined, [p])
for (const n of ['basis', 'basis-closed']) for (const p of [[0, 10, 5, 20], [1, 2], [4, 4, 4], [0, 100, 0, 100, 0]]) add(n, undefined, [p])
for (const p of palettes) add('discrete', undefined, [p])
for (const n of ['hue', 'number', 'round']) for (const p of [...nums, [350, 10], [10, 350], [0, 360], [NaN, 120], [120, NaN]]) add(n, undefined, p)
for (const p of [[[0, 0, 100], [100, 100, 200]], [[10, 10, 50], [10, 10, 400]], [[0, 0, 1], [3, 4, 5]]]) add('zoom', undefined, p)
add('string', undefined, ['a1b22c', 'a5b3c'])
add('string', undefined, ['rgb(0,0,0)', 'rgb(255,100,50)'])
add('date', undefined, [new Date(0), new Date(1e12)])
add('array', undefined, [[0, 10, 20], [10, 0, 5]])
add('number-array', undefined, [[0, 10], [10, 20]])
add('object', undefined, [{ a: 0, b: 'x' }, { a: 10, b: 'y' }])
add('', undefined, [0, 10])
add('', undefined, ['#ff0000', '#0000ff'])
add('', undefined, [[1, 2], [3, 4]])
add('bogus', undefined, [0, 1])

const out = []
for (const c of cases) {
  const want = attempt(() => {
    const f = vega.interpolate(c.name, c.gamma)
    const g = f(...c.args)
    const r = T.map((t) => g(t))
    return c.name === 'zoom' ? { v: r, duration: g.duration } : r
  })
  out.push({ name: c.name, gamma: c.gamma === undefined ? null : c.gamma, args: c.args.map(enc), want })
}
const dest = join(here, '..', '..', 'core', 'testdata', 'vectors', 'spec-level', 'vega-interpolate.json')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, `{"oracle":${JSON.stringify('vega@' + vega.version)},"t":${JSON.stringify(T)},"cases":[\n${out.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`)
console.log(`[vectors] wrote ${out.length} interpolator cases -> ${dest}`)
