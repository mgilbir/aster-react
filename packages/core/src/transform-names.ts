/**
 * Which transforms a spec can name, and how it may spell them. A transform type is looked up in lower case, so
 * `Isocontour`, `FILTER` and `filter` are one transform; a type that names none (or is not text) is refused when the spec is
 * parsed. The refusal quotes the type as it was WRITTEN, and so do the messages of a transform's own parameters, which is why
 * the written spelling is kept beside the compiled transform.
 */
import { SpecParseError } from './parse-error.js'

/** The names (lower case) a spec can give a transform. */
export const TRANSFORM_TYPES: ReadonlySet<string> = new Set([
  'aggregate', 'bin', 'collect', 'countpattern', 'cross', 'density', 'dotbin', 'extent', 'filter', 'flatten', 'fold', 'formula',
  'impute', 'joinaggregate', 'kde', 'lookup', 'pivot', 'project', 'quantile', 'sample', 'sequence', 'timeunit', 'window',
  'identifier', 'linkpath', 'pie', 'stack', 'contour', 'geojson', 'geopath', 'geopoint', 'geoshape', 'graticule', 'heatmap',
  'isocontour', 'kde2d', 'force', 'label', 'nest', 'pack', 'partition', 'stratify', 'tree', 'treelinks', 'treemap', 'loess',
  'regression', 'voronoi', 'wordcloud', 'crossfilter', 'resolvefilter',
])

/** A value as a message quotes it: JSON for text and objects, the bare value otherwise. */
function quote(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(quote).join(',') + ']'
  if ((v !== null && typeof v === 'object') || typeof v === 'string') return String(JSON.stringify(v)).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return String(v)
}

/** The transform a written type names (lower case), or a refusal: text that names none, or a truthy value that is not text. */
export function transformTypeOf(written: unknown): string {
  if (written && typeof written !== 'string') throw new TypeError('type.toLowerCase is not a function')
  const type = written ? (written as string).toLowerCase() : ''
  if (!TRANSFORM_TYPES.has(type)) throw new SpecParseError('Unrecognized transform type: ' + quote(written))
  return type
}

const WRITTEN = new WeakMap<object, string>()

/** Remember how a compiled transform's type was written (only kept when it differs from the canonical one). */
export function noteWrittenType(compiled: object, written: string, canonical: string): void {
  if (written !== canonical) WRITTEN.set(compiled, written)
}

/** The type of a compiled transform as the spec wrote it. */
export function writtenTypeOf(t: { type?: unknown }): unknown {
  return WRITTEN.get(t) ?? t.type
}
