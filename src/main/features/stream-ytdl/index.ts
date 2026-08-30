import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { FeatureContext, FeatureModule, SettingDescriptor } from '@shared/feature-api'
import {
  FORMAT_PRESETS,
  hookArgs,
  parseRawOptions,
  privacySensitive,
  rawOptionArgs,
  toggleCommand
} from './ytdl-opts.ts'
import {
  UPDATE_CHANNELS,
  findYtdlp,
  parseVersion,
  probeOrder,
  updateArgv,
  ytdlPathOption,
  type UpdateChannel
} from './ytdl-path.ts'
import {
  classify,
  qualityOptions,
  singleFormatIsNormal,
  type QualityOption,
  type YtdlOutcome
} from './ytdl-status.ts'

/**
 * M36 stream-ytdl — R05–R10.
 *
 * ===========================================================================
 * THE ctx.network PILOT RESULT, and it is a NEGATIVE result in both directions.
 * ===========================================================================
 *
 * M35 and M36 are the first modules that touch the network, so they were asked
 * to pilot `ctx.network` and the per-host allowlist. The honest finding is that
 * neither module can use it, for two structurally different reasons, and that
 * bending either one to fit would delete the table's value for the modules it
 * IS right for (M21's subtitle providers: a fixed, small, reviewable set of
 * hosts the BUILD reaches on its own initiative).
 *
 *   M35's reason is the axis. `ctx.network.allowed(host)` asks "is HOST h in the
 *   compile-time table?" A stream URL's host is supplied by the user at runtime
 *   and is unbounded. With the table empty every stream is refused; with a `*`
 *   row nothing is asserted. Neither is a policy. What M35 enforces instead is
 *   the R02 SCHEME allowlist plus "an explicit user action for every open".
 *
 *   M36's reason is the PROCESS BOUNDARY, and it is the sharper one.
 *   `ctx.network` and §11.5's layers 2–4 (`session.webRequest`, `setProxy`,
 *   `--host-resolver-rules`) are Chromium session policy. Every request in this
 *   feature is made by yt-dlp.exe, spawned by ytdl_hook.lua inside mpv.exe —
 *   two process boundaries away from any Electron session. None of the layers
 *   applies, `--log-net-log` cannot see it, and `check:network` is structurally
 *   blind to it: a packaged cold launch would report a perfectly clean netlog
 *   while yt-dlp was mid-download.
 *
 * So `assertAllowed` is NOT called here, and calling it would be theatre:
 * whatever it answered, the socket is opened by a process it does not govern.
 * What holds the promise instead is layer 1 — nothing asks — and for this module
 * layer 1 is a specific, testable claim:
 *
 *   the hook is loaded INERT (`ytdl_hook-exclude=.*`) on every spawn unless the
 *   user has turned yt-dlp support on, and no code path here spawns yt-dlp
 *   except two commands the user invokes.
 *
 * `module.test.ts` asserts exactly that, with a negative control so the
 * assertion is not vacuous.
 *
 * ===========================================================================
 * R07: WHY THERE IS NO UPDATER HERE, AND WHY THAT IS THE FEATURE
 * ===========================================================================
 *
 * yt-dlp's breakage cadence is real — R07 measures it as "bursty, roughly
 * monthly with reactive clusters" — and the tempting fix is a version check at
 * launch. That is the nagging updater this product exists to remove, and R07
 * settles it: "surface the update affordance only at the moment of an actual
 * extraction failure, never on a timer … No background task, no scheduled task,
 * no Run key, no launch check." yt-dlp updates ITSELF; the app's entire
 * contribution is one non-modal toast, after a failure the user already saw, that
 * runs `yt-dlp --update-to <channel>` when clicked.
 *
 * There is no `setInterval` in this file, nothing on `lifecycle.onReady` that
 * reaches a process, and the failure signal is a property ytdl_hook writes and
 * deletes on end-of-file, so there is nothing to poll.
 */

let ctx: FeatureContext

/** Resolved lazily, on first need. Never during setup(). */
let resolvedBinary: string | null = null
let resolvedProbed = false
let version: string | null = null
let lastOutcome: YtdlOutcome = { kind: 'none' }
let quality: QualityOption[] = []
const unsubs: Array<() => void> = []

// ---------------------------------------------------------------------------
// R06: discovery
// ---------------------------------------------------------------------------

function exeDir(): string {
  // `process.execPath` is the Electron binary in dev and the packaged exe in a
  // build; R06's `<exeDir>/tools/yt-dlp.exe` means the latter.
  return path.dirname(process.execPath)
}

function candidates(): string[] {
  const env = process.env
  return probeOrder({
    dataDir: ctx.paths.dataDir(),
    exeDir: exeDir(),
    configured: ctx.settings.get<string>('stream-ytdl.path'),
    localAppData: env['LOCALAPPDATA'] ?? '',
    userProfile: env['USERPROFILE'] ?? '',
    pathDirs: (env['PATH'] ?? '').split(path.delimiter).filter((d) => d.length > 0)
  })
}

/**
 * Find the binary, at most once per session unless the user asks again.
 *
 * Filesystem reads only — no process, no network. It is still lazy rather than
 * done in `setup()`, because a `stat` per PATH entry on a machine with a long
 * PATH is measurable startup cost for a feature that is off by default.
 */
function resolveBinary(force = false): string | null {
  if (resolvedProbed && !force) return resolvedBinary
  resolvedProbed = true
  resolvedBinary = findYtdlp(candidates(), (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (resolvedBinary) {
    const opt = ytdlPathOption(resolvedBinary)
    if (!opt.ok) {
      ctx.log.warn(
        `[stream-ytdl] ignoring '${resolvedBinary}': ${opt.reason}. ` +
          `Because we pass --no-config, ytdl_hook's ytdl_path must be absolute (R06).`
      )
      resolvedBinary = null
    }
  }
  return resolvedBinary
}

/**
 * The ONE non-mpv child process in this module, and the API gap it stands on.
 *
 * `FeatureContext` has no way to run a program that is not mpv:
 * `ctx.engine.spawn()` always applies `--no-config --idle=yes` &c. and is an mpv
 * client, and mpv's own `subprocess` and `run` commands are CORE-owned (§2.1).
 * R06's version probe and R07's `--update-to` are both "run this exe the user
 * installed", so this module uses `node:child_process` directly. It is tracked
 * through `ctx.lifecycle.trackProcess` so the registry reaps it on quit, which is
 * the guarantee that would otherwise be lost — reported as a finding rather than
 * left as a quiet exception.
 */
function run(
  binary: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  /**
   * Announced before the attempt, deliberately.
   *
   * This one line is the spawn detector `module.test.ts` uses for "nothing at
   * rest", and it has to be logged BEFORE `execFile` rather than after: on
   * Windows `execFile` throws SYNCHRONOUSLY for a file that is not a valid
   * executable (`Error: spawn UNKNOWN`, errno -4094), so a detector that keyed on
   * the returned ChildProcess — or on `trackProcess` — would miss exactly the
   * attempt an audit cares about most. It is also the line a support log needs:
   * "which yt-dlp did it run, with what arguments".
   */
  ctx.log.info(`[stream-ytdl] exec ${binary} ${args.join(' ')}`)
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        binary,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        }
      )
    } catch (e) {
      // A synchronous spawn failure — a stale path, a stub file, a permission
      // denial — must not escape into a settings-window click handler.
      ctx.log.warn(`[stream-ytdl] could not start ${binary}:`, (e as Error).message)
      resolve({ ok: false, stdout: '', stderr: (e as Error).message })
      return
    }
    // `LifecycleService.trackProcess` types `kill(signal?: string)`, and Node's
    // `ChildProcess.kill` takes `NodeJS.Signals | number`. Adapted here rather
    // than widened in the API: this is the only child process in the tree that
    // is not mpv, so the shim belongs at the one call site.
    ctx.lifecycle.trackProcess({
      pid: child.pid,
      kill: (signal?: string): boolean => child.kill(signal as NodeJS.Signals | undefined)
    })
  })
}

async function probeVersion(force = false): Promise<string | null> {
  const binary = resolveBinary(force)
  if (!binary) {
    version = null
    return null
  }
  if (version !== null && !force) return version
  const r = await run(binary, ['--version'], 10_000)
  version = parseVersion(r.stdout) ?? null
  if (version === null) {
    ctx.log.warn('[stream-ytdl] --version did not look like a version:', r.stdout.slice(0, 120))
  }
  pushState()
  return version
}

// ---------------------------------------------------------------------------
// R10: raw options
// ---------------------------------------------------------------------------

function rawOptionLines(): string[] {
  const raw = ctx.settings.get<string[]>('stream-ytdl.rawOptions')
  return Array.isArray(raw) ? raw.filter((l): l is string => typeof l === 'string') : []
}

function validatedRawOptions(): readonly string[] {
  const { entries, errors } = parseRawOptions(rawOptionLines())
  for (const e of errors) {
    ctx.log.warn(`[stream-ytdl] ignoring yt-dlp option '${e.line}': ${e.error}`)
  }
  return entries
}

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------

interface YtdlState {
  readonly enabled: boolean
  readonly binary: string | null
  readonly version: string | null
  readonly outcome: YtdlOutcome
  readonly quality: readonly QualityOption[]
  readonly singleFormatIsNormal: boolean
  readonly privacyKeys: readonly string[]
}

function currentState(): YtdlState {
  return {
    enabled: ctx.settings.get<boolean>('stream-ytdl.enabled'),
    binary: resolvedBinary,
    version,
    outcome: lastOutcome,
    quality,
    singleFormatIsNormal: singleFormatIsNormal(quality),
    privacyKeys: privacySensitive(validatedRawOptions())
  }
}

function pushState(): void {
  ctx.ipc.send('stream-ytdl:state', currentState())
}

// ---------------------------------------------------------------------------
// R07: the failure signal
// ---------------------------------------------------------------------------

/**
 * The property ytdl_hook sets, named in R07: it holds mpv's `subprocess` result
 * for the yt-dlp run and is DELETED on end-of-file, so `undefined` is the normal
 * resting value and means "nothing to say".
 */
const RESULT_PROPERTY = 'user-data/mpv/ytdl/json-subprocess-result'

function onResult(raw: unknown): void {
  const outcome = classify(raw)
  if (outcome.kind === lastOutcome.kind && outcome.kind !== 'extraction-failed') {
    lastOutcome = outcome
    pushState()
    return
  }
  lastOutcome = outcome
  pushState()

  if (outcome.kind === 'missing') {
    // An update offer here would tell the user to update something they have
    // not got. R06's answer is "bring your own", so the toast says where to put
    // it and nothing else.
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t('stream-ytdl.toastMissing')
    })
    return
  }
  if (outcome.kind !== 'extraction-failed') return

  ctx.log.warn('[stream-ytdl] extraction failed:', outcome.detail)
  if (!outcome.updateWorthy) {
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('stream-ytdl.toastFailed') })
    return
  }
  /**
   * R07's one and only moment: an extraction just failed, in a shape a newer
   * yt-dlp plausibly fixes. Non-modal, one action, no timer behind it, and this
   * is the only place in the whole application that mentions updating anything.
   */
  ctx.osd.toast({
    kind: 'error',
    message: ctx.i18n.t('stream-ytdl.toastUpdate'),
    actionLabel: ctx.i18n.t('stream-ytdl.updateNow'),
    onAction: () => {
      void ctx.commands.invoke('stream-ytdl.update')
    }
  })
}

async function doUpdate(channelArg?: unknown): Promise<void> {
  const binary = resolveBinary()
  if (!binary) {
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('stream-ytdl.toastMissing') })
    return
  }
  const wanted = String(channelArg ?? ctx.settings.get<string>('stream-ytdl.updateChannel'))
  const channel = (UPDATE_CHANNELS as readonly string[]).includes(wanted)
    ? (wanted as UpdateChannel)
    : 'nightly'

  // Explicit consent, with the exact command line shown. This is a third-party
  // binary reaching the network on the user's behalf, and §11.5's layers cannot
  // police a grandchild process — so the confirmation IS the control.
  const yes = await ctx.dialog.confirm({
    titleKey: 'stream-ytdl.updateNow',
    messageKey: 'stream-ytdl.updateConfirm',
    params: { command: `${path.basename(binary)} ${updateArgv(channel).join(' ')}`, channel },
    confirmKey: 'stream-ytdl.updateRun'
  })
  if (!yes) return

  const progress = ctx.osd.progress({ id: 'stream-ytdl.update', labelKey: 'stream-ytdl.updating' })
  const r = await run(binary, updateArgv(channel), 180_000)
  progress.done()
  version = null
  await probeVersion(true)
  ctx.osd.toast({
    kind: r.ok ? 'info' : 'error',
    message: r.ok
      ? ctx.i18n.t('stream-ytdl.updateDone', { version: version ?? '?' })
      : ctx.i18n.t('stream-ytdl.updateFailed')
  })
  if (!r.ok) ctx.log.error('[stream-ytdl] --update-to failed:', r.stderr.slice(0, 400))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function descriptors(): SettingDescriptor[] {
  return [
    {
      id: 'stream-ytdl.enabled',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-ytdl.enabled',
      descriptionKey: 'stream-ytdl.enabledDesc',
      type: { kind: 'bool' },
      // OFF. This is the zero-network-at-rest default and it is also R06's
      // "bring your own": with no yt-dlp installed, on would be a lie.
      default: false,
      keywords: ['유튜브', 'yt-dlp', 'youtube', 'site', 'stream'],
      order: 410
    },
    {
      id: 'stream-ytdl.path',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-ytdl.path',
      descriptionKey: 'stream-ytdl.pathDesc',
      // Not a plain `path` descriptor: the interesting part is the DETECTED
      // location and the version, neither of which is knowable statically, which
      // is exactly what §7's `custom` hatch is for.
      type: { kind: 'custom', rendererComponent: 'stream-ytdl.picker' },
      default: '',
      keywords: ['yt-dlp', '경로', 'path'],
      order: 420
    },
    {
      id: 'stream-ytdl.formatPreset',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-ytdl.formatPreset',
      descriptionKey: 'stream-ytdl.formatPresetDesc',
      type: { kind: 'enum', options: FORMAT_PRESETS },
      default: '',
      mpvOption: 'ytdl-format',
      keywords: ['화질', 'quality', 'format'],
      order: 430
    },
    {
      id: 'stream-ytdl.updateChannel',
      section: 'playback',
      group: 'stream',
      labelKey: 'stream-ytdl.updateChannel',
      descriptionKey: 'stream-ytdl.updateChannelDesc',
      type: {
        kind: 'enum',
        options: UPDATE_CHANNELS.map((c) => ({ value: c, labelKey: `stream-ytdl.channel.${c}` }))
      },
      // R07: the project itself calls nightly "the recommended channel for
      // regular users", and this is only ever reached from a failure toast.
      default: 'nightly',
      keywords: ['업데이트', 'update', 'nightly'],
      order: 440
    },
    {
      id: 'stream-ytdl.useManifests',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-ytdl.useManifests',
      descriptionKey: 'stream-ytdl.useManifestsDesc',
      type: { kind: 'bool' },
      default: false,
      advanced: true,
      requiresRestart: true,
      keywords: ['dash', 'hls', 'manifest'],
      order: 450
    },
    {
      id: 'stream-ytdl.rawOptions',
      section: 'advanced',
      group: 'stream',
      labelKey: 'stream-ytdl.rawOptions',
      descriptionKey: 'stream-ytdl.rawOptionsDesc',
      type: { kind: 'list', of: 'string' },
      default: [] as string[],
      mpvOption: 'ytdl-raw-options',
      advanced: true,
      requiresRestart: true,
      keywords: ['쿠키', 'cookies', 'proxy', 'geo'],
      order: 460
    }
  ]
}

const mod: FeatureModule = {
  id: 'stream-ytdl',
  // Copied verbatim from this module's row in docs/parity/modules.json.
  dependsOn: ['stream-open', 'audio-tracks'],
  ownsProperties: ['script-opts', 'ytdl', 'ytdl-format', 'ytdl-raw-options'],
  requestsProperties: ['aid', 'vid'],

  setup(c): void {
    ctx = c
    ctx.settings.define(descriptors())

    /**
     * Spawn args. Nothing here reaches a host: with `enabled` false — the
     * default — the hook is loaded and excluded from every URL, which R05
     * measured as making zero network calls.
     *
     * INTEGRATOR RESOLUTION — `--ytdl` IS NOT CONTRIBUTED, and the doc was right.
     *
     * This module shipped `ytdlArg()` (`--ytdl=yes`) in this list, reasoning that
     * §4 of `02-wave0-api.md` calls `--ytdl` core-reserved but
     * `CORE_RESERVED_OPTIONS` in `core/mpv/reserved.ts` does not list it, so the
     * doc must be stale. `CORE_RESERVED_OPTIONS` was the wrong list to grep:
     * core does not reserve `--ytdl` through that table, it CONTRIBUTES it
     * directly at `src/main/index.ts:587` as `--ytdl=no`, under a comment that
     * names R05 by number. Measured on the packaged build, the result was a hard
     * boot failure that took down all nine Wave-1 modules and the app with them:
     *
     *   [boot] RLPlayer failed to start: ContributionError: spawn-arg collision
     *   on '--ytdl': contributed by both 'core/mpv/bus' and 'stream-ytdl'.
     *
     * Resolving it the other way — letting the module win — is what makes this
     * worth the paragraph. `ytdlArg()` is unconditional, so every launch would
     * have loaded `ytdl_hook.lua`, and the product's headline promise would rest
     * on the Lua exclude regex `ytdl_hook-exclude=.*` being right rather than on
     * the network hook not being present. Zero-network-at-rest is kept
     * STRUCTURAL: core's `--ytdl=no` stands and the hook is never loaded.
     *
     * The cost is real and is not hidden: R05's enable-without-restart cannot
     * work, because a property cannot retroactively load a script that was never
     * loaded — which is exactly what R05 measured. Enabling yt-dlp needs core to
     * make `--ytdl` conditional. That is an API gap, not a module bug: the arg
     * system is additive and collision-rejecting, and offers no way for a module
     * to override a core-contributed default even for a property it owns
     * (`ownsProperties` includes `ytdl` here). `ytdlArg()` is kept exported and
     * tested so the day core gains that hook, the value is already pinned.
     */
    ctx.mpv.contributeArgs(30, () => {
      const args: string[] = []
      const binary = resolveBinary()
      args.push(
        ...hookArgs({
          enabled: ctx.settings.get<boolean>('stream-ytdl.enabled'),
          ytdlPath: binary ?? '',
          allFormats: true,
          useManifests: ctx.settings.get<boolean>('stream-ytdl.useManifests')
        })
      )
      const preset = ctx.settings.get<string>('stream-ytdl.formatPreset')
      // R09: "An empty value or `ytdl` does not pass a --format option at all",
      // so an empty preset contributes nothing rather than `--ytdl-format=`.
      if (preset.length > 0) args.push(`--ytdl-format=${preset}`)
      args.push(...rawOptionArgs(validatedRawOptions()))
      return args
    })

    // ---------------------------------------------------------------------
    // R05: the runtime toggle, so enabling needs no restart
    // ---------------------------------------------------------------------
    ctx.settings.onChange<boolean>('stream-ytdl.enabled', (on) => {
      void (async (): Promise<void> => {
        try {
          // `change-list` NAMES `script-opts`, which this module owns, so the
          // §2.2 guard checks it like any other write.
          await ctx.mpv.command(toggleCommand(on))
        } catch (e) {
          ctx.log.error('[stream-ytdl] could not toggle ytdl_hook:', (e as Error).message)
          return
        }
        if (on && resolveBinary() === null) {
          ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('stream-ytdl.toastMissing') })
        }
        pushState()
      })()
    })

    ctx.settings.onChange<string>('stream-ytdl.formatPreset', (v) => {
      void (async (): Promise<void> => {
        try {
          // R09: takes effect on the NEXT loadfile, which the UI says.
          await ctx.mpv.set('ytdl-format', v)
        } catch (e) {
          ctx.log.warn('[stream-ytdl] ytdl-format:', (e as Error).message)
        }
      })()
    })

    // ---------------------------------------------------------------------
    // Observers. Reads only — `observe` never checks ownership.
    // ---------------------------------------------------------------------
    unsubs.push(ctx.mpv.observe(RESULT_PROPERTY, onResult))

    /**
     * R08: the quality menu IS the track menu, and R22 already established that
     * a network source's tracks appear LATE. So observe rather than snapshot,
     * exactly as M35 does for its own list.
     */
    unsubs.push(
      ctx.mpv.observe('track-list', (list) => {
        quality = qualityOptions(list)
        pushState()
      })
    )

    // ---------------------------------------------------------------------
    // IPC
    // ---------------------------------------------------------------------
    ctx.ipc.handle<void, YtdlState>('stream-ytdl:getState', () => currentState())
    ctx.ipc.on<void>('stream-ytdl:detect', () => {
      void probeVersion(true)
    })
    ctx.ipc.on<{ id: number; kind: 'video' | 'audio' }>('stream-ytdl:selectQuality', (req) => {
      if (!req) return
      void ctx.commands.invoke('stream-ytdl.selectQuality', req)
    })
    ctx.ipc.on<void>('stream-ytdl:update', () => {
      void doUpdate()
    })

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------
    ctx.commands.register([
      {
        id: 'stream-ytdl.toggle',
        labelKey: 'stream-ytdl.enabled',
        category: 'playback',
        // No default accelerator: this is a per-machine capability toggle, not
        // something to bind to a key. It is in the menu instead.
        menuPath: 'playback',
        menuOrder: 17,
        run: () => {
          const on = !ctx.settings.get<boolean>('stream-ytdl.enabled')
          ctx.settings.set<boolean>('stream-ytdl.enabled', on)
        }
      },
      {
        /**
         * R08. `vid` and `aid` are M11's and are ONE decision on an EDL-backed
         * source, so this goes through `audio-tracks.selectStreamFormat` rather
         * than two `requestSet` calls that could interleave.
         */
        id: 'stream-ytdl.selectQuality',
        labelKey: 'stream-ytdl.selectQuality',
        category: 'playback',
        internal: true,
        run: async (arg) => {
          const a = (arg ?? {}) as { id?: unknown; kind?: unknown }
          const id = Number(a.id)
          if (!Number.isFinite(id)) return
          const payload = a.kind === 'audio' ? { aid: id } : { vid: id }
          await ctx.commands.invoke('audio-tracks.selectStreamFormat', payload)
          // R08's measured caveat, said out loud: "Switching vid/aid on an EDL
          // re-opens the underlying stream — expect a visible rebuffer; show the
          // buffering indicator, do not pretend it is instant."
          ctx.osd.show({ kind: 'track', text: ctx.i18n.t('stream-ytdl.switching') })
        }
      },
      {
        id: 'stream-ytdl.update',
        labelKey: 'stream-ytdl.updateNow',
        category: 'playback',
        // Internal: R07 says this is reachable from a failure toast and from the
        // settings page, and from nowhere else. A keybindable "update yt-dlp"
        // is one keypress away from being the nag this product refuses.
        internal: true,
        run: (arg) => doUpdate(arg)
      },
      {
        id: 'stream-ytdl.detect',
        labelKey: 'stream-ytdl.detect',
        category: 'playback',
        internal: true,
        run: () => probeVersion(true)
      }
    ])

    ctx.i18n.register('ko', {
      'stream-ytdl.enabled': '사이트 주소를 yt-dlp로 열기',
      'stream-ytdl.enabledDesc':
        '끄면 yt-dlp를 전혀 실행하지 않습니다. 기본값은 꺼짐이고, 꺼진 상태에서는 네트워크 요청이 ' +
        '한 건도 발생하지 않습니다. yt-dlp는 함께 배포하지 않습니다 — 공식 실행 파일은 GPLv3+이고 ' +
        '이 앱은 MIT입니다.',
      'stream-ytdl.path': 'yt-dlp 실행 파일',
      'stream-ytdl.pathDesc':
        "찾는 순서: 프로필의 tools\\yt-dlp.exe → 프로그램 폴더의 tools\\yt-dlp.exe → 여기 지정한 " +
        '경로 → PATH → WinGet/scoop. --no-config 로 실행하므로 절대 경로여야 합니다.',
      'stream-ytdl.detect': 'yt-dlp 다시 찾기',
      'stream-ytdl.selectQuality': '화질 선택',
      'stream-ytdl.switching': '화질을 바꾸는 중… 다시 버퍼링됩니다',
      'stream-ytdl.formatPreset': 'yt-dlp 화질 지정',
      'stream-ytdl.formatPresetDesc':
        '비워 두면 yt-dlp 기본값을 씁니다. 다음에 열 때부터 적용됩니다. 재생 중 화질 전환은 ' +
        '트랙 메뉴에서 하세요 — 그쪽이 실제 화질 목록입니다.',
      'stream-ytdl.format.auto': '자동 (yt-dlp 기본값)',
      'stream-ytdl.format.h264_1080': '1080p 이하 · H.264',
      'stream-ytdl.format.p1080': '1080p 이하',
      'stream-ytdl.format.p720': '720p 이하',
      'stream-ytdl.format.audioOnly': '소리만',
      'stream-ytdl.updateChannel': 'yt-dlp 업데이트 채널',
      'stream-ytdl.updateChannelDesc':
        '실패했을 때만 물어봅니다. 정기 확인, 백그라운드 작업, 시작 시 확인은 없습니다.',
      'stream-ytdl.channel.stable': '안정판',
      'stream-ytdl.channel.nightly': '나이틀리 (권장)',
      'stream-ytdl.useManifests': 'DASH/HLS 매니페스트 직접 사용',
      'stream-ytdl.useManifestsDesc':
        'ytdl_hook의 use_manifests 옵션입니다. 상위 프로젝트에서 기본으로 꺼 둔 이유가 있으니 ' +
        '문제가 있을 때만 켜세요.',
      'stream-ytdl.rawOptions': 'yt-dlp 추가 옵션',
      'stream-ytdl.rawOptionsDesc':
        '앞의 하이픈 없이 한 줄에 하나씩. 값이 없는 옵션은 뒤에 = 를 붙여야 합니다 ' +
        '(예: force-ipv6=). 검사하지 않으므로 잘못 쓰면 재생이 깨질 수 있습니다.',
      'stream-ytdl.privacyWarning':
        '쿠키·계정 옵션이 들어 있습니다. cookies-from-browser 는 브라우저의 쿠키 데이터베이스를 ' +
        '읽습니다 — 필요한 사이트에만 쓰세요.',
      'stream-ytdl.toastMissing':
        'yt-dlp를 찾을 수 없습니다. 프로필의 tools 폴더에 yt-dlp.exe를 넣거나 경로를 지정해 주세요.',
      'stream-ytdl.toastFailed': '이 주소에서 재생 정보를 가져오지 못했습니다.',
      'stream-ytdl.toastUpdate':
        '사이트가 바뀌어 정보를 가져오지 못한 것 같습니다. yt-dlp를 최신으로 올려보시겠어요?',
      'stream-ytdl.updateNow': 'yt-dlp 업데이트',
      'stream-ytdl.updateConfirm':
        'yt-dlp가 스스로 업데이트합니다. 실행할 명령: {command}. 이 앱에는 자동 업데이트가 없고, ' +
        '이 창은 눌렀을 때만 나옵니다.',
      'stream-ytdl.updateRun': '실행',
      'stream-ytdl.updating': 'yt-dlp 업데이트 중…',
      'stream-ytdl.updateDone': 'yt-dlp가 {version} 으로 업데이트되었습니다',
      'stream-ytdl.updateFailed': 'yt-dlp 업데이트가 실패했습니다. 로그를 확인해 주세요.',
      'stream-ytdl.notesTitle': 'yt-dlp',
      'stream-ytdl.noteLicense':
        'yt-dlp는 함께 배포하지 않습니다. 소스는 Unlicense지만 공식 실행 파일은 GPLv3+이고, ' +
        'MIT 앱의 압축 파일에 넣는 것은 좋은 선택이 아닙니다. 직접 받아 두시면 됩니다.',
      'stream-ytdl.noteUpdate':
        'yt-dlp는 스스로 업데이트합니다. 이 앱은 추출이 실제로 실패한 순간에만 한 번 물어보고, ' +
        '정기 확인이나 백그라운드 작업은 하지 않습니다.',
      'stream-ytdl.noteQuality':
        '화질 목록은 트랙 목록과 같습니다. 사이트가 형식을 나눠 주지 않으면 (HLS 마스터 재생 목록이 ' +
        '대표적입니다) 화질이 하나만 보이는 것이 정상입니다.',
      'stream-ytdl.statusFound': '찾았습니다: {path}',
      'stream-ytdl.statusVersion': '버전 {version}',
      'stream-ytdl.statusMissing': '찾지 못했습니다',
      'stream-ytdl.qualityTitle': '화질',
      'stream-ytdl.qualitySingle': '이 주소는 화질이 하나입니다 (정상)'
    })

    ctx.i18n.register('en', {
      'stream-ytdl.enabled': 'Open site URLs with yt-dlp',
      'stream-ytdl.enabledDesc':
        'Off means yt-dlp is never run. Off is the default, and while it is off this app makes ' +
        'no network request at all. yt-dlp is not bundled: its source is Unlicense but the ' +
        'official executables are GPLv3+, and this app is MIT.',
      'stream-ytdl.path': 'yt-dlp executable',
      'stream-ytdl.pathDesc':
        'Search order: profile tools\\yt-dlp.exe, then the program folder\'s tools\\yt-dlp.exe, ' +
        'then this path, then PATH, then WinGet and scoop. Must be absolute, because mpv runs ' +
        'with --no-config.',
      'stream-ytdl.detect': 'Look for yt-dlp again',
      'stream-ytdl.selectQuality': 'Choose quality',
      'stream-ytdl.switching': 'Switching quality — this rebuffers',
      'stream-ytdl.formatPreset': 'yt-dlp format',
      'stream-ytdl.formatPresetDesc':
        'Leave empty to use yt-dlp\'s own default. Takes effect on the next open. To change ' +
        'quality during playback use the track menu — that list IS the quality list.',
      'stream-ytdl.format.auto': 'Automatic (yt-dlp default)',
      'stream-ytdl.format.h264_1080': 'Up to 1080p · H.264',
      'stream-ytdl.format.p1080': 'Up to 1080p',
      'stream-ytdl.format.p720': 'Up to 720p',
      'stream-ytdl.format.audioOnly': 'Audio only',
      'stream-ytdl.updateChannel': 'yt-dlp update channel',
      'stream-ytdl.updateChannelDesc':
        'Only ever offered after a failure. No periodic check, no background task, no check at ' +
        'launch.',
      'stream-ytdl.channel.stable': 'Stable',
      'stream-ytdl.channel.nightly': 'Nightly (recommended)',
      'stream-ytdl.useManifests': 'Use DASH/HLS manifests directly',
      'stream-ytdl.useManifestsDesc':
        "ytdl_hook's use_manifests option. Upstream keeps it off for a reason; turn it on only " +
        'when a site misbehaves without it.',
      'stream-ytdl.rawOptions': 'Extra yt-dlp options',
      'stream-ytdl.rawOptionsDesc':
        'One per line, with no leading dashes. A flag-style option needs a trailing "=" ' +
        '(e.g. force-ipv6=). Nothing is sanity-checked, so a wrong option can break playback.',
      'stream-ytdl.privacyWarning':
        'These options include cookies or credentials. cookies-from-browser reads your ' +
        "browser's cookie database — use it only for the sites that need it.",
      'stream-ytdl.toastMissing':
        'yt-dlp was not found. Put yt-dlp.exe in the profile\'s tools folder, or set its path.',
      'stream-ytdl.toastFailed': 'Could not get playback information for that address.',
      'stream-ytdl.toastUpdate':
        'That looks like the site changed under yt-dlp. Update yt-dlp and try again?',
      'stream-ytdl.updateNow': 'Update yt-dlp',
      'stream-ytdl.updateConfirm':
        'yt-dlp updates itself. The command that will run: {command}. This app has no ' +
        'auto-update, and this prompt only ever appears because you asked.',
      'stream-ytdl.updateRun': 'Run it',
      'stream-ytdl.updating': 'Updating yt-dlp…',
      'stream-ytdl.updateDone': 'yt-dlp updated to {version}',
      'stream-ytdl.updateFailed': 'The yt-dlp update failed — see the log.',
      'stream-ytdl.notesTitle': 'yt-dlp',
      'stream-ytdl.noteLicense':
        'yt-dlp is not bundled. Its source is Unlicense, but the published executables are ' +
        "GPLv3+, and shipping one inside an MIT app's ZIP is at best mere aggregation. Install " +
        'it yourself and point this at it.',
      'stream-ytdl.noteUpdate':
        'yt-dlp updates itself. This app asks once, at the moment an extraction actually ' +
        'fails, and never checks on a timer or in the background.',
      'stream-ytdl.noteQuality':
        'The quality list is the track list. When a site does not split formats — an HLS ' +
        'master playlist is the usual case — seeing one quality is correct, not a bug.',
      'stream-ytdl.statusFound': 'Found: {path}',
      'stream-ytdl.statusVersion': 'Version {version}',
      'stream-ytdl.statusMissing': 'Not found',
      'stream-ytdl.qualityTitle': 'Quality',
      'stream-ytdl.qualitySingle': 'This source has a single quality (normal)'
    })
  },

  dispose(): void {
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
