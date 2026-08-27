# 02 — The Wave 0 API: a module author's guide

> **Status:** authoritative for anyone writing a feature module.
> You should be able to build your module from this file plus your row in
> `00-parity-spec.md` §2, and never open a core file. If you find yourself
> reading `src/main/core/**`, that is a bug in this document — say so.
>
> **The one rule everything else follows from:** adding a feature means adding
> a **directory**. If you are about to edit `src/shared/types.ts`,
> `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/core/**`,
> `src/main/mpv/manager.ts` or `src/main/core/window/windows.ts` — stop. The API
> below exists so you do not have to, and CI greps for several of them.
>
> Last updated: 2026-08-28 (end of Wave 0)

---

## 0. The sixty-second version

```
src/main/features/<your-id>/index.ts        default-exports a FeatureModule
src/renderer/src/features/<your-id>/index.ts  optional; same id
```

```ts
import type { FeatureContext, FeatureModule } from '@shared/feature-api'

let ctx: FeatureContext

const mod: FeatureModule = {
  id: 'video-color',                       // MUST equal the directory name
  ownsProperties: ['brightness', 'contrast', 'saturation', 'hue', 'gamma'],
  usesVideoFilters: true,                  // grants ctx.vf
  ownsFilterLabels: ['rl-levels'],

  setup(c) {
    ctx = c
    ctx.commands.register([...])
    ctx.settings.define([...])
    ctx.i18n.register('ko', { 'video-color.brightness': '밝기' })
  },

  dispose() { /* timers, watchers, child processes */ }
}

export default mod
```

That is the whole contract. The registry finds the directory with
`import.meta.glob`, checks your id against it, folds your property claims into
the owner map, sets you up in dependency order, and hands you a
`FeatureContext`. Nothing about your module is written down anywhere else.

**Run `npm run verify` before you push.** It is typecheck + 109 tests +
the natural-sort differential + the forbidden-pattern grep.

---

## 1. `FeatureModule` — what you declare

| Field | Meaning |
|---|---|
| `id` | kebab-case, equals the directory name. Boot error naming both if not. |
| `dependsOn?` | Other module ids that must be set up first. A cycle is a boot error **naming the cycle**. |
| `ownsProperties?` | Every mpv property you may **write**. §2 below. |
| `requestsProperties?` | Properties you reach through `ctx.mpv.requestSet()`. Declared so the dependency is visible in review. |
| `ownsFilterLabels?` | Reserved vf/af labels (§5). Same duplicate detection. |
| `usesVideoFilters?` / `usesAudioFilters?` | Grants `ctx.vf` / `ctx.af`. Without the flag the field is `undefined`. |
| `setup(ctx)` | Called once, in dependency order, before the first window is shown. May be async. |
| `dispose?()` | Called on quit. |

**Isolation, and its deliberate asymmetry.** A *collision* — duplicate property,
duplicate command id, duplicate IPC channel, a namespace violation, a spawn-arg
clash, a dependency cycle — throws out of the registry's try/catch and **the app
refuses to start**, because it is a programming error CI must catch. A *runtime*
failure inside your `setup()` disables your module only: it logs loudly, shows
one toast, and the app starts. One broken feature must never black-screen the
player.

---

## 2. mpv property ownership — the part that will actually stop you

This is the mechanism that makes forty people working in parallel real rather
than hoped-for. Two enforcement points, both code:

**At boot.** The registry folds every `ownsProperties` array (plus core's own)
into one `Map<property, moduleId>`. Two modules claiming the same property — or
a glob overlapping another claim — throws, naming **both modules and the
property**, and the app does not start:

```
mpv property ownership collision: 'aid' (audio-tracks) overlaps 'aid' (audio-devices).
Exactly one module may write a property (§3.7). Pick an owner and give the other
a mediator command, then update docs/parity/modules.json.
```

**At every call.** `ctx.mpv.set()` and the property-writing commands
(`set_property`, `set`, `cycle`, `add`, `multiply`, `cycle-values`,
`change-list`) consult that map:

```
OwnershipError: audio-loudness may not write 'aid' (owned by audio-tracks).
Use ctx.mpv.requestSet('aid', value, reason) or the owner's mediator command.
```

In dev this throws. In a packaged build it is logged, dropped and counted, so a
misbehaving module cannot corrupt another's state *and* cannot black-screen the
player.

**Reads are unrestricted.** `observe`, `peek` and `get` never check ownership.

**Globs.** A single **trailing** `*` is allowed (`'screenshot-*'`). A bare `'*'`
and an interior `'sub-*-size'` are both boot errors.

**Core owns some properties too.** `core/mpv/bus` owns `pause`, `keep-open`,
`idle`, `force-window`, `msg-level` and `input-*` — the transport and the
process itself. `core/vf-chain` owns `vf`; `core/af-chain` owns `af`. That is
why "start playing" is `ctx.commands.invoke('core.play')` and not
`ctx.mpv.set('pause', false)`.

**`docs/parity/modules.json` is the same map in machine-readable form**, and
`npm test` compares them **in both directions** for every implemented module. If
you add a property, add it there too; if you do not, the test tells you which
one and where.

### Getting at a property you do not own

Two sanctioned paths, and no third:

**1. The owner's mediator command.** These are ordinary `CommandDescriptor`s
with `internal: true`, so they appear in a stack trace with a name:

| Command | Owner | For |
|---|---|---|
| `audio-tracks.reinitDecoder` | M11 | forcing a decoder reinit (A20 passthrough, A36 AC-3 DRC) without racing M11's per-file restore |
| `audio-tracks.selectStreamFormat({vid, aid})` | M11 | R08's yt-dlp format switch — `vid` and `aid` are one decision |
| `subs-tracks.reload({sid?})` | M17 | debounced `sub-reload`, no-op for embedded tracks, re-applies `sid` after |
| `video-geometry.setFitMode(mode)` | M02 | the only way to move `keepaspect`/`panscan`; also resets zoom/pan, which V23 requires |
| `playlist.openPaths(paths)` | M28 | the single entry point for "play these files" |
| `playlist.seriesPrefix(path)` | M28 | the shared episode-prefix computation (L50/N51) |
| `core.play` / `core.pause` / `core.playPause` | core | the transport |

```ts
await ctx.commands.invoke('audio-tracks.reinitDecoder', { reason: 'spdif toggle' })
const prefix = await ctx.commands.query<string>('playlist.seriesPrefix', file)
```

**2. `ctx.mpv.requestSet()`**, for a value the owner arbitrates:

```ts
const r = await ctx.mpv.requestSet('aid', 2, 'user picked a track in my panel')
if (!r.ok) ctx.log.warn('refused:', r.reason)   // refusal is a NORMAL outcome
```

`requestSet` refuses with `'no-arbiter'` rather than falling through to a raw
write, so a missing arbiter is visible instead of silently racing. If **you** own
a property others need, register the arbiter once in `setup()`:

```ts
ctx.mpv.arbitrate('aid', async (value, req) => {
  if (busyRestoring) return { ok: false, reason: 'per-file restore in progress' }
  await ctx.mpv.set('aid', value)
  return { ok: true }
})
```

**Adding a mediator is a one-line PR against the owner's module plus a row in
the table above.** Cheap, visible, reviewable — that is the whole point.

---

## 3. `ctx.mpv` — the only way to talk to mpv

```ts
observe<T>(name, cb): Unsubscribe   // refcounted; ONE observe_property on the wire
peek<T>(name): T | undefined        // last value seen; undefined is legitimate
get<T>(name): Promise<T>
set(name, value): Promise<void>     // ownership-checked
requestSet(name, value, reason)     // mediated
arbitrate(name, fn)                 // owners only
command<T>(args): Promise<T>        // ownership-checked; raw vf/af refused
commandNoReply(args): void          // drag-scrub only
onEvent(event, cb): Unsubscribe
afterFileLoaded(cb): Unsubscribe
contributeArgs(priority, fn): void
requestRestart(reason): void
readonly isNetworkSource: boolean
```

**`observe` is refcounted.** Ten modules observing `time-pos` produce exactly one
`observe_property` on the pipe. It fires immediately with the cached value, so a
module that registers late is not blind until the next change.

**`undefined` is a real value.** mpv reports "property unavailable" for
`editions` on MP4, `current-ao` with no AO, and others. The bus passes it
through and never coerces it to `0` or `''`. Guard for it.

**`afterFileLoaded`, never `file-loaded`.** The verified event order is
`start-file` → `file-loaded` → seek → `playback-restart`, and a property write
made at `file-loaded` can be **dropped outright** or produce a visible frame-0
flash. `afterFileLoaded` fires after `playback-restart`, once per newly loaded
file (not on every seek). **Every per-file restore uses it.**

**`requestRestart(reason)`** is debounced, shows one toast, respawns mpv,
re-embeds via `--wid` and restores the position. Use it for VO and
exclusive-mode changes — anything mpv cannot do in place. Do not use it for
anything a property write can achieve.

### Traps that were measured, not guessed

1. **`loadfile` with an options map needs `-1`.** `['loadfile', p, 'replace', -1, {start: '5.5'}]`. Without the `-1` it **hard-errors** with `{"error":"invalid parameter"}` — it does not silently drop the map.
2. **`frame-step` replies before it moves.** Drive the UI from the `time-pos` observer, never from the reply.
3. **`screenshot` returns a BARE RELATIVE FILENAME** unless `screenshot-directory` is set first. Assert `path.isAbsolute` on the reply.
4. **`screenshot` with `scaled` or `window` fails when there is no window-backed VO** (audio-only with the video window hidden, tray-only mode). `video` succeeds in both.
5. **`screenshot-raw` kills mpv over JSON IPC.** Never.
6. **Clearing an A-B point yields the string `"no"`**, not a number.
7. **`editions` is `undefined`, not `0`,** on non-Matroska files.
8. **A Windows absolute path cannot appear inside a lavfi option.** Stage assets into `ctx.paths.tempJobDir(id)` and spawn with `cwd` set, using bare relative filenames.
9. **DIP vs device pixels.** Electron geometry is DIP; `video-out-params/dw|dh` are real pixels. `ctx.window` does the conversion — do not do it yourself. (`dw`/`dh` **do** account for `video-rotate`; no swap logic is needed anywhere.)

---

## 4. Spawn arguments

```ts
ctx.mpv.contributeArgs(10, () => [`--hwdec=${ctx.settings.get('video-decode.hwdec')}`])
```

Called before every spawn and respawn. Priority `1..999` (core reserves 0 and
1000). Three boot checks, all of which name names:

**Core-reserved.** `--wid`, `--input-ipc-server`, `--no-config`, `--config*`,
`--input-*`, `--osc`, `--osd-*`, `--vo`, `--gpu-context`, `--idle`,
`--force-window`, `--keep-open`, `--terminal`, `--msg-level`, `--load-scripts`,
`--include`, `--drag-and-drop`, `--ytdl`. Contributing one throws.

**Inert under `--wid`.** These twenty-six are accepted by mpv, report success and
**do nothing**, because with `--wid` mpv does not own a window. Contributing one
throws with the Electron replacement named:

```
--border --title-bar --show-in-taskbar --fullscreen --fs --fs-screen
--fs-screen-name --ontop --ontop-level --snap-window --window-minimized
--window-maximized --window-affinity --window-corners --window-scale --geometry
--autofit --autofit-larger --autofit-smaller --keepaspect-window --title
--cursor-autohide --input-cursor --hidpi-window-scale --native-touch
--taskbar-progress
```

Everything on that list is `ctx.window` work (§8).

**Duplicates across contributors.** Two modules contributing the same option
name throw, whatever the values — not just when core owns it. This is the
V33/V36 case: `--d3d11-output-format=rgba16f` (M05) and `=rgb10_a2` (M06), both
P1, mutually exclusive, silent last-one-wins. The only exemption is mpv's
genuinely additive `*-append` family (`--script-opts-append`,
`--sub-auto-exts-append`, `--sub-file-paths-append`, `--ytdl-raw-options-append`,
and a few more; the list is explicit, and nothing else is exempt).

**An option follows its property's owner.** If you do not own
`d3d11-output-format`, you may not contribute `--d3d11-output-format`.

---

## 5. `ctx.vf` / `ctx.af` — the filter chains

Declare `usesVideoFilters` / `usesAudioFilters` and `ownsFilterLabels`, then:

```ts
ctx.vf.set('rl-sharpen', 'lavfi=[cas=strength=0.4]')   // spec WITHOUT the label
ctx.vf.toggle('rl-sharpen', false)                      // disables IN PLACE
ctx.vf.remove('rl-sharpen')
const { path } = await ctx.vf.command('rl-sharpen', 'strength', '0.55', 'cas')
```

- **You never issue a raw `vf`/`af` command.** The ownership map refuses it for
  every feature module. Two modules fighting over the chain is the single most
  likely way to silently destroy each other's work.
- **Ordering is enforced, not advisory.** The chain is emitted in the §5.5
  policy order regardless of the order you registered in.
  vf: `deint → dv → 3d/360 → cropdetect → denoise/deblock → colour → sharpen/soften → mblur → mi → vsr → truehdr → lut → rotate → hflip/vflip`.
  af: `rlch → rleq/rlpre/rltone/rlfeq → rlfx/rlcry/rlnr → rldlg → rlnorm/rlnight → rltempo → rlac3 → rlboost` — **boost and limiter last, always**.
- **Changes before `file-loaded` are queued.** mpv cannot validate a filter
  before the first frame and may leave a broken chain.
- **`toggle(label, false)` disables in place** (`@label:!spec`), so your settings
  survive a toggle.
- **`command()` emits the VERIFIED FOUR-ARGUMENT form**
  `['vf-command', label, option, value, lavfiFilterName]` — the last argument is
  the libavfilter **filter name**, not the label and not `'all'`. The
  three-argument form fails on both sides.
- **The refuser table lives in the chain, not in your module.** `unsharp`
  refuses `vf-command`; `superequalizer`, `pan` and `loudnorm` refuse
  `af-command`. `command()` transparently rebuilds for those and reports
  `{path: 'rebuild'}`, so you can choose commit-on-release instead of a live
  slider **without hardcoding the table**.
- **`hasCpuFilter`** tells the stats overlay that hwdec frames are being copied
  back to system memory. Every lavfi filter does that.

Reserved labels (unregistered ones throw at boot):

```
vf: rl-levels rl-autolevel rl-cshift rl-sharpen rl-soften rl-denoise rl-tdenoise
    rl-gdenoise rl-deblock rl-mblur rl-deint rl-hflip rl-vflip rl-rotate rl-3d
    rl-360 rl-vsr rl-dv rl-lut rl-cropdetect rl-mi rl-truehdr
af: rlch rleq rlpre rlfx rldlg rlnorm rlnight rlcry rlnr rltone rlac3 rltempo
    rlfeq rlboost
```

---

## 6. Commands and keybinds

```ts
ctx.commands.register([
  {
    id: 'capture-still.save',              // MUST start with `${ctx.id}.`
    labelKey: 'capture-still.save',
    category: 'capture',
    scope: 'player',                        // default; also 'playlist'|'settings'|'global'
    defaults: {
      default: ['KeyS'],
      potplayer: ['KeyS'],
      mpv: ['KeyS']
    },
    enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
    run: () => saveScreenshot()
  }
])
```

**There is no preset table anywhere.** All three presets are the **fold** of
every registered command's `defaults`. A module that ships a command ships its
Default/PotPlayer/mpv bindings with it, and all three presets grow without
anyone editing a shared file.

**Accelerators are PHYSICAL.** `'KeyS'`, `'Digit1'`, `'BracketLeft'`,
`'ArrowRight'`, `'Space'`, `'Comma'`, with modifiers in the fixed order
`Ctrl+Alt+Shift`. Never `'S'` or `'s'`. This is P16: with the Korean IME
composing, `e.key` is `'Process'` for every letter, so a `key`-based binding
silently stops working the moment someone switches to 한글. Mouse and wheel share
the namespace using **mpv's own names**: `MBTN_LEFT`, `MBTN_RIGHT_DBL`,
`WHEEL_UP`, `Ctrl+WHEEL_DOWN`.

**One accel per step, not one command with an argument.** A binding carries no
argument, so `seek +5` and `seek +60` are two commands (`nav-seek.forward5`,
`nav-seek.forward60`). That is what lets the mpv preset put `ArrowUp` on ±60s
while Default puts it on volume.

**`internal: true`** hides a command from the keybind editor and the cheat sheet.
Use it for mediators and for the arg-driven entry points the legacy bridge and
your own IPC call.

**`run()` may return a value**, which `ctx.commands.query<T>()` retrieves. Use it
only for mediators that genuinely compute something (`playlist.seriesPrefix`).

Conflicts are detected scope-aware and **reported, not resolved** — a conflict
the user created deliberately is their business, but they must be told.

---

## 7. Settings

```ts
ctx.settings.define([
  {
    id: 'video-color.brightness',           // MUST start with `${ctx.id}.`
    section: 'video',                        // one of the EIGHT fixed sections
    group: 'colour',
    labelKey: 'video-color.brightness',
    type: { kind: 'int', min: -100, max: 100, step: 1 },
    default: 0,
    mpvOption: 'brightness',                 // indexed for search and the tooltip
    keywords: ['밝기', 'brightness'],
    advanced: false,
    order: 10
  }
])

const v = ctx.settings.get<number>('video-color.brightness')
ctx.settings.set('video-color.brightness', 20)
ctx.settings.onChange<number>('video-color.brightness', (v) => applyBrightness(v))
```

Sections are fixed: `general playback video audio subtitles keys filetypes
advanced`. **New sections are not allowed** — a settings window with forty
module-shaped tabs is the thing this design exists to prevent.

**Only values that differ from the default are stored** (P51). That is what makes
a later default change still reach users who never touched the setting; it also
means `get()` on an untouched id returns the descriptor's `default`, not
`undefined`.

The store underneath gives you, for free: atomic write with **fsync** (P11),
unknown-key preservation across versions (P10), a read-only downgrade guard
(P09), corrupt-file quarantine to `<file>.corrupt.<ts>` (P12), and a
`<file>.bak.v<old>` copy before any migration (P08).

The settings UI (M38) is generated from your descriptors. It does not know your
module exists.

---

## 8. `ctx.window` — every window operation

`src/main/core/window/windows.ts` is **not importable by a feature module**, and
CI greps for it the same way it greps for `UserChoice`. Everything is here:

```ts
isFullScreen() / setFullScreen(on) / toggleFullScreen()
setFullScreenOnDisplay(id)      // moves FIRST, then goes fullscreen; restores
                                //  the PRE-fullscreen bounds
onFullScreenChange(cb)

setAlwaysOnTop('never'|'always'|'while-playing'|'fullscreen-only')
getAlwaysOnTop()

getContentSize() / setContentSize(w, h, {anchor})     // DIP, always
getBounds() / setBounds(rect, {clamp})
setAspectRatio(ratio, extraSize) / center()
maximize() / unmaximize() / isMaximized() / minimize() / restore()
showInactive()                  // U41 — never steals focus
focusInput()                    // focus goes to the OVERLAY; it sees the input
beginDrag('move'|'resize', edge) / endDrag() / close()

displays() / currentDisplay() / persistBounds() / restoreBounds() / onDisplayChange(cb)
enterMiniPlayer({width, corner}) / exitMiniPlayer() / isMiniPlayer()
setChrome('full'|'minimal'|'none')
readonly layoutMode: 'overlay' | 'compat'
onVideoRegionChange(cb)
taskbar?                        // granted ONLY to shell-taskbar, by module id
blockSleep('display'|'app-suspension', reason): { release() }
```

Three things the service does so you never have to:

- **`setAlwaysOnTop` sets BOTH windows with the correct relative levels** — main
  `'floating'`, overlay `'pop-up-menu'`. On Windows `'floating'`…`'status'` sit
  *below* the taskbar and `'pop-up-menu'` and above sit *above* it; getting the
  pair wrong is how the overlay ends up underneath the video. Modules never
  choose the level.
- **Geometry is DIP.** `video-out-params/dw|dh` are real pixels; the conversion
  is made once, inside the service.
- **`setContentSize` releases and restores the aspect lock** around the
  programmatic resize, because Electron does not respect the lock for
  `setSize`.

**`blockSleep` is refcounted** and released automatically on `dispose()`. Anyone
may state a requirement; M33 owns the policy.

**`enterMiniPlayer` mutates the existing window** — no new window, no mpv
respawn, so `--wid` embedding is untouched. Bounds, aspect, ontop level, minimum
size and chrome are saved and restored as one unit.

---

## 9. `ctx.perFile` — per-file state

```ts
ctx.perFile.slice({
  key: 'subs-sync',
  capture: () => ({ subDelay: ctx.mpv.peek<number>('sub-delay') ?? 0 }),
  apply: async (v) => {
    if (typeof v.subDelay === 'number') await ctx.mpv.set('sub-delay', v.subDelay)
  },
  rememberDefaults: { subDelay: true }      // P50 defaults; speed is default-OFF
})
```

- `capture()` runs on file close/switch; `apply()` runs **after
  `playback-restart`**, in registration order, and each slice's failures are
  isolated.
- **Baseline diffing (P51).** The service snapshots each slice at file-load
  *before* applying anything, and persists only keys that differ from that
  baseline. A value you restored is written back; a value nobody touched is not.
- **`vf` and `af` are never remembered**, whatever a slice reports. mpv's
  `--watch-later-options` default includes them, and restoring a raw filter
  string would overwrite whatever the chain owner believes the chain to be.
- Two stores, deliberately: `resume.json` **deletes** an entry once the file is
  finished, so a stale position is never offered back; `history.json` **keeps**
  it with `finished: true` so the history panel can show a checkmark.

Also on the service: `currentKey()`, `currentPath()`, `forget(file)`,
`resumeFor(file)`, `recordPosition(file, pos, dur)`, `captureNow()`, and
`lookupMany(paths)` for the playlist's watched badges.

---

## 10. `ctx.ipc` and the renderer half

**Main side.** Channels are `${ctx.id}:${verb}` — enforced, duplicates throw at
boot:

```ts
ctx.ipc.handle<Req, Res>('capture-still:list', async (req) => [...])
ctx.ipc.on<{ index: number }>('nav-chapters:goto', (req) => …)
ctx.ipc.send('playlist:state', payload)          // to the overlay
```

**Renderer side.** `src/renderer/src/features/<same-id>/index.ts`, found by the
renderer's own glob:

```ts
import type { RendererFeatureModule } from '@shared/renderer-api'

const mod: RendererFeatureModule = {
  id: 'nav-chapters',
  setup(ctx) {
    ctx.ipc.send('nav-chapters:goto', { index: 3 })
    ctx.state.subscribe((s) => redraw(s))
    ctx.seekbarLayer({ ... })
  }
}
export default mod
```

**Nobody edits `src/preload/index.ts` again.** It exposes one generic
`window.rl` bridge with a channel shape check, plus the typed `window.rlplayer`
core surface that feature modules do **not** extend. `contextIsolation` is on,
`nodeIntegration` is off, and raw `ipcRenderer` is never exposed. The regex in
the preload is a shape check, not the security boundary: main only has a handler
for channels a module actually registered under its own id.

The renderer context also gives you `panel()`, `statsSection()`,
`settingsSection()`, `settingsComponent()` and `osd.show()`.

### The interactive seek-bar layer

```ts
ctx.seekbarLayer({
  id: 'nav-bookmarks.abloop',
  order: 20,                                    // paint order low→high
  render: (c) => drawRegion(c),

  // Interaction is OPT-IN: no hitTest means no pointer events at all.
  hitTest: (c) =>
    Math.abs(c.x - c.timeToX(a)) <= c.tolerancePx ? 'a'
  : Math.abs(c.x - c.timeToX(b)) <= c.tolerancePx ? 'b' : null,

  onPointerMove: (e) => preview(e.handle, e.time),      // no mpv write yet
  onPointerUp:   (e) => { if (!e.cancelled) ctx.ipc.send('nav-bookmarks:setLoopPoint',
                                                          { which: e.handle, t: e.time }) },
  onHover:   (e) => showTip(e?.handle ?? null),          // hit-test independent
  tooltip:   (e) => ({ el: node, order: 20 }),           // merged into ONE tooltip
  onKey:     (e) => nudge(e.handle, e.key === 'ArrowLeft' ? -e.stepSec : e.stepSec)
})
```

Four guarantees:

1. **Hit-testing runs in reverse paint order** — the visually topmost layer is
   offered the pointer first. Returning `null` passes it down, and finally to the
   host's own scrub, which is therefore never stolen by accident.
2. **Exactly one `onPointerUp` per `onPointerDown`**, including on
   `pointercancel`, window blur and Esc, where it arrives with
   `cancelled: true`.
3. **`tolerancePx` defaults to 6** — it is the only reason a 2 px pin is
   grabbable.
4. **Keyboard equivalence is mandatory** for an interactive layer. A bar you can
   only drag is a bar some people cannot use.

`ctx.duration` is `0` for live streams — guard for it; `timeToX`/`xToTime`
already do.

**The ownership rule holds on both halves.** A renderer layer never writes an
mpv property. It sends to its own main half, which owns the property.

---

## 11. OSD, toasts, dialogs, menus, i18n

```ts
ctx.osd.show({ kind: 'volume', text: '85%', value: 0.85 })
ctx.osd.toast({ kind: 'info', message: '저장됨', actionLabel: '폴더 열기', onAction: () => … })
const job = ctx.osd.progress({ id: 'encode-1', labelKey: 'capture-encode.job', cancellable: true })
job.update({ fraction: 0.4 }); if (job.cancelled) abort(); job.done()
```

**Every state-changing command fires an OSD message.** That is a product rule,
not a suggestion. `show()` coalesces by `kind`, so dragging a slider produces one
updating readout rather than forty stacked ones, and the per-kind enable/disable
from config is applied **in the service** — you never check whether your OSD is
wanted. The overlay owns 100% of the OSD; mpv's `show-text` is a debugging
fallback and mixing the two looks broken.

```ts
const files = await ctx.dialog.openFiles({ titleKey: 'x.open', multi: true, filters: [...] })
const dir   = await ctx.dialog.openDirectory({ titleKey: 'x.folder' })
const out   = await ctx.dialog.saveFile({ titleKey: 'x.save', defaultPath })
const yes   = await ctx.dialog.confirm({ titleKey, messageKey, confirmKey, destructive: true })
```

Never import Electron's `dialog` directly: the service parents the dialog to the
**overlay**, and parenting to the video window puts it *behind* the video.

```ts
ctx.menu.contribute({
  id: 'video-geometry.menu',
  labelKey: 'video-geometry.menuTitle',
  order: 50,
  items: [
    { commandId: 'video-geometry.rotateCw' },
    { type: 'separator' },
    { labelKey: 'video-geometry.aspectTitle', submenu: [
        { dynamic: () => aspects.map((a) => ({ label: a.name, commandId: 'video-geometry.setAspect',
                                               arg: a.value, radio: true, checked: current === a.value })) }
      ] }
  ]
})
```

```ts
ctx.i18n.register('ko', { 'video-color.brightness': '밝기' })   // keys must be namespaced
ctx.i18n.t('subs-tracks.added', { name })
```

For a sentence with an interpolated filename, use the 조사 helper rather than
producing "파일를": write the catalog string as `{name}{을/를} 찾을 수 없습니다`
and `t()` picks the particle from the preceding word's final consonant.

---

## 12. Paths and lifecycle

```ts
ctx.paths.dataDir() / cacheDir() / subCacheDir() / thumbCacheDir() /
          sceneCacheDir() / logsDir() / tempJobDir(jobId)
ctx.paths.isPortable() / ctx.paths.portableFallback
ctx.lifecycle.onReady(cb) / onQuit(cb) / trackProcess(child)
```

`tempJobDir(jobId)` exists because **a Windows absolute path cannot appear
inside a lavfi option**. Stage your font/palette there and spawn with `cwd` set.

`trackProcess` registers a child so the registry kills it on quit or crash —
even if your `dispose()` throws. An orphaned encoder holding a file handle is
worse than a noisy log line.

---

## 13. Testing your module

- Put `node:test` files next to the code as `*.test.ts`; `npm test` globs
  `src/**/*.test.ts`.
- Node runs TypeScript by **stripping** it. That means: no `enum`, no
  `namespace`, no **parameter properties** (`constructor(private x: T)`) — declare
  the field and assign it. Type-only imports must be written `import type`, and
  runtime imports inside tested files must be **relative with a `.ts`
  extension**, because Node knows nothing about the `@shared` alias.
- Keep the logic you want to test free of Electron imports. Every core piece
  that has a test does this, which is why the suites exercise the real
  implementation rather than a copy of it.
- Your §6.3 acceptance row is the bar. "It compiles" is not acceptance.

---

## 14. Where Wave 0 deviated from the spec, and why

Six places where the design did not survive contact with the code. All are
implemented as described here, and this list is the authority.

| # | Spec said | What shipped | Why |
|---|---|---|---|
| 1 | `MenuService.contribute({ items: Array<{commandId} \| {separator}> })` | plus a `{ dynamic(): MenuNode[] }` node and label/checked/radio/arg fields | A track list, a chapter list and an aspect radio group cannot be a fixed array of command ids, and every one of the legacy menu's groups is one of those. |
| 2 | `CommandService.invoke(): Promise<void>` | plus `query<T>()`, and `run()` may return a value | §3.7.3 sanctions `playlist.seriesPrefix(path)` as a mediator, and a mediator that *computes* a value cannot be expressed by a `run()` typed `void`. The alternative was M25 re-deriving the prefix, which is the duplication L50 exists to prevent. |
| 3 | `PerFileService` = `slice / currentKey / forget` | plus `resumeFor()`, `recordPosition()`, `captureNow()`, `currentPath()` | The declared service had no way to **read** a resume position, yet M28 needs one at `loadfile` time and M30 needs one for continue-watching. Both would have re-implemented `resume.json`. `captureNow()` exists because mpv's `end-file` arrives with some properties already reset, so the module about to issue `loadfile` has to be able to say "capture first". |
| 4 | §3.4 interfaces live in `shared/feature-api.ts` | renderer-side interfaces live in `shared/renderer-api.ts` | They mention `HTMLElement`, and `feature-api.ts` is compiled under the main tsconfig, which carries no DOM lib. `tsconfig.node.json` excludes the renderer file. |
| 5 | §5.3 puts `--cursor-autohide=no` and `--taskbar-progress=no` in the base set; §7.5 lists both as inert under `--wid` | core may contribute them; a **feature module** contributing any inert flag still throws | Both statements are in the spec. Setting them from core is harmless belt-and-braces; the check that matters is the one that stops a module from using a dead flag *instead of* `ctx.window`. |
| 6 | `test:legacy-shim` "fails the build once every one of the 22 has an owner" | it asserts the table only ever **shrinks**; the build-failing half is gated on the renderer being repointed | Wave 0 itself gave all 22 an owner, because it migrated the modules that claim them — while the renderer's buttons and sliders still speak the legacy `PlayerAction` vocabulary. As written the deadline would fire on day one and delete a shim that is still load-bearing. The honest expiry is "all 22 owned **and** no renderer call site left"; the shrink-only assertion holds meanwhile. |

Two smaller notes:

- **`--volume-max` is 150, not the 100 §5.3 asks for.** v0.1 shipped a 0–150
  slider and dropping it to 100 is a regression a user notices immediately. A06
  moves all boost into the af chain and drops it to 100; that is M10's Wave-1
  work, and the property is M10's to change.
- **`--vo` and `--gpu-context` are core-reserved *args* while the `vo`
  *property* is M07's.** The two-window `--wid` embedding depends on the spawn
  values. Changing the VO is restart-scoped: write the setting, then
  `ctx.mpv.requestRestart()`.

---

## 15. Checklist before you open a PR

- [ ] Directory name equals `id`.
- [ ] Every property you write is in `ownsProperties` **and** in
      `docs/parity/modules.json`. `npm test` checks both directions.
- [ ] Every property you write that you do **not** own goes through a mediator
      or `requestSet`, and is listed in `requestsProperties`.
- [ ] Settings, commands, IPC channels and i18n keys are all prefixed with your
      id.
- [ ] Keybind defaults use **physical** codes for all three presets.
- [ ] Every state-changing command fires an OSD message.
- [ ] Per-file state goes through a slice, never through your own JSON file.
- [ ] No import of `windows.ts`, `ipc.ts`, `preload/index.ts`, another feature
      module, or Electron's `dialog`. `npm run check:forbidden` proves it.
- [ ] Your `dispose()` releases timers, watchers, sleep blockers and child
      processes.
- [ ] `npm run verify` is green, and your §6.3 acceptance row is ticked in your
      module's `VERIFY.md`.
