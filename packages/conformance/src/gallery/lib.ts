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

/** The vega-datasets version the gallery's data is pinned to (gallery/manifest.json `vegaDatasets`, the installed package). */
export const PINNED_DATASETS: string = (JSON.parse(readFileSync(join(GALLERY_DIR, 'manifest.json'), 'utf8')) as { vegaDatasets: string }).vegaDatasets

/** What a gallery URL names: the vendored file, and the vega-datasets version a jsDelivr URL asks for (null: none stated). */
export interface GalleryData { file: string; version: string | null }

/**
 * What a gallery URL resolves to on disk, or null when it is not one the galleries use: `data/x.csv` against the base URL
 * (the gallery's own copy of vega-datasets), or `cdn.jsdelivr.net/npm/vega-datasets[@<version>]/data/x.csv` -- that package and
 * no other. Both are served from the PINNED vega-datasets; a URL that asks for another version is served the pinned bytes too,
 * and `version` says which it asked for, so the run can record that the spec was compared on other bytes than it names (see
 * `datasetVersionMismatches`). A path that does not decode (a malformed `%` escape) is not a gallery URL.
 */
export function galleryDataFor(rawUrl: string): GalleryData | null {
  let u: URL
  try { u = new URL(rawUrl, BASE_URL) } catch { return null }
  let path: string
  try { path = decodeURIComponent(u.pathname) } catch { return null }
  let name: string
  let version: string | null = null
  if (u.hostname === 'gallery.invalid') {
    const m = /^\/data\/([^/]+)$/.exec(path)
    if (!m) return null
    name = m[1]!
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    const m = /^\/npm\/vega-datasets(?:@([^/]+))?\/data\/([^/]+)$/.exec(path)
    if (!m) return null
    version = m[1] ?? null
    name = m[2]!
  } else return null
  const file = join(DATASETS_DIR, name)
  return existsSync(file) ? { file, version } : null
}

/** The file a gallery URL resolves to (see `galleryDataFor`), or null. */
export function localFileFor(rawUrl: string): string | null {
  return galleryDataFor(rawUrl)?.file ?? null
}

/** The data URLs of a spec that ask for a vega-datasets version other than the pinned one (they are served the pinned bytes). */
export function datasetVersionMismatches(spec: unknown): string[] {
  return dataUrlsIn(spec).filter((url) => {
    const v = galleryDataFor(url)?.version
    return v != null && v.replace(/^v/, '') !== PINNED_DATASETS
  })
}

/**
 * Every gallery data URL a spec names (absolute, in the form the page fetches): any string of the spec that
 * {@link localFileFor} resolves to a vendored file. The React path preloads these into the page before the spec runs.
 */
export function dataUrlsIn(spec: unknown): string[] {
  const found = new Set<string>()
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!v.includes('data/') || /\s/.test(v)) return
      try {
        const abs = new URL(v, BASE_URL).href
        if (localFileFor(abs) !== null) found.add(abs)
      } catch { /* not a URL */ }
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  visit(spec)
  return [...found].sort()
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

/**
 * Whether what vega logged says it needed a canvas Node does not have: a null canvas surfaces as `Cannot set properties of null` or
 * `reading 'getContext'`, from a function called getContext. The message and the names of the functions on the stack are read,
 * never where those functions live: a checkout whose path holds the word "canvas" (a worktree named after it) must not turn every
 * oracle error into one.
 */
export function needsCanvas(message: string): boolean {
  const withoutLocations = message
    .split('\n')
    // (a frame `at name (location)` keeps its name; a frame `at location` has none)
    .map((line) => (/^\s*at\s/.test(line) ? line.replace(/\s*\(.*\)\s*$/, '').replace(/^\s*at\s+(?:async\s+)?(?:file:|node:|\/|[A-Za-z]:\\).*$/, '') : line))
    .join('\n')
  return /getContext|canvas/i.test(withoutLocations)
}

/**
 * The passing list a run may record, given the list recorded before and what passed now: a run in which a listed spec no longer
 * passes records nothing (`write` null), so a regression can never become the baseline.
 */
export function nextPassingList(listed: readonly string[], passed: ReadonlySet<string>): { regressed: string[]; write: string[] | null } {
  const regressed = listed.filter((id) => !passed.has(id))
  return { regressed, write: regressed.length ? null : [...passed].sort() }
}
