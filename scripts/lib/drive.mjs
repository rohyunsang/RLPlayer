/**
 * A reusable "launch the packaged app and talk to it" harness.
 *
 * `e2e-overlay.mjs` and `check-network.mjs` each grew their own copy of the CDP
 * plumbing, and `e2e-wave1.mjs` needed a third. This is that plumbing, once.
 *
 * It deliberately does NOT assert anything: the caller owns the claims, so a
 * shared harness can never become the place where a check quietly stops
 * checking.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        return
      }
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params)
    })
  }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Session(ws)
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
    })
  }
  on(method, cb) {
    const list = this.handlers.get(method) ?? []
    list.push(cb)
    this.handlers.set(method, list)
  }
  /**
   * Evaluate in the page and return the VALUE, throwing on a thrown exception.
   *
   * `awaitPromise` matters: every `window.rl.invoke` is a promise, and without
   * it the harness would resolve to `{}` for a rejected IPC call and read as a
   * pass. That is the whole family of defect this repo keeps finding.
   */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval threw'
      )
    }
    return r.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

export async function press(s, code, key, vk, modifiers = 0) {
  const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * Launch the packaged app on a throwaway profile and attach to the overlay.
 *
 * Returns `{ session, child, stop, log, profile }`. `log` accumulates the
 * child's stdout+stderr so a caller can assert on the app's own markers, which
 * is the only evidence available for anything that happens in the main process.
 */
/**
 * The sample to play, resolved the way `make:sample` actually names things.
 *
 * `launch()` hard-defaulted to `samples/bbb_long.mp4` and threw `sample
 * missing` otherwise, while `scripts/make-sample.mjs` -- the script that exists
 * precisely because `samples/` is gitignored -- writes `samples/bbb.mp4`. So on
 * any tree without a developer's own Big Buck Bunny, which is every fresh
 * checkout and every CI runner, `npm run make:sample && npm run e2e:wave1`
 * produced `Error: sample missing`. That is the reason this suite could not
 * simply be added to the workflow, and it is a harness defect rather than a
 * runner limitation.
 *
 * One list, in the same preference order make-sample uses, and the error names
 * the command that fixes it.
 */
export function resolveSample(explicit) {
  const candidates = explicit ? [explicit] : ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  for (const rel of candidates) {
    const abs = path.join(repo, rel)
    if (fs.existsSync(abs)) return abs
  }
  throw new Error(
    `no sample video: looked for ${candidates.join(', ')} under ${repo}. ` +
      `Run \`npm run make:sample\` (it encodes one with the pinned mpv; no download).`
  )
}

export async function launch({ port = 9411, sample, args = [], mpvConf } = {}) {
  const exe = path.join(repo, 'dist', 'win-unpacked', 'RLPlayer.exe')
  if (!fs.existsSync(exe)) throw new Error(`packaged build missing: ${exe}`)
  const file = resolveSample(sample)

  /**
   * A FRESH PROFILE, via `RLPLAYER_HOME`.
   *
   * The variable name matters and cost a wrong measurement to learn: this
   * harness first passed `RLPLAYER_PORTABLE_DIR`, which the app does not read,
   * so three exploratory runs silently drove the DEVELOPER'S OWN config. The
   * tell was in the data — `volume: 145`, `sub-delay: -0.4` and a `time-pos` of
   * 508 s on what was supposed to be a first-ever launch — and a run that
   * inherits a real profile can pass or fail for reasons that have nothing to do
   * with the build. `e2e-overlay.mjs` uses `RLPLAYER_HOME`; so does this.
   */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-wave1-'))
  if (mpvConf) fs.writeFileSync(path.join(profile, 'mpv.conf'), mpvConf, 'utf8')

  let log = ''
  const child = spawn(
    exe,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
     ...args, file],
    { cwd: repo, env: { ...process.env, RLPLAYER_HOME: profile }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))

  // Wait for the overlay target, not merely for the process.
  let session = null
  for (let i = 0; i < 120 && session === null; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) session = await Session.open(page.webSocketDebuggerUrl)
    } catch {
      /* not up yet */
    }
  }
  if (!session) throw new Error(`no CDP overlay target after 60s.\n--- app log ---\n${log}`)
  await session.send('Runtime.enable')

  const stop = async () => {
    try {
      void session.eval('window.rlplayer.window.close()').catch(() => {})
    } catch {
      /* page may already be gone */
    }
    await sleep(1200)
    try {
      child.kill()
    } catch {
      /* already exited */
    }
  }
  return { session, child, stop, profile, getLog: () => log }
}

export { Session }
