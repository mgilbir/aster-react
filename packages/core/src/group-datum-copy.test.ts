// @vitest-environment node
/**
 * A group item's `datum` is a copy of the row it is made from, as a leaf item's is (C87): a scene hands out no row of the spec or of
 * the host's data, so a host that writes into a scene it was given (API.md "You may write into a scene you were given") changes
 * that scene alone, never the spec, the data, or what the chart evaluates next. Every way a group mark makes its items: from a
 * dataset (inline values and host rows), pre-faceted rows, a facet's partitions, a keyed join, and nested groups.
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, type SceneGroup, type SceneRoot, type VgSpec } from './index.js'

type Row = Record<string, unknown>

const leaf = { type: 'text', encode: { update: { text: { field: { parent: 'v' } } } } }

const SHAPES: Record<string, (rows: Row[]) => VgSpec> = {
  'from a dataset': (rows) => ({ data: [{ name: 't', values: rows }], marks: [{ type: 'group', from: { data: 't' }, marks: [leaf] }] }) as unknown as VgSpec,
  'from a dataset, keyed': (rows) => ({ data: [{ name: 't', values: rows }], marks: [{ type: 'group', key: 'k', from: { data: 't' }, marks: [leaf] }] }) as unknown as VgSpec,
  'pre-faceted rows': (rows) => ({ data: [{ name: 't', values: rows.map((r) => ({ ...r, kids: [r] })) }], marks: [{ type: 'group', from: { facet: { data: 't', name: 'f', field: 'kids' } }, marks: [leaf] }] }) as unknown as VgSpec,
  'nested in a group': (rows) => ({ data: [{ name: 't', values: rows }], marks: [{ type: 'group', marks: [{ type: 'group', from: { data: 't' }, marks: [leaf] }] }] }) as unknown as VgSpec,
}

/** Every group item of a scene, at any depth. */
function groupItems(node: SceneRoot | SceneGroup, out: SceneGroup[] = []): SceneGroup[] {
  for (const n of (node.items ?? []) as SceneGroup[]) {
    if ((n as { _scope?: boolean })._scope === true) out.push(n)
    if (Array.isArray(n.items)) groupItems(n, out)
  }
  return out
}

const texts = (scene: SceneRoot): unknown[] => {
  const out: unknown[] = []
  const walk = (n: SceneGroup): void => {
    for (const c of (n.items ?? []) as SceneGroup[]) {
      if (c.marktype === 'text') for (const it of c.items ?? []) out.push((it as { text?: unknown }).text)
      if (Array.isArray(c.items)) walk(c)
    }
  }
  walk(scene as unknown as SceneGroup)
  return out
}

describe("a group item's datum is a copy of its row (C87)", () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    it(name, () => {
      const rows: Row[] = [{ k: 'a', v: 1, nested: { q: 1 } }, { k: 'b', v: 2, nested: { q: 2 } }]
      const spec = make(rows)
      const inline = ((spec as unknown as { data: Array<{ values: Row[] }> }).data[0]!.values)
      const chart = compileChart(spec)
      const scene = evaluateChart(chart, {})
      const items = groupItems(scene).filter((g) => (g.datum as Row | undefined)?.v !== undefined)
      expect(items.length).toBeGreaterThan(0)
      for (const g of items) {
        expect(inline, 'no group datum is a row of the spec').not.toContain(g.datum)
        expect(rows).not.toContain(g.datum)
      }
      // (a host writes into the scene it was given: the spec and the next evaluation do not see it)
      for (const g of items) (g.datum as Row).v = 999
      expect(inline.map((r) => r.v)).not.toContain(999)
      expect(texts(evaluateChart(chart, {}))).not.toContain(999)
      expect(texts(evaluateChart(compileChart(make(rows)), {}))).not.toContain(999)
    })
  }

  it('host rows given to a group mark are not handed out either', () => {
    const host: Row[] = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }]
    const chart = compileChart({ data: [{ name: 't' }], marks: [{ type: 'group', from: { data: 't' }, marks: [leaf] }] } as unknown as VgSpec)
    const scene = evaluateChart(chart, { data: { t: host } })
    for (const g of groupItems(scene)) expect(host).not.toContain(g.datum)
  })
})
