/**
 * What a mark's bounds can fail on. vega measures every mark's items in its Bound operator, ranked after the mark's encode, its
 * transforms and its sort; measuring an item draws its geometry into a bounds context, and some values cannot be drawn: path text
 * vega's reader refuses (or that is no text at all), a custom symbol shape likewise, a line's or an area's `interpolate` that names
 * no curve, a shape mark's item with no shape to draw, a mark's clip path. The operator throws, and the dataflow pass stops there:
 * nothing ranked after it (the marks after this one, the layout of the view) runs, and the error is logged once.
 *
 * Other values that do not draw are no failure: vega measures what it can (a NaN, a negative radius) and goes on.
 */
import type { SceneItem } from './types.js'
import { part } from './engine-parts.js'
import type { BezierSink, PathCommand } from './path-data.js'

/** vega-scenegraph's built-in symbol shapes: any other name is read as the SVG path of a custom shape. */
const SYMBOLS = new Set(['circle', 'cross', 'diamond', 'square', 'arrow', 'wedge', 'triangle', 'triangle-up', 'triangle-down', 'triangle-right', 'triangle-left', 'stroke'])

/** The curves vega's `interpolate` names (`monotone` aside, which takes the mark's orientation). */
const CURVES = new Set(['basis', 'basis-closed', 'basis-open', 'bundle', 'cardinal', 'cardinal-open', 'cardinal-closed', 'catmull-rom', 'catmull-rom-closed', 'catmull-rom-open', 'linear', 'linear-closed', 'natural', 'step', 'step-after', 'step-before'])

/**
 * Draw a line or an area in the curve its first item names, as vega's shape generator does: a name vega does not know (nor
 * `monotone` in an orientation that is neither `vertical`, the default, nor `horizontal`) leaves it no curve, and calling it
 * throws the engine's TypeError. (The renderers here draw such a mark in the linear curve: they draw any scene they are given.)
 */
function measureCurve(interpolate: unknown, orient: unknown): void {
  const name = interpolate || 'linear'
  const named = name === 'monotone' ? !orient || orient === 'vertical' || orient === 'horizontal' : typeof name === 'string' && CURVES.has(name)
  const curve = named ? (): void => {} : undefined
  ;(curve as () => void)()
}

const NOWHERE: BezierSink = { moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {} }

/**
 * Read and replay path text as vega's path reader does when it measures it: its errors where vega's reader throws (`Invalid SVG
 * path, ...`; a `t` that reflects a control point no `t` set), and, for a value that is no text, the TypeError the engine gives
 * vega's `path.match(...)` read.
 */
export function measurePath(path: unknown, scale = 1): void {
  const { svgPathCommands, renderSvgPath } = part('svgpath')
  const commands: PathCommand[] = svgPathCommands(path as string)
  renderSvgPath(NOWHERE, commands, 0, 0, scale)
}

/** Draw a shape mark's item: its mark's shape (a transform's), else its own. */
function measureShape(item: { mark: { shape?: unknown }; shape?: unknown }): void {
  if (typeof (item.mark.shape || item.shape) === 'function') return
  ;((item.mark.shape || item.shape) as { context(context: null): unknown }).context(null)
}

/**
 * Where measuring the items of a mark of `type` fails: the error, and the first item it leaves unmeasured (the failing one, in the
 * mark's order: those after it are never measured either; a line or an area is measured as one, from its first item) -- or undefined
 * when they all measure. `clipPath` is the mark's clip, when it is an SVG path: vega bounds it after the items, which are measured by
 * then. `shaped`, whether a transform gave the mark a shape (a shape mark's).
 */
export function boundFailure(type: string, items: readonly SceneItem[], clipPath?: string, shaped = false): { error: unknown; from: number | undefined } | undefined {
  let at = 0
  try {
    switch (type) {
      case 'path':
        for (; at < items.length; at++) if (items[at]!.path != null) measurePath(items[at]!.path)
        break
      case 'symbol':
        for (; at < items.length; at++) {
          const shape = (items[at] as { shape?: unknown }).shape || 'circle'
          if (typeof shape !== 'string' || !SYMBOLS.has(shape)) measurePath(shape)
        }
        break
      case 'line':
      case 'area':
        // (a line or an area is one shape, in the curve its first item names)
        if (items.length) {
          const first = items[0] as { interpolate?: unknown; orient?: unknown }
          measureCurve(first.interpolate, first.orient)
        }
        break
      case 'shape':
        if (!shaped) for (; at < items.length; at++) measureShape({ mark: {}, shape: (items[at] as { shape?: unknown }).shape })
        break
    }
  } catch (error) {
    return { error, from: type === 'line' || type === 'area' ? 0 : at }
  }
  if (clipPath !== undefined) {
    try { measurePath(clipPath) } catch (error) { return { error, from: undefined } }
  }
  return undefined
}
