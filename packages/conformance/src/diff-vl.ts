/**
 * Diff the Vega specs upstream vega-lite.compile and @aster/vl emit for
 * sweep cases. Usage: npx tsx src/diff-vl.ts <family|case-filter> [limit]
 */
import * as vl from 'vega-lite'
import { mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { compile as compileOurs } from '@aster/vl'

const require = createRequire(import.meta.url)

function makeNodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-diff-'))
  mkdirSync(join(dir, 'node_modules'))
  const base = dirname(require.resolve('vega'))
  const stores = [
    join(base, '..', '..'),
    join(dirname(require.resolve('vega-lite')), '..', '..'),
  ]
  const seen = new Set<string>()
  for (const store of stores) {
    let entries: string[] = []
    try { entries = readdirSync(store) } catch { continue }
    for (const name of entries) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try { symlinkSync(join(store, name), join(dir, 'node_modules', name), 'dir') } catch { /* linked */ }
    }
  }
  return join(dir, 'node_modules')
}

const filter = process.argv[2] ?? ''
const limit = Number(process.argv[3] ?? 5)

const { generate } = await import(`./sweeps/${'vega-lite' + '-schema'}.mjs`)
const ctx = { vl, require, nodeModules: makeNodeModules() }
const { cases } = generate(ctx)
const selected = cases.filter((c: any) => !filter || c.name.includes(filter))
console.log(`${selected.length} cases match`)

/** Flatten a spec into path -> leaf-value records for a set diff. */
function flatten(obj: unknown, path = ''): Map<string, string> {
  const m = new Map<string, string>()
  const walk = (o: unknown, p: string) => {
    if (Array.isArray(o)) {
      if (o.length === 0) m.set(p, '[]')
      o.forEach((v, i) => walk(v, `${p}[${i}]`))
    } else if (o && typeof o === 'object') {
      const entries = Object.entries(o as Record<string, unknown>)
      if (entries.length === 0) m.set(p, '{}')
      for (const [k, v] of entries) walk(v, p ? `${p}.${k}` : k)
    } else {
      m.set(p, JSON.stringify(o))
    }
  }
  walk(obj, path)
  return m
}

for (const c of selected.slice(0, limit)) {
  console.log(`\n=== ${c.name} (${c.family}.${c.property})`)
  let oracle: unknown, ours: unknown
  try {
    oracle = (vl as unknown as { compile: (s: unknown) => { spec: unknown } }).compile(c.spec).spec
  } catch (e) {
    console.log(`  upstream refuses: ${(e as Error).message.split('\n')[0]}`)
    continue
  }
  try {
    ours = compileOurs(c.spec as never)
  } catch (e) {
    console.log(`  ours refuses: ${(e as Error).message.split('\n')[0]}`)
    continue
  }
  const o = flatten(oracle)
  const u = flatten(ours)
  const onlyO: [string, string][] = []
  const onlyU: [string, string][] = []
  const changed: [string, string, string][] = []
  for (const [k, v] of o) {
    if (!u.has(k)) onlyO.push([k, v])
    else if (u.get(k) !== v) changed.push([k, v, u.get(k)!])
  }
  for (const [k, v] of u) if (!o.has(k)) onlyU.push([k, v])
  const show = (rows: unknown[][]) => rows.slice(0, 25).forEach((r) => console.log('  ' + r.join('  ')))
  if (onlyO.length) { console.log(`  oracle-only (${onlyO.length}):`); show(onlyO) }
  if (onlyU.length) { console.log(`  ours-only (${onlyU.length}):`); show(onlyU) }
  if (changed.length) { console.log(`  changed (${changed.length}):`); show(changed) }
  if (!onlyO.length && !onlyU.length && !changed.length) console.log('  specs identical')
}

rmSync(ctx.nodeModules, { recursive: true, force: true })
