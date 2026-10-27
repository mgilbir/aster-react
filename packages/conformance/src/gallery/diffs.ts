/** Summaries of a canonical diff (pure: used by the Node runner and by the browser page). */
export interface DiffSummary {
  first: string
  /** the first diff that says WHAT differs: for a structure diff the oracle/aster line pair, never the root size line or the count header */
  firstContent: string
  diffs: number
}

export function summarizeDiffs(diffs: string[], max = 240): DiffSummary {
  const cut = (s: string): string => (s.length > max ? s.slice(0, max) + '...' : s)
  const o = diffs.findIndex((d) => d.startsWith('structure: - oracle:'))
  let content: string
  if (o >= 0) content = `${diffs[o]!.replace('structure: ', '')} || ${(diffs[o + 1] ?? '').replace('structure: ', '')}`
  else content = diffs.find((d) => !d.startsWith('root:') && !d.startsWith('structure:')) ?? ''
  return { first: cut(diffs[0]!), firstContent: cut(content), diffs: diffs.length }
}
