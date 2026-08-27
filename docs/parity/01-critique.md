# 01 — Completeness critique of `00-parity-spec.md`

> **Status:** adversarial review. Written against the spec dated 2026-08-28.
> Nothing here is an opinion about priorities; every claim below was either executed
> against the pinned binary or read out of an authoritative artifact on this machine.
> Where I could not settle something I say so.

---

## 0. Method — what was actually executed

The spec is unusually verifiable, so I verified it instead of arguing with it.

| Source | How it was used |
|---|---|
| `resources/mpv/mpv.exe` — confirmed `v0.41.0-923-g7b8915bc1`, FFmpeg `N-126125`, the exact pinned build | `--list-properties` (1009 names), `--list-options` (1265), `--input-cmdlist` (86), `--vf=help`, `--af=help`, `--hwdec=help`, `--ao=help` |
| A live JSON-IPC harness over a Windows named pipe | ~120 `get_property` / `set_property` / command round-trips against a running mpv, including a real SRT and a real audio track |
| `C:\Program Files (x86)\DAUM\PotPlayer\Language\English.ini` | PotPlayer's **complete** menu tree with hotkeys (`[MenuString]`, 889 lines) and its **complete** preferences tree (`[StringTable]` ids 2055–2097). This is PotPlayer's own shipped string table, not a third-party wiki. |
| `HKCU\Software\DAUM\PotPlayer` | settles the P61 storage-location question |
| `src/` | traced three features end to end against the code that exists today |

**Headline:** the mpv mapping is far more accurate than a document of this size has any
right to be. Every one of the 131 JSON-form property names, all 25 `hwdec` values, all
~80 lavfi filter names, `--hwdec-codecs`, `--watch-later-options`, `--sub-auto-exts`,
`--ab-loop-count`'s `"inf"`, `--drag-and-drop=auto`, `--volume-max`, `--sub-outline-size`,
`--sub-back-color`, `--sub-ass-override=scale`, `--secondary-sub-ass-override=strip`,
`--input-doubleclick-time=300`, `--input-dragging-deadzone=3` — all confirmed exactly as
written. The bad mappings below are the exceptions, and they cluster in one place.

---

## 1. Bad mappings — 11 found

Ordered by how much time each will cost the implementer who copies it.

### 1.1 Copy-paste fatal

**BM-1 — `vf-command` is written with the wrong arity (V09, and by implication V38, §7.4 R-11).**

Spec V09 says:
```
live: {"command":["vf-command","rl-sharpen","strength","0.55"]}
```
Measured against the pinned build with `@rl-sharpen:lavfi=[cas=strength=0.4]` loaded:

| Form | Result |
|---|---|
| `["vf-command","rl-sharpen","strength","0.55"]` (3-arg, as specced) | **`error running command`** |
| `["vf-command","rl-sharpen","strength","0.55","cas"]` (4-arg) | `success` |

**Correct mapping:** `['vf-command','<label>','<option>','<value>','<lavfi-filter-name>']`
— identical in shape to the four-argument `af-command` rule the spec already states
correctly in A27 and repeats in §7.7 trap 4. The vf side simply did not get the same
treatment. `FilterChainService.command()` in §3.3.6 already has the right five-parameter
signature, so this is a documentation defect in V09 that will make the first implementer
conclude `vf-command` does not work at all and fall back to graph rebuilds.

**BM-2 — `unsharp` does not implement `process_command`; V08's live slider cannot work.**

Settles half of §7.4 **R-11**, which lists `hqdn3d`, `unsharp` and `deblock` as unknown.
Measured, all with the correct 4-arg form:

| lavfi filter | `vf-command` |
|---|---|
| `cas` | **success** |
| `eq` | **success** |
| `hqdn3d` | **success** |
| `deblock` | **success** |
| `v360` | **success** — this also settles **R-10**, see §5 |
| `unsharp` | **`error running command`** |

So V08 ("Sharpen (luma/chroma)", P1, `sm`) is the *only* enhancement filter that must
rebuild its graph on every slider tick. V09 already recommends making CAS the default and
hiding unsharp behind "classic" — that recommendation is now load-bearing, not stylistic,
and V08's row should say so.

**BM-3 — the `screenshot` reply is not always an absolute path (C01, C20).**

C01: `→ reply {"error":"success","data":{"filename":"<abs path actually written>"}}`
C20: "The `screenshot` command's reply data is `{"filename":"<abs path>"}`"

Measured with `screenshot-directory` **unset**:
```
["screenshot","video"] → {"filename":"mpv-shot0002.jpg"}
```
A bare relative name, resolved against **mpv's** cwd, not ours. With
`screenshot-directory` set it does return the absolute path
(`{"filename":"C:/…/shots/rlcritic_…_01.jpg"}`).

The spec's own advice — "**Use the reported filename, never one you construct**" — is
right, but it silently depends on a precondition it never states. `shell.showItemInFolder(r.filename)`
in C20 and the toast in C20 both break on first run if the module has not yet written
`screenshot-directory`. **Correct mapping:** M22 must set `screenshot-directory`
unconditionally at `setup()` before any screenshot can be taken, and treat a
non-absolute reply as a bug to log, not a path to use.

**BM-4 — `screenshot` with `scaled` or `window` requires a live VO (C04).**

C04 presents `["screenshot","scaled+subtitles"]` and `["screenshot","window"]` as
straightforward. Both return **`error running command`** when no window-backed VO is
open. `["screenshot","video"]` succeeds in the same state. This matters because two
shipped states have no VO surface to grab: audio-only playback with the video window
hidden (A38, M11) and tray-only mode (U39, M32). C04's row needs the failure mode and a
fallback to `video`, or the capture menu items must be disabled in those states.

### 1.2 Wrong claims that will misdirect design

**BM-5 — `--tone-mapping-max-boost` is *not* removed or deprecated (§1.6, V32).**

Both §1.6 and V32 state that `--tone-mapping-max-boost`, `--tone-mapping-desaturate` and
`--tone-mapping-desaturate-exponent` "are removed or deprecated under gpu-next" and
conclude **"Do not build UI on any of the four."** Actual `--list-options` output:

```
--tone-mapping-desaturate            removed [deprecated]
--tone-mapping-desaturate-exponent   removed [deprecated]
--tone-mapping-max-boost             Float (1 to 10) (default: 1)
```

`set_property tone-mapping-max-boost 2.0` returns `success` over IPC. Two of the four are
genuinely dead; `--tone-mapping-mode` genuinely does not exist (`property not found`,
confirmed); **`--tone-mapping-max-boost` is live and settable.** It is also the single
most useful HDR knob after the curve itself, so blanket-banning it costs a real feature.
Correct the sentence to name three, not four.

**BM-6 — `--gamma-factor` is not deprecated (V02).**

V02's trap: "Do **not** use `--gamma-factor` / `--gamma-auto`: both deprecated-by-design
under gpu-next." Actual:
```
--gamma-auto     Flag (default: no) [deprecated]
--gamma-factor   Float (0.1 to 2) (default: 1)
```
Only `--gamma-auto` carries the marker. The advice to use the `gamma` property instead is
still fine; the justification is wrong, and a reader who checks will stop trusting the
other traps.

**BM-7 — `ewa_lanczossoft` and `haasnsoft` are still in the enum (V44).**

V44: "Under gpu-next `ewa_lanczossoft` and `haasnsoft` were **removed** — do not offer
them." Both appear verbatim in this build's `--scale`, `--dscale` and `--cscale` choice
lists. Whatever gpu-next does with them internally, **the option parser accepts them**,
which means any scaler dropdown generated from the enum (the obvious implementation) will
show them. The row needs to say "filter them out of the enum", not "they were removed" —
otherwise M06 generates the list from mpv and ships two dead entries.

**BM-8 — nothing validates `--audio-spdif` (A20).**

A20: "`--audio-spdif=ac3,dts-hd,eac3,truehd` (only these five names are accepted)".
Two problems. First, four names are listed under the word "five". Second and worse,
`audio-spdif` is `String (default: )` — a plain string. Both
`mpv --audio-spdif=atmos` and `set_property audio-spdif "ac3,atmos"` succeed silently.
There is **no validation at all**, so a typo does not error, it just disables passthrough
for that codec while the UI shows it as on. Given that R-13 already says passthrough could
not be verified end to end, M15 must validate the list itself against
`ac3,dts,dts-hd,eac3,truehd` before writing.

**BM-9 — `loadfile` without `-1` errors, it does not silently drop (N41, R01, §7.7 trap 2).**

Stated three times as "the map is parsed as an insertion index and **silently dropped**"
/ "and dropped". Measured:
```
["loadfile", path, "replace", {"start":"9.5"}]   → {"error":"invalid parameter"}
["loadfile", path, "replace", -1, {"start":"5.5"}] → {"playlist_entry_id":2}, lands at 5.5
```
The remedy is right and important. The *symptom* is wrong, and that costs debugging time:
an implementer told to expect silence will not check the reply, will see the file not load
at all, and will look for the bug somewhere else entirely.

### 1.3 Understatements

**BM-10 — `--video-margin-ratio-left` and `-right` exist (V27, V28).**

V27 says extend presets need "`video-margin-ratio-top` and `-bottom` (no mpv `pad`
property exists)". All four exist and are settable (`set_property video-margin-ratio-left 0.1`
→ `success`):
```
--video-margin-ratio-bottom / -left / -right / -top   Float (0 to 1) (default: 0)
```
This matters because PotPlayer's *Frame Size* menu has **Increase/Decrease Top, Left,
Bottom and Right Margin** plus "Operate margin changes only in fullscreen" — overscan
correction for TV output. The spec has no row for it and believes half the primitive is
missing. It is a `triv` row for M02.

**BM-11 — `--cover-art-whitelist` is presented as the default but is not (L28).**

Spec: `--cover-art-whitelist=cover,front,folder,AlbumArt,Album,AlbumArtSmall,.folder,thumb`
Actual default read over IPC:
`["AlbumArt","Album","cover","front","AlbumArtSmall","Folder",".folder","thumb"]`
Same set, different order, and `Folder` is capitalised upstream. Harmless on NTFS, but the
row reads as if it were quoting mpv, and it is not. If it is a deliberate reorder, say so.

### 1.4 Claims I re-tested and confirmed (so nobody re-litigates them)

`vf add` with an existing label replaces **in place**, preserving chain position ✓ ·
`@label:!lavfi=[…]` disables in place and survives `vf set`/`af set` ✓ ·
`af-command` 3-arg fails, 4-arg works ✓ · `loudnorm`, `pan`, `superequalizer` reject
`af-command` while `volume`, `dynaudnorm`, `dialoguenhance`, `crossfeed`, `crystalizer`,
`acompressor`, `bass`, `stereotools` accept it ✓ · `stereotools mlev=0` fails,
`0.015625` works ✓ · `mute_l` fails, `mutel` works ✓ · `v360 input=c2x3` fails,
`eac` works ✓ · Windows absolute paths inside lavfi options fail ✓ ·
`ab-loop-a` clears to the **string** `"no"` ✓ · `editions` is `unavailable`, not `0` ✓ ·
`discnav` is absent from this build ✓ · `screenshot-to-file` rejects `scaled` ✓ ·
`sub-text/ass`, `sub-text/ass-full`, `sub-start/full`, `sub-end/full` all exist ✓ ·
auto-inserted `scaletempo2` stays invisible in `af` at `speed=1.5` and `pitch=1.06`, so
`af set` cannot delete it ✓ · `dump-cache` fails with the default cache ✓ ·
the `async` command prefix works over JSON IPC ✓ · `--ao=help` lists only
wasapi/openal/null/pcm ✓ · §1.1's arithmetic reconciles exactly with Appendix B ✓.

---

## 2. Missing features

Diffed against PotPlayer's own shipped menu tree and preferences tree. I am listing only
things that are **absent from the matrix, absent from §1.3, and absent from §2.10** —
i.e. genuine gaps, not declines.

### 2.1 The two that should worry you

**MF-1 — Skip Intro / Skip Ending. Belongs in M25 (`nav-chapters`), and it is P1, not P2.**

PotPlayer ships this as a first-class, keybound feature:
```
101_0_9_8   = Skip
101_0_9_8_0 = Enable skip feature      Shift+'
101_0_9_8_1 = Skip Intro %s
101_0_9_8_2 = Skip Ending %s
101_0_9_8_3 = Skip chapter(s)
101_0_9_8_5 = Skip Setup...            '
```
Two dedicated keys and its own setup dialog. The spec's nearest row is **N08
"Auto-skip chapters by title (OP/ED)", P2**, which is a *different mechanism*:
chapter-title regex matching. PotPlayer's is **time-based** — skip the first N seconds
and the last M seconds of every file in a series — which is precisely what works on
Korean drama and anime rips that have no chapter markers at all. N08 as specified would
do nothing on the files this feature exists for.

This is pure app code (`observe time-pos`, two numbers per series folder, one OSD with an
undo), so it is `sm` at most, and it targets exactly the binge-watching audience the
project is aimed at. It also inherits N08's correct trap: off by default, always show the
undo. **Add it as a sibling row to N08 and promote both to P1.**

**MF-2 — Image / slideshow playback is missing entirely, yet P30 registers image file associations.**

P30 seeds the extension picker with a full image category
(`avif,bmp,gif,heic,heif,j2k,jp2,jpeg,jpg,jxl,png,qoi,svg,tga,tif,tiff,webp`) and the
truncated trap begins "**Ship the image category unch…**". PotPlayer has:
```
101_0_6_6 = Slideshow
101_0_6_8 = Jump to previous slide
101_0_6_9 = Jump to next slide
```
There is **no feature row anywhere in §2 for opening an image**. So as specified, RLPlayer
would claim `.jpg` in Windows' Default Apps and then have no defined behaviour when
Explorer hands it one. That is worse than not registering the type.

mpv supports this directly — `--image-display-duration` exists (`Double (0 to inf) (default: 5)`,
confirmed) and images already flow through the normal `loadfile` path. The work is a
playlist mode plus a duration setting. **Either add a P1 row to M28 (`playlist`) with
`--image-display-duration`, or remove the image category from P30 and say in §1.3 that we
are not an image viewer.** Shipping the association without the feature is the one option
that is indefensible.

### 2.2 Real gaps, smaller

| # | Missing | Evidence from PotPlayer | Where it belongs |
|---|---|---|---|
| MF-3 | **Embedded ASS font attachments** and a user font directory | Preferences node `2080=Font Style`; PotPlayer exposes "use embedded fonts" | **M19** `subs-style`. mpv has `--embeddedfonts` (default `yes`, confirmed) and `--sub-fonts-dir`. Default is already right, but the *setting* is absent, and on a fansub-heavy library "why is the typeface wrong" is a support ticket with a one-checkbox answer. |
| MF-4 | **Closed captions (CEA-608/708) as a subtitle source** | Korean broadcast TS recordings carry them in-stream | **M17** `subs-tracks`. mpv has `--sub-create-cc-track` (confirmed, default `no`). S01's format list — 12 formats — does not mention captions at all. For the "IPTV/OTA TS is a heavy Korean use case" risk flagged in §7.8, this is the missing engine feature, and it is one boolean. |
| MF-5 | **VSFilter colour compatibility** | Old Korean SMI→ASS and older fansub files render with shifted colours without it | **M19**. `--sub-ass-vsfilter-color-compat` (`no\|basic\|full\|force-601`, default `basic`, confirmed). Not mentioned anywhere. |
| MF-6 | **Named jump targets** — start / middle / 30 s before end | `101_0_9_6_14/15/16` = `BackSpace`, `Ctrl+BackSpace`, `Shift+BackSpace` | **M24** `nav-seek`. Three lines of code, three real keys in the potplayer preset that currently map to nothing. |
| MF-7 | **System volume control**, distinct from player volume | `101_0_12_9` System Volume: master ±, master mute, wave ±, wave mute (`Ctrl+Alt+Shift+↑/↓`, `Ctrl+Alt+↑/↓`); plus `Shift+↑/↓` master volume | **M33** `shell-system` (it already owns process-global registrations). Not in the matrix. Needs a native/PowerShell path, so it is a legitimate P2 — but it should be *listed*. |
| MF-8 | **Favorites**, separate from playlists | `101_0_3` Album/Favorites: Add Current Item (`Alt+Insert`), Add Current Folder (`Ctrl+Insert`), Edit Favorites | **M28**. L37 covers "multiple named playlists (Albums)" at P2 but Favorites is a different, cheaper concept — one list, two keys, no manager UI required. |
| MF-9 | **Playback queue**, separate from the playlist | `101_0_9_9_2` / `111_0_5`: Add to playback queue (`Q` in the playlist window), Clear playback queue | **M28**. L37's schema reserves a `'__queue__'` key, which suggests someone knew — but there is no feature row, so the reserved key has no owner and no behaviour. |
| MF-10 | **Sleep timer / playback-finished action** | `101_0_15_4` (Exit / Shut down / Sleep / Hibernate), `101_0_15_8` "Shutdown at %s", `101_0_15_9` "Shutdown in %s" | N47 says "Never auto-quit. Never auto-shutdown the PC" — that is a decision, and a defensible one for shutdown. But it is **not recorded in §1.3 or §2.10**, and it lumps in the benign half: "stop playback after 45 minutes" is a bedtime feature with no support-ticket risk. Split the row and record the decline. |
| MF-11 | **Winamp DSP plugin hosting** | Preferences node `2094=Winamp DSP Plugins` | Not in the matrix and **not in the declined register**, even though its exact twin — "DirectShow DSP hosting" — *is* declined in §2.10 D. Add one line so the register is complete. |
| MF-12 | **Auto-rotate by aspect ratio** | `101_0_11_11_5/6` "Auto rotate 0/90 (and 180/270) degrees according to AR" | **M02**. Portrait phone video on a landscape monitor. Free given V29. |
| MF-13 | **Three fullscreen modes** | `Enter` Keep AR · `Ctrl+Enter` Stretch · `Ctrl+Alt+Enter` Stretch keeping AR — plus `Shift+Enter` Desktop Mode | **M31**. U08 has exactly one fullscreen. The stretch variants are a two-line combination of U08 and V23 and they are muscle memory for the `Ctrl+Enter` crowd. Desktop Mode (video as wallpaper) is fine to decline — but record it. |
| MF-14 | **"Delete the last saved frame"** | `101_0_11_12_26` | **M22**. Trivial, and a genuinely nice touch after a burst capture. |
| MF-15 | **Three-level info OSD** | `Tab` full playback/tag info · `Shift+Tab` short info · `Scroll Lock` misc info | **M29**. U06/L23 give one stats surface; PotPlayer's tiered model (glance / detail) is better and the spec has no row for the short form. |
| MF-16 | **"Add together similar files to playlist"** on open | `101_0_15_5`: only-selected / similar / all | **M28**. L02 always scans the whole folder. "Similar" (same series prefix) is what stops a 400-file anime folder from becoming your queue when you double-click one episode. |

### 2.3 Korean-market check

The SMI work (S03–S06), CP949/uchardet (S33/S34), `slang=ko,kor` (S13/P52), 초성 search
(P02) and the 조사 helper (P47) are the strongest part of the document and I found nothing
wrong with any of them. The gaps are **MF-4 (CEA-608/708 in broadcast TS)** and
**MF-5 (VSFilter colour compat)**, both engine-side one-liners, plus the observation that
§7.8's own "Korean-market assumptions may not survive contact" row about IPTV/OTA TS
already anticipates MF-4 without naming it.

---

## 3. Partition holes

I traced three features end to end. All three hit the same wall.

### PH-1 — **Nothing enforces mpv property ownership. The entire §3.6 table is prose.** (Critical)

This is the most serious hole in the document.

§3.5 lists what `core/registry` guarantees: id-equals-directory, topological setup,
namespace enforcement for **settings / commands / IPC channels / i18n keys**, duplicate
detection for those **plus filter labels**, isolation, teardown. The vf/af chains get real
machinery — reserved labels, declared in §5.5, "unregistered labels throw at boot".

But `MpvService.set(name, value)` (§3.3.1) is completely unrestricted. There is no
allowlist, no ownership check, no boot-time collision detection for properties. Meanwhile
§3.6's "Must NOT touch" column — the thing the whole 40-way fan-out rests on — is 40 rows
of English. The spec's own §0.2 rule 5 correctly identifies uncontrolled `vf`/`af` as
"the single most likely way for two modules to silently destroy each other's work" and
then builds a registry for it. Every other property gets nothing.

And the spec itself already contains three violations of its own table:

1. **`aid` has three writers.** M11 owns audio tracks (A10–A12). But **A20 (M15)**
   bitstream passthrough is specified as `['set_property','aid','no']` → `['set_property','aid',prevId]`
   to force a chain reinit, and **A36 (M13)** says `--ad-lavc-ac3drc` "takes effect on next
   decoder init — pair with the aid round-trip". Three modules, one property, no arbitration.
   Worse, M11 also registers a per-file slice that restores `aid` on `playback-restart`
   (A44) — so an M15 round-trip that races M11's restore will select the wrong dub.
2. **`sub-reload` has three writers and a self-contradiction.** M18's "Must NOT touch"
   column reads "anything mpv-stateful **except `sub-codepage` + `sub-reload`**", i.e.
   M18 owns it. But **S12 "Reload subtitle / auto-reload on change" is assigned to M17**
   and its entire mapping is `{"command":["sub-reload"]}` plus an `fs.watch` loop, and
   **S22 (M19)** says "issue `sub-reload` afterwards for external tracks". The spec
   contradicts itself inside two pages.
3. **`vid` has no owner at all.** **A38 (M11)** writes `vid=no` for background playback.
   **R08 (M36)** switches `vid`/`aid` to pick a yt-dlp format. **P49 (`core/per-file`)**
   persists and restores `vid` because it is in mpv's `--watch-later-options` default
   (which the spec adopts verbatim — I confirmed the list matches). Three writers, zero
   rows in the "who owns this" table.

**Fix:** extend the registry the same way the filter chains already are. Have each module
declare `ownsProperties: readonly string[]` in its `FeatureModule`; have
`MpvService.set()` reject a write to a property another module declared; have two modules
declaring the same property throw at boot with both names. That converts §3.6 from
documentation into CI. It is maybe a day of Wave-0 work and it is the difference between
"40 people can work in parallel" and "40 people believe they can work in parallel".

### PH-2 — **`core/per-file` restores `vf` and `af` behind the chain owners' backs.** (High)

P49 adopts mpv's `--watch-later-options` default **verbatim**, and I confirmed that list
contains `vf` and `af`. So on every `playback-restart` the per-file service can write a raw
`vf` / `af` string — which is exactly the raw command §0.2 rule 5 forbids every module from
issuing, and which will silently overwrite whatever `core/vf-chain` believes the chain to
be. `PerFileService.slice()` gives modules a `capture`/`apply` pair, so the chains *could*
own their own slices — but P49's canonical list, adopted as-is, bypasses that. **Strike
`vf` and `af` from the P49 list explicitly and let the two chain owners register slices.**

### PH-3 — **`FeatureContext` has no window service; M31, M32 and M33 must all edit `windows.ts`.** (High)

Traced end to end: **U07 always-on-top** → needs `mainWindow.setAlwaysOnTop(on,'floating')`
*and* `rendererWindow.setAlwaysOnTop(on,'pop-up-menu')`. **U08 fullscreen** → `setFullScreen`.
**U15 fit-to-video** → `setContentSize` + work-area clamp. **U26/U27 taskbar** →
`setThumbarButtons` / `setProgressBar` on the main window. **U41** → `showInactive()`.

`FeatureContext` (§3.3) exposes `log, paths, mpv, settings, commands, ipc, osd, perFile,
menu, i18n, lifecycle, vf?, af?`. **There is no window handle and no window service.**

Today `src/main/windows.ts` (414 lines) already exports exactly what these modules need:
`getVideoWindow()`, `getUiWindow()`, `getMpvHostWindow()`, `setAlwaysOnTop()`,
`setFullScreen()`, `toggleFullScreen()`, `toggleMaximize()`, `beginDrag()`,
`persistBounds()`, `clampToDisplay()`, `syncOverlay()`, `setVideoRegion()`. And the spec
*requires* modules to extend it: **U17**'s trap says of `persistBounds`/`clampToDisplay`
"**extend it, do not duplicate it**", and §5.9 assigns `beginDrag()`'s Aero Snap defect to
Wave 0 without saying who owns the file afterwards.

Net effect: **M31 (24 features, 8 of them P0), M32 (7 features) and M33 (U41) all edit one
414-line file**, which is precisely the collision §3.0 promises to eliminate — and
`windows.ts` is not even on §3.0's list of six forbidden files. Add a `WindowService` to
`FeatureContext` (main window, overlay window, work-area helpers, bounds persistence,
fullscreen/ontop/aspect primitives) or M31 becomes a serialisation point for the whole
shell area.

### PH-4 — **`seekbarLayer` is render-only; N19 (P0) cannot be built through it.** (High)

§3.4: `seekbarLayer({ id, order, render(ctx: { el, duration, width }) })`. Render only.
No pointer events, no hit-testing, no drag contract.

**N19 "Loop region drawn on the seek bar" is P0** and its mapping says "**dragging a
handle sets `ab-loop-a`/`-b`**". **N13** bookmark pins want click-to-seek. **N30**
drag-to-scrub is M24's. So three modules need pointer interaction on one bar and the API
gives none of them a way to get it. Either the layer contract grows
`onPointerDown/Move/Up` with an ordered hit-test, or M26 reaches into the core seek-bar
host — the same collision, one directory over. This one blocks a P0 feature, so it has to
be settled in Wave 0, not discovered in Wave 1.

### PH-5 — **Two P1 modules contribute the same spawn arg, and the registry will not catch it.** (Medium)

§3.3.1: "A module returning an arg **core** already owns throws." Only core-owned args are
protected. Feature-vs-feature collisions are unhandled — and there is already one:

- **V33 (M05, HDR passthrough)** contributes `--d3d11-output-format=rgba16f --d3d11-output-csp=pq`
- **V36 (M06, 10-bit output/dither)** contributes `--d3d11-output-format=rgb10_a2`

Same option, two owners, both P1, mutually exclusive values, silent last-one-wins. There is
a second, softer case: **V19 (M04)** says to "pass a larger `--hwdec-extra-frames` at
spawn" while **M07** owns everything `hwdec`. Make `contributeArgs` reject *any* duplicate
option name across all contributors, not just core's.

### PH-6 — **The legacy `Player` class and `ipc.ts` action table are never retired.** (Medium)

`src/main/ipc.ts` dispatches 22 string actions — `volume`, `mute`, `speed`, `speedReset`,
`frameBack`, `frameForward`, `screenshot`, `screenshotClipboard`, `toggleSubs`, `cycleSub`,
`cycleAudio`, `subDelay`, `audioDelay`, `chapterNext`, `chapterPrev`, `next`, `previous`,
`fullscreen`, `alwaysOnTop`, `togglePlaylist`, `seek`, `stop` — all routed through the
578-line `Player` class.

**Every single one of those 22 is claimed by a Wave-1 module** (M10, M24, M22, M17, M20,
M25, M28, M31). §5.9's `ipc.ts` row lists only four small fixes and never says the legacy
dispatch is deleted, migrated, or frozen. So after Wave 1, `volume` has two writers
(`Player` and M10), `chapter` has two (`Player` and M25), `sid` has two, and so on — with
the legacy path still wired to the existing renderer and the existing keybinds. §3.5's
duplicate detection does not see it, because `Player` is not a module.

**Wave 0 must state the migration explicitly:** either the legacy actions become thin
`ctx.commands.invoke()` shims, or they are deleted and the renderer is repointed. Leaving
it unstated means the first two modules to land silently fight the code that is already
running.

### PH-7 — Smaller API holes

- **No `dialog` service.** M22 (C05 folder picker), M28 (L12 add-folder, L13 open-playlist),
  M40 (P42/P43 import/export) all need `dialog.showOpenDialog`. `paths` is provided;
  `dialog` is not. Main-process modules can import Electron directly, but then the context
  is not "the whole surface a module is allowed to touch" as §3.3 claims.
- **`statsSection.fields()` has no refresh contract** — it returns a static array. M29
  polls at some cadence that is never specified, so every contributor guesses.
- **`MenuService.contribute({ replaces })`** is the only escape hatch for the two legacy
  `menu.ts` entries (C23 flags this), but nothing enumerates what legacy ids exist, so
  `replaces` is unusable without reading `menu.ts` — a forbidden file.
- **The number-key conflict is undetected.** N33 binds 1–9 to percent-seek; in PotPlayer
  ``` ` 1 2 3 4 5 6 7 8 9 0 ``` are **window sizes** (`101_0_19`). P15's conflict detector is
  scope-aware within our own registry but cannot know that the `potplayer` preset is
  claiming keys N33 also wants. Someone must resolve it by hand before the preset ships.

---

## 4. Effort corrections

### Under-estimated

| Row | Spec | Reality |
|---|---|---|
| **V08 Sharpen** | `sm`, live sliders implied | `unsharp` rejects `vf-command` (BM-2). Every drag rebuilds the graph and forces an hwdec copy-back on a 4K frame. Either accept on-release-only, or make CAS the only sharpener. Keep `sm` but write the constraint into the row. |
| **A20 Bitstream passthrough** | `md` | Correctly flagged unverifiable in R-13, but the *effort* ignores what §3 requires: it must round-trip `aid` (a property M11 owns — PH-1), coordinate with M15's AO reinit, disable EQ/normalizer/boost/volume across four other modules, and show that in the UI. It is `lg`, and it is blocked on hardware. **Do not schedule it into a release before someone has a receiver.** |
| **N36 Seek thumbnails** | `lg` | Correct at `lg`, but the estimate does not carry **D-5** (lifecycle) or **R-19** (BGRA swizzle) as blockers, and L30 + N38 + N14 + N43 all silently depend on the same engine. M27 is four features' critical path, not one. It should land in landing-order group 2, not "everything else". |
| **S35/S36 OpenSubtitles** | `md` each | Also correct in isolation, but the pair carries the **consent gate, the network-monitor CI test, credential storage via `safeStorage`, rate-limit handling, quota display, D-8 (whose API key)** — and D-8 is unresolved. At P2 that is fine. The risk is that "md" reads as schedulable. |
| **P14 keybinding presets** | `md` | See §5 — the `potplayer` preset is wronger than the spec believes, and PotPlayer's real map is ~500 bindings deep. `md` for the mechanism is right; budget separately for transcription. |

### Over-estimated — genuinely cheaper than stated

| Row | Spec | Reality |
|---|---|---|
| **V38 360° look-around** | `lg`, "the entire 360 look-around depends on" R-10 | **R-10 is settled: `v360` accepts `vf-command`.** `["vf-command","<label>","yaw","20","v360"]` returns `success`. No bundled GLSL reprojection shader is needed. The spec's own text says this "is the difference between `sm` and `lg`" — so **V38 drops to `sm`** and the bundled-shader plan can be deleted. (Caveat: v360 rebuilds its projection maps per command, so measure the frame cost before promising smooth dragging.) |
| **N25 Frame-step backward** | `sm`, "the hard one" | Overstated relative to the others here. `frame-back-step` exists, `["frame-step",-10,"seek"]` and `["frame-step",N,"mute"]` all return `success`, and the one real trap — the reply arrives before the position moves — is already correctly documented and already solved by the property bus every other module uses. This is `triv`-to-`sm`. The genuinely hard case is the one the spec correctly quotes mpv's manual on: VFR. |
| **C22 Capture keybindings** | `triv`, "**Source uncertainty, stated plainly**… Verify the four keys against a live PotPlayer install before freezing the preset" | **Settled, all eight, from PotPlayer's own string table.** `Ctrl+E` Save Current Source Frame · `Ctrl+C` Copy Current Source Frame to Clipboard · `Ctrl+Alt+E` Save Current Screen Frame · `Ctrl+Alt+C` Copy Current Screen Frame · `Alt+N` Create Thumbnail Image · `Ctrl+G` Capture Consecutive Images · `Alt+C` Record Video · `Shift+G` Record Audio. The spec's guessed preset is **8/8 correct**. Delete the uncertainty note. |
| **U13/U16 window presets & aspect lock** | blocked on R-18 ("**Every window-size preset and the aspect lock depend on it**") | **R-18 is settled.** Measured: 320×240 source, `set video-rotate 90` → `video-out-params` returns `dw:240, dh:320`. `dw`/`dh` **do** account for rotation. No dw/dh swap logic is needed. |
| **V27 Extend presets** | `sm`, believed to need a nonexistent `pad` | All four `--video-margin-ratio-*` exist (BM-10). `triv`. |

---

## 5. Open items I settled for free

Retire these from §7.4 and §7.8:

| Item | Verdict |
|---|---|
| **R-10** `v360` `process_command`? | **Yes.** V38 drops from `lg` to `sm`; no bundled shader. |
| **R-11** which lavfi filters take `vf-command`? | `cas` ✓ `eq` ✓ `hqdn3d` ✓ `deblock` ✓ `v360` ✓ — **`unsharp` ✗**. And the arity is four arguments, not three (BM-1). |
| **R-18** does `video-out-params/dw`/`dh` account for `video-rotate`? | **Yes**, measured. |
| **§7.8** "PotPlayer keybind preset accuracy… three bindings in the current preset are wrong" | **Understated by a factor of three.** Against PotPlayer's shipped `[MenuString]` table, `src/shared/keybinds.ts`'s `POTPLAYER_PRESET` has at least **ten** wrong entries: `F`→fullscreen (PotPlayer: F = **Next frame**; fullscreen is **Enter**), `D`→frameForward (PotPlayer: D = **Previous** frame), `,`/`.`→frame step (PotPlayer: those are **subtitle sync** ±), `S`→screenshot (PotPlayer: S = **Pixel Shaders** menu), `L`→togglePlaylist (PotPlayer: L = **Add/Select Subtitles**; playlist is **F6**), `T`→alwaysOnTop (PotPlayer: **Ctrl+T**), `Home`/`End`→seekStart/seekEnd (PotPlayer: **previous/next subtitle position**; start-of-file is **BackSpace**), `Ctrl+Q`→quit (PotPlayer: Ctrl+Q = **Extend/Crop Video**). Only `M`, `C`, `X`, `Z`, `Ctrl+C` and `Escape` are right. |
| **§2.9 P14** "Verified PotPlayer keys" list | Two errors in the spec's own list. **`F7` is "Control Panel…", not "Equalizer"** (the equalizer is a tab inside it; the equalizer toggle is `Shift+E`). **`Q` is "Disable/Last used Color Controls", not "speed/quality reset"** — speed reset is **`Z`**. Note that V03 states the `Q` mapping **correctly**, so P14 contradicts V03 two hundred lines later. |
| **P61 / §2.10** "PotPlayer stores settings under `HKCU\Software\DAUM\PotPlayerMini64`" | On this machine the key is **`HKCU\Software\DAUM\PotPlayer`**, with subkeys `Settings`, `Positions`, `BMItem_0`, `ExtensionSection`, `_UrlCookie`, `_UrlHeader`, `_UrlReferer`, `_UrlUserAgent`. The path depends on which build is installed, so **probe both** rather than hardcoding either. `BMItem_0` is where bookmarks live, which is worth knowing before declaring `.pbf` import impossible. |

---

## 6. Verdict on the verdict

**Is §1.1's arithmetic honest? Yes.** I checked it. 418 − 12 = 406; the per-area P0/P1/P2/skip
columns sum to 115/155/126/10; Appendix B reconciles row-for-row with §2. That is rarer
than it should be and it deserves saying.

**Is §1.1's *claim* honest? No — the denominator is doing work the text does not admit to.**

> "We are shipping roughly 27% of PotPlayer's surface as v1.0, and about 66% of it if every P1 lands."

406 is not PotPlayer's surface. It is *our backlog*, and it differs from PotPlayer's surface
in two directions at once:

1. **72 infeasible items are excluded from the denominator** (§1.1 lists them
   "*(separately)*"). They are real PotPlayer features we will never have. Counting parity
   against a denominator with the known losses removed inflates the ratio. The honest
   denominator is 406 + 72 = 478, which turns 27% into **24%** and 66% into **56%**.
2. **The numerator contains rows PotPlayer has no counterpart for.** Of the 115 P0 rows,
   roughly sixteen are RLPlayer's own plumbing or positioning, not parity: V56 and A26/A27
   (the filter-chain registries), P03/P07/P08/P09/P11 (settings registry, schema versioning,
   migrations, downgrade guard, fsync), P16 (IME-safe accelerators), P33 (the no-hijack CI
   test), P36/P37/P38 (portable mode), P45/P46 (i18n infrastructure), P60 (there is no
   updater, and the *absence* is the feature). Every one is worth building. None of them
   moves a switcher one step closer to feeling at home.

Net: v1.0 delivers something closer to **~20% of what PotPlayer does**, not 27%. The
document that opens with "**The honest number**" should be the one that says so.

**The rest of the framing survives scrutiny, and one part of it is better than advertised.**
§1.2's argument — that the 291 non-P0 rows are overwhelmingly *variations* — is correct;
I read PotPlayer's real menu tree and it is exactly nine denoisers, twenty-three anaglyph
modes and fifteen DirectShow renderers. §1.3's declines are honest and mostly complete
(gaps: MF-10 sleep timer, MF-11 Winamp DSP, Desktop Mode). §1.4's four differentiators are
real, and the SMI work in particular is the most rigorous thing in the document.

**What I would change before anyone writes code:**

1. **Fix BM-1 (`vf-command` arity) today.** It is one line and it is in the row the first
   video implementer will open.
2. **Build PH-1 into Wave 0.** Property ownership must be machinery, not a table. Without
   it the 40-way fan-out is a hope. `aid`, `sub-reload` and `vid` are already broken *on
   paper*, before anyone has typed anything.
3. **Settle PH-3 (WindowService) and PH-4 (seek-bar pointer events) before Wave 1.** PH-4
   blocks a P0 feature; PH-3 makes M31 a bottleneck for a quarter of the shell area.
4. **Answer MF-2.** Either ship image playback or stop registering image extensions. The
   current spec does the second half of a feature it never specified.
5. **Restate §1.1 with the 478 denominator** and mark the ~16 infrastructure P0 rows.
   The project's entire pitch is that it does not lie to you. The scope section is the
   worst possible place to round in your own favour.
