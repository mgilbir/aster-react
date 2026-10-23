/**
 * The conformance corpus as Vega specs, for the React differential tests.
 * Vega-Lite entries are compiled with the same compiler `<Chart>` uses
 * (`@aster/vl`); URL data is resolved through the load addon, exactly as a host would.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@aster/vl'
import type { VgSpec } from '@aster/core'
import '@aster/core/geo'
import '@aster/core/transforms'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'conformance', 'corpus')

export interface CorpusSpec {
  name: string
  spec: VgSpec
}

export function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
}

/** Load one corpus file as a ready-to-render Vega spec (compiled and with its data loaded). */
export async function loadCorpusSpec(file: string): Promise<CorpusSpec> {
  const doc = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Record<string, unknown>
  // only a true wrapper doc ({ spec }) is unwrapped: a Vega-Lite repeat / facet spec carries a
  // nested `spec` child of its own and has a $schema (same rule as the conformance runners)
  let spec = (doc.$schema ? doc : (doc.spec ?? doc)) as VgSpec
  if (file.endsWith('.vl.json')) spec = compile(spec as never) as VgSpec
  return { name: file.replace(/\.v[gl]\.json$/, ''), spec: await loadSpecData(spec, TRUSTED_LOAD_OPTIONS) }
}
