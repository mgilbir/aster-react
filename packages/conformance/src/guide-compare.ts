import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>
type ViewLike = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void }

/** Real vega's SVG for `spec`, with the errors its logger reports (its console fallback silenced). */
export async function vegaSvg(spec: Spec, errors: string[] = []): Promise<string> {
  const log = console.error
  const warn = console.warn
  console.error = () => {}
  console.warn = () => {}
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => ViewLike & { logger(l: unknown): unknown } }).View
  const view = new View(vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
  view.logger({
    level() { return 1 },
    error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message ?? String(x)).join(' ')); return this },
    warn() { return this }, info() { return this }, debug() { return this },
  })
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

/**
 * The differences between vega and Aster for `spec` ([] when they agree): the canonical documents, and whether each logged an error
 * (vega logs a failing operator and draws what it has; so does Aster, through its logger). `refused` when vega itself cannot take the
 * spec -- Aster is run all the same, and refusing nothing where vega refuses is a difference.
 */
export async function compareToVega(spec: Spec): Promise<Outcome> {
  // (each engine its own copy: vega writes onto the rows it ingests)
  return forEngines(spec, (oracle, aster) => compareCopies(oracle, aster))
}

async function compareCopies(oracle: Spec, aster: Spec): Promise<Outcome> {
  const vegaErrors: string[] = []
  let want: string | undefined
  let refused: string | undefined
  try {
    want = await vegaSvg(oracle, vegaErrors)
  } catch (e) {
    refused = (e as Error).message.split('\n')[0]
  }
  let got: string
  const asterErrors: string[] = []
  const logger = { error: (...a: unknown[]) => { asterErrors.push(a.map((x) => (x as Error)?.message ?? String(x)).join(' ')) }, warn: () => {} }
  try {
    got = renderSpec(aster as never, { logger } as never)
  } catch (e) {
    if (refused !== undefined) return { diffs: [], refused }
    return { diffs: [`aster threw: ${(e as Error).message.split('\n')[0]}`] }
  }
  if (refused !== undefined) return { diffs: [`vega refused (${refused}), aster rendered`], refused }
  const diffs = diffCanonical(canonicalizeSvg(want!), canonicalizeSvg(got))
  if ((vegaErrors.length > 0) !== (asterErrors.length > 0)) diffs.push(`logged errors: vega ${JSON.stringify(vegaErrors.slice(0, 1))}, aster ${JSON.stringify(asterErrors.slice(0, 1))}`)
  return { diffs, svg: want }
}
