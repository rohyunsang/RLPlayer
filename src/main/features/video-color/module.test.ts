import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CommandDescriptor,
  FeatureContext,
  PerFileSlice,
  SettingDescriptor
} from '@shared/feature-api'
import mod from './index.ts'
import { LEVELS_DEFAULTS, autoLevelSpec, levelsSpec } from './colour.ts'

/**
 * M01's WIRING, driven through the real module rather than through a
 * description of it. Nothing here lists what the module is supposed to do: it
 * calls `setup()` with a recording context, pushes the same events the app
 * pushes, and asserts on the calls that come out.
 *
 * The two tests that matter most are at the bottom. `restore beats the
 * baseline in EITHER order` is there because this module's per-file restore
 * would otherwise be correct only by accident — it depends on core registering
 * its slice handler after the feature modules, which is an ordering no document
 * promises and no module can see.
 */

// --- a recording FeatureContext -------------------------------------------

interface VfCall {
  op: 'set' | 'remove' | 'toggle' | 'command'
  args: unknown[]
}

interface Slot {
  spec: string
  enabled: boolean
}

const props = new Map<string, unknown>()
const writes: Array<{ name: string; value: unknown }> = []
const rawCommands: unknown[][] = []
const vfCalls: VfCall[] = []
const slots = new Map<string, Slot>()
const osdMessages: string[] = []
const commands = new Map<string, CommandDescriptor>()
const descriptors = new Map<string, SettingDescriptor>()
const catalogs = new Map<string, Record<string, string>>()
const values = new Map<string, unknown>()
const settingListeners = new Map<string, Array<(v: unknown, prev: unknown) => void>>()
const events = new Map<string, Array<() => void>>()
const fileLoadedCbs: Array<() => void | Promise<void>> = []
const argContributors: Array<{ priority: number; fn: () => string[] }> = []
const ipcListeners = new Map<string, (req: unknown) => void>()
const ipcHandlers = new Map<string, (req: unknown) => unknown>()
let slice: PerFileSlice<Record<string, unknown>> | null = null

function getSetting<T>(id: string): T {
  if (values.has(id)) return values.get(id) as T
  return descriptors.get(id)?.default as T
}

/** The same contract as core/settings/registry: an unchanged value does not fire. */
function setSetting(id: string, value: unknown): void {
  const prev = getSetting<unknown>(id)
  if (Object.is(prev, value)) return
  values.set(id, value)
  for (const cb of settingListeners.get(id) ?? []) cb(value, prev)
}

const ctx = {
  id: 'video-color',
  log: { info: () => {}, warn: () => {}, error: () => {} },
  vf: {
    set: (label: string, spec: string) => {
      vfCalls.push({ op: 'set', args: [label, spec] })
      slots.set(label, { spec, enabled: slots.get(label)?.enabled ?? true })
    },
    remove: (label: string) => {
      vfCalls.push({ op: 'remove', args: [label] })
      slots.delete(label)
    },
    toggle: (label: string, on: boolean) => {
      vfCalls.push({ op: 'toggle', args: [label, on] })
      const slot = slots.get(label)
      if (slot) slot.enabled = on
    },
    command: async (label: string, option: string, value: string, filter: string, spec: string) => {
      vfCalls.push({ op: 'command', args: [label, option, value, filter, spec] })
      // The chain updates the slot from `spec` before either path runs.
      slots.set(label, { spec, enabled: true })
      return { path: 'command' as const }
    },
    has: (label: string) => slots.has(label),
    isEnabled: (label: string) => slots.get(label)?.enabled === true,
    specOf: (label: string) => slots.get(label)?.spec,
    hasCpuFilter: false
  },
  mpv: {
    peek: <T>(name: string): T | undefined => props.get(name) as T | undefined,
    set: async (name: string, value: unknown): Promise<void> => {
      writes.push({ name, value })
      props.set(name, value)
    },
    command: async (args: unknown[]): Promise<unknown> => {
      rawCommands.push(args)
      return undefined
    },
    observe: (name: string, cb: (v: unknown) => void) => {
      // The real bus fires immediately with the cached value.
      cb(props.get(name))
      return () => {}
    },
    onEvent: (name: string, cb: () => void) => {
      const list = events.get(name) ?? []
      list.push(cb)
      events.set(name, list)
      return () => {}
    },
    afterFileLoaded: (cb: () => void | Promise<void>) => {
      fileLoadedCbs.push(cb)
      return () => {}
    },
    contributeArgs: (priority: number, fn: () => string[]) => {
      argContributors.push({ priority, fn })
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
    on: (channel: string, fn: (req: unknown) => void) => ipcListeners.set(channel, fn),
    handle: (channel: string, fn: (req: unknown) => unknown) => ipcHandlers.set(channel, fn),
    send: () => {}
  },
  osd: { show: (m: { text: string }) => osdMessages.push(m.text) },
  perFile: {
    slice: (s: PerFileSlice<Record<string, unknown>>) => {
      slice = s
    }
  },
  menu: { contribute: () => {} },
  i18n: {
    register: (lang: string, messages: Record<string, string>) => {
      catalogs.set(lang, { ...(catalogs.get(lang) ?? {}), ...messages })
    },
    t: (key: string) => catalogs.get('ko')?.[key] ?? key
  }
} as unknown as FeatureContext

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const clear = (): void => {
  writes.length = 0
  vfCalls.length = 0
  osdMessages.length = 0
  rawCommands.length = 0
}
const run = async (id: string, arg?: unknown): Promise<void> => {
  await commands.get(id)?.run(arg)
  await flush()
}
const fire = (event: string): void => {
  for (const cb of events.get(event) ?? []) cb()
}
const loadFile = async (): Promise<void> => {
  for (const cb of fileLoadedCbs) await cb()
}
const spawnArgs = (): string[] => argContributors.flatMap((c) => c.fn())

/**
 * The colour state as mpv EFFECTIVELY holds it.
 *
 * `?? 0` and not a bare `props.get()`, and the difference is the whole point:
 * the module writes only the knobs that actually move, so after a reset from
 * `{brightness: 20}` mpv is never told about `contrast` at all and `props` has
 * no entry for it — which is mpv's own default 0, i.e. exactly neutral. The
 * first version of this helper asserted `contrast: 0` against `undefined` and
 * failed on correct behaviour, demanding four redundant round trips per reset.
 *
 * Because `?? 0` would also be satisfied by a module that wrote NOTHING, every
 * caller pairs it with an assertion on `writes` — the minimal write set is the
 * half that proves something happened.
 */
const mpvTuple = (): Record<string, unknown> => ({
  brightness: props.get('brightness') ?? 0,
  contrast: props.get('contrast') ?? 0,
  saturation: props.get('saturation') ?? 0,
  hue: props.get('hue') ?? 0,
  gamma: props.get('gamma') ?? 0
})

const NEUTRAL_TUPLE = { brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 0 }

/**
 * Back to a cold start — and it has to go through the MODULE, not just the
 * recorders.
 *
 * `lastUsed` and the three `filters` flags are module-private (V03 requires the
 * first: "there is no mpv-side restore primitive ... keep the state in the
 * app"), so clearing `props`/`values`/`slots` left them behind. Every one of the
 * seven failures this file had on its first real run traced back to that:
 * `toggleLevels` after a "cold" start flipped a leftover `true` to `false` and
 * the test saw an empty chain; the "nothing to restore" test restored the
 * previous test's tuple. `video-color.reset` is the module's own documented way
 * to put all of it back, so the harness uses that rather than reaching inside.
 */
const coldStart = async (): Promise<void> => {
  await run('video-color.reset')
  props.clear()
  values.clear()
  slots.clear()
  clear()
}

// --- the manifest ----------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', '..', '..', 'docs', 'parity', 'modules.json'), 'utf8')
) as Array<{
  id: string
  path: string
  dependsOn: string[]
  ownedProperties: string[]
  ownedCommands: string[]
  ownedFilterLabels: string[]
}>
const row = manifest.find((m) => m.path === 'src/main/features/video-color/')

test('the module declares exactly what modules.json says it owns', () => {
  assert.ok(row, 'no manifest row for video-color')
  assert.equal(mod.id, 'video-color')
  assert.deepEqual([...(mod.ownsProperties ?? [])].sort(), [...row.ownedProperties].sort())
  assert.deepEqual([...(mod.ownsFilterLabels ?? [])].sort(), [...row.ownedFilterLabels].sort())
  assert.deepEqual([...(mod.ownsCommands ?? [])], row.ownedCommands)
  assert.equal(mod.usesVideoFilters, true)
  assert.equal(mod.usesAudioFilters, undefined)
  // §3.2: ONE namespace. Mirroring the manifest row verbatim used to be a boot
  // failure on the first line of a module, so this asserts the mirror is exact.
  assert.deepEqual([...(mod.dependsOn ?? [])], row.dependsOn)
})

test('the five sliders are not the six owned properties', () => {
  // `video-output-levels` is owned here too and is an enum, so a module that
  // derived its slider list from `ownsProperties` would put a string property
  // into a -100..100 loop.
  assert.ok(mod.ownsProperties?.includes('video-output-levels'))
  assert.equal(descriptors.size, 0, 'setup() has not run yet')
})

// --- setup ---------------------------------------------------------------

test('setup registers namespaced settings, commands and both catalogs', () => {
  mod.setup(ctx)

  assert.ok(descriptors.size >= 13, `only ${descriptors.size} descriptors`)
  for (const d of descriptors.values()) {
    assert.ok(d.id.startsWith('video-color.'), d.id)
    assert.equal(d.section, 'video', `${d.id} must live in the fixed 'video' section`)
  }
  // V01/V02: five sliders, -100..100, default 0, each naming its mpv option so
  // the settings search and the tooltip can find it.
  for (const knob of ['brightness', 'contrast', 'saturation', 'hue', 'gamma']) {
    const d = descriptors.get(`video-color.${knob}`)
    assert.deepEqual(d?.type, { kind: 'int', min: -100, max: 100, step: 1 }, knob)
    assert.equal(d?.default, 0, knob)
    assert.equal(d?.mpvOption, knob, knob)
  }
  // V04: the three values mpv accepts and no more.
  const levels = descriptors.get('video-color.outputLevels')
  assert.deepEqual(
    levels?.type,
    {
      kind: 'enum',
      options: [
        { value: 'auto', labelKey: 'video-color.outputLevels.auto' },
        { value: 'limited', labelKey: 'video-color.outputLevels.limited' },
        { value: 'full', labelKey: 'video-color.outputLevels.full' }
      ]
    }
  )
  assert.equal(levels?.advanced, true, 'V04: expose it behind Advanced')

  assert.ok(commands.size >= 12, `only ${commands.size} commands`)
  for (const c of commands.values()) {
    assert.ok(c.id.startsWith('video-color.'), c.id)
    assert.equal(c.category, 'video')
  }

  const ko = catalogs.get('ko') ?? {}
  const en = catalogs.get('en') ?? {}
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort())
  for (const key of Object.keys(ko)) assert.ok(key.startsWith('video-color.'), key)

  // Every user-visible key anything references must exist in BOTH languages —
  // an untranslated labelKey renders as the key itself. Enum option labels are
  // included, which is the half a `labelKey`-only sweep misses.
  const enumLabels = [...descriptors.values()].flatMap((d) =>
    d.type.kind === 'enum' ? d.type.options.map((o) => o.labelKey) : []
  )
  const referenced = [
    ...[...commands.values()].map((c) => c.labelKey),
    ...[...descriptors.values()].flatMap((d) => [d.labelKey, d.descriptionKey ?? d.labelKey]),
    ...enumLabels,
    // The renderer half's prose and its button.
    'video-color.help',
    'video-color.helpProps',
    'video-color.helpFilters',
    'video-color.helpReset',
    // …and its stats block (§4.2).
    'video-color.stats',
    'video-color.statsCpuFilters'
  ]
  for (const key of referenced) {
    assert.ok(key in ko, `ko is missing ${key}`)
    assert.ok(key in en, `en is missing ${key}`)
  }
})

test('the mpv-preset digit bindings are mpv own map, and nothing invents a PotPlayer key', () => {
  const accels = (id: string): string[] => [...(commands.get(id)?.defaults?.mpv ?? [])]
  assert.deepEqual(accels('video-color.contrastDown'), ['Digit1'])
  assert.deepEqual(accels('video-color.contrastUp'), ['Digit2'])
  assert.deepEqual(accels('video-color.brightnessDown'), ['Digit3'])
  assert.deepEqual(accels('video-color.brightnessUp'), ['Digit4'])
  assert.deepEqual(accels('video-color.gammaDown'), ['Digit5'])
  assert.deepEqual(accels('video-color.gammaUp'), ['Digit6'])
  assert.deepEqual(accels('video-color.saturationDown'), ['Digit7'])
  assert.deepEqual(accels('video-color.saturationUp'), ['Digit8'])
  // Hue has no published binding in any of the three presets, so it gets none:
  // a preset is the FOLD of every module's defaults, and an invented
  // accelerator is a conflict another module has to discover.
  assert.deepEqual(commands.get('video-color.hueUp')?.defaults, undefined)
  // V03 / §7.8: PotPlayer's Q is "Disable / Last used Color Controls". It is
  // NOT the speed reset — that is Z, and it belongs to M10.
  assert.deepEqual([...(commands.get('video-color.toggleLastUsed')?.defaults?.potplayer ?? [])], [
    'KeyQ'
  ])
  // Physical codes only (P16): with the Korean IME composing, `e.key` is
  // 'Process' and a `key`-based binding stops working.
  for (const c of commands.values()) {
    for (const list of Object.values(c.defaults ?? {})) {
      for (const accel of list ?? []) {
        assert.match(accel, /^(Ctrl\+|Alt\+|Shift\+)*(Key|Digit|Arrow|Bracket|F\d|MBTN|WHEEL)/, accel)
      }
    }
  }
})

test('the spawn args are the six properties this module owns, and no reserved one', () => {
  const args = spawnArgs()
  assert.deepEqual(args, [
    '--brightness=0',
    '--contrast=0',
    '--saturation=0',
    '--hue=0',
    '--gamma=0',
    '--video-output-levels=auto'
  ])
  // V02's correction: `--gamma-factor` is live, not deprecated — and it is
  // still not what this module uses, because the runtime property is the
  // observable, per-file-persistable one.
  assert.ok(!args.some((a) => a.includes('gamma-factor')))
  // §4: nothing core-reserved and nothing from the inert-under---wid list.
  for (const a of args) {
    assert.doesNotMatch(a, /^--(wid|vo|gpu-context|input-|osd-|osc|no-config|config|idle)/)
    assert.doesNotMatch(a, /^--(fullscreen|fs|ontop|geometry|autofit|title|window-|keepaspect-window)/)
  }
})

// --- V01 / V02: the properties ---------------------------------------------

test('a step command writes mpv once, shows an OSD and records the preference', async () => {
  await coldStart()
  await run('video-color.brightnessUp')

  assert.deepEqual(writes, [{ name: 'brightness', value: 1 }], 'exactly one property write')
  assert.equal(props.get('brightness'), 1)
  assert.equal(getSetting<number>('video-color.brightness'), 1, 'the preference moved with it')
  assert.deepEqual(osdMessages, ['밝기 +1'])
  // The settings write fires onChange, which re-applies — and the re-apply must
  // be a no-op, not a second round trip on the pipe.
  assert.equal(writes.length, 1)
})

/**
 * ONE READOUT PER GESTURE, and this is the assertion that found a real defect
 * rather than confirming one.
 *
 * `SettingsRegistry.set()` calls `onChange` synchronously, and this module
 * subscribes to every id it defines so the settings WINDOW reaches mpv. So each
 * gesture ran the apply path twice: once directly, once re-entrantly through its
 * own store write. The second apply was a no-op on the pipe — mpv already held
 * the value — so `writes` looked perfect and only the OSD carried the evidence.
 * Measured against the module before the `storing` guard:
 *
 *   brightnessUp  -> ['밝기 +1', '밝기 +1']
 *   reset         -> ['채도 0', '색 조정 초기화됨']   (one per knob that moved)
 *
 * §3.3.5's "one updating readout rather than forty stacked ones" is a product
 * rule, and a per-knob readout stacked under a whole-gesture one is the shape it
 * names. `show()` coalesces by kind, which is exactly why nothing but a counting
 * assertion could see it.
 */
test('one gesture produces exactly one OSD readout, never a stack', async () => {
  await coldStart()
  await run('video-color.setKnob', { knob: 'saturation', value: 30 })
  assert.deepEqual(osdMessages, ['채도 +30'])

  clear()
  await run('video-color.reset')
  assert.deepEqual(
    osdMessages,
    ['색 조정 초기화됨'],
    'the reset speaks once for the whole gesture; the knobs it moved must not each announce'
  )

  clear()
  await run('video-color.setKnob', { knob: 'brightness', value: 5 })
  await run('video-color.toggleLevels')
  await run('video-color.setOutputLevels', 'limited')
  assert.deepEqual(osdMessages, [
    '밝기 +5',
    '블랙/화이트 레벨 켜짐',
    '출력 범위: 제한 (TV, 16-235)'
  ])
})

test('the step commands cover all five knobs in both directions', async () => {
  await coldStart()
  for (const knob of ['brightness', 'contrast', 'saturation', 'hue', 'gamma']) {
    await run(`video-color.${knob}Up`)
    await run(`video-color.${knob}Up`)
    await run(`video-color.${knob}Down`)
    assert.equal(props.get(knob), 1, knob)
  }
})

test('a step at the limit clamps instead of sending mpv a value it rejects', async () => {
  await coldStart()
  props.set('hue', 100)
  setSetting('video-color.hue', 100)
  clear()
  await run('video-color.hueUp')
  assert.deepEqual(writes, [], 'mpv already holds 100; nothing to write')
  assert.deepEqual(osdMessages, ['색조 +100'], 'the readout still confirms the key press')
})

test('the arg-driven entry point clamps and ignores an unknown knob', async () => {
  await coldStart()
  await run('video-color.setKnob', { knob: 'contrast', value: 900 })
  assert.equal(props.get('contrast'), 100)
  clear()
  await run('video-color.setKnob', { knob: 'gamma-factor', value: 5 })
  await run('video-color.setKnob', undefined)
  assert.deepEqual(writes, [])
})

// --- V03 -------------------------------------------------------------------

test("V03: the last-used toggle zeroes the tuple and gives it back", async () => {
  await coldStart()
  await run('video-color.setKnob', { knob: 'brightness', value: 20 })
  await run('video-color.setKnob', { knob: 'gamma', value: -8 })
  clear()

  await run('video-color.toggleLastUsed')
  assert.deepEqual(mpvTuple(), NEUTRAL_TUPLE)
  assert.deepEqual(writes.map((w) => w.name).sort(), ['brightness', 'gamma'])
  assert.deepEqual(osdMessages, ['색 조정 끔'])

  clear()
  await run('video-color.toggleLastUsed')
  assert.equal(props.get('brightness'), 20)
  assert.equal(props.get('gamma'), -8)
  assert.deepEqual(osdMessages, ['색 조정 되살림'])
  assert.equal(getSetting<number>('video-color.brightness'), 20, 'and it sticks for the next file')
})

test('V03: with nothing to restore the toggle says so instead of doing nothing', async () => {
  await coldStart()
  await run('video-color.toggleLastUsed')
  assert.deepEqual(writes, [])
  assert.deepEqual(osdMessages, ['되살릴 색 조정이 없습니다'])
})

test('V53: reset puts every property, every toggle and every slot back', async () => {
  await coldStart()
  await run('video-color.setKnob', { knob: 'saturation', value: 30 })
  await run('video-color.toggleLevels')
  await run('video-color.toggleChromaShift')
  setSetting('video-color.levelsBlack', 0.2)
  clear()

  await run('video-color.reset')

  assert.deepEqual(mpvTuple(), NEUTRAL_TUPLE)
  assert.equal(props.get('video-output-levels'), 'auto')
  assert.equal(getSetting<number>('video-color.levelsBlack'), LEVELS_DEFAULTS.black)
  assert.equal(getSetting<boolean>('video-color.levels'), false)
  assert.equal(slots.get('rl-levels')?.enabled, false)
  assert.equal(slots.get('rl-cshift')?.enabled, false)
  assert.deepEqual(osdMessages.at(-1), '색 조정 초기화됨')
})

// --- V04 -------------------------------------------------------------------

test('V04: the output-level mediator only ever writes one of mpv three values', async () => {
  await coldStart()
  await run('video-color.setOutputLevels', 'limited')
  assert.equal(props.get('video-output-levels'), 'limited')
  await run('video-color.setOutputLevels', 'nonsense')
  assert.equal(props.get('video-output-levels'), 'auto')
})

// --- V05 / V06 / V07: the chain -------------------------------------------

test('a colour filter puts nothing in the chain until it is switched on', async () => {
  await coldStart()
  await loadFile()
  assert.deepEqual(vfCalls, [], 'three disabled slots must not be parked in the chain')
})

test('V05: switching levels on sets the spec BEFORE enabling the slot', async () => {
  await coldStart()
  await run('video-color.toggleLevels')
  assert.deepEqual(vfCalls, [
    { op: 'set', args: ['rl-levels', levelsSpec(LEVELS_DEFAULTS)] },
    { op: 'toggle', args: ['rl-levels', true] }
  ])
  assert.deepEqual(osdMessages, ['블랙/화이트 레벨 켜짐'])
})

test('V05: moving the black point is a live four-argument vf-command per channel', async () => {
  await coldStart()
  await run('video-color.toggleLevels')
  clear()
  setSetting('video-color.levelsBlack', 0.1)
  await flush()

  const spec = levelsSpec({ black: 0.1, white: LEVELS_DEFAULTS.white })
  assert.deepEqual(vfCalls, [
    { op: 'command', args: ['rl-levels', 'rimin', '0.1', 'colorlevels', spec] },
    { op: 'command', args: ['rl-levels', 'gimin', '0.1', 'colorlevels', spec] },
    { op: 'command', args: ['rl-levels', 'bimin', '0.1', 'colorlevels', spec] }
  ])
  // The slot ends up holding the POST-change spec, which is what stops the next
  // whole-chain rebuild reverting the drag.
  assert.equal(slots.get('rl-levels')?.spec, spec)
})

test('a filter toggled off is disabled IN PLACE, never removed', async () => {
  await coldStart()
  await run('video-color.toggleLevels')
  clear()
  await run('video-color.toggleLevels')
  assert.deepEqual(vfCalls, [{ op: 'toggle', args: ['rl-levels', false] }])
  // §5: the slot keeps its spec, so the user's black point survives the toggle
  // and coming back is not a whole-chain rebuild.
  assert.equal(slots.get('rl-levels')?.spec, levelsSpec(LEVELS_DEFAULTS))
})

test('V06: auto level carries the mandatory smoothing and has no live options', async () => {
  await coldStart()
  await run('video-color.toggleAutoLevel')
  assert.deepEqual(vfCalls, [
    { op: 'set', args: ['rl-autolevel', autoLevelSpec()] },
    { op: 'toggle', args: ['rl-autolevel', true] }
  ])
  assert.match(autoLevelSpec(), /smoothing=50/)
})

// --- ownership -------------------------------------------------------------

test('the module never writes a property it does not own, and never a raw chain command', async () => {
  const owned = new Set(mod.ownsProperties ?? [])
  for (const w of writes) assert.ok(owned.has(w.name), `wrote unowned property '${w.name}'`)
  // Every filter change went through ctx.vf. A raw `['vf', …]` is refused for
  // every feature module, and `ctx.mpv.command` is not called at all here.
  assert.deepEqual(rawCommands, [])
  // And every IPC channel is inside this module's own `${ctx.id}:` namespace.
  assert.deepEqual([...ipcListeners.keys()], ['video-color:reset'])
  assert.deepEqual([...ipcHandlers.keys()], ['video-color:stats'])
  for (const ch of [...ipcListeners.keys(), ...ipcHandlers.keys()]) {
    assert.ok(ch.startsWith('video-color:'), ch)
  }
})

// --- §4.2: the stats block -------------------------------------------------

/**
 * The stats rows are asserted on their CONTENT, not on "a handler was
 * registered". The last row is the one that matters: §6.3's criterion for this
 * module is that brightness moves the picture with hwdec ACTIVE, i.e. that the
 * five knobs are VO-level properties and no CPU filter of this module's is in
 * the chain — a claim you can only check in the app if something reports both.
 */
test('§4.2: the stats block reports the tuple, the range and which slots are live', async () => {
  await coldStart()
  const pull = async (): Promise<Array<{ labelKey: string; value: string }>> => {
    const r = (await ipcHandlers.get('video-color:stats')?.(undefined)) as {
      rows: Array<{ labelKey: string; value: string }>
    }
    return r.rows
  }

  let rows = await pull()
  assert.deepEqual(rows, [
    { labelKey: 'video-color.brightness', value: '0' },
    { labelKey: 'video-color.contrast', value: '0' },
    { labelKey: 'video-color.saturation', value: '0' },
    { labelKey: 'video-color.hue', value: '0' },
    { labelKey: 'video-color.gamma', value: '0' },
    { labelKey: 'video-color.outputLevels', value: 'auto' },
    // No lavfi slot of this module's is in the chain, so a colour change that
    // survives hwdec cannot be coming from a filter.
    { labelKey: 'video-color.statsCpuFilters', value: '—' }
  ])

  await run('video-color.setKnob', { knob: 'brightness', value: -20 })
  await run('video-color.setOutputLevels', 'full')
  await run('video-color.toggleAutoLevel')
  await run('video-color.toggleChromaShift')
  rows = await pull()
  assert.equal(rows.find((r) => r.labelKey === 'video-color.brightness')?.value, '-20')
  assert.equal(rows.find((r) => r.labelKey === 'video-color.outputLevels')?.value, 'full')
  assert.equal(
    rows.find((r) => r.labelKey === 'video-color.statsCpuFilters')?.value,
    'rl-autolevel, rl-cshift',
    'only this module labels, and only the ones actually enabled'
  )
  // Every label the block emits must be translated in both catalogs, which the
  // sweep above enforces for the two static keys; these are the dynamic half.
  for (const r of rows) {
    assert.ok(r.labelKey in (catalogs.get('ko') ?? {}), r.labelKey)
    assert.ok(r.labelKey in (catalogs.get('en') ?? {}), r.labelKey)
  }
})

// --- V53: the per-file slice ----------------------------------------------

test('V53: the slice captures the live tuple, the output level and the three toggles', async () => {
  await coldStart()
  await run('video-color.setKnob', { knob: 'brightness', value: 12 })
  await run('video-color.toggleAutoLevel')
  assert.ok(slice)
  assert.deepEqual(slice.capture(), {
    brightness: 12,
    contrast: 0,
    saturation: 0,
    hue: 0,
    gamma: 0,
    outputLevels: 'auto',
    levels: false,
    autoLevel: true,
    chromaShift: false
  })
  // The filter PARAMETERS are deliberately absent: a file remembering "black
  // point 0.071" makes a later default change unshippable (P51).
  assert.equal('levelsBlack' in slice.capture(), false)
})

test("V53: a file with nothing stored starts from the user's defaults, not the last file's", async () => {
  await coldStart()
  // File A restored a stored override of +20. A restore writes mpv only, so the
  // preference is untouched.
  fire('start-file')
  await slice?.apply({ brightness: 20 })
  assert.equal(props.get('brightness'), 20)
  assert.equal(getSetting<number>('video-color.brightness'), 0, 'a restore is not a preference')

  // File B has nothing stored, so `apply()` is never called for it — and mpv's
  // properties are process-global, so without the baseline reset below the +20
  // silently follows the user into the next film.
  fire('start-file')
  await loadFile()
  assert.equal(props.get('brightness'), 0)
})

/**
 * THE ORDER-INDEPENDENCE TEST, and why it is the most valuable one here.
 *
 * Both this module's `afterFileLoaded` (which applies the user's defaults) and
 * core's per-file slice restore (which applies this file's stored override) run
 * from the SAME callback list on the bus, in registration order. Today the
 * module wins that race because `registry.loadAll()` is called before
 * `mpvBus.afterFileLoaded(perFile.onFileLoaded)` in `src/main/index.ts` — an
 * ordering no part of the module API states, that a module cannot observe, and
 * that a reviewer reordering two lines of core boot code would not connect to a
 * colour setting quietly reverting to 0.
 *
 * So the module does not rely on it: `start-file` clears a flag, the slice
 * restore sets it, and the baseline apply is skipped when it is set. This test
 * drives BOTH orders. Measured against the naive version (an unconditional
 * `applyTuple(defaultTuple())` in `afterFileLoaded`, with no flag), the
 * baseline-second order fails with `brightness: 0` — the stored +20 clobbered
 * by the defaults, i.e. per-file colour silently not working.
 */
test('V53: a stored restore beats the baseline in EITHER order', async () => {
  // Order A: baseline first, restore second (today's real order).
  await coldStart()
  fire('start-file')
  await loadFile()
  await slice?.apply({ brightness: 20, autoLevel: true })
  assert.equal(props.get('brightness'), 20, 'order A: the restore must win')
  assert.equal(slots.get('rl-autolevel')?.enabled, true)

  // Order B: restore first, baseline second.
  await coldStart()
  fire('start-file')
  await slice?.apply({ brightness: 20, autoLevel: true })
  await loadFile()
  assert.equal(props.get('brightness'), 20, 'order B: the restore must still win')
  assert.equal(slots.get('rl-autolevel')?.enabled, true)
})

test('V53: the restore is per-file, so the NEXT file is not restored again', async () => {
  await coldStart()
  fire('start-file')
  await slice?.apply({ brightness: 20 })
  await loadFile()
  assert.equal(props.get('brightness'), 20)

  // A new file: `start-file` clears the flag, so the baseline applies again.
  fire('start-file')
  await loadFile()
  assert.equal(props.get('brightness'), 0)
})

test('V53: a stored slice from an older build cannot inject a foreign property', async () => {
  await coldStart()
  fire('start-file')
  await slice?.apply({ brightness: 5, vf: 'lavfi=[hflip]', 'video-rotate': 90 } as never)
  const owned = new Set(mod.ownsProperties ?? [])
  for (const w of writes) assert.ok(owned.has(w.name), `restore wrote '${w.name}'`)
  assert.equal(props.get('video-rotate'), undefined)
})
