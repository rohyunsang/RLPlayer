import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_SCHEMES,
  DENIED_SCHEMES,
  authorityOf,
  classifyUrl,
  isHistoryWorthy,
  pathOf,
  schemeOf,
  type UrlSource
} from './url-policy.ts'

/**
 * M35's R02 policy, exercised directly.
 *
 * Every case below is either a line the spec says was MEASURED, or a shape that
 * a reasonable implementation gets wrong. Several tests assert that the OBVIOUS
 * implementation is wrong before asserting ours is right, because a policy test
 * that only checks the happy path is the shape of check this project keeps
 * finding lied.
 */

const SOURCES: readonly UrlSource[] = [
  'user',
  'clipboard',
  'cli',
  'drag-drop',
  'protocol-handler',
  'playlist-entry'
]

// ---------------------------------------------------------------------------
// The allow / deny columns
// ---------------------------------------------------------------------------

test('every ALLOW scheme in the R02 table is accepted', () => {
  for (const s of ALLOWED_SCHEMES) {
    const v = classifyUrl(`${s}://example.com/a`, 'user')
    assert.equal(v.ok, true, `${s} was refused`)
    if (v.ok) assert.equal(v.scheme, s)
  }
})

test('every DENY scheme is refused from EVERY source, user included', () => {
  for (const s of Object.keys(DENIED_SCHEMES)) {
    for (const src of SOURCES) {
      const v = classifyUrl(`${s}://whatever`, src)
      assert.equal(v.ok, false, `${s} from ${src} was allowed`)
    }
  }
})

test('the deny list is not a subset of the allow list, in either direction', () => {
  // A scheme in both tables would be decided by evaluation order, which is
  // exactly how an allowlist rots. Assert the two are disjoint.
  for (const s of Object.keys(DENIED_SCHEMES)) {
    assert.equal(ALLOWED_SCHEMES.includes(s), false, `${s} is in both tables`)
  }
})

test('an unknown scheme is refused rather than passed through', () => {
  const v = classifyUrl('gopher://example.com/1', 'user')
  assert.equal(v.ok, false)
  if (!v.ok) {
    assert.equal(v.reason, 'unknown-scheme')
    assert.equal(v.scheme, 'gopher')
  }
})

test('scheme matching is case-insensitive but the URL is not rewritten', () => {
  const v = classifyUrl('HTTPS://Example.COM/A%20B?q=1', 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.scheme, 'https')
    assert.equal(v.host, 'example.com')
    // The mpv-bound string is the user's, byte for byte.
    assert.equal(v.url, 'HTTPS://Example.COM/A%20B?q=1')
  }
})

// ---------------------------------------------------------------------------
// R15: the `udp://@239...` case, and why `new URL()` is not used
// ---------------------------------------------------------------------------

test('R15: a leading @ in udp:// is the multicast marker, NOT userinfo', () => {
  const raw = 'udp://@239.1.1.1:5000?fifo_size=1000000&overrun_nonfatal=1'

  /**
   * FIRST, the mangling this parser exists to avoid — and it is NOT where I
   * assumed it was, which is why it is asserted here rather than described in a
   * comment. `hostname` is correct; the ROUND TRIP silently deletes the `@`:
   *
   *   hostname -> '239.1.1.1'                                        correct
   *   href     -> 'udp://239.1.1.1:5000?fifo_size=1000000&...'       '@' GONE
   *
   * In ffmpeg's syntax `@` means "listen on any interface for this group", so a
   * normaliser that hands mpv `u.href` turns a multicast subscription into a
   * unicast connect that never receives a packet. Measured on Node 24.14.0. If
   * this assertion ever fails, WHATWG changed and the note above is stale — but
   * the rule (never give mpv a parser's output) does not depend on it.
   */
  assert.equal(new URL(raw).hostname, '239.1.1.1')
  assert.notEqual(new URL(raw).href, raw, 'the URL round trip stopped mangling; re-measure')
  assert.equal(new URL(raw).href.includes('@'), false, 'href kept the @; re-measure')

  const v = classifyUrl(raw, 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.host, '239.1.1.1')
    assert.equal(v.multicast, true)
    // R15's actual requirement: do not mangle the query string.
    assert.equal(v.url, raw)
  }
})

test('R15: real userinfo is still stripped, and splits on the LAST @', () => {
  const raw = 'http://user:p@ss@media.example.com:8080/live'

  // The second measured mangling, and it matters for R33's saved FTP/WebDAV
  // credentials: the round trip percent-encodes the password, so the string mpv
  // would receive carries a DIFFERENT secret than the one the user typed.
  assert.equal(new URL(raw).href, 'http://user:p%40ss@media.example.com:8080/live')

  const v = classifyUrl(raw, 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.host, 'media.example.com')
    assert.equal(v.multicast, false)
    assert.equal(v.url, raw, 'the mpv-bound string must be the user text, byte for byte')
  }
})

test('a leading @ is userinfo, not multicast, for a scheme that has userinfo', () => {
  // http has no multicast syntax, so `@host` there is an empty userinfo.
  const v = classifyUrl('http://@example.com/x', 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.host, 'example.com')
    assert.equal(v.multicast, false)
  }
})

test('srt query parameters survive intact', () => {
  const raw = 'srt://host.example:9000?mode=caller&latency=200000'
  const v = classifyUrl(raw, 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.url, raw)
    assert.equal(v.host, 'host.example')
  }
})

test('an IPv6 literal keeps its colons and loses its port', () => {
  const v = classifyUrl('http://[2001:db8::1]:8080/live.m3u8', 'user')
  assert.equal(v.ok, true)
  if (v.ok) assert.equal(v.host, '2001:db8::1')
})

test('authorityOf returns no host for a scheme with no authority', () => {
  assert.deepEqual(authorityOf('data://text/plain,hello', 'data'), {
    host: 'text',
    multicast: false
  })
  // `data:` written without the slashes has no authority at all.
  assert.deepEqual(authorityOf('data:text/plain,hello', 'data'), { host: '', multicast: false })
})

// ---------------------------------------------------------------------------
// Windows paths must never look like a scheme
// ---------------------------------------------------------------------------

test('a Windows drive letter is a local path, not the scheme `c`', () => {
  // The check that would have lied: a naive scheme regex answers 'c'.
  assert.equal(schemeOf('C:\\Videos\\ep01.mkv'), 'c')

  for (const p of ['C:\\Videos\\ep01.mkv', 'c:/videos/ep01.mkv', 'D:\\a b\\x.mp4']) {
    const v = classifyUrl(p, 'drag-drop')
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.reason, 'local-path')
  }
})

test('a UNC path is a local path', () => {
  const v = classifyUrl('\\\\nas\\media\\ep01.mkv', 'drag-drop')
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.reason, 'local-path')
})

test('file:// gets the local-path reason, not a scary denial', () => {
  const v = classifyUrl('file:///C:/Videos/ep01.mkv', 'cli')
  assert.equal(v.ok, false)
  if (!v.ok) {
    assert.equal(v.reason, 'local-path')
    assert.equal(v.category, 'local-path')
  }
})

test('a bare host is refused rather than silently prefixed with http://', () => {
  for (const s of ['example.com/live', 'www.example.com', 'ep01.mkv']) {
    const v = classifyUrl(s, 'protocol-handler')
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.reason, 'no-scheme')
  }
})

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

test('a two-line paste is refused rather than half-opened', () => {
  const v = classifyUrl('https://a.example/1\nhttps://b.example/2', 'clipboard')
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.reason, 'multiline')
})

test('a control character is refused', () => {
  const v = classifyUrl('https://a.example/\u0007x', 'clipboard')
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.reason, 'control-character')
})

test('a tab inside the URL is a control character, not whitespace to trim', () => {
  // trim() removes leading/trailing tabs; an interior one must still fail.
  const v = classifyUrl('https://a.example/\tx', 'clipboard')
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.reason, 'control-character')
})

test('empty and whitespace-only input is refused', () => {
  for (const s of ['', '   ', '\t\t']) {
    const v = classifyUrl(s, 'user')
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.reason, 'empty')
  }
})

test('a denied scheme smuggled through the protocol handler is refused', () => {
  // R35: "Strip the scheme and feed the remainder through the same allowlist as
  // R02." This is that call, and it is the one that matters most.
  for (const bad of ['edl://', 'av://dshow:video=x', 'mpv://', 'env://PATH']) {
    const v = classifyUrl(bad, 'protocol-handler')
    assert.equal(v.ok, false, `${bad} was allowed`)
  }
})

// ---------------------------------------------------------------------------
// R04 / R12 / R13: classification without branching on the extension
// ---------------------------------------------------------------------------

test('R04: .m3u8 is a playlist CANDIDATE and an HLS manifest at once', () => {
  const v = classifyUrl('https://cdn.example/master.m3u8?token=abc', 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    // Both, deliberately: the spec forbids branching on the extension, so the
    // classification carries the ambiguity forward instead of resolving it.
    assert.equal(v.manifest, 'hls')
    assert.equal(v.playlistCandidate, true)
  }
})

test('the query string does not decide the extension', () => {
  // The check that would have lied: `endsWith('.m3u8')` on the whole URL is
  // false here, and `includes('.m3u8')` is true for `?next=x.m3u8`.
  const withQuery = classifyUrl('https://cdn.example/master.m3u8?a=1', 'user')
  assert.equal(withQuery.ok && withQuery.manifest, 'hls')

  const inQuery = classifyUrl('https://cdn.example/video.mp4?next=x.m3u8', 'user')
  assert.equal(inQuery.ok && inQuery.manifest, null)
  assert.equal(inQuery.ok && inQuery.playlistCandidate, false)
})

test('R13: .mpd is DASH and is not a playlist candidate', () => {
  const v = classifyUrl('https://cdn.example/manifest.mpd', 'user')
  assert.equal(v.ok, true)
  if (v.ok) {
    assert.equal(v.manifest, 'dash')
    assert.equal(v.playlistCandidate, false)
  }
})

test('.m3u/.pls/.asx are playlist candidates with no manifest family', () => {
  for (const ext of ['m3u', 'pls', 'asx', 'wpl', 'xspf']) {
    const v = classifyUrl(`https://cdn.example/list.${ext}`, 'user')
    assert.equal(v.ok, true)
    if (v.ok) {
      assert.equal(v.playlistCandidate, true, ext)
      assert.equal(v.manifest, null, ext)
    }
  }
})

test('pathOf drops the fragment as well as the query', () => {
  assert.equal(pathOf('https://a.example/x/y.m3u8?q=1#z', 'https'), '/x/y.m3u8')
  assert.equal(pathOf('https://a.example', 'https'), '')
})

// ---------------------------------------------------------------------------
// R03
// ---------------------------------------------------------------------------

test('R03: only user-entered sources are history-worthy', () => {
  assert.equal(isHistoryWorthy('user'), true)
  assert.equal(isHistoryWorthy('clipboard'), true)
  // The whole point of PotPlayer's toggle: an HLS master playlist would
  // otherwise flood the list with one segment URL every few seconds.
  assert.equal(isHistoryWorthy('playlist-entry'), false)
  assert.equal(isHistoryWorthy('cli'), false)
  assert.equal(isHistoryWorthy('drag-drop'), false)
  assert.equal(isHistoryWorthy('protocol-handler'), false)
})
