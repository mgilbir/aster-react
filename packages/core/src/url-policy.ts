/**
 * URL policy shared by the data loader (`@aster/core/load`, C6) and image marks
 * (C93). A spec is untrusted input: every URL it names is something the host
 * (or the viewer's browser) will request, so each one passes a policy first.
 *
 * Defaults (documented in docs/LIMITS.md):
 *  - only `http:` and `https:` (image marks also allow `data:`); anything else
 *    (`javascript:`, `file:`, `ftp:`, `blob:` ...) is denied;
 *  - URLs carrying credentials (`user:pass@host`) are denied;
 *  - relative URLs resolve against `baseURL`; without one a relative URL is an
 *    error rather than a guess about the environment;
 *  - `allow(url)` is a veto hook consulted for every URL (and every redirect hop).
 */

/** Typed policy violation: the URL was refused before any request was made. */
export class AsterUrlError extends Error {
  readonly code = 'ASTER_URL_DENIED'
  constructor(readonly url: string, readonly reason: string) {
    super(`[aster] url denied: ${reason}: ${url.length > 200 ? url.slice(0, 200) + '...' : url}`)
    this.name = 'AsterUrlError'
  }
}

export interface UrlPolicyBase {
  /**
   * Base for resolving relative URLs (e.g. `location.href` in a browser, the
   * origin of the data service on a server). Without it relative URLs are
   * refused (loader) or passed through untouched when no `allow` hook is set
   * (images).
   */
  baseURL?: string
  /** Allowed protocols, each with its trailing colon. Default `['http:', 'https:']`. */
  protocols?: readonly string[]
}

/** The synchronous policy applied to image `url`s while the scene is built. */
export interface ImageUrlPolicy extends UrlPolicyBase {
  /** Return true to permit the URL. Must be synchronous. */
  allow?: (url: URL) => boolean
  /**
   * Called instead of throwing when a URL is denied; the image is then dropped
   * (its item has no `url`, so nothing is drawn and nothing is requested).
   */
  onDeny?: (url: string, error: AsterUrlError) => void
}

export const DEFAULT_LOAD_PROTOCOLS: readonly string[] = ['http:', 'https:']
export const DEFAULT_IMAGE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'data:']

/** Placeholder base used to classify a URL when the host gave none. */
const NO_BASE = 'https://relative.invalid/'

/**
 * The checks every URL passes before a policy-specific hook: parse, protocol
 * allowlist, no embedded credentials. Returns the parsed URL, or null for a
 * genuinely relative URL (no scheme, no host) when the policy has no base to
 * resolve it against. Classification uses the WHATWG parser, never a regex, so
 * leading whitespace, control characters and `//host` forms cannot slip past.
 */
export function checkBasicUrl(raw: string, policy: UrlPolicyBase, defaults: readonly string[]): URL | null {
  const protocols = policy.protocols ?? defaults
  let url: URL
  try {
    url = new URL(raw, policy.baseURL)
  } catch {
    if (policy.baseURL != null) throw new AsterUrlError(raw, 'not a valid URL')
    // Without a base only a scheme-less, host-less reference parses against the placeholder.
    let probe: URL
    try {
      probe = new URL(raw, NO_BASE)
    } catch {
      throw new AsterUrlError(raw, 'not a valid URL')
    }
    if (probe.host === 'relative.invalid') return null
    url = probe // `//host/path`: a network URL whose scheme the base would supply
  }
  if (!protocols.includes(url.protocol)) throw new AsterUrlError(raw, `protocol ${url.protocol} is not allowed`)
  if (url.username || url.password) throw new AsterUrlError(raw, 'URLs with embedded credentials are not allowed')
  return url
}

/**
 * Apply an image policy to one URL. Returns the URL to keep, or null to drop it
 * (only when `onDeny` is set); otherwise a denial throws {@link AsterUrlError}.
 */
export function applyImageUrlPolicy(raw: unknown, policy: ImageUrlPolicy | undefined): unknown {
  // No policy at all: the host trusts its specs (the default outside `limits`).
  if (raw == null || policy === undefined) return raw
  const text = String(raw)
  try {
    const url = checkBasicUrl(text, policy, DEFAULT_IMAGE_PROTOCOLS)
    if (url == null) {
      // relative URL with no base: fine unless the host asked to vet URLs
      if (policy.allow) throw new AsterUrlError(text, 'a relative URL needs a baseURL when an allow hook is set')
      return raw
    }
    if (policy.allow && policy.allow(url) !== true) throw new AsterUrlError(text, 'refused by the allow hook')
    return raw
  } catch (e) {
    if (e instanceof AsterUrlError && policy.onDeny) {
      policy.onDeny(text, e)
      return null
    }
    throw e
  }
}
