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
 *    error rather than a guess about the environment (an image `url` is also drawn
 *    resolved against it, as vega's loader does: `resolveImageUrl`);
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
/** Hyperlinks (the `href` channel) may also be `mailto:` / `tel:`; never `javascript:`, `file:` or `data:`. */
export const DEFAULT_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:']

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
  // No policy at all (and no `limits`): drawn as given, like Vega. Residual risk: tracking pixels / IP leaks (docs/LIMITS.md).
  return applyUrlPolicy(raw, policy, DEFAULT_IMAGE_PROTOCOLS)
}

/**
 * Apply the policy to a hyperlink (`href` channel). Same rules as images with
 * the link protocol defaults ({@link DEFAULT_LINK_PROTOCOLS}); a denied link
 * throws, or is dropped (the item is drawn without a link) when `onDeny` is set.
 * Without a policy (no `urlPolicy`, no `limits`) only {@link sanitizeHref}
 * applies, which is what Vega does.
 */
export function applyLinkUrlPolicy(raw: unknown, policy: ImageUrlPolicy | undefined): unknown {
  return applyUrlPolicy(raw, policy, DEFAULT_LINK_PROTOCOLS)
}

function applyUrlPolicy(raw: unknown, policy: ImageUrlPolicy | undefined, defaults: readonly string[]): unknown {
  if (raw == null || policy === undefined) return raw
  const text = String(raw)
  try {
    const url = checkBasicUrl(text, policy, defaults)
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

// vega-loader sanitize(): the URIs a hyperlink may carry. From DOMPurify's
// ALLOWED_URI_REGEXP with vega's `file:` / `data:` additions.
const ALLOWED_HREF = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|file|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
// eslint-disable-next-line no-control-regex
const HREF_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205f\u3000]/g

/**
 * The `href` the SVG renderer writes for a hyperlinked item, or null when the
 * item gets no link. A port of vega-loader's `sanitize` as vega-scenegraph's
 * SVGStringRenderer uses it (no loader options): a non-string or a URI outside
 * the allowed schemes (`javascript:`, `vbscript:` ...) is rejected, so the item
 * is drawn unlinked; `//host/p` gets vega's default protocol `http:`; `file://`
 * is stripped to the path. This runs in every renderer regardless of any
 * {@link ImageUrlPolicy}, so a scene that never met the policy still cannot
 * carry a script URL into the markup.
 */
export function sanitizeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (!ALLOWED_HREF.test(raw.replace(HREF_WHITESPACE, ''))) return null
  if (raw.startsWith('file://')) return raw.slice('file://'.length)
  if (raw.startsWith('//')) return 'http:' + raw
  return raw
}

// vega-loader: a uri with a scheme-and-host, `//host`, or `data:` is not relative.
const HAS_PROTOCOL = /^(data:|([A-Za-z]+:)?\/\/)/

/**
 * The url an image is drawn with: vega-loader's `sanitize` as the renderer applies it to an image. A relative url is
 * prefixed with the loader's `baseURL` (here the url policy's), a slash between them when neither has one; `//host`
 * gets vega's default protocol `http:`; `file://` is stripped to the path. A url that is not a string is left as it is.
 */
export function resolveImageUrl(raw: unknown, baseURL: string | undefined): unknown {
  if (typeof raw !== 'string') return raw
  let uri = raw
  if (baseURL && !HAS_PROTOCOL.test(uri)) {
    if (!uri.startsWith('/') && !baseURL.endsWith('/')) uri = '/' + uri
    uri = baseURL + uri
  }
  if (uri.startsWith('file://')) return uri.slice('file://'.length)
  if (uri.startsWith('//')) return 'http:' + uri
  return uri
}
