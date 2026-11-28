/**
 * No public entry of a published package carries an internal (docs/DECISIONS Q20, audit C758, C543, C283).
 *
 * "Public entry" is every `exports` key of `@aster-charts/{core,react,vl}` except `./package.json` and the internal entries
 * (`@aster-charts/core/internal*`: plumbing the sibling packages and this repo's tests read, declared to a consumer as a module that
 * declares nothing; docs/ARCHITECTURE.md, "Internal plumbing"). An internal is
 *   - a name an exported declaration marks `@internal` (read from the sources by the TypeScript compiler API), or
 *   - a name only the internal entries export (derived from the `exports` maps and the built `dist`, not listed here), or
 *   - one of the symbols DECISIONS Q20 names (a floor under the two derived sets: if a rename slipped past them these still hold).
 * The checks read the built `dist` (`pnpm build` first), as api-docs-coverage and verify-publish do.
 *
 * Declarations are checked as they ship: no `@internal` text survives in one (`stripInternal`), none imports or re-exports from an
 * internal entry (a type a consumer could not resolve), and every built declaration file of a package type-checks on its own with
 * `skipLibCheck` off, so a name stripped from one file while another still re-exports it is an error here instead of a silent `any`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['core', 'react', 'vl']
const isInternalKey = (key) => /^\.\/internal(\/|$)/.test(key)

/** DECISIONS Q20's list, and the other process-global tables and test seams the audit named (C283, C543). */
const Q20 = [
  'registerVegaLiteCompiler', 'compileUnit', 'checkChartRows', 'shareRowWatch', 'buildPulseGraph', 'propagatePulse', 'transformNeedsFullRederive',
  'withdrawFunctions', 'dataFormatRegistry', 'geoRegistry', 'transformRegistry', 'requireTransform', 'typeParsers',
  'sceneIntersect', 'lastEvaluation', 'compileVegaLite', 'resetVegaLiteCompiler', 'scaleSpace', 'panIn', 'zoomIn', 'tickStep',
]

const manifests = Object.fromEntries(PACKAGES.map((d) => [d, JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8'))]))
const entries = []
for (const dir of PACKAGES) {
  const pkg = manifests[dir]
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue
    const internal = isInternalKey(key)
    entries.push({
      dir, internal, name: key === '.' ? pkg.name : pkg.name + key.slice(1),
      file: join(root, 'packages', dir, target.default),
      types: join(root, 'packages', dir, internal ? target['aster-internal'] : target.types),
    })
  }
}
const publicEntries = entries.filter((e) => !e.internal)
const internalEntries = entries.filter((e) => e.internal)
const NO_EXPORTS = new Set(['@aster-charts/react/worker-entry'])

/** The runtime export names of a built entry (importing it: the entries are side-effect safe in Node). */
async function runtimeNames(e) {
  expect(existsSync(e.file), `${e.file} is missing: run pnpm build`).toBe(true)
  return Object.keys(await import(pathToFileURL(e.file).href)).filter((n) => n !== 'default')
}

const sourceFiles = (dir) => {
  const out = []
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(f.name) && !/\.(test|testlib|testkit|assert)\.(ts|tsx)$|\.d\.ts$/.test(f.name)) out.push(p)
    }
  }
  walk(join(root, 'packages', dir, 'src'))
  return out
}

/**
 * The names a source text declares at top level with an `export` and an `@internal` tag in its doc comment.
 * (A file's first statement carries the file's header comment: a header that says `@internal` marks that statement.)
 */
export function internalExports(text, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const names = []
  const tagged = (node) => ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal')
  for (const st of sf.statements) {
    if (!ts.canHaveModifiers(st) || !ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || !tagged(st)) continue
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push(d.name.getText(sf))
    else if (st.name) names.push(st.name.text)
  }
  return names
}

const taggedNames = new Map()
for (const dir of PACKAGES) {
  for (const f of sourceFiles(dir)) for (const n of internalExports(readFileSync(f, 'utf8'), f)) taggedNames.set(n, relative(root, f))
}

describe('the scanner reads what it must (it is not vacuous)', () => {
  it('finds an @internal export, a variable, and a header tag that lands on the first statement', () => {
    expect(internalExports('/** a. @internal */\nexport function a(): void {}\nexport function b(): void {}\n')).toEqual(['a'])
    expect(internalExports('/** @internal */\nexport const c = 1\n/** d */\nexport const d = 2\n')).toEqual(['c'])
    expect(internalExports('/**\n * Header. @internal for the shells\n */\nexport { x } from "./x.js"\nexport function y(): void {}\n')).toEqual([])
    expect(internalExports('/** Header. @internal */\nexport function first(): void {}\nexport function second(): void {}\n')).toEqual(['first'])
    expect(internalExports('/** @internal */\nfunction notExported(): void {}\n')).toEqual([])
  })

  it('the repository has internals to find, and internal entries to keep them on', () => {
    expect(taggedNames.size).toBeGreaterThan(10)
    expect(taggedNames.has('lastEvaluation')).toBe(true)
    expect(internalEntries.length).toBeGreaterThanOrEqual(7)
    expect(publicEntries.length).toBeGreaterThan(15)
  })
})

describe('the internal entries are declared as such', () => {
  it.each(internalEntries.map((e) => [e.name, e]))('%s resolves, for a consumer, to a declaration of nothing', (_n, e) => {
    const target = manifests[e.dir].exports['.' + e.name.slice(`@aster-charts/${e.dir}`.length)]
    expect(target.types).toBe('./dist/not-public.d.ts')
    expect(readFileSync(join(root, 'packages', e.dir, 'dist', 'not-public.d.ts'), 'utf8')).toMatch(/export \{\};\s*$/)
    expect(existsSync(e.types), `${e.types} (the declaration this repo reads): run pnpm build`).toBe(true)
  })

  it('no public entry is also an internal one: the two sets share no runtime file under the same specifier', () => {
    expect(new Set([...publicEntries, ...internalEntries].map((e) => e.name)).size).toBe(entries.length)
  })
})

describe('no public entry exports an internal, at run time', () => {
  it.each(publicEntries.filter((e) => !NO_EXPORTS.has(e.name)).map((e) => [e.name, e]))('%s', async (_n, e) => {
    const names = await runtimeNames(e)
    const exportedByInternalOnly = await internalOnlyNames()
    const leaked = names.filter((n) => taggedNames.has(n) || exportedByInternalOnly.has(n) || Q20.includes(n))
    expect(leaked.map((n) => `${n}${taggedNames.has(n) ? ` (@internal in ${taggedNames.get(n)})` : ''}`)).toEqual([])
  })

  it('the names only the internal entries export are found (so the derived set is not empty)', async () => {
    const only = await internalOnlyNames()
    for (const n of ['loadCanvasPart', 'loadSignalsPart', 'datasetUrls', 'sceneScaleMap', 'sceneScaleSnapshots', 'checkChartRows', 'sceneIntersect', 'ENGINE_PARTS']) {
      expect(only.has(n), n).toBe(true)
    }
  })

  it('Q20: the symbols are reachable from no public entry, nor on any entry of the packages', async () => {
    const all = new Set()
    for (const e of publicEntries.filter((x) => !NO_EXPORTS.has(x.name))) for (const n of await runtimeNames(e)) all.add(n)
    expect(Q20.filter((n) => all.has(n))).toEqual([])
  })
})

let internalOnlyCache
async function internalOnlyNames() {
  if (internalOnlyCache) return internalOnlyCache
  const inPublic = new Set()
  for (const e of publicEntries.filter((x) => !NO_EXPORTS.has(x.name))) for (const n of await runtimeNames(e)) inPublic.add(n)
  const only = new Set()
  for (const e of internalEntries) for (const n of await runtimeNames(e)) if (!inPublic.has(n)) only.add(n)
  return (internalOnlyCache = only)
}

/** A TypeScript program over built declaration files, with its checker. */
function programOf(files, extra = {}) {
  return ts.createProgram({
    rootNames: files,
    options: { noEmit: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: [], ...extra },
  })
}

describe('no public declaration carries an internal, as it ships', () => {
  const byPackage = (dir) => publicEntries.filter((e) => e.dir === dir && !NO_EXPORTS.has(e.name))

  it.each(PACKAGES.map((d) => [d]))('@aster-charts/%s: the declarations reachable from its public entries', (dir) => {
    const mine = byPackage(dir)
    for (const e of mine) expect(existsSync(e.types), `${e.types}: run pnpm build`).toBe(true)
    const program = programOf(mine.map((e) => e.types))
    const checker = program.getTypeChecker()
    const reachable = program.getSourceFiles().filter((sf) => sf.fileName.startsWith(join(root, 'packages', dir, 'dist') + '/'))
    expect(reachable.length).toBeGreaterThan(5)
    const problems = []
    for (const sf of reachable) {
      const text = sf.getFullText()
      if (/@internal\b/.test(text)) problems.push(`${relative(root, sf.fileName)} still carries an @internal declaration (stripInternal is off?)`)
      for (const st of sf.statements) {
        const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null
        if (spec === null || !/^@aster-charts\/[a-z]+\/internal(\/|$)/.test(spec)) continue
        // a bare `import '...'` names no type: the one form allowed (`@aster-charts/react/all` imports the part registrations that way)
        const sideEffectOnly = ts.isImportDeclaration(st) && st.importClause === undefined
        if (!sideEffectOnly) problems.push(`${relative(root, sf.fileName)} imports or re-exports from ${spec}, which declares nothing to a consumer`)
      }
    }
    for (const e of mine) {
      const sf = program.getSourceFile(e.types)
      const sym = sf && checker.getSymbolAtLocation(sf)
      for (const n of sym ? checker.getExportsOfModule(sym) : []) {
        if (taggedNames.has(n.name) || Q20.includes(n.name)) problems.push(`${e.name} declares the internal ${n.name}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('ChartSession has no `last`, and `HydrateChartOptions` no `tooltips` (Q20)', () => {
    const dom = publicEntries.find((e) => e.name === '@aster-charts/core/dom')
    const ssr = publicEntries.find((e) => e.name === '@aster-charts/react/ssr')
    const program = programOf([dom.types, ssr.types])
    const checker = program.getTypeChecker()
    const exported = (e, name) => {
      const sf = program.getSourceFile(e.types)
      return checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).find((s) => s.name === name)
    }
    const session = checker.getDeclaredTypeOfSymbol(exported(dom, 'ChartSession'))
    expect(session.getProperties().map((p) => p.name).sort()).toEqual(['change', 'evaluate', 'pulse'])
    const hydrate = checker.getDeclaredTypeOfSymbol(exported(ssr, 'HydrateChartOptions'))
    expect(hydrate.getProperties().map((p) => p.name)).not.toContain('tooltips')
  })

  it.each(PACKAGES.map((d) => [d]))('@aster-charts/%s: every built declaration file type-checks on its own, skipLibCheck off', (dir) => {
    const distDir = join(root, 'packages', dir, 'dist')
    expect(existsSync(distDir), 'run pnpm build').toBe(true)
    const files = readdirSync(distDir).filter((f) => f.endsWith('.d.ts')).map((f) => join(distDir, f))
    // (the internal entries' declarations are read through the `aster-internal` condition by this repo's packages: they must resolve too)
    const program = programOf(files, { skipLibCheck: false, customConditions: ['aster-internal'], paths: undefined })
    const own = new Set(files)
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file && own.has(d.file.fileName))
    expect(diags.map((d) => `${relative(root, d.file.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160)}`)).toEqual([])
  }, 120_000)
})

describe('docs/API.md documents no internal', () => {
  const api = readFileSync(join(root, 'docs', 'API.md'), 'utf8')
  const code = [...api.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]).concat([...api.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])).join('\n')
  const mentioned = (n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)

  it('names no symbol only an internal entry exports, no @internal export, and none of Q20', async () => {
    const only = await internalOnlyNames()
    // (`part` and `ENGINE_PARTS` are common words in the part tables; the names that are not are checked by word)
    const names = [...new Set([...only, ...taggedNames.keys(), ...Q20])].filter((n) => n.length > 5)
    expect(names.filter(mentioned)).toEqual([])
  })

  it('names the internal entries only to say they are not public API', () => {
    const lines = api.split('\n').filter((l) => /@aster-charts\/core\/internal|`\/internal/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l, 'a line of API.md that names an internal entry must say it is not public API').toMatch(/not public API|not part of the API|unsupported/i)
  })
})
