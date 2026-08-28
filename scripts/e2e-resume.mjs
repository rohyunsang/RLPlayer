#!/usr/bin/env node
/**
 * The v0.1.0 resume guarantee, driven end to end against the PACKAGED build.
 *
 * WHY IT EXISTS. Giving `seek` an owner (§3.7, so M25 cannot seek behind M24's
 * back) immediately broke resume, and nothing caught it:
 *
 *   - `['seek', 200, 'absolute+exact']` implies a write to `time-pos`;
 *   - M28's four seek call sites did not own the command, so they were refused;
 *   - in a PACKAGED build a refusal is dropped, not thrown (§3.5 rule 5);
 *   - and every one of those call sites had `.catch(() => undefined)` on it.
 *
 * So the app opened a file, silently did not seek, silently stored nothing, and
 * every unit test, grep and partition check stayed green. It was found by
 * launching the packaged app, seeking, quitting, and looking at `resume.json`,
 * which is exactly what this script does.
 *
 * `src/main/services/resume-rules.test.ts` covers the thresholds. This covers
 * the part unit tests structurally cannot: that the write actually reaches mpv,
 * that the position survives a real quit, and that it is applied on reopen.
 *
 * Run:  node scripts/e2e-resume.mjs
 * Windows, needs a desktop session and a packaged build. It IS in CI now, in
 * the same job that packages the app and drives the overlay over CDP.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The same preference order `make:sample` and `lib/drive.mjs` use. */
function resolveSample() {
  for (const rel of ['samples/bbb_long.mp4', 'samples/bbb.mp4']) {
    const abs = path.join(repo, rel)
    if (fs.existsSync(abs)) return abs
  }
  console.error(
    `no sample video: looked for samples/bbb_long.mp4 and samples/bbb.mp4. ` +
      `Run \`npm run make:sample\`.`
  )
  process.exit(1)
}

/** Duration in seconds, from the pinned mpv rather than from an assumption. */
function probeDuration(file) {
  const mpv = [
    path.join(repo, 'dist', 'win-unpacked', 'resources', 'mpv', 'mpv.exe'),
    path.join(repo, 'resources', 'mpv', 'mpv.exe')
  ].find((p) => fs.existsSync(p))
  if (!mpv) {
    console.error('no mpv binary to probe the sample with; run npm run fetch:mpv')
    process.exit(1)
  }
  const out = execFileSync(
    mpv,
    [
      '--no-config',
      '--vo=null',
      '--ao=null',
      '--frames=1',
      '--term-playing-msg=RLDUR=${=duration}',
      file
    ],
    { encoding: 'utf8', cwd: repo }
  )
  const m = /RLDUR=([0-9.]+)/.exec(out)
  if (!m) {
    console.error(`mpv did not report a duration for ${file}`)
    process.exit(1)
  }
  return Number(m[1])
}
const exe = path.join(repo, 'dist', 'win-unpacked', 'RLPlayer.exe')
const PORT = 9444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(exe)) {
  console.error(`no packaged build at ${exe}. Run: npm run build && npx electron-builder --win --dir`)
  process.exit(1)
}

/**
 * THE SEEK TARGET IS DERIVED FROM THE FILE, not hardcoded at 200 s.
 *
 * It was 200, with the only guard being `existsSync('samples/bbb_long.mp4')`
 * and a message claiming the file is "longer than 200s" that nothing checked.
 * `scripts/make-sample.mjs` -- the script a fresh checkout or a CI runner has to
 * use, because `samples/` is gitignored -- produces a 200 SECOND file named
 * `bbb.mp4`. So this suite could not run there twice over: wrong name, and a
 * seek target at the exact end of the file.
 *
 * And 200 s in a 200 s file is not merely "the end", it is outside the resumable
 * window by design: `src/main/services/resume-rules.ts` refuses to remember a
 * position in the last max(90 s, 5%) of a file, because reaching the end means
 * finished. A hardcoded target that lands there would have produced a red run
 * reading `resume.json: 0 entries` and looked exactly like the regression this
 * script was written to catch.
 *
 * So: ask mpv for the duration, compute the window the rules actually allow, and
 * refuse a file too short for one rather than guessing. On the 596 s Big Buck
 * Bunny this still picks 200, so a local run is byte-for-byte what it was.
 */
const sample = resolveSample()
const duration = probeDuration(sample)
const END_MARGIN = Math.max(90, duration * 0.05) // resume-rules.ts
const LO = 75 // > MIN_RESUME_SECONDS (60), with room for this script's +/-15
const HI = duration - END_MARGIN - 15
if (!(HI > LO)) {
  console.error(
    `${path.relative(repo, sample)} is ${duration.toFixed(1)}s long, which leaves no resumable ` +
      `window: resume-rules.ts wants a position above ${LO}s and below ` +
      `${(duration - END_MARGIN).toFixed(1)}s. Use a longer sample.`
  )
  process.exit(1)
}
const SEEK_TO = Math.min(200, Math.floor((LO + HI) / 2))

// A profile of its own, so a developer's real resume history is neither read
// nor written, and run 1 genuinely starts from nothing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-resume-'))

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

async function openSession(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  return {
    send: (method, params = {}) =>
      new Promise((res) => {
        const i = ++id
        pending.set(i, res)
        ws.send(JSON.stringify({ id: i, method, params }))
      }),
    close: () => ws.close()
  }
}

async function launch(label) {
  const child = spawn(
    exe,
    [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', sample],
    { env: { ...process.env, RLPLAYER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let overlay = null
  for (let i = 0; i < 120 && !overlay; i++) {
    try {
      overlay = (await targets()).find((t) => t.url.includes('index.html'))
    } catch {
      /* devtools endpoint not up yet */
    }
    if (!overlay) await sleep(250)
  }
  if (!overlay) {
    child.kill()
    throw new Error(`${label}: the overlay never appeared`)
  }
  const s = await openSession(overlay.webSocketDebuggerUrl)
  // Playback has to have actually started: property writes made before
  // `playback-restart` are dropped by mpv (§3.3.1).
  await sleep(3000)
  return { child, s }
}

/** Seconds on the overlay clock, read from the DOM the user reads. */
async function positionSeconds(s) {
  const r = await s.send('Runtime.evaluate', {
    expression: `document.getElementById('timeNow').textContent`,
    returnByValue: true
  })
  const [m, sec] = String(r.result?.value ?? '0:00').split(':')
  return Number(m) * 60 + Number(sec)
}

async function quit(child, s, label) {
  /**
   * NOT `await`ed, and that is the fix for an intermittent exit-13 hang.
   *
   * `window.rlplayer.window.close()` destroys the page this very evaluate was
   * sent to, so whether a CDP response ever comes back is a race with the
   * renderer's teardown. Awaiting it hung 2 runs in 5 -- Node's
   * "unsettled top-level await", which exits 13 having lost every buffered
   * console.log, so the run looked like a silent failure with no output at all.
   * A harness whose own quit path can hang is the quit-timer lesson again: what
   * is being measured is the app's exit, which the loop below measures directly
   * from `child.exitCode`.
   */
  s.send('Runtime.evaluate', { expression: 'window.rlplayer.window.close()' }).catch(
    () => undefined
  )
  for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250)
  s.close()
  if (child.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    throw new Error(`${label}: the app did not quit; nothing measured after this is evidence`)
  }
  await sleep(1000)
}

const failures = []

// --- run 1: seek, then quit the way a user does ----------------------------
{
  const { child, s } = await launch('run 1')
  await s.send('Runtime.evaluate', {
    expression: `window.rlplayer.action({ type: 'seek', seconds: ${SEEK_TO}, absolute: true })`
  })
  await sleep(2500)
  const pos = await positionSeconds(s)
  console.log(`run 1: seeked to ${SEEK_TO}s, clock reads ${pos}s`)
  if (Math.abs(pos - SEEK_TO) > 15) {
    failures.push(
      `the seek did not land: asked for ${SEEK_TO}s, clock reads ${pos}s. In a packaged ` +
        `build an ownership refusal is DROPPED, so a seek that is refused looks exactly ` +
        `like this and logs nothing.`
    )
  }
  await quit(child, s, 'run 1')
}

// --- the store ------------------------------------------------------------
const resumeFile = path.join(home, 'resume.json')
const stored = fs.existsSync(resumeFile) ? JSON.parse(fs.readFileSync(resumeFile, 'utf8')) : null
const entries = Object.values(stored?.entries ?? {})
console.log(`resume.json: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
if (entries.length !== 1) {
  failures.push(
    `resume.json holds ${entries.length} entries after watching past the 60 s threshold; ` +
      `expected exactly 1`
  )
}

// --- run 2: reopen the same file and expect to land there ------------------
{
  const { child, s } = await launch('run 2')
  const pos = await positionSeconds(s)
  console.log(`run 2: reopened the same file, clock reads ${pos}s`)
  if (Math.abs(pos - SEEK_TO) > 20) {
    failures.push(`resume did not apply: expected ~${SEEK_TO}s on reopen, got ${pos}s`)
  }
  await quit(child, s, 'run 2')
}

fs.rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('\ne2e-resume FAILED:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('\ne2e-resume: clean')
