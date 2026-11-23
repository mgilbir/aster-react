/**
 * The bundle-size figures in the docs are tied to the budgets in code (C368, D2): `packages/benchmarks/scripts/budget-rows.mjs` holds a ceiling per
 * import pattern, always the measured gzip size plus 0.5 kB, so the size a doc may state for a row is its ceiling minus 0.5 kB. Every figure
 * a doc states for a row (the table of docs/PERFORMANCE.md, the sentences derived from it, docs/API.md, the react README, the shipped
 * `.d.ts` comments) is checked here, so a change that edits a budget and not the docs fails, and so does a doc that states a size the
 * code no longer measures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** `'<row name>': <kB> * KB,` inside `export const BUDGETS = {` ... `}` of budget-rows.mjs. */
function budgets() {
  const text = read('packages/benchmarks/scripts/budget-rows.mjs')
  const block = /export const BUDGETS = \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  const out = new Map()
  for (const m of block.matchAll(/^\s*'([^']+)':\s*([\d.]+)\s*\*\s*KB,/gm)) out.set(m[1], Number(m[2]))
  return out
}
const B = budgets()
/** The ceiling of a row (its measured size + 0.5 kB when it was last set). */
const ceiling = (name) => {
  const c = B.get(name)
  if (c === undefined) throw new Error(`no budget named ${name}`)
  return c
}
/** A size a doc states for a row must be within the budget's own headroom: at most the ceiling and not more than 1 kB under it (measured + 0.5 = ceiling, give or take the noise of rounding and of the rows moving between edits). */
const withinBudget = (stated, name) => stated <= ceiling(name) && stated >= ceiling(name) - 1
const fmt = (n) => n.toFixed(1)

describe('budget-rows.mjs', () => {
  it('has the rows the docs state, each a ceiling in kB', () => {
    expect(B.size).toBeGreaterThanOrEqual(15)
    for (const name of ['@aster-charts/core', '@aster-charts/react useChart', '@aster-charts/react Chart', '@aster-charts/react SvgChart', '@aster-charts/react SvgChart + interaction', '@aster-charts/react Chart + VL']) {
      expect(B.has(name), name).toBe(true)
    }
  })
})

describe('docs/PERFORMANCE.md bundle table', () => {
  const doc = read('docs/PERFORMANCE.md')
  const table = doc.slice(doc.indexOf('| Row (`budget-rows.mjs` name)'))
  const rows = [...table.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([\d.]+) \|(?:\s*[\d.]*\s*\|)?$/gm)].map((m) => ({ name: m[1], pattern: m[2].trim(), kb: Number(m[3]) }))

  it('lists every budget row, once, and nothing else', () => {
    expect(rows.map((r) => r.name).sort()).toEqual([...B.keys()].sort())
  })

  it('states, for every row, a size inside its budget: at most the ceiling, at most 1 kB below it', () => {
    for (const r of rows) expect(withinBudget(r.kb, r.name), `${r.name}: the table says ${r.kb} kB, the ceiling in budget-rows.mjs is ${fmt(ceiling(r.name))}`).toBe(true)
  })
})

describe('docs that derive a size from two rows', () => {
  const performance = read('docs/PERFORMANCE.md')
  const api = read('docs/API.md')
  const readme = read('packages/react/README.md')
  // the figures as PERFORMANCE.md's own table states them: every sentence derived from two rows must be arithmetic on that table
  const table = new Map([...performance.matchAll(/^\| `([^`]+)` \| [^|]+ \| ([\d.]+) \|(?:\s*[\d.]*\s*\|)?$/gm)].map((m) => [m[1], Number(m[2])]))
  const t = (name) => { const v = table.get(name); if (v === undefined) throw new Error(`no table row ${name}`); return v }
  const chart = t('@aster-charts/react Chart')
  const lite = t('@aster-charts/react SvgChart')
  const liteInteraction = t('@aster-charts/react SvgChart + interaction')
  const chartVl = t('@aster-charts/react Chart + VL')
  const round1 = (n) => Math.round(n * 10) / 10

  it('PERFORMANCE.md: how much smaller <SvgChart> is than <Chart>, what the Vega-Lite compiler adds, and the marginal rows named beside them', () => {
    const smaller = /`<SvgChart>` is ([\d.]+) kB smaller than `<Chart>` \(([\d.]+) minus ([\d.]+)\)/.exec(performance)
    expect(smaller, 'the sentence about <SvgChart> being smaller').not.toBeNull()
    expect([Number(smaller[2]), Number(smaller[3]), Number(smaller[1])]).toEqual([chart, lite, round1(chart - lite)])
    const marginal = /Their marginal rows \(([\d.]+), ([\d.]+) and ([\d.]+) kB\)/.exec(performance)
    expect(marginal, 'the sentence naming the canvas, hit and signals marginal rows').not.toBeNull()
    expect([Number(marginal[1]), Number(marginal[2]), Number(marginal[3])]).toEqual([t('+ @aster-charts/core/canvas'), t('+ @aster-charts/core/hit'), t('+ @aster-charts/core/signals')])
    const vl = /The Vega-Lite compiler is ([\d.]+) kB gzip on top of the base `<Chart>` \(([\d.]+) minus ([\d.]+)/.exec(performance)
    expect(vl, 'the sentence about the Vega-Lite compiler').not.toBeNull()
    expect([Number(vl[2]), Number(vl[3]), Number(vl[1])]).toEqual([chartVl, chart, round1(chartVl - chart)])
    const like = /Chart>\` plus the\s+Vega-Lite compiler: ([\d.]+) kB gzip up front plus ([\d.]+) kB loaded on demand \(the `budget`\s+rows below\), ([\d.]+) kB in all/.exec(performance)
    expect(like, 'the like-for-like sentence').not.toBeNull()
    expect(Number(like[1])).toBe(chartVl)
    expect(Number(like[3])).toBe(round1(Number(like[1]) + Number(like[2])))
  })

  it('API.md and the react README state the same <Chart>, <SvgChart> and interaction sizes as the table, and the gap between them', () => {
    const sizes = /`<Chart>` ([\d.]+) kB,\s*`<SvgChart>` ([\d.]+) kB, `<SvgChart>` \+ `interaction` ([\d.]+) kB/.exec(api)
    expect(sizes, 'API.md sizes sentence').not.toBeNull()
    expect([Number(sizes[1]), Number(sizes[2]), Number(sizes[3])]).toEqual([chart, lite, liteInteraction])
    const gap = /unless that ([\d.]+) kB/.exec(api)
    expect(gap, 'API.md gap sentence').not.toBeNull()
    expect(Number(gap[1])).toBe(round1(chart - lite))
    const r = /`<SvgChart>` from `@aster-charts\/react\/lite` \(([\d.]+) kB gzip against ([\d.]+) kB for/.exec(readme)
    expect(r, 'react README <SvgChart> sentence').not.toBeNull()
    expect([Number(r[1]), Number(r[2])]).toEqual([lite, chart])
    const ri = /\(([\d.]+) kB gzip with it;/.exec(readme)
    expect(Number(ri?.[1])).toBe(liteInteraction)
  })

  it('API.md: the <Chart> and <Chart> + VL figures and the compiler\'s size', () => {
    const m = /adds about ([\d.]+) kB\s*gzip to the bundle \(`<Chart>` ([\d.]+) kB, `<Chart>` \+ `@aster-charts\/react\/vl` ([\d.]+) kB eager/.exec(api)
    expect(m, 'API.md Vega-Lite sentence').not.toBeNull()
    expect([Number(m[2]), Number(m[3])]).toEqual([chart, chartVl])
    expect(Math.abs(Number(m[1]) - (chartVl - chart))).toBeLessThanOrEqual(1) // "about": within a kB
  })

  it('the shipped declarations say the compiler\'s size like the table does (to the nearest 5 kB)', () => {
    const nearest5 = (n) => Math.round(n / 5) * 5
    for (const f of ['packages/react/src/vl.ts', 'packages/react/src/vl-registry.ts']) {
      const m = /about (\d+) kB gzip/.exec(read(f))
      expect(m, f).not.toBeNull()
      expect(Number(m[1]), f).toBe(nearest5(chartVl - chart))
    }
  })
})
