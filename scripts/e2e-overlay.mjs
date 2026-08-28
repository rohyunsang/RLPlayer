#!/usr/bin/env node
/**
 * The overlay smoke test, driven for real.
 *
 * This exists because of a bug that no unit test could have seen from the
 * outside and that typecheck was perfectly happy with: a stray duplicate
 * `loadRendererFeatures()` spliced INSIDE the `keydown` handler. Before any
 * keypress the console was clean; one ArrowUp produced 32 errors in 4 seconds
 * and roughly 8 per second forever after, because each press re-entered every
 * renderer module's `setup()` and leaked a permanently throwing state
 * subscriber.
 *
 * So the assertion here is not "the app started". It is:
 *
 *   1. zero console errors in the first N seconds, with video playing;
 *   2. drive real keypresses through the same path a user's keyboard takes;
 *   3. zero console errors in the N seconds AFTER them, too.
 *
 * Run:  node scripts/e2e-overlay.mjs [--packaged] [--keep] [--seconds=4]
 * Needs a desktop session (it opens real windows) so it is NOT part of CI;
 * `npm run verify` stays headless. Run it before you tag.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const PACKAGED = args.includes('--packaged')
const WINDOW_S = Number(args.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 4)
const PORT = 9333

const sample = ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** How many mpv.exe processes are running right now. */
function countMpv() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq mpv.exe', '/NH'], {
      encoding: 'utf8'
    })
    return (out.match(/mpv\.exe/g) ?? []).length
  } catch {
    return -1
  }
}

/**
 * `--packaged` drives `dist/win-unpacked/RLPlayer.exe` instead of the dev
 * Electron.
 *
 * It matters more than it looks. `scripts/watch-network.mjs` measured the DEV
 * build and reported "0 outbound" on the very launches whose packaged netlog
 * showed a completed download to Google — the two builds do not behave the
 * same, because `app.isPackaged` changes ownership strictness, asar changes
 * paths, and Chromium's subsystems are configured differently. Anything that
 * claims to be evidence about the shipped product runs with this flag.
 */
function electronBinary() {
  if (PACKAGED) {
    const exe = path.join(repo, 'dist', 'win-unpacked', 'RLPlayer.exe')
    if (!fs.existsSync(exe)) {
      throw new Error(
        `--packaged given but ${exe} does not exist. ` +
          `Run: npm run build && npx electron-builder --win --dir`
      )
    }
    return exe
  }
  const p = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(p)) throw new Error(`electron not found at ${p}`)
  return p
}

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

/** A minimal CDP session over the global WebSocket. */
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
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 10000)
    })
  }
  on(method, cb) {
    const list = this.handlers.get(method) ?? []
    list.push(cb)
    this.handlers.set(method, list)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

/** One physical keypress, the way a keyboard delivers it. */
async function pressKey(s, code, key, windowsVirtualKeyCode) {
  const base = { code, key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function main() {
  if (!sample) throw new Error('no sample video under samples/; cannot drive playback')

  // The packaged exe IS the app; the dev binary needs the app directory as argv[1].
  const launchArgs = PACKAGED ? [] : [repo]
  const child = spawn(
    electronBinary(),
    [...launchArgs, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', sample],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }
  )
  console.log(`driving ${PACKAGED ? 'the PACKAGED build' : 'the dev build'}`)
  const mainLog = []
  child.stdout.on('data', (d) => mainLog.push(String(d)))
  child.stderr.on('data', (d) => mainLog.push(String(d)))

  let targets = []
  for (let i = 0; i < 120; i++) {
    try {
      targets = await cdpTargets()
      if (targets.some((t) => t.url.includes('index.html'))) break
    } catch {
      /* devtools endpoint not up yet */
    }
    await sleep(250)
  }
  const overlay = targets.find((t) => t.url.includes('index.html'))
  if (!overlay) {
    child.kill()
    throw new Error(`overlay target never appeared. main log:\n${mainLog.join('')}`)
  }

  const s = await Session.open(overlay.webSocketDebuggerUrl)
  const errors = []
  s.on('Runtime.exceptionThrown', (p) => {
    errors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`)
  })
  s.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return
    errors.push('console.error: ' + p.args.map((a) => a.description ?? a.value).join(' '))
  })
  await s.send('Runtime.enable')
  await s.send('Page.enable')

  // Let playback actually start before measuring.
  await sleep(2500)
  const started = errors.length
  errors.length = 0

  console.log(`baseline: watching for ${WINDOW_S}s with no input...`)
  await sleep(WINDOW_S * 1000)
  const before = errors.splice(0).slice()

  // LIVENESS, before anything else is believed. A hung app also reports zero
  // console errors, which is how a boot failure behind a modal `showErrorBox`
  // once passed this test: the main process blocks, CDP stops answering, no
  // events arrive, and "0 errors in 4s" reads as success. Ask a question and
  // require an answer.
  const alive = await s
    .send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
    .then((r) => r.result?.value === 2)
    .catch(() => false)
  if (!alive) {
    child.kill()
    throw new Error(
      'the app stopped answering CDP before any input. A blocked main process ' +
        'produces zero console errors too, so this is a FAILURE, not a clean run.\n' +
        'main log:\n' +
        mainLog.join('')
    )
  }

  // The exact key the audit used, plus a few more bound ones. ArrowUp is
  // volume in the default preset; every one of these goes through the keydown
  // handler the stray call was spliced into.
  console.log('driving keypresses...')
  process.on('uncaughtException', (e) => {
    console.error('main process log so far:\n' + mainLog.join(''))
    console.error(e)
    child.kill()
    process.exit(1)
  })
  await pressKey(s, 'ArrowUp', 'ArrowUp', 38)
  await sleep(200)
  await pressKey(s, 'ArrowDown', 'ArrowDown', 40)
  await sleep(200)
  await pressKey(s, 'ArrowRight', 'ArrowRight', 39)
  await sleep(200)
  await pressKey(s, 'ArrowLeft', 'ArrowLeft', 37)
  await sleep(200)
  await pressKey(s, 'KeyM', 'm', 77)
  await sleep(200)
  await pressKey(s, 'KeyM', 'm', 77)
  await sleep(500)

  console.log(`after input: watching for ${WINDOW_S}s...`)
  errors.length = 0
  await sleep(WINDOW_S * 1000)
  const after = errors.splice(0).slice()

  // Prove the overlay is still alive rather than merely quiet: a dead renderer
  // also produces zero errors.
  const probe = await s.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      panels: document.querySelectorAll('#panelRoot .panel').length,
      layers: document.querySelectorAll('#seekLayers > *').length,
      title: document.getElementById('mediaTitle')?.textContent ?? '',
      time: document.getElementById('timeNow')?.textContent ?? '',
      duration: document.getElementById('timeTotal')?.textContent ?? ''
    })`,
    returnByValue: true
  })
  const dom = JSON.parse(probe.result.value)

  // --- the generated settings window ---------------------------------------
  //
  // Every control on that page comes from a `ctx.settings.define()` descriptor,
  // a `ctx.settingsSection()` or a `ctx.settingsComponent()`. If the wiring
  // breaks, the page renders empty rather than throwing, so counting controls
  // is the only assertion that actually means anything here.
  console.log('opening the settings window...')
  await s.send('Runtime.evaluate', {
    expression: `window.rlplayer.settings.open()`,
    awaitPromise: false
  })
  let settingsTarget = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    settingsTarget = (await cdpTargets()).find((t) => t.url.includes('settings.html'))
    if (settingsTarget) break
  }
  let settings = { rows: 0, sections: 0, custom: 0, contributed: 0, errors: [] }
  if (settingsTarget) {
    const ss = await Session.open(settingsTarget.webSocketDebuggerUrl)
    const sErrors = []
    ss.on('Runtime.exceptionThrown', (p) =>
      sErrors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`)
    )
    ss.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') sErrors.push('console.error: ' + p.args.map((a) => a.description ?? a.value).join(' '))
    })
    await ss.send('Runtime.enable')
    await sleep(1500)
    const r = await ss.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        rows: document.querySelectorAll('.row.setting').length,
        sections: document.querySelectorAll('#settingsRoot section').length,
        custom: document.querySelectorAll('.setting-custom select').length,
        contributed: document.querySelectorAll('.settings-contributed').length,
        ids: [...document.querySelectorAll('.row.setting')].map((n) => n.dataset.settingId)
      })`,
      returnByValue: true
    })
    settings = { ...JSON.parse(r.result.value), errors: sErrors }
    ss.close()
  }

  // --- graceful quit, and no orphan mpv ------------------------------------
  //
  // `child.kill()` is TerminateProcess on Windows, so `before-quit` never runs
  // and mpv is orphaned -- by the harness, not by the app. Quit the way a user
  // does and then check, because "no orphan mpv on quit" is a v0.1 guarantee
  // and this is the only place that exercises it.
  let orphans = -1
  let quitMs = -1
  let hadToKill = false
  if (!KEEP) {
    const mpvBefore = countMpv()
    const t0 = Date.now()
    await s.send('Runtime.evaluate', { expression: 'window.rlplayer.window.close()' }).catch(() => {})
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250)
    /**
     * THIS IS THE LINE THAT USED TO LIE.
     *
     * It was `if (child.exitCode === null) child.kill()` with no record kept,
     * and `child.kill()` is TerminateProcess on Windows. So a build that never
     * quit was killed by the harness, `before-quit` never ran, and the script
     * then printed "e2e-overlay: clean" with "0 orphan mpv" — a number measured
     * AFTER a TerminateProcess it did not report.
     *
     * The measured failure it hid: with the settings window open (which this
     * harness opens, twenty lines above) the app never quit at all. 0 s to exit
     * without it; still running after 16 s with it, 2 out of 2.
     */
    if (child.exitCode === null) {
      hadToKill = true
      child.kill()
    }
    quitMs = Date.now() - t0
    await sleep(1200)
    orphans = countMpv() - (mpvBefore - 1)
    s.close()
  }

  console.log('\n--- results ---')
  console.log(`errors during startup       : ${started}`)
  console.log(`errors in ${WINDOW_S}s before input : ${before.length}`)
  console.log(`errors in ${WINDOW_S}s after input  : ${after.length}`)
  console.log(`panels mounted              : ${dom.panels}`)
  console.log(`seek-bar layers registered  : ${dom.layers}`)
  console.log(`title / time                : ${dom.title} ${dom.time} / ${dom.duration}`)
  console.log(`settings rows / sections    : ${settings.rows} / ${settings.sections}`)
  console.log(`  generated from descriptors: ${(settings.ids ?? []).join(', ')}`)
  console.log(`  custom components mounted : ${settings.custom}`)
  console.log(`  contributed sections      : ${settings.contributed}`)
  console.log(
    `quit                        : ${hadToKill ? 'FORCE-KILLED by the harness' : `${quitMs} ms`}`
  )
  console.log(`orphan mpv after quit       : ${orphans}`)
  for (const e of [...before, ...after, ...settings.errors]) console.log('  ' + e)

  const failures = []
  if (started > 0) failures.push(`${started} console error(s) during startup`)
  if (before.length > 0) failures.push(`${before.length} console error(s) before any input`)
  if (after.length > 0) failures.push(`${after.length} console error(s) after keypresses`)
  if (dom.duration === '0:00') failures.push('no duration: nothing is playing')
  if (dom.layers === 0) failures.push('no seek-bar layer registered')
  if (dom.panels === 0) failures.push('no contributed panel mounted')
  if (settings.rows < 8) failures.push(`settings form generated only ${settings.rows} rows`)
  if (settings.custom === 0) failures.push('the custom settings component did not mount')
  if (settings.contributed === 0) failures.push('no contributed settings section mounted')
  if (settings.errors.length > 0) {
    failures.push(`${settings.errors.length} console error(s) in the settings window`)
  }
  if (hadToKill) {
    failures.push(
      'the app did not quit within 10 s of window.close() and the harness had to ' +
        'TerminateProcess it. Every number after this point (orphan mpv above all) was ' +
        'measured after a kill, so it proves nothing — which is exactly how this used to ' +
        'report "clean". The settings window being open is the known cause.'
    )
  }
  if (orphans > 0) failures.push(`${orphans} orphaned mpv.exe after a graceful quit`)
  if (failures.length > 0) {
    console.error('\ne2e-overlay FAILED:')
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('\ne2e-overlay: clean')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
