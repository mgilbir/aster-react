export interface GateCounter { floor: number; what: string }

export interface Gate {
  /** `--plant-difference` was given: corrupt Aster's side of every compared case (the gate must then fail). */
  readonly plant: boolean
  /** The run is narrowed (`--filter`, `--limit`): floors are not applied, the primary counter must still be >= 1. */
  readonly partial: boolean
  /** Add to a declared counter. */
  count(counter: string, n?: number): void
  /** A case was compared and agrees; counts toward `counter` (default: the primary counter; `null`: toward none, for a gate that counts what it compared itself). */
  agree(caseName: string, counter?: string | null): void
  /** A case was compared and differs; counts toward `counter` (default: the primary counter; `null`: toward none, for a gate that counts what it compared itself). */
  differ(caseName: string, detail: string, counter?: string | null): void
  /** A case could not be compared (it threw, the page failed): a failure, counted toward no counter. */
  error(caseName: string, detail: string): void
  /** A failure that belongs to no case (a page error, a ratchet broken). */
  problem(detail: string): void
}

export const GATE_FLAGS: Readonly<{ 'plant-difference': 'bool' }>

export function intOption(value: string | undefined, flag: string, fallback: number, opts?: { min?: number }): number

export function gateVerdict(run: {
  name: string
  counters: Record<string, GateCounter>
  counts: Record<string, number>
  partial: boolean
  outcomes: Map<string, { differs: string | null; error: string | null }>
  errors: string[]
  expected: ReadonlyArray<{ gate: string; case: string; reason: string }>
}): { ok: boolean; lines: string[] }

export function runGate(spec: {
  name: string
  counters: Record<string, GateCounter>
  partial?: boolean
  /** The packages whose `dist` the gate judges (default core and vl): it fails when one was built before its last source edit. */
  reads?: string[]
  argv?: string[]
  run: (gate: Gate) => Promise<void> | void
}): Promise<never>
