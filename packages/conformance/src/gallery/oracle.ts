/** The oracle side of the static path: real vega rendered headless from the offline gallery data. */
import * as vega from 'vega'
import { BASE_URL, fileFetch } from './lib.js'

/**
 * Errors vega (or Aster) throws from a timer/promise callback nobody awaits (vega's scenegraph redraw does) surface as
 * uncaught exceptions; collect them so the spec that caused them is reported instead of the whole run dying.
 */
export const stray: string[] = []
process.on('uncaughtException', (e) => { stray.push(e instanceof Error ? e.message : String(e)) })
process.on('unhandledRejection', (e) => { stray.push(e instanceof Error ? e.message : String(e)) })
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export async function vegaSvg(spec: Record<string, unknown>): Promise<string> {
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
  try {
    await view.runAsync()
    view.finalize() // the first frame: no timer tick between the run and the serialisation
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

