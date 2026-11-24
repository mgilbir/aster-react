/** The oracle side of the static path: real vega rendered headless from the offline gallery data. */
import * as vega from 'vega'
import { BASE_URL, fileFetch } from './lib.js'
import { settleWithin } from '../render-vega.js'

/**
 * Errors vega (or Aster) throws from a timer/promise callback nobody awaits (vega's scenegraph redraw does) surface as
 * uncaught exceptions; collect them so the spec that caused them is reported instead of the whole run dying.
 */
export const stray: string[] = []
process.on('uncaughtException', (e) => { stray.push(e instanceof Error ? e.message : String(e)) })
process.on('unhandledRejection', (e) => { stray.push(e instanceof Error ? e.message : String(e)) })
/** What the view being rendered logged as an error (vega logs a failing operator and carries on; the rendered document is then not what the spec describes). */
export const logged: string[] = []
/** What it logged as a warning: vega's loader reports a data file it could not load as a warning (`Loading failed`) and renders the chart without it. */
export const warned: string[] = []
const collector = {
  level(): number { return 2 },
  // (the stack too: a null canvas surfaces as `Cannot set properties of null` from a function called getContext)
  error(...a: unknown[]) { logged.push(a.map((x) => (x as Error)?.stack ?? String(x)).join(' ')); return this },
  warn(...a: unknown[]) { warned.push(a.map((x) => (x as Error)?.message ?? String(x)).join(' ')); return this },
  info() { return this },
  debug() { return this },
}
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))


/** `inspect` reads the view once it has run (its datasets), before it is finalized. */
export async function vegaSvg(spec: Record<string, unknown>, inspect?: (view: vega.View) => void): Promise<string> {
  // vega-loader's Node build requests through the GLOBAL fetch (the network), whatever options say; serve the gallery from disk instead
  // (mode 'http': with a baseURL a relative uri would otherwise still be read as a FILE on Node)
  const loader = vega.loader({ baseURL: BASE_URL, mode: 'http' })
  loader.http = async (url: string, options: (Partial<RequestInit> & { response?: string }) | undefined): Promise<string> => {
    const res = await fileFetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
    const type = options?.response as 'arrayBuffer' | 'json' | 'text' | undefined
    return (type !== undefined && typeof res[type] === 'function' ? res[type]() : res.text()) as Promise<string>
  }
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none', loader })
  view.logger(collector as never)
  try {
    await settleWithin(view.runAsync(), 'the oracle (vega runAsync)')
    inspect?.(view)
    view.finalize() // the first frame: no timer tick between the run and the serialisation
    return await settleWithin(view.toSVG(), 'the oracle (vega toSVG)')
  } finally {
    view.finalize()
  }
}

