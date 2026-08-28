#!/usr/bin/env node
/**
 * The grep-shaped guarantees, in one place.
 *
 * Three of the spec's §6.2 suites are greps rather than unit tests, because
 * what they assert is the ABSENCE of code:
 *
 *   test:no-hijack      — never write a UserChoice hash, never call the
 *                         undocumented default-app APIs (P33)
 *   test:window-service — no feature module imports windows.ts or constructs a
 *                         BrowserWindow (§3.3.7)
 *   no-updater          — no electron-updater, no autoUpdater, no version ping.
 *                         The absence IS the feature; docs/01 makes it the
 *                         reason the project exists.
 *
 * A GREP THAT DOES NOT MATCH ITS OWN COMMENT IS WORSE THAN NO GREP, because it
 * is read as coverage. Two of these did not, and both were measured:
 *
 *   - the "any network request" rule matched none of `import dns from
 *     "node:dns"`, `await import("node:dns/promises")`, `await
 *     import("node:https")`, `import tls/dgram/http2`, `net.connect({host,
 *     port:443})`, `session.defaultSession.resolveHost(...)` or
 *     `const F = fetch; F(u)`. All seven were probed against the live regex and
 *     all seven PASSED. It also exempted the whole of `src/preload/index.ts`,
 *     which contains no network API at all — a hole opened for nothing.
 *   - the "no module imports a core file" rule was `from\s+['"]…`, i.e. STATIC
 *     imports only. `await import('../../core/mpv/bus.ts')` and
 *     `require('../../core/mpv/bus.ts')` escalated to a full ownership bypass
 *     and this script printed "clean (90 files scanned)" and exited 0.
 *
 * So the rules are declared as data now, and `--self-test` runs every one of
 * them against the exact strings above plus the lines that must NOT trip them.
 * A rule that stops catching its own regression fails the build.
 *
 * Run: npm run check:forbidden       (add --self-test to check the checker)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|js|mjs|html)$/.test(entry.name)) out.push(full)
  }
  return out
}

const srcFiles = walk(path.join(repo, 'src'))
const rel = (f) => path.relative(repo, f).replace(/\\/g, '/')

function forbid(files, pattern, message, allow = () => false) {
  for (const file of files) {
    if (allow(rel(file))) continue
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      // A line that explains why we do NOT do something is not a violation.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (pattern.test(line)) failures.push(`${rel(file)}:${i + 1}  ${message}\n    ${line.trim()}`)
    })
  }
}

// ---------------------------------------------------------------------------
// The network rules, declared as data so `--self-test` can exercise them.
// ---------------------------------------------------------------------------

/**
 * Node modules that can open a socket, in every spelling that reaches one:
 * `import x from`, `import 'x'`, `export … from`, `require('x')` and
 * `import('x')` — the last of which is what the previous version missed.
 *
 * `net` is on the list and is exempted for ONE file: `src/main/mpv/client.ts`
 * connects to mpv's JSON IPC over a Windows NAMED PIPE (`\\.\pipe\…`), which is
 * `net.connect` with a path and never a host. The exemption is per file and per
 * module name rather than a blanket pass, because "this file is allowed sockets"
 * is exactly the shape of exemption that later hides a real one.
 */
const NETWORK_MODULE_RE =
  /(?:^|[^\w$])(?:import|export)\s*(?:[\w$*{},\s]*?\s*from\s*)?['"](?:node:)?(?:dns|dns\/promises|https|http|http2|tls|dgram|net|undici|node-fetch|axios|got|request)['"]|\b(?:require|import)\s*\(\s*['"](?:node:)?(?:dns|dns\/promises|https|http|http2|tls|dgram|net|undici|node-fetch|axios|got|request)['"]\s*\)/

/**
 * Runtime entry points, matched as IDENTIFIERS rather than as calls.
 *
 * `const F = fetch; F(url)` was the probe that proved the old `fetch\s*\(`
 * pattern was cosmetic: the call site does not have to look like a call. So the
 * bare name is enough to fail, and a legitimate use has to be argued for in a
 * review rather than spelled around.
 */
const NETWORK_IDENTIFIER_RE =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|resolveHost|resolveProxy|setProxy)\b|\bnet\.(?:request|connect|createConnection|fetch)\b|\bhttps?\.(?:get|request)\b|\bnew\s+ClientRequest\b/

const NETWORK_MESSAGE =
  'RLPlayer makes no network request while it runs. If a feature genuinely ' +
  'needs one (R05 yt-dlp, S35 subtitle providers), it must be user-initiated, ' +
  'go through that module, and add an ALLOWLIST row in src/main/core/no-network.ts'

/**
 * The narrowest possible exemptions, each with the reason it is safe.
 *
 * `src/preload/index.ts` is NOT here any more. It was exempted from the whole
 * network grep on the theory that "the overlay's own IPC bridge is not the
 * network" — but it contains no network API at all, so the exemption bought
 * nothing and covered the one file whose whole job is to hand capabilities to
 * untrusted page code.
 */
const NETWORK_EXEMPT = {
  // mpv's JSON IPC is a named pipe. The exemption is deliberately keyed on the
  // `{ path: … }` form: a named pipe has no host and no port and cannot reach a
  // network, whereas `net.connect({ host, port })` in this same file would be a
  // real socket and would still fail the check.
  'src/main/mpv/client.ts':
    /^import net from 'node:net'$|net\.(?:connect|createConnection)\(\s*\{\s*path:/,
  // core/no-network IS the policy: it names the APIs it switches off.
  'src/main/core/no-network.ts': /setProxy|resolveHost|setSpellChecker/,
  // …and its test asserts that the policy still names them.
  'src/main/core/no-network.test.ts': /setProxy|resolveHost|setSpellChecker/
}

/** Blanks the contents of string and template literals, keeping the quotes. */
function stripStrings(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function networkAllowed(relPath, line) {
  const rule = NETWORK_EXEMPT[relPath]
  return rule !== undefined && rule.test(line.trim())
}

function forbidNetwork(files) {
  for (const file of files) {
    const r = rel(file)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      // The IDENTIFIER rule runs on the line with string literals blanked out.
      // `'the default-apps fetch'` and `"npm run fetch:mpv"` are prose, and a
      // check that fires on prose is a check people learn to ignore. The MODULE
      // rule keeps the quotes, because there the module name IS the string.
      if (!NETWORK_MODULE_RE.test(line) && !NETWORK_IDENTIFIER_RE.test(stripStrings(line))) return
      if (networkAllowed(r, line)) return
      failures.push(`${r}:${i + 1}  ${NETWORK_MESSAGE}\n    ${line.trim()}`)
    })
  }
}

/**
 * A feature module reaching a shared core file, in EVERY spelling.
 *
 * The path fragments are the same list as before; what changed is that a static
 * `from '…'` is no longer the only way to be caught. `import('…')`,
 * `require('…')` and a bare side-effect `import '…'` all count, and a dynamic
 * import whose specifier is not a string literal is refused outright — there is
 * no legitimate reason for a feature module to compute a module path, and
 * allowing one would reopen the hole by another name.
 */
const CORE_PATHS =
  '(?:\\/ipc|\\/core\\/menu|\\/core\\/legacy-bridge|\\/core\\/mpv|\\/core\\/registry|\\/core\\/input|\\/core\\/osd|\\/core\\/state|\\/core\\/settings|\\/core\\/no-network|\\/core\\/window|preload\\/index|shared\\/keybinds)'
const CORE_IMPORT_RE = new RegExp(
  `(?:from|import|require)\\s*\\(?\\s*['"][^'"]*${CORE_PATHS}[^'"]*['"]`
)
const COMPUTED_IMPORT_RE = /\bimport\s*\(\s*(?!['"])[^)]/

// --- test:no-hijack (P33) --------------------------------------------------
forbid(
  srcFiles,
  /UserChoice|SetAppAsDefaultAll|LaunchAdvancedAssociationUI/,
  'file associations must never be hijacked; send the user to ms-settings:defaultapps'
)

// --- no updater, no telemetry, NO NETWORK ----------------------------------
forbid(
  srcFiles,
  /electron-updater|autoUpdater|checkForUpdatesAndNotify/,
  'there is no auto-update in this app, and the absence is the product'
)
forbidNetwork(srcFiles)
forbid(
  srcFiles,
  // `http://www.w3.org/2000/svg` is an XML NAMESPACE, not an address: nothing
  // dereferences it, and createElementNS needs it verbatim.
  /https?:\/\/(?!www\.w3\.org\/|github\.com\/rohyunsang)/,
  'no remote origin in shipped code; the releases link is the one exception ' +
    'and it is opened in the user’s browser, never fetched'
)

// `eval` and `new Function` are the one gap that string-stripping opens: a
// network call hidden in a string and executed later. Neither has ever had a use
// in this codebase, so forbidding them costs nothing and closes it.
forbid(
  srcFiles,
  /\beval\s*\(|\bnew\s+Function\s*\(/,
  'no eval and no Function constructor: the network grep blanks string literals, ' +
    'so a string that is later executed would be the one way past it'
)

// --- test:window-service (§3.3.7) ------------------------------------------
const featureFiles = srcFiles.filter((f) => /\/(main|renderer\/src)\/features\//.test(rel(f)))
forbid(
  featureFiles,
  /(?:from|import|require)\s*\(?\s*['"][^'"]*window\/windows['"]/,
  'no feature module imports windows.ts — use ctx.window (§3.3.7)'
)
forbid(featureFiles, /new BrowserWindow/, 'no feature module constructs a BrowserWindow')

// --- the other forbidden shared files (§3.0) -------------------------------
forbid(
  featureFiles,
  CORE_IMPORT_RE,
  'no feature module imports a shared core file — everything arrives on FeatureContext. ' +
    'This now matches dynamic import() and require() too: `await import("../../core/mpv/bus.ts")` ' +
    'was a full ownership bypass that the static-only regex printed "clean" for'
)
forbid(
  featureFiles,
  COMPUTED_IMPORT_RE,
  'a feature module may not compute a module specifier. A computed import is how a ' +
    'path-fragment grep gets walked around, and no module has a reason to need one'
)

// The renderer half has the same rule: a module's UI reaches the overlay
// through ctx.panel() / ctx.statsSection() / ctx.seekbarLayer(), never by
// importing the host.
const rendererFeatureFiles = srcFiles.filter((f) => /\/renderer\/src\/features\//.test(rel(f)))
forbid(
  rendererFeatureFiles,
  /(?:from|import|require)\s*\(?\s*['"][^'"]*\/core\/(?:index|feature-host|panel-host|stats-host|seekbar-host|settings-form)/,
  'no renderer module imports the renderer core — the contribution points on ' +
    'RendererFeatureContext are the whole API'
)
forbid(
  rendererFeatureFiles,
  /getElementById\(\s*['"](?:stage|chrome|controls|titlebar|seek|seekLayers|osd|toasts|panelRoot|stats|playlistBtn|mediaTitle)['"]/,
  "no renderer module reaches into the overlay's own chrome by id; contribute a panel"
)

// --- one module never imports another (§3.0) -------------------------------
for (const file of featureFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const own = rel(file).split('/features/')[1]?.split('/')[0]
  for (const m of text.matchAll(
    /(?:from|import|require)\s*\(?\s*['"]([^'"]*\/features\/([a-z0-9-]+)\/[^'"]*)['"]/g
  )) {
    if (m[2] !== own) {
      failures.push(
        `${rel(file)}  module '${own}' imports module '${m[2]}' directly. ` +
          `Cross-module calls go through ctx.commands.invoke() (§3.7.3).`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// --self-test: the regressions these rules exist for, as fixtures.
// ---------------------------------------------------------------------------

const MUST_CATCH = [
  // Every one of these was probed against the PREVIOUS regex and passed it.
  ['network', `import dns from "node:dns"`],
  ['network', `const { lookup } = await import("node:dns/promises")`],
  ['network', `const https = await import("node:https")`],
  ['network', `import tls from "node:tls"`],
  ['network', `import dgram from "node:dgram"`],
  ['network', `import http2 from "node:http2"`],
  ['network', `const s = net.connect({ host: "example.com", port: 443 })`],
  ['network', `await session.defaultSession.resolveHost("example.com")`],
  ['network', `const F = fetch; F(u)`],
  ['network', `const r = await fetch(url)`],
  ['network', `new WebSocket("wss://example.com")`],
  ['network', `navigator.sendBeacon("/x", d)`],
  // The ownership escalations the static-import regex missed.
  ['core-import', `const { mpvBus } = await import("../../core/mpv/bus.ts")`],
  ['core-import', `const bus = require("../../core/mpv/bus.ts")`],
  ['core-import', `import { mpvBus } from '../../core/mpv/bus.ts'`],
  ['core-import', `import "../../core/registry.ts"`],
  ['core-import', `export { x } from '../../core/settings/store.ts'`],
  ['computed-import', `const bus = await import(BUS_PATH)`],
  ['computed-import', 'const m = await import(`../../core/mpv/${name}.ts`)']
]

const MUST_NOT_CATCH = [
  ['network', `const prefetch = settings.get('prefetch-playlist')`],
  // Prose ABOUT the thing we do not do is not the thing we do not do.
  ['network', `['disable-default-apps', 'the default-apps fetch'],`],
  ['network', `'core.engineHint': 'Run "npm run fetch:mpv" to download mpv.',`],
  ['network', 'const m = `mpv.exe not found. Run "npm run fetch:mpv".`'],
  ['network', `ctx.ipc.handle('audio-devices:list', async () => [])`],
  ['network', `import type { FeatureModule } from '@shared/feature-api'`],
  ['core-import', `import type { Chapter } from '../../../shared/types.ts'`],
  ['core-import', `import './playlist.css'`],
  ['computed-import', `const mod = await import('./thing.ts')`]
]

function selfTest() {
  const rules = {
    network: (line) =>
      NETWORK_MODULE_RE.test(line) || NETWORK_IDENTIFIER_RE.test(stripStrings(line)),
    'core-import': (line) => CORE_IMPORT_RE.test(line),
    'computed-import': (line) => COMPUTED_IMPORT_RE.test(line)
  }
  const bad = []
  for (const [rule, line] of MUST_CATCH) {
    if (!rules[rule](line)) bad.push(`rule '${rule}' FAILED TO CATCH:  ${line}`)
  }
  for (const [rule, line] of MUST_NOT_CATCH) {
    if (rules[rule](line)) bad.push(`rule '${rule}' false positive on:  ${line}`)
  }
  if (bad.length > 0) {
    console.error('check:forbidden --self-test found %d broken rule(s):\n', bad.length)
    for (const b of bad) console.error('  ' + b)
    process.exit(1)
  }
  console.log(
    'check:forbidden --self-test: %d regressions caught, %d clean lines untouched',
    MUST_CATCH.length,
    MUST_NOT_CATCH.length
  )
}

if (process.argv.includes('--self-test')) selfTest()

if (failures.length > 0) {
  console.error('check:forbidden found %d violation(s):\n', failures.length)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('check:forbidden: clean (%d files scanned)', srcFiles.length)
