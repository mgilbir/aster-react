/**
 * Drift guards for the single gate list (scripts/gates.mjs).
 * The list is only a source of truth if nothing else keeps its own copy.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { GATES } from './gates.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const rootPkg = JSON.parse(read('package.json'))
const confPkg = JSON.parse(read('packages/conformance/package.json'))
const benchPkg = JSON.parse(read('packages/benchmarks/package.json'))
const reactPkg = JSON.parse(read('packages/react/package.json'))

/** The `run:` commands of a workflow file. */
const runLines = (rel) =>
  [...read(rel).matchAll(/^\s*(?:- )?run:\s*(.+)$/gm)].map((m) => m[1].trim())

/** Fenced code blocks of a markdown file. */
const fences = (rel) => [...read(rel).matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1])

describe('gate list', () => {
  it('has unique names and every gate resolves to a real script', () => {
    const names = GATES.map((g) => g.name)
    expect(new Set(names).size).toBe(names.length)
    for (const g of GATES) {
      if (g.args[0] === '--filter') {
        const pkg = g.args[1] === '@aster/benchmarks' ? benchPkg : g.args[1] === '@aster/react' ? reactPkg : confPkg
        expect(g.args[2], g.name).toBe('run')
        expect(pkg.scripts, `${g.name}: ${g.args[3]}`).toHaveProperty(g.args[3])
      } else {
        expect(rootPkg.scripts, `${g.name}: ${g.args[0]}`).toHaveProperty(g.args[0])
      }
    }
  })

  it('covers the gates the repo has always claimed (incl. conformance-vl)', () => {
    const names = new Set(GATES.map((g) => g.name))
    for (const want of [
      'build', 'deps', 'typecheck', 'test', 'verify-publish', 'conformance', 'conformance-vl',
      'scene-diff', 'incremental-diff', 'a11y-parity', 'transform-matrix', 'canvas', 'batch', 'fuzz-replay', 'budget',
    ]) expect(names.has(want), want).toBe(true)
  })

  it('every real-browser script (one that drives Playwright) is a gate, or a benchmark', () => {
    const covered = (pkgName, script) => GATES.some((g) => (
      pkgName === 'root' ? g.args[0] === script
        : g.args[0] === '--filter' ? g.args[2] === 'run' && g.args[3] === script && g.args[1] === pkgName
          : g.args[0] === script))
    for (const [dir, pkgName, pkg] of [['packages/conformance', '@aster/conformance', confPkg], ['packages/react', '@aster/react', reactPkg]]) {
      for (const [script, cmd] of Object.entries(pkg.scripts)) {
        const file = /\btsx\s+(scripts\/[\w.-]+\.mts)/.exec(cmd)?.[1]
        if (!file || !/from 'playwright'/.test(read(`${dir}/${file}`))) continue
        const inGates = GATES.some((g) => g.args.includes(script) || (g.args[0] === '--filter' && g.args[1] === pkgName && g.args[3] === script))
        expect(inGates || covered(pkgName, script), `${pkgName} script "${script}" drives a real browser and is not in scripts/gates.mjs`).toBe(true)
      }
    }
  })

  it('every gate is blocking: a gate that cannot fail proves nothing (the probe has a floor on the probes that pass)', () => {
    expect(GATES.filter((g) => g.blocking === false).map((g) => g.name)).toEqual([])
    expect(GATES.find((g) => g.name === 'probe').args).toEqual(['probe', '--', '--min-pass', '2'])
  })

  it('builds before the dependency check (which inspects dist)', () => {
    const order = GATES.map((g) => g.name)
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('deps'))
  })

  it('`pnpm check` is the gate runner', () => {
    expect(rootPkg.scripts.check).toBe('node scripts/gates.mjs')
  })
})

describe('nothing keeps a second copy of the list', () => {
  const allowedCi = [
    /^pnpm install --frozen-lockfile$/,
    /^pnpm --filter @aster\/conformance exec playwright install /,
    /^pnpm check$/,
  ]
  // The `unit` job (Node matrix) builds, then runs vitest directly under the matrix Node
  // (pnpm 11 cannot itself run on Node 20). It adds no gate: it is `pnpm test` on other engines.
  const allowedUnit = [
    /^pnpm build$/,
    /^node node_modules\/vitest\/vitest\.mjs run( scripts\/differential- oracle-vectors\.test)?$/,
  ]

  it('ci.yml only sets up the toolchain, runs `pnpm check`, and the unit-test Node matrix', () => {
    const lines = runLines('.github/workflows/ci.yml')
    expect(lines).toContain('pnpm check')
    for (const l of lines) {
      expect([...allowedCi, ...allowedUnit].some((re) => re.test(l)), `ci.yml runs "${l}" outside the gate list`).toBe(true)
    }
  })

  it('the main ci job stays on Node 22; the unit job covers 20, 22 and the newest major', () => {
    const ci = read('.github/workflows/ci.yml')
    const [main, unit] = ci.split(/^  unit:$/m)
    expect(unit, 'ci.yml has a `unit` job').toBeDefined()
    expect(main).toMatch(/node-version: 22\b/)
    expect(unit).toMatch(/node:\s*\[20, 22, node\]/)
    // the matrix job runs what `pnpm test` runs, so it cannot drift from the root script
    expect(rootPkg.scripts.test).toBe('vitest run')
    expect(runLines('.github/workflows/ci.yml')).toContain('node node_modules/vitest/vitest.mjs run')
    // and never grows a second gate list: `pnpm check` is run by the main job only
    expect(unit).not.toMatch(/pnpm check/)
  })

  it('nightly.yml runs `pnpm check` before its extras and installs with a frozen lockfile', () => {
    const lines = runLines('.github/workflows/nightly.yml')
    expect(lines).toContain('pnpm check')
    expect(lines).toContain('pnpm install --frozen-lockfile')
  })

  it('nightly.yml fetches the official galleries from the manifest (cached on it, pinned by SHA) before the gallery gate', () => {
    const text = read('.github/workflows/nightly.yml')
    const lines = runLines('.github/workflows/nightly.yml')
    expect(lines).toContain('pnpm gallery:fetch')
    expect(lines).toContain('pnpm conformance:gallery')
    expect(lines.indexOf('pnpm gallery:fetch')).toBeLessThan(lines.indexOf('pnpm conformance:gallery'))
    // the cache action is pinned by commit SHA (like release.yml) and keyed on the manifest's hash
    expect(text).toMatch(/uses: actions\/cache@[0-9a-f]{40}\b/)
    expect(text).toMatch(/key: gallery-\$\{\{ hashFiles\('packages\/conformance\/gallery\/manifest\.json'\) \}\}/)
    // the gate is not in the PR gate list: it needs the fetched cache (see packages/conformance/gallery/README.md)
    expect(GATES.map((g) => g.name)).not.toContain('gallery')
  })

  it('every workflow installs with --frozen-lockfile', () => {
    for (const wf of ['ci', 'nightly', 'release']) {
      const installs = runLines(`.github/workflows/${wf}.yml`).filter((l) => /^pnpm (install|i)\b/.test(l))
      expect(installs.length, wf).toBeGreaterThan(0)
      for (const l of installs) expect(l, wf).toMatch(/--frozen-lockfile/)
    }
  })

  it('CONTRIBUTING and TESTING point at the source instead of listing gates', () => {
    const gateCmds = GATES.map((g) => `pnpm ${g.args.join(' ')}`)
    for (const doc of ['CONTRIBUTING.md', 'docs/TESTING.md']) {
      expect(read(doc), doc).toContain('scripts/gates.mjs')
      expect(read(doc), doc).toContain('pnpm check')
      for (const block of fences(doc)) {
        for (const line of block.split('\n')) {
          const cmd = line.replace(/\s+#.*$/, '').trim()
          expect(gateCmds.includes(cmd), `${doc} lists gate "${cmd}" itself; point at scripts/gates.mjs`).toBe(false)
        }
      }
    }
  })
})

describe('workflow files are valid YAML', () => {
  // The text-based checks above cannot see a file GitHub refuses to load (an unquoted ": " in a
  // step name made ci.yml invalid and no CI ran), so every workflow goes through a real parser.
  const files = readdirSync(join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f))

  it('finds the workflows', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'nightly.yml', 'release.yml']))
  })

  for (const f of files) {
    it(`${f} parses without errors or warnings and has \`on\` and \`jobs\``, () => {
      const doc = parseDocument(read(`.github/workflows/${f}`), { prettyErrors: true })
      expect(doc.errors.map(String), `${f}: YAML errors`).toEqual([])
      expect(doc.warnings.map(String), `${f}: YAML warnings`).toEqual([])
      const wf = doc.toJS()
      expect(wf && typeof wf === 'object' && !Array.isArray(wf), `${f}: top level is a mapping`).toBe(true)
      // YAML 1.1 loaders read the key `on` as boolean true; `yaml` 1.2 keeps the string.
      expect(Object.keys(wf), f).toEqual(expect.arrayContaining(['on', 'jobs']))
      expect(Object.keys(wf.jobs ?? {}).length, `${f}: at least one job`).toBeGreaterThan(0)
    })
  }
})

describe('workflow hygiene', () => {
  const files = readdirSync(join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f))
  const load = (f) => parseDocument(read(`.github/workflows/${f}`)).toJS()
  const stepsOf = (wf) => Object.values(wf.jobs).flatMap((j) => j.steps ?? [])

  for (const f of files) {
    it(`${f}: every action is pinned to a commit SHA, with the version as a comment`, () => {
      const lines = read(`.github/workflows/${f}`).split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l))
      expect(lines.length, f).toBeGreaterThan(0)
      for (const l of lines) expect(l, `${f}: ${l.trim()}`).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*\s*$/)
    })

    it(`${f}: a top-level permissions block grants read access to the contents and nothing else`, () => {
      const wf = load(f)
      expect(wf.permissions, `${f}: no top-level permissions block`).toEqual({ contents: 'read' })
    })

    it(`${f}: a job may only add permissions the release workflow needs (id-token for provenance)`, () => {
      const wf = load(f)
      for (const [name, job] of Object.entries(wf.jobs)) {
        for (const [perm, level] of Object.entries(job.permissions ?? {})) {
          const allowed = (f === 'release.yml' && name === 'publish' && perm === 'id-token' && level === 'write') || (perm === 'contents' && level === 'read')
          expect(allowed, `${f} job ${name} grants ${perm}: ${level}`).toBe(true)
        }
      }
    })
  }
})

describe('nightly.yml: one failing check does not hide the others', () => {
  const wf = parseDocument(read('.github/workflows/nightly.yml')).toJS()
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps)
  const checks = steps.filter((s) => typeof s.run === 'string' && s.id)

  it('runs each check as its own step that survives an earlier failure and names what it needs', () => {
    expect(checks.length).toBeGreaterThanOrEqual(12)
    for (const s of checks) {
      if (s.id === 'install') { expect(s.if, 'install is the first step').toBeUndefined(); continue }
      expect(s.if, `${s.id}: needs an \`if\``).toMatch(/^\$\{\{ !cancelled\(\)/)
    }
    // the sweeps and the fuzzer are checks of their own, after the gates
    const ids = checks.map((s) => s.id)
    for (const want of ['gates', 'gallery', 'canvas-firefox', 'canvas-webkit', 'bench-incremental', 'bench-stream', 'bench-browser', 'bench-dense', 'sweep-vl', 'sweep-vega', 'sweep-values', 'fuzz']) {
      expect(ids, want).toContain(want)
    }
    expect(ids.indexOf('gates')).toBeLessThan(ids.indexOf('sweep-vl'))
  })

  it('ends with an always-run summary that fails the job when a check failed or was skipped', () => {
    const last = steps.at(-1)
    expect(last.if).toBe('${{ always() }}')
    expect(last.run).toBe('node scripts/nightly-summary.mjs')
    expect(last.env.STEPS).toBe('${{ toJSON(steps) }}')
  })

  it('has no step that could stop the later ones: continue-on-error is not used to hide a failure', () => {
    expect(read('.github/workflows/nightly.yml')).not.toMatch(/continue-on-error/)
  })
})
