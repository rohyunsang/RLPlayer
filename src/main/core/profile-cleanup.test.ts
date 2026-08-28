import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLEANUP_VERSION,
  REJECTED_TARGETS,
  TARGET_PATHS,
  appOwnedConflict,
  describeCleanup,
  purgeLeakedProfileState
} from './profile-cleanup.ts'

/**
 * The 0.1.0 profile artefacts, removed for the user rather than by the user.
 *
 * TWO THINGS IN THIS FILE USED TO LIE, and 241 tests passed with the 11 MB
 * artefact sitting on the disk of the machine they were written on.
 *
 *   1. `dirtyProfile()` built `session/` twins for Network and for Cache and
 *      NOT for Dictionaries -- so the one target that had no session twin was
 *      also the one the fixture could not reach. And it never created the app's
 *      own `cache/` directory, so `rel: 'Cache'` could not be observed deleting
 *      `cache/thumbs`, `cache/scenes`, `cache/art` and `cache/jobs`.
 *
 *   2. Its "nothing else is touched" proof walked the profile for the literal
 *      string `gvt1`. An 11,476,456-byte `.bdic` does not contain it. A
 *      substring search can only find what someone remembered to search for; the
 *      assertion below is a FILE INVENTORY, so anything left behind shows up as
 *      a path whether or not we guessed its contents.
 *
 * What was actually on disk after version 2 of the cleanup had run and written
 * its marker:
 *
 *   %APPDATA%\\RLPlayer\\session\\Dictionaries\\ko-3-0.bdic   11,476,456 bytes
 *   %APPDATA%\\RLPlayer\\cleanup.json                         {"version": 2, ...}
 *
 * `paths.ts` redirects sessionData to `<root>\\session`, which is where Chromium
 * writes the dictionary. The marker was already at CLEANUP_VERSION, so the file
 * was stranded permanently.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Chromium's dictionary format starts with this magic; the real file is 11 MB. */
const BDIC = Buffer.concat([Buffer.from('BDic'), Buffer.alloc(2044, 7)])

/**
 * A profile that looks exactly like one 0.1.0 left behind, INCLUDING the app's
 * own data sitting in `cache/`.
 *
 * The Cache/cache pair is created deliberately: on NTFS they are ONE directory,
 * which is the entire mechanism of the data loss. `cache/thumbs` is created
 * first so the directory carries the app's spelling on disk, exactly as it does
 * in a real profile where `cacheDir()` made it.
 */
function dirtyProfile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-cleanup-'))
  const write = (rel: string, data: string | Buffer): void => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }

  // THE APP'S OWN DATA, first, so `cache` is the on-disk spelling. These four
  // are `thumbCacheDir()`, `sceneCacheDir()`, `artCacheDir()` and
  // `tempJobDir()` -- what §12 of the module author's guide hands to all 38
  // Wave-1 modules, and what `rel: 'Cache'` was measured deleting.
  write(path.join('cache', 'thumbs', 'thumb-1.jpg'), 'jpeg')
  write(path.join('cache', 'scenes', 's.jpg'), 'jpeg')
  write(path.join('cache', 'art', 'a.png'), 'png')
  write(path.join('cache', 'jobs', 'job1', 'font.ttf'), 'ttf')
  write(path.join('subcache', 'movie.srt'), 'subtitles')
  write(path.join('logs', 'main.log'), 'log')
  write(path.join('themes', 'dark.css'), 'css')
  write('config.json', '{"schema":1}')
  write('resume.json', '{"schema":1,"entries":{}}')

  // The dictionary, in BOTH places. The root one is what 0.1.0's release notes
  // named; the session one is where Chromium actually put it, and is the one
  // that survived version 2 of this cleanup.
  write(path.join('Dictionaries', 'ko-3-0.bdic'), BDIC)
  write(path.join('session', 'Dictionaries', 'ko-3-0.bdic'), BDIC)

  for (const sub of ['Network', path.join('session', 'Network')]) {
    write(
      path.join(sub, 'Network Persistent State'),
      '{"net":{"http_server_properties":{"servers":[{"server":"https://redirector.gvt1.com",' +
        '"supports_spdy":true}],"supports_quic":{"address":"2406:5900:117c:1830::1"}}}}'
    )
    // Chromium's own marker; it must SURVIVE, or the next launch re-migrates.
    write(path.join(sub, 'NetworkDataMigrated'), '')
  }

  // The HTTP disk cache, holding the 302 with the user's public IP in `mip=`,
  // in the legacy shared-with-the-app location AND in the one paths.ts uses now.
  const three_oh_two =
    'HTTP/1.1 302 location:https://r4---sn-x.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic' +
    '?cms_redirect=yes&mip=2406:5900:117c:183c:b757:a254:4b22:c7d8'
  write(path.join('Cache', 'Cache_Data', 'data_2'), three_oh_two)
  write(path.join('Cache', 'No_Vary_Search', 'db'), three_oh_two)
  write(path.join('session', 'Cache', 'Cache_Data', 'data_2'), three_oh_two)
  write(path.join('httpcache', 'Cache_Data', 'data_2'), three_oh_two)

  for (const sub of ['Shared Dictionary', path.join('session', 'Shared Dictionary')]) {
    write(path.join(sub, 'db'), 'compression dictionary')
  }
  return root
}

const exists = (root: string, ...p: string[]): boolean => fs.existsSync(path.join(root, ...p))

/**
 * EVERY path under the root, directories included, as the profile actually is.
 *
 * This replaces a walk that opened each file and looked for the substring
 * `gvt1`. That search could not see an 11 MB `.bdic` (binary, and the host name
 * is not in it), could not see an empty directory, and could only ever find
 * what the person writing it already suspected. An inventory has none of those
 * properties: what is left is listed, whatever it is.
 */
function inventory(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory()) {
        out.push(`${rel}/`)
        walk(path.join(dir, e.name), rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(root, '')
  return out.sort()
}

/**
 * A handle opened with `FileShare.None`, which is what a second instance of the
 * app holding the file looks like.
 *
 * `fs.openSync(f, 'r+')` -- what this test used to do -- opens with
 * FILE_SHARE_DELETE on Windows, so the unlink SUCCEEDS and the test took its
 * else branch and asserted the OPPOSITE of its own title on every run. There is
 * no way to ask Node for a share mode, so the lock is held by a real process.
 */
async function lockExclusively(file: string): Promise<() => void> {
  const sentinel = `${file}.locked`
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$h=[System.IO.File]::Open('${file}','Open','ReadWrite','None');` +
        `Set-Content -LiteralPath '${sentinel}' -Value 'held';` +
        `Start-Sleep -Seconds 60; $h.Close()`
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  for (let i = 0; i < 300 && !fs.existsSync(sentinel); i++) await sleep(50)
  if (!fs.existsSync(sentinel)) {
    child.kill()
    throw new Error('could not take an exclusive handle; the locked-file case was not exercised')
  }
  return () => {
    child.kill()
    fs.rmSync(sentinel, { force: true })
  }
}

test('the leaked artefacts go, and nothing else in the profile is touched', () => {
  const root = dirtyProfile()
  const before = inventory(root)
  const r = purgeLeakedProfileState(root)

  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.removed.map((s) => s.split(path.sep).join('/')).sort(), [
    'Cache/Cache_Data',
    'Cache/No_Vary_Search',
    'Dictionaries',
    'Network/Network Persistent State',
    'Shared Dictionary',
    'httpcache',
    'session/Cache',
    'session/Dictionaries',
    'session/Network/Network Persistent State',
    'session/Shared Dictionary'
  ])

  // THE ARTEFACT THIS FILE EXISTS FOR. The old fixture never built this path,
  // so version 2 shipped, ran, reported success, wrote its marker, and left
  // 11,476,456 bytes on disk with no launch left that would ever look again.
  assert.equal(exists(root, 'session', 'Dictionaries', 'ko-3-0.bdic'), false)
  assert.equal(exists(root, 'Dictionaries'), false)
  assert.equal(exists(root, 'Network', 'Network Persistent State'), false)
  assert.equal(exists(root, 'session', 'Network', 'Network Persistent State'), false)
  assert.equal(exists(root, 'Cache', 'Cache_Data', 'data_2'), false)
  assert.equal(exists(root, 'session', 'Cache'), false)
  assert.equal(exists(root, 'httpcache'), false)

  // THE DATA LOSS. `rel: 'Cache'` removed all four of these, on NTFS, where
  // `Cache` and the `cache` that `cacheDir()` returns are one directory -- and
  // logged one line reading "removed Cache".
  assert.equal(exists(root, 'cache', 'thumbs', 'thumb-1.jpg'), true)
  assert.equal(exists(root, 'cache', 'scenes', 's.jpg'), true)
  assert.equal(exists(root, 'cache', 'art', 'a.png'), true)
  assert.equal(exists(root, 'cache', 'jobs', 'job1', 'font.ttf'), true)

  // AND THE WHOLE PROFILE, BY INVENTORY. The previous version of this assertion
  // searched every file for the string `gvt1`; the 11 MB dictionary does not
  // contain it, so the artefact was present and the test was green. What is
  // left is now listed by path, and the list is exact in both directions.
  const gone = before.filter((p) => !inventory(root).includes(p))
  assert.deepEqual(
    inventory(root),
    [
      'Network/',
      'Network/NetworkDataMigrated',
      'cache/',
      'cache/art/',
      'cache/art/a.png',
      'cache/jobs/',
      'cache/jobs/job1/',
      'cache/jobs/job1/font.ttf',
      'cache/scenes/',
      'cache/scenes/s.jpg',
      'cache/thumbs/',
      'cache/thumbs/thumb-1.jpg',
      'cleanup.json',
      'config.json',
      'logs/',
      'logs/main.log',
      'resume.json',
      'session/',
      'session/Network/',
      'session/Network/NetworkDataMigrated',
      'subcache/',
      'subcache/movie.srt',
      'themes/',
      'themes/dark.css'
    ],
    'the profile after the cleanup, path by path. Anything extra is an artefact that ' +
      'survived; anything missing is the user\'s data we took.'
  )
  assert.ok(
    gone.includes('session/Dictionaries/ko-3-0.bdic'),
    'the dictionary Chromium actually writes was not among the removals'
  )
  assert.ok(
    !gone.some((p) => p.startsWith('cache/thumbs') || p.startsWith('cache/jobs')),
    "a module's cache directories were removed by a routine that has no business there"
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('no target may be, or contain, a path the app owns', () => {
  // 1b, as a rule rather than as one caught instance. `Cache` passed every
  // review because "a cache is by definition safe to delete" is true of
  // Chromium's cache and was being applied to ours.
  assert.deepEqual(
    REJECTED_TARGETS,
    [],
    'a target in the shipped list would delete app-owned data; see rule 5'
  )

  assert.equal(appOwnedConflict('Cache'), "it IS the app-owned path 'cache'")
  assert.equal(appOwnedConflict('cache'), "it IS the app-owned path 'cache'")
  assert.equal(appOwnedConflict(''), 'it is the data root itself')
  assert.equal(appOwnedConflict('cache/thumbs'), "it IS the app-owned path 'cache/thumbs'")
  assert.equal(appOwnedConflict('cache/jobs/job1'), "it is inside the app-owned path 'cache/jobs'")
  assert.equal(appOwnedConflict('logs'), "it IS the app-owned path 'logs'")
  // …and the narrowed targets that replaced it are fine.
  assert.equal(appOwnedConflict(path.join('Cache', 'Cache_Data')), null)
  assert.equal(appOwnedConflict('httpcache'), null)
  assert.equal(appOwnedConflict(path.join('session', 'Cache')), null)
})

test('every root artefact has a session/ twin, because sessionData is redirected', () => {
  // 1a, as a rule. `Dictionaries` was the ONLY Chromium target with no session
  // twin, and `paths.ts:78` sends sessionData to <root>\session, so it was also
  // the only one pointed at a directory Chromium does not use. Three targets
  // carried a twin and one did not, and nothing compared them.
  const rels = TARGET_PATHS.map((r) => r.split(path.sep).join('/'))
  // `httpcache` is the disk-cache-dir switch, which is a single directory for
  // the whole browser rather than a per-partition one. It is the only exemption
  // and it needs this sentence to stay one.
  const exempt = new Set(['httpcache'])
  for (const rel of rels) {
    if (rel.startsWith('session/') || exempt.has(rel)) continue
    const twin = `session/${rel}`
    assert.ok(
      rels.some((r) => r === twin || twin.startsWith(`${r}/`)),
      `'${rel}' has no session/ twin. app.setPath('sessionData', <root>\\session) means ` +
        `Chromium writes it at '${twin}', so a target at the root alone deletes nothing — ` +
        `which is exactly what happened to the 11 MB dictionary for a whole release.`
    )
  }
  assert.ok(rels.includes('session/Dictionaries'), 'the dictionary target lost its session twin')
})

test("it runs once: a rebuilt Dictionaries directory is the user's, not ours", () => {
  const root = dirtyProfile()
  purgeLeakedProfileState(root)

  // Someone puts something back afterwards. It is theirs.
  fs.mkdirSync(path.join(root, 'session', 'Dictionaries'), { recursive: true })
  fs.writeFileSync(path.join(root, 'session', 'Dictionaries', 'mine.bdic'), 'x')

  const second = purgeLeakedProfileState(root)
  assert.equal(second.alreadyDone, true)
  assert.deepEqual(second.removed, [])
  assert.equal(exists(root, 'session', 'Dictionaries', 'mine.bdic'), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an absent artefact is a no-op, not an error — the fresh-install path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-clean-'))
  const r = purgeLeakedProfileState(root)
  assert.deepEqual(r.removed, [])
  assert.deepEqual(r.failed, [])
  assert.equal(describeCleanup(r), null, 'a fresh install must log nothing at all')
  assert.equal(exists(root, 'cleanup.json'), true, 'the marker is written so it never re-scans')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a data root that does not exist yet does not throw', () => {
  const root = path.join(os.tmpdir(), `rlplayer-missing-${process.pid}-${Date.now()}`)
  const r = purgeLeakedProfileState(root)
  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.removed, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test(
  'a LOCKED artefact leaves the marker unwritten, so the next launch retries',
  { skip: process.platform !== 'win32' ? 'needs a Windows share mode' : false },
  async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE OF ITS TITLE. It took the handle with
    // `fs.openSync(f, 'r+')`, and Node opens with FILE_SHARE_DELETE on Windows,
    // so `rmSync` always SUCCEEDED, `r.failed` was always empty, and the
    // assertion that ran was the else branch: "the marker WAS written". The
    // invariant in the title -- the one the whole retry design rests on -- was
    // never once executed. With a real FileShare.None handle it does hold.
    const root = dirtyProfile()
    const locked = path.join(root, 'Network', 'Network Persistent State')
    const release = await lockExclusively(locked)
    try {
      const r = purgeLeakedProfileState(root)
      assert.ok(
        r.failed.length > 0,
        'an exclusively held file was deleted anyway; the lock was not exclusive and this ' +
          'test proved nothing (which is what fs.openSync(f, "r+") did for four rounds)'
      )
      assert.equal(r.failed[0]?.rel, path.join('Network', 'Network Persistent State'))
      assert.equal(exists(root, 'cleanup.json'), false, 'the marker was written despite a failure')
      assert.match(describeCleanup(r) ?? '', /retrying next launch/)
      // The rest of the run still happened: one locked file does not abort it.
      assert.equal(exists(root, 'session', 'Dictionaries'), false)
    } finally {
      release()
    }

    // Once it is released, a later launch finishes the job.
    let again = purgeLeakedProfileState(root)
    for (let i = 0; i < 40 && again.failed.length > 0; i++) {
      await sleep(100)
      again = purgeLeakedProfileState(root)
    }
    assert.deepEqual(again.failed, [])
    assert.equal(exists(root, 'Network', 'Network Persistent State'), false)
    assert.equal(exists(root, 'cleanup.json'), true, 'the retry never wrote the marker')
    fs.rmSync(root, { recursive: true, force: true })
  }
)

test('a corrupt marker does not skip the cleanup forever', () => {
  const root = dirtyProfile()
  fs.writeFileSync(path.join(root, 'cleanup.json'), 'not json {{{')
  const r = purgeLeakedProfileState(root)
  assert.equal(r.alreadyDone, false)
  assert.equal(exists(root, 'session', 'Dictionaries'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an older marker version re-runs, so a new artefact can be added later', () => {
  // NOT A HYPOTHETICAL. The shipped 0.1.1 marker said {"version": 2} on a
  // profile that still held the 11 MB dictionary; without this behaviour the
  // fixed target list below would never have run on a single existing install.
  const root = dirtyProfile()
  fs.writeFileSync(
    path.join(root, 'cleanup.json'),
    JSON.stringify({ version: 2, removed: ['session\\Cache'] })
  )
  const r = purgeLeakedProfileState(root)
  assert.equal(r.alreadyDone, false)
  assert.equal(exists(root, 'session', 'Dictionaries', 'ko-3-0.bdic'), false)
  assert.ok(CLEANUP_VERSION > 2, 'the list was fixed without moving the marker version')
  assert.equal(r.removed.length, 10)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the target list is literal: no glob, no recursive delete of the root', () => {
  // The safety argument for this file is that a reviewer can read the whole
  // target list in one screen. A glob cannot be reviewed, and
  // `rmSync(root, { recursive: true })` behind a condition is one bad edit away
  // from deleting the user's resume positions and playlists.
  const src = fs.readFileSync(path.join(here, 'profile-cleanup.ts'), 'utf8')
  assert.ok(!/readdirSync\([^)]*\)\s*\)?\s*\{[\s\S]{0,200}rmSync/.test(src), 'a directory scan feeds rmSync')
  assert.ok(!/rmSync\(\s*dataRoot/.test(src), 'the data root itself is passed to rmSync')
  assert.ok(!/glob|\*\.|match\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'a pattern selects targets')
  // Every removable path is spelled out.
  for (const literal of ['Dictionaries', 'Network Persistent State', 'session', 'httpcache']) {
    assert.ok(src.includes(`'${literal}'`), `the target list no longer names '${literal}'`)
  }
})

test('paths.ts keeps the app cache and Chromium cache in different directories', () => {
  // The other half of 1b: as long as `disk-cache-dir` and `cacheDir()` name the
  // same directory, "delete Chromium's cache" and "delete the app's cache" are
  // the same operation and no target list can tell them apart.
  const paths = fs.readFileSync(path.join(here, 'paths.ts'), 'utf8')
  const diskCache = /appendSwitch\('disk-cache-dir',\s*path\.join\(dir,\s*'([^']+)'\)/.exec(paths)
  const appCache = /export function cacheDir\(\)[\s\S]*?path\.join\(root\(\),\s*'([^']+)'\)/.exec(paths)
  assert.ok(diskCache, 'disk-cache-dir is no longer set from a literal directory name')
  assert.ok(appCache, 'cacheDir() no longer returns a literal directory name')
  assert.notEqual(
    diskCache?.[1]?.toLowerCase(),
    appCache?.[1]?.toLowerCase(),
    "Chromium's disk cache and cacheDir() are the same directory again. NTFS is " +
      'case-insensitive, so `Cache` and `cache` collide, and every module\'s thumbnails ' +
      'sit inside what a cleanup routine calls "the HTTP cache".'
  )
})

test('the cleanup runs before app.whenReady(), where it still can', () => {
  // Chromium reads `Network Persistent State` during startup and rewrites it on
  // shutdown, so a cleanup scheduled after ready deletes a copy that is about to
  // be written back — it would look like it worked and change nothing.
  // CODE ONLY: index.ts explains in prose why the call is where it is, and an
  // assertion that fires on its own documentation is one people delete the
  // documentation to satisfy.
  const index = fs
    .readFileSync(path.join(repo, 'src', 'main', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const purgeAt = index.indexOf('purgeLeakedProfileState(')
  const readyAt = index.indexOf('app.whenReady()')
  assert.ok(purgeAt > 0, 'nothing calls purgeLeakedProfileState')
  assert.ok(readyAt > 0)
  assert.ok(purgeAt < readyAt, 'the cleanup moved below app.whenReady() and now deletes nothing')
  // …and after initPaths(), or it would run against the wrong directory in a
  // portable build, which is the one place the profile is not %APPDATA%.
  assert.ok(index.indexOf('initPaths()') < purgeAt, 'the cleanup runs before paths are resolved')
})
