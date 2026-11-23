/**
 * The gallery ratchet files against their own history (C262, C525). The comparison is pure and tested on snapshots; the last block reads
 * the files at the base revision from git and fails when this change weakens any of them. (The PR CI does not run the gallery: this is
 * what it runs of the ratchet.)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GALLERY_DIR } from './lib.js'
import { duplicateSpecs, parseLines, ratchetProblems, type RatchetOverride, type RatchetSnapshot } from './ratchet.js'

const snapshot = (): RatchetSnapshot => ({
  floors: {
    pass: { static: { vega: 2, vl: 3 }, react: { vega: 2, vl: 3 } },
    maxUnverifiable: { static: { vega: 1, vl: 0 }, react: { vega: 0, vl: 0 } },
    swap: { minRunnable: 2, maxUnverifiable: 0 },
  },
  passing: { static: ['vega/a', 'vega/b', 'vl/c'], react: ['vega/a', 'vl/c'] },
  swapPairs: ['vega/a => vl/c', 'vega/b => vl/c'],
  manifest: { sources: {
    vega: { repo: 'vega/vega', tag: 'v6', commit: 'aaa', upstreamDir: 'd', suffix: '.vg.json', cacheDir: 'vega', licenseSha256: 'x', files: { 'a.vg.json': '1', 'b.vg.json': '2' } },
    'vega-lite': { repo: 'vega/vega-lite', tag: 'v6', commit: 'bbb', upstreamDir: 'd', suffix: '.vl.json', cacheDir: 'vl', licenseSha256: 'y', files: { 'c.vl.json': '3' } },
  } },
})
const edit = (f: (s: RatchetSnapshot) => void): RatchetSnapshot => { const s = snapshot(); f(s); return s }

describe('ratchetProblems', () => {
  it('holds for an unchanged snapshot and for one that only improves', () => {
    expect(ratchetProblems(snapshot(), snapshot())).toEqual([])
    const better = edit((s) => {
      s.floors.pass.static!.vega = 3
      s.floors.maxUnverifiable.static!.vega = 0
      s.passing.static = [...s.passing.static!, 'vega/new']
      s.manifest.sources.vega!.files['new.vg.json'] = '9'
    })
    expect(ratchetProblems(snapshot(), better)).toEqual([])
  })

  it.each([
    ['a floor lowered', (s: RatchetSnapshot) => { s.floors.pass.static!.vl = 1 }, /floors\.pass\.static\.vl: the floor went from 3 to 1/],
    ['a ceiling of unverifiable specs raised', (s: RatchetSnapshot) => { s.floors.maxUnverifiable.react!.vega = 5 }, /maxUnverifiable\.react\.vega: .* from 0 to 5/],
    ['a passing id deleted', (s: RatchetSnapshot) => { s.passing.static = ['vega/a', 'vl/c'] }, /passing\.static: 1 spec\(s\) left .* vega\/b/],
    ['a floor deleted with its path', (s: RatchetSnapshot) => { delete s.floors.pass.react }, /floors\.pass\.react\.vega/],
    ['the swap floor lowered', (s: RatchetSnapshot) => { s.floors.swap.minRunnable = 1 }, /floors\.swap\.minRunnable: went from 2 to 1/],
    ['a swap pair deleted with its floor lowered', (s: RatchetSnapshot) => { s.swapPairs = ['vega/a => vl/c']; s.floors.swap.minRunnable = 1 }, /swapPairs: 1 committed pair/],
    ['a swap pair added and the floor left behind', (s: RatchetSnapshot) => { s.swapPairs = [...s.swapPairs, 'vega/b => vl/c2'] }, /3 pairs are committed and 2 must run/],
    ['a manifest file count that shrank', (s: RatchetSnapshot) => { delete s.manifest.sources.vega!.files['b.vg.json'] }, /manifest\.vega\.files: 2 spec files became 1/],
    ['a source dropped', (s: RatchetSnapshot) => { delete s.manifest.sources['vega-lite'] }, /manifest\.vega-lite: the source left/],
    ['another repo', (s: RatchetSnapshot) => { s.manifest.sources.vega!.repo = 'someone/else' }, /manifest\.vega\.repo: moved from vega\/vega to someone\/else/],
    ['another commit', (s: RatchetSnapshot) => { s.manifest.sources.vega!.commit = 'ccc' }, /manifest\.vega\.commit: moved from aaa to ccc/],
    ['a spec file with another hash', (s: RatchetSnapshot) => { s.manifest.sources.vega!.files['a.vg.json'] = 'changed' }, /manifest\.vega\.hashes: 1 spec file/],
  ])('refuses %s', (_name, change, message) => {
    const problems = ratchetProblems(snapshot(), edit(change))
    expect(problems.join('\n')).toMatch(message)
  })

  it('an override covers the one change it names, with a reason, and nothing else', () => {
    const lowered = edit((s) => { s.floors.pass.static!.vl = 1 })
    const override: RatchetOverride = { field: 'floors.pass.static.vl', to: 1, reason: 'three specs left the gallery at the new pinned commit' }
    expect(ratchetProblems(snapshot(), lowered, [override])).toEqual([])
    expect(ratchetProblems(snapshot(), edit((s) => { s.floors.pass.static!.vl = 0 }), [override])).not.toEqual([])
    expect(ratchetProblems(snapshot(), edit((s) => { s.floors.pass.static!.vega = 1 }), [override])).not.toEqual([])
    expect(ratchetProblems(snapshot(), lowered, [{ ...override, reason: 'ok' }])).not.toEqual([])
  })
})

describe('the manifest is the gallery the oracle is pinned to (C262)', () => {
  const manifest = JSON.parse(readFileSync(join(GALLERY_DIR, 'manifest.json'), 'utf8')) as RatchetSnapshot['manifest']
  const pinned = (name: string): string => (JSON.parse(readFileSync(join(GALLERY_DIR, '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }).dependencies?.[name] ?? ''

  it.each([['vega', 'vega/vega'], ['vega-lite', 'vega/vega-lite']])('%s: the repo is %s and the tag is the version the oracle package is pinned to', (name, repo) => {
    const source = manifest.sources[name]!
    expect(source.repo).toBe(repo)
    expect(pinned(name)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(source.tag).toBe(`v${pinned(name)}`)
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('byte-identical specs count twice (C525)', () => {
  it('finds the groups the manifest hashes name', () => {
    const s = snapshot()
    s.manifest.sources.vega!.files['b.vg.json'] = '1'
    expect(duplicateSpecs(s.manifest)).toEqual([['vega/a.vg.json', 'vega/b.vg.json']])
    expect(duplicateSpecs(snapshot().manifest)).toEqual([])
  })

  it('the committed manifest has exactly the three known pairs: a new duplicate is a spec the denominator counts twice', () => {
    const manifest = JSON.parse(readFileSync(join(GALLERY_DIR, 'manifest.json'), 'utf8')) as RatchetSnapshot['manifest']
    expect(duplicateSpecs(manifest)).toEqual([
      ['vega-lite/selection_filter.vl.json', 'vega-lite/selection_filter_true.vl.json'],
      ['vega-lite/selection_translate_brush_drag.vl.json', 'vega-lite/selection_zoom_brush_wheel.vl.json'],
      ['vega-lite/selection_translate_scatterplot_drag.vl.json', 'vega-lite/selection_zoom_scatterplot_wheel.vl.json'],
    ])
  })
})

// --- this change against the base -------------------------------------------------------------------------------------------

const REPO = join(GALLERY_DIR, '..', '..', '..')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (...args: string[]): string | null => { try { return git(...args) } catch { return null } }

/**
 * The revision this change is compared with: `ASTER_RATCHET_BASE` if set; else where this branch left origin/main (or main); else the
 * first parent (a merge commit, which is what a PR's CI checks out, and a push to main, whose first parent is the previous main).
 */
function baseRevision(): string | null {
  const head = tryGit('rev-parse', 'HEAD')
  if (process.env.ASTER_RATCHET_BASE) return tryGit('rev-parse', '--verify', `${process.env.ASTER_RATCHET_BASE}^{commit}`)
  for (const ref of ['origin/main', 'main']) {
    const base = tryGit('merge-base', 'HEAD', ref)
    if (base && base !== head) return base
  }
  return tryGit('rev-parse', '--verify', 'HEAD^1^{commit}')
}

function snapshotAt(rev: string | null): RatchetSnapshot {
  const read = (file: string): string => (rev === null ? readFileSync(join(GALLERY_DIR, file), 'utf8') : git('show', `${rev}:packages/conformance/gallery/${file}`))
  return {
    floors: JSON.parse(read('floors.json')) as RatchetSnapshot['floors'],
    passing: { static: parseLines(read('passing-static.txt')), react: parseLines(read('passing-react.txt')) },
    swapPairs: parseLines(read('swap-pairs.txt')),
    manifest: JSON.parse(read('manifest.json')) as RatchetSnapshot['manifest'],
  }
}

describe('this change keeps the gallery ratchet files where the base had them', () => {
  const base = baseRevision()

  it('has a base revision to compare with (a checkout with no history cannot show a lowered floor: fetch-depth 2 is enough)', () => {
    expect(base, 'no base revision: neither origin/main, main nor HEAD^1 exists in this checkout').not.toBeNull()
  })

  it('floors only up, ceilings only down, no passing id gone, no spec file gone, the same repo and commit', () => {
    expect(base).not.toBeNull()
    const overrides = JSON.parse(readFileSync(join(GALLERY_DIR, 'ratchet-overrides.json'), 'utf8')) as RatchetOverride[]
    expect(ratchetProblems(snapshotAt(base), snapshotAt(null), overrides)).toEqual([])
  })

  it('the overrides file is a list, and every override is still needed', () => {
    const overrides = JSON.parse(readFileSync(join(GALLERY_DIR, 'ratchet-overrides.json'), 'utf8')) as RatchetOverride[]
    expect(Array.isArray(overrides)).toBe(true)
    for (const o of overrides) {
      expect(ratchetProblems(snapshotAt(base), snapshotAt(null), []).join('\n'), `override ${o.field} -> ${o.to} covers no change: drop it`).toContain(o.field)
    }
  })

  it('the swap floor is the pair count (a skipped pair is an eroded sample)', () => {
    const now = snapshotAt(null)
    expect(now.floors.swap.minRunnable).toBe(now.swapPairs.length)
  })
})
