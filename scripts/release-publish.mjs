#!/usr/bin/env node
/**
 * The publish step of the Release workflow: `npm publish` of the verified tarballs, core, vl, then react.
 *
 * Usage: node scripts/release-publish.mjs <tag> <tarball-dir> [--dry-run]
 *   <tag>          the pushed release tag (v<version>); the version and the npm dist-tag come from it
 *   <tarball-dir>  holds aster-charts-<pkg>-<version>.tgz for every public package (what `pnpm pack` writes)
 *   --dry-run      print what would run; run nothing
 *
 * Two properties the workflow relies on, both pinned by scripts/release-publish.test.mjs:
 *   - the dist-tag is explicit: `next` for a prerelease version, `latest` for a stable one (scripts/lib/release.mjs).
 *     Without `--tag`, npm 10 would publish v0.5.0-rc.1 as `latest` and npm 11 would refuse it;
 *   - it is re-runnable: a version that is already on the registry is skipped (`npm view <name>@<version>`), so when the
 *     second package of three failed (registry 5xx, OTP), re-running the job publishes the missing ones instead of failing
 *     at the first. Any answer from `npm view` other than "has it" or "E404" is an error, never a reason to publish.
 *
 * Exit codes: 0 every package is on the registry at the tag's version, 1 a tarball is missing or npm failed, 2 bad usage.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { cli } from './lib/cli.mjs'
import { PUBLISH_ORDER, distTagFor, versionOfTag } from './lib/release.mjs'

cli({ url: import.meta.url, flags: { 'dry-run': 'bool' }, args: '<tag> <tarball-dir>' })

const args = process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('--'))
const dryRun = process.argv.includes('--dry-run')
const [tag, dir] = args
const fail = (msg) => { console.error(`[release-publish] FAIL: ${msg}`); process.exit(1) }

if (!tag || !dir || args.length > 2) { console.error('Usage: node scripts/release-publish.mjs <tag> <tarball-dir> [--dry-run]'); process.exit(2) }
const version = versionOfTag(tag)
if (!version) fail(`tag "${tag}" is not a version tag`)
const distTag = distTagFor(version)

const jobs = PUBLISH_ORDER.map((pkg) => {
  const file = join(resolve(dir), `aster-charts-${pkg}-${version}.tgz`)
  if (!existsSync(file)) fail(`${file} is missing: the verify job must have packed @aster-charts/${pkg} at ${version}`)
  return { name: `@aster-charts/${pkg}`, file }
})

function npm(argv) {
  const r = spawnSync('npm', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) fail(`could not run npm: ${r.error.message}`)
  return r
}

for (const { name, file } of jobs) {
  const view = npm(['view', `${name}@${version}`, 'version'])
  if (view.status === 0 && view.stdout.trim() === version) {
    console.log(`[release-publish] ${name}@${version} is already on the registry: skipped`)
    continue
  }
  if (view.status === 0) fail(`npm view ${name}@${version} answered ${JSON.stringify(view.stdout.trim())}, not the version`)
  if (!/\bE404\b|\b404\b/.test(view.stderr)) fail(`npm view ${name}@${version} failed for a reason other than "not published":\n${view.stderr}`)
  // `./` or an absolute path: npm reads `dir/file.tgz` as GitHub `owner/repo` shorthand and tries git.
  const publish = ['publish', file, '--access', 'public', '--provenance', '--ignore-scripts', '--tag', distTag]
  console.log(`[release-publish] npm ${publish.join(' ')}`)
  if (dryRun) continue
  const r = spawnSync('npm', publish, { stdio: 'inherit' })
  if (r.error || r.status !== 0) {
    fail(`npm publish of ${name}@${version} failed; fix the cause and re-run the job: the packages already published are skipped`)
  }
}
console.log(`[release-publish] ${version} is on the registry under the "${distTag}" dist-tag for every public package`)
