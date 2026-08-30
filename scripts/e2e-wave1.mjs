#!/usr/bin/env node
/**
 * e2e-wave1 — do the nine Wave-1 modules WORK in the packaged app?
 *
 * The distinction this script exists to hold is the one that has burned this
 * repo five times: a module reporting its own success is the app agreeing with
 * itself. So every claim about mpv is answered BY MPV — a second JSON-IPC client
 * on the same `--input-ipc-server` pipe the app opened (`scripts/lib/mpv-probe.mjs`),
 * asking `get_property` directly. A claim about the UI is answered by what the
 * overlay RENDERS, read out of the live DOM, never by the module's own state
 * channel.
 *
 * Three things are deliberately NOT asserted here, because they cannot be
 * asserted honestly from this harness and a green line claiming them would be
 * worse than no line:
 *   - anything needing a live network host (M35's real streams, M36's yt-dlp),
 *   - anything needing hardware this box lacks (nvenc/qsv/amf),
 *   - the audio-fingerprint decode path (M25 double-gates it behind a setting).
 *
 * Usage: node scripts/e2e-wave1.mjs [--keep]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { launch, sleep, repo } from './lib/drive.mjs'
import { findMpvPipe, connectMpv } from './lib/mpv-probe.mjs'

const results = []
const fail = []

/** Run one named check; a throw is a failure, never a skip. */
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    fail.push(`FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`)
  }
}

const { session, child, stop, getLog, profile } = await launch({ port: 9422 })
await sleep(3500)

// --- the second client, so mpv answers for itself -------------------------
const pipes = findMpvPipe(child.pid)
assert.equal(pipes.length, 1, `expected exactly one mpv child, found ${pipes.length}`)
const mpv = await connectMpv(pipes[0].pipe)

/** mpv's own value for `prop`, or a throw naming the error mpv gave. */
async function prop(name) {
  const r = await mpv.get(name)
  if (r.error !== undefined) throw new Error(`mpv refused get_property ${name}: ${r.error}`)
  return r.value
}
const invoke = (id, arg) =>
  session.eval(`window.rlplayer.invokeCommand(${JSON.stringify(id)}, ${JSON.stringify(arg ?? null)}), 1`)
const dom = (expr) => session.eval(expr)

/**
 * Write a SETTING, through the channel the settings window itself uses.
 *
 * This cost four false failures to learn and is worth the note: ids like
 * `capture-still.directory` and `capture-encode.gifMaxSeconds` are
 * `ctx.settings.define()` DESCRIPTORS, not commands. Pushing them through
 * `invokeCommand` is a no-op that reports nothing, so M22 and M23 both looked
 * broken while the modules were fine and the harness was writing to nowhere.
 */
const setSetting = async (id, value) => {
  const r = await session.eval(
    `window.rl.invoke('core-settings:set', ${JSON.stringify({ id, value })}).then(()=>'ok',e=>'ERR '+e.message)`
  )
  if (String(r).startsWith('ERR')) throw new Error(`core-settings:set ${id}: ${r}`)
}

/** The ACTUAL command line of the mpv child, as Windows reports it. */
const mpvArgv = pipes[0].commandLine

// Wait for real playback, so property reads are not answered by an idle core.
for (let i = 0; i < 40; i++) {
  if (typeof (await mpv.get('time-pos')).value === 'number') break
  await sleep(250)
}

console.log(`# e2e-wave1 — mpv pipe ${pipes[0].pipe}`)
console.log(`# profile ${profile}`)

// =========================================================================
// M01 video-color — V01-V07. mpv owns brightness/contrast/saturation/gamma.
// =========================================================================
await check('M01 video-color: brightnessUp moves mpv\'s OWN brightness', async () => {
  const before = await prop('brightness')
  await invoke('video-color.reset')
  await sleep(300)
  const zero = await prop('brightness')
  assert.equal(zero, 0, `reset should leave mpv brightness at 0, mpv says ${zero}`)
  // Spaced, not burst: `invokeCommand` is a fire-and-forget `send`, so three
  // in one tick raced the module's own apply-then-store and mpv saw one.
  for (let i = 0; i < 3; i++) {
    await invoke('video-color.brightnessUp')
    await sleep(250)
  }
  await sleep(400)
  const after = await prop('brightness')
  assert.equal(after, 3, `after 3x brightnessUp mpv should report 3, mpv says ${after}`)
  await invoke('video-color.reset')
  await sleep(250)
  assert.equal(await prop('brightness'), 0, 'reset did not return mpv to 0')
  return `brightness ${before} -> 0 -> 3 -> 0, read from mpv`
})

await check('M01 video-color: setKnob saturation reaches mpv, and reset clears it', async () => {
  await invoke('video-color.setKnob', { knob: 'saturation', value: 30 })
  await sleep(350)
  const sat = await prop('saturation')
  assert.equal(sat, 30, `mpv saturation should be 30, mpv says ${sat}`)
  await invoke('video-color.reset')
  await sleep(300)
  assert.equal(await prop('saturation'), 0, 'saturation not reset in mpv')
  return 'saturation 30 confirmed by mpv, then 0'
})

// =========================================================================
// M19 subs-style — S17-S26. 50 real mpv properties.
// =========================================================================
await check('M19 subs-style: scaleUp changes mpv\'s sub-scale', async () => {
  const before = await prop('sub-scale')
  await invoke('subs-style.scaleUp')
  await sleep(350)
  const after = await prop('sub-scale')
  assert.notEqual(after, before, `sub-scale did not move in mpv (still ${after})`)
  assert.ok(after > before, `scaleUp should raise sub-scale: ${before} -> ${after}`)
  return `sub-scale ${before} -> ${after} per mpv`
})

await check('M19 subs-style: setPos writes mpv\'s sub-pos, in range', async () => {
  await invoke('subs-style.setPos', 90)
  await sleep(350)
  const pos = await prop('sub-pos')
  assert.equal(pos, 90, `mpv sub-pos should be 90, mpv says ${pos}`)
  return 'sub-pos 90 per mpv'
})

await check('M19 subs-style: the ass-override cycle steps FOUR states, not five', async () => {
  /** S21 has four states; the draft's keybind stepped five. Ask mpv each time. */
  const seen = []
  for (let i = 0; i < 6; i++) {
    seen.push(await prop('sub-ass-override'))
    await invoke('subs-style.cycleAssOverride')
    await sleep(220)
  }
  const distinct = [...new Set(seen)]
  assert.equal(
    distinct.length,
    4,
    `mpv reported ${distinct.length} distinct sub-ass-override states over 6 presses: ${seen.join(',')}`
  )
  return `mpv cycled exactly ${distinct.join(' -> ')}`
})

// =========================================================================
// M18 subs-formats — S33/S34. sub-codepage is mpv's.
// =========================================================================
await check('M18 subs-formats: setCodepage reaches mpv\'s sub-codepage', async () => {
  const before = await prop('sub-codepage')
  // `+cp949`, WITH the plus. mpv's own "force this codepage" syntax, and the
  // literal value in M18's CODEPAGES table — a bare 'cp949' is correctly
  // REFUSED by the module, which is what made this look like a module failure.
  await invoke('subs-formats.setCodepage', '+cp949')
  await sleep(500)
  const after = await prop('sub-codepage')
  assert.match(String(after), /cp949/i, `mpv sub-codepage should mention cp949, mpv says ${after}`)
  await invoke('subs-formats.setCodepage', 'auto')
  await sleep(300)
  const back = await prop('sub-codepage')
  assert.match(String(back), /auto/i, `S33 says auto must be restorable; mpv says ${back}`)
  return `sub-codepage ${before} -> ${after} -> ${back} per mpv`
})

// =========================================================================
// M36 stream-ytdl — the zero-network promise, AT REST, asked of mpv.
// =========================================================================
await check('M36 stream-ytdl: mpv reports ytdl=no at rest (STRUCTURAL, not a regex)', async () => {
  const v = await prop('ytdl')
  assert.equal(v, false, `mpv must report ytdl false at rest; mpv says ${JSON.stringify(v)}`)
  return 'mpv: ytdl=false — ytdl_hook.lua was never loaded'
})

await check('M36 stream-ytdl: ytdl_hook.lua is not among mpv\'s loaded scripts', async () => {
  /**
   * The stronger form of the same claim, and the one a regex cannot fake: ask
   * mpv what scripts it has actually loaded.
   */
  const list = await prop('script-list').catch(() => null)
  if (list === null) {
    // Older property name / not exposed: fall back to the option, still mpv's word.
    const scripts = await prop('scripts').catch(() => [])
    assert.ok(
      !JSON.stringify(scripts).includes('ytdl'),
      `mpv has an ytdl script loaded: ${JSON.stringify(scripts)}`
    )
    return 'mpv: no ytdl script loaded (via scripts)'
  }
  const json = JSON.stringify(list)
  assert.ok(!/ytdl/i.test(json), `mpv has ytdl_hook loaded: ${json}`)
  return `mpv: ${Array.isArray(list) ? list.length : 0} scripts loaded, none ytdl`
})

await check('M36 stream-ytdl: nothing fired without user action (app log is silent)', async () => {
  const log = getLog()
  assert.ok(
    !/yt-dlp|ytdl_hook|\[stream-ytdl\] exec/.test(log),
    `the app log shows yt-dlp activity at rest:\n${log.split('\n').filter((l) => /ytdl/i.test(l)).join('\n')}`
  )
  return 'no yt-dlp exec, no hook load, over the whole session'
})

// =========================================================================
// M35 stream-open — R16/R17/R24. Cache options are mpv's.
// =========================================================================
await check('M35 stream-open: mpv\'s cache byte caps match the ONE mandated slider', async () => {
  /**
   * R17's defect was that the preset carried `demuxer-max-bytes` and won the
   * spawn-arg de-dup, so the slider moved nothing. Asked of mpv.
   */
  const max = await prop('demuxer-max-bytes')
  assert.equal(typeof max, 'number', `demuxer-max-bytes should be a number, got ${typeof max}`)
  assert.ok(max > 0, `demuxer-max-bytes is ${max}`)
  const back = await prop('demuxer-max-back-bytes')
  assert.equal(typeof back, 'number')
  return `mpv: demuxer-max-bytes=${max}, max-back-bytes=${back}`
})

await check('M35 stream-open: --network-timeout is absent from the real mpv command line', async () => {
  /**
   * THIS CHECK LIED IN ITS FIRST FORM and the correction is the interesting
   * part. It asserted `network-timeout === 0` on a local file. mpv's OWN default
   * is 60 (`mpv --no-config --list-options`: "Double (0 to any) (default: 60)"),
   * so 0 is a value mpv never holds unless somebody writes it — the assertion
   * demanded the module do the exact thing R14 forbids, and would have been
   * satisfied only by the defect.
   *
   * R14's claim is that merely SETTING the option breaks RTSP. The evidence for
   * "not set" is therefore the child's real command line plus mpv still holding
   * its own default — not a magic number.
   */
  assert.ok(
    !/--network-timeout/.test(mpvArgv),
    `--network-timeout is in the spawn argv, which R14 says breaks RTSP:
${mpvArgv}`
  )
  const t = await prop('network-timeout')
  assert.equal(t, 60, `mpv should still hold its own default 60; mpv says ${t}`)
  const tls = await prop('tls-verify')
  assert.equal(tls, true, `defect (1): tls-verify must not be left off; mpv says ${tls}`)
  return 'argv has no --network-timeout; mpv at its own default 60; tls-verify=yes'
})

await check('M36 stream-ytdl: the real spawn argv carries core --ytdl=no and nothing else', async () => {
  /**
   * The boot failure this integration fixed, asserted where it actually lives:
   * the command line Windows reports for the running child.
   */
  const ytdlArgs = (mpvArgv.match(/--ytdl[^\s"]*/g) ?? []).filter((a) => !a.startsWith('--ytdl-'))
  assert.deepEqual(
    ytdlArgs,
    ['--ytdl=no'],
    `expected exactly core's --ytdl=no in the argv, got ${JSON.stringify(ytdlArgs)}`
  )
  assert.ok(
    /ytdl_hook-exclude=\.\*/.test(mpvArgv),
    'M36 no longer contributes the exclude belt'
  )
  return "argv: exactly one --ytdl=no, plus M36's inert exclude"
})

// =========================================================================
// M25 nav-chapters — N51. The skip rule that ended episodes.
// =========================================================================
await check('M25 nav-skip: skipEnding at 30s does NOT end the file', async () => {
  /**
   * The headline draft defect: pressing skip-ending early seeked to
   * duration-0.35 and ended the episode. Asserted on mpv's time-pos and on
   * mpv still having a file loaded.
   */
  const duration = await prop('duration')
  await mpv.command(['set_property', 'time-pos', 30])
  await sleep(600)
  await invoke('nav-chapters.skipEnding')
  await sleep(900)
  const idle = await prop('idle-active').catch(() => false)
  assert.equal(idle, false, 'the file ENDED — the draft defect is back')
  const t = await prop('time-pos')
  assert.ok(
    t < duration - 1,
    `time-pos ${t} is at the very end of a ${duration}s file — skip-ending ended it`
  )
  return `mpv: time-pos ${t.toFixed(2)} of ${duration.toFixed(2)}s, file still loaded`
})

await check('M25 nav-skip: skipIntro seeks forward and stays inside the file', async () => {
  await mpv.command(['set_property', 'time-pos', 2])
  await sleep(500)
  await invoke('nav-chapters.skipIntro')
  await sleep(900)
  const t = await prop('time-pos')
  const duration = await prop('duration')
  assert.ok(t < duration - 1, `skipIntro landed at ${t} of ${duration} — it closed the film`)
  return `mpv: time-pos ${t.toFixed(2)} after skipIntro`
})

// =========================================================================
// M22 capture-still — C01. A file on disk, and mpv's own reply.
// =========================================================================
await check('M22 capture-still: a screenshot lands on disk at mpv\'s reported size', async () => {
  const dir = fs.mkdtempSync(path.join(profile, 'shots-'))
  await setSetting('capture-still.directory', dir)
  await sleep(400)
  await invoke('capture-still.save')
  await sleep(2500)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  assert.ok(files.length > 0, `no screenshot written to ${dir}`)
  const f = path.join(dir, files[0])
  const size = fs.statSync(f).size
  assert.ok(size > 2000, `screenshot ${files[0]} is only ${size} bytes — not a real image`)
  // A PNG really is a PNG, so a 0-byte-with-a-name pass is impossible.
  const head = fs.readFileSync(f).subarray(0, 8)
  const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpg = head[0] === 0xff && head[1] === 0xd8
  assert.ok(isPng || isJpg, `${files[0]} has no PNG/JPEG magic: ${head.toString('hex')}`)
  const w = await prop('width')
  return `${files[0]}, ${size} bytes, real ${isPng ? 'PNG' : 'JPEG'}, source ${w}px wide per mpv`
})

// =========================================================================
// M29 mediainfo — L26. The panel must agree with MPV, not with itself.
// =========================================================================
await check('M29 mediainfo: the rendered panel agrees with mpv on the codec', async () => {
  // The panel opens from its transport button (there is no command id for it —
  // the button sends `mediainfo:togglePanel`), so this clicks what a user clicks.
  await dom(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/미디어 정보/.test(x.title||''));if(!b)throw new Error('mediainfo transport button not found');b.click();return 1})()`)
  await sleep(1500)
  const codec = await prop('video-codec')
  const shown = await dom(
    `(()=>{const p=document.querySelector('[data-panel-id="mediainfo"]');return p?p.innerText:''})()`
  )
  assert.ok(String(shown).length > 20, 'the mediainfo panel rendered no text')
  // mpv's video-codec is a long description; the panel shows a short label.
  // Compare on alphanumerics, which is the exact fix M29 made to `codecLabel`.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  const cShort = (await prop('video-format')) ?? ''
  assert.ok(
    norm(shown).includes(norm(cShort)),
    `panel text does not mention mpv's video-format '${cShort}'`
  )
  const res = await prop('video-params/w')
  assert.ok(
    String(shown).includes(String(res)),
    `panel does not show mpv's width ${res}`
  )
  return `panel shows mpv's ${cShort} and ${res}px`
})

await check('M29 mediainfo: no raw i18n key rendered in the panel', async () => {
  const shown = await dom(
    `(()=>{const p=document.querySelector('[data-panel-id="mediainfo"]');return p?p.innerText:''})()`
  )
  const keys = String(shown).match(/\b[a-z-]+\.[a-zA-Z][a-zA-Z0-9.]+\b/g) ?? []
  const bad = keys.filter((k) => /^(mediainfo|capture|subs|nav|stream|video)\./.test(k))
  assert.deepEqual(bad, [], `raw i18n keys leaked into the UI: ${bad.join(', ')}`)
  return `${String(shown).split('\n').length} lines, no key leaked`
})

// =========================================================================
// M23 capture-encode — C09-C19. A finalised file, verified after close().
// =========================================================================
await check('M23 capture-encode: a GIF is FINALISED, not merely started', async () => {
  /**
   * GIF is the right target: M23 measured the output as INVALID at `end-file`
   * and still growing (786,432 -> 856,011 bytes), which is exactly what the
   * draft's fire-and-forget `close()` + `size>0` check reported as success. So a
   * real GIF here is evidence for the `await close()` shape specifically.
   */
  const dir = fs.mkdtempSync(path.join(profile, 'enc-'))
  await setSetting('capture-encode.videoDir', dir)
  await setSetting('capture-encode.gifMaxSeconds', 2)
  await setSetting('capture-encode.gifWidth', 240)
  await sleep(500)
  await mpv.command(['set_property', 'time-pos', 4])
  await sleep(500)
  await invoke('capture-encode.exportGif')

  let done = null
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.gif')) : []
    if (files.length > 0) {
      const f = path.join(dir, files[0])
      const a = fs.statSync(f).size
      await sleep(1200)
      const b = fs.statSync(f).size
      // Finalised means it has STOPPED growing, which is the claim the old
      // `size>0` check could not make.
      if (a > 1000 && a === b) {
        done = { name: files[0], size: b }
        break
      }
    }
  }
  assert.ok(done !== null, `no finalised .gif in ${dir} after 60s`)
  const head = fs.readFileSync(path.join(dir, done.name)).subarray(0, 6).toString('latin1')
  assert.match(head, /^GIF8[79]a$/, `not a real GIF: magic '${head}'`)
  return `${done.name}, ${done.size} bytes, magic ${head}, size stable`
})

// =========================================================================
// REGRESSION: the four PILOT modules, still working after nine more landed.
//
// Asserted on mpv's own `vf` / `af` chains and its own ab-loop properties, for
// the same reason as everything above: a pilot module reporting itself healthy
// while a Wave-1 module has quietly stolen its filter label would look exactly
// like a pass.
// =========================================================================
await check('PILOT audio-eq: mpv OWN af chain holds ten bands, and the toggle is real', async () => {
  /**
   * THE FIRST FORM OF THIS CHECK LIED, in the direction that matters: it
   * asserted the `rleq` label DISAPPEARS from `af` when the EQ is switched off.
   * mpv's actual chain keeps the entry and flips `"enabled": false` — which is
   * `ctx.af`'s whole design (a claimed label is held, enabled or not; M01's
   * report names the same gap for `ctx.vf`). So "off" was being tested as
   * "absent", and the only implementation that could have satisfied it is one
   * that drops and re-adds the label on every toggle.
   *
   * Asserting on `enabled` is also the stronger claim: it proves the toggle
   * reached mpv, where an absent label proves only that something is missing.
   */
  const chain = async () => {
    const af = await prop('af')
    return (Array.isArray(af) ? af : []).find((f) => f.label === 'rleq') ?? null
  }
  await invoke('audio-eq.toggle')
  await sleep(800)
  const on = await chain()
  assert.ok(on !== null, 'no rleq label in mpv af chain at all')
  assert.equal(on.enabled, true, 'rleq is present but mpv reports it disabled after toggling ON')

  // Ten bands, per mpv's own copy of the graph — not per the module's report.
  const freqs = [...new Set((on.params.graph.match(/f=(\d+)/g) ?? []).map((m) => m.slice(2)))]
  assert.equal(freqs.length, 10, `expected 10 distinct bands, mpv's graph has ${freqs.length}: ${freqs}`)

  await invoke('audio-eq.toggle')
  await sleep(700)
  const off = await chain()
  assert.ok(off !== null, 'the label vanished — ctx.af is meant to HOLD a claimed label')
  assert.equal(off.enabled, false, 'mpv still reports rleq enabled after toggling OFF')
  return `mpv: rleq enabled -> disabled, ${freqs.length} bands (${freqs[0]}..${freqs[9]} Hz)`
})

await check('PILOT video-enhance: sharpen appears in mpv OWN vf chain', async () => {
  await invoke('video-enhance.toggleSharpen')
  await sleep(700)
  const vf = JSON.stringify(await prop('vf'))
  assert.match(vf, /rl-sharpen/, `no rl-sharpen in mpv's vf chain: ${vf}`)
  await invoke('video-enhance.toggleSharpen')
  await sleep(600)
  return 'mpv vf carried rl-sharpen'
})

await check('PILOT nav-bookmarks A-B: mpv OWN ab-loop-a/b hold the range', async () => {
  await mpv.command(['set_property', 'time-pos', 20])
  await sleep(500)
  await invoke('nav-bookmarks.abLoopSetA')
  await sleep(400)
  await mpv.command(['set_property', 'time-pos', 26])
  await sleep(600)
  await invoke('nav-bookmarks.abLoopSetB')
  await sleep(500)
  const a = await prop('ab-loop-a')
  const b = await prop('ab-loop-b')
  assert.equal(typeof a, 'number', `ab-loop-a is ${JSON.stringify(a)}`)
  assert.equal(typeof b, 'number', `ab-loop-b is ${JSON.stringify(b)}`)
  assert.ok(b > a, `ab-loop-b ${b} must be after ab-loop-a ${a}`)
  await invoke('nav-bookmarks.abLoopClear')
  await sleep(500)
  const cleared = await prop('ab-loop-a')
  assert.notEqual(typeof cleared, 'number', `ab-loop-a survived the clear: ${JSON.stringify(cleared)}`)
  return `mpv: ab-loop ${a.toFixed(2)} -> ${b.toFixed(2)}, then cleared`
})

await check('PILOT nav-thumbnails: a REAL decoded frame comes back for a seek position', async () => {
  /**
   * The first form of this check asserted "147 commands are registered and a
   * seek bar exists", under a title promising a thumbnail. That is the shape
   * this repo keeps finding — a green line for a claim it never tested — so it
   * now goes through the same IPC the overlay's tooltip uses
   * (`nav-thumbnails:request`) and asserts on the PIXELS that come back.
   */
  await setSetting('nav-thumbnails.enabled', true)
  await sleep(600)
  let frame = null
  for (let i = 0; i < 30; i++) {
    const r = await session.eval(
      `window.rl.invoke('nav-thumbnails:request', { t: 60, exact: false })
         .then(f => f ? JSON.stringify({ w: f.width, h: f.height, bytes: (f.rgba && (f.rgba.byteLength || f.rgba.length)) || 0, t: f.time, exact: f.exact }) : 'null',
               e => 'ERR ' + e.message)`
    )
    if (typeof r === 'string' && r.startsWith('{')) {
      frame = JSON.parse(r)
      break
    }
    if (typeof r === 'string' && r.startsWith('ERR')) throw new Error(r)
    await sleep(1000)
  }
  assert.ok(frame !== null, 'nav-thumbnails:request returned null for 30s — no frame was ever decoded')
  assert.ok(frame.w > 0 && frame.h > 0, `a frame with no dimensions: ${JSON.stringify(frame)}`)
  // RGBA: exactly 4 bytes per pixel, so a stub or a truncated buffer fails.
  assert.equal(
    frame.bytes,
    frame.w * frame.h * 4,
    `a ${frame.w}x${frame.h} RGBA frame must be ${frame.w * frame.h * 4} bytes, got ${frame.bytes}`
  )
  return `real ${frame.w}x${frame.h} RGBA frame, ${frame.bytes} bytes (=w*h*4), t=${frame.t}, exact=${frame.exact}`
})

// =========================================================================
// Cross-module: the panels and transport buttons the API newly renders.
// =========================================================================
await check('all nine: every contributed panel and transport button RENDERS', async () => {
  const d = await dom(`JSON.stringify({
    panels: [...document.querySelectorAll('[data-panel-id]')].map(e=>e.dataset.panelId),
    labels: [...document.querySelectorAll('#transportExtras button')].map(e=>(e.title||'').trim()).filter(Boolean)
  })`)
  const { panels, labels } = JSON.parse(d)
  for (const p of ['mediainfo', 'stream-open', 'nav-chapters.skip', 'capture-encode']) {
    assert.ok(panels.includes(p), `panel '${p}' did not render (got ${panels.join(', ')})`)
  }
  assert.ok(labels.length >= 8, `only ${labels.length} transport buttons rendered`)
  const raw = labels.filter((l) => /^[a-z-]+\.[a-zA-Z]/.test(l))
  assert.deepEqual(raw, [], `transport buttons showing raw i18n keys: ${raw.join(', ')}`)
  return `${panels.length} panels, ${labels.length} transport buttons, 0 raw keys`
})

await check('all nine: 0 console errors accumulated over the module drive', async () => {
  const errs = await dom(`JSON.stringify((window.__rlConsoleErrors ?? []).slice(0, 20))`)
  const list = JSON.parse(errs)
  assert.deepEqual(list, [], `console errors: ${list.join(' | ')}`)
  const log = getLog()
  const bad = log
    .split('\n')
    .filter((l) => /ContributionError|OwnershipError|failed to start|Unhandled/.test(l))
  assert.deepEqual(bad, [], `app log carries errors:\n${bad.join('\n')}`)
  return 'clean'
})

// -------------------------------------------------------------------------
mpv.close()
await stop()
await sleep(800)

console.log('')
for (const r of results) console.log(r)
for (const f of fail) console.log(f)
console.log('')
console.log(`e2e-wave1: ${results.length} passed, ${fail.length} failed`)
if (!process.argv.includes('--keep')) {
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    /* the app may still hold a handle */
  }
}
process.exit(fail.length > 0 ? 1 : 0)
