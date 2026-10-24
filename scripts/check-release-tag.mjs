/**
 * Release guard (C77): the pushed tag must be `v<version>` and equal the version
 * of EVERY public package, and the three public packages must agree.
 *
 * Usage: node scripts/check-release-tag.mjs <tag> [--root <repo>]
 *        (the release workflow passes $GITHUB_REF_NAME)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = ['core', 'react', 'vl']
const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = rootAt >= 0 ? args.splice(rootAt, 2)[1] : dirname(dirname(fileURLToPath(import.meta.url)))
const tag = args[0]

function fail(message) {
  console.error(`[check-release-tag] FAIL: ${message}`)
  process.exit(1)
}

if (!tag) fail('usage: check-release-tag.mjs <tag>')
const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)
if (!m) fail(`tag "${tag}" is not a version tag (v<major>.<minor>.<patch>[-prerelease])`)
const want = m[1]
for (const pkg of PUBLIC) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))
  if (manifest.private) fail(`@aster/${pkg} is private`)
  if (manifest.version !== want) fail(`tag ${tag} does not match @aster/${pkg} version ${manifest.version}`)
}
console.log(`[check-release-tag] ${tag} matches every public package (${PUBLIC.map((p) => `@aster/${p}`).join(', ')}) at ${want}`)
