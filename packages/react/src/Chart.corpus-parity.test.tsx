// @vitest-environment jsdom
/**
 * Anti-drift guard 3: OUTPUT parity over the whole conformance corpus (every spec of packages/conformance/corpus).
 *
 * `<SvgChart>` and `<Chart renderer="svg">` are shells over one implementation; this proves the DOM they produce is the same,
 * byte for byte, attribute for attribute, for every corpus spec, in all three ways a host gets it:
 *   - server markup (`renderToString`),
 *   - a client mount (`createRoot`),
 *   - hydration of the server markup (`hydrateRoot`), with no recoverable hydration error and no `console.error` (React reports
 *     an innerHTML difference only there, never through `onRecoverableError`), and the hydrated DOM equal to the client mount's.
 * The a11y overlay and the bound-input controls are part of that DOM, so the accessible tree is compared too.
 *
 * One relation, no allow-list of tolerated differences:
 *   <SvgChart interaction={interaction}>  ===  <SvgChart>  ===  <Chart renderer="svg">
 * The `interaction` capability adds nothing to the markup, even for a spec with `signal.on` event streams: the mark under the
 * pointer is found through the scene hit index, so the DOM is the markup vega writes (no per-item `data-datum` attribute;
 * the oracle gates compare the mounted DOM with vega's, exactly). Nothing in the compared DOM may carry the attribute.
 *
 * Every one of those is a drawn chart: an `<svg>` with a drawn element, never the error state (`role="alert"`), which all three
 * shells share and which would otherwise count as parity.
 *
 * The scenes are the same too: the handle's `getScene()` must agree between the variants (same marks, none stamped).
 */
import * as React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { Chart } from './Chart'
import { SvgChart } from './SvgChart'
import { interaction } from './interaction-capability'
import type { ChartHandle } from './chart-types'
import { corpusFiles, loadCorpusSpec, type CorpusSpec } from './testing/corpus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type VariantName = 'chart' | 'plain' | 'rich'
const element = (v: VariantName, spec: VgSpec, ref?: React.Ref<ChartHandle>): React.ReactElement =>
  v === 'chart' ? <Chart spec={spec} renderer="svg" ref={ref} />
    : v === 'plain' ? <SvgChart spec={spec} ref={ref} />
      : <SvgChart spec={spec} interaction={interaction} ref={ref} />

/**
 * A radio group's name is the chart's React `useId` followed by the signal (C156): `name="_r_<n>_<signal>"` (`_R_` under `hydrateRoot`), where `<n>`
 * depends on the root the chart was mounted in, so two separate mounts differ there and nowhere else. Only that
 * `_r_<n>_` part of a `name` attribute is set aside; the signal after it, and every other attribute, is compared as it is.
 */
export function withoutRootIds(html: string): string {
  return html.replace(/ name="_[rR]_[0-9a-z]+_/g, ' name="<useId>')
}

/**
 * The markup with every `style` attribute written the way the CSSOM writes it. Hydration keeps the server's attribute text
 * (`cursor:default;position:relative`) where a client mount sets the property (`cursor: default; position: relative;`): the same
 * style, spelled twice. Everything else is untouched, so any other difference is still one.
 */
export function withCssomStyles(html: string): string {
  const t = document.createElement('template')
  t.innerHTML = html
  for (const el of t.content.querySelectorAll<HTMLElement>('[style]')) el.setAttribute('style', el.style.cssText)
  return t.innerHTML
}

/** A short description of the first difference between two strings, or null when equal. */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60))
  return `at ${i} (lengths ${a.length} vs ${b.length}): ${ctx(a)} vs ${ctx(b)}`
}

function clientMount(v: VariantName, spec: VgSpec, props: Record<string, unknown> = {}): { html: string; scene: ChartHandle['getScene'] extends () => infer S ? S : never } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ref = React.createRef<ChartHandle>()
  act(() => { root.render(React.cloneElement(element(v, spec, ref), props)) })
  const html = withoutRootIds(container.innerHTML)
  const scene = ref.current?.getScene() ?? null
  act(() => root.unmount())
  container.remove()
  return { html, scene }
}

/** Hydrate `serverSpec`'s server markup with `spec`'s client render (the same spec unless a test makes them differ). */
function hydrate(v: VariantName, spec: VgSpec, serverSpec: VgSpec = spec, props: Record<string, unknown> = {}): { html: string; recoverable: string[]; logged: string[] } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const withProps = (el: React.ReactElement): React.ReactElement => React.cloneElement(el, props)
  container.innerHTML = renderToString(withProps(element(v, serverSpec)))
  const recoverable: string[] = []
  const logged: string[] = []
  // (React reports markup that differs from the server's, inside `dangerouslySetInnerHTML`, with `console.error` only)
  // (React's own reports are formatted strings; the chart's logger reports a failing spec's error, which is not a hydration error)
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && !args[0].startsWith('[aster]')) logged.push(args[0].slice(0, 160))
  })
  let root: ReturnType<typeof hydrateRoot> | undefined
  try {
    act(() => { root = hydrateRoot(container, withProps(element(v, spec)), { onRecoverableError: (e) => { recoverable.push(String((e as Error).message).slice(0, 160)) } }) })
  } finally { spy.mockRestore() }
  const html = withoutRootIds(container.innerHTML)
  act(() => root!.unmount())
  container.remove()
  return { html, recoverable, logged }
}

/** What is wrong with markup that should be a drawn chart: the error state, no `<svg>`, or an `<svg>` with nothing drawn in it. */
export function notADrawnChart(html: string): string | null {
  if (/role="alert"/.test(html)) return 'the error state (role="alert")'
  const svg = html.indexOf('<svg')
  if (svg < 0) return 'no <svg>'
  if (!/<(?:path|rect|circle|line|text|image|use|g class="mark-)/.test(html.slice(svg))) return 'an <svg> with nothing drawn in it'
  return null
}

const stampedItems = (scene: unknown): number => {
  let n = 0
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return
    const o = node as { items?: unknown[]; dataDatum?: unknown }
    if (typeof o.dataDatum === 'string') n++
    for (const c of o.items ?? []) walk(c)
  }
  walk(scene)
  return n
}

const SLICE = 40

describe('<SvgChart> renders what <Chart renderer="svg"> renders, over the whole corpus', () => {
  let specs: CorpusSpec[] = []
  beforeAll(async () => { specs = await Promise.all(corpusFiles().map(loadCorpusSpec)) }, 120_000)

  // (the floor is the corpus gate's own: packages/conformance/src/run.ts FLOORS.corpus; a file that failed to load is a failure here)
  it('covers the whole corpus', () => {
    expect(specs.length).toBe(corpusFiles().length)
    expect(specs.length).toBeGreaterThanOrEqual(1129)
  })

  // Each pass is cut into slices of the corpus, one test each: one long synchronous test keeps a vitest worker from answering
  // its host (Timeout calling onTaskUpdate), and a slice names where a difference is.
  const slices = Array.from({ length: Math.ceil(corpusFiles().length / SLICE) }, (_, i) => [i * SLICE, (i + 1) * SLICE] as const)
  for (const [from, to] of slices) it(`server markup, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = renderToString(element('chart', spec))
      const plain = renderToString(element('plain', spec))
      const rich = renderToString(element('rich', spec))
      const dRich = firstDifference(chart, rich)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(chart, plain)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart ${dPlain}`)
      if (chart.includes('data-datum')) failures.push(`${name}: the server markup carries a data-datum attribute`)
      const bad = notADrawnChart(chart)
      if (bad) failures.push(`${name}: the server markup is ${bad}`)
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('is not vacuous: the corpus has specs with event streams, the ones that used to be stamped', () => {
    const withEvents = specs.filter(({ spec }) => (spec.signals as Array<{ on?: unknown[] }> | undefined)?.some((s) => s.on?.length))
    expect(withEvents.length).toBeGreaterThan(20)
  })

  for (const [from, to] of slices) it(`client mount, markup and scene, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = clientMount('chart', spec)
      const plain = clientMount('plain', spec)
      const rich = clientMount('rich', spec)
      const dRich = firstDifference(chart.html, rich.html)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(chart.html, plain.html)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart ${dPlain}`)
      if (chart.html.includes('data-datum')) failures.push(`${name}: the mounted DOM carries a data-datum attribute`)
      for (const [label, v] of [['Chart', chart], ['SvgChart', plain], ['SvgChart+interaction', rich]] as const) {
        const bad = notADrawnChart(v.html)
        if (bad) failures.push(`${name}: the ${label} client mount is ${bad}`)
      }
      // the scenes are never stamped either
      for (const [label, v] of [['Chart', chart], ['SvgChart', plain], ['SvgChart+interaction', rich]] as const) {
        if (stampedItems(v.scene) !== 0) failures.push(`${name}: ${label} stamped scene items`)
      }
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  for (const [from, to] of slices) it(`hydration of the server markup, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = hydrate('chart', spec)
      const plain = hydrate('plain', spec)
      const rich = hydrate('rich', spec)
      const mounted = clientMount('chart', spec).html
      const dRich = firstDifference(chart.html, rich.html)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(chart.html, plain.html)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart ${dPlain}`)
      if (chart.html.includes('data-datum')) failures.push(`${name}: the hydrated DOM carries a data-datum attribute`)
      for (const [label, h] of [['Chart', chart], ['SvgChart', plain], ['SvgChart+interaction', rich]] as const) {
        if (h.recoverable.length) failures.push(`${name}: ${label} hydration mismatch: ${h.recoverable[0]}`)
        if (h.logged.length) failures.push(`${name}: ${label} hydration logged an error: ${h.logged[0]}`)
        // what hydration leaves is the chart a client mount draws (React keeps the server's innerHTML where it differs: C45)
        const dMount = firstDifference(withCssomStyles(h.html), withCssomStyles(mounted))
        if (dMount) failures.push(`${name}: ${label} hydrated DOM differs from a client mount ${dMount}`)
        const bad = notADrawnChart(h.html)
        if (bad) failures.push(`${name}: the ${label} hydrated DOM is ${bad}`)
      }
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('setting the root part of a radio group name aside hides nothing else', () => {
    const radio = (id: string, signal: string, extra = ''): string => `<input type="radio" value="x" name="${id}${signal}"${extra}>`
    // the root part alone: equal
    expect(firstDifference(withoutRootIds(radio('_r_1j_', 'pick_c')), withoutRootIds(radio('_r_1l_', 'pick_c')))).toBeNull()
    expect(firstDifference(withoutRootIds(radio('_R_0_', 'pick_c')), withoutRootIds(radio('_r_1l_', 'pick_c')))).toBeNull()
    // the signal part of the name differs: reported
    expect(firstDifference(withoutRootIds(radio('_r_1j_', 'pick_c')), withoutRootIds(radio('_r_1j_', 'pick_d')))).not.toBeNull()
    // an id-like value in another attribute (an id, a clip-path reference) is not touched
    expect(firstDifference(withoutRootIds(radio('_r_1j_', 'a', ' id="_r_1j_"')), withoutRootIds(radio('_r_1j_', 'a', ' id="_r_2k_"')))).not.toBeNull()
    expect(firstDifference(withoutRootIds('<g clip-path="url(#_r_1_clip)"/>'), withoutRootIds('<g clip-path="url(#_r_2_clip)"/>'))).not.toBeNull()
    // a name that is not a useId is compared as it is
    expect(firstDifference(withoutRootIds('<input name="mode">'), withoutRootIds('<input name="mode2">'))).not.toBeNull()
  })

  // The corpus pass above hydrates a spec's own server markup, which equals the client's, so it cannot see hydration keep a
  // picture the client would not draw. This is the channel's own check: a server that drew other positions (and, with `a11y`, other
  // labels) than the client does. It fails on a hydration that leaves the server's picture, and on any `console.error` React makes.
  describe('hydration of server markup the client would draw differently is the client\'s picture', () => {
    const at = (xs: number[]): VgSpec => ({
      width: 200, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: xs.map((x, i) => ({ x, y: i })) }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      axes: [{ scale: 'x', orient: 'bottom' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 } } } }],
    } as unknown as VgSpec)
    for (const a11y of [false, true]) for (const v of ['chart', 'plain', 'rich'] as const) {
      it(`${v}, a11y ${a11y}`, () => {
        const server = at([1, 2, 3]); const client = at([9, 8, 7])
        expect(clientMount(v, client, { a11y }).html, 'the two pictures must differ for this to test anything').not.toBe(clientMount(v, server, { a11y }).html)
        const h = hydrate(v, client, server, { a11y })
        // The chart's own markup is the chart's to correct and says nothing (its host suppresses React's report), and neither does
        // the accessible overlay, whose elements the chart makes anew from the client's scene once hydration is over: React makes no
        // `console.error` with `a11y` on or off, and the picture left behind is the client's either way.
        expect(h.logged).toEqual([])
        expect(withCssomStyles(h.html)).toBe(withCssomStyles(clientMount(v, client, { a11y }).html))
      })
    }
  })

  it('the style normalisation hides only the spelling of a style', () => {
    expect(firstDifference(withCssomStyles('<div style="cursor:default;width:100%"></div>'), withCssomStyles('<div style="cursor: default; width: 100%;"></div>'))).toBeNull()
    expect(firstDifference(withCssomStyles('<div style="cursor:default;width:100%"></div>'), withCssomStyles('<div style="cursor: default; width: 90%;"></div>'))).not.toBeNull()
    expect(firstDifference(withCssomStyles('<div style="width:1px" id="a"></div>'), withCssomStyles('<div style="width:1px" id="b"></div>'))).not.toBeNull()
  })

  it('the drawn-chart check bites: the error state, no svg and an empty svg are reported, a drawn chart is not', () => {
    expect(notADrawnChart('<div role="alert">[aster] boom</div>')).toMatch(/error state/)
    expect(notADrawnChart('<div>loading</div>')).toBe('no <svg>')
    expect(notADrawnChart('<div><svg width="1"></svg></div>')).toMatch(/nothing drawn/)
    expect(notADrawnChart('<div><svg><g class="mark-rect role-mark"><path d="M0,0"></path></g></svg></div>')).toBeNull()
  })

  it('the comparison bites: a one-attribute difference is reported', () => {
    expect(firstDifference('<svg a="1"/>', '<svg a="2"/>')).toMatch(/^at 8 /)
    expect(firstDifference('<svg a="1"/>', '<svg a="1"/>')).toBeNull()
  })
})
