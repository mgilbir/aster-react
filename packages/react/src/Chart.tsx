import * as React from 'react'
import {
  getChartInfo,
  renderSceneToSvg,
  type ChartInfo,
  type SceneRoot,
} from '@aster/core'
// The incremental DOM patcher ships as the `@aster/core/dom` addon: a
// string-mode host never bundles it, while <Chart> (which supports the
// `incremental` path) pulls it in explicitly. The canvas renderer is likewise
// opt-in (`@aster/core/canvas`) so SVG-only hosts never bundle it.
import { createChartSession, patchSceneDom, renderSceneToDomElement } from '@aster/core/dom'
import { renderSceneToCanvas } from '@aster/core/canvas'
import { buildHitIndex, type HitIndex } from '@aster/core/hit'
import { bindSceneSignals, stampDatumAttrs, type SignalBinding } from '@aster/core/signals'
import { dragToDataInterval, selectionToPixels, type SelectionInterval } from './interaction.js'

const num = (x: number): string => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000))

/** Scene/encode channel fields that are engine-internal, not datum data. */
const TOOLTIP_INTERNAL_FIELDS = new Set([
  'x', 'y', 'x2', 'y2', 'xc', 'yc', 'width', 'height', 'opacity', 'fill', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-dasharray', 'strokeOpacity', 'size', 'shape', 'angle',
  'theta', 'radius', 'text', 'align', 'baseline', 'defined', 'startAngle', 'endAngle',
  'innerRadius', 'outerRadius', 'ariaRoleDescription', 'description', 'path', 'url',
  'limit', 'dir', 'dx', 'dy', 'cursor', 'href', 'tooltip', 'band',
])

export interface ChartProps {
  spec: Record<string, unknown>
  data?: Record<string, unknown[]>
  /**
   * Per-datum differential update: for each named dataset, the indices (into the
   * new row array, unchanged length/order) whose values changed. The reactive
   * dataflow re-derives only the changed rows and reuses unchanged scene items
   * and DOM subtrees. Combine with an immutable `data` replacement (new array) of
   * the same length/order. When omitted, updates re-encode fully.
   */
  dataChanges?: Record<string, number[]>
  width?: number
  height?: number
  ariaLabel?: string
  /**
   * Incremental DOM updates: instead of re-serializing and re-parsing the whole
   * SVG on every spec/data change, keep the <svg> element and patch only the
   * attributes that changed (vega-scenegraph's SVG update strategy).
   * On by default: it is dramatically cheaper on updates for the common
   * dashboard case (mostly-stable axes/legends) and leaks less heap. Set to
   * false for a single string render when you only need static output.
   * SSR-safe: the first render emits the full string markup (server + hydration
   * match); patching only runs in the browser on subsequent updates.
   */
  incremental?: boolean
  /**
   * Rendering backend: `'svg'` (default, SSR-safe) or `'canvas'`. Both render
   * the same scene through the shared geometry engine. Canvas handles
   * devicePixelRatio and redraws on every scene change; the DOM tooltip and
   * the spec-driven signal event loop are SVG-only (they read the rendered
   * DOM). Selection brushing works in both.
   */
  renderer?: 'svg' | 'canvas'
  className?: string
  style?: React.CSSProperties
  signals?: Record<string, unknown>
  onSelect?: (interval: SelectionInterval | null) => void
  brush?: SelectionInterval | null
  /**
   * Event-driven signals (vega-react's `signalListeners` convention): handlers
   * called when a signal changes, whether driven by the spec's `signal.on`
   * DOM event streams or by the imperative path. The chart re-renders with
   * the updated signal values after each event.
   */
  signalListeners?: Record<string, (name: string, value: unknown) => void>
  /** Internal: shared listeners (the event loop drives these). */
  onSignal?: (name: string, value: unknown) => void
  /** Disable the spec-driven event loop (defaults to on when the spec has signal.on streams). */
  interactive?: boolean
  /**
   * Show a tooltip on hover over a mark: the datum's fields rendered as
   * `key: value` at the cursor. Reads the `data-datum` attribute that
   * stampDatumAttrs stamps onto scene items. Off by default.
   */
  tooltip?: boolean
}

export function Chart({
  spec,
  data,
  dataChanges,
  width,
  height,
  ariaLabel,
  className,
  style,
  signals,
  onSelect,
  brush,
  incremental = true,
  renderer = 'svg',
  signalListeners,
  onSignal,
  interactive = true,
  tooltip = false,
}: ChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = React.useState<{ width: number; height: number }>({
    width: 600,
    height: 400,
  })
  const overlayRef = React.useRef<HTMLDivElement>(null)

  // Interaction state
  const [isDragging, setIsDragging] = React.useState(false)
  const [dragStartData, setDragStartData] = React.useState<SelectionInterval | null>(null)
  const [dragEndData, setDragEndData] = React.useState<SelectionInterval | null>(null)
  const [dragPixelStart, setDragPixelStart] = React.useState<{ x: number; y: number } | null>(null)
  const [dragPixelEnd, setDragPixelEnd] = React.useState<{ x: number; y: number } | null>(null)
  const [tooltipInfo, setTooltipInfo] = React.useState<{ datum: Record<string, unknown>; x: number; y: number } | null>(null)

  const useOverrides = width != null && height != null

  React.useEffect(() => {
    if (useOverrides) return
    const el = containerRef.current
    if (!el) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const { width: w, height: h } = entries[0]?.contentRect ?? {}
        if (w && h) {
          setMeasured({ width: w, height: h })
        }
      })
      observer.observe(el)
      return () => observer.disconnect()
    }
  }, [useOverrides])

  const renderWidth = useOverrides ? width : measured.width
  const renderHeight = useOverrides ? height : measured.height

  // Session caches scene across renders whose inputs are unchanged (fresh
  // spec object with identical content costs nothing), mirroring Vega's
  // "skip work when nothing is dirty" behavior.
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()

  const sceneGenRef = React.useRef(0)
  const scene = React.useMemo<SceneRoot | null>(() => {
    try {
      const sc = sessionRef.current!.evaluate(spec, { data, dataChanges, width: renderWidth, height: renderHeight, signals })
      // Tooltips read data-datum off the DOM; stamp the datum onto scene items
      // before the markup/patch so the attribute is rendered.
      if (tooltip) stampDatumAttrs(sc.items)
      return sc
    } catch (err) {
      return null
    }
  }, [spec, data, dataChanges, renderWidth, renderHeight, signals, tooltip])
  if (scene != null) sceneGenRef.current++
  const sceneGen = sceneGenRef.current

  // Incremental is the default: we still serialize the full SVG for the first
  // render (so server output and client hydration carry the markup), then the
  // patcher owns the <svg> and we stop re-serializing on later updates.
  const hasPatchedRef = React.useRef(false)
  const markup = React.useMemo<string | null>(() => {
    if (scene == null) return null
    if (renderer === 'canvas') return null
    if (incremental && hasPatchedRef.current) return null
    return renderSceneToSvg(scene)
  }, [incremental, renderer, scene])

  const svgHostRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  // Canvas-mode hit testing: the tooltip resolves marks through the scene hit
  // index instead of DOM attributes (canvas has none). Rebuilt per scene.
  const hitIndexRef = React.useRef<{ idx: number; index: HitIndex | null }>({ idx: 0, index: null })
  // Event-driven signals (vega's event loop): bind the spec's `signal.on`
  // streams to the rendered svg; each event updates the signal store, and the
  // chart re-renders with the updated values via `eventSignals`.
  const signalBindingRef = React.useRef<SignalBinding | null>(null)
  const [eventSignals, setEventSignals] = React.useState<Record<string, unknown>>({})
  React.useLayoutEffect(() => {
    if (!interactive || !scene || renderer === 'canvas') return
    const host = svgHostRef.current
    const svg = (host?.firstElementChild as SVGSVGElement | null) ?? null
    if (!svg) return
    const hasStreams = (scene as unknown as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } }).compiled?.signalDefs?.some((d) => d.on?.length) ?? false
    if (!hasStreams && !signalListeners && !onSignal) return
    signalBindingRef.current?.detach()
    stampDatumAttrs(scene.items)
    signalBindingRef.current = bindSceneSignals(svg, scene, { ...signals, ...eventSignals }, {
      onSignal: (name, value, all) => {
        setEventSignals((prev) => ({ ...prev, ...all }))
        signalListeners?.[name]?.(name, value)
        onSignal?.(name, value)
      },
    })
    return () => {
      signalBindingRef.current?.detach()
      signalBindingRef.current = null
    }
  })

  // Incremental updates: create the <svg> once, then patch changed attributes
  // in place instead of re-serializing and re-parsing the whole markup every render.
  React.useLayoutEffect(() => {
    if (!incremental || !scene || renderer === 'canvas') return
    const host = svgHostRef.current
    if (!host) return
    const existing = host.firstElementChild
    if (existing && existing.tagName.toLowerCase() === 'svg') {
      patchSceneDom(existing, scene)
    } else {
      host.replaceChildren(renderSceneToDomElement(scene))
    }
    hasPatchedRef.current = true
  }, [incremental, scene])

  // Canvas backend: size the backing store for devicePixelRatio and redraw the
  // whole scene whenever it changes (cheap relative to SVG serialization for
  // dense marks; no listeners to leak — every redraw is a full repaint).
  React.useLayoutEffect(() => {
    if (renderer !== 'canvas' || !scene) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const w = Math.max(1, Math.round(scene.width))
    const h = Math.max(1, Math.round(scene.height))
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    } else {
      const ctx0 = canvas.getContext('2d')
      ctx0?.clearRect(0, 0, canvas.width, canvas.height)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderSceneToCanvas(scene, ctx, { dpr })
  }, [renderer, scene])

  const hasInteraction = onSelect != null || brush != null
  const chartInfoRef = React.useRef<ChartInfo | null>(null)
  const chartInfoCacheIdx = React.useRef(0)

  // Recompute chart info when deps change
  const [chartInfoKey, setChartInfoKey] = React.useState<number>(0)
  React.useEffect(() => {
    // Interaction-only: without a selection handler the chart info is unused,
    // and forcing a state update here would re-render (and re-commit the svg)
    // a second time on every spec change.
    if (!hasInteraction) return
    let info: ChartInfo | null = null
    try {
      info = getChartInfo(spec, { width: renderWidth, height: renderHeight })
    } catch { /* ignore */ }
    chartInfoRef.current = info
    chartInfoCacheIdx.current++
    setChartInfoKey(chartInfoCacheIdx.current)
  }, [hasInteraction, spec, renderWidth, renderHeight])

  // Memoize to avoid recalculating
  const chartInfo = chartInfoRef.current ?? null
  const _chartInfoDepKey = chartInfoKey // force re-read

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!hasInteraction) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setDragPixelStart({ x, y })
      setDragPixelEnd({ x, y })
      setIsDragging(true)
      const target = e.target as HTMLElement
      target.setPointerCapture(e.pointerId)
    },
    [hasInteraction],
  )

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging || dragPixelStart == null || !hasInteraction) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setDragPixelEnd({ x, y })
      const ci = chartInfoRef.current
      if (ci) {
        const interval = dragToDataInterval(dragPixelStart, { x, y }, ci)
        setDragEndData(interval)
      }
    },
    [isDragging, dragPixelStart, hasInteraction],
  )

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging || dragPixelStart == null || !hasInteraction) {
        setIsDragging(false)
        return
      }
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) {
        setIsDragging(false)
        return
      }
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      const dx = x - dragPixelStart.x
      const dy = y - dragPixelStart.y
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        // Tiny drag -> clear selection
        setDragStartData(null)
        setDragEndData(null)
        if (onSelect) onSelect(null)
      } else {
        const ci = chartInfoRef.current
        if (ci) {
          const interval = dragToDataInterval(dragPixelStart, { x, y }, ci)
          setDragStartData(interval)
          setDragEndData(interval)
          if (onSelect) onSelect(interval)
        }
      }
      setIsDragging(false)
      setDragPixelStart(null)
      setDragPixelEnd(null)
    },
    [isDragging, dragPixelStart, hasInteraction, onSelect],
  )

  /**
   * Tooltip fields: the datum row is the ORIGINAL data plus the encoded
   * channel values resolveEncodeSet appends (x/y/width/fill/...). The tooltip
   * is for reading the datum — hide the internal/positional channels and
   * engine fields, keep the source data.
   */
  const tooltipFields = React.useMemo(() => {
    if (!tooltipInfo) return [] as Array<[string, string]>
    const fmt = ([k, v]: [string, unknown]): [string, string] => [k, typeof v === 'number' ? num(v) : String(v)]
    const visible = Object.entries(tooltipInfo.datum).filter(
      ([k, v]) => !k.startsWith('__') && !TOOLTIP_INTERNAL_FIELDS.has(k) && v != null && typeof v !== 'object',
    )
    // Specs whose source fields are themselves named like channels (x/y/...)
    // would filter to nothing — vega-style fallback: show every field.
    return (visible.length ? visible : Object.entries(tooltipInfo.datum).filter(([k, v]) => !k.startsWith('__') && v != null && typeof v !== 'object')).map(fmt)
  }, [tooltipInfo])

  const handleTooltipMove = React.useCallback(
    (e: React.MouseEvent) => {
    if (!tooltip) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    if (renderer === 'canvas') {
      // Canvas backend: resolve through the scene hit index.
      if (hitIndexRef.current.index == null || hitIndexRef.current.idx !== sceneGen) {
        hitIndexRef.current = scene ? { idx: sceneGen, index: buildHitIndex(scene) } : { idx: 0, index: null }
      }
      const target = hitIndexRef.current.index?.query(e.clientX - rect.left, e.clientY - rect.top)
      const datum = target?.item.datum as Record<string, unknown> | undefined
      setTooltipInfo(datum != null && typeof datum === 'object' ? { datum, x: e.clientX - rect.left, y: e.clientY - rect.top } : null)
      return
    }
    // The hovered element may be a parent/child of the mark (e.g. a tspan or an
    // axis line above it); walk up to the nearest element carrying data-datum.
    const el = (e.target as HTMLElement).closest?.('[data-datum]') as HTMLElement | null
    const raw = el?.dataset?.datum
    if (!raw) { setTooltipInfo(null); return }
    try {
      const datum = JSON.parse(raw) as Record<string, unknown>
      setTooltipInfo({ datum, x: e.clientX - rect.left, y: e.clientY - rect.top })
    } catch { setTooltipInfo(null) }
    },
    [tooltip, renderer],
  )

  const handleTooltipLeave = React.useCallback(() => {
    if (tooltip) setTooltipInfo(null)
  }, [tooltip])

  // Brush pixel rect from persisted brush prop
  const brushPixelRect = React.useMemo(() => {
    if (!brush || chartInfo == null) return null
    return selectionToPixels(brush, chartInfo)
  }, [brush, chartInfo])

  // Drag overlay pixel rect
  const dragRect = React.useMemo(() => {
    if (!dragPixelStart || !dragPixelEnd) return null
    return {
      x: Math.min(dragPixelStart.x, dragPixelEnd.x),
      y: Math.min(dragPixelStart.y, dragPixelEnd.y),
      width: Math.abs(dragPixelEnd.x - dragPixelStart.x),
      height: Math.abs(dragPixelEnd.y - dragPixelStart.y),
    }
  }, [dragPixelStart, dragPixelEnd])

  if (scene === null) {
    return <div role="alert" style={style}>Chart render failed</div>
  }

  const outerStyle: React.CSSProperties = hasInteraction
    ? { ...style, position: 'relative', width: '100%', height: '100%' }
    : { width: '100%', height: '100%', ...style }

  return (
    <div
      ref={containerRef}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      className={className}
      style={outerStyle}
      onMouseMove={handleTooltipMove}
      onMouseLeave={handleTooltipLeave}
    >
      {hasInteraction && (
        <div data-testid="chart-brush-overlay"
          style={{ position: 'absolute', inset: 0, zIndex: 10 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Live drag overlay */}
          {dragRect != null && (
            <div
              ref={overlayRef}
              style={{
                position: 'absolute',
                left: dragRect.x,
                top: dragRect.y,
                width: dragRect.width,
                height: dragRect.height,
                background: 'rgba(37,99,235,0.15)',
                border: '1px solid rgba(37,99,235,0.6)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          )}
          {/* Persisted brush overlay */}
          {brushPixelRect != null && (
            <div
              style={{
                position: 'absolute',
                left: brushPixelRect.x,
                top: brushPixelRect.y,
                width: brushPixelRect.width,
                height: brushPixelRect.height,
                background: 'rgba(37,99,235,0.15)',
                border: '1px solid rgba(37,99,235,0.6)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      )}
      {renderer === 'canvas' ? (
        <canvas
          ref={canvasRef}
          data-testid="chart-canvas"
          style={{ position: 'relative', zIndex: 1, width: scene.width, height: scene.height, display: 'block' }}
        />
      ) : (
        <div
          ref={svgHostRef}
          style={{ position: 'relative', zIndex: 1 }}
          {...(markup != null ? { dangerouslySetInnerHTML: { __html: markup } } : {})}
        />
      )}
      {tooltipInfo != null && (
        <div
          data-testid="chart-tooltip"
          style={{
            position: 'absolute',
            left: tooltipInfo.x + 12,
            top: tooltipInfo.y + 12,
            zIndex: 20,
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'system-ui, sans-serif',
            maxWidth: 240,
            whiteSpace: 'nowrap',
          }}
        >
          {tooltipFields.map(([k, v]) => (
            <div key={k}><strong>{k}:</strong> {v}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export { type SelectionInterval } from './interaction.js'
