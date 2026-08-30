/**
 * M36 R06 — finding yt-dlp, and the licensing reason we never ship it.
 *
 * R06's verdict, quoted so nobody re-opens it: "yt-dlp source is Unlicense, but
 * the published PyInstaller executables are stated by the project to be
 * GPLv3+. Shipping that `.exe` inside an MIT app's ZIP is at best mere
 * aggregation. Not bundling it is simultaneously the licensing-safe,
 * no-bundled-junk and update-problem answer. Do all three at once."
 *
 * So this file only ever LOOKS. Nothing here downloads anything, and the whole
 * search is filesystem reads plus (on explicit user action) one `--version`
 * probe. It is pure apart from an injected `exists` predicate, so the order —
 * which is the part that decides which of two installed copies wins — is
 * testable without a machine that has yt-dlp on it.
 */

import path from 'node:path'

export interface ProbeEnv {
  /** `ctx.paths.dataDir()` — the app's own portable-aware profile. */
  readonly dataDir: string
  /** The directory holding the running executable. */
  readonly exeDir: string
  /** The user's explicit setting, or ''. */
  readonly configured: string
  /** `%LOCALAPPDATA%`, or '' when unset. */
  readonly localAppData: string
  /** `%USERPROFILE%`, or '' when unset. */
  readonly userProfile: string
  /** Every directory on `PATH`. */
  readonly pathDirs: readonly string[]
}

/**
 * The candidate list, in the order R06 specifies:
 *
 *   `<userData>/tools/yt-dlp.exe` → `<exeDir>/tools/yt-dlp.exe` →
 *   `config.ytdlPath` → `where yt-dlp` → WinGet links → scoop shims
 *
 * The user's own setting is THIRD, not first, and that is deliberate rather than
 * an oversight: the two `tools/` directories are places this app told the user
 * to put the file, so a copy sitting there is a copy they placed for this app,
 * whereas a stale absolute path in a settings file survives an uninstall. If the
 * setting should win outright, that is a one-line change here plus a test — but
 * it should be an argued change, not a drift.
 *
 * `where yt-dlp` is expanded to PATH directories rather than SPAWNED: `where` is
 * a process, and this function runs while the settings window is being built.
 */
export function probeOrder(env: ProbeEnv): string[] {
  const out: string[] = []
  const add = (p: string): void => {
    if (p.length > 0 && !out.includes(p)) out.push(p)
  }

  add(path.join(env.dataDir, 'tools', 'yt-dlp.exe'))
  add(path.join(env.exeDir, 'tools', 'yt-dlp.exe'))
  if (env.configured.trim().length > 0) add(path.normalize(env.configured.trim()))

  // The `where yt-dlp` equivalent, and yt-dlp's own alternative names — the
  // ytdl_hook search list extracted from the binary is
  // `{"yt-dlp", "yt-dlp_x86", "youtube-dl"}`.
  for (const dir of env.pathDirs) {
    if (dir.length === 0) continue
    for (const name of ['yt-dlp.exe', 'yt-dlp_x86.exe', 'youtube-dl.exe']) {
      add(path.join(dir, name))
    }
  }

  if (env.localAppData.length > 0) {
    add(path.join(env.localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'))
  }
  if (env.userProfile.length > 0) {
    add(path.join(env.userProfile, 'scoop', 'shims', 'yt-dlp.exe'))
  }
  if (env.localAppData.length > 0) {
    add(path.join(env.localAppData, 'scoop', 'shims', 'yt-dlp.exe'))
  }
  return out
}

/** The first candidate that exists, or null. `exists` is injected for the test. */
export function findYtdlp(
  candidates: readonly string[],
  exists: (p: string) => boolean
): string | null {
  for (const c of candidates) {
    if (exists(c)) return c
  }
  return null
}

/**
 * `ytdl_hook-ytdl_path`, which is NOT simply the path.
 *
 * Two measured constraints from R06: the option "replaces the list and is
 * `;`-separated on Windows", and because we pass `--no-config` it "must be an
 * absolute path". A relative path here fails silently — ytdl_hook just does not
 * find the binary and reports a generic extraction failure — so a non-absolute
 * candidate is refused with a reason rather than passed through.
 */
export function ytdlPathOption(binary: string): { ok: true; value: string } | { ok: false; reason: string } {
  const p = binary.trim()
  if (p.length === 0) return { ok: false, reason: 'empty' }
  if (!path.isAbsolute(p)) return { ok: false, reason: 'not-absolute' }
  // A `;` inside the path would be read as a separator and split one path into
  // two nonexistent ones. Windows forbids `;` in a filename, so this can only
  // arrive from a hand-edited setting.
  if (p.includes(';')) return { ok: false, reason: 'separator-in-path' }
  return { ok: true, value: p }
}

/**
 * yt-dlp's `--version` output.
 *
 * The stable channel prints a bare date (`2026.08.19`); nightly and master
 * builds print `2026.08.19.123456` or a date with a suffix. Anything that starts
 * with a plausible date is accepted, and anything else returns null rather than
 * being shown to the user — a version box reading `Traceback (most recent call`
 * is worse than one reading "unknown".
 */
export function parseVersion(stdout: string): string | null {
  const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (first === undefined) return null
  const m = /^(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?(?:[-.][A-Za-z0-9]+)?)/.exec(first.trim())
  return m ? (m[1] as string) : null
}

/**
 * R07's channels. `--update-to` takes these, and nothing else is offered:
 * `--update-to <channel>@<tag>` exists but pinning a tag from a toast is a
 * support burden with no user asking for it.
 */
export const UPDATE_CHANNELS = ['stable', 'nightly'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

/**
 * The argv for a self-update, as data.
 *
 * The point of returning it rather than spawning it here is that the test can
 * assert the EXACT argv — including that it is `--update-to <channel>` and not
 * some homegrown download — without a process existing.
 */
export function updateArgv(channel: UpdateChannel): string[] {
  return ['--update-to', channel]
}
