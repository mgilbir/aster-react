/**
 * Every runtime export of every public entry point is documented in docs/API.md.
 *
 * The entry points are the keys of each published package's `exports` map; their runtime exports are read by importing the built
 * `dist` entry (so this test needs `pnpm build`, which `pnpm check` runs before the tests). A name counts as documented when it
 * appears, as a whole word, inside inline code or a fenced code block of the section of docs/API.md for its package
 * (`## \`@aster/core\``, `## \`@aster/react\``, `## \`@aster/vl\``) or of the parts of the document outside the package sections (the
 * "Start here" table, the contents and the package table): prose that merely contains the word (`locale`, `format`) does not count. Types are not runtime exports and are not checked.
 *
 * The one entry without exports is `@aster/react/worker-entry` (a worker script that installs a message handler when it is loaded);
 * it is not imported here, and the test checks its declaration file says it exports nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['core', 'react', 'vl']
const NO_EXPORTS = new Set(['@aster/react/worker-entry'])

/** docs/API.md cut at its `## ` headings: one text per package section, and the rest (the title, "Start here", the contents, the package table). */
function apiSections(markdown) {
  const parts = markdown.split(/^(?=## )/m)
  const sections = new Map()
  for (const part of parts) {
    const name = /^## `(@aster\/[a-z]+)`/.exec(part)?.[1]
    if (name) sections.set(name, part)
  }
  const preamble = parts.filter((p) => !/^## `@aster\/[a-z]+`/.test(p)).join('\n')
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
    entries.push({ pkg: pkg.name, entry: key === '.' ? pkg.name : pkg.name + key.slice(1), file: join(pkgDir, target.default), types: join(pkgDir, target.types) })
  }
}

describe('docs/API.md has a section for every package', () => {
  it.each(PACKAGES.map((d) => `@aster/${d}`))('%s', (name) => {
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
