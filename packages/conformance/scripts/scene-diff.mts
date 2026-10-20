/**
 * R8.1–R8.3 gate: compare resolved scenes (scales, groups, items) against the
 * real Vega scenegraph for every corpus spec.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { sceneDiff } from '../src/scene-diff.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(HERE, '..', 'corpus')

async function main(): Promise<boolean> {
  if (!existsSync(CORPUS)) return false
  const argv = process.argv.slice(2)
  const filterIdx = argv.indexOf('--filter')
  const filter = filterIdx >= 0 ? argv[filterIdx + 1]! : ''
  const scalesOnly = argv.includes('--scales-only')
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
  let pass = 0
  const failures: Array<{ name: string; diffs: string[] }> = []
  for (const f of files) {
    if (filter && !f.includes(filter)) continue
    const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Record<string, unknown>
    const spec = f.endsWith('.vl.json')
      ? (vl.compile(raw as never).spec as unknown as Record<string, unknown>)
      : raw
    const result = await sceneDiff(spec)
    const diffs = scalesOnly ? result.diffs.filter((d) => d.includes(' scale ')) : result.diffs
    if (diffs.length === 0) pass++
    else {
      failures.push({ name: f, diffs })
      console.log(`FAIL  ${f}`)
      for (const d of diffs.slice(0, 10)) console.log(`      ${d}`)
    }
  }
  const total = files.filter((f) => !filter || f.includes(filter)).length
  console.log(`\n[scene] ${pass}/${total} scenes match (${failures.length} failing)`)
  if (failures.length) console.log(`[scene] failing: ${failures.slice(0, 30).map((f) => f.name).join(', ')}${failures.length > 30 ? ', …' : ''}`)
  return failures.length === 0
}

const ok = await main()
process.exit(ok ? 0 : 1)
