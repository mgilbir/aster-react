import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>
type ViewLike = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void }

/** Real vega's SVG for `spec`, with its logging (and the console it falls back to) silenced. */
export async function vegaSvg(spec: Spec): Promise<string> {
  const log = console.error
  const warn = console.warn
  console.error = () => {}
  console.warn = () => {}
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => ViewLike }).View
  const view = new View(vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    console.warn = warn
    view.finalize()
  }
}

export interface Outcome { diffs: string[]; refused?: string; svg?: string }

/** The differences between vega and Aster for `spec` ([] when they agree); `refused` when vega itself cannot take the spec. */
export async function compareToVega(spec: Spec): Promise<Outcome> {
  // (each engine its own copy: vega writes onto the rows it ingests)
  return forEngines(spec, (oracle, aster) => compareCopies(oracle, aster))
}

async function compareCopies(oracle: Spec, aster: Spec): Promise<Outcome> {
  let want: string
  try {
    want = await vegaSvg(oracle)
  } catch (e) {
    return { diffs: [], refused: (e as Error).message.split('\n')[0] }
  }
  let got: string
  const log = console.error
  const warn = console.warn
  console.error = () => {}
  console.warn = () => {}
  try {
    got = renderSpec(aster as never)
  } catch (e) {
    return { diffs: [`aster threw: ${(e as Error).message.split('\n')[0]}`] }
  } finally {
    console.error = log
    console.warn = warn
  }
  return { diffs: diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got)), svg: want }
}
