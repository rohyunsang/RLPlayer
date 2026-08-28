# 02 — The Wave 0 API: a module author's guide

> **Status:** authoritative for anyone writing a feature module.
> You should be able to build your module from this file plus your row in
> `00-parity-spec.md` §2, and never open a core file. If you find yourself
> reading `src/main/core/**`, that is a bug in this document — say so.
>
> **The one rule everything else follows from:** adding a feature means adding
> a **directory**. If you are about to edit any of these — stop:
>
> ```
> src/shared/types.ts          src/shared/keybinds.ts      src/shared/media-types.ts
> src/main/ipc.ts              src/main/index.ts           src/main/core/**
> src/main/mpv/**              src/preload/index.ts
> src/renderer/index.html      src/renderer/settings.html  src/renderer/src/main.ts
> src/renderer/src/settings.ts src/renderer/src/styles.css src/renderer/src/core/**
> ```
>
> The API below exists so you do not have to — and it is no longer only a grep
> that stops you. `core/mpv/bus.ts` **exports no bus**. It exports
> `createMpvBus()`, which throws on a second call, and `src/main/index.ts` makes
> the one. So `await import('../../core/mpv/bus.ts')` from a module gets a
> factory that refuses instead of a singleton with a public `createService()`;
> the service you hold is minted for you by the registry with **your** id baked
> in, and asking for `{ privileged: true }` under any id but core's throws.
>
> `npm run check:forbidden` no longer scans LINES — it lexes the file, so a
> multi-line `await import()`, a `createRequire(import.meta.url)(…)` and a
> multi-line computed specifier all fail, and none of the three did before — and
> `npm run check:partition` **fails the build if any tracked file under `src/`
> is not owned by exactly one row of `modules.json`**, and now also if a
> feature's private symbol — a CSS selector **or an HTML element id** — is
> sitting in a core file.
>
> The renderer files are on that list for the first time, and that is the
> headline change: `ctx.panel()`, `ctx.statsSection()`, `ctx.settingsSection()`
> and `ctx.settingsComponent()` had **no consumers at all** until now, so a
> module with any UI had no choice but to edit `index.html`, `main.ts` and
> `styles.css`. They render now (§10, §7), and `ctx.transportButton()` joins
> them so the transport bar's button row stops being a shared file too.
>
> Last updated: 2026-08-28 (third repair round)

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

**Run `npm run verify` before you push.** It is typecheck + ~240 tests + the
natural-sort differential (27,225 pairs against the real `StrCmpLogicalW`) + the
forbidden-pattern check (a comment- and string-aware lexer now, not a line
scanner — three multi-line escalations walked past the old one) + the
file-partition check (content-granular for CSS, **HTML and TS**). CI runs all of
it on every push, plus `check:network` against a freshly PACKAGED build.

Three things need a desktop session and a build, so run them before you tag:

```
npm run build && npx electron-builder --win --dir
npm run e2e:overlay -- --packaged --presses=300   # §6.3's soak: 0 console errors
npm run e2e:resume                    # seek, quit, reopen — the v0.1 resume guarantee
npm run check:network                 # packaged cold launches, asserting on Chromium's netlog
npm run check:network -- --no-blackhole  # the same, with the DNS seatbelt REMOVED
```

The last one is the only run that proves the leak is gone rather than merely
blackholed, and it is the run whose evidence used to be worthless: 7 of 36
observed netlogs were header-only — zero events, which is also the shape of a
perfectly clean session — and 2 of those exited reporting success. A pass now
needs a minimum event count, two netlog event types that only a real session
writes, and three stdout markers from the app itself; and every launch opens the
**settings window**, the one page with text inputs, which is the surface the
0.1.0 leak was on and which this check had never once exercised.

Use `--packaged` for anything you intend to call evidence. The dev build and the
packaged build do not behave the same, and the previous round's "0 outbound
connections over 5 launches" was measured on the dev build while the packaged
one was completing a download to Google.

---

## 1. `FeatureModule` — what you declare

| Field | Meaning |
|---|---|
| `id` | kebab-case, equals the directory name. Boot error naming both if not. |
| `dependsOn?` | Other module ids that must be set up first. A cycle is a boot error **naming the cycle**. |
| `ownsProperties?` | Every mpv property you may **write**. §2 below. |
| `ownsCommands?` | Every mpv **command** only you may issue. Same syntax, same duplicate check, same runtime guard. §2.1. |
| `requestsProperties?` | Properties you reach through `ctx.mpv.requestSet()`. Declared so the dependency is visible in review, and it now also decides which fix-hint an OwnershipError gives you. |
| `ownsFilterLabels?` | Reserved vf/af labels (§5). Same duplicate detection. |
| `usesVideoFilters?` / `usesAudioFilters?` | Grants `ctx.vf` / `ctx.af`. Without the flag the field is `undefined`. |
| `setup(ctx)` | Called once, in dependency order, before the first window is shown. May be async. |
| `dispose?()` | Called on quit. |

`ownsCommands` is not optional in spirit any more: if your module issues an mpv
command that mutates state, it has to be listed, and §2.2's side-effect table
plus `npm run test:command-ownership` will tell you if it is not.

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

**At every call.** `ctx.mpv.set()` and every property-writing command consult
that map:

```
OwnershipError: audio-loudness may not write 'aid' (owned by audio-tracks).
Add 'aid' to your requestsProperties and use ctx.mpv.requestSet('aid', value,
reason), or call audio-tracks' mediator command. If audio-tracks has no arbiter
for it yet, adding one is a one-line PR against audio-tracks.
```

The hint depends on what you actually declared, because the previous one pointed
at a dead path: `requestSet` refuses with `'no-arbiter'` unless the owner
registered an arbiter, and for a while no module registered any.

**What counts as a property-writing command is wider than it looks**, and every
line below was measured against the pinned mpv over JSON IPC rather than
reasoned about:

- `set`, `set_property`, `set_property_string`, `del`, `cycle`, `add`,
  `multiply`, `cycle-values`, `change-list` — **and their underscore
  spellings**, which mpv accepts (`cycle_values`, `change_list`, …).
- **Any of the above behind a prefix.** mpv takes a prefix as its own array
  element, so `['osd-msg','set','speed','1.75']` is a write. The eleven it
  accepts are `osd-auto no-osd osd-bar osd-msg osd-msg-bar raw
  expand-properties repeatable nonrepeatable async sync`; every one of them
  used to walk straight past the guard.
- **`loadfile`'s options argument.** `['loadfile', f, 'replace', 0, 'speed=2.5']`
  and the map form both set the property for real. Whatever you put in that map
  you must own — that is how `start` came to be M28's.

**Two commands are banned outright**, whoever you are: `screenshot-raw` (it
kills mpv over JSON IPC, §7.7 trap 5) and any raw `vf`/`af` command (§5).

In dev an ownership violation throws. In a packaged build it is logged, dropped
and **counted**, so a misbehaving module cannot corrupt another's state *and*
cannot black-screen the player. The count is not invisible any more: the first
refusal shows a toast, and every refusal appears in the stats overlay (`I`), so
it can reach a bug report.

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

### 2.1 Command ownership

A command can be owned too, and it needs to be for the same reason a property
does. `sub-reload` was declared in M17's `ownsProperties`, where it enforced
exactly nothing — it is not a property (mpv answers `property not found`), it is
a command — and any module could call it and blow away M17's track selection.

```ts
const mod: FeatureModule = {
  id: 'subs-tracks',
  ownsCommands: ['sub-reload', 'sub-add', 'sub-remove']
}
```

Same trailing-`*` glob, same boot-time duplicate check naming both modules, same
runtime guard. Currently owned:

| Commands | Owner |
|---|---|
| `seek` `revert-seek` `frame-step` `frame-back-step` | **M24** — it owns seeking. §3.6 already said "N51 seeks through M24's command, it does not own seeking"; that sentence had no encoding, so `assertCommand('nav-chapters','seek')` returned **true** for everybody |
| `sub-seek` `sub-step` | M20 — §1.5 keeps the confusable pair with one owner on purpose |
| `ab-loop` `ab-loop-align-cache` | M26 — it owns `ab-loop-a`/`-b`, so it owns the command that writes them |
| `dump-cache` `ab-loop-dump-cache` | M23 — capture owns everything that writes media to disk |
| `loadfile` `loadlist` `stop` `playlist-*` | M28 — mpv's own playlist must always hold exactly one entry (§7.6) |
| `sub-reload` `sub-add` `sub-remove` `rescan-external-files` | M17 — it owns `sid` and the external-track set |
| `audio-add` `audio-remove` `audio-reload` `video-add` `video-remove` `video-reload` | M11 — it owns `aid` and `vid` outright |
| `ao-reload` | M15 — it owns every AO-reinit round-trip |
| `screenshot` `screenshot-to-file` | M22 — traps 3 and 4 are its problem to get right once |
| `quit` `quit-watch-later` `run` `subprocess` `keybind` `keypress` `keydown` `keyup` `enable-section` `disable-section` `define-section` `load-config-file` `load-input-conf` `load-script` `show-text` `show-progress` `print-text` `write-watch-later-config` `delete-watch-later-config` | core — the process, the input layer, the OSD and mpv's own resume file |

If you need one of those, call the owner's mediator.

**Three checks keep this table honest**, and all three are new:

- every command name here exists in the **pinned binary's own
  `--input-cmdlist`** (captured to `docs/parity/mpv-commands.json` by
  `npm run dump:mpv-commands`), so a typo guards nothing silently;
- every command with a side effect has **exactly one owner**;
- **the spec's prose is cross-checked against `modules.json`.** Where a §1.5 or
  §3.6 row says a module owns a command, the manifest has to encode it, or
  `npm run test:command-ownership` fails. Prose that nothing enforces is exactly
  how `seek` ended up owned by nobody.

**…and the second of those three used to be blind in exactly the way it was
written to prevent.** It iterated `Object.keys(COMMAND_SIDE_EFFECTS)` — a table
somebody types by hand — so a command missing from that table was invisible to
the check whose whole job is to find commands nobody thought about. Measured:

```
OwnerMap.assertCommand('nav-chapters', 'script-binding', strict) -> true
commandOwnerOf('script-binding')                                 -> null
commandOwnerOf('mouse')                                          -> null
```

Both are named in the spec (L45 and U06 give `script-binding` to M29), both
mutate state, and neither had an owner.

The universe comes from the **binary** now. Every one of the 86 commands in the
pinned build's `--input-cmdlist` must be classified in one of five ways, and
anything unclassified — including a command a future mpv adds — fails the build:

| Classification | Meaning |
|---|---|
| owned | a module or a core piece declared it in `ownsCommands` |
| property-writing | guarded through the property it NAMES (`set`, `cycle`, `add`, …) |
| chain-reserved | only `core/vf-chain` and `core/af-chain` may issue it |
| banned | nobody may issue it, whoever they are |
| non-mutating | in `NON_MUTATING_COMMANDS`, **with a written reason** |

Seventeen were unclassified and each got a decision rather than a default.
`script-binding`, `script-message` and `script-message-to` → M29 (the only
loadable scripts are the built-in stats and select overlays). `mouse` and
`begin-vo-dragging` → core, input injection, the same family as the
`keypress`/`keydown`/`keyup` it already owned. `osd-overlay`, `overlay-add`,
`overlay-remove` → core, for the same reason as `show-text`: they draw inside
mpv's video surface, under your overlay. `update-clipboard` → **banned**: every
clipboard path here is Electron's, and mpv writing the same clipboard from the
other side is a race with no owner and no benefit.

If you need a command nobody owns yet, that is now a manifest edit and a review,
which is the conversation it should have been all along.

### 2.2 Commands that write a property WITHOUT naming it

This is the trap that cost the most. The guard only understood commands whose
second argument is a property name, so from an unrelated module every one of
these landed with **no throw, no refusal counted and nothing in the log** —
measured against the pinned binary, before and after:

| Command | What it actually wrote |
|---|---|
| `['frame-step']`, `['frame-back-step']` | core-owned **`pause`**: `false → true` |
| `['ab-loop']` | M26's **`ab-loop-a`**: `"no" → 2.466667` |
| `['apply-profile','fast']` | M06's **`scale`**: `lanczos → bilinear` |
| `['seek', …]`, `['sub-seek', 1]` | `time-pos` — i.e. seeking, which is M24's |

`COMMAND_SIDE_EFFECTS` in `core/mpv/ownership.ts` now maps each of these to the
properties it mutates, and `ctx.mpv.command()` checks them the same way it checks
`['set', …]`. **`apply-profile` is banned outright**: the set of properties a
profile touches lives inside mpv, so there is no way to police it. Apply your own
properties instead.

The prefix forms reach the table too: `['no-osd','frame-step']` is a `pause`
write. And a correction to what the guide used to say — **mpv accepts MORE THAN
ONE prefix.** `['async','no-osd','set','speed','1.5']` returns `error: success`
and writes; so do `['osd-msg','raw',…]` and `['async','async',…]`. The old
comment claimed that form was `invalid parameter`, which would have made
stripping a *run* of prefixes look like unnecessary caution to the next person
simplifying the loop.

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

`requestSet` refuses rather than falling through to a raw write, so a missing
arbiter is visible instead of silently racing — and the refusal now **names the
owner and says what to do**, because a bare `'no-arbiter'` sent people back to
the same call in a loop. The OwnershipError hint is honest about it too: it only
tells you to call `requestSet` when an arbiter is **actually registered**, and
otherwise points you at the mediator. It used to promise "the owner's arbiter
will answer" regardless, while `requestSet` answered `'no-arbiter'`.

There is a real call site now, which there was not before: **M15** re-asserts the
audio track through M11's arbiter after an audio-device switch reopens the
output (`src/main/features/audio-devices/index.ts`). Read it as the worked
example. **Refusal is
a normal outcome and your caller must handle it** — M11's arbiter refuses `aid`
outright while its own per-file restore is in flight, because that race picks
the wrong dub on a dual-audio release. If **you** own a property others need,
register the arbiter once in `setup()`:

```ts
ctx.mpv.arbitrate('aid', async (value, req) => {
  if (busyRestoring) return { ok: false, reason: 'per-file restore in progress' }
  await ctx.mpv.set('aid', value)
  return { ok: true }
})
```

Arbiters registered today: M11 on `aid`, M07 on `d3d11-output-format` and
`d3d11-output-csp`. If the property you need has none, the OwnershipError says
so and adding one is a one-line PR against the owner.

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

### A command must LOOK like a command

Every guard above funnels through one function that reads the command's verb, and
that function used to answer "I do not recognise this" for any array whose head
was not a primitive string — which every caller read as "nothing to check". So
"unrecognised" meant "allowed", and §3.7 switched itself off for any shape it had
not been taught. Nine of eleven probes landed and none threw:

```ts
ctx.mpv.command([new String('vf'), 'set', 'hflip'])   // JSON: ["vf","set","hflip"]
ctx.mpv.command([new String('apply-profile'), 'fast'])// the BANNED command
ctx.mpv.command(['set', new String('speed'), 4])      // verb fine, PROPERTY skipped
```

A boxed primitive is `typeof 'object'` and `JSON.stringify`s as a plain string,
so mpv executed exactly what the guard refused to look at. The last one is the
sharpest: the head was a real string, only the property name was boxed, and the
"which properties does this write" step returned an empty list.

**Every element of a command must now be a JSON value** — a string, a finite
number, a boolean, `null`, or (for `loadfile`'s options argument) a flat object
or array of those. Anything else is a hard error, for core as much as for you,
and it is checked *above* the privileged early-out. In practice you will never
notice; if you do, the message names the argument.

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

**An option follows its property's owner — and this is now a boot error, not
advice.** A spawn arg is a property write that happens before the first frame,
so it goes through the same owner map:

```
module 'video-hdr' contributes '--d3d11-output-format=rgba16f', but the
'd3d11-output-format' property is owned by 'video-decode' (§3.7). An option
follows its property's owner ... Ask video-decode through
ctx.mpv.requestSet('d3d11-output-format', …) or its mediator command, and let
video-decode contribute the arg.
```

**Why this matters more than it looks: the V33/V36 case.** M05 (video-hdr) needs
`d3d11-output-format=rgba16f` for HDR passthrough; M06 (video-scaler) wants
`rgb10_a2` for 10-bit dithering. Both declare it in `requestsProperties`;
neither owns it; it is spawn-scoped. Under the old rules each module was
perfectly correct on its own and the PAIR was a hard boot failure — so the bill
fell on whoever merged second, weeks later, with no clue why. Now either one
fails on its own boot with M07 named.

The resolution, so nobody re-litigates it: **M07 owns it, M07 contributes it,
and M07 arbitrates.** The two values are mutually exclusive and one is strictly
better — `rgba16f` is a 16-bit float surface, so it carries everything
`rgb10_a2` does plus the HDR range — so M07 holds HDR above dither and says so
in the refusal rather than letting last-writer-win decide it silently. It is
restart-scoped: the swapchain format is fixed when the VO comes up.

The check runs BEFORE the additive-`*-append` exemption, because `--vf-append`
is additive as an option and still writes `vf`, which the chain owns.

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
- **There is no `vfChain` to import any more.** It used to be an exported
  singleton whose `exec` was a TypeScript `private` — which erases to an ordinary
  enumerable property — so `Object.keys(vfChain)` listed it and
  `vfChain.exec.command(['vf','set','hflip'])` landed a raw chain write from a
  feature module, as did `vfChain.claim('attacker-module', ['rl-lut'])` on a
  label whose owner does not exist yet. Fields are `#`-private, the class is not
  exported, and `createVfChain()` builds one and throws on a second call. A
  dynamic import gets a factory that refuses.

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

### The settings window is GENERATED from these, and that is the whole story

There is no form to edit. `src/renderer/settings.html` is an empty `<main>` and
`src/renderer/src/settings.ts` is one line; the page is built from the
descriptor snapshot at open time, one control per `type.kind`, written back by
id. **Adding a setting means adding a descriptor in your own module directory
and nothing else.**

It was not like this. `settings.html` hardcoded `<select id="hwdec">`,
`<select id="vo">`, `<select id="audioDevice">`, `<input id="subScale">` and six
more, all backed by fields on `AppConfig` in `src/shared/types.ts` — three files
in every module's `mustNotTouch`, which put M38 in a head-on collision with
M07, M10, M15, M17, M19, M22, M28 and M31 simultaneously.

Two escape hatches for what a descriptor genuinely cannot express, and please
use them only for that:

**`{ kind: 'custom', rendererComponent }`** when the choices are not knowable
statically. The one real case today is M15's output-device list, which is read
from mpv when the window opens and changes when a headset is plugged in:

```ts
// main half
type: { kind: 'custom', rendererComponent: 'audio-devices.picker' }

// renderer half — src/renderer/src/features/audio-devices/index.ts
ctx.settingsComponent('audio-devices.picker', (host, binding) => {
  const select = document.createElement('select')
  host.appendChild(select)
  select.addEventListener('change', () => binding.set(select.value))
  const off = binding.onChange(() => { select.value = binding.get<string>() })
  return () => { off(); select.remove() }
})
```

**`ctx.settingsSection()`** for prose and actions — a paragraph explaining a
driver bug, a "restart now" button. M31 contributes the Electron #40515
explanation that sits under its layout select.

Everything else is a descriptor. If you are reaching for a hatch to render an
ordinary value, the descriptor kinds you want are there: `bool` is a checkbox,
a bounded `int`/`float` is a slider with a readout, an unbounded one is a number
box, `enum` is a select, `path` is a read-only field plus a native browse
dialog, `list` is one line per entry, `string` with `multiline` is a textarea.
`requiresRestart` adds a badge; `mpvOption` is shown and indexed for search;
`keywords` are what the search box matches besides the label.

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
import './my-panel.css'                       // your CSS, in your directory
import type { RendererFeatureModule } from '@shared/renderer-api'

const mod: RendererFeatureModule = {
  id: 'nav-chapters',
  setup(ctx) {
    if (ctx.surface !== 'player') return       // see below
    ctx.ipc.send('nav-chapters:goto', { index: 3 })
    ctx.state.subscribe((s) => redraw(s))
    ctx.seekbarLayer({ ... })
  }
}
export default mod
```

**`ctx.surface` is `'player'` or `'settings'`.** The overlay and the settings
window run the SAME glob, so your `setup()` is called once per window. The hosts
ignore contributions that do not belong to their surface, so a module that just
registers everything is still correct — branch on it to skip expensive work.

**Import your own CSS.** Vite bundles it. `styles.css` is core's and is on the
forbidden list; a panel's look is the panel's business.

> **A trap that cost us a live bug, and it is about YOUR code, not core's.**
> `ctx.state.subscribe(cb)` **replays the last state synchronously**, so `cb`
> runs during your `setup()`. Everything it closes over must already exist at
> the point you subscribe. nav-chapters declared `let ticks = []` *below* its
> subscribe, so the first replayed `paint()` was a TDZ ReferenceError; the throw
> killed the rest of `setup()`, so its `seekbarLayer()` never registered, and it
> left a permanently throwing subscriber behind. Declare first, subscribe last.

### The five contribution points, and what each renders

They had no consumers at all until now — the arrays existed and nothing read
them — which is why every module with UI had to edit a shared file.

```ts
// A docked side panel. The DOCK is core's; everything inside is yours.
ctx.panel({
  id: 'playlist', side: 'right', titleKey: 'playlist.title', order: 10,
  mount(host) {            // host starts hidden; open it when your state says so
    host.hidden = false
    return () => { /* unmount */ }
  }
})

// A block in the stats overlay (core.toggleStats, `I` by default).
ctx.statsSection({
  id: 'video-decode.stats', order: 20, titleKey: 'video-decode.stats',
  refresh: { mode: 'onChange', watch: ['hwdec-current'] },   // or 'static' | 'poll'
  fields: () => [{ labelKey: 'video-decode.statsHwdec', value: 'd3d11va' }]
})

// Prose or an action inside one of the eight fixed settings sections (§7).
ctx.settingsSection({ id, section: 'video', order: 6, titleKey, mount(host) {...} })

// The renderer half of a { kind: 'custom' } descriptor (§7).
ctx.settingsComponent('audio-devices.picker', (host, binding) => {...})

// A control in the transport bar's button row. The <button>, its `icon-btn`
// class and its position are core's; what is inside it is yours.
ctx.transportButton({
  id: 'nav-bookmarks.toggle',
  order: 30,                       // left to right; core's own controls end at 100
  labelKey: 'nav-bookmarks.togglePanel',   // tooltip AND accessible name
  mount(el, api) {
    el.appendChild(icon())
    return ctx.state.subscribe((s) => api.pressed(isOpen(s)))   // aria-pressed
  },
  onClick: () => ctx.ipc.send('nav-bookmarks:togglePanel')
})
```

`transportButton` is new, and it exists for the same reason as `panel()`.
`src/renderer/index.html` hard-coded `#subBtn` (M17's) and `#playlistBtn`
(M28's), with their click handlers and their pressed-state rendering in
`src/renderer/src/main.ts` — two core files in the `mustNotTouch` list of 40 of
the 55 rows, carrying two modules' controls. M22 (capture), M26 (bookmarks),
M27 (thumbnails) and M35 (open URL) all want the next button in that row and had
a committed precedent to follow into the same file. Both have moved into their
owning modules; `index.html` names neither.

Note what `check:partition` could NOT do about that one: core's `main.ts` really
did reference `#playlistBtn`, so the id had a legitimate core user and no
ownership rule could fire. The fix was the host, not the detector. What the
detector guarantees now is that it cannot come back as a **feature-only** symbol
in a core file — see below.

`refresh` exists so a stats block does not burn a wake-up a second for a value
that changes once per file: `static` reads once when the panel opens, `onChange`
re-reads on a state push, `poll` is for values with no property to watch.
Everything stops while the panel is hidden.

**Nobody edits `src/preload/index.ts` again.** It exposes one generic
`window.rl` bridge with a channel shape check, plus the typed `window.rlplayer`
core surface that feature modules do **not** extend. `contextIsolation` is on,
`nodeIntegration` is off, and raw `ipcRenderer` is never exposed. The regex in
the preload is a shape check, not the security boundary: main only has a handler
for channels a module actually registered under its own id.

The renderer context also gives you `panel()`, `statsSection()`,
`settingsSection()`, `settingsComponent()`, `transportButton()`, `t()` and
`osd.show()`. Every one of them has a host that renders it; see below.

### Your layer's CSS lives in YOUR directory

Core creates the element your layer paints into and owns its class
(`.seek-layer`); everything **inside** it is yours. Import your own stylesheet
from your renderer half, exactly as M28's playlist panel does:

```ts
import './nav-chapters.css'          // src/renderer/src/features/nav-chapters/
```

This is not a style preference. M25's `.seek-chapter-tick` and
`.seek-tip-chapter` were in `src/renderer/src/styles.css` — a file owned by
`core-renderer` and named in the `mustNotTouch` list of **40 of the 55 rows** —
because the layer had to build its own container and therefore had to know
core's class name. §6.3 requires this same bar to carry chapter ticks, bookmark
pins and the A-B region at once, so M20, M26 and M27 were each one commit from
following the precedent in. That is the `#playlist` collision again, moved from
the panel path to the seek-bar path.

`npm run check:partition` is **content-granular for CSS, HTML and TS** now. The
unit is a SYMBOL — a class or id a stylesheet defines, or an `id="…"` an HTML
file declares — and a *use* is that symbol inside a **string literal** of a code
file. A symbol defined in a core file and used only by features fails the build,
whether by one feature or by three, and so does the same symbol being defined by
two modules.

The three holes that version had, each found by planting the violation and
watching the check print "clean":

* it gated on `featureUsers.length === 1`, so a selector used by **two** feature
  modules passed — which is exactly the case §6.3 creates, since it puts M25's
  ticks, M26's pins and M27's thumbnails on one bar;
* a "use" was any substring hit anywhere in any core file, **comments included**,
  so one word of prose in `util.ts` whitelisted a real violation;
* only `.css` was scanned at all. There was no content check for HTML or TS.

Comments are blanked (`scripts/lib/lex.mjs`) before anything is matched, and an
`id="x"` attribute is a declaration rather than a use.

**Then the same hole came back twice more, in the CSS reader itself**, and both
were found by planting the violation and watching the check print "clean" with
exit 0:

* the prelude regex `/(^|\}|;)([^{}]+)\{/` required the prelude to follow `}`,
  `;` or start-of-file, so **the first rule inside any at-rule block was never
  extracted**. `.bm-pin` inside `@media (min-width: 1px) { … }` in core
  `styles.css`, referenced only from two feature modules: clean;
* `/[.#]([A-Za-z]…)/.exec(part)` takes the **leftmost** token only, so anything
  after a descendant combinator was invisible. `.seek-layer .thumb-preview`,
  same file, same two modules: clean.

Instrumented against this repo's own four stylesheets, **15 selector tokens were
already unextractable, 7 of them in core `styles.css`** (`boosted`, `close`,
`error`, `play`, `primary`, `show`, `small`). The old self-check did not close
it: it named three canaries by hand, and all three happened to be leftmost and
top-level.

So the CSS is **parsed**, not matched: `scripts/lib/css.mjs` walks the rules with
postcss (which descends into every at-rule) and tokenizes each selector with a
state machine that understands combinators, `,`, `:not(…)`, `[attr="…"]`,
strings, escapes and selector comments. It returns two views, and the rules use
different ones on purpose:

* **`all`** — every class and id anywhere in the selector. "Does a **core** file
  carry a name only features use?" is answered with this one, which is the half
  that was missing.
* **`leftmost`** — the first compound of each comma part. "Who **owns** this
  symbol?" is answered with this one, so `.pl-tools .icon-btn` in the playlist's
  own stylesheet stays what it is: a module styling a core component inside its
  own subtree.

The fifth rule still asserts the extraction can see itself, but it now runs over
a fixture built from the **shapes** (a rule first inside `@media`, a class after
a descendant combinator, an id in a compound, a hex colour in a declaration)
rather than from names this repo happens to use today, and it fails if the `all`
and `leftmost` views ever agree in size. `scripts/lib/css.test.mjs` carries the
two planted violations as fixtures.

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
  handles:   () => ['a', 'b'],                           // what Tab reaches
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
4. **Keyboard equivalence is mandatory** for an interactive layer, and it is now
   *possible*. Declare `handles()` alongside `hitTest`; Tab walks every handle in
   paint order, the arrows and Home/End reach `onKey()`, and
   `ctx.focusedHandle` tells your `render()` which of your handles to draw a
   focus ring on. A layer with `hitTest` and no `handles()` is logged once,
   by name.

`ctx.duration` is `0` for live streams — guard for it; `timeToX`/`xToTime`
already do.

**THIS HALF WAS DEAD CODE UNTIL NOW, and it is worth knowing why.** `tooltips()`,
`key()` and `focusHandle()` were implemented on the host, documented in the four
rules above, unit-tested and green — with **zero production call sites**. The
overlay assigned its hover readout with a plain
`seekHover.textContent = formatTime(…)` and returned early on every arrow key
inside a range input, and the seek bar *is* a range input. So M25 wrote a
`tooltip()` fragment against the documented contract and it never once ran, and
rule 4 was unsatisfiable by construction: any author who implemented `onKey`
would have watched it never fire.

Two consequences for you. First, **your `tooltip()` fragment really is merged**:
core's timecode is a fragment at order 0, so returning `{ el, order: 20 }` puts
your chapter title under it in the same box rather than in a second floating one,
and N37's thumbnail slots in at order 10 without anyone editing a shared file.
Second, `npm test` now fails if any host method a module's contract depends on
loses its last caller in shipped code, and `scripts/e2e-overlay.mjs` asserts in
the **packaged build** that the tooltip composed ≥2 fragments and Tab reached a
handle. A unit test structurally could not have caught this: the unit test was
the only caller.

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

## 11.5 `ctx.network` — and why it will say no

RLPlayer reaches **zero hosts**. Not "no telemetry": zero. `ctx.network` is how
a module that genuinely needs one (R05's yt-dlp, M21's subtitle providers) finds
out whether it may — and it cannot grant itself permission:

```ts
if (!ctx.network.allowed('api.example.com')) return   // grey the feature out
ctx.network.assertAllowed('api.example.com', 'subtitle search')  // or throw
```

The allowlist is a table in `src/main/core/no-network.ts`, it is **empty**, and
adding a row is a deliberate edit to a core file that shows up in review. It is
not a runtime `allowHost()` call on purpose: that would make the policy a
function of load order, and "what can this build reach?" would need a running
app to answer. `RLPlayer.exe --print-network-policy` prints the whole thing.

Four layers enforce it, and the ordering is the point:

1. nothing makes a request;
2. `session.webRequest.onBeforeRequest` cancels every non-local URL;
3. the proxy is `direct` and `--no-proxy-server` is set (WPAD emitted two
   `wpad` host resolutions on both HEAD and the released 0.1.0);
4. **only then** the `MAP * ~NOTFOUND` DNS rule.

That DNS rule used to be layers 1 through 4. Every cold launch of the packaged
build fetched Chromium's spellcheck dictionary from `redirector.gvt1.com`, and it
failed `-105` **only** because of that one line; with it removed the download
completed and the 302 carried the user's public IPv6 back in `mip=`. `grep
spellcheck src/` returned zero hits. The fix is
`session.setSpellCheckerEnabled(false)` — measured to be the ONLY layer that
works, in preference to the two obvious ones: `webPreferences.spellcheck: false`
alone and `--disable-spell-checking` alone were both measured **insufficient**.

`npm run check:network` proves it, and it proves it the only way that means
anything: it drives the **packaged** app with `--log-net-log` and asserts on
`URL_REQUEST` and `HOST_RESOLVER` events, so an **attempt** fails the check
whether or not it succeeded. `--no-blackhole` runs it again with the DNS rule
switched off, which is the difference between "gone" and "blackholed".

---

## 12. Paths and lifecycle

```ts
ctx.paths.dataDir() / cacheDir() / subCacheDir() / thumbCacheDir() /
          sceneCacheDir() / logsDir() / tempJobDir(jobId)
ctx.paths.isPortable() / ctx.paths.portableFallback / ctx.paths.mpvBinary()
ctx.lifecycle.onReady(cb) / onQuit(cb) / trackProcess(child)
```

`tempJobDir(jobId)` exists because **a Windows absolute path cannot appear
inside a lavfi option**. Stage your font/palette there and spawn with `cwd` set.

`trackProcess` registers a child so the registry kills it on quit or crash —
even if your `dispose()` throws. An orphaned encoder holding a file handle is
worse than a noisy log line.

### `ctx.engine` — a second mpv, spawned and reaped for you

Four Wave-1 features need one: N36 (seek thumbnails, M27), L22 (the headless
metadata probe, M29), C09 and C16 (clip export and cache dump, M23). Until now
the only resolver was `resolveMpvPath()` **inside `src/main/mpv/manager.ts`**,
and `PathService` exposed no binary path at all — so M23 and M27 would each have
edited `src/shared/feature-api.ts` *and* `src/main/core/paths.ts` before writing
a line of their own feature. §2.6's L30 row already carried an explicit
"**Overlap warning:** build ONE shared engine, not two", and there was nothing to
build it with.

```ts
const engine = await ctx.engine.spawn({
  purpose: 'thumbnail',                 // [a-z0-9-], names it in the log and the pipe
  args: ['--vo=null', '--ao=null', '--hr-seek=yes'],
  idleTimeoutMs: 60_000                 // §6.3's M27 criterion, implemented once
})
await engine.command(['loadfile', file, 'replace'])
const dur = await engine.getProperty<number>('duration')
await engine.close()                    // idempotent, and never required
```

Core always applies `--no-config --idle=yes --terminal=no --msg-level=all=no
--load-scripts=no --ytdl=no` and a **random** `--input-ipc-server` pipe name per
instance. Neither is tidiness: a `vf` in the user's `mpv.conf` would corrupt
every thumbnail, "zero network at rest" is about every process this app starts,
and mpv's IPC is documented as *explicitly insecure* and exposes the `run`
command (L22 says so in as many words), so a guessable pipe name is a local
command-execution surface.

**Use this rather than `ctx.paths.mpvBinary()` + `child_process`.** Every engine
minted here is registered, reaped on the quit path *before* the playing mpv, and
covered by one synchronous `process.on('exit')` fallback — the same reasoning as
`MpvManager`'s, and for the same measured reason: an async cleanup registered in
`before-quit` almost never runs. "No orphan mpv on quit" is a v0.1 guarantee, and
it has to mean all of them, not only the one with a window on it. A feature
module importing `mpv/manager` or `mpv/client` now fails `check:forbidden`.

`ctx.paths.mpvBinary()` remains, for the cases that want a path and not a
process: a version string in a bug report, `--input-cmdlist` in a test.

### Your users' 0.1.0 profiles are cleaned up for you

`core/profile-cleanup` runs once, before `app.whenReady()`, and removes what the
0.1.0 spellchecker leak left on disk: the downloaded dictionary, both
`Network Persistent State` records, and the HTTP disk cache — which held the 302
from Google's redirector with the user's public IP in its `mip=` parameter. It is
a literal target list, it never throws, and a locked file leaves its marker
unwritten so the next launch retries. You will not interact with it; it is here
so you know why a first launch after upgrade prints a `[cleanup]` line.

**Two things about it concern you directly**, because version 2 of it got both
wrong on real disks:

* it listed `Dictionaries` at the profile root, and `core/paths.ts` redirects
  `sessionData` to `<root>\session` — which is where Chromium actually writes it.
  Every other Chromium target had a `session/` twin and that one did not, so the
  11 MB artefact the feature exists for survived, with the marker already at
  `CLEANUP_VERSION` and therefore never retried. **A one-shot migration that
  missed has to be able to run again: fixing the list means moving the version.**
* it listed `Cache`, and `cacheDir()` returned `<root>/cache`. On NTFS those are
  one directory, so it deleted `cache/thumbs`, `cache/scenes`, `cache/art` and
  `cache/jobs` — `thumbCacheDir()`, `sceneCacheDir()`, `artCacheDir()` and
  `tempJobDir()`, the four directories §12 hands to **you** — and logged
  "removed Cache". Chromium's disk cache is at `<root>/httpcache` now, the
  legacy target is narrowed to `Cache/Cache_Data` and `Cache/No_Vary_Search`,
  and `appOwnedConflict()` refuses any target that is, contains, or sits inside
  a path the app owns. **Nothing in `ctx.paths` can be touched by a cleanup
  routine.**

---

## 13. Testing your module

- Put `node:test` files next to the code as `*.test.ts`; `npm test` globs
  `src/**/*.test.ts` **and `scripts/**/*.test.mjs`**, and CI runs it on every
  push. The named suites are `npm run test:property-ownership`,
  `test:reserved-args` and `test:renderer-hosts`; `npm run e2e:overlay` drives
  the real app (add `--packaged --presses=300` before a tag).
- **`e2e:overlay` is in CI now**, and it is the only check that asserts the
  generated settings page actually rendered (`settings.rows < 8`) — the page
  where all 38 Wave-1 modules land their descriptors. It was excluded because
  `samples/` is gitignored; `npm run make:sample` encodes 200 s of
  `av://lavfi:` with the mpv the job already downloaded, and leaves a real
  sample alone if you have one.
- **A harness is code, and it gets tests too.** Both orphan checks in this repo
  counted `mpv.exe` machine-wide with `tasklist` and no attribution, and were
  wrong in both directions: `check:network` reported "FAILED: 4 orphaned mpv.exe"
  on an unchanged tree (all four belonged to a different checkout, 3 runs out of
  4, and it was a hard red), while `e2e-overlay` computed
  `countMpv() - (mpvBefore - 1)` — a delta, so an unrelated mpv exiting inside
  the quit window cancelled a real orphan out. `scripts/lib/mpv-procs.mjs` tracks
  the pids the app is an ancestor of, and its unit tests are those two measured
  failures as fixtures.
- **Your new file needs an owner.** `npm run check:partition` fails if any file
  under `src/` — including one you have not committed yet — is not in exactly
  one row's `ownedFiles` in `docs/parity/modules.json`. Your module's row claims
  its two directories, so anything inside them is already covered.
- Node runs TypeScript by **stripping** it. That means: no `enum`, no
  `namespace`, no **parameter properties** (`constructor(private x: T)`) — declare
  the field and assign it. Type-only imports must be written `import type`, and
  runtime imports inside tested files must be **relative with a `.ts`
  extension**, because Node knows nothing about the `@shared` alias.
- Keep the logic you want to test free of Electron imports. Every core piece
  that has a test does this, which is why the suites exercise the real
  implementation rather than a copy of it.
- Your §6.3 acceptance row is the bar. "It compiles" is not acceptance. Neither
  is "no console errors": a hung app is silent too, which is why
  `e2e:overlay` proves liveness before it believes a quiet console.

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

### What the post-Wave-0 audit changed

Three verifiers went at Wave 0 and returned FAIL / FAIL / PASS-with-leaks. The
list below is what moved as a result; everything above already describes the
current state.

| # | Was | Is |
|---|---|---|
| 7 | `ctx.panel()`, `statsSection()`, `settingsSection()`, `settingsComponent()` pushed into arrays nothing read | four hosts render them; M28's panel, M07's stats block, M31's settings section and M15's settings component are the proof, and `index.html` / `main.ts` / `styles.css` are forbidden to modules |
| 8 | the settings form hardcoded ten controls and collided with eight modules | generated from descriptors; `settings.html` is an empty `<main>` |
| 9 | `ctx.ipc.send(ch, p, 'settings')` was silently dropped | `windowsFor()` returns the settings window; it also runs the feature glob, with `ctx.surface` to tell you which window you are in |
| 10 | the guard stripped two prefixes, space-joined only | the eleven prefixes mpv accepts, in the array-element form it actually uses; plus `set_property_string`, the underscore aliases, and `loadfile`'s options argument |
| 11 | `sub-reload` was declared as a *property*, where it enforced nothing | `ownsCommands`, with the same duplicate check and runtime guard, and a test that fails if a command name appears in `ownsProperties` |
| 12 | `mpvBus.manager` was public: `mpvBus.manager.client.setProperty('aid',2)` bypassed everything | `#private`; the bus exposes no path to a raw write, and `check:forbidden` greps `core/mpv/*` too |
| 13 | a dropped write in a shipped build was counted and never read | first refusal toasts, all of them show in the stats overlay |
| 14 | no module registered an arbiter, so every `requestSet` returned `'no-arbiter'` while the error recommended it | M11 arbitrates `aid`, M07 the two d3d11 surface options, and the hint tells you the truth when there is none |
| 15 | "an option follows its property's owner" was prose | a boot error naming the owner; M05/M06/M07 resolved (§4) |
| 16 | 30 of 78 files under `src/` had no owner | all owned; `check:partition` fails the build otherwise |

### What the SECOND audit changed

Four verifiers audited the repair. Runtime passed; partition, ownership-bypass
and network all failed, with measurements. This is what moved.

| # | Was | Is |
|---|---|---|
| 17 | **every cold launch of the packaged build fetched `redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic`** — Chromium's spellchecker, activated by the text inputs Wave 0's settings form added. It failed `-105` only because of the DNS blackhole; without that one line the download completed and the 302 returned the user's public IPv6 in `mip=` | `session.setSpellCheckerEnabled(false)` — **measured to be the only layer that works**; `webPreferences.spellcheck: false` alone and `--disable-spell-checking` alone were each measured insufficient. All three are applied and the two that do not work say so |
| 18 | WPAD: two `HOST_RESOLVER_MANAGER_REQUEST`s for `wpad` on HEAD *and* on 0.1.0 | `--no-proxy-server` plus `session.setProxy({ mode: 'direct' })` |
| 19 | the `MAP * ~NOTFOUND` DNS rule WAS the guarantee, with a comment saying it must be "revisited deliberately" when R05/M21 land | demoted to layer four of four. The opt-in exists now: an empty, auditable per-host `ALLOWLIST`, reached through `ctx.network` (§11.5), printable with `--print-network-policy` |
| 20 | `scripts/watch-network.mjs` launched the **dev** build, slept 1500 ms, then polled sockets at 1 Hz. The episode it hunted lasts 390 ms, and a poll can only see connections that were *established* | `scripts/check-network.mjs`: the **packaged** build, fresh profile per launch, asserting on `--log-net-log`'s `URL_REQUEST` / `HOST_RESOLVER` events, so an **attempt** fails whether or not it succeeded. `--no-blackhole` proves the leak is gone rather than blackholed. It is a CI job |
| 21 | `check:forbidden`'s "any network request" rule matched none of `import dns`, `await import("node:https")`, `net.connect({host,port})`, `session.resolveHost(...)` or `const F = fetch`, and exempted all of `src/preload/index.ts` for nothing | all of them fail now; the exemption is gone; `--self-test` runs the rules against those exact strings so a rule that stops catching its own regression fails the build |
| 22 | **`mpvBus` was an exported singleton.** `createService('victim')`, `createService('core/mpv/bus')`, `{privileged:true}`, `setOwnerMap(...)` (which disarmed all 38 hardened attacks at once), `contributeArgs('core/mpv/bus', …)` and `chainExec(['vf','set','hflip'])` each landed a write from a feature module | **there is no bus to import.** `createMpvBus()` throws on a second call; `src/main/index.ts` makes the one; the registry mints your service with your id baked in; `privileged` belongs to three hard-coded core ids; `setOwnerMap` and `chainExec` are unreachable |
| 23 | the only barrier was a grep, and the grep was static-import-only, so `await import('../../core/mpv/bus.ts')` escalated fully while `check:forbidden` printed "clean (90 files scanned)" | `import()`, `require()` and bare side-effect imports all match, and a **computed** specifier in a feature module is refused outright |
| 24 | feature modules were imported with `{ eager: true }`, so their top-level code ran during `src/main/index.ts`'s own evaluation — before core was wired | lazy glob; `collectFeatureModules()` is awaited from `main()`, after the bus exists and after the session network policy is applied |
| 25 | no command → side-effect table: `['frame-step']` flipped core's `pause`, `['ab-loop']` set M26's `ab-loop-a`, `['apply-profile','fast']` rewrote M06's `scale`, all with no refusal counted | `COMMAND_SIDE_EFFECTS` (§2.2), checked against the pinned binary's `--input-cmdlist`; `apply-profile` is banned |
| 26 | `seek`, `frame-step`, `frame-back-step`, `revert-seek`, `sub-seek` had **no owner**, so §3.6's "M25 seeks through M24's command" enforced nothing | owners assigned, and a check fails when a spec row claims command ownership `modules.json` does not encode |
| 27 | `requestSet` had zero call sites, and the hint promised an arbiter without checking one existed | M15 uses it for real after an audio-device switch; the hint and the refusal both tell the truth |
| 28 | M25's `.seek-chapter-tick` / `.seek-tip-chapter` lived in core's `styles.css`, with M20, M26 and M27 heading for the same file | core owns the layer's container; the layer's look lives in its own directory; `check:partition` is content-granular for CSS |
| 29 | closing the player with the settings window open never quit (still running after 16 s, 2/2), and `e2e-overlay` then did a silent `child.kill()` and printed "clean" | the player is the app: closing it quits. `before-quit` takes control, runs the shutdown to completion and then `app.exit(0)`, with a watchdog. The harness fails loudly on a force-kill and reports the quit time |
| 31 | giving `seek` an owner **broke seeking**, and 192 tests, the greps and the partition check all stayed green: `['seek',…]` implies a `time-pos` write nobody owns, so M24 was refused its own command and M28's four resume seeks were dropped behind `.catch(() => undefined)` | a command's **implied** side effects belong to its owner (decided once in `modules.json`, checked by `commands.test.ts`); the properties it **names** are still checked for everyone, so `loadfile` being M28's never becomes "M28 may write anything". `npm run e2e:resume` drives the packaged app and asserts the position survives a real quit |
| 30 | `MpvManager.dispose()` was `setTimeout(() => proc.kill(), 300)` inside `before-quit`, which almost never fired | an awaited escalation — IPC `quit`, `kill()`, `taskkill /T /F`, each verified by re-polling the pid — plus a synchronous `process.on('exit')` reaper that cannot be skipped |

### What the THIRD audit changed

Three verifiers audited the release. Runtime passed for the product and failed on
the tooling; partition and ownership-bypass both failed, with measurements.
Thirty-eight feature modules start immediately after this, so the ordering
principle was "fix what will break a 38-way parallel build", not "fix what is
theoretically reachable".

| # | Was | Is |
|---|---|---|
| 32 | **three modules needed the same line.** `main.ts:364` assigned the seek tooltip with `seekHover.textContent = formatTime(…)`, so N37 (M27) and N13 (M26) each had to edit it — in a file all three of M25/M26/M27 list in `mustNotTouch`. Meanwhile `SeekbarHost.tooltips()`, `.key()` and `.focusHandle()` had **zero production call sites** and M25's shipped `tooltip()` fragment was dead code | the overlay composes the tooltip from `tooltips()`; core's timecode is a fragment at order 0 via a new `baseTooltip` dep. `npm test` fails if any host method a module's contract depends on loses its last shipped caller |
| 33 | host rule 4 said "keyboard equivalence is **mandatory**" while `main.ts:464` returned early on every arrow key inside a range input — and the seek bar *is* a range input, so `key()` was unreachable by construction. A rule nothing can satisfy is worse than none | Tab drives `focusNext()` through the handles a layer declares in the new `handles()`; arrows and Home/End reach `onKey()`; `ctx.focusedHandle` lets a layer paint its own focus ring. When nothing is focused `key()` returns false and the native slider keeps its arrows exactly as before |
| 34 | four Wave-1 features need a second mpv and the only resolver was `resolveMpvPath()` **inside `mpv/manager.ts`**; `PathService` had no binary path. M23 and M27 would each have edited `feature-api.ts` + `core/paths.ts` | `ctx.engine.spawn()` (§12): one spawner, registered children, reaped before the playing mpv, one synchronous exit reaper, an optional idle timeout, a random IPC pipe name. A feature importing `mpv/manager` or `mpv/client` now fails `check:forbidden` |
| 35 | §2.6 line 601 gave **L30 to M27**, and M27's `features` array agreed — while the files that row edits are M28's `ownedFiles`. Two documents agreeing is not two sources of truth | split: the view mode is M28's, the thumbnail is M27's through a `nav-thumbnails.getThumb` mediator. A check requires every feature the spec assigns to one module to be claimed by that module, which also surfaced **12 rows claimed by nobody** |
| 36 | `script-binding` and `mouse` are state-mutating, named in the spec, owned by nobody — and `commands.test.ts` could not see them because it iterated a hand-written table | the command universe comes from the pinned binary's `--input-cmdlist`; all 86 must be classified (§2.1). 17 were not; each got a decision |
| 37 | `check:partition` gated on `featureUsers.length === 1` (so a selector used by **two** modules passed), counted a word in a **comment** as a use, and scanned `.css` only | symbol-granular over CSS **and** HTML ids, uses matched inside string literals only, comments lexed away, and a self-check that the extraction still finds what it is known to find |
| 38 | `#playlistBtn` and `#subBtn` were feature controls in core's `index.html` and `main.ts` | `ctx.transportButton()` (§10). Both moved into their modules; `index.html` names neither. `check:partition` could not have caught these — core genuinely used the ids — which is why the fix is a host and not a rule |
| 39 | `verbOf()` returned null for any non-string head, and every guard read null as "nothing to check". 9 of 11 boxed-primitive probes landed, 0 threw, including raw `vf`/`af` and the banned `apply-profile`; `['set', new String('speed'), 4]` skipped the property check with a perfectly good verb | `assertCommandShape()` refuses every value that is not a JSON primitive (or a flat object/array for `loadfile`'s options), inside `verbOf` — the one choke point all five guards share — and above the `privileged` early-out |
| 40 | `vf-chain.ts` exported the `vfChain` singleton and `exec` was a TypeScript `private`, so `Object.keys(vfChain)` listed it; `vfChain.exec.command([...])` and `claim('attacker-module', …)` both landed. The test asserted `!/chainExec/` — a grep for a name the file never had | `#`-private fields, no exported instance, `createVfChain()` throws on a second call, and the test asserts on the **runtime object's own properties** and the module's export list |
| 41 | `bus.ts` exempted core ids from the id check, so `createService('core/mpv/bus')` **without** the privileged flag was minted and wrote core's `pause` | naming yourself core is not a credential: every non-privileged id must be one the registry loaded |
| 42 | `check-forbidden.mjs` iterated lines, so a multi-line `await import()`, a `createRequire(import.meta.url)(…)` and a multi-line computed import all passed — all three resolving at runtime to the same singleton | a comment- and string-aware lexer (`scripts/lib/lex.mjs`) and whole-file rules; `createRequire` is forbidden outright in a feature module, because no lexical rule can follow the binding once it is named |
| 43 | both orphan checks counted `mpv.exe` **machine-wide**. `check:network` reported "FAILED: 4 orphaned" on an unchanged tree (all four another checkout's, 3 runs of 4, a hard red); `e2e-overlay` used a **delta**, so an unrelated mpv exiting cancelled a real orphan out | pids the app is an ancestor of, keyed by pid **and** creation time, with the two measured failures as unit-test fixtures |
| 44 | a header-only netlog (0 events) is the same shape as a clean run, and the only liveness gate was a line printed at module scope **before** `app.whenReady()`. 7 of 36 netlogs were header-only; 2 exited reporting success | a pass needs ≥8 events, `PROXY_CONFIG_CHANGED` **and** `QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS`, and three markers the app prints: `[ready]`, `[e2e]`, `[quit]` |
| 45 | `check:network` only ever opened a sample video — never the **settings window**, the app's only page with text inputs and the exact surface the gvt1 leak lived on | every launch opens it, through an env-only hook with the same three rules as the DNS blackhole override, enforced by a test |
| 46 | 0.1.1 told users to delete `%APPDATA%\RLPlayer\Dictionaries` **by hand**, and named none of the rest. The `Network Persistent State` records held the host, its round-trip time and the machine's public address; the HTTP disk cache held the 302 with `mip=<the user's public IPv6>` | `core/profile-cleanup` does it for them, once, before `app.whenReady()`, from a literal target list, never throwing, retrying a locked file next launch. Measured on a real profile: 5 artefacts, 25.1 MB, zero occurrences of the host left, user data byte-identical |
| 47 | `check:partition`'s prelude regex could not see **the first rule inside any at-rule**, and its name regex took only the **leftmost** token. `.bm-pin` in `@media` and `.seek-layer .thumb-preview`, both in core `styles.css`, both used only by two feature modules: reported clean, exit 0. 15 tokens in this repo were already unextractable, 7 in core `styles.css`. The self-check named 3 canaries, all of them leftmost and top-level | the CSS is parsed (postcss + a selector tokenizer in `scripts/lib/css.mjs`), every class and id in every selector is extracted, and the self-check runs over a fixture of **shapes** and fails if the `all` and `leftmost` views ever agree in size |
| 48 | `[e2e] settings window opened` was printed **synchronously** after `openSettingsWindow()`, and `ipc.ts` does `void settingsWindow.loadFile(…)` and returns before the page loads. With and without `RLPLAYER_E2E_OPEN_SETTINGS` the packaged app produced 11 netlog events and 53,435 bytes — **delta 0** — so the console line was the only evidence, and it was printed before the page existed. The same defect this round removed from `[no-network]` | the marker fires on `did-finish-load`, carries the row/section/text-field counts out of the rendered DOM, and the app dispatches real key events at a focused field first. `check:network` asserts on the counts (`rows >= 8`), and `scripts/lib/netlog.test.mjs` runs the gate against the old stdout |
| 49 | `core/profile-cleanup` v2 listed `Dictionaries` at the profile root while `sessionData` is `<root>\session`, so the 11,476,456-byte `ko-3-0.bdic` survived with the marker already at `CLEANUP_VERSION` — stranded permanently. And it listed `Cache`, which on NTFS is the `cache` that `cacheDir()` returns, so it deleted `thumbs/`, `scenes/`, `art/` and `jobs/`. Two of its tests could not reach either defect: the fixture built no session `Dictionaries` and no `cache/`, and its "nothing else is touched" proof searched for the string `gvt1`, which an 11 MB `.bdic` does not contain | a `session/` twin for every root target (asserted as a rule), `CLEANUP_VERSION` bumped so cleaned profiles retry, Chromium's cache moved to `httpcache/`, the legacy target narrowed to `Cache/Cache_Data`, and `appOwnedConflict()` refusing any target that touches app-owned paths. The test asserts on a **file inventory** |
| 50 | the test titled *"a LOCKED artefact leaves the marker unwritten"* took its handle with `fs.openSync(f, 'r+')`, which on Windows opens with `FILE_SHARE_DELETE`. The unlink always succeeded, so it always took the else branch and asserted the marker **was** written — the opposite of its title, for four rounds | a real `FileShare.None` handle held by another process. The invariant holds: EPERM, marker unwritten, retried next launch, no crash |
| 51 | `e2e-overlay.mjs` is the only check that asserts the settings page rendered, and it was **excluded from `ci.yml`** — that page is where all 38 Wave-1 modules land their descriptors. `check-network.mjs` also whitelisted `ws:` by scheme, so `ws://remote/` was not a violation | `e2e:overlay --packaged` runs in CI, with `make:sample` generating a playable file from `av://lavfi:` using the pinned mpv. `ws:`/`wss:` are judged by host like every other remote scheme |

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
      `docs/parity/modules.json`. `npm test` checks both directions. That
      includes anything you pass in `loadfile`'s options map, and anything you
      write behind an mpv prefix.
- [ ] Every mpv COMMAND only you may issue is in `ownsCommands` and in
      `modules.json`'s `ownedCommands`. A command is not a property; declaring
      it as one enforces nothing.
- [ ] Every property you write that you do **not** own goes through a mediator
      or `requestSet`, and is listed in `requestsProperties`.
- [ ] Settings, commands, IPC channels and i18n keys are all prefixed with your
      id.
- [ ] Keybind defaults use **physical** codes for all three presets.
- [ ] Every state-changing command fires an OSD message.
- [ ] Per-file state goes through a slice, never through your own JSON file.
- [ ] No import of `windows.ts`, `ipc.ts`, `preload/index.ts`, `core/mpv/*`,
      the renderer core, another feature module, or Electron's `dialog` — by
      `from`, by `require()`, by `await import()`, or by a computed specifier.
      `npm run check:forbidden` proves all four now; it only proved the first
      one before, and that is how a one-line ownership bypass shipped.
- [ ] No network API at all: no `fetch` (aliased or not), no `node:dns` /
      `https` / `tls` / `dgram` / `http2`, no `resolveHost`. If your module is
      the one that genuinely needs a host, add its `ALLOWLIST` row in
      `src/main/core/no-network.ts` in the same PR and use `ctx.network`.
- [ ] Your UI is a `ctx.panel()` / `ctx.statsSection()` / `ctx.seekbarLayer()` /
      `ctx.transportButton()` / `ctx.settingsSection()`, and your CSS is in your
      own directory. You did not touch `index.html`, `main.ts` or `styles.css`.
      `check:partition` is symbol-granular over HTML ids as well as CSS
      selectors now, and a comment no longer counts as a use.
- [ ] Your files are claimed by your row in `modules.json`.
      `npm run check:partition` proves it.
- [ ] Your renderer half declares everything its state subscriber closes over
      BEFORE it subscribes (§10).
- [ ] Your `dispose()` releases timers, watchers, sleep blockers and child
      processes.
- [ ] Any mpv command you issue that mutates state is in §2.2's table with an
      owner, or you are calling the owner's mediator. `['frame-step']` writes
      `pause`; `['ab-loop']` writes `ab-loop-a`; neither says so in its name.
      Every command in the pinned binary is classified (§2.1); if yours is not,
      that is a `modules.json` edit and a review, not a shrug.
- [ ] Every element of every command you send is a JSON value — string, finite
      number, boolean, `null`, or a flat object/array for `loadfile`'s options.
      An unrecognised shape used to disable every ownership check silently; it
      is a hard error now.
- [ ] You spawn a second mpv with `ctx.engine.spawn()`, never with
      `child_process` and a path. An untracked child is how "no orphan mpv on
      quit" stops being true.
- [ ] If your seek-bar layer has a `hitTest`, it also has `handles()` and
      `onKey()`. Rule 4 is enforceable now: a layer that is grabbable and not
      Tab-reachable is logged by name.
- [ ] `npm run verify` is green; `npm run e2e:overlay -- --packaged --presses=300`
      and `npm run e2e:resume` are clean **and report a quit time rather than a
      force-kill**; `npm run check:network` is clean on a packaged build **and
      with `--no-blackhole`**; and your §6.3 acceptance row is ticked in your
      module's `VERIFY.md`.
