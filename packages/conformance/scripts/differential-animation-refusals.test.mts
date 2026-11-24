/**
 * The two groups of animation refusals of packages/vl/test/animation.test.ts, against the pinned upstream. A refusal belongs to the
 * first group (what vega-lite compiles to a chart vega cannot run, or throws on) or to the second (vega-lite compiles it and vega
 * runs it: Aster's own refusal); the titles of those groups say so, so each spec is compiled by vega-lite 6.4.3 and its output run
 * in vega 6.3.1, here, to hold the claim. The tables are read from that test's own text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'

type Refusal = [string, Record<string, unknown>, RegExp]

const src = readFileSync(fileURLToPath(new URL('../../vl/test/animation.test.ts', import.meta.url)), 'utf8')
// the test's own fixtures and the two refusal tables, read from its text (type annotations dropped)
const strip = (t: string): string => t.replace(/: Record<string, unknown> = \{\}/g, ' = {}').replace(/: Record<string, unknown>/g, '').replace(/ as never/g, '')
const fixtures = strip(src.slice(src.indexOf('const ROWS'), src.indexOf("describe('animation: a time channel")))
const groups = [...src.matchAll(/describe\('animation: refusals of ([^']*)', \(\) => \{\n  const cases: Refusal\[\] = (\[[\s\S]*?\n  \])\n/g)]
const tables = groups.map((g) => new Function(fixtures + 'return ' + strip(g[2]!))() as Refusal[])

const logger = { level() { return logger }, warn() { return logger }, info() { return logger }, debug() { return logger }, error() { return logger } }

/** 'broken' when vega-lite throws or its output does not run in vega (a dataset it never defines, an unknown or duplicate signal); else 'runs'. */
async function outcome(spec: Record<string, unknown>): Promise<'broken' | 'runs'> {
  let out: Record<string, unknown>
  try { out = vl.compile(JSON.parse(JSON.stringify(spec)), { logger: logger as never }).spec as unknown as Record<string, unknown> } catch { return 'broken' }
  const names = new Set<string>()
  const refs = new Set<string>()
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      const r = o as Record<string, any>
      if (Array.isArray(r.data)) for (const d of r.data) if (d?.name) names.add(d.name)
      if (r.from?.facet?.name) names.add(r.from.facet.name)
      if (typeof r.from?.data === 'string') refs.add(r.from.data)
      for (const [k, x] of Object.entries(r)) if (k !== 'values') walk(x)
    }
  }
  walk(out)
  if ([...refs].some((r) => !names.has(r))) return 'broken'
  try { const view = new vega.View(vega.parse(out as never), { renderer: 'none' }); await view.runAsync(); view.finalize() } catch { return 'broken' }
  return 'runs'
}

describe('the animation refusals are in the group their title says', () => {
  it('reads the group of refusals out of the test', () => {
    expect(tables).toHaveLength(1)
    expect(tables.map((t) => t.length)).toEqual([11])
  })
  it.each(tables[0] ?? [])('vega-lite breaks on: %s', async (_name, spec) => {
    expect(await outcome(spec)).toBe('broken')
  })
})
