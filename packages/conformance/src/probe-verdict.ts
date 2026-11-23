/**
 * The command line of the probe runner (probe.ts): a name filter and `--min-pass N`, the floor on the number of probes
 * compared (the verdict itself is runGate's, scripts/lib/run-gate.mjs).
 */
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
