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

// --- 4. CONTENT is checked by SYMBOL, not by file -------------------------
//
// File-granular checking is what let the last collision through. Every file was
// owned by exactly one row and the check passed — while
// `src/renderer/src/styles.css`, owned by `core-renderer` and listed in the
// `mustNotTouch` of 40 of the 55 rows, carried `.seek-chapter-tick` and
// `.seek-tip-chapter`: M25 nav-chapters' private styles, referenced by nothing
// except `src/renderer/src/features/nav-chapters/index.ts`.
//
// The selector rule that replaced it had three holes of its own, and all three
// were found by planting the violation and watching the check report "clean":
//
//   HOLE 1 — it gated on `featureUsers.length === 1`, so a selector used by TWO
//     feature modules passed. That is exactly the case the rule exists for:
//     §6.3 requires chapter ticks (M25), bookmark pins (M26) and thumbnails
//     (M27) on ONE seek bar at once, so the shared-selector collision is a
//     three-way one by design. Planted `.plantedB` in core `styles.css`,
//     referenced from both nav-chapters and playlist: reported clean.
//
//   HOLE 2 — a use was any substring hit anywhere in any core `.ts`/`.html`,
//     comments included. Planted `.plantedC` used only by nav-chapters, plus
//     the bare word `plantedC` in a COMMENT in core-owned `util.ts`: reported
//     clean. One word of prose whitelisted a real violation.
//
//   HOLE 3 — only `.css` files were scanned at all
//     (`cssFiles = tracked.filter(f => f.endsWith('.css'))`). There was no
//     content check for HTML or TS of any kind.
//
// So the unit is a SYMBOL now, not a file and not only a CSS selector:
//
//   - class and id selectors DEFINED by a stylesheet (leftmost, see below), and
//   - element ids DECLARED by an HTML file (`id="…"`).
//
// and a USE is the symbol appearing inside a STRING LITERAL of a code file —
// `el.className = 'seek-layer'`, `querySelector('.pl-row')`, `class="icon-btn"`.
// Comments are blanked by `scripts/lib/lex.mjs` before anything is matched, so
// prose can no longer whitelist a symbol.
//
// WHAT THIS STILL CANNOT SEE, stated plainly because a check whose limits are
// undocumented gets trusted past them: it cannot tell that `#playlistBtn` in
// core's `index.html` is a FEATURE's control, because core's `main.ts` genuinely
// referenced it — the symbol had a legitimate core user, so no ownership rule
// could fire. That one is fixed by moving the control to `ctx.transportButton()`
// rather than by detecting it; what the rule below guarantees is that it cannot
// come back as a feature-only symbol in a core file.

import { lex } from './lib/lex.mjs'
import { symbolsIn } from './lib/css.mjs'

const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8')
const cssFiles = tracked.filter((f) => f.endsWith('.css'))
const htmlFiles = tracked.filter((f) => f.endsWith('.html'))
const codeFiles = tracked.filter((f) => /\.(ts|js|html)$/.test(f))

/**
 * THE SELECTOR EXTRACTION IS A PARSER NOW, and the change is not cosmetic.
 *
 * It used to be `/(^|\}|;)([^{}]+)\{/` for the prelude and
 * `/[.#]([A-Za-z][A-Za-z0-9_-]*)/.exec(part)` for the name, and each half had a
 * hole that let a real violation through with exit 0:
 *
 *   - the prelude had to follow `}`, `;` or start-of-file, so THE FIRST RULE
 *     INSIDE ANY AT-RULE was never extracted. `.bm-pin` planted inside
 *     `@media (min-width: 1px) { … }` in core styles.css, referenced only from
 *     two feature modules: reported clean.
 *   - `.exec()` returns the FIRST match, so anything after a descendant
 *     combinator was invisible. `.seek-layer .thumb-preview`, same file, same
 *     two modules: reported clean.
 *
 * Instrumented against this repo's own four stylesheets, 15 selector tokens
 * were already unextractable, 7 of them in core `styles.css` (boosted, close,
 * error, play, primary, show, small). The rule-5 self-check below did not close
 * it either: it named three canaries by hand, and any new Wave-1 name --
 * bookmark pins, thumbnail previews -- has no canary and reports clean.
 *
 * `scripts/lib/css.mjs` uses postcss to walk the rules (it descends into every
 * at-rule) and a state machine to tokenize each selector, and it has its own
 * test file whose fixtures are the two planted violations.
 *
 * TWO VIEWS, because the rules below need different ones:
 *
 *   `all`      every class and id anywhere in the selector. Rule 4a asks
 *              whether a CORE file MENTIONS a name, and `.seek-layer
 *              .thumb-preview` mentions `thumb-preview`.
 *   `leftmost` the first compound of each comma part only. Rules 4b and 4c ask
 *              who DEFINES a symbol, and `.pl-tools .icon-btn` in the playlist's
 *              own stylesheet is a module styling a core component inside its
 *              own subtree -- which is what a shared component is for. Reading
 *              that as a redefinition of `.icon-btn` would make the check noise
 *              people suppress.
 */
function selectorsIn(file) {
  try {
    return symbolsIn(read(file), file)
  } catch (e) {
    failures.push(
      `${file}\n    could not be parsed as CSS: ${e.message}\n` +
        `    A stylesheet this check cannot read is one it cannot check, and every rule\n` +
        `    below would report 'clean' for it. Fix the CSS or fix scripts/lib/css.mjs.`
    )
    return { all: new Set(), leftmost: new Set() }
  }
}

/** The element ids an HTML file DECLARES. Comments blanked first. */
function idsIn(file) {
  const html = lex(read(file)).code
  const names = new Set()
  for (const m of html.matchAll(/\sid\s*=\s*["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) names.add(m[1])
  return names
}

/** Which owner each file belongs to, and whether that owner is a feature. */
const featureOf = (file) => /\/features\/([a-z0-9-]+)\//.exec(file)?.[1] ?? null

/**
 * Every symbol, with where it is defined and what KIND it is, so the failure
 * message can name the right fix.
 */
// KEYED BY KIND AND NAME, not by name. `.seek` (core's slider class) and
// `#seek` (the element it is on) are two different symbols that happen to share
// a word, and collapsing them made whichever one was scanned first shadow the
// other -- silently, and in the direction that reports fewer problems.
const definedAll = new Map() // 'kind:name' -> Set(file)   every mention
const definedLeftmost = new Map() // 'kind:name' -> Set(file)   subject position
const add = (map, key, file) => {
  let e = map.get(key)
  if (!e) map.set(key, (e = new Set()))
  e.add(file)
}
for (const file of cssFiles) {
  const { all, leftmost } = selectorsIn(file)
  for (const key of all) add(definedAll, key, file)
  for (const key of leftmost) add(definedLeftmost, key, file)
}
// An `id="x"` declaration is unambiguous: it is both a mention and a subject.
for (const file of htmlFiles) {
  for (const name of idsIn(file)) {
    add(definedAll, `id:${name}`, file)
    add(definedLeftmost, `id:${name}`, file)
  }
}
const parse = (key) => ({ kind: key.slice(0, key.indexOf(':')), name: key.slice(key.indexOf(':') + 1) })

/**
 * STRING LITERALS ONLY, comments blanked.
 *
 * `lex()` returns a view of each file in which everything outside a string is
 * blanked, so `// plantedC` in a core file's comment is no longer a "use" and
 * cannot whitelist a feature's private symbol sitting in a core file. HTML
 * attribute values (`class="icon-btn"`, `id="seek"`) are string literals under
 * the same lexer, which is what extends this rule to HTML for the first time.
 */
/**
 * An `id="x"` attribute DECLARES the id; it is not a USE of it.
 *
 * Without this, every id in `index.html` had a "core user" — the declaration
 * itself — so rule 4a could never fire on an HTML id at all and the whole HTML
 * half of the check was decorative. Measured: a planted `<div id="plantedD">`
 * referenced only from `nav-chapters/index.ts` was reported clean. The
 * declarations are stripped before the file is lexed, so `for="x"`,
 * `aria-labelledby="x"` and `href="#x"` still count as the real references they
 * are.
 */
const usesTextOf = (f) => {
  const src = read(f)
  return f.endsWith('.html') ? src.replace(/(\sid\s*=\s*["'])[^"']*(["'])/g, '$1$2') : src
}

const codeText = codeFiles.map((f) => ({
  file: f,
  strings: lex(usesTextOf(f)).strings,
  feature: featureOf(f)
}))

const usedBy = new Map() // 'kind:name' -> Set(feature id | 'core')
for (const key of definedAll.keys()) {
  const { name } = parse(key)
  const owners = new Set()
  const needle = new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`)
  for (const c of codeText) {
    if (!needle.test(c.strings)) continue
    owners.add(c.feature ?? 'core')
  }
  usedBy.set(key, owners)
}

const sigil = (kind) => (kind === 'id' ? '#' : '.')
const kindWord = (kind) => (kind === 'id' ? 'id' : 'selector')

for (const key of definedAll.keys()) {
  const { kind, name } = parse(key)
  const mentions = [...(definedAll.get(key) ?? [])]
  const subjects = [...(definedLeftmost.get(key) ?? [])]
  const where = kind === 'id' ? 'a core-owned HTML file' : 'a core stylesheet'

  // 4a. A core file must not carry a symbol only FEATURES use.
  //
  //     `=== 1` was the first bug here. §6.3 puts M25's ticks, M26's pins and
  //     M27's thumbnails on the same seek bar, so the collision this rule exists
  //     to catch is a two- and three-module one — and those were precisely the
  //     cases that passed. Any number of feature users with no core user is a
  //     private symbol in a shared file.
  //
  //     MENTIONS, not subjects. `.seek-layer .thumb-preview` in core styles.css
  //     is core carrying a feature's private class just as surely as
  //     `.thumb-preview` on its own would be, and reading only the leftmost
  //     token is what made it invisible.
  const inCoreMentions = mentions.filter((f) => featureOf(f) === null)
  if (inCoreMentions.length > 0) {
    const users = [...(usedBy.get(key) ?? [])]
    const featureUsers = users.filter((u) => u !== 'core')
    if (featureUsers.length > 0 && !users.includes('core')) {
      const list =
        featureUsers.length === 1
          ? `'${featureUsers[0]}'`
          : `${featureUsers.length} modules: ${featureUsers.sort().join(', ')}`
      failures.push(
        `${sigil(kind)}${name}\n    is defined in ${inCoreMentions.join(', ')} (core-owned, ${where}) but is\n` +
          `    used ONLY by ${list}. That is a feature's private ${kindWord(kind)} living in a file 40 of\n` +
          `    the 55 rows are told not to touch, so the next module that wants the same host\n` +
          `    edits it too — and when there is more than one user already, the merge conflict\n` +
          `    is not hypothetical, it is scheduled. Move it into\n` +
          `    src/renderer/src/features/<module>/ and contribute it: a stylesheet imported from\n` +
          `    that module's index.ts (the way M28's playlist does), a panel through ctx.panel(),\n` +
          `    a seek-bar layer through ctx.seekbarLayer(), a control through ctx.transportButton().`
      )
    }
  }

  // 4b and 4c are about who OWNS the symbol, which is the subject position.
  const inCore = subjects.filter((f) => featureOf(f) === null)
  const inFeatures = subjects.filter((f) => featureOf(f) !== null)

  // 4b. Two features must never define the same symbol: that is the same
  //     collision one level down, and it is silent because CSS just cascades.
  const owners = [...new Set(inFeatures.map(featureOf))]
  if (owners.length > 1) {
    failures.push(
      `${sigil(kind)}${name}\n    is defined by ${owners.length} different modules: ${owners.join(', ')}.\n` +
        `    CSS has no ownership check of its own -- it simply cascades, so the last one\n` +
        `    bundled wins and nothing reports it. Namespace it per module.`
    )
  }

  // 4c. A feature must not redefine a symbol core also defines.
  if (inCore.length > 0 && inFeatures.length > 0) {
    failures.push(
      `${sigil(kind)}${name}\n    is defined in core (${inCore.join(', ')}) AND in ${inFeatures.join(', ')}.\n` +
        `    A module overriding a core ${kindWord(kind)} is a merge conflict with a delay on it.`
    )
  }
}

// --- 5. the rule has to be able to see itself ------------------------------
//
// A content check that silently stops matching passes everything, which is how
// hole 2 above survived: the whitelist path was exercised by prose and nobody
// noticed the real path had stopped running.
//
// THE PREVIOUS VERSION OF THIS SELF-CHECK DID NOT CLOSE THE HOLE IT WAS FOR. It
// named three canaries by hand -- `seek-layer`, `icon-btn`, `seek-chapter-tick`
// -- all three of which happened to be leftmost and at the top level, so the
// extraction could fail on every at-rule and every descendant combinator in the
// repo and still find all three. Re-planted inside `@media` it reported the
// wrong diagnosis. Any new Wave-1 name has no canary at all.
//
// So the self-check runs the extractor over a fixture that contains the SHAPES
// it must handle rather than the NAMES this repo happens to use today. It is the
// same fixture as the first two cases in scripts/lib/css.test.mjs, restated here
// because a check that trusts a test file it does not run is trusting prose.
{
  const fixture = `@media (min-width: 1px) {
    .canary-in-at-rule { color: red }
  }
  .canary-subject .canary-descendant { color: red }
  #canary-id.canary-compound { color: red }
  @keyframes ignored { from { opacity: 0 } }
  .canary-hex { color: #fff }`
  let got = { all: new Set(), leftmost: new Set() }
  let parseError = null
  try {
    got = symbolsIn(fixture, '<self-check>')
  } catch (e) {
    parseError = e.message
  }
  const must = [
    ['class:canary-in-at-rule', 'the first rule inside an @media block'],
    ['class:canary-descendant', 'a class after a descendant combinator'],
    ['class:canary-compound', 'a class in a compound with an id'],
    ['id:canary-id', 'an id in a selector'],
    ['class:canary-subject', 'a leftmost class'],
    ['class:canary-hex', 'a rule whose declaration holds a hex colour']
  ]
  const missed = must.filter(([k]) => !got.all.has(k))
  const mustNot = [
    ['id:fff', 'a hex colour in a DECLARATION read as an id'],
    ['class:from', 'a @keyframes step read as a class']
  ]
  const overreach = mustNot.filter(([k]) => got.all.has(k))
  if (parseError !== null || missed.length > 0 || overreach.length > 0) {
    failures.push(
      `the selector extraction fails its own fixture.\n` +
        (parseError !== null ? `    postcss threw: ${parseError}\n` : '') +
        missed.map(([k, why]) => `    MISSED ${k} — ${why}\n`).join('') +
        overreach.map(([k, why]) => `    INVENTED ${k} — ${why}\n`).join('') +
        `    Every assertion above is built on it, so a rule that matches nothing reports\n` +
        `    'clean' for every violation at once. Fix scripts/lib/css.mjs first, and run\n` +
        `    node --test scripts/lib/css.test.mjs.`
    )
  }

  // …and, separately, that it still finds this repo's real symbols. The fixture
  // proves the shapes are handled; these prove the extractor is pointed at the
  // right files.
  const knownSelectors = ['seek-layer', 'icon-btn', 'seek-chapter-tick']
  const missingReal = knownSelectors.filter((n) => !definedAll.has(`class:${n}`))
  if (missingReal.length > 0) {
    failures.push(
      `the selector extraction stopped finding ${missingReal.join(', ')} in the repo's own\n` +
        `    stylesheets, even though it passes its fixture. The file list, not the parser.`
    )
  }
  // One name that is ONLY reachable through the two holes: it lives after a
  // descendant combinator, and if the `all` view regressed to leftmost it goes.
  if (definedAll.size <= definedLeftmost.size) {
    failures.push(
      `the 'all' and 'leftmost' views of the stylesheets are the same size\n` +
        `    (${definedAll.size} vs ${definedLeftmost.size}). The whole point of the parser is that\n` +
        `    core styles.css alone holds 7 tokens the leftmost view cannot see; if the two\n` +
        `    agree, the 'all' view has collapsed back into the regex's behaviour.`
    )
  }
  if (!definedAll.has('id:seek')) {
    failures.push(
      `the HTML id extraction stopped finding #seek.\n` +
        `    There was no content check for HTML at all until this rule existed; a broken\n` +
        `    one is the same thing wearing a passing test.`
    )
  }
  const seekLayerUsers = usedBy.get('class:seek-layer') ?? new Set()
  if (!seekLayerUsers.has('core')) {
    failures.push(
      `the string-literal USE extraction stopped finding core's own 'seek-layer'.\n` +
        `    If uses stop being found, every core-defined symbol looks feature-only and the\n` +
        `    check turns into noise; if they are found too eagerly, nothing is ever reported.`
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
