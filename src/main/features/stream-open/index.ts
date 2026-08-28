import type { FeatureContext, FeatureModule, SettingDescriptor } from '@shared/feature-api'
import {
  CACHE_PRESETS,
  LOW_LATENCY_FOREIGN,
  byteSlidersApply,
  curlArgs,
  presetById,
  type OwnedCacheProperty
} from './cache-presets.ts'
import { deriveBufferState, type BufferState } from './buffering.ts'
import {
  addRecent,
  loadRecent,
  removeRecent,
  retitleRecent,
  saveRecent,
  type RecentUrl
} from './recent.ts'
import { classifyUrl, isHistoryWorthy, type UrlSource, type UrlVerdict } from './url-policy.ts'

/**
 * M35 stream-open — R01–R04, R11–R20, R22–R24.
 *
 * ===========================================================================
 * THE ctx.network PILOT RESULT, up front, because it is the reason this module
 * was asked to go first and because the answer is "the allowlist does not fit,
 * and it should not be made to".
 * ===========================================================================
 *
 * `ctx.network` (§11.5) answers ONE question: "is HOST h in the compile-time
 * table in src/main/core/no-network.ts?" That is exactly the right question for
 * M21's subtitle providers — a fixed, small, reviewable set of hosts the BUILD
 * reaches on its own initiative. It is structurally the wrong question for a
 * stream URL, and adding a wildcard row to make it fit would delete the value of
 * the table for every other module. So:
 *
 *   - This module never calls `assertAllowed` for a user-entered host. With an
 *     empty ALLOWLIST that call throws for every stream, and with a `*` row it
 *     asserts nothing. Neither is a policy.
 *   - What the module enforces instead is on a different axis, and all three
 *     halves are code, not prose: the R02 SCHEME allowlist (`url-policy.ts`),
 *     an explicit user action for every single open (see `openUrl` — there is no
 *     timer, no retry loop, no prefetch and no code path that reaches a host
 *     without a command the user invoked), and nothing whatsoever at rest.
 *   - `ctx.network` IS used, once, where it is the right question: M36 asks it
 *     before offering R07's `yt-dlp --update-to`, because that is the app
 *     reaching a fixed host on its own initiative. It answers `false` today,
 *     which is correct — the row is a review, and a module may not write it.
 *
 * AND A LIMIT OF THE ENFORCEMENT MODEL THAT THIS MODULE MAKES REACHABLE FOR THE
 * FIRST TIME, recorded here because `check:network` cannot see it. Layers 2–4 of
 * §11.5 (`session.webRequest`, `setProxy`, `--host-resolver-rules`) are Chromium
 * session policy. mpv.exe is a CHILD PROCESS with its own resolver and its own
 * sockets, and yt-dlp.exe under it is another. None of the three layers applies
 * to either, and `--log-net-log` records only Chromium's traffic — so from
 * v0.1.2 on, "zero network requests" is guaranteed by layer 1 alone (nothing
 * asks) for everything below the Electron process. Layer 1 is this module's job,
 * which is why every network-touching path here starts at a command.
 *
 * ===========================================================================
 * WHAT THIS MODULE CANNOT DO, and did not work around
 * ===========================================================================
 *
 * R01's shape is `['loadfile', url, 'replace', -1, {options}]`. `loadfile` is
 * M28's command (§2.1) and the sanctioned path is `playlist.openPaths(paths)`,
 * which takes no options map — and, measured, drops a URL outright:
 * `openPaths` calls `fs.statSync(p)` on every entry inside a
 * `try { } catch { continue }`, and `fs.statSync('https://…')` throws ENOENT.
 * So `openStream()` below calls the mediator (correctly), watches for the
 * `start-file` that a real load produces, and reports the blocker by name when
 * it does not arrive, rather than issuing `loadfile` behind M28's back.
 *
 * Because there is no per-file options map, the seven rows that specify per-file
 * options (R01, R12, R13, R14, R15, R19, R20) are applied as PROPERTY WRITES
 * before the open and reverted on `end-file`. That revert is the whole reason
 * `restoreDefaults()` exists: mpv restores per-file options for you, and a
 * global `tls-verify=no` that leaked into the next stream would be a real
 * security regression rather than an inconvenience.
 */

let ctx: FeatureContext

/** R03's list, loaded once at setup and written through. */
let recent: RecentUrl[] = []

/** The URL currently playing, for R03's retitle and R20's badge. */
let currentUrl: string | null = null
/** Properties this module wrote for the current stream, and their old values. */
let overridden: Array<{ property: OwnedCacheProperty | string; previous: unknown }> = []

let pushTimer: ReturnType<typeof setTimeout> | null = null
const unsubs: Array<() => void> = []

// ---------------------------------------------------------------------------
// R16 / R24: the buffering push
// ---------------------------------------------------------------------------

function currentBufferState(): BufferState {
  return deriveBufferState({
    viaNetwork: ctx.mpv.peek('demuxer-via-network'),
    pausedForCache: ctx.mpv.peek('paused-for-cache'),
    bufferingState: ctx.mpv.peek('cache-buffering-state'),
    cacheSpeed: ctx.mpv.peek('cache-speed'),
    cacheDuration: ctx.mpv.peek('demuxer-cache-duration'),
    cacheTime: ctx.mpv.peek('demuxer-cache-time'),
    duration: ctx.mpv.peek('duration'),
    seekable: ctx.mpv.peek('seekable'),
    cacheState: ctx.mpv.peek('demuxer-cache-state')
  })
}

/**
 * Coalesced to one push per animation-ish frame.
 *
 * `demuxer-cache-state` changes several times a second on a healthy stream and
 * every observed property below fires independently, so an un-coalesced push
 * would send the same object five times per tick to a renderer that repaints
 * once. R16's UI is a progress readout; 60 ms is invisible and the wake-ups are
 * not.
 */
function schedulePush(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    ctx.ipc.send('stream-open:buffer', currentBufferState())
  }, 60)
}

// ---------------------------------------------------------------------------
// R19 / R20 / R12 / R14: per-stream options, as writes plus a revert
// ---------------------------------------------------------------------------

async function override(property: string, value: string): Promise<void> {
  const previous = ctx.mpv.peek(property)
  try {
    await ctx.mpv.set(property, value)
    overridden.push({ property, previous })
  } catch (e) {
    // An OwnershipError here means the manifest and this module disagree, which
    // is a programming error worth seeing rather than a silently missing option.
    ctx.log.error(`[stream-open] could not set '${property}':`, (e as Error).message)
  }
}

/**
 * Undo every per-stream write. Called on `end-file`, so the next stream — or the
 * next local file — starts from the user's settings and not from the last
 * stream's exception.
 *
 * R20's `tls-verify=no` is why this is not optional. mpv would have restored it
 * for us if this were a per-file option; it is not, so we restore it, and the
 * order is reversed so a property written twice ends on its oldest value.
 */
async function restoreDefaults(): Promise<void> {
  const list = overridden.slice().reverse()
  overridden = []
  for (const o of list) {
    if (o.previous === undefined) continue
    try {
      await ctx.mpv.set(o.property, o.previous)
    } catch (e) {
      ctx.log.warn(`[stream-open] could not restore '${o.property}':`, (e as Error).message)
    }
  }
}

function tlsExceptions(): string[] {
  const raw = ctx.settings.get<string[]>('stream-open.tlsExceptions')
  return Array.isArray(raw) ? raw.filter((h) => typeof h === 'string' && h.length > 0) : []
}

async function applyStreamOptions(v: Extract<UrlVerdict, { ok: true }>): Promise<void> {
  const ua = ctx.settings.get<string>('stream-open.userAgent')
  if (ua.length > 0) await override('user-agent', ua)

  const referrer = ctx.settings.get<string>('stream-open.referrer')
  if (referrer.length > 0) await override('referrer', referrer)

  const headers = ctx.settings.get<string[]>('stream-open.headers')
  if (Array.isArray(headers) && headers.length > 0) {
    // `http-header-fields` is a list property; `change-list` names it, so the
    // guard checks it against this module's ownership like any other write.
    for (const h of headers) {
      if (typeof h !== 'string' || h.length === 0) continue
      await ctx.mpv.command(['change-list', 'http-header-fields', 'append', h])
    }
  }

  // R12: HLS variant choice happens at OPEN time. There is no mid-stream ABR
  // switching in mpv, which is why this is written here and why changing the
  // setting mid-stream shows the "reload required" note instead of pretending.
  if (v.manifest === 'hls') {
    const bitrate = ctx.settings.get<string>('stream-open.hlsBitrate')
    if (bitrate.length > 0) await override('hls-bitrate', bitrate)
  }

  if (v.scheme === 'rtsp' || v.scheme === 'rtsps') {
    await override('rtsp-transport', ctx.settings.get<string>('stream-open.rtspTransport'))
    /**
     * R14, measured: `--network-timeout` is BROKEN for RTSP — "merely setting
     * the option will put RTSP into listening mode, which breaks any client
     * uses". A global timeout slider wired to an RTSP camera makes it fail in a
     * way no user would connect to a timeout setting, so the timeout is forced
     * to 0 for the duration of an RTSP stream and restored afterwards.
     */
    await override('network-timeout', '0')
  }

  // R20: per-origin, opt-in, and it reverts. Never a global checkbox.
  if ((v.scheme === 'https' || v.scheme === 'rtsps') && tlsExceptions().includes(v.host)) {
    await override('tls-verify', 'no')
    ctx.osd.toast({
      kind: 'warning',
      message: ctx.i18n.t('stream-open.tlsSkipped', { host: v.host })
    })
  }

  // R24: seeking inside the cache. Cheap, and the difference between a live
  // stream that feels unseekable and one that is.
  if (ctx.settings.get<boolean>('stream-open.forceSeekable')) {
    await override('force-seekable', 'yes')
  }
}

async function applyCachePreset(id: string): Promise<void> {
  const preset = presetById(id)
  if (!preset) return
  for (const [property, value] of Object.entries(preset.apply)) {
    try {
      await ctx.mpv.set(property, value)
    } catch (e) {
      ctx.log.warn(`[stream-open] preset '${id}': ${(e as Error).message}`)
    }
  }
  ctx.osd.show({ kind: 'info', text: ctx.i18n.t(`stream-open.preset.${id}`) })
  if (id === 'low-latency') {
    // Say what it did NOT do. A latency preset that silently applies 3 of its 11
    // properties reads as "this setting does nothing".
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('stream-open.lowLatencyPartial', {
        count: LOW_LATENCY_FOREIGN.length
      })
    })
  }
}

// ---------------------------------------------------------------------------
// R01: the open itself
// ---------------------------------------------------------------------------

/** Resolves true if mpv began loading something within the window. */
function waitForStartFile(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const off = ctx.mpv.onEvent('start-file', () => {
      clearTimeout(timer)
      off()
      resolve(true)
    })
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
  })
}

/**
 * THE ONLY PATH TO THE NETWORK IN THIS MODULE, and it is only ever reached from
 * a command the user invoked. There is no caller with a timer behind it.
 */
async function openStream(raw: string, source: UrlSource): Promise<void> {
  const v = classifyUrl(raw, source)
  if (!v.ok) {
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t(`stream-open.refuse.${v.reason}`, { scheme: v.scheme ?? '' })
    })
    ctx.log.warn(`[stream-open] refused (${v.reason}) from ${source}: ${raw.slice(0, 200)}`)
    return
  }

  await applyStreamOptions(v)

  // Watch BEFORE invoking: `start-file` for a fast local cache hit can arrive
  // inside the same tick as the mediator's await.
  const started = waitForStartFile(6000)
  await ctx.commands.invoke('playlist.openPaths', [v.url])

  if (isHistoryWorthy(source)) {
    recent = addRecent(recent, { url: v.url, title: v.url, lastPlayed: Date.now() })
    saveRecent(ctx.paths.dataDir(), recent)
    pushState()
  }
  currentUrl = v.url

  if (!(await started)) {
    /**
     * The measured blocker, reported rather than worked around.
     *
     * `playlist.openPaths` filters its input with `fs.statSync(p)` inside a
     * `catch { continue }`, and `fs.statSync` on any URL throws ENOENT, so every
     * URL is dropped before mpv sees it. The fix is one mediator on M28
     * (`playlist.openUrl(url, options)` — which R01 needs anyway for the options
     * map) and it is not this module's file to write.
     */
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('stream-open.notOpened') })
    ctx.log.error(
      `[stream-open] R01 BLOCKED: 'playlist.openPaths' did not load ${v.url}. ` +
        `M28's mediator filters its input with fs.statSync(), which throws ENOENT for ` +
        `every URL, and it accepts no per-file options map — so R01/R12/R13/R14/R15/R19/R20 ` +
        `cannot be expressed. M35 will not issue 'loadfile' itself: that command is M28's ` +
        `(§2.1). Needed: a 'playlist.openUrl(url, options)' mediator.`
    )
  }
}

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------

interface StreamPanelState {
  readonly open: boolean
  readonly recent: readonly RecentUrl[]
  readonly currentUrl: string | null
  readonly tlsOverridden: boolean
  readonly hlsReloadHint: boolean
}

let panelOpen = false
let hlsReloadHint = false

function pushState(): void {
  const state: StreamPanelState = {
    open: panelOpen,
    recent,
    currentUrl,
    tlsOverridden: overridden.some((o) => o.property === 'tls-verify'),
    hlsReloadHint
  }
  ctx.ipc.send('stream-open:state', state)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function descriptors(): SettingDescriptor[] {
  const cacheOnDisk = (): boolean => ctx.settings.get<boolean>('stream-open.cacheOnDisk')
  return [
    {
      id: 'stream-open.cachePreset',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.cachePreset',
      descriptionKey: 'stream-open.cachePresetDesc',
      type: {
        kind: 'enum',
        options: CACHE_PRESETS.map((p) => ({
          value: p.id,
          labelKey: `stream-open.preset.${p.id}`
        }))
      },
      default: 'default',
      keywords: ['버퍼', '캐시', 'buffer', 'cache', 'stream'],
      order: 210
    },
    {
      /**
       * R17: "If your settings UI has one buffer slider, it must move
       * `demuxer-max-bytes`." This is that slider, and `cache-secs` is
       * deliberately NOT exposed as a second one — raising it alone does
       * nothing, which is the most misunderstood pair in mpv.
       */
      id: 'stream-open.maxBytes',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.maxBytes',
      descriptionKey: 'stream-open.maxBytesDesc',
      type: { kind: 'int', min: 16, max: 4096, step: 16 },
      default: 150,
      mpvOption: 'demuxer-max-bytes',
      keywords: ['버퍼', 'buffer', 'readahead'],
      order: 220,
      visibleWhen: () => byteSlidersApply(cacheOnDisk())
    },
    {
      id: 'stream-open.maxBackBytes',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.maxBackBytes',
      type: { kind: 'int', min: 0, max: 2048, step: 16 },
      default: 50,
      mpvOption: 'demuxer-max-back-bytes',
      keywords: ['되감기', 'back', 'rewind'],
      order: 230,
      visibleWhen: () => byteSlidersApply(cacheOnDisk())
    },
    {
      id: 'stream-open.forceSeekable',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.forceSeekable',
      descriptionKey: 'stream-open.forceSeekableDesc',
      type: { kind: 'bool' },
      default: true,
      mpvOption: 'force-seekable',
      keywords: ['탐색', 'seek', 'live', 'dvr'],
      order: 240
    },
    {
      id: 'stream-open.cacheOnDisk',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.cacheOnDisk',
      descriptionKey: 'stream-open.cacheOnDiskDesc',
      type: { kind: 'bool' },
      default: false,
      mpvOption: 'cache-on-disk',
      keywords: ['디스크', 'disk', 'cache'],
      advanced: true,
      order: 250
    },
    {
      id: 'stream-open.chunkedRequests',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.chunkedRequests',
      descriptionKey: 'stream-open.chunkedRequestsDesc',
      type: { kind: 'bool' },
      default: false,
      mpvOption: 'curl-max-request-size',
      keywords: ['끊김', 'cdn', 'throttle', 'curl'],
      order: 260,
      requiresRestart: true
    },
    {
      id: 'stream-open.networkTimeout',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.networkTimeout',
      descriptionKey: 'stream-open.networkTimeoutDesc',
      type: { kind: 'int', min: 0, max: 120, step: 1 },
      default: 60,
      mpvOption: 'network-timeout',
      keywords: ['시간', 'timeout'],
      advanced: true,
      order: 270
    },
    {
      id: 'stream-open.hlsBitrate',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.hlsBitrate',
      descriptionKey: 'stream-open.hlsBitrateDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'max', labelKey: 'stream-open.hls.max' },
          { value: 'min', labelKey: 'stream-open.hls.min' },
          { value: 'no', labelKey: 'stream-open.hls.no' }
        ]
      },
      default: 'max',
      mpvOption: 'hls-bitrate',
      keywords: ['화질', 'hls', 'bitrate'],
      order: 280
    },
    {
      id: 'stream-open.rtspTransport',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-open.rtspTransport',
      type: {
        kind: 'enum',
        options: ['tcp', 'udp', 'udp_multicast', 'http', 'lavf'].map((v) => ({
          value: v,
          labelKey: `stream-open.rtsp.${v}`
        }))
      },
      default: 'tcp',
      mpvOption: 'rtsp-transport',
      keywords: ['카메라', 'rtsp', 'camera', 'nvr'],
      order: 290
    },
    {
      id: 'stream-open.userAgent',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.userAgent',
      descriptionKey: 'stream-open.userAgentDesc',
      type: { kind: 'string' },
      default: '',
      mpvOption: 'user-agent',
      keywords: ['ua', 'user-agent', '403'],
      advanced: true,
      order: 310
    },
    {
      id: 'stream-open.referrer',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.referrer',
      type: { kind: 'string' },
      default: '',
      mpvOption: 'referrer',
      advanced: true,
      order: 320
    },
    {
      id: 'stream-open.headers',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.headers',
      descriptionKey: 'stream-open.headersDesc',
      type: { kind: 'list', of: 'string' },
      default: [] as string[],
      mpvOption: 'http-header-fields',
      advanced: true,
      order: 330
    },
    {
      id: 'stream-open.proxy',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.proxy',
      // R19, measured and worth saying out loud in the UI: the proxy is
      // "silently ignored if it does not start with http://. Proxies are not
      // used for https URLs." Otherwise an https stream bypasses the setting and
      // the user concludes the app is broken.
      descriptionKey: 'stream-open.proxyDesc',
      type: { kind: 'string' },
      default: '',
      mpvOption: 'http-proxy',
      advanced: true,
      order: 340
    },
    {
      id: 'stream-open.cookiesFile',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.cookiesFile',
      descriptionKey: 'stream-open.cookiesFileDesc',
      type: { kind: 'path', mode: 'file' },
      default: '',
      mpvOption: 'cookies-file',
      advanced: true,
      order: 350
    },
    {
      /**
       * R20. A LIST of hosts, never a global checkbox: "Never ship a global
       * 'ignore certificate errors' checkbox." Each entry is one origin the user
       * accepted after a verification failure, and the override reverts on
       * `end-file` because it is a property write and not a per-file option.
       */
      id: 'stream-open.tlsExceptions',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.tlsExceptions',
      descriptionKey: 'stream-open.tlsExceptionsDesc',
      type: { kind: 'list', of: 'string' },
      default: [] as string[],
      mpvOption: 'tls-verify',
      advanced: true,
      order: 360
    },
    {
      id: 'stream-open.tlsCaFile',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-open.tlsCaFile',
      type: { kind: 'path', mode: 'file' },
      default: '',
      mpvOption: 'tls-ca-file',
      advanced: true,
      order: 370
    }
  ]
}

const MiB = 1024 * 1024

const mod: FeatureModule = {
  id: 'stream-open',
  dependsOn: ['core-mpv-bus'],

  // Copied verbatim from this module's row in docs/parity/modules.json. `curl-*`
  // is the one glob, and it is trailing, which §2 requires.
  ownsProperties: [
    'cache',
    'cache-on-disk',
    'cache-pause',
    'cache-pause-initial',
    'cache-pause-wait',
    'cache-secs',
    'cookies',
    'cookies-file',
    'curl-*',
    'demuxer-cache-dir',
    'demuxer-max-back-bytes',
    'demuxer-max-bytes',
    'demuxer-readahead-secs',
    'force-seekable',
    'hls-bitrate',
    'http-header-fields',
    'http-proxy',
    'network-timeout',
    'referrer',
    'rtsp-transport',
    'stream-buffer-size',
    'tls-ca-file',
    'tls-cert-file',
    'tls-key-file',
    'tls-verify',
    'user-agent'
  ],

  setup(c): void {
    ctx = c
    recent = loadRecent(ctx.paths.dataDir())

    ctx.settings.define(descriptors())

    // ---------------------------------------------------------------------
    // Spawn args. Everything here is a property this module owns, so the §4
    // owner check passes; nothing here is core-reserved or inert under --wid.
    // ---------------------------------------------------------------------
    ctx.mpv.contributeArgs(20, () => {
      const args: string[] = []
      const preset = presetById(ctx.settings.get<string>('stream-open.cachePreset'))
      if (preset) {
        for (const [k, v] of Object.entries(preset.apply)) args.push(`--${k}=${v}`)
      }
      const onDisk = ctx.settings.get<boolean>('stream-open.cacheOnDisk')
      if (onDisk) {
        args.push('--cache-on-disk=yes')
        // Portable-mode friendly: cacheDir() is beside the exe in portable mode
        // and under the profile otherwise, and profile-cleanup is forbidden from
        // touching anything under ctx.paths (§12).
        args.push(`--demuxer-cache-dir=${ctx.paths.cacheDir()}`)
      } else {
        // The byte caps only mean bytes of MEDIA when the disk cache is off
        // (R18: with it on they apply to metadata only), so they are contributed
        // only in that case rather than silently changing meaning.
        const dedupe = new Set(args.map((a) => a.split('=')[0]))
        const max = ctx.settings.get<number>('stream-open.maxBytes') * MiB
        const back = ctx.settings.get<number>('stream-open.maxBackBytes') * MiB
        if (!dedupe.has('--demuxer-max-bytes')) args.push(`--demuxer-max-bytes=${max}`)
        if (!dedupe.has('--demuxer-max-back-bytes')) args.push(`--demuxer-max-back-bytes=${back}`)
      }
      args.push(...curlArgs(ctx.settings.get<boolean>('stream-open.chunkedRequests')))

      const timeout = ctx.settings.get<number>('stream-open.networkTimeout')
      if (timeout > 0) args.push(`--network-timeout=${timeout}`)

      const ua = ctx.settings.get<string>('stream-open.userAgent')
      if (ua.length > 0) args.push(`--user-agent=${ua}`)
      const proxy = ctx.settings.get<string>('stream-open.proxy')
      if (proxy.length > 0) args.push(`--http-proxy=${proxy}`)
      const cookies = ctx.settings.get<string>('stream-open.cookiesFile')
      if (cookies.length > 0) args.push('--cookies=yes', `--cookies-file=${cookies}`)
      const ca = ctx.settings.get<string>('stream-open.tlsCaFile')
      if (ca.length > 0) args.push(`--tls-ca-file=${ca}`)

      // Deduplicate within this batch: a preset and a slider can name the same
      // option, and `validateArgContributions` rejects a repeat inside one
      // contributor's own array.
      const seen = new Set<string>()
      return args.filter((a) => {
        const name = a.split('=')[0] as string
        if (seen.has(name)) return false
        seen.add(name)
        return true
      })
    })

    // ---------------------------------------------------------------------
    // R16 / R24 observers. Reads only — `observe` never checks ownership.
    // ---------------------------------------------------------------------
    for (const p of [
      'demuxer-via-network',
      'paused-for-cache',
      'cache-buffering-state',
      'cache-speed',
      'demuxer-cache-duration',
      'demuxer-cache-time',
      'demuxer-cache-state',
      'duration',
      'seekable'
    ]) {
      unsubs.push(ctx.mpv.observe(p, () => schedulePush()))
    }

    /**
     * R22: tracks appear LATE on a network stream. The failure this prevents is
     * a user opening an IPTV channel, seeing one audio track and concluding the
     * app is broken when the second audio PID simply had not been probed yet.
     * Observing rather than snapshotting is the entire fix — the menus belong to
     * M11/M17, so what this module does is tell the overlay that the list moved.
     */
    unsubs.push(
      ctx.mpv.observe('track-list', () => {
        if (ctx.mpv.peek<boolean>('demuxer-via-network') !== true) return
        ctx.ipc.send('stream-open:tracksChanged', {
          count: (ctx.mpv.peek<unknown[]>('track-list') ?? []).length
        })
      })
    )

    // R03: retitle once mpv knows what the stream is called.
    unsubs.push(
      ctx.mpv.observe<string>('media-title', (title) => {
        if (!currentUrl || !title || title === currentUrl) return
        const next = retitleRecent(recent, currentUrl, title)
        if (next !== recent) {
          recent = next
          saveRecent(ctx.paths.dataDir(), recent)
          pushState()
        }
      })
    )

    // The per-stream revert. See restoreDefaults() for why this is not optional.
    unsubs.push(
      ctx.mpv.onEvent('end-file', () => {
        currentUrl = null
        void restoreDefaults().then(() => pushState())
      })
    )

    // R12: the variant is chosen at open time and there is no mid-stream ABR
    // switching in mpv, so changing the setting mid-stream must SAY so rather
    // than looking like nothing happened.
    ctx.settings.onChange<string>('stream-open.hlsBitrate', () => {
      if (ctx.mpv.peek<boolean>('demuxer-via-network') !== true) return
      hlsReloadHint = true
      pushState()
      ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('stream-open.hlsReload') })
    })

    ctx.settings.onChange<string>('stream-open.cachePreset', (v) => {
      void applyCachePreset(v)
    })

    // ---------------------------------------------------------------------
    // IPC
    // ---------------------------------------------------------------------
    ctx.ipc.on<{ url: string }>('stream-open:submit', (req) => {
      void openStream(String(req?.url ?? ''), 'user')
    })
    ctx.ipc.on<{ url: string }>('stream-open:forget', (req) => {
      recent = removeRecent(recent, String(req?.url ?? ''))
      saveRecent(ctx.paths.dataDir(), recent)
      pushState()
    })
    ctx.ipc.on<void>('stream-open:togglePanel', () => {
      panelOpen = !panelOpen
      pushState()
    })
    ctx.ipc.handle<void, StreamPanelState>('stream-open:getState', () => ({
      open: panelOpen,
      recent,
      currentUrl,
      tlsOverridden: overridden.some((o) => o.property === 'tls-verify'),
      hlsReloadHint
    }))
    ctx.ipc.handle<void, BufferState>('stream-open:getBuffer', () => currentBufferState())

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------
    ctx.commands.register([
      {
        id: 'stream-open.openUrl',
        labelKey: 'stream-open.openUrl',
        category: 'playback',
        defaults: {
          // PotPlayer's Open URL is Ctrl+U; mpv has no equivalent, so the mpv
          // preset gets the same accel rather than nothing.
          default: ['Ctrl+KeyU'],
          potplayer: ['Ctrl+KeyU'],
          mpv: ['Ctrl+KeyU']
        },
        menuPath: 'playback',
        menuOrder: 15,
        run: () => {
          panelOpen = true
          pushState()
        }
      },
      {
        id: 'stream-open.closePanel',
        labelKey: 'stream-open.closePanel',
        category: 'playback',
        internal: true,
        run: () => {
          panelOpen = false
          pushState()
        }
      },
      {
        /**
         * The arg-driven entry point, for M34's `rlplayer://` handler and for
         * argv. `internal` so it is not a keybindable action: a command that
         * takes a URL as an argument has nothing to bind to.
         *
         * The SOURCE is part of the argument on purpose. R35 says the OS handler
         * is a remote-input surface, and a caller that cannot state where the
         * string came from is a caller that should not be opening it.
         */
        id: 'stream-open.openFrom',
        labelKey: 'stream-open.openFrom',
        category: 'playback',
        internal: true,
        run: (arg) => {
          const a = (arg ?? {}) as { url?: unknown; source?: unknown }
          const source = typeof a.source === 'string' ? (a.source as UrlSource) : 'protocol-handler'
          return openStream(String(a.url ?? ''), source)
        }
      },
      {
        id: 'stream-open.applyPreset',
        labelKey: 'stream-open.applyPreset',
        category: 'playback',
        internal: true,
        run: (arg) => applyCachePreset(String(arg ?? 'default'))
      },
      {
        /**
         * R23: `sub-add` accepts a URL as well as a path ("load the given
         * subtitle file OR STREAM"), and `--sub-auto` does nothing at all for an
         * `http://` source — no engine feature fills that gap. So this is the
         * explicit "자막 URL 추가" the row asks for, and it goes through M17's
         * mediator because M17 owns `sid` and the external-track set.
         */
        id: 'stream-open.addSubtitleUrl',
        labelKey: 'stream-open.addSubtitleUrl',
        category: 'subtitles',
        enabledWhen: () => ctx.mpv.peek<boolean>('demuxer-via-network') === true,
        run: async (arg) => {
          const v = classifyUrl(String(arg ?? ''), 'user')
          if (!v.ok) {
            ctx.osd.toast({
              kind: 'error',
              message: ctx.i18n.t(`stream-open.refuse.${v.reason}`, { scheme: v.scheme ?? '' })
            })
            return
          }
          await ctx.commands.invoke('subs-tracks.addFile', v.url)
        }
      },
      {
        /**
         * R20's "이 주소만 인증서 검증 건너뛰기". Adds the host to the exception
         * list and reopens, because `tls-verify` is read when the connection is
         * made. Confirmed through ctx.dialog with mpv's own wording, which the
         * row asks for by name.
         */
        id: 'stream-open.trustHostOnce',
        labelKey: 'stream-open.trustHostOnce',
        category: 'playback',
        internal: true,
        run: async (arg) => {
          const v = classifyUrl(String(arg ?? currentUrl ?? ''), 'user')
          if (!v.ok || v.host.length === 0) return
          const yes = await ctx.dialog.confirm({
            titleKey: 'stream-open.trustHostOnce',
            messageKey: 'stream-open.trustHostWarning',
            confirmKey: 'stream-open.trustHostConfirm',
            destructive: true
          })
          if (!yes) return
          const list = tlsExceptions()
          if (!list.includes(v.host)) {
            ctx.settings.set<string[]>('stream-open.tlsExceptions', [...list, v.host])
          }
          await openStream(v.url, 'user')
        }
      }
    ])

    ctx.menu.contribute({
      id: 'stream-open.menu',
      labelKey: 'stream-open.menuTitle',
      order: 15,
      items: [
        { commandId: 'stream-open.openUrl' },
        { type: 'separator' },
        {
          labelKey: 'stream-open.recentTitle',
          submenu: [
            {
              dynamic: () =>
                recent.length === 0
                  ? [{ labelKey: 'stream-open.recentEmpty', enabled: false }]
                  : recent.slice(0, 15).map((r) => ({
                      label: r.title,
                      commandId: 'stream-open.openFrom',
                      arg: { url: r.url, source: 'user' }
                    }))
            }
          ]
        },
        {
          labelKey: 'stream-open.cachePreset',
          submenu: [
            {
              dynamic: () => {
                const active = ctx.settings.get<string>('stream-open.cachePreset')
                return CACHE_PRESETS.map((p) => ({
                  labelKey: `stream-open.preset.${p.id}`,
                  commandId: 'stream-open.applyPreset',
                  arg: p.id,
                  radio: true,
                  checked: active === p.id
                }))
              }
            }
          ]
        }
      ]
    })

    ctx.i18n.register('ko', {
      'stream-open.openUrl': 'URL 열기…',
      'stream-open.openFrom': 'URL 열기(인수)',
      'stream-open.closePanel': 'URL 창 닫기',
      'stream-open.applyPreset': '버퍼 프리셋 적용',
      'stream-open.addSubtitleUrl': '자막 URL 추가…',
      'stream-open.trustHostOnce': '이 주소만 인증서 검증 건너뛰기',
      'stream-open.trustHostWarning':
        '인증서 검증을 끄면 중간자 공격이 HTTPS 스트림의 내용을 몰래 바꿔치기할 수 있습니다. ' +
        '검증이 실패하는 이유를 알고 있을 때, 이 주소에만 한해서 쓰는 것을 권합니다.',
      'stream-open.trustHostConfirm': '이 주소만 허용',
      'stream-open.menuTitle': '스트리밍',
      'stream-open.recentTitle': '최근 URL',
      'stream-open.recentEmpty': '기록 없음',
      'stream-open.panelTitle': 'URL 열기',
      'stream-open.urlPlaceholder': 'http://, https://, rtsp://, udp://@… 주소를 붙여넣으세요',
      'stream-open.openButton': '열기',
      'stream-open.forget': '기록에서 지우기',
      'stream-open.notOpened':
        'URL을 재생 목록에 넘겼지만 mpv가 열지 않았습니다. 로그를 확인해 주세요.',
      'stream-open.tlsSkipped': '{host}{을/를} 인증서 검증 없이 재생합니다',
      'stream-open.hlsReload': 'HLS 화질은 열 때 결정됩니다. 다시 열어야 적용됩니다.',
      'stream-open.lowLatencyPartial':
        '저지연 프리셋 중 {count}개 항목은 다른 모듈 소유라 적용되지 않았습니다',
      'stream-open.cachePreset': '버퍼 프리셋',
      'stream-open.cachePresetDesc':
        '캐시 크기와 정지 동작을 한 번에 바꿉니다. cache-secs만 올려도 아무 일도 일어나지 않습니다 — ' +
        '실제 한도는 demuxer-max-bytes입니다.',
      'stream-open.preset.default': '기본 (150MiB / 50MiB)',
      'stream-open.preset.unstable': '불안정한 회선 (1GiB / 256MiB)',
      'stream-open.preset.low-latency': '저지연 (캐시 없음)',
      'stream-open.maxBytes': '앞으로 받아둘 버퍼 (MiB)',
      'stream-open.maxBytesDesc': '스트리밍이 자꾸 끊기면 이 값을 올리세요.',
      'stream-open.maxBackBytes': '뒤로 남겨둘 버퍼 (MiB)',
      'stream-open.forceSeekable': '생방송에서도 캐시 범위 안에서 탐색',
      'stream-open.forceSeekableDesc':
        '캐시에 들어온 구간은 탐색이 됩니다. 탐색 막대에 그 구간만 표시됩니다.',
      'stream-open.cacheOnDisk': '캐시를 디스크에 저장',
      'stream-open.cacheOnDiskDesc':
        '켜면 캐시 파일이 재생 중 계속 커지고(비운 자리는 재사용되지 않음) 닫을 때 지워집니다. ' +
        '이때 위의 버퍼 크기는 메타데이터에만 적용되므로 숨겨집니다.',
      'stream-open.chunkedRequests': '스트리밍이 자꾸 끊길 때',
      'stream-open.chunkedRequestsDesc':
        '한 연결의 속도를 제한하는 CDN에서, 요청을 8MiB씩 나눠 받습니다.',
      'stream-open.networkTimeout': '네트워크 시간 초과 (초)',
      'stream-open.networkTimeoutDesc':
        'RTSP에는 적용되지 않습니다 — mpv에서 이 옵션은 RTSP를 수신 대기 모드로 바꿔 버립니다.',
      'stream-open.hlsBitrate': 'HLS 화질',
      'stream-open.hlsBitrateDesc':
        '열 때 한 번 결정됩니다. mpv에는 재생 중 화질 전환(ABR)이 없습니다.',
      'stream-open.hls.max': '가장 높은 화질',
      'stream-open.hls.min': '가장 낮은 화질',
      'stream-open.hls.no': '서버 기본값',
      'stream-open.rtspTransport': 'RTSP 전송 방식',
      'stream-open.rtsp.tcp': 'TCP',
      'stream-open.rtsp.udp': 'UDP',
      'stream-open.rtsp.udp_multicast': 'UDP 멀티캐스트',
      'stream-open.rtsp.http': 'HTTP 터널',
      'stream-open.rtsp.lavf': 'libavformat 기본값',
      'stream-open.userAgent': 'User-Agent',
      'stream-open.userAgentDesc':
        'mpv 기본값은 libmpv이고, 일부 CDN은 이 값을 403으로 막습니다.',
      'stream-open.referrer': 'Referer',
      'stream-open.headers': '추가 HTTP 헤더',
      'stream-open.headersDesc': '한 줄에 하나씩, "X-Token: abc" 형식으로.',
      'stream-open.proxy': 'HTTP 프록시',
      'stream-open.proxyDesc':
        'http:// 로 시작하지 않으면 조용히 무시되고, https 주소에는 아예 쓰이지 않습니다.',
      'stream-open.cookiesFile': '쿠키 파일',
      'stream-open.cookiesFileDesc': 'Netscape 형식 cookies.txt.',
      'stream-open.tlsExceptions': '인증서 검증 예외 (호스트)',
      'stream-open.tlsExceptionsDesc':
        '여기 적힌 주소에만 검증을 건너뜁니다. 전체 끄기는 제공하지 않습니다.',
      'stream-open.tlsCaFile': 'CA 인증서 파일',
      'stream-open.buffering': '버퍼링',
      'stream-open.stats': '스트리밍',
      'stream-open.statsPercent': '버퍼 채움',
      'stream-open.statsSeconds': '앞으로 받아둔 시간',
      'stream-open.statsForward': '앞 버퍼',
      'stream-open.statsRate': '입력 속도(참고)',
      'stream-open.statsSpeed': '캐시 속도',
      'stream-open.statsDisk': '디스크 캐시',
      'stream-open.statsRanges': '탐색 가능 구간',
      'stream-open.statsLive': '생방송',
      'stream-open.refuse.empty': '주소를 입력해 주세요.',
      'stream-open.refuse.local-path':
        '로컬 파일은 파일 열기로 재생하세요. URL 열기는 네트워크 주소용입니다.',
      'stream-open.refuse.control-character': '주소에 쓸 수 없는 문자가 들어 있습니다.',
      'stream-open.refuse.multiline': '한 번에 하나의 주소만 열 수 있습니다.',
      'stream-open.refuse.no-scheme': 'http:// 처럼 프로토콜까지 포함한 주소가 필요합니다.',
      'stream-open.refuse.denied-scheme': '{scheme}:// 주소는 보안상 열지 않습니다.',
      'stream-open.refuse.unknown-scheme': '{scheme}:// 프로토콜은 지원하지 않습니다.'
    })

    ctx.i18n.register('en', {
      'stream-open.openUrl': 'Open URL…',
      'stream-open.openFrom': 'Open URL (argument)',
      'stream-open.closePanel': 'Close the URL box',
      'stream-open.applyPreset': 'Apply buffer preset',
      'stream-open.addSubtitleUrl': 'Add subtitle URL…',
      'stream-open.trustHostOnce': 'Skip certificate verification for this address only',
      'stream-open.trustHostWarning':
        'Disabling this allows man-in-the-middle attacks to silently substitute the content ' +
        'of an HTTPS stream, and is only recommended as a per-stream override when ' +
        'verification fails for a known-good reason.',
      'stream-open.trustHostConfirm': 'Allow this address only',
      'stream-open.menuTitle': 'Streaming',
      'stream-open.recentTitle': 'Recent URLs',
      'stream-open.recentEmpty': 'No history',
      'stream-open.panelTitle': 'Open URL',
      'stream-open.urlPlaceholder': 'Paste an http://, https://, rtsp:// or udp://@… address',
      'stream-open.openButton': 'Open',
      'stream-open.forget': 'Remove from history',
      'stream-open.notOpened': 'The URL reached the playlist but mpv did not open it — see the log.',
      'stream-open.tlsSkipped': 'Playing {host} without certificate verification',
      'stream-open.hlsReload': 'HLS quality is chosen when the stream opens. Reopen to apply.',
      'stream-open.lowLatencyPartial':
        '{count} settings in the low-latency preset belong to other modules and were not applied',
      'stream-open.cachePreset': 'Buffer preset',
      'stream-open.cachePresetDesc':
        'Changes the cache size and the pause behaviour together. Raising cache-secs alone does ' +
        'nothing — the real limit is demuxer-max-bytes.',
      'stream-open.preset.default': 'Default (150MiB / 50MiB)',
      'stream-open.preset.unstable': 'Unstable connection (1GiB / 256MiB)',
      'stream-open.preset.low-latency': 'Low latency (no cache)',
      'stream-open.maxBytes': 'Forward buffer (MiB)',
      'stream-open.maxBytesDesc': 'Raise this if streams keep stalling.',
      'stream-open.maxBackBytes': 'Backward buffer (MiB)',
      'stream-open.forceSeekable': 'Seek within the cache on live streams',
      'stream-open.forceSeekableDesc':
        'Anything already cached becomes seekable. The seek bar shows only that window.',
      'stream-open.cacheOnDisk': 'Cache to disk',
      'stream-open.cacheOnDiskDesc':
        'The cache file is append-only: it grows for the whole session and is deleted on close. ' +
        'With this on the buffer sizes above apply to metadata only, so they are hidden.',
      'stream-open.chunkedRequests': 'When streaming keeps stalling',
      'stream-open.chunkedRequestsDesc':
        'Fetches in 8MiB range requests, for CDNs that throttle a single long-lived connection.',
      'stream-open.networkTimeout': 'Network timeout (s)',
      'stream-open.networkTimeoutDesc':
        'Not applied to RTSP — in mpv this option puts RTSP into listening mode and breaks it.',
      'stream-open.hlsBitrate': 'HLS quality',
      'stream-open.hlsBitrateDesc':
        'Decided once, when the stream opens. mpv has no mid-stream ABR switching.',
      'stream-open.hls.max': 'Highest',
      'stream-open.hls.min': 'Lowest',
      'stream-open.hls.no': 'Server default',
      'stream-open.rtspTransport': 'RTSP transport',
      'stream-open.rtsp.tcp': 'TCP',
      'stream-open.rtsp.udp': 'UDP',
      'stream-open.rtsp.udp_multicast': 'UDP multicast',
      'stream-open.rtsp.http': 'HTTP tunnel',
      'stream-open.rtsp.lavf': 'libavformat default',
      'stream-open.userAgent': 'User-Agent',
      'stream-open.userAgentDesc':
        "mpv's default is literally `libmpv`, which some CDNs answer with 403.",
      'stream-open.referrer': 'Referer',
      'stream-open.headers': 'Extra HTTP headers',
      'stream-open.headersDesc': 'One per line, as "X-Token: abc".',
      'stream-open.proxy': 'HTTP proxy',
      'stream-open.proxyDesc':
        'Silently ignored unless it starts with http://, and never used for https URLs.',
      'stream-open.cookiesFile': 'Cookies file',
      'stream-open.cookiesFileDesc': 'Netscape-format cookies.txt.',
      'stream-open.tlsExceptions': 'Certificate exceptions (hosts)',
      'stream-open.tlsExceptionsDesc':
        'Verification is skipped for these hosts only. There is no global off switch.',
      'stream-open.tlsCaFile': 'CA certificate file',
      'stream-open.buffering': 'Buffering',
      'stream-open.stats': 'Streaming',
      'stream-open.statsPercent': 'Buffer fill',
      'stream-open.statsSeconds': 'Readahead',
      'stream-open.statsForward': 'Forward cache',
      'stream-open.statsRate': 'Input rate (hint)',
      'stream-open.statsSpeed': 'Cache speed',
      'stream-open.statsDisk': 'Disk cache',
      'stream-open.statsRanges': 'Seekable ranges',
      'stream-open.statsLive': 'Live',
      'stream-open.refuse.empty': 'Enter an address.',
      'stream-open.refuse.local-path': 'Local files go through Open File; this box is for URLs.',
      'stream-open.refuse.control-character': 'That address contains characters a URL cannot hold.',
      'stream-open.refuse.multiline': 'One address at a time.',
      'stream-open.refuse.no-scheme': 'The address needs a protocol, e.g. http://.',
      'stream-open.refuse.denied-scheme': '{scheme}:// addresses are not opened, for safety.',
      'stream-open.refuse.unknown-scheme': '{scheme}:// is not a supported protocol.'
    })

    pushState()
  },

  dispose(): void {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    for (const off of unsubs.splice(0)) {
      try {
        off()
      } catch {
        /* an observer that is already gone is not an error on the quit path */
      }
    }
  }
}

export default mod
