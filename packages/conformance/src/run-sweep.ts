/**
 * Schema-sweep runner (R8.4, ported from the Go aster project's sweep tests).
 *
 * For every (property, value) pair Vega's own schema declares, render one small
 * chart through upstream vega (oracle) and through @aster/core, and compare the
 * SVG. A value upstream refuses is still a case: "both refuse" is agreement.
 *
 * Usage: npx tsx src/run-sweep.ts <sweep-name> [--filter substr] [--floor N]
 *   sweeps: vega-schema | vega-lite-schema | values | signals
 */
import { mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
import { compile as compileVL } from '@aster/vl'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const require = createRequire(import.meta.url)

/** Build a shim node_modules dir symlinking every package the sweep reads. */
function makeNodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-sweep-'))
  mkdirSync(join(dir, 'node_modules'))
  const base = dirname(require.resolve('vega')) // .../vega/build
  const stores = [
    join(base, '..', '..'), // vega@x.y.z/node_modules (vega, vega-scenegraph, vega-projection)
    join(dirname(require.resolve('vega-lite')), '..', '..'), // vega-lite@x/node_modules
  ]
  const seen = new Set<string>()
  for (const store of stores) {
    let entries: string[] = []
    try {
      entries = readdirSync(store)
    } catch {
      continue
    }
    for (const name of entries) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try {
        symlinkSync(join(store, name), join(dir, 'node_modules', name), 'dir')
      } catch {
        /* already linked */
      }
    }
  }
  return join(dir, 'node_modules')
}

interface SweepCase {
  name: string
  family: string
  property: string
  spec: Record<string, unknown>
  writes?: Array<{ name: string; value: unknown }>
  lite?: boolean
}

interface Status {
  ok: number
  bothRefused: number
  nodeError: number
  engineError: number
  differ: number
  failNames: string[]
}

async function runOneCase(c: SweepCase, nodeModules: string): Promise<'ok' | 'both-refused' | 'node-error' | 'engine-error' | 'differ'> {
  // Vega-Lite cases compare the compiled Vega: upstream vl.compile vs
  // @aster/vl, each rendered through its own engine (a VL defect lives in
  // the spec it emits — see the sweep's header note).
  let vgSpec = c.spec as Record<string, unknown>
  let ourVgSpec = c.spec as Record<string, unknown>
  if (c.lite) {
    try {
      vgSpec = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(c.spec).spec
    } catch (e) {
      // upstream refuses to compile: an agreement only if we refuse too
      try {
        compileVL(c.spec as never)
        console.error(`  [node-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
        return 'node-error'
      } catch {
        return 'both-refused'
      }
    }
    try {
      ourVgSpec = compileVL(c.spec as never) as unknown as Record<string, unknown>
    } catch (e) {
      console.error(`  [engine-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
      return 'engine-error'
    }
  }
  let oracleSvg: string | null = null
  let oracleErr = ''
  try {
    const runtime = vega.parse(vgSpec as never)
    const view = new (vega as any).View(runtime, { renderer: 'none' })
    try {
      await view.runAsync()
      oracleSvg = await view.toSVG()
      // signals sweep: write the requested signals and re-render
      for (const w of c.writes ?? []) {
        view.signal(w.name, w.value)
        await view.runAsync()
      }
      if (c.writes?.length) oracleSvg = await view.toSVG()
    } finally {
      view.finalize()
    }
  } catch (e) {
    oracleErr = (e as Error).message
  }

  let ourSvg: string | null = null
  let ourErr = ''
  try {
    const loaded = await loadSpecData(ourVgSpec as never)
    ourSvg = renderSpec(loaded as never)
  } catch (e) {
    ourErr = (e as Error).message
  }

  if (ourErr && oracleErr) return 'both-refused'
  if (ourErr) {
    console.error(`  [engine-error] ${c.name}: ${ourErr.split('\n')[0]}`)
    return 'engine-error'
  }
  if (oracleErr) {
    console.error(`  [node-error] ${c.name}: ${oracleErr.split('\n')[0]}`)
    return 'node-error'
  }
  const a = canonicalizeSvg(oracleSvg!)
  const b = canonicalizeSvg(ourSvg!)
  const diffs = diffCanonical(a, b)
  if (diffs.length === 0) return 'ok'
  console.error(`  [differ] ${c.name} (${c.family}.${c.property}): ${diffs[0]}`)
  return 'differ'
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sweepName = args[0] ?? 'vega-schema'
  const filterIdx = args.indexOf('--filter')
  const filter = filterIdx >= 0 ? args[filterIdx + 1]! : ''
  const floorIdx = args.indexOf('--floor')
  const floor = floorIdx >= 0 ? Number(args[floorIdx + 1]) : 0

  const nodeModules = makeNodeModules()
  try {
    const { generate } = await import(`./sweeps/${sweepName}.mjs`)
    const ctx = { vega, vl, require, nodeModules }
    const out = (generate as (ctx: unknown) => { cases: SweepCase[]; skips: Array<{ family: string; property: string; reason: string }> })(ctx)
    const all = out.cases.filter((c) => !filter || c.name.includes(filter))
    console.log(`[${sweepName}] ${out.cases.length} cases generated, ${out.skips.length} properties skipped; running ${all.length}`)
    if (floor && out.cases.length < floor) {
      console.error(`FLOOR FAILED: generated ${out.cases.length} < floor ${floor}`)
      process.exitCode = 1
    }
    console.log(`[${sweepName}] ${out.skips.length} skipped properties (declared but not enumerable)`)

    const status: Status = { ok: 0, bothRefused: 0, nodeError: 0, engineError: 0, differ: 0, failNames: [] }
    const CONCURRENCY = 8
    let idx = 0
    const workers: Promise<void>[] = []
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = idx++
            if (i >= all.length) break
            const r = await runOneCase(all[i]!, nodeModules)
            if (r === 'ok') status.ok++
            else if (r === 'both-refused') status.bothRefused++
            else if (r === 'node-error') { status.nodeError++; status.failNames.push(all[i]!.name) }
            else if (r === 'engine-error') { status.engineError++; status.failNames.push(all[i]!.name) }
            else { status.differ++; status.failNames.push(all[i]!.name) }
          }
        })(),
      )
    }
    await Promise.all(workers)

    const total = all.length
    console.log(`[${sweepName}] results: ${status.ok} ok, ${status.bothRefused} both-refused, ${status.nodeError} node-error, ${status.engineError} engine-error, ${status.differ} differ / ${total}`)
    // Per-family scoreboard
    const fams = new Map<string, { ok: number; fail: number }>()
    for (const c of out.cases) {
      if (filter && !c.name.includes(filter)) continue
      const f = fams.get(c.family) ?? { ok: 0, fail: 0 }
      fams.set(c.family, f)
    }
    for (const c of all) {
      const f = fams.get(c.family)!
      if (status.failNames.includes(c.name)) f.fail++
      else f.ok++
    }
    console.log(`[${sweepName}] family scoreboard (ok/fail):`)
    for (const [f, s] of [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${f.padEnd(28)} ${s.ok}\t${s.fail}`)
    }
    if (status.differ + status.engineError > 0) {
      console.error(`[${sweepName}] FAILING (${status.differ + status.engineError}):`)
      for (const n of status.failNames.slice(0, 40)) console.error(' ', n)
      if (status.failNames.length > 40) console.error(`  ... and ${status.failNames.length - 40} more`)
      process.exitCode = 1
    } else {
      console.log(`[${sweepName}] PASS`)
    }
  } finally {
    rmSync(nodeModules, { recursive: true, force: true })
  }
}

await main()
