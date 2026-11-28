/**
 * The refusals of the values that are not what a door takes (a spec, a compiled chart), in a module of their own so a door that needs
 * one does not import the compiler for it.
 */
import type { CompiledChart } from './types.js'

/** The one refusal of a value that is no spec (`null`, a string...) at every door that takes a spec: `who` names the door. */
export function assertSpecObject(spec: unknown, who: string): void {
  if (!spec || typeof spec !== 'object') throw new Error(`[aster] ${who} expects a Vega spec object`)
}

/**
 * The refusal of an `evaluateChart` that was handed something that is no compiled chart (a spec, most often: `evaluateChart(spec)`
 * is the mistake the name invites). A compiled chart has its three lists and a padding with numbers in it; a spec rarely has all of these.
 */
export function assertCompiledChart(chart: unknown): void {
  const c = chart as Partial<CompiledChart> | null | undefined
  if (c && typeof c === 'object' && Array.isArray(c.data) && Array.isArray(c.scales) && Array.isArray(c.marks)
    && c.padding !== null && typeof c.padding === 'object' && typeof c.padding.top === 'number') return
  throw new Error(`[aster] evaluateChart expects a CompiledChart (compileChart(spec) makes one), got ${c === null ? 'null' : Array.isArray(chart) ? 'a list' : typeof chart === 'object' ? 'an object that is no compiled chart (a spec?)' : typeof chart}`)
}

