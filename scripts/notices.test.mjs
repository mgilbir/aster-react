/**
 * THIRD_PARTY_NOTICES.md must carry the real licence text of every project the
 * sources port or transcribe, copied verbatim from the package's LICENSE.
 *
 * Every `##` section is accounted for by a source of truth the test compares it with:
 *  - installed:  a `Projects:` line; the text is verbatim the LICENSE of each listed `name@version` in node_modules;
 *  - header:     a project that is not installed whose notice is carried in the header of an installed file (d3-cloud in vega-wordcloud's
 *                CloudLayout.js, Esprima in vega-expression's parser.js), and in our own source header;
 *  - fixture:    a project that is not installed and has no such file: its LICENSE as fetched from the URL and commit named in
 *                scripts/notices-fixtures/manifest.json (committed, with its sha256), compared with the section;
 *  - prose:      a section with no licence text (listed below).
 * A source file that names an installed upstream project in a comment must name one the notices list, or one `MENTIONED` says is
 * mentioned and not derived, with the reason. A new section, or a new name, that none of this accounts for fails.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const store = join(root, 'node_modules', '.pnpm')

/** Sections with a `Projects:` line and a fenced licence text. */
const sections = [...notices.matchAll(/^## (.+)\n\nProjects: (.+)\n\n```text\n([\s\S]*?)```/gm)].map((m) => ({
  title: m[1],
  projects: m[2].split(', ').map((p) => p.trim()),
  text: m[3],
}))

function licenceFile(project) {
  const at = project.lastIndexOf('@')
  const name = project.slice(0, at)
  const version = project.slice(at + 1)
  const dir = readdirSync(store).find((d) => d === `${name}@${version}` || d.startsWith(`${name}@${version}_`))
  if (!dir) return null
  const base = join(store, dir, 'node_modules', name)
  const file = readdirSync(base).find((f) => /^licen[sc]e(\.md|\.txt)?$/i.test(f))
  return file ? join(base, file) : null
}

const srcFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (e.isDirectory()) return srcFiles(p)
  return /\.(ts|tsx)$/.test(e.name) && !/\.(test|testlib|testkit)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
})

/** Every `## ` section: its title and its text up to the next one. */
const allSections = notices.split(/^(?=## )/m).filter((t) => t.startsWith('## ')).map((t) => ({ title: t.split('\n', 1)[0].slice(3), text: t }))
const fences = (text) => [...text.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1])

const FIXTURES = join(root, 'scripts', 'notices-fixtures')
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))

/** Sections with no licence text of their own: they say what follows which listed licence, or what is not redistributed. */
const PROSE = new Set([
  'vega-crossfilter and vega-voronoi',
  "Modules rewritten as Aster's own designs",
  'Other projects (not redistributed; named for completeness)',
])
/** Not installed; the licence is in the header of an installed file. */
const HEADER_SOURCED = {
  'd3-cloud (Jason Davies)': { installed: 'vega-wordcloud@5.1.2', file: 'src/CloudLayout.js', ours: 'packages/core/src/wordcloud.ts' },
  'Esprima (BSD-2-Clause)': { installed: 'vega-expression@6.2.1', file: 'src/parser.js', ours: 'packages/core/src/expr-parser.ts' },
}
/**
 * Upstream projects a shipped source names in a comment and does not derive from, each with why. (A project the sources derive from
 * is in a section above.) An entry that no comment mentions any more is stale and fails.
 */
const MENTIONED = {
  'vega-embed': 'named as the host that prints errors to the console and applies the container size; the behaviour is matched, none of its code is used',
  'vega-canvas': "named to say what `createHostCanvas` is (a canvas factory); it is a document.createElement('canvas') call, nothing of its code is carried",
}

const COMMENT = /^\s*(\/\/|\/\*|\*)|\/\/|\/\*/
const UPSTREAM_NAME = /\b(?:vega|d3|topojson)-[a-z]+(?:-[a-z]+)*\b|\b(?:delaunator|internmap|robust-predicates)\b/g
const installedUpstream = () => new Set(readdirSync(store).map((d) => d.replace(/^(@?[^@]+)@.*$/, '$1')).filter((n) => /^(vega|d3|topojson)-|^(delaunator|internmap|robust-predicates)$/.test(n)))
/** The names of installed upstream projects that the comments of the shipped sources mention, with one place each. */
function mentionedInComments() {
  const upstream = installedUpstream()
  const found = new Map()
  for (const pkg of ['core', 'vl', 'react']) {
    for (const file of srcFiles(join(root, 'packages', pkg, 'src'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!COMMENT.test(line)) return
        for (const name of line.match(UPSTREAM_NAME) ?? []) if (upstream.has(name) && !found.has(name)) found.set(name, `${file.replace(root, '')}:${i + 1}: ${line.trim().slice(0, 80)}`)
      })
    }
  }
  return found
}

describe('THIRD_PARTY_NOTICES.md', () => {
  it('has licence sections', () => {
    expect(sections.length).toBeGreaterThan(10)
  })

  it.each(sections)('$title: the text is verbatim the LICENSE of every listed project', ({ projects, text }) => {
    for (const p of projects) {
      const file = licenceFile(p)
      expect(file, `${p}: no LICENSE in node_modules (run pnpm install)`).not.toBeNull()
      expect(readFileSync(file, 'utf8').trimEnd(), p).toBe(text.trimEnd())
    }
  })

  it('every section is accounted for by a source of truth (none sits outside the test)', () => {
    const installed = new Set(sections.map((s) => s.title))
    const fixtured = new Set(manifest.map((m) => m.section))
    const unaccounted = allSections.map((s) => s.title).filter((t) => !installed.has(t) && !(t in HEADER_SOURCED) && !fixtured.has(t) && !PROSE.has(t))
    expect(unaccounted).toEqual([])
    // and each category names sections that exist
    const titles = new Set(allSections.map((s) => s.title))
    expect([...Object.keys(HEADER_SOURCED), ...fixtured, ...PROSE].filter((t) => !titles.has(t))).toEqual([])
    // every section whose text lists a `Projects:` line is checked as installed: a malformed line cannot hide one
    expect(allSections.filter((s) => /^Projects:/m.test(s.text) && !installed.has(s.title)).map((s) => s.title)).toEqual([])
  })

  it.each(Object.entries(HEADER_SOURCED))('%s: the text is the notice in the header of the installed file, and of our own header', (title, { installed, file, ours }) => {
    const section = allSections.find((s) => s.title === title)
    expect(section, title).toBeDefined()
    const [block] = fences(section.text)
    const [name, version] = [installed.slice(0, installed.lastIndexOf('@')), installed.slice(installed.lastIndexOf('@') + 1)]
    const dir = readdirSync(store).find((d) => d === `${name}@${version}` || d.startsWith(`${name}@${version}_`))
    expect(dir, `${installed} is not installed (run pnpm install)`).toBeDefined()
    const upstream = readFileSync(join(store, dir, 'node_modules', name, file), 'utf8')
    // the licence is the first block comment that holds it; its lines may be indented by the comment's layout
    const header = upstream.match(/\/\*([\s\S]*?)\*\//g).map((c) => c.slice(2, -2)).find((c) => c.includes(block.trimEnd().split('\n')[0].trim()))
    expect(header, `${installed}/${file} has no comment carrying the notice`).toBeDefined()
    const dedent = (t) => t.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n')
    const carried = (t) => t.replace(/^[\s\S]*?(?=Copyright)/, '').trimEnd()
    expect(carried(header) === block.trimEnd() || carried(dedent(header)) === block.trimEnd(), `${installed}/${file}: the header differs from the notice`).toBe(true)
    // our own source keeps the same text in its header
    const own = readFileSync(join(root, ours), 'utf8')
    for (const line of block.trimEnd().split('\n').filter((l) => l.trim() !== '')) expect(own, `${ours} lacks the line ${JSON.stringify(line)}`).toContain(line.trim())
  })

  describe('projects that are not installed: the section is the fetched file', () => {
    it('the manifest names every fixture file, and each file is the bytes the manifest hashes', () => {
      const onDisk = readdirSync(FIXTURES).filter((f) => f !== 'manifest.json').sort()
      expect(onDisk).toEqual(manifest.map((m) => m.file).sort())
      for (const m of manifest) {
        expect(createHash('sha256').update(readFileSync(join(FIXTURES, m.file))).digest('hex'), m.file).toBe(m.sha256)
        expect(m.url, m.file).toMatch(/^https:\/\/(raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/|www\.apache\.org\/licenses\/|registry\.npmjs\.org\/)/)
      }
    })

    it.each(manifest.filter((m) => !m.file.endsWith('.json')))('$section: the text of $file is a licence block of the section, and its URL is named there', (m) => {
      const section = allSections.find((s) => s.title === m.section)
      expect(section, m.section).toBeDefined()
      const text = readFileSync(join(FIXTURES, m.file), 'utf8').trimEnd()
      expect(fences(section.text).map((b) => b.trimEnd()), `${m.file} (${m.what}) is not verbatim in "${m.section}"`).toContain(text)
      expect(section.text, `"${m.section}" does not name ${m.url}`).toContain(m.url.replace(/^https:\/\/www\./, '').replace(/^https:\/\//, ''))
    })

    it('time-grain-detector: the author and licence of the notice are the registry\'s, and the ISC text is the one d3 ships', () => {
      const m = manifest.find((x) => x.file === 'time-grain-detector-package.json')
      const pkg = JSON.parse(readFileSync(join(FIXTURES, m.file), 'utf8'))
      const section = allSections.find((s) => s.title === m.section)
      const [block] = fences(section.text)
      expect(pkg.license).toBe('ISC')
      expect(block.split('\n')[0]).toBe(`${pkg.license} License`)
      expect(block).toContain(`Copyright (c) ${pkg.author}`)
      // (ISC is one text with the holder's name: the same words as the LICENSE of an installed ISC project, past its copyright line)
      const d3 = licenceFile('d3-format@' + readdirSync(store).find((d) => d.startsWith('d3-format@')).slice('d3-format@'.length).replace(/_.*/, ''))
      const words = (t) => t.trimEnd().split('\n').slice(1).join('\n').replace(/^\s+/, '')
      expect(words(block.trimEnd().split('\n').slice(2).join('\n'))).toBe(words(readFileSync(d3, 'utf8')))
    })
  })

  it('names every upstream project the sources mention in a comment: listed, or mentioned-not-derived with a reason', () => {
    const listed = new Set(sections.flatMap((s) => s.projects.map((p) => p.slice(0, p.lastIndexOf('@')))))
    const found = mentionedInComments()
    const missing = [...found].filter(([name]) => !listed.has(name) && !(name in MENTIONED))
    expect(missing, 'an upstream project named in a comment with no notice: list it (if the code follows it) or add it to MENTIONED with the reason').toEqual([])
  })

  it('MENTIONED holds only projects that are still mentioned, are not listed, and have a reason', () => {
    const listed = new Set(sections.flatMap((s) => s.projects.map((p) => p.slice(0, p.lastIndexOf('@')))))
    const found = mentionedInComments()
    for (const [name, reason] of Object.entries(MENTIONED)) {
      expect(found.has(name), `${name} is no longer mentioned in a comment: drop it from MENTIONED`).toBe(true)
      expect(listed.has(name), `${name} has a notice: drop it from MENTIONED`).toBe(false)
      expect(reason.length, name).toBeGreaterThan(20)
    }
  })

  it('the name scan sees what the old keyword scan could not (a planted comment is found)', () => {
    // the old test read a line only if it said "ported" or "transcription"; this one reads every comment line
    const upstream = installedUpstream()
    expect(upstream.has('vega-tooltip')).toBe(true)
    const planted = '// shows the tooltip as vega-tooltip does'
    expect(COMMENT.test(planted) && (planted.match(UPSTREAM_NAME) ?? []).includes('vega-tooltip')).toBe(true)
  })

  it('every package ships the notices through copy-legal and `files`', () => {
    expect(readFileSync(join(root, 'scripts', 'copy-legal.mjs'), 'utf8')).toContain('THIRD_PARTY_NOTICES.md')
    for (const pkg of ['core', 'vl', 'react']) {
      const m = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))
      expect(m.files, pkg).toContain('THIRD_PARTY_NOTICES.md')
      expect(m.files, pkg).toContain('LICENSE')
      expect(m.scripts.prepack, pkg).toContain('copy-legal')
    }
    expect(existsSync(join(root, 'LICENSE'))).toBe(true)
  })
})
