/**
 * Guide-caption parity: compare the accessible axis/legend captions emitted by
 * buildA11yTree with the aria-label values vega-scenegraph puts on the same
 * guides. Mark labels are compared only for existence (data descriptions are
 * host-authored).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { buildA11yTree, compileChart, evaluateChart, getChartInfo } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
import { renderWithVega } from '../src/render-vega.js'
import { parseSvg, type XmlEl } from '../src/svg-parse.js'

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

async function main(): Promise<boolean> {
  if (!existsSync(CORPUS)) return false
  const argv = process.argv.slice(2)
  const filterIdx = argv.indexOf('--filter')
  const filter = filterIdx >= 0 ? argv[filterIdx + 1]! : ''
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
  let pass = 0
  const failures: string[] = []
  for (const f of files) {
    if (filter && !f.includes(filter)) continue
    const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Record<string, unknown>
    const spec = f.endsWith('.vl.json')
      ? (vl.compile(raw as never).spec as unknown as Record<string, unknown>)
      : raw
    try {
      const loaded = await loadSpecData(spec as never) as Record<string, unknown>
      const [svg, scene] = await Promise.all([renderWithVega(loaded as never), Promise.resolve(evaluateChart(compileChart(loaded as never)))])
      const real = realCaptions(svg)
      const info = getChartInfo(loaded as never)
      const tree = buildA11yTree(scene, info.scales)
      const oursAxes = tree.nodes.filter((n) => n.kind === 'axis').map((n) => n.label).sort()
      const oursLegends = tree.nodes.filter((n) => n.kind === 'legend').map((n) => n.label).sort()
      const okAxes = JSON.stringify(real.axes.sort()) === JSON.stringify(oursAxes)
      const okLegends = JSON.stringify(real.legends.sort()) === JSON.stringify(oursLegends)
      if (okAxes && okLegends) pass++
      else {
        failures.push(f)
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
      failures.push(f)
      console.log(`FAIL  ${f}  (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const total = files.filter((f) => !filter || f.includes(filter)).length
  console.log(`\n[a11y] ${pass}/${total} guide caption sets match`)
  if (failures.length) console.log(`[a11y] failing: ${failures.slice(0, 30).join(', ')}${failures.length > 30 ? ', …' : ''}`)
  return failures.length === 0
}

const ok = await main()
process.exit(ok ? 0 : 1)
