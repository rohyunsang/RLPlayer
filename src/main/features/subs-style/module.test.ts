import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  CommandDescriptor,
  FeatureContext,
  MenuNode,
  SettingDescriptor
} from '@shared/feature-api'
import mod, { UI_STATE_KEYS, type SubsStyleUiState } from './index.ts'
import { ROWS, rowByKey, settingIdOf } from './style.ts'

/**
 * M19's WIRING, driven through the real module rather than through a description
 * of it.
 *
 * Nothing here lists what the module is supposed to do. It calls `setup()` with
 * a recording context, pushes the same events the app pushes, and asserts on the
 * calls that come out — and it asserts the VALUE that reached mpv, not that a
 * call happened. "A `set` was issued for `sub-pos`" is satisfied by the very bug
 * a clamping table exists to prevent.
 */

// --- a recording FeatureContext -------------------------------------------

interface MpvSet {
  name: string
  value: unknown
}

const sets: MpvSet[] = []
const rawCommands: unknown[][] = []
const osdMessages: string[] = []
const sent: Array<{ channel: string; payload: unknown; target?: string }> = []
const invoked: Array<{ id: string; arg?: unknown }> = []
const commands = new Map<string, CommandDescriptor>()
const descriptors = new Map<string, SettingDescriptor>()
const ipcHandlers = new Map<string, (req: unknown) => unknown>()
const ipcListeners = new Map<string, (req: unknown) => void>()
const catalogs = new Map<string, Record<string, string>>()
const values = new Map<string, unknown>()
const settingListeners = new Map<string, Array<(v: unknown, prev: unknown) => void>>()
const observers = new Map<string, Array<(v: unknown) => void>>()
const fileLoadedCbs: Array<(p: string) => void> = []
const argContributors: Array<{ priority: number; fn: () => string[] }> = []
const menuSections: Array<{ id: string; order: number; labelKey: string; items: readonly MenuNode[] }> = []
const logs: string[] = []

/** Properties this fake mpv refuses, to exercise `pushRow`'s failure path. */
const refuse = new Set<string>()
/** What the fake mpv "holds", so a readback after a refusal has something to say. */
const held = new Map<string, unknown>()

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
  id: 'subs-style',
  log: {
    info: () => {},
    warn: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => logs.push(a.map(String).join(' '))
  },
  mpv: {
    set: async (name: string, value: unknown): Promise<void> => {
      if (refuse.has(name)) throw new Error('unsupported format for accessing property')
      sets.push({ name, value })
      held.set(name, value)
    },
    get: async (name: string): Promise<unknown> => held.get(name),
    command: async (args: unknown[]): Promise<unknown> => {
      rawCommands.push(args)
      return undefined
    },
    observe: (name: string, cb: (v: unknown) => void) => {
      const list = observers.get(name) ?? []
      list.push(cb)
      observers.set(name, list)
      return () => {}
    },
    peek: () => undefined,
    afterFileLoaded: (cb: (p: string) => void) => {
      fileLoadedCbs.push(cb)
      return () => {}
    },
    onEvent: () => () => {},
    contributeArgs: (priority: number, fn: () => string[]) =>
      argContributors.push({ priority, fn })
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
      for (const c of list) {
        assert.equal(commands.has(c.id), false, `duplicate command id ${c.id}`)
        commands.set(c.id, c)
      }
    },
    has: (id: string) => commands.has(id) || id === 'subs-tracks.reload',
    invoke: async (id: string, arg?: unknown): Promise<void> => {
      invoked.push({ id, arg })
      const c = commands.get(id)
      if (c) await c.run(arg)
    },
    query: async () => undefined
  },
  ipc: {
    handle: (channel: string, fn: (req: unknown) => unknown) => ipcHandlers.set(channel, fn),
    on: (channel: string, fn: (req: unknown) => void) => ipcListeners.set(channel, fn),
    send: (channel: string, payload: unknown, target?: string) =>
      sent.push({ channel, payload, target })
  },
  osd: { show: (m: { text: string }) => osdMessages.push(m.text) },
  menu: {
    contribute: (s: { id: string; order: number; labelKey: string; items: readonly MenuNode[] }) =>
      menuSections.push(s)
  },
  i18n: {
    register: (lang: string, messages: Record<string, string>) => {
      catalogs.set(lang, { ...(catalogs.get(lang) ?? {}), ...messages })
    },
    t: (key: string, params?: Record<string, string | number>) => {
      let s = catalogs.get('ko')?.[key] ?? key
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
      return s
    }
  }
} as unknown as FeatureContext

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const clear = (): void => {
  sets.length = 0
  rawCommands.length = 0
  osdMessages.length = 0
  sent.length = 0
  invoked.length = 0
  logs.length = 0
}

await mod.setup!(ctx)
await flush()
const setupSets = [...sets]
clear()

// --- what setup() declared -------------------------------------------------

test('the module id equals its directory name', () => {
  assert.equal(mod.id, 'subs-style')
})

test('ownsProperties and the table are the same set, in both directions', () => {
  const declared = [...(mod.ownsProperties ?? [])].sort()
  const table = ROWS.map((r) => r.mpv).sort()
  assert.deepEqual(declared, table)
})

test('the module declares no commands and no filter labels — it writes properties only', () => {
  assert.deepEqual(mod.ownsCommands ?? [], [])
  assert.deepEqual(mod.ownsFilterLabels ?? [], [])
  assert.equal(mod.usesVideoFilters, undefined)
  assert.equal(mod.usesAudioFilters, undefined)
})

test('dependsOn is copied from the manifest namespace, not invented', () => {
  assert.deepEqual(mod.dependsOn, ['core-mpv-bus', 'subs-tracks'])
})

test('one descriptor per row reached the registry', () => {
  assert.equal(descriptors.size, ROWS.length)
  for (const row of ROWS) assert.ok(descriptors.has(settingIdOf(row)), row.key)
})

// --- i18n, in both languages ----------------------------------------------

/**
 * Every key the module can ever ask `t()` for, gathered from the descriptors and
 * the commands the module actually registered — not from a list typed here. A
 * label added without a translation fails; so does a translation for a key
 * nothing uses, which is how a catalog rots.
 */
function keysInUse(): string[] {
  const keys = new Set<string>()
  for (const d of descriptors.values()) {
    keys.add(d.labelKey)
    if (d.descriptionKey) keys.add(d.descriptionKey)
    if (d.group) keys.add(d.group)
    if (d.type.kind === 'enum') for (const o of d.type.options) keys.add(o.labelKey)
  }
  for (const c of commands.values()) keys.add(c.labelKey)
  for (const s of menuSections) {
    keys.add(s.labelKey)
    const walk = (nodes: readonly MenuNode[]): void => {
      for (const n of nodes) {
        if ('labelKey' in n && n.labelKey) keys.add(n.labelKey)
        if ('submenu' in n && n.submenu) walk(n.submenu)
      }
    }
    walk(s.items)
  }
  return [...keys]
}

for (const lang of ['ko', 'en']) {
  test(`every key in use has a ${lang} translation`, () => {
    const cat = catalogs.get(lang) ?? {}
    const missing = keysInUse().filter((k) => !(k in cat))
    assert.deepEqual(missing, [])
  })
}

test('the two catalogs cover exactly the same keys', () => {
  const ko = Object.keys(catalogs.get('ko') ?? {}).sort()
  const en = Object.keys(catalogs.get('en') ?? {}).sort()
  assert.deepEqual(ko, en)
})

test('every registered key is namespaced to this module', () => {
  for (const cat of catalogs.values()) {
    for (const k of Object.keys(cat)) assert.ok(k.startsWith('subs-style.'), k)
  }
})

test('no catalog entry is left as English text in the Korean catalog', () => {
  const ko = catalogs.get('ko') ?? {}
  const en = catalogs.get('en') ?? {}
  const identical = Object.keys(ko).filter((k) => ko[k] === en[k])
  // A few values are genuinely the same in both ('SDR', '203 nit' vs '203 nits'
  // differ, but 'SDR' does not), so the assertion is on the SHAPE: an identical
  // value is only allowed where it contains no lowercase prose.
  const suspicious = identical.filter((k) => /[a-z]{4,}\s+[a-z]{2,}/.test(String(ko[k])))
  assert.deepEqual(suspicious, [], 'Korean entries that are still English sentences')
})

test('the ASS-override label says the default is off, in both languages', () => {
  assert.match(String(catalogs.get('ko')?.['subs-style.desc.assOverride']), /끔/)
  assert.match(String(catalogs.get('en')?.['subs-style.desc.assOverride']), /[Oo]ff by default/)
})

// --- spawn arguments ------------------------------------------------------

test('exactly one arg contributor, in the Wave-1 band', () => {
  assert.equal(argContributors.length, 1)
  assert.ok(argContributors[0]!.priority >= 1 && argContributors[0]!.priority <= 999)
})

test('the contributed args style the first frame and carry no duplicate option', () => {
  const args = argContributors[0]!.fn()
  const names = args.map((a) => a.slice(0, a.indexOf('=')))
  assert.equal(new Set(names).size, names.length, 'a duplicate option name would fail §4')
  assert.ok(args.includes('--sub-ass-override=no'), 'the module default must reach the spawn')
  assert.ok(args.includes('--sub-font-size=38'))
  assert.ok(args.includes('--sub-bold=no'))
  assert.ok(args.includes('--sub-back-color=#AF000000'))
  // The three String lists are property writes only; an empty path is nothing.
  for (const n of [
    '--sub-filter-regex',
    '--sub-filter-sdh-enclosures',
    '--sub-ass-style-overrides',
    '--sub-fonts-dir',
    '--sub-ass-styles'
  ]) {
    assert.equal(names.includes(n), false, `${n} must not be a spawn arg`)
  }
})

test('the args follow the settings, so a respawn keeps the user styling', () => {
  setSetting('subs-style.fontSize', 52)
  setSetting('subs-style.assOverride', 'force')
  const args = argContributors[0]!.fn()
  assert.ok(args.includes('--sub-font-size=52'))
  assert.ok(args.includes('--sub-ass-override=force'))
  setSetting('subs-style.fontSize', 38)
  setSetting('subs-style.assOverride', 'no')
  clear()
})

// --- property writes ------------------------------------------------------

test('a settings change writes the mapped property with the mapped value', () => {
  clear()
  setSetting('subs-style.font', 'Malgun Gothic')
  setSetting('subs-style.borderStyle', 'background-box')
  setSetting('subs-style.bold', true)
  assert.deepEqual(sets, [
    { name: 'sub-font', value: 'Malgun Gothic' },
    { name: 'sub-border-style', value: 'background-box' },
    { name: 'sub-bold', value: true }
  ])
})

test('an out-of-range setting is CLAMPED on the way to mpv, not passed through', () => {
  clear()
  // 200 is a value the pinned binary refuses outright (style.ts finding 2).
  setSetting('subs-style.pos', 200)
  assert.deepEqual(sets, [{ name: 'sub-pos', value: 150 }])
})

test('a list property is written as a real array', () => {
  clear()
  setSetting('subs-style.filterRegex', ['OpenSubtitles', 'Subtitles by'])
  assert.deepEqual(sets, [
    { name: 'sub-filter-regex', value: ['OpenSubtitles', 'Subtitles by'] }
  ])
})

test('the module never issues an mpv COMMAND — every row is a property', async () => {
  clear()
  for (const row of ROWS) {
    const id = settingIdOf(row)
    // Nudge every row off its default and back, so every code path runs.
    if (row.kind === 'bool') setSetting(id, row.def !== true)
    else if (row.kind === 'int' || row.kind === 'float') setSetting(id, row.min ?? 0)
    else if (row.kind === 'enum') setSetting(id, (row.choices ?? [])[0])
  }
  await flush()
  assert.deepEqual(rawCommands, [], 'a raw mpv command escaped a property-only module')
  // and in particular never sub-reload, which is M17's
  assert.equal(
    invoked.some((i) => i.id === 'sub-reload'),
    false
  )
  // This test moved every row, so put the store back before the next one runs.
  ipcListeners.get('subs-style:reset')!(undefined)
  await flush()
  clear()
})

test('a refused write names the value sent AND what mpv is still holding', async () => {
  clear()
  held.set('sub-blur', 0)
  refuse.add('sub-blur')
  setSetting('subs-style.blur', 3)
  await flush()
  refuse.delete('sub-blur')
  assert.equal(logs.length, 1, logs.join(' | '))
  assert.match(logs[0]!, /sub-blur/)
  assert.match(logs[0]!, /to 3/)
  assert.match(logs[0]!, /mpv holds 0/)
  clear()
})

// --- S22: the reload mediator, and never sub-reload ------------------------

test('a track-parse-time row asks M17 to reload, debounced to one call', async () => {
  clear()
  setSetting('subs-style.assStyleOverrides', ['Default.Bold=1'])
  setSetting('subs-style.assStyles', 'C:/x/custom.ass')
  await flush()
  const reloads = invoked.filter((i) => i.id === 'subs-tracks.reload')
  assert.equal(reloads.length, 1, 'two reload-worthy writes must coalesce to one reload')
  assert.deepEqual(rawCommands, [])
  clear()
})

test('a row libass re-reads live asks for no reload at all', async () => {
  clear()
  setSetting('subs-style.fontSize', 44)
  await flush()
  assert.deepEqual(
    invoked.filter((i) => i.id === 'subs-tracks.reload'),
    []
  )
  setSetting('subs-style.fontSize', 38)
  clear()
})

// --- per-file / S25 -------------------------------------------------------

test('afterFileLoaded pushes exactly the rows that cannot be spawn args', async () => {
  clear()
  for (const cb of fileLoadedCbs) cb('C:/x/ep01.mkv')
  await flush()
  const names = sets.map((s) => s.name).sort()
  assert.deepEqual(names, [
    'sub-ass-style-overrides',
    'sub-filter-regex',
    'sub-filter-sdh-enclosures'
  ])
  clear()
})

test('an image-subtitle track is reported to the settings window, and a text one is not', async () => {
  const feed = (v: unknown): void => {
    for (const cb of observers.get('current-tracks/sub/codec') ?? []) cb(v)
  }
  clear()
  feed('hdmv_pgs_subtitle')
  await flush()
  const a = sent.at(-1)?.payload as SubsStyleUiState
  assert.equal(a.imageSub, true)
  assert.equal(a.codec, 'hdmv_pgs_subtitle')

  clear()
  feed('ass')
  await flush()
  const b = sent.at(-1)?.payload as SubsStyleUiState
  assert.equal(b.imageSub, false)
  assert.equal(b.codec, 'ass')

  // `undefined` is what mpv reports with no subtitle selected — a real value,
  // never coerced to '' (§3).
  clear()
  feed(undefined)
  await flush()
  const c = sent.at(-1)?.payload as SubsStyleUiState
  assert.equal(c.codec, null)
  assert.equal(c.imageSub, false)
  clear()
})

test('an unchanged codec does not re-broadcast', async () => {
  const feed = (v: unknown): void => {
    for (const cb of observers.get('current-tracks/sub/codec') ?? []) cb(v)
  }
  feed('ass')
  await flush()
  clear()
  feed('ass')
  await flush()
  assert.deepEqual(sent, [])
  clear()
})

test('the state payload has exactly the keys the renderer half expects', () => {
  const state = ipcHandlers.get('subs-style:query')!(undefined) as SubsStyleUiState
  assert.deepEqual(Object.keys(state).sort(), [...UI_STATE_KEYS])
  // and the colour map is keyed by SETTING id, one entry per colour row
  const colourRows = ROWS.filter((r) => r.kind === 'color').map(settingIdOf).sort()
  assert.deepEqual(Object.keys(state.colors).sort(), colourRows)
  for (const id of colourRows) assert.match(state.colors[id]!, /^#[0-9A-F]{8}$/)
})

test('a colour change reaches the settings window, coalesced to one message', async () => {
  clear()
  setSetting('subs-style.color', '#FFFF0000')
  setSetting('subs-style.outlineColor', '#FF00FF00')
  await flush()
  const msgs = sent.filter((s) => s.channel === 'subs-style:state')
  assert.equal(msgs.length, 1, 'two colour writes must coalesce to one broadcast')
  const state = msgs[0]!.payload as SubsStyleUiState
  assert.equal(state.colors['subs-style.color'], '#FFFF0000')
  assert.equal(state.colors['subs-style.outlineColor'], '#FF00FF00')
  assert.equal(msgs[0]!.target, 'settings')
  clear()
})

// --- presets and the legacy bridge ---------------------------------------

test('a preset writes its whole map and mpv receives every property', async () => {
  /**
   * Reset first, deliberately. Every one of the eight values `readable` writes
   * differs from its descriptor default, so from a reset store all eight are
   * real changes and must all reach mpv. Without this the test passes for the
   * wrong reason: `ctx.settings.set` is idempotent, so a row an EARLIER test
   * left already sitting on the preset's value produces no write at all, and the
   * assertion would then be measuring test order rather than the preset.
   */
  ipcListeners.get('subs-style:reset')!(undefined)
  await flush()
  clear()
  ipcListeners.get('subs-style:applyPreset')!({ id: 'readable' })
  await flush()
  const got = new Map(sets.map((s) => [s.name, s.value]))
  assert.equal(got.get('sub-font-size'), 52)
  assert.equal(got.get('sub-border-style'), 'background-box')
  assert.equal(got.get('sub-back-color'), '#C0000000')
  assert.equal(got.get('sub-outline-size'), 2.5)
  assert.equal(got.get('sub-shadow-offset'), 2)
  assert.equal(got.get('sub-ass-override'), 'force')
  assert.equal(got.get('sub-scale-signs'), true)
  assert.equal(got.get('sub-margin-y'), 48)
  assert.equal(osdMessages.at(-1), catalogs.get('ko')?.['subs-style.preset.readable'])
  clear()
})

test('an unknown preset id changes nothing and says nothing', async () => {
  clear()
  ipcListeners.get('subs-style:applyPreset')!({ id: 'nope' })
  await flush()
  assert.deepEqual(sets, [])
  assert.deepEqual(osdMessages, [])
  clear()
})

test('reset returns every property to its declared default', async () => {
  clear()
  ipcListeners.get('subs-style:reset')!(undefined)
  await flush()
  const got = new Map(sets.map((s) => [s.name, s.value]))
  assert.equal(got.get('sub-ass-override'), 'no')
  assert.equal(got.get('sub-font-size'), 38)
  assert.equal(got.get('sub-border-style'), 'outline-and-shadow')
  clear()
})

/**
 * The three ids `src/main/ipc.ts` invokes by name. That file is core's, so the
 * ids and the ARGUMENT SHAPES are a contract this module may not quietly rename
 * — and `setAssOverride` takes the v0.1 BOOLEAN, where `true` meant the
 * checkbox "use my font", i.e. `force`. Getting that backwards ships a player
 * that overrides every fansub's typesetting on upgrade.
 */
test('the legacy boolean override maps true to force and false to no', async () => {
  clear()
  await ctx.commands.invoke('subs-style.setAssOverride', true)
  await flush()
  assert.deepEqual(sets.at(-1), { name: 'sub-ass-override', value: 'force' })
  clear()
  await ctx.commands.invoke('subs-style.setAssOverride', false)
  await flush()
  assert.deepEqual(sets.at(-1), { name: 'sub-ass-override', value: 'no' })
  clear()
})

test('the five-state entry point takes the string, and rejects nonsense to the default', async () => {
  clear()
  await ctx.commands.invoke('subs-style.setAssOverrideMode', 'scale')
  assert.deepEqual(sets.at(-1), { name: 'sub-ass-override', value: 'scale' })
  clear()
  await ctx.commands.invoke('subs-style.setAssOverrideMode', 'banana')
  assert.deepEqual(sets.at(-1), { name: 'sub-ass-override', value: 'no' })
  clear()
})

test('the legacy scale entry point clamps rather than failing on the wire', async () => {
  clear()
  await ctx.commands.invoke('subs-style.setScale', 999)
  const row = rowByKey('scale')!
  assert.deepEqual(sets.at(-1), { name: 'sub-scale', value: row.max })
  clear()
  await ctx.commands.invoke('subs-style.setScale', 1)
  clear()
})

// --- commands and keybinds ------------------------------------------------

test('every command id is namespaced and every label key is registered', () => {
  for (const c of commands.values()) {
    assert.ok(c.id.startsWith('subs-style.'), c.id)
    assert.ok(c.labelKey.startsWith('subs-style.'), c.labelKey)
    assert.equal(c.category, 'subtitles')
  }
})

test('menuPath is one of the eight roots, menuOrder is present, and no mediator has one', () => {
  const roots = new Set([
    'playback',
    'video',
    'audio',
    'subtitles',
    'navigate',
    'capture',
    'window',
    'tools'
  ])
  const slots = new Set<string>()
  for (const c of commands.values()) {
    if (c.menuPath === undefined) {
      assert.equal(c.menuOrder, undefined, `${c.id} orders a menu entry it does not have`)
      continue
    }
    assert.ok(roots.has(c.menuPath), `${c.id}: ${c.menuPath}`)
    assert.equal(c.menuPath.includes('/'), false, 'menuPath does not nest')
    assert.equal(typeof c.menuOrder, 'number', `${c.id} has no menuOrder`)
    assert.notEqual(c.internal, true, `${c.id} is internal and also in the menu`)
    const slot = `${c.menuPath}#${c.menuOrder}`
    assert.equal(slots.has(slot), false, `duplicate slot ${slot}`)
    slots.add(slot)
  }
})

/**
 * P16: accelerators are PHYSICAL codes. With the Korean IME composing, `e.key`
 * is `'Process'` for every letter, so a `key`-based binding stops working the
 * moment somebody switches to 한글 — which for this module's audience is most of
 * the time.
 */
test('every default accelerator is a physical code with modifiers in order', () => {
  const physical =
    /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F[0-9]{1,2}|Arrow(Up|Down|Left|Right)|Space|Comma|Period|Slash|Minus|Equal|Semicolon|Quote|Backquote|Bracket(Left|Right)|Backslash|Home|End|PageUp|PageDown|Insert|Delete|Enter|Escape|Tab|Backspace|MBTN_[A-Z_]+|WHEEL_[A-Z]+)$/
  let seen = 0
  for (const c of commands.values()) {
    for (const [preset, accels] of Object.entries(c.defaults ?? {})) {
      for (const a of accels ?? []) {
        seen++
        assert.match(a, physical, `${c.id}/${preset}: '${a}' is not a physical accelerator`)
      }
    }
  }
  assert.ok(seen >= 12, `only ${seen} accelerators declared — did the defaults vanish?`)
})

test('no keybindable command is internal, and no mediator is keybindable', () => {
  for (const c of commands.values()) {
    if (c.internal) assert.equal(c.defaults, undefined, `${c.id} is internal and bindable`)
  }
})

test('the cycle keybind steps S21 four states and skips yes', async () => {
  clear()
  setSetting('subs-style.assOverride', 'no')
  clear()
  const cycle = commands.get('subs-style.cycleAssOverride')!
  const seen: unknown[] = []
  for (let i = 0; i < 5; i++) {
    await cycle.run()
    seen.push(getSetting('subs-style.assOverride'))
  }
  assert.deepEqual(seen, ['scale', 'force', 'strip', 'no', 'scale'])
  setSetting('subs-style.assOverride', 'no')
  clear()
})

test('the scale keybinds step and clamp, and say so on the OSD', async () => {
  clear()
  setSetting('subs-style.scale', 1)
  clear()
  await commands.get('subs-style.scaleUp')!.run()
  assert.equal(getSetting('subs-style.scale'), 1.1)
  assert.equal(osdMessages.length, 1)
  assert.match(osdMessages[0]!, /1\.10/)
  await commands.get('subs-style.scaleDown')!.run()
  assert.equal(getSetting('subs-style.scale'), 1)
  setSetting('subs-style.scale', 1)
  clear()
})

/** `sub-pos` counts DOWNWARDS: 100 is authored, >100 is lower on the frame. */
test('subtitles-up subtracts from sub-pos and subtitles-down adds', async () => {
  clear()
  setSetting('subs-style.pos', 100)
  clear()
  await commands.get('subs-style.posUp')!.run()
  assert.deepEqual(sets.at(-1), { name: 'sub-pos', value: 99 })
  await commands.get('subs-style.posDown')!.run()
  assert.deepEqual(sets.at(-1), { name: 'sub-pos', value: 100 })
  setSetting('subs-style.pos', 100)
  clear()
})

test('a toggle command reports the state it moved TO', async () => {
  clear()
  setSetting('subs-style.filterSdh', false)
  clear()
  await commands.get('subs-style.toggleSdh')!.run()
  assert.deepEqual(sets.at(-1), { name: 'sub-filter-sdh', value: true })
  assert.equal(osdMessages.at(-1), catalogs.get('ko')?.['subs-style.osd.sdhOn'])
  await commands.get('subs-style.toggleSdh')!.run()
  assert.deepEqual(sets.at(-1), { name: 'sub-filter-sdh', value: false })
  assert.equal(osdMessages.at(-1), catalogs.get('ko')?.['subs-style.osd.sdhOff'])
  clear()
})

// --- the menu -------------------------------------------------------------

test('one menu section, ordered under the subtitles root and after M17 at 41', () => {
  assert.equal(menuSections.length, 1)
  assert.equal(menuSections[0]!.id, 'subs-style.menu')
  assert.equal(menuSections[0]!.order, 42)
})

test('every commandId the menu references is a command this module registered', () => {
  const walk = (nodes: readonly MenuNode[]): void => {
    for (const n of nodes) {
      if ('dynamic' in n && typeof n.dynamic === 'function') {
        walk(n.dynamic())
        continue
      }
      if ('commandId' in n && n.commandId) {
        assert.ok(commands.has(n.commandId), `menu references unknown ${n.commandId}`)
      }
      if ('submenu' in n && n.submenu) walk(n.submenu)
    }
  }
  walk(menuSections[0]!.items)
})

test('the override radio group marks exactly the current state', () => {
  setSetting('subs-style.assOverride', 'force')
  const group = menuSections[0]!.items.find(
    (n) => 'labelKey' in n && n.labelKey === 'subs-style.label.assOverride'
  ) as { submenu: readonly MenuNode[] }
  const dyn = group.submenu[0] as { dynamic(): readonly MenuNode[] }
  const nodes = dyn.dynamic() as Array<{ arg: string; checked: boolean; radio: boolean }>
  assert.deepEqual(
    nodes.map((n) => n.arg),
    ['no', 'yes', 'scale', 'force', 'strip']
  )
  assert.deepEqual(
    nodes.filter((n) => n.checked).map((n) => n.arg),
    ['force']
  )
  for (const n of nodes) assert.equal(n.radio, true)
  setSetting('subs-style.assOverride', 'no')
  clear()
})

// --- setup itself ---------------------------------------------------------

test('setup writes nothing to mpv before the first spawn', () => {
  // Every value is delivered as a spawn ARGUMENT, so styling is right on the
  // first frame; pushing properties at setup time would race the spawn.
  assert.deepEqual(setupSets, [])
})

test('dispose releases every subscription without throwing', () => {
  assert.doesNotThrow(() => mod.dispose?.())
})
