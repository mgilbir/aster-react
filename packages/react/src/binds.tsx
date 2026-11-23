/**
 * The bound inputs of a chart (`signal.bind`), as vega-view generates them: the same controls showing the same values and
 * writing the same signal values (`packages/conformance/src/react-binds-vs-vega.test.ts` compares them control by control),
 * rendered by React inside the chart's element.
 *
 * Where vega's are unsafe for a spec the page did not write, they differ on purpose (docs/ARCHITECTURE.md, "Deviations from
 * Vega"): a generated input takes only the input types and attributes an input can safely have (vega copies every other key
 * of `bind` onto it, so an `on*` key is an inline event handler); only a radio group is named, uniquely per chart (vega names
 * every input after its signal, so two charts share a radio group and a spec picks the field names a host form submits); and
 * `bind.element`, an input placed elsewhere in the page or an existing element of the page bound to the signal, is not
 * honoured (reported once through the logger).
 */
import * as React from 'react'
import { tickStep } from '@aster-charts/core/lean'

export interface SignalBindDef {
  name?: unknown
  value?: unknown
  bind?: unknown
}

/** The input types a generated `<input>` may have; any other is a text field (as a browser treats a type it does not know). */
const INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local', 'month', 'week', 'color'])

/** `bind` keys copied to a generated `<input>` (by their React names): the ones that shape the field and nothing else. */
const INPUT_ATTRIBUTES: Readonly<Record<string, string>> = {
  placeholder: 'placeholder', autocomplete: 'autoComplete', maxlength: 'maxLength', minlength: 'minLength', size: 'size',
  pattern: 'pattern', min: 'min', max: 'max', step: 'step', inputmode: 'inputMode', spellcheck: 'spellCheck',
}

/** vega-view's equality of an option and a signal value: the same value, or the same text. */
const valuesEqual = (a: unknown, b: unknown): boolean => a === b || String(a) === String(b)

/** An option's text: its label when it has a non-empty one, else the option itself, as text. */
const optionLabel = (options: readonly unknown[], labels: readonly unknown[], i: number): string => String(labels[i] || options[i])

/** Calls `fn` `ms` after the last call (as vega's `debounce` binding option), or at once without a delay; pending calls end with the control. */
function useDebounced(ms: number, fn: (value: unknown) => void): (value: unknown) => void {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = React.useRef(fn)
  latest.current = fn
  React.useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current) }, [])
  return React.useCallback((value: unknown) => {
    if (!(ms > 0)) { latest.current(value); return }
    if (timer.current != null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; latest.current(value) }, ms)
  }, [ms])
}

const rowStyle = (gap: number): React.CSSProperties => ({ display: 'inline-flex', gap, alignItems: 'center' })

/**
 * vega-view's slider. Its bounds and step are fixed when it is made, from the value then: a missing `max` is the larger of 100
 * and that value, a missing `min` the smaller of 0, `max` and the value, a missing `step` d3's tickStep over 100 ticks. A
 * missing value shows mid-range (the browser's default for a value it cannot read) and the value next to it is empty.
 */
function BoundRange({ name, label, bind, value, set }: {
  name: string
  label: string
  bind: Record<string, unknown>
  value: unknown
  set: (value: unknown) => void
}): React.ReactElement {
  const initial = React.useRef(value)
  const [min, max, step] = React.useMemo(() => {
    const v0 = initial.current !== undefined ? initial.current : (Number(bind.max) + Number(bind.min)) / 2
    const hi = bind.max != null ? Number(bind.max) : Math.max(100, Number(v0)) || 100
    const lo = Number(bind.min) || Math.min(0, hi, Number(v0)) || 0
    return [lo, hi, Number(bind.step) || tickStep(lo, hi, 100)]
  }, [bind.min, bind.max, bind.step])
  const shown = value == null || Number.isNaN(Number(value)) ? String((min + max) / 2) : String(value)
  return (
    <label data-signal={name} style={rowStyle(8)}>
      <span>{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={shown}
        onChange={(e) => set(Number(e.currentTarget.value))} />
      <span>{value == null ? '' : String(value)}</span>
    </label>
  )
}

function BoundInput({ def, value, groupId, onChange }: {
  def: SignalBindDef
  value: unknown
  groupId: string
  onChange: (name: string, value: unknown) => void
}): React.ReactElement {
  const name = String(def.name)
  const bind = (typeof def.bind === 'object' && def.bind != null ? def.bind : { input: String(def.bind) }) as Record<string, unknown>
  const input = typeof bind.input === 'string' ? bind.input : 'text'
  const label = bind.name != null && bind.name !== '' ? String(bind.name) : name
  const options = Array.isArray(bind.options) ? bind.options as unknown[] : []
  const labels = Array.isArray(bind.labels) ? bind.labels as unknown[] : []
  const set = useDebounced(typeof bind.debounce === 'number' ? bind.debounce : 0, (v) => onChange(name, v))
  if (input === 'range') {
    return <BoundRange name={name} label={label} bind={bind} value={value} set={set} />
  }
  if (input === 'select') {
    // Options are addressed by index, so an option of any type (a number, null, an array) is written back as itself.
    const selected = Math.max(0, options.findIndex((o) => valuesEqual(o, value)))
    return (
      <label data-signal={name} style={rowStyle(6)}>
        <span>{label}</span>
        <select aria-label={label} value={String(selected)} onChange={(e) => {
          const i = e.currentTarget.selectedIndex
          if (i >= 0 && i < options.length) set(options[i])
        }}>
          {options.map((_o, i) => <option key={i} value={String(i)}>{optionLabel(options, labels, i)}</option>)}
        </select>
      </label>
    )
  }
  if (input === 'radio') {
    return (
      <span data-signal={name} style={rowStyle(8)}>
        <span>{label}</span>
        <span style={rowStyle(8)}>
          {options.map((o, i) => (
            <label key={i} style={rowStyle(3)}>
              <input type="radio" name={groupId} value={String(o)} aria-label={`${label} ${optionLabel(options, labels, i)}`}
                checked={valuesEqual(o, value)} onChange={() => set(o)} />
              <span>{optionLabel(options, labels, i)}</span>
            </label>
          ))}
        </span>
      </span>
    )
  }
  if (input === 'checkbox') {
    return (
      <label data-signal={name} style={rowStyle(6)}>
        <span>{label}</span>
        <input type="checkbox" aria-label={label} checked={Boolean(value)} onChange={(e) => set(e.currentTarget.checked)} />
      </label>
    )
  }
  // Any other input, as vega-view's generic form: the field's text is the value written (a number field writes text too).
  const attributes: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(INPUT_ATTRIBUTES)) {
    const v = bind[key]
    if (typeof v === 'string' || typeof v === 'number' || (prop === 'spellCheck' && typeof v === 'boolean')) attributes[prop] = v
  }
  return (
    <label data-signal={name} style={rowStyle(6)}>
      <span>{label}</span>
      <input {...attributes} type={INPUT_TYPES.has(input) ? input : 'text'} aria-label={label}
        value={value == null ? '' : String(value)} onChange={(e) => set(e.currentTarget.value)} />
    </label>
  )
}

/**
 * The bound inputs of the spec's root signals. `values` are the signal values the chart drew with (the scene's), so an input
 * shows what the chart shows, `null` included.
 */
export function SignalBinds({ signals, values, idPrefix, onChange, onUnsupported }: {
  signals: readonly SignalBindDef[]
  /** The chart's own id (`useId`): a radio group is named with it, so two charts on a page do not share one. */
  idPrefix: string
  values: Readonly<Record<string, unknown>>
  onChange: (name: string, value: unknown) => void
  /** Told once of each signal whose `bind` asks for what is not honoured (`bind.element`). */
  onUnsupported: (message: string) => void
}): React.ReactElement | null {
  const defs = signals.filter((s) => typeof s.name === 'string' && s.bind != null)
  const placed = defs.filter((d) => {
    const bind = d.bind as Record<string, unknown> | null
    return !(typeof bind === 'object' && bind != null && bind.element != null)
  })
  const elsewhere = defs.filter((d) => !placed.includes(d)).map((d) => String(d.name)).join(', ')
  const report = React.useRef(onUnsupported)
  report.current = onUnsupported
  React.useEffect(() => {
    if (elsewhere) report.current(`[aster] bind.element is not honoured (signals ${elsewhere}): a chart does not place inputs in, or bind to elements of, the page around it; the inputs it can generate are drawn under the chart`)
  }, [elsewhere])
  // (an input with `element` and an `input` type is drawn under the chart like the others; one that binds an existing element has nothing to draw)
  const drawn = defs.filter((d) => placed.includes(d) || (d.bind as Record<string, unknown>).input != null)
  if (!drawn.length) return null
  return (
    <div
      data-testid="chart-binds"
      data-aster-binds=""
      style={{
        position: 'relative', zIndex: 2, display: 'flex', flexWrap: 'wrap', gap: 12,
        alignItems: 'center', padding: '6px 8px', fontSize: 12,
      }}
    >
      {drawn.map((def) => {
        const name = String(def.name)
        const value = Object.hasOwn(values, name) ? values[name] : def.value
        return <BoundInput key={name} def={def} value={value} groupId={`${idPrefix}${name}`} onChange={onChange} />
      })}
    </div>
  )
}
