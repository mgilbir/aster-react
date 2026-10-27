/**
 * Fetch the official Vega / Vega-Lite example galleries into the gitignored cache `packages/conformance/.gallery/`.
 *
 *   pnpm --filter @aster/conformance gallery:fetch              download what is missing, verify everything
 *   pnpm --filter @aster/conformance gallery:fetch -- --verify  verify only (no network)
 *   pnpm --filter @aster/conformance gallery:fetch -- --regenerate   rebuild gallery/manifest.json from the pinned commits
 *
 * The galleries are NOT committed. `gallery/manifest.json` pins each source by tag AND commit SHA and lists every file with its
 * sha256; files are downloaded from raw.githubusercontent.com at the COMMIT (a tag can move, a SHA cannot) and checked against the
 * manifest. Any mismatch fails the run (the bad file is removed). Idempotent: a file already present with the right hash is skipped.
 *
 * `--regenerate` is for a maintainer bumping the pins (edit `sources[*].tag/commit` first): it lists the examples directory of the
 * pinned commit through the GitHub trees API, downloads the files and rewrites the hashes. A normal fetch never needs the API.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_DIR, MANIFEST_PATH, sha256, verifyCache, type Manifest, type Source } from '../src/gallery/cache.js'

const raw = (s: Source, path: string): string => `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${path}`

async function download(url: string): Promise<Uint8Array> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) return new Uint8Array(await res.arrayBuffer())
      last = new Error(`${res.status} ${res.statusText}`)
      if (res.status === 404) break
    } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  throw new Error(`${url}: ${last instanceof Error ? last.message : String(last)}`)
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: n }, async () => { for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x) }))
}

async function fetchAll(manifest: Manifest): Promise<void> {
  for (const s of Object.values(manifest.sources)) {
    const dir = join(CACHE_DIR, s.cacheDir)
    mkdirSync(dir, { recursive: true })
    const want: Array<[string, string, string]> = [['LICENSE', 'LICENSE', s.licenseSha256], ...Object.entries(s.files).map(([n, h]) => [n, `${s.upstreamDir}/${n}`, h] as [string, string, string])]
    let fetched = 0
    await pool(want, 16, async ([name, upstream, hash]) => {
      const p = join(dir, name)
      if (existsSync(p) && sha256(readFileSync(p)) === hash) return
      const body = await download(raw(s, upstream))
      if (sha256(body) !== hash) {
        rmSync(p, { force: true })
        throw new Error(`checksum mismatch for ${s.repo}@${s.commit.slice(0, 8)} ${upstream}: got ${sha256(body)}, manifest says ${hash}`)
      }
      writeFileSync(p, body)
      fetched++
    })
    console.log(`[gallery:fetch] ${s.cacheDir}: ${want.length} files verified (${fetched} downloaded) from ${s.repo}@${s.tag} (${s.commit.slice(0, 8)})`)
  }
}

async function regenerate(manifest: Manifest): Promise<void> {
  for (const s of Object.values(manifest.sources)) {
    const res = await fetch(`https://api.github.com/repos/${s.repo}/git/trees/${s.commit}?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'aster-gallery-fetch' } })
    if (!res.ok) throw new Error(`tree listing of ${s.repo}@${s.commit}: ${res.status}`)
    const tree = (await res.json()) as { truncated: boolean; tree: Array<{ path: string; type: string }> }
    if (tree.truncated) throw new Error('GitHub truncated the tree listing; list the directory another way')
    const prefix = `${s.upstreamDir}/`
    const names = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/') && e.path.endsWith(s.suffix)).map((e) => e.path.slice(prefix.length)).sort()
    const files: Record<string, string> = {}
    await pool(names, 16, async (n) => { files[n] = sha256(await download(raw(s, `${s.upstreamDir}/${n}`))) })
    s.files = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
    s.licenseSha256 = sha256(await download(raw(s, 'LICENSE')))
    console.log(`[gallery:fetch] ${s.cacheDir}: ${names.length} files listed at ${s.commit.slice(0, 8)}`)
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  const flags = process.argv.slice(2)
  try {
    if (flags.includes('--regenerate')) await regenerate(manifest)
    else if (!flags.includes('--verify')) await fetchAll(manifest)
    const problems = verifyCache(manifest)
    if (problems.length && !flags.includes('--regenerate')) {
      console.error(`[gallery:fetch] cache does not match the manifest:\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  ... ${problems.length} problems` : ''}`)
      process.exit(1)
    }
    console.log('[gallery:fetch] ok')
  } catch (e) {
    console.error(`[gallery:fetch] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
