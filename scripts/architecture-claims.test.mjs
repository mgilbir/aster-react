/**
 * docs/ARCHITECTURE.md says where things live: "`lexedText` in `expr-text.ts`", "`namesIn` in `step-reuse.ts`, `lexedText` in
 * `expr-text.ts`". A name placed in the wrong file is a doc that sends a reader to a file without it (C754: `lexedText` was said to be
 * in `step-reuse.ts`, which only imports it; `scaleSettings` and `sameSettings` were said to be in the runtime). Every
 * "`name` in `file.ts`" of the document, and every list of names before an "in `file.ts`", names a file of the packages that DEFINES
 * (declares or exports) it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const doc = readFileSync(join(root, 'docs', 'ARCHITECTURE.md'), 'utf8')

const sources = new Map()
for (const pkg of ['core', 'react', 'vl']) {
  for (const f of readdirSync(join(root, 'packages', pkg, 'src'))) if (/\.tsx?$/.test(f) && !f.endsWith('.d.ts')) sources.set(`${pkg}/${f}`, join(root, 'packages', pkg, 'src', f))
}
const filesNamed = (name) => [...sources].filter(([, path]) => path.endsWith(`/${name}`))

/** Whether `file` declares `name`: a function, const, class, type, interface or enum, exported or not, or a re-export of it. */
function defines(file, name) {
  const text = readFileSync(file, 'utf8')
  return new RegExp(`(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b|\\b${name}\\s*[:(]\\s*(?:function|async|\\()|^\\s+${name}\\s*[(<:]|export\\s*\\{[^}]*\\b${name}\\b`, 'm').test(text)
}

// "`a`, `b` and `c` in `file.ts`" and "`a` in `x.ts`, `b` in `y.ts`": the names directly before an "in `file`"
const claims = []
for (const m of doc.matchAll(/((?:`[A-Za-z_]\w*`(?:\([^)]*\))?(?:, | \/ | and | or )?)+) in `([\w./-]+\.tsx?)`/g)) {
  for (const n of m[1].matchAll(/`([A-Za-z_]\w*)`/g)) claims.push({ name: n[1], file: m[2], at: m.index })
}

describe('ARCHITECTURE.md places names in the files that define them', () => {
  it('finds the claims it checks', () => {
    expect(claims.length).toBeGreaterThanOrEqual(8)
    expect(claims.some((c) => c.name === 'lexedText' && c.file === 'expr-text.ts')).toBe(true)
  })

  it.each(claims.map((c) => [`${c.name} in ${c.file}`, c]))('%s', (_label, { name, file }) => {
    const found = filesNamed(file)
    expect(found.length, `${file} is not a source file of the packages`).toBeGreaterThan(0)
    expect(found.some(([, path]) => defines(path, name)), `${file} does not define ${name}`).toBe(true)
  })

  it('the check bites: a name placed in a file that only imports it is refused', () => {
    // (step-reuse.ts imports lexedText from expr-text.ts)
    expect(filesNamed('step-reuse.ts').some(([, p]) => defines(p, 'lexedText'))).toBe(false)
    expect(filesNamed('expr-text.ts').some(([, p]) => defines(p, 'lexedText'))).toBe(true)
  })
})
