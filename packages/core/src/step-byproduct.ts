/**
 * What a transform step's own run computes about its rows that the state it leaves for the next pulse is made of
 * (incremental-state.ts): an aggregate's group of each row, a collect's sort order, a flatten's count per row. Deriving that state
 * again after the step reads every row a second time (a key per row, a second sort); recorded while the step runs, it is read once,
 * at the moment the step's output is made of it, so the state can only describe the rows the output was made from.
 *
 * A recording is for one input array: only the first step run on exactly that array records (a step may run others on rows of its
 * own: a nested aggregate is not the one asked about). Nothing is kept past the call that asked.
 */
import type { Row } from './transform-agg.js'

/** An aggregate's or joinaggregate's grouping: the parameters it read, the key of each input row and the rows of each group. */
export interface GroupsByproduct {
  kind: 'groups'
  groupby: unknown
  key: unknown
  rowKey: string[]
  /** The groups made of rows, in order of first appearance: their keys and the input indices of their rows. */
  keys: string[]
  members: number[][]
}
/** A collect's order: the sort it read and the input index of each output row. */
export interface OrderByproduct { kind: 'order'; sort: unknown; order: number[] }
/** A flatten's rows: the fields it read and how many rows each input row made. */
export interface FlattenByproduct { kind: 'flatten'; fields: unknown; sizes: number[] }
export type StepByproduct = GroupsByproduct | OrderByproduct | FlattenByproduct

/** One request to record (see `recordByproduct`). */
export interface Recording { rows: readonly Row[]; got: StepByproduct | undefined }

let recording: Recording | undefined

/** Run `run` (one step over `rows`), and return with its result what the step recorded of `rows`, if it did. */
export function recordByproduct<T>(rows: readonly Row[], run: () => T): { result: T; byproduct: StepByproduct | undefined } {
  const outer = recording
  const mine: Recording = { rows, got: undefined }
  recording = mine
  try {
    return { result: run(), byproduct: mine.got }
  } finally {
    recording = outer
  }
}

/** The request a step about to run on `rows` records for: only one for exactly those rows, and only the first step. */
export function recordingFor(rows: readonly Row[]): Recording | undefined {
  return recording !== undefined && recording.rows === rows && recording.got === undefined ? recording : undefined
}

/** Hand over what the step recorded for `to` (the request `recordingFor` gave it), once its run is complete. */
export function recorded(to: Recording, byproduct: StepByproduct): void {
  if (to.got === undefined) to.got = byproduct
}
