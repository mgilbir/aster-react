/**
 * Drift guards for the single gate list (scripts/gates.mjs).
 * The list is only a source of truth if nothing else keeps its own copy.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { DEFAULT_TIMEOUT_MS, GATES, runGate, runGates, selectGates, timeoutOf } from './gates.mjs'

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
        const pkg = g.args[1] === '@aster-charts/benchmarks' ? benchPkg : g.args[1] === '@aster-charts/react' ? reactPkg : confPkg
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
    for (const [dir, pkgName, pkg] of [['packages/conformance', '@aster-charts/conformance', confPkg], ['packages/react', '@aster-charts/react', reactPkg]]) {
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
    /^pnpm --filter @aster-charts\/conformance exec playwright install /,
    /^pnpm check$/,
  ]
  // The `unit` job (Node matrix) builds, then runs vitest directly under the matrix Node
  // (pnpm 11 cannot itself run on Node 20). It adds no gate: it is `pnpm test` on other engines.
  const allowedUnit = [
    /^pnpm build$/,
    /^node node_modules\/vitest\/vitest\.mjs run( scripts\/differential- oracle-vectors\.test dist-node-smoke\.test)?$/,
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

describe('every gate has a deadline and can fail on it (C251)', () => {
  const sleeper = (extra = {}) => ({ name: 'hang', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], why: 't', ...extra })
  const quiet = { stdio: 'ignore' }

  it('every gate resolves to a finite, positive deadline', () => {
    for (const g of GATES) {
      expect(Number.isFinite(timeoutOf(g)) && timeoutOf(g) > 0, g.name).toBe(true)
      expect(timeoutOf(g), g.name).toBeLessThanOrEqual(2 * 60 * 60_000)
    }
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('a gate that never exits is killed at its deadline and reported as a timeout', async () => {
    const t0 = Date.now()
    const r = await runGate(sleeper({ timeoutMs: 400 }), quiet)
    expect(r).toMatchObject({ ok: false, timedOut: true })
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20_000)

  it('the whole process tree dies with it (a browser the gate started must not outlive the deadline)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-gates-'))
    try {
      const pidFile = join(dir, 'grandchild.pid')
      const code = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`
      const r = await runGate({ name: 'tree', command: process.execPath, args: ['-e', code], timeoutMs: 1500, why: 't' }, quiet)
      expect(r.timedOut).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)) } catch { alive = false }
      }
      expect(alive, `grandchild ${pid} survived the deadline`).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)

  it('a gate that exits 0 passes and one that exits 1 fails, without a timeout', async () => {
    expect(await runGate({ name: 'ok', command: process.execPath, args: ['-e', ''], why: 't' }, quiet)).toMatchObject({ ok: true, timedOut: false })
    expect(await runGate({ name: 'bad', command: process.execPath, args: ['-e', 'process.exit(1)'], why: 't' }, quiet)).toMatchObject({ ok: false, timedOut: false })
  })

  it('runGates names the timed-out gate, exits 1, and still runs the gates after it', async () => {
    const lines = []
    const log = console.log
    const err = console.error
    console.log = (...a) => { lines.push(a.join(' ')) }
    console.error = (...a) => { lines.push(a.join(' ')) }
    let code
    try {
      const gates = [sleeper({ timeoutMs: 300 }), { name: 'after', command: process.execPath, args: ['-e', ''], why: 't' }]
      code = await runGates(gates, { run: (g) => runGate(g, quiet) })
    } finally { console.log = log; console.error = err }
    const out = lines.join('\n')
    expect(code).toBe(1)
    expect(out).toMatch(/FAIL {2}hang\s+\d+s \(timeout\)/)
    expect(out).toMatch(/PASS {2}after/)
    expect(out).toMatch(/blocking gate\(s\) failed: hang \(timeout\)/)
  }, 20_000)

  it('the workflows bound every job in time', () => {
    for (const f of readdirSync(join(root, '.github', 'workflows')).filter((n) => /\.ya?ml$/.test(n))) {
      const wf = parseDocument(read(`.github/workflows/${f}`)).toJS()
      for (const [name, job] of Object.entries(wf.jobs)) {
        expect(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 180, `${f} job ${name} needs a timeout-minutes`).toBe(true)
      }
    }
  })
})

describe('--only and --skip take names and tags alike (C642)', () => {
  it('--only browser selects exactly the gates tagged browser; --skip browser selects the rest', () => {
    const tagged = GATES.filter((g) => (g.tags ?? []).includes('browser'))
    expect(tagged.length).toBeGreaterThan(3)
    expect(selectGates(GATES, ['browser']).map((g) => g.name)).toEqual(tagged.map((g) => g.name))
    expect(selectGates(GATES, null, ['browser']).map((g) => g.name)).toEqual(GATES.filter((g) => !tagged.includes(g)).map((g) => g.name))
    expect(selectGates(GATES, ['build', 'canvas']).map((g) => g.name)).toEqual(['build', 'canvas'])
    expect(selectGates(GATES, ['browser'], ['canvas']).map((g) => g.name)).not.toContain('canvas')
  })
  it('an unknown name or tag exits 2 and runs nothing', async () => {
    const { spawnAsync } = await import('./lib/spawn-async.mjs')
    for (const flag of ['--only', '--skip']) {
      const r = await spawnAsync(process.execPath, [join(root, 'scripts/gates.mjs'), flag, 'broswer'], { timeout: 30_000 })
      expect(r.status, flag).toBe(2)
      expect(r.stderr).toMatch(/unknown gate or tag "broswer"/)
    }
  })
})

describe('ci.yml: CI runs on main only (C305)', () => {
  const wf = parseDocument(read('.github/workflows/ci.yml')).toJS()
  it('triggers on pushes to main and on nothing else: no pull_request, no schedule, no dispatch', () => {
    expect(wf.on).toEqual({ push: { branches: ['main'] } })
  })
  it('CONTRIBUTING names the Node matrix job that a local `pnpm check` does not reproduce', () => {
    const doc = read('CONTRIBUTING.md')
    expect(doc).toMatch(/unit.{0,40}job|Node matrix|Node 20/)
    expect(doc).toMatch(/main/)
  })
})

describe('the contributor Node range is the one the toolchain supports (C369)', () => {
  const jsdomEngines = JSON.parse(read('node_modules/jsdom/package.json')).engines.node

  it('the root engines equal the jsdom dev dependency\'s, and both docs state that range', () => {
    expect(rootPkg.engines.node).toBe(jsdomEngines)
    const norm = (r) => r.split('||').map((x) => x.trim())
    for (const doc of ['CONTRIBUTING.md', 'README.md']) {
      const text = read(doc)
      for (const range of norm(rootPkg.engines.node)) {
        const shown = range.replace(/(\.0)+$/, '') // `^24.15.0` is written `^24.15`, `>=26.0.0` is written `>=26`
        expect(text.includes(shown), `${doc} must state ${shown}`).toBe(true)
      }
      expect(text, doc).not.toMatch(/Node 22\.13 or newer/)
    }
  })

  it('.nvmrc names a Node that satisfies the root engines', () => {
    const v = read('.nvmrc').trim()
    const [major, minor = '0', patch = '0'] = v.split('.').map(Number)
    const ok = (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15) || major >= 26
    expect(ok, `.nvmrc ${v}`).toBe(true)
  })

  it('CONTRIBUTING states the real number of gates and how to get pnpm without corepack', () => {
    const doc = read('CONTRIBUTING.md')
    expect(doc).toContain(`runs ${GATES.length} gates`)
    expect(doc).toMatch(/corepack/)
    expect(doc).toMatch(/pnpm build/)
    expect(doc).toMatch(/--with-deps chromium/)
    expect(read('README.md')).toMatch(/playwright install --with-deps chromium[\s\S]{0,40}pnpm build/)
  })
})

describe('the typecheck gate covers every TypeScript file (C303)', () => {
  // Every workspace that has a tsconfig.json is typechecked by `pnpm typecheck` (`pnpm -r typecheck`); the tests and runner scripts must be
  // inside one of their `include`s, or vitest/tsx (which strip types) are the only things that ever read them.
  const ts = createRequire(import.meta.url)('typescript')
  const tracked = () => execFileSync('git', ['ls-files', '-z', 'packages', 'apps'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => /\.(ts|mts|cts|tsx)$/.test(f))
  const projects = () => ['packages', 'apps'].flatMap((d) => readdirSync(join(root, d)).map((n) => `${d}/${n}`)).filter((p) => existsSync(join(root, p, 'tsconfig.json')))
  /** Files each project's typecheck reads, from its real tsconfig. */
  const covered = (dirs = projects()) => {
    const set = new Set()
    for (const dir of dirs) {
      const cfg = ts.readConfigFile(join(root, dir, 'tsconfig.json'), ts.sys.readFile)
      for (const f of ts.parseJsonConfigFileContent(cfg.config, ts.sys, join(root, dir)).fileNames) set.add(resolve(f))
    }
    return set
  }
  // Type fixtures include files that must NOT compile (`*rejects*`): packages/react/src/Chart.types.test.ts compiles them with the TS API and
  // asserts each expected error, so they are checked by a test that can fail, not by the project typecheck.
  const exempt = (f) => f.startsWith('packages/react/type-fixtures/')

  it('every tracked .ts/.mts/.cts/.tsx under packages/ and apps/ is in a project\'s typecheck, except the type fixtures', () => {
    const set = covered()
    const missing = tracked().filter((f) => !exempt(f) && !set.has(resolve(root, f)))
    expect(missing, `${missing.length} TypeScript files no \`pnpm typecheck\` reads`).toEqual([])
  })

  it('the type fixtures are exempt only because Chart.types.test.ts compiles every one of them', () => {
    const test = read('packages/react/src/Chart.types.test.ts')
    const fixtures = tracked().filter((f) => f.startsWith('packages/react/type-fixtures/')).map((f) => f.replace('packages/react/type-fixtures/', ''))
    expect(fixtures.length).toBeGreaterThan(3)
    // each fixture is named in the test, or is a module another fixture imports (`shared.ts`)
    for (const f of fixtures) {
      const imported = fixtures.some((g) => g !== f && read(`packages/react/type-fixtures/${g}`).includes(`./${f.replace(/\.tsx?$/, '')}`))
      expect(test.includes(f) || imported, `${f} must be compiled by Chart.types.test.ts`).toBe(true)
    }
  })

  it('has bite: a project whose include drops a directory leaves its files uncovered', () => {
    const real = covered()
    const missingFor = (set) => tracked().filter((f) => !exempt(f) && !set.has(resolve(root, f)))
    expect(missingFor(real)).toEqual([])
    const narrow = new Set([...real].filter((f) => !f.includes('/packages/conformance/scripts/')))
    expect(missingFor(narrow).length).toBeGreaterThan(50)
  })

  it('every package.json typecheck script runs the project tsconfig.json that the coverage above reads', () => {
    for (const dir of projects()) {
      const pkg = JSON.parse(read(`${dir}/package.json`))
      expect(pkg.scripts?.typecheck, dir).toMatch(/tsc (--noEmit )?-p tsconfig\.json( --noEmit)?$/)
    }
  })
})

describe('`pnpm build` builds each package once, in dependency order (C495)', () => {
  it('no workspace build script rebuilds another workspace (pnpm -r orders them; a second build races the first on dist)', () => {
    for (const dir of ['packages', 'apps'].flatMap((d) => readdirSync(join(root, d)).map((n) => `${d}/${n}`))) {
      if (!existsSync(join(root, dir, 'package.json'))) continue
      const build = JSON.parse(read(`${dir}/package.json`)).scripts?.build
      if (build) expect(build, dir).not.toMatch(/\bpnpm\b|\bnpm run\b|\byarn\b/)
    }
  })
})
