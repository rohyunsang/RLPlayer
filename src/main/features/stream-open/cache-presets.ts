/**
 * M35 R17 / R18 / R14 — the cache presets, and an honest record of what this
 * module is NOT allowed to set.
 *
 * R17's headline, and the reason the settings UI below has one byte slider and
 * not four: "raising `--cache-secs` alone does nothing — the default is set to
 * something very high, so the achieved readahead will usually be limited by
 * `--demuxer-max-bytes`". So `demuxer-max-bytes` is the knob, and everything
 * else in a preset exists to make that knob behave.
 *
 * WHY `profile: 'low-latency'` IS NOT USED HERE, which is the interesting part.
 * R14 and R15 both specify the per-file option `profile=low-latency`. Three
 * things stop it:
 *
 *   1. `apply-profile` is BANNED outright (§2.2): the set of properties a
 *      profile touches lives inside mpv, so there is no way to police it.
 *   2. `profile` as a `loadfile` option is a property write, and NO ROW of
 *      docs/parity/modules.json owns the `profile` property — so
 *      `assertWrite` refuses it to everyone, M35 included, with
 *      "no module owns it".
 *   3. `loadfile` itself is M28's command (§2.1), so this module has no way to
 *      pass a per-file options map at all.
 *
 * So the preset is expanded to its VERIFIED CONTENTS (R14 lists them, measured
 * against the pinned binary) and this module applies the subset it owns. The
 * rest is listed in `LOW_LATENCY_FOREIGN` rather than quietly dropped, because
 * a latency preset that silently applies 3 of its 11 properties is worse than
 * one that says so: the user concludes the setting does nothing.
 */

/** Property names this module owns, per its row in docs/parity/modules.json. */
export type OwnedCacheProperty =
  | 'cache'
  | 'cache-on-disk'
  | 'cache-pause'
  | 'cache-pause-initial'
  | 'cache-pause-wait'
  | 'cache-secs'
  | 'demuxer-cache-dir'
  | 'demuxer-max-back-bytes'
  | 'demuxer-max-bytes'
  | 'demuxer-readahead-secs'
  | 'force-seekable'
  | 'stream-buffer-size'

export type CachePresetId = 'default' | 'unstable' | 'low-latency'

export interface CachePreset {
  readonly id: CachePresetId
  /** Only properties this module owns. Values are mpv's own string spellings. */
  readonly apply: Readonly<Partial<Record<OwnedCacheProperty, string>>>
  /**
   * The two byte caps, in MiB, kept OUT of `apply` on purpose.
   *
   * THE DEFECT THIS SHAPE FIXES, which the draft shipped and no test caught.
   * `apply` used to carry `demuxer-max-bytes`, and `contributeArgs` pushed the
   * preset's entries BEFORE the slider's and then de-duplicated by option name
   * keeping the first — so `--demuxer-max-bytes` always came from the preset and
   * `stream-open.maxBytes` moved nothing. R17's one instruction is "if your
   * settings UI has one buffer slider, it must move `demuxer-max-bytes`", and it
   * did not.
   *
   * So the byte caps have exactly ONE source now: the two settings. Choosing a
   * preset WRITES these numbers into those settings (`applyCachePreset`), which
   * makes the sliders move where the user can see them, and `buildSpawnArgs`
   * reads the settings and nothing else. A preset with no `bytes` (low-latency,
   * which turns the cache off entirely) leaves them alone.
   */
  readonly bytes?: { readonly maxMiB: number; readonly backMiB: number }
}

const MiB = 1024 * 1024

/**
 * The three presets R17 names. Byte values are written as plain integers rather
 * than `150MiB`, because a property write takes the number and only a
 * COMMAND-LINE option takes mpv's suffix syntax.
 */
export const CACHE_PRESETS: readonly CachePreset[] = [
  {
    // mpv's shipped defaults, restated so "back to normal" is one click and does
    // not depend on remembering what the defaults were.
    id: 'default',
    bytes: { maxMiB: 150, backMiB: 50 },
    apply: {
      cache: 'auto',
      'demuxer-readahead-secs': '1',
      'cache-secs': '3600000',
      'cache-pause': 'yes',
      'cache-pause-initial': 'no',
      'cache-pause-wait': '1',
      'stream-buffer-size': String(128 * 1024)
    }
  },
  {
    // "불안정한 회선". Note `cache-pause-initial=yes` and `cache-pause-wait=5`
    // are paired ON PURPOSE and only here: R17 records that cache-pause-initial
    // also triggers after SEEKING, which is why raising cache-pause-wait makes
    // seeks feel sluggish. They belong to the same choice, so they move together.
    id: 'unstable',
    bytes: { maxMiB: 1024, backMiB: 256 },
    apply: {
      cache: 'yes',
      'cache-secs': '300',
      'cache-pause': 'yes',
      'cache-pause-initial': 'yes',
      'cache-pause-wait': '5',
      'stream-buffer-size': String(512 * 1024)
    }
  },
  {
    // R14/R15's low-latency case, reduced to what M35 owns. See the file header.
    id: 'low-latency',
    apply: {
      cache: 'no',
      'cache-pause': 'no',
      'stream-buffer-size': String(4 * 1024)
    }
  }
]

/**
 * The rest of the verified `low-latency` profile, with its owner, so the UI can
 * name what it cannot do and a reviewer can see the gap without re-deriving it.
 *
 * Contents from R14, measured against the pinned binary:
 *   audio-buffer=0, vd-lavc-threads=1, cache-pause=no,
 *   demuxer-lavf-o-add=fflags=+nobuffer, demuxer-lavf-probe-info=nostreams,
 *   demuxer-lavf-analyzeduration=0.1, video-sync=audio, interpolation=no,
 *   video-latency-hacks=yes, stream-buffer-size=4k
 */
export const LOW_LATENCY_FOREIGN: ReadonlyArray<{
  readonly property: string
  readonly value: string
  /** The module id that owns it, or null when NO row of the manifest does. */
  readonly owner: string | null
}> = [
  { property: 'audio-buffer', value: '0', owner: 'audio-devices' },
  { property: 'video-sync', value: 'audio', owner: 'video-framerate' },
  { property: 'interpolation', value: 'no', owner: 'video-framerate' },
  { property: 'vd-lavc-threads', value: '1', owner: null },
  { property: 'demuxer-lavf-o-add', value: 'fflags=+nobuffer', owner: null },
  { property: 'demuxer-lavf-probe-info', value: 'nostreams', owner: null },
  { property: 'demuxer-lavf-analyzeduration', value: '0.1', owner: null },
  { property: 'video-latency-hacks', value: 'yes', owner: null }
]

export function presetById(id: string): CachePreset | undefined {
  return CACHE_PRESETS.find((p) => p.id === id)
}

/**
 * R11's CDN workaround as one toggle rather than a byte field.
 *
 * "A common workaround for per-connection bandwidth throttling employed by some
 * CDNs, where each Range request is served at full speed but a single long-lived
 * connection is rate-limited." Default 0 means one open-ended request, which is
 * the shape that gets throttled.
 *
 * These are SPAWN ARGS and not property writes: `curl-*` is in this module's
 * ownedProperties as a glob, so both routes are legal, but the libcurl backend
 * reads them when it opens a connection, so changing them mid-stream does
 * nothing visible until the next open.
 */
export function curlArgs(chunked: boolean): string[] {
  if (!chunked) return []
  return [
    '--curl-max-request-size=8MiB',
    '--curl-max-retries=5',
    '--curl-max-redirects=16',
    '--curl-connect-timeout=30',
    '--curl-buffer-size=4MiB'
  ]
}

/**
 * R18: with `cache-on-disk=yes`, `demuxer-max-bytes` "applies to metadata only"
 * — about 50 MB per hour — so the buffer slider silently changes meaning. The
 * settings descriptors hide the byte fields through this predicate rather than
 * relabelling them, because a slider that means something different depending on
 * a checkbox three rows up is not a thing a label can rescue.
 */
export function byteSlidersApply(cacheOnDisk: boolean): boolean {
  return !cacheOnDisk
}

// ---------------------------------------------------------------------------
// The spawn-arg builder — pure, so the test can assert the ARRAY mpv receives
// ---------------------------------------------------------------------------

/**
 * Every setting `buildSpawnArgs` reads, as plain data.
 *
 * Taking a record rather than a `FeatureContext` is the whole point: the arg
 * list is the thing that decides whether a slider does anything, and the draft's
 * version of it lived inside `setup()` where a test could only reach it by
 * building a fake context. It was wrong (see `CachePreset.bytes`) and both of
 * this module's suites passed.
 */
export interface SpawnArgInputs {
  readonly cachePreset: string
  readonly maxBytesMiB: number
  readonly maxBackBytesMiB: number
  readonly cacheOnDisk: boolean
  readonly cacheDir: string
  readonly chunkedRequests: boolean
  readonly userAgent: string
  readonly proxy: string
  readonly cookiesFile: string
  readonly tlsCaFile: string
}

/**
 * NOTE what is deliberately absent: `--network-timeout`.
 *
 * R14 records, measured, that "merely setting the option will put RTSP into
 * listening mode, which breaks any client uses" — so a global spawn arg wired to
 * a timeout slider breaks every RTSP camera in a way no user would ever connect
 * to a timeout setting. The draft contributed the arg and then wrote `0` over it
 * for RTSP streams, which is still *setting the option*. The timeout is a
 * per-stream property write for non-RTSP schemes only (`applyStreamOptions`), so
 * for an RTSP source this module never touches the property at all.
 */
export function buildSpawnArgs(i: SpawnArgInputs): string[] {
  const args: string[] = []
  const preset = presetById(i.cachePreset)
  if (preset) {
    for (const [k, v] of Object.entries(preset.apply)) args.push(`--${k}=${v}`)
  }

  if (i.cacheOnDisk) {
    args.push('--cache-on-disk=yes')
    // Portable-mode friendly: cacheDir() is beside the exe in portable mode and
    // under the profile otherwise.
    args.push(`--demuxer-cache-dir=${i.cacheDir}`)
    // R18: with the disk cache on, the byte caps apply to METADATA only ("50 MB
    // per hour is typical"), so contributing the user's media-sized numbers here
    // would silently change what they mean. The settings UI hides the sliders for
    // the same reason (`byteSlidersApply`).
  } else {
    args.push(`--demuxer-max-bytes=${Math.max(0, Math.round(i.maxBytesMiB)) * MiB}`)
    args.push(`--demuxer-max-back-bytes=${Math.max(0, Math.round(i.maxBackBytesMiB)) * MiB}`)
  }

  args.push(...curlArgs(i.chunkedRequests))

  if (i.userAgent.length > 0) args.push(`--user-agent=${i.userAgent}`)
  if (i.proxy.length > 0) args.push(`--http-proxy=${i.proxy}`)
  if (i.cookiesFile.length > 0) args.push('--cookies=yes', `--cookies-file=${i.cookiesFile}`)
  if (i.tlsCaFile.length > 0) args.push(`--tls-ca-file=${i.tlsCaFile}`)

  // A preset must never name an option the builder also derives; if one ever
  // does, the LAST value would win inside mpv while `validateArgContributions`
  // rejects the duplicate at boot. Keeping the first occurrence would hide it.
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of args) {
    const name = a.split('=')[0] as string
    if (seen.has(name)) continue
    seen.add(name)
    out.push(a)
  }
  return out
}

/**
 * The settings a preset writes when it is chosen, so the sliders move with it.
 * Empty for a preset with no `bytes`.
 */
export function presetSliderValues(
  id: string
): { maxBytesMiB: number; maxBackBytesMiB: number } | null {
  const p = presetById(id)
  if (!p?.bytes) return null
  return { maxBytesMiB: p.bytes.maxMiB, maxBackBytesMiB: p.bytes.backMiB }
}
