/**
 * Run vega on a spec (JSON on stdin) with the `canvas` stand-in registered, and print as JSON what its `label` transforms
 * wrote on the items of every text mark that has one: { marks: [{ name, items: [{ text, x, y, opacity, align, baseline }] }], data },
 * `data` being the rows of the datasets named on the command line.
 * (Started by label-vs-vega.test.ts as `node --import ./register.mjs run-vega.mjs`.)
 */
import { readFileSync } from 'node:fs'

const vega = await import('vega')
const spec = JSON.parse(readFileSync(0, 'utf8'))
const view = new vega.View(vega.parse(spec), { renderer: 'none' })
await view.runAsync()

const out = []
const visit = (node) => {
  if (node.marktype === 'text') out.push({ name: node.name ?? null, items: node.items.map((i) => ({ text: i.text, x: i.x, y: i.y, opacity: i.opacity, align: i.align, baseline: i.baseline })) })
  for (const c of node.items ?? []) if (c && (c.marktype || c.items)) visit(c)
}
visit(view.scenegraph().root)
const data = {}
for (const name of process.argv.slice(2)) data[name] = view.data(name).map((r) => ({ text: r.text, x: r.x, y: r.y, opacity: r.opacity, align: r.align, baseline: r.baseline }))
process.stdout.write(JSON.stringify({ marks: out, data }))
