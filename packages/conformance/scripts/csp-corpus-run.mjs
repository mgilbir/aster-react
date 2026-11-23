#!/usr/bin/env node
/**
 * Renders every corpus spec (Vega and Vega-Lite, the main corpus and the extra ones) through the BUILT packages, to be run with
 * `node --disallow-code-generation-from-strings` (what a Content-Security-Policy without 'unsafe-eval' does to a page): any code
 * generated from a string anywhere in the engine, the Vega-Lite compiler or the add-ons is an EvalError, which this script
 * reports. Run by `csp-no-dynamic-code.test.mts`; prints one JSON line `{ specs, rendered, evalErrors: [...] }`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { renderSpec, getChartInfo } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile } from '@aster-charts/vl'

const here = dirname(fileURLToPath(import.meta.url))
const dirs = ['corpus', 'corpus-vega-only', 'corpus-tz'].map((d) => join(here, '..', d)).filter(existsSync)

/** Whether an error (or what was logged) is the refusal of a code-generation ban. */
const isEvalRefusal = (e) => e instanceof EvalError || /Code generation from strings disallowed/.test(String(e && (e.message ?? e)))

const evalErrors = []
let specs = 0
let rendered = 0
for (const dir of dirs) {
  for (const f of readdirSync(dir).sort()) {
    const kind = f.endsWith('.vl.json') ? 'vl' : f.endsWith('.vg.json') ? 'vg' : null
    if (!kind) continue
    specs++
    const logger = {
      error: (...a) => { for (const e of a) if (isEvalRefusal(e)) evalErrors.push(`${f}: logged ${String(e && (e.message ?? e))}`) },
      warn: (...a) => { for (const e of a) if (isEvalRefusal(e)) evalErrors.push(`${f}: warned ${String(e && (e.message ?? e))}`) },
      info() {},
      debug() {},
    }
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const spec = kind === 'vl' ? compile(raw) : raw
      const loaded = await loadSpecData(spec, TRUSTED_LOAD_OPTIONS)
      getChartInfo(loaded, { logger })
      renderSpec(loaded, { logger })
      rendered++
    } catch (e) {
      if (isEvalRefusal(e)) evalErrors.push(`${f}: threw ${String(e && e.message)}`)
    }
  }
}
console.log(JSON.stringify({ specs, rendered, evalErrors }))
