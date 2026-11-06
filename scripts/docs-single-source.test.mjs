/**
 * One home for each fact the docs used to repeat, and a check that the copies do not come back.
 *
 * - The add-on transforms: the list is `TRANSFORMS_ADDON_TYPES` in packages/core/src/addons.ts (and the data formats
 *   `LOAD_ADDON_FORMATS`). docs/ARCHITECTURE.md names a sample in its add-on table; every name it gives must be in the list, a
 *   slash-joined list of formats must be the whole of `LOAD_ADDON_FORMATS`, and the READMEs, API.md and ERRORS.md do not
 *   enumerate the transforms (a paragraph there names at most three).
 * - The gates: scripts/gates.mjs. Outside docs/TESTING.md and docs/RUNBOOK.md (which tabulate results and how to run one), no
 *   paragraph lists four or more gates, and every `pnpm <script>` any doc names is a script that exists.
 * - What `retained` means: docs/INTERACTION.md ("Signals"); docs/ARCHITECTURE.md's table row points at it.
 * - What `@aster/vl` refuses: packages/vl/README.md ("Throws"), held to the compiler by packages/vl/test/readme-refusals.test.ts;
 *   the distinctive refusals are named nowhere else.
 *
 * The checks read the docs as text. They find a list that is copied back into a paragraph; they do not find a fact reworded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GATES } from './gates.mjs'
import { LOAD_ADDON_FORMATS, TRANSFORMS_ADDON_TYPES } from '../packages/core/dist/addons.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', 'dist', '.git', 'audits', 'coverage'])

/** Every markdown file of the repository, as { file, text } with a repository-relative path. */
function markdownFiles(dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) markdownFiles(path, out)
    else if (entry.endsWith('.md')) out.push({ file: relative(root, path), text: readFileSync(path, 'utf8') })
  }
  return out
}

const DOCS = markdownFiles()
const doc = (file) => DOCS.find((d) => d.file === file)?.text ?? ''
const paragraphs = (text) => text.split(/\n\s*\n/)
/** The distinct backticked tokens of a text. */
const ticks = (text) => new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
const countIn = (text, names) => [...ticks(text)].filter((t) => names.has(t))

/** Docs whose job is to be a history, a snapshot or a table of commands: they may name anything. */
const HISTORY = new Set(['CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'packages/conformance/gallery/TRIAGE.md'])

describe('add-ons: TRANSFORMS_ADDON_TYPES and LOAD_ADDON_FORMATS are the lists', () => {
  const types = new Set(TRANSFORMS_ADDON_TYPES)

  it('the code lists transforms and the four formats', () => {
    expect(types.size).toBeGreaterThan(20)
    expect([...LOAD_ADDON_FORMATS].sort()).toEqual(['csv', 'dsv', 'topojson', 'tsv'])
  })

  it('every transform ARCHITECTURE.md names in its add-on table is one of them', () => {
    const arch = doc('docs/ARCHITECTURE.md')
    const row = arch.split('\n').find((l) => l.startsWith('| `@aster/core/transforms` |')) ?? ''
    const sample = row.slice(0, row.indexOf('(implementations'))
    const named = [...ticks(sample)].filter((t) => /^[a-z0-9]+$/.test(t))
    expect(named.length, 'the add-on table row is gone or no longer names transforms').toBeGreaterThan(5)
    expect(named.filter((t) => !types.has(t))).toEqual([])
  })

  it('a slash-joined list of data formats is all of LOAD_ADDON_FORMATS', () => {
    const wrong = []
    for (const { file, text } of DOCS) {
      if (HISTORY.has(file)) continue
      for (const m of text.matchAll(/`(?:csv|tsv|dsv|topojson)`(?:\/`(?:csv|tsv|dsv|topojson)`)+/g)) {
        const got = [...m[0].matchAll(/`(\w+)`/g)].map((x) => x[1]).sort()
        if (got.join() !== [...LOAD_ADDON_FORMATS].sort().join()) wrong.push(`${file}: ${m[0]}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('the READMEs, API.md, ERRORS.md and the rest of ARCHITECTURE.md do not enumerate the transforms', () => {
    const copies = []
    for (const { file, text } of DOCS) {
      if (HISTORY.has(file) || file === 'docs/LIMITS.md' || file === 'docs/PERFORMANCE.md') continue // their lists are per-transform cost, not the add-on
      for (const p of paragraphs(text)) {
        if (file === 'docs/ARCHITECTURE.md' && p.startsWith('| Addon | Registers |')) continue // the canonical sample
        if (countIn(p, types).length >= 4) copies.push(`${file}: ${p.slice(0, 70).replace(/\n/g, ' ')}...`)
      }
    }
    expect(copies, 'a paragraph names four or more add-on transforms: point at TRANSFORMS_ADDON_TYPES instead of listing them').toEqual([])
  })
})

describe('gates: scripts/gates.mjs is the list', () => {
  const commands = new Set(GATES.map((g) => g.args.find((a) => !a.startsWith('-')) ?? '').filter((a) => a && a !== 'run'))
  const named = (p) => {
    const found = new Set()
    for (const c of commands) if (new RegExp(`pnpm ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`).test(p)) found.add(c)
    for (const g of GATES) if (p.includes(`\`${g.name}\``)) found.add(g.name)
    return found
  }

  it('no paragraph outside TESTING.md and RUNBOOK.md lists four or more gates', () => {
    const copies = []
    for (const { file, text } of DOCS) {
      if (HISTORY.has(file) || file === 'docs/TESTING.md' || file === 'docs/RUNBOOK.md') continue
      for (const p of paragraphs(text)) if (named(p).size >= 4) copies.push(`${file}: ${p.slice(0, 70).replace(/\n/g, ' ')}...`)
    }
    expect(copies, 'a paragraph lists gates: point at scripts/gates.mjs (`pnpm check -- --list`)').toEqual([])
  })

  it('every `pnpm <script>` a doc names exists', () => {
    const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts))
    // pnpm's own commands, and the words that follow "pnpm" in prose
    const own = new Set(['vitest', 'tsx', 'tsc', 'install', 'add', 'pack', 'exec', 'run', 'dlx', 'publish', 'i', 'rebuild', 'approve-builds', 'store', 'why', 'ls', 'list', 'update', 'up'])
    const missing = []
    for (const { file, text } of DOCS) {
      if (HISTORY.has(file)) continue
      // code only: inline code and fenced blocks, where a command is a command
      const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((m) => m[1].split('\n')).filter((l) => /^\s*(?:[$#] )?pnpm /.test(l))
      const code = [...text.matchAll(/`([^`\n]*pnpm [^`\n]*)`/g)].map((m) => m[1]).concat(fenced)
      for (const c of code) {
        if (/--filter|\s-F\s/.test(c)) continue // a script of another workspace package
        for (const m of c.matchAll(/\bpnpm (?:-[\w-]+(?: \S+)? )*([a-z][\w:.-]*)/g)) {
          if (!scripts.has(m[1]) && !own.has(m[1])) missing.push(`${file}: pnpm ${m[1]}`)
        }
      }
    }
    expect([...new Set(missing)]).toEqual([])
  })
})

describe('retained: INTERACTION.md says what it means', () => {
  const EXPLAINS = /first autosize|first layout|keeps its first size|it first computed/
  it('only INTERACTION.md and the deviations table of ARCHITECTURE.md explain it', () => {
    const files = DOCS.filter((d) => !HISTORY.has(d.file) && EXPLAINS.test(d.text)).map((d) => d.file)
    expect(files.sort()).toEqual(['docs/ARCHITECTURE.md', 'docs/INTERACTION.md'])
  })
  it('the table row links to the explanation', () => {
    const row = doc('docs/ARCHITECTURE.md').split('\n').find((l) => l.startsWith('| Signals written into a running chart: `retained`')) ?? ''
    expect(row).toContain('(INTERACTION.md#signals)')
    expect(doc('docs/INTERACTION.md')).toMatch(/^## Signals$/m)
  })
})

describe('Vega-Lite refusals: packages/vl/README.md is the list', () => {
  const REFUSAL_ONLY = ['timeUnit.maxbins', 'timeUnitBandPosition', 'timeUnitBandSize', 'scale.domain.unionWith', 'bin.extent', 'argmax']
  const canonical = 'packages/vl/README.md'
  const throwsList = (() => {
    const t = doc(canonical)
    return t.slice(t.indexOf('## Throws (not supported)'), t.indexOf('## Where it matches'))
  })()

  it('the canonical list still names the refusals the guard looks for', () => {
    expect(REFUSAL_ONLY.filter((r) => !throwsList.includes(r))).toEqual([])
  })
  it('no other doc restates them', () => {
    const copies = []
    for (const { file, text } of DOCS) {
      if (file === canonical || HISTORY.has(file) || file === 'packages/vl/CONTRIBUTING.md') continue
      for (const r of REFUSAL_ONLY) if (text.includes(r)) copies.push(`${file}: ${r}`)
    }
    expect(copies, 'name the refusals once, in packages/vl/README.md, and link to it').toEqual([])
  })
})
