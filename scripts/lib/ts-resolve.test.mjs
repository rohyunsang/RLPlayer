import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALIASES, aliasTargets, resolveSpecifier } from './ts-resolve.mjs'

/**
 * Two jobs.
 *
 * 1. THE HOOK IS WHAT MAKES `npm test` ABLE TO LOAD `src/main` AT ALL, and this
 *    file proves it by running the same fixture twice — once without the hook,
 *    where it must fail with ERR_MODULE_NOT_FOUND, and once with it, where it
 *    must pass. A test that only exercised the hook would go on passing if
 *    somebody dropped `--import` from the test script, which is the same class
 *    of vacuous pass as an assertion satisfied by the bug it guards.
 *
 * 2. THE ALIAS EXISTS IN FOUR PLACES and they must not drift: this hook,
 *    `tsconfig.node.json`, `tsconfig.web.json` and `electron.vite.config.ts`.
 *    Three of those decide typecheck and production; this one decides tests.
 *    A test-only alias that disagreed with the bundler's would make the suite
 *    lie about what the app resolves.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
/**
 * A file: URL, not a Windows path. `--import C:\...\hook.mjs` is
 * ERR_UNSUPPORTED_ESM_URL_SCHEME: node reads `C:` as the URL scheme. The
 * package.json scripts get away with `./scripts/lib/...` because they run from
 * the repo root; a test spawning an absolute path does not.
 */
const HOOK = pathToFileURL(path.join(REPO, 'scripts/lib/ts-resolve-register.mjs')).href

function readJsonc(rel) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8')
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
}

test('the alias map agrees with both tsconfigs and the vite config', () => {
  const mine = aliasTargets()
  assert.deepEqual(Object.keys(mine), ['@shared/'], 'one alias, and only one')
  assert.ok(mine['@shared/'].endsWith('/src/shared/'), mine['@shared/'])

  for (const cfg of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const paths = readJsonc(cfg).compilerOptions.paths
    assert.deepEqual(
      paths,
      { '@shared/*': ['src/shared/*'] },
      `${cfg} declares a different alias map than scripts/lib/ts-resolve.mjs`
    )
  }

  const vite = fs.readFileSync(path.join(REPO, 'electron.vite.config.ts'), 'utf8')
  // The single alias object the three build targets share.
  assert.match(
    vite,
    /const shared = \{\s*'@shared':\s*resolve\(__dirname,\s*'src\/shared'\)\s*\}/,
    'electron.vite.config.ts no longer declares exactly the @shared -> src/shared alias'
  )
  // …and all three targets must still use it, or main resolves differently
  // from the renderer in production while tests resolve both the same way.
  assert.equal(
    (vite.match(/resolve: \{ alias: shared \}/g) ?? []).length,
    3,
    'main, preload and renderer must all take the shared alias object'
  )
})

test('every `node --test` script installs the hook', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const offenders = Object.entries(pkg.scripts)
    .filter(([, v]) => v.includes('--test'))
    .filter(([, v]) => !v.includes('scripts/lib/ts-resolve-register.mjs'))
    .map(([k]) => k)
  assert.deepEqual(
    offenders,
    [],
    `these scripts run node --test without the resolve hook, so they cannot load ` +
      `most of src/main: ${offenders.join(', ')}`
  )
})

test('resolveSpecifier: the alias, extensions and index files — and nothing else', () => {
  // The alias, spelled both ways a module author spells it.
  assert.ok(resolveSpecifier('@shared/media-types', undefined).endsWith('/src/shared/media-types.ts'))
  assert.ok(
    resolveSpecifier('@shared/features/audio-eq/wire.ts', undefined).endsWith(
      '/src/shared/features/audio-eq/wire.ts'
    )
  )
  // A relative specifier that Node already resolves is left alone.
  const here = new URL('./ts-resolve.test.mjs', import.meta.url).href
  assert.equal(resolveSpecifier('./ts-resolve.mjs', here), null)
  // A bare package specifier is never touched.
  assert.equal(resolveSpecifier('node:fs', here), null)
  assert.equal(resolveSpecifier('electron', here), null)
  // A genuine typo is deferred to Node, not invented.
  assert.equal(resolveSpecifier('./no-such-module-at-all', here), null)
  assert.equal(resolveSpecifier('@shared/no-such-file', undefined), null)
})

test('the hook is load-bearing: the same fixture fails without it and passes with it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-alias-'))
  try {
    // `./target` — no extension. Legal under moduleResolution: bundler, which is
    // what both tsconfigs use; rejected by Node's own resolver.
    fs.writeFileSync(path.join(dir, 'target.ts'), 'export const answer: number = 42\n')
    fs.writeFileSync(
      path.join(dir, 'probe.test.ts'),
      [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { answer } from './target'",
        "import { SUB_EXTENSIONS } from '@shared/media-types'",
        "test('both bundler-shaped specifiers resolve', () => {",
        '  assert.equal(answer, 42)',
        '  assert.ok(SUB_EXTENSIONS.length > 0)',
        '})',
        ''
      ].join('\n')
    )
    const probe = path.join(dir, 'probe.test.ts')

    /**
     * `NODE_TEST_CONTEXT` MUST BE STRIPPED, and getting this wrong is how this
     * very test lied on its first run. Node sets it in every test-runner child;
     * a grandchild that inherits it switches to the v8-serialised child protocol,
     * writes NOTHING to stdout and exits 0 — so the "must fail without the hook"
     * run came back green with empty output, and the check that exists to prove
     * the hook is load-bearing was satisfied by a process that ran no tests at
     * all. Hence the assertion on stdout as well as the exit code, below.
     */
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_OPTIONS

    const run = (args) => {
      try {
        return {
          code: 0,
          out: execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', env })
        }
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    }

    const without = run(['--test', probe])
    assert.notEqual(without.code, 0, 'without the hook this fixture must FAIL')
    assert.match(
      without.out,
      /ERR_MODULE_NOT_FOUND/,
      'without the hook the failure must be the resolution failure, not something else'
    )
    // A run that executed nothing also "does not resolve", so insist the child
    // really got as far as reporting a test file.
    assert.match(without.out, /fail 1/, 'the failing run must have actually run')

    const withHook = run(['--import', HOOK, '--test', probe])
    assert.equal(withHook.code, 0, `with the hook it must pass:\n${withHook.out}`)
    assert.match(withHook.out, /pass 1/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ALIASES is frozen, so a test cannot quietly widen resolution for the rest', () => {
  assert.ok(Object.isFrozen(ALIASES))
})
