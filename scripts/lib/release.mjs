/**
 * Release facts shared by the release scripts and their tests: what a version tag looks like, which npm dist-tag a
 * version is published under, and the publish order of the public packages.
 */

/** Public packages in publish order: dependencies first (@aster-charts/react depends on core and vl). */
export const PUBLISH_ORDER = ['core', 'vl', 'react']

const NUM = '(?:0|[1-9]\\d*)'
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
/** `v<major>.<minor>.<patch>[-<prerelease>]` exactly as semver 2.0.0 writes it (no build metadata, no leading zeros). */
export const TAG_RE = new RegExp(`^v(${NUM}\\.${NUM}\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?)$`)

/** The version a release tag names, or null when the tag is not a version tag. */
export function versionOfTag(tag) {
  return TAG_RE.exec(tag)?.[1] ?? null
}

/**
 * The npm dist-tag a version is published under: a prerelease goes to `next` so `latest` stays on the last stable release,
 * every other version goes to `latest`. Always passed to `npm publish --tag`, because without it npm 10 puts a prerelease
 * under `latest` and npm 11 refuses to publish it.
 */
export function distTagFor(version) {
  if (versionOfTag(`v${version}`) !== version) {
    throw new Error(`not a semver version: ${JSON.stringify(version)}`)
  }
  return version.includes('-') ? 'next' : 'latest'
}
