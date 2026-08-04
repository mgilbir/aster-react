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
}

export function Chart({ spec, data, width, height, ariaLabel, className, style }: ChartProps) {
  const markup = React.useMemo(() => {
    try {
      return renderSpec(spec, { data, width, height })
    } catch (err) {
      return null
    }
  }, [spec, data, width, height])
  if (markup === null) {
    return <div role="alert" style={style}>Chart render failed</div>
  }
  return (
    <div
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
