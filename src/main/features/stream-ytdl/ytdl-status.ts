/**
 * M36 R07 / R08 — reading what ytdl_hook did, without asking anyone.
 *
 * ===========================================================================
 * R07 IS A POLICY ROW, AND THE POLICY IS "NEVER ON A TIMER"
 * ===========================================================================
 *
 * "yt-dlp updates itself; we never write an updater. Trigger rule: surface the
 * update affordance only at the moment of an actual extraction failure, never on
 * a timer. … One non-modal toast on failure, and that is the ONLY time the app
 * ever mentions updating anything. No background task, no scheduled task, no Run
 * key, no launch check."
 *
 * That is the product this whole repository exists to be, so the trigger is a
 * FAILURE that already happened, in a session the user started, on a URL the
 * user typed. This file is the parser for that failure. It reads
 * `user-data/mpv/ytdl/json-subprocess-result`, which ytdl_hook sets and deletes
 * on end-of-file, so there is nothing to poll and nothing to remember.
 *
 * Everything here is pure. `ytdl-status.test.ts` drives it with the shapes mpv's
 * `subprocess` result actually has, including the ones that mean "yt-dlp is not
 * installed" rather than "yt-dlp is out of date" — telling those two apart is the
 * difference between a useful toast and one that tells a user to update
 * something they never had.
 */

/** mpv's own subprocess-result shape, every field optional as it arrives. */
export interface SubprocessResult {
  readonly status?: unknown
  readonly stdout?: unknown
  readonly stderr?: unknown
  readonly error_string?: unknown
  readonly killed_by_us?: unknown
}

export type YtdlOutcome =
  /** No result recorded: not a yt-dlp source, or nothing has been tried. */
  | { readonly kind: 'none' }
  | { readonly kind: 'ok' }
  /** The binary could not be run at all. An update offer would be nonsense. */
  | { readonly kind: 'missing'; readonly detail: string }
  /** yt-dlp ran and failed. This is the ONE case R07 offers an update on. */
  | { readonly kind: 'extraction-failed'; readonly detail: string; readonly updateWorthy: boolean }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Lines yt-dlp prints when the SITE changed under it — i.e. when a newer yt-dlp
 * plausibly helps. Drawn from the failure modes R07's cadence note describes
 * ("bursty, roughly monthly with reactive clusters"): signature/nsig breakage,
 * a hard 403 from a player endpoint, a format list that came back empty, and
 * yt-dlp's own "please report" line, which it prints when its extractor hit
 * something it does not understand.
 *
 * A NON-match still shows the failure; it just does not offer the update. That
 * asymmetry is the point: offering an update for "Video unavailable" or
 * "Private video" trains people to click it, and then the one time it matters
 * they have already learned it does nothing.
 */
const UPDATE_WORTHY = [
  /unable to extract/i,
  /signature extraction failed/i,
  /nsig extraction failed/i,
  /failed to extract any player response/i,
  /requested format is not available/i,
  /no video formats found/i,
  /please report this issue/i,
  /update to the latest version/i,
  /http error 403/i
]

/** Lines that mean the binary itself is not usable. */
const MISSING = [
  /init failed/i,
  /is not recognized as an internal or external command/i,
  /no such file or directory/i,
  /enoent/i,
  /cannot find the (file|path) specified/i,
  /access is denied/i
]

/** The first `ERROR:`/`WARNING:` line, or the last non-empty line. */
export function summarise(stderr: string, max = 200): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const flagged = lines.find((l) => /^(ERROR|WARNING)\b/i.test(l))
  const pick = flagged ?? lines[lines.length - 1] ?? ''
  return pick.length > max ? `${pick.slice(0, max - 1)}…` : pick
}

export function classify(raw: unknown): YtdlOutcome {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { kind: 'none' }
  const r = raw as SubprocessResult

  // `status` is a number from mpv. A missing status with no stderr is a result
  // shape we do not understand, and guessing "failed" would fire a toast at a
  // user whose stream is playing perfectly well.
  const status = typeof r.status === 'number' ? r.status : null
  const stderr = str(r.stderr)
  const errorString = str(r.error_string)

  if (r.killed_by_us === true) return { kind: 'none' }
  if (status === 0) return { kind: 'ok' }
  if (status === null && stderr.length === 0 && errorString.length === 0) {
    return { kind: 'none' }
  }

  const haystack = `${errorString}\n${stderr}`
  if (MISSING.some((re) => re.test(haystack))) {
    return { kind: 'missing', detail: summarise(haystack) }
  }
  return {
    kind: 'extraction-failed',
    detail: summarise(stderr.length > 0 ? stderr : errorString),
    updateWorthy: UPDATE_WORTHY.some((re) => re.test(haystack))
  }
}

// ---------------------------------------------------------------------------
// R08 — the quality menu IS the track menu
// ---------------------------------------------------------------------------

/**
 * One entry of mpv's `track-list`, as much of it as R08 needs.
 *
 * R08: "ytdl_hook already does the hard part … it builds an EDL exposing EVERY
 * yt-dlp format as a separate delay-loaded mpv track. So the quality menu IS the
 * track menu: read `track-list`, switch with `vid`/`aid`." This module therefore
 * OWNS NO TRACK STATE: it reads the list and asks M11's mediator, because M11
 * owns `vid` and `aid` outright and they are one decision on an EDL source.
 */
export interface TrackEntry {
  readonly id?: unknown
  readonly type?: unknown
  readonly title?: unknown
  readonly lang?: unknown
  readonly selected?: unknown
  readonly codec?: unknown
  readonly 'demux-w'?: unknown
  readonly 'demux-h'?: unknown
  readonly 'demux-fps'?: unknown
  readonly 'demux-bitrate'?: unknown
}

export interface QualityOption {
  readonly id: number
  readonly kind: 'video' | 'audio'
  readonly selected: boolean
  /** A label built from what the track actually reports; never invented. */
  readonly label: string
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Build the quality list from `track-list`.
 *
 * The label is assembled from height, fps, codec and bitrate ONLY where the
 * track reports them — a delay-loaded EDL track legitimately reports almost
 * nothing until it is selected, and a label reading "0p 0fps" is worse than one
 * reading "Track 3". R08's own note: "For richer labels read the cached yt-dlp
 * JSON rather than spawning it again."
 */
export function qualityOptions(list: unknown): QualityOption[] {
  if (!Array.isArray(list)) return []
  const out: QualityOption[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as TrackEntry
    const kind = t.type === 'video' ? 'video' : t.type === 'audio' ? 'audio' : null
    if (kind === null) continue
    const id = num(t.id)
    if (id === null) continue

    const parts: string[] = []
    const h = num(t['demux-h'])
    if (h !== null && h > 0) parts.push(`${h}p`)
    const fps = num(t['demux-fps'])
    if (fps !== null && fps > 0) parts.push(`${Math.round(fps)}fps`)
    if (typeof t.codec === 'string' && t.codec.length > 0) parts.push(t.codec)
    const br = num(t['demux-bitrate'])
    if (br !== null && br > 0) parts.push(`${Math.round(br / 1000)} kbps`)
    if (typeof t.lang === 'string' && t.lang.length > 0) parts.push(t.lang)
    if (parts.length === 0 && typeof t.title === 'string' && t.title.length > 0) {
      parts.push(t.title)
    }

    out.push({
      id,
      kind,
      selected: t.selected === true,
      label: parts.length > 0 ? parts.join(' · ') : `#${id}`
    })
  }
  // Highest first for video (what "quality" means to a user), id order for audio.
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1
    if (a.kind === 'audio') return a.id - b.id
    const ah = /^(\d+)p/.exec(a.label)
    const bh = /^(\d+)p/.exec(b.label)
    if (ah && bh) return Number(bh[1]) - Number(ah[1])
    return a.id - b.id
  })
}

/**
 * R08's honest caveat, encoded so the UI can say it: when yt-dlp returns no
 * `requested_formats` — typical for an HLS master playlist — ytdl_hook
 * deliberately does not split formats, so one quality is legitimate.
 */
export function singleFormatIsNormal(options: readonly QualityOption[]): boolean {
  return options.filter((o) => o.kind === 'video').length <= 1
}
