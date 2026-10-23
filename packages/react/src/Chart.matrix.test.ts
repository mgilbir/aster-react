/**
 * Anti-drift guard 2: no component test renders <Chart> outside the variant matrix.
 *
 * A test that imports `Chart` and renders it checks one variant only; the same assertion on `<SvgChart>` is then
 * either missing or copied (and the copy drifts). So every test file under packages/react/src that renders
 * `<Chart>` must go through `forEachVariant` (testing/variants.tsx), which hands the test its component and runs it on
 * every variant that has the capabilities the test declares. The exceptions are listed here, each with a reason;
 * a stale entry fails too.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

/** Test files allowed to use `<Chart>` directly, and why. */
export const DIRECT_CHART_TESTS: Readonly<Record<string, string>> = {
  'Chart.matrix.test.ts': 'this guard: its detector samples are source strings that contain <Chart>; it renders nothing',
  'Chart.shells.test.ts': 'guard test: reads the shells as source text and renders nothing; its titles mention <Chart>',
  'Chart.types.test.ts': 'type-level test: compiles fixtures with the TypeScript API and renders nothing; its titles mention <Chart>',
  'Chart.corpus-parity.test.tsx': 'the differential itself: renders <Chart> and <SvgChart> side by side over the corpus and compares their DOM',
}

/** How a test source uses `<Chart>` directly, ignoring comments and strings that merely mention it. */
export function directChartUse(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const uses: string[] = []
  // Inside a matrix file `Chart` is the variant's component (a parameter of the forEachVariant callback, not an import).
  const matrix = /\bforEachVariant\(/.test(code)
  if (!matrix && /<Chart[\s>/]/.test(code)) uses.push('renders <Chart> as JSX')
  if (!matrix && /createElement\(\s*Chart\s*[,)]/.test(code)) uses.push('renders Chart through createElement')
  if (/^import\s+(?!type\b)[^;]*\bChart\b[^;]*from\s+'\.\/Chart(?:\.js)?'/m.test(code)) uses.push("imports the Chart value from './Chart'")
  return uses
}

/** Files that use <Chart> directly without going through the matrix and without a listed reason. */
export function unmatrixed(files: Record<string, string>, allow: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const [name, source] of Object.entries(files)) {
    if (name in allow) continue
    const uses = directChartUse(source)
    if (uses.length === 0) continue
    out.push(`${name}: ${uses.join('; ')}`)
  }
  return out
}

function testFiles(dir = SRC, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, testFiles(join(dir, e.name), `${prefix}${e.name}/`))
    else if (/\.test\.tsx?$/.test(e.name)) out[prefix + e.name] = readFileSync(join(dir, e.name), 'utf8')
  }
  return out
}

describe('every <Chart> component test goes through the variant matrix', () => {
  const files = testFiles()

  it('no test file renders <Chart> directly unless it is listed with a reason', () => {
    expect(unmatrixed(files, DIRECT_CHART_TESTS)).toEqual([])
  })

  it('every exception is still needed and has a reason', () => {
    for (const [name, reason] of Object.entries(DIRECT_CHART_TESTS)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20)
      expect(files[name], `${name} is listed but does not exist`).toBeDefined()
      expect(directChartUse(files[name]!).length, `${name} no longer renders <Chart> directly: remove it from DIRECT_CHART_TESTS`).toBeGreaterThan(0)
    }
  })

  it('the matrix really covers the suite: many files, all three variants named', () => {
    const matrixFiles = Object.entries(files).filter(([n, s]) => n !== 'Chart.matrix.test.ts' && /forEachVariant\(/.test(s))
    expect(matrixFiles.length).toBeGreaterThanOrEqual(20)
  })

  describe('the guard bites', () => {
    it.each([
      ['a JSX render', "import { Chart } from './Chart'\nrender(<Chart spec={s} />)"],
      ['a self-closing-less render', 'render(<Chart\n spec={s}\n/>)'],
      ['createElement', 'React.createElement(Chart, { spec })'],
      ['only the import', "import { Chart, type ChartHandle } from './Chart.js'\nconst x = 1"],
    ])('flags %s', (_what, source) => {
      expect(unmatrixed({ 'x.test.tsx': source }, {})).toHaveLength(1)
    })
    it('flags a matrix file that also imports the Chart value (it would shadow the variant)', () => {
      expect(unmatrixed({ 'x.test.tsx': "import { Chart } from './Chart'\nforEachVariant(['svg'], (Chart) => { render(<Chart />) })" }, {})).toHaveLength(1)
    })
    it.each([
      ['the matrix form', "import { forEachVariant } from './testing/variants'\nforEachVariant(['svg'], (Chart) => { render(<Chart spec={s} />) })"],
      ['a type-only import', "import type { ChartHandle } from './Chart'\nconst ref = createRef<ChartHandle>()"],
      ['a mention in a comment', '// renders <Chart> elsewhere\nconst x = 1'],
      ['ChartStream', "import { ChartStream } from './ChartStream'\nrender(<ChartStream spec={s} />)"],
    ])('does not flag %s', (_what, source) => {
      expect(unmatrixed({ 'x.test.tsx': source }, {})).toEqual([])
    })
    it('honours an allow-list entry', () => {
      expect(unmatrixed({ 'x.test.tsx': 'render(<Chart />)' }, { 'x.test.tsx': 'a documented reason that is long enough' })).toEqual([])
    })
  })
})
