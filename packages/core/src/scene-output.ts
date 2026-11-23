/**
 * What a scene was evaluated under that its renderers must draw it under too: the URL policy (every URL they write is vetted with
 * it, url-policy.ts `outputUrl`) and the text measurer given for that evaluation (`RuntimeInput.textMetrics`: a label's `limit` is
 * cut, and a text's box measured, when it is drawn; under another measurer than the layout's, the output would cut a label the
 * layout sized whole). The evaluation records both on the scene it returns (`bindSceneUrlPolicy`, `bindSceneTextMetrics`); every
 * renderer entry -- the SVG string, the DOM descriptors, canvas, the canvas append, the hit index, the accessible tree -- runs
 * under them (`withSceneOutput`). A scene with nothing recorded (made by hand, evaluated with no per-call measurer, or posted from
 * a worker, which drops what cannot be cloned) is drawn under the defaults and the measurer set for every chart
 * (`setTextMetricsProvider`).
 */
import { sceneUrlPolicy, type ImageUrlPolicy } from './url-policy.js'
import { withExactTextMetricsProvider, type TextMetricsProvider } from './text-metrics.js'

const SCENE_MEASURER: unique symbol = Symbol.for('@aster-charts/core:text-metrics') as never

/** Record the text measurer a scene was evaluated under (null: the canvas measurer, or the estimate where there is no canvas). */
export function bindSceneTextMetrics(scene: object, provider: TextMetricsProvider | null): void {
  // (under a symbol, as the URL policy: copied with the scene, dropped by a structured clone, unreachable from a spec)
  Object.defineProperty(scene, SCENE_MEASURER, { value: provider, enumerable: true, configurable: true, writable: true })
}

/** The measurer a scene was evaluated under: a provider, null for none, undefined when nothing was recorded. */
export function sceneTextMetrics(scene: object): TextMetricsProvider | null | undefined {
  return (scene as { [SCENE_MEASURER]?: TextMetricsProvider | null })[SCENE_MEASURER]
}

/** The URL policy of the scene being drawn (see {@link withSceneOutput}); undefined outside a render, or for a scene with none. */
let OUTPUT_POLICY: ImageUrlPolicy | undefined

/** The URL policy the attribute sinks and the image loader vet with now. */
export function outputPolicy(): ImageUrlPolicy | undefined {
  return OUTPUT_POLICY
}

/** Run `fn` (a render of `scene`) under what the scene was evaluated under: its URL policy and its text measurer. */
export function withSceneOutput<T>(scene: object, fn: () => T): T {
  const before = OUTPUT_POLICY
  OUTPUT_POLICY = sceneUrlPolicy(scene)
  try {
    const measurer = sceneTextMetrics(scene)
    return measurer === undefined ? fn() : withExactTextMetricsProvider(measurer, fn)
  } finally {
    OUTPUT_POLICY = before
  }
}
