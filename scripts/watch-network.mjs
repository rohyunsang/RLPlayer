#!/usr/bin/env node
/**
 * Proof, per cold launch, that RLPlayer opens no outbound connection.
 *
 * The finding this answers: an unexplained outbound TCP:443 to a Google host,
 * attributed by the OS to RLPlayer's own NetworkService child, on one launch
 * out of four. It did not reproduce over three later runs including a 180s
 * watch — which is the worst possible shape for a guarantee. An intermittent
 * violation you cannot reproduce is indistinguishable from one you have fixed,
 * so the only useful answer is a repeatable measurement over several COLD
 * launches rather than one long watch.
 *
 * What it does, per launch:
 *   - starts the app on a sample file, from a clean process tree;
 *   - polls Get-NetTCPConnection every second for the WHOLE tree (Electron
 *     browser, GPU, renderers, utility processes and the NetworkService child,
 *     plus mpv), because the one connection we saw belonged to a child;
 *   - records every remote address that is not loopback and not 0.0.0.0;
 *   - quits the app gracefully and checks for orphaned mpv.
 *
 * Run:  node scripts/watch-network.mjs [--launches=5] [--seconds=30]
 * Windows only, and it needs a desktop session, so it is not part of CI.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const num = (flag, dflt) => Number(argv.find((a) => a.startsWith(flag))?.split('=')[1] ?? dflt)
const LAUNCHES = num('--launches=', 5)
const SECONDS = num('--seconds=', 30)

const sample = ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
}

/** Every descendant PID of `root`, plus `root`. Walks Win32_Process's parent. */
function processTree(root) {
  const raw = ps(
    `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`
  )
  const all = JSON.parse(raw)
  const byParent = new Map()
  for (const p of all) {
    const list = byParent.get(p.ParentProcessId) ?? []
    list.push(p)
    byParent.set(p.ParentProcessId, list)
  }
  const out = new Map()
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      if (out.has(child.ProcessId)) continue
      out.set(child.ProcessId, child.Name)
      walk(child.ProcessId)
    }
  }
  const self = all.find((p) => p.ProcessId === root)
  if (self) out.set(root, self.Name)
  walk(root)
  // mpv is spawned by us but detaches its own children; catch it by name too.
  for (const p of all) if (/^mpv\.exe$/i.test(p.Name)) out.set(p.ProcessId, p.Name)
  return out
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::', ''])

/** Non-loopback TCP connections owned by any pid in `pids`. */
function connections(pids) {
  const list = [...pids.keys()].join(',')
  if (!list) return []
  const raw = ps(
    `Get-NetTCPConnection -ErrorAction SilentlyContinue | ` +
      `Where-Object { @(${list}) -contains $_.OwningProcess } | ` +
      `Select-Object OwningProcess,State,RemoteAddress,RemotePort,LocalPort | ConvertTo-Json -Compress`
  ).trim()
  if (!raw) return []
  const rows = JSON.parse(raw)
  return (Array.isArray(rows) ? rows : [rows]).filter(
    (r) => !LOOPBACK.has(String(r.RemoteAddress)) && Number(r.RemotePort) !== 0
  )
}

function countMpv() {
  try {
    return (ps(`(Get-Process mpv -ErrorAction SilentlyContinue | Measure-Object).Count`) ?? '0')
      .trim()
      .split('\n')
      .map(Number)[0]
  } catch {
    return -1
  }
}

async function oneLaunch(n) {
  const child = spawn(
    path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [repo, sample],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))

  const found = []
  let peakPids = 0
  const deadline = Date.now() + SECONDS * 1000
  await sleep(1500)
  while (Date.now() < deadline && child.exitCode === null) {
    let pids
    try {
      pids = processTree(child.pid)
    } catch {
      break
    }
    peakPids = Math.max(peakPids, pids.size)
    for (const c of connections(pids)) {
      found.push(
        `${pids.get(c.OwningProcess) ?? 'pid ' + c.OwningProcess} -> ` +
          `${c.RemoteAddress}:${c.RemotePort} (${c.State})`
      )
    }
    await sleep(1000)
  }

  const mpvDuring = countMpv()
  child.kill()
  await sleep(1500)
  const mpvAfter = countMpv()

  const unique = [...new Set(found)]
  console.log(
    `launch ${n}: ${SECONDS}s, ${peakPids} processes watched, ` +
      `${unique.length} outbound connection(s), mpv ${mpvDuring} -> ${mpvAfter}`
  )
  for (const f of unique) console.log('    ' + f)
  if (log.some((l) => /no-network/.test(l))) {
    console.log('    ' + log.join('').match(/\[no-network\][^\n]*/)?.[0])
  }
  return unique
}

async function main() {
  if (!sample) throw new Error('no sample video under samples/')
  if (process.platform !== 'win32') throw new Error('windows only')

  console.log(`watching ${LAUNCHES} cold launches for ${SECONDS}s each...\n`)
  const all = []
  for (let i = 1; i <= LAUNCHES; i++) {
    all.push(...(await oneLaunch(i)))
    // A genuinely COLD launch: let the OS tear the tree down between runs, and
    // give any deferred background task a chance to be scheduled fresh. The
    // connection we are hunting appeared on one launch in four.
    await sleep(2500)
  }

  const unique = [...new Set(all)]
  console.log(`\ntotal outbound connections across ${LAUNCHES} launches: ${unique.length}`)
  for (const u of unique) console.log('  ' + u)
  if (unique.length > 0) {
    console.error('\nwatch-network FAILED: RLPlayer must open no outbound connection.')
    process.exit(1)
  }
  console.log('watch-network: clean')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
