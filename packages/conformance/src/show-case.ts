/** Render one sweep case through both engines and dump the SVGs. Usage: npx tsx src/show-case.ts <case-name-substr> */
import { mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile as compileVL } from '@aster/vl'

const require = createRequire(import.meta.url)

function makeNodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-show-'))
  mkdirSync(join(dir, 'node_modules'))
  const base = dirname(require.resolve('vega'))
  const stores = [join(base, '..', '..'), join(dirname(require.resolve('vega-lite')), '..', '..')]
  const seen = new Set<string>()
  for (const store of stores) {
    let entries: string[] = []
    try { entries = readdirSync(store) } catch { continue }
    for (const name of entries) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try { symlinkSync(join(store, name), join(dir, 'node_modules', name), 'dir') } catch { /* linked */ }
    }
  }
  return join(dir, 'node_modules')
}

const filter = process.argv[2] ?? ''
const nm = makeNodeModules()
const { generate } = await import(`./sweeps/${'vega-lite' + '-schema'}.mjs`)
const { cases } = generate({ vl, require, nodeModules: nm })
rmSync(nm, { recursive: true, force: true })
const c = cases.find((x: any) => x.name.includes(filter))
if (!c) { console.error('no case matches'); process.exit(1) }
console.log(`case: ${c.name} (${c.family}.${c.property})`)

const oracleVg = (vl as unknown as { compile: (s: unknown) => { spec: unknown } }).compile(c.spec).spec
const ourVg = compileVL(c.spec as never)
writeFileSync('/tmp/case-oracle.vg.json', JSON.stringify(oracleVg, null, 1))
writeFileSync('/tmp/case-ours.vg.json', JSON.stringify(ourVg, null, 1))
writeFileSync('/tmp/case-source.vl.json', JSON.stringify(c.spec, null, 1))

const runtime = vega.parse(oracleVg as never)
const view = new (vega as any).View(runtime, { renderer: 'none' })
await view.runAsync()
writeFileSync('/tmp/case-oracle.svg', await view.toSVG())
view.finalize()

const loaded = await loadSpecData(ourVg as never, TRUSTED_LOAD_OPTIONS)
writeFileSync('/tmp/case-ours.svg', renderSpec(loaded as never))
console.log('wrote /tmp/case-source.vl.json /tmp/case-oracle.vg.json /tmp/case-ours.vg.json /tmp/case-oracle.svg /tmp/case-ours.svg')
