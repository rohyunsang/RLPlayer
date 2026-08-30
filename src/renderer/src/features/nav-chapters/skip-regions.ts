/**
 * N51's renderer-side arithmetic and the payload types, with no DOM in it.
 *
 * ---------------------------------------------------------------------------
 * THE TYPES BELOW ARE A DUPLICATE, AND THAT IS A REPORTED DEFECT, NOT A CHOICE.
 *
 * §10 of the API guide says the two halves of a module "DO have a file they both
 * compile: `src/shared/features/<your id>/`", and that the directory is listed in
 * the row's `ownedFiles`. M25's row lists exactly two paths --
 * `src/main/features/nav-chapters/` and `src/renderer/src/features/nav-chapters/`
 * -- so there is no such directory for this module, and creating one is not this
 * module's edit to make. Measured, rather than assumed:
 *
 *     $ echo 'export const x = 1' > src/shared/features/nav-chapters/wire.ts
 *     $ node scripts/check-partition.mjs
 *     check:partition found 1 problem(s):
 *       src/shared/features/nav-chapters/wire.ts
 *         is owned by NOBODY. Add it to exactly one row's ownedFiles ...
 *
 * M12, M26 and M27 all have `src/shared/features/<id>/` in their rows; M25 does
 * not. So `SkipPanelState` and `SkipPrompt` are written twice -- here and in
 * `src/main/features/nav-chapters/skip-intro.ts` -- and the two must be kept in
 * step by hand, which is precisely the failure §10 was added to end. One line in
 * `modules.json` fixes it.
 * ---------------------------------------------------------------------------
 */

export interface SkipPanelState {
  open: boolean
  enabled: boolean
  mode: 'prompt' | 'auto'
  hasFile: boolean
  folderLabel: string
  introStart: number | null
  introEnd: number | null
  endingStart: number | null
  source: 'manual' | 'learned' | 'fingerprint' | null
  detecting: boolean
  fingerprintOptIn: boolean
  duration: number
}

/** `kind: null` means "take the button away". */
export interface SkipPrompt {
  kind: 'intro' | 'ending' | null
  ms?: number
  label?: string
}

export const EMPTY_STATE: SkipPanelState = {
  open: false,
  enabled: false,
  mode: 'prompt',
  hasFile: false,
  folderLabel: '',
  introStart: null,
  introEnd: null,
  endingStart: null,
  source: null,
  detecting: false,
  fingerprintOptIn: false,
  duration: 0
}

export interface RegionBand {
  kind: 'intro' | 'ending'
  /** Percent of the bar, 0..100. */
  leftPct: number
  widthPct: number
}

/**
 * The bands to paint on the seek bar, in percent.
 *
 * Percent rather than pixels because the layer is repainted on every state push
 * and the bar's width changes with the window; a percentage survives a resize
 * with no repaint at all.
 *
 * Zero-width and out-of-range bands are dropped rather than clamped to a sliver.
 * A 1-pixel stripe at the left edge of the bar, on a file whose window does not
 * really apply, is a lie that costs the user a moment every time they look at it,
 * and `resolveWindows()` on the main side has already declined to produce a
 * window it does not believe -- so anything degenerate arriving here is a bug
 * worth showing as nothing rather than as almost-nothing.
 */
export function regionBands(s: SkipPanelState): RegionBand[] {
  const out: RegionBand[] = []
  if (!(s.duration > 0)) return out
  const band = (kind: 'intro' | 'ending', from: number, to: number): void => {
    const a = Math.max(0, Math.min(from, s.duration))
    const b = Math.max(0, Math.min(to, s.duration))
    if (!(b > a)) return
    const width = ((b - a) / s.duration) * 100
    if (width < 0.15) return
    out.push({ kind, leftPct: (a / s.duration) * 100, widthPct: width })
  }
  if (s.introEnd !== null) band('intro', s.introStart ?? 0, s.introEnd)
  if (s.endingStart !== null) band('ending', s.endingStart, s.duration)
  return out
}

/** `0:00`, `1:35`, `1:02:05`. The same shape the main half's OSD uses. */
export function clock(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** `12:00 - 1:35`, or null when this half of the window is not set. */
export function rangeLabel(from: number | null, to: number | null): string | null {
  const a = clock(from)
  const b = clock(to)
  if (b === null) return null
  return a === null ? b : `${a} – ${b}`
}

export function sanitizePrompt(raw: unknown): SkipPrompt | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r['kind']
  if (kind === null) return { kind: null }
  if (kind !== 'intro' && kind !== 'ending') return null
  const ms = typeof r['ms'] === 'number' && r['ms'] > 0 ? r['ms'] : 5000
  const label = typeof r['label'] === 'string' && r['label'] !== '' ? r['label'] : undefined
  return label === undefined ? { kind, ms } : { kind, ms, label }
}
