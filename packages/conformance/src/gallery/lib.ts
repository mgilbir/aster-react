/**
 * Shared pieces of the official-gallery gate (see ../../gallery/README.md): the vendored spec lists, the offline
 * data resolver that BOTH engines load from, and the outcome vocabulary.
 *
 * No network: every `url` the galleries use is `data/<file>` (relative to the gallery root) or the jsDelivr copy of
 * a vega-datasets file. Both resolve to the pinned `vega-datasets` package in node_modules.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_DIR } from './cache.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GALLERY_DIR = join(HERE, '..', '..', 'gallery')

export const DATASETS_DIR = join(HERE, '..', '..', 'node_modules', 'vega-datasets', 'data')

/** The base URL every relative `url` resolves against, in both engines and in the browser page. */
export const BASE_URL = 'https://gallery.invalid/'

export type Kind = 'vega' | 'vl'
export interface GallerySpec {
  /** `vega/<name>` or `vl/<name>` */
  id: string
  kind: Kind
  name: string
  file: string
}

export function listGallery(): GallerySpec[] {
  const out: GallerySpec[] = []
  for (const [dir, kind, suffix] of [['vega', 'vega', '.vg.json'], ['vega-lite', 'vl', '.vl.json']] as const) {
    const d = join(CACHE_DIR, dir)
    for (const f of readdirSync(d).sort()) {
      if (!f.endsWith(suffix)) continue
      const name = f.slice(0, -suffix.length)
      out.push({ id: `${kind}/${name}`, kind, name, file: join(d, f) })
    }
  }
  return out
}

export function readSpec(s: GallerySpec): Record<string, unknown> {
  return JSON.parse(readFileSync(s.file, 'utf8')) as Record<string, unknown>
}

/**
 * Where a gallery URL lives on disk, or null when it is not one the galleries use. `data/x.csv` against the base URL
 * and `cdn.jsdelivr.net/npm/vega-datasets@<v>/data/x.csv` both mean the file `x.csv` of the pinned vega-datasets.
 */
export function localFileFor(rawUrl: string): string | null {
  let u: URL
  try { u = new URL(rawUrl, BASE_URL) } catch { return null }
  const okHost = u.hostname === 'gallery.invalid' || u.hostname === 'cdn.jsdelivr.net'
  if (!okHost) return null
  const m = /(?:^|\/)data\/([^/]+)$/.exec(decodeURIComponent(u.pathname))
  if (!m) return null
  const file = join(DATASETS_DIR, m[1]!)
  return existsSync(file) ? file : null
}

/** A `fetch` that serves the gallery data from disk (404 for anything else): no network at test time. */
export const fileFetch: typeof globalThis['fetch'] = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  const file = localFileFor(url)
  if (file === null) return new Response('not a gallery url', { status: 404, statusText: 'Not Found' })
  return new Response(new Uint8Array(readFileSync(file)), { status: 200 })
}

export type Status = 'pass' | 'fail' | 'error' | 'unverifiable'
export interface Outcome {
  id: string
  status: Status
  /** why a spec is unverifiable / what category an error is */
  reason?: string
  /** the first diff (or error message) */
  first?: string
  /** the first diff that is not the root size line (triage aid; the gate itself compares everything) */
  firstContent?: string
  /** number of diff lines (the canonical diff caps its own lists) */
  diffs?: number
  ms: number
}

export const trunc = (s: string, n = 240): string => (s.length > n ? s.slice(0, n) + '...' : s)
export { basename }
