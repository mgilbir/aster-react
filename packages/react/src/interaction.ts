import type { ChartInfo } from '@aster/core'

export interface SelectionInterval {
  x?: [number, number]
  y?: [number, number]
}

export interface PixelPoint {
  x: number
  y: number
}

/** Convert an SVG-local pixel drag rect into a data-space interval using the chart scales + padding. */
export function dragToDataInterval(
  start: PixelPoint,
  end: PixelPoint,
  info: ChartInfo,
): SelectionInterval {
  const xScale = info.scales.get('x')
  const yScale = info.scales.get('y')
  const out: SelectionInterval = {}
  const xInv = (xScale as { invert?: (v: number) => number } | undefined)?.invert
  const yInv = (yScale as { invert?: (v: number) => number } | undefined)?.invert

  if (xInv) {
    const a = xInv(start.x - info.padding.left)
    const b = xInv(end.x - info.padding.left)
    if (isFiniteNumber(a) && isFiniteNumber(b)) out.x = [Math.min(a, b), Math.max(a, b)]
  }
  if (yInv) {
    const a = yInv(start.y - info.padding.top)
    const b = yInv(end.y - info.padding.top)
    if (isFiniteNumber(a) && isFiniteNumber(b)) out.y = [Math.min(a, b), Math.max(a, b)]
  }
  return out
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Convert a data-space selection to pixel coordinates within the SVG. */
export function selectionToPixels(
  selection: SelectionInterval,
  info: ChartInfo,
): { x: number; y: number; width: number; height: number } {
  const xScale = info.scales.get('x')
  const yScale = info.scales.get('y')

  // Helper to call scale(value) for continuous scales
  const scaleVal = (s: unknown, v: number): number => {
    if (s == null) return NaN
    return (s as { (arg: number): number })(v)
  }

  let x = info.padding.left
  let y = info.padding.top
  let width = info.width
  let height = info.height

  if (selection.x && xScale) {
    const [x0, x1] = selection.x
    const px0 = scaleVal(xScale, x0)
    const px1 = scaleVal(xScale, x1)
    x = Math.min(px0, px1)
    width = Math.abs(px1 - px0)
  }

  if (selection.y && yScale) {
    const [y0, y1] = selection.y
    const py0 = scaleVal(yScale, y0)
    const py1 = scaleVal(yScale, y1)
    y = Math.min(py0, py1)
    height = Math.abs(py1 - py0)
  }

  return { x, y, width, height }
}
