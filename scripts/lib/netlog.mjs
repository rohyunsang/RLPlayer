/**
 * What counts as a network violation, and what counts as a session that
 * happened — separated from `check-network.mjs` so both can be tested without
 * launching an app.
 *
 * The reason they are here at all is that the interesting failure of this check
 * has never been a missed request. It has been ACCEPTING EVIDENCE THAT PROVED
 * NOTHING: a header-only netlog read as a perfectly clean run; a `[no-network]`
 * line printed at module scope read as "the app came up"; and, until this file
 * existed, `[e2e] settings window opened` read as "the settings page was
 * exercised" when `ipc.ts` prints it before `loadFile()` has resolved. That last
 * one was measured: the packaged app with and without RLPLAYER_E2E_OPEN_SETTINGS
 * produced 11 netlog events and 53,435 bytes in BOTH cases, delta 0. The console
 * line was the only evidence, and it was printed before the page existed.
 *
 * `scripts/lib/netlog.test.mjs` runs `sessionProof()` against the exact stdout
 * of both shapes.
 */

/**
 * WHAT A REAL SESSION LEAVES IN THE NETLOG, measured rather than assumed.
 *
 * A clean launch of the packaged build -- overlay up, sample playing, settings
 * window opened, graceful quit -- writes exactly 11 events, and the same seven
 * types every time. It is a small number because everything this app loads is
 * `file:` and never touches the network stack; that is the product working. The
 * header-only files this check used to PASS had zero.
 *
 * So the floor is 8: below every observed real run, far above every observed
 * dead one, and deliberately not tuned close to 11. Its job is to separate "a
 * session happened" from "the file has a header", not to police how many events
 * a session ought to have.
 */
export const MIN_NETLOG_EVENTS = 8

/**
 * Two event types that BRACKET a real session, which is stronger than a count.
 *
 *   PROXY_CONFIG_CHANGED  -- `applySessionPolicy()` sets `{ mode: 'direct' }`,
 *     and that runs as the first statement after `app.whenReady()`. Its presence
 *     means the app got past startup, not merely that a process existed.
 *   QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS -- Chromium tears the network stack
 *     down on a clean shutdown. A force-killed process never writes it.
 *
 * Both were present on every observed clean launch and on neither header-only
 * file. Requiring the pair means the netlog itself testifies that the session
 * started and ended, rather than the harness inferring it from a count.
 */
export const REQUIRED_NETLOG_EVENTS = ['PROXY_CONFIG_CHANGED', 'QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS']

/**
 * The floor for the generated settings form.
 *
 * `settings.html` is deliberately empty -- every control on it comes from a
 * `ctx.settings.define()` descriptor -- so a page that loaded but wired nothing
 * renders zero rows and throws nothing at all. Eight is the same floor
 * `e2e-overlay.mjs` uses, and the shipped build renders more.
 */
export const MIN_SETTINGS_ROWS = 8

/**
 * Local schemes. Everything else is a violation — including a request that
 * fails, and including a hostname that is only ever resolved.
 *
 * `ws:` USED TO BE ON THIS LIST, unqualified, so `ws://remote.example/` was not
 * counted as a request at all. A WebSocket to another host is exactly as much a
 * network request as an `https:` one, and the only local WebSocket this repo
 * ever opens is `e2e-overlay.mjs` talking to 127.0.0.1 on the CDP port. So the
 * scheme is not enough on its own: `ws:` and `wss:` are judged by their host,
 * like every other remote scheme.
 *
 * `wpad` is NOT local either. It is a local-network DNS query rather than a
 * third-party connection, but "zero network requests" has to mean zero, and
 * Chromium's proxy auto-discovery is switched off explicitly in
 * core/no-network.ts precisely so this list can stay this short.
 */
export const LOCAL_SCHEME = /^(file|data|blob|devtools|chrome|chrome-extension|about):/i
const HOST_SCHEME = /^(ws|wss|http|https):\/\//i
export const LOCAL_HOST = new Set(['localhost', '127.0.0.1', '::1', ''])

/** `example.com:443`, `[::1]:80`, `::1` -> the bare host, lowercased. */
export function bareHost(host) {
  return host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
}

export function isLocalHost(host) {
  return LOCAL_HOST.has(bareHost(host))
}

/**
 * Is this URL local? Scheme first, then -- for the schemes that carry one -- the
 * host, so `ws://127.0.0.1:9333/devtools/page/x` is local and
 * `ws://remote.example/` is not.
 */
export function isLocalUrl(url) {
  if (LOCAL_SCHEME.test(url)) return true
  if (!HOST_SCHEME.test(url)) return false
  const rest = url.slice(url.indexOf('://') + 3)
  const authority = rest.split(/[/?#]/)[0] ?? ''
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  return isLocalHost(host)
}

/**
 * Every distinct request, resolution and connection in a parsed netlog that is
 * not local. `types` maps Chromium's numeric event ids to names.
 */
export function violationsIn(events, types) {
  const out = []
  const seen = new Set()
  const add = (kind, detail) => {
    const key = `${kind} ${detail}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, detail })
  }

  for (const e of events) {
    const type = types[e.type]
    const p = e.params
    if (!type || !p) continue

    if (typeof p.url === 'string' && /URL_REQUEST|SOCKET_POOL_CONNECT_JOB/.test(type)) {
      if (!isLocalUrl(p.url)) add('request', `${type}  ${p.url}`)
    }
    if (typeof p.host === 'string' && /HOST_RESOLVER/.test(type)) {
      if (!isLocalHost(p.host)) add('resolve', `${type}  ${p.host}`)
    }
    if (typeof p.address === 'string' && /TCP_CONNECT|SOCKET_ALIVE/.test(type)) {
      const bare = p.address.replace(/^\[?([^\]]*)\]?:\d+$/, '$1').toLowerCase()
      if (!LOCAL_HOST.has(bare)) add('connect', `${type}  ${p.address}`)
    }
  }
  const seenTypes = new Set(events.map((e) => types[e.type]).filter(Boolean))
  return { out, eventCount: events.length, seenTypes }
}

/**
 * The evidence gate: everything this check measures is an ABSENCE, and absence
 * is also what a launch that never ran produces. Returns the reasons this run
 * was not a real session; an empty array means it was.
 */
export function sessionProof({ stdout, eventCount, seenTypes }) {
  const proof = []

  if (eventCount < MIN_NETLOG_EVENTS) {
    proof.push(
      `the netlog holds ${eventCount} events (floor ${MIN_NETLOG_EVENTS}). A header-only file ` +
        `is indistinguishable from a perfectly clean session unless the floor is checked, and ` +
        `7 of 36 observed netlogs were header-only.`
    )
  }
  for (const required of REQUIRED_NETLOG_EVENTS) {
    if (!seenTypes.has(required)) {
      proof.push(
        `the netlog has no ${required}. That event is written by every clean session of this ` +
          `app and by no dead one, so its absence means the run did not happen the way a ` +
          `user's does -- and a run that did not happen records no violations either.`
      )
    }
  }
  if (!/\[ready\]/.test(stdout)) {
    proof.push(
      `the app never printed [ready], so its windows were never shown. The [no-network] line ` +
        `is printed at module scope, BEFORE app.whenReady(), and proves only that the ` +
        `process started.`
    )
  }

  // THE SETTINGS PAGE, asserted on what it RENDERED.
  //
  // The old gate was `/\[e2e\] settings window opened/`, and index.ts printed
  // that synchronously after `openSettingsWindow()` -- which does
  // `void settingsWindow.loadFile(...)` and returns before the page loads. So
  // the marker was printed before the surface existed, and no netlog event
  // corroborated it: with and without RLPLAYER_E2E_OPEN_SETTINGS the packaged
  // app produced 11 events and 53,435 bytes, delta 0.
  const rendered = /\[e2e\] settings page rendered rows=(\d+) sections=(\d+) textFields=(\d+) focused=(\S+)/.exec(
    stdout
  )
  if (!rendered) {
    const stale = /\[e2e\] settings window opened/.test(stdout)
    const failed = /\[e2e\] settings page FAILED: (.*)/.exec(stdout)
    proof.push(
      `the settings page never reported what it rendered, so the one page in this app with ` +
        `text inputs -- the surface the gvt1.com spellchecker leak was on -- was not ` +
        `exercised.` +
        (failed ? ` The app said: ${failed[1]}` : '') +
        (stale
          ? ` It printed the OLD marker instead, which ipc.ts emits before loadFile() has ` +
            `resolved and which therefore proves only that a BrowserWindow was constructed.`
          : '')
    )
  } else {
    const rows = Number(rendered[1])
    const textFields = Number(rendered[3])
    const focused = rendered[4]
    if (rows < MIN_SETTINGS_ROWS) {
      proof.push(
        `the settings page rendered ${rows} rows (floor ${MIN_SETTINGS_ROWS}). settings.html is ` +
          `empty by design and every control comes from a ctx.settings.define() descriptor, so ` +
          `a page that loaded and wired nothing renders zero rows and throws nothing. That is ` +
          `where all 38 Wave-1 modules land their descriptors.`
      )
    }
    if (textFields < 1) {
      proof.push(
        `the settings page has no text field at all, so focusing one -- the action a ` +
          `spellcheck-on-focus regression would need -- did not happen. The gvt1.com download ` +
          `was Chromium fetching a dictionary for the locale of this page's text inputs.`
      )
    } else if (focused !== 'input' && focused !== 'textarea') {
      proof.push(
        `the settings page reported ${textFields} text field(s) but focus landed on ` +
          `'${focused}', so the input was dispatched at nothing.`
      )
    }
  }

  if (!/\[quit\] clean exit/.test(stdout)) {
    proof.push(
      `the app never printed [quit], so the shutdown hooks did not run to completion. A ` +
        `force-killed app writes no events either, which is why "0 events" alone is not a pass.`
    )
  }
  return proof
}
