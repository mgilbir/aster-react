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
 * Two relations, no allow-list of tolerated differences:
 *   <SvgChart interaction={interaction}>  ===  <Chart renderer="svg">          (everything, including the `data-datum` stamps)
 *   <SvgChart>                            ===  <Chart renderer="svg"> minus its `data-datum` attributes
 * The only thing `interaction` adds to the markup is the `data-datum` stamp that `signal.on` mark events read, and only for
 * specs that have event streams; without the capability nothing can read them, so they are not emitted.
 *
 * The scenes are the same too: the handle's `getScene()` must agree between the variants (same marks, same stamps).
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

/** The `data-datum` stamps are the only thing the interaction capability adds to the markup. */
export const withoutStamps = (html: string): string => html.replace(/ data-datum="[^"]*"/g, '')

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
    expect(specs.length).toBeGreaterThanOrEqual(785)
  })

  // Each pass is cut into slices of the corpus, one test each: one long synchronous test keeps a vitest worker from answering
  // its host (Timeout calling onTaskUpdate), and a slice names where a difference is.
  const slices = Array.from({ length: Math.ceil(corpusFiles().length / SLICE) }, (_, i) => [i * SLICE, (i + 1) * SLICE] as const)
  let streams = 0
  let stamped = 0
  for (const [from, to] of slices) it(`server markup, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = renderToString(element('chart', spec))
      const plain = renderToString(element('plain', spec))
      const rich = renderToString(element('rich', spec))
      const dRich = firstDifference(chart, rich)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(withoutStamps(chart), plain)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart minus stamps ${dPlain}`)
      if (chart !== plain) streams++
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('server markup is not vacuous: the stamps exist for event-stream specs (otherwise `withoutStamps` is untested)', () => {
    expect(streams).toBeGreaterThan(0)
  })

  for (const [from, to] of slices) it(`client mount, markup and scene, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = clientMount('chart', spec)
      const plain = clientMount('plain', spec)
      const rich = clientMount('rich', spec)
      const dRich = firstDifference(chart.html, rich.html)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(withoutStamps(chart.html), plain.html)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart minus stamps ${dPlain}`)
      // the same scene, with the same stamped items
      if (stampedItems(chart.scene) !== stampedItems(rich.scene)) failures.push(`${name}: stamped scene items differ between Chart and SvgChart+interaction`)
      stamped += stampedItems(chart.scene)
      if (stampedItems(plain.scene) !== 0) failures.push(`${name}: SvgChart (no interaction) stamped scene items`)
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('client mount is not vacuous: event-stream specs have stamped items', () => {
    expect(stamped, 'event-stream specs must have stamped items, or the stamp comparison is vacuous').toBeGreaterThan(0)
  })

  for (const [from, to] of slices) it(`hydration of the server markup, specs ${from}-${to}`, () => {
    const failures: string[] = []
    for (const { name, spec } of specs.slice(from, to)) {
      const chart = hydrate('chart', spec)
      const plain = hydrate('plain', spec)
      const rich = hydrate('rich', spec)
      const dRich = firstDifference(chart.html, rich.html)
      if (dRich) failures.push(`${name}: SvgChart+interaction vs Chart ${dRich}`)
      const dPlain = firstDifference(withoutStamps(chart.html), plain.html)
      if (dPlain) failures.push(`${name}: SvgChart vs Chart minus stamps ${dPlain}`)
      for (const [label, h] of [['Chart', chart], ['SvgChart', plain], ['SvgChart+interaction', rich]] as const) {
        if (h.recoverable.length) failures.push(`${name}: ${label} hydration mismatch: ${h.recoverable[0]}`)
      }
    }
    expect(failures.slice(0, 20).join('\n'), `${failures.length} difference(s)`).toBe('')
  }, 600_000)

  it('the comparison bites: a one-attribute difference is reported', () => {
    expect(firstDifference('<svg a="1"/>', '<svg a="2"/>')).toMatch(/^at 8 /)
    expect(firstDifference('<svg a="1"/>', '<svg a="1"/>')).toBeNull()
    expect(withoutStamps('<path data-datum="{&quot;x&quot;:1}" d="M0"/>')).toBe('<path d="M0"/>')
  })
})
