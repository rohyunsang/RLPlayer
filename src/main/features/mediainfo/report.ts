/**
 * M29 mediainfo -- L25, "copy media info to clipboard".
 *
 * L25 is one line of spec ("`clipboard.writeText(renderInfoAsText(snapshot))`,
 * grouped `Key: value` lines") with one hard requirement attached: "Include
 * `hwdec-current`, `current-vo`, `video-params/pixelformat` and `mpv-version` --
 * those four are what make a rendering bug report actionable." Section 6.3 turns
 * that into M29's acceptance criterion: "'copy info' output pasted into an issue
 * contains `hwdec-current` and `current-vo`".
 *
 * So the report ends with a DIAGNOSTICS block that prints those under their real
 * mpv property names, not under translated labels. That is deliberate: a
 * maintainer reading a pasted report has to be able to grep it for the property,
 * and a Korean UI would otherwise emit `하드웨어 디코더: d3d11va`, which satisfies
 * the letter of the row and none of its purpose. `report.test.ts` asserts the
 * four literal names survive in both languages, so a future relabelling cannot
 * quietly break the criterion.
 *
 * Pure: it takes the snapshot, a `t()` and the diagnostic map, and returns a
 * string.
 */
import type { MediaInfoState } from './wire.ts'

export type Translate = (key: string, params?: Record<string, string | number>) => string

export interface ReportOptions {
  /** Literal mpv property name -> value. Printed verbatim (see the header). */
  diagnostics: Readonly<Record<string, string>>
  /** Tag rows can be long and are off by default (`mediainfo.copyIncludesTags`). */
  includeTags: boolean
  /** L24's per-track detail. Off by default: the summaries are usually enough. */
  includeTrackDetail: boolean
}

const RULE = '-'.repeat(52)

/**
 * A label that reads the same in a plain-text report as it does in the panel.
 *
 * A tag row's `labelKey` is the raw tag name (see `tagsGroup` in snapshot.ts) and
 * `t()` returns an unknown key unchanged, so this needs no special case -- which
 * is the reason tags were modelled that way.
 */
function line(t: Translate, labelKey: string, value: string): string {
  return `${t(labelKey)}: ${value}`
}

export function renderInfoAsText(
  state: MediaInfoState,
  t: Translate,
  o: ReportOptions
): string {
  const out: string[] = []
  out.push(t('mediainfo.report.heading'))
  out.push(RULE)
  if (!state.available) {
    out.push(t('mediainfo.empty'))
    return out.join('\r\n')
  }

  for (const group of state.groups) {
    if (group.id === 'tags' && !o.includeTags) continue
    out.push('')
    out.push(`[${t(group.titleKey)}]`)
    for (const r of group.rows) out.push(line(t, r.labelKey, r.value))
  }

  if (state.tracks.length > 0) {
    out.push('')
    out.push(`[${t('mediainfo.group.tracks')}]`)
    for (const tr of state.tracks) {
      const mark = tr.selected ? '*' : ' '
      out.push(`${mark} ${tr.type}: ${tr.summary}`)
      if (o.includeTrackDetail) {
        for (const r of tr.detail) out.push(`    ${line(t, r.labelKey, r.value)}`)
      }
    }
  }

  // Last, and under the real property names. See the file header.
  const diag = Object.entries(o.diagnostics)
  if (diag.length > 0) {
    out.push('')
    out.push(`[${t('mediainfo.group.diagnostics')}]`)
    for (const [prop, value] of diag) out.push(`${prop}: ${value}`)
  }

  // CRLF: this string goes to the Windows clipboard and gets pasted into
  // Notepad and into GitHub. LF-only text is one paragraph in the first.
  return out.join('\r\n')
}

/**
 * The properties the diagnostics block prints, in the order L25 lists them.
 *
 * Exported so `index.ts` reads exactly this set and the test can assert the
 * four required names are in it -- rather than the test asserting about a string
 * that happens to contain them today.
 */
export const DIAGNOSTIC_PROPERTIES: readonly string[] = [
  'hwdec-current',
  'hwdec-interop',
  'current-vo',
  'current-gpu-context',
  'current-ao',
  'video-params/pixelformat',
  'mpv-version'
]
