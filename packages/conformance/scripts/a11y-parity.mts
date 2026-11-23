/**
 * Guide-caption parity: compare the accessible axis/legend captions emitted by
 * buildA11yTree with the aria-label values vega-scenegraph puts on the same
 * guides, as sorted lists per spec. Mark nodes are not compared (vega labels a mark item only from a host-authored
 * `description`; Aster's mark nodes are its own keyboard model).
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `specs` counts the specs whose captions were compared, `captions` the
 * captions vega emitted that were compared (two empty lists agree, so a spec with no guide adds nothing to it); both have
 * floors on a full run, and a `--filter` that matches nothing fails. `--plant-difference` changes Aster's first caption.
 *
 * Run after `pnpm build`: npx tsx scripts/a11y-parity.mts [--filter substr]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { buildA11yTree, compileChart, evaluateChart, getChartInfo } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { renderWithVega } from '../src/render-vega.js'
import { parseSvg, type XmlEl } from '../src/svg-parse.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: { filter: 'value', ...GATE_FLAGS } })

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(HERE, '..', 'corpus')

function decode(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function realCaptions(svg: string): { axes: string[]; legends: string[] } {
  const root = parseSvg(svg)
  const axes: string[] = []
  const legends: string[] = []
  const walk = (el: XmlEl): void => {
    const role = el.attrs['aria-roledescription']
    const label = el.attrs['aria-label']
    if (label) {
      if (role === 'axis') axes.push(decode(label))
      else if (role === 'legend') legends.push(decode(label))
    }
    for (const c of el.children) if (typeof c !== 'string') walk(c)
  }
  walk(root)
  return { axes, legends }
}

const argv = process.argv.slice(2)
const filterIdx = argv.indexOf('--filter')
const filter = filterIdx >= 0 ? argv[filterIdx + 1]! : ''

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
      const loaded = await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS) as Record<string, unknown>
      const [svg, scene] = await Promise.all([renderWithVega(loaded as never), Promise.resolve(evaluateChart(compileChart(loaded as never)))])
      const real = realCaptions(svg)
      const info = getChartInfo(loaded as never)
      const tree = buildA11yTree(scene, info.scales)
      const oursAxes = tree.nodes.filter((n) => n.kind === 'axis').map((n) => n.label).sort()
      const oursLegends = tree.nodes.filter((n) => n.kind === 'legend').map((n) => n.label).sort()
      if (gate.plant) {
        const first = oursAxes.length ? oursAxes : oursLegends
        if (first.length) first[0] = `${first[0]} (planted)`
      }
      gate.count('captions', real.axes.length + real.legends.length)
      const okAxes = JSON.stringify(real.axes.sort()) === JSON.stringify(oursAxes)
      const okLegends = JSON.stringify(real.legends.sort()) === JSON.stringify(oursLegends)
      if (okAxes && okLegends) {
        pass++
        gate.agree(f)
      } else {
        gate.differ(f, okAxes ? `legends ${JSON.stringify(real.legends)} vs ${JSON.stringify(oursLegends)}` : `axes ${JSON.stringify(real.axes)} vs ${JSON.stringify(oursAxes)}`)
        console.log(`FAIL  ${f}`)
        if (!okAxes) {
          console.log(`  axes oracle: ${JSON.stringify(real.axes)}`)
          console.log(`  axes ours:   ${JSON.stringify(oursAxes)}`)
        }
        if (!okLegends) {
          console.log(`  legends oracle: ${JSON.stringify(real.legends)}`)
          console.log(`  legends ours:   ${JSON.stringify(oursLegends)}`)
        }
      }
    } catch (e) {
      gate.error(f, e instanceof Error ? e.message : String(e))
    }
  }
  console.log(`\n[a11y] ${pass}/${total} guide caption sets match`)
}

await runGate({
  name: 'a11y-parity',
  counters: {
    specs: { floor: 1063, what: 'corpus specs whose guide captions were compared' },
    captions: { floor: 1, what: 'guide captions of vega compared' },
  },
  partial: Boolean(filter),
  run: main,
})
