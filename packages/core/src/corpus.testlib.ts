/**
 * The vega corpus as the unit tests that loop over it see it. Test-only (excluded from the published build).
 *
 * A loop over the corpus is only a check of what it reaches: a `catch { continue }` around the evaluation drops, without a count,
 * every spec that throws. The corpus specs that use an add-on (a geo projection, force, contour, label, ...) throw "load the
 * addon first" unless the test file imports the add-ons, which is how those marks silently dropped out of every loop. So a test
 * imports the add-ons (`./addon-transforms.js`, `./addon-geo.js`), skips only what has no data to draw, and counts.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Every vega spec of the corpus, as a path. */
export function vegaCorpusFiles(): string[] {
  return ['../../conformance/corpus', '../../conformance/corpus-vega-only'].map((d) => join(here, d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.vg.json')).map((f) => join(d, f)))
}

/** The specs whose data is a URL that nothing loads here (the conformance suite loads it): there is nothing to draw. */
export const CORPUS_UNLOADABLE = ['data-url-csv.vg.json', 'data-url-signal.vg.json']

/** True for the one throw a corpus loop may skip: the spec's data is a URL and no data was loaded for it. */
export function isDataNotLoaded(e: unknown): boolean {
  return e instanceof Error && /no data was loaded/.test(e.message)
}
