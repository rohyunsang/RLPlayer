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
    apply: {
      cache: 'auto',
      'demuxer-max-bytes': String(150 * MiB),
      'demuxer-max-back-bytes': String(50 * MiB),
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
    apply: {
      cache: 'yes',
      'demuxer-max-bytes': String(1024 * MiB),
      'demuxer-max-back-bytes': String(256 * MiB),
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
