/**
 * The dependency-boundary check must bite on every import form. Each case plants
 * a violation in a throw-away repo fixture and runs the real CLI against it; the
 * clean fixture and the negative controls prove the check is not simply failing.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-deps.mjs')
const PKGS = ['core', 'react', 'vl']
const made = []

function put(root, rel, text) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

/** A clean three-package repo with built output. `edit` plants the violation. */
function fixture(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'aster-checkdeps-'))
  made.push(root)
  for (const p of PKGS) {
    put(root, `packages/${p}/package.json`, JSON.stringify({ name: `@aster/${p}`, dependencies: {} }))
    put(root, `packages/${p}/dep-baseline.json`, JSON.stringify({ imports: {}, deps: [] }))
    put(root, `packages/${p}/src/index.ts`, `export const x = 1\n`)
    put(root, `packages/${p}/dist/index.js`, `export const x = 1\n`)
    put(root, `packages/${p}/dist/index.d.ts`, `export declare const x = 1\n`)
  }
  edit((rel, text) => put(root, rel, text), root)
  return root
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

describe('check-deps', () => {
  it('passes on a clean repo', () => {
    const r = run(fixture())
    expect(r.code, r.out).toBe(0)
  })

  const srcViolations = {
    'bare vega': `import * as vega from 'vega'\nexport { vega }\n`,
    'bare d3': `import * as d3 from 'd3'\nexport { d3 }\n`,
    'default import': `import vega from "vega"\nexport default vega\n`,
    'side-effect import': `import 'vega'\n`,
    'type-only import': `import type { Spec } from 'vega'\nexport type S = Spec\n`,
    'inline type specifier': `import { type Spec } from 'vega-lite'\nexport type S = Spec\n`,
    'export star': `export * from 'd3-array'\n`,
    'export named from': `export { scaleLinear } from 'd3-scale'\n`,
    'export type from': `export type { Spec } from 'vega-typings'\n`,
    'import = require': `import vega = require('vega')\nexport { vega }\n`,
    'dynamic import': `export const f = () => import('vega')\n`,
    'dynamic import, template literal': 'export const f = () => import(`vega`)\n',
    'dynamic import, template with tail': 'export const f = (n: string) => import(`vega/${n}`)\n',
    'dynamic import, concatenation': `export const f = () => import('ve' + 'ga')\n`,
    'dynamic import, parenthesised': `export const f = () => import(('vega' as const))\n`,
    'require': `declare const require: (s: string) => unknown\nexport const v = require('vega')\n`,
    'require, template literal': 'declare const require: (s: string) => unknown\nexport const v = require(`d3-array`)\n',
    'require.resolve': `declare const require: any\nexport const v = require.resolve('vega')\n`,
    'import.meta.resolve': `export const v = import.meta.resolve('vega')\n`,
    'importScripts': `declare function importScripts(s: string): void\nimportScripts('vega')\n`,
    'import type node': `export type S = import('vega').Spec\n`,
    'triple-slash types reference': `/// <reference types="d3" />\nexport const x = 1\n`,
    'vega-lite': `import { compile } from 'vega-lite'\nexport { compile }\n`,
    'vega-embed': `import embed from 'vega-embed'\nexport { embed }\n`,
    'topojson': `import * as t from 'topojson'\nexport { t }\n`,
    'topojson-client': `import { feature } from 'topojson-client'\nexport { feature }\n`,
    'subpath import': `import { x } from 'd3/src/index.js'\nexport { x }\n`,
    '@types stub': `import type { Selection } from '@types/d3'\nexport type S = Selection\n`,
    'jsx file': `import vega from 'vega'\nexport const A = () => <div>{String(vega)}</div>\n`,
    'mts file': `import 'vega'\n`,
  }
  for (const [name, text] of Object.entries(srcViolations)) {
    it(`src: ${name}`, () => {
      const ext = name === 'jsx file' ? 'tsx' : name === 'mts file' ? 'mts' : 'ts'
      const root = fixture((w) => w(`packages/core/src/bad.${ext}`, text))
      const r = run(root)
      expect(r.code, r.out).toBe(1)
      // detected as the banned package itself, not merely rejected as unreadable
      expect(r.out).toMatch(/banned import not in baseline: packages\/core\/src\/bad\.\w+ imports "(@types\/)?(vega|d3|topojson)/)
    })
  }

  const unanalyzable = {
    'computed dynamic import': `export const f = (n: string) => import(n)\n`,
    'template with dynamic head': 'export const f = (n: string) => import(`${n}/x`)\n',
    'template, name not complete': 'export const f = (n: string) => import(`vega${n}`)\n',
    'aliased require': `declare const require: any\nconst r = require\nexport const v = r('vega')\n`,
    'comma-indirect require': `declare const require: any\nexport const v = (0, require)('vega')\n`,
    'createRequire': `import { createRequire } from 'node:module'\nexport const r = createRequire(import.meta.url)\n`,
  }
  for (const [name, text] of Object.entries(unanalyzable)) {
    it(`src: unanalyzable ${name}`, () => {
      const r = run(fixture((w) => w('packages/react/src/bad.ts', text)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/unanalyzable/)
    })
  }

  const manifestViolations = {
    dependencies: { dependencies: { vega: '^6' } },
    peerDependencies: { peerDependencies: { 'd3-array': '*' } },
    optionalDependencies: { optionalDependencies: { 'vega-lite': '*' } },
    bundledDependencies: { bundledDependencies: ['topojson-client'] },
    bundleDependencies: { bundleDependencies: ['d3'] },
    'imports alias': { imports: { '#v': { node: 'vega', default: './x.js' } } },
  }
  for (const [name, patch] of Object.entries(manifestViolations)) {
    it(`manifest: ${name}`, () => {
      const root = fixture((w) =>
        w('packages/vl/package.json', JSON.stringify({ name: '@aster/vl', ...patch })))
      const r = run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/packages\/vl\/package\.json|banned dependency/)
    })
  }

  describe('built dist', () => {
    it('flags a banned import in dist .js while src is clean', () => {
      const r = run(fixture((w) => w('packages/core/dist/leak.js', `import * as v from 'vega'\nexport { v }\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/core\/dist\/leak\.js/)
    })
    it('flags a banned import in dist .d.ts', () => {
      const r = run(fixture((w) => w('packages/react/dist/types.d.ts', `export type S = import('vega-lite').TopLevelSpec\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/react\/dist\/types\.d\.ts/)
    })
    it('flags a nested dist .cjs require', () => {
      const r = run(fixture((w) => w('packages/vl/dist/deep/x.cjs', `module.exports = require('d3-array')\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/packages\/vl\/dist\/deep\/x\.cjs/)
    })
    it('fails when dist is missing, passes with --src-only', () => {
      const root = fixture()
      rmSync(join(root, 'packages/core/dist'), { recursive: true })
      expect(run(root).code).toBe(1)
      expect(run(root, '--src-only').code).toBe(0)
    })
    it('--src-only does not hide a src violation', () => {
      const root = fixture((w) => w('packages/core/src/bad.ts', `import 'vega'\n`))
      expect(run(root, '--src-only').code).toBe(1)
    })
  })

  describe('negative controls (must not be flagged)', () => {
    it('ignores comments, strings, relative/internal/builtin imports and lookalike names', () => {
      const root = fixture((w) => {
        w('packages/core/src/ok.ts', [
          `// import 'vega'  and  require('d3')`,
          `/* import('vega-lite') */`,
          `export const doc = "import x from 'vega'"`,
          'export const tpl = `from "d3-array"`',
          `import { readFileSync } from 'node:fs'`,
          `import { x } from './index'`,
          `import 'react'`,
          `import type { Y } from '@aster/core'`,
          `import 'vegas'`,
          `import 'd3x'`,
          `import 'my-vega'`,
          'export const dyn = (n: string) => import(`./locale/${n}.js`)',
          `export const m = { require: 1, createRequire: 2 }`,
          `export const k = m.require`,
          '',
        ].join('\n'))
      })
      const r = run(root)
      expect(r.code, r.out).toBe(0)
    })
    it('allows devDependencies on the oracle (tests/benchmarks use it)', () => {
      const root = fixture((w) =>
        w('packages/core/package.json', JSON.stringify({ name: '@aster/core', devDependencies: { vega: '^6' } })))
      expect(run(root).code).toBe(0)
    })
  })
})
