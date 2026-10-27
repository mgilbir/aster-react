/**
 * The gallery cache (`packages/conformance/.gallery/`, gitignored) and its manifest (`gallery/manifest.json`, committed):
 * paths, the manifest shape and the verification the gate runs before it reads a single spec.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONF = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MANIFEST_PATH = join(CONF, 'gallery', 'manifest.json')
export const CACHE_DIR = join(CONF, '.gallery')
export const FETCH_COMMAND = 'pnpm --filter @aster/conformance gallery:fetch'

export interface Source {
  repo: string
  tag: string
  commit: string
  /** directory of the examples inside the repository */
  upstreamDir: string
  /** only files with this suffix are part of the gallery (Vega-Lite's `normalized/` subdirectory is never listed) */
  suffix: string
  /** sub-directory of the cache */
  cacheDir: string
  /** sha256 of the repository's LICENSE at the commit; stored as `<cacheDir>/LICENSE` */
  licenseSha256: string
  files: Record<string, string>
}
export interface Manifest {
  note: string
  vegaDatasets: string
  sources: Record<string, Source>
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
}

/** Hashes of what is in the cache against the manifest; returns the problems (empty = verified). Reads no network. */
export function verifyCache(manifest: Manifest): string[] {
  const problems: string[] = []
  for (const s of Object.values(manifest.sources)) {
    const dir = join(CACHE_DIR, s.cacheDir)
    const want = new Map<string, string>([['LICENSE', s.licenseSha256], ...Object.entries(s.files)])
    for (const [name, hash] of want) {
      const p = join(dir, name)
      if (!existsSync(p)) { problems.push(`missing ${s.cacheDir}/${name}`); continue }
      if (sha256(readFileSync(p)) !== hash) problems.push(`checksum mismatch ${s.cacheDir}/${name}`)
    }
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (!want.has(f)) problems.push(`unexpected ${s.cacheDir}/${f} (not in the manifest)`)
  }
  return problems
}
