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
 * @param view 'bare' (default) for identifier rules, 'code' for module paths,
 *   'strings' for "is this exact token a STRING LITERAL here" — which is the
 *   only view in which a regex literal that quotes the token is not a match.
 */
function forbid(files, pattern, message, allow = () => false, view = 'bare') {
  const re = global_(pattern)
  for (const file of files) {
    if (allow(rel(file))) continue
    const v = viewsOf(file)
    const text = view === 'code' ? v.code : view === 'strings' ? v.strings : v.bare
    for (const m of text.matchAll(re)) {
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
  // `/mpv/manager` and `/mpv/client` are on this list because that is where
  // `resolveMpvPath()` lives, and FOUR Wave-1 features need a second mpv (N36
  // thumbnails, L22 probe, C09/C16 encode and cache dump). Without the rule,
  // `import { resolveMpvPath } from '../../mpv/manager'` is the one-line route
  // to an untracked child process, and "no orphan mpv on quit" stops being true
  // the first time one of them uses it. The sanctioned path is
  // `ctx.engine.spawn()`, which registers and reaps.
  '(?:\\/ipc|\\/core\\/menu|\\/core\\/legacy-bridge|\\/core\\/mpv|\\/core\\/registry|\\/core\\/input|\\/core\\/osd|\\/core\\/state|\\/core\\/settings|\\/core\\/no-network|\\/core\\/window|\\/mpv\\/manager|\\/mpv\\/client|preload\\/index|shared\\/keybinds)'
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

/**
 * `'electron'` AS A MODULE SPECIFIER, which is the only thing every spelling of
 * the import has in common — static, dynamic, side-effect, re-export, and
 * however many lines it spans.
 *
 * THREE VERSIONS OF THIS RULE WERE WRITTEN AND TWO WERE MEASURED WRONG, on this
 * tree, before it shipped:
 *
 *   /(?:from|import|require)\s*\(?\s*['"]electron['"]/  over the `code` view
 *     -> FALSE POSITIVE on `mediainfo/module.test.ts:307` and
 *        `wire-parity.test.ts:120`, two REGEX LITERALS that assert this very
 *        rule. `lex.mjs` deliberately keeps regex literals in `code` and `bare`,
 *        because blanking them would hide a rule that greps for one.
 *
 *   /^[ \t]*(?:import|export)\b[^\n]*?['"]electron['"]/m  anchored to one line
 *     -> MISSES `import {\n  app,\n  shell\n} from 'electron'`. A line is not a
 *        unit of syntax; that is this file's own founding lesson.
 *
 * So the test is not a single regex over a single view, it is the INTERSECTION
 * of two: the token has to look like a quoted specifier in `code`, AND the
 * character after the opening quote has to still be there in `strings`. Inside a
 * regex literal the whole span is blank in `strings`, so the two test files pass;
 * inside a comment both views are blank; inside a real import both hold.
 */
const ELECTRON_SPECIFIER_RE = /['"]electron['"]/

/** Indices in `code` where `'electron'` is genuinely a string literal. */
function electronSpecifierHits(v) {
  const out = []
  for (const m of v.code.matchAll(global_(ELECTRON_SPECIFIER_RE))) {
    // `lex` blanks the quote characters in `strings` and keeps the CONTENT, so
    // a real string literal has 'e' at index+1 there and a regex literal does
    // not. This is the whole difference between the rule and its false positive.
    if (v.strings[m.index + 1] === 'e') out.push(m.index)
  }
  return out
}

function forbidElectron(files, message) {
  for (const file of files) {
    const v = viewsOf(file)
    for (const idx of electronSpecifierHits(v)) {
      failures.push(`${rel(file)}:${v.lineAt(idx)}  ${message}\n    ${lineText(v.text, idx)}`)
    }
  }
}

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
  /**
   * ONE exemption, and it is the file whose entire job is to name the host.
   *
   * `profile-cleanup.test.ts` builds a fixture profile containing the exact
   * `Network Persistent State` that 0.1.0 left on real machines, and that record
   * names redirector.gvt1.com. Spelling the host around (`'https://' + 'gvt1'`)
   * to satisfy a grep would make the fixture stop resembling the artefact it
   * asserts about, which is worse than the grep being told the truth. Same
   * reasoning as the `core/no-network.ts` exemption: the file that documents
   * what we do not do has to be able to write it down.
   */
  (relPath) => relPath === 'src/main/core/profile-cleanup.test.ts',
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

/**
 * ELECTRON ITSELF, in a feature module. §3.3 claims `FeatureContext` is "the
 * whole surface a module is allowed to touch", and until now nothing enforced
 * the claim: three of the thirteen landed modules opened with
 * `import { app, clipboard, ClipboardItem, nativeImage, shell } from 'electron'`.
 *
 * The cost is not abstract. That one line makes `index.ts` unloadable by
 * `node --test`, so M22 and M23 each split a `manifest.ts` out of `index.ts`
 * purely to give a test something it could import, and every suite that wants to
 * assert on the real module object had to give up. With `ctx.shell` (§3.3.9),
 * `ctx.image` (§3.3.10), `ctx.dialog` and `ctx.window` in place there is nothing
 * left for a module to reach Electron FOR, so the import is forbidden rather
 * than discouraged, and the next twenty-five modules inherit a loadable
 * `index.ts` by default.
 *
 * `code`, not `bare`: the specifier is a string literal, and prose about
 * Electron in a comment is not an import. Two files quote
 * `import { app } from 'electron'` inside a doc comment today, citing the core
 * file that legitimately does it.
 *
 * TWO patterns rather than the obvious one, and the reason is a false positive
 * this rule produced on its first run. `/(?:from|import|require)\s*\(?\s*
 * ['"]electron['"]/` fired on `mediainfo/module.test.ts:307` and
 * `mediainfo/wire-parity.test.ts:120` — two REGEX LITERALS that assert this very
 * rule. `scripts/lib/lex.mjs` keeps regex literals in both views on purpose
 * (blanking them would hide a rule that greps for one), so the fix is a pattern
 * that describes an import rather than a substring of one: a STATEMENT at the
 * start of a line, or a call to `import(` / `require(`. A test that checks for
 * the string still reads naturally, and a real import in any spelling fails.
 */
forbidElectron(
  featureFiles,
  'no feature module imports electron — ctx.shell (§3.3.9), ctx.image (§3.3.10), ' +
    'ctx.dialog and ctx.window are the whole surface. A direct import also makes the ' +
    'file unloadable by node --test, which is why M22 and M23 each had to split a ' +
    'manifest.ts out just to be testable'
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
  // The route to the mpv BINARY. `resolveMpvPath()` lives in mpv/manager.ts and
  // four Wave-1 features need a second mpv, so this is the import M23 and M27
  // were both about to write.
  ['core-import', `import { resolveMpvPath } from '../../mpv/manager'`],
  ['core-import', `const { MpvClient } = await import('../../mpv/client.ts')`],
  // …and the three the LINE scanner missed, measured resolving at runtime to
  // the same core/mpv/vf-chain singleton.
  ['core-import', `const chain = await import(\n  "../../core/mpv/vf-chain.ts"\n)`],
  ['core-import', `createRequire(import.meta.url)(\n  "../../core/mpv/vf-chain.ts"\n)`],
  ['create-require', `const req = createRequire(import.meta.url)\nconst m = req(p)`],
  ['computed-import', `const bus = await import(BUS_PATH)`],
  ['computed-import', 'const m = await import(`../../core/mpv/${name}.ts`)'],
  ['computed-import', `const m = await import(\n  head + tail\n)`],
  // ELECTRON, in a feature module. Every spelling three landed modules used or
  // could have used, plus the two dynamic ones the anchored rule alone misses.
  ['electron-import', `import { app, shell } from 'electron'`],
  ['electron-import', `import { clipboard, nativeImage } from "electron"`],
  ['electron-import', `import electron from 'electron'`],
  ['electron-import', `import 'electron'`],
  ['electron-import', `export { shell } from 'electron'`],
  ['electron-import', `import {\n  app,\n  shell\n} from 'electron'`],
  ['electron-import', `const { shell } = await import('electron')`],
  ['electron-import', `const { app } = require("electron")`]
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
  ['computed-import', `const re = /https?:\\/\\/x/\nconst mod = await import('./a.ts')`],
  /**
   * THE FALSE POSITIVE THIS RULE ACTUALLY PRODUCED, kept as a fixture.
   *
   * `mediainfo/module.test.ts:307` and `mediainfo/wire-parity.test.ts:120`
   * assert this very rule with a REGEX LITERAL, and `lex.mjs` keeps regex
   * literals in both views on purpose. The obvious pattern
   * (`/(?:from|import|require)\\s*\\(?\\s*['"]electron['"]/`) red-lights both.
   */
  ['electron-import', `const electronImport = /import \\{([^}]*)\\} from 'electron'/.exec(src)`],
  ['electron-import', `assert.equal(/from 'electron'/.test(text), false)`],
  ['electron-import', `// core/shell.ts does \`import { app } from 'electron'\` for us\nconst x = 1`],
  ['electron-import', `const electronImport = /import \\{([^}]*)\\} from 'electron'/.exec(src)`],
  ['electron-import', `import type { ShellService } from '@shared/feature-api'`]
]

function selfTest() {
  const test = (re, view) => (text) => {
    const v = lex(text)
    return global_(re).test(view === 'code' ? v.code : view === 'strings' ? v.strings : v.bare)
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
    'computed-import': test(COMPUTED_IMPORT_RE, 'code'),
    'electron-import': (text) => electronSpecifierHits(lex(text)).length > 0
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
