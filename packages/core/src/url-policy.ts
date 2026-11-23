/**
 * URL policy shared by the data loader (`@aster-charts/core/load`), hyperlinks and image marks.
 * A spec is untrusted input: every URL it names is something the host
 * (or the viewer's browser) will request, so each one passes a policy first.
 *
 * Defaults (documented in docs/LIMITS.md):
 *  - only `http:` and `https:` (image marks also allow `data:`, links `mailto:` and `tel:`); anything else
 *    (`javascript:`, `file:`, `ftp:`, `blob:` ...) is denied;
 *  - URLs carrying credentials (`user:pass@host`) are denied;
 *  - relative URLs: the data loader resolves them against `baseURL` and refuses one without it rather than guess about the
 *    environment; an image `url` is drawn with the `baseURL` as a prefix (vega's loader rule, `resolveImageUrl`), and that
 *    drawn url is what the policy vets; a relative image `url` or link with no `baseURL` is kept unless an `allow` hook is set,
 *    which refuses it;
 *  - `allow(url)` is a veto hook consulted for every URL (and every redirect hop).
 *
 * Two places apply it. The evaluation (`applyImageUrlPolicy`, `applyLinkUrlPolicy`) vets the URL channels it knows and throws,
 * or calls `onDeny` and drops the URL. The renderers vet every URL they write, at the one place each writes it (`outputUrl`):
 * with the policy the scene was evaluated under, else with the defaults, so href and image vetting are on even with no
 * policy and no `limits`, and a URL no evaluation vetted still never reaches the output.
 */

/** Placeholder base used to classify a URL when the host gave none. */
const NO_BASE = 'https://relative.invalid/'

/**
 * Typed policy violation: the URL was refused before any request was made. The URL it carries (`url`, and the copy in the
 * message) has any user name and password replaced by `***` ({@link redactUrl}): a host that logs the error, or shows it
 * through `onError`, never writes a credential out.
 */
export class AsterUrlError extends Error {
  readonly code = 'ASTER_URL_DENIED'
  readonly url: string
  constructor(url: string, readonly reason: string) {
    const shown = redactUrl(url)
    super(`[aster] url denied: ${reason}: ${shown.length > 200 ? shown.slice(0, 200) + '...' : shown}`)
    this.url = shown
    this.name = 'AsterUrlError'
  }
}

/** The user-info part of an authority anywhere in a text: after `//` (or `\\`), what stands up to the last `@` of that segment. */
const AUTHORITY_USERINFO = /([\\/]{2})[^\\/?#\s]*@/g
/** The user-info right after a leading scheme with no slashes (`https:user:pw@host`, which a special scheme reads as one). */
const LEADING_USERINFO = /^([\u0000-\u0020]*[A-Za-z][A-Za-z0-9+.\-]*:)[^\\/?#\s]*@/

/**
 * A URL text with anything that may be a user name and password replaced by `***`, for messages and errors: the user-info of
 * every authority in it (a URL the policy refused may be judged after vega's rewrites, `file://` stripped, so an authority
 * anywhere in the text counts), and the user-info right after a leading scheme when the WHATWG parser reads one there (it
 * does for `https:user:pw@host`; a `mailto:` address keeps its `@`). Tabs and newlines, which the parser ignores, are dropped
 * first, so they cannot split a credential past the redaction.
 */
export function redactUrl(raw: string): string {
  if (raw.indexOf('@') < 0) return raw
  let text = raw.replace(/[\t\n\r]/g, '').replace(AUTHORITY_USERINFO, '$1***@')
  let leading = true
  try {
    const url = new URL(text, NO_BASE)
    leading = url.username !== '' || url.password !== ''
  } catch {
    // unreadable: redact whatever stands where credentials would
  }
  if (leading) text = text.replace(LEADING_USERINFO, '$1***@')
  return text
}

export interface UrlPolicyBase {
  /**
   * Base for relative URLs. The data loader resolves a relative url against it (WHATWG `new URL(url, baseURL)`: the origin
   * of the data service on a server, or a directory URL). An image `url` is drawn with it as a text prefix, as vega's loader
   * does (`baseURL + '/' + url`): give a directory (`https://app.example/assets/`), not a page URL such as `location.href`,
   * whose query or file name would become part of every image path. Without it relative URLs are refused (loader) or
   * passed through untouched when no `allow` hook is set (images, links).
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
  return applyUrlPolicy(raw, policy, DEFAULT_IMAGE_PROTOCOLS)
}

/**
 * Apply the policy to a hyperlink (`href` channel). Same rules as images with
 * the link protocol defaults ({@link DEFAULT_LINK_PROTOCOLS}); a denied link
 * throws, or is dropped (the item is drawn without a link) when `onDeny` is set.
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
    if (policy.allow) {
      if (policy.allow(url) !== true) throw new AsterUrlError(text, 'refused by the allow hook')
      remember(policy.allow, url.href)
    }
    return raw
  } catch (e) {
    if (e instanceof AsterUrlError && policy.onDeny) {
      policy.onDeny(text, e)
      return null
    }
    throw e
  }
}

// --- the output sink ------------------------------------------------------------------------------------------------
//
// Every URL a renderer writes (a link's `xlink:href`, an image's `xlink:href`, the urls the canvas loads) is decided here, at
// the place the output is produced, whatever channel or code path put it on the scene: a channel nobody vetted while the scene
// was built still cannot reach the output with a URL the policy refuses. The policy is the one the scene was evaluated under
// (`bindSceneUrlPolicy`), else the defaults: href and image vetting are on with no `urlPolicy` and no `limits` at all, and they
// fail closed (a URL that cannot be read, or is refused, is not written: the item is drawn without its link, the image not at
// all). Nothing here throws and no `onDeny` is called: reporting a refusal is the evaluation's (`applyImageUrlPolicy`,
// `applyLinkUrlPolicy`), which has already dropped or refused every URL of the channels it knows.

/** What a URL in the output is for: a hyperlink, or a bitmap the viewer's browser loads. */
export type OutputUrlKind = 'link' | 'image'

const SCENE_URL_POLICY: unique symbol = Symbol.for('@aster-charts/core:url-policy') as never

/**
 * Record the policy a scene was evaluated under, so its renderers vet with it. Kept under a symbol: it is copied along with the
 * scene's other properties (a spread, a copy with its descriptors) and dropped by a structured clone (a scene posted from a
 * worker is vetted against the defaults where it is drawn), and no spec or JSON can name it.
 */
export function bindSceneUrlPolicy(scene: object, policy: ImageUrlPolicy | undefined): void {
  if (policy === undefined) {
    if (SCENE_URL_POLICY in scene) delete (scene as { [SCENE_URL_POLICY]?: ImageUrlPolicy })[SCENE_URL_POLICY]
    return
  }
  Object.defineProperty(scene, SCENE_URL_POLICY, { value: policy, enumerable: true, configurable: true, writable: true })
}

/** The policy a scene was evaluated under (see {@link bindSceneUrlPolicy}), if any. */
export function sceneUrlPolicy(scene: object | null | undefined): ImageUrlPolicy | undefined {
  return scene == null ? undefined : (scene as { [SCENE_URL_POLICY]?: ImageUrlPolicy })[SCENE_URL_POLICY]
}

/**
 * The URLs an `allow` hook permitted, by hook: the evaluation records each it asked about, so the renderers do not ask again
 * for a URL the scene was built with (the engine already treats one policy object as one set of answers: what it keeps between
 * evaluations under the same policy is not vetted again). Bounded: cleared whole when full, which costs only a repeated question.
 */
const PERMITTED = new WeakMap<(url: URL) => boolean, Set<string>>()
const PERMITTED_MAX = 4096
function remember(allow: (url: URL) => boolean, href: string): void {
  let set = PERMITTED.get(allow)
  if (set === undefined) PERMITTED.set(allow, (set = new Set()))
  else if (set.size >= PERMITTED_MAX) set.clear()
  set.add(href)
}

/** `http://` or `https://` written plainly, with no `@` anywhere: the scheme is read off the prefix and there can be no credentials. */
const PLAIN_HTTP = /^https?:\/\/[^@]*$/

/**
 * The URL text to write for an output URL, or null to write none. `raw` is normalised as vega-loader's `sanitize` does (a
 * leading `file://` is stripped, `//host` gets `http:`), and then the text that would be written is classified by the WHATWG
 * parser (never a regex: leading whitespace, control characters and `\\` cannot slip past): its protocol must be one the policy
 * allows (default {@link DEFAULT_LINK_PROTOCOLS} / {@link DEFAULT_IMAGE_PROTOCOLS}), it must carry no credentials, and the
 * policy's `allow` hook, when there is one, must permit it; a relative URL is kept unless there is a hook and no `baseURL`.
 */
export function outputUrl(kind: OutputUrlKind, raw: unknown, policy: ImageUrlPolicy | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  const uri = raw.startsWith('file://') ? raw.slice('file://'.length) : raw.startsWith('//') ? 'http:' + raw : raw
  if (uri === '') return null
  const defaults = kind === 'link' ? DEFAULT_LINK_PROTOCOLS : DEFAULT_IMAGE_PROTOCOLS
  const protocols = policy?.protocols ?? defaults
  const allow = policy?.allow
  if (allow === undefined) {
    // (the common shapes, without the parser: a plain http(s) url, and an image's data url -- which can be megabytes long)
    if (PLAIN_HTTP.test(uri)) return protocols.includes(uri.charCodeAt(4) === 115 ? 'https:' : 'http:') ? uri : null
    // (`data:` not followed by a slash: no authority, so no credentials, whatever follows)
    if (uri.startsWith('data:') && uri.charCodeAt(5) !== 47) return protocols.includes('data:') ? uri : null
  }
  let url: URL | null
  try {
    url = checkBasicUrl(uri, { protocols, ...(policy?.baseURL !== undefined ? { baseURL: policy.baseURL } : {}) }, defaults)
  } catch {
    return null
  }
  if (url === null) return allow === undefined ? uri : null
  if (allow !== undefined && PERMITTED.get(allow)?.has(url.href) !== true) {
    let ok = false
    try { ok = allow(url) === true } catch { ok = false }
    if (!ok) return null
    remember(allow, url.href)
  }
  // A text is written as it is only when it means what it was vetted as, wherever the page is. One with no scheme of its own that
  // names a host (`\\host\p`) or was resolved against the policy's base, or one whose meaning the base changed (`https:a@b`:
  // relative to an https base, but absolute with credentials to any other page), is written as the URL it was vetted as.
  if (!SCHEME.test(uri)) return url.href
  if (policy?.baseURL === undefined) return uri
  return URL.canParse(uri) && new URL(uri).href === url.href ? uri : url.href
}

/** A URL text that starts with a scheme of its own (after what the WHATWG parser skips). */
const SCHEME = /^[\u0000-\u0020]*[A-Za-z][A-Za-z0-9+.\-]*:/

/**
 * The `href` a hyperlink is written with when no policy is in force, or null when the item gets no link: {@link outputUrl}
 * with the link defaults. vega-loader's `sanitize` drops a script URL by a pattern (and passes `file://javascript:` through,
 * since it strips `file://` after its check); here the text that is written is the one classified, so no scheme outside
 * `http:`, `https:`, `mailto:`, `tel:` is ever linked, whatever the spec says.
 */
export function sanitizeHref(raw: unknown): string | null {
  return outputUrl('link', raw, undefined)
}

// vega-loader: a uri with a scheme-and-host, `//host`, or `data:` is not relative.
const HAS_PROTOCOL = /^(data:|([A-Za-z]+:)?\/\/)/

/**
 * The url an image is drawn with: vega-loader's `sanitize` as the renderer applies it to an image. A relative url is
 * prefixed with the policy's `baseURL` (a text prefix, as vega's loader does, not a WHATWG resolution: a base that names a
 * page and a query is a directory to it), a slash between them when neither has one; `//host` gets vega's default
 * protocol `http:`; `file://` is stripped to the path. A url that is not a string is left as it is. This is the url the
 * policy is applied to (`allow` sees exactly what is drawn).
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
