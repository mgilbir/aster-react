import * as React from 'react'
import embed from 'vega-embed'

/**
 * The oracle column: the official vega-embed renderer. This module is
 * lazy-loaded (React.lazy) so the aster column paints before any vega code is
 * even downloaded — the load delay you see on the left panes is the official
 * toolchain arriving, not aster.
 *
 * The same spec object the aster column receives (after @aster/vl compilation
 * for Vega-Lite inputs) is handed to vega-embed verbatim.
 *
 * Specs with signal-based width/height (e.g. `{ signal: 'width' }`) render at
 * vega's 10x10 minimum viewport unless driven by the container — so for those,
 * this pane implements the documented vega recipe: a ResizeObserver feeds the
 * container size into view.width()/height().
 */
export function VegaPane({ spec, width, height, responsiveHeight, ariaLabel }: {
  spec: Record<string, unknown>
  width?: number
  height?: number
  /** Container height for container-driven (signal-sized) specs. */
  responsiveHeight?: number
  ariaLabel?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const responsive = width == null || height == null
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    let finalized: { finalize(): void } | null = null
    let observer: ResizeObserver | null = null
    setError(null)
    const sized = !responsive ? { ...spec, width, height } : spec
    embed(el, sized as never, { actions: false, renderer: 'svg' })
      .then((result) => {
        if (cancelled) {
          result.finalize()
          return
        }
        finalized = result
        if (!responsive) return
        // Container-driven sizing (the documented ResizeObserver + view API glue).
        const view = result.view
        const apply = (): void => {
          // el.clientWidth already excludes the container padding — the aster
          // side's ResizeObserver sees the same content box, so no adjustment.
          const w = el.clientWidth
          const h = responsiveHeight ?? el.clientHeight
          if (w > 0 && h > 0 && (Math.abs(view.width() - w) > 0.5 || Math.abs(view.height() - h) > 0.5)) {
            view.width(w).height(h).runAsync()
          }
        }
        apply()
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => apply())
          observer.observe(el)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      observer?.disconnect()
      finalized?.finalize()
      el.innerHTML = ''
    }
  }, [spec, width, height, responsive, responsiveHeight])
  return (
    <div
      className="vega-pane"
      ref={ref}
      aria-label={ariaLabel}
      role="img"
      style={responsive ? { height: responsiveHeight ?? 400 } : undefined}
    />
  )
}

export default VegaPane
