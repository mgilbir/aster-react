/**
 * The corpus is a set of DISTINCT checks (docs/TESTING.md, "The corpus is distinct"). Two entries whose oracle renders are the same
 * give the SVG gate the same comparison twice: the second adds nothing to what it can catch.
 *
 * `groupIdentical` groups entries by the hash of what the gate compares (the canonical form of the real-Vega SVG); `checkIdentical`
 * holds the groups against `corpus-identical.json`, the table of groups that are known to be identical and still to be made
 * distinct. The check is strict both ways:
 *   - a group of identical entries that is not in the table is refused (a new duplicate), and
 *   - a table entry whose members are no longer identical (fixed, renamed, deleted) is refused too, so the table only ever shrinks.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { CanonicalResult } from './normalize.js'

/** What the SVG gate compares of one oracle render, as one hash: the root, the accessibility structure and every record in order. */
export function canonicalHash(c: CanonicalResult): string {
  return createHash('sha256').update(JSON.stringify([c.root, c.structure, c.records])).digest('hex')
}

/** The groups of two or more entry names with the same hash, each sorted, the groups sorted by their first name. */
export function groupIdentical(hashes: ReadonlyMap<string, string>): string[][] {
  const byHash = new Map<string, string[]>()
  for (const [name, h] of hashes) {
    const g = byHash.get(h)
    if (g) g.push(name)
    else byHash.set(h, [name])
  }
  return [...byHash.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
}

/** The table `corpus-identical.json`: groups of entry names expected to render identically (and to be fixed). */
export interface IdenticalTable {
  groups: Array<{ specs: string[]; why: string }>
}

export function readIdenticalTable(path: string): IdenticalTable {
  const t = JSON.parse(readFileSync(path, 'utf8')) as IdenticalTable
  if (!t || !Array.isArray(t.groups)) throw new Error(`${path}: expected { "groups": [...] }`)
  return t
}

const key = (g: readonly string[]): string => [...g].sort().join('\n')

/** The problems (empty when the corpus is as the table says). `names` is every entry that was rendered. */
export function checkIdentical(found: readonly string[][], table: IdenticalTable, names: ReadonlySet<string>): string[] {
  const problems: string[] = []
  const listed = new Map(table.groups.map((g) => [key(g.specs), g]))
  const foundKeys = new Set(found.map(key))
  for (const g of found) {
    if (!listed.has(key(g))) problems.push(`render-identical entries (one comparison twice; make them exercise distinct behaviour): ${g.join(' == ')}`)
  }
  for (const [k, g] of listed) {
    if (foundKeys.has(k)) continue
    const missing = g.specs.filter((s) => !names.has(s))
    problems.push(
      missing.length
        ? `corpus-identical.json lists ${g.specs.join(' == ')}, but ${missing.join(', ')} no longer exist${missing.length === 1 ? 's' : ''}: remove the entry`
        : `corpus-identical.json lists ${g.specs.join(' == ')}, which no longer render identically: remove the entry`,
    )
  }
  for (const g of table.groups) {
    if (g.specs.length < 2) problems.push(`corpus-identical.json: a group needs two or more specs (${g.specs.join(', ')})`)
  }
  return problems
}

/** The table `corpus-no-items.json`: entries that draw no item of their own marks, by design (the guides are what they compare). */
export interface NoItemsTable {
  specs: Array<{ name: string; why: string }>
}

export function readNoItemsTable(path: string): NoItemsTable {
  const t = JSON.parse(readFileSync(path, 'utf8')) as NoItemsTable
  if (!t || !Array.isArray(t.specs)) throw new Error(`${path}: expected { "specs": [...] }`)
  return t
}

/**
 * An entry whose own marks drew nothing compares its axes and legends and nothing of the data: that is allowed only where the table
 * says it is the point, and the table is exact (an entry that now draws something is refused too, so the table only ever shrinks).
 */
export function checkNoItems(empty: readonly string[], table: NoItemsTable, names: ReadonlySet<string>): string[] {
  const problems: string[] = []
  const listed = new Set(table.specs.map((s) => s.name))
  for (const n of empty) {
    if (!listed.has(n)) problems.push(`${n} draws no item of its own marks (it compares only its guides): give it data that draws, or list it in corpus-no-items.json with the reason`)
  }
  const emptySet = new Set(empty)
  for (const s of table.specs) {
    if (!names.has(s.name)) problems.push(`corpus-no-items.json lists ${s.name}, which is not in the corpus: remove the entry`)
    else if (!emptySet.has(s.name)) problems.push(`corpus-no-items.json lists ${s.name}, which now draws items: remove the entry`)
    if (!s.why || s.why.trim().length < 10) problems.push(`corpus-no-items.json: ${s.name} needs a reason`)
  }
  return problems
}
