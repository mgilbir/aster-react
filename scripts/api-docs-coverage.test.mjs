/**
 * Every runtime export of every public entry point is documented in docs/API.md.
 *
 * The entry points are the keys of each published package's `exports` map; their runtime exports are read by importing the built
 * `dist` entry (so this test needs `pnpm build`, which `pnpm check` runs before the tests). A name counts as documented when it
 * appears, as a whole word, inside inline code or a fenced code block of the section of docs/API.md for its package
 * (`## \`@aster-charts/core\``, `## \`@aster-charts/react\``, `## \`@aster-charts/vl\``) or of the parts of the document outside the package sections (the
 * "Start here" table, the contents and the package table): prose that merely contains the word (`locale`, `format`) does not count. The types an entry exports are checked the same way (below), and so is the other direction: a type name the
 * document puts in code that is declared in a package but exported by no entry cannot be imported by the reader who is told to use it.
 *
 * The one entry without exports is `@aster-charts/react/worker-entry` (a worker script that installs a message handler when it is loaded);
 * it is not imported here, and the test checks its declaration file says it exports nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['core', 'react', 'vl']
const NO_EXPORTS = new Set(['@aster-charts/react/worker-entry'])

/** docs/API.md cut at its `## ` headings: one text per package section, and the rest (the title, "Start here", the contents, the package table). */
function apiSections(markdown) {
  const parts = markdown.split(/^(?=## )/m)
  const sections = new Map()
  for (const part of parts) {
    const name = /^## `(@aster-charts\/[a-z]+)`/.exec(part)?.[1]
    if (name) sections.set(name, part)
  }
  const preamble = parts.filter((p) => !/^## `@aster-charts\/[a-z]+`/.test(p)).join('\n')
  return { preamble, sections }
}

/** The code of a markdown text: fenced blocks and inline code spans. */
function codeOf(text) {
  const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1])
  const rest = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  const inline = [...rest.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  return [...fenced, ...inline].join('\n')
}

const isMentioned = (code, name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)

const api = apiSections(readFileSync(join(root, 'docs', 'API.md'), 'utf8'))

const entries = []
for (const dir of PACKAGES) {
  const pkgDir = join(root, 'packages', dir)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue
    // the internal entries (@aster-charts/core/internal*) are not public API and have no section: scripts/public-surface.test.mjs holds them out of API.md
    if (/^\.\/internal(\/|$)/.test(key)) continue
    entries.push({ pkg: pkg.name, entry: key === '.' ? pkg.name : pkg.name + key.slice(1), file: join(pkgDir, target.default), types: join(pkgDir, target.types) })
  }
}

describe('docs/API.md has a section for every package', () => {
  it.each(PACKAGES.map((d) => `@aster-charts/${d}`))('%s', (name) => {
    expect(api.sections.has(name), `docs/API.md has no "## \`${name}\`" section`).toBe(true)
  })
})

describe('every runtime export of a public entry is documented in docs/API.md', () => {
  it.each(entries.map((e) => [e.entry, e]))('%s', async (_entry, e) => {
    if (NO_EXPORTS.has(e.entry)) {
      expect(readFileSync(e.types, 'utf8').trim(), `${e.entry} now has exports: remove it from NO_EXPORTS`).toBe('export {};')
      return
    }
    expect(existsSync(e.file), `${e.file} is missing: run pnpm build`).toBe(true)
    const names = Object.keys(await import(pathToFileURL(e.file).href)).filter((n) => n !== 'default')
    const code = codeOf(`${api.preamble}\n${api.sections.get(e.pkg) ?? ''}`)
    const missing = names.filter((n) => !isMentioned(code, n))
    expect(missing, `${e.entry} exports names docs/API.md does not mention in code (inline code or a fenced block) in its ${e.pkg} section`).toEqual([])
  })
})

/** The exported types (and the exported names of every kind) of each entry, by the TypeScript compiler API over the built declarations. */
function exportedNamesByEntry() {
  const byEntry = new Map()
  const declared = new Set()
  for (const dir of PACKAGES) {
    const mine = entries.filter((e) => e.pkg === `@aster-charts/${dir}` && !NO_EXPORTS.has(e.entry))
    const program = ts.createProgram({ rootNames: mine.map((e) => e.types), options: { noEmit: true, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    const checker = program.getTypeChecker()
    for (const e of mine) {
      const sf = program.getSourceFile(e.types)
      const sym = sf && checker.getSymbolAtLocation(sf)
      byEntry.set(e.entry, (sym ? checker.getExportsOfModule(sym) : []).map((n) => ({ name: n.name, isType: (n.flags & ts.SymbolFlags.Value) === 0 })))
    }
    // every type declared in the package's declarations, exported by an entry or not
    const dist = join(root, 'packages', dir, 'dist')
    for (const f of readdirSync(dist).filter((n) => n.endsWith('.d.ts'))) {
      for (const m of readFileSync(join(dist, f), 'utf8').matchAll(/^(?:export )?(?:declare )?(?:interface|type|class|enum) (\w+)/gm)) declared.add(m[1])
    }
  }
  return { byEntry, declared }
}

describe('every type an entry exports is named in docs/API.md, and no type it names is out of reach', () => {
  const { byEntry, declared } = exportedNamesByEntry()
  const code = codeOf(readFileSync(join(root, 'docs', 'API.md'), 'utf8'))
  const exportedAnywhere = new Set([...byEntry.values()].flat().map((n) => n.name))

  it.each([...byEntry].map(([entry, names]) => [entry, names]))('%s', (_entry, names) => {
    const missing = names.filter((n) => n.isType && !isMentioned(code, n.name)).map((n) => n.name)
    expect(missing, 'exported types that appear in no code span or block of docs/API.md').toEqual([])
  })

  it('a type name the document puts in code and a package declares is exported by some entry (the reader is told to import it)', () => {
    const named = new Set([...code.matchAll(/(?<![\w$.])([A-Z][A-Za-z0-9]+)(?![\w$])/g)].map((m) => m[1]))
    const unreachable = [...named].filter((n) => declared.has(n) && !exportedAnywhere.has(n))
    expect(unreachable, 'declared in a package, named in docs/API.md, exported by no entry').toEqual([])
  })

  it('the names the check reads are there (it is not vacuous): the types of the entries, and the declared ones the docs name', () => {
    expect(isMentioned(code, 'NoSuchTypeAnywhere')).toBe(false)
    expect(exportedAnywhere.has('ChartSession') && exportedAnywhere.has('ScaleContext') && exportedAnywhere.has('TooltipInfo')).toBe(true)
    expect(declared.has('ScaleContext') && declared.has('TransformContext') && declared.has('TooltipInfo')).toBe(true)
    expect([...byEntry.values()].flat().filter((n) => n.isType).length).toBeGreaterThan(150)
    // (C730: with the three exports of ScaleContext, TransformContext and ChartStreamInput removed, the test above reports them: seen to fail. ChartStreamInput has since become internal (declared nowhere), so TooltipInfo stands in the sanity check)
  })
})

/** GitHub's heading anchor: lower case, code ticks and punctuation dropped, spaces to hyphens. */
const slugOf = (heading) => heading.trim().toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')

/** The headings of the document, outside fenced code. */
function headingsOf(markdown) {
  const out = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    const m = !fenced && /^(#{2,4})\s+(.*)$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2], slug: slugOf(m[2]) })
  }
  return out
}

// "Start here" and the contents are how a reader finds a section; a heading the contents forgot is a section nobody can find.
describe('the contents of docs/API.md', () => {
  const markdown = readFileSync(join(root, 'docs', 'API.md'), 'utf8')
  const contents = /^## Contents\n([\s\S]*?)^## /m.exec(markdown)?.[1] ?? ''
  const targets = new Set([...contents.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1]))
  const headings = headingsOf(markdown)
  /** Headings that only group the ones below them, and the two that are the navigation itself. */
  const GROUPS = new Set(['Start here', 'Contents', 'Guides', 'Reference', 'Components and hooks', 'Add-on entry points'])

  it('exists and links something', () => {
    expect(targets.size).toBeGreaterThan(20)
  })
  it('links every section heading', () => {
    const missing = headings.filter((h) => !GROUPS.has(h.text) && !targets.has(h.slug)).map((h) => h.text)
    expect(missing, 'docs/API.md headings missing from its "## Contents" list').toEqual([])
  })
  it('links only headings that exist', () => {
    const slugs = new Set(headings.map((h) => h.slug))
    const dangling = [...targets].filter((s) => !slugs.has(s))
    expect(dangling, 'docs/API.md "## Contents" links that match no heading').toEqual([])
  })
})

describe('the matching rules', () => {
  it('count a whole word in code, not a word in prose or part of a longer name', () => {
    const code = codeOf('The locale of a chart.\n\n`resolveCursor(a, b)` and `locales`\n\n```ts\nimport { sortRows } from "x"\n```\n')
    expect(isMentioned(code, 'resolveCursor')).toBe(true)
    expect(isMentioned(code, 'sortRows')).toBe(true)
    expect(isMentioned(code, 'locale')).toBe(false)
    expect(isMentioned(code, 'resolve')).toBe(false)
  })
})
