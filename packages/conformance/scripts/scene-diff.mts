/**
 * Scene gate: compare resolved scenes (scales, groups, items) against the
 * real Vega scenegraph for every corpus spec.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `specs` counts the corpus specs whose scenes were compared, `items` the
 * scene items compared, `scales` the scales; each has a floor on a full run (today's numbers, they only ratchet up), and a
 * `--filter` that matches nothing fails. `--plant-difference` moves one item of Aster's scene by 7 px.
 *
 * Run after `pnpm build`: npx tsx scripts/scene-diff.mts [--filter substr] [--scales-only]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import type { SceneNode, SceneRoot } from '@aster-charts/core'
import { sceneDiff } from '../src/scene-diff.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: { filter: 'value', 'scales-only': 'bool', ...GATE_FLAGS } })

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(HERE, '..', 'corpus')
const argv = process.argv.slice(2)
const filterIdx = argv.indexOf('--filter')
const filter = filterIdx >= 0 ? argv[filterIdx + 1]! : ''
const scalesOnly = argv.includes('--scales-only')

/** The planted defect: the first item with a numeric x, anywhere in the scene, drawn 7 px to the right. */
function plant(scene: SceneRoot): void {
  const walk = (nodes: readonly SceneNode[] | undefined): boolean => {
    for (const n of nodes ?? []) {
      const kids = (n as { items?: SceneNode[] }).items
      if (kids && walk(kids)) return true
      if (!kids && typeof n.x === 'number') {
        n.x += 7
        return true
      }
    }
    return false
  }
  walk(scene.items)
}

async function main(gate: Gate): Promise<void> {
  if (!existsSync(CORPUS)) throw new Error(`corpus directory not found: ${CORPUS}`)
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
  let pass = 0
  let total = 0
  for (const f of files) {
    if (filter && !f.includes(filter)) continue
    total++
    try {
      const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Record<string, unknown>
      const spec = f.endsWith('.vl.json')
        ? (vl.compile(raw as never).spec as unknown as Record<string, unknown>)
        : raw
      const result = await sceneDiff(spec, gate.plant ? plant : undefined)
      gate.count('items', result.items)
      gate.count('scales', result.scales)
      const diffs = scalesOnly ? result.diffs.filter((d) => d.includes(' scale ')) : result.diffs
      if (diffs.length === 0) {
        pass++
        gate.agree(f)
      } else {
        gate.differ(f, diffs[0]!)
        console.log(`FAIL  ${f}`)
        for (const d of diffs.slice(0, 10)) console.log(`      ${d}`)
      }
    } catch (e) {
      gate.error(f, e instanceof Error ? e.message : String(e))
    }
  }
  console.log(`\n[scene] ${pass}/${total} scenes match`)
}

await runGate({
  name: 'scene-diff',
  counters: {
    specs: { floor: 1063, what: "corpus specs whose resolved scene was compared with vega's scenegraph" },
    items: { floor: 5524, what: 'scene items compared' },
    scales: { floor: 2164, what: 'scales compared' },
  },
  partial: Boolean(filter) || scalesOnly,
  run: main,
})
