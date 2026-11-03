/**
 * The verdict of a probe run. Probes document gaps, so a probe that fails is allowed; what is not allowed is to LOSE ground:
 * the number of probes that pass has a floor (`--min-pass`), and a run that finds fewer probes than the floor (a deleted or
 * renamed directory, an empty filter) fails too. The floor is the number passing today; it only moves up, when a gap closes and
 * its probe is promoted to `corpus/` (it then leaves `probes/`, and the floor drops with it).
 */
export interface ProbeVerdict { ok: boolean; reason: string }

export function probeVerdict(passed: number, total: number, minPass: number | null): ProbeVerdict {
  if (minPass === null) return { ok: true, reason: 'no floor given: diagnostic only' }
  if (total < minPass) return { ok: false, reason: `only ${total} probe(s) found, the floor is ${minPass} passing` }
  if (passed < minPass) return { ok: false, reason: `${passed} probe(s) pass, the floor is ${minPass}` }
  return { ok: true, reason: `${passed} pass (floor ${minPass})` }
}

/** `pnpm probe [name-filter] [--min-pass N]` */
export function parseProbeArgs(argv: string[]): { filter: string | undefined; minPass: number | null } {
  let filter: string | undefined
  let minPass: number | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--min-pass' || a.startsWith('--min-pass=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i]
      const n = Number(v)
      if (v === undefined || v === '' || !Number.isInteger(n) || n < 0) throw new Error(`--min-pass needs a non-negative integer, got ${JSON.stringify(v)}`)
      minPass = n
    } else if (a === '--') continue
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else filter = a
  }
  return { filter, minPass }
}
