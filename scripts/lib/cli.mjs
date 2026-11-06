/**
 * Argument checking shared by the repository's command-line entry points (the scripts in the root, in each package's scripts and the runners in the conformance and benchmarks src).
 *
 * `cli()` runs before a script does any work and does two things the scripts used to leave to chance:
 *   - `--help` / `-h` prints the usage line and the script's own header comment, and exits 0;
 *   - an option the script does not declare prints an error and the usage line to stderr, and exits 2.
 * It does not parse values: each script keeps reading its own arguments exactly as before. The declaration says only which
 * options exist and how a value is attached, so a typo (`--flor 10`, `--limit 5` for `--limit=5`) fails instead of being ignored.
 *
 * Option kinds:
 *   'bool'   `--name`
 *   'value'  `--name <value>`   (the next argument is the value, whatever it looks like)
 *   'eq'     `--name=<value>`
 *   'both'   either of the two forms above
 * Positional arguments are never checked; a bare `--` (what `pnpm run script -- --flag` forwards) is ignored.
 * Exit codes of the CLIs that use this: 0 success (or --help), 1 the check failed, 2 bad usage.
 */
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** The text of the leading block comment of a script (after an optional shebang), without the comment markers. */
function headerOf(file) {
  const m = /^(?:#![^\n]*\n)?\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(file, 'utf8'))
  if (!m) return ''
  return m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '').replace(/\s+$/, '')).join('\n').trim()
}

/** `scripts/gates.mjs [--list] [--only <value>] [--limit=<value>] [filter]` */
function usageLine(file, flags, args) {
  const opts = Object.entries(flags).map(([name, kind]) => `[--${name}${kind === 'value' ? ' <value>' : kind === 'eq' ? '=<value>' : kind === 'both' ? ' <value>' : ''}]`)
  return [relative(REPO_ROOT, file), ...opts, ...(args ? [args] : [])].join(' ')
}

/**
 * @param {{ url: string, flags?: Record<string, 'bool' | 'value' | 'eq' | 'both'>, args?: string, argv?: string[] }} spec
 *   `url` is the script's `import.meta.url`; `args` describes its positional arguments for the usage line (`'<tag>'`, `'[filter]'`).
 * @returns {void} exits the process on --help (0) and on an undeclared option (2)
 */
export function cli({ url, flags = {}, args = '', argv = process.argv.slice(2) }) {
  const file = fileURLToPath(url)
  const usage = `Usage: ${usageLine(file, flags, args)}`
  const unknown = []
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--help' || a === '-h') { help = true; continue }
    if (!a.startsWith('-') || /^-\d/.test(a)) continue
    const eq = a.indexOf('=')
    const name = a.startsWith('--') ? (eq < 0 ? a.slice(2) : a.slice(2, eq)) : null
    const kind = name === null ? undefined : flags[name]
    if (kind === 'bool' && eq < 0) continue
    if ((kind === 'value' || kind === 'both') && eq < 0) { i++; continue }
    if ((kind === 'eq' || kind === 'both') && eq >= 0) continue
    unknown.push(a)
  }
  if (help) {
    console.log(`${usage}\n\n${headerOf(file)}`)
    process.exit(0)
  }
  if (unknown.length > 0) {
    const hint = unknown.map((a) => {
      const name = a.replace(/^--/, '').replace(/=.*$/, '')
      const kind = flags[name]
      return kind === 'eq' ? ` (${a} needs a value: --${name}=<value>)` : kind === 'value' ? ` (${a} takes the value after it: --${name} <value>)` : kind === 'bool' ? ` (--${name} takes no value)` : ''
    }).join('')
    console.error(`${relative(REPO_ROOT, file)}: unknown option ${unknown.map((a) => JSON.stringify(a)).join(', ')}${hint}\n${usage}\n(--help prints the header of the script)`)
    process.exit(2)
  }
}
