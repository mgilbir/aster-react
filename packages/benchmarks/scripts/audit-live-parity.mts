/**
 * Live-page parity audit: extract both engines' SVGs from the deployed demo,
 * canonicalize with the conformance tooling, and report per-card diffs.
 */
import { chromium } from 'playwright'
import { canonicalizeSvg, diffCanonical } from '../../conformance/src/normalize.js'

const URL = process.argv[2] ?? 'https://aster-charts-demo.ringed-crane.workers.dev/'

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForFunction(() => document.querySelectorAll('.vega-pane svg').length >= 18, null, { timeout: 60_000 })

const cards = await page.evaluate(() => {
  const out: Array<{ title: string; oracle: string; aster: string }> = []
  for (const section of document.querySelectorAll('.section')) {
    const title = section.querySelector('h2')?.textContent ?? '?'
    const panes = section.querySelectorAll('.pane')
    if (panes.length !== 2) continue
    const oracle = panes[0]!.querySelector('svg')
    const aster = panes[1]!.querySelector('svg')
    if (!oracle || !aster) continue
    out.push({ title, oracle: oracle.outerHTML, aster: aster.outerHTML })
  }
  return out
})
await browser.close()

console.log(`extracted ${cards.length} cards\n`)
let same = 0
for (const card of cards) {
  const a = canonicalizeSvg(card.oracle, { ignoreBackground: true })
  const b = canonicalizeSvg(card.aster, { ignoreBackground: true })
  const diffs = diffCanonical(a, b)
  if (diffs.length === 0) { same++; console.log(`MATCH  ${card.title}`); continue }
  // classify: text vs geometry
  const kinds = { text: 0, geom: 0 }
  for (const d of diffs) (d.startsWith('text|') ? kinds.text++ : kinds.geom++)
  console.log(`DIFF   ${card.title}  (${diffs.length} records: ${kinds.text} text, ${kinds.geom} geom)`)
  for (const d of diffs.slice(0, 6)) console.log(`         ${d.slice(0, 160)}`)
}
console.log(`\n${same}/${cards.length} cards match under canonicalized geometry diff`)
