/**
 * Pack-and-consume smoke test for the published packages.
 *
 * `pnpm check` exercises the workspace; this verifies the actual npm artifacts:
 *
 *  1. every public package is packed (running its `prepack` licence copy),
 *  2. the tarball carries LICENSE, THIRD_PARTY_NOTICES.md, dist and types,
 *  3. the tarballs can be extracted into a clean `node_modules` and imported
 *     through their declared `exports` (core, addons, react, react/vl, worker,
 *     ssr) — including a Vega-Lite render through the opt-in addon.
 *
 * The release workflow has never run, so this is the only test of the packaging
 * itself. No network and no package manager install: tarballs are extracted
 * with `tar` and the React peer deps are symlinked from the workspace.
 *
 * Run: node scripts/verify-publish.mjs   (after `pnpm build`)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PUBLIC = ['core', 'react', 'vl']
const REQUIRED = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/index.js', 'dist/index.d.ts']
const REQUIRED_BY_PACKAGE = {
  core: [
    'dist/addon-dom.js', 'dist/canvas.js', 'dist/hit.js', 'dist/signals.js',
    'dist/addon-geo.js', 'dist/addon-load.js', 'dist/addon-transforms.js',
  ],
  react: ['dist/vl.js', 'dist/ssr.js', 'dist/worker.js', 'dist/worker-entry.js'],
  vl: [],
}

function fail(message) {
  console.error(`[verify-publish] FAIL: ${message}`)
  process.exit(1)
}

for (const pkg of PUBLIC) {
  if (!existsSync(join(root, 'packages', pkg, 'dist', 'index.js'))) {
    fail(`packages/${pkg}/dist is missing — run \`pnpm build\` first`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'aster-publish-'))
try {
  const tarballs = new Map()
  for (const pkg of PUBLIC) {
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
      cwd: join(root, 'packages', pkg),
      encoding: 'utf8',
    })
    const packed = JSON.parse(out)
    const file = packed[0]?.filename
    if (!file) fail(`npm pack produced no tarball for @aster/${pkg}`)
    tarballs.set(pkg, join(tmp, file))
    console.log(`[verify-publish] packed @aster/${pkg} (${packed[0].entryCount} files, ${(packed[0].unpackedSize / 1024).toFixed(0)} kB)`)
  }

  // 1) Tarball contents: licences + declaration/entry files.
  for (const pkg of PUBLIC) {
    const listing = execFileSync('tar', ['-tzf', tarballs.get(pkg)], { encoding: 'utf8' })
    const names = new Set(listing.split('\n').map((l) => l.replace(/^package\//, '')).filter(Boolean))
    for (const want of [...REQUIRED, ...REQUIRED_BY_PACKAGE[pkg]]) {
      if (!names.has(want)) fail(`@aster/${pkg} tarball is missing ${want}`)
    }
    // Source maps point at ../src, which is not shipped: a dangling map is worse than none.
    const maps = [...names].filter((n) => n.endsWith('.map'))
    if (maps.length) fail(`@aster/${pkg} tarball ships source maps whose sources are not included: ${maps.slice(0, 3).join(', ')}`)
    for (const n of names) {
      if (!/\.(c|m)?js$/.test(n)) continue
      const body = execFileSync('tar', ['-xzf', tarballs.get(pkg), '-O', `package/${n}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (/^\/\/# sourceMappingURL=/m.test(body)) fail(`@aster/${pkg}/${n} references a source map that is not in the tarball`)
    }
    const manifest = JSON.parse(execFileSync('tar', ['-xzf', tarballs.get(pkg), '-O', 'package/package.json'], { encoding: 'utf8' }))
    if (manifest.private) fail(`@aster/${pkg} is private but was packed`)
    if (manifest.license !== 'BSD-3-Clause') fail(`@aster/${pkg} has license ${manifest.license}`)
  }

  // 2) Extract into a clean node_modules as a consumer would receive them.
  const project = join(tmp, 'consumer')
  const modules = join(project, 'node_modules')
  mkdirSync(join(modules, '@aster'), { recursive: true })
  for (const pkg of PUBLIC) {
    const dest = join(modules, '@aster', pkg)
    mkdirSync(dest, { recursive: true })
    execFileSync('tar', ['-xzf', tarballs.get(pkg), '-C', dest, '--strip-components=1'])
  }
  // Peer deps come from the workspace (react, react-dom, scheduler).
  for (const dep of ['react', 'react-dom', 'scheduler']) {
    const from = join(root, 'packages', 'react', 'node_modules', dep)
    if (existsSync(from)) symmetricLink(from, join(modules, dep))
  }

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

console.log('[verify-publish] consumer smoke test PASS')
`)

  execFileSync(process.execPath, ['smoke.mjs'], { cwd: project, stdio: 'inherit' })
  console.log('[verify-publish] PASS — tarballs carry licences, exports resolve, Vega and Vega-Lite render')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

function symmetricLink(target, path) {
  try {
    symlinkSync(target, path, 'dir')
  } catch (err) {
    if (err && err.code === 'EEXIST') return
    throw err
  }
}
