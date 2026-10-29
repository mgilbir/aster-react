/**
 * The `heatmap` transform against vega-geo's. vega draws the bitmap with a canvas, which Node does not have; the transform is run
 * in a child process (`heatmap-canvas/`) in which `canvas` is a stand-in that keeps the pixels `putImageData` is given. The real
 * vega-geo code computes them, so this compares everything the transform decides -- the grid's cells, the colour and opacity (a
 * constant, an expression of the pixel or of the tuple, the default gradient), `resolve`, `as`, the tuples it is run on (dataset
 * rows and a mark's items) -- pixel for pixel. How a browser encodes the bitmap into the image's `href` is the gallery gate's
 * (`vega/density-heatmaps`, `vega/contour-plot` in Chromium).
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import '@aster/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart, renderSpec } from '@aster/core'
import { addonsNeeded } from '@aster/core/addons'

type Spec = Record<string, unknown>
interface Bitmap { width: number; height: number; pixels: number[] }
interface Result { data: Record<string, Array<Bitmap | null>>; marks: Record<string, Array<Bitmap | null>> }

const HERE = dirname(fileURLToPath(import.meta.url))

function runVega(spec: Spec, data: string[], marks: string[], as = 'image'): Result {
  const out = execFileSync(process.execPath, ['--import', join(HERE, 'heatmap-canvas', 'register.mjs'), join(HERE, 'heatmap-canvas', 'run-vega.mjs'), `--data=${data}`, `--marks=${marks}`, `--as=${as}`], {
    input: JSON.stringify(spec), maxBuffer: 1 << 28,
  }).toString()
  return JSON.parse(out) as Result
}

const asBitmap = (img: unknown): Bitmap | null => {
  const i = img as { width: number; height: number; pixels: Uint8ClampedArray } | null | undefined
  return i ? { width: i.width, height: i.height, pixels: Array.from(i.pixels) } : null
}

function engine(spec: Spec, data: string[], marks: string[], as = 'image'): Result {
  const scene = evaluateChart(compileChart(structuredClone(spec) as never), {})
  const sets = datasetsOfScene(scene)
  const out: Result = { data: {}, marks: {} }
  for (const n of data) out.data[n] = (sets.get(n) as unknown as Array<Record<string, unknown>>).map((r) => asBitmap(r[as]))
  const visit = (node: { marktype?: string; name?: string; items?: unknown[] }): void => {
    if (node.marktype === 'image' && node.name && marks.includes(node.name)) out.marks[node.name] = (node.items as Array<{ image?: unknown }>).map((i) => asBitmap(i.image))
    for (const c of node.items ?? []) if (c && typeof c === 'object' && ((c as { marktype?: string }).marktype || (c as { items?: unknown }).items)) visit(c as never)
  }
  visit(scene as never)
  return out
}

// a few clusters in three groups (deterministic)
const POINTS = Array.from({ length: 90 }, (_, i) => {
  const g = i % 3
  const a = (i * 2.399963) % (2 * Math.PI)
  const r = 4 + ((i * 7) % 11)
  return { g: ['a', 'b', 'c'][g], x: 30 + 25 * g + r * Math.cos(a), y: 25 + 8 * g + r * Math.sin(a) }
})

const kde = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'kde2d', groupby: ['g'], size: [90, 60], x: { expr: 'datum.x' }, y: { expr: 'datum.y' }, bandwidth: [6, 6], cellSize: 2, counts: true, ...extra })

const datasetSpec = (heatmap: Record<string, unknown>, extra: Spec = {}): Spec => ({
  width: 90, height: 60, padding: 0,
  ...extra,
  data: [
    { name: 'pts', values: POINTS },
    { name: 'hm', source: 'pts', transform: [kde(), { type: 'heatmap', field: 'grid', ...heatmap }] },
  ],
  marks: [],
})

const CASES: Array<[string, Spec]> = [
  ['the default: a grey, alpha from the value over the maximum', datasetSpec({})],
  ['a constant colour', datasetSpec({ color: 'steelblue' })],
  ['a constant hex colour and a constant opacity', datasetSpec({ color: '#ff8800', opacity: 0.5 })],
  ['an opacity of 0 is no opacity at all: the default gradient', datasetSpec({ color: 'tomato', opacity: 0 })],
  ['a colour that depends on the value', datasetSpec({ color: { expr: 'rgb(255 * datum.$value / datum.$max, 40, 200)' } })],
  ['a colour that depends on the pixel', datasetSpec({ color: { expr: 'rgb(datum.$x * 4, datum.$y * 6, 90)' }, opacity: 1 })],
  ['a colour read by a bracketed name', datasetSpec({ color: { expr: "rgb(255 * datum['$value'] / datum['$max'], 0, 0)" }, opacity: { expr: "datum['$x'] / 45" } })],
  ['an opacity that depends on the pixel', datasetSpec({ color: 'black', opacity: { expr: 'datum.$x / 45 * datum.$y / 30' } })],
  ['a colour of the tuple (a scale of its group), not the pixel', datasetSpec({ color: { expr: "scale('c', datum.g)" } }, { scales: [{ name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] }] })],
  ['a shared maximum', datasetSpec({ resolve: 'shared', color: { expr: 'rgb(0, 255 * datum.$value / datum.$max, 0)' } })],
  ['an independent maximum', datasetSpec({ resolve: 'independent', color: { expr: 'rgb(0, 255 * datum.$value / datum.$max, 0)' } })],
  ['a colour that does not parse, and a transparent one', datasetSpec({ color: { expr: "datum.g == 'a' ? 'transparent' : 'nonsense'" } })],
  ['a colour with an alpha channel', datasetSpec({ color: 'rgba(10, 200, 30, 0.2)' })],
  ['an output field', datasetSpec({ as: 'bitmap', color: 'purple' })],
]

describe('heatmap, dataset rows, matches vega-geo pixel for pixel', () => {
  it.each(CASES)('%s', (_n, spec) => {
    const as = ((spec.data as Array<{ transform?: Array<{ as?: string }> }>)[1]!.transform![1]!.as) ?? 'image'
    const want = runVega(spec, ['hm'], [], as).data.hm!
    const got = engine(spec, ['hm'], [], as).data.hm!
    expect(want.length).toBe(3)
    expect(want.every((b) => b !== null && b.pixels.length > 0)).toBe(true)
    expect(got.map((b) => b && { width: b.width, height: b.height })).toEqual(want.map((b) => b && { width: b.width, height: b.height }))
    for (let i = 0; i < want.length; i++) {
      expect(got[i]!.pixels).toEqual(want[i]!.pixels)
      // (not a comparison of blanks: the bitmaps hold pixels of more than one value)
      expect(new Set(want[i]!.pixels).size).toBeGreaterThan(1)
    }
  })
})

const markSpec = (heatmap: Record<string, unknown>): Spec => ({
  width: 90, height: 60, padding: 0,
  scales: [{ name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] }],
  data: [
    { name: 'pts', values: POINTS },
    { name: 'density', source: 'pts', transform: [kde()] },
  ],
  marks: [{
    type: 'image', name: 'img', from: { data: 'density' },
    encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 90 }, height: { value: 60 }, aspect: { value: false } } },
    transform: [{ type: 'heatmap', field: 'datum.grid', ...heatmap }],
  }],
})

describe('heatmap, a mark\'s items, matches vega-geo pixel for pixel', () => {
  it.each([
    ['the default, over the items\' datum.grid', markSpec({})],
    ['a colour of the datum behind the item (datum.datum)', markSpec({ color: { expr: "scale('c', datum.datum.g)" } })],
    ['a shared maximum and a colour of the value', markSpec({ resolve: 'shared', color: { expr: 'rgb(255 * datum.$value / datum.$max, 0, 128)' }, opacity: 1 })],
  ] as Array<[string, Spec]>)('%s', (_n, spec) => {
    const want = runVega(spec, [], ['img']).marks.img!
    const got = engine(spec, [], ['img']).marks.img!
    expect(want.length).toBe(3)
    for (let i = 0; i < want.length; i++) {
      expect(got[i]!.width).toBe(want[i]!.width)
      expect(got[i]!.pixels).toEqual(want[i]!.pixels)
      expect(new Set(want[i]!.pixels).size).toBeGreaterThan(1)
    }
  })
})

/** The chunks of a PNG, each with its CRC checked. */
function pngChunks(url: string): Map<string, Buffer> {
  const m = /^data:image\/png;base64,(.*)$/.exec(url)
  expect(m).not.toBeNull()
  const png = Buffer.from(m![1]!, 'base64')
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = new Map<string, Buffer>()
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p)
    const type = png.subarray(p + 4, p + 8).toString('latin1')
    const data = png.subarray(p + 8, p + 8 + len)
    expect(png.readUInt32BE(p + 8 + len)).toBe(crc32(png.subarray(p + 4, p + 8 + len)))
    chunks.set(type, data)
    p += 12 + len
  }
  return chunks
}

describe('an image mark draws the bitmap where the host has no canvas', () => {
  it('the SVG href is a valid PNG of exactly the pixels, and the box is the item\'s', () => {
    const spec = markSpec({ color: { expr: "scale('c', datum.datum.g)" } })
    const svg = renderSpec(structuredClone(spec) as never)
    const imgs = [...svg.matchAll(/<image[^>]*xlink:href="([^"]*)"[^>]*\/>/g)]
    expect(imgs.length).toBe(3)
    const bitmaps = engine(spec, [], ['img']).marks.img!
    imgs.forEach((m, i) => {
      const chunks = pngChunks(m[1]!)
      const ihdr = chunks.get('IHDR')!
      expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([bitmaps[i]!.width, bitmaps[i]!.height, 8, 6])
      const raw = inflateSync(chunks.get('IDAT')!)
      const w = bitmaps[i]!.width
      const px: number[] = []
      for (let y = 0; y < bitmaps[i]!.height; y++) {
        expect(raw[y * (1 + 4 * w)]).toBe(0)
        px.push(...raw.subarray(y * (1 + 4 * w) + 1, (y + 1) * (1 + 4 * w)))
      }
      expect(px).toEqual(bitmaps[i]!.pixels)
    })
    expect(svg).toMatch(/<image[^>]* width="90" height="60"/)
  })
})

describe('the add-on detector knows heatmap', () => {
  it('a heatmap, as a dataset transform or a mark transform, needs the transforms add-on (kde2d alone is the same add-on; isocontour also the geo one)', () => {
    expect(addonsNeeded(markSpec({}) as never)).toEqual(['transforms'])
    expect(addonsNeeded(datasetSpec({}) as never)).toEqual(['transforms'])
    const bare = { data: [{ name: 'g', values: [{ grid: { width: 1, height: 1, values: [1] } }], transform: [{ type: 'heatmap', field: 'grid' }] }] }
    expect(addonsNeeded(bare as never)).toEqual(['transforms'])
  })
})
