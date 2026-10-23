/**
 * The shared variant matrix for the React component tests.
 *
 * `<Chart>` and `<SvgChart>` are shells over one implementation (ChartCore), so the same tests run on every
 * variant instead of the light one getting a thinner copy that drifts:
 *
 *   forEachVariant(['svg'], (Chart, variant) => {
 *     describe('...', () => { it('...', () => { render(<Chart spec={spec} />) }) })
 *     variant.it(['interaction'], 'a test that needs hit testing', () => { ... })
 *   })
 *
 * The callback receives the variant's component under the name `Chart`, so test bodies are written once.
 * Capabilities a group (or a single `variant.it`) declares:
 *   svg          every variant
 *   canvas       <Chart> only
 *   interaction  hit testing + signal event loop: <Chart> and <SvgChart interaction={interaction}>
 *   signals      the `signal.on` event loop (ships with interaction)
 * A variant that LACKS a declared capability does not skip: it asserts the documented failure mode
 * (FAILURE_MODES below) in place of the test, so a variant that quietly started to work, or to fail
 * differently, turns the suite red.
 *
 * `Chart.matrix.test.tsx` fails if a component test renders <Chart> outside this matrix without an
 * entry (and a reason) in `DIRECT_CHART_TESTS`.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { Chart } from '../Chart.js'
import { SvgChart } from '../SvgChart.js'
import { interaction } from '../interaction-capability.js'
import type { ChartHandle, ChartProps } from '../chart-types.js'
import { SVG_CHART_INTERACTION_PROPS } from '../svg-chart-types.js'

export type Capability = 'svg' | 'canvas' | 'interaction' | 'signals'
export type VariantName = 'Chart' | 'SvgChart' | 'SvgChart+interaction'
/** What every variant is exercised as: `<Chart>`'s public props and handle. */
export type ChartComponent = React.ForwardRefExoticComponent<ChartProps & React.RefAttributes<ChartHandle>>

export interface Variant {
  readonly name: VariantName
  readonly caps: ReadonlySet<Capability>
  has(needs: readonly Capability[]): boolean
  /** The raw component with this variant's capabilities, for props the matrix wrapper refuses (the failure probes). */
  element(props: Record<string, unknown>): React.ReactElement
  /** A test with its own capability needs; lacking them, the documented failure mode is asserted instead. */
  it(needs: readonly Capability[], name: string, fn: () => void | Promise<void>, timeout?: number): void
}

// `<SvgChart>` takes a union of prop shapes (interaction props only with `interaction`). The matrix drives it
// with `<Chart>`'s prop type: tests declare what they need, and the type-level contract is enforced separately by
// `Chart.types.test.ts` against fixtures. This is the one place that erases it.
const PlainSvgChart = SvgChart as unknown as ChartComponent

const SvgChartWithInteraction: ChartComponent = React.forwardRef<ChartHandle, ChartProps>(function SvgChartWithInteraction(props, ref) {
  const { renderer, ...rest } = props
  if (renderer === 'canvas') throw new Error('the SvgChart+interaction variant has no canvas: declare the `canvas` capability')
  return <SvgChart {...rest} interaction={interaction} ref={ref} />
})

// The plain variant refuses what only the interaction variant has, so a test that uses it must declare
// `interaction`/`signals` instead of passing vacuously on a variant that ignores the prop.
const PlainSvgChartChecked: ChartComponent = React.forwardRef<ChartHandle, ChartProps>(function PlainSvgChartChecked(props, ref) {
  if (props.renderer === 'canvas') throw new Error('the SvgChart variant has no canvas: declare the `canvas` capability')
  const used = SVG_CHART_INTERACTION_PROPS.filter((k) => props[k] !== undefined)
  if (used.length) throw new Error(`the SvgChart variant has no interaction: declare the \`interaction\` capability (uses ${used.join(', ')})`)
  const onError = (error: Error): void => {
    // The runtime report for an event-stream spec without `interaction`: the test needs the `signals` capability.
    if (error.message.includes("'@aster/react/interaction'")) throw new Error(`the SvgChart variant has no event loop: declare the \`signals\` capability (${error.message})`)
    props.onError?.(error)
  }
  return <PlainSvgChart {...props} onError={onError} ref={ref} />
})

function makeVariant(
  name: VariantName, caps: Capability[], element: (props: Record<string, unknown>) => React.ReactElement,
): Variant {
  const set = new Set<Capability>(caps)
  const v: Variant = {
    name,
    caps: set,
    has: (needs) => needs.every((c) => set.has(c)),
    element,
    it(needs, title, fn, timeout) {
      const missing = needs.filter((c) => !set.has(c))
      if (missing.length === 0) {
        it(title, fn, timeout)
        return
      }
      it(`${title} [${name} lacks ${missing.join('+')}: asserts the documented failure]`, () => assertFailureMode(v, missing))
    },
  }
  return v
}

interface VariantSpec { variant: Variant; component: ChartComponent }

export const VARIANTS: readonly VariantSpec[] = [
  { component: Chart, variant: makeVariant('Chart', ['svg', 'canvas', 'interaction', 'signals'], (p) => React.createElement(Chart, p as never)) },
  { component: PlainSvgChartChecked, variant: makeVariant('SvgChart', ['svg'], (p) => React.createElement(SvgChart as never, p)) },
  {
    component: SvgChartWithInteraction,
    variant: makeVariant('SvgChart+interaction', ['svg', 'interaction', 'signals'], (p) => React.createElement(SvgChart as never, { ...p, interaction })),
  },
]

/** Run `body` once per variant that has every capability in `needs`; the others assert their failure mode. */
export function forEachVariant(needs: readonly Capability[], body: (Chart: ChartComponent, variant: Variant) => void): void {
  for (const { variant, component } of VARIANTS) {
    if (variant.has(needs)) {
      describe(variant.name, () => body(component, variant))
    } else {
      const missing = needs.filter((c) => !variant.caps.has(c))
      describe(`${variant.name} (lacks ${missing.join('+')})`, () => {
        it(`asserts the documented failure for ${missing.join('+')} instead of running`, () => assertFailureMode(variant, missing))
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Documented failure modes
// ---------------------------------------------------------------------------

const tinySpec = {
  width: 40, height: 30, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ x: 1 }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'steelblue' } } } }],
}

const eventStreamSpec = {
  ...tinySpec,
  signals: [{ name: 'n', value: 1, on: [{ events: 'click', update: 'n + 1' }] }],
}

interface Mounted { container: HTMLElement; errors: Error[]; unmount(): void }

function mount(variant: Variant, props: Record<string, unknown>): Mounted {
  if (typeof document === 'undefined') throw new Error('the variant matrix needs a DOM: add `// @vitest-environment jsdom` to this test file')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const errors: Error[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const withOnError = 'onError' in props ? props : { ...props, onError: (e: Error) => { errors.push(e) } }
  act(() => { root.render(variant.element(withOnError)) })
  return { container, errors, unmount: () => { act(() => root.unmount()); container.remove() } }
}

type FailureMode = (variant: Variant) => void

/** What a variant does when asked for a capability it does not have (documented in API.md / INTERACTION.md). */
export const FAILURE_MODES: Record<Capability, FailureMode> = {
  svg: () => { throw new Error('every variant has the svg capability') },
  canvas: (variant) => {
    // `<SvgChart renderer="canvas">` is a compile error; for JS callers the chart renders as SVG and reports it.
    const m = mount(variant, { spec: tinySpec, width: 40, height: 30, renderer: 'canvas' })
    try {
      expect(m.container.querySelector('canvas')).toBeNull()
      expect(m.container.querySelector('svg')).not.toBeNull()
      expect(m.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^\[aster\] renderer="canvas" needs the canvas renderer.*<Chart renderer="canvas">/)])
    } finally { m.unmount() }
  },
  interaction: (variant) => {
    // Interaction props are compile errors without `interaction`; for JS callers they are ignored and reported once.
    const m = mount(variant, { spec: tinySpec, width: 40, height: 30, tooltip: true, onPointSelect: () => {} })
    try {
      expect(m.errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/^\[aster\] tooltip, onPointSelect \(props that need hit testing and the signal event loop\) are ignored.*interaction=\{interaction\} from '@aster\/react\/interaction'/),
      ])
      const rect = m.container.querySelector('svg path')!
      rect.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }))
      expect(m.container.querySelector('[data-testid="chart-tooltip"]')).toBeNull()
      expect(m.container.querySelector('[data-datum]')).toBeNull()
    } finally { m.unmount() }
    // Without `onError` the same report goes to the logger.
    const warned: string[] = []
    const m2 = mount(variant, { spec: tinySpec, width: 40, height: 30, tooltip: true, onError: undefined, logger: { error: () => {}, warn: (...a: unknown[]) => { warned.push(String(a[0])) } } })
    try { expect(warned).toEqual([expect.stringMatching(/^\[aster\] tooltip \(props that need hit testing/)]) } finally { m2.unmount() }
  },
  signals: (variant) => {
    // A spec with `signal.on` streams still renders, but is reported: never a silently dead chart.
    const m = mount(variant, { spec: eventStreamSpec, width: 40, height: 30 })
    try {
      expect(m.container.querySelector('svg')).not.toBeNull()
      expect(m.errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/^\[aster\] this spec has event streams \(signal\.on\) but no event loop is bound.*pass `interaction` from '@aster\/react\/interaction'/),
      ])
    } finally { m.unmount() }
  },
}

function assertFailureMode(variant: Variant, missing: readonly Capability[]): void {
  for (const cap of missing) FAILURE_MODES[cap](variant)
}
