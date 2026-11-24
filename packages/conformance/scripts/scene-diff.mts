/**
 * Scene gate: compare resolved scenes (scales, groups, items) against the
 * real Vega scenegraph for every corpus spec.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `specs` counts the corpus specs whose scenes were compared, `items` the
 * scene items compared (at every depth: inside group marks and facets too), `attributes` the item channel values, `marks`,
 * `groups` and `scales` what their names say; each has a floor on a full run (today's numbers, they only ratchet up), and a
 * `--filter` that matches nothing fails. A spec whose oracle drew items of which none was compared fails. `--plant-difference`
 * moves one item of Aster's scene by 7 px.
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
  let zeroItems = 0
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
      gate.count('attributes', result.attributes)
      gate.count('marks', result.marks)
      gate.count('groups', result.groups)
      gate.count('scales', result.scales)
      if (result.items === 0) zeroItems++
      const diffs = scalesOnly ? result.diffs.filter((d) => d.includes(' scale ')) : [...result.diffs]
      // a spec whose oracle drew items of which none was compared has not been compared, whatever else agreed
      if (!scalesOnly && result.oracleItems > 0 && result.items === 0) diffs.unshift(`the oracle drew ${result.oracleItems} item(s), none was compared`)
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
  console.log(`\n[scene] ${pass}/${total} scenes match; ${zeroItems} spec(s) with no item to compare (the oracle drew none either)`)
}

await runGate({
  name: 'scene-diff',
  counters: {
    specs: { floor: 1071, what: "corpus specs whose resolved scene was compared with vega's scenegraph" },
    // (5524 before the comparison followed marks inside group marks, C62: 141 specs compared no item at all)
    items: { floor: 8211, what: 'scene items compared (group items included)' },
    attributes: { floor: 61584, what: 'item channel values compared' },
    marks: { floor: 1978, what: 'marks compared' },
    groups: { floor: 667, what: 'group items (scopes) compared' },
    scales: { floor: 2164, what: 'scales compared' },
  },
  partial: Boolean(filter) || scalesOnly,
  run: main,
})
