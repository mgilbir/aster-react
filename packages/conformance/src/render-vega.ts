/**
 * Reference oracle renderer: render a Vega spec through the real vega runtime
 * (headless) to an SVG string. Used only by the conformance harness (dev).
 */
import * as vega from 'vega'

export async function renderWithVega(vgSpec: Record<string, unknown>): Promise<string> {
  const runtime = vega.parse(vgSpec as any)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}

export interface CheckedRender {
  svg: string
  /** vega logger error() calls plus a thrown parse/run error, if any. */
  errors: string[]
  /** vega logger warn() calls (invalid scale refs, bad encodings, ...). */
  warnings: string[]
}

/**
 * Render a Vega spec through real vega while capturing everything its logger
 * reports. Aster's own runtime is lenient (it renders specs real vega refuses),
 * so the VL harness uses this to prove the Vega @aster/vl EMITS is valid Vega,
 * not merely something Aster tolerates (audit C39/T4).
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
  try {
    const runtime = vega.parse(vgSpec as any)
    const view = new (vega as any).View(runtime, { renderer: 'none', logger })
    try {
      await view.runAsync()
      svg = await view.toSVG()
    } finally {
      view.finalize()
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  return { svg, errors, warnings }
}
