// @vitest-environment jsdom
/**
 * Anti-drift guard 3: OUTPUT parity over the whole conformance corpus (every spec of packages/conformance/corpus).
 *
 * `<SvgChart>` and `<Chart renderer="svg">` are shells over one implementation; this proves the DOM they produce is the same,
 * byte for byte, attribute for attribute, for every corpus spec, in all three ways a host gets it:
 *   - server markup (`renderToString`),
 *   - a client mount (`createRoot`),
 *   - hydration of the server markup (`hydrateRoot`), with no recoverable hydration error.
 * The a11y overlay and the bound-input controls are part of that DOM, so the accessible tree is compared too.
 *
 * One relation, no allow-list of tolerated differences:
 *   <SvgChart interaction={interaction}>  ===  <SvgChart>  ===  <Chart renderer="svg">
 * The `interaction` capability adds nothing to the markup, even for a spec with `signal.on` event streams: the mark under the
 * pointer is found through the scene hit index, so the DOM is the markup vega writes (no per-item `data-datum` attribute;
 * the oracle gates compare the mounted DOM with vega's, exactly). Nothing in the compared DOM may carry the attribute.
 *
 * The scenes are the same too: the handle's `getScene()` must agree between the variants (same marks, none stamped).
 */
import * as React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect, beforeAll } from 'vitest'
import type { VgSpec } from '@aster/core'
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

/** A short description of the first difference between two strings, or null when equal. */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60))
  return `at ${i} (lengths ${a.length} vs ${b.length}): ${ctx(a)} vs ${ctx(b)}`
}

function clientMount(v: VariantName, spec: VgSpec): { html: string; scene: ChartHandle['getScene'] extends () => infer S ? S : never } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ref = React.createRef<ChartHandle>()
  act(() => { root.render(element(v, spec, ref)) })
  const html = container.innerHTML
  const scene = ref.current?.getScene() ?? null
  act(() => root.unmount())
  container.remove()
  return { html, scene }
}

function hydrate(v: VariantName, spec: VgSpec): { html: string; recoverable: string[] } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  container.innerHTML = renderToString(element(v, spec))
  const recoverable: string[] = []
  let root: ReturnType<typeof hydrateRoot> | undefined
  act(() => { root = hydrateRoot(container, element(v, spec), { onRecoverableError: (e) => { recoverable.push(String((e as Error).message).slice(0, 160)) } }) })
  const html = container.innerHTML
  act(() => root!.unmount())
  container.remove()
  return { html, recoverable }
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

  it('covers the whole corpus', () => {
    expect(specs.length).toBeGreaterThanOrEqual(794)
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
      const dRich = firstDifference(chart.html, rich.html)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(chart.html, plain.html)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart ${dPlain}`)
      if (chart.html.includes('data-datum')) failures.push(`${name}: the hydrated DOM carries a data-datum attribute`)
      for (const [label, h] of [['Chart', chart], ['SvgChart', plain], ['SvgChart+interaction', rich]] as const) {
        if (h.recoverable.length) failures.push(`${name}: ${label} hydration mismatch: ${h.recoverable[0]}`)
      }
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('the comparison bites: a one-attribute difference is reported', () => {
    expect(firstDifference('<svg a="1"/>', '<svg a="2"/>')).toMatch(/^at 8 /)
    expect(firstDifference('<svg a="1"/>', '<svg a="1"/>')).toBeNull()
  })
})
