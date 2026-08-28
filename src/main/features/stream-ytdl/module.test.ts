import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CommandDescriptor, FeatureContext, SettingDescriptor } from '@shared/feature-api'
import mod from './index.ts'

/**
 * M36's module half, and the one claim that matters most in this repository:
 * NOTHING HAPPENS AT REST.
 *
 * §11.5's layers 2–4 cannot see this module's traffic at all — every request is
 * made by yt-dlp.exe, spawned by ytdl_hook.lua inside mpv.exe, two process
 * boundaries away from any Electron session — so `check:network` would report a
 * perfectly clean netlog while yt-dlp was mid-download. That makes layer 1
 * ("nothing asks") the whole guarantee for this feature, and layer 1 is only as
 * good as a test of it.
 *
 * The detector is the `[stream-ytdl] exec …` line that the module's single
 * `run()` helper logs BEFORE it spawns anything, so every attempt is visible —
 * including one that fails to spawn at all, which on Windows is a SYNCHRONOUS
 * throw from `execFile` and would be invisible to a detector keyed on the
 * resulting ChildProcess or on `trackProcess`. The first version of this suite
 * was keyed on `trackProcess` and could not see a stub binary being run, which
 * is the failure mode a "nothing at rest" audit cares about most. The second
 * test below proves the detector fires, because a spawn detector that cannot
 * see a spawn is exactly the shape of check this project keeps finding.
 */

interface Rec {
  readonly ctx: FeatureContext
  readonly writes: Array<{ property: string; value: unknown }>
  readonly commands: unknown[][]
  readonly invokes: Array<{ id: string; arg: unknown }>
  /**
   * One entry per child-process ATTEMPT. The spawn detector.
   *
   * Keyed on the module's own `[stream-ytdl] exec …` log line rather than on
   * `trackProcess`, because on Windows `execFile` throws synchronously for a
   * file that is not a valid executable, so `trackProcess` is never reached —
   * and an attempt that failed to spawn is still an attempt, which is precisely
   * what "nothing at rest" is about. Every spawn in this module goes through the
   * one `run()` helper that logs it.
   */
  readonly spawned: string[]
  readonly toasts: Array<{ kind: string; message: string; hasAction: boolean }>
  readonly registered: Map<string, CommandDescriptor>
  readonly ipcHandlers: Map<string, (req: unknown) => unknown>
  readonly dataDir: string
  set(id: string, v: unknown): void
  args(): string[]
  observed(name: string, value: unknown): void
  confirm: boolean
}

function makeCtx(dataDir: string): Rec {
  const writes: Array<{ property: string; value: unknown }> = []
  const commands: unknown[][] = []
  const invokes: Array<{ id: string; arg: unknown }> = []
  const spawned: string[] = []
  const toasts: Array<{ kind: string; message: string; hasAction: boolean }> = []
  const registered = new Map<string, CommandDescriptor>()
  const ipcHandlers = new Map<string, (req: unknown) => unknown>()
  const descriptors = new Map<string, SettingDescriptor>()
  const values = new Map<string, unknown>()
  const changeCbs = new Map<string, Array<(v: unknown, p: unknown) => void>>()
  const observers = new Map<string, Array<(v: unknown) => void>>()
  let argFns: Array<() => string[]> = []

  const getSetting = (id: string): unknown =>
    values.has(id) ? values.get(id) : descriptors.get(id)?.default
  const setSetting = (id: string, v: unknown): void => {
    const prev = getSetting(id)
    values.set(id, v)
    for (const cb of changeCbs.get(id) ?? []) cb(v, prev)
  }

  const rec: Rec = {
    writes,
    commands,
    invokes,
    spawned,
    toasts,
    registered,
    ipcHandlers,
    dataDir,
    confirm: true,
    set: setSetting,
    args: () => argFns.flatMap((f) => f()),
    observed(name, value): void {
      for (const cb of observers.get(name) ?? []) cb(value)
    },
    ctx: undefined as unknown as FeatureContext
  }

  const ctx = {
    id: 'stream-ytdl',
    log: {
      info: (...a: unknown[]): void => {
        const line = a.map(String).join(' ')
        if (line.startsWith('[stream-ytdl] exec ')) spawned.push(line)
      },
      warn: (): void => {},
      error: (): void => {}
    },
    paths: {
      dataDir: (): string => dataDir,
      cacheDir: (): string => path.join(dataDir, 'cache')
    },
    mpv: {
      observe(name: string, cb: (v: unknown) => void): () => void {
        const list = observers.get(name) ?? []
        list.push(cb)
        observers.set(name, list)
        return () => {}
      },
      peek: (): undefined => undefined,
      get: async (): Promise<undefined> => undefined,
      set: async (property: string, value: unknown): Promise<void> => {
        writes.push({ property, value })
      },
      requestSet: async (): Promise<{ ok: false; reason: string }> => ({
        ok: false,
        reason: 'no-arbiter'
      }),
      arbitrate: (): void => {},
      command: async (a: unknown[]): Promise<null> => {
        commands.push(a)
        return null
      },
      commandNoReply: (a: unknown[]): void => {
        commands.push(a)
      },
      onEvent: (): (() => void) => () => {},
      afterFileLoaded: (): (() => void) => () => {},
      contributeArgs(_p: number, fn: () => string[]): void {
        argFns = [...argFns, fn]
      },
      requestRestart: (): void => {},
      isNetworkSource: false
    },
    settings: {
      define(list: readonly SettingDescriptor[]): void {
        for (const d of list) descriptors.set(d.id, d)
      },
      get: getSetting,
      set: setSetting,
      onChange(id: string, cb: (v: unknown, p: unknown) => void): () => void {
        const list = changeCbs.get(id) ?? []
        list.push(cb)
        changeCbs.set(id, list)
        return () => {}
      },
      migrate: (): void => {}
    },
    commands: {
      register(list: readonly CommandDescriptor[]): void {
        for (const c of list) registered.set(c.id, c)
      },
      async invoke(id: string, arg?: unknown): Promise<void> {
        invokes.push({ id, arg })
        const own = registered.get(id)
        if (own) await own.run(arg)
      },
      query: async (): Promise<never> => {
        throw new Error('unused')
      },
      has: (id: string): boolean => registered.has(id)
    },
    ipc: {
      handle(ch: string, fn: (r: unknown) => unknown): void {
        ipcHandlers.set(ch, fn)
      },
      on(ch: string, fn: (r: unknown) => void): void {
        ipcHandlers.set(ch, fn as (r: unknown) => unknown)
      },
      send: (): void => {}
    },
    osd: {
      show: (): void => {},
      toast(t: { kind: string; message: string; onAction?: () => void }): void {
        toasts.push({ kind: t.kind, message: t.message, hasAction: typeof t.onAction === 'function' })
      },
      progress: () => ({ update: (): void => {}, done: (): void => {}, cancelled: false })
    },
    perFile: {},
    menu: { contribute: (): void => {} },
    i18n: { register: (): void => {}, t: (k: string): string => k },
    lifecycle: {
      onReady: (): void => {},
      onQuit: (): void => {},
      trackProcess(): void {
        /* the log line above is the detector; see `spawned` */
      }
    },
    window: {},
    dialog: {
      confirm: async (): Promise<boolean> => rec.confirm,
      openFiles: async (): Promise<string[]> => [],
      openDirectory: async (): Promise<string[]> => [],
      saveFile: async (): Promise<null> => null
    },
    network: {
      allowed: (): boolean => false,
      assertAllowed: (): void => {
        throw new Error('the allowlist should not be consulted here — see the file header')
      }
    },
    engine: {
      spawn: async (): Promise<never> => {
        throw new Error('mpv-only')
      },
      binaryPath: (): string => 'mpv.exe'
    }
  }

  ;(rec as { ctx: FeatureContext }).ctx = ctx as unknown as FeatureContext
  return rec
}

let seq = 0
function freshDir(): string {
  const d = path.join(os.tmpdir(), `rl-stream-ytdl-${process.pid}-${seq++}`)
  fs.mkdirSync(path.join(d, 'tools'), { recursive: true })
  return d
}

/**
 * A file at the FIRST probe location, so the test does not depend on whether the
 * machine running it happens to have yt-dlp on PATH.
 *
 * It is not a real executable, which is fine and is in fact the point: `execFile`
 * returns a ChildProcess synchronously and reports the spawn failure through the
 * callback, so `trackProcess` is still called — the detector sees the attempt.
 */
function plantBinary(dataDir: string): string {
  const p = path.join(dataDir, 'tools', 'yt-dlp.exe')
  fs.writeFileSync(p, 'not really an executable')
  return p
}

async function booted(plant = false): Promise<Rec> {
  const rec = makeCtx(freshDir())
  if (plant) plantBinary(rec.dataDir)
  await mod.setup(rec.ctx)
  return rec
}

// ---------------------------------------------------------------------------
// Nothing at rest
// ---------------------------------------------------------------------------

test('setup() spawns nothing, writes nothing and asks the allowlist nothing', async () => {
  const rec = await booted(true)
  assert.deepEqual(rec.spawned, [], 'a process was started during setup()')
  assert.deepEqual([...rec.writes], [])
  assert.deepEqual([...rec.commands], [])
  assert.deepEqual([...rec.invokes], [])
  // …and it did register its declarative surface, so this is not vacuous.
  assert.equal(rec.registered.size, 4)
  assert.equal(rec.args().length > 0, true)
})

test('the spawn detector is not blind: an explicit detect DOES show up', async () => {
  /**
   * The negative control. `trackProcess` is the only thing standing between
   * "nothing at rest" and a claim nobody checked, so it has to be shown firing.
   */
  const rec = await booted(true)
  await rec.registered.get('stream-ytdl.detect')?.run()
  assert.equal(rec.spawned.length, 1, 'the detector did not see an actual spawn')
  assert.match(rec.spawned[0] as string, /yt-dlp\.exe --version$/)
})

test('R05: at rest the hook is NOT LOADED, and this module never says otherwise', async () => {
  /**
   * THIS TEST USED TO ASSERT THE WEAKER ARCHITECTURE, and that is why it is
   * worth a paragraph rather than a one-line fix.
   *
   * It was `assert.equal(args.includes('--ytdl=yes'), true)` under the title
   * "at rest the hook is loaded but excluded from every URL" — so the test
   * DEMANDED that every launch load `ytdl_hook.lua`, and rested the product's
   * headline zero-network promise on the Lua exclude regex `ytdl_hook-exclude=.*`
   * being correct. A test that requires the network hook to be present is not a
   * zero-network test; it is a test of a regex.
   *
   * It also could not pass, for a reason worth keeping in the record: core
   * contributes `--ytdl=no` itself (`src/main/index.ts:587`, under a comment
   * naming R05), and `core/mpv/reserved.ts:251` rejects two contributors of one
   * option, so `--ytdl=yes` from this module was a boot-time ContributionError
   * that took the app and all nine Wave-1 modules down with it. M36 had grepped
   * `CORE_RESERVED_OPTIONS` (which indeed does not list `ytdl`) and concluded the
   * guide was stale; the guide was right, and the wrong list was grepped.
   *
   * So the assertion is inverted: the module must contribute NO `--ytdl` at all,
   * and the promise is kept STRUCTURAL — the hook is never loaded, rather than
   * loaded-and-asked-nicely.
   */
  const rec = await booted(true)
  const args = rec.args()
  assert.equal(
    args.some((a) => a === '--ytdl' || a.startsWith('--ytdl=')),
    false,
    `this module must not contribute --ytdl; core owns it as --ytdl=no. Got: ${args.join(' ')}`
  )

  // Pinned to CORE'S OWN SOURCE, not to this module's opinion of it. If core
  // ever flips to `--ytdl=yes` or drops the line, the zero-network promise
  // changes shape and this test is where that shows up.
  const coreMain = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'index.ts'),
    'utf8'
  )
  assert.match(
    coreMain,
    /'--ytdl=no'/,
    "core no longer contributes --ytdl=no, so 'the hook is never loaded' is no longer structural"
  )

  // The exclude and the path are still contributed, so that the day core makes
  // `--ytdl` conditional the values are already right. They are a belt, not the
  // guarantee — which is the whole point of the rewrite above.
  assert.equal(
    args.includes('--script-opts-append=ytdl_hook-exclude=.*'),
    true,
    'the default spawn must still make ytdl_hook inert if it is ever loaded'
  )
  assert.equal(
    args.some((a) => a.startsWith('--script-opts-append=ytdl_hook-ytdl_path=')),
    true
  )
})

test('R05: turning the feature on is one change-list command, not a respawn', async () => {
  const rec = await booted(true)
  rec.set('stream-ytdl.enabled', true)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(rec.commands, [
    ['change-list', 'script-opts', 'append', 'ytdl_hook-exclude=']
  ])
  // And the args for the NEXT spawn agree with the live state.
  assert.equal(
    rec.args().some((a) => a.includes('ytdl_hook-exclude')),
    false
  )
})

test('R05: turning it back off re-excludes rather than leaving it live', async () => {
  const rec = await booted(true)
  rec.set('stream-ytdl.enabled', true)
  rec.set('stream-ytdl.enabled', false)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(rec.commands[1], [
    'change-list',
    'script-opts',
    'append',
    'ytdl_hook-exclude=.*'
  ])
})

test('no keybindable command in this module starts a process', async () => {
  const rec = await booted(true)
  for (const c of rec.registered.values()) {
    if (c.internal === true) continue
    await c.run()
  }
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual([...rec.spawned], [])
})

test('R07: the update prompt is refusable, and refusing spawns nothing', async () => {
  const rec = await booted(true)
  rec.confirm = false
  await rec.registered.get('stream-ytdl.update')?.run()
  assert.deepEqual([...rec.spawned], [])

  // …and accepting it runs `--update-to`, i.e. yt-dlp updating itself, and
  // nothing this app wrote.
  rec.confirm = true
  await rec.registered.get('stream-ytdl.update')?.run()
  assert.equal(rec.spawned.length >= 1, true)
  assert.match(rec.spawned[0] as string, /yt-dlp\.exe --update-to (stable|nightly)$/)
})

// ---------------------------------------------------------------------------
// R07's trigger rule
// ---------------------------------------------------------------------------

test('R07: an update offer appears ONLY for a site-changed failure', async () => {
  const rec = await booted(true)

  // Resting value: ytdl_hook deletes the property on end-of-file.
  rec.observed('user-data/mpv/ytdl/json-subprocess-result', undefined)
  assert.deepEqual([...rec.toasts], [])

  // A success says nothing.
  rec.observed('user-data/mpv/ytdl/json-subprocess-result', { status: 0, stderr: '' })
  assert.deepEqual([...rec.toasts], [])

  // An ordinary failure: reported, but with no update action attached.
  rec.observed('user-data/mpv/ytdl/json-subprocess-result', {
    status: 1,
    stderr: 'ERROR: [youtube] abc: Video unavailable'
  })
  assert.equal(rec.toasts.length, 1)
  assert.equal(rec.toasts[0]?.message, 'stream-ytdl.toastFailed')
  assert.equal(rec.toasts[0]?.hasAction, false)

  // A site-changed failure: the one moment R07 permits.
  rec.observed('user-data/mpv/ytdl/json-subprocess-result', {
    status: 1,
    stderr: 'ERROR: [youtube] abc: Unable to extract player response'
  })
  assert.equal(rec.toasts.length, 2)
  assert.equal(rec.toasts[1]?.message, 'stream-ytdl.toastUpdate')
  assert.equal(rec.toasts[1]?.hasAction, true)

  // Nothing was spawned by any of it: the affordance is an offer, not an action.
  assert.deepEqual([...rec.spawned], [])
})

test('R07: a missing binary gets the "install it" message, never "update it"', async () => {
  const rec = await booted(false)
  rec.observed('user-data/mpv/ytdl/json-subprocess-result', {
    status: -1,
    error_string: 'init failed'
  })
  assert.equal(rec.toasts[0]?.message, 'stream-ytdl.toastMissing')
  assert.equal(rec.toasts[0]?.hasAction, false)
})

// ---------------------------------------------------------------------------
// R08 / R09 and the ownership boundary
// ---------------------------------------------------------------------------

test('R08: a quality switch goes through M11, and writes neither vid nor aid', async () => {
  const rec = await booted(true)
  await rec.registered.get('stream-ytdl.selectQuality')?.run({ id: 3, kind: 'video' })
  assert.deepEqual(rec.invokes, [
    { id: 'audio-tracks.selectStreamFormat', arg: { vid: 3 } }
  ])
  // `vid` and `aid` are M11's outright, and they are ONE decision on an EDL
  // source — which is why this module has a mediator and not two requestSets.
  for (const w of rec.writes) {
    assert.notEqual(w.property, 'vid')
    assert.notEqual(w.property, 'aid')
  }

  await rec.registered.get('stream-ytdl.selectQuality')?.run({ id: 2, kind: 'audio' })
  assert.deepEqual(rec.invokes[1], {
    id: 'audio-tracks.selectStreamFormat',
    arg: { aid: 2 }
  })
})

test('R08: the quality list follows track-list rather than a snapshot', async () => {
  const rec = await booted(true)
  const read = (): { quality: unknown[] } =>
    rec.ipcHandlers.get('stream-ytdl:getState')?.(undefined) as { quality: unknown[] }
  assert.deepEqual(read().quality, [])
  rec.observed('track-list', [
    { id: 1, type: 'video', 'demux-h': 720 },
    { id: 2, type: 'video', 'demux-h': 1080 }
  ])
  assert.equal(read().quality.length, 2)
})

test('R09: an empty format preset contributes no --ytdl-format at all', async () => {
  const rec = await booted(true)
  assert.equal(
    rec.args().some((a) => a.startsWith('--ytdl-format')),
    false
  )
  rec.set('stream-ytdl.formatPreset', 'bestaudio/best')
  assert.equal(rec.args().includes('--ytdl-format=bestaudio/best'), true)
})

test('R10: an invalid raw option is dropped rather than passed to mpv', async () => {
  const rec = await booted(true)
  rec.set('stream-ytdl.rawOptions', ['--proxy=x', 'force-ipv6', 'proxy=y'])
  const args = rec.args()
  assert.equal(args.includes('--ytdl-raw-options-append=proxy=y'), true)
  assert.equal(
    args.filter((a) => a.startsWith('--ytdl-raw-options-append=')).length,
    1,
    args.join(' ')
  )
})

test('every id is inside this module namespace, and the manifest row is copied', async () => {
  const rec = await booted(true)
  for (const id of rec.registered.keys()) assert.equal(id.startsWith('stream-ytdl.'), true, id)
  for (const ch of rec.ipcHandlers.keys()) assert.equal(ch.startsWith('stream-ytdl:'), true, ch)
  assert.equal(mod.id, 'stream-ytdl')
  // §1: `dependsOn` is ONE namespace and the manifest row is the answer.
  assert.deepEqual([...(mod.dependsOn ?? [])], ['stream-open', 'audio-tracks'])
  assert.deepEqual([...(mod.ownsProperties ?? [])].sort(), [
    'script-opts',
    'ytdl',
    'ytdl-format',
    'ytdl-raw-options'
  ])
  assert.deepEqual([...(mod.requestsProperties ?? [])].sort(), ['aid', 'vid'])
})

test('spawn args are well formed and touch nothing core reserves', async () => {
  const rec = await booted(true)
  rec.set('stream-ytdl.enabled', true)
  rec.set('stream-ytdl.useManifests', true)
  rec.set('stream-ytdl.formatPreset', 'bestaudio/best')
  rec.set('stream-ytdl.rawOptions', ['proxy=y'])
  const args = rec.args()
  for (const a of args) assert.match(a, /^--[a-z0-9-]+=.*$/)

  // §4: duplicates across contributors throw at boot unless the option is on
  // core's additive allowlist. Everything repeated here must be an `*-append`.
  const counts = new Map<string, number>()
  for (const a of args) {
    const n = a.split('=')[0] as string
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  for (const [name, n] of counts) {
    if (n > 1) assert.match(name, /-append$/, `${name} appears ${n} times and is not additive`)
  }
  for (const reserved of ['--vo', '--wid', '--no-config', '--load-scripts', '--osc', '--msg-level']) {
    assert.equal(counts.has(reserved), false, reserved)
  }
})
