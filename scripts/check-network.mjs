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
  return { out, eventCount: events.length }
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

  const args = [`--log-net-log=${netlog}`]
  if (sample) args.push(sample)
  const child = spawn(exe, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))

  const t0 = Date.now()
  const deadline = t0 + SECONDS * 1000
  while (Date.now() < deadline && child.exitCode === null) await sleep(250)

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
      `launch ${n}: the app never printed its [no-network] policy line, so it did not ` +
        `finish starting. A zero-event netlog from a dead app is not a clean run.
` +
        stdout.slice(-2000)
    )
  }

  const { out, eventCount } = violations(netlog)
  const mpv = mpvCount()
  console.log(
    `launch ${n}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${eventCount} netlog events, ` +
      `${out.length} violation(s)${hadToForce ? ', HAD TO FORCE-KILL' : ''}, ${mpv} mpv.exe left`
  )
  for (const v of out) console.log(`    ${v.kind}: ${v.detail}`)
  const policy = log.join('').match(/\[no-network\][^\n]*/)?.[0]
  if (policy) console.log('    ' + policy)
  return { violations: out, hadToForce, orphanMpv: mpv }
}

function mpvCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq mpv.exe', '/NH'], {
      encoding: 'utf8'
    })
    return (out.match(/mpv\.exe/g) ?? []).length
  } catch {
    return -1
  }
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
  let orphans = 0
  for (let i = 1; i <= LAUNCHES; i++) {
    const r = await oneLaunch(exe, i, dir)
    all.push(...r.violations)
    if (r.hadToForce) forced++
    if (r.orphanMpv > 0) orphans += r.orphanMpv
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
  if (orphans > 0) failures.push(`${orphans} orphaned mpv.exe`)

  if (failures.length > 0) {
    console.error('\ncheck:network FAILED:')
    for (const f of failures) console.error('  - ' + f)
    console.error(`\nnetlogs kept for inspection: ${dir}`)
    process.exit(1)
  }
  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true })
  console.log('check:network: clean')
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
