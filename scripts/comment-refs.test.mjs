/**
 * A comment that points at a file of this repository must point at a file that exists.
 *
 * Renaming or deleting a file leaves its name in the comments of other files (`signal-dataflow.ts`, `Chart.matrix.test.tsx`,
 * `testdata/vectors/vega-transforms.json` were all dead references in comments of source files). Links in the markdown docs are checked by
 * docs tests; this holds the comments of the tracked, non-test source and script files to the same standard.
 *
 * What counts as a reference: a token in a comment (`//`, `/* *\/`, JSDoc; found with the TypeScript parser, so a `//` inside a string or
 * a template literal is not a comment) that looks like a file name with one of the extensions below, with any directories before it.
 * It resolves when it is a tracked file, relative to the repository root or to the commenting file, or an abbreviation of one
 * (`src/x.ts`, `core/pointer.ts`: the directories appear in that order in the path of a tracked file with that name), or a bare file
 * name that exists anywhere in the repository. `.js` resolves to the `.ts`/`.tsx`/`.mts` it is imported as. Paths into `dist/` are build
 * output and are not checked.
 *
 * What does not count, so the check has no false positives:
 *   - URLs;
 *   - citations of the upstream projects this repository reimplements (`vega-scenegraph/src/path/curves.js`, `marks/text.js`,
 *     `util/aria.js`, vega-lite's `compile/facet.ts`): a token that is not a repository file but names a file of an installed vega,
 *     vega-lite, d3 or topojson package (found under node_modules; `.js` and `.ts` are the same name), starts with the name of one of
 *     those packages, or starts with a directory of their sources (`marks/`, `compile/`, `normalize/`) is a citation;
 *   - globs and placeholders (`*.test.ts`, `<name>.json`), a bare suffix (`.test.mts`, `-cases.mjs`);
 *   - files a command writes, and examples of a name that is not meant to exist: PRODUCED below, each with its reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Names that appear in comments and are not (tracked) repository files. Every entry says why. */
const PRODUCED = new Map([
  ['sel-vega.svg', 'written by browser-vl-selections.mts under SEL_DUMP'],
  ['sel-aster.svg', 'written by browser-vl-selections.mts under SEL_DUMP'],
  ['sel-vega-fresh.svg', 'written by browser-vl-selections.mts under SEL_DUMP'],
  ['gate-results.json', 'the --json output of conformance:gallery, an argument of gallery-triage.mts'],
  ['out.json', 'the output argument of gallery-triage.mts'],
  ['app.mjs', 'the entry file name check-bundle-shaking.mjs gives the app it bundles'],
  ['science.js', 'the science.js library (curve-fits.ts says what the fits are ported from), not a file'],
  ['d3-geo.json', 'historical: the vectors gen-vectors.mjs used to record before the differential became live (d3-geo-cases.mjs)'],
  ['d3-shape.json', 'historical, as d3-geo.json (d3-shape-cases.mjs)'],
  ['vega-expression.json', 'historical, as d3-geo.json (vega-expression-cases.mjs)'],
  ['vega-scale.json', 'historical, as d3-geo.json (vega-scale-cases.mjs)'],
])

const SOURCE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/
const NOT_SCANNED = /\.test\.|\.testlib\.|\.testkit\.|\.d\.[cm]?ts$|(?:^|\/)(?:test|test-fixtures|type-fixtures|corpus[\w-]*|gallery|testdata)\//
const EXT = 'ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|txt|svg|css|html'
const REFERENCE = new RegExp(String.raw`(?<![\w@/:-])(?<![\w@/:-]\.)((?:\.{1,2}\/)*(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:${EXT}))(?![\w-])`, 'g')
const UPSTREAM_PACKAGE = /^(?:vega|d3|topojson)(?:-|$)/
/** Directories of an upstream package that say nothing about which project a path belongs to. */
const GENERIC_DIRS = new Set(['src', 'build', 'test', 'tests', 'docs', 'bin', 'lib', 'dist', 'scripts', 'types', 'examples'])

function scriptKind(file) {
  if (file.endsWith('x')) return file.endsWith('jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

/** Every comment of a source text: `{ text, line }`. */
export function commentsOf(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file))
  const found = new Map()
  const take = (ranges) => { for (const r of ranges ?? []) found.set(r.pos, r) }
  const visit = (node) => {
    take(ts.getLeadingCommentRanges(text, node.pos))
    take(ts.getTrailingCommentRanges(text, node.end))
    node.forEachChild(visit)
  }
  visit(sf)
  take(ts.getLeadingCommentRanges(text, sf.endOfFileToken.pos))
  return [...found.values()].map((r) => ({ text: text.slice(r.pos, r.end), line: text.slice(0, r.pos).split('\n').length }))
}

/**
 * The dead references of `sources` (`{ file, text }`), as `file:line  reference` strings.
 * @param {{ files: string[], upstream: (ref: string) => boolean, sources: { file: string, text: string }[] }} input
 */
export function deadReferences({ files, upstream, sources }) {
  const tracked = new Set(files)
  const byName = new Map()
  for (const f of files) { const n = f.split('/').pop(); byName.set(n, [...(byName.get(n) ?? []), f]) }
  const asSources = (p) => (p.endsWith('.js') ? [p, p.replace(/\.js$/, '.ts'), p.replace(/\.js$/, '.tsx'), p.replace(/\.js$/, '.mts')] : [p])
  const abbreviation = (p) => {
    const segments = p.split('/')
    const name = segments.pop()
    return (byName.get(name) ?? []).some((f) => {
      let at = 0
      for (const seg of segments) { at = f.split('/').indexOf(seg, at) + 1; if (at === 0) return false }
      return true
    })
  }
  /** The references of `text` (a comment, or a whole file as a cheap first look) that name no file of the repository. */
  const unresolved = (file, text) => {
    const dir = posix.dirname(file)
    const out = []
    for (const m of text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').matchAll(REFERENCE)) {
      const ref = m[1]
      if (/[*<>{}]/.test(ref) || /^[.-]/.test(ref.split('/').pop()) || PRODUCED.has(ref) || /(?:^|\/)dist\//.test(ref)) continue
      const resolves = /^\.{1,2}\//.test(ref)
        ? asSources(posix.normalize(posix.join(dir, ref))).some((p) => tracked.has(p))
        : ref.includes('/')
          ? asSources(ref).some((p) => tracked.has(p) || abbreviation(p))
          : asSources(ref).some((p) => byName.has(p))
      if (!resolves) out.push(ref)
    }
    return out
  }
  const dead = []
  for (const { file, text } of sources) {
    // Parsing is the slow part: a file whose every file-like token (code, strings and comments alike) resolves has no dead reference.
    if (unresolved(file, text).length === 0) continue
    for (const comment of commentsOf(file, text)) {
      for (const ref of unresolved(file, comment.text)) {
        if (!upstream(ref)) dead.push(`${file}:${comment.line}  ${ref}`)
      }
    }
  }
  return dead
}

/** A predicate: is this token a file of an installed vega, vega-lite, d3 or topojson package? (Built on first use: the walk is the slow part, and most runs never ask.) */
function upstreamFiles() {
  const paths = new Set()
  const names = new Set()
  const topDirs = new Set()
  const store = join(ROOT, 'node_modules', '.pnpm')
  const walk = (dir, rel, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      if (e.isDirectory()) { if (depth < 8) walk(join(dir, e.name), `${rel}${e.name}/`, depth + 1) } else { paths.add(rel + e.name); names.add(e.name) }
      if (e.isDirectory() && /^[^/]+\/src\/$/.test(rel)) topDirs.add(e.name)
    }
  }
  if (!existsSync(store)) return () => false
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const name of readdirSync(modules)) {
      if (!UPSTREAM_PACKAGE.test(name)) continue
      walk(join(modules, name), `${name}/`, 0)
    }
  }
  const tails = new Set()
  for (const p of paths) {
    const parts = p.split('/')
    for (let i = 0; i < parts.length; i++) tails.add(parts.slice(i).join('/'))
  }
  const sameName = (r) => (/\.[jt]sx?$/.test(r) ? [r, r.replace(/\.[jt]sx?$/, '.js'), r.replace(/\.[jt]sx?$/, '.ts')] : [r])
  return (ref) => {
    const stripped = ref.replace(/^(?:\.\.?\/)+/, '')
    if (!stripped.includes('/')) return sameName(stripped).some((r) => names.has(r))
    const first = stripped.split('/')[0]
    return UPSTREAM_PACKAGE.test(first) || (topDirs.has(first) && !GENERIC_DIRS.has(first)) || sameName(stripped).some((r) => tails.has(r))
  }
}

describe('comment references', { timeout: 60_000 }, () => {
  it('every file a comment of a source or script file names exists', async () => {
    const r = await spawnAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    const files = r.stdout.split('\n').filter(Boolean).filter((f) => existsSync(join(ROOT, f)))
    const sources = files.filter((f) => SOURCE.test(f) && !NOT_SCANNED.test(f)).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))
    expect(sources.length, 'the scan found the sources').toBeGreaterThan(200)
    let upstream
    const dead = deadReferences({ files, upstream: (ref) => (upstream ??= upstreamFiles())(ref), sources })
    expect(dead, `comments name files that do not exist (renamed or deleted?):\n  ${dead.join('\n  ')}\n`).toEqual([])
  })

  describe('the matcher', () => {
    const files = ['packages/core/src/runtime.ts', 'packages/react/src/pointer.ts', '.github/workflows/ci.yml', 'packages/core/src/dom.test.mts', 'packages/core/src/util.ts', 'scripts/gates.mjs', 'docs/TESTING.md']
    const upstream = (ref) => ref === 'marks/text.js' || ref === 'vega-scenegraph/src/path/curves.js'
    const dead = (text, file = 'packages/core/src/runtime.ts') => deadReferences({ files, upstream, sources: [{ file, text }] }).map((d) => d.split('  ')[1])

    it('reports a bare name, a rooted path and a package-relative path that do not exist', () => {
      expect(dead('// see signal-dataflow.ts')).toEqual(['signal-dataflow.ts'])
      expect(dead('/** the suite in\n * testdata/vectors/vega-transforms.json and packages/core/src/gone.ts */')).toEqual(['testdata/vectors/vega-transforms.json', 'packages/core/src/gone.ts'])
      expect(dead('const x = 1 // dom-string-parity.test.ts (it is .test.mts)')).toEqual(['dom-string-parity.test.ts'])
    })

    it('accepts files that exist: a bare name, a path tail, a path from the root, a relative path, .js for .ts, an extensionless tail', () => {
      expect(dead('// runtime.ts, src/util.ts, packages/core/src/util.ts, ./util.js, scripts/gates.mjs, docs/TESTING.md, dom.test.mts, .github/workflows/ci.yml')).toEqual([])
      expect(dead('// react/pointer.ts is an abbreviation, core/pointer.ts is not (wrong package)')).toEqual(['core/pointer.ts'])
      expect(dead('// ../src/util.ts', 'packages/core/test/a.ts')).toEqual([])
    })

    it('does not read code, strings, URLs, globs, suffixes or upstream citations as references', () => {
      expect(dead("const s = 'gone.ts' // fine\nconst t = `// gone.ts`")).toEqual([])
      expect(dead('// https://github.com/vega/vega/blob/main/packages/vega-scenegraph/src/gone.js and https://x.org/gone.ts')).toEqual([])
      expect(dead('// *.test.ts, <name>.json, {a,b}.ts, .test.mts, -cases.mjs')).toEqual([])
      expect(dead('// ported from marks/text.js and vega-scenegraph/src/path/curves.js')).toEqual([])
    })

    it('resolves a relative path against the commenting file, not the root', () => {
      expect(dead('// ./util.ts', 'scripts/gates.mjs')).toEqual(['./util.ts'])
    })
  })
})
