import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  EXCLUDE_ALL,
  FORMAT_PRESETS,
  hookArgs,
  parseRawOptions,
  privacySensitive,
  rawOptionArgs,
  toggleCommand,
  ytdlArg
} from './ytdl-opts.ts'
import {
  UPDATE_CHANNELS,
  findYtdlp,
  parseVersion,
  probeOrder,
  updateArgv,
  ytdlPathOption
} from './ytdl-path.ts'
import { classify, qualityOptions, singleFormatIsNormal, summarise } from './ytdl-status.ts'

/**
 * M36's pure halves. Every case here is either a line R05–R10 says was MEASURED
 * against the pinned build, or a shape that the obvious implementation gets
 * wrong.
 */

const ENV = {
  dataDir: 'C:\\Users\\u\\AppData\\Roaming\\RLPlayer',
  exeDir: 'C:\\Program Files\\RLPlayer',
  configured: '',
  localAppData: 'C:\\Users\\u\\AppData\\Local',
  userProfile: 'C:\\Users\\u',
  pathDirs: ['C:\\Windows\\system32', 'C:\\tools']
}

// ---------------------------------------------------------------------------
// R05 — the zero-network-at-rest design
// ---------------------------------------------------------------------------

test('R05: with the feature OFF, the hook is loaded and excluded from every URL', () => {
  const args = hookArgs({ enabled: false, ytdlPath: '', allFormats: true, useManifests: false })
  // The measured facts: `--ytdl=no` stops ytdl_hook loading at all, and setting
  // the `ytdl` property later cannot retroactively load it. So the toggle CANNOT
  // be `--ytdl`, and the at-rest state has to be "loaded but inert".
  assert.equal(ytdlArg(), '--ytdl=yes')
  assert.equal(
    args.includes(`--script-opts-append=ytdl_hook-exclude=${EXCLUDE_ALL}`),
    true,
    args.join(' ')
  )
  // `.*` matches every URL, which is what makes it inert: ytdl_hook returns
  // before it builds a command line, so no process and no request.
  assert.equal(EXCLUDE_ALL, '.*')
})

test('R05: the exclude append comes FIRST, so the fail-safe state is inert', () => {
  const args = hookArgs({ enabled: false, ytdlPath: 'C:\\t\\yt-dlp.exe', allFormats: true, useManifests: true })
  assert.match(args[0] as string, /ytdl_hook-exclude=/)
})

test('R05: with the feature ON, nothing excludes anything', () => {
  const args = hookArgs({ enabled: true, ytdlPath: '', allFormats: true, useManifests: false })
  assert.equal(
    args.some((a) => a.includes('ytdl_hook-exclude')),
    false,
    args.join(' ')
  )
})

test('R05: the runtime toggle is the exact change-list command the row specifies', () => {
  assert.deepEqual(toggleCommand(true), [
    'change-list',
    'script-opts',
    'append',
    'ytdl_hook-exclude='
  ])
  assert.deepEqual(toggleCommand(false), [
    'change-list',
    'script-opts',
    'append',
    'ytdl_hook-exclude=.*'
  ])
  // It NAMES `script-opts`, which is how the §2.2 guard checks it against this
  // module's ownership. A command that wrote the property without naming it
  // would be exactly the trap §2.2 is about.
  assert.equal(toggleCommand(true)[1], 'script-opts')
})

test('R05: every hook option is a script-opts-APPEND, never a replacing --script-opts', () => {
  const args = hookArgs({ enabled: true, ytdlPath: 'C:\\t\\yt-dlp.exe', allFormats: true, useManifests: true })
  for (const a of args) {
    assert.match(a, /^--script-opts-append=ytdl_hook-[a-z_]+=/)
  }
  // `script-opts` is one shared list that M29's overlays also write, and
  // `--script-opts=` would replace it. `script-opts-append` is on core's
  // additive allowlist precisely so two modules can both contribute.
  assert.equal(
    args.some((a) => a.startsWith('--script-opts=')),
    false
  )
})

test('R08: all_formats and force_all_formats are stated explicitly, both of them', () => {
  const on = hookArgs({ enabled: true, ytdlPath: '', allFormats: true, useManifests: false })
  assert.equal(on.includes('--script-opts-append=ytdl_hook-all_formats=yes'), true)
  assert.equal(on.includes('--script-opts-append=ytdl_hook-force_all_formats=yes'), true)
})

test('R13: use_manifests is off unless asked for', () => {
  const off = hookArgs({ enabled: true, ytdlPath: '', allFormats: true, useManifests: false })
  assert.equal(
    off.some((a) => a.includes('use_manifests')),
    false
  )
  const on = hookArgs({ enabled: true, ytdlPath: '', allFormats: true, useManifests: true })
  assert.equal(on.includes('--script-opts-append=ytdl_hook-use_manifests=yes'), true)
})

// ---------------------------------------------------------------------------
// R06 — discovery
// ---------------------------------------------------------------------------

test('R06: the probe order is the row order, profile first', () => {
  const order = probeOrder(ENV)
  assert.equal(order[0], path.join(ENV.dataDir, 'tools', 'yt-dlp.exe'))
  assert.equal(order[1], path.join(ENV.exeDir, 'tools', 'yt-dlp.exe'))
  // The `where yt-dlp` equivalent, expanded rather than spawned, and it covers
  // ytdl_hook's own alternative names extracted from the binary.
  assert.equal(order.includes(path.join('C:\\tools', 'yt-dlp.exe')), true)
  assert.equal(order.includes(path.join('C:\\tools', 'yt-dlp_x86.exe')), true)
  assert.equal(order.includes(path.join('C:\\tools', 'youtube-dl.exe')), true)
  // WinGet and scoop come last.
  const winget = path.join(ENV.localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe')
  assert.equal(order.includes(winget), true)
  assert.equal(order.indexOf(winget) > order.indexOf(path.join('C:\\tools', 'yt-dlp.exe')), true)
})

test('R06: a configured path is inserted third and never duplicated', () => {
  const order = probeOrder({ ...ENV, configured: 'C:\\tools\\yt-dlp.exe' })
  assert.equal(order[2], 'C:\\tools\\yt-dlp.exe')
  assert.equal(order.filter((p) => p === 'C:\\tools\\yt-dlp.exe').length, 1)
})

test('R06: an empty environment yields a usable list rather than junk paths', () => {
  const order = probeOrder({ ...ENV, localAppData: '', userProfile: '', pathDirs: [] })
  assert.equal(order.length, 2)
  for (const p of order) assert.equal(path.isAbsolute(p), true)
})

test('R06: the first existing candidate wins', () => {
  const order = probeOrder(ENV)
  const present = new Set([path.join('C:\\tools', 'yt-dlp.exe'), order[0] as string])
  assert.equal(findYtdlp(order, (p) => present.has(p)), order[0])
  assert.equal(
    findYtdlp(order, (p) => p === path.join('C:\\tools', 'yt-dlp.exe')),
    path.join('C:\\tools', 'yt-dlp.exe')
  )
  assert.equal(findYtdlp(order, () => false), null)
})

test('R06: ytdl_path must be absolute, because mpv runs with --no-config', () => {
  assert.deepEqual(ytdlPathOption('C:\\tools\\yt-dlp.exe'), {
    ok: true,
    value: 'C:\\tools\\yt-dlp.exe'
  })
  // A relative path fails SILENTLY inside ytdl_hook — the binary is simply not
  // found and the user gets a generic extraction failure — so it is refused here.
  assert.deepEqual(ytdlPathOption('tools\\yt-dlp.exe'), { ok: false, reason: 'not-absolute' })
  assert.deepEqual(ytdlPathOption('   '), { ok: false, reason: 'empty' })
  // The option is `;`-separated on Windows, so a `;` in the path would split one
  // path into two nonexistent ones.
  assert.deepEqual(ytdlPathOption('C:\\a;b\\yt-dlp.exe'), {
    ok: false,
    reason: 'separator-in-path'
  })
})

test('R06/R07: --version output is parsed, and junk is null rather than shown', () => {
  assert.equal(parseVersion('2026.08.19\n'), '2026.08.19')
  assert.equal(parseVersion('2026.08.19.123456'), '2026.08.19.123456')
  assert.equal(parseVersion('\n\n2026.08.19  \n'), '2026.08.19')
  // A version box reading "Traceback (most recent call last):" is worse than one
  // reading "unknown".
  assert.equal(parseVersion('Traceback (most recent call last):'), null)
  assert.equal(parseVersion(''), null)
})

test('R07: the update is yt-dlp updating ITSELF, and only those two channels', () => {
  assert.deepEqual(updateArgv('nightly'), ['--update-to', 'nightly'])
  assert.deepEqual(updateArgv('stable'), ['--update-to', 'stable'])
  assert.deepEqual([...UPDATE_CHANNELS], ['stable', 'nightly'])
})

// ---------------------------------------------------------------------------
// R07 — the failure classifier
// ---------------------------------------------------------------------------

test('R07: no result at all is "none", not a failure', () => {
  // ytdl_hook DELETES the property on end-of-file, so undefined is the resting
  // value. Reading it as a failure would fire a toast on every local file.
  for (const v of [undefined, null, 'nonsense', 42, {}]) {
    assert.equal(classify(v).kind, 'none', String(v))
  }
})

test('R07: status 0 is success', () => {
  assert.deepEqual(classify({ status: 0, stdout: '{...}', stderr: '' }), { kind: 'ok' })
})

test('R07: a missing binary is NOT an update offer', () => {
  // Telling someone to update something they have not installed is the shape of
  // message that makes people stop reading them.
  const r = classify({ status: -1, error_string: 'init failed', stderr: '' })
  assert.equal(r.kind, 'missing')
})

test('R07: a site-changed failure IS an update offer', () => {
  const r = classify({
    status: 1,
    stderr:
      'WARNING: [youtube] nsig extraction failed: Some formats may be missing\n' +
      'ERROR: [youtube] abc: Unable to extract player response; please report this issue'
  })
  assert.equal(r.kind, 'extraction-failed')
  if (r.kind !== 'extraction-failed') return
  assert.equal(r.updateWorthy, true)
  // The detail is the FIRST flagged line, so the message is the useful one.
  assert.match(r.detail, /^WARNING: \[youtube\] nsig extraction failed/)
})

test('R07: an ordinary "video unavailable" failure is NOT an update offer', () => {
  /**
   * The asymmetry that keeps the affordance meaningful. Offering an update for
   * a private or geo-blocked video trains people to click it, and then the one
   * time it matters they have already learned it does nothing.
   */
  for (const stderr of [
    'ERROR: [youtube] abc: Video unavailable',
    'ERROR: [youtube] abc: Private video. Sign in if you have been granted access',
    'ERROR: [generic] abc: The uploader has not made this video available in your country'
  ]) {
    const r = classify({ status: 1, stderr })
    assert.equal(r.kind, 'extraction-failed', stderr)
    if (r.kind !== 'extraction-failed') continue
    assert.equal(r.updateWorthy, false, stderr)
  }
})

test('R07: a run we killed ourselves is silent', () => {
  assert.equal(classify({ status: 1, killed_by_us: true, stderr: 'ERROR: x' }).kind, 'none')
})

test('summarise picks the flagged line and truncates rather than flooding the toast', () => {
  assert.equal(summarise('a\nb\nERROR: the real one\nc'), 'ERROR: the real one')
  assert.equal(summarise('just this'), 'just this')
  assert.equal(summarise(''), '')
  assert.equal(summarise(`ERROR: ${'x'.repeat(500)}`, 40).length, 40)
})

// ---------------------------------------------------------------------------
// R08 — the quality menu is the track menu
// ---------------------------------------------------------------------------

test('R08: quality options come from track-list, highest video first', () => {
  const opts = qualityOptions([
    { id: 1, type: 'video', 'demux-h': 720, 'demux-fps': 30, codec: 'h264' },
    { id: 2, type: 'video', 'demux-h': 1080, 'demux-fps': 60, codec: 'vp9', selected: true },
    { id: 1, type: 'audio', 'demux-bitrate': 128000, lang: 'en' },
    { id: 3, type: 'sub' },
    'junk',
    null
  ])
  assert.deepEqual(
    opts.map((o) => `${o.kind}:${o.id}`),
    ['video:2', 'video:1', 'audio:1']
  )
  assert.equal(opts[0]?.label, '1080p · 60fps · vp9')
  assert.equal(opts[0]?.selected, true)
  assert.equal(opts[2]?.label, '128 kbps · en')
})

test('R08: a delay-loaded track that reports nothing gets an honest label', () => {
  // An EDL track legitimately reports almost nothing until it is selected. A
  // label reading "0p 0fps" is worse than one reading "#4".
  const opts = qualityOptions([
    { id: 4, type: 'video', 'demux-h': 0, 'demux-fps': 0 },
    { id: 5, type: 'video', title: '1080p60 (av01)' }
  ])
  assert.equal(opts.find((o) => o.id === 4)?.label, '#4')
  assert.equal(opts.find((o) => o.id === 5)?.label, '1080p60 (av01)')
})

test('R08: one video quality is NORMAL for an HLS master playlist', () => {
  // "When yt-dlp returns no requested_formats (typical for an HLS master
  // playlist) ytdl_hook deliberately does not split formats … Not a bug."
  assert.equal(singleFormatIsNormal(qualityOptions([{ id: 1, type: 'video' }])), true)
  assert.equal(
    singleFormatIsNormal(
      qualityOptions([
        { id: 1, type: 'video' },
        { id: 2, type: 'video' }
      ])
    ),
    false
  )
  assert.equal(singleFormatIsNormal([]), true)
})

test('R08: a non-array track-list is empty, not a throw', () => {
  assert.deepEqual(qualityOptions(undefined), [])
  assert.deepEqual(qualityOptions('nope'), [])
})

// ---------------------------------------------------------------------------
// R09 / R10
// ---------------------------------------------------------------------------

test('R09: the empty preset is the default and passes no --format at all', () => {
  assert.equal(FORMAT_PRESETS[0]?.value, '')
  // "An empty value or `ytdl` does not pass a --format option at all", so an
  // empty preset must contribute nothing — not `--ytdl-format=`.
  for (const p of FORMAT_PRESETS.slice(1)) assert.equal(p.value.length > 0, true)
})

test('R10: leading dashes and a missing trailing = are both refused, by name', () => {
  const r = parseRawOptions([
    '--force-ipv6=',
    'force-ipv6',
    'cookies-from-browser=chrome',
    'proxy=http-proxy.example:3128',
    '  ',
    '# a comment',
    '=novalue',
    'bad key=1'
  ])
  assert.deepEqual([...r.entries], [
    'cookies-from-browser=chrome',
    'proxy=http-proxy.example:3128'
  ])
  assert.deepEqual(
    r.errors.map((e) => `${e.line}|${e.error}`),
    [
      '--force-ipv6=|leading-dashes',
      'force-ipv6|flag-needs-equals',
      '=novalue|no-key',
      'bad key=1|space-in-key'
    ]
  )
})

test('R10: entries become the additive append form', () => {
  assert.deepEqual(rawOptionArgs(['proxy=x', 'force-ipv6=']), [
    '--ytdl-raw-options-append=proxy=x',
    '--ytdl-raw-options-append=force-ipv6='
  ])
})

test('R10: the privacy-sensitive keys are flagged so the UI can say so', () => {
  // "cookies-from-browser reads the user's browser cookie DB — a meaningful
  // privacy action for a zero-telemetry app. Make it opt-in per source with a
  // one-line explanation, never a global default."
  assert.deepEqual(privacySensitive(['cookies-from-browser=chrome', 'proxy=x']), [
    'cookies-from-browser'
  ])
  assert.deepEqual(privacySensitive(['username=u', 'password=p', 'geo-bypass=']), [
    'username',
    'password'
  ])
  assert.deepEqual(privacySensitive([]), [])
})
