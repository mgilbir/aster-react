/**
 * The code blocks of README.md are checked: every `ts` / `tsx` block type-checks against the built packages, and the first two
 * (a Vega spec and a Vega-Lite spec rendered to an SVG string, the first chart a reader types) are run.
 *
 * The blocks are read from the README itself, so an edit that breaks one fails here. The packages are the built `dist` of each
 * workspace (this test needs `pnpm build`, which `pnpm check` runs first), mapped to the specifiers the README imports.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = (name) => join(root, 'packages', name)
const dist = (name, file) => join(pkg(name), 'dist', file)

/** The ts / tsx fenced blocks of a markdown text, with the 1-based line each starts on. */
function codeBlocks(markdown) {
  const blocks = []
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(tsx?)\s*$/.exec(lines[i])
    if (!open) continue
    const start = i + 1
    const body = []
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i])
    blocks.push({ lang: open[1], line: start, code: body.join('\n') + '\n' })
  }
  return blocks
}

const blocks = codeBlocks(readFileSync(join(root, 'README.md'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'aster-readme-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const REACT_TYPES = join(pkg('react'), 'node_modules', '@types', 'react')
const PATHS = {
  '@aster/core': [dist('core', 'index.d.ts')],
  '@aster/core/dom': [dist('core', 'dom.d.ts')],
  '@aster/react': [dist('react', 'index.d.ts')],
  '@aster/vl': [dist('vl', 'index.d.ts')],
  react: [join(REACT_TYPES, 'index.d.ts')],
  'react/jsx-runtime': [join(REACT_TYPES, 'jsx-runtime.d.ts')],
}

describe('the code blocks of README.md', () => {
  it('has the blocks the README is about', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5)
    expect(blocks[0].code).toContain('renderSpec')
  })

  it('type-check against the built packages', () => {
    for (const p of Object.values(PATHS)) expect(existsSync(p[0]), `${p[0]} is missing: run pnpm build`).toBe(true)
    const files = blocks.map((b, i) => {
      const file = join(work, `block-${i}-line-${b.line}.${b.lang}`)
      // every block is a module of its own: exports keep names from colliding across blocks
      writeFileSync(file, `${b.code}\nexport {}\n`)
      return file
    })
    const program = ts.createProgram(files, {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      types: [],
      baseUrl: '/',
      paths: PATHS,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && files.includes(d.file.fileName))
    const report = diagnostics.map((d) => {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start)
      return `${d.file.fileName.split('/').pop()}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
    })
    expect(report).toEqual([])
  }, 120_000)

  describe('the first charts render', () => {
    const run = async (index) => {
      const dir = join(work, `run-${index}`)
      mkdirSync(dir, { recursive: true })
      let js = ts.transpileModule(blocks[index].code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      js = js.replace(/'@aster\/core'/g, JSON.stringify(pathToFileURL(dist('core', 'index.js')).href))
      js = js.replace(/'@aster\/vl'/g, JSON.stringify(pathToFileURL(dist('vl', 'index.js')).href))
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
