/**
 * The dependency-boundary check must bite on every import form. Each case plants
 * a violation in a throw-away repo fixture and runs the real CLI against it; the
 * clean fixture and the negative controls prove the check is not simply failing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { makeTempDir, removeTempDir } from './lib/temp-dir.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

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
  const root = makeTempDir('aster-checkdeps-')
  made.push(root)
  for (const p of PKGS) {
    put(root, `packages/${p}/package.json`, JSON.stringify({ name: `@aster-charts/${p}`, dependencies: {}, files: ['dist'] }))
    put(root, `packages/${p}/dep-baseline.json`, JSON.stringify({ imports: {}, deps: [] }))
    put(root, `packages/${p}/src/index.ts`, `export const x = 1\n`)
    put(root, `packages/${p}/dist/index.js`, `export const x = 1\n`)
    put(root, `packages/${p}/dist/index.d.ts`, `export declare const x = 1\n`)
  }
  edit((rel, text) => put(root, rel, text), root)
  return root
}

async function run(root, ...args) {
  const r = await spawnAsync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

afterAll(() => {
  for (const d of made) removeTempDir(d)
})

describe('check-deps', () => {
  it('passes on a clean repo', async () => {
    const r = await run(fixture())
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
    it(`src: ${name}`, async () => {
      const ext = name === 'jsx file' ? 'tsx' : name === 'mts file' ? 'mts' : 'ts'
      const root = fixture((w) => w(`packages/core/src/bad.${ext}`, text))
      const r = await run(root)
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
    it(`src: unanalyzable ${name}`, async () => {
      const r = await run(fixture((w) => w('packages/react/src/bad.ts', text)))
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
    it(`manifest: ${name}`, async () => {
      const root = fixture((w) =>
        w('packages/vl/package.json', JSON.stringify({ name: '@aster-charts/vl', ...patch })))
      const r = await run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/packages\/vl\/package\.json|banned dependency/)
    })
  }

  // C104: the holes the first audit left (each case passed with exit 0 before).
  const holes = {
    'createRequire through a namespace': { file: 'packages/core/src/h.ts', text: `import * as m from 'node:module'\nexport const v = m.createRequire(import.meta.url)('vega')\n`, out: /unanalyzable/ },
    'process.getBuiltinModule': { file: 'packages/core/src/h.ts', text: `export const v = process.getBuiltinModule('module').createRequire(import.meta.url)('vega')\n`, out: /unanalyzable/ },
    'globalThis[require]': { file: 'packages/core/src/h.ts', text: `export const v = (globalThis as any)['require']('d3')\n`, out: /imports "d3"/ },
    'module[require]': { file: 'packages/react/src/h.ts', text: `declare const module: any\nexport const v = module['require']('d3')\n`, out: /imports "d3"/ },
    'dynamic import of a CDN URL': { file: 'packages/core/src/h.ts', text: `export const v = () => import('https://esm.sh/vega@6')\n`, out: /outside the boundary.*"https:\/\/esm\.sh\/vega@6" is not a package/s },
    'static import of a CDN URL': { file: 'packages/vl/src/h.ts', text: `import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm'\nexport { d3 }\n`, out: /outside the boundary/ },
    'data: URL import': { file: 'packages/core/src/h.ts', text: 'export const v = () => import("data:text/javascript,import \'vega\'")\n', out: /outside the boundary/ },
    'relative import into the oracle': { file: 'packages/core/src/h.ts', text: `import * as v from '../../conformance/node_modules/vega/build/vega.js'\nexport { v }\n`, out: /reaches into node_modules|leaves the package/ },
    'new URL into the oracle': { file: 'packages/core/src/h.ts', text: `export const u = new URL('../../conformance/node_modules/vega/build/vega.js', import.meta.url)\n`, out: /outside the boundary/ },
    'new URL of a CDN': { file: 'packages/core/src/h.ts', text: `export const u = new URL('https://esm.sh/vega', import.meta.url)\n`, out: /outside the boundary/ },
    'triple-slash path reference': { file: 'packages/core/dist/h.d.ts', text: `/// <reference path="../../../conformance/node_modules/vega-typings/types/build/vega.d.ts" />\nexport declare const x: number\n`, out: /outside the boundary in shipped output/ },
    'ambient declare module': { file: 'packages/react/dist/h.d.ts', text: `declare module 'vega' { export const x: number }\nexport declare const y: number\n`, out: /shipped output: packages\/react\/dist\/h\.d\.ts imports "vega"/ },
    'eval': { file: 'packages/core/src/h.ts', text: `export const v = eval("import('vega')")\n`, out: /unanalyzable.*dynamic code evaluation/s },
    'new Function': { file: 'packages/core/dist/h.js', text: `export const v = new Function("return import('vega')")\n`, out: /unanalyzable module specifier in shipped output/ },
    'a read of module.require': { file: 'packages/core/src/h.ts', text: `declare const module: any\nexport const r = module.require\n`, out: /unanalyzable/ },
  }
  for (const [name, c] of Object.entries(holes)) {
    it(`hole: ${name}`, async () => {
      const r = await run(fixture((w) => w(c.file, c.text)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(c.out)
    })
  }

  const manifestHoles = {
    'npm alias of vega': { dependencies: { 'chart-rt': 'npm:vega@^6' } },
    'npm alias of vega-lite as peer': { peerDependencies: { x: 'npm:vega-lite@6' } },
    'github shorthand': { dependencies: { x: 'vega/vega' } },
    'git url': { dependencies: { x: 'git+https://github.com/vega/vega.git#v6' } },
    'tarball url': { optionalDependencies: { x: 'https://registry.npmjs.org/vega/-/vega-6.0.0.tgz' } },
    'file range': { dependencies: { x: 'file:../conformance/node_modules/vega' } },
    'link range': { dependencies: { x: 'link:../conformance/node_modules/d3' } },
    'relative path range': { dependencies: { x: '../conformance/node_modules/vega' } },
  }
  for (const [name, patch] of Object.entries(manifestHoles)) {
    it(`manifest hole: ${name}`, async () => {
      const root = fixture((w) => w('packages/vl/package.json', JSON.stringify({ name: '@aster-charts/vl', ...patch })))
      const r = await run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/packages\/vl\/package\.json/)
    })
  }

  describe('every shipped path is scanned, not only dist (the `files` field)', () => {
    it('a bin/ directory listed in files', async () => {
      const root = fixture((w) => {
        w('packages/core/package.json', JSON.stringify({ name: '@aster-charts/core', files: ['dist', 'bin', 'README.md'] }))
        w('packages/core/bin/cli.mjs', `import 'vega'\n`)
      })
      const r = await run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/core\/bin\/cli\.mjs imports "vega"/)
    })
    it('a single file listed in files', async () => {
      const root = fixture((w) => {
        w('packages/vl/package.json', JSON.stringify({ name: '@aster-charts/vl', files: ['dist', 'worker.js'] }))
        w('packages/vl/worker.js', `importScripts('https://cdn/vega.js')\n`)
      })
      expect((await run(root)).code).toBe(1)
    })
    it('no `files` field means everything ships: a stray file at the package root is scanned', async () => {
      const root = fixture((w) => {
        w('packages/vl/package.json', JSON.stringify({ name: '@aster-charts/vl' }))
        w('packages/vl/stray.mjs', `import 'd3'\n`)
      })
      const r = await run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/vl\/stray\.mjs imports "d3"/)
    })
    it('a pattern in files cannot be scanned, so it fails', async () => {
      const root = fixture((w) => w('packages/vl/package.json', JSON.stringify({ name: '@aster-charts/vl', files: ['dist', 'lib/**/*.js'] })))
      const r = await run(root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/is a pattern/)
    })
    it('a clean extra path, a negation, and a missing optional path pass', async () => {
      const root = fixture((w) => {
        w('packages/core/package.json', JSON.stringify({ name: '@aster-charts/core', files: ['dist', '!dist/**/*.map', 'bin', 'README.md', 'LICENSE'] }))
        w('packages/core/bin/cli.mjs', `import { x } from '../dist/index.js'\nconsole.log(x)\n`)
      })
      const r = await run(root)
      expect(r.code, r.out).toBe(0)
    })
  })

  describe('the baselines still work for what they are for', () => {
    it('a baselined banned import in src is not reported as new', async () => {
      const root = fixture((w) => {
        w('packages/core/src/b.ts', `import 'vega'\n`)
        w('packages/core/dist/b.js', `import 'vega'\n`)
        w('packages/core/dep-baseline.json', JSON.stringify({ imports: { 'src/b.ts': ['vega'] }, deps: [] }))
      })
      const r = await run(root)
      expect(r.out).not.toMatch(/banned import not in baseline/)
    })
  })

  describe('built dist', () => {
    it('flags a banned import in dist .js while src is clean', async () => {
      const r = await run(fixture((w) => w('packages/core/dist/leak.js', `import * as v from 'vega'\nexport { v }\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/core\/dist\/leak\.js/)
    })
    it('flags a banned import in dist .d.ts', async () => {
      const r = await run(fixture((w) => w('packages/react/dist/types.d.ts', `export type S = import('vega-lite').TopLevelSpec\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/shipped output: packages\/react\/dist\/types\.d\.ts/)
    })
    it('flags a nested dist .cjs require', async () => {
      const r = await run(fixture((w) => w('packages/vl/dist/deep/x.cjs', `module.exports = require('d3-array')\n`)))
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/packages\/vl\/dist\/deep\/x\.cjs/)
    })
    it('fails when dist is missing, passes with --src-only', async () => {
      const root = fixture()
      rmSync(join(root, 'packages/core/dist'), { recursive: true })
      expect((await run(root)).code).toBe(1)
      expect((await run(root, '--src-only')).code).toBe(0)
    })
    it('--src-only does not hide a src violation', async () => {
      const root = fixture((w) => w('packages/core/src/bad.ts', `import 'vega'\n`))
      expect((await run(root, '--src-only')).code).toBe(1)
    })
  })

  describe('negative controls (must not be flagged)', () => {
    it('ignores comments, strings, relative/internal/builtin imports and lookalike names', async () => {
      const root = fixture((w) => {
        w('packages/core/src/ok.ts', [
          `// import 'vega'  and  require('d3')`,
          `/* import('vega-lite') */`,
          `export const doc = "import x from 'vega'"`,
          'export const tpl = `from "d3-array"`',
          `import { readFileSync } from 'node:fs'`,
          `import { x } from './index'`,
          `import 'react'`,
          `import type { Y } from '@aster-charts/core'`,
          `import 'vegas'`,
          `import 'd3x'`,
          `import 'my-vega'`,
          'export const dyn = (n: string) => import(`./locale/${n}.js`)',
          `export const m = { require: 1, createRequire: 2 }`,
          `export const k = m.requires`,
          'export const w = () => new Worker(new URL("./worker.js", import.meta.url))',
          `/// <reference path="./local.d.ts" />`,
          '',
        ].join('\n'))
      })
      const r = await run(root)
      expect(r.code, r.out).toBe(0)
    })
    it('allows devDependencies on the oracle (tests/benchmarks use it)', async () => {
      const root = fixture((w) =>
        w('packages/core/package.json', JSON.stringify({ name: '@aster-charts/core', devDependencies: { vega: '^6' } })))
      expect((await run(root)).code).toBe(0)
    })
  })
})
