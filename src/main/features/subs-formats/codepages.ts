/**
 * S33/S34 — the character-encoding table.
 *
 * Every `mpv` value below was issued against the PINNED binary
 * (mpv v0.41.0-923-g7b8915bc1, uchardet=enabled) over the command line with a
 * CP949 SAMI file, and the resulting `sub-text` was read back. All ten are
 * accepted and all ten re-decode:
 *
 *   auto        Using charset 'UHC'      안녕하세요 …      <- uchardet
 *   +cp949                               안녕하세요 …
 *   +euc-kr                              안녕하세요 …
 *   +utf-8                               <replacement chars>
 *   +utf-16le                            <replacement chars>
 *   +cp932                               ¾ȳçÇϼ¼¿ä
 *   +gb18030                             救崇窍技夸
 *   +big5                                寰喟ж撮蹂
 *   +cp1252                              ¾È³çÇÏ¼¼¿ä
 *   +cp1251                              ѕИізЗПјјїд
 *
 * The leading `+` means FORCE. Without it mpv short-circuits to UTF-8 whenever
 * the bytes happen to validate as UTF-8, so a plain `cp949` is not an override
 * at all for a file that is accidentally valid UTF-8 — which every ASCII-only
 * subtitle is.
 *
 * `decoder` is the WHATWG label this project's own converter (S03/S04/S07)
 * passes to `TextDecoder`, which is a DIFFERENT namespace from mpv's iconv
 * names. Measured under Node 24 / Electron: `'cp949'` THROWS
 * (`The "cp949" encoding is not supported`) while `'euc-kr'` and
 * `'windows-949'` both resolve to the full CP949/UHC index. That is why the two
 * columns exist instead of one string being reused.
 */

export interface CodepageEntry {
  /** The exact value written to mpv's `sub-codepage`. */
  readonly mpv: string
  /** The WHATWG `TextDecoder` label for our own converter, or null for `auto`. */
  readonly decoder: string | null
  /** i18n key, namespaced under this module. */
  readonly labelKey: string
}

export const CODEPAGES: readonly CodepageEntry[] = [
  { mpv: 'auto', decoder: null, labelKey: 'subs-formats.cp.auto' },
  { mpv: '+cp949', decoder: 'euc-kr', labelKey: 'subs-formats.cp.cp949' },
  { mpv: '+euc-kr', decoder: 'euc-kr', labelKey: 'subs-formats.cp.euckr' },
  { mpv: '+utf-8', decoder: 'utf-8', labelKey: 'subs-formats.cp.utf8' },
  { mpv: '+utf-16le', decoder: 'utf-16le', labelKey: 'subs-formats.cp.utf16le' },
  { mpv: '+cp932', decoder: 'shift_jis', labelKey: 'subs-formats.cp.cp932' },
  { mpv: '+gb18030', decoder: 'gb18030', labelKey: 'subs-formats.cp.gb18030' },
  { mpv: '+big5', decoder: 'big5', labelKey: 'subs-formats.cp.big5' },
  { mpv: '+cp1252', decoder: 'windows-1252', labelKey: 'subs-formats.cp.cp1252' },
  { mpv: '+cp1251', decoder: 'windows-1251', labelKey: 'subs-formats.cp.cp1251' }
]

export const DEFAULT_CODEPAGE = 'auto'

export function codepageEntry(mpvValue: string): CodepageEntry | undefined {
  return CODEPAGES.find((c) => c.mpv === mpvValue)
}

/** The `enum` descriptor options, in table order. */
export function codepageOptions(): ReadonlyArray<{ value: string; labelKey: string }> {
  return CODEPAGES.map((c) => ({ value: c.mpv, labelKey: c.labelKey }))
}

/**
 * The `TextDecoder` label our converter should use for a forced codepage, or
 * `null` when the user left the setting on `auto` and the converter must run its
 * own detector (`detectEncoding`).
 */
export function decoderFor(mpvValue: string): string | null {
  return codepageEntry(mpvValue)?.decoder ?? null
}
