/**
 * The `transition` prop of the charts: its options, the on-demand load of the animation code, and what the chart draws while
 * that code is not there.
 *
 * The interpolation and the frame loop are `@aster-charts/core/transition` (`createScenePlayer`), loaded on demand: a chart
 * without `transition` never imports it, and one with it starts loading it as soon as the prop is set. A change that arrives
 * before it has loaded is drawn at once, like any chart without `transition`.
 *
 * Frames are drawn from `requestAnimationFrame` straight into the `<svg>` by the DOM patcher, outside React: a frame is only
 * pixels. Hit testing, tooltips and the accessible tree keep answering for the scene the chart has (the target).
 */
import type { SceneRoot } from '@aster-charts/core'
import type { ScenePlayer } from '@aster-charts/core/transition'
import type { ChartProps, TransitionOptions } from './chart-types.js'

type TransitionModule = typeof import('@aster-charts/core/transition')

let loaded: TransitionModule | null = null
let loading: Promise<TransitionModule> | null = null

/** Load the animation module once per page (a failed load is tried again by the next chart that asks). */
export function loadTransitions(): Promise<TransitionModule> {
  if (loaded !== null) return Promise.resolve(loaded)
  loading ??= import('@aster-charts/core/transition').then(
    (m) => (loaded = m),
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** `transition` with its defaults, or null when it is off. */
export interface ResolvedTransition {
  duration: number
  easing: NonNullable<TransitionOptions['easing']>
  reducedMotion: NonNullable<TransitionOptions['reducedMotion']>
}

export function resolveTransition(prop: ChartProps['transition']): ResolvedTransition | null {
  if (prop == null || prop === false) return null
  const o: TransitionOptions = prop === true ? {} : prop
  const duration = typeof o.duration === 'number' && o.duration >= 0 ? o.duration : 300
  return { duration, easing: o.easing ?? 'cubic-in-out', reducedMotion: o.reducedMotion ?? 'user' }
}

const reduced = (o: ResolvedTransition): boolean => o.reducedMotion === 'always'
  || (o.reducedMotion === 'user' && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/** Draws one chart's scenes into its `<svg>`: at once, or animated once the animation module is there. */
export interface SceneAnimator {
  /** Draw `scene`: `animate` (a change of data, with the chart's options) animates it from the picture on screen. */
  draw(svg: Element, scene: SceneRoot, animate: ResolvedTransition | null): void
  /** The DOM shows `scene` (it was drawn some other way): stop any transition, start the next from it. */
  reset(scene: SceneRoot | null): void
  /** Stop the frame loop (unmount). */
  cancel(): void
}

export function createSceneAnimator(patch: (svg: Element, scene: SceneRoot) => void, report: (error: Error) => void): SceneAnimator {
  // what the svg shows until the player exists (it keeps track itself from then on)
  let shown: SceneRoot | null = null
  let player: ScenePlayer<Element> | null = null
  return {
    draw(svg, scene, animate) {
      if (player === null && animate !== null && loaded !== null) player = loaded.createScenePlayer(patch, report, shown)
      if (player !== null) player.draw(svg, scene, animate !== null && !reduced(animate) ? animate : null)
      else patch(svg, scene)
      shown = scene
    },
    reset(scene) {
      shown = scene
      player?.reset(scene)
    },
    cancel() {
      player?.cancel()
    },
  }
}
