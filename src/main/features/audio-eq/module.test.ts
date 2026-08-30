import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandDescriptor, FeatureContext, SettingDescriptor } from '@shared/feature-api'
import mod from './index.ts'
import { equaliserSpec, preampSpec } from './eq.ts'

/**
 * M12's WIRING, driven through the real module rather than a description of it.
 *
 * The rule this file exists to keep honest is the one the audit rounds kept
 * catching: a test that iterates a hand-written table can only see what
 * somebody remembered to type into the table. So nothing here lists what the
 * module is supposed to do — it calls `setup()` with a recording context,
 * pushes the same events the app pushes, and asserts on the calls that come
 * out. If a band update starts rebuilding the chain, or an `af-command` loses
 * its fourth argument, or a label stops matching `modules.json`, this fails.
 */

// --- a recording FeatureContext -------------------------------------------

interface AfCall {
  op: 'set' | 'remove' | 'toggle' | 'command'
  args: unknown[]
}

const afCalls: AfCall[] = []
const osdMessages: string[] = []
const sent: Array<{ channel: string; payload: unknown; target?: string }> = []
const commands = new Map<string, CommandDescriptor>()
const descriptors = new Map<string, SettingDescriptor>()
const ipcHandlers = new Map<string, (req: unknown) => unknown>()
const ipcListeners = new Map<string, (req: unknown) => void>()
const catalogs = new Map<string, Record<string, string>>()
const values = new Map<string, unknown>()
const settingListeners = new Map<string, Array<(v: unknown, prev: unknown) => void>>()
const fileLoadedCbs: Array<() => void> = []
const events = new Map<string, Array<() => void>>()

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-eq-'))

function getSetting<T>(id: string): T {
  if (values.has(id)) return values.get(id) as T
  return descriptors.get(id)?.default as T
}

/** The same contract as core/settings/registry: unchanged values do not fire. */
function setSetting(id: string, value: unknown): void {
  const prev = getSetting<unknown>(id)
  if (Object.is(prev, value)) return
  values.set(id, value)
  for (const cb of settingListeners.get(id) ?? []) cb(value, prev)
}

const ctx = {
  id: 'audio-eq',
  log: { info: () => {}, warn: () => {}, error: () => {} },
  paths: { dataDir: () => dataDir },
  af: {
    set: (label: string, spec: string) => afCalls.push({ op: 'set', args: [label, spec] }),
    remove: (label: string) => afCalls.push({ op: 'remove', args: [label] }),
    toggle: (label: string, on: boolean) => afCalls.push({ op: 'toggle', args: [label, on] }),
    command: async (label: string, option: string, value: string, filter: string) => {
      afCalls.push({ op: 'command', args: [label, option, value, filter] })
      return { path: 'command' as const }
    },
    hasCpuFilter: true
  },
  mpv: {
    afterFileLoaded: (cb: () => void) => {
      fileLoadedCbs.push(cb)
      return () => {}
    },
    onEvent: (name: string, cb: () => void) => {
      const list = events.get(name) ?? []
      list.push(cb)
      events.set(name, list)
      return () => {}
    }
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
    }
  },
  ipc: {
    handle: (channel: string, fn: (req: unknown) => unknown) => ipcHandlers.set(channel, fn),
    on: (channel: string, fn: (req: unknown) => void) => ipcListeners.set(channel, fn),
    send: (channel: string, payload: unknown, target?: string) =>
      sent.push({ channel, payload, target })
  },
  osd: { show: (m: { text: string }) => osdMessages.push(m.text) },
  i18n: {
    register: (lang: string, messages: Record<string, string>) => {
      catalogs.set(lang, { ...(catalogs.get(lang) ?? {}), ...messages })
    },
    t: (key: string) => catalogs.get('ko')?.[key] ?? key
  }
} as unknown as FeatureContext

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const clear = (): void => {
  afCalls.length = 0
  osdMessages.length = 0
  sent.length = 0
}
const run = (id: string, arg?: unknown): unknown => commands.get(id)?.run(arg)
const preview = async (band: number, gain: number): Promise<void> => {
  ipcListeners.get('audio-eq:preview')?.({ band, gain })
  await flush()
}

// --- declarations ----------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(here, '..', '..', '..', '..', 'docs', 'parity', 'modules.json'),
    'utf8'
  )
) as Array<{
  id: string
  path: string
  ownedProperties: string[]
  ownedCommands: string[]
  ownedFilterLabels: string[]
}>
const row = manifest.find((m) => m.path === 'src/main/features/audio-eq/')

test('the module declares exactly what modules.json says it owns', () => {
  assert.ok(row, 'no manifest row for audio-eq')
  assert.equal(mod.id, 'audio-eq')
  // `ownership.test.ts` cross-checks properties and commands against the
  // manifest but NOT filter labels, and a stolen label is the same class of
  // bug: it is claimed at boot and collides for whoever comes second.
  assert.deepEqual([...(mod.ownsFilterLabels ?? [])].sort(), [...row.ownedFilterLabels].sort())
  assert.equal(mod.usesAudioFilters, true)
  // The EQ owns no mpv property and no mpv command: everything it does goes
  // through the af chain, which owns `af` itself.
  assert.deepEqual([...(mod.ownsProperties ?? [])], row.ownedProperties)
  assert.deepEqual([...(mod.ownsCommands ?? [])], row.ownedCommands)
  assert.equal(mod.usesVideoFilters, undefined)
})

test('setup registers namespaced settings, commands and both catalogs', () => {
  mod.setup(ctx)

  assert.ok(descriptors.size >= 4)
  for (const d of descriptors.values()) {
    assert.ok(d.id.startsWith('audio-eq.'), d.id)
    assert.equal(d.section, 'audio')
  }
  const bands = descriptors.get('audio-eq.bands')
  assert.deepEqual(bands?.type, { kind: 'custom', rendererComponent: 'audio-eq.bands' })

  assert.ok(commands.size >= 3)
  for (const c of commands.values()) assert.ok(c.id.startsWith('audio-eq.'), c.id)

  const ko = catalogs.get('ko') ?? {}
  const en = catalogs.get('en') ?? {}
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(ko).length > 0)
  for (const key of Object.keys(ko)) assert.ok(key.startsWith('audio-eq.'), key)
  // Every user-visible key a command or descriptor names must be translated,
  // in both languages — an untranslated labelKey renders as the key itself.
  const referenced = [
    ...[...commands.values()].map((c) => c.labelKey),
    ...[...descriptors.values()].flatMap((d) => [d.labelKey, d.descriptionKey ?? d.labelKey])
  ]
  for (const key of referenced) {
    assert.ok(key in ko, `ko is missing ${key}`)
    assert.ok(key in en, `en is missing ${key}`)
  }
})

// --- the chain -------------------------------------------------------------

test('a disabled EQ puts nothing in the chain at all', async () => {
  clear()
  fileLoadedCbs.forEach((cb) => cb())
  await flush()
  assert.deepEqual([...afCalls], [], 'the EQ is off and must not park a disabled filter in the chain')
})

test('enabling sets both slots and enables them, and nothing else', async () => {
  clear()
  setSetting('audio-eq.enabled', true)
  await flush()
  assert.deepEqual([...afCalls], [
    { op: 'set', args: ['rleq', equaliserSpec([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])] },
    { op: 'set', args: ['rlpre', preampSpec(0)] },
    { op: 'toggle', args: ['rleq', true] },
    { op: 'toggle', args: ['rlpre', true] }
  ])
  assert.deepEqual(osdMessages, [catalogs.get('ko')?.['audio-eq.osdOn']])
})

test('A DRAG IS af-command ONLY — eight channels, four arguments, no rebuild', async () => {
  clear()
  await preview(0, 6)

  // Eight `change` commands and one preamp command. NOT ONE `af set`: an
  // `af set` reinitialises every filter in the chain, which is audible.
  assert.equal(afCalls.some((c) => c.op === 'set'), false, 'a slider drag rebuilt the chain')
  assert.equal(afCalls.some((c) => c.op === 'toggle' || c.op === 'remove'), false)

  const changes = afCalls.filter((c) => c.args[1] === 'change')
  assert.equal(changes.length, 8)
  assert.deepEqual(changes[0]?.args, ['rleq', 'change', '0|f=31|w=22|g=6', 'anequalizer'])
  assert.deepEqual(changes[7]?.args, ['rleq', 'change', '70|f=31|w=22|g=6', 'anequalizer'])
  for (const c of changes) {
    assert.equal(c.op, 'command')
    // The fourth argument is the libavfilter FILTER NAME (A27). The
    // three-argument form and 'all' both fail, and the failure is a silent
    // fallback to a rebuild — exactly what this test exists to notice.
    assert.equal(c.args.length, 4)
    assert.equal(c.args[3], 'anequalizer')
  }

  // A03: the automatic preamp follows the curve while it is being dragged.
  const preamp = afCalls.filter((c) => c.args[0] === 'rlpre')
  assert.equal(preamp.length, 1)
  assert.deepEqual(preamp[0]?.args, ['rlpre', 'volume', '-6dB', 'volume'])
})

test('the drag does not touch the settings store; the release does', async () => {
  assert.equal(getSetting<string>('audio-eq.bands'), '0,0,0,0,0,0,0,0,0,0')

  // The release is `binding.set()` in the settings form, which is a write to
  // this exact setting — not a private channel of ours.
  clear()
  setSetting('audio-eq.bands', '6,0,0,0,0,0,0,0,0,0')
  await flush()

  assert.equal(getSetting<string>('audio-eq.bands'), '6,0,0,0,0,0,0,0,0,0')
  // Exactly one rebuild, carrying the dragged curve and its preamp.
  assert.deepEqual([...afCalls], [
    { op: 'set', args: ['rleq', equaliserSpec([6, 0, 0, 0, 0, 0, 0, 0, 0, 0])] },
    { op: 'set', args: ['rlpre', preampSpec(-6)] },
    { op: 'toggle', args: ['rleq', true] },
    { op: 'toggle', args: ['rlpre', true] }
  ])
})

test('a band that is out of range is dropped, not clamped into another band', async () => {
  clear()
  await preview(10, 6)
  await preview(-1, 6)
  await preview(Number.NaN, 6)
  assert.deepEqual([...afCalls], [])
})

test('gains beyond +/-12 dB never reach mpv', async () => {
  clear()
  await preview(1, 99)
  assert.deepEqual(afCalls[0]?.args, ['rleq', 'change', '1|f=62|w=44|g=12', 'anequalizer'])
})

test('no af-command is issued while no file is loaded', async () => {
  events.get('end-file')?.forEach((cb) => cb())
  clear()
  await preview(2, 3)
  assert.deepEqual([...afCalls], [], 'the chain has no filter graph to talk to yet')

  // …and the pending curve reaches mpv when the next file starts.
  fileLoadedCbs.forEach((cb) => cb())
  await flush()
  assert.equal(afCalls.filter((c) => c.op === 'set').length, 2)
})

test('switching the EQ off disables IN PLACE and keeps the curve', async () => {
  clear()
  run('audio-eq.toggle')
  await flush()
  assert.equal(getSetting<boolean>('audio-eq.enabled'), false)
  assert.equal(afCalls.some((c) => c.op === 'remove'), false, 'toggle() must not drop the slot')
  assert.deepEqual(afCalls.filter((c) => c.op === 'toggle'), [
    { op: 'toggle', args: ['rleq', false] },
    { op: 'toggle', args: ['rlpre', false] }
  ])
  // The spec that is still in the slot carries the user's curve — including
  // the two bands the tests above previewed and never committed, which is the
  // point: the running filter and the slot agree, the settings file lags until
  // the release.
  const spec = afCalls.find((c) => c.args[0] === 'rleq' && c.op === 'set')?.args[1]
  assert.equal(spec, equaliserSpec([6, 12, 3, 0, 0, 0, 0, 0, 0, 0]))

  clear()
  run('audio-eq.toggle')
  await flush()
  assert.equal(getSetting<boolean>('audio-eq.enabled'), true)
})

// --- presets ---------------------------------------------------------------

test('nextPreset commits a preset and announces it on the OSD', async () => {
  clear()
  run('audio-eq.reset')
  await flush()
  assert.equal(getSetting<string>('audio-eq.bands'), '0,0,0,0,0,0,0,0,0,0')

  clear()
  run('audio-eq.nextPreset')
  await flush()
  // Flat is the first built-in, so the cycle lands on the second one.
  assert.notEqual(getSetting<string>('audio-eq.bands'), '0,0,0,0,0,0,0,0,0,0')
  assert.equal(osdMessages.length, 1)
  assert.equal(afCalls.filter((c) => c.op === 'set').length, 2, 'one rebuild per preset')
})

test('applyPreset ignores a name nobody defined', async () => {
  const before = getSetting<string>('audio-eq.bands')
  clear()
  run('audio-eq.applyPreset', 'no such preset')
  await flush()
  assert.equal(getSetting<string>('audio-eq.bands'), before)
  assert.deepEqual([...afCalls], [])
})

test('a user preset file on disk shows up in the query, and is written back', async () => {
  fs.writeFileSync(
    path.join(dataDir, 'audio-eq-presets.json'),
    JSON.stringify([{ name: 'my headphones', gains: [3, 2, 0, 0, 0, 0, 0, 0, 0, 4] }]),
    'utf8'
  )
  const state = (await ipcHandlers.get('audio-eq:query')?.(undefined)) as {
    presets: Array<{ id: string; builtIn: boolean }>
    freqs: number[]
    limit: number
    gains: number[]
  }
  assert.ok(state.presets.some((p) => p.id === 'my headphones' && !p.builtIn))
  // The renderer cannot import the band table (composite tsconfig), so the
  // state has to carry it; a missing field silently produces unlabelled
  // sliders, which is the sort of thing only a test notices.
  assert.equal(state.freqs.length, 10)
  assert.equal(state.freqs[0], 31)
  assert.equal(state.limit, 12)
  assert.equal(state.gains.length, 10)

  clear()
  run('audio-eq.applyPreset', 'my headphones')
  await flush()
  assert.equal(getSetting<string>('audio-eq.bands'), '3,2,0,0,0,0,0,0,0,4')

  ipcListeners.get('audio-eq:savePreset')?.({ name: 'saved curve' })
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'audio-eq-presets.json'), 'utf8')
  ) as Array<{ name: string; gains: number[] }>
  assert.deepEqual(onDisk.map((p) => p.name).sort(), ['my headphones', 'saved curve'])
  assert.deepEqual(onDisk.find((p) => p.name === 'saved curve')?.gains, [3, 2, 0, 0, 0, 0, 0, 0, 0, 4])

  ipcListeners.get('audio-eq:deletePreset')?.({ id: 'saved curve' })
  const after = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'audio-eq-presets.json'), 'utf8')
  ) as Array<{ name: string }>
  assert.deepEqual(after.map((p) => p.name), ['my headphones'])
})

test('the settings window is told about changes it did not make', () => {
  const pushes = sent.filter((s) => s.channel === 'audio-eq:state')
  assert.ok(pushes.length > 0)
  for (const p of pushes) assert.equal(p.target, 'settings')
})

test('dispose leaves nothing running', () => {
  mod.dispose?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
