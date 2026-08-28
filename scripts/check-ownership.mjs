#!/usr/bin/env node
/**
 * `mustNotTouch`, ENFORCED. It was not enforced anywhere.
 *
 * THE MEASUREMENT THAT STARTED THIS. `grep -rn mustNotTouch scripts/ src/` found
 * exactly one hit — `manifest.test.ts:237`, which checks the listed paths are not
 * stale. Nothing checked whether anyone had EDITED one. Proof: appending three
 * lines to `src/renderer/src/main.ts` — owned by `core-renderer`, named in the
 * `mustNotTouch` list of 40 of the 55 rows, and named in `check-partition.mjs`'s
 * own header as THE collision hotspot — gave
 *
 *     npm run check:partition   ->  exit 0, "clean, 129 tracked files"
 *     npm run check:forbidden   ->  exit 0, "clean, 122 files scanned"
 *
 * and that is correct behaviour for both: `check:partition` asks who OWNS each
 * file, never who changed it. The pilots' clean record — 27 files, all additions,
 * all inside their own `ownedFiles` — was discipline. Thirty-four more modules
 * were about to run on it.
 *
 * WHAT A CHANGE SET IS ALLOWED TO BE. Two rules, and the reason there are two is
 * that "who is acting?" has an honest answer only sometimes:
 *
 *   RULE A — CROSS-ATTRIBUTION. Unconditional, needs no declaration, runs in
 *     `npm run verify` and on every CI push. If a change set touches any file
 *     owned by a FEATURE module, every other file in that change set must be
 *     owned by the same module. This is the exact shape Wave 1 produced: 27
 *     module files plus 8 shared-file edits across 6 core rows. It cannot be
 *     opted out of and it needs nobody to remember anything.
 *
 *   RULE B — DECLARED ACTOR (`--as <id>`). Every changed file must be owned by
 *     that one row. This is the rule a module author's branch runs, and it is
 *     the one that fails on a lone `main.ts` edit — because a lone `main.ts`
 *     edit is a perfectly legitimate `core-renderer` change and a check that
 *     failed on it unconditionally would be the next check that lies. The actor
 *     is taken from `--as`, from `$RL_MODULE`, from a `Module:` trailer on the
 *     commits in the range, or from a branch named `feat/M03-…`,
 *     `module/video-enhance`, `core/renderer` — so on a module branch it is not
 *     an honour system either.
 *
 * `mustNotTouch` VIOLATIONS ARE REPORTED SEPARATELY from merely-unowned ones,
 * because the message differs: one is "you edited the file 40 rows are told not
 * to touch, here is the contribution point that exists instead", the other is
 * "this file belongs to someone else".
 *
 * Usage:
 *   node scripts/check-ownership.mjs                    working tree vs HEAD
 *   node scripts/check-ownership.mjs --base origin/main  a whole branch
 *   node scripts/check-ownership.mjs --as M03            declare the actor
 *   node scripts/check-ownership.mjs --self-test         the rules against fixtures
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modules = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
)

const argv = process.argv.slice(2)
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const SELF_TEST = argv.includes('--self-test')

// ---------------------------------------------------------------------------
// The manifest, read the way the rules need it
// ---------------------------------------------------------------------------

const isFeatureRow = (row) => /^M\d+$/.test(row.id)
const moduleDirOf = (row) =>
  /^src\/main\/features\/([a-z0-9-]+)\/$/.exec(row.path ?? '')?.[1] ?? null

/** Resolve `M03`, `video-enhance` or `core-renderer` to one manifest row. */
export function resolveRow(name) {
  if (!name) return null
  const direct = modules.find((m) => m.id === name)
  if (direct) return direct
  return modules.find((m) => moduleDirOf(m) === name) ?? null
}

/** Every row that owns `file` (the partition check guarantees at most one). */
function ownersOf(file) {
  const out = []
  for (const row of modules) {
    for (const entry of row.ownedFiles ?? []) {
      const hit = entry.endsWith('/') ? file.startsWith(entry) : file === entry
      if (hit) {
        out.push(row.id)
        break
      }
    }
  }
  return out
}

/**
 * `mustNotTouch` as a predicate, PROSE INCLUDED.
 *
 * The lists are mostly literal paths, and three entries are prose. Two of the
 * three are real file rules and are expanded here; three name mpv surfaces
 * rather than files and are enforced elsewhere (the ownership map at every
 * `ctx.mpv.set`, and `check:forbidden` for raw `vf`/`af`), so they are
 * recognised and skipped rather than silently ignored — an unrecognised entry
 * is a FAILURE of this script, because a rule it cannot read is a rule it
 * reports clean.
 */
const NOT_A_FILE_RULE = [
  'mpv `vf` / `af` (use ctx.vf / ctx.af)',
  'any mpv property not in ownedProperties (use ctx.mpv.requestSet)',
  'any mpv command owned by another module (use its mediator)'
]

export function forbiddenFor(row) {
  /** @type {Array<{ test: (f: string) => boolean, why: string }>} */
  const rules = []
  const unreadable = []
  for (const entry of row.mustNotTouch ?? []) {
    if (NOT_A_FILE_RULE.includes(entry)) continue
    if (entry === 'any file under src/main/features/** or src/renderer/src/features/**') {
      rules.push({
        test: (f) =>
          f.startsWith('src/main/features/') || f.startsWith('src/renderer/src/features/'),
        why: entry
      })
      continue
    }
    if (entry === "another core piece's files") {
      const mine = new Set(row.ownedFiles ?? [])
      const others = modules
        .filter((m) => m.id !== row.id && !isFeatureRow(m))
        .flatMap((m) => (m.ownedFiles ?? []).filter((e) => !mine.has(e)))
      rules.push({
        test: (f) => others.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e)),
        why: entry
      })
      continue
    }
    if (entry.startsWith('src/')) {
      rules.push({
        test: (f) => (entry.endsWith('/') ? f.startsWith(entry) : f === entry),
        why: entry
      })
      continue
    }
    unreadable.push(entry)
  }
  return { rules, unreadable }
}

// ---------------------------------------------------------------------------
// The rules, as a pure function so --self-test can drive them
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} files  changed paths, repo-relative, forward slashes
 * @param {string | null} actorName  the declared actor, or null
 * @returns {{ problems: string[], attributed: Array<[string, string]>, actor: string | null }}
 */
export function evaluate(files, actorName) {
  const problems = []
  const scoped = files.filter((f) => f.startsWith('src/'))
  const attributed = scoped.map((f) => {
    const owners = [...new Set(ownersOf(f))]
    return [f, owners.length === 1 ? owners[0] : owners.length === 0 ? '(nobody)' : owners.join('+')]
  })

  const declared = resolveRow(actorName)
  if (actorName && !declared) {
    problems.push(
      `--as '${actorName}' names no row in docs/parity/modules.json. Use a row id (M03), a ` +
        `module directory (video-enhance) or a core row id (core-renderer).`
    )
    return { problems, attributed, actor: null }
  }

  /** Report one file against one row's rules. */
  const check = (row, file, ruleName) => {
    if (ownersOf(file).includes(row.id)) return
    const { rules, unreadable } = forbiddenFor(row)
    for (const entry of unreadable) {
      problems.push(
        `${row.id}'s mustNotTouch entry '${entry}' is neither a path under src/ nor a rule this ` +
          `script knows how to read. A rule that cannot be read is a rule that reports clean; ` +
          `either make it a path or teach scripts/check-ownership.mjs about it.`
      )
    }
    const hit = rules.find((r) => r.test(file))
    if (hit) {
      problems.push(
        `${ruleName}: ${row.id} changed ${file}\n` +
          `    which its own mustNotTouch list names as '${hit.why}'.\n` +
          `    That file is owned by ${ownersOf(file).join(', ') || '(nobody)'}. Use the ` +
          `contribution point instead:\n` +
          `    ${hintFor(file)}`
      )
      return
    }
    problems.push(
      `${ruleName}: ${row.id} changed ${file}\n` +
        `    which it does not own (owner: ${ownersOf(file).join(', ') || '(nobody)'}).\n` +
        `    A module's change set is the files in its own ownedFiles. If this file really has ` +
        `to move, that is a core change and belongs in its own commit against its owner's row.`
    )
  }

  if (declared) {
    // RULE B. Every changed file must be the actor's.
    for (const f of scoped) check(declared, f, 'RULE B (declared actor)')
  } else {
    // RULE A. Any feature row in the set claims the whole set.
    const featureActors = modules.filter(
      (row) => isFeatureRow(row) && scoped.some((f) => ownersOf(f).includes(row.id))
    )
    for (const row of featureActors) {
      for (const f of scoped) check(row, f, 'RULE A (cross-attribution)')
    }
  }
  return { problems, attributed, actor: declared?.id ?? null }
}

/** What to do instead. Specific per shared file, because "use the API" is not help. */
function hintFor(file) {
  const hints = [
    ['src/renderer/index.html', 'ctx.panel(), ctx.transportButton(), ctx.seekbarLayer()'],
    ['src/renderer/src/main.ts', 'ctx.panel() / ctx.seekbarLayer() / ctx.transportButton() / ctx.statsSection()'],
    ['src/renderer/src/styles.css', "a .css file in your own features/<id>/ directory, imported from its index.ts"],
    ['src/renderer/settings.html', 'ctx.settings.define(), ctx.settingsSection(), ctx.settingsComponent()'],
    ['src/renderer/src/settings.ts', 'ctx.settings.define(), ctx.settingsSection(), ctx.settingsComponent()'],
    ['src/main/ipc.ts', 'ctx.ipc.handle()/on()/send() in your own namespace'],
    ['src/main/index.ts', 'ctx.lifecycle.onReady()/onQuit(), and your module directory'],
    ['src/main/core/mpv/', 'ctx.mpv, ctx.vf, ctx.af — never the bus or a chain directly'],
    ['src/main/mpv/', 'ctx.mpv for the playing instance, ctx.engine.spawn() for a second one'],
    ['src/shared/types.ts', 'your own types, in your own directory'],
    ['src/shared/keybinds.ts', "ctx.commands.register()'s `defaults`"],
    ['src/renderer/src/core/', 'the renderer contribution points on ctx (§3.4)']
  ]
  const hit = hints.find(([p]) => (p.endsWith('/') ? file.startsWith(p) : file === p))
  return hit
    ? hit[1]
    : 'see docs/parity/02-wave0-api.md — adding a feature means adding a DIRECTORY'
}

// ---------------------------------------------------------------------------
// Where the change set and the actor come from
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

/**
 * Resolve `--base` into something git can diff against, or exit.
 *
 * A CI expression like `${{ github.event.before }}` is empty on a
 * workflow_dispatch and all-zeros for a newly pushed branch, and with a falsy
 * base this script would diff nothing, find nothing and print "clean" — a
 * vacuous pass on the check whose whole point is that nothing was enforced. So a
 * base that was ASKED FOR and cannot be resolved is a failure, with the fallback
 * stated out loud when one is used.
 */
function resolveBase(raw) {
  if (raw === undefined) return null
  const given = raw.trim()
  const usable = (ref) => {
    if (!ref || /^0{7,40}$/.test(ref)) return false
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }
  if (usable(given)) return given
  for (const fallback of ['HEAD~1', 'origin/main', 'origin/master']) {
    if (usable(fallback)) {
      console.log(
        `check:ownership: --base '${given || '(empty)'}' does not resolve to a commit; ` +
          `using ${fallback} instead. This is stated rather than silent because a base that ` +
          `resolves to nothing makes this check pass on an empty diff.`
      )
      return fallback
    }
  }
  console.error(
    `check:ownership: --base '${given || '(empty)'}' does not resolve to a commit and no ` +
      `fallback does either. Refusing to report "clean" on a diff this could not compute.`
  )
  process.exit(1)
}

function changedFiles(base) {
  const lines = []
  if (base) {
    // `...` so a long-lived branch is compared against its merge base rather
    // than against whatever main has done since.
    lines.push(...git(['diff', '--name-only', `${base}...HEAD`]).split('\n'))
  }
  lines.push(...git(['diff', '--name-only', 'HEAD']).split('\n'))
  lines.push(...git(['diff', '--name-only', '--cached']).split('\n'))
  lines.push(...git(['ls-files', '--others', '--exclude-standard']).split('\n'))
  return [...new Set(lines.map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean))]
}

/**
 * The actor, without asking anyone to remember a flag.
 *
 * A branch name is not a security control and is not meant to be one — it is a
 * default that makes rule B apply on the branches where it belongs, so a module
 * author does not have to opt in to being checked.
 */
function detectActor(base) {
  const explicit = flag('as') ?? process.env['RL_MODULE']
  if (explicit) return { name: explicit, from: explicit === flag('as') ? '--as' : '$RL_MODULE' }

  let trailer = null
  try {
    const range = base ? `${base}...HEAD` : '-1'
    const log = base ? git(['log', '--format=%B', range]) : git(['log', '-1', '--format=%B'])
    trailer = /^Module:\s*(\S+)\s*$/m.exec(log)?.[1] ?? null
  } catch {
    trailer = null
  }
  if (trailer) return { name: trailer, from: 'a Module: commit trailer' }

  let branch = ''
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  } catch {
    branch = ''
  }
  const m = /^(?:feat|feature|module|wave1)\/(M\d+|[a-z0-9-]+)(?:[-_/].*)?$/.exec(branch)
  if (m && resolveRow(m[1])) return { name: m[1], from: `the branch name '${branch}'` }
  const core = /^core\/([a-z0-9-]+)/.exec(branch)
  if (core && resolveRow(`core-${core[1]}`)) {
    return { name: `core-${core[1]}`, from: `the branch name '${branch}'` }
  }
  return { name: null, from: null }
}

// ---------------------------------------------------------------------------
// --self-test: the rules against the change sets they were written for
// ---------------------------------------------------------------------------

function selfTest() {
  const cases = [
    {
      name: 'the 3-line main.ts edit, on M03s branch',
      files: ['src/renderer/src/main.ts'],
      actor: 'M03',
      expect: 'fail',
      because:
        'this is the exact edit that gave check:partition and check:forbidden exit 0, and ' +
        'src/renderer/src/main.ts is in M03s own mustNotTouch list'
    },
    {
      name: 'the same edit, attributed by module directory rather than row id',
      files: ['src/renderer/src/main.ts'],
      actor: 'video-enhance',
      expect: 'fail'
    },
    {
      name: 'M03 editing only its own files',
      files: [
        'src/main/features/video-enhance/index.ts',
        'src/main/features/video-enhance/specs.ts',
        'src/renderer/src/features/video-enhance/index.ts'
      ],
      actor: 'M03',
      expect: 'pass',
      because: 'the pilot record: additions, all inside ownedFiles'
    },
    {
      name: "Wave 1's actual shape: module files PLUS a shared edit, no actor declared",
      files: ['src/main/features/video-enhance/index.ts', 'src/renderer/src/main.ts'],
      actor: null,
      expect: 'fail',
      because: 'RULE A has to catch this with nothing declared, or it catches nothing'
    },
    {
      name: 'a module reaching into ANOTHER module',
      files: [
        'src/main/features/video-enhance/index.ts',
        'src/main/features/audio-eq/index.ts'
      ],
      actor: null,
      expect: 'fail',
      because: 'features/** is in every feature row s mustNotTouch'
    },
    {
      name: 'a legitimate core-renderer change with no actor',
      files: ['src/renderer/src/main.ts', 'src/renderer/src/core/seekbar-host.ts'],
      actor: null,
      expect: 'pass',
      because:
        'no feature row is in the set, so rule A has no actor to attribute it to. A check ' +
        'that failed here would fail every core commit and be switched off inside a week.'
    },
    {
      name: 'the same core change, declared as core-renderer',
      files: ['src/renderer/src/main.ts', 'src/renderer/src/core/seekbar-host.ts'],
      actor: 'core-renderer',
      expect: 'pass'
    },
    {
      name: 'core-renderer reaching into core/mpv',
      files: ['src/renderer/src/main.ts', 'src/main/core/mpv/chain.ts'],
      actor: 'core-renderer',
      expect: 'fail',
      because: "'another core piece\\'s files' is a real rule, not decoration"
    },
    {
      name: 'a file nobody owns',
      files: ['src/main/features/video-enhance/index.ts', 'src/main/brand-new-thing.ts'],
      actor: 'M03',
      expect: 'fail',
      because: 'check:partition catches this too, from the other direction'
    },
    {
      name: 'changes outside src/ are not this check s business',
      files: ['docs/parity/02-wave0-api.md', 'package.json', 'scripts/check-ownership.mjs'],
      actor: 'M03',
      expect: 'pass'
    }
  ]

  const failures = []
  for (const c of cases) {
    const { problems } = evaluate(c.files, c.actor)
    const got = problems.length > 0 ? 'fail' : 'pass'
    if (got !== c.expect) {
      failures.push(
        `${c.name}\n      expected ${c.expect}, got ${got}` +
          (c.because ? `\n      (${c.because})` : '') +
          (problems.length > 0 ? `\n      ${problems.join('\n      ')}` : '')
      )
    }
  }

  // The rules are only worth anything if the manifest is readable, so the
  // expansion is checked too: an unreadable mustNotTouch entry must be reported
  // rather than skipped.
  for (const row of modules) {
    const { rules, unreadable } = forbiddenFor(row)
    if (unreadable.length > 0) {
      failures.push(
        `${row.id} has mustNotTouch entries this script cannot read: ${unreadable.join(', ')}`
      )
    }
    if ((row.mustNotTouch ?? []).length > 0 && rules.length === 0) {
      failures.push(
        `${row.id} has ${row.mustNotTouch.length} mustNotTouch entries and NONE of them ` +
          `expanded into a rule, so nothing about that row is enforced`
      )
    }
  }

  if (failures.length > 0) {
    console.error('check:ownership SELF-TEST FAILED:\n')
    for (const f of failures) console.error('  - ' + f + '\n')
    process.exit(1)
  }
  console.log(
    'check:ownership: self-test passed (%d change-set fixtures, %d rows expanded)',
    cases.length,
    modules.length
  )
}

// ---------------------------------------------------------------------------

if (SELF_TEST) selfTest()

const base = resolveBase(flag('base'))
const files = changedFiles(base)
if (base !== null && files.length === 0) {
  console.error(
    `check:ownership: the diff ${base}...HEAD is empty, so nothing was checked. That is not a ` +
      `pass. If this is intentional, run without --base.`
  )
  process.exit(1)
}
const actor = detectActor(base)
const { problems, attributed } = evaluate(files, actor.name)

const inSrc = attributed.length
console.log(
  'check:ownership: %d changed file(s), %d under src/%s',
  files.length,
  inSrc,
  actor.name ? `, actor '${actor.name}' (from ${actor.from})` : ', no actor declared (rule A only)'
)
if (inSrc > 0) {
  const byOwner = new Map()
  for (const [file, owner] of attributed) {
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), file])
  }
  for (const [owner, list] of [...byOwner].sort()) {
    console.log('  %s: %s', owner, list.join(', '))
  }
}

if (problems.length > 0) {
  console.error('\ncheck:ownership found %d violation(s):\n', problems.length)
  for (const p of problems) console.error('  ' + p + '\n')
  console.error(
    '  `mustNotTouch` is the promise the whole plugin API rests on: 34 more modules land on\n' +
      '  these files. If a shared file genuinely has to change, that is a CORE change — split\n' +
      '  it into its own commit against the owning row and land it first.\n'
  )
  process.exit(1)
}

console.log('check:ownership: clean')
