import * as React from 'react'
import { renderSceneToSvg, type RuntimeInput, type SceneRoot, type VgSpec } from '@aster/core'
import { createChartSession } from '@aster/core/dom'

export interface UseChartOptions extends RuntimeInput {
  /** Skip SVG serialization when the host renders the scene itself. */
  serialize?: boolean
}

export interface UseChartResult {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  /** The underlying incremental session, stable across renders. */
  session: ReturnType<typeof createChartSession>
}

/**
 * Headless React hook: compile/evaluate a Vega spec through the same
 * incremental session <Chart> uses, returning the scene (and SVG unless
 * `serialize: false`). Identical inputs return the cached scene.
 */
export function useChart(spec: VgSpec, options: UseChartOptions = {}): UseChartResult {
  const { serialize = true, ...input } = options
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const session = sessionRef.current
  return React.useMemo(() => {
    try {
      const scene = session.evaluate(spec, input)
      return { scene, svg: serialize ? renderSceneToSvg(scene) : null, error: null, session }
    } catch (e) {
      return { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), session }
    }
  }, [spec, input.data, input.dataChanges, input.width, input.height, input.signals, input.limits, serialize, session])
}
