/**
 * M22 capture-still — the pure half.
 *
 * Everything here is a total function over plain values: no mpv, no Electron,
 * no filesystem, not even `node:path` (see `isAbsoluteCapturePath`). That is
 * what lets `capture.test.ts` exercise the REAL logic rather than a copy of it.
 *
 * Every rule below is a MEASURED value out of §2.4 of the parity spec, not a
 * reasonable-looking guess, and each is a thing a straightforward implementation
 * gets wrong:
 *
 *  - C01/C20: `screenshot` replies with a BARE RELATIVE FILENAME
 *    (`mpv-shot0002.jpg`) unless `screenshot-directory` was set first. The reply
 *    is the only path anyone may use (mpv appends `%n` disambiguation), so the
 *    absoluteness of the reply is a precondition, not a formality.
 *  - C04: `scaled` and `window` return `error running command` when there is no
 *    window-backed VO, while `video` succeeds in the same state. Two shipped
 *    states have no VO surface: audio-only with the video window hidden (A38)
 *    and tray-only mode (U39). Silently returning an error to a keypress is the
 *    one option the spec forbids, so there is an explicit fallback here.
 *  - C04: `screenshot-to-file` accepts ONLY `subtitles`/`video`/`window` — not
 *    `scaled`, not `osd` — and ignores the template. So the flag set depends on
 *    which of the two commands is being used, which is why `captureFlags` takes
 *    the sink.
 *  - C05: mpv will NOT overwrite an existing file, so a template with no `%n`
 *    and no millisecond component silently stops producing captures.
 *  - C08: mpv's `each-frame` flag captures every decoded frame with no interval
 *    control (150 5-MB PNGs in five seconds at 30 fps). It is unrepresentable
 *    here, and a test asserts that.
 */

// ---------------------------------------------------------------------------
// Capture flags (C01, C02, C04)
// ---------------------------------------------------------------------------

/**
 * Which mpv command the flags are for.
 *
 * `template` is the `screenshot` command: it honours `screenshot-template` and
 * `screenshot-directory` and replies with the filename it chose. `exact` is
 * `screenshot-to-file`, which takes the path from us, replies `null`, and
 * accepts a strictly smaller flag set.
 */
export type CaptureSink = 'template' | 'exact'

/** Source resolution (the decoded frame) or display resolution (C04). */
export type CaptureScope = 'source' | 'display'

export interface CaptureRequest {
  sink: CaptureSink
  scope: CaptureScope
  subs: boolean
}

/**
 * The mpv flag string for a capture — the whole §2.4 C01/C02/C04 table.
 *
 * `window` is the only display-resolution flag `screenshot-to-file` accepts, and
 * it always carries the OSD and whatever subtitles are on screen, so the `subs`
 * choice is not expressible on that path. `capturePlan` reports that as
 * `subsIgnored` rather than pretending otherwise.
 */
export function captureFlags(req: CaptureRequest): string {
  if (req.scope === 'display') {
    if (req.sink === 'exact') return 'window'
    return req.subs ? 'scaled+subtitles' : 'scaled'
  }
  return req.subs ? 'subtitles' : 'video'
}

/** True for the two flags measured to fail without a window-backed VO (C04). */
export function needsWindowVo(flags: string): boolean {
  return flags.split('+').some((f) => f === 'scaled' || f === 'window')
}

export interface CapturePlan {
  /** What to send first. */
  flags: string
  /** What to send instead if mpv refuses `flags`, or null when there is no
   *  weaker form to fall back to. */
  fallbackFlags: string | null
  /** True when this plan needs a window-backed VO to work at all (C04). */
  needsWindow: boolean
  /** True when the sink cannot honour the `subs` choice (`screenshot-to-file`
   *  with `window` always includes the OSD and the on-screen subtitles). */
  subsIgnored: boolean
}

/**
 * The flags to try, and the flags to retry with.
 *
 * The fallback is always a SOURCE-resolution capture of the same subtitle
 * choice, because `video`/`subtitles` were measured to succeed in exactly the
 * states where `scaled`/`window` fail. A caller that takes the fallback must
 * tell the user it did (C04) — hence `fellBack` in the toast, not a silent swap.
 */
export function capturePlan(req: CaptureRequest): CapturePlan {
  const flags = captureFlags(req)
  const source = captureFlags({ sink: req.sink, scope: 'source', subs: req.subs })
  return {
    flags,
    fallbackFlags: flags === source ? null : source,
    needsWindow: needsWindowVo(flags),
    subsIgnored: req.sink === 'exact' && req.scope === 'display'
  }
}

// ---------------------------------------------------------------------------
// The reply path (C01, C20)
// ---------------------------------------------------------------------------

/**
 * Is this reply a path we may use?
 *
 * Deliberately NOT `path.isAbsolute`: that function answers by platform, so the
 * same string is absolute in the app and relative under a posix test runner,
 * which would make this check pass or fail depending on where it ran. The three
 * shapes below are the ones Windows produces, plus a leading slash so a posix
 * dev machine is not lying to itself either.
 *
 * `mpv-shot0002.jpg` — the bare relative name mpv replies with when
 * `screenshot-directory` is unset — is false, which is the whole point.
 */
export function isAbsoluteCapturePath(reply: unknown): reply is string {
  if (typeof reply !== 'string') return false
  const s = reply.trim()
  if (s.length === 0) return false
  if (/^[A-Za-z]:[\\/]/.test(s)) return true // C:\shots\a.png, C:/shots/a.png
  if (s.startsWith('\\\\') || s.startsWith('//')) return true // UNC
  return s.startsWith('/') || s.startsWith('\\')
}

/** The `screenshot` reply shape. `screenshot-to-file` replies `null`. */
export interface ScreenshotReply {
  filename?: unknown
}

export type ReplyFailure = 'no-reply' | 'relative' | 'malformed'

/**
 * The filename out of a `screenshot` reply, or the reason it is unusable.
 *
 * A refused command returns `undefined` in a packaged build (the ownership
 * guard drops it), so "no reply" is a normal branch, not an assertion.
 *
 * THREE reasons, not two, and the third one matters because of what the caller
 * does with it. `'relative'` is the C01 precondition failing, and the caller
 * logs a very specific accusation for it — "screenshot-directory was not in
 * effect, the file is in mpv's cwd". A `filename` that is not a string at all
 * (`{filename: 42}`, an mpv that changed its reply shape) is NOT that: reporting
 * it as `'relative'` makes the C01 diagnostic itself lie, sending the next
 * reader to inspect a setting that was fine. The draft's own test asserted
 * `'relative'` for `{filename: 42}` directly under a comment saying "a
 * non-string filename is a malformed reply, not a relative path" — the comment
 * was right and the assertion was wrong.
 */
export function replyFilename(
  reply: unknown
): { ok: true; filename: string } | { ok: false; reason: ReplyFailure } {
  if (reply === null || typeof reply !== 'object') return { ok: false, reason: 'no-reply' }
  const raw = (reply as ScreenshotReply).filename
  if (raw === undefined || raw === null || raw === '') return { ok: false, reason: 'no-reply' }
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' }
  if (!isAbsoluteCapturePath(raw)) return { ok: false, reason: 'relative' }
  return { ok: true, filename: raw.trim() }
}

// ---------------------------------------------------------------------------
// The filename template (C05)
// ---------------------------------------------------------------------------

/**
 * The default template.
 *
 * `%F` is the filename without extension; `%wH.%wM.%wS.%wT` is the playback
 * position down to milliseconds; `%#02n` is mpv's own disambiguating counter.
 * The dots are deliberate: `%p`/`%P` expand with `:`, which is illegal in a
 * Windows filename, and mpv silently substitutes `_` (measured).
 */
export const DEFAULT_TEMPLATE = '%F_%wH.%wM.%wS.%wT_%#02n'

/** Specifiers that make two captures in the same second distinct (C05). */
const DISAMBIGUATORS = new Set(['n', 'wT', 'wf'])

/** Characters Windows refuses in a filename, minus the separators a template
 *  may legitimately use to write into a subdirectory. */
const ILLEGAL_LITERALS = ['<', '>', ':', '"', '|', '?', '*']

/**
 * Every specifier in a template, in order, with `%%` (a literal percent)
 * correctly skipped.
 *
 * The skip is the reason this is a scanner and not a regex: `%%n` is a literal
 * `%` followed by the letter `n`, so a `/%[#0-9]*n/` test reports a
 * disambiguator in a template that has none and the "mpv will not overwrite"
 * trap comes straight back.
 */
export function templateSpecifiers(tpl: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < tpl.length) {
    if (tpl[i] !== '%') {
      i++
      continue
    }
    const next = tpl[i + 1]
    if (next === undefined) break
    if (next === '%') {
      i += 2
      continue
    }
    // `%[#][0X]n` — flags sit between the % and the letter.
    let j = i + 1
    while (j < tpl.length) {
      const f = tpl[j] as string
      if (f === '#' || (f >= '0' && f <= '9')) j++
      else break
    }
    const c = tpl[j]
    if (c === undefined) break
    if (c === '{') {
      // `%{property:fallback}`
      const end = tpl.indexOf('}', j)
      out.push(end === -1 ? tpl.slice(j) : tpl.slice(j, end + 1))
      i = end === -1 ? tpl.length : end + 1
      continue
    }
    if (c === 'w' || c === 't') {
      const c2 = tpl[j + 1]
      out.push(c2 === undefined ? c : c + c2)
      i = c2 === undefined ? j + 1 : j + 2
      continue
    }
    if (c === 'X' && tpl[j + 1] === '{') {
      const end = tpl.indexOf('}', j + 1)
      out.push(end === -1 ? tpl.slice(j) : tpl.slice(j, end + 1))
      i = end === -1 ? tpl.length : end + 1
      continue
    }
    out.push(c)
    i = j + 1
  }
  return out
}

/** Does the template distinguish two captures taken in the same second? */
export function hasDisambiguator(tpl: string): boolean {
  return templateSpecifiers(tpl).some((s) => DISAMBIGUATORS.has(s))
}

/**
 * The template to actually give mpv.
 *
 * An empty template falls back to the default; a template with no
 * disambiguator gets `_%#02n` appended, because mpv refuses to overwrite and
 * the second capture in a second would otherwise vanish with no error the user
 * can see (C05).
 */
export function normalizeTemplate(tpl: string | undefined | null): string {
  const t = (tpl ?? '').trim()
  if (t.length === 0) return DEFAULT_TEMPLATE
  if (hasDisambiguator(t)) return t
  return `${t}_%#02n`
}

export type TemplateWarning = 'colon-specifier' | 'illegal-literal' | 'no-disambiguator'

/**
 * What is wrong with a template the user typed, for the settings UI.
 *
 * These are warnings and not errors on purpose: mpv accepts all three and does
 * something surprising rather than failing, which is precisely why they need
 * saying out loud.
 */
export function templateWarnings(tpl: string): TemplateWarning[] {
  const out: TemplateWarning[] = []
  const specs = templateSpecifiers(tpl)
  if (specs.some((s) => s === 'p' || s === 'P')) out.push('colon-specifier')
  // Literal text is the template minus its specifiers.
  let literal = tpl
  for (const s of specs) literal = literal.replace(`%${s}`, '')
  if (ILLEGAL_LITERALS.some((c) => literal.includes(c))) out.push('illegal-literal')
  if (!hasDisambiguator(tpl)) out.push('no-disambiguator')
  return out
}

// ---------------------------------------------------------------------------
// Burst capture (C08)
// ---------------------------------------------------------------------------

/** 'time' is the interval timer; 'frame' steps one frame per shot (paused only). */
export type BurstMode = 'time' | 'frame'

export interface BurstConfig {
  count: number
  intervalMs: number
  mode: BurstMode
}

export const BURST_MIN_COUNT = 1
export const BURST_MAX_COUNT = 500
export const BURST_MIN_INTERVAL_MS = 100
export const BURST_MAX_INTERVAL_MS = 60_000
/**
 * Frame mode has no interval: each shot is followed by a `frame-step`, and
 * `frame-step` REPLIES BEFORE IT MOVES (§7.7 trap 2), so a small gap is what
 * keeps the next capture from grabbing the same frame twice. It is not an
 * interval the user chose, so it is not a setting.
 */
export const BURST_FRAME_GAP_MS = 80

export function clampBurst(c: Partial<BurstConfig>): BurstConfig {
  const rawCount = Number(c.count)
  const rawInterval = Number(c.intervalMs)
  const count = Number.isFinite(rawCount)
    ? Math.min(BURST_MAX_COUNT, Math.max(BURST_MIN_COUNT, Math.floor(rawCount)))
    : 10
  const intervalMs = Number.isFinite(rawInterval)
    ? Math.min(BURST_MAX_INTERVAL_MS, Math.max(BURST_MIN_INTERVAL_MS, Math.floor(rawInterval)))
    : 1000
  return { count, intervalMs, mode: c.mode === 'frame' ? 'frame' : 'time' }
}

/** The delay between two shots of a burst. */
export function burstGapMs(c: BurstConfig): number {
  return c.mode === 'frame' ? BURST_FRAME_GAP_MS : c.intervalMs
}

export interface BurstState {
  config: BurstConfig
  done: number
  /** Set once the burst has been asked to stop; the next tick is a no-op. */
  stopping: boolean
}

export function startBurst(config: BurstConfig): BurstState {
  return { config, done: 0, stopping: false }
}

export type BurstStep =
  | { action: 'capture'; index: number; last: boolean }
  | { action: 'finish'; reason: 'complete' | 'cancelled' }

/** What the next tick should do. Pure, so the timer body has no branching. */
export function burstStep(s: BurstState): BurstStep {
  if (s.stopping) return { action: 'finish', reason: 'cancelled' }
  if (s.done >= s.config.count) return { action: 'finish', reason: 'complete' }
  return { action: 'capture', index: s.done, last: s.done + 1 >= s.config.count }
}

export function burstFraction(s: BurstState): number {
  if (s.config.count <= 0) return 1
  return Math.min(1, s.done / s.config.count)
}

// ---------------------------------------------------------------------------
// The recent-capture stack (C24)
// ---------------------------------------------------------------------------

/** Only files THIS session reported writing are ever deletable (C24). */
export const RECENT_LIMIT = 20

export function pushRecent(list: readonly string[], file: string, limit = RECENT_LIMIT): string[] {
  const out = [file, ...list.filter((f) => f !== file)]
  return out.slice(0, Math.max(1, limit))
}

export function popRecent(list: readonly string[]): { file: string | null; rest: string[] } {
  const [first, ...rest] = list
  return { file: first ?? null, rest }
}

// ---------------------------------------------------------------------------
// Image format (C06)
// ---------------------------------------------------------------------------

/** mpv has no BMP writer; PNG is the lossless option we offer instead (C06). */
export const CAPTURE_FORMATS = ['png', 'jpg', 'webp', 'jxl', 'avif'] as const
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number]

export function normalizeFormat(v: unknown): CaptureFormat {
  return CAPTURE_FORMATS.includes(v as CaptureFormat) ? (v as CaptureFormat) : 'png'
}

/** The extension the clipboard's temp file must carry so mpv picks the writer
 *  we want. `screenshot-to-file` chooses the format from the extension. */
export function tempCaptureName(seq: number, now: number): string {
  return `rlplayer-clip-${now.toString(36)}-${seq}.png`
}

/** The eight-byte PNG signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Did mpv actually write a PNG?
 *
 * The clipboard path (C03) reads the temp file back and hands the bytes to
 * Electron, and a zero-byte or half-written file is a real outcome: screenshot
 * encoding is asynchronous, so the reply can land before the writer has
 * finished, and a refused command leaves no file at all. Checking the signature
 * is both cheaper and stricter than decoding the image to ask whether it
 * decoded — and it is a pure function over bytes, so it is testable without a
 * display, an Electron runtime or a real capture.
 */
export function looksLikePng(bytes: Uint8Array | undefined | null): boolean {
  if (!bytes || bytes.length < PNG_MAGIC.length) return false
  return PNG_MAGIC.every((b, i) => bytes[i] === b)
}

// ---------------------------------------------------------------------------
// Custom capture width (C07)
// ---------------------------------------------------------------------------

/**
 * C07 has NO mpv option, and the spec is explicit that a `vf` is the wrong
 * answer: scaling the live chain would change what the user is watching. So the
 * resize happens after the fact, on the file mpv already wrote.
 *
 * That constrains it to the formats the platform can RE-ENCODE. Electron's
 * `nativeImage` exposes exactly two encoders, `toPNG()` and `toJPEG(q)`; there
 * is no `toWebP`, no JXL and no AVIF. So a resize request against a `webp`,
 * `jxl` or `avif` capture cannot be honoured without silently changing the
 * user's chosen container, and this module refuses instead — the one thing C04
 * establishes as never acceptable is doing something different from what was
 * asked without saying so.
 */
export const RESIZE_ENCODABLE = ['png', 'jpg'] as const

export function canReencode(format: string): boolean {
  return (RESIZE_ENCODABLE as readonly string[]).includes(format)
}

/** 0 (and anything unusable) means "keep the source size" — the default. */
export const RESIZE_MIN_WIDTH = 64
export const RESIZE_MAX_WIDTH = 7680

export function clampResizeWidth(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(RESIZE_MAX_WIDTH, Math.max(RESIZE_MIN_WIDTH, Math.floor(n)))
}

export type ResizeDecision =
  | { action: 'skip'; reason: 'off' | 'not-encodable' | 'already-small' }
  | { action: 'resize'; width: number }

/**
 * Whether to rewrite a capture at a narrower width.
 *
 * `already-small` is not an optimisation: re-encoding a frame that is already
 * at or below the target width would strip the source's bit depth and, for
 * JPEG, add a second generation of loss for no change in size. Upscaling a
 * capture is never what "capture at 640px" means.
 */
export function resizeDecision(
  targetWidth: number,
  sourceWidth: number | undefined,
  format: string
): ResizeDecision {
  const w = clampResizeWidth(targetWidth)
  if (w === 0) return { action: 'skip', reason: 'off' }
  if (!canReencode(format)) return { action: 'skip', reason: 'not-encodable' }
  if (typeof sourceWidth === 'number' && sourceWidth > 0 && sourceWidth <= w) {
    return { action: 'skip', reason: 'already-small' }
  }
  return { action: 'resize', width: w }
}
