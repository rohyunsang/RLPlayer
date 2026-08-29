import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildProperties, buildPropertiesFromProbe } from './properties.ts'
import { EN, KO } from './i18n.ts'
import { MediaProbe, type FileStat, type ProbeDeps, type ProbeEngine } from './probe.ts'
import { DIAGNOSTIC_PROPERTIES, renderInfoAsText } from './report.ts'
import { findSidecarArt, toFileUrl } from './art.ts'
import { buildInvocation } from './shell-props.ts'
import {
  LIVE_PROPERTIES,
  STATIC_PROPERTIES,
  buildState,
  type Props,
  type SnapshotOptions
} from './snapshot.ts'
import { textOr } from './format.ts'
import type { FeatureContext, FeatureModule, Unsubscribe } from '@shared/feature-api'
import type { InfoDensity, InfoTab, MediaInfoState, ProbeSummary } from '@shared/features/mediainfo/wire'

/**
 * M29 mediainfo -- the media-info panel, the stats sections, the file-properties
 * view and the headless probe (L21-L29, L40, L43-L45, A45, N26, R34, U06, U47,
 * V55).
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY OVER MPV, AND THAT IS THE WHOLE SHAPE OF THIS MODULE
 * ---------------------------------------------------------------------------
 * `docs/parity/modules.json` gives M29 `ownedProperties: []`. That is not an
 * oversight: an info panel that writes a property is a panel that changes what
 * it is measuring. So this module reads (`observe` / `peek` / `get` are
 * unrestricted, section 2) and owns three COMMANDS instead --
 * `script-binding`, `script-message`, `script-message-to` -- because U06 and L45
 * drive mpv's own built-in stats overlay through `script-binding`, and section
 * 2.1 measured that command as state-mutating and owned by nobody.
 *
 * The one property write this module would like is L28's, and it cannot make it:
 * `audio-display` / `cover-art-auto` / `cover-art-whitelist` are M11's, and L28
 * says so in as many words ("These three are M11's spawn args, not M29's -- M29
 * is read-only over mpv; it requests them"). It is requested through
 * `ctx.mpv.requestSet()`, a refusal is a normal outcome, and the refusal path is
 * exercised by a test. See `requestOwnCoverArt` for what was measured.
 *
 * ---------------------------------------------------------------------------
 * ONE SNAPSHOT, FOUR SURFACES
 * ---------------------------------------------------------------------------
 * `snapshot.ts` is a pure function from a property bag to a render model. The
 * panel (L23/L24/L26), the stats sections (V55/A45/N26/R34), U47's three
 * densities and the clipboard report (L25) are four PROJECTIONS of that one
 * object, so "the copy in my bug report disagrees with the panel in my
 * screenshot" is not a state this module can reach.
 *
 * ---------------------------------------------------------------------------
 * WHAT COSTS WHAT
 * ---------------------------------------------------------------------------
 * `STATIC_PROPERTIES` are observed for the whole session -- `observe` is
 * refcounted, so watching `track-list` costs nothing extra when the playlist
 * already does. `LIVE_PROPERTIES` change every frame (`estimated-frame-number`
 * changes 60 times a second) and are pulled with `get()` on a tick that only
 * runs while something is looking: the panel being open, or a stats section
 * having asked inside the last few seconds. That is section 10's refresh
 * contract applied to the main half: "Everything stops while the panel is
 * hidden."
 */

const SLICE_KEY = 'mediainfo'
const PROBE_CACHE_FILE = 'mediainfo-probe.json'
/** How long a stats `fields()` call keeps the live tick alive after it stops. */
const LIVE_GRACE_MS = 4000

let ctx: FeatureContext

const offs: Unsubscribe[] = []

/** Last value seen for every LIVE property. Merged over the observed ones. */
let live: Record<string, unknown> = {}
let liveTimer: ReturnType<typeof setInterval> | null = null
/** Wall clock of the last `mediainfo:snapshot` invoke from a stats section. */
let lastStatsPull = 0

let panelOpen = false
let density: InfoDensity = 'full'
let tab: InfoTab = 'info'

let artUrl: string | null = null
let properties: MediaInfoState['properties'] = null

let probe: MediaProbe | null = null
/** The child holding L27's shell dialog open. At most one, ever. */
let shellChild: TrackedChild | null = null

/**
 * The shape `LifecycleService.trackProcess` declares.
 *
 * Node's `ChildProcess.kill` is typed `(signal?: NodeJS.Signals | number)`,
 * which is not assignable to the API's `(signal?: string)`, so the child is
 * adapted rather than cast: `trackProcess` only ever calls `kill()` with no
 * argument, and writing the adapter says so instead of a `as unknown as`
 * hiding it.
 */
interface TrackedChild {
  pid?: number | undefined
  kill(signal?: string): boolean
}

let disposed = false

// ---------------------------------------------------------------------------
// The property bag
// ---------------------------------------------------------------------------

/**
 * Everything the render model reads, in one object.
 *
 * `peek()` for the observed half and the cached live half for the rest. `peek`
 * returning `undefined` is a REAL answer (section 3: mpv reports "property
 * unavailable" for `audio-params` on a video-only file), and every formatter in
 * `format.ts` takes `unknown` for exactly that reason. Nothing here coerces.
 */
function props(): Props {
  const out: Record<string, unknown> = {}
  for (const name of STATIC_PROPERTIES) out[name] = ctx.mpv.peek(name)
  for (const name of LIVE_PROPERTIES) out[name] = live[name]
  return out
}

function snapshotOptions(): SnapshotOptions {
  return {
    open: panelOpen,
    density,
    tab,
    showApproxFrames: ctx.settings.get<boolean>('mediainfo.showApproxFrames') === true,
    artUrl: ctx.settings.get<boolean>('mediainfo.albumArt') === true ? artUrl : null,
    properties,
    now: Date.now()
  }
}

function state(): MediaInfoState {
  return buildState(props(), snapshotOptions())
}

function push(): void {
  if (disposed) return
  ctx.ipc.send('mediainfo:state', state())
}

// ---------------------------------------------------------------------------
// The live tick
// ---------------------------------------------------------------------------

function liveWanted(): boolean {
  return panelOpen || Date.now() - lastStatsPull < LIVE_GRACE_MS
}

async function pullLive(): Promise<void> {
  const next: Record<string, unknown> = {}
  await Promise.all(
    LIVE_PROPERTIES.map(async (name) => {
      // A rejection is "property unavailable", which is a value. Swallowing it
      // to `undefined` is correct; letting it reject would abandon the rest.
      next[name] = await ctx.mpv.get(name).catch(() => undefined)
    })
  )
  live = next
}

function retickLive(): void {
  const wanted = liveWanted()
  if (wanted && liveTimer === null) {
    const every = Math.max(200, ctx.settings.get<number>('mediainfo.refreshMs'))
    liveTimer = setInterval(() => {
      if (!liveWanted()) {
        retickLive()
        return
      }
      void pullLive().then(() => {
        if (panelOpen) push()
      })
    }, every)
    liveTimer.unref?.()
    // Fire once immediately: a panel that opens blank for half a second reads
    // as broken, and the tick's first edge is up to `refreshMs` away.
    void pullLive().then(() => {
      if (panelOpen) push()
    })
  } else if (!wanted && liveTimer !== null) {
    clearInterval(liveTimer)
    liveTimer = null
  }
}

// ---------------------------------------------------------------------------
// L28 / L29 -- cover art
// ---------------------------------------------------------------------------

/**
 * L28, and the ownership wall it runs into.
 *
 * The row wants `--audio-display=no` set when we draw the cover ourselves
 * ("otherwise you get mpv's copy behind ours"). That property is M11's, and M11
 * registers an arbiter for `aid` only. `docs/parity/modules.json` records a
 * mediator, `audio-tracks.setTrackAutoSelection`, covering exactly these three
 * properties -- and that command exists in the manifest and NOWHERE IN `src/`.
 * Measured:
 *
 *     grep -rn setTrackAutoSelection src/   ->  no matches
 *
 * So both sanctioned paths are closed today, and the module has to behave
 * correctly with the request refused -- which is what section 2 says a caller
 * must do anyway ("refusal is a NORMAL outcome and your caller must handle
 * it"). It asks, logs the refusal once per file, and draws its own art
 * regardless. Nothing here falls through to a raw write.
 */
async function requestOwnCoverArt(): Promise<void> {
  if (ctx.settings.get<boolean>('mediainfo.albumArt') !== true) return
  if (artUrl === null) return
  const r = await ctx.mpv.requestSet(
    'audio-display',
    'no',
    'L28: mediainfo draws the cover art in the overlay, so mpv must not draw its own behind it'
  )
  if (!r.ok) {
    ctx.log.warn(
      `audio-display request refused (${r.reason}); mpv's own cover art may show behind ours`
    )
  }
}

function findArt(file: string | null): void {
  artUrl = null
  if (file === null || file.length === 0) return
  if (ctx.settings.get<boolean>('mediainfo.albumArt') !== true) return
  if (ctx.mpv.isNetworkSource) return
  const hit = findSidecarArt(file, {
    readDir: (dir) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return null
      }
    },
    join: (dir, name) => path.join(dir, name)
  })
  if (hit === null) return
  artUrl = toFileUrl(hit)
}

// ---------------------------------------------------------------------------
// L22 / L21 -- the probe
// ---------------------------------------------------------------------------

function probeCachePath(): string {
  return path.join(ctx.paths.cacheDir(), PROBE_CACHE_FILE)
}

/**
 * The probe cache is a CACHE FILE, not per-file state, and that distinction is
 * the reason the section 15 checklist ("per-file state goes through a slice,
 * never through your own JSON file") is not being broken here.
 *
 * A slice is keyed to the file that is PLAYING: `ctx.perFile.slice()` captures
 * and applies for the current file only. L21's whole subject is files that are
 * NOT playing -- 500 playlist rows -- and `PerFileService` has `sliceFor(file)`
 * and `slicesFor(file)` to READ another file's slices and no way at all to
 * WRITE one. So a probe result for a file nobody has opened is inexpressible as
 * a slice. It also should not be one: it is derived data that a re-encode
 * invalidates, which is why the key is `path + size + mtimeMs` (L21) and why it
 * lives under `cacheDir()`, where losing it costs one re-probe.
 */
function readProbeCache(): Record<string, ProbeSummary> {
  try {
    const raw = fs.readFileSync(probeCachePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, ProbeSummary>
  } catch {
    // A missing or corrupt cache is not an error worth a log line: the next
    // probe rebuilds it.
    return {}
  }
}

let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingCache: Record<string, ProbeSummary> | null = null

function writeProbeCacheSoon(entries: Record<string, ProbeSummary>): void {
  pendingCache = entries
  if (cacheWriteTimer !== null) return
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null
    const data = pendingCache
    pendingCache = null
    if (data === null) return
    try {
      fs.mkdirSync(ctx.paths.cacheDir(), { recursive: true })
      const tmp = `${probeCachePath()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
      fs.renameSync(tmp, probeCachePath())
    } catch (e) {
      ctx.log.warn('probe cache write failed:', (e as Error).message)
    }
  }, 1000)
  cacheWriteTimer.unref?.()
}

function statFor(p: string): FileStat | null {
  try {
    const s = fs.statSync(p)
    if (!s.isFile()) return null
    return { size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }
  } catch {
    return null
  }
}

function probeDeps(): ProbeDeps {
  return {
    spawn: async (): Promise<ProbeEngine> =>
      await ctx.engine.spawn({
        purpose: 'probe',
        // L22's argument list, minus the six core always applies (`--no-config`,
        // `--idle=yes`, `--terminal=no`, `--msg-level=all=no`,
        // `--load-scripts=no`, `--ytdl=no`) and minus `--input-ipc-server`,
        // whose RANDOM pipe name L22 calls mandatory and which core generates.
        args: MediaProbe.engineArgs(),
        idleTimeoutMs: Math.max(0, ctx.settings.get<number>('mediainfo.probeIdleSec') * 1000)
      }),
    stat: statFor,
    timeoutMs: () => ctx.settings.get<number>('mediainfo.probeTimeoutMs'),
    idleMs: () => ctx.settings.get<number>('mediainfo.probeIdleSec') * 1000,
    enabled: () => ctx.settings.get<boolean>('mediainfo.probeEnabled') === true,
    log: ctx.log,
    restore: readProbeCache,
    persist: writeProbeCacheSoon
  }
}

function theProbe(): MediaProbe {
  probe ??= new MediaProbe(probeDeps())
  return probe
}

// ---------------------------------------------------------------------------
// L25 -- the clipboard report
// ---------------------------------------------------------------------------

/**
 * The diagnostics block, under the LITERAL mpv property names.
 *
 * L25: "Include `hwdec-current`, `current-vo`, `video-params/pixelformat` and
 * `mpv-version` -- those four are what make a rendering bug report actionable."
 * A translated label satisfies the letter of that and none of its purpose: a
 * maintainer greps a pasted report for `hwdec-current`, not for
 * `하드웨어 디코더`. `report.test.ts` asserts the four names survive in both
 * languages.
 */
function diagnostics(): Record<string, string> {
  const p = props()
  const vp = p['video-params']
  const out: Record<string, string> = {}
  for (const name of DIAGNOSTIC_PROPERTIES) {
    const value =
      name === 'video-params/pixelformat'
        ? textOr(
            vp !== null && typeof vp === 'object'
              ? (vp as Record<string, unknown>)['pixelformat']
              : undefined
          )
        : textOr(p[name])
    out[name] = value
  }
  return out
}

function reportText(): string {
  return renderInfoAsText(state(), (k, params) => ctx.i18n.t(k, params), {
    diagnostics: diagnostics(),
    includeTags: ctx.settings.get<boolean>('mediainfo.copyIncludesTags') === true,
    includeTrackDetail: ctx.settings.get<boolean>('mediainfo.copyIncludesTrackDetail') === true
  })
}

/**
 * L25. `async` because `ctx.shell.copyText` is: Electron 44's
 * `clipboard.writeText` returns a Promise, and the un-awaited call this
 * replaced would have swallowed a clipboard failure into an unhandled
 * rejection while the toast said "copied".
 */
async function copyInfo(): Promise<void> {
  const s = state()
  if (!s.available) {
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('mediainfo.noFile') })
    return
  }
  try {
    await ctx.shell.copyText(reportText())
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('mediainfo.copied')
    })
  } catch (e) {
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t('mediainfo.copyFailed', { reason: (e as Error).message })
    })
  }
}

// ---------------------------------------------------------------------------
// L26 / L27 -- the properties views
// ---------------------------------------------------------------------------

function openProperties(): void {
  const s = buildProperties(state(), { stat: statFor })
  if (s === null) {
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('mediainfo.noFile') })
    return
  }
  properties = s
  panelOpen = true
  tab = 'properties'
  retickLive()
  push()
  ctx.osd.show({ kind: 'info', text: ctx.i18n.t('mediainfo.fileProperties') })
}

/**
 * L27, through the row's own documented PowerShell fallback.
 *
 * The koffi route (`SHObjectProperties`) needs a dependency this module may not
 * add, and the row's two gotchas are both handled by the fallback: the modal
 * message loop belongs to a separate process rather than to Electron's main
 * thread, and the `Start-Sleep` is what keeps the dialog alive, which is why the
 * child is tracked and killed on quit.
 *
 * The path never reaches the script as source -- see `shell-props.ts`.
 */
function openShellProperties(): void {
  const file = state().path
  const invocation = file === null ? null : buildInvocation(file)
  if (invocation === null) {
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('mediainfo.shellUnavailable') })
    return
  }
  // One dialog at a time. Two `Start-Sleep -Seconds 3600` children is two hours
  // of held processes for one user mistake.
  if (shellChild !== null) {
    try {
      shellChild.kill()
    } catch {
      /* already gone */
    }
    shellChild = null
  }
  try {
    const child = spawn(invocation.file, invocation.args, {
      env: { ...process.env, ...invocation.env },
      windowsHide: true,
      stdio: 'ignore',
      detached: false
    })
    child.on('error', (e) => {
      ctx.log.warn('shell properties failed:', e.message)
      shellChild = null
    })
    child.on('exit', () => {
      shellChild = null
    })
    const tracked: TrackedChild = {
      pid: child.pid,
      kill: (signal) => (signal === undefined ? child.kill() : child.kill(signal as never))
    }
    shellChild = tracked
    // Tracked so the registry kills it on quit or crash: an orphan holding a
    // modal dialog outlives the app that opened it.
    ctx.lifecycle.trackProcess(tracked)
  } catch (e) {
    ctx.log.warn('shell properties spawn threw:', (e as Error).message)
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('mediainfo.shellUnavailable') })
  }
}

// ---------------------------------------------------------------------------
// U06 / L45 -- mpv's own stats overlay
// ---------------------------------------------------------------------------

let mpvStatsPage = 1

/**
 * U06/L45. `script-binding` is this module's command (section 2.1: it is
 * state-mutating, named in the spec for M29, and was owned by nobody).
 *
 * Core spawns the playing mpv with `--load-scripts=no`, and L45 records the
 * measurement that matters here: `--load-stats-overlay=yes` is the default and
 * is **not** disabled by `--load-scripts=no`. So nothing is contributed for it;
 * a spawn arg would be a property write for a property M29 does not own and the
 * manifest does not record. If mpv ever refuses the binding, the user is told
 * rather than left with a dead key.
 */
async function mpvStats(binding: string): Promise<void> {
  try {
    await ctx.mpv.command(['script-binding', binding])
    ctx.osd.show({ kind: 'info', text: ctx.i18n.t('mediainfo.mpvStatsHint') })
  } catch (e) {
    ctx.log.warn(`script-binding ${binding} failed:`, (e as Error).message)
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('mediainfo.mpvStatsUnavailable') })
  }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const mod: FeatureModule = {
  id: 'mediainfo',
  dependsOn: ['core-mpv-bus', 'audio-tracks'],
  /**
   * Section 2.1's seventeen unclassified commands: `script-binding`,
   * `script-message` and `script-message-to` were assigned to M29 because the
   * only loadable scripts are mpv's built-in stats and select overlays, and
   * both are this module's diagnostics surface (U06, L45).
   */
  ownsCommands: ['script-binding', 'script-message', 'script-message-to'],
  /** L28. Requested, never written; see `requestOwnCoverArt`. */
  requestsProperties: ['audio-display', 'cover-art-auto', 'cover-art-whitelist'],

  setup(c): void {
    ctx = c

    // -- settings ---------------------------------------------------------
    ctx.settings.define([
      {
        id: 'mediainfo.showApproxFrames',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.showApproxFrames',
        descriptionKey: 'mediainfo.approxNote',
        type: { kind: 'bool' },
        default: false,
        mpvOption: 'estimated-frame-number',
        keywords: ['프레임', 'frame', 'estimate', '추정'],
        order: 10
      },
      {
        id: 'mediainfo.albumArt',
        section: 'audio',
        group: 'mediainfo',
        labelKey: 'mediainfo.albumArt',
        type: { kind: 'bool' },
        default: true,
        keywords: ['앨범 아트', 'cover', 'art', '커버'],
        order: 60
      },
      {
        id: 'mediainfo.refreshMs',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.refreshMs',
        type: { kind: 'int', min: 200, max: 5000, step: 100 },
        default: 500,
        keywords: ['갱신', 'refresh', 'interval'],
        order: 11
      },
      {
        id: 'mediainfo.probeEnabled',
        section: 'general',
        group: 'mediainfo',
        labelKey: 'mediainfo.probeEnabled',
        descriptionKey: 'mediainfo.probeEnabled.desc',
        type: { kind: 'bool' },
        default: true,
        keywords: ['길이', 'duration', 'probe', '재생목록'],
        order: 50
      },
      {
        id: 'mediainfo.probeTimeoutMs',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.probeTimeoutMs',
        // L22 says 2 s, and the reason it is a setting is a disconnected
        // network share, where the OS blocks `file-loaded` for as long as it
        // likes and the honest fix is the user's own patience.
        type: { kind: 'int', min: 500, max: 20000, step: 500 },
        default: 2000,
        keywords: ['제한 시간', 'timeout', 'probe'],
        order: 12
      },
      {
        id: 'mediainfo.probeIdleSec',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.probeIdleSec',
        type: { kind: 'int', min: 0, max: 600, step: 10 },
        default: 60,
        keywords: ['probe', 'idle', '종료'],
        order: 13
      },
      {
        id: 'mediainfo.copyIncludesTags',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.copyIncludesTags',
        type: { kind: 'bool' },
        default: false,
        keywords: ['태그', 'tags', 'copy'],
        order: 14
      },
      {
        id: 'mediainfo.copyIncludesTrackDetail',
        section: 'advanced',
        group: 'mediainfo',
        labelKey: 'mediainfo.copyIncludesTrackDetail',
        type: { kind: 'bool' },
        default: false,
        keywords: ['트랙', 'tracks', 'copy'],
        order: 15
      }
    ])

    offs.push(
      ctx.settings.onChange<boolean>('mediainfo.albumArt', () => {
        findArt(ctx.mpv.peek<string>('path') ?? null)
        push()
      }),
      ctx.settings.onChange<boolean>('mediainfo.showApproxFrames', () => push()),
      ctx.settings.onChange<number>('mediainfo.refreshMs', () => {
        // Rebuild the interval rather than waiting for the next tick: the point
        // of lowering it is seeing the effect.
        if (liveTimer !== null) {
          clearInterval(liveTimer)
          liveTimer = null
        }
        retickLive()
      })
    )

    // -- observation ------------------------------------------------------
    /**
     * L23: "Observe, do not poll: VIDEO_RECONFIG fires property-change for
     * `video-params`/`dwidth`/`container-fps`/`current-vo`/`track-list`;
     * AUDIO_RECONFIG for `audio-params`/`audio-bitrate`/`current-ao`."
     *
     * One observer per name, coalesced into one push per frame of event
     * traffic: a file load moves twenty of these inside a few milliseconds and
     * twenty IPC sends of the same object is twenty repaints.
     */
    let pushQueued = false
    const pushSoon = (): void => {
      if (pushQueued || disposed) return
      pushQueued = true
      setTimeout(() => {
        pushQueued = false
        push()
      }, 50).unref?.()
    }
    for (const name of STATIC_PROPERTIES) offs.push(ctx.mpv.observe(name, pushSoon))

    offs.push(
      ctx.mpv.afterFileLoaded((file) => {
        // A new file invalidates everything derived: the art, the properties
        // view built for the previous path, and the live cache.
        properties = null
        live = {}
        findArt(file)
        void requestOwnCoverArt()
        push()
      })
    )

    /**
     * The per-file slice exists for ONE key: which density the user last looked
     * at is a per-file preference in exactly the way subtitle delay is. The
     * panel's open state is deliberately NOT in it -- a panel that reopens
     * itself on every file in a folder is the behaviour every player gets
     * complaints about.
     *
     * `rememberDefaults` is `false` for it, per P50: remembering it is opt-in.
     */
    ctx.perFile.slice<{ density?: string }>({
      key: SLICE_KEY,
      capture: () => (density === 'full' ? {} : { density }),
      apply: (v) => {
        if (v.density === 'full' || v.density === 'short' || v.density === 'misc') {
          density = v.density
        }
      },
      rememberDefaults: { density: false }
    })

    // -- IPC --------------------------------------------------------------
    ctx.ipc.on('mediainfo:request', () => push())
    ctx.ipc.on('mediainfo:togglePanel', () => {
      panelOpen = !panelOpen
      retickLive()
      push()
    })
    ctx.ipc.on<{ density: InfoDensity }>('mediainfo:setDensity', (req) => {
      if (req.density === 'full' || req.density === 'short' || req.density === 'misc') {
        density = req.density
        push()
      }
    })
    ctx.ipc.on<{ tab: InfoTab }>('mediainfo:setTab', (req) => {
      if (req.tab === 'properties') {
        properties = buildProperties(state(), { stat: statFor })
      }
      if (req.tab === 'info' || req.tab === 'tracks' || req.tab === 'properties') {
        tab = req.tab
        push()
      }
    })
    ctx.ipc.on('mediainfo:copy', () => void copyInfo())
    ctx.ipc.on('mediainfo:showInFolder', () => {
      const p = state().path
      if (p !== null && !state().network) ctx.shell.showItemInFolder(p)
    })
    ctx.ipc.on('mediainfo:shellProperties', () => openShellProperties())

    /**
     * The stats sections' data source, and the thing that keeps the live tick
     * alive. A stats section calls this from `fields()`'s refresh; the grace
     * window means the tick runs while the overlay is up and stops within a few
     * seconds of it closing, without the renderer having to say goodbye.
     */
    ctx.ipc.handle<undefined, MediaInfoState>('mediainfo:snapshot', async () => {
      lastStatsPull = Date.now()
      const wasIdle = liveTimer === null
      retickLive()
      // The very first pull has no live values yet, and a stats overlay that
      // shows dashes for its first second is the same defect as a blank panel.
      if (wasIdle) await pullLive()
      return state()
    })

    /** L21/L40: the probe, for the current file's neighbours. */
    ctx.ipc.handle<{ path: string }, ProbeSummary | null>('mediainfo:probe', async (req) =>
      typeof req?.path === 'string' && req.path.length > 0
        ? await theProbe().probe(req.path)
        : null
    )
    ctx.ipc.handle<{ path: string }, ProbeSummary | null>('mediainfo:peekProbe', async (req) =>
      typeof req?.path === 'string' ? theProbe().peek(req.path) : null
    )
    ctx.ipc.handle<{ path: string }, MediaInfoState['properties']>(
      'mediainfo:propertiesFor',
      async (req) => {
        if (typeof req?.path !== 'string' || req.path.length === 0) return null
        const summary = await theProbe().probe(req.path)
        return buildPropertiesFromProbe(
          req.path,
          summary.rows,
          summary.container,
          summary.durationSec,
          { stat: statFor }
        )
      }
    )

    // -- commands ---------------------------------------------------------
    const showDensity = (which: InfoDensity): void => {
      // A second press of the same density closes it: one key, one surface,
      // which is what U47 means by "one surface, three densities".
      if (panelOpen && density === which) {
        panelOpen = false
      } else {
        panelOpen = true
        density = which
        if (tab === 'properties') tab = 'info'
      }
      retickLive()
      push()
      ctx.osd.show({
        kind: 'info',
        text: ctx.i18n.t(panelOpen ? `mediainfo.density.${which}` : 'mediainfo.close')
      })
    }

    ctx.commands.register([
      {
        /**
         * U47's full view. `Tab` is PotPlayer's key for it and it is bound in
         * the potplayer preset only, on purpose: in the Default preset `Tab`
         * has to keep moving focus between the overlay's own controls, and a
         * global binding calls `preventDefault()` on every Tab in the app. The
         * spec's accel is honoured where a user expects it and not at the price
         * of making the player unnavigable by keyboard.
         */
        id: 'mediainfo.showFull',
        labelKey: 'mediainfo.showFull',
        category: 'info',
        defaults: { default: ['Alt+KeyI'], potplayer: ['Tab'], mpv: ['Alt+KeyI'] },
        run: () => showDensity('full')
      },
      {
        id: 'mediainfo.showShort',
        labelKey: 'mediainfo.showShort',
        category: 'info',
        defaults: { default: ['Alt+Shift+KeyI'], potplayer: ['Shift+Tab'] },
        run: () => showDensity('short')
      },
      {
        id: 'mediainfo.showMisc',
        labelKey: 'mediainfo.showMisc',
        category: 'info',
        defaults: { default: ['ScrollLock'], potplayer: ['ScrollLock'] },
        run: () => showDensity('misc')
      },
      {
        id: 'mediainfo.copyInfo',
        labelKey: 'mediainfo.copyInfo',
        category: 'info',
        defaults: { default: ['Ctrl+Alt+KeyI'], potplayer: ['Ctrl+Alt+KeyI'] },
        enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
        run: () => void copyInfo()
      },
      {
        id: 'mediainfo.fileProperties',
        labelKey: 'mediainfo.fileProperties',
        category: 'info',
        // The Windows convention for "properties", and free in all three
        // presets.
        defaults: { default: ['Alt+Enter'], potplayer: ['Alt+Enter'] },
        enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
        run: () => openProperties()
      },
      {
        id: 'mediainfo.shellProperties',
        labelKey: 'mediainfo.shellPropertiesCmd',
        category: 'info',
        enabledWhen: () => {
          const p = ctx.mpv.peek<string>('path')
          return typeof p === 'string' && buildInvocation(p) !== null
        },
        run: () => openShellProperties()
      },
      {
        id: 'mediainfo.mpvStatsToggle',
        labelKey: 'mediainfo.mpvStatsToggle',
        category: 'info',
        defaults: { default: ['Ctrl+Shift+KeyI'], mpv: ['Ctrl+Shift+KeyI'] },
        run: async () => {
          await mpvStats('stats/display-stats-toggle')
        }
      },
      {
        id: 'mediainfo.mpvStatsNextPage',
        labelKey: 'mediainfo.mpvStatsNextPage',
        category: 'info',
        run: async () => {
          mpvStatsPage = (mpvStatsPage % 5) + 1
          await mpvStats(`stats/display-page-${mpvStatsPage}`)
        }
      },
      {
        /**
         * L21/L40's mediator. M28's playlist owns the rows; M29 owns the
         * metadata. This is the only way across, and it is `internal` so it
         * never appears in the keybind editor.
         *
         * REPORTED, not worked around: `docs/parity/modules.json` records no
         * mediator on either side of this edge -- M29's `mediates` is `{}` and
         * M28's `usesMediators` names `nav-seek.seek` and
         * `nav-thumbnails.getThumb` and nothing here -- so M28 cannot declare
         * that it uses this without a manifest change neither module owns.
         */
        id: 'mediainfo.probeFile',
        labelKey: 'mediainfo.probeFile',
        category: 'info',
        internal: true,
        run: async (arg) => await theProbe().probe(String(arg ?? ''))
      },
      {
        id: 'mediainfo.peekFile',
        labelKey: 'mediainfo.probeFile',
        category: 'info',
        internal: true,
        run: (arg) => theProbe().peek(String(arg ?? ''))
      },
      {
        /** L25 as a mediator: M30's history panel wants the same text. */
        id: 'mediainfo.reportText',
        labelKey: 'mediainfo.copyInfo',
        category: 'info',
        internal: true,
        run: () => reportText()
      }
    ])

    // -- the menu ---------------------------------------------------------
    ctx.menu.contribute({
      id: 'mediainfo.menu',
      labelKey: 'mediainfo.menuTitle',
      order: 82,
      items: [
        { commandId: 'mediainfo.showFull' },
        { commandId: 'mediainfo.showShort' },
        { commandId: 'mediainfo.showMisc' },
        { type: 'separator' },
        { commandId: 'mediainfo.copyInfo' },
        { commandId: 'mediainfo.fileProperties' },
        { commandId: 'mediainfo.shellProperties' },
        { type: 'separator' },
        {
          labelKey: 'mediainfo.mpvStatsTitle',
          submenu: [
            { commandId: 'mediainfo.mpvStatsToggle' },
            { commandId: 'mediainfo.mpvStatsNextPage' },
            {
              dynamic: () =>
                [1, 2, 3, 4, 5].map((n) => ({
                  label: `${n}`,
                  commandId: 'mediainfo.mpvStatsPage',
                  arg: n,
                  radio: true,
                  checked: mpvStatsPage === n
                }))
            }
          ]
        }
      ]
    })

    // The arg-driven entry point the menu's dynamic page list invokes. Declared
    // after the menu purely for reading order; registration order is irrelevant.
    ctx.commands.register([
      {
        id: 'mediainfo.mpvStatsPage',
        labelKey: 'mediainfo.mpvStatsPage',
        category: 'info',
        internal: true,
        run: async (arg) => {
          const n = Number(arg)
          if (!Number.isInteger(n) || n < 1 || n > 5) return
          mpvStatsPage = n
          await mpvStats(`stats/display-page-${n}`)
        }
      }
    ])

    // -- i18n -------------------------------------------------------------
    ctx.i18n.register('ko', KO)
    ctx.i18n.register('en', EN)
  },

  async dispose(): Promise<void> {
    disposed = true
    if (liveTimer !== null) clearInterval(liveTimer)
    liveTimer = null
    if (cacheWriteTimer !== null) clearTimeout(cacheWriteTimer)
    cacheWriteTimer = null
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        /* already gone */
      }
    }
    if (shellChild !== null) {
      try {
        shellChild.kill()
      } catch {
        /* already gone */
      }
      shellChild = null
    }
    const p = probe
    probe = null
    if (p) await p.dispose()
  }
}

/** For `module.test.ts`: the module's own view of what it is looking at. */
export function __testState(): MediaInfoState {
  return state()
}

export default mod
