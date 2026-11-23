#!/usr/bin/env node
/**
 * Removes the `dist` of the package it is run in (the current directory). `tsc` never deletes what an earlier build emitted, so a module
 * whose source was removed or renamed stayed in `dist` (and in the tarball a local `pnpm pack` makes) until someone noticed. The build
 * scripts of the published packages run this first: `node ../../scripts/clean-dist.mjs && tsc -p tsconfig.build.json`.
 *
 * Usage: node ../../scripts/clean-dist.mjs      (from packages/<name>)
 * Exit codes: 0 done (also when there was no dist), 2 bad usage (an unknown option, or the current directory has no package.json).
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cli } from './lib/cli.mjs'

cli({ url: import.meta.url })

const cwd = process.cwd()
if (!existsSync(join(cwd, 'package.json'))) {
  console.error(`[clean-dist] ${cwd} has no package.json: run it from a package directory`)
  process.exit(2)
}
rmSync(join(cwd, 'dist'), { recursive: true, force: true })
