import fs from 'node:fs'
import path from 'node:path'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { PosterCache } from './poster.ts'
import { Thumbnailer } from './thumbnailer.ts'
import {
  bucketStep,
  bucketTime,
  clamp,
  DEFAULT_THUMB_WIDTH,
  frameBytes,
  frameKey,
  FrameScheduler,
  LruMap,
  MAX_THUMB_WIDTH,
  MIN_THUMB_WIDTH,
  thumbSize,
  bgraToRgba,
  type ThumbGeometry
} from './thumb-core.ts'

/**
 * M27 nav-thumbnails — seek-bar preview thumbnails (N36), the tooltip's chapter
 * caption (N37) and the `nav-thumbnails.getThumb` mediator L30 and N14 consume.
 *
 * This module owns NO mpv property and NO mpv command, which is the point of it:
 * everything it does happens inside a second `mpv.exe` that nothing else can
 * observe. It reads the playing instance (reads are unrestricted, §3.7) to find
 * out what size, track, edition and rotation the preview should match, and it
 * never writes to it. It is the first consumer of `ctx.engine.spawn()` and of
 * `ctx.paths.thumbCacheDir()`.
 *
 * Lifecycle, in the order the failures actually happen:
 *
 *  - LAZY. No hover, no process. §2.6 N36 puts the thumbnailer at 40-60 MB RSS,
 *    which is not something to pay for a file somebody opened to hear.
 *  - PINNED. `--o`, `--start` and the input file are spawn-scoped, so an
 *    instance belongs to one file. `afterFileLoaded` closes the old one.
 *  - IDLE-KILLED at 60 s by core, which is §6.3's M27 criterion implemented
 *    once for everybody rather than four times slightly differently.
 *  - REAPED. `ctx.engine` registers every instance, kills them on the quit path
 *    BEFORE the playing mpv, and has a synchronous `process.on('exit')`
 *    fallback. `dispose()` below is politeness, not the guarantee.
 *  - NEVER FIGHTING THE PRIMARY. Read-only, `--demuxer-max-bytes=128KiB`, no
 *    audio, no window, and not spawned at all for a network source.
 */

let ctx: FeatureContext

/**
 * Preview frames, keyed by file + geometry + bucketed time.
 *
 * Bounded in BYTES rather than in entries, because the width is a setting: 64
 * frames is 12 MB at the default 288 px and 33 MB at the 480 px maximum, and
 * the second number is the one a user would notice. Rebuilt whenever the
 * geometry changes.
 */
const FRAME_CACHE_BYTES = 16 * 1024 * 1024
let frames = new LruMap<CachedFrame>(24)

function frameCacheFor(g: ThumbGeometry): LruMap<CachedFrame> {
  return new LruMap<CachedFrame>(Math.max(16, Math.floor(FRAME_CACHE_BYTES / frameBytes(g))))
}

interface CachedFrame {
  readonly key: string
  readonly time: number
  readonly width: number
  readonly height: number
  readonly exact: boolean
  readonly rgba: Uint8Array
}

interface ThumbStatus {
  readonly enabled: boolean
  readonly available: boolean
  readonly width: number
  readonly height: number
  /** Seconds per cache bucket, so the overlay asks once per bucket, not per px. */
  readonly stepSec: number
}

let thumbnailer: Thumbnailer | null = null
let posters: PosterCache | null = null
let geometry: ThumbGeometry = thumbSize(undefined, undefined, DEFAULT_THUMB_WIDTH)
let fileKey = ''
let available = false
let duration = 0

const scheduler = new FrameScheduler(
  (req) => runGrab(req.time, req.exact),
  (e, req) => ctx.log.warn(`frame at ${req.time.toFixed(2)}s failed:`, e.message)
)

function enabled(): boolean {
  return ctx.settings.get<boolean>('nav-thumbnails.enabled') === true
}

function targetWidth(): number {
  const w = ctx.settings.get<number>('nav-thumbnails.width')
  return clamp(typeof w === 'number' ? w : DEFAULT_THUMB_WIDTH, MIN_THUMB_WIDTH, MAX_THUMB_WIDTH)
}

function status(): ThumbStatus {
  return {
    enabled: enabled(),
    available,
    width: geometry.width,
    height: geometry.height,
    stepSec: bucketStep(duration)
  }
}

function pushStatus(): void {
  // A different channel from the `nav-thumbnails:status` request handler: main
  // pushes on this one, the overlay asks on that one. Sharing a name works —
  // `ipcRenderer.on` and `ipcRenderer.invoke` do not collide — but it reads as
  // if one of the two must be wrong.
  ctx.ipc.send('nav-thumbnails:statusChanged', status())
}

/**
 * One output path per thumbnailer instance, and a swept directory at boot.
 *
 * The counter is not decoration: `teardown()` awaits the old process's exit
 * before the next instance is built, but "awaits" means "up to the escalation's
 * grace period", and two mpvs rewriting one path is a frame from the wrong file.
 * The sweep is for the leftovers a crash leaves behind, since nothing else ever
 * deletes them (`core/profile-cleanup` is now forbidden to touch `ctx.paths`).
 */
let instanceSeq = 0

function jobDir(): string {
  return ctx.paths.tempJobDir('nav-thumbnails')
}

function sweepJobDir(): void {
  try {
    const dir = jobDir()
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.out') || f.endsWith('.frame')) fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch {
    /* a first run has no directory yet, and a locked file is not fatal */
  }
}

/**
 * Close the instance pinned to the file we have just left, and forget its
 * frames.
 *
 * Awaiting is deliberate even though nothing waits for this to finish: the old
 * process must be on its way out before the new one is asked for, or a fast
 * playlist advance leaves two thumbnailers reading two files.
 */
async function teardown(): Promise<void> {
  scheduler.reset()
  frames.clear()
  const old = thumbnailer
  thumbnailer = null
  await old?.close()
}

/**
 * Decide whether a preview is possible for the file that just loaded, and with
 * what geometry.
 *
 * Every value here is READ from the playing instance. `video-out-params/dw|dh`
 * rather than `width`/`height` because it is the displayed size and it already
 * accounts for `video-rotate` (§7.7 trap 9).
 */
async function onFileLoaded(file: string): Promise<void> {
  await teardown()
  fileKey = file
  duration = 0
  available = false

  // R24/N36: never for a URL. A second process re-opening a stream is a second
  // set of requests, and this app makes none.
  if (ctx.mpv.isNetworkSource) {
    ctx.log.info('no seek previews for a network source')
    pushStatus()
    return
  }

  const [dw, dh, dur, vid, edition, rotate] = await Promise.all([
    ctx.mpv.get<number>('video-out-params/dw').catch(() => undefined),
    ctx.mpv.get<number>('video-out-params/dh').catch(() => undefined),
    ctx.mpv.get<number>('duration').catch(() => undefined),
    ctx.mpv.get<number | false>('vid').catch(() => undefined),
    ctx.mpv.get<number | false>('edition').catch(() => undefined),
    ctx.mpv.get<number>('video-rotate').catch(() => undefined)
  ])

  // Audio-only: no video track, or a video output with no size. N36 says never
  // spawn for one, and a cover-art "video track" would give one static frame at
  // every position, which is worse than nothing.
  const hasVideo = typeof dw === 'number' && dw > 0 && typeof dh === 'number' && dh > 0
  if (!hasVideo || !(typeof dur === 'number' && dur > 0)) {
    pushStatus()
    return
  }

  duration = dur
  geometry = thumbSize(dw, dh, targetWidth())
  frames = frameCacheFor(geometry)
  available = true
  thumbnailer = new Thumbnailer({
    engine: ctx.engine,
    log: ctx.log,
    file,
    geometry,
    outputFile: path.join(jobDir(), `hover-${++instanceSeq}.bgra.out`),
    vid: typeof vid === 'number' ? vid : undefined,
    edition: typeof edition === 'number' ? edition : undefined,
    videoRotate: typeof rotate === 'number' ? rotate : 0,
    idleTimeoutMs: 60_000
  })
  pushStatus()
}

/** One scheduled decode. Caches the result and pushes it to the overlay. */
async function runGrab(time: number, exact: boolean): Promise<void> {
  const t = thumbnailer
  if (!t || !enabled() || !available) return
  const key = frameKey(fileKey, t.geometry, time)
  const known = frames.get(key)
  if (known && (known.exact || !exact)) return

  const bgra = await t.grab(time, exact)
  if (!bgra) return
  // A file switch that happened while this decode was in flight must not put
  // the old file's frame into the new file's cache.
  if (thumbnailer !== t) return
  const frame: CachedFrame = {
    key,
    time,
    width: t.geometry.width,
    height: t.geometry.height,
    exact,
    rgba: bgraToRgba(bgra)
  }
  frames.set(key, frame)
  ctx.ipc.send('nav-thumbnails:frame', frame)
}

/**
 * The overlay's hover ask.
 *
 * Returns the frame immediately when it is already decoded, which is the common
 * case once a bar has been swept: the overlay caches by the same key, so a
 * cached frame usually does not even reach this handler. A miss schedules the
 * decode and answers null; the frame arrives on `nav-thumbnails:frame` when it
 * is ready, and the overlay paints it only if the pointer is still there.
 * Answering null rather than awaiting the decode is what keeps a slow exact
 * seek off the overlay's pointermove path.
 */
function onRequest(req: { t: number; exact?: boolean }): CachedFrame | null {
  if (!enabled() || !available || !thumbnailer) return null
  const wantExact = req.exact === true
  const time = bucketTime(req.t, duration)
  const key = frameKey(fileKey, geometry, time)
  const cached = frames.get(key)
  if (cached && (cached.exact || !wantExact)) return cached
  scheduler.request({ time, exact: wantExact })
  return cached ?? null
}

/**
 * L30 and N14: one PNG for an arbitrary file, cached on disk.
 *
 * It answers with a `data:` URL and not with the path, and that is not a taste
 * decision: the overlay's CSP is `img-src 'self' data:` and lives in
 * `src/renderer/index.html`, a core file. A caller handed a `file://` path could
 * not display it and could not fix it from its own directory either. The path is
 * returned alongside for callers that want to reveal it in Explorer.
 */
async function getThumb(arg: unknown): Promise<{ file: string; dataUrl: string } | null> {
  const req = (arg ?? {}) as { path?: unknown; timeSec?: unknown; width?: unknown }
  const file = typeof req.path === 'string' ? req.path : ''
  if (!file || !posters) return null
  // A URL has no frame to grab and no local file to stat.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return null
  const out = await posters.get({
    path: file,
    timeSec: typeof req.timeSec === 'number' ? req.timeSec : undefined,
    width: typeof req.width === 'number' ? req.width : undefined
  })
  if (!out) return null
  try {
    const png = await fs.promises.readFile(out)
    return { file: out, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  } catch {
    return null
  }
}

const mod: FeatureModule = {
  id: 'nav-thumbnails',
  // Deliberately empty, and checked against docs/parity/modules.json in both
  // directions by `npm test`. Everything this module writes, it writes to a
  // process of its own; the playing instance is read-only from here.
  ownsProperties: [],
  ownsCommands: [],

  setup(c): void {
    ctx = c
    sweepJobDir()

    ctx.settings.define([
      {
        id: 'nav-thumbnails.enabled',
        section: 'playback',
        group: 'seek',
        labelKey: 'nav-thumbnails.enabledLabel',
        descriptionKey: 'nav-thumbnails.enabledDesc',
        type: { kind: 'bool' },
        default: true,
        keywords: ['미리보기', '썸네일', 'thumbnail', 'preview', 'seek'],
        order: 20
      },
      {
        id: 'nav-thumbnails.width',
        section: 'playback',
        group: 'seek',
        labelKey: 'nav-thumbnails.widthLabel',
        descriptionKey: 'nav-thumbnails.widthDesc',
        type: { kind: 'int', min: MIN_THUMB_WIDTH, max: MAX_THUMB_WIDTH, step: 16 },
        default: DEFAULT_THUMB_WIDTH,
        keywords: ['썸네일 크기', 'thumbnail size'],
        advanced: true,
        order: 21
      },
      {
        id: 'nav-thumbnails.cacheLimitMb',
        section: 'advanced',
        group: 'cache',
        labelKey: 'nav-thumbnails.cacheLimitLabel',
        descriptionKey: 'nav-thumbnails.cacheLimitDesc',
        type: { kind: 'int', min: 16, max: 4096, step: 16 },
        default: 256,
        keywords: ['캐시', 'cache', 'thumbnail'],
        advanced: true,
        order: 40
      }
    ])

    posters = new PosterCache({
      engine: ctx.engine,
      log: ctx.log,
      dir: ctx.paths.thumbCacheDir(),
      limitBytes: ctx.settings.get<number>('nav-thumbnails.cacheLimitMb') * 1024 * 1024
    })

    // A width change invalidates every cached frame, because the geometry is
    // part of the key AND part of the spawn line.
    ctx.settings.onChange<number>('nav-thumbnails.width', () => {
      if (!available) return
      void teardown().then(() => {
        const file = ctx.perFile.currentPath()
        if (file) void onFileLoaded(file)
      })
    })
    ctx.settings.onChange<boolean>('nav-thumbnails.enabled', (on) => {
      if (!on) void teardown()
      pushStatus()
    })

    ctx.mpv.afterFileLoaded((file) => {
      void onFileLoaded(file)
    })

    ctx.ipc.handle<{ t: number; exact?: boolean }, CachedFrame | null>(
      'nav-thumbnails:request',
      (req) => onRequest(req)
    )
    ctx.ipc.handle<undefined, ThumbStatus>('nav-thumbnails:status', () => status())

    ctx.commands.register([
      {
        id: 'nav-thumbnails.toggle',
        labelKey: 'nav-thumbnails.toggle',
        category: 'navigation',
        // PotPlayer has no binding for this; Default and mpv get one so the
        // preset fold has all three (§3.3.3).
        defaults: { default: ['Ctrl+KeyT'], potplayer: [], mpv: ['Ctrl+KeyT'] },
        run: () => {
          const next = !enabled()
          ctx.settings.set('nav-thumbnails.enabled', next)
          // N50: every navigation action says what it did.
          ctx.osd.show({
            kind: 'info',
            text: ctx.i18n.t(next ? 'nav-thumbnails.osdOn' : 'nav-thumbnails.osdOff')
          })
        }
      },
      {
        // The mediator §2.6 L30 names, and N14's frame source. Internal, so it
        // never appears in the keybind editor.
        id: 'nav-thumbnails.getThumb',
        labelKey: 'nav-thumbnails.getThumb',
        category: 'navigation',
        internal: true,
        run: (arg) => getThumb(arg)
      }
    ])

    ctx.menu.contribute({
      id: 'nav-thumbnails.menu',
      labelKey: 'nav-thumbnails.menuTitle',
      order: 45,
      items: [{ commandId: 'nav-thumbnails.toggle' }]
    })

    ctx.i18n.register('ko', {
      'nav-thumbnails.enabledLabel': '탐색 막대 미리보기 썸네일',
      'nav-thumbnails.enabledDesc':
        '탐색 막대에 마우스를 올리면 그 위치의 화면을 미리 보여 줍니다. 재생과 별개인 mpv 프로세스를 쓰며, 마지막 미리보기 60초 뒤에 종료됩니다.',
      'nav-thumbnails.widthLabel': '미리보기 너비 (픽셀)',
      'nav-thumbnails.widthDesc': '크게 잡을수록 디코딩 비용과 메모리가 함께 늘어납니다.',
      'nav-thumbnails.cacheLimitLabel': '썸네일 캐시 최대 크기 (MB)',
      'nav-thumbnails.cacheLimitDesc':
        '목록·북마크 썸네일을 저장하는 폴더의 상한입니다. 넘으면 오래된 것부터 지웁니다.',
      'nav-thumbnails.toggle': '탐색 미리보기 켜기/끄기',
      'nav-thumbnails.getThumb': '썸네일 요청',
      'nav-thumbnails.menuTitle': '미리보기',
      'nav-thumbnails.osdOn': '탐색 미리보기 켬',
      'nav-thumbnails.osdOff': '탐색 미리보기 끔'
    })
    ctx.i18n.register('en', {
      'nav-thumbnails.enabledLabel': 'Seek-bar preview thumbnails',
      'nav-thumbnails.enabledDesc':
        'Show the frame under the pointer while hovering the seek bar. Uses a separate mpv process that exits 60 s after the last preview.',
      'nav-thumbnails.widthLabel': 'Preview width (pixels)',
      'nav-thumbnails.widthDesc': 'Larger previews cost proportionally more decoding and memory.',
      'nav-thumbnails.cacheLimitLabel': 'Thumbnail cache limit (MB)',
      'nav-thumbnails.cacheLimitDesc':
        'Upper bound for the folder holding playlist and bookmark thumbnails. Oldest entries go first.',
      'nav-thumbnails.toggle': 'Toggle seek preview',
      'nav-thumbnails.getThumb': 'Request thumbnail',
      'nav-thumbnails.menuTitle': 'Preview',
      'nav-thumbnails.osdOn': 'Seek preview on',
      'nav-thumbnails.osdOff': 'Seek preview off'
    })
  },

  async dispose(): Promise<void> {
    posters?.dispose()
    posters = null
    await teardown()
  }
}

export default mod
