/**
 * What the architecture documents say about the code is tied to the code (audit a30: C82-C85, C372-C378, C447-C454, C728-C731).
 *
 * Each block states a claim a reader relies on and computes it from the sources, the manifests or the gate tables, so a change that
 * makes it false fails here instead of leaving a document that sends a reader somewhere wrong. A check that has never been seen to fail
 * proves nothing: every block ends with a plant (a doc or a source made wrong in memory) that the check must report.
 *
 * Needs `pnpm build` only for the budget rows (they are data modules read directly); the rest reads text.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXPECTED_DIFFERENCES } from './lib/expected-differences.mjs'
import { ENTRIES } from '../packages/benchmarks/scripts/budget-rows.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const manifest = (pkg) => JSON.parse(read(`packages/${pkg}/package.json`))
const ARCH = read('docs/ARCHITECTURE.md')
const ADR_DIR = 'docs/adr'

/** The text of the `## <heading>` section of a markdown document (to the next `## `). */
const section = (md, heading) => {
  const i = md.indexOf(`\n## ${heading}`)
  if (i < 0) throw new Error(`no section "${heading}"`)
  const j = md.indexOf('\n## ', i + 4)
  return md.slice(i, j < 0 ? undefined : j)
}

describe('the ADR index lists every record, and the records say what holds (C84, C374)', () => {
  const files = readdirSync(join(root, ADR_DIR)).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort()
  const index = read(`${ADR_DIR}/README.md`)

  it('every record has a row of the index and every row names a record', () => {
    const listed = [...index.matchAll(/^\| \[(\d{4}-[\w-]+)\]\(([\w-]+\.md)\)/gm)].map((m) => m[2]).sort()
    expect(listed).toEqual(files)
  })

  it('the first paint is not said to be synchronous without the condition: no document asserts "Nothing loads asynchronously"', () => {
    for (const f of ['docs/ARCHITECTURE.md', 'docs/API.md', 'README.md', 'packages/react/README.md', `${ADR_DIR}/0007-svgchart-shell-over-lazy-loading.md`]) {
      const text = read(f)
      // (ADR 0007's amendment quotes the old clause as the thing that no longer holds; its Decision does not assert it)
      const asserted = f.endsWith('0007-svgchart-shell-over-lazy-loading.md') ? text.slice(0, text.indexOf('## Amendments')) : text
      expect(asserted, f).not.toMatch(/Nothing loads asynchronously/)
    }
  })

  it('the engine-parts decision has its record, and the records and ARCHITECTURE point at it', () => {
    const adr = read(`${ADR_DIR}/0011-engine-parts-load-on-demand-in-browser-builds.md`)
    expect(adr).toMatch(/first paint is synchronous only where nothing needs loading/)
    for (const f of [`${ADR_DIR}/0003-ssr-async-worker.md`, `${ADR_DIR}/0007-svgchart-shell-over-lazy-loading.md`, `${ADR_DIR}/0008-addons-load-themselves-through-suspense.md`, 'docs/ARCHITECTURE.md']) {
      expect(read(f), f).toContain('0011-engine-parts-load-on-demand-in-browser-builds')
    }
  })

  it('ADR 0004 lists the entry points that no budget row imports, exactly', () => {
    const rowText = ENTRIES.map((e) => e.src).join('\n')
    const unimported = []
    for (const pkg of ['core', 'react', 'vl']) {
      const m = manifest(pkg)
      for (const key of Object.keys(m.exports)) {
        if (key === './package.json') continue
        const spec = key === '.' ? m.name : `${m.name}${key.slice(1)}`
        if (!rowText.includes(`'${spec}'`)) unimported.push(spec)
      }
    }
    const adr = read(`${ADR_DIR}/0004-release-and-provenance.md`)
    const stated = /Entry points that no row imports: ([^\n]+(?:\n  [^\n]+)*)\./.exec(adr)?.[1] ?? ''
    const named = [...stated.matchAll(/`(@aster-charts\/[\w/-]+)`/g)].map((x) => x[1])
    // (the internal `/internal*` are one parenthesis)
    expect(unimported.filter((s) => !s.includes('/internal')).sort()).toEqual(named.sort())
    expect(stated).toContain('/internal*')
  })
})

describe('the incremental guarantee states the exceptions where the oracle makes them (C85)', () => {
  const oracle = read('packages/core/src/incremental-oracle.testlib.ts')
  const incremental = section(ARCH, 'Incremental evaluation')
  const guarantee = /\*\*Guarantee\.\*\*[^\n]*/.exec(incremental)?.[0] ?? ''

  it('the oracle compares a spec with an `identifier` with a freshly compiled chart, as identities, and only the history-bound scenarios with a chart carried through the states; ARCHITECTURE says so beside the guarantee', () => {
    // (the oracle's reference: a chart compiled afresh unless the scenario is history-bound; no blanket case for a spec that has an identifier)
    expect(oracle).not.toMatch(/includes\('"identifier"'\)/)
    expect(oracle).toMatch(/function historyBound\(/)
    expect(oracle).toMatch(/const keptReference = historyBound\(g\)/)
    expect(guarantee).toContain('compares them as identities')
    expect(guarantee).toContain('historyBound')
  })

  it('the two history-bound kinds the document names are the two the oracle decides by', () => {
    const decides = /function historyBound\([\s\S]*?\n}/.exec(oracle)?.[0] ?? ''
    expect(decides).toContain("g.store === 'ids'")
    expect(decides).toContain('ROW_FIELDS')
    expect(guarantee).toContain('`_vgsid_` ids')
    expect(guarantee).toContain('overwrites a field the rows carry')
  })
})

describe('the entry points the documents list are the `exports` maps (C375, C731)', () => {
  /** The public subpaths of a package ("/dom"), the internal `/internal*` ones counted as the one entry "/internal". */
  const subpaths = (pkg) => [...new Set(Object.keys(manifest(pkg).exports).filter((k) => k !== '.' && k !== './package.json').map((k) => (k.startsWith('./internal') ? '/internal' : k.slice(1))))]
  const rowOf = (md, startsWith) => md.split('\n').find((l) => l.startsWith(startsWith)) ?? ''
  const lacking = (row, subs) => subs.filter((s) => !(s === '/internal' ? /`\/internal\*?`/.test(row) : row.includes(`\`${s}\``)))
  const API = read('docs/API.md')
  const README = read('README.md')

  it.each([
    ['core', 'ARCHITECTURE.md entry table', ARCH, '| `@aster-charts/core` | `.`'],
    ['react', 'ARCHITECTURE.md entry table', ARCH, '| `@aster-charts/react` | `.`'],
    ['core', 'API.md package table', API, '| `@aster-charts/core/…` |'],
    ['react', 'API.md package table', API, '| `@aster-charts/react/…` |'],
    ['core', 'README.md repo layout', README, '| `packages/core`'],
    ['react', 'README.md repo layout', README, '| `packages/react`'],
  ])('%s: %s names every entry', (pkg, _where, md, startsWith) => {
    const row = rowOf(md, startsWith)
    expect(row, `no row starting ${startsWith}`).not.toBe('')
    // (API.md leaves the internal `/internal*` to its own paragraph; the other two name them)
    const subs = subpaths(pkg).filter((s) => !(md === API && s === '/internal'))
    expect(lacking(row, subs)).toEqual([])
  })

  it('the core README names every add-on entry', () => {
    const text = read('packages/core/README.md')
    // (written as `/dom` or as the whole specifier)
    expect(subpaths('core').filter((s) => s !== '/internal' && !text.includes(`\`${s}\``) && !text.includes(`@aster-charts/core${s}`))).toEqual([])
  })

  it('the check bites: a row with an entry left out is reported', () => {
    expect(lacking('| `@aster-charts/core` | `.`, `/addons`, `/dom` |', ['/addons', '/dom', '/png'])).toEqual(['/png'])
  })
})

describe('TypeScript consumers are told which moduleResolution works (C371)', () => {
  it.each(['core', 'react'])('the %s package declares subpaths through `exports` only, and its README and the root README say what that needs', (pkg) => {
    const m = manifest(pkg)
    expect(Object.keys(m.exports).length).toBeGreaterThan(2)
    expect(m.typesVersions, 'with typesVersions the node10 resolution would find subpaths: the note could go').toBeUndefined()
    for (const f of [`packages/${pkg}/README.md`, 'README.md']) expect(read(f), f).toMatch(/"moduleResolution": "bundler"`, `"node16"` or `"nodenext"`/)
  })
})

describe('the side-effects table lists every module a manifest marks (C448)', () => {
  const table = section(ARCH, 'Side effects and tree-shaking')
  const tokens = new Set([...table.matchAll(/`([\w*-]+\.js)`/g)].map((m) => m[1]))
  const entries = (pkg) => (Array.isArray(manifest(pkg).sideEffects) ? manifest(pkg).sideEffects : []).map((f) => f.replace('./dist/', ''))
  const covered = (name) => tokens.has(name) || (name.startsWith('part-') && tokens.has('part-*.js'))

  it.each(['core', 'react'])('every %s entry of `sideEffects` is named', (pkg) => {
    expect(entries(pkg).filter((n) => !covered(n))).toEqual([])
  })

  it('every module the table names is marked by a manifest (no row for a module that left the list)', () => {
    const marked = new Set([...entries('core'), ...entries('react')])
    expect([...tokens].filter((t) => t !== 'part-*.js' && !marked.has(t))).toEqual([])
  })

  it('the check bites: a manifest entry the table lacks, and a token the manifests lack, are reported', () => {
    expect(covered('lean-nonexistent.js')).toBe(false)
    expect(covered('part-anything.js')).toBe(true)
  })
})

describe('the import graph the package map draws (C375, C82)', () => {
  /** The files of packages/react/src that import `spec` as a VALUE (not a type-only import or re-export). */
  function valueImporters(spec) {
    const out = []
    const dir = join(root, 'packages/react/src')
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || /\.test\.|\.d\.ts$/.test(f)) continue
      const sf = ts.createSourceFile(f, readFileSync(join(dir, f), 'utf8'), ts.ScriptTarget.ES2022, true)
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && st.moduleSpecifier.text === spec) {
          const c = st.importClause
          const value = !c || (!c.isTypeOnly && (!!c.name || (c.namedBindings && (ts.isNamespaceImport(c.namedBindings) || c.namedBindings.elements.some((e) => !e.isTypeOnly)))))
          if (value) out.push(f)
        } else if (ts.isExportDeclaration(st) && st.moduleSpecifier?.text === spec && !st.isTypeOnly) {
          if (!st.exportClause || ts.isNamespaceExport(st.exportClause) || st.exportClause.elements.some((e) => !e.isTypeOnly)) out.push(f)
        }
      }
    }
    return [...new Set(out)].sort()
  }
  const caption = /\*Package map\.[^\n]*/.exec(ARCH)?.[0] ?? ''

  it('the caption names the files that import core/dom, core/addons and the barrel as values', () => {
    expect(caption).not.toBe('')
    for (const [spec, label] of [['@aster-charts/core/dom', 'core/dom'], ['@aster-charts/core/addons', 'core/addons'], ['@aster-charts/core', 'the barrel']]) {
      const files = valueImporters(spec)
      expect(files.length, spec).toBeGreaterThan(0)
      const clause = caption.slice(caption.indexOf(label === 'the barrel' ? 'the barrel' : `\`${label}\``))
      for (const f of files) expect(clause, `${spec} is imported by ${f}`).toContain(`\`${f}\``)
    }
  })

  it('<ChartStream> does not reach the worker hook or the barrel: ChartStream.tsx and stream-shared.ts import neither', () => {
    for (const f of ['ChartStream.tsx', 'stream-shared.ts']) {
      const text = read(`packages/react/src/${f}`)
      expect(text, f).not.toMatch(/from '\.\/(useChartWorkerStream|worker|ChartWorkerStream)(\.js)?'/)
    }
    expect(valueImporters('@aster-charts/core')).not.toContain('ChartStream.tsx')
  })

  it('the check bites: a file that does import the barrel is found, and one that only imports its types is not', () => {
    expect(valueImporters('@aster-charts/core')).toContain('ssr.ts')
    expect(valueImporters('@aster-charts/core')).not.toContain('chart-types.ts')
  })
})

describe('the deviations table holds a row for every difference a gate holds, and for no other (C372)', () => {
  const rows = section(ARCH, 'Deviations from Vega').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Area') && !l.startsWith('|---'))
  const tokens = new Set(rows.flatMap((r) => [...r.matchAll(/`([^`]+)`/g)].map((m) => m[1])))
  const label = read('packages/conformance/src/label-generated-vs-vega.test.ts')
  const labelCases = [.../KNOWN_BROWSER_DIFFERENCES: Record<string, string> = \{([\s\S]*?)\n\}/.exec(label)[1].matchAll(/'(label-\d+)':/g)].map((m) => m[1])
  const held = [...EXPECTED_DIFFERENCES.map((e) => e.case), ...labelCases]
  /** A token cites a case when it equals it or is a prefix of it (a row cites a group of cases by their common start). */
  const cites = (token, c) => c === token || (token.includes(': ') && c.startsWith(token))

  it('every case a gate holds as still differing is cited by a row', () => {
    expect(labelCases.length).toBeGreaterThan(0)
    const uncited = held.filter((c) => ![...tokens].some((t) => cites(t, c)))
    expect(uncited, 'cases in scripts/lib/expected-differences.mjs (or the label test) that no row of the deviations table cites').toEqual([])
  })

  it('every case a row cites is one a gate still holds (a fixed difference leaves the table)', () => {
    const looksLikeCase = (t) => /^(differential-[\w-]+|mark-role-config-vs-vega|guide-null-vs-vega|guide-encode-vs-vega): /.test(t) || /^label-\d+$/.test(t)
    const stale = [...tokens].filter((t) => looksLikeCase(t) && !held.some((c) => cites(t, c)))
    expect(stale, 'rows citing a case no table holds').toEqual([])
  })

  it('the check bites: a made-up citation is stale, and a held case with no citation is found', () => {
    expect(held.some((c) => cites('differential-nest: generate with no keys', c))).toBe(true)
    expect(held.some((c) => cites('differential-nest: generate with no keys over 99 rows', c))).toBe(false)
    expect([...tokens].some((t) => cites(t, 'differential-made-up: x'))).toBe(false)
  })
})

describe('the files and symbols the architecture documents name are where they say (C447)', () => {
  const sourceFiles = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (['node_modules', 'dist', 'audits'].includes(e.name) || e.name.startsWith('.')) continue
      const rel = join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else sourceFiles.add(rel)
    }
  }
  for (const d of ['packages', 'scripts', 'apps', 'docs']) walk(d)
  const bases = new Set([...sourceFiles].map((f) => f.split('/').pop()))
  const exists = (token) => sourceFiles.has(token) || [...sourceFiles].some((f) => f.endsWith(`/${token}`)) || bases.has(token)

  const docs = ['docs/ARCHITECTURE.md', 'docs/ROADMAP.md', ...readdirSync(join(root, ADR_DIR)).filter((f) => f.endsWith('.md')).map((f) => `${ADR_DIR}/${f}`)]
  it.each(docs)('%s: every source file named in code resolves', (doc) => {
    const missing = new Set()
    for (const m of read(doc).matchAll(/`((?:[\w@.-]+\/)*[\w.-]+\.(?:ts|tsx|mts|mjs))`/g)) {
      const token = m[1]
      if (token.endsWith('.d.ts') || token.includes('*')) continue
      if (!exists(token)) missing.add(token)
    }
    expect([...missing]).toEqual([])
  })

  it('the check bites: a file that moved is not found', () => {
    expect(exists('svg-path.ts')).toBe(false)
    expect(exists('path-data.ts')).toBe(true)
  })
})

describe('every [aster] message the sources throw has its stem in docs/ERRORS.md (C729)', () => {
  const ERRORS = read('docs/ERRORS.md')
  /** The `[aster]` stems of the `new Error(...)` / `TypeError` / `RangeError` calls of a source text (what comes before its first `${` or closing quote). */
  const stemsOf = (source) => [...source.matchAll(/new (?:Error|TypeError|RangeError|\w*Error)\(\s*[`'"](\[aster(?:\/vl)?\] [^`'"$\\]{4,70})/g)].map((m) => m[1])
  const stemKey = (stem) => stem.slice(0, Math.min(stem.length, 28))

  it('finds the stems it checks', () => {
    expect(stemsOf("throw new TypeError(`[aster] stream capacity must be at least 1 ${x}`)")).toEqual(['[aster] stream capacity must be at least 1 '])
  })

  it.each(['core', 'react', 'vl'])('%s', (pkg) => {
    const dir = join(root, 'packages', pkg, 'src')
    const missing = []
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || /\.test\.|\.testlib\.|\.d\.ts$/.test(f)) continue
      for (const stem of stemsOf(readFileSync(join(dir, f), 'utf8'))) if (!ERRORS.includes(stemKey(stem))) missing.push(`${f}: ${stem}`)
    }
    expect(missing, 'thrown with an [aster] message that docs/ERRORS.md does not list').toEqual([])
  })

  it('the check bites: a message the document does not list is reported', () => {
    expect(ERRORS.includes(stemKey(stemsOf("new Error('[aster] a message nobody documented anywhere')")[0]))).toBe(false)
  })
})

describe('the version the documents state is the version of the packages (C450)', () => {
  const version = manifest('core').version
  it('the three packages are in lockstep, and README and ROADMAP say which is on npm', () => {
    expect(manifest('react').version).toBe(version)
    expect(manifest('vl').version).toBe(version)
    expect(read('README.md')).toContain(`Version ${version} is published to npm`)
    expect(read('docs/ROADMAP.md')).toContain(`${version} is on npm`)
    expect(read('docs/ROADMAP.md')).toContain(`(${version} is the version on npm)`)
  })
})

describe('the demo app says what it is and models what an app should do (C376, C452)', () => {
  const app = read('apps/demo/src/App.tsx')

  it('the page header states no measured figure', () => {
    const hero = /<div className="hero-stats">([\s\S]*?)<\/div>\s*<\/header>/.exec(app)?.[1] ?? ''
    expect(hero).not.toBe('')
    expect(hero.replace(/<[^>]+>/g, ' ')).not.toMatch(/\d/)
    expect(app).not.toMatch(/400\+/)
  })

  it('every <Chart> and <ChartStream> of the app is under a Suspense boundary', () => {
    for (const f of ['apps/demo/src/App.tsx', 'apps/demo/src/showcase.tsx']) {
      const text = read(f)
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
      const bare = []
      const visit = (n, guarded) => {
        let g = guarded
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
          const tag = (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText(sf)
          if (tag === 'React.Suspense' || tag === 'AsterSuspense') g = true
          if ((tag === 'Chart' || tag === 'ChartStream') && !g) bare.push(`${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
        }
        ts.forEachChild(n, (c) => visit(c, g))
      }
      visit(sf, false)
      expect(bare, 'a <Chart> with no <Suspense> above it in its own file').toEqual([])
    }
  })

  it('the demo does not derive dataChanges from a ref read during render, nor use the legacy brush props on a spec with its own brush', () => {
    expect(app).not.toMatch(/dataChanges=\{\{[^}]*\.current/)
    expect(app).not.toMatch(/onSelect=\{/)
    expect(app).not.toMatch(/\bbrush=\{/)
  })

  it('apps/demo/.wrangler/ is ignored', () => {
    expect(read('.gitignore').split('\n')).toContain('apps/demo/.wrangler/')
  })
})
