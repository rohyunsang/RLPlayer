import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_BOOKMARKS,
  cycleAbLoop,
  defaultTitle,
  formatPrecise,
  formatTime,
  loopCountToMpv,
  loopPoint,
  makeId,
  mergeBookmarks,
  nextBookmark,
  nudgePoint,
  parseImport,
  prevBookmark,
  remainingLoops,
  sanitizeBookmarks,
  sortBookmarks,
  subtitleLoop,
  toExportJson,
  toFfmetadata,
  type AbLoop,
  type Bookmark
} from './bookmarks.ts'
import type { FeatureContext, FeatureModule, MenuNode, Unsubscribe } from '@shared/feature-api'

/**
 * M26 nav-bookmarks — named bookmarks, the bookmark manager, seek-bar pins and
 * A-B repeat (N10–N15, N17–N23, N50, S41).
 *
 * This module is the pilot for the seek-bar contribution host. Its renderer half
 * paints the pins AND the A-B region on the same bar M25 already paints chapter
 * ticks on, contributes a fragment to the ONE shared tooltip, and drags the A-B
 * endpoints — without touching `src/renderer/src/main.ts`, `index.html` or
 * `styles.css`. If any of that had required a core edit, the Wave-0 experiment
 * would have failed here rather than in Wave 2.
 *
 * OWNERSHIP, and the two halves of it that are easy to get wrong:
 *
 *   - `ab-loop-a` / `ab-loop-b` / `ab-loop-count` are this module's, so the
 *     `ab-loop` COMMAND is too: §2.2 measured `['ab-loop']` writing `ab-loop-a`
 *     from `"no"` to `2.466667` without naming the property, which is exactly
 *     the class of write the owner map used to wave through. Declaring the
 *     command is what stops any other module issuing it.
 *   - Everything else this feature does belongs to somebody else. Seeking is
 *     M24's command, so every jump goes through `nav-seek.seek`; `pause` is
 *     core's, so N23's hold at B goes through `core.pause` / `core.play`. The
 *     renderer half never writes a property at all — it sends here.
 *
 * PERSISTENCE. §2.5 N10 names `<dataDir>/bookmarks.json`; this uses
 * `ctx.perFile.slice()` instead, which is the same identity (`resumeKey`) and
 * the same atomic-write/quarantine/unknown-key guarantees without a second
 * store to keep in sync. See the note on `sliceKey` for the two consequences.
 */

const SLICE_KEY = 'nav-bookmarks'
const NUDGE_SECONDS = 0.1

/** What the renderer half needs, and nothing more. `PlayerState` carries no
 *  A-B fields, so this is pushed on our own channel. */
interface BookmarkPanelState {
  open: boolean
  duration: number
  bookmarks: Bookmark[]
  loop: {
    a: number | null
    b: number | null
    /** N23: B is held here and never written to mpv, so the UI has to be told
     *  which mode drew the region it is looking at. */
    soft: boolean
    count: number
    remaining: number | null
  }
}

/** The per-file record. `bookmarks` is OPTIONAL so an empty list writes no key
 *  at all: the store deletes a file's whole bucket when every slice reports
 *  nothing, and a `bookmarks: []` for every file ever opened would grow the
 *  options store without bound. */
type BookmarkSlice = { bookmarks?: Bookmark[] }

let ctx: FeatureContext

/** The current file's list, plus the identity it was loaded for. */
let list: Bookmark[] = []
let listKey: string | null = null

let panelOpen = false

/** Mirrored from mpv; `null` is a cleared point, never 0 (§2.5 N17). */
const loop: AbLoop = { a: null, b: null }
/** N23's B: held in JS, deliberately never written to `ab-loop-b`. */
let softB: number | null = null
let pauseArmed = false
let pauseTimer: ReturnType<typeof setTimeout> | null = null

const offs: Unsubscribe[] = []

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * The bookmarks for the file that is playing NOW.
 *
 * The key guard is not defensive noise. `PerFileManager.onFileLoaded` calls
 * `apply()` only when the new file HAS a stored value, so a file with no
 * bookmarks never clears what the previous file left behind. Comparing against
 * `currentKey()` makes the answer correct whatever order the core callbacks
 * happen to run in, which is core wiring this module does not control.
 */
function current(): Bookmark[] {
  return listKey !== null && listKey === ctx.perFile.currentKey() ? list : []
}

function commit(next: readonly Bookmark[]): void {
  list = sortBookmarks(next)
  listKey = ctx.perFile.currentKey()
  // Flush now rather than at file close: a crash three hours into a lecture
  // must not cost the forty bookmarks that made it worth watching.
  ctx.perFile.captureNow()
  push()
}

const duration = (): number => ctx.mpv.peek<number>('duration') ?? 0
const timePos = (): number => ctx.mpv.peek<number>('time-pos') ?? 0
const idle = (): boolean => ctx.mpv.peek<boolean>('idle-active') === true

// ---------------------------------------------------------------------------
// A-B loop
// ---------------------------------------------------------------------------

const pauseAtB = (): boolean => ctx.settings.get<boolean>('nav-bookmarks.pauseAtB') === true

/** The B the USER sees, which in N23's mode is the one mpv was never told. */
const effectiveB = (): number | null => (pauseAtB() ? softB : loop.b)

async function writePoint(which: 'a' | 'b', value: number | null): Promise<void> {
  // §2.5 N17, verified: a cleared point is the STRING "no". Writing 0 would
  // draw a loop region from the start of the file over a file nobody looped.
  await ctx.mpv.set(`ab-loop-${which}`, value === null ? 'no' : value).catch((e: Error) => {
    ctx.log.warn(`ab-loop-${which} write failed:`, e.message)
  })
}

async function applyLoopCount(): Promise<void> {
  const wanted = loopCountToMpv(ctx.settings.get<number>('nav-bookmarks.loopCount'))
  await ctx.mpv.set('ab-loop-count', wanted).catch(() => {})
}

async function applyLoop(next: AbLoop): Promise<void> {
  await writePoint('a', next.a)
  if (pauseAtB()) {
    // N23 is explicit: do NOT set `ab-loop-b` in this mode, or mpv loops back
    // instantly and the hold never happens.
    softB = next.b
    await writePoint('b', null)
  } else {
    softB = null
    await writePoint('b', next.b)
  }
  loop.a = next.a
  if (!pauseAtB()) loop.b = next.b
  pauseArmed = false
  await applyLoopCount()
  push()
  announceLoop()
}

function announceLoop(): void {
  const a = loop.a
  const b = effectiveB()
  if (a === null) {
    ctx.osd.show({ kind: 'abloop', text: ctx.i18n.t('nav-bookmarks.osdLoopCleared') })
    return
  }
  ctx.osd.show({
    kind: 'abloop',
    text:
      b === null
        ? ctx.i18n.t('nav-bookmarks.osdLoopA', { time: formatPrecise(a) })
        : ctx.i18n.t('nav-bookmarks.osdLoopAB', {
            a: formatPrecise(a),
            b: formatPrecise(b)
          })
  })
}

/** N23. Driven off the RAW `time-pos` change, not the 100 ms coalesced state
 *  push, or the pause lands up to a tenth of a second past B. */
function onTimePos(raw: unknown): void {
  const t = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  if (t === null) return
  const a = loop.a
  const b = softB
  if (a === null || b === null || !pauseAtB()) {
    pauseArmed = false
    return
  }
  if (t < b) {
    pauseArmed = false
    return
  }
  if (pauseArmed) return
  pauseArmed = true
  void loopBack(a)
}

async function loopBack(a: number): Promise<void> {
  const holdMs = Math.max(0, ctx.settings.get<number>('nav-bookmarks.pauseAtBMs'))
  try {
    await ctx.commands.invoke('core.pause')
    await new Promise<void>((resolve) => {
      pauseTimer = setTimeout(() => {
        pauseTimer = null
        resolve()
      }, holdMs)
    })
    await ctx.commands.invoke('nav-seek.seek', { seconds: a, absolute: true, quiet: true })
    await ctx.commands.invoke('core.play')
  } catch (e) {
    // A failed hold must not leave the player paused forever.
    ctx.log.warn('pause-at-B failed:', (e as Error).message)
    await ctx.commands.invoke('core.play').catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Seeking — always through M24 (§3.6: seeking is M24's command, not ours)
// ---------------------------------------------------------------------------

async function seekTo(seconds: number): Promise<void> {
  // N10: always `absolute+exact`, which is what `nav-seek.seek` emits. A
  // bookmark that lands twelve seconds off is worse than no bookmark.
  await ctx.commands
    .invoke('nav-seek.seek', { seconds: Math.max(0, seconds), absolute: true, quiet: true })
    .catch((e: Error) => ctx.log.warn('seek failed:', e.message))
}

async function jumpTo(bookmark: Bookmark): Promise<void> {
  await seekTo(bookmark.t)
  ctx.osd.show({
    kind: 'bookmark',
    text: ctx.i18n.t('nav-bookmarks.osdJumped', { title: bookmark.title })
  })
}

// ---------------------------------------------------------------------------
// State push
// ---------------------------------------------------------------------------

function push(): void {
  const state: BookmarkPanelState = {
    open: panelOpen,
    duration: duration(),
    bookmarks: current(),
    loop: {
      a: loop.a,
      b: effectiveB(),
      soft: pauseAtB(),
      count: ctx.settings.get<number>('nav-bookmarks.loopCount'),
      remaining: remainingLoops(ctx.mpv.peek('remaining-ab-loops'))
    }
  }
  ctx.ipc.send('nav-bookmarks:state', state)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function addAt(seconds: number, title?: string, b?: number): Bookmark | null {
  // No file, no identity to file the bookmark under — and `commit()` would
  // otherwise store it against `null` and lose it at the next file load.
  if (ctx.perFile.currentKey() === null) return null
  const items = current()
  if (items.length >= MAX_BOOKMARKS) {
    ctx.osd.show({
      kind: 'error',
      text: ctx.i18n.t('nav-bookmarks.osdFull', { max: MAX_BOOKMARKS })
    })
    return null
  }
  // Two pins on the same frame are two ways to say the same thing and one of
  // them is unreachable on a 400 px bar.
  if (items.some((x) => Math.abs(x.t - seconds) < 0.5 && x.b === b)) {
    ctx.osd.show({ kind: 'bookmark', text: ctx.i18n.t('nav-bookmarks.osdDuplicate') })
    return null
  }
  const bookmark: Bookmark = {
    id: makeId(),
    t: Math.max(0, seconds),
    title: title?.trim() || defaultTitle(seconds),
    createdAt: Date.now()
  }
  if (b !== undefined && b > bookmark.t) bookmark.b = b
  commit([...items, bookmark])
  return bookmark
}

function byId(id: unknown): Bookmark | null {
  return current().find((b) => b.id === id) ?? null
}

async function exportBookmarks(): Promise<void> {
  const items = current()
  const file = ctx.perFile.currentPath()
  if (items.length === 0 || !file) {
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdNothingToExport') })
    return
  }
  const base = path.parse(file).name
  const target = await ctx.dialog.saveFile({
    titleKey: 'nav-bookmarks.exportTitle',
    defaultPath: `${base}.bookmarks.json`,
    filters: [
      { name: 'RLPlayer bookmarks', extensions: ['json'] },
      { name: 'ffmetadata', extensions: ['ffmeta', 'txt'] }
    ]
  })
  if (!target) return
  // N15: the extension picks the format, because the ffmetadata half exists to
  // round-trip through `--chapters-file` (N07) and mkvtoolnix.
  const ffmeta = /\.(ffmeta|txt)$/i.test(target)
  const body = ffmeta ? toFfmetadata(items, duration()) : toExportJson(file, items)
  try {
    fs.writeFileSync(target, body, 'utf8')
    ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('nav-bookmarks.osdExported') })
  } catch (e) {
    ctx.log.error('export failed:', (e as Error).message)
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdExportFailed') })
  }
}

async function importBookmarks(): Promise<void> {
  if (ctx.perFile.currentKey() === null) return
  const picked = await ctx.dialog.openFiles({
    titleKey: 'nav-bookmarks.importTitle',
    multi: false,
    filters: [{ name: 'Bookmarks', extensions: ['json', 'ffmeta', 'txt'] }]
  })
  const source = picked[0]
  if (!source) return
  let text = ''
  try {
    text = fs.readFileSync(source, 'utf8')
  } catch (e) {
    ctx.log.error('import failed:', (e as Error).message)
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdImportFailed') })
    return
  }
  const incoming = parseImport(text)
  if (incoming.length === 0) {
    ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdImportEmpty') })
    return
  }
  const merged = mergeBookmarks(current(), incoming)
  const added = merged.length - current().length
  commit(merged)
  ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('nav-bookmarks.osdImported', { n: added }) })
}

const mod: FeatureModule = {
  id: 'nav-bookmarks',
  ownsProperties: ['ab-loop-a', 'ab-loop-b', 'ab-loop-count'],
  /**
   * `ab-loop` writes `ab-loop-a` without naming it (§2.2's measured table) and
   * `ab-loop-align-cache` snaps both endpoints to demuxer-cache boundaries.
   * Both belong to whoever owns the points. M23 needs the second one for its
   * lossless cache dump and reaches it through the mediator below.
   */
  ownsCommands: ['ab-loop', 'ab-loop-align-cache'],

  setup(c): void {
    ctx = c

    // -- settings ---------------------------------------------------------
    ctx.settings.define([
      {
        id: 'nav-bookmarks.loopCount',
        section: 'playback',
        group: 'abloop',
        labelKey: 'nav-bookmarks.loopCount',
        descriptionKey: 'nav-bookmarks.loopCountHelp',
        type: { kind: 'int', min: 0, max: 99, step: 1 },
        default: 0,
        mpvOption: 'ab-loop-count',
        keywords: ['ab', '구간 반복', 'repeat', 'loop'],
        order: 40
      },
      {
        id: 'nav-bookmarks.pauseAtB',
        section: 'playback',
        group: 'abloop',
        labelKey: 'nav-bookmarks.pauseAtB',
        descriptionKey: 'nav-bookmarks.pauseAtBHelp',
        type: { kind: 'bool' },
        default: false,
        keywords: ['일시정지', 'pause', 'shadow'],
        order: 41
      },
      {
        id: 'nav-bookmarks.pauseAtBMs',
        section: 'playback',
        group: 'abloop',
        labelKey: 'nav-bookmarks.pauseAtBMs',
        // "only when the switch above is on" is prose because it cannot be
        // structural: `SettingDescriptor.visibleWhen` is in the API and the
        // generated form never reads it (a function cannot cross the snapshot
        // IPC either). Reported rather than worked around.
        descriptionKey: 'nav-bookmarks.pauseAtBMsHelp',
        type: { kind: 'int', min: 0, max: 5000, step: 100 },
        default: 500,
        order: 42
      },
      {
        id: 'nav-bookmarks.subtitleTailMs',
        section: 'playback',
        group: 'abloop',
        labelKey: 'nav-bookmarks.subtitleTailMs',
        descriptionKey: 'nav-bookmarks.subtitleTailHelp',
        type: { kind: 'int', min: 0, max: 2000, step: 50 },
        default: 200,
        keywords: ['자막', 'subtitle', 'loop'],
        order: 43
      }
    ])

    // Switching modes has to move B between mpv and this module, or the region
    // the user is looking at stops matching the loop that is playing.
    offs.push(
      ctx.settings.onChange<boolean>('nav-bookmarks.pauseAtB', () => {
        const b = loop.b ?? softB
        void applyLoop({ a: loop.a, b })
      })
    )
    offs.push(
      ctx.settings.onChange<number>('nav-bookmarks.loopCount', () => {
        void applyLoopCount().then(push)
      })
    )

    // -- per-file state ---------------------------------------------------
    /**
     * N10 says `<dataDir>/bookmarks.json` keyed by `resumeKey()`; this is that
     * store, reached the sanctioned way. Two consequences worth writing down:
     *
     *   1. the options store keeps its entry when a file FINISHES (only
     *      `resume.json` deletes one), so a bookmark outlives watching the file
     *      to the end — which is the behaviour §6.3 asks this module to make
     *      documented rather than accidental;
     *   2. the key is `path + size`, so a file renamed IN PLACE keeps its
     *      bookmarks and a file moved to another folder loses them. That is
     *      §7.9's open D-2 decision, made once for resume, history and
     *      bookmarks together instead of three times differently.
     */
    ctx.perFile.slice<BookmarkSlice>({
      key: SLICE_KEY,
      capture: () => {
        const items = current()
        return items.length > 0 ? { bookmarks: items } : {}
      },
      apply: (value) => {
        list = sanitizeBookmarks(value.bookmarks)
        listKey = ctx.perFile.currentKey()
        push()
      },
      rememberDefaults: { bookmarks: true }
    })

    // -- mpv observation --------------------------------------------------
    // N19: `ab-loop-a`/`-b` are not in core's OBSERVED set, so the region would
    // never redraw without these. `observe` is refcounted, so this costs one
    // `observe_property` each however many modules ask.
    offs.push(
      ctx.mpv.observe('ab-loop-a', (v) => {
        loop.a = loopPoint(v)
        push()
      })
    )
    offs.push(
      ctx.mpv.observe('ab-loop-b', (v) => {
        loop.b = loopPoint(v)
        push()
      })
    )
    offs.push(ctx.mpv.observe('remaining-ab-loops', () => push()))
    offs.push(ctx.mpv.observe('time-pos', onTimePos))
    offs.push(
      ctx.mpv.observe('duration', () => {
        push()
      })
    )

    // A new file starts with no loop: mpv keeps `ab-loop-a` across a
    // `loadfile`, which is how a loop set in episode 1 silently truncates
    // episode 2. The bookmark mirror is dropped only once `currentKey()` has
    // actually moved on — the per-file service switches identity AFTER this
    // callback, which is why `current()` guards on the key rather than trusting
    // this to have run.
    offs.push(
      ctx.mpv.afterFileLoaded(() => {
        softB = null
        pauseArmed = false
        if (listKey !== ctx.perFile.currentKey()) list = []
        push()
      })
    )

    // -- IPC (renderer half) ----------------------------------------------
    ctx.ipc.on('nav-bookmarks:request', () => push())
    ctx.ipc.on('nav-bookmarks:togglePanel', () => {
      panelOpen = !panelOpen
      push()
    })
    ctx.ipc.on<{ id: string }>('nav-bookmarks:goto', (req) => {
      void ctx.commands.invoke('nav-bookmarks.goto', req?.id)
    })
    ctx.ipc.on<{ id: string; title: string }>('nav-bookmarks:rename', (req) => {
      void ctx.commands.invoke('nav-bookmarks.rename', req)
    })
    ctx.ipc.on<{ id: string }>('nav-bookmarks:remove', (req) => {
      void ctx.commands.invoke('nav-bookmarks.remove', req?.id)
    })
    ctx.ipc.on<{ id: string; t: number }>('nav-bookmarks:move', (req) => {
      void ctx.commands.invoke('nav-bookmarks.move', req)
    })
    ctx.ipc.on('nav-bookmarks:add', () => {
      void ctx.commands.invoke('nav-bookmarks.add')
    })
    // The seek-bar layer's drag lands here. Note what it does NOT do: it never
    // writes `ab-loop-a` itself. The renderer half of a module owns no mpv
    // property, whoever owns the main half.
    ctx.ipc.on<{ which: 'a' | 'b'; t: number }>('nav-bookmarks:setLoopPoint', (req) => {
      void ctx.commands.invoke('nav-bookmarks.setLoopPoint', req)
    })
    ctx.ipc.on('nav-bookmarks:clearLoop', () => {
      void ctx.commands.invoke('nav-bookmarks.abLoopClear')
    })
    ctx.ipc.on('nav-bookmarks:export', () => void exportBookmarks())
    ctx.ipc.on('nav-bookmarks:import', () => void importBookmarks())

    // -- commands ---------------------------------------------------------
    ctx.commands.register([
      {
        id: 'nav-bookmarks.add',
        labelKey: 'nav-bookmarks.add',
        category: 'navigation',
        defaults: { default: ['Ctrl+KeyB'], potplayer: ['Ctrl+KeyB'] },
        enabledWhen: () => !idle(),
        run: () => {
          const bookmark = addAt(timePos())
          if (bookmark) {
            ctx.osd.show({
              kind: 'bookmark',
              text: ctx.i18n.t('nav-bookmarks.osdAdded', { title: bookmark.title })
            })
          }
        }
      },
      {
        // N22: a bookmark with a `b` field IS a section. One panel, one store.
        id: 'nav-bookmarks.addSection',
        labelKey: 'nav-bookmarks.addSection',
        category: 'navigation',
        defaults: { default: ['Ctrl+Shift+KeyB'] },
        enabledWhen: () => loop.a !== null && effectiveB() !== null,
        run: () => {
          const a = loop.a
          const b = effectiveB()
          if (a === null || b === null) {
            ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdNoLoop') })
            return
          }
          const bookmark = addAt(a, `${formatTime(a)} – ${formatTime(b)}`, b)
          if (bookmark) {
            ctx.osd.show({
              kind: 'bookmark',
              text: ctx.i18n.t('nav-bookmarks.osdSectionSaved', { title: bookmark.title })
            })
          }
        }
      },
      {
        id: 'nav-bookmarks.togglePanel',
        labelKey: 'nav-bookmarks.togglePanel',
        category: 'navigation',
        defaults: { default: ['Ctrl+Alt+KeyB'], potplayer: ['Ctrl+Alt+KeyB'] },
        run: () => {
          panelOpen = !panelOpen
          push()
        }
      },
      {
        // N12: chapters keep PgUp/PgDn; bookmarks get the shifted pair. Sharing
        // one key with chapters is ambiguous on a file that has both.
        id: 'nav-bookmarks.next',
        labelKey: 'nav-bookmarks.next',
        category: 'navigation',
        defaults: { default: ['Shift+PageDown'], potplayer: ['Shift+PageDown'] },
        enabledWhen: () => current().length > 0,
        run: async () => {
          const bookmark = nextBookmark(current(), timePos())
          if (!bookmark) {
            ctx.osd.show({ kind: 'bookmark', text: ctx.i18n.t('nav-bookmarks.osdNoNext') })
            return
          }
          await jumpTo(bookmark)
        }
      },
      {
        id: 'nav-bookmarks.prev',
        labelKey: 'nav-bookmarks.prev',
        category: 'navigation',
        defaults: { default: ['Shift+PageUp'], potplayer: ['Shift+PageUp'] },
        enabledWhen: () => current().length > 0,
        run: async () => {
          const bookmark = prevBookmark(current(), timePos())
          if (!bookmark) {
            ctx.osd.show({ kind: 'bookmark', text: ctx.i18n.t('nav-bookmarks.osdNoPrev') })
            return
          }
          await jumpTo(bookmark)
        }
      },
      {
        id: 'nav-bookmarks.goto',
        labelKey: 'nav-bookmarks.goto',
        category: 'navigation',
        internal: true,
        run: async (arg) => {
          const bookmark = byId(arg)
          if (!bookmark) return
          // N22: activating a SECTION writes both loop points and then seeks to
          // a, so the saved region starts playing rather than merely existing.
          if (bookmark.b !== undefined) await applyLoop({ a: bookmark.t, b: bookmark.b })
          await jumpTo(bookmark)
        }
      },
      {
        id: 'nav-bookmarks.rename',
        labelKey: 'nav-bookmarks.rename',
        category: 'navigation',
        internal: true,
        run: (arg) => {
          const a = (arg ?? {}) as { id?: string; title?: string }
          const bookmark = byId(a.id)
          if (!bookmark) return
          const title = (a.title ?? '').trim() || defaultTitle(bookmark.t)
          commit(current().map((b) => (b.id === bookmark.id ? { ...b, title } : b)))
        }
      },
      {
        id: 'nav-bookmarks.remove',
        labelKey: 'nav-bookmarks.remove',
        category: 'navigation',
        internal: true,
        run: (arg) => {
          const bookmark = byId(arg)
          if (!bookmark) return
          commit(current().filter((b) => b.id !== bookmark.id))
          ctx.osd.show({
            kind: 'bookmark',
            text: ctx.i18n.t('nav-bookmarks.osdRemoved', { title: bookmark.title })
          })
        }
      },
      {
        // Dragging a pin along the bar.
        id: 'nav-bookmarks.move',
        labelKey: 'nav-bookmarks.move',
        category: 'navigation',
        internal: true,
        run: (arg) => {
          const a = (arg ?? {}) as { id?: string; t?: number }
          const bookmark = byId(a.id)
          const t = Number(a.t)
          if (!bookmark || !Number.isFinite(t)) return
          const clamped = Math.max(0, duration() > 0 ? Math.min(t, duration()) : t)
          commit(current().map((b) => (b.id === bookmark.id ? { ...b, t: clamped } : b)))
        }
      },
      {
        id: 'nav-bookmarks.clearAll',
        labelKey: 'nav-bookmarks.clearAll',
        category: 'navigation',
        enabledWhen: () => current().length > 0,
        run: async () => {
          const ok = await ctx.dialog.confirm({
            titleKey: 'nav-bookmarks.clearAll',
            messageKey: 'nav-bookmarks.clearAllConfirm',
            params: { n: current().length },
            confirmKey: 'nav-bookmarks.clearAllOk',
            destructive: true
          })
          if (!ok) return
          commit([])
          ctx.osd.show({ kind: 'bookmark', text: ctx.i18n.t('nav-bookmarks.osdCleared') })
        }
      },

      // --- A-B repeat ----------------------------------------------------
      {
        /**
         * N17's one-key cycle, written as three explicit property writes rather
         * than `['ab-loop']`.
         *
         * The mpv command sets its point from the current playback position too,
         * so the two agree on WHERE — but it always writes `ab-loop-b`, which
         * N23's mode must not do, and it reports nothing back, so the OSD would
         * have to re-read both properties to say what just happened. `KeyL` is
         * mpv's own binding for this and is already claimed by M28's playlist
         * panel in all three presets, so the default here is `Ctrl+KeyL`.
         */
        id: 'nav-bookmarks.abLoopCycle',
        labelKey: 'nav-bookmarks.abLoopCycle',
        category: 'navigation',
        defaults: {
          default: ['Ctrl+KeyL'],
          potplayer: ['Ctrl+KeyL'],
          mpv: ['Ctrl+KeyL']
        },
        enabledWhen: () => !idle(),
        run: () => applyLoop(cycleAbLoop({ a: loop.a, b: effectiveB() }, timePos()))
      },
      {
        id: 'nav-bookmarks.abLoopSetA',
        labelKey: 'nav-bookmarks.abLoopSetA',
        category: 'navigation',
        defaults: { default: ['Ctrl+BracketLeft'], potplayer: ['Ctrl+BracketLeft'] },
        enabledWhen: () => !idle(),
        run: () => applyLoop({ a: timePos(), b: effectiveB() })
      },
      {
        id: 'nav-bookmarks.abLoopSetB',
        labelKey: 'nav-bookmarks.abLoopSetB',
        category: 'navigation',
        defaults: { default: ['Ctrl+BracketRight'], potplayer: ['Ctrl+BracketRight'] },
        enabledWhen: () => !idle(),
        run: () => {
          const t = timePos()
          const a = loop.a
          // A B before A is not a loop; treat it as "start again here".
          return a !== null && t > a ? applyLoop({ a, b: t }) : applyLoop({ a: t, b: null })
        }
      },
      {
        id: 'nav-bookmarks.abLoopClear',
        labelKey: 'nav-bookmarks.abLoopClear',
        category: 'navigation',
        defaults: { default: ['Ctrl+Backslash'], potplayer: ['Ctrl+Backslash'] },
        run: () => applyLoop({ a: null, b: null })
      },
      {
        id: 'nav-bookmarks.setLoopPoint',
        labelKey: 'nav-bookmarks.setLoopPoint',
        category: 'navigation',
        internal: true,
        run: (arg) => {
          const a = (arg ?? {}) as { which?: 'a' | 'b'; t?: number }
          const t = Number(a.t)
          if (!Number.isFinite(t)) return
          const next: AbLoop =
            a.which === 'b' ? { a: loop.a, b: t } : { a: t, b: effectiveB() }
          // A drag that pulls one endpoint past the other would store an
          // inverted pair mpv cannot play.
          if (next.a !== null && next.b !== null && next.b <= next.a) return
          return applyLoop(next)
        }
      },
      {
        // S41 / N20 — the language-learner's feature.
        id: 'nav-bookmarks.abLoopSubtitle',
        labelKey: 'nav-bookmarks.abLoopSubtitle',
        category: 'subtitles',
        defaults: { default: ['Ctrl+Shift+KeyL'], potplayer: ['Ctrl+Shift+KeyL'] },
        enabledWhen: () => !idle(),
        run: async () => {
          // Reads are unrestricted; `sub-start`/`sub-end` are M20's world and we
          // never write them. Both are null when no line is on screen, and JSON
          // IPC returns the full double, so `sub-start/full` buys nothing here.
          const [start, end, delay] = await Promise.all([
            ctx.mpv.get('sub-start').catch(() => null),
            ctx.mpv.get('sub-end').catch(() => null),
            ctx.mpv.get<number>('sub-delay').catch(() => 0)
          ])
          const tail = ctx.settings.get<number>('nav-bookmarks.subtitleTailMs') / 1000
          const next = subtitleLoop(start, end, typeof delay === 'number' ? delay : 0, tail)
          if (!next) {
            ctx.osd.show({ kind: 'error', text: ctx.i18n.t('nav-bookmarks.osdNoSubtitle') })
            return
          }
          await applyLoop(next)
          await seekTo(next.a as number)
        }
      },
      {
        id: 'nav-bookmarks.nudgeAMinus',
        labelKey: 'nav-bookmarks.nudgeAMinus',
        category: 'navigation',
        defaults: { default: ['Ctrl+Alt+ArrowLeft'] },
        enabledWhen: () => loop.a !== null,
        run: () => nudge('a', -NUDGE_SECONDS)
      },
      {
        id: 'nav-bookmarks.nudgeAPlus',
        labelKey: 'nav-bookmarks.nudgeAPlus',
        category: 'navigation',
        defaults: { default: ['Ctrl+Alt+ArrowRight'] },
        enabledWhen: () => loop.a !== null,
        run: () => nudge('a', NUDGE_SECONDS)
      },
      {
        id: 'nav-bookmarks.nudgeBMinus',
        labelKey: 'nav-bookmarks.nudgeBMinus',
        category: 'navigation',
        defaults: { default: ['Ctrl+Alt+Shift+ArrowLeft'] },
        enabledWhen: () => effectiveB() !== null,
        run: () => nudge('b', -NUDGE_SECONDS)
      },
      {
        id: 'nav-bookmarks.nudgeBPlus',
        labelKey: 'nav-bookmarks.nudgeBPlus',
        category: 'navigation',
        defaults: { default: ['Ctrl+Alt+Shift+ArrowRight'] },
        enabledWhen: () => effectiveB() !== null,
        run: () => nudge('b', NUDGE_SECONDS)
      },
      {
        id: 'nav-bookmarks.jumpToA',
        labelKey: 'nav-bookmarks.jumpToA',
        category: 'navigation',
        enabledWhen: () => loop.a !== null,
        run: async () => {
          if (loop.a === null) return
          await seekTo(loop.a)
          announceLoop()
        }
      },
      {
        /**
         * The mediator for `ab-loop-align-cache`. M23 (capture) owns
         * `dump-cache` and `ab-loop-dump-cache` and needs the endpoints snapped
         * to demuxer-cache boundaries before a lossless dump — but the command
         * that MOVES the endpoints is a write to this module's properties, so
         * it is ours to issue and M23's to ask for. §3.7.3's one-line PR.
         */
        id: 'nav-bookmarks.alignLoopToCache',
        labelKey: 'nav-bookmarks.alignLoopToCache',
        category: 'navigation',
        internal: true,
        run: async () => {
          if (loop.a === null) return { a: null, b: null }
          await ctx.mpv.command(['ab-loop-align-cache']).catch((e: Error) => {
            ctx.log.warn('ab-loop-align-cache failed:', e.message)
          })
          const [a, b] = await Promise.all([
            ctx.mpv.get('ab-loop-a').catch(() => null),
            ctx.mpv.get('ab-loop-b').catch(() => null)
          ])
          loop.a = loopPoint(a)
          loop.b = loopPoint(b)
          push()
          return { a: loop.a, b: loop.b }
        }
      },

      // --- N15 -----------------------------------------------------------
      {
        id: 'nav-bookmarks.export',
        labelKey: 'nav-bookmarks.export',
        category: 'navigation',
        enabledWhen: () => current().length > 0,
        run: () => exportBookmarks()
      },
      {
        id: 'nav-bookmarks.import',
        labelKey: 'nav-bookmarks.import',
        category: 'navigation',
        enabledWhen: () => !idle(),
        run: () => importBookmarks()
      }
    ])

    // -- menu -------------------------------------------------------------
    ctx.menu.contribute({
      id: 'nav-bookmarks.menu',
      labelKey: 'nav-bookmarks.menuTitle',
      order: 46,
      items: [
        { commandId: 'nav-bookmarks.add' },
        { commandId: 'nav-bookmarks.addSection' },
        { commandId: 'nav-bookmarks.togglePanel' },
        { type: 'separator' },
        {
          labelKey: 'nav-bookmarks.jumpTo',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const items = current()
                if (items.length === 0) {
                  return [{ labelKey: 'nav-bookmarks.none', enabled: false }]
                }
                return items.map((b) => ({
                  label: `${formatTime(b.t)}  ${b.title}`,
                  commandId: 'nav-bookmarks.goto',
                  arg: b.id
                }))
              }
            }
          ]
        },
        { type: 'separator' },
        { commandId: 'nav-bookmarks.abLoopCycle' },
        { commandId: 'nav-bookmarks.abLoopSubtitle' },
        { commandId: 'nav-bookmarks.abLoopClear' },
        { type: 'separator' },
        { commandId: 'nav-bookmarks.export' },
        { commandId: 'nav-bookmarks.import' },
        { commandId: 'nav-bookmarks.clearAll' }
      ]
    })

    // -- i18n -------------------------------------------------------------
    ctx.i18n.register('ko', {
      'nav-bookmarks.add': '북마크 추가',
      'nav-bookmarks.addSection': 'A-B 구간을 북마크로 저장',
      'nav-bookmarks.togglePanel': '북마크 목록',
      'nav-bookmarks.next': '다음 북마크',
      'nav-bookmarks.prev': '이전 북마크',
      'nav-bookmarks.goto': '북마크로 이동',
      'nav-bookmarks.rename': '북마크 이름 변경',
      'nav-bookmarks.remove': '북마크 삭제',
      'nav-bookmarks.move': '북마크 위치 이동',
      'nav-bookmarks.clearAll': '북마크 모두 삭제',
      'nav-bookmarks.clearAllConfirm': '북마크 {n}개를 모두 삭제할까요?',
      'nav-bookmarks.clearAllOk': '삭제',
      'nav-bookmarks.abLoopCycle': 'A-B 반복 (A → B → 해제)',
      'nav-bookmarks.abLoopSetA': 'A 지점 지정',
      'nav-bookmarks.abLoopSetB': 'B 지점 지정',
      'nav-bookmarks.abLoopClear': 'A-B 반복 해제',
      'nav-bookmarks.abLoopSubtitle': '현재 자막 구간 반복',
      'nav-bookmarks.setLoopPoint': 'A-B 지점 조정',
      'nav-bookmarks.alignLoopToCache': 'A-B 지점을 캐시 경계에 맞춤',
      'nav-bookmarks.nudgeAMinus': 'A 지점 -0.1초',
      'nav-bookmarks.nudgeAPlus': 'A 지점 +0.1초',
      'nav-bookmarks.nudgeBMinus': 'B 지점 -0.1초',
      'nav-bookmarks.nudgeBPlus': 'B 지점 +0.1초',
      'nav-bookmarks.jumpToA': 'A 지점으로 이동',
      'nav-bookmarks.export': '북마크 내보내기',
      'nav-bookmarks.import': '북마크 가져오기',
      'nav-bookmarks.exportTitle': '북마크 내보내기',
      'nav-bookmarks.importTitle': '북마크 가져오기',
      'nav-bookmarks.menuTitle': '북마크',
      'nav-bookmarks.jumpTo': '북마크로 이동',
      'nav-bookmarks.none': '(북마크 없음)',
      'nav-bookmarks.loopCount': 'A-B 반복 횟수',
      'nav-bookmarks.loopCountHelp': '0이면 무한 반복입니다.',
      'nav-bookmarks.pauseAtB': 'B 지점에서 잠시 멈춘 뒤 되돌아가기',
      'nav-bookmarks.pauseAtBHelp': '받아쓰기·쉐도잉용. 켜면 mpv 대신 RLPlayer가 구간을 되돌립니다.',
      'nav-bookmarks.pauseAtBMs': 'B 지점에서 멈추는 시간 (밀리초)',
      'nav-bookmarks.pauseAtBMsHelp': '위의 “B 지점에서 잠시 멈추기”를 켰을 때만 적용됩니다.',
      'nav-bookmarks.subtitleTailMs': '자막 구간 뒤 여유 시간 (밀리초)',
      'nav-bookmarks.subtitleTailHelp': '마지막 음절이 잘리지 않도록 B 지점을 조금 뒤로 미룹니다.',
      'nav-bookmarks.title': '북마크',
      'nav-bookmarks.filter': '북마크 검색',
      'nav-bookmarks.close': '닫기',
      'nav-bookmarks.empty': '이 파일에는 북마크가 없습니다.',
      'nav-bookmarks.noMatch': '검색 결과가 없습니다.',
      'nav-bookmarks.section': '구간',
      'nav-bookmarks.renamePrompt': '새 이름',
      'nav-bookmarks.pinLabel': '북마크: {title}',
      'nav-bookmarks.handleA': 'A 지점',
      'nav-bookmarks.handleB': 'B 지점',
      'nav-bookmarks.osdAdded': '북마크: {title}',
      'nav-bookmarks.osdRemoved': '{title}{을/를} 삭제했습니다',
      'nav-bookmarks.osdJumped': '북마크: {title}',
      'nav-bookmarks.osdCleared': '북마크를 모두 삭제했습니다',
      'nav-bookmarks.osdDuplicate': '같은 위치에 북마크가 이미 있습니다',
      'nav-bookmarks.osdFull': '북마크는 파일당 {max}개까지입니다',
      'nav-bookmarks.osdNoNext': '다음 북마크가 없습니다',
      'nav-bookmarks.osdNoPrev': '이전 북마크가 없습니다',
      'nav-bookmarks.osdSectionSaved': '구간 저장: {title}',
      'nav-bookmarks.osdNoLoop': 'A-B 구간이 지정되지 않았습니다',
      'nav-bookmarks.osdLoopA': 'A 지정 {time}',
      'nav-bookmarks.osdLoopB': 'B 지정 {time}',
      'nav-bookmarks.osdLoopAB': '반복 {a} – {b}',
      'nav-bookmarks.osdLoopCleared': 'A-B 반복 해제',
      'nav-bookmarks.osdNoSubtitle': '현재 위치에 자막이 없습니다',
      'nav-bookmarks.osdExported': '북마크를 저장했습니다',
      'nav-bookmarks.osdExportFailed': '북마크를 저장하지 못했습니다',
      'nav-bookmarks.osdNothingToExport': '내보낼 북마크가 없습니다',
      'nav-bookmarks.osdImported': '북마크 {n}개를 가져왔습니다',
      'nav-bookmarks.osdImportFailed': '북마크 파일을 읽지 못했습니다',
      'nav-bookmarks.osdImportEmpty': '가져올 북마크를 찾지 못했습니다'
    })
    ctx.i18n.register('en', {
      'nav-bookmarks.add': 'Add bookmark',
      'nav-bookmarks.addSection': 'Save A-B range as a bookmark',
      'nav-bookmarks.togglePanel': 'Bookmarks',
      'nav-bookmarks.next': 'Next bookmark',
      'nav-bookmarks.prev': 'Previous bookmark',
      'nav-bookmarks.goto': 'Go to bookmark',
      'nav-bookmarks.rename': 'Rename bookmark',
      'nav-bookmarks.remove': 'Delete bookmark',
      'nav-bookmarks.move': 'Move bookmark',
      'nav-bookmarks.clearAll': 'Delete all bookmarks',
      'nav-bookmarks.clearAllConfirm': 'Delete all {n} bookmarks for this file?',
      'nav-bookmarks.clearAllOk': 'Delete',
      'nav-bookmarks.abLoopCycle': 'A-B repeat (A → B → clear)',
      'nav-bookmarks.abLoopSetA': 'Set loop point A',
      'nav-bookmarks.abLoopSetB': 'Set loop point B',
      'nav-bookmarks.abLoopClear': 'Clear A-B repeat',
      'nav-bookmarks.abLoopSubtitle': 'Loop the current subtitle line',
      'nav-bookmarks.setLoopPoint': 'Adjust an A-B point',
      'nav-bookmarks.alignLoopToCache': 'Align A-B to cache boundaries',
      'nav-bookmarks.nudgeAMinus': 'Loop point A -0.1s',
      'nav-bookmarks.nudgeAPlus': 'Loop point A +0.1s',
      'nav-bookmarks.nudgeBMinus': 'Loop point B -0.1s',
      'nav-bookmarks.nudgeBPlus': 'Loop point B +0.1s',
      'nav-bookmarks.jumpToA': 'Jump to loop point A',
      'nav-bookmarks.export': 'Export bookmarks',
      'nav-bookmarks.import': 'Import bookmarks',
      'nav-bookmarks.exportTitle': 'Export bookmarks',
      'nav-bookmarks.importTitle': 'Import bookmarks',
      'nav-bookmarks.menuTitle': 'Bookmarks',
      'nav-bookmarks.jumpTo': 'Go to bookmark',
      'nav-bookmarks.none': '(no bookmarks)',
      'nav-bookmarks.loopCount': 'A-B repeat count',
      'nav-bookmarks.loopCountHelp': '0 repeats forever.',
      'nav-bookmarks.pauseAtB': 'Pause briefly at B before looping back',
      'nav-bookmarks.pauseAtBHelp':
        'For dictation and shadowing. RLPlayer drives the loop instead of mpv while this is on.',
      'nav-bookmarks.pauseAtBMs': 'Hold at B (ms)',
      'nav-bookmarks.pauseAtBMsHelp': 'Only applies while the switch above is on.',
      'nav-bookmarks.subtitleTailMs': 'Tail added after a subtitle line (ms)',
      'nav-bookmarks.subtitleTailHelp': 'Keeps the last syllable from clipping.',
      'nav-bookmarks.title': 'Bookmarks',
      'nav-bookmarks.filter': 'Filter bookmarks',
      'nav-bookmarks.close': 'Close',
      'nav-bookmarks.empty': 'No bookmarks for this file yet.',
      'nav-bookmarks.noMatch': 'Nothing matches.',
      'nav-bookmarks.section': 'range',
      'nav-bookmarks.renamePrompt': 'New name',
      'nav-bookmarks.pinLabel': 'Bookmark: {title}',
      'nav-bookmarks.handleA': 'Loop point A',
      'nav-bookmarks.handleB': 'Loop point B',
      'nav-bookmarks.osdAdded': 'Bookmark: {title}',
      'nav-bookmarks.osdRemoved': 'Deleted {title}',
      'nav-bookmarks.osdJumped': 'Bookmark: {title}',
      'nav-bookmarks.osdCleared': 'All bookmarks deleted',
      'nav-bookmarks.osdDuplicate': 'A bookmark is already here',
      'nav-bookmarks.osdFull': 'At most {max} bookmarks per file',
      'nav-bookmarks.osdNoNext': 'No later bookmark',
      'nav-bookmarks.osdNoPrev': 'No earlier bookmark',
      'nav-bookmarks.osdSectionSaved': 'Range saved: {title}',
      'nav-bookmarks.osdNoLoop': 'No A-B range is set',
      'nav-bookmarks.osdLoopA': 'A set {time}',
      'nav-bookmarks.osdLoopB': 'B set {time}',
      'nav-bookmarks.osdLoopAB': 'Loop {a} – {b}',
      'nav-bookmarks.osdLoopCleared': 'A-B repeat off',
      'nav-bookmarks.osdNoSubtitle': 'No subtitle here',
      'nav-bookmarks.osdExported': 'Bookmarks exported',
      'nav-bookmarks.osdExportFailed': 'Could not write the bookmark file',
      'nav-bookmarks.osdNothingToExport': 'Nothing to export',
      'nav-bookmarks.osdImported': 'Imported {n} bookmarks',
      'nav-bookmarks.osdImportFailed': 'Could not read that file',
      'nav-bookmarks.osdImportEmpty': 'No bookmarks found in that file'
    })
  },

  dispose(): void {
    if (pauseTimer) clearTimeout(pauseTimer)
    pauseTimer = null
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * N18. `['add','ab-loop-a',0.1]` is the literal mapping and it ERRORS when the
 * property holds `"no"`, so the mirrored value is checked first and an unset
 * endpoint no-ops. Nudging A re-seeks to it, because the point of a 0.1 s nudge
 * is hearing whether you got it right.
 */
async function nudge(which: 'a' | 'b', delta: number): Promise<void> {
  const currentValue = which === 'a' ? loop.a : effectiveB()
  const next = nudgePoint(currentValue, delta)
  if (next === null) return
  if (which === 'b' && pauseAtB()) {
    // N23's B never reaches mpv, so there is nothing to `add` to.
    softB = next
  } else if (Math.abs(next - ((currentValue as number) + delta)) > 1e-9) {
    // The nudge was clamped at 0. `add` would take the property negative, so
    // the clamped value goes in as an absolute write instead.
    await writePoint(which, next)
    if (which === 'a') loop.a = next
    else loop.b = next
  } else {
    await ctx.mpv.command(['add', `ab-loop-${which}`, delta]).catch(async () => {
      // The property can drift from the mirror (a file switch, a foreign
      // write); an absolute set still lands the value the user asked for.
      await writePoint(which, next)
    })
    if (which === 'a') loop.a = next
    else loop.b = next
  }
  push()
  ctx.osd.show({
    kind: 'abloop',
    text: ctx.i18n.t(which === 'a' ? 'nav-bookmarks.osdLoopA' : 'nav-bookmarks.osdLoopB', {
      time: formatPrecise(next)
    })
  })
  if (which === 'a') await seekTo(next)
}

export default mod
