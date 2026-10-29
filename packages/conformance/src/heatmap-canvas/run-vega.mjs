/**
 * Run vega on a spec (JSON on stdin) with the pixel-keeping `canvas` stand-in registered and print, as JSON, the bitmaps its
 * `heatmap` transforms made: { data: { <dataset>: [{ width, height, pixels }] }, marks: { <mark name>: [{ width, height, pixels }] } },
 * for the datasets and the named marks on the command line (`--data=a,b --marks=m --as=image`; `as` is the transform's output field on the rows). `pixels` is a plain array of the RGBA bytes.
 * (Started by heatmap-vs-vega.test.ts as `node --import ./register.mjs run-vega.mjs`.)
 */
import { readFileSync } from 'node:fs'

const vega = await import('vega')
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? '').slice(n.length + 3).split(',').filter(Boolean)
const spec = JSON.parse(readFileSync(0, 'utf8'))
const view = new vega.View(vega.parse(spec), { renderer: 'none' })
await view.runAsync()

const image = (c) => (c ? { width: c.width, height: c.height, pixels: Array.from(c.pixels) } : null)
const out = { data: {}, marks: {} }
const as = arg('as')[0] ?? 'image'
for (const name of arg('data')) out.data[name] = view.data(name).map((r) => image(r[as]))
const visit = (node) => {
  if (node.marktype === 'image' && node.name && arg('marks').includes(node.name)) out.marks[node.name] = node.items.map((i) => image(i.image))
  for (const c of node.items ?? []) if (c && (c.marktype || c.items)) visit(c)
}
visit(view.scenegraph().root)
process.stdout.write(JSON.stringify(out))
