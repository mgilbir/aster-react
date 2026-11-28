/**
 * Every `ts` / `tsx` code block of the documents that are not README.md (README.md is `scripts/readme-examples.test.mjs`) type-checks
 * against the built packages, resolved through each manifest's `exports` map (C732: docs/API.md says its examples are type-checked
 * against the source; only two of its blocks were, and two blocks of ANIMATION.md did not compile).
 *
 * The documents are found, not listed: docs/*.md, the README of every package and app, and the top-level guides, so a new document or a
 * new block is checked from the day it is written. A block is a module of its own; one that shows a fragment declares what it needs
 * (`declare const spec: VgSpec`). Needs `pnpm build`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { makeTempDir, removeTempDir } from './lib/temp-dir.mjs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codeBlocks, missingBuilds, root, typeCheckBlocks } from './lib/doc-blocks.mjs'

const work = makeTempDir('aster-docs-')
afterAll(() => removeTempDir(work))

const markdownIn = (dir, deep) => {
  const out = []
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'audits' || e.name.startsWith('.')) continue
    const rel = join(dir, e.name)
    if (e.isDirectory()) { if (deep) out.push(...markdownIn(rel, deep)) } else if (e.name.endsWith('.md')) out.push(rel)
  }
  return out
}

const documents = [
  ...markdownIn('docs', true),
  ...['core', 'react', 'vl', 'conformance', 'benchmarks'].map((p) => join('packages', p, 'README.md')).filter((f) => existsSync(join(root, f))),
  'apps/demo/README.md', 'CONTRIBUTING.md',
].filter((f) => existsSync(join(root, f)))

const withBlocks = documents.map((f) => ({ file: f, blocks: codeBlocks(readFileSync(join(root, f), 'utf8')) })).filter((d) => d.blocks.length)

describe('the code blocks of the documents other than README.md', () => {
  it('are found: API.md, ANIMATION.md and the package READMEs have them', () => {
    const names = withBlocks.map((d) => d.file)
    for (const f of ['docs/API.md', 'docs/ANIMATION.md', 'packages/react/README.md']) expect(names, f).toContain(f)
    expect(withBlocks.reduce((n, d) => n + d.blocks.length, 0)).toBeGreaterThanOrEqual(30)
  })

  it.each(withBlocks.map((d) => [d.file, d]))('%s type-checks', (_file, d) => {
    expect(missingBuilds(), 'run pnpm build').toEqual([])
    expect(typeCheckBlocks(d.file, d.blocks, work)).toEqual([])
  }, 120_000)

  it('the check bites: a block that does not compile, and one that imports a name the package does not export, are reported', () => {
    const broken = codeBlocks('```ts\nimport { renderSpec } from \'@aster-charts/core\'\nconst n: number = renderSpec({})\n```\n\n```tsx\nimport { NoSuchThing } from \'@aster-charts/react\'\nexport const x = <NoSuchThing />\n```\n')
    expect(broken).toHaveLength(2)
    const report = typeCheckBlocks('planted.md', broken, work)
    expect(report.some((l) => /^planted\.md:3 /.test(l)), report.join('\n')).toBe(true)
    expect(report.some((l) => /NoSuchThing/.test(l)), report.join('\n')).toBe(true)
  })

  it('a documented subpath resolves through `exports` (@aster-charts/core/dom is addon-dom.d.ts, not dom.d.ts)', () => {
    const report = typeCheckBlocks('subpath.md', codeBlocks('```ts\nimport { createChartSession } from \'@aster-charts/core/dom\'\nimport { SvgChart } from \'@aster-charts/react/lite\'\nexport const x = [createChartSession, SvgChart]\n```\n'), work)
    expect(report).toEqual([])
  })
})
