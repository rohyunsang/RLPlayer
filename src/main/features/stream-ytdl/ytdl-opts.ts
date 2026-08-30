/**
 * M36 R05 / R08 / R09 / R10 / R13 — every string this module hands mpv.
 *
 * ===========================================================================
 * THE ZERO-NETWORK-AT-REST DESIGN, which is R05's and is the reason this file
 * exists as pure functions with a test rather than as inline strings.
 * ===========================================================================
 *
 * R05 measured three things that together rule out the obvious design:
 *
 *   1. `--ytdl=no` prevents `ytdl_hook.lua` from loading AT ALL.
 *   2. `--load-scripts=no` does NOT disable it.
 *   3. Setting the `ytdl` PROPERTY at runtime therefore cannot retroactively
 *      load the script.
 *
 * So a "use yt-dlp" checkbox wired to the `ytdl` property either needs a restart
 * or does nothing. R05's recommendation, followed here verbatim:
 *
 *   always launch with `--ytdl=yes --script-opts-append=ytdl_hook-exclude=.*`
 *   (which makes zero network calls) and clear it at runtime with
 *   `{"command":["change-list","script-opts","append","ytdl_hook-exclude="]}`
 *
 * `exclude=.*` is a URL pattern ytdl_hook matches BEFORE it spawns anything, so
 * with it set the hook is loaded and inert: no yt-dlp process, no request, no DNS
 * lookup. That is the at-rest state, it is the DEFAULT, and the only thing that
 * changes it is a setting the user turns on.
 *
 * The alternative — launch with `--ytdl=no` and respawn mpv when the user enables
 * it — was rejected because it makes an ordinary settings toggle interrupt
 * playback, and `requestRestart` is documented for things a property write cannot
 * achieve rather than as a way around a hook's load order.
 */

/** The `ytdl_hook` script-opts keys this module sets, and nothing else. */
export type HookOption =
  | 'ytdl_path'
  | 'exclude'
  | 'all_formats'
  | 'force_all_formats'
  | 'use_manifests'
  | 'try_ytdl_first'

/**
 * The pattern that makes the hook inert. `.*` matches every URL, so ytdl_hook
 * returns before it builds a command line.
 */
export const EXCLUDE_ALL = '.*'

export function hookOpt(key: HookOption, value: string): string {
  return `ytdl_hook-${key}=${value}`
}

export interface HookConfig {
  /** The user's "use yt-dlp for site URLs" toggle. Default FALSE. */
  readonly enabled: boolean
  /** An absolute path, already validated by `ytdlPathOption`, or ''. */
  readonly ytdlPath: string
  /** R08: expose every yt-dlp format as an mpv track. */
  readonly allFormats: boolean
  /** R13: off upstream for a reason; an advanced toggle here. */
  readonly useManifests: boolean
}

/**
 * The `--script-opts-append=` arguments for a spawn.
 *
 * Separate appends rather than one `--script-opts=` on purpose: `script-opts` is
 * a single shared list that M29's stats and select overlays also write, and
 * `--script-opts=` would REPLACE it. `script-opts-append` is on core's additive
 * allowlist (`ADDITIVE_OPTIONS`) precisely so two modules can both contribute.
 */
export function hookArgs(cfg: HookConfig): string[] {
  const args: string[] = []

  // The exclude pattern comes FIRST, so that even if a later append were
  // dropped the fail-safe state is "inert" rather than "live".
  if (!cfg.enabled) args.push(`--script-opts-append=${hookOpt('exclude', EXCLUDE_ALL)}`)

  if (cfg.ytdlPath.length > 0) {
    args.push(`--script-opts-append=${hookOpt('ytdl_path', cfg.ytdlPath)}`)
  }
  // R08: "Verified defaults in this build: all_formats = true,
  // force_all_formats = true … Be explicit anyway." Being explicit is the point:
  // a future yt-dlp or ytdl_hook flipping the default would silently turn the
  // quality menu into a single entry.
  args.push(`--script-opts-append=${hookOpt('all_formats', cfg.allFormats ? 'yes' : 'no')}`)
  args.push(
    `--script-opts-append=${hookOpt('force_all_formats', cfg.allFormats ? 'yes' : 'no')}`
  )
  if (cfg.useManifests) {
    args.push(`--script-opts-append=${hookOpt('use_manifests', 'yes')}`)
  }
  return args
}

/**
 * The runtime toggle, as the exact command array R05 specifies.
 *
 * `script-opts` is a key=value list and a later append overrides an earlier
 * entry with the same key, which is what makes this work without a respawn.
 */
export function toggleCommand(enabled: boolean): unknown[] {
  return [
    'change-list',
    'script-opts',
    'append',
    hookOpt('exclude', enabled ? '' : EXCLUDE_ALL)
  ]
}

/** `--ytdl=yes`, always, for the load-order reason in the file header. */
export function ytdlArg(): string {
  return '--ytdl=yes'
}

// ---------------------------------------------------------------------------
// R09 — the explicit --ytdl-format override
// ---------------------------------------------------------------------------

/**
 * R09's presets, verbatim, plus the empty default.
 *
 * "An empty value or `ytdl` does not pass a `--format` option at all", so '' is
 * the do-nothing choice and is the default: R09 is explicitly redundant with
 * R08's track menu and the row says to ship the menu first.
 */
export const FORMAT_PRESETS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: '', labelKey: 'stream-ytdl.format.auto' },
  {
    value: 'bestvideo[height<=?1080][vcodec^=avc1]+bestaudio/best',
    labelKey: 'stream-ytdl.format.h264_1080'
  },
  { value: 'bestvideo[height<=?1080]+bestaudio/best', labelKey: 'stream-ytdl.format.p1080' },
  { value: 'bestvideo[height<=?720]+bestaudio/best', labelKey: 'stream-ytdl.format.p720' },
  { value: 'bestaudio/best', labelKey: 'stream-ytdl.format.audioOnly' }
]

// ---------------------------------------------------------------------------
// R10 — arbitrary yt-dlp options
// ---------------------------------------------------------------------------

export type RawOptionError = 'leading-dashes' | 'no-key' | 'space-in-key' | 'flag-needs-equals'

export interface RawOptionResult {
  readonly entries: readonly string[]
  readonly errors: ReadonlyArray<{ line: string; error: RawOptionError }>
}

/**
 * R10's two rules, which are the whole feature: "key without leading dashes;
 * flag-style options need a trailing `=`".
 *
 * Both failures are silent in mpv — the manual says outright "There is no sanity
 * checking so it's possible to break things" — so a user who types
 * `--force-ipv6` or `force-ipv6` gets nothing and no explanation. Validating
 * here is the only place it can be caught before it becomes a bug report about
 * a site not working.
 */
export function parseRawOptions(lines: readonly string[]): RawOptionResult {
  const entries: string[] = []
  const errors: Array<{ line: string; error: RawOptionError }> = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('-')) {
      errors.push({ line, error: 'leading-dashes' })
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      // A bare word is a flag-style option and needs the trailing '='. This is
      // the one that costs a support round trip, so it gets its own message.
      errors.push({ line, error: 'flag-needs-equals' })
      continue
    }
    const key = line.slice(0, eq)
    if (key.length === 0) {
      errors.push({ line, error: 'no-key' })
      continue
    }
    if (/\s/.test(key)) {
      errors.push({ line, error: 'space-in-key' })
      continue
    }
    entries.push(line)
  }
  return { entries, errors }
}

/**
 * The privacy row, called out because R10 does: `cookies-from-browser` "reads
 * the user's browser cookie DB — a meaningful privacy action for a
 * zero-telemetry app. Make it opt-in per source with a one-line explanation,
 * never a global default."
 */
export const PRIVACY_SENSITIVE_KEYS: readonly string[] = [
  'cookies-from-browser',
  'cookies',
  'username',
  'password',
  'netrc',
  'netrc-cmd',
  'video-password',
  'ap-username',
  'ap-password'
]

export function privacySensitive(entries: readonly string[]): string[] {
  return entries
    .map((e) => e.slice(0, e.indexOf('=')))
    .filter((k) => PRIVACY_SENSITIVE_KEYS.includes(k))
}

export function rawOptionArgs(entries: readonly string[]): string[] {
  return entries.map((e) => `--ytdl-raw-options-append=${e}`)
}
