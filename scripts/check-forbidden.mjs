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
 * AND THEN A THIRD, which is why this file no longer scans lines. Every rule ran
 * against `text.split(/\r?\n/)`, one line at a time, so a specifier on a
 * different line from its `import(` matched nothing. Three spellings were
 * measured resolving at runtime to the same `core/mpv/vf-chain` singleton while
 * this script printed "clean":
 *
 *     await import(
 *       '../../core/mpv/vf-chain.ts'
 *     )
 *     createRequire(import.meta.url)('../../core/mpv/vf-chain.ts')
 *     await import(
 *       head + tail
 *     )
 *
 * A line is not a unit of syntax. `scripts/lib/lex.mjs` blanks comments and (in
 * the `bare` view) string contents across the WHOLE file, preserving offsets so
 * a match still reports a line, and every rule below is now a whole-file regex.
 *
 * So the rules are declared as data, and `--self-test` runs every one of them
 * against the exact sources above — multi-line included — plus the ones that
 * must NOT trip them. A rule that stops catching its own regression fails the
 * build.
 *
 * Run: npm run check:forbidden       (add --self-test to check the checker)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lex } from './lib/lex.mjs'

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

// ---------------------------------------------------------------------------
// The lexed views, and the matcher that runs a rule over one of them.
// ---------------------------------------------------------------------------

/**
 * `code` keeps string CONTENTS (an import specifier is a string, so the
 * module-path rules need it) and blanks comments. `bare` blanks both, so the
 * identifier rules see code only: `'the default-apps fetch'` and
 * `"npm run fetch:mpv"` are prose, and a check that fires on prose is a check
 * people learn to ignore.
 */
const lexed = new Map()
function viewsOf(file) {
  let v = lexed.get(file)
  if (!v) {
    const text = fs.readFileSync(file, 'utf8')
    v = { text, ...lex(text) }
    lexed.set(file, v)
  }
  return v
}

/** The source line a match landed on, trimmed, for the failure message. */
function lineText(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  let end = text.indexOf('\n', index)
  if (end < 0) end = text.length
  return text.slice(start, end).trim()
}

const global_ = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')

/**
 * @param view 'bare' (default) for identifier rules, 'code' for module paths.
 */
function forbid(files, pattern, message, allow = () => false, view = 'bare') {
  const re = global_(pattern)
  for (const file of files) {
    if (allow(rel(file))) continue
    const v = viewsOf(file)
    for (const m of (view === 'code' ? v.code : v.bare).matchAll(re)) {
      failures.push(
        `${rel(file)}:${v.lineAt(m.index)}  ${message}\n    ${lineText(v.text, m.index)}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// The network rules, declared as data so `--self-test` can exercise them.
// ---------------------------------------------------------------------------

/**
 * Node modules that can open a socket, in every spelling that reaches one:
 * `import x from`, `import 'x'`, `export … from`, `require('x')` and
 * `import('x')` — the last of which is what the previous version missed. The
 * `\s*` runs are newline-tolerant now, because `import(\n  'node:https'\n)` is
 * the same escalation with a line break in it.
 *
 * `net` is on the list and is exempted for ONE file: `src/main/mpv/client.ts`
 * connects to mpv's JSON IPC over a Windows NAMED PIPE (`\\.\pipe\…`), which is
 * `net.connect` with a path and never a host. The exemption is per file and per
 * module name rather than a blanket pass, because "this file is allowed sockets"
 * is exactly the shape of exemption that later hides a real one.
 */
const NET_MODULES =
  '(?:node:)?(?:dns|dns\\/promises|https|http|http2|tls|dgram|net|undici|node-fetch|axios|got|request)'
const NETWORK_MODULE_RE = new RegExp(
  `(?:^|[^\\w$])(?:import|export)\\s*(?:[\\w$*{},\\s]*?\\s*from\\s*)?['"]${NET_MODULES}['"]` +
    `|\\b(?:require|import)\\s*\\(\\s*['"]${NET_MODULES}['"]\\s*\\)`
)

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

function networkAllowed(relPath, line) {
  const rule = NETWORK_EXEMPT[relPath]
  return rule !== undefined && rule.test(line.trim())
}

/**
 * The network rule needs both views at once: the MODULE half reads specifiers
 * (strings), the IDENTIFIER half must not read them. So it runs each half over
 * its own view and merges by offset.
 */
function forbidNetwork(files) {
  const moduleRe = global_(NETWORK_MODULE_RE)
  const identRe = global_(NETWORK_IDENTIFIER_RE)
  for (const file of files) {
    const r = rel(file)
    const v = viewsOf(file)
    const hits = [
      ...[...v.code.matchAll(moduleRe)].map((m) => m.index),
      ...[...v.bare.matchAll(identRe)].map((m) => m.index)
    ].sort((a, b) => a - b)
    const seen = new Set()
    for (const idx of hits) {
      const lineNo = v.lineAt(idx)
      if (seen.has(lineNo)) continue
      seen.add(lineNo)
      const line = lineText(v.text, idx)
      if (networkAllowed(r, line)) continue
      failures.push(`${r}:${lineNo}  ${NETWORK_MESSAGE}\n    ${line}`)
    }
  }
}

/**
 * A feature module reaching a shared core file, in EVERY spelling.
 *
 * The path fragments are the same list as before; what changed is that a static
 * `from '…'` is no longer the only way to be caught. `import('…')`,
 * `require('…')`, `createRequire(…)(…)` and a bare side-effect `import '…'` all
 * count — across line breaks, which is what the line scanner could not do — and
 * a dynamic import whose specifier is not a string literal is refused outright.
 * There is no legitimate reason for a feature module to compute a module path,
 * and allowing one would reopen the hole by another name.
 */
const CORE_PATHS =
  '(?:\\/ipc|\\/core\\/menu|\\/core\\/legacy-bridge|\\/core\\/mpv|\\/core\\/registry|\\/core\\/input|\\/core\\/osd|\\/core\\/state|\\/core\\/settings|\\/core\\/no-network|\\/core\\/window|preload\\/index|shared\\/keybinds)'
const CORE_IMPORT_RE = new RegExp(
  `(?:from|import|require|createRequire\\s*\\([^)]*\\))\\s*\\(?\\s*['"][^'"]*${CORE_PATHS}[^'"]*['"]`
)
/**
 * A dynamic import whose specifier is not a string LITERAL.
 *
 * The lookahead matters more than it looks. The obvious spelling —
 * `import\s*\(\s*(?!['"])[^)]` — reads correctly and is wrong across line
 * breaks: `\s*` backtracks to zero width, the negative lookahead then passes on
 * the newline, and `await import(\n  './thing.ts'\n)` — a perfectly ordinary
 * literal import — is reported. Anchoring the whitespace INSIDE the lookahead
 * removes the backtrack: `\s*` must be followed by a non-space that is not a
 * quote, and there is no shorter match to fall back to.
 */
const COMPUTED_IMPORT_RE = /\bimport\s*\((?=\s*[^\s'"])/

/**
 * `createRequire` at all, in a feature module.
 *
 * `createRequire(import.meta.url)('../../core/mpv/vf-chain.ts')` was measured
 * resolving to the live singleton. CORE_IMPORT_RE catches that exact spelling,
 * but `const req = createRequire(import.meta.url)` followed by `req(p)` twenty
 * lines later is the same escalation with the two halves separated, and no
 * lexical rule can follow the binding. A feature module has never needed
 * `createRequire` and never will: everything it may reach arrives on
 * `FeatureContext`. So the FUNCTION is forbidden, not one of its call shapes.
 */
const CREATE_REQUIRE_RE = /\bcreateRequire\b/

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
    'and it is opened in the user’s browser, never fetched',
  () => false,
  'code'
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
  'no feature module imports windows.ts — use ctx.window (§3.3.7)',
  () => false,
  'code'
)
forbid(featureFiles, /new BrowserWindow/, 'no feature module constructs a BrowserWindow')

// --- the other forbidden shared files (§3.0) -------------------------------
forbid(
  featureFiles,
  CORE_IMPORT_RE,
  'no feature module imports a shared core file — everything arrives on FeatureContext. ' +
    'This now matches dynamic import(), require() and createRequire() too, ACROSS LINE BREAKS: ' +
    '`await import(\\n  "../../core/mpv/vf-chain.ts"\\n)` was a full ownership bypass that both ' +
    'the static-only regex and the line-at-a-time scanner printed "clean" for',
  () => false,
  'code'
)
forbid(
  featureFiles,
  COMPUTED_IMPORT_RE,
  'a feature module may not compute a module specifier. A computed import is how a ' +
    'path-fragment grep gets walked around, and no module has a reason to need one',
  () => false,
  'code'
)
forbid(
  featureFiles,
  CREATE_REQUIRE_RE,
  'no feature module calls createRequire(). It is a second module loader that no ' +
    'specifier rule can follow once the returned function is bound to a name, and a ' +
    'feature module has no use for one: everything it may reach arrives on FeatureContext'
)

// The renderer half has the same rule: a module's UI reaches the overlay
// through ctx.panel() / ctx.statsSection() / ctx.seekbarLayer(), never by
// importing the host.
const rendererFeatureFiles = srcFiles.filter((f) => /\/renderer\/src\/features\//.test(rel(f)))
forbid(
  rendererFeatureFiles,
  /(?:from|import|require)\s*\(?\s*['"][^'"]*\/core\/(?:index|feature-host|panel-host|stats-host|seekbar-host|settings-form)/,
  'no renderer module imports the renderer core — the contribution points on ' +
    'RendererFeatureContext are the whole API',
  () => false,
  'code'
)
forbid(
  rendererFeatureFiles,
  /getElementById\(\s*['"](?:stage|chrome|controls|titlebar|seek|seekLayers|osd|toasts|panelRoot|stats|transportExtras|playlistBtn|mediaTitle)['"]/,
  "no renderer module reaches into the overlay's own chrome by id; contribute a panel",
  () => false,
  'code'
)

// --- one module never imports another (§3.0) -------------------------------
for (const file of featureFiles) {
  const v = viewsOf(file)
  const own = rel(file).split('/features/')[1]?.split('/')[0]
  for (const m of v.code.matchAll(
    /(?:from|import|require)\s*\(?\s*['"]([^'"]*\/features\/([a-z0-9-]+)\/[^'"]*)['"]/g
  )) {
    if (m[2] !== own) {
      failures.push(
        `${rel(file)}:${v.lineAt(m.index)}  module '${own}' imports module '${m[2]}' directly. ` +
          `Cross-module calls go through ctx.commands.invoke() (§3.7.3).`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// --self-test: the regressions these rules exist for, as fixtures.
//
// Fixtures are whole FILES now, not lines, because three of the escalations
// below span lines and a line-shaped fixture cannot express them. Each one is
// run through the same `lex()` the real check uses.
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
  // …and the multi-line spellings the LINE scanner could not see.
  ['network', `const https = await import(\n  "node:https"\n)`],
  ['network', `import {\n  connect\n} from "node:tls"`],
  // The ownership escalations the static-import regex missed.
  ['core-import', `const { mpvBus } = await import("../../core/mpv/bus.ts")`],
  ['core-import', `const bus = require("../../core/mpv/bus.ts")`],
  ['core-import', `import { mpvBus } from '../../core/mpv/bus.ts'`],
  ['core-import', `import "../../core/registry.ts"`],
  ['core-import', `export { x } from '../../core/settings/store.ts'`],
  // …and the three the LINE scanner missed, measured resolving at runtime to
  // the same core/mpv/vf-chain singleton.
  ['core-import', `const chain = await import(\n  "../../core/mpv/vf-chain.ts"\n)`],
  ['core-import', `createRequire(import.meta.url)(\n  "../../core/mpv/vf-chain.ts"\n)`],
  ['create-require', `const req = createRequire(import.meta.url)\nconst m = req(p)`],
  ['computed-import', `const bus = await import(BUS_PATH)`],
  ['computed-import', 'const m = await import(`../../core/mpv/${name}.ts`)'],
  ['computed-import', `const m = await import(\n  head + tail\n)`]
]

const MUST_NOT_CATCH = [
  ['network', `const prefetch = settings.get('prefetch-playlist')`],
  // Prose ABOUT the thing we do not do is not the thing we do not do.
  ['network', `['disable-default-apps', 'the default-apps fetch'],`],
  ['network', `'core.engineHint': 'Run "npm run fetch:mpv" to download mpv.',`],
  ['network', 'const m = `mpv.exe not found. Run "npm run fetch:mpv".`'],
  ['network', `ctx.ipc.handle('audio-devices:list', async () => [])`],
  ['network', `import type { FeatureModule } from '@shared/feature-api'`],
  // A COMMENT is prose too, wherever on the line it sits. The old scanner only
  // skipped a line whose first characters were a comment opener, so a trailing
  // comment's code half was invisible while its prose half was scanned.
  ['network', `const x = 1 // we never fetch() anything`],
  ['network', `/*\n * We do not import("node:https") here.\n */\nconst x = 1`],
  ['core-import', `import type { Chapter } from '../../../shared/types.ts'`],
  ['core-import', `import './playlist.css'`],
  ['core-import', `// see ../../core/mpv/bus.ts for why\nconst x = 1`],
  ['create-require', `const s = 'createRequire is not used here'`],
  ['computed-import', `const mod = await import('./thing.ts')`],
  // The multi-line LITERAL import: legal, and the reason the lookahead above is
  // anchored. The obvious spelling of that rule reports this one.
  ['computed-import', `const mod = await import(\n  './thing.ts'\n)`],
  ['computed-import', `const mod = await import(\n  "./thing.ts"\n)`],
  // A regex literal containing a slash must not open a phantom comment.
  ['computed-import', `const re = /https?:\\/\\/x/\nconst mod = await import('./a.ts')`]
]

function selfTest() {
  const test = (re, view) => (text) => {
    const v = lex(text)
    return global_(re).test(view === 'code' ? v.code : v.bare)
  }
  const network = (text) => {
    const v = lex(text)
    return (
      global_(NETWORK_MODULE_RE).test(v.code) || global_(NETWORK_IDENTIFIER_RE).test(v.bare)
    )
  }
  const rules = {
    network,
    'core-import': test(CORE_IMPORT_RE, 'code'),
    'create-require': test(CREATE_REQUIRE_RE, 'bare'),
    'computed-import': test(COMPUTED_IMPORT_RE, 'code')
  }
  const bad = []
  const show = (s) => s.replace(/\n/g, '\\n')
  for (const [rule, text] of MUST_CATCH) {
    if (!rules[rule](text)) bad.push(`rule '${rule}' FAILED TO CATCH:  ${show(text)}`)
  }
  for (const [rule, text] of MUST_NOT_CATCH) {
    if (rules[rule](text)) bad.push(`rule '${rule}' false positive on:  ${show(text)}`)
  }
  if (bad.length > 0) {
    console.error('check:forbidden --self-test found %d broken rule(s):\n', bad.length)
    for (const b of bad) console.error('  ' + b)
    process.exit(1)
  }
  const multiline = MUST_CATCH.filter(([, t]) => t.includes('\n')).length
  console.log(
    'check:forbidden --self-test: %d regressions caught (%d of them multi-line), ' +
      '%d clean sources untouched',
    MUST_CATCH.length,
    multiline,
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
