import * as React from 'react'
import { renderSpec } from '@aster/core'

export interface ChartProps {
  spec: Record<string, unknown>
  data?: Record<string, unknown[]>
  width?: number
  height?: number
  ariaLabel?: string
  className?: string
  style?: React.CSSProperties
  signals?: Record<string, unknown>
}

export function Chart({ spec, data, width, height, ariaLabel, className, style, signals }: ChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = React.useState<{ width: number; height: number }>({
    width: 600,
    height: 400,
  })

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

  if (markup === null) {
    return <div role="alert" style={style}>Chart render failed</div>
  }

  return (
    <div
      ref={containerRef}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
