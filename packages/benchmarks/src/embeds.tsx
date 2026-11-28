/**
 * The three embedding approaches under benchmark, behind one React interface.
 *
 * - aster:      @aster-charts/react <Chart incremental={false}> (our library, string mode: every update re-serializes the svg and
 *               sets it as markup)
 * - asterDom:   @aster-charts/react <Chart incremental> (our library, the default: the live svg is patched in place)
 * - reactVega:  <VegaEmbed> from react-vega v8 (community-standard React wrapper;
 *               re-embeds whenever the spec deep-changes)
 * - embedHook:  vega-embed inside useEffect following the official tutorials, incl.
 *               the documented incremental paths: view.change(...) for data updates
 *               and view.width()/height() for resize (Vega's best case)
 *
 * `responsive` selects how width is decided: fixed prop width for every embed,
 * or container-driven (aster's built-in ResizeObserver vs the documented
 * ResizeObserver + view API glue for the Vega paths).
 */
import * as React from 'react'
import { Chart as AsterChart } from '@aster-charts/react'
import { VegaEmbed } from 'react-vega'
import embed from 'vega-embed'
import { changeset } from 'vega'
import type { Result } from 'vega-embed'
import { firstDataset } from './fixtures.js'

export type EmbedName = 'aster' | 'asterDom' | 'reactVega' | 'embedHook'

export const EMBEDS: EmbedName[] = ['aster', 'asterDom', 'reactVega', 'embedHook']

export interface EmbedProps {
  spec: Record<string, unknown>
  width: number
  height: number
  responsive?: boolean
  /** Per-datum differential update (aster only): data override + changed indices. */
  data?: Record<string, unknown[]>
  dataChanges?: Record<string, number[]>
}

const options: Record<string, unknown> = {
  renderer: 'svg',
  actions: false,
}

function useContainerWidth(
  ref: React.RefObject<HTMLElement | null>,
  onWidth: (w: number) => void,
  enabled: boolean,
): void {
  React.useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) onWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, onWidth, enabled])
}

/**
 * The `incremental` prop each aster embed passes, always explicit: `<Chart>` defaults to true, so leaving `aster` to the default
 * made the two rows the same configuration (C304). benchmarks/src/embeds.test.tsx renders both and reads the prop.
 */
export const ASTER_INCREMENTAL: Readonly<Record<'aster' | 'asterDom', boolean>> = { aster: false, asterDom: true }

function AsterEmbed({ spec, width, height, responsive, incremental, data, dataChanges }: EmbedProps & { incremental: boolean }) {
  // (responsive: the width of the element, as the other embeds take it from their container; the height is the spec's)
  if (responsive) return <AsterChart spec={spec} data={data} dataChanges={dataChanges} width="container" incremental={incremental} />
  return <AsterChart spec={spec} data={data} dataChanges={dataChanges} width={width} height={height} incremental={incremental} />
}

function ReactVegaEmbed({ spec, width, height, responsive }: EmbedProps) {
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const resultRef = React.useRef<Result | null>(null)
  const sized = React.useMemo(
    () => ({ ...spec, width, height }),
    [spec, width, height],
  )
  const applyWidth = React.useCallback((w: number) => {
    const view = resultRef.current?.view
    if (view && Math.abs(view.width() - w) > 0.5) {
      view.width(w).runAsync()
    }
  }, [])
  useContainerWidth(wrapperRef, applyWidth, responsive === true)
  return (
    <div ref={wrapperRef} style={{ width: '100%' }}>
      <VegaEmbed
        spec={sized as never}
        options={options as never}
        onEmbed={(r: Result) => {
          resultRef.current = r
          const w = wrapperRef.current?.clientWidth
          if (responsive && w) r.view.width(w).runAsync()
        }}
      />
    </div>
  )
}

function EmbedHookEmbed({ spec, width, height, responsive }: EmbedProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const resultRef = React.useRef<Result | null>(null)
  const prevDataRef = React.useRef(firstDataset(spec).values)
  const prevSizeRef = React.useRef({ width, height })

  // Mount once: create the view from the current spec.
  React.useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let cancelled = false
    void embed(el, spec as never, options as never).then((result) => {
      if (cancelled) {
        void result.finalize()
        return
      }
      resultRef.current = result
      if (responsive) {
        const w = el.clientWidth
        if (w) result.view.width(w).runAsync()
      }
    })
    return () => {
      cancelled = true
      void resultRef.current?.finalize()
      resultRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Container-driven resize: the documented ResizeObserver + view API recipe.
  const applyWidth = React.useCallback((w: number) => {
    const view = resultRef.current?.view
    if (view && Math.abs(view.width() - w) > 0.5) {
      view.width(w).runAsync()
    }
  }, [])
  useContainerWidth(hostRef, applyWidth, responsive === true)

  // Subsequent changes use the official incremental update paths.
  React.useEffect(() => {
    const result = resultRef.current
    if (!result) return
    const { name, values } = firstDataset(spec)
    let dirty = false
    if (values !== prevDataRef.current) {
      result.view.change(name, changeset().remove(() => true).insert(values as never))
      prevDataRef.current = values
      dirty = true
    }
    if (width !== prevSizeRef.current.width || height !== prevSizeRef.current.height) {
      result.view.width(width).height(height)
      prevSizeRef.current = { width, height }
      dirty = true
    }
    if (dirty) void result.view.runAsync()
  }, [spec, width, height])

  return <div ref={hostRef} style={{ display: 'inline-block', width: responsive ? '100%' : undefined }} />
}

export function BenchEmbed({ name, ...props }: EmbedProps & { name: EmbedName }) {
  switch (name) {
    case 'aster':
      return <AsterEmbed {...props} incremental={ASTER_INCREMENTAL.aster} />
    case 'asterDom':
      return <AsterEmbed {...props} incremental={ASTER_INCREMENTAL.asterDom} />
    case 'reactVega':
      return <ReactVegaEmbed {...props} />
    case 'embedHook':
      return <EmbedHookEmbed {...props} />
  }
}
