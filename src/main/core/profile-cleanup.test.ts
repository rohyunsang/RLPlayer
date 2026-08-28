import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLEANUP_VERSION,
  describeCleanup,
  purgeLeakedProfileState
} from './profile-cleanup.ts'

/**
 * The 0.1.0 profile artefacts, removed for the user rather than by the user.
 *
 * These are the exact files confirmed present on a 0.1.1 launch of the machine
 * this was written on:
 *
 *   %APPDATA%\\RLPlayer\\Dictionaries\\ko-3-0.bdic            11,476,456 bytes
 *   %APPDATA%\\RLPlayer\\Network\\Network Persistent State           505 bytes
 *   %APPDATA%\\RLPlayer\\session\\Network\\Network Persistent State  505 bytes
 *
 * and the second one is the one that matters. Its contents, verbatim:
 *
 *   {"net":{"http_server_properties":{"servers":[
 *     {"server":"https://redirector.gvt1.com","supports_spdy":true},
 *     {"server":"https://r4---sn-…-bh2sd.gvt1.com","network_stats":{"srtt":3416},…}],
 *     "supports_quic":{"address":"2406:5900:…"}}}}
 *
 * A record of which Google host was reached, how long it took, and the machine's
 * own public address. 0.1.1's release notes mentioned only the 11 MB folder.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

/** A profile that looks exactly like one 0.1.0 left behind. */
function dirtyProfile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-cleanup-'))
  fs.mkdirSync(path.join(root, 'Dictionaries'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Dictionaries', 'ko-3-0.bdic'), Buffer.alloc(2048, 7))
  for (const sub of ['Network', path.join('session', 'Network')]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true })
    fs.writeFileSync(
      path.join(root, sub, 'Network Persistent State'),
      '{"net":{"http_server_properties":{"servers":[{"server":"https://redirector.gvt1.com",' +
        '"supports_spdy":true}],"supports_quic":{"address":"2406:5900:117c:1830::1"}}}}'
    )
    // Chromium's own marker; it must SURVIVE, or the next launch re-migrates.
    fs.writeFileSync(path.join(root, sub, 'NetworkDataMigrated'), '')
  }
  // The HTTP disk cache, holding the 302 with the user's public IP in `mip=`.
  // Version 1 of this cleanup left it behind; it was found by grepping the
  // profile for the host AFTER the cleanup reported success.
  for (const sub of ['Cache', path.join('session', 'Cache')]) {
    fs.mkdirSync(path.join(root, sub, 'Cache_Data'), { recursive: true })
    fs.writeFileSync(
      path.join(root, sub, 'Cache_Data', 'data_2'),
      'HTTP/1.1 302 location:https://r4---sn-x.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic' +
        '?cms_redirect=yes&mip=2406:5900:117c:183c:b757:a254:4b22:c7d8'
    )
  }
  // The user's actual data. None of it is any of this function's business.
  fs.writeFileSync(path.join(root, 'config.json'), '{"schema":1}')
  fs.writeFileSync(path.join(root, 'resume.json'), '{"schema":1,"entries":{}}')
  return root
}

const exists = (root: string, ...p: string[]): boolean => fs.existsSync(path.join(root, ...p))

test('the leaked artefacts go, and nothing else in the profile is touched', () => {
  const root = dirtyProfile()
  const r = purgeLeakedProfileState(root)

  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.removed.map((s) => s.split(path.sep).join('/')).sort(), [
    'Cache',
    'Dictionaries',
    'Network/Network Persistent State',
    'session/Cache',
    'session/Network/Network Persistent State'
  ])
  assert.equal(exists(root, 'Dictionaries'), false)
  assert.equal(exists(root, 'Network', 'Network Persistent State'), false)
  assert.equal(exists(root, 'session', 'Network', 'Network Persistent State'), false)
  assert.equal(exists(root, 'Cache', 'Cache_Data', 'data_2'), false)
  assert.equal(exists(root, 'session', 'Cache', 'Cache_Data', 'data_2'), false)

  // THE CHECK THAT FOUND THE MISS. Version 1 of this cleanup reported success
  // and left the 302 -- with the user's public IP in it -- in the disk cache.
  // Assert on the ABSENCE OF THE HOST across the whole profile, not on the
  // cleanup's own report of what it did.
  const leftovers: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (fs.readFileSync(full).toString('latin1').includes('gvt1')) leftovers.push(full)
    }
  }
  walk(root)
  assert.deepEqual(
    leftovers.map((f) => path.relative(root, f).split(path.sep).join('/')),
    [],
    'the host must not appear anywhere in the profile afterwards -- INCLUDING in the ' +
      'marker this cleanup writes, because "grep the profile for the host" is how a user ' +
      'checks whether it worked, and a marker containing the string answers yes wrongly'
  )

  // Everything else, including Chromium's own bookkeeping next to the file we
  // removed. "Delete the profile directory" would have been a much simpler
  // implementation and would have taken the user's resume positions with it.
  assert.equal(exists(root, 'config.json'), true)
  assert.equal(exists(root, 'resume.json'), true)
  assert.equal(exists(root, 'Network', 'NetworkDataMigrated'), true)
  assert.equal(exists(root, 'session', 'Network', 'NetworkDataMigrated'), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('it runs once: a rebuilt Dictionaries directory is the user\'s, not ours', () => {
  const root = dirtyProfile()
  purgeLeakedProfileState(root)

  // Someone puts something back afterwards. It is theirs.
  fs.mkdirSync(path.join(root, 'Dictionaries'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Dictionaries', 'mine.bdic'), 'x')

  const second = purgeLeakedProfileState(root)
  assert.equal(second.alreadyDone, true)
  assert.deepEqual(second.removed, [])
  assert.equal(exists(root, 'Dictionaries', 'mine.bdic'), true)
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

test('a LOCKED artefact leaves the marker unwritten, so the next launch retries', () => {
  // The case this rule exists for: a second instance still holds the file. The
  // easy implementation writes the marker regardless and strands the artefact
  // forever on the one launch where it happened to be locked.
  const root = dirtyProfile()
  const locked = path.join(root, 'Network', 'Network Persistent State')
  const fd = fs.openSync(locked, 'r+')
  try {
    const r = purgeLeakedProfileState(root)
    // Windows may or may not refuse the unlink depending on share mode; assert
    // the INVARIANT rather than the platform's choice.
    if (r.failed.length > 0) {
      assert.equal(exists(root, 'cleanup.json'), false, 'the marker was written despite a failure')
      assert.match(describeCleanup(r) ?? '', /retrying next launch/)
    } else {
      assert.equal(exists(root, 'cleanup.json'), true)
    }
  } finally {
    fs.closeSync(fd)
  }
  // Once it is released, a later launch finishes the job.
  const again = purgeLeakedProfileState(root)
  assert.equal(exists(root, 'Network', 'Network Persistent State'), false)
  assert.deepEqual(again.failed, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a corrupt marker does not skip the cleanup forever', () => {
  const root = dirtyProfile()
  fs.writeFileSync(path.join(root, 'cleanup.json'), 'not json {{{')
  const r = purgeLeakedProfileState(root)
  assert.equal(r.alreadyDone, false)
  assert.equal(exists(root, 'Dictionaries'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an older marker version re-runs, so a new artefact can be added later', () => {
  const root = dirtyProfile()
  fs.writeFileSync(path.join(root, 'cleanup.json'), JSON.stringify({ version: CLEANUP_VERSION - 1 }))
  const r = purgeLeakedProfileState(root)
  assert.equal(r.alreadyDone, false)
  assert.equal(r.removed.length, 5)
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
  for (const literal of ['Dictionaries', 'Network Persistent State', 'session']) {
    assert.ok(src.includes(`'${literal}'`), `the target list no longer names '${literal}'`)
  }
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
