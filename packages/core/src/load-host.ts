/**
 * Which hosts the data loader treats as non-public: the destinations a spec's `url` must not make the host (or the viewer's
 * browser) request unless the host opts in with `allowPrivateNetwork`.
 *
 * The rule reads the host as the WHATWG URL parser does (so `0x7f.1`, `2130706433`, `0177.0.0.1`, full-width digits and
 * `[::ffff:127.0.0.1]` are the addresses they spell), then:
 *
 * - a name with no dot (after every trailing dot is dropped: `http://metadata/`, `http://intranet/`, `localhost..`) can only be
 *   resolved by a local search domain or hosts file, so it is non-public;
 * - a name under a special-use or private-use suffix (RFC 6761/6762/8375/9476 and ICANN's `.internal`, plus the de-facto
 *   internal suffixes `lan`, `home`, `corp`, `intranet`, `private`, `localdomain`, Kubernetes' `svc`) is non-public;
 * - an IPv4 address is public unless it is in a special-purpose block that is not globally reachable (IANA IPv4
 *   Special-Purpose Address Registry), or multicast / reserved;
 * - an IPv6 address is public only inside global unicast `2000::/3`, minus its special-purpose blocks (Teredo and the rest of
 *   `2001::/23`, documentation, 6to4 / NAT64 whose embedded IPv4 address is non-public); the IPv4-mapped and well-known
 *   NAT64 forms are judged by the IPv4 address they carry. Everything outside `2000::/3` (`::/8`, `100::/8`, unique local,
 *   link-local, site-local, multicast, unassigned space) is non-public.
 *
 * What a host literal cannot show is where a public NAME resolves: that is DNS, which this check does not perform (see
 * docs/LIMITS.md, "What the policy cannot see"). The loader's required `allow` policy is the control for names.
 */

/** Name suffixes (the last label) that never denote a host on the public internet. */
const NON_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // special-use domain names (IANA registry): RFC 6761 (test, localhost, invalid, example), RFC 6762 (local), RFC 7686 (onion),
  // RFC 9476 (alt), and `.arpa` (home.arpa RFC 8375, the reverse-mapping zones, resolver.arpa, service.arpa, ...)
  'test', 'localhost', 'invalid', 'example', 'local', 'onion', 'alt', 'arpa',
  // ICANN's private-use TLD (2024)
  'internal',
  // de-facto internal suffixes: home and office routers, corporate DNS, Kubernetes service names (`<svc>.<ns>.svc`)
  'localdomain', 'lan', 'home', 'corp', 'intranet', 'private', 'svc',
])

/** The host as the WHATWG URL parser reads it (lower case, canonical IPv4 and IPv6, punycode), without brackets; null if it is not one. */
function canonicalHost(hostname: string): string | null {
  const raw = hostname.trim()
  if (raw === '') return null
  // an IPv6 literal given without its brackets (as `URL.hostname` never is, but a caller may)
  const literal = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
  let host: string
  try {
    const url = new URL(`http://${literal}/`)
    // anything that changed the authority (a port, a path, credentials smuggled into the "hostname") is not a host
    if (url.port !== '' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
    host = url.hostname
  } catch {
    return null
  }
  return host.startsWith('[') ? host.slice(1, -1) : host
}

/** The four octets of a canonical dotted-quad IPv4 address, or null. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every((x) => x <= 255) ? o : null
}

/** Whether an IPv4 address is in a block that is not globally reachable (or multicast / reserved / broadcast). */
function nonPublicIPv4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number]
  return (
    a === 0 ||                                    // 0.0.0.0/8 "this network"
    a === 10 ||                                   // 10.0.0.0/8 private
    (a === 100 && b >= 64 && b <= 127) ||         // 100.64.0.0/10 shared address space (carrier-grade NAT)
    a === 127 ||                                  // 127.0.0.0/8 loopback
    (a === 169 && b === 254) ||                   // 169.254.0.0/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||          // 172.16.0.0/12 private
    (a === 192 && b === 0 && c === 0) ||          // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) ||          // 192.0.2.0/24 documentation (TEST-NET-1)
    (a === 192 && b === 88 && c === 99) ||        // 192.88.99.0/24 deprecated 6to4 relay anycast
    (a === 192 && b === 168) ||                   // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) ||      // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) ||       // 198.51.100.0/24 documentation (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) ||        // 203.0.113.0/24 documentation (TEST-NET-3)
    a >= 224                                      // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  )
}

/** Eight 16-bit groups of an IPv6 address (no brackets, no zone; a trailing dotted IPv4 part allowed), or null. */
function ipv6Groups(host: string): number[] | null {
  let h = host
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (dotted) {
    const o = ipv4Octets(dotted[1]!)
    if (!o) return null
    h = h.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16)
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const parts = [...left, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  if (parts.length !== 8) return null
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/i.test(p) ? parseInt(p, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

/** The IPv4 address two groups carry. */
const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255]

/** Whether an IPv6 address is outside the publicly routed unicast space, or carries a non-public IPv4 address. */
function nonPublicIPv6(g: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0)
  // ::ffff:a.b.c.d (IPv4-mapped): a dual-stack socket connects to the IPv4 address itself
  if (zeros(0, 5) && g[5] === 0xffff) return nonPublicIPv4(embedded(g[6]!, g[7]!))
  // 64:ff9b::/96 (well-known NAT64 prefix): the translator connects to the embedded IPv4 address
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return nonPublicIPv4(embedded(g[6]!, g[7]!))
  // 2002::/16 (6to4): the relay delivers to the IPv4 address in bits 16-47
  if (g[0] === 0x2002) return nonPublicIPv4(embedded(g[1]!, g[2]!))
  const first = g[0]!
  // everything outside global unicast 2000::/3: ::/8 (unspecified, loopback, IPv4-compatible, SIIT), 64:ff9b:1::/48 local NAT64,
  // 100::/8 discard, unassigned space, fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast
  if ((first & 0xe000) !== 0x2000) return true
  // 2001::/23 IETF protocol assignments (Teredo 2001::/32, benchmarking, ORCHID, the anycast services)
  if (first === 0x2001 && g[1]! < 0x200) return true
  // 2001:db8::/32 and 3fff::/20 documentation
  if (first === 0x2001 && g[1] === 0x0db8) return true
  if (first === 0x3fff && g[1]! < 0x1000) return true
  return false
}

/**
 * True when a URL's host names a destination that is not on the public internet: a dotless name, a special-use or
 * private-use name, a non-public IPv4 address or any IPv6 address outside public unicast (including IPv4-mapped, NAT64 and
 * 6to4 forms of a non-public IPv4 address). Anything the URL parser does not read as a host is non-public too (fail closed).
 * It cannot see DNS: a public name that resolves to a private address is not detected here.
 */
export function isNonPublicHost(hostname: string): boolean {
  if (typeof hostname !== 'string') return true
  const canonical = canonicalHost(hostname)
  if (canonical === null) return true
  const host = canonical.replace(/\.+$/, '')
  if (host === '') return true
  if (canonical.includes(':')) {
    const g = ipv6Groups(canonical)
    return g === null || nonPublicIPv6(g)
  }
  const v4 = ipv4Octets(host)
  if (v4) return nonPublicIPv4(v4)
  const labels = host.split('.')
  // a single label resolves only through a local search domain or hosts file
  if (labels.length < 2) return true
  return NON_PUBLIC_SUFFIXES.has(labels[labels.length - 1]!)
}
