/**
 * M29 mediainfo -- L26, "file properties dialog (our own)".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PANEL TAB AND NOT A SECOND WINDOW
 * ---------------------------------------------------------------------------
 * L26 says "render in a second BrowserWindow mirroring the settings-window
 * pattern". A feature module cannot do that:
 *
 *   - `new BrowserWindow` in a file under `src/main/features/**` is a hard
 *     failure of `npm run check:forbidden`
 *     ("no feature module constructs a BrowserWindow");
 *   - `WindowService` (docs/parity/02-wave0-api.md section 8) is the whole of the
 *     sanctioned window surface and it has no "open a window of my own": every
 *     method on it operates on the two windows core already made;
 *   - the settings window itself is opened from `src/main/ipc.ts`, which is in
 *     this module's `mustNotTouch`.
 *
 * So the properties VIEW is a third tab of M29's own `ctx.panel()`, which is
 * entirely this module's. Everything the row asks for survives that move --
 * `fs.statSync` size/dates, the probe snapshot, a "show in folder" button and a
 * "copy" button -- and the one thing that does not is the separate window. That
 * is reported rather than worked around; see the module report.
 *
 * This file is the PURE half: it turns a stat result plus a snapshot into the
 * rows the tab renders. `fs` is injected, so `properties.test.ts` runs with no
 * disk.
 */
import {
  containerLabel,
  formatBytes,
  formatDuration,
  formatTimestamp,
  textOr,
  UNKNOWN
} from './format.ts'
import type { FileProperties, InfoRow, MediaInfoState } from './wire.ts'

export interface StatResult {
  size: number
  birthtimeMs: number
  mtimeMs: number
}

export interface PropertiesDeps {
  /** `fs.statSync`, or null when the path is gone or is not a local file. */
  stat(path: string): StatResult | null
}

/**
 * Split a path the way the view labels it. Pure string work: a network source
 * has no directory and must not be reported as having one.
 */
export function splitPath(p: string): { directory: string; filename: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return { directory: '', filename: p }
  const slash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (slash < 0) return { directory: '', filename: p }
  return { directory: p.slice(0, slash), filename: p.slice(slash + 1) }
}

/**
 * L26's row set.
 *
 * The dates come from the filesystem and the media facts come from the snapshot
 * that is already built (L23), because the alternative is a second reader of the
 * same properties and therefore a second answer to "how long is this file".
 *
 * `birthtimeMs` is deliberately allowed to be absent rather than defaulted:
 * on some volumes (and on every network share this project has been run
 * against) Windows reports 0, and "1970-01-01 09:00:00" in a properties dialog
 * is worse than no row at all.
 */
export function buildProperties(
  state: MediaInfoState,
  deps: PropertiesDeps
): FileProperties | null {
  const path = state.path
  if (path === null || path.length === 0) return null

  const { directory, filename } = splitPath(path)
  const stat = state.network ? null : deps.stat(path)

  const rows: InfoRow[] = []
  const push = (labelKey: string, value: string): void => {
    if (value !== UNKNOWN) rows.push({ labelKey, value })
  }

  push('mediainfo.f.filename', filename)
  push('mediainfo.f.directory', directory)
  push('mediainfo.f.path', path)
  push('mediainfo.f.size', formatBytes(stat?.size))
  push('mediainfo.f.created', formatTimestamp(stat?.birthtimeMs))
  push('mediainfo.f.modified', formatTimestamp(stat?.mtimeMs))

  // The three media facts a shell properties tab would not know: they come from
  // the one snapshot, so this tab can never disagree with the info tab.
  const general = state.groups.find((g) => g.id === 'general')
  const fromGeneral = (labelKey: string): void => {
    const hit = general?.rows.find((r) => r.labelKey === labelKey)
    if (hit) rows.push(hit)
  }
  fromGeneral('mediainfo.f.container')
  fromGeneral('mediainfo.f.duration')
  fromGeneral('mediainfo.f.overallBitrate')
  fromGeneral('mediainfo.f.title')

  return {
    path,
    filename,
    directory,
    sizeBytes: stat ? stat.size : null,
    createdMs: stat && stat.birthtimeMs > 0 ? Math.round(stat.birthtimeMs) : null,
    modifiedMs: stat && stat.mtimeMs > 0 ? Math.round(stat.mtimeMs) : null,
    rows
  }
}

/**
 * The same view for a file that is NOT playing, built from a probe summary.
 *
 * L40's tooltip and L21's columns need this; so does the properties tab when the
 * user asks about a playlist row rather than the current file. It is a different
 * source (`demux-*` claims, not `video-params`) and the labels already say so.
 */
export function buildPropertiesFromProbe(
  path: string,
  probeRows: readonly InfoRow[],
  container: string | null,
  durationSec: number | null,
  deps: PropertiesDeps
): FileProperties {
  const { directory, filename } = splitPath(path)
  const stat = deps.stat(path)
  const rows: InfoRow[] = []
  const push = (labelKey: string, value: string): void => {
    if (value !== UNKNOWN) rows.push({ labelKey, value })
  }
  push('mediainfo.f.filename', filename)
  push('mediainfo.f.directory', directory)
  push('mediainfo.f.path', path)
  push('mediainfo.f.size', formatBytes(stat?.size))
  push('mediainfo.f.created', formatTimestamp(stat?.birthtimeMs))
  push('mediainfo.f.modified', formatTimestamp(stat?.mtimeMs))
  push('mediainfo.f.container', containerLabel(container))
  push('mediainfo.f.duration', formatDuration(durationSec))
  for (const r of probeRows) {
    // The probe's own duration/size/container rows are already above, and a
    // second copy under a slightly different label is how a panel starts
    // looking like it disagrees with itself.
    if (
      r.labelKey === 'mediainfo.f.duration' ||
      r.labelKey === 'mediainfo.f.size' ||
      r.labelKey === 'mediainfo.f.container'
    ) {
      continue
    }
    push(r.labelKey, textOr(r.value))
  }
  return {
    path,
    filename,
    directory,
    sizeBytes: stat ? stat.size : null,
    createdMs: stat && stat.birthtimeMs > 0 ? Math.round(stat.birthtimeMs) : null,
    modifiedMs: stat && stat.mtimeMs > 0 ? Math.round(stat.mtimeMs) : null,
    rows
  }
}
