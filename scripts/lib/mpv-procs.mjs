/**
 * WHOSE mpv.exe IS THAT?
 *
 * Both orphan checks in this repo counted mpv processes MACHINE-WIDE, with no
 * attribution at all:
 *
 *   scripts/check-network.mjs:258  mpvCount()  -> tasklist /FI "IMAGENAME eq mpv.exe"
 *   scripts/e2e-overlay.mjs:42     countMpv()  -> the same command
 *
 * The product is clean: 47 launches, every graceful quit exiting in 216-457 ms,
 * mpv dying 115-164 ms after the app, 0 orphans attributed by ParentProcessId.
 * The INSTRUMENTS were the problem, and they were broken in both directions.
 *
 * FALSE RED. `npm run check:network -- --launches=6 --seconds=10` -- the exact
 * CI invocation in .github/workflows/ci.yml -- reported "FAILED: 4 orphaned
 * mpv.exe" on an unchanged tree. All four belonged to a different checkout of
 * this project running in another window; zero belonged to the app under test.
 * It failed 3 of 4 runs on identical bits, and check-network.mjs:305 made that a
 * hard red. A gate that red-lights clean trees is disabled by the first person
 * it blocks.
 *
 * FALSE GREEN, which is worse. e2e-overlay.mjs:331 computed
 *
 *     orphans = countMpv() - (mpvBefore - 1)
 *
 * a DELTA. An unrelated mpv exiting inside the quit window subtracts one, so a
 * genuine orphan reports 0 -- in the very file whose comment reads "THIS IS THE
 * LINE THAT USED TO LIE".
 *
 * So: track the actual PIDs. `snapshot()` records every mpv the app under test
 * is an ancestor of, by walking ParentProcessId; `orphansAfterQuit()` asks which
 * of THOSE specific processes are still alive afterwards. An unrelated mpv is
 * invisible to both directions, which is the only property that matters here.
 *
 * PID REUSE. Windows reuses pids, and a quit window is exactly long enough for
 * it to happen. Every process is keyed by pid AND creation time, so a recycled
 * pid is a different process and is not counted as a survivor.
 */
import { execFileSync } from 'node:child_process'

/**
 * Every running process, as `{ pid, ppid, name, created }`.
 *
 * CIM rather than `tasklist`, because `tasklist` prints no parent pid in any
 * format and the parent pid is the entire point. `CreationDate` comes back as a
 * DMTF string (`20260828143012.123456+540`); it is used only for equality, so it
 * is kept verbatim rather than parsed into a Date that could round.
 */
export function listProcesses() {
  const ps = [
    'Get-CimInstance Win32_Process',
    "| Select-Object ProcessId,ParentProcessId,Name,CreationDate",
    '| ConvertTo-Json -Compress -Depth 2'
  ].join(' ')
  let out
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', maxBuffer: 32 << 20, windowsHide: true }
    )
  } catch (e) {
    throw new Error(`could not enumerate processes: ${e.message ?? e}`)
  }
  const raw = JSON.parse(out.trim() || '[]')
  const rows = Array.isArray(raw) ? raw : [raw]
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: String(r.Name ?? ''),
    created: String(r.CreationDate ?? '')
  }))
}

/**
 * The mpv processes `rootPid` is an ANCESTOR of, not merely the parent of.
 *
 * Pure, and separated from `listProcesses` on purpose: this is the logic that
 * was wrong, so it is the logic that gets a unit test with a fixture process
 * table rather than a live machine.
 */
export function mpvDescendantsOf(processes, rootPid) {
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const isDescendant = (p) => {
    const seen = new Set()
    let cur = p
    // A process table can contain a cycle after pid reuse; bound the walk.
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid)
      if (cur.ppid === rootPid) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  return processes
    .filter((p) => p.name.toLowerCase() === 'mpv.exe' && (p.pid === rootPid || isDescendant(p)))
    .map((p) => ({ pid: p.pid, created: p.created }))
}

/** What the app under test had running when we looked. */
export function snapshot(rootPid) {
  return mpvDescendantsOf(listProcesses(), rootPid)
}

/**
 * Which of `tracked` are STILL running, keyed by pid AND creation time.
 *
 * Pure, for the same reason as above. `later` is a fresh process list.
 */
export function survivors(tracked, later) {
  const alive = new Map(later.map((p) => [p.pid, p.created]))
  return tracked.filter((t) => alive.get(t.pid) === t.created)
}

/**
 * THE FUNCTION THAT REPLACES THE DELTA.
 *
 * `before` is what the app owned while it was running; `later` is the machine's
 * process table after the quit. The answer is a list of pids, so a failure names
 * the processes rather than a count nobody can chase.
 */
export function orphansAfterQuit(before, later) {
  return survivors(before, later).map((p) => p.pid)
}

/** Machine-wide mpv count, for reporting CONTEXT next to the real number. */
export function machineWideMpvCount(processes) {
  return processes.filter((p) => p.name.toLowerCase() === 'mpv.exe').length
}
