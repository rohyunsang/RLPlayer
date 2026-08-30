import fs from 'node:fs'
import path from 'node:path'

/**
 * core/profile-cleanup — undo, on the user's disk, what 0.1.0 left behind.
 *
 * WHAT 0.1.0 DID. Chromium's spellchecker downloaded a dictionary for the locale
 * of the settings window's text inputs, from
 * `https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic`, on every cold
 * launch. 0.1.1 stops the request. It does not undo the two artefacts already
 * written into the profile of anyone who ran 0.1.0, and both were confirmed
 * present on a 0.1.1 launch of this machine:
 *
 *   %APPDATA%\RLPlayer\Dictionaries\ko-3-0.bdic          11,476,456 bytes
 *   %APPDATA%\RLPlayer\session\Dictionaries\ko-3-0.bdic  11,476,456 bytes  <- the real one
 *   %APPDATA%\RLPlayer\Network\Network Persistent State
 *   %APPDATA%\RLPlayer\session\Network\Network Persistent State
 *   %APPDATA%\RLPlayer\Cache\Cache_Data\data_1 and data_2         ~13 MB each
 *
 * The release notes named only the first. The others are worse.
 *
 * `Network Persistent State` is Chromium's HTTP_SERVER_PROPERTIES record, and
 * what it actually held on this machine is:
 *
 *   {"net":{"http_server_properties":{"servers":[
 *     {"server":"https://redirector.gvt1.com","supports_spdy":true},
 *     {"server":"https://r4---sn-…-bh2sd.gvt1.com", "network_stats":{"srtt":3416}, …}],
 *     "supports_quic":{"address":"2406:5900:…"}}}}
 *
 * — which Google host was contacted, the round-trip time to it, and the
 * machine's own public address.
 *
 * And the HTTP DISK CACHE held the request and the reply in full. Read out of
 * `Cache\Cache_Data` on this machine, verbatim:
 *
 *   1/0/https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic
 *   HTTP/1.1 302 … location:https://r4---sn-….gvt1.com/edgedl/chrome/dict/
 *     ko-3-0.bdic?cms_redirect=yes&met=1787863932,&mh=qG
 *     &mip=2406:5900:117c:183c:b757:a254:4b22:c7d8&mm=28&mn=sn-…
 *
 * `mip=` is the user's public IPv6 address, echoed back by Google's redirector
 * and then written to their disk by us. That is the single most concrete
 * artefact of the whole episode, it survived the first version of this cleanup,
 * and no release note mentioned it. Telling the user to delete a folder by hand
 * was never going to reach it.
 *
 * FIVE RULES, because a cleanup that goes wrong is worse than the mess.
 *
 *   1. AN EXPLICIT LIST. Every path below is a literal relative path under the
 *      data root. No globs, no `rmSync(root, { recursive: true })` guarded by a
 *      condition somebody will edit later. Nothing else in the profile is read,
 *      moved or touched.
 *   2. BEFORE `app.whenReady()`. Chromium reads `Network Persistent State`
 *      during startup and rewrites it on shutdown, so deleting it after ready
 *      deletes a copy that is about to be written back.
 *   3. ONCE, AND IDEMPOTENTLY, via a version marker. A user who deliberately
 *      builds their own dictionary directory afterwards keeps it.
 *   4. NEVER THROWS. A locked file, a read-only profile, a directory that is not
 *      there: all normal, all logged, none fatal. If a target survives, the
 *      marker is NOT written, so the next launch tries again — which is the
 *      behaviour a locked file actually wants.
 *   5. NEVER THE APP'S OWN DATA. Every target is checked against the paths
 *      `core/paths.ts` hands to modules before it is touched. Rule 1's literal
 *      list did not prevent `Cache` from being on it, and `cacheDir()` was
 *      `<root>/cache`; on NTFS those are one directory. See `appOwnedConflict`.
 */

/**
 * Bump when a new artefact needs removing; the marker gates on this.
 *
 * 1 -> 2: the HTTP disk cache. Version 1 removed the dictionary and the server-
 * properties records and left `Cache/Cache_Data` holding the 302 with the user's
 * public IP in the query string -- found by grepping the profile for `gvt1`
 * AFTER version 1 had run and reported success. Which is the argument for
 * checking a cleanup by searching for what it was supposed to remove rather than
 * by reading its own log line.
 *
 * 2 -> 3: THE 11 MB DICTIONARY ITSELF -- the artefact this whole file exists for
 * and the only one version 2 never touched. Version 2 listed `Dictionaries` at
 * the profile ROOT, and `core/paths.ts` redirects `sessionData` to
 * `<root>\session`, which is where Chromium actually writes it. Every other
 * Chromium target here carries a `session/` twin; that one did not. Measured on
 * this machine AFTER version 2 had run and written its marker:
 *
 *   %APPDATA%\RLPlayer\session\Dictionaries\ko-3-0.bdic   11,476,456 bytes
 *   %APPDATA%\RLPlayer\cleanup.json                       {"version": 2, ...}
 *
 * The marker was already at CLEANUP_VERSION, so the file was stranded
 * permanently and no launch would ever look at it again. THAT is why the version
 * has to move and not just the list: a one-shot migration that already ran and
 * missed its target has to be able to run again, and the marker is the only
 * thing that decides whether it does.
 *
 * The same bump re-runs the narrowed cache targets below, which is the other
 * half of this version: `Cache` used to be removed WHOLESALE while
 * `core/paths.ts` put the app's own `thumbs/`, `scenes/`, `art/` and `jobs/`
 * inside it.
 */
/**
 * 3 -> 4: `%APPDATA%\RLPlayer\Preferences`, measured on this machine after
 * version 2 had run:
 *
 *   {"spellcheck":{"dictionaries":["ko"],"dictionary":""}}
 *
 * No host and no IP, so this is not a leak -- but it is the request's last
 * fingerprint: the record of WHICH dictionary 0.1.0 decided to fetch. It cannot
 * be deleted wholesale the way the cache can, because `Preferences` is a live
 * Chromium file in the general case; and it must not be confused with
 * `<root>\session\Preferences`, which on this machine reads
 * `{"browser":{"enable_spellchecking":false},"spellcheck":{"dictionaries":[],...}}`
 * -- that one is 0.1.1's CORRECT current state and is left exactly alone.
 *
 * So version 4 does one surgical thing: it removes the `spellcheck` key from a
 * `Preferences` file that has one, and deletes the file only if nothing else was
 * in it. See `SPELLCHECK_SCRUBS`.
 */
export const CLEANUP_VERSION = 4

const MARKER = 'cleanup.json'

/**
 * RULE 5, added because rules 1-4 were not enough: A TARGET MAY NEVER SWALLOW
 * THE APP'S OWN DATA.
 *
 * `Cache` was on the list below, justified as "a cache is by definition safe to
 * delete". It was not this app's cache to reason about. `core/paths.ts` returned
 * `<root>/cache` from `cacheDir()`, and on NTFS `cache` and `Cache` are one
 * directory, so removing that target removed `cache/thumbs`, `cache/scenes`,
 * `cache/art` and `cache/jobs` -- the four directories §12 of the module
 * author's guide hands to all 38 Wave-1 modules -- and logged it as
 * "removed Cache".
 *
 * `paths.ts` now points `disk-cache-dir` at `httpcache/`, so the two are
 * separable by path alone. This is the second half: the app-owned paths a target
 * may not BE and may not CONTAIN. It is enforced here rather than only in a test
 * because the next person to add a target will read this file.
 */

/**
 * Mixed contents: legacy Chromium subdirectories still live under `cache/`, so a
 * target may reach INSIDE these but may never be them or above them.
 */
const APP_OWNED: readonly string[] = ['cache']

/**
 * Wholly the app's. A target may not be one of these, be inside one, or be above
 * one.
 */
const APP_SUBTREES: readonly string[] = [
  'cache/thumbs',
  'cache/scenes',
  'cache/art',
  'cache/jobs',
  'subcache',
  'logs',
  'themes',
  'crash',
  'config.json',
  'resume.json',
  'history.json',
  'per-file.json',
  'keybinds.json',
  'mpv.conf',
  MARKER.toLowerCase()
]

/** NTFS is case-insensitive, and that is the whole point: `Cache` IS `cache`. */
function norm(rel: string): string {
  return rel
    .split(/[\\/]+/)
    .filter((x) => x && x !== '.')
    .join('/')
    .toLowerCase()
}

/**
 * Why a target is unsafe, or null if it is fine. Exported so the test asserts on
 * the reason rather than on a boolean.
 */
export function appOwnedConflict(rel: string): string | null {
  /**
   * TRAVERSAL FIRST, because rules 1-5 did not stop it and rule 5's own root
   * guard was unreachable.
   *
   * `norm()` filtered `'.'` and not `'..'`, so `appOwnedConflict('session/..')`
   * normalised to `'session/..'`, matched no APP_OWNED or APP_SUBTREES entry and
   * returned NULL -- while `path.join(root, 'session', '..') === root`. The next
   * line in `purgeLeakedProfileState` is
   * `fs.rmSync(abs, { recursive: true, force: true })`, i.e. the user's entire
   * profile: resume.json, history.json, per-file.json, keybinds.json,
   * config.json, every bookmark and every thumbnail.
   *
   * Rule 5's "it is the data root itself" guard below could only ever fire for
   * `''`, because that was the only spelling `norm()` collapsed to empty. The
   * test that was supposed to cover this grepped the source for
   * `/rmSync\(\s*dataRoot/` -- a spelling this code does not use and never would,
   * since the dangerous call passes `abs`.
   *
   * So: a target is a RELATIVE path under the data root, with no `..` segment and
   * no root of its own. All three checked before anything is compared, and
   * `purgeLeakedProfileState` re-checks the RESOLVED path as well, because one
   * guard in the same function as the `rmSync` is worth more than three in a
   * helper somebody can forget to call.
   */
  const segments = rel.split(/[\\/]+/).filter((x) => x && x !== '.')
  if (segments.includes('..')) {
    return "it contains a '..' segment, which walks out of the data root"
  }
  if (/^[A-Za-z]:/.test(rel)) return 'it starts with a drive letter, so it is not relative'
  if (/^[\\/]/.test(rel)) return 'it starts at the filesystem root, so it is not relative'
  if (rel.includes('\0')) return 'it contains a NUL byte'

  const t = norm(rel)
  if (t === '') return 'it is the data root itself'
  for (const a of APP_OWNED) {
    if (t === a) return `it IS the app-owned path '${a}'`
    if (a.startsWith(t + '/')) return `it contains the app-owned path '${a}'`
  }
  for (const a of APP_SUBTREES) {
    if (t === a) return `it IS the app-owned path '${a}'`
    if (a.startsWith(t + '/')) return `it contains the app-owned path '${a}'`
    if (t.startsWith(a + '/')) return `it is inside the app-owned path '${a}'`
  }
  return null
}

/**
 * THE FUNCTION THAT GATES THE `rmSync`. Exported so a test can drive it.
 *
 * It is `appOwnedConflict()` PLUS an independent check on the RESOLVED absolute
 * path, and both halves are here rather than in the caller for one reason: the
 * test that was supposed to cover this grepped the source for
 * `/rmSync\(\s*dataRoot/` -- a spelling this file has never used, because the
 * dangerous call is `fs.rmSync(abs, …)` where `abs = path.join(dataRoot, rel)`.
 * A test that asserts on a spelling proves nothing about behaviour, so
 * `profile-cleanup.test.ts` now calls THIS and asserts what it returns.
 *
 * `path.relative` rather than `abs.startsWith(dataRoot)`: a `startsWith` is also
 * true of `…\Roaming\RLPlayerEvil`, a sibling whose name merely begins with the
 * root's.
 */
export function refuseTarget(dataRoot: string, rel: string): string | null {
  const conflict = appOwnedConflict(rel)
  if (conflict !== null) return conflict
  const abs = path.join(dataRoot, rel)
  const inside = path.relative(path.resolve(dataRoot), path.resolve(abs))
  if (inside === '') return `it resolves to the data root itself ('${abs}')`
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return `it resolves to '${abs}', which is outside the data root '${dataRoot}'`
  }
  return null
}

/**
 * The artefacts, each with the reason it is here. A literal list is the whole
 * safety argument: a reviewer can read it in one screen and a glob cannot be
 * reviewed at all.
 */
const TARGETS: ReadonlyArray<{ rel: string; kind: 'dir' | 'file'; why: string }> = [
  {
    rel: 'Dictionaries',
    kind: 'dir',
    why: "Chromium's downloaded spellcheck dictionary (ko-3-0.bdic, ~11 MB). " +
      'RLPlayer switches the spellchecker off, so nothing reads it.'
  },
  {
    rel: path.join('session', 'Dictionaries'),
    kind: 'dir',
    why: 'THE SAME DICTIONARY, IN THE PLACE IT IS ACTUALLY WRITTEN. paths.ts redirects ' +
      'sessionData to <root>/session, so this -- not the root twin above -- is where the ' +
      '11,476,456-byte ko-3-0.bdic was still sitting after version 2 of this cleanup had ' +
      'run and written its marker. Every other Chromium target here had a session/ twin ' +
      'and this one did not, which is the whole of the defect.'
  },
  {
    rel: path.join('Network', 'Network Persistent State'),
    kind: 'file',
    why: 'the HTTP_SERVER_PROPERTIES record naming redirector.gvt1.com, its round-trip ' +
      "time, and the machine's own public address. Chromium rebuilds this file from " +
      'nothing on the next launch.'
  },
  {
    rel: path.join('session', 'Network', 'Network Persistent State'),
    kind: 'file',
    why: 'the same record in the sessionData partition, which core/paths redirects ' +
      'separately and which the release notes never mentioned.'
  },
  {
    rel: 'httpcache',
    kind: 'dir',
    why: "Chromium's HTTP disk cache, which paths.ts now points at a directory of its " +
      'own. Nothing but Chromium ever writes there, so this one may go wholesale. It is ' +
      'what held the gvt1.com request and its 302 reply in full -- including `mip=`, the ' +
      "user's public IP -- back when it shared a directory with the app's own cache."
  },
  {
    rel: path.join('Cache', 'Cache_Data'),
    kind: 'dir',
    why: 'THE LEGACY LOCATION, NARROWED TO CHROMIUM\'S OWN SUBDIRECTORY. Through 0.1.1 ' +
      'disk-cache-dir was <root>/cache, which on NTFS is the same directory cacheDir() ' +
      'returns -- so the previous target, the whole of `Cache`, deleted cache/thumbs, ' +
      'cache/scenes, cache/art and cache/jobs and reported "removed Cache".'
  },
  {
    rel: path.join('Cache', 'No_Vary_Search'),
    kind: 'dir',
    why: 'the other subdirectory Chromium creates beside Cache_Data; it keys cache ' +
      'entries by request URL. Same argument, same narrowing.'
  },
  {
    rel: path.join('session', 'Cache'),
    kind: 'dir',
    why: 'the same HTTP cache for the sessionData partition. This one may go wholesale: ' +
      "<root>/session is Chromium's directory end to end and the app writes nothing " +
      'anywhere inside it.'
  },
  {
    rel: 'Shared Dictionary',
    kind: 'dir',
    why: 'compression dictionaries fetched over HTTP. Same argument as the cache: an app ' +
      'that makes no request cannot have put anything legitimate in it.'
  },
  {
    rel: path.join('session', 'Shared Dictionary'),
    kind: 'dir',
    why: 'the same, for the sessionData partition.'
  }
]

/**
 * Rule 5 applied to the literal list above, once, at module load.
 *
 * It cannot fire in a shipped build -- TARGETS is a constant and the test
 * asserts this array is empty -- and it exists anyway so that a target added in
 * a hurry is skipped and named rather than silently deleting a module's
 * thumbnails. It deliberately does NOT go into `failed`: a programming error
 * must not hold the marker back and re-run a broken cleanup on every launch
 * forever.
 */
export const REJECTED_TARGETS: ReadonlyArray<{ rel: string; reason: string }> = TARGETS.flatMap(
  (t) => {
    const reason = appOwnedConflict(t.rel)
    return reason === null ? [] : [{ rel: t.rel, reason }]
  }
)

const SAFE_TARGETS = TARGETS.filter((t) => appOwnedConflict(t.rel) === null)

/**
 * The literal list, for the tests that assert on its SHAPE rather than on one
 * run's behaviour -- above all "every Chromium target has a session/ twin",
 * which is the invariant `Dictionaries` broke for a whole release.
 */
export const TARGET_PATHS: readonly string[] = TARGETS.map((t) => t.rel)

/**
 * Version 4: `spellcheck` keys, removed SURGICALLY rather than by deleting the file.
 *
 * `Preferences` is Chromium's, and in the general case it holds live state, so
 * the wholesale delete every other target gets would be the `Cache` mistake
 * again (rule 5). What 0.1.0 left is one key:
 *
 *   %APPDATA%\RLPlayer\Preferences  ->  {"spellcheck":{"dictionaries":["ko"],...}}
 *
 * The `session\Preferences` twin is listed too, and NOT because it is dirty:
 * on this machine it reads `{"browser":{"enable_spellchecking":false},...}`,
 * which is 0.1.1's correct state. The scrub only rewrites a file that actually
 * names a downloaded dictionary, so the correct one is read and left alone --
 * and listing it is how a machine where the twin IS dirty gets fixed too, which
 * is the exact gap that stranded the 11 MB `Dictionaries` for a whole release.
 */
const SPELLCHECK_SCRUBS: readonly string[] = ['Preferences', path.join('session', 'Preferences')]

/**
 * Remove `spellcheck` from one Preferences file. Returns what happened.
 *
 * Never throws, like everything else here: a locked or unparseable Preferences
 * file is a normal thing to meet and is not worth failing a launch over. An
 * unparseable one is left completely alone rather than rewritten from a guess.
 */
function scrubSpellcheck(abs: string): 'absent' | 'clean' | 'rewritten' | 'removed' | 'failed' {
  let text: string
  try {
    if (!fs.existsSync(abs)) return 'absent'
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return 'failed'
  }
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'failed'
    data = parsed as Record<string, unknown>
  } catch {
    return 'failed'
  }
  const spell = data['spellcheck']
  if (spell === undefined) return 'clean'
  // A dictionary list that is already empty is 0.1.1's own correct state, not an
  // artefact. Rewriting it would churn a live file for nothing.
  const dictionaries = (spell as { dictionaries?: unknown } | null)?.dictionaries
  const named = Array.isArray(dictionaries) && dictionaries.length > 0
  if (!named) return 'clean'
  delete data['spellcheck']
  try {
    if (Object.keys(data).length === 0) {
      fs.rmSync(abs, { force: true })
      return fs.existsSync(abs) ? 'failed' : 'removed'
    }
    fs.writeFileSync(abs, JSON.stringify(data))
    return 'rewritten'
  } catch {
    return 'failed'
  }
}

/**
 * NOT ON THE LIST, deliberately: `Code Cache`, `GPUCache`, `DawnGraphiteCache`,
 * `DawnWebGPUCache`. They are compilation and shader caches, not network
 * artefacts -- nothing in them ever came off a wire -- and deleting them buys
 * nothing but a slower next launch. The list is for what the leak touched.
 */

export interface CleanupResult {
  /** Skipped because a previous launch already did it. */
  alreadyDone: boolean
  /** Paths that existed and are now gone, relative to the data root. */
  removed: string[]
  /** Files that were EDITED rather than deleted (version 4's Preferences). */
  scrubbed: string[]
  /** Paths that existed, could not be removed, and will be retried next launch. */
  failed: Array<{ rel: string; reason: string }>
  /** Bytes reclaimed, for the log line. */
  bytes: number
}

function sizeOf(abs: string): number {
  try {
    const st = fs.statSync(abs)
    if (st.isFile()) return st.size
    let total = 0
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      total += sizeOf(path.join(abs, e.name))
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Do the work. Pure of Electron on purpose: `profile-cleanup.test.ts` runs it
 * against a temp directory, including the locked-file and missing-file cases,
 * without launching anything.
 */
export function purgeLeakedProfileState(dataRoot: string): CleanupResult {
  const result: CleanupResult = {
    alreadyDone: false,
    removed: [],
    scrubbed: [],
    failed: [],
    bytes: 0
  }
  const markerPath = path.join(dataRoot, MARKER)

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { version?: unknown }
    if (typeof marker.version === 'number' && marker.version >= CLEANUP_VERSION) {
      result.alreadyDone = true
      return result
    }
  } catch {
    // No marker, or an unreadable one. Both mean "not done yet", and a corrupt
    // marker must not be able to skip the cleanup forever.
  }

  for (const r of REJECTED_TARGETS) {
    console.error(
      `[cleanup] REFUSING to remove '${r.rel}': ${r.reason}. A cleanup routine may not ` +
        'touch the app\'s own data. See rule 5 in src/main/core/profile-cleanup.ts.'
    )
  }

  for (const target of SAFE_TARGETS) {
    const abs = path.join(dataRoot, target.rel)
    const refusal = refuseTarget(dataRoot, target.rel)
    if (refusal !== null) {
      console.error(
        `[cleanup] REFUSING to touch '${target.rel}': ${refusal}. See rule 5 in ` +
          `src/main/core/profile-cleanup.ts.`
      )
      continue
    }
    let existed = false
    try {
      existed = fs.existsSync(abs)
    } catch (e) {
      result.failed.push({ rel: target.rel, reason: (e as Error).message })
      continue
    }
    if (!existed) continue

    const bytes = sizeOf(abs)
    try {
      fs.rmSync(abs, { recursive: target.kind === 'dir', force: true })
    } catch (e) {
      // A locked file is the normal case here, not an exceptional one: a second
      // instance may still hold it. Leaving the marker unwritten retries later.
      result.failed.push({ rel: target.rel, reason: (e as Error).message })
      continue
    }
    if (fs.existsSync(abs)) {
      result.failed.push({ rel: target.rel, reason: 'still present after removal' })
      continue
    }
    result.removed.push(target.rel)
    result.bytes += bytes
  }

  // Version 4's surgical half. It runs after the deletions and reports through
  // the same `removed`/`failed` channels, so a locked Preferences file holds the
  // marker back and is retried next launch exactly like a locked cache file.
  for (const rel of SPELLCHECK_SCRUBS) {
    const conflict = appOwnedConflict(rel)
    if (conflict !== null) {
      console.error(`[cleanup] REFUSING to scrub '${rel}': ${conflict}.`)
      continue
    }
    const abs = path.join(dataRoot, rel)
    const outcome = scrubSpellcheck(abs)
    if (outcome === 'failed') result.failed.push({ rel, reason: 'could not rewrite' })
    else if (outcome === 'rewritten' || outcome === 'removed') {
      result.scrubbed.push(rel)
    }
  }

  // Only claim it is done when nothing is left behind. A partial run that wrote
  // the marker would strand whatever was locked on that one launch forever.
  if (result.failed.length === 0) {
    try {
      fs.mkdirSync(dataRoot, { recursive: true })
      fs.writeFileSync(
        markerPath,
        JSON.stringify(
          {
            version: CLEANUP_VERSION,
            ranAt: new Date().toISOString(),
            removed: result.removed,
            scrubbed: result.scrubbed,
            // The host is NOT named here on purpose. "Is my profile clean?" is
            // answered by grepping it for the host, and a marker that contains
            // the string makes that check answer yes when it should answer no.
            // The full story is in src/main/core/profile-cleanup.ts.
            why: 'RLPlayer 0.1.0 let Chromium download a spellcheck dictionary, and the ' +
              'request left records in this profile. This file says they have been ' +
              'removed, so the removal happens once. See core/profile-cleanup.ts.'
          },
          null,
          2
        ) + '\n'
      )
    } catch (e) {
      // Cannot write the marker (read-only profile): the cleanup still happened,
      // and repeating it next launch costs three `existsSync` calls.
      result.failed.push({ rel: MARKER, reason: (e as Error).message })
    }
  }

  return result
}

/** One line, only when something actually happened. Silence is the normal case. */
export function describeCleanup(r: CleanupResult): string | null {
  if (r.alreadyDone) return null
  if (r.removed.length === 0 && r.scrubbed.length === 0 && r.failed.length === 0) return null
  const mb = (r.bytes / (1024 * 1024)).toFixed(1)
  const parts = [`[cleanup] removed ${r.removed.length} 0.1.0 artefact(s), ${mb} MB`]
  for (const rel of r.removed) parts.push(`  - ${rel}`)
  for (const rel of r.scrubbed) parts.push(`  ~ ${rel} (spellcheck key removed)`)
  for (const f of r.failed) parts.push(`  ! ${f.rel} could not be removed (${f.reason}); retrying next launch`)
  return parts.join('\n')
}
