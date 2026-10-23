/**
 * Pack-install-consume check for the published packages (C75).
 *
 * `pnpm check` exercises the workspace; this verifies the artifact a consumer
 * actually receives, built the way the release builds it:
 *
 *  1. every public package is packed with `pnpm pack` (what `pnpm publish`
 *     uses; `npm pack` would leave `workspace:*` ranges in the manifest),
 *  2. no packed manifest still contains a `workspace:` range,
 *  3. the tarball carries LICENSE, THIRD_PARTY_NOTICES.md, dist and types, and
 *     no source maps that point at files that are not shipped,
 *  4. the tarballs are INSTALLED with `npm install <tgz>` into a scratch
 *     consumer project (offline: local files only, nothing is published or
 *     fetched; the React peer dependencies are linked from the workspace),
 *  5. EVERY entry declared in each manifest's `exports` is imported by name,
 *     and its `types` and `default` targets exist,
 *  6. `tsc` typechecks a consumer file that uses the public types, with
 *     `module: nodenext` so the `exports` map and its `types` conditions are
 *     resolved exactly as a consumer's compiler resolves them,
 *  7. a Vega and a Vega-Lite render run through the installed packages,
 *  8. a consumer app that depends on import side effects (`@aster/react/vl`, `@aster/core/geo`,
 *     `@aster/core/transforms`, the guide captions) is BUNDLED from the installed tarballs with esbuild
 *     (production, tree-shaking) and the bundle is executed: the `sideEffects` field that survived `pnpm pack`
 *     must keep those registrations.
 *
 * Run: node scripts/verify-publish.mjs   (after `pnpm build`)
 * Test hook: ASTER_VERIFY_PUBLISH_ROOT=<dir> verifies a scratch copy of the
 * repository instead of this one (scripts/verify-publish.test.mjs plants faults there).
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.ASTER_VERIFY_PUBLISH_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
// Test hook only: the fault-injection test sets this to `npm` to prove the `workspace:` check bites.
const PACKER = process.env.ASTER_VERIFY_PUBLISH_PACKER ?? 'pnpm'
const PUBLIC = ['core', 'react', 'vl']
const REQUIRED = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/index.js', 'dist/index.d.ts']
const TSC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', 'typescript', 'bin', 'tsc')

function fail(message) {
  console.error(`[verify-publish] FAIL: ${message}`)
  process.exit(1)
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
const tarRead = (tgz, member) => run('tar', ['-xzf', tgz, '-O', `package/${member}`])

for (const pkg of PUBLIC) {
  if (!existsSync(join(root, 'packages', pkg, 'dist', 'index.js'))) {
    fail(`packages/${pkg}/dist is missing — run \`pnpm build\` first`)
  }
}

/** Every `exports` key except `./package.json`, as [subpath, { types, default }]. */
function entriesOf(manifest) {
  return Object.entries(manifest.exports ?? {}).filter(([k]) => k !== './package.json')
}

const tmp = mkdtempSync(join(tmpdir(), 'aster-publish-'))
try {
  // 1) Pack the way the release packs: `pnpm pack` rewrites `workspace:` ranges to real versions.
  const tarballs = new Map()
  const manifests = new Map()
  for (const pkg of PUBLIC) {
    const dest = join(tmp, 'tarballs', pkg)
    mkdirSync(dest, { recursive: true })
    run(PACKER, ['pack', '--pack-destination', dest], { cwd: join(root, 'packages', pkg), stdio: ['ignore', 'pipe', 'inherit'] })
    const files = readdirSync(dest).filter((f) => f.endsWith('.tgz'))
    if (files.length !== 1) fail(`${PACKER} pack produced ${files.length} tarballs for @aster/${pkg}`)
    const file = join(dest, files[0])
    tarballs.set(pkg, file)
    manifests.set(pkg, JSON.parse(tarRead(file, 'package.json')))
    console.log(`[verify-publish] packed @aster/${pkg} with ${PACKER} pack: ${files[0]}`)
  }

  // 2) No unresolved workspace ranges in any dependency field of any packed manifest.
  for (const pkg of PUBLIC) {
    const m = manifests.get(pkg)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(m[field] ?? {})) {
        if (/^(workspace|link|file):/.test(String(range))) {
          fail(`@aster/${pkg} packed manifest has ${field}.${dep} = "${range}" (the published package would be uninstallable)`)
        }
      }
    }
  }

  // 3) Tarball contents: licences, declaration/entry files for every export, no dangling source maps.
  for (const pkg of PUBLIC) {
    const listing = run('tar', ['-tzf', tarballs.get(pkg)])
    const names = new Set(listing.split('\n').map((l) => l.replace(/^package\//, '')).filter(Boolean))
    const m = manifests.get(pkg)
    const wanted = [...REQUIRED]
    for (const [sub, target] of entriesOf(m)) {
      for (const cond of ['types', 'default']) {
        if (typeof target?.[cond] !== 'string') fail(`@aster/${pkg} exports["${sub}"] has no "${cond}" condition`)
        wanted.push(target[cond].replace(/^\.\//, ''))
      }
    }
    for (const want of wanted) {
      if (!names.has(want)) fail(`@aster/${pkg} tarball is missing ${want}`)
    }
    const maps = [...names].filter((n) => n.endsWith('.map'))
    if (maps.length) fail(`@aster/${pkg} tarball ships source maps whose sources are not included: ${maps.slice(0, 3).join(', ')}`)
    for (const n of names) {
      if (!/\.(c|m)?js$/.test(n)) continue
      if (/^\/\/# sourceMappingURL=/m.test(tarRead(tarballs.get(pkg), n))) fail(`@aster/${pkg}/${n} references a source map that is not in the tarball`)
    }
    if (m.sideEffects === undefined) fail(`@aster/${pkg} packed manifest declares no "sideEffects" (bundlers could not tree-shake it)`)
    if (m.private) fail(`@aster/${pkg} is private but was packed`)
    if (m.license !== 'BSD-3-Clause') fail(`@aster/${pkg} has license ${m.license}`)
    const notices = tarRead(tarballs.get(pkg), 'THIRD_PARTY_NOTICES.md')
    if (!/Permission to use, copy, modify, and\/or distribute this software/.test(notices) || !/Redistribution and use in source and binary forms/.test(notices)) {
      fail(`@aster/${pkg} THIRD_PARTY_NOTICES.md carries no licence texts`)
    }
  }

  // 4) Install the tarballs into a scratch consumer, like `npm install @aster/react` would, minus the registry.
  const project = join(tmp, 'consumer')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'aster-consumer', private: true, type: 'module' }))
  // Peers and type packages come from the workspace (linked, not fetched): local files only.
  const reactDir = join(root, 'packages', 'react', 'node_modules')
  const peers = ['react', 'react-dom', '@types/react', '@types/react-dom'].map((d) => {
    const dir = join(reactDir, d)
    if (!existsSync(dir)) fail(`workspace peer ${d} is not installed (run pnpm install)`)
    return `file:${realpathSync(dir)}`
  })
  run('npm', [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    ...PUBLIC.map((p) => tarballs.get(p)), ...peers,
  ], { cwd: project, stdio: ['ignore', 'pipe', 'inherit'] })
  for (const pkg of PUBLIC) {
    const installed = join(project, 'node_modules', '@aster', pkg, 'package.json')
    if (!existsSync(installed)) fail(`npm install did not install @aster/${pkg}`)
  }

  // 5) Import EVERY declared export entry by its public specifier.
  const specifiers = []
  for (const pkg of PUBLIC) {
    const m = manifests.get(pkg)
    for (const [sub] of entriesOf(m)) specifiers.push(sub === '.' ? m.name : `${m.name}${sub.slice(1)}`)
  }
  writeFileSync(join(project, 'exports.mjs'), `
const specifiers = ${JSON.stringify(specifiers)}
for (const s of specifiers) {
  const mod = await import(s)
  console.log('[verify-publish] imported ' + s + ' (' + Object.keys(mod).length + ' exports)')
}
`)
  try {
    run(process.execPath, ['exports.mjs'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    fail('importing a declared export entry failed (see above)')
  }

  // 6) Typecheck a consumer that uses the public types, resolving through the `exports` map.
  const typeImports = specifiers.map((s, i) => `import * as entry${i} from '${s}'\nvoid entry${i}`).join('\n')
  writeFileSync(join(project, 'consumer.ts'), `${typeImports}
import type { VgSpec, RuntimeInput, SceneRoot, SpecLimits, ChartInfo } from '@aster/core'
import { renderSpec, evaluateChart, compileChart, getChartInfo, chartInfoFromScene, AsterLimitError } from '@aster/core'
import { compile } from '@aster/vl'
import { Chart } from '@aster/react'
import type { ChartProps } from '@aster/react'
import { createElement } from 'react'

const spec: VgSpec = { width: 100, height: 50, marks: [] }
const limits: SpecLimits = { maxMarks: 100 }
const input: RuntimeInput = { limits }
const svg: string = renderSpec(spec, input)
const scene: SceneRoot = evaluateChart(compileChart(spec), input)
const info: ChartInfo = getChartInfo(spec, input)
const fromScene: ChartInfo = chartInfoFromScene(scene)
const props: ChartProps = { spec, width: 100, height: 50 }
const el = createElement(Chart, props)
const err: boolean = new AsterLimitError('x').code === 'ASTER_LIMIT'
const vega = compile({ mark: 'bar', data: { values: [] }, encoding: {} })
void [svg, info, fromScene, el, err, vega]
`)
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', jsx: 'react-jsx',
      strict: true, noEmit: true, skipLibCheck: false, types: [], lib: ['es2022', 'dom'],
    },
    files: ['consumer.ts'],
  }))
  try {
    run(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    fail('the consumer file does not typecheck against the installed packages (see tsc output above)')
  }
  console.log('[verify-publish] consumer typecheck PASS (module nodenext, skipLibCheck off)')

  // 7) Render Vega and Vega-Lite through the installed packages.
  writeFileSync(join(project, 'smoke.mjs'), `
import assert from 'node:assert'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { renderSpec, compileChart, evaluateChart } from '@aster/core'
import { createChartSession, patchSceneDom } from '@aster/core/dom'
import { renderSceneToCanvas } from '@aster/core/canvas'
import { buildHitIndex } from '@aster/core/hit'
import { bindSceneSignals } from '@aster/core/signals'
import { compile } from '@aster/vl'
import { Chart, hasVegaLiteCompiler } from '@aster/react'
import '@aster/react/vl'
import { renderChartToStaticMarkup } from '@aster/react/ssr'
import { handleChartWorkerRequest } from '@aster/react/worker'

const rows = [{ c: 'a', v: 3 }, { c: 'b', v: 7 }]
const vega = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5, autosize: 'none',
  data: [{ name: 't', values: rows }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
    fill: { value: 'steelblue' },
  } } }],
}

const svg = renderSpec(vega)
assert.ok(svg.startsWith('<svg'), 'renderSpec output')
assert.ok(svg.includes('mark-rect'), 'renderSpec rendered the mark')
assert.equal(typeof createChartSession, 'function')
assert.equal(typeof patchSceneDom, 'function')
assert.equal(typeof renderSceneToCanvas, 'function')
assert.equal(typeof buildHitIndex, 'function')
assert.equal(typeof bindSceneSignals, 'function')

const scene = evaluateChart(compileChart(vega))
assert.ok(scene.width > 0)

const vl = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 120,
  data: { values: rows },
  mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
}
assert.ok(Array.isArray(compile(vl).marks), 'direct @aster/vl compile')
assert.equal(hasVegaLiteCompiler(), true, '@aster/react/vl registered the compiler')

const chartHtml = renderToString(createElement(Chart, { spec: vega, width: 200, height: 120, a11y: false }))
assert.ok(chartHtml.includes('<svg'), '<Chart> renders Vega through the published package')
const vlHtml = renderToString(createElement(Chart, { spec: vl, width: 200, height: 120, a11y: false }))
assert.ok(vlHtml.includes('<svg'), '<Chart> renders Vega-Lite through the opt-in addon')
assert.ok(renderChartToStaticMarkup(vega).includes('<svg'), 'ssr entry')

const worker = handleChartWorkerRequest({ id: 1, spec: vega })
assert.ok(worker.svg && worker.svg.includes('<svg'), 'worker request handler')
assert.ok(worker.scene && !('runtime' in worker.scene), 'worker scene is clone-safe')

`)

  run(process.execPath, ['smoke.mjs'], { cwd: project, stdio: ['ignore','inherit','inherit'] })

  // 8) Bundle (tree-shaken, production) an app that only works through import side effects, from the INSTALLED
  //    tarballs, and execute it. Node's own loader runs every module, so step 7 cannot see a registration that a
  //    bundler would drop; this can.
  writeFileSync(join(project, 'shaken.mjs'), `
import assert from 'node:assert'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import '@aster/react/vl'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { Chart, hasVegaLiteCompiler } from '@aster/react'

const vl = { width: 200, height: 120, data: { values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }] }, mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }
assert.equal(hasVegaLiteCompiler(), true, 'the packed @aster/react/vl registers the compiler after bundling')
const html = renderToString(createElement(Chart, { spec: vl, width: 200, height: 120 }))
assert.ok(html.includes('mark-rect'), 'a Vega-Lite spec renders through the bundled, tree-shaken packages')
assert.ok(/aria-label="[XY]-axis/.test(html), 'the guide captions survived tree-shaking')

const geo = { width: 200, height: 120, projections: [{ name: 'p', type: 'mercator', fit: true, size: { signal: '[width, height]' }, extent: null }],
  data: [{ name: 'g', values: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] } }] }],
  marks: [{ type: 'shape', from: { data: 'g' }, encode: { update: { fill: { value: 'steelblue' } } }, transform: [{ type: 'geoshape', projection: 'p' }] }] }
assert.ok(/<path [^>]*d="M/.test(renderSpec(geo)), 'the packed @aster/core/geo registers projections after bundling')

const treemap = { width: 100, height: 100, data: [{ name: 't', values: [{ id: 1, parent: null, value: 10 }, { id: 2, parent: 1, value: 5 }, { id: 3, parent: 1, value: 5 }],
  transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, { type: 'treemap', field: 'value' }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'x0' }, y: { field: 'y0' }, x2: { field: 'x1' }, y2: { field: 'y1' }, fill: { value: 'tomato' } } } }] }
assert.ok(renderSpec(treemap).includes('tomato'), 'the packed @aster/core/transforms registers the treemap after bundling')
console.log('shaken ok')
`)
  await build({
    entryPoints: [join(project, 'shaken.mjs')], outfile: join(project, 'shaken.bundle.mjs'), bundle: true, minify: true, treeShaking: true,
    format: 'esm', platform: 'node', external: ['react', 'react-dom', 'react-dom/*'], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  }).catch((e) => fail(`bundling the consumer app from the installed tarballs failed: ${e.message.split('\n')[0]}`))
  try {
    run(process.execPath, ['shaken.bundle.mjs'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    fail('the tree-shaken bundle built from the installed tarballs does not behave (a side-effect registration was shaken out; see above)')
  }
  console.log('[verify-publish] tree-shaken bundle of the installed tarballs executes: vl, geo, transforms and captions registered')
  console.log('[verify-publish] PASS — packed with pnpm, installed with npm, every export imports and typechecks, Vega and Vega-Lite render, a tree-shaken bundle keeps its side effects')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
