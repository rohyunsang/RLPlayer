/**
 * Ask THE PLAYING mpv what its properties actually are.
 *
 * Everything else in `scripts/` observes the app's own reports of mpv: the
 * overlay's `player:state`, a module's state channel, an OSD line. Those are the
 * app agreeing with itself, which is exactly the shape of evidence this repo has
 * been burned by five times. This connects a SECOND client to the same
 * `--input-ipc-server` pipe the app opened and asks mpv directly, so
 * "M19 changed sub-font-size" is answered by mpv rather than by M19.
 *
 * The pipe name is random per instance (`core/mpv/engine.ts` builds it by
 * concatenation precisely so it cannot be guessed), so it is read back off the
 * child's command line — attribution by ParentProcessId, the same way
 * `scripts/lib/mpv-procs.mjs` counts orphans.
 */
import { execFileSync } from 'node:child_process'
import net from 'node:net'

/** The `--input-ipc-server` pipe of the mpv.exe descended from `rootPid`. */
export function findMpvPipe(rootPid) {
  const ps = `
    $ErrorActionPreference='Stop'
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
    $want = @(${rootPid})
    for ($i=0; $i -lt 4; $i++) {
      $kids = $all | Where-Object { $want -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }
      if ($kids) { $want = $want + $kids }
    }
    $all | Where-Object { $_.Name -eq 'mpv.exe' -and $want -contains $_.ProcessId } |
      ForEach-Object { $_.CommandLine }
  `
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8'
  })
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const pipes = []
  for (const l of lines) {
    const m = /--input-ipc-server=(\S+)/.exec(l)
    if (m) pipes.push({ pipe: m[1].replace(/^"|"$/g, ''), commandLine: l })
  }
  return pipes
}

/**
 * A one-shot JSON-IPC client. Returns a `get(prop)` / `command(args)` pair.
 *
 * Each reply is matched by `request_id`, because mpv interleaves unsolicited
 * events with replies and reading "the next line" is how a probe starts
 * reporting an event payload as a property value.
 */
export async function connectMpv(pipe, timeoutMs = 8000) {
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect(pipe)
    const t = setTimeout(() => reject(new Error(`mpv pipe ${pipe} did not connect`)), timeoutMs)
    s.once('connect', () => { clearTimeout(t); resolve(s) })
    s.once('error', (e) => { clearTimeout(t); reject(e) })
  })
  let buf = ''
  let nextId = 1
  const waiting = new Map()
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.request_id !== undefined && waiting.has(msg.request_id)) {
        const { resolve } = waiting.get(msg.request_id)
        waiting.delete(msg.request_id)
        resolve(msg)
      }
    }
  })
  const rpc = (command) => {
    const request_id = nextId++
    return new Promise((resolve, reject) => {
      waiting.set(request_id, { resolve, reject })
      sock.write(JSON.stringify({ command, request_id }) + '\n')
      setTimeout(() => {
        if (waiting.delete(request_id)) reject(new Error(`mpv ${command[0]} ${command[1] ?? ''} timed out`))
      }, timeoutMs)
    })
  }
  return {
    /** The property's value, or `{ error }` — never a silent undefined. */
    async get(prop) {
      const r = await rpc(['get_property', prop])
      if (r.error !== 'success') return { error: r.error, prop }
      return { value: r.data, prop }
    },
    command: (args) => rpc(args),
    close: () => sock.destroy()
  }
}
