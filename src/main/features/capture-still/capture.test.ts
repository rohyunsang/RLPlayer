import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BURST_FRAME_GAP_MS,
  BURST_MAX_COUNT,
  BURST_MAX_INTERVAL_MS,
  BURST_MIN_INTERVAL_MS,
  CAPTURE_FORMATS,
  DEFAULT_TEMPLATE,
  RECENT_LIMIT,
  burstFraction,
  burstGapMs,
  burstStep,
  captureFlags,
  capturePlan,
  clampBurst,
  hasDisambiguator,
  isAbsoluteCapturePath,
  needsWindowVo,
  normalizeFormat,
  normalizeTemplate,
  popRecent,
  pushRecent,
  replyFilename,
  startBurst,
  tempCaptureName,
  templateSpecifiers,
  templateWarnings
} from './capture.ts'

/**
 * M22's own logic, exercised directly.
 *
 * None of these cases is "does the happy path work". Every one of them is a
 * value §2.4 says was MEASURED against the pinned mpv and that a reasonable
 * implementation gets wrong: a `screenshot` reply that is a bare relative
 * filename and not a path, a `screenshot-to-file` that refuses `scaled`, a
 * template with no `%n` that silently stops producing files because mpv will not
 * overwrite, and an `each-frame` flag that must not be reachable at all.
 */

// --- C01 / C02 / C04: the flag table --------------------------------------

test('the flag table is exactly §2.4 C01/C02/C04', () => {
  // C01: with subtitles, source resolution.
  assert.equal(captureFlags({ sink: 'template', scope: 'source', subs: true }), 'subtitles')
  // C02: without subtitles — unconditional, ignoring sub-visibility.
  assert.equal(captureFlags({ sink: 'template', scope: 'source', subs: false }), 'video')
  // C04: display resolution, with and without subtitles.
  assert.equal(
    captureFlags({ sink: 'template', scope: 'display', subs: true }),
    'scaled+subtitles'
  )
  assert.equal(captureFlags({ sink: 'template', scope: 'display', subs: false }), 'scaled')
})

test('screenshot-to-file never gets `scaled`, because it does not accept it (C04)', () => {
  /**
   * MEASURED: `scaled` and `osd` are not accepted by `screenshot-to-file`. The
   * only display-resolution flag it takes is `window`, which always carries the
   * OSD and whatever subtitles are on screen — so `subs` is not expressible
   * there, and the plan says so rather than quietly ignoring it.
   */
  for (const subs of [true, false]) {
    const flags = captureFlags({ sink: 'exact', scope: 'display', subs })
    assert.equal(flags, 'window')
    assert.ok(!flags.includes('scaled'), 'screenshot-to-file must never be sent `scaled`')
  }
  assert.equal(capturePlan({ sink: 'exact', scope: 'display', subs: true }).subsIgnored, true)
  assert.equal(capturePlan({ sink: 'template', scope: 'display', subs: true }).subsIgnored, false)
})

test('`each-frame` is unreachable (C08)', () => {
  /**
   * `["screenshot","video+each-frame"]` captures EVERY decoded frame with no
   * interval control: 150 five-megabyte PNGs in five seconds at 30 fps. There is
   * no input to `captureFlags` that produces it, and this test is what keeps it
   * that way when somebody adds a third scope.
   */
  for (const sink of ['template', 'exact'] as const) {
    for (const scope of ['source', 'display'] as const) {
      for (const subs of [true, false]) {
        assert.ok(!captureFlags({ sink, scope, subs }).includes('each-frame'))
      }
    }
  }
})

test('the window-VO requirement is per FLAG, not per scope', () => {
  assert.equal(needsWindowVo('scaled'), true)
  assert.equal(needsWindowVo('scaled+subtitles'), true)
  assert.equal(needsWindowVo('window'), true)
  assert.equal(needsWindowVo('video'), false)
  assert.equal(needsWindowVo('subtitles'), false)
  // A substring must not count: 'subtitles' contains neither flag as a term,
  // and a naive `flags.includes('window')` would be wrong the moment mpv grows
  // a flag with 'window' inside it.
  assert.equal(needsWindowVo('subtitles+video'), false)
})

test('every display plan has a source-resolution fallback, and source plans have none', () => {
  const display = capturePlan({ sink: 'template', scope: 'display', subs: true })
  assert.equal(display.flags, 'scaled+subtitles')
  assert.equal(display.fallbackFlags, 'subtitles')
  assert.equal(display.needsWindow, true)

  const source = capturePlan({ sink: 'template', scope: 'source', subs: false })
  assert.equal(source.flags, 'video')
  assert.equal(source.fallbackFlags, null, 'nothing weaker than `video` exists to fall back to')
  assert.equal(source.needsWindow, false)

  // The fallback keeps the SUBTITLE choice; only the resolution gives way.
  assert.equal(capturePlan({ sink: 'template', scope: 'display', subs: false }).fallbackFlags, 'video')
  assert.equal(capturePlan({ sink: 'exact', scope: 'display', subs: true }).fallbackFlags, 'subtitles')
})

// --- C01 / C20: the reply path -------------------------------------------

test('mpv’s bare relative reply is refused, not resolved (C01)', () => {
  /**
   * THE measurement this module is built around: with `screenshot-directory`
   * unset, `["screenshot","video"]` replies `{"filename":"mpv-shot0002.jpg"}` —
   * a bare name resolved against MPV's cwd. `shell.showItemInFolder` and the
   * toast both break on it, so it must never be mistaken for a path.
   */
  assert.equal(isAbsoluteCapturePath('mpv-shot0002.jpg'), false)
  assert.equal(replyFilename({ filename: 'mpv-shot0002.jpg' }).ok, false)
  assert.equal(
    (replyFilename({ filename: 'mpv-shot0002.jpg' }) as { reason: string }).reason,
    'relative'
  )

  // And the shapes that ARE usable, in both slash directions plus UNC.
  assert.equal(isAbsoluteCapturePath('C:/Users/x/Pictures/RLPlayer/a_01.png'), true)
  assert.equal(isAbsoluteCapturePath('C:\\Users\\x\\Pictures\\a_01.png'), true)
  assert.equal(isAbsoluteCapturePath('\\\\nas\\share\\a.png'), true)
  const ok = replyFilename({ filename: 'C:/shots/a_01.png' })
  assert.deepEqual(ok, { ok: true, filename: 'C:/shots/a_01.png' })
})

test('a dropped or empty reply is a normal branch, not a crash', () => {
  // In a packaged build an ownership refusal returns `undefined` rather than
  // throwing, and `screenshot-to-file` replies `null` by design.
  for (const reply of [undefined, null, {}, { filename: '' }, { filename: 42 }, 'x']) {
    const r = replyFilename(reply)
    assert.equal(r.ok, false, `${JSON.stringify(reply)} must not be treated as a filename`)
  }
  assert.equal((replyFilename(undefined) as { reason: string }).reason, 'no-reply')
  // A non-string filename is a malformed reply, not a relative path.
  assert.equal((replyFilename({ filename: 42 }) as { reason: string }).reason, 'relative')
})

// --- C05: the filename template ------------------------------------------

test('the specifier scanner skips `%%`, so `%%n` is not a counter', () => {
  /**
   * This is the whole reason the scanner is not a regex. `%%` is a literal
   * percent, so `shot%%n` contains NO `%n` — and a `/%[#0-9]*n/` test would say
   * it does, re-opening the "mpv will not overwrite" trap it exists to close.
   */
  assert.deepEqual(templateSpecifiers('shot%%n'), [])
  assert.equal(hasDisambiguator('shot%%n'), false)
  assert.equal(normalizeTemplate('shot%%n'), 'shot%%n_%#02n')

  assert.deepEqual(templateSpecifiers('%F_%wH.%wM.%wS.%wT_%#02n'), [
    'F',
    'wH',
    'wM',
    'wS',
    'wT',
    'n'
  ])
  assert.deepEqual(templateSpecifiers('%{media-title:untitled}-%p'), ['{media-title:untitled}', 'p'])
})

test('a template with no disambiguator gets a counter appended (C05)', () => {
  // MEASURED: if the template resolves to an existing file mpv will NOT
  // overwrite it — the capture silently does not happen.
  assert.equal(normalizeTemplate('%F'), '%F_%#02n')
  assert.equal(normalizeTemplate('shot'), 'shot_%#02n')
  // ...and one that already disambiguates is left exactly as the user wrote it.
  assert.equal(normalizeTemplate('%F-%n'), '%F-%n')
  assert.equal(normalizeTemplate('%F-%03n'), '%F-%03n')
  assert.equal(normalizeTemplate('%F-%wT'), '%F-%wT')
  assert.equal(normalizeTemplate(''), DEFAULT_TEMPLATE)
  assert.equal(normalizeTemplate('   '), DEFAULT_TEMPLATE)
  assert.equal(normalizeTemplate(undefined), DEFAULT_TEMPLATE)
  assert.equal(hasDisambiguator(DEFAULT_TEMPLATE), true, 'the default must not need patching')
})

test('the template warnings name the two undocumented mpv behaviours', () => {
  // OBSERVED AND UNDOCUMENTED: %p/%P expand with ':', which is illegal in a
  // Windows filename, and mpv silently substitutes '_'.
  assert.deepEqual(templateWarnings('%F-%p-%n'), ['colon-specifier'])
  assert.deepEqual(templateWarnings('%F-%P-%n'), ['colon-specifier'])
  // A colon the USER typed is a different problem with the same symptom.
  assert.ok(templateWarnings('%F 12:30 %n').includes('illegal-literal'))
  // The default is clean, and a bare name warns about the overwrite trap.
  assert.deepEqual(templateWarnings(DEFAULT_TEMPLATE), [])
  assert.deepEqual(templateWarnings('%F'), ['no-disambiguator'])
})

// --- C08: burst capture ---------------------------------------------------

test('burst configuration is clamped, and a garbage value does not disable it', () => {
  assert.deepEqual(clampBurst({ count: 10, intervalMs: 1000, mode: 'time' }), {
    count: 10,
    intervalMs: 1000,
    mode: 'time'
  })
  assert.equal(clampBurst({ count: 0 }).count, 1, 'a zero-frame burst is not a burst')
  assert.equal(clampBurst({ count: 100_000 }).count, BURST_MAX_COUNT)
  assert.equal(clampBurst({ intervalMs: 1 }).intervalMs, BURST_MIN_INTERVAL_MS)
  assert.equal(clampBurst({ intervalMs: 10 ** 9 }).intervalMs, BURST_MAX_INTERVAL_MS)
  assert.equal(clampBurst({ count: Number.NaN }).count, 10)
  assert.equal(clampBurst({ intervalMs: Number.NaN }).intervalMs, 1000)
  assert.equal(clampBurst({ mode: 'nonsense' as never }).mode, 'time')
  assert.equal(clampBurst({ mode: 'frame' }).mode, 'frame')
})

test('frame mode ignores the interval; time mode honours it', () => {
  assert.equal(burstGapMs({ count: 5, intervalMs: 5000, mode: 'frame' }), BURST_FRAME_GAP_MS)
  assert.equal(burstGapMs({ count: 5, intervalMs: 5000, mode: 'time' }), 5000)
})

test('a burst of n takes exactly n captures and then finishes', () => {
  const s = startBurst(clampBurst({ count: 3, intervalMs: 100, mode: 'time' }))
  const seen: number[] = []
  for (let guard = 0; guard < 10; guard++) {
    const step = burstStep(s)
    if (step.action === 'finish') {
      assert.equal(step.reason, 'complete')
      break
    }
    seen.push(step.index)
    assert.equal(step.last, step.index === 2)
    s.done++
  }
  assert.deepEqual(seen, [0, 1, 2])
  assert.equal(burstFraction(s), 1)
})

test('a cancelled burst finishes as cancelled even with captures remaining', () => {
  const s = startBurst(clampBurst({ count: 50, intervalMs: 100, mode: 'time' }))
  s.done = 2
  assert.equal(burstFraction(s), 0.04)
  s.stopping = true
  const step = burstStep(s)
  assert.equal(step.action, 'finish')
  assert.equal(step.action === 'finish' ? step.reason : '', 'cancelled')
})

// --- C24: the delete stack -----------------------------------------------

test('the recent stack is newest-first, de-duplicating and capped', () => {
  let list: string[] = []
  list = pushRecent(list, 'C:/a.png')
  list = pushRecent(list, 'C:/b.png')
  assert.deepEqual(list, ['C:/b.png', 'C:/a.png'])
  // Re-capturing the same path moves it to the front rather than duplicating.
  list = pushRecent(list, 'C:/a.png')
  assert.deepEqual(list, ['C:/a.png', 'C:/b.png'])

  let big: string[] = []
  for (let i = 0; i < RECENT_LIMIT + 5; i++) big = pushRecent(big, `C:/f${i}.png`)
  assert.equal(big.length, RECENT_LIMIT)
  assert.equal(big[0], `C:/f${RECENT_LIMIT + 4}.png`)

  const popped = popRecent(list)
  assert.equal(popped.file, 'C:/a.png')
  assert.deepEqual(popped.rest, ['C:/b.png'])
  // An empty stack is a no-op, not an exception: C24 says the command OSDs and
  // does nothing when there is nothing from this session to delete.
  assert.deepEqual(popRecent([]), { file: null, rest: [] })
})

// --- C06: format ----------------------------------------------------------

test('the format enum is mpv’s, and mpv has no BMP writer', () => {
  assert.deepEqual([...CAPTURE_FORMATS], ['png', 'jpg', 'webp', 'jxl', 'avif'])
  assert.equal(normalizeFormat('bmp'), 'png', 'BMP does not exist in mpv; offer PNG')
  assert.equal(normalizeFormat(undefined), 'png')
  assert.equal(normalizeFormat('webp'), 'webp')
})

test('the clipboard temp name is unique per call and always a .png', () => {
  const a = tempCaptureName(1, 1_700_000_000_000)
  const b = tempCaptureName(2, 1_700_000_000_000)
  assert.notEqual(a, b)
  assert.ok(a.endsWith('.png'))
})
