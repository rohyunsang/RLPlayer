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
 * Run:  node scripts/e2e-overlay.mjs [--keep] [--seconds=4]
 * Needs a desktop session (it opens real windows) so it is NOT part of CI;
 * `npm run verify` stays headless. Run it before you tag.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const WINDOW_S = Number(args.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 4)
const PORT = 9333

const sample = ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronBinary() {
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

  const child = spawn(
    electronBinary(),
    [repo, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', sample],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }
  )
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

  // The exact key the audit used, plus a few more bound ones. ArrowUp is
  // volume in the default preset; every one of these goes through the keydown
  // handler the stray call was spliced into.
  console.log('driving keypresses...')
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

  if (!KEEP) {
    s.close()
    child.kill()
    await sleep(800)
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
