import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * test:no-network — the source half of the guarantee.
 *
 * WHAT THIS WOULD HAVE CAUGHT. Every cold launch of the packaged build fetched
 * `https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic`, Chromium's
 * spellcheck dictionary, because Electron enables the spellchecker by default
 * and Wave 0 added text inputs to the generated settings form. `grep spellcheck
 * src/` returned zero hits and no `webPreferences` block in the repo set it.
 * The request failed `-105` ONLY because of the `MAP * ~NOTFOUND` host-resolver
 * rule; with that one line removed the download completed and the 302 carried
 * the user's public IPv6 back in `mip=`.
 *
 * The runtime proof is `scripts/check-network.mjs`, which drives the PACKAGED
 * app and asserts on Chromium's own `--log-net-log`. That needs a desktop
 * session and a build, so it cannot be the only guard: this one runs in `npm
 * test`, in CI, in under a second, and fails the moment a new window forgets the
 * flag or the session policy loses a layer.
 *
 * These are source assertions on purpose. `core/no-network.ts` imports Electron,
 * so it cannot be imported under `node --test` at all — and a check that runs
 * everywhere beats a check that runs nowhere.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8')

const policy = read('src/main/core/no-network.ts')

function mainSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(path.join(repo, 'src', 'main'))
  return out
}

test('every BrowserWindow in the app disables the spellchecker', () => {
  /**
   * The check is on `webPreferences`, not on `new BrowserWindow`: a window can
   * be constructed with a shared preferences helper, which is what
   * `windows.ts` does. So every `webPreferences` VALUE has to reach a
   * `spellcheck: false`, whether it says so inline or spreads the constant.
   */
  const offenders: string[] = []
  for (const file of mainSources()) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/webPreferences:\s*(\{[\s\S]*?\}|[A-Za-z_$][\w$]*\(\))/g)) {
      const block = m[1] ?? ''
      const ok =
        /spellcheck/.test(block) ||
        /NO_SPELLCHECK/.test(block) ||
        // A call like `rendererPreload()`: the helper itself is checked below.
        /^[A-Za-z_$][\w$]*\(\)$/.test(block.trim())
      if (!ok) {
        offenders.push(`${path.relative(repo, file).replace(/\\/g, '/')}  ${block.slice(0, 60)}…`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a BrowserWindow without spellcheck: false. Chromium then downloads a dictionary from ` +
      `redirector.gvt1.com for the app locale, and the redirect reports the user's public IP ` +
      `back to Google:\n  ${offenders.join('\n  ')}`
  )
})

test('the shared webPreferences helpers carry the flag', () => {
  const windows = read('src/main/core/window/windows.ts')
  assert.match(windows, /const NO_SPELLCHECK = \{ spellcheck: false \}/)
  assert.match(windows, /function rendererPreload\(\)[\s\S]*?NO_SPELLCHECK/)
  // The settings window is the page that actually has the text inputs.
  assert.match(read('src/main/ipc.ts'), /spellcheck: false/)
})

test('the session policy keeps all four of its layers', () => {
  // MEASURED: only the SESSION call actually stops the download. The per-window
  // flag and `--disable-spell-checking` were each measured insufficient on their
  // own, so losing this line silently reopens the leak while the obvious-looking
  // guards stay in place and keep reading as coverage.
  assert.match(policy, /setSpellCheckerEnabled\(false\)/)
  assert.match(policy, /setSpellCheckerLanguages\(\[\]\)/)
  // WPAD: two HOST_RESOLVER_MANAGER_REQUESTs for `wpad` on both HEAD and 0.1.0.
  assert.match(policy, /setProxy\(\{ mode: 'direct' \}\)/)
  assert.match(policy, /'no-proxy-server'/)
  // The blocker that makes the DNS rule defence-in-depth rather than the point.
  assert.match(policy, /webRequest\.onBeforeRequest/)
})

test('the session policy is applied before any feature module runs', () => {
  const main = read('src/main/index.ts')
  const applied = main.indexOf('applySessionPolicy()')
  const modules = main.indexOf('collectFeatureModules()')
  assert.ok(applied > 0, 'src/main/index.ts never calls applySessionPolicy()')
  assert.ok(modules > 0, 'src/main/index.ts never loads feature modules')
  assert.ok(
    applied < modules,
    'applySessionPolicy() must run before the first feature module body does'
  )
})

test('the host allowlist is empty in the shipped source', () => {
  const m = /const ALLOWLIST: readonly AllowedHost\[\] = \[([\s\S]*?)\]/.exec(policy)
  assert.ok(m, 'the ALLOWLIST declaration moved or changed shape')
  const body = (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()
  assert.equal(
    body,
    '',
    `RLPlayer ships reaching ZERO hosts. If a module genuinely needs one, this test is the ` +
      `place the decision becomes visible: change it deliberately, in the same commit as the ` +
      `ALLOWLIST row, and say which module and why.`
  )
})

test('the DNS blackhole is built from the allowlist, not hard-coded', () => {
  // The old rule was a flat `MAP * ~NOTFOUND , EXCLUDE localhost` string with a
  // comment saying it "has to be revisited deliberately" when R05 or M21 land.
  // In practice that means the first module that needs a host deletes the line.
  assert.match(policy, /function hostResolverRules\(\)/)
  assert.match(policy, /ALLOWLIST\.map\(\(a\) => a\.host\)/)
  assert.match(policy, /MAP \* ~NOTFOUND/)
})

test('--print-network-policy reports what is actually enforced', () => {
  assert.match(policy, /export function describeNoNetwork\(\)/)
  for (const fragment of ['setSpellCheckerEnabled', 'onBeforeRequest', 'host allowlist']) {
    assert.ok(
      policy.includes(fragment),
      `describeNoNetwork() must mention '${fragment}': a policy nobody can print is a policy ` +
        `nobody can audit, which is how ten disabled switches read as a solved problem while ` +
        `the real leak was in none of them.`
    )
  }
})

test('the unsafe blackhole override is env-only and loudly named', () => {
  // It exists so `scripts/check-network.mjs --no-blackhole` can prove the leak
  // is GONE rather than merely blackholed. It must never be reachable from a
  // setting, and its name must be alarming in a support log.
  assert.match(policy, /RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE/)
  assert.equal(
    (policy.match(/process\.env\['RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE'\]/g) ?? []).length,
    1,
    'the override must be read in exactly one place'
  )
  for (const file of mainSources()) {
    if (file.endsWith('no-network.ts') || file.endsWith('no-network.test.ts')) continue
    assert.ok(
      !fs.readFileSync(file, 'utf8').includes('RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE'),
      `${path.relative(repo, file)} reads the unsafe override; only core/no-network.ts may`
    )
  }
})
