/**
 * Launch a Playwright browser so that nothing it writes to the OS temp dir outlives the script.
 *
 * Playwright makes `playwright_chromiumdev_profile-*` and `playwright-artifacts-*` in the temp dir and removes them only when the
 * browser is closed (or when the process is ended by a signal). A script that throws, or calls `process.exit`, before `browser.close()`
 * leaves them behind (~100 MB a run). This launches the browser with the temp dir pointed at a directory of scripts/lib/temp-dir.mjs's,
 * which goes when the browser disconnects and, whatever else happens, when the process ends.
 */
import { makeTempDir, removeTempDir } from './temp-dir.mjs'

/**
 * @template B, O
 * @param {{ launch(options?: O): Promise<B> }} browserType `chromium` (or `playwright.chromium`, `playwright[name]`)
 * @param {O} [options] the options of `browserType.launch`
 * @returns {Promise<B>}
 */
export async function launchBrowser(browserType, options) {
  const dir = makeTempDir('aster-browser-')
  const keys = ['TMPDIR', 'TMP', 'TEMP']
  const before = keys.map((k) => process.env[k])
  for (const k of keys) process.env[k] = dir
  try {
    const browser = await browserType.launch(options)
    // (every Playwright Browser is an EventEmitter; `disconnected` fires on close() and on a crash)
    const emitter = /** @type {any} */ (browser)
    // (`disconnected` fires when the connection closes, while Chromium may still be writing: what it writes after is removed at exit)
    emitter.on('disconnected', () => removeTempDir(dir, { again: true }))
    return browser
  } catch (error) {
    removeTempDir(dir)
    throw error
  } finally {
    keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i] })
  }
}
