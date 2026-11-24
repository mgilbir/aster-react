// @vitest-environment node
/**
 * Non-terminating loops (bin maxbins <= 0, stratify cycles) must terminate
 * or throw exactly where vega does. No Math.min/max(...array) (or push
 * spread) over data-sized arrays: 300k rows must not overflow the stack.
 */
import { describe, it, expect, afterAll } from 'vitest'
import ts from 'typescript'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileChart, evaluateChart, applyTransforms, renderSpec } from './index.js'
import { buildStratifyTree } from './transform.js'
import { minOf, maxOf, pushAll } from './util.js'
import { attack } from './attack.testkit.js'
import type { VgSpec } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The `src` directories of the pnpm workspace packages: every directory matched by a
 * `pnpm-workspace.yaml` `packages:` glob that has a `package.json` and a `src`. A stray directory
 * (an ignored `packages/.tmp-debug`, a half-deleted package) is not a package and is skipped.
 */
function workspaceSrcDirs(root: string): string[] {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs: string[] = []
  let inPackages = false
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue }
    if (!inPackages) continue
    const m = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*(#.*)?$/.exec(line)
    if (m) globs.push(m[1]!)
    else if (/^\S/.test(line)) break // the next top-level key
  }
  const pkgDirs: string[] = []
  for (const g of globs) {
    if (g.startsWith('!')) continue
    if (g.endsWith('/*')) {
      const base = join(root, g.slice(0, -2))
      if (existsSync(base)) for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) pkgDirs.push(join(base, e.name))
    } else pkgDirs.push(join(root, g))
  }
  return pkgDirs
    .filter((d) => existsSync(join(d, 'package.json')) && existsSync(join(d, 'src')) && statSync(join(d, 'src')).isDirectory())
    .map((d) => join(d, 'src'))
}

/**
 * A spread in the arguments of a call (`f(...xs)`, `Math.max(0, ...xs)`, `xs.push(...ys)`, `xs.splice(0, 0, ...ys)`, `new F(...xs)`)
 * puts every element on the stack: with a data-sized array it throws a RangeError (about 120k elements and up). The call may be
 * any, so the scan reads the syntax, not a list of function names. Exempt without being listed: a spread of the REST PARAMETER of
 * the function around it (`(...args) => f(...args)` forwards the arguments it was called with, a number the call site wrote).
 * Every other spread is listed here, by file and call, with the bound that makes it safe; an unlisted one is an offender.
 */
interface AllowedSpread { file: string; call: RegExp; why: string }
const SPREAD_ALLOWED: AllowedSpread[] = [
  { file: 'packages/core/src/dom.ts', call: /replaceChildren\(\.\.\.desc\.children\.map/, why: 'a dense mark container: its few hundred chunk elements, never one per item' },
  { file: 'packages/core/src/legacy-dom.testlib.ts', call: /replaceChildren\(\.\.\.desc\.children\.map/, why: 'the frozen copy of the dom patcher above' },
  { file: 'packages/core/src/runtime.ts', call: /logger\[level\]\?\.\(\.\.\.args\)/, why: 'the arguments of one logged message' },
  { file: 'packages/conformance/src/gallery/virtual-clock.ts', call: /due\.fn\(\.\.\.due\.args\)/, why: 'the arguments a timer was scheduled with' },
  { file: 'packages/core/src/raster-image.ts', call: /fromCharCode\(\.\.\.png\.subarray\(i, i \+ 0x8000\)\)/, why: 'a 32 KiB slice' },
  { file: 'packages/core/src/expr-interpreter.ts', call: /direct\(\.\.\.values\(f\)\)|vega\[f\]!\(\.\.\.args\)|m\.apply\(obj, args\.slice\(1\)\)/, why: 'the arguments of one expression call: as many as the expression text writes' },
  { file: 'packages/core/src/runtime.ts', call: /texts\.push\(\.\.\.\[u\.expr, u\.signal\]/, why: 'two elements' },
  { file: 'packages/core/src/scale.ts', call: /register\(.*\.\.\.NUMERIC/, why: 'a module constant of scale type names' },
  { file: 'packages/core/src/scales.ts', call: /zoomed\(domain as number\[\], factor, \.\.\.(logSpace|powerSpace|symlogSpace)\(/, why: 'a pair' },
  { file: 'packages/core/src/scale-warped.ts', call: /plainDomain\(\.\.\.v\)/, why: 'a scale domain: two numbers (or a short piecewise list the spec writes)' },
  { file: 'packages/core/src/scene-fuzz.testlib.ts', call: /splice\(at\(t\.length \+ 1\), 0, \.\.\.Array\.from\(\{ length: 1 \+ at\(3\) \}/, why: 'at most three generated rows' },
  { file: 'packages/vl/src/compile.ts', call: /g\.casts\.push\(\.\.\.d\.casts\)/, why: 'the casts of one dataset: a field per type the spec casts' },
  { file: 'packages/vl/src/compile.ts', call: /sizeSignals\.splice\(0, 0, \.\.\.(unitContainer|container)\.signals\)/, why: 'the container size signals of one view: a handful' },
  { file: 'packages/vl/src/compile.ts', call: /fieldsTitle\(titled\(def\), \.\.\.\(def2/, why: 'one or two field definitions' },
  { file: 'packages/vl/src/predicate.ts', call: /Date\.UTC\(\.\.\.args\)|new Date\(\.\.\.args\)/, why: 'the date parts of one time unit: at most seven' },
  { file: 'packages/vl/src/scaleprops.ts', call: /only\(\.\.\.(CONTINUOUS|BANDED)/, why: 'module constants of scale type names' },
  { file: 'packages/vl/src/titles.ts', call: /fieldsTitle\(\.\.\.a\.fields, \.\.\.b\.fields\)/, why: 'the fields of two titles the spec writes' },
  { file: 'packages/conformance/src/run.ts', call: /entries\.splice\(0, entries\.length, \.\.\.entries\.filter/, why: 'the corpus entries on disk (about a thousand)' },
  { file: 'packages/conformance/src/gallery/run.ts', call: /swapResults\.push\(\.\.\.\(await runSwap/, why: 'the gallery swap results: one per gallery spec' },
  { file: 'packages/conformance/src/raster-shapes.ts', call: /cmds\.push\(\['beginPath'\]/, why: 'the fixed command lists of one generated shape' },
]

/** True when `name` is a rest parameter (`...name`) of a function that contains `node`. */
function isRestParameterOf(node: ts.Node, name: string): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => p.dotDotDotToken !== undefined && ts.isIdentifier(p.name) && p.name.text === name)) return true
  }
  return false
}

/** `file:line` of every spread in the arguments of a call in the non-test sources under `dirs`, but the rest-parameter forwards and the listed ones. */
function spreadOffenders(dirs: string[], allowed: readonly AllowedSpread[] = SPREAD_ALLOWED): string[] {
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p) }
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.testkit\./.test(e.name)) {
        const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, p.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
        const visit = (n: ts.Node): void => {
          if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments) {
            // `Math.max.apply(null, big)` is the same spread under another name
            if (ts.isCallExpression(n) && /\.apply$/.test(n.expression.getText(sf)) && n.arguments.length === 2 && !ts.isArrayLiteralExpression(n.arguments[1]!)
              && !(ts.isIdentifier(n.arguments[1]!) && isRestParameterOf(n, n.arguments[1].text))
              && !allowed.some((x) => p.endsWith(x.file) && x.call.test(n.getText(sf).replace(/\s+/g, ' ')))) {
              offenders.push(`${p}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
            }
            for (const a of n.arguments) {
              if (!ts.isSpreadElement(a)) continue
              if (ts.isIdentifier(a.expression) && isRestParameterOf(n, a.expression.text)) continue
              const call = n.getText(sf).replace(/\s+/g, ' ')
              if (allowed.some((x) => p.endsWith(x.file) && x.call.test(call))) continue
              offenders.push(`${p}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1}`)
            }
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }
    }
  }
  for (const d of dirs) walk(d)
  return offenders
}

/**
 * Oracle values recorded from the pinned vega 6.3.1 (vega-hierarchy / d3-hierarchy
 * stratify, vega-statistics bin) by running the specs below through `vega.View`
 * with a capturing logger (vega's dataflow swallows the throw and logs it). Core
 * tests may not import vega (pnpm check:deps), so they are replayed as constants.
 */
const VEGA_STRATIFY_ERRORS: Record<string, string | null> = {
  "cycle": "cycle",
  "self parent": "cycle",
  "multiple roots": "multiple roots",
  "missing parent": "missing: zzz",
  "ambiguous": "ambiguous: b",
  "no root": "no root",
  "empty": null
}

const VEGA_BIN_ROWS: Array<[Record<string, unknown>, string]> = [
  [
    {
      "maxbins": -1
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 0
    },
    "[{\"x\":1,\"b0\":0,\"b1\":5},{\"x\":50,\"b0\":50,\"b1\":55},{\"x\":99,\"b0\":95,\"b1\":100}]"
  ],
  [
    {
      "maxbins": 0.5
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 20
    },
    "[{\"x\":1,\"b0\":0,\"b1\":5},{\"x\":50,\"b0\":50,\"b1\":55},{\"x\":99,\"b0\":95,\"b1\":100}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 1
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 0.5
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":64,\"b1\":128}]"
  ],
  [
    {
      "maxbins": 3,
      "base": -2
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 2
    },
    "[{\"x\":1,\"b0\":0,\"b1\":64},{\"x\":50,\"b0\":0,\"b1\":64},{\"x\":99,\"b0\":64,\"b1\":128}]"
  ]
]

describe('stratify matches vega-hierarchy / d3-stratify', () => {
  const cases: Record<string, unknown[]> = {
    cycle: [{ id: 'a', p: 'b' }, { id: 'b', p: 'a' }, { id: 'r', p: null }],
    'self parent': [{ id: 'a', p: 'a' }, { id: 'r', p: null }],
    'multiple roots': [{ id: 'a', p: null }, { id: 'b', p: null }],
    'missing parent': [{ id: 'a', p: null }, { id: 'b', p: 'zzz' }],
    ambiguous: [{ id: 'a', p: null }, { id: 'b', p: 'a' }, { id: 'b', p: 'a' }, { id: 'c', p: 'b' }],
    'no root': [{ id: 'a', p: 'b' }, { id: 'b', p: 'a' }],
  }
  for (const [name, rows] of Object.entries(cases)) {
    it(`${name}: terminates and throws vega's error`, async () => {
      const oracle = VEGA_STRATIFY_ERRORS[name]
      expect(oracle, 'the oracle must reject this input').not.toBeNull()
      // run in a child with a hard kill: before the fix the cycle case never returned
      const r = await attack(`
        const rows = ${JSON.stringify(rows)}
        core.renderSpec({ data: [{ name: 't', values: rows, transform: [{ type: 'stratify', key: 'id', parentKey: 'p' }] }] })`)
      expect(r.killed, 'hang').toBe(false)
      expect(r.threw?.message).toBe(`[aster] stratify: ${oracle}`)
    }, 30_000)
  }

  it('stringifies ids like d3 (1 and "1" are the same node) and builds the same heights', () => {
    const root = buildStratifyTree([{ id: 1, p: null }, { id: 2, p: '1' }, { id: 3, p: 2 }], 'id', 'p')
    expect(root.height).toBe(2)
    expect(root.children[0]!.children[0]!.depth).toBe(2)
  })

  it('an empty source yields vega\'s placeholder root instead of an error', async () => {
    expect(VEGA_STRATIFY_ERRORS.empty).toBeNull()
    expect(() => buildStratifyTree([], 'id', 'p')).not.toThrow()
  })

  it('a 300k-deep chain does not overflow the stack (iterative walks)', () => {
    const n = 300_000
    const rows = Array.from({ length: n }, (_, i) => ({ id: i, p: i === 0 ? null : i - 1 }))
    expect(buildStratifyTree(rows, 'id', 'p').height).toBe(n - 1)
  })
})

describe('bin follows vega-statistics bin()', () => {
  for (const [params, oracle] of VEGA_BIN_ROWS) {
    it(`${JSON.stringify(params)}: terminates with vega's rows`, async () => {
      const r = await attack(`
        const rows = core.applyTransforms([{ x: 1 }, { x: 50 }, { x: 99 }],
          [{ type: 'bin', field: 'x', extent: [1, 99], as: ['b0', 'b1'], ...${JSON.stringify(params)} }],
          { runtime: { expr() { throw new Error('no expressions') } }, signals: {} })
        return JSON.stringify(rows)`)
      expect(r.killed, 'hang').toBe(false)
      expect(r.threw).toBeNull()
      expect(r.value).toBe(oracle)
    }, 30_000)
  }

  it('a span so small the step underflows to 0 (vega spins forever) is an error', async () => {
    const r = await attack(`
      core.applyTransforms([{ x: 0 }, { x: 5e-324 }],
        [{ type: 'bin', field: 'x', extent: [0, 5e-324], maxbins: 20, as: ['b0', 'b1'] }],
        { runtime: { expr() { throw new Error('no expressions') } }, signals: {} })`)
    expect(r.killed, 'hang').toBe(false)
    expect(r.threw?.message).toMatch(/bin: cannot derive a step size/)
  }, 30_000)

  it('scale bins with a zero/NaN/negative step produce no bins instead of spinning', async () => {
    const r = await attack(`
      for (const step of [0, -1, NaN]) {
        core.renderSpec({ width: 100, height: 100, signals: [{ name: 'b', value: { start: 0, stop: 10, step } }],
          scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: [0, 100], bins: { signal: 'b' } }],
          axes: [{ orient: 'bottom', scale: 'x' }] })
      }`)
    expect(r.killed, 'hang').toBe(false)
  }, 30_000)
})

describe('data-sized arrays never go through argument spread', () => {
  const N = 300_000
  const rows = Array.from({ length: N }, (_, i) => ({ x: i, y: (i * 7) % 1000, c: i % 5, t: 1.6e12 + i * 1000, g: 'g' + (i % 3) }))

  it('the helpers match Math.min/max(...a) on small inputs, including NaN, -0 and empty', () => {
    const samples: number[][] = [[], [3], [3, 1, 2], [NaN, 1], [1, NaN, 0], [-0, 0], [0, -0], [Infinity, -Infinity]]
    for (const a of samples) {
      expect(Object.is(minOf(a), Math.min(...a))).toBe(true)
      expect(Object.is(maxOf(a), Math.max(...a))).toBe(true)
    }
    const target = [1]
    pushAll(target, [2, 3])
    expect(target).toEqual([1, 2, 3])
  })

  it('the helpers survive 300k elements where the spread form overflows the stack', () => {
    const big = Array.from({ length: N }, (_, i) => i)
    expect(() => Math.max(...big)).toThrow(RangeError) // the hazard this guards against is real here
    expect(maxOf(big)).toBe(N - 1)
    expect(minOf(big)).toBe(0)
    const sink: number[] = []
    pushAll(sink, big)
    expect(sink.length).toBe(N)
  })

  it('the source has no spread in the arguments of a call over an array that could be data-sized, in the workspace packages\' src', () => {
    const root = join(here, '..', '..', '..')
    const dirs = workspaceSrcDirs(root)
    for (const pkg of ['core', 'react', 'vl', 'conformance', 'benchmarks']) expect(dirs, pkg).toContain(join(root, 'packages', pkg, 'src')) // the scan is not vacuous
    const offenders = spreadOffenders(dirs)
    expect(offenders).toEqual([])
  })

  describe('the scan walks the real workspace packages only', () => {
    const tmp: string[] = []
    afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })
    const fixture = (): string => {
      const root = mkdtempSync(join(tmpdir(), 'aster-scan-'))
      tmp.push(root)
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - "apps/*"\n\nallowBuilds:\n  esbuild: true\n')
      const pkg = (rel: string, src: Record<string, string> | null): void => {
        mkdirSync(join(root, rel), { recursive: true })
        writeFileSync(join(root, rel, 'package.json'), '{"name":"x"}')
        if (src) {
          mkdirSync(join(root, rel, 'src'), { recursive: true })
          for (const [f, body] of Object.entries(src)) writeFileSync(join(root, rel, 'src', f), body)
        }
      }
      pkg('packages/a', { 'ok.ts': 'export const m = Math.max(1, 2)\n' })
      pkg('packages/no-src', null) // a workspace package without src
      pkg('apps/demo', { 'main.ts': 'export const n = 1\n' })
      mkdirSync(join(root, 'packages', '.tmp-debug'), { recursive: true }) // stray, ignored, empty
      mkdirSync(join(root, 'packages', 'stray-with-junk', 'src'), { recursive: true }) // not a package: no package.json
      writeFileSync(join(root, 'packages', 'stray-with-junk', 'src', 'bad.ts'), 'Math.max(...big)\n')
      return root
    }

    it('a stray empty directory (or one without package.json/src) does not break it', () => {
      const root = fixture()
      const dirs = workspaceSrcDirs(root)
      expect(dirs.map((d) => d.slice(root.length + 1)).sort()).toEqual([join('apps', 'demo', 'src'), join('packages', 'a', 'src')])
      expect(spreadOffenders(dirs)).toEqual([])
    })

    it('still bites on a planted spread in a workspace package: every shape of it, in any argument position, and nothing else', () => {
      const root = fixture()
      const lines = [
        'export const m = Math.max(...big)',                        // 1
        'export const o: number[] = []',                            // 2 (not a call)
        'o.push(...big)',                                           // 3
        'export const w = Math.max(-1, ...big.map((d) => d.n))',    // 4 a spread after other arguments
        'o.push(0, ...big)',                                        // 5
        'o.splice(0, 0, ...big)',                                   // 6
        'o.concat(...big)',                                         // 7
        'Math.max.apply(null, big)',                                // 8 the same hazard, spelt apply
        'o.push(...(big as number[]))',                             // 9 a parenthesised operand
        'new Set(...big)',                                          // 10
        // not offenders: a rest parameter forwarded, an array literal, an object literal, fixed arguments, apply with a literal list
        'export const f = (...args: number[]) => Math.max(...args)',
        'export const g = [...big, ...big]',
        'export const h = { ...big }',
        'Math.max(1, 2, 3)',
        'Math.max.apply(null, [1, 2])',
      ]
      writeFileSync(join(root, 'packages', 'a', 'src', 'bad.ts'), lines.join('\n') + '\n')
      expect(spreadOffenders(workspaceSrcDirs(root)).map((o) => o.slice(root.length + 1))).toEqual(
        [1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => join('packages', 'a', 'src', 'bad.ts') + ':' + n),
      )
    })

    it('an allowlisted call is let through only in its file', () => {
      const root = fixture()
      writeFileSync(join(root, 'packages', 'a', 'src', 'bad.ts'), 'o.push(...cells)\n')
      const allowed = [{ file: 'packages/a/src/bad.ts', call: /o\.push\(\.\.\.cells\)/, why: 'test' }]
      expect(spreadOffenders(workspaceSrcDirs(root), allowed)).toEqual([])
      expect(spreadOffenders(workspaceSrcDirs(root), [{ ...allowed[0]!, file: 'packages/a/src/other.ts' }])).toHaveLength(1)
    })
  })

  const render = (spec: Record<string, unknown>) => evaluateChart(compileChart(spec as unknown as VgSpec), { data: { t: rows } })

  it('extent / aggregate min,max / impute min,max / bin / shared-kde domain over 300k rows', () => {
    const out = applyTransforms(rows as never, [
      { type: 'extent', field: 'x', signal: 'e' },
      { type: 'aggregate', groupby: ['g'], fields: ['x', 'x'], ops: ['min', 'max'], as: ['lo', 'hi'] },
    ] as never, { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(out).toHaveLength(3)
    expect(out[0]!.lo).toBe(0)
    const binned = applyTransforms(rows as never, [{ type: 'bin', field: 'x', maxbins: 10, as: ['b0', 'b1'] }] as never,
      { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(binned).toHaveLength(N)
    const imputed = applyTransforms(rows.map((r) => ({ ...r })) as never, [{ type: 'impute', field: 'y', key: 'x', method: 'max', groupby: ['g'], keyvals: [-1] }] as never,
      { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(imputed.length).toBeGreaterThan(N)
  })

  it('scale domains (linear, time, multi-field union, discrete) over 300k rows', () => {
    const scene = render({
      width: 200, height: 100, data: [{ name: 't' }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
        { name: 'u', type: 'linear', domain: { data: 't', fields: ['x', 'y'] }, range: 'height' },
        { name: 'tm', type: 'time', domain: { data: 't', field: 't' }, range: 'width' },
        { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', value: 0 } } } }],
    })
    expect(scene).toBeTruthy()
  }, 60_000)

  it.each([{ orient: 'right', gridAlign: 'all' }, { orient: 'top', direction: 'horizontal', gridAlign: undefined }])(
    'a legend with 150k entries lays out (%j): legend entry maxima use no spread', (legend) => {
      const entries = Array.from({ length: 150_000 }, (_, i) => ({ x: 'v' + i }))
      const svg = renderSpec({
        width: 100, height: 100, data: [{ name: 't' }],
        scales: [{ name: 'c', type: 'ordinal', domain: { data: 't', field: 'x' }, range: 'category' }],
        legends: [{ fill: 'c', ...legend }],
      } as unknown as VgSpec, { data: { t: entries } })
      expect(svg.length).toBeGreaterThan(1000)
    }, 60_000)
})
