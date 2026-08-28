import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CommandDescriptor,
  FeatureContext,
  SettingDescriptor,
  SettingType
} from '@shared/feature-api'
import mod, { convertibleCandidates } from './index.ts'
import { CODEPAGES } from './codepages.ts'
import { parseAssCues, parseSrtCues } from './serialise.ts'
import { decodeSubtitle } from './text.ts'
import {
  brokenHeaderSmi,
  cp949,
  multiLanguageSmi,
  singleLanguageSmi,
  utf8,
  HELLO_KO
} from './fixtures.ts'

/**
 * M18's WIRING, driven through the real module.
 *
 * Nothing here lists what the module is supposed to do. `setup()` is called with
 * a recording context, the same events the app pushes are pushed, and the calls
 * that come out are asserted — including the ones that must NOT come out, which
 * is the half a table-driven test cannot see. If the codepage change stops
 * calling M17's mediator, or the converter starts touching a file mpv reads
 * fine, or a Korean string goes missing from one of the two catalogs, this fails.
 */

// --- a recording FeatureContext -------------------------------------------

interface MpvWrite {
  name: string
  value: unknown
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-subs-formats-'))
const videoDir = path.join(root, 'video')
const cacheDir = path.join(root, 'subcache')
fs.mkdirSync(videoDir, { recursive: true })
fs.mkdirSync(path.join(videoDir, 'subs'), { recursive: true })
fs.mkdirSync(cacheDir, { recursive: true })

const writes: MpvWrite[] = []
const invoked: Array<{ id: string; arg: unknown }> = []
const toasts: Array<{ kind: string; message: string }> = []
const osd: string[] = []
const logs: Array<{ level: string; args: unknown[] }> = []
const commands = new Map<string, CommandDescriptor>()
const descriptors = new Map<string, SettingDescriptor>()
const values = new Map<string, unknown>()
const settingListeners = new Map<string, Array<(v: unknown, prev: unknown) => void>>()
const catalogs = new Map<string, Record<string, string>>()
const fileLoadedCbs: Array<() => void> = []
const readyCbs: Array<() => void> = []
const argContributions: Array<{ priority: number; fn: () => readonly string[] }> = []
const menus: Array<Record<string, unknown>> = []
const slices: Array<Record<string, unknown>> = []
const ipcHandlers = new Map<string, (req: unknown) => unknown>()
let mpvProps: Record<string, unknown> = {}
let currentFile: string | null = null
let saveFileAnswer: string | null = null

function getSetting<T>(id: string): T {
  if (values.has(id)) return values.get(id) as T
  return descriptors.get(id)?.default as T
}

function setSetting(id: string, value: unknown): void {
  const prev = getSetting<unknown>(id)
  if (Object.is(prev, value)) return
  values.set(id, value)
  for (const cb of settingListeners.get(id) ?? []) cb(value, prev)
}

const ctx = {
  id: 'subs-formats',
  log: {
    info: (...a: unknown[]) => logs.push({ level: 'info', args: a }),
    warn: (...a: unknown[]) => logs.push({ level: 'warn', args: a }),
    error: (...a: unknown[]) => logs.push({ level: 'error', args: a })
  },
  paths: {
    subCacheDir: () => cacheDir,
    // Deliberately a path that cannot exist: the uchardet probe must degrade to
    // a warning, never take the module down with it.
    mpvBinary: () => path.join(root, 'no-such-mpv.exe')
  },
  mpv: {
    peek: <T>(name: string): T | undefined => mpvProps[name] as T | undefined,
    get: async <T>(name: string): Promise<T> => mpvProps[name] as T,
    set: async (name: string, value: unknown): Promise<void> => {
      writes.push({ name, value })
      mpvProps[name] = value
    },
    observe: () => () => {},
    afterFileLoaded: (cb: () => void) => {
      fileLoadedCbs.push(cb)
      return () => {}
    },
    onEvent: () => () => {},
    contributeArgs: (priority: number, fn: () => readonly string[]) =>
      argContributions.push({ priority, fn })
  },
  settings: {
    define: (list: readonly SettingDescriptor[]) => {
      for (const d of list) descriptors.set(d.id, d)
    },
    get: getSetting,
    set: setSetting,
    onChange: (id: string, cb: (v: unknown, prev: unknown) => void) => {
      const list = settingListeners.get(id) ?? []
      list.push(cb)
      settingListeners.set(id, list)
      return () => {}
    }
  },
  commands: {
    register: (list: readonly CommandDescriptor[]) => {
      for (const c of list) commands.set(c.id, c)
    },
    has: (id: string) => id === 'subs-tracks.reload' || id === 'subs-tracks.addFile',
    invoke: async (id: string, arg?: unknown): Promise<void> => {
      invoked.push({ id, arg })
    },
    query: async <T>(): Promise<T> => undefined as T
  },
  ipc: {
    handle: (channel: string, fn: (req: unknown) => unknown) => ipcHandlers.set(channel, fn),
    on: () => {},
    send: () => {}
  },
  osd: {
    show: (m: { text: string }) => osd.push(m.text),
    toast: (t: { kind: string; message: string }) => toasts.push(t)
  },
  perFile: {
    slice: (s: Record<string, unknown>) => slices.push(s),
    currentPath: () => currentFile,
    currentKey: () => currentFile
  },
  menu: { contribute: (m: Record<string, unknown>) => menus.push(m) },
  lifecycle: {
    onReady: (cb: () => void) => readyCbs.push(cb),
    onQuit: () => {},
    trackProcess: () => {}
  },
  dialog: {
    saveFile: async (): Promise<string | null> => saveFileAnswer,
    openFiles: async (): Promise<string[]> => [],
    confirm: async (): Promise<boolean> => true
  },
  i18n: {
    register: (lang: string, messages: Record<string, string>) => {
      catalogs.set(lang, { ...(catalogs.get(lang) ?? {}), ...messages })
    },
    t: (key: string, params?: Record<string, string | number>) => {
      const raw = catalogs.get('ko')?.[key] ?? key
      return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? `{${k}}`))
    }
  }
} as unknown as FeatureContext

mod.setup(ctx)

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function reset(): void {
  writes.length = 0
  invoked.length = 0
  toasts.length = 0
  osd.length = 0
  logs.length = 0
  for (const f of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, f), { force: true })
}

/** The state a Korean rip arrives in: one video, one sidecar mpv did load. */
function playing(file: string, subs: Array<Partial<Record<string, unknown>>> = []): void {
  currentFile = file
  mpvProps = {
    'idle-active': false,
    'sub-delay': 0,
    'sub-speed': 1,
    sid: subs.length > 0 ? 1 : false,
    'track-list': subs.map((s, i) => ({
      id: i + 1,
      type: 'sub',
      external: true,
      selected: i === 0,
      ...s
    }))
  }
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test('the module declares exactly what its manifest row says', () => {
  assert.equal(mod.id, 'subs-formats')
  assert.deepEqual(mod.ownsProperties, ['sub-codepage'])
  assert.deepEqual(mod.dependsOn, ['core-settings'])
  // M17 depends on M18, so naming it back would be the boot-time cycle.
  assert.ok(!(mod.dependsOn ?? []).includes('subs-tracks'))
  // No filter chains, no commands of its own: `sub-reload`, `sub-add` and
  // `sub-remove` are all M17's (§3.7.1) and this module goes through mediators.
  assert.equal(mod.ownsCommands, undefined)
  assert.equal(mod.usesVideoFilters, undefined)
  assert.equal(mod.usesAudioFilters, undefined)
})

test('every setting and command id is inside this module namespace', () => {
  assert.ok(descriptors.size >= 6)
  for (const id of descriptors.keys()) assert.match(id, /^subs-formats\./)
  for (const id of commands.keys()) assert.match(id, /^subs-formats\./)
  for (const d of descriptors.values()) {
    assert.equal(d.section, 'subtitles', `${d.id} is in the wrong settings section`)
    assert.ok(typeof d.order === 'number', `${d.id} has no order`)
  }
})

test('the codepage descriptor offers the ten measured values, force-prefixed', () => {
  const d = descriptors.get('subs-formats.codepage')
  assert.ok(d)
  assert.equal(d.default, 'auto')
  assert.equal(d.mpvOption, 'sub-codepage')
  const type = d.type as Extract<SettingType, { kind: 'enum' }>
  assert.equal(type.kind, 'enum')
  assert.deepEqual(
    type.options.map((o) => o.value),
    CODEPAGES.map((c) => c.mpv)
  )
})

// ---------------------------------------------------------------------------
// S34 — the two steps, both required
// ---------------------------------------------------------------------------

test('the spawn arg carries the codepage and follows the setting', () => {
  const contribution = argContributions.find((c) => c.fn().join(' ').includes('--sub-codepage'))
  assert.ok(contribution, 'no --sub-codepage spawn arg at all')
  assert.deepEqual([...contribution.fn()], ['--sub-codepage=auto'])
  setSetting('subs-formats.codepage', '+cp949')
  assert.deepEqual([...contribution.fn()], ['--sub-codepage=+cp949'])
  setSetting('subs-formats.codepage', 'auto')
})

test('changing the codepage writes the property AND calls M17 to reload', async () => {
  reset()
  setSetting('subs-formats.codepage', '+cp949')
  await flush()
  assert.deepEqual(writes, [{ name: 'sub-codepage', value: '+cp949' }])
  // Both steps, in order. `sub-reload` is M17's; issuing it here would be an
  // OwnershipError, and skipping it means the change only lands on the next file.
  assert.deepEqual(
    invoked.map((i) => i.id),
    ['subs-tracks.reload']
  )
  setSetting('subs-formats.codepage', 'auto')
  await flush()
})

test('the keybind cycles the whole table and wraps', async () => {
  reset()
  const cycle = commands.get('subs-formats.cycleCodepage')
  assert.ok(cycle)
  assert.deepEqual(cycle.defaults?.default, ['Alt+KeyC'])
  for (let i = 0; i < CODEPAGES.length; i++) await cycle.run()
  await flush()
  assert.deepEqual(
    writes.map((w) => w.value),
    [...CODEPAGES.slice(1).map((c) => c.mpv), CODEPAGES[0]?.mpv]
  )
  assert.equal(invoked.filter((i) => i.id === 'subs-tracks.reload').length, CODEPAGES.length)
  // Every step announces itself in Korean, resolved through the catalog rather
  // than printed as a raw key.
  assert.equal(osd.length, CODEPAGES.length)
  assert.ok(osd.every((t) => t.startsWith('자막 인코딩: ') && !t.includes('subs-formats.')))
})

test('an unknown codepage is refused instead of written to mpv', async () => {
  reset()
  await commands.get('subs-formats.setCodepage')?.run('+klingon')
  await flush()
  assert.deepEqual(writes, [])
  assert.equal(logs.filter((l) => l.level === 'warn').length, 1)
})

// ---------------------------------------------------------------------------
// S03/S04 — the conversion pass, end to end through the module
// ---------------------------------------------------------------------------

test('SM-F: a multi-language CP949 SMI becomes two tracks, Korean selected LAST', async () => {
  reset()
  const smi = path.join(videoDir, 'korean.smi')
  fs.writeFileSync(smi, cp949(multiLanguageSmi()))
  playing(path.join(videoDir, 'korean.mkv'), [{ 'external-filename': smi }])

  for (const cb of fileLoadedCbs) cb()
  await flush()

  const adds = invoked.filter((i) => i.id === 'subs-tracks.addFile')
  assert.equal(adds.length, 2, 'expected one sub-add per language')
  const paths = adds.map((a) => String(a.arg))
  for (const p of paths) assert.ok(fs.existsSync(p), `${p} was announced but not written`)
  // `subs-tracks.addFile` always passes `select`, so the LAST one added is the
  // selected one and it must be the Korean track.
  assert.match(path.basename(paths[1] ?? ''), /\.ko\.ass$/)
  assert.match(path.basename(paths[0] ?? ''), /\.en\.ass$/)

  // The Korean file really contains the line FFmpeg would have dropped, and it
  // is written UTF-8 with a BOM so nothing has to guess its encoding again.
  const bytes = new Uint8Array(fs.readFileSync(paths[1] ?? ''))
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  const cues = parseAssCues(decodeSubtitle(bytes, null).text)
  assert.equal(cues[0]?.text, `${HELLO_KO} 여러분`)
  assert.equal(cues[0]?.endMs, 4000)

  assert.ok(
    toasts.some((t) => t.kind === 'info' && t.message.includes('korean.smi')),
    'the user was not told anything happened'
  )
})

test('a second file-loaded for the same file does not add the tracks again', async () => {
  reset()
  for (const cb of fileLoadedCbs) cb()
  await flush()
  const first = invoked.filter((i) => i.id === 'subs-tracks.addFile').length
  assert.equal(first, 2)
  reset()
  // Same file, same cache: the guard is per load, and mpv re-adding a track it
  // already has would give the user four Korean entries.
  playing(path.join(videoDir, 'korean.mkv'), [
    { 'external-filename': path.join(videoDir, 'korean.smi') }
  ])
  for (const cb of fileLoadedCbs) cb()
  await flush()
  assert.equal(invoked.filter((i) => i.id === 'subs-tracks.addFile').length, 2)
})

test('a single-language SMI that mpv reads correctly is LEFT ALONE', async () => {
  reset()
  const smi = path.join(videoDir, 'fine.smi')
  fs.writeFileSync(smi, cp949(singleLanguageSmi()))
  playing(path.join(videoDir, 'fine.mkv'), [{ 'external-filename': smi }])
  for (const cb of fileLoadedCbs) cb()
  await flush()
  assert.deepEqual(invoked, [], 'a working file was converted anyway')
  assert.deepEqual(fs.readdirSync(cacheDir), [], 'a cache file was written for nothing')
  assert.deepEqual(toasts, [], 'the user was interrupted about a file that was already fine')
})

test('S04: a malformed SMI that mpv could not even load is found and repaired', async () => {
  reset()
  // The broken copy is NOT in track-list, because its probe score is 1 — below
  // --demuxer-lavf-probescore — so mpv never opened it. That is exactly why the
  // sibling scan exists.
  const smi = path.join(videoDir, 'subs', 'broken.ko.smi')
  fs.writeFileSync(smi, cp949(brokenHeaderSmi(0)))
  fs.renameSync(smi, path.join(videoDir, 'subs', 'broken.ko.smi'))
  playing(path.join(videoDir, 'broken.mkv'), [])
  for (const cb of fileLoadedCbs) cb()
  await flush()

  const adds = invoked.filter((i) => i.id === 'subs-tracks.addFile')
  assert.equal(adds.length, 1)
  const out = String(adds[0]?.arg)
  assert.match(out, /\.repaired\.smi$/)
  const text = decodeSubtitle(new Uint8Array(fs.readFileSync(out)), null).text
  assert.equal(text.startsWith('<SAMI>'), true, 'the repaired copy still would not probe')
  assert.ok(text.includes(HELLO_KO))
  // …and the user's own file was not touched.
  assert.equal(
    decodeSubtitle(new Uint8Array(fs.readFileSync(smi)), null).text.startsWith('<sami>'),
    true
  )
})

test('the candidate scan is prefix-exact, not fuzzy — that is M17 S10 work', () => {
  const listing: Record<string, string[]> = {
    'C:\\v': ['Movie.smi', 'Movie.ko.smi', 'Movie.mkv', 'Other.smi', 'Movie.srt', 'notes.txt'],
    'C:\\v\\subs': ['Movie.KRCC.smi'],
    'C:\\v\\sub': [],
    'C:\\v\\subtitles': [],
    'C:\\v\\자막': []
  }
  const found = convertibleCandidates(
    'C:\\v\\Movie.mkv',
    (d) => listing[d] ?? [],
    []
  ).map((p) => path.basename(p))
  assert.deepEqual(found.sort(), ['Movie.KRCC.smi', 'Movie.ko.smi', 'Movie.smi'])
  assert.ok(!found.includes('Other.smi'), 'a same-directory unrelated .smi was claimed')
  assert.ok(!found.includes('Movie.srt'), 'an .srt needs no conversion')
})

test('an already-loaded convertible track is a candidate even with no video path', () => {
  const found = convertibleCandidates(null, () => [], ['C:\\x\\a.smi', 'C:\\x\\b.srt'])
  assert.deepEqual(found, ['C:\\x\\a.smi'])
})

test('the mediator for S11 writes the cache and answers with the paths', () => {
  reset()
  const smi = path.join(videoDir, 'dropped.smi')
  fs.writeFileSync(smi, cp949(multiLanguageSmi()))
  const prepared = commands.get('subs-formats.prepare')?.run(smi) as Array<{
    path: string
    lang: string
    preferred: boolean
  }>
  assert.equal(prepared.length, 2)
  assert.equal(prepared[1]?.preferred, true, 'the preferred entry must be last')
  assert.equal(prepared[1]?.lang, 'ko')
  for (const p of prepared) assert.ok(fs.existsSync(p.path))
  // A file mpv can read gets an empty answer, so M17 just adds it itself.
  fs.writeFileSync(path.join(videoDir, 'ok.smi'), cp949(singleLanguageSmi()))
  assert.deepEqual(commands.get('subs-formats.prepare')?.run(path.join(videoDir, 'ok.smi')), [])
  assert.deepEqual(commands.get('subs-formats.prepare')?.run('C:\\nope.srt'), [])
})

// ---------------------------------------------------------------------------
// S42 — export
// ---------------------------------------------------------------------------

test('export refuses an embedded track instead of writing a one-line file', async () => {
  reset()
  playing(path.join(videoDir, 'x.mkv'), [{ external: false, 'external-filename': undefined }])
  await commands.get('subs-formats.saveAs')?.run()
  await flush()
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.kind, 'error')
  assert.ok(toasts[0]?.message.includes('내장 자막'))
  assert.equal(commands.get('subs-formats.saveAs')?.enabledWhen?.(), false)
})

test('S42: save-beside bakes sub-delay into the timestamps and writes UTF-8+BOM', async () => {
  reset()
  const smi = path.join(videoDir, 'export.smi')
  fs.writeFileSync(smi, cp949(multiLanguageSmi()))
  playing(path.join(videoDir, 'export.mkv'), [{ 'external-filename': smi, lang: 'ko' }])
  mpvProps['sub-delay'] = 2
  mpvProps['sub-speed'] = 1

  await commands.get('subs-formats.saveBeside')?.run()
  await flush()

  const out = path.join(videoDir, 'export.ko.srt')
  assert.ok(fs.existsSync(out), 'nothing was written')
  const bytes = new Uint8Array(fs.readFileSync(out))
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  const cues = parseSrtCues(decodeSubtitle(bytes, null).text)
  assert.deepEqual(
    cues.map((c) => [c.startMs, c.text]),
    [
      [2500, `${HELLO_KO} 여러분`],
      [8000, '두 번째 줄\n계속']
    ]
  )
  assert.ok(toasts.some((t) => t.kind === 'info' && t.message.includes('export.ko.srt')))
})

test('S42: SMI export can be written as CP949, and losses are counted out loud', async () => {
  reset()
  const smi = path.join(videoDir, 'emoji.smi')
  fs.writeFileSync(
    smi,
    utf8(
      ['<SAMI>', '<BODY>', '<SYNC Start=0><P Class=KRCC>가😀', '<SYNC Start=1000><P>&nbsp;'].join(
        '\r\n'
      )
    )
  )
  playing(path.join(videoDir, 'emoji.mkv'), [{ 'external-filename': smi, lang: 'ko' }])
  setSetting('subs-formats.exportEncoding', 'cp949')
  saveFileAnswer = path.join(videoDir, 'emoji-out.smi')

  await commands.get('subs-formats.saveSmi')?.run()
  await flush()

  const bytes = new Uint8Array(fs.readFileSync(saveFileAnswer))
  assert.notDeepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CP949 must not get a UTF-8 BOM')
  assert.equal(new TextDecoder('euc-kr').decode(bytes).startsWith('<SAMI>'), true)
  assert.ok(
    toasts.some((t) => t.kind === 'error' && t.message.includes('1')),
    'the unmappable emoji was dropped silently'
  )
  setSetting('subs-formats.exportEncoding', 'utf8-bom')
  saveFileAnswer = null
})

test('a cancelled save dialog writes nothing', async () => {
  reset()
  const smi = path.join(videoDir, 'cancel.smi')
  fs.writeFileSync(smi, cp949(multiLanguageSmi()))
  playing(path.join(videoDir, 'cancel.mkv'), [{ 'external-filename': smi, lang: 'ko' }])
  saveFileAnswer = null
  const before = fs.readdirSync(videoDir).length
  await commands.get('subs-formats.saveAs')?.run()
  await flush()
  assert.equal(fs.readdirSync(videoDir).length, before)
  assert.deepEqual(toasts, [])
})

// ---------------------------------------------------------------------------
// S33 — the assertion must not be able to break the app
// ---------------------------------------------------------------------------

test('a missing mpv binary makes the uchardet probe warn, not throw', () => {
  reset()
  assert.equal(readyCbs.length, 1)
  assert.doesNotThrow(() => readyCbs[0]?.())
})

// ---------------------------------------------------------------------------
// Per-file state, the menu, the report
// ---------------------------------------------------------------------------

test('the per-file slice remembers the codepage and reapplies it', async () => {
  reset()
  const slice = slices.find((s) => s.key === 'subs-formats') as
    | {
        key: string
        capture: () => Record<string, unknown>
        apply: (v: Record<string, unknown>) => Promise<void>
        rememberDefaults: Record<string, boolean>
      }
    | undefined
  assert.ok(slice, 'no per-file slice at all (S14 lists subCodepage)')
  assert.equal(slice.rememberDefaults.codepage, true)
  assert.deepEqual(slice.capture(), { codepage: 'auto' })
  await slice.apply({ codepage: '+cp949' })
  await flush()
  assert.deepEqual(writes, [{ name: 'sub-codepage', value: '+cp949' }])
  assert.deepEqual(slice.capture(), { codepage: '+cp949' })
  // Reapplying the same value must not thrash a reload through M17.
  reset()
  await slice.apply({ codepage: '+cp949' })
  assert.deepEqual(invoked, [])
  await slice.apply({ codepage: 'auto' })
  await flush()
})

test('the encoding menu is a radio group, greyed for an embedded track', () => {
  const menu = menus.find((m) => m.id === 'subs-formats.menu')
  assert.ok(menu, 'no menu contribution')
  assert.equal(menu.order, 43)
  const items = menu.items as Array<{ submenu?: Array<{ dynamic?: () => unknown[] }> }>
  const group = items[0]?.submenu?.[0]
  assert.ok(group?.dynamic)

  playing(path.join(videoDir, 'x.mkv'), [{ 'external-filename': path.join(videoDir, 'fine.smi') }])
  const external = group.dynamic() as Array<{ enabled: boolean; checked: boolean; arg: string }>
  assert.equal(external.length, CODEPAGES.length)
  assert.ok(external.every((i) => i.enabled))
  assert.equal(external.filter((i) => i.checked).length, 1)

  playing(path.join(videoDir, 'x.mkv'), [{ external: false }])
  const embedded = group.dynamic() as Array<{ enabled: boolean; checked: boolean }>
  // sub-reload re-reads external tracks only — mkv subtitles are always assumed
  // to be UTF-8 — so offering the change would be offering a no-op.
  assert.equal(embedded.filter((i) => i.enabled).length, 1)
})

test('the stats report is populated from the last conversion', async () => {
  reset()
  const handler = ipcHandlers.get('subs-formats:report')
  assert.ok(handler)
  const smi = path.join(videoDir, 'report.smi')
  fs.writeFileSync(smi, cp949(multiLanguageSmi()))
  playing(path.join(videoDir, 'report.mkv'), [{ 'external-filename': smi }])
  for (const cb of fileLoadedCbs) cb()
  await flush()
  const r = handler(undefined) as Record<string, unknown>
  assert.equal(r.kind, 'split')
  assert.equal(r.encoding, 'euc-kr')
  assert.equal(r.file, 'report.smi')
  assert.deepEqual(r.classes, ['KRCC', 'ENCC'])
  assert.equal(r.duplicateTimestamps, 2)
  assert.equal(r.probeScore, 100)
  assert.equal((r.added as string[]).length, 2)
})

// ---------------------------------------------------------------------------
// i18n, in BOTH languages, for every key the module can actually show
// ---------------------------------------------------------------------------

/**
 * This test is written to fail on the omission it is checking for, which is
 * harder than it sounds: the keys are COLLECTED from the descriptors, commands,
 * enum options and menu the module registered, so a new label with no Korean
 * string fails without anyone remembering to add a row here. Checking a
 * hand-written list of keys would have been the check that lies.
 */
test('every user-visible key exists in Korean AND English', () => {
  const needed = new Set<string>()
  for (const d of descriptors.values()) {
    needed.add(d.labelKey)
    if (d.descriptionKey) needed.add(d.descriptionKey)
    if (d.type.kind === 'enum') for (const o of d.type.options) needed.add(o.labelKey)
  }
  for (const c of commands.values()) needed.add(c.labelKey)
  const walk = (nodes: unknown[]): void => {
    for (const n of nodes) {
      const node = n as { labelKey?: string; submenu?: unknown[] }
      if (node.labelKey) needed.add(node.labelKey)
      if (Array.isArray(node.submenu)) walk(node.submenu)
    }
  }
  for (const m of menus) {
    needed.add(String(m.labelKey))
    walk((m.items ?? []) as unknown[])
  }

  assert.ok(needed.size >= 25, `collected only ${needed.size} keys, so this proves little`)
  const ko = catalogs.get('ko') ?? {}
  const en = catalogs.get('en') ?? {}
  const missingKo = [...needed].filter((k) => !(k in ko))
  const missingEn = [...needed].filter((k) => !(k in en))
  assert.deepEqual(missingKo, [], 'keys with no Korean string')
  assert.deepEqual(missingEn, [], 'keys with no English string')
  // …and the two catalogs must not drift apart either way.
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort())
  for (const k of Object.keys(ko)) {
    assert.match(k, /^subs-formats\./, `${k} is outside this module's namespace`)
    assert.ok((ko[k] ?? '').length > 0, `${k} is empty in Korean`)
  }
})

test('every reason and toast key the code can emit is registered', () => {
  const ko = catalogs.get('ko') ?? {}
  for (const kind of ['split', 'repair', 'ttml']) {
    assert.ok(`subs-formats.toast.${kind}` in ko, `no toast string for a ${kind} conversion`)
  }
  for (const reason of [
    'native',
    'split',
    'collide',
    'repair',
    'ttml',
    'unsupported',
    'notTtml',
    'empty'
  ]) {
    assert.ok(`subs-formats.reason.${reason}` in ko, `no reason string for '${reason}'`)
  }
})

/**
 * The renderer half is a separate bundle with a separate catalog lookup, so a
 * key it renders and this half never registers is a raw `subs-formats.help.x`
 * printed at the user. The keys are READ OUT OF ITS SOURCE rather than listed
 * here, so adding a row over there cannot pass this by being forgotten.
 */
test('every key the renderer half renders is registered in both catalogs', () => {
  const src = fs.readFileSync(
    path.join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'renderer',
      'src',
      'features',
      'subs-formats',
      'index.ts'
    ),
    'utf8'
  )
  const used = new Set<string>()
  for (const m of src.matchAll(/'(subs-formats\.[A-Za-z0-9_.-]+)'/g)) {
    const key = m[1] ?? ''
    if (key.length > 0) used.add(key)
  }
  // A contribution `id:` is not an i18n key — it is a slot name in the host's
  // registry, and `subs-formats.help` is deliberately not a message. IPC
  // channels use a colon and never match at all.
  for (const m of src.matchAll(/\bid:\s*'(subs-formats\.[A-Za-z0-9_.-]+)'/g)) {
    const id = m[1] ?? ''
    // …unless it is ALSO used as a titleKey, which `subs-formats.stats` is.
    if (!new RegExp(`(?:title|label)Key:\\s*'${id}'`).test(src)) used.delete(id)
  }
  assert.ok(used.size >= 8, `read only ${used.size} keys out of the renderer half`)
  const ko = catalogs.get('ko') ?? {}
  const en = catalogs.get('en') ?? {}
  assert.deepEqual(
    [...used].filter((k) => !(k in ko)),
    []
  )
  assert.deepEqual(
    [...used].filter((k) => !(k in en)),
    []
  )
})

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})
