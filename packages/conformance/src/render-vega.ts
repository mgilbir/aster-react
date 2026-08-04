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
