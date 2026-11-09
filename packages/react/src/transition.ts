/**
 * The `transition` prop of the charts: which scene changes animate, and the frame loop that draws them.
 *
 * The interpolation itself is `@aster-charts/core/transition`, loaded on demand: a chart without `transition` never imports
 * it, and one with it starts loading it as soon as the prop is set. A change that arrives before it has loaded is drawn at
 * once, like any chart without `transition`.
 *
 * Frames are drawn from `requestAnimationFrame` straight into the `<svg>` with the DOM patcher, outside React: a frame
 * is only pixels. Hit testing, tooltips and the accessible tree keep answering for the scene the chart has (the target).
 */
import type { SceneRoot } from '@aster-charts/core'
import type { SceneTransition } from '@aster-charts/core/transition'
import type { ChartProps, TransitionOptions } from './chart-types.js'

type TransitionModule = typeof import('@aster-charts/core/transition')

let loaded: TransitionModule | null = null
let loading: Promise<TransitionModule> | null = null

/** Load the interpolation module once per page (a failed load is tried again by the next chart that asks). */
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

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface Running {
  svg: Element
  /** Where it started: kept, so a change that only retargets it keeps its start and its clock. */
  from: SceneRoot
  to: SceneRoot
  tr: SceneTransition
  t0: number
  duration: number
  easing: ResolvedTransition['easing']
}

/** Draws scenes into one chart's `<svg>`: at once, or animated from what is on screen. */
export interface SceneAnimator {
  /**
   * Draw `scene` into `svg`. `animate` (a transition-worthy change, with the chart's options) starts a transition from the
   * picture on screen; without it, a running transition takes `scene` as its new end, and otherwise `scene` is drawn at once.
   */
  draw(svg: Element, scene: SceneRoot, animate: ResolvedTransition | null): void
  /** The DOM shows `scene` (it was drawn some other way): stop any transition, start the next from it. */
  reset(scene: SceneRoot | null): void
  /** Stop the frame loop (unmount). The DOM keeps the frame it shows. */
  cancel(): void
}

export function createSceneAnimator(
  patch: (svg: Element, scene: SceneRoot) => void,
  report: (error: Error) => void,
): SceneAnimator {
  /** The scene the DOM shows: a chart's scene, or the frame of the running transition. */
  let shown: SceneRoot | null = null
  let run: Running | null = null
  let frame = 0
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  const stopFrames = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
  }
  const settle = (svg: Element, scene: SceneRoot): void => {
    stopFrames()
    run = null
    patch(svg, scene)
    shown = scene
  }
  const show = (r: Running, t: number): void => {
    const scene = r.tr.at(t)
    patch(r.svg, scene)
    shown = scene
  }
  const tick = (): void => {
    frame = 0
    const r = run
    if (r === null) return
    const t = r.duration > 0 ? (now() - r.t0) / r.duration : 1
    if (t >= 1) {
      settle(r.svg, r.to)
      return
    }
    try {
      show(r, t)
    } catch (e) {
      report(e instanceof Error ? e : new Error(String(e)))
      settle(r.svg, r.to)
      return
    }
    frame = requestAnimationFrame(tick)
  }
  /** A transition from `from` to `to`, or null when there is nothing to animate (or it cannot be made). */
  const make = (from: SceneRoot, to: SceneRoot, easing: ResolvedTransition['easing']): SceneTransition | null => {
    if (loaded === null) return null
    try {
      const tr = loaded.createSceneTransition(from, to, { easing })
      return tr.moves ? tr : null
    } catch (e) {
      report(e instanceof Error ? e : new Error(String(e)))
      return null
    }
  }

  return {
    draw(svg, scene, animate) {
      if (typeof requestAnimationFrame !== 'function') {
        settle(svg, scene)
        return
      }
      if (animate !== null) {
        const reduced = animate.reducedMotion === 'always' || (animate.reducedMotion === 'user' && prefersReducedMotion())
        // (from the picture on screen: the last scene drawn, or the frame of the transition this one interrupts)
        const from = shown
        if (!reduced && animate.duration > 0 && from !== null) {
          const tr = make(from, scene, animate.easing)
          if (tr !== null) {
            stopFrames()
            run = { svg, from, to: scene, tr, t0: now(), duration: animate.duration, easing: animate.easing }
            show(run, 0)
            frame = requestAnimationFrame(tick)
            return
          }
        }
      } else if (run !== null && run.svg === svg) {
        // not a change that animates, during one that does: it becomes the transition's end, on the same clock
        const r = run
        const tr = make(r.from, scene, r.easing)
        if (tr !== null) {
          r.tr = tr
          r.to = scene
          const t = r.duration > 0 ? (now() - r.t0) / r.duration : 1
          if (t < 1) {
            show(r, t)
            return
          }
        }
      }
      settle(svg, scene)
    },
    reset(scene) {
      stopFrames()
      run = null
      shown = scene
    },
    cancel() {
      stopFrames()
      run = null
    },
  }
}
