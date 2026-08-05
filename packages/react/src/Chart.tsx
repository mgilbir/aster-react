import * as React from 'react'
import { renderSpec, getChartInfo, type ChartInfo } from '@aster/core'
import { dragToDataInterval, selectionToPixels, type SelectionInterval } from './interaction.js'

export interface ChartProps {
  spec: Record<string, unknown>
  data?: Record<string, unknown[]>
  width?: number
  height?: number
  ariaLabel?: string
  className?: string
  style?: React.CSSProperties
  signals?: Record<string, unknown>
  onSelect?: (interval: SelectionInterval | null) => void
  brush?: SelectionInterval | null
}

export function Chart({
  spec,
  data,
  width,
  height,
  ariaLabel,
  className,
  style,
  signals,
  onSelect,
  brush,
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

  const markup = React.useMemo(() => {
    try {
      return renderSpec(spec, { data, width: renderWidth, height: renderHeight, signals })
    } catch (err) {
      return null
    }
  }, [spec, data, renderWidth, renderHeight, signals])

  const hasInteraction = onSelect != null || brush != null
  const chartInfoRef = React.useRef<ChartInfo | null>(null)
  const chartInfoCacheIdx = React.useRef(0)

  // Recompute chart info when deps change
  const [chartInfoKey, setChartInfoKey] = React.useState<number>(0)
  React.useEffect(() => {
    if (hasInteraction) {
      let info: ChartInfo | null = null
      try {
        info = getChartInfo(spec, { width: renderWidth, height: renderHeight })
      } catch { /* ignore */ }
      chartInfoRef.current = info
      chartInfoCacheIdx.current++
      setChartInfoKey(chartInfoCacheIdx.current)
    } else {
      chartInfoRef.current = null
      chartInfoCacheIdx.current++
      setChartInfoKey(chartInfoCacheIdx.current)
    }
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

  if (markup === null) {
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
    >
      {hasInteraction && (
        <div
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
      <div
        style={{ position: 'relative', zIndex: 1 }}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  )
}

export { type SelectionInterval } from './interaction.js'
