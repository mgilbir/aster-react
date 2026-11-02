/**
 * The stream definitions of an `on` handler: a selector string parsed, or the list a spec gives, split into event streams and the
 * operator sources (a signal, a scale) that also trigger it; and the text of the expression that filters a stream's events.
 * Shared by the signal event loop and by the check of a spec's expressions, which must see the same text.
 */
import { parseEventSelectorString, type StreamDef } from './event-selector.js'

// --- selector / stream-spec normalisation -----------------------------------

export interface OperatorSource { signal?: string; scale?: string }

/** vega-parser update.js: a string is a selector; otherwise an array of stream objects and operator sources. */
export function normalizeEvents(events: unknown, defaultSource: 'view' | 'scope' = 'view'): { streams: StreamDef[]; sources: OperatorSource[] } {
  if (events == null) throw new Error('Signal update missing events specification.')
  // (a selector string's default source is the view's, and a group scope's own in a subscope: vega-parser update.js)
  const list: unknown[] = typeof events === 'string' ? parseEventSelectorString(events, defaultSource) : Array.isArray(events) ? events : [events]
  const streams: StreamDef[] = []
  const sources: OperatorSource[] = []
  for (const s of list) {
    const o = s as OperatorSource | null
    if (o && typeof o === 'object' && (o.signal || o.scale)) sources.push(o)
    else streams.push(s as StreamDef)
  }
  return { streams, sources }
}

/** vega-parser filterMark. */
function markFilter(def: { marktype?: string; markname?: string; markrole?: string }): string {
  const item = 'event.item'
  return item
    + (def.marktype && def.marktype !== '*' ? '&&' + item + ".mark.marktype==='" + def.marktype + "'" : '')
    + (def.markrole ? '&&' + item + ".mark.role==='" + def.markrole + "'" : '')
    + (def.markname ? '&&' + item + ".mark.name==='" + def.markname + "'" : '')
}

/** The filter expression text vega-parser's streamParameters builds (or null). */
export function filterCode(def: StreamDef & { markrole?: string }): string | null {
  const param: string[] = def.filter ? ([] as string[]).concat(def.filter) : []
  if (def.marktype || def.markname || def.markrole) param.push(markFilter(def))
  if (def.source === 'scope') param.push('inScope(event.item)')
  return param.length ? '(' + param.join(')&&(') + ')' : null
}

