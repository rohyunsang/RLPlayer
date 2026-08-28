import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CommandDescriptor, FeatureContext, SettingDescriptor } from '@shared/feature-api'
import mod from './index.ts'
import { withScheme } from './url-policy.ts'

/**
 * M35, the module half — driven through a recording FeatureContext.
 *
 * WHAT THIS SUITE IS FOR, and why the other two could not do it. `buffering.ts`,
 * `cache-presets.ts`, `recent.ts` and `url-policy.ts` are pure and already
 * tested. Every defect the draft actually shipped was in `index.ts`: the revert
 * that read `peek` on a property nobody observes and therefore never fired, the
 * `end-file` handler that undid the options for the stream it was about to open,
 * and a `network-timeout` write to the one protocol the spec says it breaks.
 * None of them is reachable without calling `setup()`.
 *
 * So the context below RECORDS instead of asserting-on-call: every test states
 * what mpv ended up holding, or what this module did and did not send. A test
 * that only asserted "set() was called" would have passed on all three defects.
 */

// ---------------------------------------------------------------------------
// The recording context
// ---------------------------------------------------------------------------

interface Rec {
  readonly ctx: FeatureContext
  /** Every ownership-checked write, in order. */
  readonly writes: Array<{ property: string; value: unknown }>
  /** Every ctx.mpv.command() array, in order. */
  readonly commands: unknown[][]
  /** Every property this module ASKED mpv for. */
  readonly gets: string[]
  /** Every cross-module mediator call. */
  readonly invokes: Array<{ id: string; arg: unknown }>
  /** Anything that could reach a network or a process, by name. */
  readonly sideEffects: string[]
  readonly toasts: Array<{ kind: string; message: string }>
  readonly registered: Map<string, CommandDescriptor>
  readonly ipcHandlers: Map<string, (req: unknown) => unknown>
  /** Property values mpv reports. Reads come from here, writes land here. */
  readonly mpvState: Map<string, unknown>
  /** The current value of a setting. */
  set(id: string, v: unknown): void
  get(id: string): unknown
  emit(event: string, msg?: Record<string, unknown>): void
  args(): string[]
  /** Emit `start-file` as soon as the open mediator is called. */
  autoStartFile: boolean
}

function makeCtx(dataDir: string): Rec {
  const writes: Array<{ property: string; value: unknown }> = []
  const commands: unknown[][] = []
  const gets: string[] = []
  const invokes: Array<{ id: string; arg: unknown }> = []
  const sideEffects: string[] = []
  const toasts: Array<{ kind: string; message: string }> = []
  const registered = new Map<string, CommandDescriptor>()
  const ipcHandlers = new Map<string, (req: unknown) => unknown>()
  const mpvState = new Map<string, unknown>([
    // Deliberately populated with the properties this module OVERRIDES, and
    // deliberately never `observe`d — which is the whole point: `peek` returns
    // undefined for all of them, `get` returns these.
    ['tls-verify', 'yes'],
    ['user-agent', 'libmpv'],
    ['referrer', ''],
    ['rtsp-transport', 'tcp'],
    ['network-timeout', 0],
    ['force-seekable', 'no'],
    ['hls-bitrate', 'max'],
    ['http-header-fields', []],
    ['demuxer-via-network', true]
  ])
  const descriptors = new Map<string, SettingDescriptor>()
  const values = new Map<string, unknown>()
  const changeCbs = new Map<string, Array<(v: unknown, p: unknown) => void>>()
  const eventCbs = new Map<string, Array<(m: Record<string, unknown>) => void>>()
  const observers = new Map<string, Array<(v: unknown) => void>>()
  let argFns: Array<() => string[]> = []

  const getSetting = (id: string): unknown => {
    if (values.has(id)) return values.get(id)
    const d = descriptors.get(id)
    return d?.default
  }
  const setSetting = (id: string, v: unknown): void => {
    const prev = getSetting(id)
    values.set(id, v)
    for (const cb of changeCbs.get(id) ?? []) cb(v, prev)
  }

  const rec: Rec = {
    writes,
    commands,
    gets,
    invokes,
    sideEffects,
    toasts,
    registered,
    ipcHandlers,
    mpvState,
    autoStartFile: true,
    set: setSetting,
    get: getSetting,
    emit(event, msg = {}): void {
      for (const cb of eventCbs.get(event) ?? []) cb(msg)
    },
    args(): string[] {
      return argFns.flatMap((f) => f())
    },
    ctx: undefined as unknown as FeatureContext
  }

  const ctx = {
    id: 'stream-open',
    log: {
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {}
    },
    paths: {
      dataDir: (): string => dataDir,
      cacheDir: (): string => path.join(dataDir, 'cache'),
      mpvBinary: (): string => {
        sideEffects.push('paths.mpvBinary')
        return 'mpv.exe'
      }
    },
    mpv: {
      observe(name: string, cb: (v: unknown) => void): () => void {
        const list = observers.get(name) ?? []
        list.push(cb)
        observers.set(name, list)
        return () => {
          /* no-op */
        }
      },
      // `peek` is honest about what the bus knows: only observed properties.
      peek: (name: string): unknown =>
        observers.has(name) ? mpvState.get(name) : undefined,
      get: async (name: string): Promise<unknown> => {
        gets.push(name)
        if (!mpvState.has(name)) throw new Error(`property unavailable: ${name}`)
        return mpvState.get(name)
      },
      set: async (name: string, value: unknown): Promise<void> => {
        writes.push({ property: name, value })
        mpvState.set(name, value)
      },
      requestSet: async (): Promise<{ ok: false; reason: string }> => ({
        ok: false,
        reason: 'no-arbiter'
      }),
      arbitrate: (): void => {},
      command: async (a: unknown[]): Promise<unknown> => {
        commands.push(a)
        if (a[0] === 'change-list' && a[1] === 'http-header-fields' && a[2] === 'append') {
          const list = (mpvState.get('http-header-fields') as unknown[]) ?? []
          mpvState.set('http-header-fields', [...list, a[3]])
        }
        return null
      },
      commandNoReply: (a: unknown[]): void => {
        commands.push(a)
      },
      onEvent(event: string, cb: (m: Record<string, unknown>) => void): () => void {
        const list = eventCbs.get(event) ?? []
        list.push(cb)
        eventCbs.set(event, list)
        return () => {
          eventCbs.set(event, (eventCbs.get(event) ?? []).filter((f) => f !== cb))
        }
      },
      afterFileLoaded: (): (() => void) => () => {},
      contributeArgs(_p: number, fn: () => string[]): void {
        argFns = [...argFns, fn]
      },
      requestRestart: (r: string): void => {
        sideEffects.push(`requestRestart:${r}`)
      },
      isNetworkSource: true
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
        if (own) {
          await own.run(arg)
          return
        }
        // A foreign mediator. `playlist.openPaths` is the one this module needs.
        if (id === 'playlist.openPaths' || id === 'playlist.openUrl') {
          if (rec.autoStartFile) rec.emit('start-file')
        }
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
      toast(t: { kind: string; message: string }): void {
        toasts.push({ kind: t.kind, message: t.message })
      },
      progress: (): never => {
        throw new Error('unused')
      }
    },
    perFile: {},
    menu: { contribute: (): void => {} },
    i18n: {
      register: (): void => {},
      // The key itself, so an assertion can name the message without a catalog.
      t: (key: string): string => key
    },
    lifecycle: {
      onReady: (): void => {},
      onQuit: (): void => {},
      trackProcess: (): void => {
        sideEffects.push('lifecycle.trackProcess')
      }
    },
    window: {},
    dialog: {
      confirm: async (): Promise<boolean> => true,
      openFiles: async (): Promise<string[]> => [],
      openDirectory: async (): Promise<string[]> => [],
      saveFile: async (): Promise<null> => null
    },
    network: {
      allowed: (h: string): boolean => {
        sideEffects.push(`network.allowed:${h}`)
        return false
      },
      assertAllowed: (h: string): void => {
        sideEffects.push(`network.assertAllowed:${h}`)
      }
    },
    engine: {
      spawn: async (): Promise<never> => {
        sideEffects.push('engine.spawn')
        throw new Error('no engine in this test')
      },
      binaryPath: (): string => 'mpv.exe'
    }
  }

  ;(rec as { ctx: FeatureContext }).ctx = ctx as unknown as FeatureContext
  return rec
}

let tmpSeq = 0
function freshDir(): string {
  const d = path.join(os.tmpdir(), `rl-stream-open-${process.pid}-${tmpSeq++}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

async function booted(): Promise<Rec> {
  const rec = makeCtx(freshDir())
  await mod.setup(rec.ctx)
  return rec
}

// ---------------------------------------------------------------------------
// The headline promise: nothing at rest
// ---------------------------------------------------------------------------

test('setup() reaches nothing: no writes, no commands, no mediators, no processes', async () => {
  const rec = await booted()
  assert.deepEqual([...rec.writes], [])
  assert.deepEqual([...rec.commands], [])
  assert.deepEqual([...rec.invokes], [])
  assert.deepEqual([...rec.sideEffects], [])
  // It DID do its declarative work, so this is not vacuously true.
  assert.equal(rec.registered.size > 0, true)
  assert.equal(rec.ipcHandlers.size > 0, true)
  assert.equal(rec.args().length > 0, true)
})

test('the recorder is not blind: an actual write shows up in it', async () => {
  /**
   * The negative control, and the reason the test above is worth anything.
   *
   * Five audit rounds in this project have found a check that passed because it
   * was looking at nothing. So before trusting "no writes at rest", make the
   * same recorder observe a write it must catch: applying a cache preset writes
   * several properties this module owns.
   */
  const rec = await booted()
  await rec.registered.get('stream-open.applyPreset')?.run('unstable')
  const names = rec.writes.map((w) => w.property)
  assert.equal(names.includes('cache-secs'), true, names.join(','))
  assert.equal(names.includes('demuxer-max-bytes'), true, names.join(','))
})

test('no keybindable command in this module can reach the network by itself', async () => {
  const rec = await booted()
  // Every command that is NOT internal is reachable from a keypress with no
  // argument. R02/§11.5: an accelerator must not be able to start a request.
  for (const c of rec.registered.values()) {
    if (c.internal === true) continue
    await c.run()
  }
  assert.deepEqual(rec.invokes, [], 'a bindable command opened something with no URL')
  assert.deepEqual([...rec.sideEffects], [])
})

// ---------------------------------------------------------------------------
// The revert (R19 / R20), i.e. the `peek` defect
// ---------------------------------------------------------------------------

async function openHttps(rec: Rec, url: string): Promise<void> {
  const submit = rec.ipcHandlers.get('stream-open:submit')
  assert.notEqual(submit, undefined)
  await submit?.({ url })
  // `openStream` awaits the start-file race; give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 0))
}

test('R20: tls-verify is restored on end-file, from a property nobody observes', async () => {
  const rec = await booted()
  const host = 'cam.example'
  rec.set('stream-open.tlsExceptions', [host])

  await openHttps(rec, withScheme('https', `${host}/live.m3u8`))
  assert.equal(rec.mpvState.get('tls-verify'), 'no')
  // The persistent signal R20 asks for, and the toast kind that actually exists.
  assert.equal(
    rec.toasts.some((t) => t.message === 'stream-open.tlsSkipped'),
    true
  )

  rec.emit('end-file', { reason: 'eof' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rec.mpvState.get('tls-verify'), 'yes')
  // Belt and braces, both halves asserted: the previous value was READ from mpv
  // (not peeked), and `REVERT_FALLBACK` would have got `tls-verify` back to
  // 'yes' even if the read had failed. The next test is the one that separates
  // the two, because a property whose fallback happens to equal its real value
  // cannot tell you which mechanism fired.
  assert.equal(rec.gets.includes('tls-verify'), true)
})

test('the revert reads the value mpv actually holds, not a hardcoded default', async () => {
  /**
   * THE DEFECT THIS SEPARATES OUT. The draft recorded the previous value with
   * `ctx.mpv.peek(property)`. `peek` is "the last value the bus saw", and the
   * bus only sees a property somebody `observe`s — this module observes nine
   * read-only cache properties and NOT ONE of the properties it writes. So
   * `previous` was `undefined` for every override and `restoreDefaults()`
   * skipped it. `user-agent` is the case that proves it: mpv's own default is
   * the literal `libmpv`, which is neither empty nor guessable, so a revert that
   * fell back to '' rather than reading would be visibly wrong. The fake `peek`
   * above returns undefined for anything unobserved, exactly like the real bus.
   */
  const rec = await booted()
  rec.set('stream-open.userAgent', 'Mozilla/5.0 (RLPlayer)')
  await openHttps(rec, withScheme('https', 'cdn.example/a.m3u8'))
  assert.equal(rec.mpvState.get('user-agent'), 'Mozilla/5.0 (RLPlayer)')

  rec.emit('end-file', { reason: 'eof' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rec.mpvState.get('user-agent'), 'libmpv')
})

test('R14: opening an RTSP url never writes network-timeout', async () => {
  const rec = await booted()
  await openHttps(rec, withScheme('rtsp', 'cam.example:554/stream1'))
  const names = rec.writes.map((w) => w.property)
  assert.equal(names.includes('rtsp-transport'), true, names.join(','))
  assert.equal(
    names.includes('network-timeout'),
    false,
    'R14: "merely setting the option will put RTSP into listening mode"'
  )
})

test('R19: a non-RTSP url does get the timeout, and gives it back', async () => {
  const rec = await booted()
  await openHttps(rec, withScheme('https', 'cdn.example/a.m3u8'))
  assert.equal(rec.mpvState.get('network-timeout'), '60')
  rec.emit('end-file', { reason: 'eof' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rec.mpvState.get('network-timeout'), 0)
})

test('R19: http headers are restored as a LIST, not left to accumulate', async () => {
  const rec = await booted()
  rec.set('stream-open.headers', ['X-Token: abc', 'X-Other: 1'])
  await openHttps(rec, withScheme('https', 'cdn.example/a.m3u8'))
  assert.deepEqual(rec.mpvState.get('http-header-fields'), ['X-Token: abc', 'X-Other: 1'])

  rec.emit('end-file', { reason: 'eof' })
  await new Promise((r) => setTimeout(r, 0))
  // `change-list … append` is cumulative: without capturing the previous list,
  // stream two carries stream one's Authorization header.
  assert.deepEqual(rec.mpvState.get('http-header-fields'), [])
})

// ---------------------------------------------------------------------------
// The end-file race
// ---------------------------------------------------------------------------

test("end-file for the OUTGOING file does not revert the incoming stream's options", async () => {
  /**
   * THE OTHER DEFECT THE DRAFT SHIPPED. `loadfile … replace` makes mpv emit
   * `end-file` for the file being replaced, in the middle of our own open. The
   * revert was wired straight to `end-file`, so the sequence was: write
   * `tls-verify=no` for the stream we are opening, ask M28 to open it, receive
   * `end-file` for the PREVIOUS file, and undo everything — before the
   * connection was made. It worked only on the first open of a session.
   */
  const rec = await booted()
  const host = 'cam.example'
  rec.set('stream-open.tlsExceptions', [host])
  rec.autoStartFile = false

  const submit = rec.ipcHandlers.get('stream-open:submit')
  const pending = submit?.({ url: withScheme('https', `${host}/live.m3u8`) }) as
    | Promise<void>
    | undefined
  await new Promise((r) => setTimeout(r, 0))

  // mpv replaces the playlist entry: end-file (old) then start-file (new).
  rec.emit('end-file', { reason: 'redirect' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rec.mpvState.get('tls-verify'), 'no', 'the option was reverted mid-open')

  rec.emit('start-file')
  await pending
  assert.equal(rec.mpvState.get('tls-verify'), 'no')

  // …and once the stream is really over, it IS reverted.
  rec.emit('end-file', { reason: 'eof' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rec.mpvState.get('tls-verify'), 'yes')
})

// ---------------------------------------------------------------------------
// R01's blocker, and R02 at the module boundary
// ---------------------------------------------------------------------------

test("R01: the open goes through M28's mediator and never issues loadfile", async () => {
  const rec = await booted()
  await openHttps(rec, withScheme('https', 'cdn.example/a.m3u8'))
  const ids = rec.invokes.map((i) => i.id)
  assert.equal(ids.includes('playlist.openPaths'), true, ids.join(','))
  for (const c of rec.commands) {
    assert.notEqual(c[0], 'loadfile', 'loadfile is M28-owned (§2.1)')
    assert.notEqual(c[0], 'loadlist', 'loadlist is M28-owned (§2.1)')
  }
})

test('R01: a refused URL reaches no mediator at all', async () => {
  const rec = await booted()
  for (const bad of ['edl://x', 'file:///c:/a.mkv', 'C:\\a.mkv', '', 'example.com/a.m3u8']) {
    await openHttps(rec, bad)
  }
  assert.deepEqual([...rec.invokes], [])
  assert.equal(rec.toasts.length, 5)
  for (const t of rec.toasts) assert.equal(t.kind, 'error')
})

test('R03: only user-entered urls are remembered, and they survive a reload', async () => {
  const rec = await booted()
  await openHttps(rec, withScheme('https', 'cdn.example/one.m3u8'))
  const state = rec.ipcHandlers.get('stream-open:getState')?.(undefined) as {
    recent: Array<{ url: string }>
  }
  assert.equal(state.recent.length, 1)
  assert.equal(state.recent[0]?.url, withScheme('https', 'cdn.example/one.m3u8'))
})

test('the buffer readout is the not-applicable variant for a local file', async () => {
  const rec = await booted()
  rec.mpvState.set('demuxer-via-network', false)
  const buf = rec.ipcHandlers.get('stream-open:getBuffer')?.(undefined) as { network: boolean }
  assert.equal(buf.network, false)
})

test('every registered command and setting id is inside this module\'s namespace', async () => {
  const rec = await booted()
  for (const id of rec.registered.keys()) {
    assert.equal(id.startsWith('stream-open.'), true, id)
  }
  for (const ch of rec.ipcHandlers.keys()) {
    assert.equal(ch.startsWith('stream-open:'), true, ch)
  }
})
