/**
 * The `ts` / `tsx` code blocks of the repository's markdown, and what it takes to type-check them against the built packages.
 *
 * Shared by `scripts/readme-examples.test.mjs` (README.md, and the first two blocks are run) and `scripts/docs-examples.test.mjs` (every
 * other document that has such a block). A block is read from the document itself, so an edit that breaks one fails there; the
 * packages are the built `dist` of each workspace, resolved through each manifest's own `exports` map, so a documented import is
 * checked as a reader's `import` resolves it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = (name) => join(root, 'packages', name)

/** The ts / tsx fenced blocks of a markdown text, with the 1-based line each starts on. */
export function codeBlocks(markdown) {
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
 * the test cannot keep a second, drifting copy of the map (an earlier one pointed `@aster-charts/core/dom` at a declaration file that
 * is not what `exports` says, and had no `@aster-charts/react/lite`).
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
const REACT_DOM_TYPES = join(pkg('react'), 'node_modules', '@types', 'react-dom')
/** Every specifier a block may import: the packages' entries, and React's. */
export const PATHS = {
  ...pathsFromExports(),
  react: [join(REACT_TYPES, 'index.d.ts')],
  'react/jsx-runtime': [join(REACT_TYPES, 'jsx-runtime.d.ts')],
  'react-dom': [join(REACT_DOM_TYPES, 'index.d.ts')],
  'react-dom/client': [join(REACT_DOM_TYPES, 'client.d.ts')],
  'react-dom/server': [join(REACT_DOM_TYPES, 'server.d.ts')],
}

/** Every path of `PATHS` exists (the packages are built). */
export function missingBuilds() {
  return Object.entries(PATHS).filter(([, [file]]) => !existsSync(file)).map(([spec, [file]]) => `${spec} -> ${file}`)
}

/**
 * Type-check `blocks` (`{ lang, line, code }`), each as a module of its own, written under `dir` as `<label>-<line>.<lang>`: the
 * diagnostics as `<label>:<line> <message>` lines, empty when every block compiles.
 */
export function typeCheckBlocks(label, blocks, dir) {
  const files = blocks.map((b, i) => {
    const file = join(dir, `${label.replace(/[^\w]/g, '_')}-${i}-line-${b.line}.${b.lang}`)
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
  return ts.getPreEmitDiagnostics(program).filter((d) => d.file && files.includes(d.file.fileName)).map((d) => {
    const { line } = d.file.getLineAndCharacterOfPosition(d.start)
    const at = blocks[files.indexOf(d.file.fileName)]
    return `${label}:${at.line + line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]}`
  })
}
