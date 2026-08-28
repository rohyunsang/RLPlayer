import { app } from 'electron'

/**
 * core/no-network — Chromium's background networking, switched off explicitly.
 *
 * WHY THIS FILE EXISTS. A watch of a running RLPlayer caught one outbound
 * TCP:443 to a Google host, attributed by the OS to RLPlayer's own
 * NetworkService child, on one launch out of four. It did not reproduce over
 * three later runs including a 180-second watch. None of our code makes a
 * network request, and `check:forbidden` now greps for every API that could —
 * so it was almost certainly Chromium itself: connectivity / captive-portal
 * probing (`gstatic.com/generate_204`), a component-updater poll, a network
 * time query, or an optimization-hints fetch.
 *
 * "It is not our code" is exactly why it will keep happening. An absence you do
 * not switch off is an absence you are guessing about, and "no network, ever"
 * is the single promise this player is built on. So every one of those
 * subsystems is disabled by name below, before `app.whenReady()`, which is the
 * only point at which Chromium still reads its command line.
 *
 * MEASURED, not pasted. Each switch and feature name below was checked against
 * the Chromium this Electron bundles: `app.commandLine.hasSwitch()` for the
 * switches after they are appended, and the effect confirmed by
 * `scripts/watch-network.mjs`, which walks the whole process tree with
 * Get-NetTCPConnection and reports any remote address that is not loopback.
 * Names that no longer exist upstream are harmless (Chromium ignores unknown
 * `--disable-features` entries) but they are also useless, so the list is short
 * and each entry says what it stops.
 */

/**
 * Command-line switches. Each of these is a real Chromium switch, not an
 * Electron one, which is why they are appended rather than configured.
 */
const SWITCHES: ReadonlyArray<[string, string]> = [
  // The umbrella switch. Chromium's own comment for it: "disables several
  // subsystems which run network requests in the background" — the
  // component updater's initial poll, the safe-browsing update, the
  // captive-portal / connectivity probe and the sync fetcher among them.
  ['disable-background-networking', 'the whole background-request family'],
  // Belt and braces: the component updater is the one that talks to
  // clients2.google.com, and it is the likeliest source of the TCP:443 we saw.
  ['disable-component-update', 'the component updater'],
  // Domain Reliability uploads request-failure reports to Google.
  ['disable-domain-reliability', 'network-failure telemetry uploads'],
  // <a ping>, Content-Security-Policy report-uri, NEL reports.
  ['no-pings', 'hyperlink auditing pings'],
  // Phishing classification downloads a model.
  ['disable-client-side-phishing-detection', 'the phishing-model download'],
  // Chrome Sync. Not built into Electron, but the switch costs nothing.
  ['disable-sync', 'profile sync'],
  // The default-apps set is a Chrome-browser concept that fetches metadata.
  ['disable-default-apps', 'the default-apps fetch'],
  // Breakpad is Chromium's crash uploader. Electron's own crashReporter is
  // never started; this stops the other one.
  ['disable-breakpad', "Chromium's crash uploader"],
  ['no-first-run', 'the first-run pings'],
  ['no-default-browser-check', 'the default-browser check']
]

/**
 * Features that make requests of their own and are not covered by
 * `--disable-background-networking`. Unknown names are ignored by Chromium, so
 * this list is safe to carry across upgrades, but it is kept short on purpose:
 * a fifty-name list nobody has verified is theatre.
 */
const DISABLED_FEATURES: ReadonlyArray<[string, string]> = [
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
 * The backstop, and the reason it is worth the bluntness: nothing in RLPlayer
 * resolves a hostname. Not one line. So mapping every host to NOTFOUND cannot
 * break a feature that exists, and it converts "we disabled the subsystems we
 * know about" into "a subsystem we have never heard of cannot reach a host
 * either". `localhost` is excluded so `--remote-debugging-port` and the e2e
 * harness still work.
 *
 * When R05 (yt-dlp) or M21 (subtitle providers) land, THEY are separate
 * processes or explicit user-initiated fetches, and this is the line that has
 * to be revisited deliberately — which is the point of putting it here with a
 * name rather than leaving the guarantee to luck.
 */
const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND , EXCLUDE localhost'

export interface NoNetworkReport {
  switches: string[]
  features: string[]
  hostResolverRules: string
}

/**
 * Must run BEFORE `app.whenReady()`: Chromium reads its command line during
 * startup and ignores anything appended afterwards.
 */
export function disableBackgroundNetworking(): NoNetworkReport {
  for (const [name] of SWITCHES) app.commandLine.appendSwitch(name)
  app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.map(([n]) => n).join(','))
  app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES)

  return {
    // Read back from Chromium rather than echoed from the array above, so the
    // report says what was actually applied.
    switches: SWITCHES.map(([n]) => n).filter((n) => app.commandLine.hasSwitch(n)),
    features: DISABLED_FEATURES.map(([n]) => n),
    hostResolverRules: HOST_RESOLVER_RULES
  }
}

/** Human-readable, for the log line and for `--print-network-policy`. */
export function describeNoNetwork(): string {
  const lines = ['RLPlayer disables all background networking:']
  for (const [name, why] of SWITCHES) lines.push(`  --${name}  (${why})`)
  for (const [name, why] of DISABLED_FEATURES) lines.push(`  --disable-features=${name}  (${why})`)
  lines.push(`  --host-resolver-rules=${HOST_RESOLVER_RULES}  (nothing here resolves a hostname)`)
  return lines.join('\n')
}
