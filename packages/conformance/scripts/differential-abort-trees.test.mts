/**
 * A dataflow pass that fails, over random trees of nested scopes, against the pinned real Vega, in this process.
 *
 * Vega's dataflow stops at the first operator that throws: the error is logged ONCE, the operators ranked after it never run, and
 * the scenegraph is what the operators ranked before it made. The operators of a nested scope (a group's content) exist only once
 * the group item's own operators have run, so they rank after every operator of the enclosing scope, level by level. A failing
 * encode, signal, axis or legend part anywhere in a tree therefore decides which other marks, groups, axes and legends get built.
 *
 * Generated: specs of marks and groups nested up to three deep (own scales, faceted groups, axes, legends, titles) with one or
 * two failures put at random places (a mark's encode, a group's own encode, a guide part's encode, a signal, a mark's or a group's
 * transform or sort, a header group's sort, an encode and a transform of one mark, a transform of a mark among others that work on
 * its items), groups and marks whose transforms write onto their items, and header groups in grid layouts, compared to vega
 * by the picture (strict canonicalizer) and by what was logged (how many errors and their class; the text when it names a
 * scale written out).
 *
 * `ASTER_DIFF_SCALE` multiplies the number of trees. To narrow a failure down: `ABORT_KINDS=axis,legend` draws only those failures, and
 * `ABORT_ONE=1` puts exactly one failure in every tree (differential-abort-gen.mts).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { makeRng, scaled } from './differential-gen.mts'
import { FAILS, treeSpec, type Fail } from './differential-abort-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(String(a[0])); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec): { svg: string; errors: string[] } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} }
  return { svg: renderSpec(structuredClone(spec) as never, { logger } as never), errors }
}

const SEEDS = [11, 23, 37]
const PER_SEED = scaled(200)

describe('a pass that fails builds what vega builds', () => {
  it.each(SEEDS)(`${PER_SEED} generated trees of nested scopes, seed %i`, { timeout: 600_000 }, async (seed) => {
    const r = makeRng(seed)
    const bad: string[] = []
    let failed = 0
    const kinds = new Map<Fail, number>()
    // (the trees that differ, by the kinds of failure they hold: what to narrow a failure down by, with ABORT_KINDS)
    const badKinds = new Map<string, number>()
    for (let c = 0; c < PER_SEED; c++) {
      const { spec, fails, label } = treeSpec(r)
      const differs = (why: string): void => { bad.push(why); for (const f of fails.length ? fails : ['none']) badKinds.set(f, (badKinds.get(f) ?? 0) + 1) }
      const want = await onVega(spec)
      let got: ReturnType<typeof onAster>
      const tag = `#${c} ${label}`
      try {
        got = onAster(spec)
      } catch (e) {
        differs(`${tag}: aster threw ${(e as Error).message}`)
        continue
      }
      // The evaluation that keeps no state (what renderSpec runs) and the one that carries the incremental engine make the same of a pass
      // that stops, and the second evaluation of a chart (which may keep and reuse what the first made) the same again.
      const chart = compileChart(structuredClone(spec) as never)
      const evaluate = (): { svg: string; errors: string[] } => {
        const errors: string[] = []
        const input = { logger: { error: (...x: unknown[]) => { errors.push(String(x[0])) }, warn: () => {} } } as never
        return { svg: renderSceneToSvg(evaluateChart(chart, input)), errors }
      }
      const first = evaluate()
      const again = evaluate()
      if (first.svg !== got.svg || JSON.stringify(first.errors) !== JSON.stringify(got.errors)) { differs(`${tag}: the evaluation with the incremental engine made something else than the one without (${JSON.stringify(first.errors)})`); continue }
      if (again.svg !== first.svg || JSON.stringify(again.errors) !== JSON.stringify(first.errors)) { differs(`${tag}: the second evaluation made something else than the first (${JSON.stringify(again.errors)})`); continue }
      if (want.errors.length) { failed++; for (const f of fails) kinds.set(f, (kinds.get(f) ?? 0) + 1) }
      // (one error, logged once: the first operator in vega's order that threw)
      if (JSON.stringify(want.errors) !== JSON.stringify(got.errors)) { differs(`${tag}: vega logged ${JSON.stringify(want.errors)}, aster ${got.errors.length}: ${JSON.stringify(got.errors.slice(0, 2))}`); continue }
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) differs(`${tag}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.length, `${bad.length} of ${PER_SEED} trees differ (by kind: ${[...badKinds].map(([k, n]) => `${k} ${n}`).join(', ')}):\n${bad.slice(0, 8).join('\n')}`).toBe(0)
    // not vacuous: most trees fail in vega, and every kind of failure was drawn and logged by it
    expect(failed).toBeGreaterThan(PER_SEED * 0.5)
    for (const kind of FAILS) expect(kinds.get(kind) ?? 0, `trees whose ${kind} failed in vega`).toBeGreaterThan(PER_SEED * 0.015)
  })
})

/**
 * A guide that reads a late signal that throws. vega logs the one error; what it then holds depends on which of the guide's
 * operators read the signal. Where it is an axis's ticks (`tickCount`, `values`, `format`, ...), the axis's tick, label and grid
 * marks are never made and vega's renderers cannot draw what is left (`toSVG` rejects; a live view logs a second error and stops
 * drawing there): Aster refuses that view, and only that one. Elsewhere the parts that read the signal are left unencoded and the
 * view is not laid out: the error logged and the picture are compared, by both evaluations.
 */
describe('a guide that reads a late signal that throws', () => {
  const PROPS = ['tickCount', 'values', 'format', 'formatType', 'tickMinStep', 'tickExtra', 'title', 'offset', 'labelFontSize', 'labelColor', 'zindex'] as const
  // (the parts of a guide that are not its ticks: a title's paint and font, the padding and placement of the parts, the size and paint of
  // labels, ticks, the domain and the grid of an axis, a legend's symbols and gradient; and a few properties that guide does not have)
  const AXIS_PARTS = ['titleColor', 'titleFontSize', 'titlePadding', 'labelPadding', 'labelOpacity', 'labelAngle', 'labelOffset', 'labelFlush', 'labelFlushOffset',
    'labelOverlap', 'tickColor', 'tickSize', 'domainColor', 'gridColor', 'translate', 'minExtent', 'columns', 'fillColor', 'symbolSize', 'gradientLength'] as const
  const LEGEND_PARTS = ['titleColor', 'titleFontSize', 'titlePadding', 'titleOrient', 'labelOpacity', 'labelOffset', 'padding', 'fillColor', 'symbolSize',
    'symbolFillColor', 'symbolStrokeColor', 'symbolType', 'symbolOffset', 'gradientLength', 'gradientThickness', 'columns', 'direction', 'tickSize', 'domainColor'] as const
  const LATE = [`data('t')[0].zz.q`, `null.x + scale('x', 1)`, `bandwidth('x') + null.x`]
  it(`${scaled(240)} generated guides: refused where vega cannot draw, else drawn and logged as vega does`, { timeout: 300_000 }, async () => {
    const r = makeRng(53)
    const bad: string[] = []
    let unrenderable = 0
    let pictures = 0
    for (let c = 0; c < scaled(240); c++) {
      const guide = r.pick(['axis', 'axis', 'symbols', 'gradient', 'title'])
      const prop = r.chance(0.4) ? r.pick(PROPS) : guide === 'axis' ? r.pick(AXIS_PARTS) : r.pick(LEGEND_PARTS)
      const read = { signal: r.pick(['late', 'late + 1', "'' + late", 'late.v']) }
      const own: Spec = guide === 'axis' ? { scale: 'x', orient: r.pick(['bottom', 'left', 'top']), [prop]: read } : { fill: guide === 'symbols' ? 'c' : 'g', [prop]: read }
      if (guide !== 'title' && r.chance(0.4)) own.title = 'guide'
      // (an axis that draws nothing made from its ticks has no marks missing)
      if (guide === 'axis') for (const part of ['ticks', 'labels', 'grid']) if (r.chance(0.3)) own[part] = r.chance(0.3)
      // (a flush offset is read only by labels that are flushed)
      if (prop === 'labelFlushOffset') own.labelFlush = true
      const spec: Spec = {
        width: 100, height: 60, padding: 4, autosize: r.pick(['none', 'pad']),
        signals: [{ name: 'late', update: r.pick(LATE) }],
        scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: [0, 100] }, { name: 'c', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] }, { name: 'g', type: 'linear', domain: [0, 4], range: ['white', 'black'] }],
        data: [{ name: 't', values: [{ a: 1, k: 'p' }, { a: 2, k: 'q' }] }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'teal' } } } }],
        ...(guide === 'axis' ? { axes: [own] } : guide === 'title' ? { title: titleOf(r, read) } : { legends: [own] }),
      }
      const errors: string[] = []
      const logger = { level() { return 2 }, error: (...a: unknown[]) => { errors.push(String(a[0])); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
      const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
      const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
      await view.runAsync()
      const picture = await view.toSVG().then((svg) => svg, () => undefined)
      const drawn = picture !== undefined
      view.finalize()
      if (!drawn) unrenderable++
      const tag = `#${c} ${JSON.stringify(spec.axes ?? spec.legends ?? spec.title)}`
      const chart = compileChart(structuredClone(spec) as never)
      type Outcome = { errors: string[]; svg?: string; refused?: string }
      const evaluate = (): Outcome => {
        const logged: string[] = []
        try {
          return { errors: logged, svg: renderSceneToSvg(evaluateChart(chart, { logger: { error: (...x: unknown[]) => { logged.push(String(x[0])) }, warn: () => {} } } as never)) }
        } catch (e) {
          return { errors: logged, refused: (e as Error).message }
        }
      }
      const logged: string[] = []
      let got: Outcome
      try { got = { errors: logged, svg: renderSpec(structuredClone(spec) as never, { logger: { error: (...x: unknown[]) => { logged.push(String(x[0])) }, warn: () => {} } } as never) } } catch (e) { got = { errors: logged, refused: (e as Error).message } }
      const first = evaluate()
      const again = evaluate()
      if (JSON.stringify(first) !== JSON.stringify(got) || JSON.stringify(again) !== JSON.stringify(got)) { bad.push(`${tag}: the evaluations of the chart differ: ${JSON.stringify([got, first, again])}`); continue }
      // (the error is logged before the view is refused, as vega logs it before it cannot draw)
      if (JSON.stringify(got.errors) !== JSON.stringify(errors)) bad.push(`${tag}: vega logged ${JSON.stringify(errors)}, aster ${JSON.stringify(got.errors)} (${got.refused ?? 'drawn'})`)
      else if (!drawn && !got.refused?.startsWith('[aster]')) bad.push(`${tag}: vega cannot draw it, aster ${got.refused === undefined ? 'drew it' : `threw ${got.refused}`}`)
      else if (drawn && got.refused !== undefined) bad.push(`${tag}: vega draws it, aster refused: ${got.refused}`)
      else if (drawn) {
        pictures++
        const d = diffCanonical(canonicalizeSvg(picture), canonicalizeSvg(got.svg!))
        if (d.length) bad.push(`${tag}: ${d.slice(0, 3).join(' | ')}`)
      }
    }
    expect(bad, `${bad.length} of ${scaled(240)} guides differ:\n${bad.slice(0, 8).join('\n')}`).toEqual([])
    // (not vacuous: some of the guides are ones vega cannot draw, and most are ones it can, whose pictures are compared)
    expect(unrenderable).toBeGreaterThan(scaled(240) * 0.03)
    expect(pictures).toBeGreaterThan(scaled(240) * 0.5)
  })
})

/** A title of the view one of whose properties reads the late signal. */
function titleOf(r: ReturnType<typeof makeRng>, read: Spec): Spec {
  const prop = r.pick(TITLE_PROPS)
  return prop === 'text' ? { text: read } : { text: 'view', [prop]: read }
}
const TITLE_PROPS = ['text', 'text', 'fontSize', 'color', 'offset', 'dx', 'subtitle', 'anchor'] as const
