/**
 * Reference oracle renderer: render a Vega spec through the real vega runtime
 * (headless) to an SVG string. Used only by the conformance harness (dev).
 */
import * as vega from 'vega'

export async function renderWithVega(vgSpec: Record<string, unknown>): Promise<string> {
  return (await renderWithVegaCounted(vgSpec)).svg
}

/**
 * `renderWithVega`, and how many items the spec's own (non-group) marks drew: the data-driven part of the picture. Axes, legends, titles
 * and the frame are guides, not marks of the spec; a spec whose count is 0 compares its guides only.
 */
export async function renderWithVegaCounted(vgSpec: Record<string, unknown>): Promise<{ svg: string; markItems: number }> {
  const runtime = vega.parse(vgSpec as any)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  await view.runAsync()
  // The first frame: stop the view's timers (a Vega-Lite animation's clock) before they can tick. `toSVG` awaits further runs, and on
  // a busy event loop a timer that is due would land between them and draw frame two; a spec without timers is unaffected.
  view.finalize()
  let markItems = 0
  const walk = (mark: any): void => {
    if (mark.marktype === 'group') {
      for (const g of mark.items ?? []) for (const child of g.items ?? []) walk(child)
    } else if (mark.role === 'mark') {
      markItems += mark.items?.length ?? 0
    }
  }
  walk(view.scenegraph().root)
  return { svg: await view.toSVG(), markItems }
}

export interface CheckedRender {
  svg: string
  /** vega logger error() calls plus a thrown parse/run error, if any. */
  errors: string[]
  /** vega logger warn() calls (invalid scale refs, bad encodings, ...). */
  warnings: string[]
  /**
   * The tooltip of every scenegraph item that has one, in scenegraph order (`mark role/name#index: value`). Neither engine's SVG carries a
   * tooltip, so a gate that compares only the SVG cannot see them (they are what `encoding.tooltip` and `mark.tooltip` compile to).
   */
  tooltips: string[]
  /** `view.data(name)` of every top-level dataset the spec declares, after the first run (the tuples as plain objects). */
  datasets: Record<string, unknown[]>
}

/**
 * Render a Vega spec through real vega while capturing everything its logger
 * reports. Aster's own runtime is lenient (it renders specs real vega refuses),
 * so the VL harness uses this to prove the Vega @aster-charts/vl EMITS is valid Vega,
 * not merely something Aster tolerates.
 */
export async function renderWithVegaChecked(vgSpec: Record<string, unknown>): Promise<CheckedRender> {
  const errors: string[] = []
  const warnings: string[] = []
  const fmt = (args: unknown[]): string =>
    args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const logger = {
    level(): number {
      return 3
    },
    error(...args: unknown[]): unknown {
      errors.push(fmt(args))
      return logger
    },
    warn(...args: unknown[]): unknown {
      warnings.push(fmt(args))
      return logger
    },
    info(): unknown {
      return logger
    },
    debug(): unknown {
      return logger
    },
  }
  let svg = ''
  const datasets: Record<string, unknown[]> = {}
  const tooltips: string[] = []
  try {
    const runtime = vega.parse(vgSpec as any)
    const view = new (vega as any).View(runtime, { renderer: 'none', logger })
    try {
      await view.runAsync()
      view.finalize() // the first frame: no timer ticks before the SVG is drawn (see renderWithVega)
      for (const d of (vgSpec.data as Array<{ name: string }> | undefined) ?? []) {
        // (a dataset whose tuples hold themselves -- an argmax over a joinaggregate -- is not plain data: it is left out)
        try { datasets[d.name] = JSON.parse(JSON.stringify(view.data(d.name) ?? null)) as unknown[] } catch { /* not serializable */ }
      }
      collectTooltips(view.scenegraph().root, tooltips)
      svg = await view.toSVG()
    } finally {
      view.finalize()
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  return { svg, errors, warnings, tooltips, datasets }
}

/** Every item's `tooltip` (a value the spec's `tooltip` channel produced), depth first, in scenegraph order. */
function collectTooltips(mark: any, out: string[]): void {
  const label = `${mark.role ?? ''}/${mark.name ?? ''}`
  ;(mark.items ?? []).forEach((item: any, i: number) => {
    if (mark.marktype === 'group') {
      for (const child of item.items ?? []) collectTooltips(child, out)
    } else if (item.tooltip !== undefined) {
      let value: string
      try { value = JSON.stringify(item.tooltip) } catch { value = String(item.tooltip) }
      out.push(`${label}#${i}: ${value}`)
    }
  })
}
