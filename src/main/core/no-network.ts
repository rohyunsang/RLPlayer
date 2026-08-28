import { app, session, type Session } from 'electron'
import type { FeatureId, NetworkService } from '@shared/feature-api'

/**
 * core/no-network — the network policy, and the reason "zero network requests"
 * is a measured fact rather than a slogan.
 *
 * WHAT THIS FILE GOT WRONG BEFORE, recorded because the shape of the mistake is
 * more instructive than the fix. The previous revision disabled ten Chromium
 * switches and eleven features by name — the component updater, the
 * captive-portal probe, network time, optimization hints — and then declared the
 * problem solved. Not one of those subsystems appeared in a single netlog.
 * Meanwhile EVERY cold launch of the packaged build fetched
 *
 *     https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic
 *
 * which is Chromium's SPELLCHECK DICTIONARY, downloaded for the locale of the
 * text inputs Wave 0's generated settings form added. It failed `-105` only
 * because of the `MAP * ~NOTFOUND` rule at the bottom of this file; with that
 * one line removed the request completes, and the 302 that comes back carries
 * the user's public IPv6 in `mip=`. An unmasked build leaked the user's IP and
 * locale to Google in under 900 ms.
 *
 * Three lessons are wired into the code below:
 *
 *   1. THE BLACKHOLE IS NOT THE GUARANTEE. It is the seatbelt. The guarantee is
 *      that nothing attempts a request in the first place, and
 *      `scripts/check-network.mjs` asserts on ATTEMPTS (URL_REQUEST_START_JOB in
 *      Chromium's own `--log-net-log`), not on established sockets. A poll of
 *      `Get-NetTCPConnection` can only ever see the requests the seatbelt failed
 *      to stop.
 *   2. GUESSING AT SUBSYSTEM NAMES IS THEATRE. The spellchecker is switched off
 *      at all three layers it has, but only ONE of them actually stops the
 *      download and it is not the obvious one — measured, not assumed. See
 *      `applySessionPolicy` below for the table.
 *   3. A FUTURE MODULE WILL NEED A HOST. R05 (yt-dlp) and M21 (subtitle
 *      providers) are in the manifest already. The old comment said this line
 *      "has to be revisited deliberately", which in practice means the first
 *      module that needs a host deletes it. So the opt-in exists NOW, defaults
 *      to empty, and is printable with `--print-network-policy`.
 */

// ---------------------------------------------------------------------------
// The allowlist. Empty, and it stays empty until a module has a reason.
// ---------------------------------------------------------------------------

export interface AllowedHost {
  /** The module id that owns the need. Never 'core'. */
  readonly module: FeatureId
  /** An exact hostname. No wildcards: a wildcard is how an allowlist rots. */
  readonly host: string
  /** Why the user's traffic may leave the machine for this host. */
  readonly why: string
  /** True when the fetch may only happen after an explicit user action. */
  readonly userInitiatedOnly: boolean
}

/**
 * THE ENTIRE SET OF HOSTS RLPLAYER MAY REACH. It is empty, and adding a row is
 * a deliberate edit to a core file — which means it appears in a diff, it is
 * covered by `check:partition`'s ownership of this file, and `no-network.test.ts`
 * fails if a row lands without a `why`.
 *
 * The alternative — a module calling some `allowHost()` at runtime — was
 * rejected on purpose: it makes the policy a function of load order, and the
 * honest answer to "what can this build reach?" would then require running it.
 */
const ALLOWLIST: readonly AllowedHost[] = []

/** Every host the build may reach, for the log line and for the DNS rule. */
export function allowedHosts(): readonly AllowedHost[] {
  return ALLOWLIST
}

/**
 * The runtime half, handed to modules as `ctx.network`.
 *
 * A module that wants a host it did not declare gets a throw naming this file,
 * rather than a request that quietly succeeds. Reads of `allowed` are free so a
 * module can degrade gracefully (M21's provider search greys itself out) instead
 * of throwing at the user.
 */
export function createNetworkService(moduleId: FeatureId): NetworkService {
  const mine = (host: string): AllowedHost | undefined =>
    ALLOWLIST.find((a) => a.module === moduleId && a.host === host.toLowerCase())
  return {
    allowed(host: string): boolean {
      return mine(host) !== undefined
    },
    assertAllowed(host: string, reason: string): void {
      if (mine(host)) return
      throw new Error(
        `module '${moduleId}' tried to reach '${host}' (${reason}), which is not in the ` +
          `network allowlist. RLPlayer reaches zero hosts by default. Add a row to ` +
          `ALLOWLIST in src/main/core/no-network.ts naming the module, the host and why — ` +
          `that edit is the review conversation, and it is the only way in.`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Command-line switches, appended before app.whenReady().
// ---------------------------------------------------------------------------

const SWITCHES: ReadonlyArray<[string, string]> = [
  // Chromium's own umbrella: the component updater's initial poll, the
  // safe-browsing update, the captive-portal probe, the sync fetcher.
  ['disable-background-networking', 'the whole background-request family'],
  ['disable-component-update', 'the component updater'],
  ['disable-domain-reliability', 'network-failure telemetry uploads'],
  ['no-pings', 'hyperlink auditing pings'],
  ['disable-client-side-phishing-detection', 'the phishing-model download'],
  ['disable-sync', 'profile sync'],
  ['disable-default-apps', 'the default-apps fetch'],
  ['disable-breakpad', "Chromium's crash uploader"],
  ['no-first-run', 'the first-run pings'],
  ['no-default-browser-check', 'the default-browser check'],
  // MEASURED: both HEAD and the released 0.1.0 emitted two
  // HOST_RESOLVER_MANAGER_REQUESTs for `wpad`, Chromium's proxy
  // auto-discovery. It is a local-network DNS query rather than a third-party
  // connection, but "zero network requests" has to mean zero. The switch and
  // the per-session `setProxy({ mode: 'direct' })` in applySessionPolicy() are
  // belt and braces: the switch covers the browser process's own resolver, the
  // session call covers a session created later.
  ['no-proxy-server', "WPAD proxy auto-discovery and every proxy resolution"],
  // MEASURED INSUFFICIENT ON ITS OWN — kept anyway, and labelled, because a
  // switch that looks like it should work is worse than no switch at all if
  // nobody writes down that it does not. With ONLY this switch set (window flag
  // and session call both disabled, DNS blackhole off) the packaged build still
  // completed the full gvt1.com dictionary download. The session call in
  // applySessionPolicy() is what actually stops it.
  ['disable-spell-checking', "part of the spellchecker; NOT sufficient alone (see below)"]
]

const DISABLED_FEATURES: ReadonlyArray<[string, string]> = [
  // Kept from the previous revision, and worth being honest about: NONE of
  // these ever appeared in a netlog, before or after the fix. They are cheap
  // and Chromium ignores unknown names, so they stay as insurance — but the
  // leak that actually existed was not in this list, and a long list of
  // plausible names is exactly what made it easy to believe the job was done.
  ['NetworkTimeServiceQuerying', 'the network-time query to Google'],
  ['OptimizationHints', 'the optimization-hints fetch'],
  ['OptimizationHintsFetching', 'the optimization-hints fetch'],
  ['OptimizationTargetPrediction', 'the optimization-model download'],
  ['OptimizationGuideModelDownloading', 'the optimization-model download'],
  ['MediaRouter', 'Cast/mDNS device discovery on the local network'],
  ['DialMediaRouteProvider', 'DIAL device discovery on the local network'],
  ['AutofillServerCommunication', 'the autofill server round-trip'],
  ['CertificateTransparencyComponentUpdater', 'the CT log-list download'],
  ['SegmentationPlatform', 'the segmentation-model download'],
  ['Translate', "the translate service's language-list fetch"]
]

/**
 * The DNS backstop — DEMOTED, deliberately.
 *
 * It used to be the thing that made the no-network claim true, which is why
 * removing one line turned a clean build into an IP leak. It is now the last of
 * four layers (no request is made; the session blocks it; the proxy is direct;
 * and only then this), and it is built FROM the allowlist rather than being a
 * flat rule someone has to remember to widen.
 *
 * RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE exists for exactly one caller:
 * `scripts/check-network.mjs --no-blackhole`, which proves the leak is gone
 * rather than merely blackholed. It is read from the environment, never from a
 * setting, and it is named so that finding it in a support log is alarming.
 */
export function hostResolverRules(): string {
  const excluded = ['localhost', ...ALLOWLIST.map((a) => a.host)]
  return ['MAP * ~NOTFOUND', ...excluded.map((h) => `EXCLUDE ${h}`)].join(' , ')
}

function blackholeDisabled(): boolean {
  return process.env['RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE'] === '1'
}

export interface NoNetworkReport {
  switches: string[]
  features: string[]
  hostResolverRules: string
  allowedHosts: readonly AllowedHost[]
}

/**
 * Must run BEFORE `app.whenReady()`: Chromium reads its command line during
 * startup and ignores anything appended afterwards.
 */
export function disableBackgroundNetworking(): NoNetworkReport {
  for (const [name] of SWITCHES) app.commandLine.appendSwitch(name)
  app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.map(([n]) => n).join(','))
  const rules = blackholeDisabled() ? '' : hostResolverRules()
  if (rules) app.commandLine.appendSwitch('host-resolver-rules', rules)

  return {
    // Read back from Chromium rather than echoed from the array above, so the
    // report says what was actually applied.
    switches: SWITCHES.map(([n]) => n).filter((n) => app.commandLine.hasSwitch(n)),
    features: DISABLED_FEATURES.map(([n]) => n),
    hostResolverRules: rules || '(DISABLED by RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE)',
    allowedHosts: ALLOWLIST
  }
}

/**
 * The per-session half. Runs after `app.whenReady()`, on the default session
 * and on any session a window is later given.
 *
 * WHICH LAYER IS LOAD-BEARING. Measured on the PACKAGED build with the DNS
 * blackhole switched off, so the netlog records what really happens, one layer
 * enabled at a time:
 *
 *   only `webPreferences.spellcheck: false` on every window  → LEAK. 4 events,
 *                                                              download completed
 *   only `session.setSpellCheckerEnabled(false)` + languages → CLEAN. 0 events
 *   only `--disable-spell-checking`                          → LEAK. 4 events,
 *                                                              download completed
 *   control, all three off                                   → LEAK. 4 events
 *
 * So the SESSION call is the only one that works, and the two obvious answers —
 * the per-window flag everyone reaches for first, and the command-line switch
 * that is named after the feature — both fail. The per-window flag stops the
 * red squiggles; it does not stop the fetch, because the dictionary is a
 * per-PROFILE resource that Chromium acquires for the session's spellcheck
 * languages regardless of which window asked.
 *
 * All three stay applied. The two that do not work cost nothing and are now
 * labelled with what they do not do, which is the part that was missing: the
 * previous revision had neither, and a reviewer reading `spellcheck: false` in
 * `windows.ts` would reasonably have concluded the hole was closed.
 *
 * The measured leak, for the record: the 302 from redirector.gvt1.com carries
 * the client's public IPv6 back in `mip=`, so an unmasked build told Google the
 * user's IP address and UI locale within ~900 ms of launch.
 */
export function applySessionPolicy(target: Session = session.defaultSession): void {
  // The dictionary download, at the session layer.
  target.setSpellCheckerEnabled(false)
  try {
    // Belt and braces: an empty language list means there is nothing to fetch a
    // dictionary FOR, on a build where the setter above is ignored.
    target.setSpellCheckerLanguages([])
  } catch {
    /* not available on every platform; the setter above is the real one */
  }

  // WPAD. `mode: 'direct'` is what stops the `wpad` host resolution; the
  // command-line switch covers the browser process, this covers the session.
  void target.setProxy({ mode: 'direct' })

  /**
   * The enforcement layer the DNS rule used to stand in for.
   *
   * Everything RLPlayer legitimately loads is local: `file:` for the packaged
   * renderer, `devtools:`/`blob:`/`data:` for the shell. Anything else is
   * cancelled here, BEFORE DNS, and logged loudly — so a future Chromium
   * subsystem nobody has heard of is blocked by policy rather than by luck, and
   * so the block is visible instead of looking like a network failure.
   */
  target.webRequest.onBeforeRequest((details, callback) => {
    if (isLocalRequest(details.url)) return callback({ cancel: false })
    const host = hostOf(details.url)
    if (ALLOWLIST.some((a) => a.host === host)) return callback({ cancel: false })
    console.error(
      `[no-network] BLOCKED ${details.method ?? 'GET'} ${details.url} — RLPlayer reaches no ` +
        `host that is not in the allowlist in src/main/core/no-network.ts (currently ` +
        `${ALLOWLIST.length} entries). If you are seeing this, something in the shell tried ` +
        `to talk to the internet and the product promise says it must not.`
    )
    callback({ cancel: true })
  })
}

const LOCAL_SCHEME = /^(file|data|blob|devtools|chrome|chrome-extension|about):/i

function isLocalRequest(url: string): boolean {
  if (LOCAL_SCHEME.test(url)) return true
  const host = hostOf(url)
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Human-readable, for the log line and for `--print-network-policy`. */
export function describeNoNetwork(): string {
  const lines = ['RLPlayer makes no network request. What enforces that:', '', '  switches:']
  for (const [name, why] of SWITCHES) lines.push(`    --${name}  (${why})`)
  lines.push('', '  disabled features:')
  for (const [name, why] of DISABLED_FEATURES) lines.push(`    ${name}  (${why})`)
  lines.push('', '  per session (after app ready):')
  lines.push('    setSpellCheckerEnabled(false)   (the gvt1.com dictionary download)')
  lines.push('    setProxy({ mode: "direct" })    (WPAD auto-discovery)')
  lines.push('    webRequest.onBeforeRequest      (cancels every non-local URL)')
  lines.push('', '  DNS backstop (defence-in-depth, NOT the guarantee):')
  lines.push(`    --host-resolver-rules=${blackholeDisabled() ? '(disabled)' : hostResolverRules()}`)
  lines.push('', `  host allowlist: ${ALLOWLIST.length} entr${ALLOWLIST.length === 1 ? 'y' : 'ies'}`)
  for (const a of ALLOWLIST) {
    lines.push(
      `    ${a.host}  (${a.module}${a.userInitiatedOnly ? ', user-initiated only' : ''}) — ${a.why}`
    )
  }
  if (ALLOWLIST.length === 0) {
    lines.push('    (empty — RLPlayer may reach no host at all, which is the shipped state)')
  }
  return lines.join('\n')
}
