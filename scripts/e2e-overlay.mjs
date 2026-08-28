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
 * Run:  node scripts/e2e-overlay.mjs [--packaged] [--keep] [--seconds=4] [--presses=6]
 * Needs a desktop session (it opens real windows) so it is NOT part of CI;
 * `npm run verify` stays headless. Run it before you tag.
 */
import { spawn } from 'node:child_process'
import { listProcesses, machineWideMpvCount, orphansAfterQuit, snapshot } from './lib/mpv-procs.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const PACKAGED = args.includes('--packaged')
const WINDOW_S = Number(args.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 4)
const PRESSES = Number(args.find((a) => a.startsWith('--presses='))?.split('=')[1] ?? 6)
const PORT = 9333

const sample = ['samples/bbb_long.mp4', 'samples/bbb.mp4']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `countMpv()` IS GONE, and the reason is worth keeping.
 *
 * It was `tasklist /FI "IMAGENAME eq mpv.exe"` -- a machine-wide count with no
 * attribution -- and line 331 below turned it into
 *
 *     orphans = countMpv() - (mpvBefore - 1)
 *
 * a DELTA. An unrelated mpv exiting inside the quit window subtracts one, so a
 * genuine orphan reports 0. That is a false PASS, in the file whose own comment
 * reads "THIS IS THE LINE THAT USED TO LIE". The same count in
 * `check-network.mjs` produced the mirror-image failure: "FAILED: 4 orphaned
 * mpv.exe" on an unchanged tree, on four processes belonging to a different
 * checkout, 3 runs out of 4.
 *
 * `scripts/lib/mpv-procs.mjs` records the pids this app is an ancestor of while
 * it is running, and asks afterwards which of THOSE are still alive. Its
 * fixtures are the two measured failures.
 */

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

/**
 * A fresh profile whose mpv.conf gives the sample THREE CHAPTERS.
 *
 * Why this is here rather than a chaptered file in `samples/`: the seek-bar
 * assertions below are about M25's contributed layer, and M25 draws nothing at
 * all when a file has fewer than two chapters. With the plain sample, "the
 * tooltip composed one fragment" and "Tab reached no handle" are both true of a
 * perfectly wired build, so the assertions would have to be softened to the
 * point of proving nothing -- which is the failure mode this whole round is
 * about.
 *
 * It needs no external tool and no checked-in binary. `--chapters-file` takes an
 * FFMETADATA file (the OGM `CHAPTER01=` form is silently ignored by the pinned
 * build -- measured: 0 chapters), and P06 already makes `<dataDir>/mpv.conf` a
 * supported way to pass mpv options, so this exercises a real product feature
 * rather than a test hook. Forward slashes: mpv accepts them on Windows and they
 * survive the config parser without escaping.
 */
function profileWithChapters() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-e2e-'))
  const meta = path.join(home, 'chapters.ffmeta')
  fs.writeFileSync(
    meta,
    [
      ';FFMETADATA1',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=0',
      'END=60000',
      'title=Intro',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=60000',
      'END=180000',
      'title=Middle',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=180000',
      'END=560000',
      'title=End',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(home, 'mpv.conf'), `chapters-file=${meta.replace(/\\/g, '/')}\n`)
  return home
}

async function main() {
  if (!sample) throw new Error('no sample video under samples/; cannot drive playback')

  const home = profileWithChapters()
  // The packaged exe IS the app; the dev binary needs the app directory as argv[1].
  const launchArgs = PACKAGED ? [] : [repo]
  const child = spawn(
    electronBinary(),
    [...launchArgs, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', sample],
    {
      cwd: repo,
      env: { ...process.env, RLPLAYER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false
    }
  )
  console.log(
    `driving ${PACKAGED ? 'the PACKAGED build' : 'the dev build'} on a fresh profile at ${home}` +
      `\n  (its mpv.conf gives the sample 3 chapters, so M25's layer has something to draw)`
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
  console.log(`driving ${PRESSES} keypresses...`)
  process.on('uncaughtException', (e) => {
    console.error('main process log so far:\n' + mainLog.join(''))
    console.error(e)
    child.kill()
    process.exit(1)
  })
  /**
   * `--presses=N` drives the same keys N times. The default of 6 catches the
   * regression this file was written for -- one ArrowUp produced 32 errors in
   * 4 s and ~8/s forever after -- but §6.3's release bar is "0 console errors
   * over 300+ keypresses", and a leak that costs one error per hundred presses
   * is invisible at six. `--presses=300` before a tag.
   */
  const KEYS = [
    ['ArrowUp', 'ArrowUp', 38],
    ['ArrowDown', 'ArrowDown', 40],
    ['ArrowRight', 'ArrowRight', 39],
    ['ArrowLeft', 'ArrowLeft', 37],
    ['KeyM', 'm', 77],
    ['KeyM', 'm', 77],
    // Tab and the arrows now reach the seek-bar layer host (rule 4), so the
    // focus walk is on the hot path and belongs in the soak.
    ['Tab', 'Tab', 9],
    ['ArrowRight', 'ArrowRight', 39],
    ['Escape', 'Escape', 27]
  ]
  for (let i = 0; i < PRESSES; i++) {
    const k = KEYS[i % KEYS.length]
    await pressKey(s, k[0], k[1], k[2])
    // Fast enough to be a soak, slow enough that the main process actually
    // handles each one rather than coalescing them in the queue.
    await sleep(PRESSES > 50 ? 20 : 200)
  }
  await sleep(500)

  console.log(`after input: watching for ${WINDOW_S}s...`)
  errors.length = 0
  await sleep(WINDOW_S * 1000)
  const after = errors.splice(0).slice()

  // Prove the overlay is still alive rather than merely quiet: a dead renderer
  // also produces zero errors.
  /**
   * The seek bar, driven for real.
   *
   * A pointermove over the middle of the bar has to produce a tooltip built from
   * MORE THAN ONE fragment -- core's timecode plus at least the chapter layer's
   * -- and Tab has to land on a contributed handle. Both were true of the unit
   * tests and false of the shipped overlay: `SeekbarHost.tooltips()`, `.key()`
   * and `.focusHandle()` had no production call sites at all, and `main.ts`
   * returned early on every arrow key inside a range input, which the seek bar
   * is. This is the assertion a unit test structurally cannot make.
   */
  const probe = await s.send('Runtime.evaluate', {
    expression: `(() => {
      const seek = document.getElementById('seek')
      const r = seek.getBoundingClientRect()
      const at = (frac) => new PointerEvent('pointermove', {
        clientX: r.left + r.width * frac, clientY: r.top + r.height / 2, bubbles: true
      })
      // Sweep: a chapter tick is a few pixels wide, so one sample can miss it.
      let tipFragments = 0
      for (let i = 1; i < 40; i++) {
        seek.dispatchEvent(at(i / 40))
        const n = document.getElementById('seekHover')?.childElementCount ?? 0
        if (n > tipFragments) tipFragments = n
      }
      seek.focus()
      let focusables = 0
      for (let i = 0; i < 8; i++) {
        seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        if (seek.dataset.seekHandle) focusables++
      }
      return JSON.stringify({
        panels: document.querySelectorAll('#panelRoot .panel').length,
        layers: document.querySelectorAll('#seekLayers > *').length,
        transportButtons: document.querySelectorAll('#transportExtras [data-transport-button]').length,
        ticks: document.querySelectorAll('#seekLayers .seek-chapter-tick').length,
        tipFragments,
        focusables,
        title: document.getElementById('mediaTitle')?.textContent ?? '',
        time: document.getElementById('timeNow')?.textContent ?? '',
        duration: document.getElementById('timeTotal')?.textContent ?? ''
      })
    })()`,
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
  let orphans = []
  let ourMpv = []
  let quitMs = -1
  let hadToKill = false
  if (!KEEP) {
    // The pids THIS app spawned, recorded while it is still running to be an
    // ancestor of them. Anything else on the machine is somebody else's.
    ourMpv = child.pid === undefined ? [] : snapshot(child.pid)
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
    // …AND THE LINE BELOW IT, which lied differently: it was
    // `countMpv() - (mpvBefore - 1)`, a delta over a machine-wide count, so an
    // unrelated mpv exiting in this same window cancelled a real orphan out.
    orphans = orphansAfterQuit(ourMpv, listProcesses())
    s.close()
  }

  console.log('\n--- results ---')
  console.log(`errors during startup       : ${started}`)
  console.log(`errors in ${WINDOW_S}s before input : ${before.length}`)
  console.log(`errors in ${WINDOW_S}s after input  : ${after.length}  (after ${PRESSES} presses)`)
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
  console.log(
    `mpv spawned / orphaned      : ${ourMpv.length} / ${orphans.length}` +
      (orphans.length > 0 ? ` (pid ${orphans.join(', ')})` : '') +
      `  [${machineWideMpvCount(listProcesses())} mpv.exe on this machine, ` +
      `attribution by ParentProcessId]`
  )
  console.log(`chapter ticks drawn         : ${dom.ticks}`)
  console.log(`seek tooltip fragments      : ${dom.tipFragments}`)
  console.log(`transport buttons mounted   : ${dom.transportButtons}`)
  console.log(`seek-bar handles Tab reaches: ${dom.focusables}`)
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
  if (orphans.length > 0) {
    failures.push(
      `${orphans.length} orphaned mpv.exe after a graceful quit: pid ${orphans.join(', ')}. ` +
        `Attributed by ParentProcessId, so an mpv from another checkout is not one of them.`
    )
  }
  // A1's wiring, in the packaged build. `tooltips()`, `key()` and
  // `focusHandle()` were implemented, documented and unit-tested while having
  // ZERO production call sites -- a unit test cannot tell you that, because the
  // unit test WAS the only caller.
  if (dom.transportButtons === 0) {
    failures.push('no contributed transport button mounted (ctx.transportButton is dead)')
  }
  if (dom.ticks < 3) {
    failures.push(
      `${dom.ticks} chapter ticks on the bar; the profile's mpv.conf asks for 3. Without them ` +
        `every seek-bar assertion below is vacuously true, so this is checked FIRST.`
    )
  }
  if (dom.tipFragments < 2) {
    failures.push(
      `the seek tooltip composed ${dom.tipFragments} fragment(s); core's timecode plus at ` +
        `least one layer's is 2. A single fragment means main.ts is assigning the readout ` +
        `again and the layers' tooltip() is dead code, which is how it shipped.`
    )
  }
  if (dom.focusables === 0) {
    failures.push(
      'Tab reaches no seek-bar handle, so host rule 4 (keyboard equivalence) is unsatisfiable ' +
        'again -- which is what main.ts:464 returning early on arrows made it'
    )
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
