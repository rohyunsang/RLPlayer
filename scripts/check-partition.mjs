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

// --- 4. CSS is checked by SELECTOR, not by file ----------------------------
//
// File-granular checking is what let the next collision through. Every file was
// owned by exactly one row and the check passed — while
// `src/renderer/src/styles.css`, owned by `core-renderer` and listed in the
// `mustNotTouch` of 40 of the 55 rows, carried `.seek-chapter-tick` and
// `.seek-tip-chapter`: M25 nav-chapters' private styles, referenced by nothing
// except `src/renderer/src/features/nav-chapters/index.ts`.
//
// That is the `#playlist` failure again, moved from the panel path to the
// seek-bar path. §6.3 requires the seek bar to carry chapter ticks, bookmark
// pins and the A-B region at the same time, so M20, M26 and M27 were each about
// to follow M25's committed precedent into the same file. M28's playlist
// already shows the right shape: a module imports its own stylesheet and Vite
// bundles it.
//
// The rule below is mechanical: a selector defined in a CORE stylesheet must be
// used by at least one core file. If the only code that mentions it lives in one
// feature's directory, it is that feature's private style in a shared file.

const cssFiles = tracked.filter((f) => f.endsWith('.css'))
const codeFiles = tracked.filter((f) => /\.(ts|js|html)$/.test(f))
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8')

/**
 * The selectors a stylesheet DEFINES — the LEFTMOST class or id of each comma-
 * separated part, which is the one the rule is scoped by.
 *
 * Leftmost, not every token, and the distinction is the whole usefulness of the
 * rule. `.pl-tools .icon-btn { position: relative }` in the playlist's own
 * stylesheet is a module styling a core component INSIDE its own subtree, which
 * is exactly what a shared component is for. A flat token scan calls that a
 * redefinition of core's `.icon-btn` and the check becomes noise people
 * suppress. `.icon-btn { ... }` on its own in a module's stylesheet is a global
 * override and is still caught.
 */
function selectorsIn(file) {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set()
  for (const m of css.matchAll(/(^|\}|;)([^{}]+)\{/g)) {
    const prelude = (m[2] ?? '').trim()
    if (prelude.startsWith('@') || prelude.includes(':root')) continue
    for (const part of prelude.split(',')) {
      const first = /[.#]([A-Za-z][A-Za-z0-9_-]*)/.exec(part)
      if (first) names.add(first[1])
    }
  }
  return names
}

/** Which owner each file belongs to, and whether that owner is a feature. */
const featureOf = (file) => /\/features\/([a-z0-9-]+)\//.exec(file)?.[1] ?? null

const definedBy = new Map() // selector -> Set(file)
for (const file of cssFiles) {
  for (const name of selectorsIn(file)) {
    if (!definedBy.has(name)) definedBy.set(name, new Set())
    definedBy.get(name).add(file)
  }
}

// Where each selector is USED, by owner.
const usedBy = new Map() // selector -> Set(feature id | 'core')
const codeText = codeFiles.map((f) => ({ file: f, text: read(f), feature: featureOf(f) }))
for (const [name] of definedBy) {
  const owners = new Set()
  const needle = new RegExp(`(^|[^A-Za-z0-9_-])${name}([^A-Za-z0-9_-]|$)`)
  for (const c of codeText) {
    if (!needle.test(c.text)) continue
    owners.add(c.feature ?? 'core')
  }
  usedBy.set(name, owners)
}

for (const [name, files] of definedBy) {
  const inCore = [...files].filter((f) => featureOf(f) === null)
  const inFeatures = [...files].filter((f) => featureOf(f) !== null)

  // 4a. A core stylesheet must not carry a selector only one feature uses.
  if (inCore.length > 0) {
    const users = [...(usedBy.get(name) ?? [])]
    const featureUsers = users.filter((u) => u !== 'core')
    if (users.length > 0 && featureUsers.length === 1 && !users.includes('core')) {
      failures.push(
        `.${name}\n    is defined in ${inCore.join(', ')} (core-owned) but is used ONLY by\n` +
          `    '${featureUsers[0]}'. That is a feature's private style living in a file 40 of the\n` +
          `    55 rows are told not to touch, so the next module that wants the same host edits\n` +
          `    it too. Move it to src/renderer/src/features/${featureUsers[0]}/, import the\n` +
          `    stylesheet from that module's index.ts the way M28's playlist does, and leave\n` +
          `    only the HOST rules in core.`
      )
    }
  }

  // 4b. Two features must never define the same selector: that is the same
  //     collision one level down, and it is silent because CSS just cascades.
  const owners = [...new Set(inFeatures.map(featureOf))]
  if (owners.length > 1) {
    failures.push(
      `.${name}\n    is defined by ${owners.length} different modules: ${owners.join(', ')}.\n` +
        `    CSS has no ownership check of its own -- it simply cascades, so the last one\n` +
        `    bundled wins and nothing reports it. Namespace it per module.`
    )
  }

  // 4c. A feature must not redefine a selector core also defines.
  if (inCore.length > 0 && inFeatures.length > 0) {
    failures.push(
      `.${name}\n    is defined in core (${inCore.join(', ')}) AND in ${inFeatures.join(', ')}.\n` +
        `    A module overriding a core selector is a merge conflict with a delay on it.`
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
