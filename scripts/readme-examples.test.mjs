/**
 * The code blocks of README.md are checked: every `ts` / `tsx` block type-checks against the built packages, and the first two
 * (a Vega spec and a Vega-Lite spec rendered to an SVG string, the first chart a reader types) are run.
 *
 * The blocks are read from the README itself, so an edit that breaks one fails here. The packages are the built `dist` of each
 * workspace (this test needs `pnpm build`, which `pnpm check` runs first), mapped to the specifiers the README imports
 * (`scripts/lib/doc-blocks.mjs`; the other documents' blocks are `scripts/docs-examples.test.mjs`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

import { PATHS, codeBlocks, missingBuilds, root, typeCheckBlocks } from './lib/doc-blocks.mjs'
import { makeTempDir, removeTempDir } from './lib/temp-dir.mjs'

const pkg = (name) => join(root, 'packages', name)
const dist = (name, file) => join(pkg(name), 'dist', file)

const blocks = codeBlocks(readFileSync(join(root, 'README.md'), 'utf8'))
const work = makeTempDir('aster-readme-')
afterAll(() => removeTempDir(work))

describe('the paths the README blocks are checked against', () => {
  it('are the manifests\' `exports`: every public entry, with the file it declares', () => {
    const p = PATHS
    expect(p['@aster-charts/core/dom'][0]).toBe(dist('core', 'addon-dom.d.ts'))
    expect(p['@aster-charts/react/lite'], 'a sub-path the old copy did not map').toBeDefined()
    expect(p['@aster-charts/react/vl']).toBeDefined()
    expect(Object.keys(p).filter((k) => k.startsWith('@aster-charts/')).length).toBeGreaterThanOrEqual(20)
    for (const [spec, [file]] of Object.entries(p)) if (spec.startsWith('@aster-charts/')) expect(existsSync(file), `${spec} -> ${file}: run pnpm build`).toBe(true)
  })

  it('a README block that imports createChartSession from @aster-charts/core/dom type-checks (the entry the old map got wrong)', () => {
    const dir = makeTempDir('aster-readme-dom-')
    try {
      const file = join(dir, 'dom.ts')
      writeFileSync(file, `import { createChartSession, chartSkeleton } from '@aster-charts/core/dom'\nexport const x = [createChartSession, chartSkeleton]\n`)
      const program = ts.createProgram({
        rootNames: [file],
        options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true, baseUrl: root, paths: PATHS },
      })
      expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    } finally { removeTempDir(dir) }
  })
})

describe('the code blocks of README.md', () => {
  it('has the blocks the README is about', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5)
    expect(blocks[0].code).toContain('renderSpec')
  })

  it('type-check against the built packages', () => {
    expect(missingBuilds(), 'run pnpm build').toEqual([])
    expect(typeCheckBlocks('README.md', blocks, work)).toEqual([])
  }, 120_000)

  describe('the first charts render', () => {
    const run = async (index) => {
      const dir = join(work, `run-${index}`)
      mkdirSync(dir, { recursive: true })
      let js = ts.transpileModule(blocks[index].code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      js = js.replace(/'@aster-charts\/core'/g, JSON.stringify(pathToFileURL(dist('core', 'index.js')).href))
      js = js.replace(/'@aster-charts\/vl'/g, JSON.stringify(pathToFileURL(dist('vl', 'index.js')).href))
      const file = join(dir, 'example.mjs')
      writeFileSync(file, `${js}\nexport { svg }\n`)
      return (await import(pathToFileURL(file).href)).svg
    }

    it('a Vega spec: three bars and two axes', async () => {
      const svg = await run(0)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.match(/class="mark-rect/g) ?? []).toHaveLength(1)
      expect(svg.match(/<path [^>]*fill="#4c78a8"/g) ?? []).toHaveLength(3)
      expect(svg.match(/role-axis"/g) ?? []).toHaveLength(2)
    })

    it('a Vega-Lite spec: three bars', async () => {
      const svg = await run(1)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.match(/<path [^>]*role="graphics-symbol"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    })
  })
})
