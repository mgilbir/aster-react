/**
 * LIVE differential: every place the pinned Vega JSON schema lets a spec hold an expression (schema-expression-sites.mts, 800 and
 * more sites generated from vega/build/vega-schema.json, not listed by hand), given broken, unknown and good expressions. Aster's
 * compile-time walk must read each site as `vega.parse` reads it (C126, C284):
 *
 *  - where vega refuses, Aster refuses with vega's message (the guide properties whose expression vega writes into a longer text,
 *    `WRAPPED` in guide-model.ts, refuse with the same kind of message: their syntax errors quote the author's text alone);
 *  - where vega accepts, Aster accepts;
 *  - where vega's parser itself crashes on a site (a TypeError of its own, `reading 'signalRef'`: ARCHITECTURE.md, "Oracle
 *    crashes: not reproduced"), Aster does not crash;
 *  - and every site vega reads records a regular expression it holds (`regexSites`), so `limits.regex: 'refuse'` refuses a spec
 *    for an expression anywhere in it, a branch that never runs included.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '@aster-charts/core'
import { WRAPPED } from '../../core/src/guide-model.ts'
import { asterOutcome, vegaOutcome } from './expression-sites.mts'
import { schemaBase, schemaSites, type SchemaSite } from './schema-expression-sites.mts'

const POOL = ['1 +', '(1', 'foo(1)', 'nosuch', 'nosuch + foo()', 's + nosuch', '1', 'datum.a', 's']
const REGEX = "test(/a/, 'a') ? 1 : 1"
const crashes = (message: string): boolean => /^Cannot read properties|is not a function$|is not iterable$|^Unexpected token/.test(message)
/**
 * The spec of a site made with an expression. The schema fills a mark's `type` with a placeholder string: vega builds a View of such a
 * spec and refuses the type only when the view runs, Aster refuses it when it compiles (C238), so the sites are read on the mark
 * type their factory means.
 */
function made(site: SchemaSite, expr: string): Record<string, unknown> {
  const spec = site.make(expr) as { marks?: Array<{ type?: unknown }> }
  const first = spec.marks?.[0]
  if (first !== undefined && first.type === 'a') first.type = site.name.startsWith('markGroup') ? 'group' : 'rect'
  return spec as Record<string, unknown>
}

/**
 * vega's outcome for a spec: its parser's, and when the parser accepts it, whether a View can be built of it (the code of the
 * expressions is generated then: a crash there, `Unexpected token`, is the oracle failing on what its parser let through).
 */
function oracleOutcome(spec: Record<string, unknown>): string {
  const parsed = vegaOutcome(spec)
  if (parsed !== 'ok') return parsed
  try {
    new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' }).finalize()
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
/**
 * Where vega's parser reads an expression that the schema does not declare (C126): a facet's keys (`fieldRef`, `keyRef`) and its
 * aggregate (an aggregate transform's parameters), and the triggers of a mark.
 */
const facetMark = (facet: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  schemaBase({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'd', ...facet } }, ...extra }] })
const PARSER_SITES: SchemaSite[] = [
  { name: 'facet.groupby (signal)', make: (e) => facetMark({ groupby: { signal: e } }) },
  { name: 'facet.groupby.0 (signal)', make: (e) => facetMark({ groupby: ['a', { signal: e }] }) },
  { name: 'facet.groupby (expr)', make: (e) => facetMark({ groupby: { expr: e } }) },
  { name: 'facet.field (signal)', make: (e) => facetMark({ field: { signal: e } }) },
  { name: 'facet.field (expr)', make: (e) => facetMark({ field: { expr: e } }) },
  { name: 'facet.aggregate.fields (signal)', make: (e) => facetMark({ groupby: 'a', aggregate: { fields: { signal: e }, ops: ['sum'] } }) },
  { name: 'facet.aggregate.fields.0 (signal)', make: (e) => facetMark({ groupby: 'a', aggregate: { fields: [{ signal: e }], ops: ['sum'] } }) },
  { name: 'facet.aggregate.ops (signal)', make: (e) => facetMark({ groupby: 'a', aggregate: { fields: ['a'], ops: { signal: e } } }) },
  { name: 'facet.aggregate.as (signal)', make: (e) => facetMark({ groupby: 'a', aggregate: { fields: ['a'], ops: ['sum'], as: { signal: e } } }) },
  { name: 'facet.aggregate.cross (signal)', make: (e) => facetMark({ groupby: 'a', aggregate: { cross: { signal: e } } }) },
  { name: 'markTrigger.modify (exprString)', make: (e) => schemaBase({ marks: [{ type: 'rect', name: 'm', from: { data: 'd' }, on: [{ trigger: 's', modify: e }] }] }) },
  ...(['insert', 'remove', 'toggle'] as const).map((k) => ({ name: `markTrigger.${k} (exprString)`, make: (e: string) => schemaBase({ marks: [{ type: 'rect', name: 'm', from: { data: 'd' }, on: [{ trigger: 's', [k]: e }] }] }) })),
]
const sites = [...schemaSites(), ...PARSER_SITES]

describe('every expression site of the Vega schema is read as vega reads it', { timeout: 300_000 }, () => {
  it('the schema yields a site for each kind of definition', () => {
    const kinds = new Set(sites.map((s) => s.name.split(/[.: ]/)[0]))
    for (const k of ['transform', 'data', 'scale', 'projection', 'axis', 'legend', 'title', 'mark', 'markGroup', 'root']) expect(kinds, k).toContain(k)
    expect(sites.length).toBeGreaterThan(700)
  })

  const groups = new Map<string, typeof sites>()
  for (const s of sites) {
    const g = s.name.split(/[.\s]/)[0]!
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(s)
  }
  for (const [group, list] of groups) {
    it(`${group} (${list.length} sites)`, () => {
      const bad: string[] = []
      for (const site of list) {
        const property = site.name.split(/[.\s]/)[1] ?? ''
        for (const e of POOL) {
          const spec = made(site, e)
          const want = oracleOutcome(spec)
          const got = asterOutcome(spec)
          if (got === want) continue
          if (crashes(want) && !crashes(got)) continue
          if (WRAPPED.test(property) && want.startsWith('Expression parse error') && got.startsWith('Expression parse error')) continue
          bad.push(`${site.name} ${JSON.stringify(e)}\n   vega:  ${want}\n   aster: ${got}`)
        }
        // a site vega reads (it refuses a syntax error there) records the regular expression it holds
        const regexSpec = made(site, REGEX)
        const reads = vegaOutcome(made(site, '1 +')).startsWith('Expression parse error')
        if (reads && oracleOutcome(regexSpec) === 'ok' && !(compileChart(structuredClone(regexSpec) as never).regexSites?.length)) bad.push(`${site.name}: a regex there is not recorded`)
      }
      expect(bad).toEqual([])
    })
  }
})
