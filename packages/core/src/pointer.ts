/**
 * The pointer in a rendered chart's own coordinates.
 *
 * `clientToSvg` is vega-scenegraph's `point(event, el)`: the inverse of the element's screen CTM, which carries everything
 * between the viewport and the element's user space -- a viewBox against a CSS-scaled width, the element's border and
 * padding, any CSS transform on an ancestor. Without a CTM (a canvas, no layout) it unscales the bounding rect by its size
 * over the untransformed layout size, then subtracts the border.
 *
 * `createPointMapper` is the same map read once and reused: a pointermove then costs no layout read. The host forgets it
 * (`invalidate`) when anything that can change it happens -- a commit, a resize, a scroll, the pointer entering.
 */
export function clientToSvg(el: Element, clientX: number, clientY: number): [number, number] {
  const ctm = typeof (el as SVGGraphicsElement).getScreenCTM === 'function' ? (el as SVGGraphicsElement).getScreenCTM() : null
  if (ctm) {
    const det = ctm.a * ctm.d - ctm.b * ctm.c
    if (det) {
      const x = clientX - ctm.e
      const y = clientY - ctm.f
      return [(ctm.d * x - ctm.c * y) / det, (ctm.a * y - ctm.b * x) / det]
    }
  }
  const rect = el.getBoundingClientRect()
  const w = (el as HTMLElement).offsetWidth
  const h = (el as HTMLElement).offsetHeight
  const sx = w ? rect.width / w : 1
  const sy = h ? rect.height / h : 1
  return [(clientX - rect.left) / sx - (el.clientLeft || 0), (clientY - rect.top) / sy - (el.clientTop || 0)]
}

export interface PointMapper {
  /** A client point in the element's coordinates (measures the element once after an `invalidate`). */
  map(clientX: number, clientY: number): [number, number]
  /** Forget the measurement: the next `map` reads the layout again. */
  invalidate(): void
}

/** The map as an affine transform [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. One layout read. */
function clientAffine(el: Element): [number, number, number, number, number, number] {
  const ctm = typeof (el as SVGGraphicsElement).getScreenCTM === 'function' ? (el as SVGGraphicsElement).getScreenCTM() : null
  if (ctm) {
    const det = ctm.a * ctm.d - ctm.b * ctm.c
    if (det) return [ctm.d / det, -ctm.b / det, -ctm.c / det, ctm.a / det, (ctm.c * ctm.f - ctm.d * ctm.e) / det, (ctm.b * ctm.e - ctm.a * ctm.f) / det]
  }
  const rect = el.getBoundingClientRect()
  const w = (el as HTMLElement).offsetWidth
  const h = (el as HTMLElement).offsetHeight
  const sx = w ? rect.width / w : 1
  const sy = h ? rect.height / h : 1
  return [1 / sx, 0, 0, 1 / sy, -rect.left / sx - (el.clientLeft || 0), -rect.top / sy - (el.clientTop || 0)]
}

/** `getEl` names the element to map into (the chart's svg or canvas); none yet: the point is returned as it is. */
export function createPointMapper(getEl: () => Element | null): PointMapper {
  let m: [number, number, number, number, number, number] | null = null
  return {
    map(clientX, clientY) {
      if (m == null) {
        const el = getEl()
        if (el == null) return [clientX, clientY]
        m = clientAffine(el)
      }
      return [m[0] * clientX + m[2] * clientY + m[4], m[1] * clientX + m[3] * clientY + m[5]]
    },
    invalidate() { m = null },
  }
}
