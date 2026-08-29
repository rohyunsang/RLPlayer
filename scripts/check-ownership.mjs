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
 *   RULE C — AN UNATTRIBUTED HOTSPOT EDIT. See `evaluate()`.
 *
 * THE DEFAULT MODE IS TWO CHANGE SETS. HEAD is judged against the `Module:`
 * trailers HEAD's own message declares; the working tree is judged with no
 * actor unless one was typed. Borrowing HEAD's trailers to excuse an
 * uncommitted edit was the false negative that let `npm run verify` pass on a
 * live `src/renderer/src/main.ts` change, and reading no commit at all was the
 * one that let the same edit through once it was committed.
 *
 * Usage:
 *   node scripts/check-ownership.mjs                    HEAD, and the worktree
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
export function evaluate(files, actorName, opts = {}) {
  const problems = []
  // Advisory lines are kept OUT of `problems`, because a count that mixes
  // "someone edited a file they do not own" with "this script had to guess" is
  // the kind of number that gets discounted wholesale on the second read.
  const notes = []
  const scoped = files.filter((f) => f.startsWith('src/'))
  const attributed = scoped.map((f) => {
    const owners = [...new Set(ownersOf(f))]
    return [f, owners.length === 1 ? owners[0] : owners.length === 0 ? '(nobody)' : owners.join('+')]
  })

  /**
   * ONE ASSIGNMENT CAN SPAN MORE THAN ONE ROW, and a name that does not resolve
   * MUST NOT switch the rules off.
   *
   * Both halves of this were measured on the Wave-1 integration tree.
   *
   *   Multi-row actors. One agent implemented M35 `stream-open` AND M36
   *   `stream-ytdl`. `--as M35` flagged every M36 file and `--as M36` flagged
   *   every M35 file, so the only way to read either run was by hand. `--as`
   *   now takes a comma-separated list and a file is fine if ANY declared row
   *   owns it, which is exactly RULE B's contract for an actor that is two rows.
   *
   *   An unresolvable actor used to skip EVERY RULE. This function pushed one
   *   problem about the flag and `return`ed before rule A or rule B ran. The
   *   Wave-1 tree carried a `Module: WIP` trailer on its recovery commit, so
   *   `detectActor()` resolved the actor to `WIP`, which names no row — and with
   *   a `src/renderer/src/main.ts` edit planted alongside nine modules' files,
   *   the script reported `found 1 violation(s)` and that one violation was
   *   about the flag. `grep -c 'RULE A|RULE B'` on the output: 0. Exit was 1
   *   either way, which is what hid it: a red check whose message is "your flag
   *   is wrong" gets the flag fixed, not the shared-file edit found.
   *
   * So: an EXPLICIT `--as` typo stays a hard error, because silently downgrading
   * a flag someone typed is how a run gets misread as authoritative. An actor
   * that was AUTO-DETECTED from a commit trailer or a branch name falls back to
   * rule A with the reason stated out loud, because auto-detection guessing
   * wrong must not be able to disarm the check.
   */
  const names = String(actorName ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const declaredRows = []
  const unresolved = []
  for (const n of names) {
    const row = resolveRow(n)
    if (row) declaredRows.push(row)
    else unresolved.push(n)
  }
  if (unresolved.length > 0) {
    const detail =
      `${unresolved.map((n) => `'${n}'`).join(', ')} names no row in docs/parity/modules.json. ` +
      `Use a row id (M03), a module directory (video-enhance), a core row id (core-renderer), ` +
      `or a comma-separated list (M35,M36).`
    if (opts.actorWasExplicit) {
      problems.push(`--as ${detail}`)
      return { problems, notes, attributed, actor: null }
    }
    /**
     * Auto-detected and PARTLY wrong: keep what resolved, say what did not.
     *
     * This used to clear the whole list, and on this repository's own
     * integration branch that was the difference between a readable run and an
     * unreadable one. `main...HEAD` carries 22 `Module:` trailers, one of which
     * is `Module: WIP`; dropping all 22 because of that one put the run back on
     * rule A over thirteen modules' files at once.
     *
     * An UNRESOLVABLE name still may not widen anything: it is simply not an
     * actor. What it must not do is silently switch the check off, which is the
     * defect this branch already carries a fixture for.
     */
    notes.push(
      `NOTE (not a violation): ${detail}` +
        (declaredRows.length > 0
          ? `
    ${declaredRows.length} name(s) DID resolve and rule B runs on those; the ` +
            `unresolvable one is not an actor.`
          : `
    Nothing resolved, so this falls back to RULE A - an actor this script ` +
            `cannot resolve must not be able to
    switch every rule off. Pass --as ` +
            `explicitly to get RULE B.`)
    )
  }
  const declared = declaredRows[0] ?? null

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

  if (declaredRows.length > 0) {
    /**
     * RULE B. Every changed file must be owned by one of the declared rows.
     *
     * TWO DEFECTS, BOTH MEASURED ON THE DELIVERED TREE, BOTH FIXED HERE.
     *
     * 1. THE BLAME WAS ARBITRARY. `check(blamed, ...)` picked the first DECLARED
     *    row whose mustNotTouch happens to name the file, which for anything
     *    under `src/main/core/` is whichever core row was declared first. Every
     *    one of the 163 lines from `--base main` read
     *    `M36 changed src/main/core/input/registry.ts` or
     *    `core-renderer changed src/main/core/paths.ts` -- a row that did not
     *    touch it, named as if it had. A message that names the wrong actor is
     *    read once and then the whole run is discounted.
     *
     *    The file's OWNER is a fact; who among N declared rows edited it is not
     *    recoverable from a diff. So the report states the fact and stops
     *    guessing, and it is COLLAPSED to one line per owning row -- the same
     *    fix rule A already had, which rule B never got.
     *
     * 2. AN AUTO-DETECTED MULTI-ROW ACTOR IS AN INTEGRATION RANGE, NOT A MODULE
     *    BRANCH. `--base main` resolves 20 rows from 20 commit trailers.
     *    Demanding that every one of 171 changed files be owned by one of those
     *    20 is not rule B's contract ("the declared actor stayed inside its own
     *    rows"); it is "these commits do not say who changed core/paths.ts",
     *    which is a gap in COMMIT METADATA on work that already landed.
     *
     *    Conflating the two is what produced a red run on a clean tree, and a
     *    gate that red-lights a clean tree gets switched off by the first person
     *    it blocks. So on an AUTO-DETECTED multi-row actor an undeclared owner is
     *    an attribution NOTE. With an EXPLICIT `--as` it stays a hard failure,
     *    for the same reason an explicit `--as` typo does: a list somebody typed
     *    is a claim about the change set, and this script does not soften those.
     *
     * A file that no row owns at all stays a violation in both modes -- that is
     * not an attribution gap, it is a hole in the partition.
     */
    const ids = new Set(declaredRows.map((r) => r.id))
    /**
     * "Integration range" is a property of `--base`, not of the actor's SHAPE.
     *
     * This used to be `!explicit && rows > 1`, which meant a DEFAULT-mode run
     * that had picked up several trailers from one commit message got the
     * range's soft treatment: an undeclared owner became a note instead of a
     * violation. On this tree HEAD carries six trailers, so every default run
     * was in the soft mode — including the one with a live `main.ts` edit in
     * the working tree. A range is a range because a range was asked for.
     */
    const integration =
      opts.range === true && opts.actorWasExplicit !== true && declaredRows.length > 1
    /** owner id -> files, for the collapsed report. */
    const undeclared = new Map()
    for (const f of scoped) {
      if (ownersOf(f).some((o) => ids.has(o))) continue
      const owners = ownersOf(f)
      if (owners.length === 0) {
        // Nobody owns it. check:partition says the same from the other side, and
        // it is a violation whoever is acting.
        problems.push(
          `RULE B (declared actor${ids.size > 1 ? 's' : ''}): ${f}\n` +
            `    is owned by NO row of docs/parity/modules.json, so there is no owner to ` +
            `attribute it to.\n` +
            `    Every file under src/ belongs to exactly one row -- add it to one, or delete ` +
            `it.\n` +
            `    ${hintFor(f)}`
        )
        continue
      }
      if (!integration) {
        check(declaredRows[0], f, `RULE B (declared actor${ids.size > 1 ? 's' : ''})`)
        continue
      }
      const owner = owners.join('+')
      undeclared.set(owner, [...(undeclared.get(owner) ?? []), f])
    }
    if (undeclared.size > 0) {
      notes.push(
        `NOTE (not a violation): ${[...undeclared.values()].reduce((n, l) => n + l.length, 0)} ` +
          `changed file(s) are owned by ${undeclared.size} row(s) that no commit in this range\n` +
          `    declares with a \`Module:\` trailer. This is an ATTRIBUTION GAP in the commit ` +
          `metadata, not a\n` +
          `    mustNotTouch violation: each file is owned by exactly one row, and which of the ` +
          `${ids.size}\n` +
          `    declared actors edited it is not recoverable from a diff.\n` +
          [...undeclared]
            .sort()
            .map(([owner, list]) => `      ${owner}: ${list.length} file(s) -- ${list[0]}${list.length > 1 ? ', …' : ''}`)
            .join('\n') +
          `\n    To make these violations instead of notes, name the actors: --as ` +
          `${[...ids].join(',')},${[...undeclared.keys()].join(',')}`
      )
    }
  } else {
    // RULE A. Any feature row in the set claims the whole set.
    const featureActors = modules.filter(
      (row) => isFeatureRow(row) && scoped.some((f) => ownersOf(f).includes(row.id))
    )

    /**
     * ONE LINE PER FILE, not one line per (actor x file) PAIR.
     *
     * Detection is unchanged — every (row, file) pair rule A found before is
     * still found, and the exit code is identical. What changes is that the
     * output is readable, and that is not cosmetic. MEASURED on this
     * integration tree, where nine agents' work shares one worktree:
     *
     *   node scripts/check-ownership.mjs   ->  731 RULE A lines
     *   ... of which the ONE real finding  ->  a planted src/renderer/src/main.ts
     *                                          edit, appearing 19 times
     *
     * All eight Wave-1 module authors reported this run independently (68, 69,
     * 70 and 721 violations depending on when they looked) and every one of them
     * described it the same way: unreadable, all of it somebody else's file.
     * M18's report says a module author running it here "would either ignore it
     * or panic". A check whose output is discounted wholesale enforces nothing —
     * which is this repository's own recurring lesson, arriving this time as
     * volume rather than as a wrong assertion.
     *
     * The two buckets are separated for the same reason: "a file nobody in this
     * change set owns" is the SHARED-FILE EDIT shape — the exact defect rule A
     * was written for, and the pilot round's 8-edits-across-6-core-rows — while
     * "cross-module" is the weaker claim that two modules appear together. The
     * first is the finding; the second is mostly an artefact of a shared tree.
     */
    const shared = new Map() // file -> Set<blaming row id>
    const crossed = new Map()
    const push = (map, file, rowId) => {
      if (!map.has(file)) map.set(file, new Set())
      map.get(file).add(rowId)
    }

    for (const row of featureActors) {
      for (const f of scoped) {
        if (ownersOf(f).includes(row.id)) continue
        const owners = ownersOf(f)
        const ownedByAFeatureActorInTheSet = featureActors.some((r) => owners.includes(r.id))
        push(ownedByAFeatureActorInTheSet ? crossed : shared, f, row.id)
      }
    }

    // Any `mustNotTouch` entry this script cannot read is still a failure of
    // this script, reported once rather than once per actor per file.
    for (const row of featureActors) {
      for (const entry of forbiddenFor(row).unreadable) {
        problems.push(
          `${row.id}'s mustNotTouch entry '${entry}' is neither a path under src/ nor a rule this ` +
            `script knows how to read. A rule that cannot be read is a rule that reports clean; ` +
            `either make it a path or teach scripts/check-ownership.mjs about it.`
        )
      }
    }

    /**
     * RULE C - AN UNATTRIBUTED HOTSPOT EDIT. The hole rule A left open, and the
     * one this script's own header (lines 7-14) says it exists to close.
     *
     * MEASURED, on the delivered tree: three lines appended to
     * `src/renderer/src/main.ts` - the exact edit the header names - and
     *
     *     node scripts/check-ownership.mjs --self-test
     *       -> `1 under src/`, `check:ownership: clean`, EXIT 0
     *
     * Rule A needs a FEATURE file co-present to have an actor to attribute the
     * set to. With the shared edit alone there is no feature row in the set, so
     * rule A finds no actor and reports nothing. That makes the remedy this
     * script prints - "split it into its own commit against the owning row" -
     * into the evasion: do exactly as told and the check goes quiet.
     *
     * So an edit to a file that FEATURE rows are forbidden to touch is not
     * "clean" merely because nobody claimed it. It is unattributed, and the
     * difference between a legitimate `core-renderer` change and a module
     * author's shared-file edit is a declaration - one word, and the branch name
     * or a `Module:` trailer supplies it without anyone remembering a flag.
     *
     * This DOES mean an undeclared core commit fails. That is the point: 40 of
     * the 55 rows are told not to touch these files, 25 more modules land on
     * them, and "who changed this" has to have an answer. It is deliberately
     * NARROW - only files a feature row's own mustNotTouch names, only when no
     * actor resolved, and never for a file some feature row in the set owns
     * (rule A already reports those, above).
     */
    const featureRows = modules.filter(isFeatureRow)
    for (const f of scoped) {
      if (shared.has(f) || crossed.has(f)) continue
      const owners = ownersOf(f)
      if (featureRows.some((r) => owners.includes(r.id))) continue
      const named = featureRows.find((r) => forbiddenFor(r).rules.some((rule) => rule.test(f)))
      if (!named) continue
      const why = forbiddenFor(named).rules.find((r) => r.test(f))?.why
      const forbidding = featureRows.filter((r) =>
        forbiddenFor(r).rules.some((rule) => rule.test(f))
      ).length
      problems.push(
        `RULE C (unattributed): ${f}\n` +
          `    is owned by ${owners.join(', ') || '(nobody)'} and named as '${why}' in the ` +
          `mustNotTouch list of ${forbidding} feature row(s),\n` +
          `    and this change set declares NO actor - so nothing here distinguishes a ` +
          `legitimate ${owners[0] ?? 'core'} change\n` +
          `    from a module author's shared-file edit in its own commit, which is the ` +
          `evasion rule A could not see.\n` +
          `    SAY WHO IS ACTING: --as ${owners[0] ?? '<row>'}, a \`Module: ${owners[0] ?? '<row>'}\`` +
          ` commit trailer, or a branch named\n` +
          `    core/${(owners[0] ?? '').replace(/^core-/, '') || '<piece>'}. If the answer is a ` +
          `feature module, the answer is the contribution point:\n` +
          `    ${hintFor(f)}`
      )
    }

    for (const [file, rows] of shared) {
      const blamed = [...rows]
      const named = featureActors.find((r) =>
        forbiddenFor(r).rules.some((rule) => rule.test(file))
      )
      const why = named ? forbiddenFor(named).rules.find((r) => r.test(file))?.why : null
      problems.push(
        `RULE A (cross-attribution): ${file}\n` +
          `    is owned by ${ownersOf(file).join(', ') || '(nobody)'} and by no module in this ` +
          `change set,\n` +
          `    which contains work from ${blamed.length} feature row(s): ${blamed.join(', ')}.\n` +
          (why ? `    Their mustNotTouch lists name it as '${why}'.\n` : '') +
          `    THIS IS THE SHARED-FILE EDIT SHAPE. Use the contribution point instead:\n` +
          `    ${hintFor(file)}`
      )
    }

    if (crossed.size > 0) {
      const byOwner = new Map()
      for (const [file] of crossed) {
        const o = ownersOf(file).join('+') || '(nobody)'
        byOwner.set(o, [...(byOwner.get(o) ?? []), file])
      }
      problems.push(
        `RULE A (cross-attribution): ${crossed.size} file(s) across ` +
          `${byOwner.size} module row(s) appear in ONE change set.\n` +
          [...byOwner]
            .sort()
            .map(([o, list]) => `      ${o}: ${list.length} file(s)`)
            .join('\n') +
          `\n    Rule A assumes a change set has one actor, so with ${featureActors.length} ` +
          `feature rows present it cannot\n` +
          `    say which of them wrote what. If this is one author, that is a violation. If it is\n` +
          `    an INTEGRATION change set, declare the rows: --as ` +
          `${featureActors.map((r) => r.id).join(',')}`
      )
    }
  }
  return { problems, notes, attributed, actor: declared?.id ?? null }
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

/** The uncommitted half: worktree, index and untracked. */
function uncommittedFiles() {
  const lines = []
  lines.push(...git(['diff', '--name-only', 'HEAD']).split('\n'))
  lines.push(...git(['diff', '--name-only', '--cached']).split('\n'))
  lines.push(...git(['ls-files', '--others', '--exclude-standard']).split('\n'))
  return [...new Set(lines.map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean))]
}

/**
 * THE CHANGE SET, and in the DEFAULT mode it now includes the last COMMIT.
 *
 * MEASURED on this tree: three lines appended to `src/renderer/src/main.ts` —
 * the exact edit this script's header says it exists to catch — and committed
 * on their own gave
 *
 *     npm run check:ownership -> "0 changed file(s), 0 under src/", clean, EXIT 0
 *
 * because this function read the worktree, the index and the untracked files
 * and never a commit. Committing is the ONE thing the script's own remedy tells
 * you to do ("split it into its own commit"), so for the second time in this
 * file's history the remedy was the evasion: rule C closed the uncommitted half
 * and left the committed half wide open.
 *
 * `--base` is unaffected — it already spans a whole branch. The default mode now
 * covers HEAD's own diff plus anything not yet committed, which is exactly what
 * a module author is about to push.
 */
function changedFiles(base) {
  const lines = []
  if (base) {
    // `...` so a long-lived branch is compared against its merge base rather
    // than against whatever main has done since.
    lines.push(...git(['diff', '--name-only', `${base}...HEAD`]).split('\n'))
  } else {
    try {
      lines.push(...git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n'))
    } catch {
      /* a root commit has no parent; the uncommitted half still counts */
    }
  }
  lines.push(...uncommittedFiles())
  return [...new Set(lines.map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean))]
}

/** Every `Module:` row HEAD's own commit message declares. */
function headTrailers() {
  try {
    const log = git(['log', '-1', '--format=%B'])
    const found = [...log.matchAll(/^Module:[ 	]*(\S+)[ 	]*$/gm)].map((m) => m[1])
    return [...new Set(found.flatMap((t) => t.split(',').map((x) => x.trim())).filter(Boolean))]
  } catch {
    return []
  }
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
  // `--as` and `$RL_MODULE` were both typed by a human on purpose, so a name
  // that does not resolve is their typo and stays a hard error. Everything
  // below this line is a guess, and a guess may not disarm the check.
  if (explicit) {
    return {
      name: explicit,
      from: explicit === flag('as') ? '--as' : '$RL_MODULE',
      wasExplicit: true
    }
  }

  /**
   * EVERY `Module:` trailer IN THE RANGE, not the first one `exec` finds.
   *
   * THE MEASUREMENT. `node scripts/check-ownership.mjs --base main` on the
   * UNMODIFIED delivered tree exited 1 with 163 violations, and 163 of 163 were
   * false positives: every one a file owned by exactly one legitimate row,
   * blamed on M36. `main...HEAD` spans 22 commits with 22 trailers; `exec`
   * returns the first match, `git log` prints newest first, so the actor for a
   * thirteen-module integration range was whichever module committed last.
   *
   * A range's actor is the UNION of what its commits declare. Rule B already
   * takes a list (that is the M35+M36 fix), so this is one regex flag and a Set
   * - and it turns the flagship gate from "163 red lines on a clean tree",
   * which is a gate people switch off, into "clean".
   *
   * A trailer that names no row is still reported, and still does not disarm
   * anything: see the note in `evaluate()`.
   */
  let trailers = []
  try {
    const range = base ? `${base}...HEAD` : '-1'
    const log = base ? git(['log', '--format=%B', range]) : git(['log', '-1', '--format=%B'])
    trailers = [...new Set([...log.matchAll(/^Module:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]))]
    // One trailer may itself be a list: `Module: M35,M36`.
    trailers = [...new Set(trailers.flatMap((t) => t.split(',').map((x) => x.trim())))].filter(
      Boolean
    )
  } catch {
    trailers = []
  }
  if (trailers.length > 0) {
    return {
      name: trailers.join(','),
      from: `${trailers.length} Module: commit trailer(s) in ${base ? `${base}...HEAD` : 'HEAD'}`
    }
  }

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
      /**
       * THIS FIXTURE USED TO EXPECT `pass`, AND THAT EXPECTATION WAS THE BUG.
       *
       * Its stated reason was "a check that failed here would fail every core
       * commit and be switched off inside a week". True of a check with no
       * remedy; this one has a one-word remedy and states it, and the same
       * shape is the evasion the header (lines 7-14) says this script exists to
       * catch: a lone `src/renderer/src/main.ts` edit, in its own commit,
       * reported `clean` at exit 0 -- which is the split-it-out remedy the
       * script itself recommends, turned into a way past the gate.
       *
       * An undeclared core commit now fails, and `--as core-renderer`, a
       * `Module: core-renderer` trailer or a `core/renderer` branch name makes
       * it pass (the next fixture). That is the whole cost.
       */
      name: 'an UNATTRIBUTED core-renderer change: the false negative',
      files: ['src/renderer/src/main.ts', 'src/renderer/src/core/seekbar-host.ts'],
      actor: null,
      expect: 'fail',
      needle: 'RULE C',
      because:
        'MEASURED on the delivered tree: three lines appended to src/renderer/src/main.ts ' +
        'gave `1 under src/` and `check:ownership: clean`, exit 0 -- the exact edit this ' +
        'script was written for'
    },
    {
      name: 'the three-line main.ts edit ALONE, no actor: still the false negative',
      files: ['src/renderer/src/main.ts'],
      actor: null,
      expect: 'fail',
      needle: 'RULE C',
      because: 'rule A needs a feature file co-present, so on its own it saw nothing at all'
    },
    {
      name: 'a file NO feature row is forbidden to touch, unattributed',
      files: ['src/main/features/index.ts'],
      actor: null,
      expect: 'pass',
      because:
        'rule C is deliberately narrow: only files a feature row\'s own mustNotTouch names. ' +
        'It is not a general "declare an actor for everything" rule.'
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

  cases.push(
    {
      name: 'one agent, two rows: --as M35,M36 over a change set spanning both',
      files: [
        'src/main/features/stream-open/index.ts',
        'src/main/features/stream-ytdl/index.ts',
        'src/renderer/src/features/stream-ytdl/stream-ytdl.css'
      ],
      actor: 'M35,M36',
      explicit: true,
      expect: 'pass',
      because:
        'this was the Wave-1 M35+M36 assignment; --as M35 flagged every M36 file and vice ' +
        'versa, so neither run could be read'
    },
    {
      name: 'a multi-row actor still does not get to touch a THIRD row',
      files: ['src/main/features/stream-open/index.ts', 'src/main/features/mediainfo/index.ts'],
      actor: 'M35,M36',
      explicit: true,
      expect: 'fail',
      because: 'a list of actors widens the actor, never the permission'
    },
    {
      /**
       * THE FALSE POSITIVE, as a fixture. `--base main` on the unmodified
       * delivered tree exited 1 with 163 violations, 163 of 163 misblamed,
       * because `detectActor` took the FIRST `Module:` trailer `exec` found and
       * `git log` prints newest first -- so a thirteen-module integration range
       * was attributed to whichever module committed last.
       */
      name: 'an integration range: the trailer union covers every row that changed',
      range: true,
      files: [
        'src/main/features/stream-open/index.ts',
        'src/main/features/mediainfo/index.ts',
        'src/renderer/src/core/feature-host.test.ts'
      ],
      actor: 'M35,M29,core-renderer',
      explicit: false,
      expect: 'pass',
      because:
        'the union of what the range declares is the range actor; taking one trailer out of ' +
        '20 produced 163 red lines on a clean tree'
    },
    {
      name: 'an AUTO-DETECTED integration range still reports a file NOBODY owns',
      range: true,
      files: ['src/main/features/stream-open/index.ts', 'src/main/brand-new-thing.ts'],
      actor: 'M35,M29',
      explicit: false,
      expect: 'fail',
      because:
        'an attribution gap is a note; a hole in the partition is not. check:partition says ' +
        'the same thing from the other side.'
    },
    {
      name: 'an undeclared OWNER in an auto-detected range is a note, not a violation',
      range: true,
      files: ['src/main/features/stream-open/index.ts', 'src/main/core/paths.ts'],
      actor: 'M35,M29',
      explicit: false,
      expect: 'pass',
      note: 'ATTRIBUTION GAP',
      because:
        'which of N declared actors edited core/paths.ts is not recoverable from a diff, and ' +
        'reporting it as a mustNotTouch violation is what red-lit the delivered tree'
    },
    {
      name: 'the same range declared EXPLICITLY keeps the strict rule',
      range: true,
      files: ['src/main/features/stream-open/index.ts', 'src/main/core/paths.ts'],
      actor: 'M35,M29',
      explicit: true,
      expect: 'fail',
      because:
        'a list somebody typed is a claim about the change set; this script does not soften ' +
        'those, exactly as it does not soften an explicit --as typo'
    },
    {
      /**
       * THE SOFT MODE IS FOR A RANGE, NOT FOR AN ACTOR THAT HAPPENS TO NAME
       * SEVERAL ROWS. `integration` used to be `!explicit && rows > 1`, so a
       * DEFAULT-mode run whose actor came from a commit message with six
       * trailers -- which is what HEAD carries on this branch -- got the
       * range's soft treatment and turned an undeclared owner into a note.
       * That is half of why `npm run verify` passed on a live main.ts edit.
       */
      name: 'a multi-row actor WITHOUT a range keeps the strict rule',
      files: ['src/main/features/stream-open/index.ts', 'src/renderer/src/main.ts'],
      actor: 'M35,M29',
      explicit: false,
      range: false,
      expect: 'fail',
      needle: 'RULE B',
      because:
        'no --base was given, so this is one commit or one worktree, not an integration range'
    },
    {
      name: 'the SAME set as a range is an attribution note, as before',
      files: ['src/main/features/stream-open/index.ts', 'src/renderer/src/main.ts'],
      actor: 'M35,M29',
      explicit: false,
      range: true,
      expect: 'pass',
      note: 'ATTRIBUTION GAP'
    },
    {
      name: 'an EXPLICIT --as that names no row is the callers typo',
      files: ['src/main/features/stream-open/index.ts'],
      actor: 'M35,M36,M99zz',
      explicit: true,
      expect: 'fail',
      because: 'silently downgrading a flag someone typed makes the run misread as authoritative'
    },
    {
      name: 'an AUTO-DETECTED actor that names no row must not disarm rule A',
      files: ['src/main/features/video-enhance/index.ts', 'src/renderer/src/main.ts'],
      actor: 'WIP',
      explicit: false,
      expect: 'fail',
      needle: 'RULE A',
      because:
        'MEASURED on the Wave-1 tree: the recovery commit carried a `Module: WIP` trailer, ' +
        'detectActor resolved the actor to WIP, evaluate() pushed one problem about the flag ' +
        'and RETURNED — so a planted src/renderer/src/main.ts edit alongside nine modules ' +
        'files produced `found 1 violation(s)`, that one being about the flag, and ' +
        '`grep -c RULE` on the output was 0'
    }
  )

  const failures = []
  for (const c of cases) {
    const { problems, notes } = evaluate(c.files, c.actor, {
      actorWasExplicit: c.explicit === true,
      range: c.range === true
    })
    // A fixture that expects a failure and gets one for the WRONG REASON is the
    // shape of check this repo keeps finding, so the reason is asserted too.
    if (c.needle && !problems.some((pr) => pr.includes(c.needle))) {
      failures.push(
        `${c.name}
      expected a problem mentioning '${c.needle}', got: ` +
          (problems.join(' | ') || '(none)')
      )
    }
    if (c.note && !notes.some((n) => n.includes(c.note))) {
      failures.push(
        `${c.name}
      expected a NOTE mentioning '${c.note}', got: ` + (notes.join(' | ') || '(none)')
      )
    }
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

/** One evaluated change set, printed and collected. */
function run(label, files, actor) {
  const { problems, notes, attributed } = evaluate(files, actor.name, {
    actorWasExplicit: actor.wasExplicit === true,
    range: actor.range === true
  })
  console.log(
    'check:ownership [%s]: %d changed file(s), %d under src/%s',
    label,
    files.length,
    attributed.length,
    actor.name ? `, actor '${actor.name}' (from ${actor.from})` : ', no actor declared (rule A only)'
  )
  if (actor.note) console.log('  %s', actor.note)
  if (attributed.length > 0) {
    const byOwner = new Map()
    for (const [file, owner] of attributed) {
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), file])
    }
    for (const [owner, list] of [...byOwner].sort()) console.log('  %s: %s', owner, list.join(', '))
  }
  for (const n of notes ?? []) console.log('\ncheck:ownership %s', n)
  return problems
}

const problems = []

if (base !== null) {
  const files = changedFiles(base)
  if (files.length === 0) {
    console.error(
      `check:ownership: the diff ${base}...HEAD is empty, so nothing was checked. That is not a ` +
        `pass. If this is intentional, run without --base.`
    )
    process.exit(1)
  }
  const actor = detectActor(base)
  problems.push(...run(`${base}...HEAD + worktree`, files, { ...actor, range: true }))
} else {
  /**
   * THE DEFAULT MODE IS TWO CHANGE SETS, NOT ONE, and separating them is what
   * makes the fixed gate READABLE as well as correct.
   *
   * The commit at HEAD carries its own `Module:` trailers, and those are a claim
   * about THAT commit. The working tree carries no trailers at all. Evaluating
   * them together forces one of two lies: either HEAD's trailers get borrowed to
   * excuse an uncommitted shared-file edit (the false negative this fixes), or
   * the uncommitted edit's lack of an actor drags HEAD's perfectly legitimate
   * multi-row commit into rule A and prints twenty-five lines about files
   * nobody touched today. This repository has already learned, twice, that a
   * gate whose output is discounted wholesale enforces nothing.
   *
   * So: HEAD is judged against what HEAD declares, the worktree is judged with
   * no actor unless one was typed, and both must pass.
   */
  const committed = (() => {
    try {
      return [
        ...new Set(
          git(['diff', '--name-only', 'HEAD~1', 'HEAD'])
            .split('\n')
            .map((l) => l.trim().replace(/\\/g, '/'))
            .filter(Boolean)
        )
      ]
    } catch {
      return []
    }
  })()
  const dirty = uncommittedFiles()

  if (committed.length > 0) {
    // A commit's own trailers are as explicit as `--as`: somebody typed them
    // into that message about those files.
    const trailers = headTrailers()
    problems.push(
      ...run('HEAD', committed, {
        name: trailers.length > 0 ? trailers.join(',') : null,
        from: trailers.length > 0 ? `${trailers.length} Module: trailer(s) on HEAD` : null,
        wasExplicit: trailers.length > 0,
        range: false
      })
    )
  }
  if (dirty.length > 0) {
    const explicit = flag('as') ?? process.env['RL_MODULE']
    problems.push(
      ...run('worktree', dirty, {
        name: explicit ?? null,
        from: explicit ? (explicit === flag('as') ? '--as' : '$RL_MODULE') : null,
        wasExplicit: Boolean(explicit),
        range: false,
        note: explicit
          ? null
          : `no actor for the uncommitted half. HEAD's \`Module:\` trailers are NOT borrowed: ` +
            `they describe the commit that carries them. Pass --as, or commit with a trailer.`
      })
    )
  }
  if (committed.length === 0 && dirty.length === 0) {
    console.log('check:ownership: nothing changed at HEAD and nothing uncommitted.')
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
