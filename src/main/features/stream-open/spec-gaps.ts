/**
 * M35 — the spec rows this module CANNOT express, as data rather than as prose.
 *
 * WHY THIS IS A FILE AND NOT A PARAGRAPH IN A REPORT. Five of M35's eighteen
 * rows specify an mpv property that NO row of `docs/parity/modules.json` owns,
 * and `OwnerMap.assertWrite()` refuses a property whose owner is `null` exactly
 * as hard as it refuses another module's:
 *
 *     assertWrite(moduleId, property, …):
 *       if (this.owns(moduleId, property)) return true
 *       const owner = this.ownerOf(property)      // null for every name below
 *       throw new OwnershipError(...)             // in dev; counted in prod
 *
 * So "nobody owns it" is not a free-for-all, it is a hard refusal for everyone
 * including this module. That is the right default — an unowned write is exactly
 * the collision the map exists to stop — but it means the affected rows are
 * unimplementable until the manifest gains the claim, and a module that quietly
 * omitted them would leave the gap invisible.
 *
 * `spec-gaps.test.ts` asserts that this module never writes any of these, so the
 * table and the code cannot drift apart: if a future edit reaches for
 * `demuxer-lavf-format`, the test fails and points here rather than the app
 * hitting an OwnershipError at runtime in front of a user.
 *
 * Each row is a manifest edit plus a review, which §2.1 says is the conversation
 * it should be. None of them is a core-file edit and none is worked around.
 */

export interface SpecGap {
  /** The spec row that needs it. */
  readonly row: string
  /** The mpv property, verbatim from the §2 table. */
  readonly property: string
  /** What the row wanted it for. */
  readonly need: string
  /** Why this module cannot do it, and what would fix it. */
  readonly blocker: string
}

/**
 * Properties named by an M35 row that no manifest row claims.
 *
 * Verified against `docs/parity/modules.json` by folding every row's
 * `ownedProperties` (globs included) — none of these matches any claim.
 */
export const UNOWNED_PROPERTIES: readonly SpecGap[] = [
  {
    row: 'R01',
    property: 'force-media-title',
    need: "the options map in `['loadfile', url, 'replace', -1, {'force-media-title': name}]`",
    blocker:
      'unowned by every manifest row, and reachable only through the options map, ' +
      'which `playlist.openPaths` does not accept. Add it to M28 (which owns ' +
      '`loadfile`) or to M35.'
  },
  {
    row: 'R13',
    property: 'demuxer-lavf-format',
    need: 'forcing `dash` when probing picks the wrong demuxer for an `.mpd`',
    blocker:
      'unowned. The row calls it the escape hatch for the case where DASH ' +
      'probing guesses wrong, so without it a mis-probed manifest has no remedy ' +
      'in the UI at all.'
  },
  {
    row: 'R14',
    property: 'demuxer-lavf-o',
    need: "the documented RTSP timeout workaround, `--demuxer-lavf-o=timeout=…`",
    blocker:
      'unowned — and §7.4 R-14 already records that the correct key and unit for ' +
      'libavformat 63.6.100 are UNVERIFIED and must be tested against a real ' +
      'camera. Claiming the property before that test would be worse than the gap.'
  },
  {
    row: 'R14',
    property: 'untimed',
    need: "the camera preset's `{'untimed': 'yes'}`",
    blocker: 'unowned. Belongs with whoever owns display timing (M08) or with M35.'
  },
  {
    row: 'R15',
    property: 'stream-lavf-o',
    need: 'Windows multicast interface selection (`localaddr=`)',
    blocker:
      'unowned. Without it, `udp://@group` on a multi-homed Windows box binds to ' +
      "whichever interface the OS picks, which is the one thing R15 says is real work."
  },
  {
    row: 'R22',
    property: 'demuxer-lavf-probesize',
    need: 'the mpegts per-file probe pair, so late audio PIDs are found',
    blocker:
      'unowned. R22 is P0 and the OBSERVING half of it is implemented here ' +
      '(`track-list`), which is what the row calls "the entire fix"; only the ' +
      'probe-size hint is missing.'
  },
  {
    row: 'R22',
    property: 'demuxer-lavf-analyzeduration',
    need: 'the other half of the same pair',
    blocker: 'unowned; same as above.'
  }
]

/**
 * Rows blocked by something other than property ownership.
 *
 * These are NOT worked around either. In particular nothing in this module
 * issues `loadfile` or `loadlist`: both are M28's commands (§2.1), and a module
 * that reached past its owner because the mediator was inconvenient is precisely
 * the failure the ownership map exists to prevent.
 */
export const MISSING_MEDIATORS: readonly SpecGap[] = [
  {
    row: 'R01, R12, R13, R14, R15, R19, R20',
    property: 'loadfile (command, M28)',
    need: "`['loadfile', url, 'replace', -1, {options}]` — the per-file options map",
    blocker:
      "M28's only entry point is `playlist.openPaths(paths)`, which takes no " +
      'options map AND drops URLs outright: it filters every entry through ' +
      '`fs.statSync(p)` inside `catch { continue }`, and `fs.statSync` on any URL ' +
      "throws ENOENT (measured). Needed: `playlist.openUrl(url, options?)`. This " +
      'module calls it when it exists (`ctx.commands.has`) and reports the ' +
      'blocker by name when it does not.'
  },
  {
    row: 'R04',
    property: 'loadlist (command, M28)',
    need: 'the `loadlist` retry when `loadfile` finds no streams in an ambiguous .m3u8',
    blocker:
      '`loadlist` is M28\'s and has no mediator. `url-policy.ts` computes ' +
      '`playlistCandidate` so the retry is one call away the day one exists; the ' +
      'classification is deliberately NOT used to branch on the extension, which ' +
      'R04 forbids.'
  },
  {
    row: 'R33',
    property: 'Electron safeStorage',
    need: 'saved FTP/WebDAV/SMB server credentials, "never plaintext"',
    blocker:
      '`FeatureContext` exposes no secret store, and a module may not import ' +
      "Electron directly. R33's minimum-viable version (remember servers, list a " +
      'directory URL inline) also needs Node `http`/`https`, which ' +
      '`check:forbidden` refuses to a feature module by design. So the remote ' +
      'BROWSER is out of scope for this module; playback of those schemes is in ' +
      'the R02 allowlist and works today, and the recent-URL list remembers the ' +
      'server addresses without holding a secret.'
  }
]

/** Every property name this module must never attempt to write. */
export function forbiddenPropertyNames(): readonly string[] {
  return UNOWNED_PROPERTIES.map((g) => g.property)
}
