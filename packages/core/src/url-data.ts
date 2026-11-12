/**
 * Datasets that load their rows from a `url`, and the host's switch that refuses them (`RuntimeInput.urlData`).
 *
 * Aster never fetches by itself: a `url` dataset renders once the host resolved it (`loadSpecData` from
 * `@aster-charts/core/load`) or supplied its rows. A host that draws specs it did not write and supplies every row itself
 * can say `urlData: 'refuse'`: a spec with a `url` dataset is then refused at once, with an `AsterUrlError` that names the
 * dataset, before any add-on loads and before evaluation. It is the data counterpart of `urlPolicy` for image urls.
 */
import { AsterLimitError, HARD_MAX_SPEC_DEPTH } from './limits.js'
import { AsterUrlError } from './url-policy.js'
import { specList } from './spec-structure.js'

/** Whether a spec may name `url` datasets: `'allow'` (the default) or `'refuse'`. */
export type UrlDataMode = 'allow' | 'refuse'

/** One dataset that loads its rows from a url: its name and its `url` (a string, or a `{signal}`). */
export interface UrlDataset {
  readonly name: string
  readonly url: unknown
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object'

/**
 * A dataset definition that loads its rows from a url, as vega decides it (vega-parser `analyze`: its `values`, else its `url`,
 * else its `source`, each when truthy): a `url` beside a `source` is a load, a `url` beside `values` or an empty `url` is not.
 */
function isUrlDataset(def: unknown): def is Json {
  return isObj(def) && !Array.isArray(def) && !def.values && !!def.url
}

const NONE: readonly UrlDataset[] = Object.freeze([])

/**
 * Every `url` dataset of a spec, or of a compiled chart (the same shape: `data`, and `marks` whose `data` and `marks` nest),
 * at any depth of nested marks, in document order. `data` and `marks` are read as the compiler reads them (vega-util `array()`:
 * a single object is a one-element list), so a spec the engine runs cannot hide a url dataset from this walk. Iterative and safe on a cyclic object; a nesting deeper than
 * {@link HARD_MAX_SPEC_DEPTH} is an `AsterLimitError` rather than an answer that skipped what lies below it.
 */
export function collectUrlDatasets(root: unknown): readonly UrlDataset[] {
  if (!isObj(root)) return NONE
  let out: UrlDataset[] | null = null
  const seen = new WeakSet<object>()
  // (pushed in reverse so the pops visit the marks in order)
  const stack: Array<[Json, number]> = [[root, 0]]
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (seen.has(node)) continue
    seen.add(node)
    if (depth > HARD_MAX_SPEC_DEPTH) {
      throw new AsterLimitError(`maxDepth ${depth} > ${HARD_MAX_SPEC_DEPTH} (mark nesting, while looking for url datasets; a built-in ceiling that applies even without limits)`)
    }
    for (const def of specList(node.data)) if (isUrlDataset(def)) (out ??= []).push({ name: String(def.name), url: def.url })
    const marks = specList(node.marks)
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i]
      if (isObj(m) && !Array.isArray(m)) stack.push([m, depth + 1])
    }
  }
  return out ?? NONE
}

/**
 * The names of the datasets in `spec` that load their rows from a `url` (top level and in nested group marks), in document
 * order; empty when the spec draws only rows it carries or is given. A host that refuses url data can check a spec with it.
 */
export function urlDatasets(spec: unknown): string[] {
  return collectUrlDatasets(spec).map((d) => d.name)
}

const urlText = (url: unknown): string => {
  if (typeof url === 'string') return url
  try { return JSON.stringify(url) ?? String(url) } catch { return String(url) }
}

/** Throw a `TypeError` for anything but `undefined`, `'allow'` and `'refuse'`: a misspelt refusal must not allow. */
export function validateUrlDataMode(mode: unknown): asserts mode is UrlDataMode | undefined {
  if (mode !== undefined && mode !== 'allow' && mode !== 'refuse') {
    throw new TypeError(`[aster] urlData must be "allow" or "refuse", got ${typeof mode === 'string' ? JSON.stringify(mode) : String(mode)}`)
  }
}

/** The refusal for `found` (non-empty): an `AsterUrlError` with the first dataset's url, naming every dataset. */
function refusal(found: readonly UrlDataset[]): AsterUrlError {
  const names = found.map((d) => JSON.stringify(d.name)).join(', ')
  const what = found.length === 1 ? `dataset ${names} loads its rows from a url` : `datasets ${names} load their rows from urls`
  return new AsterUrlError(urlText(found[0]!.url), `${what}, and url data is not allowed here (urlData: "refuse")`)
}

/**
 * With `urlData: 'refuse'`, throw an `AsterUrlError` (`ASTER_URL_DENIED`) when `spec` (or a compiled chart) has a `url`
 * dataset; it names the datasets and carries the first one's url. Nothing is thrown for `'allow'` or `undefined`. Any other
 * mode is a `TypeError`.
 */
export function checkUrlData(spec: unknown, urlData: UrlDataMode | undefined): void {
  validateUrlDataMode(urlData)
  if (urlData !== 'refuse') return
  const found = collectUrlDatasets(spec)
  if (found.length) throw refusal(found)
}

const CHART_URL_DATASETS = new WeakMap<object, readonly UrlDataset[]>()

/**
 * {@link checkUrlData} for the engine's entry points, on a compiled chart: its url datasets are found once per chart (a chart is
 * evaluated again on every data, signal or size change).
 */
export function checkChartUrlData(chart: object, urlData: UrlDataMode | undefined): void {
  validateUrlDataMode(urlData)
  if (urlData !== 'refuse') return
  let found = CHART_URL_DATASETS.get(chart)
  if (found === undefined) CHART_URL_DATASETS.set(chart, (found = collectUrlDatasets(chart)))
  if (found.length) throw refusal(found)
}
