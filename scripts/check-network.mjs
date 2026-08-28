#!/usr/bin/env node
/**
 * "RLPlayer makes no network request" — measured from Chromium's own log.
 *
 * WHY THIS FILE REPLACED `watch-network.mjs`. The old script was a structural
 * false negative and it reported "5 launches x 30 s, 0 outbound" on runs where
 * a network fetch demonstrably completed. Three independent reasons, each
 * sufficient on its own:
 *
 *   1. It launched `node_modules/electron/dist/electron.exe` — the DEV build.
 *      The regression it was supposed to catch only exists in the PACKAGED
 *      build (Chromium's spellchecker downloads a dictionary for the locale of
 *      the text inputs the packaged settings form renders). Dev produced a
 *      netlog with zero network events; packaged produced a completed download.
 *   2. It slept 1500 ms before its first sample and then polled once a second
 *      with `Get-CimInstance` + `Get-NetTCPConnection`. The episode it was
 *      hunting spans t+491 ms to t+881 ms. A 154 ms `netstat` loop started at
 *      t=0 already reported 0 outbound on the very launch whose netlog shows
 *      the finished download. Sampling a 390 ms event at 1 Hz is not evidence.
 *   3. A socket poll can only see a connection that was ESTABLISHED. A request
 *      that is attempted and fails — which is what the DNS blackhole turns
 *      every leak into — is invisible to it. That is precisely backwards: an
 *      ATTEMPT is the bug; the failure is only the seatbelt.
 *
 * So this asserts on Chromium's `--log-net-log` instead, which records the
 * intent (URL_REQUEST_START_JOB, HOST_RESOLVER_MANAGER_REQUEST) whether or not
 * the request ever reaches a socket. It runs the PACKAGED app, with a fresh
 * profile per launch, and fails loudly on the first non-local URL or hostname.
 *
 * THREE THINGS THIS FILE GOT WRONG, all measured, all fixed below.
 *
 *   A. IT PASSED NETLOGS THAT RECORDED NOTHING. `parseNetlog` threw only when
 *      the string `"events"` was absent, so a header-only ~46,688-byte file
 *      yielded `eventCount = 0, violations = 0` -- which is exactly the shape of
 *      a clean run. 7 of 36 observed netlogs were header-only and 2 of those
 *      exited cleanly, including the decisive `--no-blackhole` step at
 *      ci.yml:146. The only liveness gate was `/\[no-network\]/`, and
 *      `src/main/index.ts` prints that line at MODULE SCOPE, before
 *      `app.whenReady()` -- so it proved the process started and nothing else.
 *      A clean run now has to prove it happened: a minimum event count, the
 *      `[ready]` line the app prints AFTER its windows are shown, and the
 *      `[quit]` line only the graceful shutdown path prints.
 *
 *   B. IT NEVER OPENED THE SETTINGS WINDOW. That is the app's only page with
 *      text inputs, and it is the exact surface the gvt1.com spellchecker leak
 *      lived on -- so the check written to prevent that defect never exercised
 *      the page that caused it. Every launch opens it now.
 *
 *   C. ITS ORPHAN COUNT WAS MACHINE-WIDE. `mpvCount()` was
 *      `tasklist /FI "IMAGENAME eq mpv.exe"` with no attribution, so
 *      `npm run check:network -- --launches=6 --seconds=10` -- the exact CI
 *      invocation -- reported "FAILED: 4 orphaned mpv.exe" on an unchanged tree.
 *      All four belonged to a different checkout. It failed 3 of 4 runs on
 *      identical bits, and line 305 made that a hard red. A gate that
 *      red-lights clean trees is disabled by the first person it blocks.
 *      `scripts/lib/mpv-procs.mjs` tracks the pids the app actually spawned.
 *
 * Run:  node scripts/check-network.mjs [--launches=3] [--seconds=12] [--build]
 *       node scripts/check-network.mjs --no-blackhole   (see below)
 *
 * `--no-blackhole` sets RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE=1, which drops the
 * `MAP * ~NOTFOUND` host-resolver rule. That flag exists for exactly one
 * purpose: to prove that the leak is GONE rather than merely blackholed. A
 * clean run with the blackhole and a dirty run without it means the blackhole
 * is the only thing making the claim true — which is the finding this whole
 * file exists to make impossible to miss again.
 */
import { execFileSync, spawn } from 'node:child_process'
import { listProcesses, machineWideMpvCount, orphansAfterQuit, snapshot } from './lib/mpv-procs.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const num = (flag, dflt) => Number(argv.find((a) => a.startsWith(flag))?.split('=')[1] ?? dflt)
const LAUNCHES = num('--launches=', 3)
const SECONDS = num('--seconds=', 12)
const BUILD = argv.includes('--build')
const NO_BLACKHOLE = argv.includes('--no-blackhole')
const KEEP = argv.includes('--keep-logs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sample = ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))

// --- 1. the app under test MUST be the packaged one ------------------------

function packagedExe() {
  const exe = path.join(repo, 'dist', 'win-unpacked', 'RLPlayer.exe')
  if (fs.existsSync(exe) && !BUILD) return exe
  if (!BUILD) {
    throw new Error(
      `no packaged build at ${exe}.\n` +
        `This check is meaningless against the dev build — that is the bug it was ` +
        `written to replace. Run \`npm run build && npx electron-builder --win --dir\`, ` +
        `or pass --build to do it here.`
    )
  }
  console.log('building the packaged app (npm run build && electron-builder --dir)...')
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', shell: true })
  execFileSync('npx', ['electron-builder', '--win', '--dir'], {
    cwd: repo,
    stdio: 'inherit',
    shell: true
  })
  if (!fs.existsSync(exe)) throw new Error(`electron-builder did not produce ${exe}`)
  return exe
}

// --- 2. netlog parsing, tolerant of a truncated file ------------------------
//
// Chromium finalises the JSON on clean shutdown. A killed process leaves the
// events array open, and "the app had to be killed" is exactly the run whose
// evidence matters most — so the parser never depends on the closing bracket.

/**
 * WHAT A REAL SESSION LEAVES IN THE NETLOG, measured rather than assumed.
 *
 * A clean launch of the packaged build -- overlay up, sample playing, settings
 * window opened, graceful quit -- writes exactly 11 events, and the same seven
 * types every time. It is a small number because everything this app loads is
 * `file:` and never touches the network stack; that is the product working. The
 * header-only files this check used to PASS had zero.
 *
 * So the floor is 8: below every observed real run, far above every observed
 * dead one, and deliberately not tuned close to 11. Its job is to separate "a
 * session happened" from "the file has a header", not to police how many events
 * a session ought to have.
 */
const MIN_NETLOG_EVENTS = 8

/**
 * Two event types that BRACKET a real session, which is stronger than a count.
 *
 *   PROXY_CONFIG_CHANGED  -- `applySessionPolicy()` sets `{ mode: 'direct' }`,
 *     and that runs as the first statement after `app.whenReady()`. Its presence
 *     means the app got past startup, not merely that a process existed.
 *   QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS -- Chromium tears the network stack
 *     down on a clean shutdown. A force-killed process never writes it.
 *
 * Both were present on every observed clean launch and on neither header-only
 * file. Requiring the pair means the netlog itself testifies that the session
 * started and ended, rather than the harness inferring it from a count.
 */
const REQUIRED_NETLOG_EVENTS = ['PROXY_CONFIG_CHANGED', 'QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS']

function parseNetlog(file) {
  const text = fs.readFileSync(file, 'utf8')
  const at = text.indexOf('"events"')
  if (at < 0) {
    throw new Error(
      `${file} has no "events" array: Chromium did not write a usable netlog, so this ` +
        `run measured nothing. Treat it as a failure, never as a pass.`
    )
  }

  const head = text.slice(0, at).replace(/,\s*$/, '') + '}'
  let constants = {}
  try {
    constants = JSON.parse(head).constants ?? {}
  } catch {
    /* the header is written in one go; if it is broken the file is unusable */
  }
  // logEventTypes maps NAME -> number; invert it once.
  const types = {}
  for (const [name, id] of Object.entries(constants.logEventTypes ?? {})) types[id] = name

  const body = text.slice(text.indexOf('[', at) + 1)
  const events = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '')
    if (!trimmed || trimmed === ']' || trimmed === ']}') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* a half-written final line; the events before it are still true */
    }
  }
  return { types, events }
}

/**
 * Local schemes and hosts. Everything else is a violation — including a
 * request that fails, and including a hostname that is only ever resolved.
 *
 * `wpad` is NOT on this list. It is a local-network DNS query rather than a
 * third-party connection, but "zero network requests" has to mean zero, and
 * Chromium's proxy auto-discovery is switched off explicitly in
 * core/no-network.ts precisely so this list can stay this short.
 */
const LOCAL_SCHEME = /^(file|data|blob|devtools|chrome|chrome-extension|about|ws):/i
const LOCAL_HOST = new Set(['localhost', '127.0.0.1', '::1', ''])

function violations(file) {
  const { types, events } = parseNetlog(file)
  const out = []
  const seen = new Set()
  const add = (kind, detail) => {
    const key = `${kind} ${detail}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, detail })
  }

  for (const e of events) {
    const type = types[e.type]
    const p = e.params
    if (!type || !p) continue

    if (typeof p.url === 'string' && /URL_REQUEST|SOCKET_POOL_CONNECT_JOB/.test(type)) {
      if (!LOCAL_SCHEME.test(p.url)) add('request', `${type}  ${p.url}`)
    }
    if (typeof p.host === 'string' && /HOST_RESOLVER/.test(type)) {
      // `host` is sometimes "example.com:443".
      const bare = p.host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
      if (!LOCAL_HOST.has(bare)) add('resolve', `${type}  ${p.host}`)
    }
    if (typeof p.address === 'string' && /TCP_CONNECT|SOCKET_ALIVE/.test(type)) {
      const bare = p.address.replace(/^\[?([^\]]*)\]?:\d+$/, '$1').toLowerCase()
      if (!LOCAL_HOST.has(bare)) add('connect', `${type}  ${p.address}`)
    }
  }
  const seenTypes = new Set(events.map((e) => types[e.type]).filter(Boolean))
  return { out, eventCount: events.length, seenTypes }
}

// --- 3. one cold launch -----------------------------------------------------

/**
 * WM_CLOSE, the way the title-bar X does it.
 *
 * NOT `/T`: taskkill's tree walk tries to close Electron's GPU, renderer and
 * utility children first, none of which have a window, so it refuses the whole
 * tree with "this process has one or more child processes" and the app never
 * receives the close at all. That looked exactly like a broken quit path for
 * two runs. Without `/T` the packaged app exits in ~390 ms.
 */
function taskkill(pid, force) {
  const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid)]
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' })
  } catch {
    /* already gone, or refused; the caller re-checks rather than trusting this */
  }
}

async function oneLaunch(exe, n, dir) {
  const netlog = path.join(dir, `netlog-${n}.json`)
  const home = path.join(dir, `home-${n}`)
  fs.mkdirSync(home, { recursive: true })

  const env = { ...process.env, RLPLAYER_HOME: home }
  if (NO_BLACKHOLE) env['RLPLAYER_UNSAFE_NO_DNS_BLACKHOLE'] = '1'
  // B: the settings window is the app's ONLY page with text inputs, and the
  // gvt1.com dictionary download happened because of them. A network check that
  // never opens it is not checking the surface the defect was on.
  env['RLPLAYER_E2E_OPEN_SETTINGS'] = '1'

  const args = [`--log-net-log=${netlog}`]
  if (sample) args.push(sample)
  const child = spawn(exe, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))

  const t0 = Date.now()
  const deadline = t0 + SECONDS * 1000
  while (Date.now() < deadline && child.exitCode === null) await sleep(250)

  // C: the mpv processes THIS app spawned, by ancestor walk, recorded while it
  // is still running. Anything else on the machine is somebody else's.
  const ourMpv = child.pid !== undefined ? snapshot(child.pid) : []

  // WM_CLOSE first, which is what a user's title-bar X does and what
  // `before-quit` needs in order to run and finalise the netlog.
  let exited = child.exitCode !== null
  if (!exited) {
    taskkill(child.pid, false)
    for (let i = 0; i < 24 && child.exitCode === null; i++) await sleep(250)
    exited = child.exitCode !== null
  }
  let hadToForce = false
  if (!exited) {
    hadToForce = true
    taskkill(child.pid, true)
    await sleep(1500)
  }
  await sleep(400)

  if (!fs.existsSync(netlog)) {
    throw new Error(
      `launch ${n}: Chromium wrote no netlog at ${netlog}. Without it this check ` +
        `proves nothing, so it is a failure rather than a pass.`
    )
  }
  // LIVENESS. A netlog with zero events is the PASSING shape, so a launch that
  // died before it opened a window would sail through this check — which is the
  // same class of false negative the old script had. Require proof the app
  // actually ran: its own policy line on stdout, and a netlog Chromium filled
  // in with constants.
  const stdout = log.join('')
  if (!/\[no-network\]/.test(stdout)) {
    throw new Error(
      `launch ${n}: the app never printed its [no-network] policy line, so it did not even ` +
        `reach module scope. A zero-event netlog from a dead app is not a clean run.
` +
        stdout.slice(-2000)
    )
  }

  const { out, eventCount, seenTypes } = violations(netlog)

  // A: a clean run has to look like a run. Each of these was false on at least
  // one observed launch that this check reported as a pass.
  const proof = []
  if (eventCount < MIN_NETLOG_EVENTS) {
    proof.push(
      `the netlog holds ${eventCount} events (floor ${MIN_NETLOG_EVENTS}). A header-only file ` +
        `is indistinguishable from a perfectly clean session unless the floor is checked, and ` +
        `7 of 36 observed netlogs were header-only.`
    )
  }
  for (const required of REQUIRED_NETLOG_EVENTS) {
    if (!seenTypes.has(required)) {
      proof.push(
        `the netlog has no ${required}. That event is written by every clean session of this ` +
          `app and by no dead one, so its absence means the run did not happen the way a ` +
          `user's does -- and a run that did not happen records no violations either.`
      )
    }
  }
  if (!/\[ready\]/.test(stdout)) {
    proof.push(
      `the app never printed [ready], so its windows were never shown. The [no-network] line ` +
        `above is printed at module scope, BEFORE app.whenReady(), and proves only that the ` +
        `process started.`
    )
  }
  if (!/\[e2e\] settings window opened/.test(stdout)) {
    proof.push(
      `the settings window never opened, so the one page in this app with text inputs -- the ` +
        `surface the gvt1.com spellchecker leak was on -- was not exercised.`
    )
  }
  if (!/\[quit\] clean exit/.test(stdout)) {
    proof.push(
      `the app never printed [quit], so the shutdown hooks did not run to completion. A ` +
        `force-killed app writes no events either, which is why "0 events" alone is not a pass.`
    )
  }

  const later = listProcesses()
  const orphans = orphansAfterQuit(ourMpv, later)
  console.log(
    `launch ${n}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${eventCount} netlog events, ` +
      `${out.length} violation(s)${hadToForce ? ', HAD TO FORCE-KILL' : ''}, ` +
      `${ourMpv.length} mpv spawned, ${orphans.length} orphaned ` +
      `(${machineWideMpvCount(later)} mpv.exe on this machine, most of them nobody's business ` +
      `of ours)`
  )
  for (const v of out) console.log(`    ${v.kind}: ${v.detail}`)
  for (const p of proof) console.log(`    NOT A REAL SESSION: ${p}`)
  const policy = stdout.match(/\[no-network\][^\n]*/)?.[0]
  if (policy) console.log('    ' + policy)
  const ready = stdout.match(/\[ready\][^\n]*/)?.[0]
  if (ready) console.log('    ' + ready)
  const settings = stdout.match(/\[e2e\][^\n]*/)?.[0]
  if (settings) console.log('    ' + settings)
  const quit = stdout.match(/\[quit\][^\n]*/)?.[0]
  if (quit) console.log('    ' + quit)
  return { violations: out, hadToForce, orphanMpv: orphans, proof, log: stdout }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('windows only')
  const exe = packagedExe()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-netlog-'))
  console.log(
    `packaged app: ${exe}\n` +
      `${LAUNCHES} cold launches x ${SECONDS}s, fresh profile each, netlogs in ${dir}` +
      (NO_BLACKHOLE ? '\nDNS BLACKHOLE DISABLED — this run measures the real behaviour.\n' : '\n')
  )

  const all = []
  let forced = 0
  const orphanPids = []
  const notReal = []
  for (let i = 1; i <= LAUNCHES; i++) {
    const r = await oneLaunch(exe, i, dir)
    all.push(...r.violations)
    if (r.hadToForce) forced++
    orphanPids.push(...r.orphanMpv)
    for (const p of r.proof) notReal.push(`launch ${i}: ${p}`)
    await sleep(1500)
  }

  const unique = [...new Set(all.map((v) => `${v.kind}: ${v.detail}`))]
  console.log(`\n${unique.length} distinct network violation(s) across ${LAUNCHES} launches`)
  for (const u of unique) console.log('  ' + u)

  const failures = []
  if (unique.length > 0) {
    failures.push(
      `${unique.length} network request/resolution(s) recorded in Chromium's own netlog. ` +
        `RLPlayer must attempt none — a request that fails because of the DNS blackhole ` +
        `is still a request, and the blackhole is defence-in-depth, not the guarantee.`
    )
  }
  // A launch that would not close is a quit-path bug, and this harness must
  // never report it as a clean run the way the old one did.
  if (forced > 0) failures.push(`${forced} launch(es) had to be force-killed; the quit path is broken`)
  if (orphanPids.length > 0) {
    failures.push(
      `${orphanPids.length} orphaned mpv.exe THIS APP SPAWNED: pid ${orphanPids.join(', ')}. ` +
        `These are attributed by ParentProcessId, so an mpv belonging to another checkout is ` +
        `not one of them -- which is what the machine-wide tasklist count used to report.`
    )
  }
  // The evidence gate. Everything above measures the ABSENCE of something, and
  // absence is also what a launch that never ran produces.
  for (const n of notReal) failures.push(n)

  if (failures.length > 0) {
    console.error('\ncheck:network FAILED:')
    for (const f of failures) console.error('  - ' + f)
    console.error(`\nnetlogs kept for inspection: ${dir}`)
    process.exit(1)
  }
  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true })
  console.log(
    `check:network: clean -- ${LAUNCHES} launches, each with the overlay up, a sample playing, ` +
      `the settings window opened, a graceful quit and no mpv left behind`
  )
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
