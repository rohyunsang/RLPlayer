import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCommandShape, isBannedCommand } from './ownership.ts'
// The repo's comment/string-aware lexer, so source rules run on code and not on prose.
import { lex } from '../../../../scripts/lib/lex.mjs'

/**
 * test:secondary-engine — the shared "spawn a second mpv" service (§5.3).
 *
 * WHAT IT EXISTS FOR. Four Wave-1 features need a second `mpv.exe`: N36 (seek
 * thumbnails, M27), L22 (the headless metadata probe, M29), C09 and C16 (clip
 * export and cache dump, M23). The only resolver was `resolveMpvPath()` at
 * `src/main/mpv/manager.ts:51` and `PathService` exposed no binary path at all,
 * so M23 and M27 would each have edited `src/shared/feature-api.ts` AND
 * `src/main/core/paths.ts` — two shared files, in the `mustNotTouch` list of 40
 * of the 55 rows, before either wrote a line of its own feature. §2.6's L30 row
 * already said "**Overlap warning:** build ONE shared engine, not two", and
 * there was nothing to build it with.
 *
 * These are SOURCE assertions because `engine.ts` reaches Electron through
 * `mpv/manager` and cannot be loaded under `node --test`. What has to be true is
 * a shape — one path to the binary, one registry, one reaper, and the reaper on
 * the quit path — and a source check proves that for every file at once on every
 * push, without a desktop session. `scripts/e2e-overlay.mjs` proves the runtime
 * half against the packaged build, where the orphan count is measured by pid.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8')

const engine = read('src/main/core/mpv/engine.ts')

/**
 * Backslash literals, built rather than written.
 *
 * These assertions are ABOUT escaping, so writing them with escapes is how the
 * assertion and the thing it checks drift apart without anyone noticing.
 */
const BS = String.fromCharCode(92)
/** What `'\\.\pipe\' +` looks like in the source of engine.ts. */
const BACKSLASH_PIPE_PREFIX = "'" + BS.repeat(4) + "." + BS.repeat(2) + "pipe" + BS.repeat(2) + "' +"
/** A regex-escaped path separator inside check-forbidden.mjs's CORE_PATHS. */
const ESCAPED = BS.repeat(2)

test('a module reaches a second mpv through the context, not through a core file', () => {
  const api = read('src/shared/feature-api.ts')
  assert.match(api, /export interface EngineService/)
  assert.match(api, /readonly engine: EngineService/, 'ctx.engine is not on FeatureContext')
  assert.match(api, /mpvBinary\(\): string/, 'PathService still exposes no binary path')

  const registry = read('src/main/core/registry.ts')
  assert.match(
    registry,
    /engine: createEngineService\(id\)/,
    'the engine service must be minted per module with its own id baked in, the same way ' +
      'ctx.mpv is — an id is not something a caller supplies'
  )
})

test('every engine is registered, so the quit path can reap one its owner forgot', () => {
  assert.match(engine, /const live = new Set<Live>\(\)/)
  assert.match(engine, /live\.add\(entry\)/)
  assert.match(engine, /export async function disposeEngines\(\)/)

  const index = read('src/main/index.ts')
  const disposeAt = index.indexOf('await disposeEngines()')
  const shutdownAt = index.indexOf('await mpvBus.shutdown()')
  assert.ok(disposeAt > 0, 'the quit path never reaps the secondary engines')
  assert.ok(shutdownAt > 0)
  assert.ok(
    disposeAt < shutdownAt,
    'secondaries must be reaped BEFORE the playing mpv: they are children of this process ' +
      'too, and "no orphan mpv on quit" has to mean all of them'
  )
})

test('there is a synchronous exit reaper, because an async one almost never runs', () => {
  // The measured reason, from MpvManager: `dispose()` was
  // `setTimeout(() => proc.kill(), 300)` inside `before-quit`, and Electron
  // tears the loop down long before it fires. Over ~50 launches that produced 2
  // silent exits with an orphaned mpv and 1 orphan after a graceful quit.
  assert.match(engine, /process\.on\('exit'/)
  assert.match(
    engine,
    /execFileSync\('taskkill'/,
    'the exit reaper must be synchronous; there is no event loop left to await on'
  )
})

test('the IPC pipe name is random per instance, and built by concatenation', () => {
  // Two separate traps in one line. mpv's IPC is documented as "explicitly
  // insecure" and exposes the `run` command, so a guessable pipe name is a local
  // command-execution surface (§2.6 L22 says so outright). And §7.7 trap 9: a
  // template literal folds `\\.\pipe\` and silently eats the backslashes.
  assert.match(engine, /randomUUID/, 'the pipe name is guessable')
  assert.ok(
    engine.includes(BACKSLASH_PIPE_PREFIX),
    'the pipe prefix must be a concatenated literal, never templated (§7.7 trap 9)'
  )
})

test('a secondary never inherits the user config, and never reaches the network', () => {
  // A `vf` in the user's mpv.conf would corrupt every thumbnail; a
  // `screenshot-template` would scatter files. And "zero network at rest" is
  // about every process this app starts, not only the one with a window.
  for (const arg of ['--no-config', '--ytdl=no', '--load-scripts=no', '--terminal=no']) {
    assert.ok(engine.includes(`'${arg}'`), `ENGINE_BASE_ARGS is missing ${arg}`)
  }
})

test('no feature module reaches the binary or the IPC client directly', () => {
  // The rule this replaces did not exist: `check-forbidden.mjs`'s CORE_PATHS
  // list covered `/core/mpv` but not `/mpv/manager`, which is where
  // `resolveMpvPath()` actually lives. `ctx.engine.spawn()` is the sanctioned
  // path precisely because it registers the child; an untracked one is how "no
  // orphan mpv on quit" stops being true.
  const forbidden = read('scripts/check-forbidden.mjs')
  assert.ok(
    forbidden.includes(ESCAPED + "/mpv" + ESCAPED + "/manager"),
    'CORE_PATHS no longer covers mpv/manager, which is where resolveMpvPath() lives'
  )
  assert.ok(
    forbidden.includes(ESCAPED + "/mpv" + ESCAPED + "/client"),
    'CORE_PATHS no longer covers mpv/client'
  )

  // THE RULE RUNS ON CODE, NOT ON PROSE — and this is a check that lied.
  //
  // It was `/resolveMpvPath|mpv\/manager|mpv\/client/.test(text)` against the
  // RAW file. Three Wave-1 modules red-lighted on it and all three hits were
  // comments citing evidence by file:line, which is the documentation discipline
  // this repo asks for everywhere else:
  //
  //   capture-encode/encode-args.ts:79   ` * (\`src/main/mpv/client.ts:36\`), so every job …`
  //   capture-still/manifest.ts:12       ` *   src/main/mpv/manager.ts:5  import { app } …`
  //   subs-style/legacy.ts:15,21         ` *   src/main/mpv/manager.ts:5`
  //
  // Zero were imports. This is the same sign-flipped defect `check-partition.mjs`
  // already fixed once ("a `// plantedC` in a comment is not a use") and that
  // M29 hit again in its own `/(word-boundary)dialog(word-boundary)/` rule. The fix is the one the repo
  // already owns: `scripts/lib/lex.mjs` blanks comments and keeps string
  // CONTENTS, and an import specifier is a string — so the rule keeps every bit
  // of its reach over real code and loses only its reach over English.
  const reach = /resolveMpvPath|mpv\/manager|mpv\/client/

  // NEGATIVE CONTROL, permanent. A detector is worth nothing unless it is shown
  // firing. If `lex()` ever starts blanking string contents too, the rule above
  // would match nothing, the walk would report clean, and this test would become
  // the fifth check in this repo to pass by being blind. These two assertions
  // fail the moment that happens.
  assert.ok(
    reach.test(lex("import { resolveMpvPath } from '../../mpv/manager'").code),
    'the detector no longer fires on a real direct import — it would report clean on anything'
  )
  assert.ok(
    !reach.test(lex('/* see src/main/mpv/manager.ts:5 for why */').code),
    'the detector still fires on prose, which is what made it red-light three clean modules'
  )

  const offenders: string[] = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.ts$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8')
        if (reach.test(lex(text).code)) {
          offenders.push(path.relative(repo, full).split(path.sep).join('/'))
        }
      }
    }
  }
  walk(path.join(repo, 'src', 'main', 'features'))
  walk(path.join(repo, 'src', 'renderer', 'src', 'features'))
  assert.deepEqual(offenders, [], `these feature files reach for mpv directly: ${offenders}`)
})

test('an engine can be given an idle timeout, which §6.3 requires of M27', () => {
  // "the thumbnailer process dies 60 s after the last hover" is an acceptance
  // criterion, and it is a lifecycle all four callers would otherwise implement
  // slightly differently.
  assert.match(engine, /idleTimeoutMs/)
  assert.match(engine, /entry\.idleTimer = setTimeout/)
  assert.match(engine, /idleTimer\.unref\?\.\(\)/, 'an idle timer must not hold the loop open')
})

/**
 * A secondary skips OWNERSHIP, not the shape check and not the bans.
 *
 * `ctx.mpv.command()` runs `assertCommandShape()` and refuses the two banned
 * commands before any other guard reads the array (bus.ts). `SecondaryEngine.
 * command()` ran neither, so on a private engine a boxed primitive walked past
 * every guard the same way it used to on the primary, and a bare
 * `['screenshot-raw']` -- which KILLS mpv over JSON IPC -- reached the pipe.
 * M27 found it as the first module to use `ctx.engine.spawn()` at all.
 *
 * This is a WIRING assertion, not a live one: `engine.ts` reaches `electron`
 * through `resolveMpvPath`, so it cannot be imported under `node --test` and
 * every test in this file is source-level for that reason. What the two
 * payloads actually do to the guards is asserted for real in ownership.test.ts;
 * this asserts that the secondary's command path is on the same side of them.
 */
test('a secondary engine command is shape-checked and ban-checked, like the primary', () => {
  const src = read('src/main/core/mpv/engine.ts')
  const body = src.slice(src.indexOf('async command<T>'), src.indexOf('async getProperty<T>'))
  assert.ok(body.length > 0, 'could not find the SecondaryEngine.command body')
  assert.match(
    body,
    /assertCommandShape\(args\)/,
    'SecondaryEngine.command() must shape-check before it writes to the pipe'
  )
  assert.match(
    body,
    /isBannedCommand\(args\)/,
    'SecondaryEngine.command() must refuse screenshot-raw / apply-profile too'
  )
  assert.ok(
    body.indexOf('assertCommandShape') < body.indexOf('client.command'),
    'the guards have to run BEFORE the write, or they are decoration'
  )
})

test('the two payloads that reached a secondary are rejected by the guards it now calls', () => {
  // The exact shapes M27 measured going straight to the pipe.
  assert.throws(() => assertCommandShape([new String('vf'), 'set', 'hflip']), /shape/)
  assert.equal(isBannedCommand(['screenshot-raw']), true)
  assert.equal(isBannedCommand(['apply-profile', 'fast']), true)
  // And a legitimate thumbnail call is untouched, or the fix breaks M27.
  assert.doesNotThrow(() => assertCommandShape(['loadfile', 'C:/x.mp4', 'replace']))
  assert.equal(isBannedCommand(['screenshot-to-file', 'C:/x.png']), false)
})
