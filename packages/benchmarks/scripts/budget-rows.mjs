/**
 * The rows of the bundle-size budget: the apps that are bundled (ENTRIES) and what each may weigh (BUDGETS, TOTALS). Data only, so a
 * test can read it without running a build (scripts/budget.test.mjs); the runner is budget.mjs and the arithmetic is budget-lib.mjs.
 *
 * Every row bundles a tiny app that imports ONE documented pattern (esbuild, minify, NODE_ENV=production, tree-shaking on,
 * react/react-dom external) and gates its gzip size. A row is
 *   absolute  the whole app up front: the entry and every chunk it imports statically, each gzipped on its own (the browser fetches
 *             separately compressed files; one gzip of their concatenation understates what is transferred by 3-5%), or
 *   marginal  `+ @aster-charts/core/<addon>`: the addon's gzip ADDED to the `@aster-charts/core` app (the addons share most of their
 *             code with core, so a standalone figure double counts it).
 * The React rows also carry a TOTAL: the up-front size plus every chunk the app can fetch later, so code moved behind an `import()`
 * that every chart triggers cannot lower a row without showing.
 *
 * A ceiling is the measured size + 0.5 kB, and the measure must stay within HEADROOM_MIN..HEADROOM_MAX of it (budget-lib.mjs `judge`):
 * a change that grows a row past the band, or shrinks it past the other side, re-sets the ceiling in its own change. The history of
 * why each row grew is the git log of this file and docs/PERFORMANCE.md.
 *
 * Tree-shaking is what these rows watch as much as size: without a correct `sideEffects` field the `useChart` app drags in Chart, the
 * stream hooks, the worker host and the batch helpers (ASTER_BUDGET_SIDE_EFFECTS=all simulates it), and a row built on a bare
 * `import '...'` (geo, transforms, `/vl`, `/all`) measures 0 when the import is shaken out (ASTER_BUDGET_SIDE_EFFECTS=none simulates
 * that); scripts/bundle-shaking.test.mjs asserts both fail.
 */

const KB = 1024

export const CORE_APP = String.raw`import { renderSpec } from '@aster-charts/core'
const spec = { width: 400, height: 300, data: [{ name: 't', values: [{ x: 0, y: 10 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }], marks: [] }
export default () => renderSpec(spec)
`

/**
 * A row is either absolute (`base` unset: the whole bundle of the app) or MARGINAL (`base` names another row: the
 * row's gzip minus that row's, i.e. what the addon adds to an app that already renders with core). The addons share
 * most of their code with core, so a standalone figure double counts it; the marginal one is what an app pays.
 */
export const ENTRIES = [
  { name: '@aster-charts/core', file: 'core.mjs', platform: 'node', src: CORE_APP },
  {
    name: '+ @aster-charts/core/dom',
    base: '@aster-charts/core',
    file: 'dom.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { createChartSession, patchSceneDom } from '@aster-charts/core/dom'
export const dom = { createChartSession, patchSceneDom }
`,
  },
  {
    name: '+ @aster-charts/core/canvas',
    base: '@aster-charts/core',
    file: 'canvas.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { renderSceneToCanvas } from '@aster-charts/core/canvas'
export const canvas = renderSceneToCanvas
`,
  },
  {
    name: '+ @aster-charts/core/hit',
    base: '@aster-charts/core',
    file: 'hit.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { buildHitIndex } from '@aster-charts/core/hit'
export const hit = buildHitIndex
`,
  },
  {
    name: '+ @aster-charts/core/signals',
    base: '@aster-charts/core',
    file: 'signals.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { bindSceneSignals } from '@aster-charts/core/signals'
export const signals = bindSceneSignals
`,
  },
  {
    name: '+ @aster-charts/core/load',
    base: '@aster-charts/core',
    file: 'load.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { loadSpecData } from '@aster-charts/core/load'
export const load = loadSpecData
`,
  },
  {
    name: '+ @aster-charts/core/geo',
    base: '@aster-charts/core',
    file: 'geo.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster-charts/core/geo'
`,
  },
  {
    name: '+ @aster-charts/core/transforms',
    base: '@aster-charts/core',
    file: 'transforms.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster-charts/core/transforms'
`,
  },
  {
    name: '+ @aster-charts/core/transition',
    base: '@aster-charts/core',
    file: 'transition.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { createScenePlayer, createSceneTransition } from '@aster-charts/core/transition'
export const transition = { createScenePlayer, createSceneTransition }
`,
  },
  {
    name: '+ @aster-charts/core/png',
    base: '@aster-charts/core',
    file: 'png.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { renderSceneToPng } from '@aster-charts/core/png'
export const png = renderSceneToPng
`,
  },
  {
    name: '@aster-charts/react useChart',
    file: 'react-usechart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { useChart } from '@aster-charts/react'
export default useChart
`,
  },
  {
    name: '@aster-charts/react Chart',
    file: 'react.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { Chart } from '@aster-charts/react'
export default Chart
`,
  },
  {
    name: '@aster-charts/react SvgChart',
    file: 'react-svgchart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster-charts/react/lite'
export default SvgChart
`,
  },
  {
    name: '@aster-charts/react SvgChart + interaction',
    file: 'react-svgchart-interaction.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'
export { SvgChart, interaction }
`,
  },
  {
    name: '@aster-charts/react Chart + all',
    file: 'react-all.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import '@aster-charts/react/all'
import { Chart } from '@aster-charts/react'
export default Chart
`,
  },
  {
    name: '@aster-charts/react Chart + VL',
    file: 'react-vl.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import '@aster-charts/react/vl'
import { Chart } from '@aster-charts/react'
export default Chart
`,
  },
  {
    name: '@aster-charts/react useChartWorker',
    file: 'react-usechartworker.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { useChartWorker } from '@aster-charts/react'
export default useChartWorker
`,
  },
  {
    name: '@aster-charts/react hydrateChart',
    file: 'react-hydrate.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { hydrateChart } from '@aster-charts/react'
export default hydrateChart
`,
  },
  {
    name: '@aster-charts/react/ssr',
    file: 'react-ssr.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { renderChartToStaticMarkup, hydrateChart } from '@aster-charts/react/ssr'
export default { renderChartToStaticMarkup, hydrateChart }
`,
  },
]

/** Ceilings of the up-front size (kB gzip, each file on its own): the measure + 0.5. Marginal rows: what the addon adds to the core app. */
export const BUDGETS = {
  '@aster-charts/core': 177.9 * KB,
  '+ @aster-charts/core/dom': 12.4 * KB,
  '+ @aster-charts/core/canvas': 6.7 * KB,
  '+ @aster-charts/core/hit': 10.6 * KB,
  '+ @aster-charts/core/signals': 15.5 * KB,
  '+ @aster-charts/core/load': 5.8 * KB,
  '+ @aster-charts/core/geo': 16.4 * KB,
  '+ @aster-charts/core/transforms': 39.0 * KB,
  '+ @aster-charts/core/transition': 4.2 * KB,
  '+ @aster-charts/core/png': 8.5 * KB,
  '@aster-charts/react useChart': 154.9 * KB,
  '@aster-charts/react Chart': 191.1 * KB,
  '@aster-charts/react SvgChart': 179.5 * KB,
  '@aster-charts/react SvgChart + interaction': 190.8 * KB,
  '@aster-charts/react Chart + VL': 297.4 * KB,
  '@aster-charts/react Chart + all': 262.1 * KB,
  '@aster-charts/react useChartWorker': 204.5 * KB,
  '@aster-charts/react hydrateChart': 219.5 * KB,
  '@aster-charts/react/ssr': 211.1 * KB,
}

/** Ceilings of the up-front size plus every chunk the app can fetch later (kB gzip): the React rows. */
export const TOTALS = {
  '@aster-charts/react useChart': 297.1 * KB,
  '@aster-charts/react Chart': 328.3 * KB,
  '@aster-charts/react SvgChart': 297.7 * KB,
  '@aster-charts/react SvgChart + interaction': 317.2 * KB,
  '@aster-charts/react Chart + VL': 434.7 * KB,
  '@aster-charts/react Chart + all': 329.6 * KB,
  '@aster-charts/react useChartWorker': 296.7 * KB,
  '@aster-charts/react hydrateChart': 296.4 * KB,
  '@aster-charts/react/ssr': 272.7 * KB,
}
