import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installSkip, type SkipInstallation } from './skip-intro.ts'
import type {
  CommandDescriptor,
  FeatureContext,
  SecondaryEngineOptions,
  SettingDescriptor
} from '@shared/feature-api'

/**
 * N51's WIRING, driven through `installSkip()` with a recording context.
 *
 * Nothing here lists what the module is supposed to do. It installs the real
 * thing, pushes the same `time-pos` values mpv pushes, invokes the real command
 * descriptors, and asserts on the seeks that come out and the JSON that lands on
 * disk. Every one of the row's non-negotiables is a case below:
 *
 *   off by default . nothing unrecorded ever auto-skips . an OSD naming what was
 *   skipped . an undo affordance . a proposal is never applied on its own .
 *   fingerprinting is opt-in and never automatic
 *
 * and so are the two defects the draft had: the ending key ending the episode
 * from 00:30, and the feature learning from its own skips.
 */

// --- the recording context -------------------------------------------------

interface Seek {
  seconds: number
  absolute: boolean
  quiet: boolean
}

interface Toast {
  kind: string
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface Harness {
  ctx: FeatureContext
  install(): SkipInstallation
  commands: Map<string, CommandDescriptor>
  descriptors: Map<string, SettingDescriptor>
  seeks: Seek[]
  osd: string[]
  toasts: Toast[]
  sent: Array<{ channel: string; payload: unknown }>
  spawns: SecondaryEngineOptions[]
  ipcListeners: Map<string, (req: unknown) => void>
  quitHooks: Array<() => void>
  props: Map<string, unknown>
  setSetting(id: string, v: unknown): void
  getSetting<T>(id: string): T
  loadFile(file: string, opts?: { duration?: number; network?: boolean }): Promise<void>
  tick(t: number): void
  settle(): Promise<void>
  run(id: string, arg?: unknown): Promise<unknown>
  dataDir: string
  catalogs: Map<string, Map<string, string>>
  storeJson(): Record<string, unknown>
  flush(): void
  reset(): void
}

function harness(): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-skip-'))
  const commands = new Map<string, CommandDescriptor>()
  const descriptors = new Map<string, SettingDescriptor>()
  const values = new Map<string, unknown>()
  const listeners = new Map<string, Array<(v: unknown, prev: unknown) => void>>()
  const props = new Map<string, unknown>()
  const observers = new Map<string, Array<(v: unknown) => void>>()
  const fileCbs: Array<(f: string) => void> = []
  const ipcListeners = new Map<string, (req: unknown) => void>()
  const quitHooks: Array<() => void> = []
  const seeks: Seek[] = []
  const osd: string[] = []
  const toasts: Toast[] = []
  const sent: Array<{ channel: string; payload: unknown }> = []
  const spawns: SecondaryEngineOptions[] = []
  const catalogs = new Map<string, Map<string, string>>()
  let network = false

  const getSetting = <T,>(id: string): T =>
    (values.has(id) ? values.get(id) : descriptors.get(id)?.default) as T

  const setSetting = (id: string, value: unknown): void => {
    const prev = getSetting<unknown>(id)
    if (Object.is(prev, value)) return
    values.set(id, value)
    for (const cb of listeners.get(id) ?? []) cb(value, prev)
  }

  const ctx = {
    id: 'nav-chapters',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    paths: {
      dataDir: () => dataDir,
      tempJobDir: (job: string) => path.join(dataDir, 'tmp', job)
    },
    mpv: {
      peek: <T,>(name: string): T | undefined => props.get(name) as T | undefined,
      // A REAL unsubscribe. The first version of this harness returned a no-op,
      // which quietly made every `dispose()` assertion in this file vacuous: two
      // installations over one dataDir both stayed subscribed and the store test
      // saw two seeks for one tick. A fake whose teardown does nothing cannot
      // test teardown.
      observe: <T,>(name: string, cb: (v: T | undefined) => void) => {
        const list = observers.get(name) ?? []
        list.push(cb as (v: unknown) => void)
        observers.set(name, list)
        return (): void => {
          const at = list.indexOf(cb as (v: unknown) => void)
          if (at >= 0) list.splice(at, 1)
        }
      },
      afterFileLoaded: (cb: (f: string) => void) => {
        fileCbs.push(cb)
        return (): void => {
          const at = fileCbs.indexOf(cb)
          if (at >= 0) fileCbs.splice(at, 1)
        }
      },
      get isNetworkSource(): boolean {
        return network
      }
    },
    settings: {
      define: (list: readonly SettingDescriptor[]) => {
        for (const d of list) descriptors.set(d.id, d)
      },
      get: getSetting,
      set: setSetting,
      onChange: (id: string, cb: (v: unknown, prev: unknown) => void) => {
        const list = listeners.get(id) ?? []
        list.push(cb)
        listeners.set(id, list)
        return (): void => {}
      }
    },
    commands: {
      register: (list: readonly CommandDescriptor[]) => {
        for (const c of list) commands.set(c.id, c)
      },
      has: (id: string) => id === 'nav-seek.seek' || id === 'playlist.seriesPrefix',
      invoke: async (id: string, arg?: unknown): Promise<void> => {
        if (id === 'nav-seek.seek') {
          const a = (arg ?? {}) as Seek
          seeks.push({ seconds: a.seconds, absolute: a.absolute === true, quiet: a.quiet === true })
          // The real M24 seeks, so `time-pos` moves. Nothing observes it here
          // unless the test pushes a tick, which is what mpv would do.
          return
        }
        const c = commands.get(id)
        if (!c) throw new Error(`unknown command ${id}`)
        await c.run()
      },
      query: async <T,>(id: string, arg?: unknown): Promise<T> => {
        if (id === 'playlist.seriesPrefix') {
          // The same shape M28's helper returns: the basename up to the episode
          // token. 'Show S01E03.mkv' -> 'Show'.
          const base = path.basename(String(arg ?? ''), path.extname(String(arg ?? '')))
          const cut = base.search(/[._\s-]*(?:[Ss]\d{1,2}[._\s-]?[Ee]\d{1,3}|\d{1,3}(?!\d))/)
          return ((cut > 0 ? base.slice(0, cut) : base).replace(/[._\s-]+$/, '') as unknown) as T
        }
        throw new Error(`unknown query ${id}`)
      }
    },
    ipc: {
      handle: () => {},
      on: (channel: string, fn: (req: unknown) => void) => ipcListeners.set(channel, fn),
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    },
    osd: {
      show: (m: { text: string }) => osd.push(m.text),
      toast: (t: Toast) => toasts.push(t),
      progress: () => ({ update: () => {}, done: () => {}, cancelled: false })
    },
    menu: { contribute: () => {} },
    i18n: {
      register: (lang: string, messages: Record<string, string>) => {
        const c = catalogs.get(lang) ?? new Map<string, string>()
        for (const [k, v] of Object.entries(messages)) c.set(k, v)
        catalogs.set(lang, c)
      },
      // English, so an assertion in this file reads as a sentence. The Korean
      // catalog is asserted for COMPLETENESS at the bottom of the file instead:
      // asserting Korean strings here would make every message change a
      // two-language edit for no extra coverage.
      t: (key: string, params?: Record<string, string | number>) => {
        let out = catalogs.get('en')?.get(key) ?? key
        for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v))
        return out
      }
    },
    lifecycle: { onReady: () => {}, onQuit: (cb: () => void) => quitHooks.push(cb) },
    engine: {
      spawn: async (o: SecondaryEngineOptions) => {
        spawns.push(o)
        throw new Error('no engine in this test')
      },
      binaryPath: () => 'mpv.exe'
    }
  } as unknown as FeatureContext

  const fire = (name: string, v: unknown): void => {
    props.set(name, v)
    for (const cb of observers.get(name) ?? []) cb(v)
  }

  return {
    ctx,
    install: () => installSkip(ctx),
    commands,
    descriptors,
    seeks,
    osd,
    toasts,
    sent,
    spawns,
    ipcListeners,
    quitHooks,
    props,
    catalogs,
    setSetting,
    getSetting,
    dataDir,
    async loadFile(file, opts = {}): Promise<void> {
      network = opts.network === true
      props.set('idle-active', false)
      props.set('duration', opts.duration ?? 1200)
      props.set('time-pos', 0)
      for (const cb of fileCbs) cb(file)
      // afterFileLoaded's callback is async in the module; let it settle.
      await new Promise((r) => setTimeout(r, 0))
    },
    tick(t): void {
      fire('time-pos', t)
    },
    // `onTime` starts an async skip and returns; the OSD, the toast and the
    // store write all land a microtask later, exactly as they do in the app.
    settle: async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
    async run(id, arg): Promise<unknown> {
      const c = commands.get(id)
      assert.ok(c, `command ${id} was never registered`)
      const out = await c.run(arg)
      await new Promise((r) => setTimeout(r, 0))
      return out
    },
    storeJson(): Record<string, unknown> {
      const p = path.join(dataDir, 'skip.json')
      if (!fs.existsSync(p)) return { folders: {} }
      return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    },
    flush(): void {
      for (const h of quitHooks) h()
    },
    reset(): void {
      seeks.length = 0
      osd.length = 0
      toasts.length = 0
      sent.length = 0
      spawns.length = 0
    }
  }
}

const EP1 = 'D:\\Anime\\Show\\Show S01E01.mkv'
const EP2 = 'D:\\Anime\\Show\\Show S01E02.mkv'
const EP3 = 'D:\\Anime\\Show\\Show S01E03.mkv'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('the row`s two defaults are OFF, and they are the ones a fresh profile gets', () => {
  const h = harness()
  h.install()
  assert.equal(h.descriptors.get('nav-chapters.skipEnabled')?.default, false)
  assert.equal(h.descriptors.get('nav-chapters.skipFingerprint')?.default, false)
  assert.equal(h.descriptors.get('nav-chapters.skipMode')?.default, 'prompt')
  // Every descriptor is in this module's namespace and in a fixed section.
  for (const d of h.descriptors.values()) {
    assert.ok(d.id.startsWith('nav-chapters.'), d.id)
    assert.equal(d.section, 'playback')
  }
})

test('the manual set points and the two dedicated keys all exist', () => {
  const h = harness()
  h.install()
  for (const id of [
    'nav-chapters.skipIntro',
    'nav-chapters.skipEnding',
    'nav-chapters.skipSetIntroStart',
    'nav-chapters.skipSetIntroEnd',
    'nav-chapters.skipSetEndingStart',
    'nav-chapters.skipClearIntro',
    'nav-chapters.skipClearEnding',
    'nav-chapters.skipUndo',
    'nav-chapters.skipToggle',
    'nav-chapters.skipSetup',
    'nav-chapters.skipDetect'
  ]) {
    assert.ok(h.commands.has(id), `${id} is missing`)
  }
  // PotPlayer's two dedicated keys, and its setup/enable pair.
  assert.deepEqual(h.commands.get('nav-chapters.skipIntro')?.defaults?.potplayer, ['Semicolon'])
  assert.deepEqual(h.commands.get('nav-chapters.skipEnding')?.defaults?.potplayer, [
    'Shift+Semicolon'
  ])
  assert.deepEqual(h.commands.get('nav-chapters.skipSetup')?.defaults?.potplayer, ['Quote'])
  assert.deepEqual(h.commands.get('nav-chapters.skipToggle')?.defaults?.potplayer, ['Shift+Quote'])
})

// ---------------------------------------------------------------------------
// Tier 1 -- manual set points, and the folder scope that is the whole feature
// ---------------------------------------------------------------------------

test('a window set on episode 1 applies to episode 3 of the same folder', async () => {
  // This is the spec's own acceptance case for N51, minus the twelve files:
  // "set intro start/end on episode 1 of a chapterless folder, then confirm
  // episodes 2-12 offer the skip at the same offsets".
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')

  await h.loadFile(EP1)
  h.props.set('time-pos', 12)
  await h.run('nav-chapters.skipSetIntroStart')
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.flush()
  const json = h.storeJson()
  const folders = json['folders'] as Record<string, Record<string, unknown>>
  const keys = Object.keys(folders)
  assert.equal(keys.length, 1, 'one folder + prefix key, not one per file')
  assert.equal(keys[0], 'd:/anime/show|show')
  const w = folders[keys[0] as string]?.['window'] as Record<string, unknown>
  assert.equal(w['introStart'], 12)
  assert.equal(w['introEnd'], 95)
  assert.equal(w['source'], 'manual')

  // Episode 3, same folder: the window is live with no further setup.
  h.reset()
  await h.loadFile(EP3)
  h.tick(20)
  await h.settle()
  assert.deepEqual(h.seeks, [{ seconds: 95, absolute: true, quiet: true }])
  // ...and the OSD names what was skipped, with where it landed.
  assert.equal(h.osd[0], 'Skipped the intro (1:35)')
})

test('a DIFFERENT series in the same folder does not inherit the window', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile('D:\\Anime\\Show\\Other Thing S01E01.mkv')
  h.tick(20)
  assert.deepEqual(h.seeks, [])
})

test('the ending is stored as a LEAD, so a shorter sibling still lands on the credits', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1, { duration: 1220 })
  h.props.set('time-pos', 1100)
  await h.run('nav-chapters.skipSetEndingStart')

  // Episode 2 is 40 s shorter. An absolute 1100 would land 40 s into the ED.
  h.reset()
  await h.loadFile(EP2, { duration: 1180 })
  h.tick(1000)
  await h.settle()
  assert.equal(h.seeks.length, 0)
  h.tick(1065)
  await h.settle()
  assert.equal(h.seeks.length, 1)
  assert.ok(Math.abs((h.seeks[0]?.seconds ?? 0) - 1179.65) < 0.01, String(h.seeks[0]?.seconds))
})

test('clearing a window stops the skip; the other half survives', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.props.set('time-pos', 1100)
  await h.run('nav-chapters.skipSetEndingStart')
  await h.run('nav-chapters.skipClearIntro')

  h.reset()
  await h.loadFile(EP2)
  h.tick(20)
  assert.deepEqual(h.seeks, [], 'the intro window was cleared')
  h.tick(1150)
  assert.equal(h.seeks.length, 1, 'the ending window was not')
})

// ---------------------------------------------------------------------------
// Off by default, and "nothing unrecorded auto-skips"
// ---------------------------------------------------------------------------

test('OFF BY DEFAULT: a stored window does nothing until the setting is on', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(20)
  h.tick(40)
  assert.deepEqual(h.seeks, [])
  assert.deepEqual(h.sent.filter((s) => s.channel === 'nav-chapters:skipPrompt'), [])
})

test('with skipping ON but no stored window, NOTHING auto-skips -- ever', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  for (const t of [1, 5, 30, 90, 200, 600, 1100, 1190]) h.tick(t)
  assert.deepEqual(h.seeks, [], 'the keypress fallback must be unreachable from the observer')
})

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test('prompt mode offers rather than seeks, and the offer withdraws itself', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(20)
  assert.deepEqual(h.seeks, [], 'prompt mode never moves playback on its own')
  const prompt = h.sent.filter((s) => s.channel === 'nav-chapters:skipPrompt')
  assert.equal(prompt.length, 1)
  assert.deepEqual(prompt[0]?.payload, { kind: 'intro', ms: 5000, label: 'Skip intro' })

  // Accepting it, the way the renderer's button does.
  const onAction = h.ipcListeners.get('nav-chapters:skipAction')
  assert.ok(onAction)
  h.props.set('time-pos', 20)
  onAction({ action: 'promptAccept' })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(h.seeks, [{ seconds: 95, absolute: true, quiet: true }])
  // and the button is told to go away
  const after = h.sent.filter((s) => s.channel === 'nav-chapters:skipPrompt')
  assert.deepEqual(after[after.length - 1]?.payload, { kind: null })
})

test('accepting a STALE prompt does nothing, because the playhead has moved on', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(20)
  // The user ignored the button and scrubbed to the middle of the episode.
  h.props.set('time-pos', 600)
  h.ipcListeners.get('nav-chapters:skipAction')?.({ action: 'promptAccept' })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(h.seeks, [], 'a stale button must not yank playback out of a scene')
})

test('an offer is made once per file, not on every tick inside the window', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  for (const t of [10, 11, 12, 13, 20, 30]) h.tick(t)
  assert.equal(h.sent.filter((s) => s.channel === 'nav-chapters:skipPrompt').length, 1)
})

// ---------------------------------------------------------------------------
// The undo affordance
// ---------------------------------------------------------------------------

test('every skip carries an undo, and the undo lands where the user was', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(22)
  await h.settle()
  const toast = h.toasts.at(-1)
  assert.ok(toast?.onAction, 'no undo action on the skip toast')
  assert.equal(toast.actionLabel, 'Undo')
  h.props.set('time-pos', 95)
  toast.onAction()
  await h.settle()
  assert.deepEqual(h.seeks[1], { seconds: 22, absolute: true, quiet: true })
  assert.ok(h.osd.some((t) => t.includes('Undid')), h.osd.join(' | '))
})

test('an undo is not immediately re-skipped by the next time-pos callback', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(22)
  await h.settle()
  h.toasts.at(-1)?.onAction?.()
  await h.settle()
  const before = h.seeks.length
  // mpv now reports the position the undo seeked to, which is inside the window.
  h.tick(22)
  h.tick(23)
  h.tick(24)
  assert.equal(h.seeks.length, before, 'an undo that undoes itself is a loop')
})

// ---------------------------------------------------------------------------
// The keypresses -- and the defect that ended the episode
// ---------------------------------------------------------------------------

test('SKIP ENDING at 00:30 with no window refuses and SAYS SO, it does not end the file', async () => {
  // THE REGRESSION. The draft seeked to `duration - 0.35` from anywhere in the
  // file, so this keypress closed the episode. `planManualSkip` refuses.
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.props.set('time-pos', 30)
  await h.run('nav-chapters.skipEnding')
  assert.deepEqual(h.seeks, [])
  assert.equal(h.osd[0], 'Nothing to skip yet — the ending starts at 17:30')
})

test('skip ending inside the configured reach jumps to the EOF margin', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.props.set('time-pos', 1100)
  await h.run('nav-chapters.skipEnding')
  assert.equal(h.seeks.length, 1)
  assert.ok(Math.abs((h.seeks[0]?.seconds ?? 0) - 1199.65) < 0.01)
  assert.ok((h.seeks[0]?.seconds ?? 0) < 1200, 'exactly `duration` would end the file')
})

test('skip ending on a stream with no duration says why instead of doing nothing', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1, { duration: 0 })
  h.props.set('time-pos', 300)
  await h.run('nav-chapters.skipEnding')
  assert.deepEqual(h.seeks, [])
  assert.equal(h.osd[0], 'A stream with no duration has no ending to skip')
})

test('skip intro with no window is PotPlayer`s relative jump, and it is evidence', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.props.set('time-pos', 8)
  await h.run('nav-chapters.skipIntro')
  assert.deepEqual(h.seeks, [{ seconds: 98, absolute: true, quiet: true }])
  h.flush()
  const folders = h.storeJson()['folders'] as Record<string, Record<string, unknown>>
  const obs = folders['d:/anime/show|show']?.['intro'] as Array<Record<string, unknown>>
  assert.equal(obs?.length, 1)
  assert.equal(obs[0]?.['file'], 'Show S01E01.mkv', 'a basename, never a full path')
  assert.equal(obs[0]?.['from'], 8)
  assert.equal(obs[0]?.['to'], 98)
})

test('skip intro USES the folder window when there is one, in preference to the jump', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.props.set('time-pos', 8)
  await h.run('nav-chapters.skipIntro')
  assert.deepEqual(h.seeks, [{ seconds: 95, absolute: true, quiet: true }])
})

// ---------------------------------------------------------------------------
// Tier 2 -- learning, and NOT learning from itself
// ---------------------------------------------------------------------------

test('two hand-made skips in one folder PROPOSE a window; nothing is applied yet', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  h.tick(6)
  h.tick(96) // a hand-made forward jump, episode 1
  await h.loadFile(EP2)
  h.tick(5)
  h.tick(97) // and again, episode 2
  await new Promise((r) => setTimeout(r, 0))

  const offer = h.toasts.find((t) => t.message.includes('episodes agree'))
  assert.ok(offer, `no proposal was offered: ${h.toasts.map((t) => t.message).join(' | ')}`)
  assert.equal(offer.actionLabel, 'Apply')

  // NOT APPLIED. This is D-11's fence, and it is the reason the model layer has
  // no function that turns an observation into a window without a caller.
  h.flush()
  let folders = h.storeJson()['folders'] as Record<string, Record<string, unknown>>
  assert.equal(folders['d:/anime/show|show']?.['window'], undefined)

  offer.onAction?.()
  await new Promise((r) => setTimeout(r, 0))
  h.flush()
  folders = h.storeJson()['folders'] as Record<string, Record<string, unknown>>
  const w = folders['d:/anime/show|show']?.['window'] as Record<string, unknown>
  assert.equal(w?.['source'], 'learned')
  assert.equal(w?.['introStart'], 5, 'the window arms at the earlier of the two presses')
  assert.equal(w?.['introEnd'], 96.5)
})

test('one episode skipped four times proposes nothing', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  for (const [a, b] of [
    [5, 95],
    [6, 96],
    [4, 94],
    [7, 97]
  ]) {
    h.tick(a as number)
    h.tick(b as number)
  }
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(
    h.toasts.filter((t) => t.message.includes('episodes agree')).length,
    0,
    'one file agreeing with itself is not evidence about the next file'
  )
})

test('AN AUTO-SKIP IS NOT EVIDENCE: the feature does not learn from itself', async () => {
  // THE REGRESSION. `onTime` reads any forward jump of 20 s+ as a hand-made
  // skip, and an auto-skip is one, so every episode of a folder with a window
  // wrote a fresh observation agreeing with the window that caused it.
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')

  await h.loadFile(EP2)
  h.tick(10)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.seeks.length, 1, 'the auto-skip did not happen, so this proves nothing')
  // mpv now reports the position the skip seeked to.
  h.tick(95)
  h.tick(96)
  h.flush()
  const folders = h.storeJson()['folders'] as Record<string, Record<string, unknown>>
  assert.equal(
    folders['d:/anime/show|show']?.['intro'],
    undefined,
    'the module recorded its own skip as user evidence'
  )
})

test('with learning off, nothing is written to disk that the user did not set', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipLearn', false)
  await h.loadFile(EP1)
  h.tick(6)
  h.tick(96)
  await new Promise((r) => setTimeout(r, 0))
  h.flush()
  assert.deepEqual(h.storeJson()['folders'], {})
})

test('a backward jump into a window spends that file`s offer', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  // The user starts at 2:00 and scrubs BACK into the OP: they want to watch it.
  h.tick(120)
  h.tick(30)
  assert.deepEqual(h.seeks, [])
})

// ---------------------------------------------------------------------------
// Tier 3 -- opt-in, and it never runs on its own
// ---------------------------------------------------------------------------

test('fingerprinting never spawns anything unless BOTH the setting and the command say so', async () => {
  const h = harness()
  h.install()
  await h.loadFile(EP1)
  for (const t of [1, 30, 95, 600, 1190]) h.tick(t)
  assert.deepEqual(h.spawns, [], 'nothing about playback may start a decode')

  // The command alone is not enough either: the setting is off.
  await h.run('nav-chapters.skipDetect')
  assert.deepEqual(h.spawns, [])
  assert.equal(h.toasts.at(-1)?.message, 'Turn on audio analysis in settings first')
})

test('with the opt-in on, a folder with no sibling says so rather than spawning', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipFingerprint', true)
  const solo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-solo-')), 'Only S01E01.mkv')
  fs.writeFileSync(solo, 'x')
  await h.loadFile(solo)
  await h.run('nav-chapters.skipDetect')
  assert.deepEqual(h.spawns, [])
  assert.equal(h.toasts.at(-1)?.message, 'No other episode found in this folder')
})

// ---------------------------------------------------------------------------
// Network sources
// ---------------------------------------------------------------------------

test('a network source gets no folder record, so skip.json is not a URL history', async () => {
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  // `rtsp://` rather than an http URL: `check:forbidden` refuses a remote origin
  // anywhere in tracked source, string literals in tests included, and it is
  // right to -- the network grep is the product's headline promise. An RTSP
  // camera (R14) is a network source in exactly the sense this test is about.
  await h.loadFile('rtsp://cam.invalid/a/b/ep1.mp4', { network: true })
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.tick(6)
  h.tick(96)
  h.flush()
  assert.deepEqual(h.storeJson()['folders'], {})
  assert.deepEqual(h.seeks, [])
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('the store survives a restart, and a corrupt file is quarantined not deleted', async () => {
  const h = harness()
  const inst = h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  h.setSetting('nav-chapters.skipMode', 'auto')
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  inst.dispose()
  const file = path.join(h.dataDir, 'skip.json')
  assert.ok(fs.existsSync(file))
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'the temp file must be renamed away')

  // A fresh install over the same dataDir reads it back.
  const again = h.install()
  h.reset()
  await h.loadFile(EP3)
  h.tick(20)
  assert.deepEqual(h.seeks, [{ seconds: 95, absolute: true, quiet: true }])
  again.dispose()

  // Now corrupt it and install again: the session starts empty and the bytes
  // are kept, because a hand-edited file must be recoverable by the person who
  // hand-edited it.
  fs.writeFileSync(file, '{ "folders": { oops', 'utf8')
  const third = h.install()
  h.reset()
  await h.loadFile(EP3)
  h.tick(20)
  assert.deepEqual(h.seeks, [])
  const kept = fs.readdirSync(h.dataDir).filter((n) => n.includes('.corrupt.'))
  assert.equal(kept.length, 1, fs.readdirSync(h.dataDir).join(','))
  third.dispose()
})

test('dispose leaves no timer holding the process open', async () => {
  const h = harness()
  const inst = h.install()
  h.setSetting('nav-chapters.skipEnabled', true)
  await h.loadFile(EP1)
  h.props.set('time-pos', 95)
  await h.run('nav-chapters.skipSetIntroEnd')
  h.reset()
  await h.loadFile(EP2)
  h.tick(20) // arms the 5 s prompt timer
  inst.dispose()
  // If the prompt timer were still live the test runner would hang for 5 s here.
  await new Promise((r) => setTimeout(r, 5))
})

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test('every message this module can show exists in BOTH languages', () => {
  const h = harness()
  h.install()
  const ko = h.catalogs.get('ko')
  const en = h.catalogs.get('en')
  assert.ok(ko && en)
  assert.ok(ko.size > 40, `only ${ko.size} Korean keys`)
  const missingKo = [...en.keys()].filter((k) => !ko.has(k))
  const missingEn = [...ko.keys()].filter((k) => !en.has(k))
  assert.deepEqual(missingKo, [], 'keys with no Korean')
  assert.deepEqual(missingEn, [], 'keys with no English')
  // Keys must be in this module's namespace -- core enforces it, and a test that
  // catches it here names the key instead of failing at boot.
  for (const k of en.keys()) assert.ok(k.startsWith('nav-chapters.'), k)
  // Every placeholder a message uses must appear in both, or one language shows
  // a raw `{at}` to the user.
  for (const [k, v] of en) {
    // A `{a/b}` hole is a 조사 marker, not a parameter: core's `t()` resolves it
    // from the PRECEDING parameter's value, so it exists in Korean only and is
    // not a mismatch.
    const holes = (str: string): string[] =>
      (str.match(/\{[^}]+\}/g) ?? []).filter((m) => !m.includes('/')).sort()
    assert.deepEqual(holes(v), holes(ko.get(k) as string), `placeholders differ for ${k}`)
  }
  // The Korean OSD lines go through the 조사 helper, so the ones that name a
  // window carry the {을/를} marker rather than a hardcoded particle.
  assert.match(ko.get('nav-chapters.skipped') as string, /\{을\/를\}/)
})

test('with learning off, an explicit skip-intro keypress writes nothing either', async () => {
  // The manual-fallback path writes an observation too, and gating only the
  // observer would have left this one live. The gate is inside
  // `writeObservation` so a third call site cannot be added without it.
  const h = harness()
  h.install()
  h.setSetting('nav-chapters.skipLearn', false)
  await h.loadFile(EP1)
  h.props.set('time-pos', 8)
  await h.run('nav-chapters.skipIntro')
  assert.equal(h.seeks.length, 1, 'the skip itself still happens')
  h.flush()
  assert.deepEqual(h.storeJson()['folders'], {})
})
