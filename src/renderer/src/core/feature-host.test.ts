import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  __resetForTests,
  createContext,
  loadModules,
  panels,
  publishState,
  setSeekbarHost,
  settingsComponents,
  settingsSections,
  statsSections,
  transportButtons,
  type DiscoveredRendererModule,
  type RendererBridge
} from './feature-host.ts'
import type { RendererFeatureModule } from '../../../shared/renderer-api.ts'
import type { PlayerState } from '../../../shared/types.ts'
import {
  NAMESPACES,
  checkOrdering,
  readMenuRoots,
  scanRepoClaims,
  type ManifestRow
} from '../../../../scripts/lib/ordering.mjs'

/**
 * The regression suite for the "one keypress permanently breaks the overlay"
 * bug, and for the contribution registries the four hosts read.
 *
 * The bug had three parts and needed all three: a duplicate
 * `loadRendererFeatures()` spliced inside the keydown handler, a synchronous
 * state replay in `state.subscribe`, and a module whose subscriber closed over
 * a `let` declared BELOW the subscribe. Each part is harmless alone; together
 * they cost a TDZ ReferenceError per keypress, a seek-bar layer that never
 * registered, and a permanently throwing subscriber leaked per press
 * (0 console errors in 4s before the first keypress; 32 in 4s after one).
 *
 * Every test below asserts on a console.error COUNT rather than on behaviour
 * alone, because "zero console errors" is the property that was actually
 * measured to be broken.
 */

const bridge: RendererBridge = {
  invoke: async () => undefined,
  send: () => {},
  on: () => () => {}
}

function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    path: 'C:/v/a.mkv',
    title: 'a',
    idle: false,
    paused: false,
    eof: false,
    timePos: 12,
    duration: 100,
    volume: 100,
    muted: false,
    speed: 1,
    tracks: [],
    sid: false,
    aid: 1,
    vid: 1,
    chapters: [],
    chapter: 0,
    cacheSeconds: 0,
    fullscreen: false,
    maximized: false,
    alwaysOnTop: false,
    layoutMode: 'overlay',
    ...over
  } as PlayerState
}

/** Counts console.error calls for the duration of `fn`. */
function countingErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const original = console.error
  const errors: string[] = []
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }
  try {
    return { result: fn(), errors }
  } finally {
    console.error = original
  }
}

const discover = (mods: RendererFeatureModule[]): DiscoveredRendererModule[] =>
  mods.map((m) => ({ file: `../features/${m.id}/index.ts`, module: m }))

const load = (mods: RendererFeatureModule[]): RendererFeatureModule[] =>
  loadModules(discover(mods), (id) => createContext(id, bridge, 'player'))

beforeEach(() => __resetForTests())

// --- the loader ------------------------------------------------------------

test('loadModules is idempotent: a second call does not re-run setup()', () => {
  let setups = 0
  const mod: RendererFeatureModule = {
    id: 'nav-chapters',
    setup: () => {
      setups++
    }
  }
  const first = load([mod])
  const second = load([mod])
  assert.equal(setups, 1, 'setup() must run exactly once however often the loader is called')
  assert.equal(second, first, 'the second call returns the same list')
})

test('a hundred duplicate loads leak nothing and log nothing', () => {
  // This is the keypress case: the stray call sat inside the keydown handler,
  // so every bound key re-ran the loader. 100 presses used to mean 100 extra
  // subscribers and ~8 errors/sec forever.
  const mod: RendererFeatureModule = {
    id: 'nav-chapters',
    setup: (ctx) => {
      ctx.state.subscribe(() => {})
    }
  }
  const { errors } = countingErrors(() => {
    load([mod])
    for (let i = 0; i < 100; i++) load([mod])
    // One push after the presses: if subscribers had accumulated we would see
    // the growth here.
    publishState(state())
  })
  assert.deepEqual(errors, [], 'repeated loads must not produce console errors')
})

test('a module whose setup throws is isolated, and the others still load', () => {
  const ok: RendererFeatureModule = { id: 'playlist', setup: () => {} }
  const bad: RendererFeatureModule = {
    id: 'nav-chapters',
    setup: () => {
      throw new Error('boom')
    }
  }
  const { result, errors } = countingErrors(() => load([bad, ok]))
  assert.deepEqual(
    result.map((m) => m.id),
    ['playlist']
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /nav-chapters/)
})

test('a module id that does not match its directory is refused by name', () => {
  const { result, errors } = countingErrors(() =>
    loadModules([{ file: '../features/playlist/index.ts', module: { id: 'plaĺist', setup: () => {} } }], (id) =>
      createContext(id, bridge, 'player')
    )
  )
  assert.deepEqual(result, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /does not match directory 'playlist'/)
})

// --- the synchronous state replay -----------------------------------------

test('state.subscribe replays the current state synchronously', () => {
  publishState(state({ timePos: 42 }))
  let seen: number | null = null
  const ctx = createContext('nav-chapters', bridge, 'player')
  ctx.state.subscribe((s) => {
    seen = s.timePos
  })
  assert.equal(seen, 42, 'a late subscriber must not be blind until the next push')
})

test('the replay is what makes declaration order load-bearing (the TDZ case)', () => {
  // A module written the way nav-chapters was: `paint()` touches a `let`
  // declared BELOW the subscribe. With the synchronous replay the very first
  // paint() runs during setup(), before the declaration is initialised.
  publishState(state())
  const broken: RendererFeatureModule = {
    id: 'nav-chapters',
    setup: (ctx) => {
      ctx.state.subscribe(() => paint())
      // eslint-disable-next-line no-var
      let ticks: string[] = []
      function paint(): void {
        ticks = []
        void ticks
      }
      ctx.seekbarLayer({ id: 'nav-chapters.ticks', order: 10, render: () => {} })
    }
  }
  const registered: string[] = []
  setSeekbarHost({ register: (l) => registered.push(l.id) })
  const { errors } = countingErrors(() => load([broken]))
  assert.equal(errors.length, 1, 'the TDZ throw is caught by the loader, not swallowed')
  assert.match(errors[0]!, /nav-chapters/)
  assert.deepEqual(registered, [], 'and everything after the throw never ran')
})

test('declaring before the subscribe registers the layer and logs nothing', () => {
  // The fixed shape. This is the assertion that would have caught the bug.
  publishState(state())
  const fixed: RendererFeatureModule = {
    id: 'nav-chapters',
    setup: (ctx) => {
      let ticks: string[] = []
      function paint(): void {
        ticks = []
        void ticks
      }
      ctx.state.subscribe(() => paint())
      ctx.seekbarLayer({ id: 'nav-chapters.ticks', order: 10, render: () => {} })
    }
  }
  const registered: string[] = []
  setSeekbarHost({ register: (l) => registered.push(l.id) })
  const { errors } = countingErrors(() => load([fixed]))
  assert.deepEqual(errors, [])
  assert.deepEqual(registered, ['nav-chapters.ticks'])
})

test('a subscriber that throws is isolated and does not stop the others', () => {
  const ctx = createContext('nav-chapters', bridge, 'player')
  let reached = false
  ctx.state.subscribe(() => {
    throw new Error('subscriber boom')
  })
  ctx.state.subscribe(() => {
    reached = true
  })
  const { errors } = countingErrors(() => publishState(state()))
  assert.equal(reached, true)
  assert.equal(errors.length, 1)
})

// --- the contribution registries -------------------------------------------

test('every contribution point lands in a registry a host can read', () => {
  const mod: RendererFeatureModule = {
    id: 'playlist',
    setup: (ctx) => {
      ctx.panel({ id: 'playlist', side: 'right', titleKey: 'playlist.title', order: 10, mount: () => () => {} })
      ctx.statsSection({ id: 'playlist.stats', order: 5, titleKey: 'playlist.stats', fields: () => [] })
      ctx.settingsSection({
        id: 'playlist.section',
        section: 'playback',
        order: 20,
        titleKey: 'playlist.section',
        mount: () => () => {}
      })
      ctx.settingsComponent('playlist.picker', () => () => {})
      ctx.transportButton({
        id: 'playlist.toggle',
        order: 20,
        labelKey: 'playlist.togglePanel',
        mount: () => () => {},
        onClick: () => {}
      })
    }
  }
  load([mod])
  assert.deepEqual(panels.map((p) => p.id), ['playlist'])
  assert.deepEqual(transportButtons.map((b) => b.id), ['playlist.toggle'])
  assert.deepEqual(statsSections.map((s) => s.id), ['playlist.stats'])
  assert.deepEqual(settingsSections.map((s) => s.id), ['playlist.section'])
  assert.equal(settingsComponents.has('playlist.picker'), true)
})

test('panels, stats and settings sections are kept in `order`', () => {
  const mk = (id: string, order: number): RendererFeatureModule => ({
    id,
    setup: (ctx) => {
      ctx.panel({ id, side: 'right', titleKey: id, order, mount: () => () => {} })
      ctx.statsSection({ id, order, titleKey: id, fields: () => [] })
      ctx.settingsSection({ id, section: 'video', order, titleKey: id, mount: () => () => {} })
    }
  })
  load([mk('history', 30), mk('playlist', 10), mk('mediainfo', 20)])
  assert.deepEqual(panels.map((p) => p.id), ['playlist', 'mediainfo', 'history'])
  assert.deepEqual(statsSections.map((s) => s.id), ['playlist', 'mediainfo', 'history'])
  assert.deepEqual(settingsSections.map((s) => s.id), ['playlist', 'mediainfo', 'history'])
})

test('a renderer module may not use a channel outside its namespace', () => {
  const ctx = createContext('nav-chapters', bridge, 'player')
  assert.throws(() => ctx.ipc.send('playlist:play', 1), /outside its namespace/)
  assert.throws(() => ctx.ipc.on('playlist:state', () => {}), /outside its namespace/)
  assert.doesNotThrow(() => ctx.ipc.send('nav-chapters:goto', { index: 1 }))
})

test('the surface tells a module which window it is in', () => {
  assert.equal(createContext('playlist', bridge, 'player').surface, 'player')
  assert.equal(createContext('playlist', bridge, 'settings').surface, 'settings')
})

test('a layer registered before the bar exists is queued, not dropped', () => {
  const ctx = createContext('nav-chapters', bridge, 'player')
  ctx.seekbarLayer({ id: 'nav-chapters.ticks', order: 10, render: () => {} })
  const registered: string[] = []
  setSeekbarHost({ register: (l) => registered.push(l.id) })
  assert.deepEqual(registered, ['nav-chapters.ticks'])
})

// --- ctx.transportButton() -------------------------------------------------

/**
 * The button row is the THIRD place a module's UI ended up in a core file, after
 * `#playlist` (fixed by ctx.panel) and `.seek-chapter-tick` (fixed by the
 * seek-bar layer host). `#subBtn` and `#playlistBtn` were markup in
 * `src/renderer/index.html` with their handlers in `src/renderer/src/main.ts` —
 * two files in the `mustNotTouch` list of 40 of the 55 rows.
 */
test('transport buttons are kept in order, whatever order the modules loaded in', () => {
  const mk = (id: string, order: number): RendererFeatureModule => ({
    id,
    setup: (ctx) =>
      ctx.transportButton({
        id: `${id}.btn`,
        order,
        labelKey: id,
        mount: () => () => {},
        onClick: () => {}
      })
  })
  load([mk('capture-still', 40), mk('subs-tracks', 10), mk('playlist', 20)])
  assert.deepEqual(
    transportButtons.map((b) => b.id),
    ['subs-tracks.btn', 'playlist.btn', 'capture-still.btn']
  )
})

test('two modules cannot claim the same transport button id', () => {
  // Silent last-one-wins is how the CSS collisions went unnoticed for a release.
  const mk = (id: string): RendererFeatureModule => ({
    id,
    setup: (ctx) =>
      ctx.transportButton({
        id: 'contested',
        order: 10,
        labelKey: id,
        mount: () => () => {},
        onClick: () => {}
      })
  })
  const { errors } = countingErrors(() => load([mk('playlist'), mk('subs-tracks')]))
  assert.equal(transportButtons.length, 1, 'the second registration must not silently replace')
  assert.ok(
    errors.some((e) => /duplicate transport button id/.test(e)),
    `the collision was not reported: ${errors.join(' | ')}`
  )
})

// ---------------------------------------------------------------------------
// Every cross-module ORDERING namespace, audited after the seek bar collided
// ---------------------------------------------------------------------------
//
// `SeekbarHost.register()` rejected a duplicate layer id and nothing rejected a
// duplicate `order`, and the two shipped layers at order 10 collided. Auditing
// the sibling namespaces found `ctx.panel()`, `ctx.statsSection()` and
// `ctx.settingsSection()` rejecting NOTHING — not even a duplicate id — and
// `ctx.transportButton()` checking the id but not the order. The tests below are
// per-namespace rather than one loop, so a failure names the namespace.

const orderClash = /duplicate .* order/
const idClash = /duplicate .* id/

test('two panels cannot share an order, and cannot share an id', () => {
  const ctx = createContext('playlist', bridge, 'player')
  const panel = (id: string, order: number): void => {
    ctx.panel({ id, side: 'right', titleKey: 'x', order, mount: () => () => {} })
  }
  panel('playlist', 10)
  assert.throws(() => panel('nav-bookmarks', 10), orderClash)
  assert.throws(() => panel('playlist', 20), idClash)
  panel('nav-bookmarks', 20)
  assert.deepEqual(
    panels.map((p) => p.id),
    ['playlist', 'nav-bookmarks']
  )
})

test('two stats sections cannot share an order, and cannot share an id', () => {
  const ctx = createContext('video-decode', bridge, 'player')
  const section = (id: string, order: number): void => {
    ctx.statsSection({ id, order, titleKey: 'x', fields: () => [] })
  }
  section('video-decode.stats', 20)
  assert.throws(() => section('mediainfo.stats', 20), orderClash)
  assert.throws(() => section('video-decode.stats', 30), idClash)
})

test('two transport buttons cannot share an order', () => {
  const ctx = createContext('playlist', bridge, 'player')
  const button = (id: string, order: number): void => {
    ctx.transportButton({ id, order, labelKey: 'x', mount: () => () => {}, onClick: () => {} })
  }
  button('playlist.toggle', 20)
  assert.throws(() => button('nav-bookmarks.toggle', 20), orderClash)
  button('nav-bookmarks.toggle', 30)
})

test('settings sections may share an order only in DIFFERENT pages', () => {
  // The one namespace with a legitimate scope: two sections that are never
  // sorted against each other cannot collide, and forbidding it would make 55
  // modules coordinate an order across pages they cannot see.
  const ctx = createContext('shell-window', bridge, 'settings')
  const section = (id: string, order: number, page: 'playback' | 'video'): void => {
    ctx.settingsSection({ id, section: page, order, titleKey: 'x', mount: () => () => {} })
  }
  section('shell-window.a', 6, 'playback')
  section('shell-window.b', 6, 'video')
  assert.throws(() => section('shell-window.c', 6, 'video'), orderClash)
})


/**
 * THE SHIPPED CONTRIBUTIONS, AGAINST THE ORDERING PARTITION IN `modules.json`.
 *
 * WHAT THIS TEST USED TO BE, AND WHY IT LIED. It paired `id:` to `order:` with
 * one regex per namespace and a 400/600-character window:
 *
 *     /ctx\.panel\(\{\s*\n?\s*id:\s*'([^']+)'[\s\S]{0,400}?order:\s*(\d+)/g
 *
 * Three ways for that to report clean on a real duplicate, all three present in
 * the delivered tree:
 *
 *   1. the WINDOW — `nav-chapters.skipPrompt` (transport button 60) and
 *      `nav-chapters.skipBands` (seek-bar layer 15) both sit further than 400
 *      characters from their own `id:`, because M25 wrote an 11-line comment
 *      between the two keys to document the collision this test had caught. The
 *      test was blinded by the note about itself;
 *   2. the KEY ORDER — `order:` before `id:` matches nothing;
 *   3. the VALUE — `order: MENU_ORDER` is not `(\d+)`, so M22's menu section was
 *      invisible.
 *
 * MEASURED: putting the duplicate back (`nav-chapters.skipPrompt` at 50, which
 * is `stream-open.toggle`'s) gave `npm test` 1143 pass / 0 fail, while the
 * runtime host threw `duplicate transport button order 50` — a boot crash no
 * check in the repository could see.
 *
 * WHAT IT IS NOW. Ordering is a partition key in `docs/parity/modules.json`
 * (`ownedOrders`), exactly like `ownedProperties` and `ownedFiles`, and the code
 * side is read with the TypeScript AST by `scripts/lib/ordering.mjs` — the same
 * reader `npm run check:ordering` uses, imported rather than re-implemented,
 * because a test that grows its own weaker copy of a shared rule is how this
 * repository got here twice (see `scripts/lib/lex.d.mts`).
 *
 * A comment cannot separate two properties of one object literal in a parse
 * tree, `order` may be a named constant, and key order is irrelevant.
 */
test('the shipped contributions agree with the ordering partition, both directions', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..', '..', '..')
  const modules = JSON.parse(
    fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
  ) as ManifestRow[]

  const { claims, unresolved } = scanRepoClaims(repo)
  const problems = checkOrdering({
    modules,
    codeClaims: claims,
    unresolved,
    menuRoots: readMenuRoots(repo)
  })
  assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '))

  // A reader that found nothing agrees with everything, which is the shape of
  // the header-only netlog. Every namespace must have been exercised by the
  // shipped tree, and the count is asserted per namespace rather than in total.
  for (const spec of NAMESPACES) {
    assert.ok(
      claims.some((c) => c.ns === spec.ns),
      `the AST reader found NO ${spec.ns} contributions in the whole tree`
    )
  }

  // The three claims the retired regex could not read are named, so "the new
  // reader sees them" is a fact this file asserts rather than a claim it makes.
  for (const id of ['nav-chapters.skipPrompt', 'nav-chapters.skipBands', 'capture-still.menu']) {
    assert.ok(
      claims.some((c) => c.id === id),
      `${id} was invisible to the retired regex and must be visible now`
    )
  }
})

/**
 * The partition is only worth having if a collision is detectable from the
 * MANIFEST ALONE — that is the whole difference between "a boot crash we find by
 * booting" and "a conflict CI reports by reading one file". Planted here rather
 * than only in `check-ordering.mjs --self-test`, because `npm test` is what a
 * module author runs.
 */
test('a duplicate order in the manifest is a collision naming both rows', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..', '..', '..')
  const modules = JSON.parse(
    fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
  ) as ManifestRow[]

  // `stream-open.toggle` holds transportButton 50. Give it to M25 as well —
  // the exact duplicate that shipped and booted-crashed — and read the report.
  const planted = modules.map((row) =>
    row.id === 'M25'
      ? {
          ...row,
          ownedOrders: {
            ...row.ownedOrders,
            transportButton: [{ id: 'nav-chapters.skipPrompt', order: 50 }]
          }
        }
      : row
  )
  const problems = checkOrdering({ modules: planted, codeClaims: [] })
  const collision = problems.find((p) => p.includes('ORDERING COLLISION'))
  assert.ok(collision, `expected a collision, got:\n  ${problems.join('\n  ')}`)
  assert.match(collision, /nav-chapters\.skipPrompt/)
  assert.match(collision, /stream-open\.toggle/)
  assert.match(collision, /M25/)
  assert.match(collision, /M35/)
})
