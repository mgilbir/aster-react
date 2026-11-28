// @vitest-environment jsdom
/**
 * `specNeeds(spec).parts` (what the React shells load before a chart's first render, @aster-charts/core/internal) never misses a part the
 * engine reads, and a chart drawn with just the parts it names is the chart drawn with all of them.
 *
 * The ground truth is the engine itself, as in addons-needed.test.ts: every corpus spec (Vega, and Vega-Lite through the pinned vega-lite
 * compiler) is drawn with every part in its slot, then again from empty slots, loading each part the engine asks for
 * (parts-needed.testlib.ts: what "drawn" covers -- the evaluation, svg, canvas, picks, and the signal loop answering a user's
 * pointer). `specNeeds` must name every part read (it may name more: it reads the structure, and a field-driven symbol shape may or
 * may not be a path), and a drawing with exactly the parts it names must equal the one with all of them. The same again under
 * `limits`, where the regular-expression screen runs. The galleries get the same check in gallery/parts-needed.gallery.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { partLoaded, specNeeds, withdrawParts } from '@aster-charts/core/internal'
import { compileChart, type SpecLimits, type VgSpec } from '@aster-charts/core'
import { checkLoad, checkParts } from './parts-needed.testlib.js'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')
const CORPUS_VEGA_ONLY = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus-vega-only')
/** Generous limits: the screen runs, nothing a corpus spec does is refused for its size. */
const LIMITS: SpecLimits = { maxRows: 10_000_000, maxTimeMs: 600_000 }

describe('the loader loads the calendar its date patterns read', () => {
  const fetchOf = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch
  const specOf = (parse: unknown): VgSpec => ({ data: [{ name: 'd', url: 'https://example.com/d.csv', format: { type: 'csv', parse } }] }) as never

  it.each([
    ['a date: pattern', { when: 'date:%Y-%m-%d' }],
    ['a utc: pattern', { when: 'utc:%Y-%m-%d' }],
  ])('loads the time part for %s, from empty slots', async (_n, parse) => {
    const restore = withdrawParts(['time'])
    try {
      const out = await loadSpecData(specOf(parse) as never, { fetch: fetchOf('when\n2020-03-04\n'), ...TRUSTED_LOAD_OPTIONS }) as unknown as { data: Array<{ values: Array<{ when: unknown }> }> }
      expect(partLoaded('time')).toBe(true)
      expect(new Date(out.data[0]!.values[0]!.when as number).toISOString().slice(0, 10)).toBe('2020-03-04')
    } finally { restore() }
  })

  it('loads nothing for a parse that reads no date pattern', async () => {
    const restore = withdrawParts(['time'])
    try {
      await loadSpecData(specOf({ n: 'number' }) as never, { fetch: fetchOf('n\n1\n'), ...TRUSTED_LOAD_OPTIONS })
      expect(partLoaded('time')).toBe(false)
    } finally { restore() }
  })
})

describe('specNeeds names every part the engine reads, over the whole corpus', async () => {
  const specs: Array<{ name: string; spec: VgSpec }> = []
  const raw: Array<{ name: string; spec: VgSpec }> = []
  let files = 0
  /** the corpus files that are not a case here, with why: none is allowed */
  const lost: string[] = []
  for (const dir of [CORPUS, CORPUS_VEGA_ONLY]) {
    for (const f of readdirSync(dir).sort()) {
      const kind = f.endsWith('.vl.json') ? 'vl' : f.endsWith('.vg.json') ? 'vg' : null
      if (!kind) continue
      files++
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as VgSpec
      let spec = (doc.$schema ? doc : ((doc as { spec?: VgSpec }).spec ?? doc)) as VgSpec
      if (kind === 'vl') {
        try { spec = vl.compile(spec as never).spec as unknown as VgSpec } catch (e) { lost.push(`${f}: vega-lite does not compile it: ${String(e).slice(0, 100)}`); continue }
      }
      raw.push({ name: f, spec })
      try { specs.push({ name: f, spec: await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS) as VgSpec }) } catch (e) { lost.push(`${f}: its data did not load: ${String(e).slice(0, 100)}`) }
    }
  }

  it('covers the corpus: every file is a case', () => {
    expect(lost, 'corpus files left out of every comparison below').toEqual([])
    expect(files).toBeGreaterThan(1000)
    expect(specs.length).toBe(files)
  })

  it('loads a spec\'s data with the parts the loader reads, whatever is already in the page', async () => {
    const { wrong, loaded } = await checkLoad(raw, TRUSTED_LOAD_OPTIONS)
    expect(wrong.slice(0, 20).join('\n'), `${wrong.length} wrong`).toBe('')
    expect(loaded).toBeGreaterThan(900)
  }, 600_000)

  it('names the signal loop for every chart an interactive shell binds it for, and for few others', () => {
    // (ChartCore binds the loop when the compiled view has a signal -- any `on` stream is a signal's -- or the host listens to signals,
    // which `useAddons` adds itself: what the spec alone must say is the first)
    const missed: string[] = []
    let bound = 0
    let named = 0
    for (const { name, spec } of specs) {
      let signals: number
      try { signals = compileChart(spec as never).signalDefs?.length ?? 0 } catch { continue }
      const eventLoop = specNeeds(spec).eventLoop
      if (signals > 0) bound++
      if (eventLoop) named++
      if (signals > 0 && !eventLoop) missed.push(name)
    }
    console.log(`[parts-needed] signal loop: bound for ${bound} specs, named for ${named} of ${specs.length}`)
    expect(missed.slice(0, 12)).toEqual([])
    // not vacuous, and the loop stays out of most charts: what is named beyond what is bound is a group mark's signals
    expect(bound).toBeGreaterThan(100)
    expect(named).toBeLessThanOrEqual(bound * 1.1 + 5)
    expect(specs.length - named).toBeGreaterThan(300)
  })

  for (const [mode, input] of [['without limits', {}], ['under limits', { limits: LIMITS }]] as const) {
    it(`${mode}: names every part the drawing reads, and draws with just those what it draws with all`, async () => {
      const { wrong, compared, dropped, read: counts, named } = await checkParts(specs, () => ({ ...input }), { limits: 'limits' in input })
      console.log(`[parts-needed] ${mode}: ${compared} specs; read ${JSON.stringify(counts)}; named ${JSON.stringify(named)}`)
      expect(wrong.slice(0, 12).join('\n'), `${wrong.length} wrong`).toBe('')
      expect(dropped, 'specs that do not draw with every part and were left out').toEqual([])
      expect(compared).toBe(specs.length)
      // not vacuous: the parts a spec's drawing can read are read by some corpus specs, and most specs read none of them
      expect(counts.legend).toBeGreaterThan(50)
      expect(counts.layout).toBeGreaterThan(5)
      expect(counts.svgpath).toBeGreaterThan(3) // (a legend brings the path reader with it: part-legend.ts)
      expect(counts.selections).toBeGreaterThan(5)
      expect(counts.aggregate).toBeGreaterThan(100)
      expect(counts.reshape).toBeGreaterThan(100)
      expect(counts.window).toBeGreaterThan(2)
      expect(counts.time).toBeGreaterThan(30)
      expect(counts.curves).toBeGreaterThan(30)
      expect(counts.color).toBeGreaterThan(50)
      expect(counts.scales).toBeGreaterThan(50)
      if ('limits' in input) expect(counts.regex).toBeGreaterThan(0)
      else expect(counts.regex).toBe(0)
      // how much more than needed is loaded (the detector reads structure, so it may over-name; it must not over-name wildly)
      for (const p of ['legend', 'layout', 'selections', 'aggregate', 'window', 'reshape', 'time', 'curves', 'color', 'scales'] as const) {
        expect(named[p], `${p}: named ${named[p]}, read ${counts[p]}`).toBeLessThanOrEqual(counts[p] * 1.1 + 2)
      }
      // (the screen: only a call that may hand it a regular expression; not every `join(a, ', ')` of a Vega-Lite spec)
      expect(named.regex, `regex: named ${named.regex}, read ${counts.regex}`).toBeLessThanOrEqual('limits' in input ? 20 : 0)
    }, 1_800_000)
  }
})
