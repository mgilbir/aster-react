// @vitest-environment node
/**
 * Every site a spec (or its data) can size, under every shape of `limits` a host can pass: no limits, `{}`, a time budget only,
 * and each single budget alone. The property is the one docs/LIMITS.md states for the built-in ceilings and `maxTimeMs`: a spec
 * of a few hundred bytes cannot exhaust the process or run unbounded, and passing a `limits` object is never less safe than
 * passing none (a limit replaces a ceiling only where the site compares that limit). Each site is one child process with a heap
 * cap and a hard kill (attack.testkit.ts); every form is timed in CPU inside the child.
 *
 * A site is `refused` (the attack must be an AsterLimitError, whatever the form) or `bounded` (it may also complete, but within
 * the CPU bound: the attack's size is no amplification there once the primitive guards itself, e.g. a dash finer than a pixel).
 */
import { describe, expect, it } from 'vitest'
import { attack } from './attack.testkit.js'

/** The limits forms each site is run under. `maxTimeMs` is the time-only form's budget. */
const TIME_MS = 300
const FORMS: Array<[string, string]> = [
  ['none', 'undefined'],
  ['{}', '{}'],
  ['maxTimeMs', `{ maxTimeMs: ${TIME_MS} }`],
  ['maxGeneratedRows', '{ maxGeneratedRows: 1000 }'],
  ['maxRows', '{ maxRows: 100000 }'],
  ['maxItems', '{ maxItems: 1000 }'],
  ['maxStringLength', '{ maxStringLength: 1000000 }'],
]
/** CPU allowed for one form that is not time-bounded: a refusal is immediate, a bounded site's work small. */
const CPU_MS = 3000
/** For the time-only form: two budgets and the slack of one uninterruptible chunk (attack.testkit.ts). */
const TIMED_CPU_MS = 2 * TIME_MS + 700

interface Site { name: string; spec: string; kind: 'refused' | 'bounded'; finding: string }

const seq = (n: number, extra = ''): string => `[{ type: 'sequence', start: 0, stop: ${n}, as: 'i' }${extra ? ', ' + extra : ''}]`
const labelSpec = (base: string, label = "size: [200, 100]", n = 3): string => `{
  width: 200, height: 100,
  data: [{ name: 'd', values: Array.from({ length: ${n} }, (_, i) => ({ x: 10 + (i * 37) % 180, y: 10 + (i * 17) % 80, t: 'label' + i })) }],
  marks: [
    { type: 'rect', name: 'base', from: { data: 'd' }, encode: { enter: { x: { field: 'x' }, y: { field: 'y' }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'steelblue' }, ${base} } } },
    { type: 'text', from: { data: 'base' }, encode: { enter: { text: { field: 'datum.t' }, fontSize: { value: 9 } } }, transform: [{ type: 'label', ${label} }] },
  ] }`

const SITES: Site[] = [
  // guides (C9)
  { finding: 'C9', name: 'legend tickCount 5e6', kind: 'refused', spec: `{ scales: [{ name: 'c', type: 'linear', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', tickCount: 5e6 }] }` },
  { finding: 'C9', name: 'legend gradientLength 1e9 (its default count)', kind: 'refused', spec: `{ scales: [{ name: 'c', type: 'linear', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', gradientLength: 1e9 }] }` },
  { finding: 'C9', name: 'size legend tickCount 2e5, symbolLimit 0', kind: 'refused', spec: `{ scales: [{ name: 's', type: 'linear', domain: [0, 1], range: [0, 100] }], legends: [{ size: 's', tickCount: 2e5, symbolLimit: 0 }] }` },
  { finding: 'C9', name: 'axis tickCount "seconds" over 300 years', kind: 'refused', spec: `{ scales: [{ name: 's', type: 'utc', domain: [0, 1e13], range: [0, 200] }], axes: [{ scale: 's', orient: 'bottom', tickCount: 'seconds' }] }` },
  { finding: 'C9', name: 'legend 200k ordinal entries, symbolLimit 0', kind: 'refused', spec: `{ data: [{ name: 'd', transform: ${seq(200000)} }], scales: [{ name: 's', type: 'ordinal', domain: { data: 'd', field: 'i' }, range: 'category' }], legends: [{ fill: 's', symbolLimit: 0 }] }` },
  // scales and expressions (C88, C19)
  { finding: 'C88', name: 'scale bins step 1e-8', kind: 'refused', spec: `{ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 100], bins: { step: 1e-8 } }], axes: [{ scale: 'x', orient: 'bottom' }] }` },
  { finding: 'C88', name: "utcSequence('seconds') over 30 years", kind: 'refused', spec: `{ signals: [{ name: 'n', update: "length(utcSequence('seconds', datetime(2000, 0, 1), datetime(2030, 0, 1)))" }] }` },
  // transforms that multiply (C88, Q18)
  { finding: 'C88', name: 'graticule step 0.001', kind: 'refused', spec: `{ data: [{ name: 'g', transform: [{ type: 'graticule', step: [0.001, 0.001] }] }] }` },
  { finding: 'C88', name: 'cross over 4000 rows', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(4000, "{ type: 'cross' }")} }] }` },
  { finding: 'C88', name: 'fold 2000 rows x 3000 fields', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(2000, "{ type: 'fold', fields: Array.from({ length: 3000 }, (_, i) => 'f' + i) }")} }] }` },
  { finding: 'C88', name: 'pivot 6000 x 6000', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(6000, "{ type: 'pivot', field: 'i', value: 'i', groupby: ['i'] }")} }] }` },
  { finding: 'C88', name: 'impute 3000 groups x 3000 keys', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(3000, "{ type: 'impute', field: 'v', key: 'i', groupby: ['i'] }")} }] }` },
  { finding: 'C88', name: 'flatten 3000 rows x 2000-long arrays', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(3000, "{ type: 'formula', expr: 'sequence(0, 2000)', as: 'a' }, { type: 'flatten', fields: ['a'] }")} }] }` },
  { finding: 'C88', name: 'kde 2000 groups x 5000 steps', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(2000, "{ type: 'kde', field: 'i', groupby: ['i'], steps: 5000, extent: [0, 1] }")} }] }` },
  { finding: 'C88', name: 'aggregate cross of 3 x 150 values', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(150, "{ type: 'formula', expr: 'datum.i', as: 'a' }, { type: 'formula', expr: 'datum.i', as: 'b' }, { type: 'aggregate', groupby: ['i', 'a', 'b'], cross: true }")} }] }` },
  { finding: 'C29', name: 'density 5e7 steps', kind: 'refused', spec: `{ data: [{ name: 't', values: [{ a: 1 }, { a: 2 }], transform: [{ type: 'density', distribution: { function: 'normal' }, extent: [0, 1], minsteps: 5e7, maxsteps: 5e7 }] }] }` },
  { finding: 'C29', name: 'quantile step 1e-8', kind: 'refused', spec: `{ data: [{ name: 't', values: [{ a: 1 }, { a: 2 }], transform: [{ type: 'quantile', field: 'a', step: 1e-8 }] }] }` },
  { finding: 'C88', name: 'regression order 2000', kind: 'refused', spec: `{ data: [{ name: 't', transform: ${seq(2100, "{ type: 'formula', expr: 'datum.i * datum.i', as: 'y' }, { type: 'regression', method: 'poly', order: 2000, x: 'i', y: 'y' }")} }] }` },
  // grids (C17, C15)
  { finding: 'C17', name: 'isocontour grid declared 2e9 x 1 with 2 values', kind: 'refused', spec: `{ data: [{ name: 'g', values: [{ grid: { values: [1, 0], width: 2e9, height: 1 } }], transform: [{ type: 'isocontour', field: 'grid', thresholds: [0.5] }] }] }` },
  { finding: 'C17', name: 'isocontour grid declared 1e5 x 1e5 with 4 values', kind: 'refused', spec: `{ data: [{ name: 'g', values: [{ grid: { values: [1, 0, 0, 1], width: 1e5, height: 1e5 } }], transform: [{ type: 'isocontour', field: 'grid', thresholds: [0.5] }] }] }` },
  { finding: 'C17', name: 'contour size [40000, 40000] over 3 values', kind: 'refused', spec: `{ data: [{ name: 's', values: [{}], transform: [{ type: 'contour', size: [40000, 40000], values: [1, 2, 3], thresholds: [1.5] }] }] }` },
  { finding: 'C15', name: 'heatmap of a grid 0 wide and 1e12 high', kind: 'bounded', spec: `{ data: [{ name: 's', values: [{ grid: { width: 0, height: 1e12, values: [] } }], transform: [{ type: 'heatmap', field: 'grid' }] }] }` },
  { finding: 'C15', name: 'heatmap of a window 0 wide (x1 = x2) and 1e12 high', kind: 'bounded', spec: `{ data: [{ name: 's', values: [{ grid: { width: 4, x1: 2, x2: 2, y1: 0, y2: 1e12, height: 4, values: [1, 2, 3, 4] } }], transform: [{ type: 'heatmap', field: 'grid' }] }] }` },
  { finding: 'C15', name: 'heatmap of a grid 1e5 x 1e5', kind: 'refused', spec: `{ data: [{ name: 's', values: [{ grid: { width: 1e5, height: 1e5, values: [] } }], transform: [{ type: 'heatmap', field: 'grid' }] }] }` },
  // the label rasterizer (C16, C93, C94)
  { finding: 'C16', name: 'label over a base mark with strokeDash [1e-7]', kind: 'bounded', spec: labelSpec("stroke: { value: 'black' }, strokeDash: { value: [1e-7] }") },
  { finding: 'C16', name: 'label over a base mark with strokeDash [1e-20]', kind: 'bounded', spec: labelSpec("stroke: { value: 'black' }, strokeDash: { value: [1e-20] }") },
  { finding: 'C16', name: 'label over a base mark with strokeDash [1, 1] at 1e6 px wide', kind: 'bounded', spec: labelSpec("width: { value: 1e6 }, stroke: { value: 'black' }, strokeDash: { value: [1, 1] }") },
  { finding: 'C94', name: 'label over a base mark with strokeWidth 1e11, round joins', kind: 'bounded', spec: labelSpec("stroke: { value: 'black' }, strokeWidth: { value: 1e11 }, strokeJoin: { value: 'round' }") },
  { finding: 'C94', name: 'label over a base mark with strokeWidth 1e17, round caps', kind: 'bounded', spec: labelSpec("stroke: { value: 'black' }, strokeWidth: { value: 1e17 }, strokeCap: { value: 'round' }") },
  { finding: 'C93', name: 'label size [40000, 40000]', kind: 'refused', spec: labelSpec('', 'size: [40000, 40000]') },
  { finding: 'C93', name: 'label 40000 labels x 40000 anchors', kind: 'refused', spec: labelSpec('', "size: [200, 100], avoidBaseMark: false, anchor: Array.from({ length: 40000 }, (_, i) => ['top', 'left', 'right', 'bottom'][i % 4]), offset: Array.from({ length: 40000 }, (_, i) => i % 7)", 40000) },
  // the word cloud (C95)
  { finding: 'C95', name: 'wordcloud size [60000, 60000]', kind: 'refused', spec: `{ data: [{ name: 'w', values: [{ text: 'a' }], transform: [{ type: 'wordcloud', size: [60000, 60000], text: { field: 'text' } }] }] }` },
  { finding: 'C95', name: 'wordcloud size [1, 3e6]: 50 words that never fit', kind: 'refused', spec: `{ data: [{ name: 'w', values: Array.from({ length: 50 }, (_, i) => ({ text: 'word' + i })), transform: [{ type: 'wordcloud', size: [1, 3e6], text: { field: 'text' }, fontSize: 40 }] }] }` },
  // force (C239)
  { finding: 'C239', name: 'static force, no forces, iterations 1e9', kind: 'refused', spec: `{ data: [{ name: 'n', values: [{}, {}, {}], transform: [{ type: 'force', static: true, iterations: 1e9, forces: [] }] }] }` },
  { finding: 'C239', name: 'link force iterations 3e9 over no links, one tick', kind: 'refused', spec: `{ data: [{ name: 'l', values: [] }, { name: 'n', values: [{}, {}, {}], transform: [{ type: 'force', forces: [{ force: 'link', links: 'l', iterations: 3e9 }] }] }] }` },
  { finding: 'C239', name: 'collide iterations 3e9 over no nodes, one tick', kind: 'refused', spec: `{ data: [{ name: 'n', values: [], transform: [{ type: 'force', forces: [{ force: 'collide', iterations: 3e9 }] }] }] }` },
  // contour holes (C240), nest (C486), the pre-flight walk (C107)
  { finding: 'C486', name: 'nest with 30000 keys', kind: 'bounded', spec: `{ data: [{ name: 't', values: [{ a: 1 }, { a: 2 }], transform: [{ type: 'nest', keys: Array(30000).fill('a') }] }] }` },
  { finding: 'C107', name: 'a spec sharing sub-objects 40 levels deep', kind: 'refused', spec: `(() => { let o = { a: 1 }; for (let i = 0; i < 40; i++) o = { p: o, q: o }; return { width: 10, height: 10, marks: [], usermeta: o } })()` },
  // the geo pipeline (T1's geo files; C242's amplification)
  { finding: 'C242', name: 'orthographic scale 1e12, precision 1e-9 over a graticule', kind: 'refused', spec: `{ width: 100, height: 100, projections: [{ name: 'p', type: 'orthographic', scale: 1e12, precision: 1e-9, clipAngle: 0 }], data: [{ name: 'g', transform: [{ type: 'graticule', extent: [[0, 0], [60, 80]], step: [1, 1] }] }], marks: [{ type: 'shape', from: { data: 'g' }, encode: { update: { stroke: { value: 'black' } } }, transform: [{ type: 'geoshape', projection: 'p' }] }] }` },
]

interface FormResult { form: string; threw: { name: string; message: string } | null; cpuMs: number }

/** Run every form of one site in one child: each a fresh render, its CPU time measured around it. */
async function runForms(site: Site): Promise<{ results: FormResult[] | undefined; killed: boolean; stderr: string; threw: unknown }> {
  const r = await attack(`
    const forms = [${FORMS.map(([name, limits]) => `[${JSON.stringify(name)}, ${limits}]`).join(', ')}]
    const out = []
    for (const [form, limits] of forms) {
      const spec = ${site.spec}
      const c0 = process.cpuUsage()
      let threw = null
      try { core.renderSpec(spec, limits ? { limits } : {}) } catch (e) { threw = { name: e && e.name, message: String(e && e.message).slice(0, 200) } }
      const c = process.cpuUsage(c0)
      out.push({ form, threw, cpuMs: (c.user + c.system) / 1000 })
    }
    return out`)
  return { results: r.value as FormResult[] | undefined, killed: r.killed, stderr: r.stderr, threw: r.threw }
}

describe('every spec-sized site is bounded under every limits form (no limits, {}, time only, each budget alone)', () => {
  for (const site of SITES) {
    it(`${site.finding}: ${site.name} (${site.kind})`, async () => {
      const { results, killed, stderr, threw } = await runForms(site)
      expect(killed, `the child hung and was killed. stderr: ${stderr}`).toBe(false)
      expect(threw, `the child failed outside a render: ${JSON.stringify(threw)} ${stderr}`).toBeNull()
      expect(results?.length, `the child died (out of memory?): ${stderr}`).toBe(FORMS.length)
      for (const f of results!) {
        const label = `${f.form}: ${JSON.stringify(f.threw)} after ${f.cpuMs.toFixed(0)} ms CPU`
        if (site.kind === 'refused') expect(f.threw?.name, label).toBe('AsterLimitError')
        else if (f.threw) expect(f.threw.name, label).toBe('AsterLimitError')
        expect(f.cpuMs, label).toBeLessThan(f.form === 'maxTimeMs' ? TIMED_CPU_MS : CPU_MS)
      }
    }, 60_000)
  }
})
