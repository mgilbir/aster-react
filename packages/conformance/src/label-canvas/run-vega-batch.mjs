/**
 * Run vega on many specs (JSON on stdin: [{ id, spec, mark, dataset }]) with the `canvas` stand-in registered, and print as JSON
 * what the `label` transform wrote: { [id]: { items } | { error } }, the items of the text mark `mark` or the rows of `dataset`.
 * (Started by label-generated-vs-vega.test.ts as `node --import ./register.mjs run-vega-batch.mjs`.)
 */
import { readFileSync } from 'node:fs'

const vega = await import('vega')
const out = {}
const pick = (i) => ({ text: i.text, x: i.x, y: i.y, opacity: i.opacity, align: i.align, baseline: i.baseline })
for (const c of JSON.parse(readFileSync(0, 'utf8'))) {
  try {
    const view = new vega.View(vega.parse(c.spec), { renderer: 'none' })
    await view.runAsync()
    if (c.dataset) out[c.id] = { items: view.data(c.dataset).map(pick) }
    else {
      let found
      const visit = (node) => {
        if (node.marktype === 'text' && node.name === c.mark) found = node.items.map(pick)
        for (const k of node.items ?? []) if (k && (k.marktype || k.items)) visit(k)
      }
      visit(view.scenegraph().root)
      out[c.id] = { items: found ?? [] }
    }
  } catch (e) {
    out[c.id] = { error: String(e instanceof Error ? e.message : e) }
  }
}
process.stdout.write(JSON.stringify(out))
