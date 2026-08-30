/**
 * S33's startup assertion: `uchardet` must be in mpv's feature list.
 *
 * WHY IT IS AN ASSERTION AND NOT A COMMENT. `--sub-codepage` defaults to `auto`,
 * and `auto` means "BOM, then valid-UTF-8, then **uchardet**, then
 * UTF-8-BROKEN". If the bundled binary is ever swapped for a build without
 * uchardet, `auto` falls through to UTF-8-BROKEN and every CP949 subtitle in
 * Korea becomes mojibake — with no error, no warning and nothing in the log. A
 * silent degradation of the single most market-critical behaviour in the product
 * is exactly the thing that has to fail loudly at boot.
 *
 * HOW, measured on the pinned binary (mpv v0.41.0-923-g7b8915bc1):
 *
 *   $ mpv --no-config --version                 -> no feature list at all
 *   $ mpv --no-config -v --version              -> "List of enabled features: … uchardet …"
 *                                                  exits immediately, 0.155 s
 *   $ mpv --no-config --msg-level=all=no -v --version
 *                                               -> feature list SUPPRESSED
 *
 * That third line is why this does not go through `ctx.engine.spawn()`, which
 * would otherwise be the sanctioned way to run a second mpv: core always applies
 * `--msg-level=all=no`, which silences the one line being looked for, and always
 * applies `--idle=yes` and an IPC pipe, which a `--version` probe neither needs
 * nor survives. So the probe uses `ctx.paths.mpvBinary()` — which §12 sanctions
 * for exactly "a version string in a bug report" — and hands the child to
 * `ctx.lifecycle.trackProcess()` so it is still reaped on the quit path.
 */

export interface McapabilityReport {
  readonly features: readonly string[]
  readonly hasUchardet: boolean
  readonly version: string
}

const FEATURE_LINE = /List of enabled features:\s*(.*)/i
const VERSION_LINE = /^mpv\s+(\S+)/m

/**
 * Parse `mpv -v --version` output.
 *
 * Pure, and tested against the real captured output, because the failure mode
 * being guarded against is "the parse silently returns `hasUchardet: true` for
 * output that does not contain it" — a check that lies is worse than no check.
 * `features` is empty when the line is absent, and `hasUchardet` is then false:
 * an unreadable probe must read as "cannot confirm", never as "fine".
 */
export function parseMpvFeatures(stdout: string): McapabilityReport {
  const m = FEATURE_LINE.exec(stdout)
  const features = m?.[1] ? m[1].trim().split(/\s+/).filter((f) => f.length > 0) : []
  return {
    features,
    hasUchardet: features.includes('uchardet'),
    version: VERSION_LINE.exec(stdout)?.[1] ?? 'unknown'
  }
}

/** The arguments the probe must use, kept here so the test can assert them. */
export const PROBE_ARGS: readonly string[] = ['--no-config', '-v', '--version']
