/**
 * M12 audio-eq — the pure half: the `anequalizer` graph, the preamp and the
 * gain arithmetic. No ctx, no Electron, no fs, so `eq.test.ts` can assert the
 * exact strings that go on the wire instead of a paraphrase of them.
 *
 * EVERY LITERAL HERE IS FROM §2's A01/A03 ROWS, which were measured against the
 * pinned mpv over JSON IPC. Do not tidy them:
 *
 *  - the widths are NOT derived from the frequencies (they are the row's own
 *    table), and `t=0` is Butterworth;
 *  - entries are separated by `|` and parameters by SPACES. That is what keeps
 *    the spec comma-free, and it has to stay that way: the af chain joins slots
 *    with `,`, so one comma inside this spec splits the graph and every other
 *    module's filter with it;
 *  - `superequalizer` is NOT an option (A48): its gains are linear multipliers,
 *    its range is 0-20, and it refuses `af-command`, so every slider drag would
 *    reinitialise the chain.
 */

/**
 * A01's band table now lives in `@shared/features/audio-eq/wire`, which is the
 * one file BOTH halves of this module compile, and is re-exported here so every
 * existing importer (and `eq.test.ts`, which asserts the literals) is unchanged.
 *
 * It moved because `EqState`'s own comment used to read "the renderer CANNOT
 * import them: the two halves of a module have no file they both own". They do
 * now, it is owned by M12, and `src/shared/**` is in both tsconfigs.
 */
export {
  BAND_COUNT,
  BAND_FREQ,
  BAND_WIDTH,
  GAIN_LIMIT
} from '@shared/features/audio-eq/wire'
import { BAND_COUNT, BAND_FREQ, BAND_WIDTH, GAIN_LIMIT } from '@shared/features/audio-eq/wire'

/**
 * Declare c0-c7 once and never touch the channel count again.
 *
 * A01, verified: `change` indices count every DECLARED entry (0-79 accepted,
 * 200 rejected) and entries for channels the stream does not have are silently
 * ignored. So a fixed 8-channel declaration is correct for stereo and for 7.1
 * alike, and no part of this module has to know the layout of the current file.
 */
export const CHANNEL_COUNT = 8


/** The lavfi FILTER NAME — the fourth argument of `af-command` (A27). Not the
 *  label, not 'all': both of those fail. */
export const EQ_FILTER = 'anequalizer'
export const PREAMP_FILTER = 'volume'

/** A number for mpv: at most one decimal, no `-0`, no exponent. */
export function formatNumber(value: number): string {
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 10) / 10
  const safe = Object.is(rounded, -0) ? 0 : rounded
  return String(safe)
}

/** Clamp to the +/-12 dB the row specifies, at 0.1 dB resolution. */
export function clampGain(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  const rounded = Math.round(n * 10) / 10
  const clamped = Math.min(GAIN_LIMIT, Math.max(-GAIN_LIMIT, rounded))
  return Object.is(clamped, -0) ? 0 : clamped
}

/** Exactly ten clamped gains, whatever came in. Short input is padded with 0,
 *  long input is truncated: a preset file is user-editable and may be wrong. */
export function normaliseGains(input: unknown): number[] {
  const list = Array.isArray(input) ? input : []
  const out: number[] = []
  for (let i = 0; i < BAND_COUNT; i++) out.push(clampGain(list[i] ?? 0))
  return out
}

export function flatGains(): number[] {
  return new Array<number>(BAND_COUNT).fill(0)
}

export function isFlat(gains: readonly number[]): boolean {
  return normaliseGains(gains).every((g) => g === 0)
}

/**
 * The settings value is a STRING of ten comma-separated dB values, not an
 * array, and that is deliberate.
 *
 * `core/settings/registry` compares a new value to the old and to the
 * descriptor's default with `Object.is`. For an array that is reference
 * identity, so an array-valued setting can never equal its default and P51's
 * "only store what differs" would keep a flat EQ in the file forever. A string
 * compares by value and round-trips through JSON unchanged.
 */
export function serialiseGains(gains: readonly number[]): string {
  return normaliseGains(gains).map(formatNumber).join(',')
}

export function parseGains(value: unknown): number[] {
  if (Array.isArray(value)) return normaliseGains(value)
  if (typeof value !== 'string') return flatGains()
  return normaliseGains(value.split(',').map((s) => Number(s.trim())))
}

/** The index `af-command … change` addresses: entries are counted across the
 *  whole declaration, channel-major. */
export function entryIndex(channel: number, band: number): number {
  return channel * BAND_COUNT + band
}

/** One `c<n> f=<hz> w=<hz> g=<dB> t=0` entry. */
function entry(channel: number, band: number, gain: number): string {
  return `c${channel} f=${BAND_FREQ[band]} w=${BAND_WIDTH[band]} g=${formatNumber(gain)} t=0`
}

/**
 * The whole graph, WITHOUT the `@rleq:` label — the chain adds that (§5).
 * 80 entries: ten bands on each of eight declared channels.
 */
export function equaliserSpec(gains: readonly number[]): string {
  const g = normaliseGains(gains)
  const entries: string[] = []
  for (let c = 0; c < CHANNEL_COUNT; c++) {
    for (let b = 0; b < BAND_COUNT; b++) entries.push(entry(c, b, g[b] as number))
  }
  return `lavfi=[${EQ_FILTER}=${entries.join('|')}]`
}

/**
 * The third argument of `['af-command','rleq','change', <this>, 'anequalizer']`.
 *
 * `f` and `w` are repeated on every change because the command replaces the
 * whole entry; leaving them out resets the band to defaults.
 */
export function changeArg(channel: number, band: number, gain: number): string {
  return `${entryIndex(channel, band)}|f=${BAND_FREQ[band]}|w=${BAND_WIDTH[band]}|g=${formatNumber(
    clampGain(gain)
  )}`
}

/** Every `change` argument for one band — one per declared channel. */
export function changeArgsForBand(band: number, gain: number): string[] {
  const out: string[] = []
  for (let c = 0; c < CHANNEL_COUNT; c++) out.push(changeArg(c, band, gain))
  return out
}

/**
 * A03. What EqualizerAPO users expect: enough attenuation to undo the largest
 * BOOST, so a preset that lifts a band by 8 dB cannot clip. Cuts never need
 * headroom, so a preset that only attenuates gets a preamp of 0.
 */
export function autoPreamp(gains: readonly number[]): number {
  const peak = Math.max(0, ...normaliseGains(gains))
  return clampGain(-peak)
}

export function effectivePreamp(
  gains: readonly number[],
  auto: boolean,
  manual: number
): number {
  return auto ? autoPreamp(gains) : clampGain(manual)
}

/** The `volume` filter's value, as `af-command` takes it: `-6dB`, `0dB`. */
export function preampValue(db: number): string {
  return `${formatNumber(clampGain(db))}dB`
}

/**
 * A03, without the label. `precision=float` avoids requantising the sample
 * format on the way through, which is the whole reason this is a separate slot
 * rather than a gain baked into the equaliser.
 */
export function preampSpec(db: number): string {
  return `lavfi=[${PREAMP_FILTER}=volume=${preampValue(db)}:precision=float]`
}
