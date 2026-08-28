#!/usr/bin/env node
/**
 * The file partition, enforced.
 *
 * The whole premise of Wave 1 is that thirty-eight modules can be built in
 * parallel because no two of them ever edit the same file. That premise was
 * false and nothing noticed: `ownedFiles` in docs/parity/modules.json covered
 * 48 of the 78 tracked files under `src/`, and the thirty it missed were
 * precisely the shared-path work -- `src/renderer/src/main.ts`,
 * `src/renderer/index.html`, `src/renderer/src/styles.css`,
 * `src/renderer/settings.html`, `src/renderer/src/settings.ts`,
 * `src/main/index.ts`. Six modules were on a collision course over them and the
 * manifest said nothing, because a partition nothing enforces is a wish.
 *
 * This is the check. Every tracked file under `src/` must be claimed by
 * EXACTLY ONE row of modules.json. Not zero (unowned means contested), not two
 * (two owners means a merge conflict with a schedule attached).
 *
 * It also verifies the other direction: an `ownedFiles` entry that matches
 * nothing on disk is either a typo or a file that has moved, and both go stale
 * silently. Wave-1 module directories that do not exist yet are the deliberate
 * exception -- they are the reservations that make the partition useful before
 * the code is written -- so a directory entry under `features/` is allowed to
 * be empty while a FILE entry is not.
 *
 * Run: npm run check:partition
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repo, 'docs', 'parity', 'modules.json')
const modules = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

// `--others --exclude-standard` includes files that are NEW but not ignored.
// Listing only tracked files meant an unowned file stayed invisible until the
// commit that added it had already landed, which is one commit too late to be
// useful — and it is exactly how four of this repo's own files slipped past the
// first run of this check.
const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
  { cwd: repo, encoding: 'utf8' }
)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)

if (tracked.length === 0) {
  console.error('check:partition: git ls-files returned nothing under src/')
  process.exit(1)
}

/** A claim is either an exact file or a directory prefix ending in '/'. */
const claims = []
for (const m of modules) {
  for (const entry of m.ownedFiles ?? []) claims.push({ owner: m.id, entry })
}

const ownersOf = (file) =>
  claims
    .filter((c) => (c.entry.endsWith('/') ? file.startsWith(c.entry) : file === c.entry))
    .map((c) => c.owner)

const failures = []

// --- 1. every tracked file has exactly one owner ---------------------------
for (const file of tracked) {
  const owners = [...new Set(ownersOf(file))]
  if (owners.length === 0) {
    failures.push(
      `${file}\n    is owned by NOBODY. Add it to exactly one row's ownedFiles in\n` +
        `    docs/parity/modules.json -- a core row if it is shared infrastructure,\n` +
        `    the feature module's row if it is that feature's. An unowned shared file\n` +
        `    is a merge conflict waiting for two people to reach it at once.`
    )
  } else if (owners.length > 1) {
    failures.push(
      `${file}\n    is claimed by ${owners.length} modules: ${owners.join(', ')}.\n` +
        `    Exactly one owner. Two is the conflict this manifest exists to prevent.`
    )
  }
}

// --- 2. no claim points at nothing -----------------------------------------
// A directory reservation for an unimplemented Wave-1 module is fine and is the
// point of the manifest; a claim on a FILE that does not exist is stale.
for (const { owner, entry } of claims) {
  const abs = path.join(repo, entry)
  if (entry.endsWith('/')) {
    if (!fs.existsSync(abs) && !/\/features\//.test(entry)) {
      failures.push(
        `${entry}\n    is claimed by ${owner} but no such directory exists, and it is not a\n` +
          `    Wave-1 feature reservation. Fix the path or drop the claim.`
      )
    }
    continue
  }
  if (!tracked.includes(entry)) {
    failures.push(
      `${entry}\n    is claimed by ${owner} but is not a tracked file. It was probably\n` +
        `    renamed or deleted; a claim on a file that no longer exists tells the\n` +
        `    next implementer nothing true.`
    )
  }
}

// --- 3. a module never owns a file inside another module's directory -------
for (const { owner, entry } of claims) {
  const m = /^src\/(?:main|renderer\/src)\/features\/([a-z0-9-]+)\//.exec(entry)
  if (!m) continue
  const dirModule = m[1]
  const row = modules.find((x) => x.id === owner)
  const expected = (row?.path ?? '').replace(/^src\/main\/features\//, '').replace(/\/$/, '')
  if (expected && dirModule !== expected) {
    failures.push(
      `${entry}\n    is claimed by ${owner}, whose directory is '${expected}'. A module owns\n` +
        `    its own directory and nothing else under features/.`
    )
  }
}

if (failures.length > 0) {
  console.error('check:partition found %d problem(s):\n', failures.length)
  for (const f of failures) console.error('  ' + f + '\n')
  process.exit(1)
}

const coreOwned = tracked.filter((f) => ownersOf(f).some((o) => o.startsWith('core'))).length
console.log(
  'check:partition: clean (%d tracked files under src/, %d core-owned, %d module-owned, %d claims)',
  tracked.length,
  coreOwned,
  tracked.length - coreOwned,
  claims.length
)
