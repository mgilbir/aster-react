/**
 * THIRD_PARTY_NOTICES.md must carry the real licence text of every project the
 * sources port or transcribe (C79), copied verbatim from the package's LICENSE.
 */
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

  it('names every upstream project the sources port or transcribe', () => {
    const listed = new Set(sections.flatMap((s) => s.projects.map((p) => p.slice(0, p.lastIndexOf('@')))))
    listed.add('d3-cloud') // no LICENSE file to copy; its own section reproduces the notice from vega-wordcloud
    expect(notices).toContain('## d3-cloud (Jason Davies)')
    const upstream = new Set(readdirSync(store).map((d) => d.replace(/^(@?[^@]+)@.*$/, '$1')).filter((n) => /^(vega|d3|topojson)-|^(delaunator|internmap|robust-predicates)$/.test(n)))
    upstream.add('d3-cloud')
    const missing = new Map()
    for (const pkg of ['core', 'vl', 'react']) {
      for (const file of srcFiles(join(root, 'packages', pkg, 'src'))) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!/\b(ported?|port of|transcri\w+|faithful|verbatim|operation-for-operation|mirrors)\b/i.test(line)) continue
          for (const name of line.match(/\b(?:vega|d3|topojson)-[a-z-]+\b|\b(?:delaunator|internmap|robust-predicates)\b/g) ?? []) {
            if (upstream.has(name) && !listed.has(name)) missing.set(name, `${file.replace(root, '')}: ${line.trim().slice(0, 80)}`)
          }
        }
      }
    }
    expect([...missing]).toEqual([])
  })

  it('every package ships the notices through copy-legal and `files`', () => {
    expect(readFileSync(join(root, 'scripts', 'copy-legal.mjs'), 'utf8')).toContain('THIRD_PARTY_NOTICES.md')
    for (const pkg of ['core', 'react', 'vl']) {
      const m = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))
      expect(m.files, pkg).toContain('THIRD_PARTY_NOTICES.md')
      expect(m.files, pkg).toContain('LICENSE')
      expect(m.scripts.prepack, pkg).toContain('copy-legal')
    }
    expect(existsSync(join(root, 'LICENSE'))).toBe(true)
  })
})
