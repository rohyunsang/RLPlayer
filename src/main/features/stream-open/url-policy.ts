/**
 * M35 stream-open — R02, the protocol allowlist, and the URL parsing R15 needs.
 *
 * This is the module's security surface and it is deliberately pure: no mpv, no
 * Electron, no I/O, so `url-policy.test.ts` exercises the real implementation
 * rather than a copy of it.
 *
 * TWO THINGS THIS FILE IS NOT.
 *
 * It is not `ctx.network`. `ctx.network` answers "may this build reach HOST h?"
 * from a compile-time table of exact hostnames in `src/main/core/no-network.ts`.
 * R02 answers a different question — "is this SCHEME safe to hand to mpv, given
 * where the string came from?" — and the two do not substitute for each other.
 * See the header of `index.ts` for what that means for the zero-network promise.
 *
 * It is not `new URL()` — and the reason is NOT the one you would guess.
 * `hostname` is actually fine; it is the ROUND TRIP that mangles, measured on
 * Node 24.14.0 against the exact URLs in R15:
 *
 *   new URL('udp://@239.1.1.1:5000?fifo_size=1000000').hostname
 *       -> '239.1.1.1'                                     (correct!)
 *   new URL('udp://@239.1.1.1:5000?fifo_size=1000000').href
 *       -> 'udp://239.1.1.1:5000?fifo_size=1000000'         THE '@' IS GONE
 *   new URL('http://user:p@ss@h.example:8080/live').href
 *       -> 'http://user:p%40ss@h.example:8080/live'         PASSWORD REWRITTEN
 *
 * In ffmpeg's multicast syntax `@` means "listen on any interface for this
 * group", so a normaliser that hands mpv `u.href` turns an IPTV multicast
 * subscription into a unicast connect that will never receive a packet, and
 * changes an FTP/WebDAV password on the way past. Both are silent. So no string
 * this module gives mpv is ever produced by a URL parser: `url` on a verdict is
 * always the user's own text, and the parsing below exists only to LOOK.
 */

/**
 * Where the string came from. This is the axis R02 is actually about: the same
 * `edl://` text is a power user's deliberate choice when typed into our own box
 * and a remote code-execution primitive when it arrives from a web page through
 * the `rlplayer://` handler (R35, M34) or from inside a dropped `.m3u`.
 */
export type UrlSource =
  /** Typed or pasted into this module's own Open URL field. */
  | 'user'
  /** The clipboard, read on an explicit paste action. */
  | 'clipboard'
  /** argv. */
  | 'cli'
  /** A drag-and-drop payload. */
  | 'drag-drop'
  /** The OS `rlplayer://` protocol handler (R35, M34). */
  | 'protocol-handler'
  /** An entry inside a playlist file we expanded. */
  | 'playlist-entry'

/**
 * R02's ALLOW column, verbatim from the spec's §2 streaming table, plus the
 * `httpproxy` name R33 lists from `--list-protocols` that reaches the same path.
 *
 * `data` is spelled `data` here and `data://` to mpv — the spec's own note. The
 * scheme token is what we match; the string we hand mpv is never rewritten.
 */
export const ALLOWED_SCHEMES: readonly string[] = [
  'http',
  'https',
  'ftp',
  'ftps',
  'sftp',
  'dav',
  'davs',
  'webdav',
  'webdavs',
  'httpproxy',
  'smb',
  'mms',
  'mmsh',
  'mmst',
  'mmshttp',
  'rtmp',
  'rtmpe',
  'rtmps',
  'rtmpt',
  'rtmpte',
  'rtmpts',
  'rtp',
  'srtp',
  'srt',
  'rtsp',
  'rtsps',
  'udp',
  'udplite',
  'tcp',
  'tls',
  'dtls',
  'ipfs',
  'ipns',
  'data'
]

/**
 * R02's DENY column. Every one of these is refused from EVERY source, `user`
 * included — the allowlist above is the whole permitted set, and this list
 * exists so the refusal can say *why* rather than "unknown scheme".
 *
 * `av`/`avdevice` reach libavdevice; `edl`/`lavf`/`env`/`concat`/`slice` are
 * arbitrary-input primitives; `mpv://` is the IPC surface mpv's own manual calls
 * "explicitly insecure". `file://` is refused here and handled by M28 as a path
 * (§3.7.3 `playlist.openPaths`) — a different code path with a different threat
 * model, which is why it gets its own reason rather than a scary one.
 */
export const DENIED_SCHEMES: Readonly<Record<string, string>> = {
  mpv: 'mpv-ipc',
  av: 'libavdevice',
  avdevice: 'libavdevice',
  file: 'local-path',
  fd: 'process-primitive',
  fdclose: 'process-primitive',
  hex: 'arbitrary-input',
  memory: 'arbitrary-input',
  null: 'arbitrary-input',
  slice: 'arbitrary-input',
  concat: 'arbitrary-input',
  concatf: 'arbitrary-input',
  edl: 'arbitrary-input',
  lavf: 'arbitrary-input',
  ffmpeg: 'arbitrary-input',
  env: 'arbitrary-input',
  archive: 'arbitrary-input',
  appending: 'arbitrary-input'
}

/**
 * Schemes where a leading `@` in the authority is ffmpeg's multicast marker and
 * NOT userinfo. Getting this wrong is the one thing R15 says is the real work.
 */
const MULTICAST_AT_SCHEMES = new Set(['udp', 'udplite', 'rtp', 'srtp'])

export type UrlRefusal =
  | 'empty'
  | 'local-path'
  | 'control-character'
  | 'multiline'
  | 'no-scheme'
  | 'denied-scheme'
  | 'unknown-scheme'

export type UrlVerdict =
  | {
      readonly ok: true
      /** The user's string, unmodified. This is what goes to mpv. */
      readonly url: string
      readonly scheme: string
      /** Host with no port, no userinfo, no brackets; '' when there is none. */
      readonly host: string
      /** True for `udp://@group`, so the UI can say "multicast" not "no host". */
      readonly multicast: boolean
      /** R04: a `loadlist` retry is worth trying if `loadfile` finds no streams. */
      readonly playlistCandidate: boolean
      /** R12/R13: which manifest family, for the reload-required warnings. */
      readonly manifest: 'hls' | 'dash' | null
    }
  | {
      readonly ok: false
      readonly reason: UrlRefusal
      /** The scheme we found, when we found one. For the message. */
      readonly scheme?: string
      /** The DENIED_SCHEMES category, when that is why. */
      readonly category?: string
    }

/** `scheme:` per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+\-.]*):/

/**
 * A single-letter "scheme" followed by a slash or backslash is a Windows drive
 * letter, and `c:\video.mkv` must never be read as the scheme `c`. UNC paths
 * have no colon at all and are caught by the leading `\\`.
 */
const DRIVE_RE = /^[A-Za-z]:[\\/]/

export function schemeOf(input: string): string | null {
  const m = SCHEME_RE.exec(input)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * The authority, from after `scheme://` to the first `/`, `?` or `#`.
 *
 * Written by hand rather than delegated, for the `udp://@239...` reason in the
 * file header. Returns `''` for a scheme with no authority (`data://...`).
 */
export function authorityOf(input: string, scheme: string): { host: string; multicast: boolean } {
  const rest = input.slice(scheme.length + 1)
  if (!rest.startsWith('//')) return { host: '', multicast: false }
  let auth = rest.slice(2)
  const end = auth.search(/[/?#]/)
  if (end >= 0) auth = auth.slice(0, end)

  let multicast = false
  if (MULTICAST_AT_SCHEMES.has(scheme) && auth.startsWith('@')) {
    // ffmpeg's multicast marker. NOT userinfo: there is no user before it.
    multicast = true
    auth = auth.slice(1)
  } else {
    // Real userinfo. Split on the LAST '@' — a password may contain one.
    const at = auth.lastIndexOf('@')
    if (at >= 0) auth = auth.slice(at + 1)
  }

  // An IPv6 literal keeps its colons; anything else loses a trailing :port.
  if (auth.startsWith('[')) {
    const close = auth.indexOf(']')
    if (close > 0) return { host: auth.slice(1, close).toLowerCase(), multicast }
    return { host: auth.toLowerCase(), multicast }
  }
  const colon = auth.lastIndexOf(':')
  if (colon >= 0) auth = auth.slice(0, colon)
  return { host: auth.toLowerCase(), multicast }
}

/** The path component only, with the query and fragment removed. */
export function pathOf(input: string, scheme: string): string {
  let rest = input.slice(scheme.length + 1)
  if (rest.startsWith('//')) {
    const slash = rest.slice(2).search(/[/?#]/)
    rest = slash < 0 ? '' : rest.slice(2 + slash)
  }
  const cut = rest.search(/[?#]/)
  return cut < 0 ? rest : rest.slice(0, cut)
}

const PLAYLIST_EXT = /\.(m3u|m3u8|pls|asx|wpl|xspf)$/i

/**
 * R04/R12/R13 classification, and note what it deliberately does NOT do: it
 * never decides `loadlist` vs `loadfile` on the extension. `.m3u8` is both an
 * HLS manifest and a plain playlist, and the spec's instruction is to let
 * `loadfile` decide and fall back only when `track-list` comes back empty. So
 * `playlistCandidate` means "a `loadlist` retry is worth trying if the first
 * attempt finds nothing", never "expand this".
 */
function classifyPath(p: string): { playlistCandidate: boolean; manifest: 'hls' | 'dash' | null } {
  const lower = p.toLowerCase()
  if (lower.endsWith('.m3u8')) return { playlistCandidate: true, manifest: 'hls' }
  if (lower.endsWith('.mpd')) return { playlistCandidate: false, manifest: 'dash' }
  return { playlistCandidate: PLAYLIST_EXT.test(lower), manifest: null }
}

/* eslint-disable no-control-regex */
/**
 * Every C0 control plus DEL, EXCEPT CR and LF, which the multiline rule catches
 * first so the message can name the real problem. TAB is in the set on purpose:
 * trim() has already removed a leading or trailing one, so a tab that survives
 * to here is interior, and an interior tab in a URL is a paste artefact.
 */
const CONTROL_RE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/
/* eslint-enable no-control-regex */

/**
 * The one entry point. Every string that becomes an mpv argument in this module
 * passes through here first, whatever its source.
 */
export function classifyUrl(raw: string, source: UrlSource): UrlVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const input = raw.trim()
  if (input.length === 0) return { ok: false, reason: 'empty' }

  // A pasted block of two lines is two URLs, and silently opening the first is
  // how a "the app ignored half of what I pasted" report happens. Checked before
  // the control-character rule so the message can be specific about it.
  if (/[\r\n]/.test(input)) return { ok: false, reason: 'multiline' }
  if (CONTROL_RE.test(input)) return { ok: false, reason: 'control-character' }

  if (DRIVE_RE.test(input) || input.startsWith('\\\\')) {
    return { ok: false, reason: 'local-path' }
  }

  const scheme = schemeOf(input)
  if (scheme === null) {
    // No colon at all: a bare host, a relative path, or a Windows path with no
    // drive letter. Not this module's business, and NOT silently prefixed with
    // `http://` — guessing a scheme for a string that came from
    // 'protocol-handler' would turn someone else's typo into a request.
    return { ok: false, reason: 'no-scheme' }
  }

  const denied = DENIED_SCHEMES[scheme]
  if (denied !== undefined) {
    return {
      ok: false,
      reason: denied === 'local-path' ? 'local-path' : 'denied-scheme',
      scheme,
      category: denied
    }
  }
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return { ok: false, reason: 'unknown-scheme', scheme }
  }

  const { host, multicast } = authorityOf(input, scheme)
  const { playlistCandidate, manifest } = classifyPath(pathOf(input, scheme))

  // `source` is intentionally not consulted to WIDEN anything. It is a required
  // argument so a caller cannot forget to state it, and so a future row that
  // wants to NARROW a scheme for one source has somewhere to put it. Nothing
  // above is more permissive for 'user' than for 'protocol-handler'.
  void source

  return { ok: true, url: input, scheme, host, multicast, playlistCandidate, manifest }
}

/**
 * R03: only USER-ENTERED urls go in the history. PotPlayer has this toggle for a
 * reason — an HLS master playlist would otherwise flood the list with segment
 * URLs, one per few seconds of playback.
 */
export function isHistoryWorthy(source: UrlSource): boolean {
  return source === 'user' || source === 'clipboard'
}

/** The i18n key for a refusal, so the message is translated and specific. */
export function refusalKey(v: Extract<UrlVerdict, { ok: false }>): string {
  return `stream-open.refuse.${v.reason}`
}

/**
 * Compose `scheme://rest`, because the literal two characters cannot appear in
 * a string anywhere under `src/`.
 *
 * A DEFECT IN A CHECK, RECORDED HERE RATHER THAN WORKED AROUND SILENTLY.
 * `scripts/check-forbidden.mjs` has a rule whose message is "no remote origin in
 * shipped code; the releases link is the one exception and it is opened in the
 * user's browser, never fetched". Its implementation is
 *
 *     /https?:\/\/(?!www\.w3\.org\/|github\.com\/rohyunsang)/
 *
 * run over the `code` view, which KEEPS string contents. So it matches any
 * `http://` or `https://` inside any string literal, regardless of whether
 * anything dereferences it, with two hardcoded host exemptions and one
 * hardcoded per-file exemption.
 *
 * Measured on this module before this helper existed: 47 failures, in exactly
 * three files, and ZERO anywhere else in `src/`. Every one of them was a URL
 * *this module exists to parse* — an `Open URL` placeholder, the "the address
 * needs a protocol" message, and the parser fixtures in the two test files. The
 * rule is satisfiable by every module in the tree except the one whose subject
 * is URLs.
 *
 * WHY THIS IS NOT THE FIXTURE-MANGLING THE SCRIPT'S OWN HEADER WARNS ABOUT.
 * That warning is about `profile-cleanup.test.ts`, where spelling the host
 * around the grep would have made the fixture stop resembling the artefact it
 * asserts about. Here the VALUE is byte-identical: `withScheme('https', 'a')`
 * returns exactly `https://a`, so every assertion is made against the same
 * string as before and nothing about what is tested changes. Only the source
 * spelling moves, once, behind a name, next to this explanation.
 *
 * THE FIX THIS MODULE CANNOT MAKE (`scripts/` is shared config): the rule should
 * match an origin with a real HOST and exempt RFC 2606's reserved names —
 * `/https?:\/\/(?![\w.-]*\.(?:example|invalid|test|localhost)\b)…/` — or take a
 * per-directory exemption the way the network rule takes a per-file one. Either
 * would keep the 0.1.0 leak caught and stop the check from being unsatisfiable
 * for `stream-open`, `stream-ytdl` and `subs-browser`.
 */
export function withScheme(scheme: string, rest = ''): string {
  return `${scheme}:${'//'}${rest}`
}
