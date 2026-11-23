/**
 * The import scanner behind the dependency boundary (scripts/lib/scan-imports.mjs), driven by a generated table:
 * every way of writing a module reference, crossed with every kind of forbidden target. A form the scanner reads must yield the
 * target; a form it cannot read must be reported as unanalyzable; and the same forms hidden in comments and strings must yield nothing.
 * (C40, C104)
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySpec, scanSource } from './lib/scan-imports.mjs'

const PKG = '/repo/packages/core'
const classify = (spec, file = `${PKG}/src/a.ts`) => classifySpec(spec, { file, packageDir: PKG })

/** `$` is replaced by the specifier. Every form here reads the specifier statically. */
const READ_FORMS = {
  'default import': `import x from '$'`,
  'namespace import': `import * as x from '$'`,
  'named import': `import { x } from '$'`,
  'side-effect import': `import '$'`,
  'type import': `import type { T } from '$'`,
  'inline type import': `import { type T } from '$'`,
  'import with attributes': `import x from '$' with { type: 'json' }`,
  'export star': `export * from '$'`,
  'export star as': `export * as x from '$'`,
  'export named': `export { x } from '$'`,
  'export type': `export type { T } from '$'`,
  'import equals require': `import x = require('$')`,
  'dynamic import': `import('$')`,
  'dynamic import, double quotes': `import("$")`,
  'dynamic import, template': 'import(`$`)',
  'dynamic import, concatenation': `import('' + '$')`,
  'dynamic import, parenthesised': `import(('$'))`,
  'dynamic import, as': `import('$' as string)`,
  'dynamic import, with options': `import('$', { with: { type: 'json' } })`,
  'await dynamic import': `await import('$')`,
  'require': `require('$')`,
  'require, template': 'require(`$`)',
  'require.resolve': `require.resolve('$')`,
  'module.require': `module.require('$')`,
  'globalThis.require': `globalThis.require('$')`,
  'element access require': `globalThis['require']('$')`,
  'element access require, template key': 'module[`require`]("$")',
  'element access on a call': `getModule()['require']('$')`,
  'import.meta.resolve': `import.meta.resolve('$')`,
  'importScripts': `importScripts('$')`,
  'import type node': `type T = import('$').X`,
  'typeof import type': `type T = typeof import('$')`,
  'triple-slash types': `/// <reference types="$" />`,
  'ambient module': `declare module '$' { export const x: number }`,
  'ambient module augmentation': `declare module '$' { interface X {} }\nexport {}`,
}

/** Every form that hands out a loader without a literal to read: all must come back unanalyzable. */
const UNREADABLE_FORMS = {
  'computed dynamic import': `import(name)`,
  'template with dynamic head': 'import(`${name}/x`)',
  'template cut inside the package name': 'import(`vega${name}`)',
  'aliased require': `const r = require; r('vega')`,
  'comma-indirect require': `(0, require)('vega')`,
  'createRequire named import': `import { createRequire } from 'node:module'; createRequire(import.meta.url)('vega')`,
  'createRequire through a namespace': `import * as m from 'node:module'; m.createRequire(import.meta.url)('vega')`,
  'createRequire through a default': `import m from 'node:module'; m.createRequire(import.meta.url)('vega')`,
  'createRequire, element access': `import * as m from 'node:module'; m['createRequire'](import.meta.url)('vega')`,
  'createRequire, destructured': `const { createRequire } = process.getBuiltinModule('module'); createRequire(import.meta.url)('vega')`,
  'getBuiltinModule': `process.getBuiltinModule('module').createRequire(import.meta.url)('d3')`,
  'getBuiltinModule, element access': `process['getBuiltinModule']('module')`,
  'getBuiltinModule, called later': `const g = process.getBuiltinModule; g('module')`,
  'a read of .require': `const r = module.require; r('vega')`,
  'a read of ["require"]': `const r = module['require']; r('vega')`,
  'require destructured': `const { require: r } = module; r('vega')`,
  'require passed on': `load(require)`,
  'eval': `eval("import('vega')")`,
  'new Function': `new Function("return import('vega')")()`,
  'Function call': `Function("return import('vega')")()`,
}

/** The forms of READ_FORMS in comments and strings, and names that only look like loaders: nothing to report. */
const INERT = {
  'line comment': (f) => `// ${f}\nexport const x = 1`,
  'block comment': (f) => `/* ${f} */\nexport const x = 1`,
  'jsdoc': (f) => `/**\n * ${f}\n */\nexport const x = 1`,
  'single-quoted string': (f) => `export const s = ${JSON.stringify(f).replace(/^"|"$/g, "'").replace(/'/g, "\\'")}`,
  'double-quoted string': (f) => `export const s = ${JSON.stringify(f)}`,
  'template string': (f) => `export const s = \`${f.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``,
  'string in a call': (f) => `console.log(${JSON.stringify(f)})`,
  'regex literal': () => `export const r = /import\\(['"]vega['"]\\)/`,
}

const BANNED_SPECS = ['vega', 'vega-lite', 'vega-embed', 'd3', 'd3-array', 'd3-scale', 'topojson', 'topojson-client', '@types/d3', '@types/topojson-client', 'vega/build/vega.js', 'd3/src/index.js', 'vega-lite/build/vega-lite.js']

const apply = (form, spec) => form.replaceAll('$', spec)

describe('scanSource reads every import form (generated: form x banned target)', () => {
  for (const [name, form] of Object.entries(READ_FORMS)) {
    it(`${name}: yields the target and nothing is unanalyzable`, () => {
      for (const spec of BANNED_SPECS) {
        const r = scanSource(apply(form, spec), name.includes('triple') || name.includes('ambient') ? 'a.d.ts' : 'a.ts')
        const known = form.includes('require') || form.includes('importScripts')
        expect(r.specs, `${name} ${spec}: ${apply(form, spec)}`).toContain(spec)
        // a loader the scanner read a literal off is fine; a form with no loader must not be reported at all
        if (!known) expect(r.unanalyzable, `${name} ${spec}`).toEqual([])
        expect(classify(spec), spec).toMatchObject({ kind: 'banned' })
      }
    })
  }
  it('has enough forms that a dropped branch of the scanner shows (guards the table itself)', () => {
    expect(Object.keys(READ_FORMS).length).toBeGreaterThanOrEqual(30)
    expect(Object.keys(UNREADABLE_FORMS).length).toBeGreaterThanOrEqual(15)
  })
})

describe('scanSource reports what it cannot read (generated)', () => {
  for (const [name, text] of Object.entries(UNREADABLE_FORMS)) {
    it(`${name}: unanalyzable`, () => {
      const r = scanSource(text, 'a.ts')
      expect(r.unanalyzable.length, text).toBeGreaterThan(0)
    })
  }
})

describe('scanSource ignores lookalikes (generated: wrapper x form)', () => {
  for (const [wrapper, wrap] of Object.entries(INERT)) {
    it(`${wrapper}: nothing found for any form`, () => {
      for (const [name, form] of Object.entries(READ_FORMS)) {
        const text = wrap(apply(form, 'vega'))
        const r = scanSource(text, 'a.ts')
        expect({ name, specs: r.specs, unanalyzable: r.unanalyzable }, text).toEqual({ name, specs: [], unanalyzable: [] })
      }
      for (const [name, form] of Object.entries(UNREADABLE_FORMS)) {
        const r = scanSource(wrap(form), 'a.ts')
        expect({ name, specs: r.specs, unanalyzable: r.unanalyzable }).toEqual({ name, specs: [], unanalyzable: [] })
      }
    })
  }

  it('names that only look like loaders are fine', () => {
    for (const text of [
      `export const m = { require: 1, createRequire: 2, getBuiltinModule: 3 }`,
      `interface X { require: string; createRequire(): void }`,
      `class C { require() {} createRequire = 1 }`,
      `import { x } from './require'`,
      `import { x } from 'react'\nexport const requireAll = x`,
      `export const f = (requires: string[]) => requires.length`,
    ]) expect(scanSource(text, 'a.ts'), text).toEqual({ specs: expect.any(Array), unanalyzable: [] })
  })
})

describe('new URL(..., import.meta.url) and /// <reference path>', () => {
  it('reads the literal as a module URL', () => {
    expect(scanSource(`new Worker(new URL('./w.js', import.meta.url))`, 'a.ts').specs).toEqual(['./w.js'])
    expect(scanSource(`new URL('https://esm.sh/vega@6', import.meta.url)`, 'a.ts').specs).toEqual(['https://esm.sh/vega@6'])
    expect(scanSource(`new URL('w.js', import.meta.url)`, 'a.ts').specs).toEqual(['./w.js'])
    expect(scanSource(`new URL('../../conformance/node_modules/vega/build/vega.js', import.meta.url)`, 'a.ts').specs).toEqual(['../../conformance/node_modules/vega/build/vega.js'])
  })
  it('does not read a URL that is not relative to the module', () => {
    expect(scanSource(`new URL('https://x.test/a', base)`, 'a.ts').specs).toEqual([])
    expect(scanSource(`new URL(x, import.meta.url)`, 'a.ts')).toEqual({ specs: [], unanalyzable: [] })
  })
  it('reads path references and amd-dependency', () => {
    expect(scanSource(`/// <reference path="../../x/vega-typings/index.d.ts" />\nexport {}`, 'a.d.ts').specs).toEqual(['../../x/vega-typings/index.d.ts'])
    expect(scanSource(`/// <reference path="local.d.ts" />\nexport {}`, 'a.d.ts').specs).toEqual(['./local.d.ts'])
    expect(scanSource(`/// <amd-dependency path="vega" />\nexport {}`, 'a.d.ts').specs).toContain('vega')
  })
})

describe('classifySpec', () => {
  const at = (spec, opts) => classifySpec(spec, { file: `${PKG}/dist/sub/a.js`, packageDir: PKG, ...opts })

  it('flags URLs and other schemes, whatever they point at', () => {
    for (const spec of [
      'https://esm.sh/vega@6', 'http://cdn.example/d3.js', 'https://cdn.jsdelivr.net/npm/d3@7/+esm', 'HTTPS://ESM.SH/vega', 'data:text/javascript,import "vega"',
      'blob:https://x/1', 'file:///repo/packages/conformance/node_modules/vega/build/vega.js', 'ws://x/y', 'jsr:@std/x', 'npm:left-pad', 'deno:x',
    ]) expect(at(spec), spec).toMatchObject({ kind: expect.stringMatching(/scheme|banned/) })
    expect(at('npm:vega@6')).toMatchObject({ kind: 'banned', name: 'vega' })
    expect(at('npm:vega-lite')).toMatchObject({ kind: 'banned' })
  })
  it('flags a relative path out of the package or into a node_modules', () => {
    expect(at('../../../conformance/node_modules/vega/build/vega.js')).toMatchObject({ kind: 'escape' })
    expect(at('../../../conformance/src/x.js')).toMatchObject({ kind: 'escape' })
    expect(at('../../../../core/dist/x.js')).toMatchObject({ kind: 'escape' })
    expect(at('/etc/passwd')).toMatchObject({ kind: 'escape' })
    expect(at('/repo/packages/core/dist/x.js')).toBeNull() // an absolute path that stays inside is only odd
    expect(at('../node_modules/vega/build/vega.js')).toMatchObject({ kind: 'escape' })
    expect(at('../../node_modules/x.js')).toMatchObject({ kind: 'escape' })
  })
  it('lets a path stay inside the package, builtins, and ordinary packages', () => {
    for (const spec of ['./a.js', '../b.js', './deep/er/c.js', '../../dist/d.js', 'node:fs', 'node:module', 'react', '@aster-charts/core', '@aster-charts/core/dom', 'vegas', 'd3x', 'my-vega', '#internal']) {
      expect(at(spec), spec).toBeNull()
    }
  })
  it('a test file may read a sibling package by path, never an oracle node_modules', () => {
    expect(at('../../../vl/dist/index.js', { allowSiblings: true })).toBeNull()
    expect(at('../../../conformance/node_modules/vega/build/vega.js', { allowSiblings: true })).toMatchObject({ kind: 'escape' })
  })
  it('works with a package directory in a temp path', () => {
    const dir = join('/tmp', 'fx', 'packages', 'core')
    expect(classifySpec('../../react/src/x.js', { file: join(dir, 'src', 'a.ts'), packageDir: dir })).toMatchObject({ kind: 'escape' })
  })
})
