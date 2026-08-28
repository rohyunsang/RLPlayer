import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { MpvClient } from '../../mpv/client'
import { resolveMpvPath } from '../../mpv/manager'
import { ContributionError } from '../errors.ts'
import type { EngineService, SecondaryEngine, SecondaryEngineOptions } from '@shared/feature-api'

/**
 * core/mpv/engine — ONE way to run a second mpv (§5.3, L22/N36/C09/C16).
 *
 * WHY THIS EXISTS. Four Wave-1 features need a second `mpv.exe`: N36 (seek
 * thumbnails, M27), L22 (the headless metadata probe, M29), and C09/C16 (clip
 * export and cache dump, M23). The only path to the binary was
 * `resolveMpvPath()` at `src/main/mpv/manager.ts:51` — a file in the
 * `mustNotTouch` list of 40 of the 55 rows — and `PathService` exposed no binary
 * path at all. So M23 and M27 would each have had to edit `feature-api.ts` AND
 * `core/paths.ts` to get one, which is two shared-file collisions before either
 * of them writes a line of their own feature. §2.6 L30 already carried an
 * explicit "**Overlap warning:** build ONE shared engine, not two" and there was
 * nothing to build it with.
 *
 * THE PART THAT IS NOT ABOUT CONVENIENCE. A module holding a raw path spawns a
 * process nothing tracks, and this project's one hard runtime guarantee is "no
 * orphan mpv on quit". Every engine minted here is:
 *
 *   - registered in a module-level set, so `disposeEngines()` on the quit path
 *     reaps all of them whether or not their owner remembered to close them;
 *   - covered by ONE synchronous `process.on('exit')` reaper, which is the only
 *     fallback that survives `app.exit()` and an uncaught throw. That is the
 *     same reasoning as `MpvManager`'s exit hook, and for the same measured
 *     reason: an async cleanup registered in `before-quit` almost never runs;
 *   - idle-killed. §6.3's M27 row requires "the thumbnailer process dies 60 s
 *     after the last hover", which is a lifecycle every one of the four modules
 *     would otherwise implement slightly differently.
 *
 * `--input-ipc-server` gets a RANDOM pipe name per instance, and that is not
 * tidiness: mpv's IPC is documented as "explicitly insecure" and exposes the
 * `run` command, so a guessable pipe name is a local command-execution surface
 * (§2.6 L22 says so in as many words).
 */

const ENGINE_BASE_ARGS: readonly string[] = [
  // The user's mpv.conf must not reach a probe: a `vf` in it would corrupt every
  // thumbnail, and a `screenshot-template` would scatter files.
  '--no-config',
  '--idle=yes',
  '--terminal=no',
  '--msg-level=all=no',
  '--load-scripts=no',
  // Zero network at rest applies to every process this app starts, not only the
  // one with a window on it.
  '--ytdl=no'
]

interface Live {
  owner: string
  purpose: string
  proc: ChildProcess
  pid: number
  client: MpvClient
  idleTimer: NodeJS.Timeout | null
  closed: boolean
}

const live = new Set<Live>()
let exitHookInstalled = false

/** True while the pid still exists. Signal 0 asks without delivering one. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hardKill(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* exit code 128 is "no such process", which is the outcome we wanted */
  }
}

/**
 * ONE reaper for every secondary, registered once.
 *
 * `process.on('exit')` handlers must be synchronous, which is why this is
 * `execFileSync`: at that point there is no event loop left to await anything
 * on, and an orphaned mpv holding a file handle is worse than a short stall on a
 * process that is exiting anyway.
 */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const e of live) if (alive(e.pid)) hardKill(e.pid)
  })
}

async function closeOne(e: Live, graceMs: number): Promise<{ orphaned: boolean }> {
  if (e.closed) return { orphaned: false }
  e.closed = true
  if (e.idleTimer) clearTimeout(e.idleTimer)
  live.delete(e)
  await e.client.command(['quit']).catch(() => {})
  e.client.close()
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && alive(e.pid)) await new Promise((r) => setTimeout(r, 40))
  if (!alive(e.pid)) return { orphaned: false }
  try {
    e.proc.kill()
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 300))
  if (!alive(e.pid)) return { orphaned: false }
  hardKill(e.pid)
  await new Promise((r) => setTimeout(r, 400))
  const orphaned = alive(e.pid)
  if (orphaned) {
    console.error(`[engine] ${e.owner}/${e.purpose} pid ${e.pid} survived every kill; orphaned`)
  }
  return { orphaned }
}

/**
 * Reap every secondary. Called from the quit path in `src/main/index.ts`, and it
 * is the reason a module never has to be trusted to close its own engine.
 */
export async function disposeEngines(): Promise<{ closed: number; orphaned: number }> {
  const all = [...live]
  let orphaned = 0
  for (const e of all) {
    const r = await closeOne(e, 800)
    if (r.orphaned) orphaned++
  }
  return { closed: all.length, orphaned }
}

/** For the e2e harness and for the stats overlay: what is running right now. */
export function liveEngines(): Array<{ owner: string; purpose: string; pid: number }> {
  return [...live].map((e) => ({ owner: e.owner, purpose: e.purpose, pid: e.pid }))
}

/**
 * The per-module facade, minted by `core/registry` with the module's id baked in
 * exactly the way `ctx.mpv` is. A module cannot construct one for another id.
 */
export function createEngineService(ownerId: string): EngineService {
  return {
    binaryPath(): string {
      const exe = resolveMpvPath()
      if (!fs.existsSync(exe)) {
        throw new Error(
          `mpv.exe not found at ${exe}. Run "npm run fetch:mpv" to download the playback engine.`
        )
      }
      return exe
    },

    async spawn(opts: SecondaryEngineOptions): Promise<SecondaryEngine> {
      const purpose = String(opts.purpose ?? '').trim()
      if (!/^[a-z0-9-]{1,32}$/.test(purpose)) {
        throw new ContributionError(
          `ctx.engine.spawn() needs a lowercase 'purpose' ([a-z0-9-], <=32 chars); got ` +
            `'${opts.purpose}'. It names the process in the log and in the pipe name, and ` +
            `"which mpv is that?" during a support call is the whole point of it.`
        )
      }
      const exe = this.binaryPath()

      // Built by concatenation, never by templating: a template that folds
      // `\\.\pipe\` silently eats the backslashes (§7.7 trap 9). The UUID is
      // required, not tidy -- mpv's IPC exposes `run`.
      const pipePath = '\\\\.\\pipe\\' + `rlplayer-${purpose}-${process.pid}-${randomUUID()}`
      const argv = [`--input-ipc-server=${pipePath}`, ...ENGINE_BASE_ARGS, ...(opts.args ?? [])]

      const proc = spawn(exe, argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      const pid = proc.pid
      if (pid === undefined) throw new Error(`could not spawn ${exe}`)
      const client = new MpvClient()
      const entry: Live = {
        owner: ownerId,
        purpose,
        proc,
        pid,
        client,
        idleTimer: null,
        closed: false
      }
      live.add(entry)
      installExitHook()
      proc.stderr?.on('data', (d: Buffer) => {
        console.error(`[engine ${ownerId}/${purpose}]`, d.toString().trim())
      })
      proc.on('exit', () => {
        entry.closed = true
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        live.delete(entry)
      })

      try {
        await client.connect(pipePath)
      } catch (e) {
        await closeOne(entry, 200)
        throw e
      }

      const idleMs = opts.idleTimeoutMs ?? 0
      const touch = (): void => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        if (idleMs <= 0 || entry.closed) return
        entry.idleTimer = setTimeout(() => void closeOne(entry, 500), idleMs)
        entry.idleTimer.unref?.()
      }
      touch()

      return {
        get pid(): number | null {
          return entry.closed ? null : pid
        },
        get running(): boolean {
          return !entry.closed && client.connected
        },
        async command<T>(args: unknown[]): Promise<T> {
          if (entry.closed) throw new Error(`${ownerId}/${purpose} engine is closed`)
          touch()
          return client.command<T>(args)
        },
        async getProperty<T>(name: string): Promise<T> {
          if (entry.closed) throw new Error(`${ownerId}/${purpose} engine is closed`)
          touch()
          return client.getProperty<T>(name)
        },
        onEvent(event: string, cb: (msg: Record<string, unknown>) => void): () => void {
          const handler = (name: string, msg: Record<string, unknown>): void => {
            if (name === event) cb(msg)
          }
          client.on('mpv-event', handler)
          return () => client.off('mpv-event', handler)
        },
        async close(): Promise<void> {
          await closeOne(entry, 800)
        }
      }
    }
  }
}
