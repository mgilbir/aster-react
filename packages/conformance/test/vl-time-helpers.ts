/** Shared by the time-unit and predicate differentials: run a compiled Vega spec and read the rows its first mark draws from. */
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'

export const silent: any = { level: () => silent, warn: () => silent, info: () => silent, debug: () => silent, error: () => silent }

/** Instants that matter to a time unit: year, quarter and week boundaries, a leap day, week 53, both ends of the daylight-saving changes, odd times of day. */
export const INSTANTS: string[] = [
  '2019-12-31T23:59:59.999Z', '2020-01-01T00:00:00.000Z', '2020-01-05T12:30:00.000Z', '2020-02-29T08:15:30.250Z', '2020-03-08T06:59:59.000Z', '2020-03-08T07:00:00.000Z',
  '2020-03-31T22:00:00.000Z', '2020-04-01T01:00:00.000Z', '2020-06-30T23:59:59.999Z', '2020-07-04T17:45:10.500Z', '2020-10-31T23:30:00.000Z', '2020-11-01T05:59:59.000Z',
  '2020-11-01T06:00:00.000Z', '2020-12-27T03:00:00.000Z', '2020-12-31T23:00:00.000Z', '2021-01-01T00:00:00.000Z', '2021-01-03T10:00:00.000Z', '2021-01-04T00:00:00.000Z',
  '2021-05-15T13:05:45.123Z', '2021-09-30T18:59:59.999Z', '2021-12-31T18:29:59.999Z', '2021-12-31T18:30:00.000Z',
]

export const TIME_DATA = [
  ...INSTANTS.map((t, i) => ({ t, v: i % 5, k: i % 3 })),
  { t: null, v: 9, k: 0 },
]

function* marksOf(ms: any[] | undefined): Generator<any> {
  for (const m of ms ?? []) {
    yield m
    yield* marksOf(m.marks)
  }
}

/** The rows of the dataset the first mark draws from, after the spec has run. Dates are written as their instants. */
export async function rowsOf(spec: any): Promise<unknown[]> {
  const view = new vega.View(vega.parse(JSON.parse(JSON.stringify(spec))), { renderer: 'none' })
  await view.runAsync()
  const first = [...marksOf(spec.marks)].find((m) => typeof m.from?.data === 'string')
  const name = first.from.data as string
  return view.data(name).map((row: any) => JSON.parse(JSON.stringify(row, (_k, v) => v)))
}

export function bothCompile(spec: any): { ours: any; theirs: any } | { refusedBy: 'aster' | 'vega-lite' } {
  let theirs: any
  try { theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec } catch { theirs = undefined }
  let ours: any
  try { ours = compile(JSON.parse(JSON.stringify(spec))) } catch { ours = undefined }
  if (theirs === undefined && ours === undefined) return { refusedBy: 'vega-lite' }
  if (theirs === undefined) return { refusedBy: 'vega-lite' }
  if (ours === undefined) return { refusedBy: 'aster' }
  return { ours, theirs }
}
