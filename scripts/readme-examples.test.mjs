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

/** The `types` target of an `exports` entry (`{ types, default }`, possibly under a condition such as `browser`). */
function typesTarget(entry) {
  if (typeof entry === 'string') return entry.endsWith('.d.ts') ? entry : null
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.types === 'string') return entry.types
  for (const v of Object.values(entry)) { const t = typesTarget(v); if (t) return t }
  return null
}

/**
 * `paths` for every public entry of the three packages, from each manifest's own `exports` map: what a reader's `import` resolves to, so
 * the test cannot keep a second, drifting copy of the map (it mapped `@aster-charts/core/dom` to `dom.d.ts`, which is not what `exports`
 * says, and had no `@aster-charts/react/lite`).
 */
export function pathsFromExports() {
  const paths = {}
  for (const name of ['core', 'react', 'vl']) {
    const manifest = JSON.parse(readFileSync(join(pkg(name), 'package.json'), 'utf8'))
    for (const [sub, entry] of Object.entries(manifest.exports ?? {})) {
      if (sub.includes('*') || sub === './package.json') continue
      const target = typesTarget(entry)
      if (target) paths[sub === '.' ? manifest.name : `${manifest.name}/${sub.slice(2)}`] = [join(pkg(name), target)]
    }
  }
  return paths
}

const REACT_TYPES = join(pkg('react'), 'node_modules', '@types', 'react')
const PATHS = {
  ...pathsFromExports(),
  react: [join(REACT_TYPES, 'index.d.ts')],
  'react/jsx-runtime': [join(REACT_TYPES, 'jsx-runtime.d.ts')],
}

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
    const dir = mkdtempSync(join(tmpdir(), 'aster-readme-dom-'))
    try {
      const file = join(dir, 'dom.ts')
      writeFileSync(file, `import { createChartSession, chartSkeleton } from '@aster-charts/core/dom'\nexport const x = [createChartSession, chartSkeleton]\n`)
      const program = ts.createProgram({
        rootNames: [file],
        options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true, baseUrl: root, paths: PATHS },
      })
      expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

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
