/**
 * The published declarations, compiled as a consumer compiles them (the TypeScript API, against the built `dist` of the packages):
 *
 *  - no DOM lib: every entry of `@aster-charts/core` must compile with `lib: ["es2022"]`, `types: []`, `skipLibCheck: false`
 *    (a Node service that renders to SVG has no `Element`, `URL` or `fetch` in its types; with `skipLibCheck` the missing names
 *    would quietly become `any`), and with the DOM lib the web-platform types must be the platform's own (C688);
 *  - what the docs tell a host to write compiles: `diffRows`' result as `dataPulse` / a stream pulse (C278), the scene fields
 *    the docs name (`item.image`, `item.tooltip`, `scene.signalParams`, `scene.__limits`) (C538).
 *
 * A check that cannot fail proves nothing: each block has a `@error` twin that must fail, so the program is known to be reading the
 * declarations it is asked about.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..', '..', 'core')
const exportsOf = (pkg: string): string[] => Object.keys((JSON.parse(readFileSync(join(HERE, '..', '..', pkg, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports).filter((k) => k !== './package.json')

/** The declaration files every program reads (the libs, the packages' dist), parsed once: a parse of lib.dom.d.ts is most of a program's cost. */
const parsed = new Map<string, ts.SourceFile | undefined>()

/** Compile `source` as a module living in this package (so `@aster-charts/*` resolves to the workspace's dist). */
function diagnose(source: string, lib: string[]): string[] {
  const file = join(HERE, '__consumer__.ts')
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib, types: [], skipLibCheck: false,
  }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) => {
    if (name === file) return ts.createSourceFile(name, source, languageVersion)
    const key = `${languageVersion}:${name}`
    if (!parsed.has(key)) parsed.set(key, read(name, languageVersion, ...rest))
    return parsed.get(key)
  }
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => name === file || fileExists(name)
  const program = ts.createProgram({ rootNames: [file], options, host })
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => `${d.file ? d.file.fileName.replace(/^.*\/packages\//, '') : ''}${d.file && d.start != null ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : ''} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
}

const ES = ['lib.es2022.d.ts']
const WITH_DOM = ['lib.es2022.d.ts', 'lib.dom.d.ts']
const specifier = (pkg: string, key: string): string => (key === '.' ? pkg : `${pkg}/${key.slice(2)}`)

describe('the declarations need no DOM lib (C688)', () => {
  const entries = [...exportsOf('core').map((k) => specifier('@aster-charts/core', k)), ...exportsOf('vl').map((k) => specifier('@aster-charts/vl', k))]
  it('the package has the entries the test expects to see', () => {
    expect(entries).toContain('@aster-charts/core')
    expect(entries).toContain('@aster-charts/core/dom')
    expect(entries).toContain('@aster-charts/core/signals')
    expect(entries).toContain('@aster-charts/vl')
    expect(entries.length).toBeGreaterThanOrEqual(10)
  })

  it.each(entries)('%s compiles with lib es2022, no types, skipLibCheck off', (entry) => {
    expect(diagnose(`import * as m from '${entry}'\nexport default m\n`, ES)).toEqual([])
  }, 120_000)

  it.each(entries)('%s compiles with the DOM lib too', (entry) => {
    expect(diagnose(`import * as m from '${entry}'\nexport default m\n`, WITH_DOM)).toEqual([])
  }, 120_000)

  it('the check bites: a declaration that names a DOM global is found', () => {
    // (a consumer of a declaration naming `Element` with no DOM lib)
    expect(diagnose('export declare function f(el: Element): void\n', ES).join('\n')).toMatch(/Cannot find name 'Element'/)
  })

  it('the platform types are the platform own where the consumer has them, and a host element is accepted where there is no DOM', () => {
    // with the DOM lib `patchSceneDom` takes an Element (a number is refused); without it, any object (the DOM is not named)
    const call = "import { patchSceneDom } from '@aster-charts/core/dom'\nimport type { SceneRoot } from '@aster-charts/core'\ndeclare const scene: SceneRoot\npatchSceneDom(THING, scene)\n"
    expect(diagnose(call.replace('THING', 'document.body'), WITH_DOM)).toEqual([])
    expect(diagnose(call.replace('THING', '3'), WITH_DOM).join('\n')).toMatch(/not assignable to parameter of type 'Element'/)
    expect(diagnose(call.replace('THING', '{}'), ES)).toEqual([])
  }, 120_000)
})

describe('what the docs tell a host to write compiles (C278, C538)', () => {
  const head = `import { createChartStream, diffRows, type RuntimeInput, type SceneItem, type SceneRoot } from '@aster-charts/core'\n`

  it('the result of diffRows is a dataPulse and a stream pulse (C278)', () => {
    const src = head + `
const a = [{ x: 1 }]
const b = [{ x: 1 }, { x: 2 }]
const d = diffRows(a, b)!
export const input: RuntimeInput = { data: { t: b }, dataPulse: { t: d } }
createChartStream({}).push({ data: { t: b }, pulse: { t: d } })
`
    expect(diagnose(src, WITH_DOM)).toEqual([])
    // the twin: something that is neither shape is refused, so the lines above were really checked
    expect(diagnose(head + "export const input: RuntimeInput = { dataPulse: { t: { added: 3 } } }\n", WITH_DOM)).not.toEqual([])
  }, 120_000)

  it('the scene fields the docs name are declared (C538)', () => {
    const src = head + `
declare const item: SceneItem
declare const scene: SceneRoot
export const image: { width: number; height: number } | null | undefined = item.image
export const tip: unknown = item.tooltip
export const params: Record<string, unknown> | undefined = scene.signalParams
export const maxTimeMs: number | undefined = scene.__limits?.maxTimeMs
`
    expect(diagnose(src, WITH_DOM)).toEqual([])
    expect(diagnose(head + 'declare const item: SceneItem\nexport const nope = item.imagee\n', WITH_DOM)).not.toEqual([])
  }, 120_000)

  it('what bindSceneSignals reads off a scene needs no cast to be passed by hand (C538)', () => {
    const src = `import type { SceneRoot } from '@aster-charts/core'
import { bindSignalEvents } from '@aster-charts/core/signals'
declare const el: Element
declare const scene: SceneRoot
if (scene.compiled && scene.runtime) bindSignalEvents(el, scene.compiled, scene.runtime, scene.signalParams ?? {}, {}, {}, { limits: scene.__limits, scene })
`
    expect(diagnose(src, WITH_DOM)).toEqual([])
  }, 120_000)
})
