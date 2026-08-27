# RLPlayer — PotPlayer Parity Implementation Spec

> **Status:** authoritative. This document supersedes the per-area research notes for
> anything an implementer needs to do. `docs/01-feature-research.md` explains *why*
> we are building this, `docs/02-competitor-analysis.md` explains *what everyone else
> got wrong*, `docs/03-architecture.md` explains *how the window topology works*.
> This is the only document you need open while writing code.
>
> **Engine baseline:** the pinned build is mpv `v0.41.0-923-g7b8915bc1` (shinchiro,
> 2026-08-14, GPL, libass 0.17.5-4, FFmpeg N-126125, libcurl, uchardet, dvdnav,
> libbluray, libavdevice). Every mapping below was verified against **that binary**
> unless the row says otherwise.
>
> **Revision 2 — 2026-08-28.** This revision applies `01-critique.md` in full. It is a
> revision of the same document, not a replacement: section numbering and structure are
> unchanged, and where a claim was wrong the correction says so in place rather than
> quietly editing history, so anyone who read revision 1 can see what moved.
>
> What changed, in one screen:
> - **11 bad mpv mappings corrected** — `vf-command` is **four** arguments (V09, V38, §5.5,
>   §7.7); `unsharp` refuses it entirely and must rebuild its chain (V08); `screenshot`
>   returns a **bare relative filename** unless `screenshot-directory` is set first, now an
>   explicit precondition (C01, C04, C05, C08, C20); `loadfile` without `-1` **hard-errors**
>   rather than dropping the map (N41, R01, §7.7). Four options were wrongly declared
>   dead — `--tone-mapping-max-boost` is **live** (§1.6, V32), `--gamma-factor` is **not**
>   deprecated (V02), `ewa_lanczossoft` and `haasnsoft` are **still in the enum** and must
>   be filtered out rather than assumed absent (V44). Plus A20, V27/V28, L28.
> - **Four partition holes closed in the API**, not in prose: mpv property ownership is now
>   declared, boot-checked and enforced by `ctx.mpv.set()` (§3.7, §0.2 rule 6);
>   `FeatureContext` gained a **`WindowService`** so M31/M32/M33 stop sharing `windows.ts`
>   (§3.3.7); `seekbarLayer` is **interactive**, which is what N19 — a P0 — needs (§3.4);
>   and the legacy `Player` / `ipc.ts` 22-action table has a written migration and a shim
>   with an expiry date enforced in CI (§5.10).
> - **16 missing features added**, led by **N51 skip intro/ending** (time-based, for the
>   markerless files N08's chapter-regex does nothing for) and **L47 image & slideshow
>   playback** (P30 was registering image associations for a feature with no row anywhere).
> - **Three open items settled by measurement** and struck from §7.4: R-10 (`v360` does take
>   `vf-command`; V38 drops `lg`→`sm` and the bundled-shader plan is deleted), R-18 (`dw`/`dh`
>   **do** account for rotation), and C22's capture keys (8/8 correct).
> - **The scope claim is corrected from 27% to ~20%**, with the arithmetic shown (§1.1).
>
> **Wave 0 has landed.** The plugin API described in §3 exists and is enforced;
> `docs/parity/02-wave0-api.md` is the module author's guide and is authoritative
> for anyone writing a feature module, including for the six places where this
> document's design was changed during implementation.
>
> Last updated: 2026-08-28

---

## 0. How to read this document

### 0.1 Column conventions used in the feature matrix

| Column | Meaning |
|---|---|
| **Pri** | `P0` ship-blocking for v1.0 · `P1` v1.1–v1.5 · `P2` backlog, may never ship · `skip` deliberately declined |
| **Eff** | `triv` under 2h · `sm` half a day · `md` 1–3 days · `lg` more than 3 days |
| **Feas** | `prop` mpv property · `cmd` mpv command · `vf`/`af` libavfilter via mpv's filter chain · `app` pure app code, mpv uninvolved · `ext` needs a second process |
| **Module** | The **one** module that owns this feature. No feature has two owners. |
| **Mapping** | Literal and copy-pasteable. JSON IPC commands are written as they go on the wire. |

### 0.2 Rules that are not negotiable

1. **No implementer edits a file outside their module directory.** The plugin API in
   §3 exists specifically so that adding a feature means adding a *directory*. If you
   find yourself opening `src/shared/types.ts`, `src/main/ipc.ts`, `src/preload/index.ts`,
   `src/main/menu.ts`, `src/shared/keybinds.ts` or `src/main/mpv/manager.ts` — stop.
   You are about to create a merge conflict with eight other people. Use the registry.
2. **`--wid` makes most of mpv's window options dead code.** See §7.5. Anything about
   fullscreen, ontop, borders, geometry, autofit, snapping, taskbar progress, minimise
   or maximise must be done in Electron. Setting the mpv option will *appear* to work
   and silently do nothing.
3. **Every state-changing command fires an OSD message.** Use `ctx.osd`. This is a
   product rule from `docs/01`, not a suggestion.
4. **Nothing here may make a network request unless the user typed a URL or clicked a
   link.** Two features in this spec (OpenSubtitles, yt-dlp) are network features; both
   are off by default behind an explicit consent gate, and both are covered by the CI
   network-monitor test.
5. **Filter chains have exactly one owner each.** `core/vf-chain` owns mpv's `vf`
   property; `core/af-chain` owns `af`. No feature module ever issues a raw
   `vf` / `af` / `vf clr` / `af clr` command. Violating this is the single most likely
   way for two modules to silently destroy each other's work.
6. **Every mpv property has exactly one owning module, and the registry enforces it.**
   A module declares `ownsProperties` in its `FeatureModule` (§3.2); the registry builds
   an owner map at boot and **throws, naming both modules, on a duplicate claim**;
   `ctx.mpv.set()` **rejects** a write to a property the calling module does not own. If
   you need a property another module owns you call `ctx.mpv.requestSet()` or that
   module's mediator command — you never write it yourself. §3.7 is the owner map, and it
   is the machine-checked half of the "Must NOT touch" column in §3.6. A table nothing
   enforces is decoration; this one is code, and `docs/parity/modules.json` is its
   machine-readable form.
7. **`windows.ts` is a forbidden file like the other six.** All window work goes through
   `ctx.window` (§3.3.7). Three modules needing `setAlwaysOnTop` must not mean three
   implementers editing one 414-line file.

---

## 1. Scope verdict — what we are actually shipping

### 1.1 The honest number

Nine researchers inventoried PotPlayer and produced **418 feature rows**. After removing
the 12 rows that two areas both claimed (§1.5) and adding the **16 rows the completeness
critique found missing entirely** (skip intro/ending, image & slideshow playback,
CEA-608/708 captions, embedded ASS fonts, VSFilter colour compatibility, named jump
targets, system volume, favorites, playback queue, sleep timer, auto-rotate by AR, the
three fullscreen modes, delete-last-saved-frame, the three-level info OSD,
add-similar-files-on-open, and the four-sided frame-size margins), **422 distinct
features** remain in the backlog:

| Priority | Count | What it means | Target |
|---|---:|---|---|
| **P0** | **115** | A PotPlayer user can switch and not hit a wall in a week of normal local-file viewing | **v1.0** |
| **P1** | **164** | The features that make people *stay* — EQ, thumbnails, bookmarks, HDR passthrough, clip export | v1.1 → v1.5 |
| **P2** | **133** | Real features with real users, but each is a rounding error next to the P0 set | backlog; many never ship |
| **skip** | **10** | Researched, understood, deliberately declined | never |
| **backlog total** | **422** | the rows in §2 | — |
| *(separately)* | **74** | Documented as **infeasible or declined** on this engine, with the reason (§2.10) | never |

#### The arithmetic, shown openly

An earlier revision of this section claimed "roughly 27% of PotPlayer's surface as v1.0,
and about 66% of it if every P1 lands." Both numbers were wrong, and both errors pushed
in the same direction:

1. **The denominator excluded the known losses.** 406 was *our backlog*, not PotPlayer's
   surface. The items documented as infeasible or declined were listed "separately" and
   dropped out of the divisor entirely. They are real PotPlayer features we will never
   have. Removing your known losses from the denominator is how any parity ratio is made
   to look good, and it is not something this project gets to do.
2. **The numerator counted our own plumbing.** Sixteen of the 115 P0 rows have no
   PotPlayer counterpart at all — they are RLPlayer's infrastructure and positioning.
   Every one is worth building. None of them moves a switcher one step closer to feeling
   at home, which is the only thing a parity percentage claims to measure.

Corrected, with the same rule applied to both halves of the fraction:

```
declined/infeasible register (§2.10)  =  58 table rows
                                      +  23 siblings bundled inside 11 of them
                                      −   7 rows that record OUR constraint, not a
                                            PotPlayer feature we lost
                                      =  74 lost PotPlayer features

denominator  =  backlog (422)  +  register (74)                      =  496

P0    parity rows  =  115  −  16 infrastructure rows                 =   99
P0+P1 parity rows  =  279  −  16  −  9 infrastructure rows           =  254

v1.0             99 / 496  =  19.96%   →   ~20% of what PotPlayer does
through v1.5    254 / 496  =  51.2%    →   ~51% if every P1 lands
```

**How the register resolves to 74, so the denominator is checkable rather than asserted.**
§2.10 has **58 table rows**, and an earlier revision called it "72 items" without saying
how it got there. Eleven of those rows bundle siblings under one reason — "Screen
recording, game capture, capture-device recording, PotScreenSaver" is four lost features,
"Media library, DLNA/Chromecast, web remote, cloud sync, accounts" is five — which adds
**23**. Seven rows are then subtracted because they record **our own engineering
constraints, not features PotPlayer has and we do not**: the limiter-vs-mpv-volume
finding, mpv's inert window-option surface, recording what gpu-next put on screen, HDR
passthrough beneath the overlay, `screenshot-raw`, Windows absolute paths inside lavfi
options, and making mpv's playlist the source of truth. 58 + 23 − 7 = **74**. Each of the
eleven bundles and the seven exclusions is identifiable by reading §2.10, which is the
point — a denominator you cannot recount is not evidence.

**The 16 P0 rows excluded from the numerator** — infrastructure or positioning, with no
PotPlayer counterpart: **V56**, **A26**, **A27** (the filter-chain registries), **P03**
(setting-descriptor registry), **P07** (versioned schema), **P08** (migration runner),
**P09** (downgrade guard), **P11** (atomic + `fsync` writes), **P16** (IME-safe
accelerators), **P33** (the no-hijack CI test), **P36**, **P37**, **P38** (portable mode),
**P45**, **P46** (i18n infrastructure), **P60** (there is no updater — the *absence* is
the feature).

**The 9 P1 rows excluded, by the same rule:** **P05** (modified indicator + per-setting
revert), **P10** (preserve unknown keys), **P12** (corrupt-file recovery), **P27** (show
the `.reg` before applying), **P39** (writability probe), **P41** (portable-cleanliness CI
test), **P42**/**P43** (settings export/import — PotPlayer keeps settings in the registry
and has neither), **P51** (persist only what the user changed).

**So: ~20% of PotPlayer as v1.0, ~51% if every P1 lands.** PotPlayer has had 20 years and
a DirectShow graph; we have mpv and a rule against bundling things. This project's entire
pitch is that it does not lie to the user, so the scope section is the worst possible
place to round in our own favour — the smaller, checkable number is the one that belongs
here. Appendix B reconciles row-for-row with §2, and §2.10 names every excluded item, so
the denominator is auditable rather than asserted.

### 1.2 Why 20% is the right number and not a retreat

The 115 P0 features are not a thin slice, they are the *load-bearing* slice. Read the P0
rows in §2 and notice what is in them: every subtitle format Korean users actually have,
including the multi-language SMI case PotPlayer handles and nothing open-source does;
frame-accurate backward stepping; hardware decode with a visible override; HDR tone
mapping that does not produce grey mush; Explorer-identical playlist sort; resume that
resumes at the right frame; A-B loop; a keymap that survives the Korean IME.

The 307 non-P0 features are overwhelmingly *variations* — nine denoisers where one is
enough, 23 anaglyph output modes, six ways to specify a proxy. The competitive claim is
not "more checkboxes than PotPlayer". It is **"PotPlayer's UX, mpv's engine, nobody's
adware."** Shipping 115 correct features beats shipping 400 approximate ones, and every
extra P2 feature is a permanent maintenance tax on a project whose pitch is that it stays
small and stays clean.

### 1.3 What we are deliberately NOT doing

Decisions, not gaps. Each is stated in the README so nobody discovers it by trying.

| Not doing | Why |
|---|---|
| **Screen recording, game capture, capture-device recording** | Requires injecting into other processes' D3D/OpenGL presentation. For an app whose pitch is "not adware, auditable, no background processes", shipping process-injection code is a self-inflicted wound — it is what antivirus heuristics are built to flag. OBS owns this. |
| **Outbound personal broadcasting (PotPlayer's Kakao TV stack)** | An entire second product: relays, chat, viewer login, TTS, earnings, an embedded CEF. Kakao TV shut down 2026-06-22 and PotPlayer's own `[260622]` build removed the integration. |
| **DVB / ATSC / analog TV tuner input** | Verified: mpv's `dvb://` is Linux-only and the Windows build has zero `--dvbin-*` options and no `tv://` protocol. PotPlayer uses Windows BDA DirectShow graphs, which have no counterpart in our stack. Users with tuners can point us at their backend's `udp://` or `http://` TS output today. |
| **DRM streaming (Widevine/PlayReady) and retail disc decryption (AACS/BD+/CSS)** | Needs a licensed CDM or a key database we will not ship. Folder/ISO playback of *decrypted* rips stays supported at P2. |
| **A media library with scraping, posters and watch-state sync** | Kodi, Plex and Jellyfin exist and are better at it. This is a player. |
| **A subtitle editor and a video editor** | Aegisub, Subtitle Edit and Shotcut exist. We ship a read-only subtitle browser (P1) and clip *export* (P1), not editing. |
| **PotPlayer's `.dsf` skin engine** | An undocumented proprietary layout runtime with a published security advisory for malformed skin files. We ship CSS custom-property theming instead — colours, radii, density — and say so plainly rather than implying skin parity. |
| **Cloud sync, accounts, a web remote, an auto-updater** | Every one needs a network listener or an outbound connection at rest. That is the thing we exist not to do. Export/import a JSON file and put it in your own sync folder. |
| **Bundling yt-dlp or ffmpeg** | See §7.3. Both are avoidable: mpv's *encode mode* replaces ffmpeg entirely (verified end to end), and yt-dlp's published `.exe` is GPLv3+ and goes stale between our releases. |
| **3D display output beyond anaglyph/interleave, and MVC Blu-ray 3D** | Shutter glasses need quad-buffered stereo we cannot get from a `--wid` child window; FFmpeg has no MVC decoder at all. Anaglyph and row/column interleave *are* feasible and sit in P2. |
| **`UserChoice` registry writes to claim file associations** | Verified impossible without forging Microsoft's private hash — which is exactly the hijacking behaviour we exist to escape. We register a ProgID and open Windows' own Default Apps page. CI greps for the API names and fails the build. |

### 1.4 The four things that are *better* than PotPlayer, on purpose

This is where the effort budget beyond parity goes:

1. **Multi-language SMI splitting.** Verified failure in FFmpeg's `samidec`: two `<SYNC>`
   events sharing a PTS make the first get duration 0 and vanish — and in real Korean
   files the Korean line is first. We convert SMI to per-language ASS ourselves.
2. **A settings window with one search box** (including 초성 matching) instead of a
   40-node tree. VLC's and PotPlayer's settings are both cited user grievances.
3. **Per-file state that only persists what you actually changed**, so improving a global
   default later still reaches files you have already opened. mpv's own `watch-later`
   gets this wrong and freezes the defaults of the day you first opened a file.
4. **The `.reg` file is shown to you before it is applied.** No other player does this.

### 1.5 Contradictions resolved (features two areas both claimed)

Each now has exactly one owner; the losing area's row was deleted, not duplicated.

| Feature | Claimed by | **Owner** | Resolution |
|---|---|---|---|
| Loop the current subtitle line | navigation, subtitles | **M26 nav-bookmarks** | It writes `ab-loop-a/b`; only one module may own those properties. It reads `sub-start`/`sub-end` directly. |
| `sub-seek` / `sub-step` | navigation, subtitles | **M20 subs-sync** | `sub-step` shifts subtitle *timing*, `sub-seek` seeks *video*; keeping the confusable pair in one file is what prevents the bug. |
| Next / previous file, end-of-file advance | navigation, playlist | **M28 playlist** | The queue owner must own advancing through it, or resume-saving happens on two code paths. |
| Gapless / `--prefetch-playlist` | navigation, playlist | **M28 playlist** | Same reason. Stays P2; see §7.6. |
| Stream recording (`stream-record`) | capture, streaming | **M23 capture-encode** | Capture owns everything that writes media to disk. Streaming exposes `isNetworkSource` for the gate. Priority resolved to **P2** — verified to produce *nothing* on local files. |
| Audio recording / extraction | audio, capture | **M23 capture-encode** | The audio researcher agreed it belongs with clip export. P1, as "extract audio for a range". |
| Media keys / SMTC | audio, UI | **M33 shell-system** | Both concluded `--media-controls=no` plus an Electron-side implementation. |
| Online subtitle search | subtitles (P1), streaming (skip) | **M21 subs-browser**, demoted to **P2** | The research is solid, but the feature sends a hash of what you are watching to a third party. It keeps its consent gate *and* drops to P2 so it cannot slip into a release by momentum. |
| Global hotkeys | UI, preferences | **M33 shell-system** | `globalShortcut` lives with the other process-global registrations. |
| Cursor auto-hide | UI (P0), preferences (P1) | **M31 shell-window**, **P0** | The overlay owns the cursor; mpv's `--cursor-autohide` is inert because mpv's child window is given `EnableWindow(hwnd, 0)`. |
| Screenshot directory and filename template | capture, preferences | **M22 capture-still** | Preferences renders the section from the registry; it does not own the values. |
| mpv's built-in stats overlay | playlist, UI | **M29 mediainfo** | One stats surface. Other modules contribute *sections* to it via `ctx.ui.statsSection`. |

### 1.6 Corrections to the earlier docs

Recorded so nobody implements from a stale premise:

- **`docs/01` says `tone-mapping=bt.2390`.** Under `--vo=gpu-next`, `auto` resolves to
  `spline`, which is the better modern choice. **Leave it on `auto`.** Related — and
  **corrected against `--list-options` on the pinned binary**, because an earlier revision
  of this bullet banned four options when only **three** deserve it:
  `--tone-mapping-mode` does not exist in this build at all (`property not found`), and
  `--tone-mapping-desaturate` and `--tone-mapping-desaturate-exponent` both print
  `removed [deprecated]`. **`--tone-mapping-max-boost` is live and settable:**
  `Float (1 to 10) (default: 1)`, and `set_property tone-mapping-max-boost 2.0` returns
  `success` over IPC. Build UI on `max-boost` (V32 does — it is the most useful HDR knob
  after the curve itself); do not build UI on the other three.
- **`docs/01` lists DVD/Blu-ray menus as "a swamp".** Half of that is now wrong: mpv
  *master* has a `discnav` command and `--disc-menu` supporting DVD menus and Blu-ray
  HDMV/popup menus. The remaining honest limit is BD-J (Java) menus. It is **absent from
  our pinned build** — see §7.2.
- **`docs/01` assumes `libmpv` linked in-process.** We ship a separate `mpv.exe` over
  JSON IPC (see `docs/03`). Two consequences recur below: `screenshot-raw` **kills mpv**
  over the JSON pipe, and mpv-side config profiles are unavailable because we pass
  `--no-config`.
- **`docs/01` budgets for a bundled ffmpeg.** Not needed. mpv's encode mode
  (`--o=` / `--of=` / `--ovc=` / `--oac=`) was verified end to end for clip export, GIF,
  animated WebP, contact sheets, burst frames and audio extraction. Saves ~80 MB and
  adds no new licence surface.

---
## 2. The feature matrix

422 rows, grouped by area. The **Module** column is binding: it is the only module
allowed to write the properties named in that row, and **§3.7 turns that sentence into
code** — the registry builds an owner map from it at boot and `ctx.mpv.set()` rejects
anything else.

Filter rows all go through `core/vf-chain` / `core/af-chain` using the reserved label
shown in the mapping. **Never issue the `vf` / `af` command directly.**

---

### 2.1 Video processing & rendering — 58 features (P0 11 · P1 18 · P2 29)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| V01 | Brightness / Contrast / Saturation / Hue | P0 | triv | prop | M01 | `{"command":["set_property","brightness",<int -100..100>]}`<br>`{"command":["set_property","contrast",<int -100..100>]}`<br>`{"command":["set_property","saturation",<int -100..100>]}`<br>`{"command":["set_property","hue",<int -100..100>]}` all default 0 | VO-level under gpu-next, so free and hwdec-safe. Range maps 1:1 onto PotPlayer's percent sliders. Observe all four so settings and OSD stay in sync. |
| V02 | Gamma | P1 | triv | prop | M01 | `{"command":["set_property","gamma",<int -100..100>]}` default 0 | Use the `gamma` property, not the startup options — but **the justification an earlier revision gave was wrong and is corrected here**: `--list-options` shows `--gamma-auto  Flag (default: no) [deprecated]` and `--gamma-factor  Float (0.1 to 2) (default: 1)`. **Only `--gamma-auto` carries the deprecation marker.** `--gamma-factor` is live; we still prefer the runtime `gamma` property because it is observable and per-file persistable, which a startup option is not. |
| V03 | Reset / last-used colour toggle (PotPlayer `Q`) | P0 | triv | cmd | M01 | Reset: set brightness/contrast/saturation/hue/gamma to `0`.<br>Last-used: keep the last non-zero tuple in app state and re-apply. | There is no mpv-side restore primitive: `apply-profile <name> restore` needs config-file profiles and we run `--no-config`. Keep the state in the app. |
| V04 | Video output levels (TV/PC range) | P1 | triv | prop | M01 | `{"command":["set_property","video-output-levels","auto"]}` — `auto`\|`limited`\|`full`<br>source-side override: `@rl-range:format=colorlevels=limited` | Manual warns some VOs silently ignore it; gpu-next honours it. Leave on `auto`, expose behind Advanced with a black-level test pattern. |
| V05 | Level control (black / white point) | P2 | sm | vf | M01 | `@rl-levels:lavfi=[colorlevels=rimin=0.0625:gimin=0.0625:bimin=0.0625:rimax=0.9176:gimax=0.9176:bimax=0.9176]` | Values are 0.0–1.0 floats. CPU filter: forces hwdec copy-back. Re-issuing `vf add` with the same label *replaces* it — that is the live-slider idiom. |
| V06 | Auto level control | P2 | sm | vf | M01 | `@rl-autolevel:lavfi=[normalize=blackpt=black:whitept=white:smoothing=50]` | `smoothing=50` is mandatory or the picture pumps on every cut. RGB-only, so it inserts a colourspace conversion. |
| V07 | Luma / chroma offset | P2 | triv | vf | M01 | `@rl-cshift:lavfi=[chromashift=cbh=0:cbv=0:crh=0:crv=0]` | Chroma only. There is no luma-offset filter; ship chroma and say so rather than faking it with crop+pad. |
| V08 | Sharpen (luma / chroma), "classic" unsharp | P1 | sm | vf | M03 | `@rl-sharpen:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.0:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=0.0]`<br>**live updates are impossible — `unsharp` rejects `vf-command`.** Every parameter change is a **full chain rebuild**: `ctx.vf.set('rl-sharpen', '<new spec>')`, which `core/vf-chain` turns into a `vf add @rl-sharpen:…` label replacement. | Two traps. (1) **mpv's own `sharpen` property is a no-op under gpu-next** — it is `(Only for --vo=gpu)` and deliberately omitted. (2) **Measured: `["vf-command","rl-sharpen","amount","1.4","unsharp"]` returns `error running command`.** `unsharp` does not implement `process_command`, and it is the **only** enhancement filter in this spec that does not (`cas`, `eq`, `hqdn3d`, `deblock` and `v360` all accept it). So this row **must not ship live sliders**: either commit on pointer-release only, or — better, and now load-bearing rather than stylistic — make **V09 CAS** the default "Sharpen" and hide unsharp behind "classic". Every drag on a 4K frame otherwise rebuilds the graph and forces an hwdec copy-back. |
| V09 | CAS (contrast-adaptive sharpening) | P1 | sm | vf | M03 | `@rl-sharpen:lavfi=[cas=strength=0.4]` strength 0.0–1.0<br>live, **four arguments, last is the lavfi filter name**:<br>`{"command":["vf-command","rl-sharpen","strength","0.55","cas"]}` | **`vf-command` takes FOUR arguments, exactly like `af-command` (A27).** Measured against the pinned build with `@rl-sharpen:lavfi=[cas=strength=0.4]` loaded: the 3-argument form `["vf-command","rl-sharpen","strength","0.55"]` returns **`error running command`**; adding the filter name as the fourth argument returns `success`. The canonical shape is `['vf-command','<label>','<option>','<value>','<lavfi-filter-name>']` and `FilterChainService.command()` (§3.3.6) already has that signature. Verified to accept `vf-command`: `cas`, `eq`, `hqdn3d`, `deblock`, `v360`. Verified to **reject** it: `unsharp` (V08). Make CAS the default "Sharpen" and hide unsharp behind "classic" — better looking, no edge ringing, and the only one with live sliders. |
| V10 | Soften (blur) | P2 | sm | vf | M03 | `@rl-soften:lavfi=[smartblur=luma_radius=1.0:luma_strength=-0.8:luma_threshold=0:chroma_radius=1.0:chroma_strength=-0.8:chroma_threshold=0]` | Negative strength blurs, positive sharpens — one filter backs both sliders. |
| V11 | Denoise 3D (spatial + temporal) | P1 | sm | vf | M03 | `@rl-denoise:lavfi=[hqdn3d=4:3:6:4.5]`<br>order is `luma_spatial:chroma_spatial:luma_tmp:chroma_tmp`<br>PotPlayer Luma→`luma_spatial`, Chroma→`chroma_spatial`, Time→`luma_tmp` (chroma_tmp = luma_tmp × 0.75) | `hqdn3d` **is** MPlayer's denoise3d, so this is an exact 1:1 port including slider meanings. Temporal state means a couple of soft frames after a seek — not a bug. |
| V12 | Temporal denoise | P2 | sm | vf | M03 | `@rl-tdenoise:lavfi=[atadenoise=s=9:0a=0.02:0b=0.04]`<br>cheaper: `@rl-tdenoise:lavfi=[hqdn3d=0:0:6:4.5]` | `atadenoise s=9` buffers 9 frames of latency and shows on seek. Prefer the hqdn3d temporal-only form. |
| V13 | Gradual denoise | P2 | sm | vf | M03 | `@rl-gdenoise:lavfi=[removegrain=m0=1:m1=1:m2=1:m3=1]`<br>alt: `@rl-gdenoise:lavfi=[vaguedenoiser=threshold=2:method=soft]` | **Not a verified mapping.** PotPlayer's "Gradual Denoise" algorithm is undocumented and matches no ffmpeg filter. Prefer folding it into the Denoise 3D slider rather than shipping different behaviour under PotPlayer's name. |
| V14 | Deblock | P2 | sm | vf | M03 | `@rl-deblock:lavfi=[deblock=filter=weak:block=8:alpha=0.098:beta=0.05]`<br>single-slider feel: `@rl-deblock:lavfi=[pp7=qp=0:mode=medium]` | Both CPU and expensive at 4K. `deblock` is modern; `pp7`/`fspp`/`spp` are the old MPlayer postprocessing family and are also present. |
| V15 | Deband | P1 | triv | prop | M03 | `{"command":["set_property","deband",true]}`<br>`{"command":["set_property","deband-threshold",<0..4096, def 48>]}`<br>`{"command":["set_property","deband-range",<1..64, def 16>]}`<br>`{"command":["set_property","deband-grain",<0..4096, def 32>]}`<br>`{"command":["set_property","deband-iterations",<0..16, def 1>]}` | The one enhancement that is *free* — a gpu-next render pass, no copy-back. PotPlayer Threshold→`deband-threshold`, Radius→`deband-range`. Make it more prominent than PotPlayer does. |
| V16 | Motion blur | P2 | triv | vf | M03 | `@rl-mblur:lavfi=[tmix=frames=3:weights=1 1 1]` | The space-separated `weights` survives mpv's parser as written; if it ever fails, wrap as `weights=[1 1 1]`. |
| V17 | Deinterlace off / on / auto | P0 | triv | prop | M04 | `{"command":["set_property","deinterlace","no"]}` — `no`\|`yes`\|`auto`, default `no`<br>read back: `{"command":["get_property","deinterlace-active"]}`<br>`{"command":["set_property","deinterlace-field-parity","auto"]}` — `auto`\|`tff`\|`bff` | `yes` inserts `bwdif`. `deinterlace-active` is a separate read-only property — observe it so the OSD reports what is *running*, not what was requested. Keep default `no`; `auto` false-positives on progressive content. |
| V18 | Deinterlace method selection | P2 | sm | vf | M04 | set `deinterlace` to `no` first, then one of:<br>`@rl-deint:lavfi=[bwdif=mode=send_field:parity=auto:deint=all]`<br>`@rl-deint:lavfi=[yadif=mode=send_field:parity=auto:deint=all]`<br>`@rl-deint:lavfi=[estdif=mode=field:parity=auto:deint=all]`<br>`@rl-deint:lavfi=[w3fdif=filter=complex:deint=all]` | Manual deinterlace filters **conflict** with the `deinterlace` property; the module must own both and never let both be on. `deint=all` vs `deint=interlaced` maps to PotPlayer's flagged/not-flagged split. `nnedi` needs a weights file we do not ship. |
| V19 | Hardware deinterlacing (D3D11 VPP) | P1 | md | vf | M04 | `@rl-deint:d3d11vpp=deint=yes:mode=adaptive:interlaced-only=yes:parity=auto`<br>modes: `blend`\|`bob`\|`adaptive`\|`mocomp`\|`ivtc`\|`none` | Right default when hwdec is active — CPU filters force copy-back. Enabling at runtime may starve the decoder's surface pool: pass a larger `--hwdec-extra-frames` at spawn or reload the file. |
| V20 | Inverse telecine (3:2 pulldown removal) | P2 | md | vf | M04 | `@rl-deint:d3d11vpp=deint=yes:mode=ivtc,format=nv12,decimate=5` | `ivtc` only field-matches; `decimate` drops the dupes and `format=nv12` downloads frames to the CPU to do it — so IVTC **costs a copy-back**, unlike plain hardware deinterlacing. Offer only for 29.97/25 fps interlaced sources. |
| V21 | Interlace detection | P2 | md | vf | M04 | passive: `{"command":["get_property","deinterlace-active"]}` and `{"command":["get_property","video-frame-info"]}` (has `interlaced`)<br>active: `@rl-idet:lavfi=[idet]` then scrape the log | `idet` reports through ffmpeg log lines, not a property. Prefer `video-frame-info` + the container flag; put `idet` behind an explicit "Analyze" button. |
| V22 | Aspect ratio override | P0 | triv | prop | M02 | `{"command":["set_property","video-aspect-override","16:9"]}` — `4:3`\|`16:10`\|`1.85:1`\|`2.35:1`\|`1.7777`<br>auto: `{"command":["set_property","video-aspect-override","no"]}`<br>`{"command":["set_property","video-aspect-method","bitstream"]}` — `container`\|`ignore` | The magic values `0` and `-1` are deprecated. **The existing code stores `'-1'` for auto and must migrate to `'no'`.** PotPlayer's "Display AR" vs "Original DAR" is exactly `video-aspect-method` container vs bitstream. |
| V23 | Screen fit modes (keep AR / fill+crop / stretch) | P0 | sm | prop | M02 | keep AR: `keepaspect=true`, `panscan=0.0`<br>fill+crop: `keepaspect=true`, `panscan=1.0`<br>stretch: `keepaspect=false`<br>`{"command":["set_property","panscan",1.0]}` float 0.0–1.0<br>1:1 pixels: `{"command":["set_property","video-unscaled","yes"]}` — or `downscale-big` | `--video-unscaled` disables `panscan`, and `keepaspect=no` disables `video-zoom` and `video-scale-x/y`. The fit-mode control must own and reset zoom/pan state or the UI shows sliders that silently do nothing. |
| V24 | Zoom & pan | P0 | sm | prop | M02 | `{"command":["set_property","video-zoom",<float, log2>]}` — 0 = 1×, 1 = 2×, −1 = 0.5×<br>`{"command":["set_property","video-pan-x",<float>]}` / `video-pan-y` (fraction of window)<br>`{"command":["set_property","video-scale-x",1.1]}` / `video-scale-y`<br>`{"command":["set_property","video-align-x",<-1..1>]}` / `video-align-y`<br>reset: zoom 0, pan 0/0, scale 1/1, panscan 0 | **`video-zoom` is log2, not a multiplier.** A 10% step is `+= log2(1.1) ≈ 0.1375`, not `+= 0.1`. This is the single most common implementation mistake here. Zoom-at-cursor solves pan so the cursor's video-space point stays fixed — do that maths in the module, not the renderer. |
| V25 | Manual crop | P1 | sm | prop | M02 | `{"command":["set_property","video-crop","1920x800+0+140"]}` (`WxH+x+y`)<br>centred: `"1920x800"`<br>kill container crop too: `"0x0+0+0"`<br>restore container crop: `""` | Works **with hwdec**, unlike `lavfi-crop`. The two empty forms are not interchangeable: `"0x0+0+0"` kills the container crop, `""` restores it. Swapping them gives a subtle wrong-framing bug. |
| V26 | Auto crop (black-bar detection) | P1 | md | vf | M02 | phase 1: `@rl-cropdetect:lavfi=[cropdetect=limit=24:round=2:reset=0]`<br>phase 2: `{"command":["set_property","video-crop","<w>x<h>+<x>+<y>"]}` then remove `@rl-cropdetect` | `cropdetect` reports through ffmpeg **log lines** (`crop=w:h:x:y`), not any property — the module must scrape mpv's stderr. That plumbing is why this is `md`. Sample during a bright scene; dark-scene detection over-crops. |
| V27 | Extend / crop presets (4:3 … 2.35:1) | P2 | triv | prop | M02 | crop: compute from `video-out-params/dw`/`dh` then `{"command":["set_property","video-crop","<w>x<h>"]}`<br>extend: **all four margins exist** — `video-margin-ratio-top`, `-bottom`, `-left`, `-right`, each `Float (0 to 1) (default: 0)`, all verified settable (`set_property video-margin-ratio-left 0.1` → `success`) | **Corrected: an earlier revision said "no mpv `pad` property exists" and believed half the primitive was missing.** It is not — the four `--video-margin-ratio-*` options are the pad, which is why this row drops from `sm` to `triv`. PotPlayer's own menu has a typo, "2:35:1 Cropping" — do not copy it. See **V57** for the per-side margin controls this unlocks. |
| V28 | Bottom margin for subtitles | P2 | triv | prop | M02 | `{"command":["set_property","video-margin-ratio-bottom",0.15]}` 0.0–1.0<br>(`-top`, `-left` and `-right` exist too and belong to V57) | PotPlayer's "only when subtitles exist" is worth copying: observe `sid` and apply only when a subtitle track is active. Coordinate with M19 so this and `sub-use-margins` do not fight. |
| V29 | Rotate 90 / 180 / 270 | P0 | triv | prop | M02 | `{"command":["set_property","video-rotate",90]}` 0–359, or `"no"` to ignore file rotation metadata | With hwdec **without copy-back only 90° steps work**. Since we default to `auto-safe`, expose only 0/90/180/270 unless software decode is forced. The value is *added* to the file's rotation metadata, so 0 means "as the file says", not "upright". |
| V30 | Arbitrary-angle rotation | P2 | triv | vf | M02 | preferred: `{"command":["set_property","video-rotate",37]}`<br>fallback: `@rl-rotate:lavfi=[rotate=PI/6:fillcolor=black]` | The lavfi form forces copy-back and resamples every frame. Gate behind Advanced and warn that hardware decoding is bypassed. |
| V31 | Flip horizontal / vertical | P1 | triv | vf | M02 | `@rl-hflip:lavfi=[hflip]` / `@rl-vflip:lavfi=[vflip]`<br>toggle: `{"command":["vf","toggle","@rl-hflip:lavfi=[hflip]"]}` *(issued by core/vf-chain)* | **mpv has no flip property.** `--d3d11-flip` and `--angle-flip` are swapchain presentation flags and completely unrelated — do not wire the UI to them. |
| V32 | HDR → SDR tone mapping | P0 | sm | prop | M05 | `{"command":["set_property","tone-mapping","auto"]}`<br>choices: `auto clip mobius reinhard hable gamma linear spline bt.2390 bt.2446a st2094-40 st2094-10`<br>`{"command":["set_property","tone-mapping-param",<float>]}`<br>`{"command":["set_property","target-peak","auto"]}` or 100..10000 nits<br>`{"command":["set_property","target-contrast","auto"]}` (`inf` for OLED)<br>`{"command":["set_property","hdr-compute-peak","auto"]}`<br>`{"command":["set_property","gamut-mapping-mode","auto"]}`<br>**`{"command":["set_property","tone-mapping-max-boost",2.0]}` — `Float (1 to 10)`, default `1`, verified settable over IPC** | Leave the curve on `auto` (resolves to `spline`). **Corrected against `--list-options`:** an earlier revision banned four options; only **three** are dead. `--tone-mapping-mode` **does not exist** (`property not found`), and `--tone-mapping-desaturate` / `-desaturate-exponent` print `removed [deprecated]`. **`--tone-mapping-max-boost` is live**, is the single most useful HDR knob after the curve itself, and must be exposed — blanket-banning it cost a real feature. |
| V33 | HDR passthrough to an HDR display | P1 | md | prop | M05 | `{"command":["set_property","target-colorspace-hint","auto"]}` — default is `auto`<br>`{"command":["set_property","target-colorspace-hint-mode","target"]}` — `target`\|`source`\|`source-dynamic`<br>**swapchain format is M07's property, not M05's** — request it:<br>`ctx.mpv.requestSet('d3d11-output-format','rgba16f','V33 HDR passthrough')` and `…('d3d11-output-csp','pq',…)` | **Collision resolved (was PH-5):** V33 and V36 both wanted to contribute `--d3d11-output-format` at spawn with mutually exclusive values (`rgba16f` vs `rgb10_a2`), silent last-one-wins, and `contributeArgs` only protected *core*-owned args. **M07 now owns `d3d11-output-format` / `-csp` and arbitrates**: HDR passthrough wins over 10-bit dither output when both are requested, because `rgba16f` is a superset. `contributeArgs` additionally rejects **any** duplicate option name across all contributors, not just core's (§3.3.1). Works on d3d11 + gpu-next, which is what we ship. Copy PotPlayer's tri-state (on / off / auto-switch). **The Electron overlay composites as SDR over the HDR surface** — design the control bar contrast for that, do not discover it during HDR testing. |
| V34 | Inverse tone mapping (SDR → HDR) | P2 | sm | prop | M05 | `{"command":["set_property","inverse-tone-mapping",true]}`<br>NVIDIA hw path: `@rl-truehdr:d3d11vpp=nvidia-true-hdr=yes` | gpu-next only; "not supported by all tone mapping curves, use with caution". Ship off by default and label it an *effect*, not a correction. |
| V35 | Dolby Vision / HDR10+ dynamic metadata | P2 | sm | vf | M05 | `@rl-dv:format=dolbyvision=no`<br>`@rl-dv:format=hdr10plus=no`<br>both: `@rl-dv:format=dolbyvision=no:hdr10plus=no`<br>curves: `tone-mapping=st2094-40` (HDR10+) / `st2094-10` | The `format` filter exposes `dolbyvision`, `enhancement-layer`, `hdr10plus`, `film-grain` (all default yes). Only gpu-next applies film grain. **Do not promise Dolby Vision profile 7 dual-layer.** |
| V36 | 10-bit output and dithering | P1 | triv | prop | M06 | `{"command":["set_property","dither","fruit"]}` — `fruit`\|`ordered`\|`error-diffusion`\|`no`<br>`{"command":["set_property","dither-depth","auto"]}` — `auto`\|`no`\|`-1..16`<br>swapchain format is **M07's** — request it: `ctx.mpv.requestSet('d3d11-output-format','rgb10_a2','V36 10-bit output')`, and expect M07 to refuse while V33 holds `rgba16f`<br>read: `{"command":["get_property","video-params/pixelformat"]}` | Defaults are already correct. **See V33 for the resolved ownership of `d3d11-output-format`** — this row and V33 used to contribute the same spawn arg with conflicting values and nothing caught it. This row exists mostly so the settings UI can *show* the source bit depth — that display is the part users want. |
| V37 | 360° projection modes | P2 | lg | vf | M09 | `@rl-360:lavfi=[v360=input=e:output=flat:h_fov=100:v_fov=70:yaw=0:pitch=0:roll=0:w=1920:h=1080]`<br>verified inputs: `e c3x2 c6x1 c1x6 eac dfisheye fisheye ball hequirect flat sg cylindrical pannini`<br>Equirect→`e`, Dual Fisheye→`dfisheye`, Cubemap→`c3x2`, EAC 3x2→`eac` | **`input=c2x3` is not valid and the graph fails to build** — PotPlayer's "EAC 2x3" has no v360 equivalent. Do not transcribe PotPlayer's menu blindly. v360 is CPU-only, so 360 forces copy-back at exactly the resolutions 360 footage uses. |
| V38 | 360° look-around (mouse / keyboard) | P2 | sm | vf | M09 | **settled: `v360` accepts `vf-command`, four-argument form** —<br>`{"command":["vf-command","rl-360","yaw","20","v360"]}` → `success`<br>same for `pitch`, `roll`, `h_fov`, `v_fov`; drive it from pointer drag through `ctx.vf.command('rl-360','yaw',String(y),'v360')` | **R-10 is settled and this row drops from `lg` to `sm`.** No bundled GLSL reprojection shader is needed and the shader plan is **deleted** — do not implement it. Two things remain true: the arity is **four** arguments with the lavfi filter name last (V09), and `v360` rebuilds its projection maps on every command, so **measure the per-command frame cost before promising smooth dragging** — if it hitches, throttle to ~30 Hz and commit exact on release, the same pattern as N30. The projection is easy; the interaction is still the work. |
| V39 | 3D SBS / Top-Bottom input, convert to 2D | P2 | sm | vf | M09 | `@rl-3d:lavfi=[stereo3d=in=sbsl:out=ml]` (left eye) / `out=mr`<br>top-bottom: `in=abl`<br>verified inputs: `sbsl sbsr sbs2l sbs2r abl abr ab2l ab2r al ar irl irr icl icr`<br>detect: `{"command":["get_property","video-params/stereo-in"]}` | `video-params/stereo-in` gives PotPlayer's "auto detect" free on properly tagged MKVs. Filename heuristic worth copying: `/[-_. ](h?sbs\|hsbs\|fsbs\|htab\|ou\|tab)[-_. ]/i`. |
| V40 | 3D output modes (anaglyph, interleave, SBS/TAB out) | P2 | sm | vf | M09 | `@rl-3d:lavfi=[stereo3d=in=sbsl:out=<MODE>]`<br>red/cyan `arcg arch arcc arcd` · green/magenta `agmg agmh agmc agmd` · yellow/blue `aybg aybh aybc aybd` · red/blue `arbg`<br>row interleave `irl irr` · column `icl icr` · checkerboard `chl chr` (output only)<br>SBS/TB out `sbsl sbsr sbs2l abl abr ab2l` · mono `ml mr` | Near-complete parity for one filter plus a dropdown. Make the Dubois variants (`arcd`/`agmd`/`aybd`) the default anaglyph, not the gray ones. `chl`/`chr` are rejected as *input*. |
| V41 | Judder removal (display resample) | P0 | triv | prop | M08 | already at spawn: `--video-sync=display-resample`<br>`{"command":["set_property","video-sync","display-resample"]}`<br>choices: `audio display-resample display-resample-vdrop display-resample-desync display-tempo display-adrop display-vdrop display-desync desync`<br>`{"command":["set_property","framedrop","vo"]}` | Already wired. The only work left is exposing it as a toggle and explaining it — display-resample slightly resamples audio and a few users object. `display-tempo` changes tempo instead of pitch-resampling; offer it as the alternative. |
| V42 | Display refresh-rate matching (true mode switch) | P2 | lg | app | M08 | mpv supplies inputs only:<br>`{"command":["get_property","container-fps"]}` · `estimated-vf-fps` · `display-fps` · `estimated-display-fps`<br>after switching: `{"command":["set_property","display-fps-override",23.976]}`<br>the switch itself is `ChangeDisplaySettingsExW` with `DEVMODE.dmDisplayFrequency` from the main process | `--override-display-fps` is a deprecated alias — use `display-fps-override`. Genuinely large: black flash, multi-monitor and HDR interactions, and it can leave the desktop at 24 Hz if we crash. Needs a restore-on-exit guarantee. Ship V41 first. |
| V43 | Frame interpolation / motion smoothing | P2 | md | prop | M08 | (a) mpv temporal: `{"command":["set_property","interpolation",true]}` + `{"command":["set_property","tscale","oversample"]}`<br>(b) true motion interp: `@rl-mi:lavfi=[minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1]`<br>(c) AMD hardware: `@rl-mi:amf_frc` | (a) is **silently disabled** unless `video-sync` is a `display-*` mode. Label (a) and (b) differently or you will get bug reports from people expecting 60fps anime. `minterpolate=mci` is unusable above 1080p on most CPUs. |
| V44 | Scaler selection (upscale / downscale / chroma) | P1 | sm | prop | M06 | `{"command":["set_property","scale","lanczos"]}` (def lanczos)<br>`{"command":["set_property","dscale","hermite"]}` (def hermite)<br>`{"command":["set_property","cscale",""]}` (empty = follow scale)<br>tuning: `scale-antiring`, `-blur`, `-radius`, `-param1/2`, `-clamp`, `-window` (same suffixes for dscale/cscale)<br>PotPlayer names: Fast Bilinear/Bilinear→`bilinear`, Bicubic→`bicubic`, Lanczos→`lanczos`, Spline→`spline36`, Nearest→`nearest` | **Corrected: `ewa_lanczossoft` and `haasnsoft` were NOT removed from this build** — both appear verbatim in `--scale`, `--dscale` and `--cscale`'s choice lists, so the option parser accepts them. Whatever gpu-next does with them internally, **a scaler dropdown generated from mpv's enum (the obvious implementation) will show them.** The instruction is therefore **"filter these two out of the enum before rendering the dropdown"**, not "they do not exist" — otherwise M06 ships two dead entries. Also: `ewa_lanczos` default radius changed to 3.2383, and `--dscale-antiring` is not applied for orthogonal filters. |
| V45 | Quality presets (fast / balanced / high) | P1 | sm | prop | M06 | HIGH (`mpv --show-profile=high-quality`): `scale=ewa_lanczossharp, scale-antiring=0.6, hdr-peak-percentile=99.995, hdr-contrast-recovery=0.30`<br>FAST (`--show-profile=fast`): `scale=bilinear, dscale=bilinear, dither=no, correct-downscaling=no, linear-downscaling=no, sigmoid-upscaling=no, hdr-compute-peak=no, allow-delayed-peak-detect=yes`<br>BALANCED = defaults: `scale=lanczos, dscale=hermite, dither=fruit, correct-downscaling=yes, linear-downscaling=yes, sigmoid-upscaling=yes, hdr-compute-peak=auto` | Apply as individual `set_property` calls. **Do not use `apply-profile`** — it is destructive and non-reversible without `profile-restore`, which needs a config file we do not have. Individual writes also let the settings UI show and reset each value. |
| V46 | User GLSL shaders (Anime4K / FSR / ravu) | P2 | md | prop | M06 | `{"command":["set_property","glsl-shaders",["C:/…/a.glsl","C:/…/b.glsl"]]}`<br>`{"command":["change-list","glsl-shaders","append","C:/…/s.glsl"]}`<br>`{"command":["change-list","glsl-shaders","clr",""]}`<br>`{"command":["change-list","glsl-shaders","remove","C:/…/s.glsl"]}`<br>`{"command":["set_property","glsl-shader-opts",{"param":"value"}]}` | PotPlayer's pre-resize vs post-resize distinction maps to the shader's own HOOK stage (MAIN vs OUTPUT), not to a player setting. `MAINPRESUB` does not exist under gpu-next. Copy PotPlayer's "Open shader folder" and "Reload list" buttons; **do not bundle Anime4K.** |
| V47 | RTX / Intel Video Super Resolution | P2 | sm | vf | M06 | `@rl-vsr:d3d11vpp=scaling-mode=nvidia:scale=2.0`<br>`@rl-vsr:d3d11vpp=scaling-mode=intel:scale=2.0`<br>modes: `standard`\|`intel`\|`nvidia` | Manual: "whether it actually works depends on your hardware and the settings in your GPU driver's control panel" — it can silently do nothing, so the UI must not claim it is active. |
| V48 | 3D LUT / ICC calibration | P2 | sm | prop | M06 | display LUT: `--lut=C:/…/display.cube --lut-type=auto`<br>source LUT: `--image-lut=C:/…/look.cube --image-lut-type=auto`<br>`{"command":["set_property","icc-profile","C:/…/monitor.icm"]}`<br>`--icc-profile-auto=yes --icc-intent=1 --icc-3dlut-size=auto --icc-use-luma=no`<br>lavfi alt: `@rl-lut:lavfi=[lut3d=file=C:/…/look.cube]` | `--image-lut-type`, `--icc-use-luma`, `--lut-type` are gpu-next only, which suits us. gpu-next caches ICC 3DLUTs on disk and evicts after 24h unused. |
| V49 | Hardware decoder selection + manual override | P0 | sm | prop | M07 | `{"command":["set_property","hwdec","auto-safe"]}`<br>verified values: `no auto auto-safe auto-unsafe auto-copy auto-copy-safe auto-copy-unsafe d3d11va d3d11va-copy d3d12va d3d12va-copy dxva2 dxva2-copy nvdec nvdec-copy cuda cuda-copy qsv qsv-copy amf amf-copy vulkan vulkan-copy vaapi vaapi-copy`<br>comma list is legal: `"d3d11va,auto"`<br>`{"command":["get_property","hwdec-current"]}`<br>`--hwdec-software-fallback=3`<br>`--hwdec-codecs=h264,vc1,hevc,vp8,vp9,av1,prores,prores_raw,ffv1,dpx,apv` | Three traps: (1) `auto-safe` is **exactly the same as** `auto` — do not present them as different. (2) plain `dxva2` requires `--vo=gpu`; under gpu-next it silently fails — offer `dxva2-copy` instead. (3) `qsv`/`amf` are accepted by this build but undocumented on Windows — label them experimental. **Always surface `hwdec-current` in the stats overlay.** |
| V50 | GPU adapter selection | P2 | sm | prop | M07 | spawn: `--d3d11-adapter="NVIDIA GeForce RTX 4070"` (substring match)<br>`{"command":["get_property","d3d11-adapter"]}`<br>`--d3d11-warp=auto\|no\|yes`, `--d3d11-feature-level=12_1…9_1` | Changing at runtime almost certainly needs a VO reinit and is unverified — treat as restart-required and say so. Enumerating adapter names is a DXGI job; mpv exposes no list. |
| V51 | Video renderer (VO) selection | P1 | sm | prop | M07 | spawn only: `--vo=gpu-next --gpu-context=d3d11`<br>fallback: `--vo=gpu --gpu-context=d3d11`<br>`--gpu-api`, `--d3d11-output-mode=auto\|window\|composition`, `--d3d11-sync-interval=1`, `--d3d11-flip=yes`<br>`{"command":["get_property","current-vo"]}` · `current-gpu-context` | Changing the VO requires respawning mpv and re-embedding via `--wid`: restart-scoped, and the settings UI must say so. `current-vo`/`current-gpu-context` belong in the stats overlay so bug reports are actionable. |
| V52 | Letterbox background colour | P1 | triv | prop | M07 | `--background=color --background-color='#FF000000'`<br>choices: `none`\|`color`\|`tiles` — **default is `tiles`**<br>related: `--background-tile-color-0/-1`, `--background-tile-size`, `--background-blur-radius`, `--corner-rounding` | mpv's default letterbox fill is a **checkerboard**, which reads as a rendering bug in a video player. One spawn-arg contribution; do it. |
| V53 | Per-file video settings persistence | P1 | md | app | M01–M09 | No mpv involvement — each module registers a slice with `core/per-file` (§5.7). Re-apply **after `file-loaded`**; property writes before the file is open are dropped. | Two rules: never persist a setting the user did not explicitly change (or later default changes become unshippable), and offer a per-file "reset video settings" so a bad saved state is recoverable. |
| V54 | Automatic per-content video profiles | P2 | md | app | M07 | mpv's `profile-cond` is unavailable (`--no-config`). Key off, after `file-loaded`:<br>`video-params/w`, `/h`, `/pixelformat` (`yuv420p10` ⇒ 10-bit), `/gamma` (`pq`/`hlg` ⇒ HDR), `/primaries`, `/max-luma`, `container-fps`, `/stereo-in` | `video-params/sig-peak` is **deprecated** — use `max-luma`/`max-cll`. Detect HDR from `video-params/gamma`, never from resolution or bt.2020 primaries alone. |
| V55 | Video pipeline stats overlay | P1 | sm | prop | M29 (section) | `hwdec-current`, `hwdec-interop`, `current-vo`, `current-gpu-context`<br>`video-params/w /h /dw /dh /pixelformat /hw-pixelformat /average-bpp /colormatrix /colorlevels /primaries /gamma /min-luma /max-luma /max-cll /max-fall /aspect /aspect-name /par /sar /rotate /stereo-in /crop-w /crop-h`<br>`container-fps`, `estimated-vf-fps`, `display-fps`, `estimated-display-fps`, `video-bitrate`<br>`vf`, `deinterlace-active`, `video-frame-info`, `frame-drop-count`, `decoder-frame-drop-count` | Contributed to M29's stats surface via `ctx.ui.statsSection`, not implemented as its own overlay. `frame-drop-count`/`decoder-frame-drop-count` were not individually verified — check before use. |
| V56 | Labelled filter-chain registry | P0 | md | cmd | **core/vf-chain** | `{"command":["vf","add","@rl-<feature>:<spec>"]}` (re-adding a used label **replaces** it)<br>`{"command":["vf","remove","@rl-<feature>"]}`<br>`{"command":["vf","toggle","@rl-<feature>"]}`<br>`{"command":["get_property","vf"]}`<br>reserved labels: `rl-levels rl-autolevel rl-cshift rl-sharpen rl-soften rl-denoise rl-tdenoise rl-gdenoise rl-deblock rl-mblur rl-deint rl-hflip rl-vflip rl-rotate rl-3d rl-360 rl-vsr rl-dv rl-lut rl-cropdetect rl-mi rl-truehdr` | **Must land before every other video filter feature.** Ordering is enforced by the registry: deinterlace → reprojection → enhancement → geometry/flip. `vf` commands issued before the first frame is decoded cannot be validated and may leave a broken chain — queue until `file-loaded`. Exposes "is any CPU filter active" for the stats overlay. |
| V57 | Frame-size margins — increase/decrease top, left, bottom, right | P2 | triv | prop | M02 | `{"command":["set_property","video-margin-ratio-top",<0..1>]}` and `-bottom`, `-left`, `-right`, all `Float (0 to 1) (default: 0)`, all verified settable<br>PotPlayer's "Operate margin changes only in fullscreen" is an app-side gate on `ctx.window.isFullScreen()` | **Added — the critique found it missing while the spec believed half the primitive did not exist (see V27).** This is PotPlayer's *Frame Size* menu: overscan correction for TV output, and the reason people press these keys is a projector or a TV that eats the edges. Reset must zero all four. Coordinate with **V28** and **S23** (`sub-use-margins`) so the subtitle margin and the video margin do not both move. |
| V58 | Auto-rotate 0/90 (and 180/270) according to aspect ratio | P2 | triv | prop | M02 | on `afterFileLoaded`, read `video-out-params/dw`/`dh`; if `dh > dw` and the display is landscape, apply `{"command":["set_property","video-rotate",90]}` (or 270), per the user's chosen pair | **Added from the critique (PotPlayer `101_0_11_11_5/6`).** Free given V29. Portrait phone video on a landscape monitor is the whole use case. **Off by default and always OSD the rotation with an undo** — silently rotating someone's video is the same class of surprise as N08 silently skipping. Note `dw`/`dh` **already account for `video-rotate`** (R-18, settled), so re-evaluating after applying rotation must not feed back — latch per file. |

---

### 2.2 Audio processing & output — 51 features (P0 8 · P1 20 · P2 20 · skip 1 · 2 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| A01 | 10-band graphic equalizer | P1 | md | af | M12 | declare once for 8 channels:<br>`['af','set','@rleq:lavfi=[anequalizer=c0 f=31 w=22 g=0 t=0\|c0 f=62 w=44 g=0 t=0\|…\|c0 f=16000 w=11000 g=0 t=0\|c1 f=31 …]']`<br>live: `['af-command','rleq','change', `${c*10+b}\|f=${FREQ[b]}\|w=${W[b]}\|g=${dB}`, 'anequalizer']`<br>FREQ `[31,62,125,250,500,1000,2000,4000,8000,16000]`, W `[22,44,88,175,350,700,1400,2800,5600,11000]`, `t=0` (Butterworth) | Verified: `change` indices count every declared entry (0–79 accepted, 200 rejected) and entries for absent channels are silently ignored, so declaring c0–c7 once is safe. `g` is in dB, matching PotPlayer's ±12 dB. **Do not use `superequalizer`** — see A48. |
| A02 | EQ presets (built-in + user) | P1 | sm | app | M12 | `{name, gains:number[10]}` in `audio-eq-presets.json`; applying a preset issues the `af-command … change` calls from A01 | Keep the shipped list short and honest. "Voice/Dialogue" and "Bass boost" are the two people actually use; genre presets are decorative. Ship presets as data so users can share JSON. |
| A03 | EQ preamp with clip guard | P1 | triv | af | M12 | `['af','add','@rlpre:lavfi=[volume=volume=-6dB:precision=float]']`<br>live: `['af-command','rlpre','volume','-6dB','volume']` | Verified that `volume` accepts `af-command`. `precision=float` avoids requantisation. Auto-preamp of −(max positive band gain) is what EqualizerAPO users expect. |
| A04 | Normalizer (PotPlayer Shift+N) | P1 | sm | af | M13 | aggressive: `['af','add','@rlnorm:lavfi=[dynaudnorm=f=250:g=9:p=0.85:m=4.0]']`, live `['af-command','rlnorm','g','15','dynaudnorm']`<br>EBU R128: `['af','add','@rlnorm:lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true:linear=false]']` | `dynaudnorm` supports `af-command`, `loudnorm` does **not** (rebuild to change targets). PotPlayer's "Release time" is dynaudnorm `g` (odd, 3–301). loudnorm upsamples to 192 kHz internally for true-peak detection. **PotPlayer ships this ON and it is a known complaint — ship it OFF.** |
| A05 | Dialogue (centre-channel) enhancement | P1 | sm | af | M13 | stereo: `['af','add','@rldlg:lavfi=[dialoguenhance=original=1:enhance=1:voice=2]']`, live `['af-command','rldlg','enhance','2','dialoguenhance']`<br>5.1: `['af','add','@rlch:lavfi=[pan=stereo\|FL=0.9*FC+0.707*FL+0.5*BL+0.5*LFE\|FR=0.9*FC+0.707*FR+0.5*BR+0.5*LFE]']`<br>fallback: `['af','add','@rldlg:lavfi=[equalizer=f=2500:t=o:w=1.2:g=4]']` | `dialoguenhance` requires **stereo** input — feed it after any downmix, never before. Pick the path from `audio-params/channel-count` rather than offering two confusing toggles. |
| A06 | Volume boost above 100% with a real limiter | P0 | sm | af | M10 | keep mpv's own volume ≤ 100 and do all boost in the chain, last:<br>`['set_property','volume', Math.min(100, uiPercent)]`<br>`['af','add', '@rlboost:lavfi=[volume=volume=${uiPercent/100}:precision=float,alimiter=level_in=1:level_out=1:limit=0.94:attack=5:release=50:level=disabled]']`<br>spawn: `--volume-max=100` | **MEASURED:** mpv applies software `volume` *after* the af chain, so an `alimiter` in `af` cannot protect against `--volume>100`. Proof: `--volume=200` + limiter → peak 0.7070 (8× baseline, limiter bypassed); `--volume=100` + in-chain gain + limiter → 0.5000 (works). **`applyBoostFilter()` in `src/main/player.ts` has this backwards today.** `alimiter` defaults to `level=true` (auto-renormalise) — you want `level=disabled`. |
| A07 | Volume percentage is cubic, not linear | P1 | triv | prop | M10 | A: `['set_property','volume', 100*Math.cbrt(uiPercent/100)]`<br>B: `['set_property','volume-gain', dB]` (−96…+12; widen with `--volume-gain-min/-max`) | **MEASURED and undocumented:** gain = (volume/100)³. volume 150 → 3.374×, i.e. +10.6 dB. `--volume-gain` is honest dB (measured `18` → 7.94×) but is *also* applied after the af chain, so it shares A06's limiter blind spot. |
| A08 | Mute, distinct from volume 0 | P0 | triv | prop | M10 | `{"command":["cycle","mute"]}` / `{"command":["set_property","mute",true]}`; observe `mute` | Already implemented. `ao-volume`/`ao-mute` exist but report "property unavailable" on `ao=null` and are AO-dependent — do not build UI on them. |
| A09 | Audio delay (A/V sync) | P0 | triv | prop | M10 | `{"command":["set_property","audio-delay",<seconds>]}` — positive delays audio<br>fine ±0.05 s, coarse ±0.5 s, reset 0 | Sign convention matches PotPlayer. PotPlayer's dialog is in ms, mpv is in seconds — divide at the boundary. Already wired; the missing half is per-file persistence. |
| A10 | Audio track switching with rich labels | P0 | sm | prop | M11 | observe `track-list`; each audio entry carries `id lang title codec audio-channels demux-samplerate demux-bitrate default forced external selected`<br>`{"command":["set_property","aid",<id>]}` · `"no"` to disable · `{"command":["cycle","aid"]}` | Render `[jpn] Commentary — FLAC 5.1`, never "Track 3". `mapTracks()` in `manager.ts` currently drops `audio-channels`, which is the field that makes the menu useful. Surface the `commentary` / `visual-impaired` / `hearing-impaired` flags as badges — PotPlayer does not. |
| A11 | Preferred audio language | P1 | triv | prop | M11 | `--alang=jpn,ja,eng,en` · `{"command":["set_property","alang",["jpn","ja","eng"]]}`<br>related: `--subs-with-matching-audio`, `--track-auto-selection=yes` | Takes effect on the next `loadfile`, not the current one. Pair with a per-file override so an explicit track pick sticks for that file. |
| A12 | External audio file load + auto-load | P1 | sm | cmd | M11 | `{"command":["audio-add","<abs path>","select"]}` (flags `select`\|`auto`\|`cached`)<br>`{"command":["audio-remove",<id>]}`<br>spawn: `--audio-file-auto=fuzzy --audio-file-paths=audio:Audio:dub:Dubs`<br>allowlist: `{"command":["get_property","audio-exts"]}` | `--audio-file-auto=fuzzy` is already set, but the **drop path is not**: `handleIncomingPaths()` treats any non-subtitle file as media, so dropping a `.mka` restarts playback with the audio file. Reuse the subtitle-drop pattern. Verified default `audio-exts`: `aac,ac3,aiff,ape,au,dts,eac3,flac,m4a,mka,mp1,mp2,mp3,mpc,oga,ogg,ogm,opus,tak,thd,tta,wav,wma,wv`. |
| A13 | 5.1 → stereo downmix | P0 | sm | prop | M14 | `{"command":["set_property","audio-channels","stereo"]}`<br>centre-lifted matrix: `['af','add','@rlch:lavfi=[pan=stereo\|FL=0.8*FC+0.707*FL+0.5*BL+0.5*LFE\|FR=0.8*FC+0.707*FR+0.5*BR+0.5*LFE]']` | `audio-channels=stereo` triggers **decoder** downmix for AC-3/AAC/DTS, which is a different matrix from mpv's own; `auto`/`auto-safe` never does. `--ad-lavc-downmix=no` forces the decoder to emit its native layout so *your* pan matrix runs. Runtime change takes effect immediately (verified). |
| A14 | Downmix clipping prevention | P1 | triv | prop | M14 | `{"command":["set_property","audio-normalize-downmix",true]}` (default `no`) | No effect if the downmix happens in the decoder or the system mixer — pair with `--ad-lavc-downmix=no`. Expose inside a Speaker-setup profile, not as a lone checkbox. |
| A15 | Speaker layout selection | P1 | sm | prop | M14 | `{"command":["set_property","audio-channels","7.1,5.1,stereo"]}` (ordered allowlist)<br>also `auto-safe` (default), `auto`, `stereo`, `mono`, `5.1`, explicit e.g. `fl-fr-lfe`<br>enumerate: `mpv --audio-channels=help` | Manual carries an explicit HDMI warning: `auto` makes the OS report every layout HDMI *can* carry even when the receiver cannot decode it, producing dropped channels or noise. An explicit whitelist is the correct default for HTPC users. |
| A16 | Stereo → surround upmix | P2 | sm | af | M14 | quality: `['af','add','@rlch:lavfi=[surround=chl_out=5.1:chl_in=stereo:lfe=1:lfe_low=128:lfe_high=256:lfe_mode=add]']`<br>cheap: `['af','add','@rlch:lavfi=[pan=5.1\|FL=FL\|FR=FR\|FC=0.5*FL+0.5*FR\|LFE=0.5*FL+0.5*FR\|BL=0.7*FL\|BR=0.7*FR]']`<br>then `{"command":["set_property","audio-channels","5.1"]}` | Setting `audio-channels` is **required** or mpv folds your 6 channels back to 2 at the AO. `surround` is FFT-based and costs noticeably more CPU than the pan matrix. |
| A17 | Channel mixer (matrix, phase, mute, balance) | P2 | md | af | M14 | matrix: `['af','add','@rlch:lavfi=[pan=stereo\|c0=0.7*c0+0.3*c1\|c1=0.3*c0+0.7*c1]']`<br>mono: `[pan=mono\|c0=0.5*c0+0.5*c1]` · swap: `[pan=stereo\|c0=c1\|c1=c0]`<br>`[stereotools=phasel=1]` · `[stereotools=mutel=1]` · `[stereotools=muter=1]` · `[stereotools=balance_in=0.3:balance_out=0.3:sbal=0.0]`<br>reorder only: `[channelmap=channel_layout=5.1:map=FL-FL\|FR-FR\|…]` | Option names are `mutel`/`muter`/`phasel`/`phaser` — **`mute_l` fails**. `stereotools` supports `af-command` for everything except `delay`; `pan` supports no commands at all, so a matrix change means re-adding the label. |
| A18 | Audio output device selection + hot swap | P1 | sm | prop | M15 | `{"command":["get_property","audio-device-list"]}` → `[{name:'auto',…},{name:'wasapi/{GUID}',description:'Speakers (…)'}]`<br>`{"command":["set_property","audio-device","wasapi/{GUID}"]}`<br>`--audio-fallback-to-null=yes`; observe `current-ao` | Setting `audio-device` forces an AO reinit — which makes it the **supported way** to apply `audio-exclusive` / `audio-samplerate` / `audio-format` changes. `current-ao` reads "property unavailable" while no AO is open; guard it. Re-enumerate on `WM_DEVICECHANGE`. |
| A19 | WASAPI exclusive mode | P1 | sm | prop | M15 | spawn: `--audio-exclusive=yes` (do **not** also pass `--ao`)<br>runtime: `['set_property','audio-exclusive',true]` then re-set `audio-device` to force AO reinit<br>`--wasapi-exclusive-buffer=min\|default\|<1..2000000 µs>` | mpv's wasapi AO is always event-mode, so PotPlayer's separate "event driven" checkbox has no counterpart — one checkbox suffices. **Ship OFF by default**: exclusive mode silences every other app and generates confused bug reports. `ao-reload` is documented as experimental/internal — prefer the audio-device round-trip. |
| A20 | Bitstream passthrough (AC3/E-AC3/DTS/DTS-HD/TrueHD/Atmos) | P1 | md | prop | M15 | `--audio-spdif=ac3,dts,dts-hd,eac3,truehd` — **five** names, and **M15 must validate the list itself before writing**<br>runtime: `['set_property','audio-spdif',…]`, then force a decoder reinit through **M11's mediator**, because `aid` is M11's property:<br>`ctx.commands.invoke('audio-tracks.reinitDecoder', {reason:'A20 passthrough'})`<br>pair with `--audio-exclusive=yes` and explicit `--audio-channels=7.1,5.1,stereo` | **Two corrections.** (1) An earlier revision wrote four names under the word "five" — the set is `ac3,dts,dts-hd,eac3,truehd`. (2) **`audio-spdif` is `String (default: )` with NO validation whatsoever.** `mpv --audio-spdif=atmos` and `set_property audio-spdif "ac3,atmos"` both **succeed silently** — a typo does not error, it just disables passthrough for that codec while the UI still shows it as on. M15 must check every entry against the five names and refuse the write otherwise. Specifying both `dts` and `dts-hd` behaves as `dts-hd`. Atmos rides inside TrueHD and E-AC-3 JOC — there is no separate Atmos switch. **`aid` belongs to M11 (§3.7) and M11 also restores it per file on `playback-restart` (A44) — a raw round-trip from here races that restore and selects the wrong dub.** Always go through the mediator. **Effort is `lg`, not `md`** (it coordinates M11, M15 and four filter modules) and it is **blocked on hardware** — do not schedule it into a release before someone has a receiver (R-13, SM-Q). **Passthrough silently disables EQ, normalizer, boost and the volume slider; the UI must show that.** |
| A21 | Pass-through after AC-3 re-encoding | P2 | sm | af | M15 | native mpv filter, not lavfi:<br>`['af','add','@rlac3:lavcac3enc=tospdif=yes:bitrate=640:minch=3']` | `minch=3` makes the filter detach for stereo so it never touches 2.0 audio. Only meaningful over SPDIF/optical — over HDMI, uncompressed multichannel PCM is better and free. **There is no DTS counterpart**; mpv ships only `lavcac3enc`. |
| A22 | Pitch-preserving speed change | P0 | triv | prop | M10 | default already correct: `--audio-pitch-correction=yes` auto-inserts `scaletempo2`<br>`{"command":["set_property","speed",1.5]}`<br>tuning: `--af=scaletempo2=search-interval=40:window-size=12:min-speed=0.25:max-speed=8.0`<br>chipmunk mode: `['set_property','audio-pitch-correction',false]` | Auto-inserted filters **do not appear in the `af` property**, so `core/af-chain` rebuilding `af` with `af set` will not delete scaletempo2. It mutes outside min-speed 0.25 / max-speed 8.0 — exactly the 0.25×–4× range already clamped in `player.ts`. |
| A23 | High-quality pitch correction (rubberband) | P2 | triv | af | M10 | `['af','add','@rltempo:rubberband=engine=finer']` (R3)<br>cheaper: `engine=faster` (R2)<br>options: `mpv --af=rubberband=help` | "If multiple audio filters can do pitch correction, only the **last** in the chain is used" — so this must sit after scaletempo2's position and nothing pitch-capable may follow it. Build reports both `rubberband` and `rubberband-3`, so R3 is available. |
| A24 | Pitch shift without changing speed | P2 | triv | prop | M10 | `{"command":["set_property","pitch",1.059463094352953]}` (+1 semitone = 2^(1/12); 2.0 = octave)<br>or `['af-command','rltempo','set-pitch','1.06']` / `'multiply-pitch'` | Documented range 0.01–100, but the *effective* range is bounded by scaletempo2's min/max-speed: with min-speed 0.25 the highest usable factor is 4. Setting `pitch` auto-inserts scaletempo2. |
| A25 | Master "audio filters off" bypass (Shift+A) | P1 | triv | cmd | **core/af-chain** | disable one slot in place: `{"command":["af","toggle","@rleq"]}`<br>bypass all: cache the chain, `['af','set','']`, restore with `['af','set', cached]` | Verified: `af toggle` flips `enabled:false`; `af set ""` clears; `af set <chain>` restores the full ordered chain including disabled entries written as `@label:!lavfi=[…]`. Much better than remove/re-add — settings survive the toggle. |
| A26 | Single-owner audio filter chain | P0 | md | app | **core/af-chain** | one command per change, whole chain rebuilt in fixed order:<br>`['af','set','@rlch:lavfi=[…],@rleq:lavfi=[…],@rlfx:lavfi=[…],@rlnorm:lavfi=[…],@rlboost:lavfi=[…]']`<br>disabled slot written in place as `@rleq:!lavfi=[…]`; empty chain `['af','set','']`<br>canonical order: channels → EQ → effects → loudness → boost/limiter LAST | Verified end to end: declared order is preserved, `!` disables in place, `af set ""` clears, and `af add` with an already-used label **replaces** rather than appending. Without a single owner, the EQ module's `af add` and the normalizer's `af clr` silently stomp each other and the boost limiter lands before the gain. |
| A27 | Live filter parameter updates (`af-command`) | P0 | sm | cmd | **core/af-chain** | **four** arguments, last is the libavfilter FILTER NAME:<br>`['af-command','<label>','<option>','<value>','<lavfi-filter-name>']`<br>e.g. `['af-command','rlcf','strength','0.3','crossfeed']`, `['af-command','rleq','change','12\|f=2000\|w=1400\|g=5','anequalizer']` | **Verified by experiment:** the 3-argument form fails with "error running command", and so does passing `'all'` as the 4th argument. Working targets are the filter's name or its instance name (`Parsed_volume_0`). Confirmed **not** to support `af-command`: `superequalizer`, `pan`, `loudnorm`. |
| A28 | Headphone crossfeed | P2 | triv | af | M16 | `['af','add','@rlfx:lavfi=[crossfeed=strength=0.6:range=0.5:slope=0.5:level_in=0.9:level_out=1]']`<br>live: `['af-command','rlfx','strength','0.3','crossfeed']`<br>Bauer alt: `['af','add','@rlfx:lavfi=[bs2b=profile=cmoy]']` (`default`\|`cmoy`\|`jmeier`) | PotPlayer has no native crossfeed — its users bolt on a DirectShow plugin. Free differentiator. |
| A29 | Crystallization (crystalizer) | P2 | triv | af | M16 | `['af','add','@rlcry:lavfi=[crystalizer=i=2.0:c=1]']`<br>live: `['af-command','rlcry','i','4','crystalizer']` | Near-exact match for PotPlayer's Shift+C. `i` is −10…10, default 2.0, 0 = unchanged, negative inverts. Default it to **0 (off)** and label it an effect. |
| A30 | Noise reduction | P2 | sm | af | M16 | `['af','add','@rlnr:lavfi=[afftdn=nr=12:nf=-25:tn=1]']`<br>`['af','add','@rlnr:lavfi=[anlmdn=s=0.00001:p=0.002:r=0.006]']`<br>`['af','add','@rlnr:lavfi=[arnndn=m=C:/path/model.rnnn]']` | `arnndn` **fails without a model file** (exit 2) and the `.rnnn` models are a separate download that conflicts with the footprint goal. Ship `afftdn` as the default; treat `arnndn` as a user-supplied model path. |
| A31 | Stereo widening | P2 | triv | af | M16 | `[stereowiden=delay=20:feedback=0.3:crossfeed=0.3:drymix=0.8]`<br>`[extrastereo=m=1.5]` · `[haas]` · `[earwax]`<br>mid/side: `[stereotools=mode=ms>lr:slev=1.5]` | `stereotools` `mlev`/`slev` have a minimum of **0.015625, not 0** — `mlev=0` fails to load; use 0.015625 for "off". |
| A32 | Vocal removal (karaoke) | P2 | triv | af | M16 | `['af','add','@rlfx:lavfi=[pan=stereo\|c0=c0-c1\|c1=c1-c0]']`<br>`[stereotools=mode=ms>lr:mlev=0.015625:slev=1]`<br>true 5.1: `['af','add','@rlch:lavfi=[pan=5.1\|FL=FL\|FR=FR\|FC=0\|LFE=LFE\|BL=BL\|BR=BR]']` | Be honest in the UI: the stereo phase-cancel trick also removes bass and everything else centre-panned and produces a mono-ish result. The 5.1 FC-mute is the only version that works well. |
| A33 | Reverb (PotPlayer "Freeverb") | P2 | sm | af | M16 | small room: `[aecho=in_gain=0.8:out_gain=0.88:delays=40\|55\|72:decays=0.35\|0.28\|0.22]`<br>large hall: `[aecho=0.9:0.85:50\|75\|110\|145:0.5\|0.4\|0.3\|0.25,aecho=0.9:0.9:180\|220\|280\|360:0.3\|0.25\|0.2\|0.15]` | **There is no reverb filter in FFmpeg.** `aecho` needs all four parameters (a 3-arg form fails). `afir` (convolution) fails with a single input — mpv's af lavfi bridge cannot supply an IR as a second input. Label the presets "Room / Hall", never "Freeverb". |
| A34 | Chorus, echo, flanger, phaser, tremolo, vibrato | P2 | triv | af | M16 | `[chorus=0.5:0.9:50\|60\|40:0.4\|0.32\|0.3:0.25\|0.4\|0.3:2\|2.3\|1.3]`<br>`[aecho=0.8:0.9:1000:0.3]` · `[flanger=delay=5:depth=2:regen=0:width=71:speed=0.5]`<br>`[aphaser=in_gain=0.4:out_gain=0.74:delay=3:decay=0.4:speed=0.5]`<br>`[tremolo=f=5:d=0.5]` · `[vibrato=f=5:d=0.5]` | One JSON line each once the effects slot exists. Bundle as a single "Effects" panel with a Reset button, not six menu entries. |
| A35 | Bass and treble shelf controls | P2 | triv | af | M12 | `['af','add','@rltone:lavfi=[bass=g=6:f=110:w=0.6,treble=g=4:f=8000:w=0.6]']`<br>live: `['af-command','rltone','g','8','bass']`<br>`[virtualbass=cutoff=250:strength=3]` · `[asubboost=dry=0.7:wet=0.7:decay=0.7:feedback=0.5:cutoff=100]` | `bass`/`treble` (aliases lowshelf/highshelf) both support `af-command`, so the knobs are live. `virtualbass` synthesises harmonics so small speakers imply bass they cannot reproduce — genuinely effective on laptops. |
| A36 | Night mode (dynamic range compression) | P1 | sm | af | M13 | `['af','add','@rlnight:lavfi=[acompressor=level_in=1:threshold=0.089:ratio=4:attack=20:release=250:makeup=2:knee=2.8]']`<br>live: `['af-command','rlnight','ratio','8','acompressor']`<br>speech: `[speechnorm=e=12.5:r=0.0001:l=1]`<br>**AC-3-native DRC: `--ad-lavc-ac3drc=1.0`** (0 = off, 1 = full) | `--ad-lavc-ac3drc` is the underrated one: AC-3 carries professionally authored DRC metadata and "the standard mandates DRC enabled by default, but mpv (and some other players) ignore this". Better night mode than any generic compressor, for one option. Takes effect on next decoder init — **do not round-trip `aid` yourself; it is M11's property (§3.7).** Call `ctx.commands.invoke('audio-tracks.reinitDecoder', {reason:'A36 ac3drc'})`, which serialises against M11's own per-file `aid` restore. |
| A37 | ReplayGain | P2 | triv | prop | M13 | `{"command":["set_property","replaygain","track"]}` — `no`\|`track`\|`album`<br>`replaygain-preamp` (dB) · `replaygain-clip` (false = lower gain to prevent clipping) · `replaygain-fallback` (dB) | Applied as gain, so it shares A06's post-chain position — but `replaygain-clip=no` (the default) already prevents clipping by lowering gain. Cheap win for the music half of the app. |
| A38 | Audio-only / background playback | P1 | sm | prop | M11 | `{"command":["set_property","vid","no"]}` — restore with `"auto"`<br>`--audio-display=no` (default `embedded-first`; `external-first` prefers folder.jpg)<br>already set: `--idle=yes --force-window=yes --keep-open=yes` | mpv side is trivial; the work is Electron-side (tray, suppressing the video window, not tearing down the `--wid` host while mpv is attached). Setting `vid=no` while embedded leaves the child window present but blank — decide whether to hide the host or paint a now-playing panel. |
| A39 | *(moved)* Media keys / SMTC | — | — | — | **M33** | see §2.7 U24 | Owner resolved in §1.5. |
| A40 | Gapless audio between playlist items | P2 | triv | prop | M28 | `--gapless-audio=weak` (default) \| `yes` \| `no`; `{"command":["set_property","gapless-audio","yes"]}`<br>pair with `--prefetch-playlist=yes` | `yes` keeps the device open with the **first** file's parameters, so a 44.1 kHz first track resamples everything after it — correct only for a single-album queue. `weak` is the right default for a mixed folder. |
| A41 | Forced output sample rate / format | P2 | sm | prop | M15 | `--audio-samplerate=48000` (0 = follow source)<br>`--audio-format=s32` (names: `mpv --af=format=format=help`)<br>apply at runtime by setting the property then round-tripping `audio-device` | Leaving both on auto is correct for almost everyone; forcing a rate inserts a resampler that can only lose quality. Bury under Advanced — PotPlayer surfacing this is why its audio settings intimidate people. |
| A42 | Audio buffer / receiver quirk escape hatches | P2 | triv | prop | M15 | `--audio-buffer=0.2` · `--wasapi-exclusive-buffer=min` · `--audio-stream-silence=yes` + `--audio-wait-open=1` | Manual is blunt: `--audio-buffer` "should be used for testing only" and `--audio-stream-silence` is "strongly discouraged" because it changes A/V-sync and underrun handling. Expose only on a troubleshooting page with those warnings copied verbatim. |
| A43 | Graceful recovery when the device disappears | P1 | sm | prop | M15 | `--audio-fallback-to-null=yes`<br>observe `current-ao`; on device-change re-read `audio-device-list`; if the configured device is gone fall back to `auto` with an OSD toast | The manual describes exactly this pattern. `current-ao` is "property unavailable" whenever no AO is open — treat that as the signal, not as an error. PotPlayer handles this poorly; it is a differentiator. |
| A44 | Per-file sticky audio settings | P1 | sm | app | M11 | slice registered with `core/per-file`: `{aid, audioDelay, volume?}`; on `file-loaded` apply `aid` then `audio-delay` | Track ids are **not stable** across differently-muxed files — match on `(lang, title, codec)` with id as fallback, or the wrong dub gets selected on the next release group. |
| A45 | Audio format readout | P1 | sm | prop | M29 (section) | `audio-codec-name`, `audio-params`, `audio-out-params`, `audio-bitrate`, `current-ao`, `af`<br>`audio-params`/`audio-out-params` = `{samplerate, channel-count, channels, hr-channels, format}` | Verified the two differ and **both matter** (`audio-params` `s16` vs `audio-out-params` `floatp`). Showing "source 5.1 → output stereo" is how a user discovers the downmix is happening in the wrong place. The audio twin of showing the active hwdec. |
| A46 | *(moved)* Audio recording | — | — | — | **M23** | see §2.4 C16 | Owner resolved in §1.5. |
| A47 | Decoder-side downmix control | P2 | triv | prop | M14 | `--ad-lavc-downmix=no` (default no) · `--ad-lavc-threads=0` · `--ad=<decoder>` | Invisible plumbing that decides whether *your* pan matrix or the decoder's built-in one runs. Set it explicitly. Passthrough via `--ad` "is not possible" — use `--audio-spdif`. |
| A48 | 18-band superequalizer | skip | sm | af | — | `[superequalizer=1b=1:…:18b=1]`, centres 65…20000 Hz | **Verified unsuitable, recorded so nobody rediscovers it:** band gains are LINEAR multipliers (1 = unity) not dB; the accepted range is 0–20 (`1b=25` and `1b=-1` both fail to load); and it supports no `af-command`, so every slider drag rebuilds the filter and glitches the audio. Use `anequalizer`. |
| A49 | Linear-phase FIR equalizer (AutoEq curves) | P2 | sm | af | M12 | **note the single quotes**, or the commas split the lavfi graph:<br>`['af','add',"@rlfeq:lavfi=[firequalizer=gain_entry='entry(31,3);entry(62,2);…;entry(16000,2)':delay=0.01:accuracy=5:wfunc=hann:scale=linlog]"]` | Verified: the quoted form loads; the unquoted form and a `gain=if(lt(f,1000),6,0)` expression both fail. Adds `delay` seconds of latency (default 0.01) which shifts A/V sync — mpv compensates, but do not raise it casually. |
| A51 | System volume, distinct from player volume | P2 | md | app | M33 | not an mpv feature. Windows core-audio: `IAudioEndpointVolume::SetMasterVolumeLevelScalar` / `SetMute` via a native addon, or a PowerShell/`ffi` fallback.<br>PotPlayer keys (`101_0_12_9`): master ± `Ctrl+Alt+Shift+↑/↓`, master mute, wave ± `Ctrl+Alt+↑/↓`, wave mute; plus `Shift+↑/↓` master volume | **Added from the critique — it was absent from the matrix entirely** while five real PotPlayer keys pointed at it. Belongs to **M33**, which already owns process-global registrations, **not** to M10 (M10 owns `volume`/`volume-gain`, the *player's* volume, and the two must never be confused in the UI or in the OSD text). Needs a native or PowerShell path, so P2 is honest — but it must be *listed*, because otherwise a `potplayer` preset key maps to nothing and the omission looks like a bug. Folds into the D-4 single-addon decision (§7.9). |
| A50 | Output profiles (Headphones / Laptop / TV / Receiver) | P1 | md | app | M15 | each profile is one ordered `['af','set', …]` plus a few property writes:<br>Headphones → `audio-channels=stereo`, centre-lift pan, crossfeed on, passthrough off<br>Laptop → stereo, dialogue enhance on, virtualbass on, normalizer on<br>TV → stereo or 5.1, no filters<br>Receiver → `audio-channels=7.1,5.1,stereo`, `audio-exclusive=yes`, `audio-spdif=ac3,dts-hd,eac3,truehd`, `af set ''` | The single biggest UX opportunity in audio and nearly free once the slot chain exists. PotPlayer's passthrough instructions require visiting two preference trees and end with "remember to set it back afterwards" — that is the failure mode to design out. |

---
### 2.3 Subtitles — 53 features (P0 15 · P1 18 · P2 14 · skip 5 · 1 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| S01 | Core format support (SRT/ASS/SSA/VTT/MicroDVD/VobSub/PGS/LRC/SBV/SCC/YTT/MKS) | P0 | triv | prop | M17 | nothing to write. Verified default `--sub-auto-exts`:<br>`ass,idx,lrc,mks,pgs,rt,sbv,scc,smi,srt,srv3,ssa,sub,sup,utf,utf-8,utf8,vtt,ytt`<br>extend: `{"command":["set_property","sub-auto-exts",[…]]}` or `--sub-auto-exts-append=xyz` | A **single-line** MicroDVD file fails to probe (score below `--demuxer-lavf-probescore` 26); 3-line files work. Real files are multi-line — do **not** lower probescore to "fix" it, that causes false-positive demuxer matches. |
| S02 | SMI/SAMI single-language | P0 | triv | prop | M17 | `smi` is already in `sub-auto-exts`<br>`{"command":["sub-add","C:/path/Movie.ko.smi","select","한국어","ko"]}` | Verified: a CP949 single-language SMI renders correctly with no options set. This is the **only** SMI case that works out of the box — S03/S04 are the ones that do not. |
| S03 | SMI multi-language (KRCC/ENCC) track splitting | P0 | md | app | M18 | parse the `.smi`, group `<SYNC Start=n><P Class=X>` by Class, emit one `.ass` per class into the cache dir, then<br>`{"command":["sub-add","<cache>/<hash>.KRCC.ass","auto","한국어 (KRCC)","ko"]}`<br>`{"command":["sub-add","<cache>/<hash>.ENCC.ass","auto","English (ENCC)","en"]}`<br>then `{"command":["set_property","sid",<preferred>]}` | **Verified failure, not speculation.** Two `<SYNC>` events at the same PTS: `ff_subtitles_queue_finalize` sets duration = next_pts − pts, so the *first* gets duration 0 and is silently dropped. In real Korean files KRCC comes first, so **the Korean line is exactly the one that disappears**. `libavcodec/samidec.c` never reads `Class` at all. `--sub-stretch-durations=yes` makes it worse (596-hour duration). |
| S04 | Malformed SMI header normalisation | P0 | sm | app | M18 | preflight before `sub-add`: strip BOM handling is fine as-is; strip leading whitespace/blank lines; `/^\s*<\s*sami\s*>/i` → literal `<SAMI>`; write the normalised copy to `%APPDATA%/RLPlayer/subcache/<sha1>.smi` and `sub-add` **that** | FFmpeg's probe is `strncmp(buf,"<SAMI>",6)` — case-sensitive, exact, no leading whitespace. **Three verified total-silence failures:** lowercase `<sami>`, two leading newlines, and `<SAMI >`. Extension fallback does not rescue them because `convert_charset()` replaces the file stream with an in-memory stream before probing, discarding the filename hint. Never modify the user's file in place. |
| S05 | SMI Ruby (한자 독음) | P2 | lg | app | M18 | inside the SMI→ASS converter: emit base text as the Dialogue line and ruby as a second smaller positioned event `{\an8\fs<0.5*size>\pos(x,y)}독음`, or drop ruby text entirely but keep the base line intact | libass has no ruby primitive; anything we ship is an approximation. Being honest about that beats a half-broken render. **Never let ruby markup leak into the visible line.** |
| S06 | SMI per-class CSS styling | P2 | md | app | M18 | parse `<STYLE TYPE="text/css">` into a real ASS `[V4+ Styles]` section: `color:`→PrimaryColour (`&HAABBGGRR`, BGR order, inverted alpha), `font-family:`→Fontname, `font-size:`→Fontsize, `font-weight:bold`→`Bold=-1` | Most Korean SMI style blocks only set a font and white text, which is already the default. Do this only after S03 ships and is stable, and gate it behind "Use style defined in subtitle". |
| S07 | TTML / DFXP | P2 | md | app | M18 | converter only — **FFmpeg has a TTML muxer but no demuxer**. Parse `<p begin="00:00:01.000" end="…">` to SRT/ASS, write to the cache dir, then `{"command":["sub-add","<cache>/<hash>.srt","select","TTML","und"]}`. Support clock-time and offset-time (`123.4s` / `3000t` with `ttp:tickRate`). | Verified: a valid TTML passed to `--sub-file` gives `sub-text` = unavailable. TTML is rare as a sidecar on a Windows disk — it mostly lives inside streaming manifests — so P2 is honest. |
| S08 | Embedded track enumeration and switching | P0 | sm | prop | M17 | observe `track-list`; per track `id type lang title codec codec-desc default forced hearing-impaired external external-filename selected main-selection`<br>`{"command":["set_property","sid",3]}` · `{"command":["cycle","sid"]}` · `{"command":["cycle","sid","down"]}` · `"no"` to disable | Render `[kor] 완전자막 (ASS)`, never "Track 3". `track-list/N/main-selection` is the correct way to tell primary from secondary — do not infer it from `sid`/`secondary-sid`, which can be stale during a track change. |
| S09 | External subtitle auto-load | P0 | triv | prop | M17 | `--sub-auto=fuzzy`<br>`--sub-file-paths=sub;subs;subtitles;자막` — **semicolons** | **Live bug in the current code:** `manager.ts` passes `--sub-file-paths=subs:Subs:subtitles:Subtitles:SUBS`. Verified: with `:` only the video's own directory is scanned (`:` is the Unix separator and Windows paths contain colons). With `;` all six are scanned. **Second verified bug:** on NTFS, case-variant entries resolve to the same folder and produce **three duplicate tracks** — use lowercase entries only. Also verified: `--sub-auto=exact` already parses `.ko.`/`.en.` suffixes into `lang`. |
| S10 | App-level fuzzy subtitle matching | P1 | md | app | M17 | after `file-loaded`, scan the video dir + sub-file-paths dirs; score candidates against the video basename (strip `[…]`/`(…)`, `1080p\|720p\|x264\|x265\|HEVC\|WEB-DL\|BluRay`, release-group suffixes; compare remaining tokens plus `S\d+E\d+` or a bare episode number); if it clears threshold and `track-list/N/external-filename` does not already have it: `{"command":["sub-add","<path>","auto","<basename>","<lang>"]}` | **Verified gap:** mpv's `fuzzy` only matches subtitle files *containing* the full video basename. A video `[Group] Show - 02 [1080p].mp4` did **not** pick up a sibling `Show - 02.srt`. The episode-number match is what matters for binge-watching — weight it heavily. |
| S11 | Drag-and-drop a subtitle onto the window | P0 | triv | cmd | M17 | `{"command":["sub-add","<file>","select"]}` | The existing `SUB_EXTENSIONS` array is missing `sup pgs mks sbv scc ytt srv3 utf8 sami ttml dfxp`. Keep it in sync with mpv's `sub-auto-exts` **plus** our converter's formats, and route `.smi`/`.ttml` through M18 first. |
| S12 | Reload subtitle / auto-reload on change | P1 | sm | cmd | M17 | `{"command":["sub-reload"]}` or `{"command":["sub-reload",3]}`<br>auto: `fs.watch()` each `track-list/N/external-filename`, debounce ~300 ms, then `sub-reload` with that id | "Works on external subtitle files only" — grey the menu item when `track-list/N/external` is false. **`sub-reload` is M17's, exclusively (§3.7).** The spec used to contradict itself here: M18's "Must NOT touch" column claimed `sub-reload`, while this row (M17) and S22 (M19) both issued it — three writers for one command. Resolved: **M17 owns it and exposes `subs-tracks.reload({sid?})`**; S34 (M18, encoding change) and S22 (M19, restyle) both call that command instead. This is also the mechanism for runtime encoding changes (S34). |
| S13 | Preferred subtitle languages / auto-selection rules | P1 | sm | prop | M17 | `--slang=ko,kor,en,eng` · `{"command":["set_property","slang",["ko","en"]]}`<br>`--subs-with-matching-audio=<yes\|forced\|no>` (def yes)<br>`--subs-fallback=<no\|default\|yes>` (def default)<br>`--subs-fallback-forced=<no\|yes\|always>` (def yes)<br>`--subs-match-os-language=<yes\|no>` (def yes) | Ship `slang=ko,kor` as the default for a Korean-market player. PotPlayer supports AND/OR expressions (`forced&&english`); mpv's `slang` is a plain ordered list, so complex rules must be implemented by scoring `track-list` and setting `sid` explicitly. |
| S14 | Remember subtitle track per file | P1 | sm | app | M17 | slice with `core/per-file`: `sid`, `secondarySid`, `subDelay`, `subVisibility`, `subCodepage`, `subSpeed`, and for external tracks the resolved `external-filename` so it can be re-added before `sid` is set. On `file-loaded`, wait for `track-list`, re-add externals, then set `sid`. | **Match by `external-filename`, not by `sid`** — sid numbering changes if the auto-loader finds a different set of files. |
| S15 | Prefer external vs embedded subtitles | P2 | sm | app | M17 | no single mpv option. On `file-loaded` read `track-list`, filter by `external`, set `sid` yourself. To hard-ignore embedded, start with `--sid=no` and select only externals after they are added. | There is **no `--prefer-external-subs`** in mpv — the full option list was checked. Entirely app-side track scoring. |
| S16 | Subtitle visibility toggle | P0 | triv | prop | M17 | `{"command":["cycle","sub-visibility"]}` / `{"command":["set_property","sub-visibility",false]}`<br>secondary: `{"command":["cycle","secondary-sub-visibility"]}` | Use `sub-visibility`, **never `sid=no`** — the latter drops decoding state and loses the track selection. |
| S17 | Font, size, bold, italic | P0 | sm | prop | M19 | `{"command":["set_property","sub-font","Malgun Gothic"]}` (def `sans-serif`)<br>`{"command":["set_property","sub-font-size",38]}` (1–9000, def 38)<br>`{"command":["set_property","sub-bold",true]}` · `{"command":["set_property","sub-italic",true]}` | `sub-font-size` is "scaled pixels at a window height of 720" — it auto-scales with the window, do not recompute on resize. Windows font provider is DirectWrite, so family names work (both `Malgun Gothic` and `맑은 고딕`). **All four are ignored for ASS unless `sub-ass-override` is `force`, and ignored entirely for image subtitles.** |
| S18 | Colour, outline, shadow, opaque/background box | P0 | sm | prop | M19 | `{"command":["set_property","sub-color","#FFFFFFFF"]}` (`#AARRGGBB`)<br>`{"command":["set_property","sub-outline-color","#FF000000"]}`<br>`{"command":["set_property","sub-outline-size",1.65]}` (0 disables)<br>`{"command":["set_property","sub-back-color","#AF000000"]}`<br>`{"command":["set_property","sub-shadow-offset",0]}`<br>`{"command":["set_property","sub-border-style","background-box"]}` — `outline-and-shadow`\|`opaque-box`\|`background-box` | Canonical names are `sub-outline-color` / `sub-outline-size` / `sub-back-color`; `sub-border-color`, `sub-border-size`, `sub-shadow-color` are aliases that still work. **There is no `sub-shadow-size`** — the shadow is offset-driven. `background-box` (ASS BorderStyle=4) is the right choice for the accessibility preset. |
| S19 | Position, margins, alignment | P0 | sm | prop | M19 | `{"command":["set_property","sub-pos",100]}` (0–150; 100 = original, >100 moves down)<br>`sub-margin-x` (def 19) · `sub-margin-y` (def 34) · `sub-margin-y-offset` (def 0, **intended for transient UI-avoidance nudges** — use it when the control bar is visible)<br>`sub-align-x` (`left`\|`center`\|`right`) · `sub-align-y` (`top`\|`center`\|`bottom`) · `sub-justify` | PotPlayer's Alt+Drag horizontal move has **no mpv equivalent** — there is no `sub-pos-x`. Emulate with `sub-align-x=left` + growing `sub-margin-x`, which is coarse. `sub-pos` above 100 can cut text off (libass limit) — prefer `sub-margin-y` for raising. `sub-align-*` never apply to ASS except in `--sub-ass=no` mode. |
| S20 | Letter spacing, line spacing, blur | P2 | triv | prop | M19 | `{"command":["set_property","sub-spacing",0]}` (−10…10)<br>`{"command":["set_property","sub-line-spacing",0]}` (−1000…1000)<br>`{"command":["set_property","sub-blur",0]}` (0–20) | mpv has **no per-axis text scale** for plain subtitles. The closest is `sub-ass-style-overrides` with `Default.ScaleX=120`, which needs `sub-ass-override` ≥ `yes`. Do not promise PotPlayer's Scale X / Scale Y. |
| S21 | ASS style override modes (5 states) | P0 | triv | prop | M19 | `{"command":["set_property","sub-ass-override","scale"]}`<br>choices: `no` \| `yes` \| `scale` \| `force` \| `strip` — **default is `scale`**<br>cycle: `{"command":["cycle-values","sub-ass-override","no","scale","force","strip"]}`<br>related: `{"command":["set_property","sub-scale-signs",true]}` (def no) | **The current code is too coarse:** `manager.ts` does `--sub-ass-override=${bool ? 'force' : 'no'}`, collapsing five modes into the two most extreme and skipping the sane default. Expose all five as a named enum. `sub-scale-signs=yes` is what makes `scale` mode safe on anime — surface it next to the selector. Note this also affects HTML tags in SRT. |
| S22 | Targeted ASS style overrides | P1 | sm | prop | M19 | `{"command":["set_property","sub-ass-style-overrides",["Default.Bold=1","Default.Fontname=Malgun Gothic","ScaledBorderAndShadow=yes"]]}`<br>`{"command":["set_property","sub-ass-styles","C:/path/custom.ass"]}` | Only takes effect when `sub-ass-override` is `yes`/`scale`/`force`; with `no` it is ignored. Whether already-rendered events restyle immediately is unverified — for external tracks, **ask M17 to reload** (`ctx.commands.invoke('subs-tracks.reload')`); `sub-reload` is M17's property/command, not M19's (§3.7). `--sub-ass-force-style` is a deprecated alias. |
| S23 | Render subtitles into the letterbox bars | P1 | triv | prop | M19 | `{"command":["set_property","sub-use-margins",true]}` — **default already yes**<br>`{"command":["set_property","sub-ass-force-margins",true]}` — default no | PotPlayer's "Force subtitles under the video" is both set to yes. mpv has no equivalent of "reserve a fixed bottom margin even with no subtitle" — that needs M02's `video-margin-ratio-bottom` (V28). Coordinate. |
| S24 | Subtitle scale | P1 | triv | prop | M19 | `{"command":["set_property","sub-scale",1.0]}` (0–100, def 1)<br>`sub-scale-by-window` (def yes) · `sub-scale-with-window` (def yes) · `sub-ass-scale-with-window` (def no) · `secondary-sub-scale` | Manual warns `sub-scale` "affects ASS subtitles as well and may lead to incorrect rendering — use with care, or use `--sub-font-size` instead". Pair the slider with `sub-scale-signs=yes` so scaling does not blow up typeset signs. |
| S25 | Image subtitle handling (VobSub / PGS) | P1 | sm | prop | M19 | `{"command":["set_property","sub-gauss",0.5]}` (0–3, def 0)<br>`stretch-dvd-subs` · `stretch-image-subs-to-screen` · `image-subs-video-resolution` · `sub-forced-events-only`<br>HDR: `--image-subs-hdr-peak` (`sdr`\|`video`\|`video-static`\|`video-dynamic`\|10–10000, def 1000) · `--sub-hdr-peak` (def auto)<br>detect via `track-list/N/codec` ∈ {`dvd_subtitle`,`hdmv_pgs_subtitle`,`dvb_subtitle`,`xsub`} | **Grey out font/colour/outline controls for image tracks** rather than silently ignoring them. `sub-gauss` non-zero forces software scaling and can be slow. Wrong HDR peak makes subs painfully bright on HDR content. |
| S26 | Subtitle style presets | P1 | sm | app | M19 | a preset is a property→value map applied in one batch. Readable: `sub-font-size=52, sub-border-style=background-box, sub-back-color=#C0000000, sub-outline-size=2.5, sub-shadow-offset=2, sub-ass-override=force, sub-scale-signs=yes, sub-margin-y=48`. Fansub-safe: `sub-ass-override=no, sub-use-margins=no, sub-ass-force-margins=no`. | mpv's built-in `--profile=sub-box` does roughly the Readable preset, but profiles are startup-time — replicate as explicit property sets over IPC. |
| S27 | Subtitle delay + per-file persistence | P0 | triv | prop | M20 | `{"command":["set_property","sub-delay",-0.5]}` (fine ±0.1, coarse ±0.5, reset 0)<br>`{"command":["set_property","secondary-sub-delay",0]}`<br>OSD: `{"command":["show-text","자막 싱크 ${sub-delay} 초",1500]}` *(we draw our own OSD instead)* | Already implemented; **persistence is what is missing**. mpv positive `sub-delay` = subtitles appear LATER. PotPlayer's UI says "Faster"/"Slower" — label ours in the direction PotPlayer users expect and negate internally. Make the step size configurable, as PotPlayer does. |
| S28 | Snap sync to the current subtitle line | P1 | sm | app | M20 | read `sub-start` (or `sub-start/full`) and `time-pos`, then `['set_property','sub-delay', curDelay + (timePos − subStart)]`<br>"next" variant: `{"command":["sub-seek",1]}` first, read the new `sub-start`, then apply | **Verified gotcha:** `sub-start`/`sub-end` report the RAW file timestamps, **not** times after `sub-speed` scaling — the lookup is `source_time = display_time / sub-speed`. Combining snap-sync with FPS correction without dividing gives an error of exactly the speed factor. Returns null when no subtitle is on screen — handle it, do not NaN the delay. |
| S29 | Step and seek by subtitle event | P1 | triv | cmd | M20 | timing shift: `{"command":["sub-step",1]}` / `-1`; secondary: `{"command":["sub-step",1,"secondary"]}`<br>video seek: `{"command":["sub-seek",1]}` / `-1`; **`{"command":["sub-seek",0]}` seeks to the start of the current line** | `sub-step` shifts `sub-delay`; `sub-seek` seeks video. Do not confuse them — that is why they live in one module. For embedded subs, forward `sub-seek` "works only with events already displayed or within a short prefetch range", so far-forward seeks may do nothing. |
| S30 | Subtitle FPS / speed correction | P1 | sm | prop | M20 | **use `sub-speed`, not `sub-fps`**:<br>`{"command":["set_property","sub-speed", sourceFps/targetFps]}` — 25→23.976 is `1.042709`; range 0.1–10, def 1<br>preset ladder 12, 15, 23.976, 24, 25, 29.97, 30 plus custom<br>after setting, `{"command":["seek",0,"exact"]}` so buffered events re-resolve | **Verified, and it corrects the obvious-looking answer:** `--sub-fps` does *nothing* for frame-based subtitles demuxed by libavformat — lavf's microdvd demuxer already converted frames to timestamps, so there is nothing left to scale. `sub-speed` works (0.5 changed the displayed event as predicted). **Do not ship UI wired to `sub-fps`.** |
| S31 | Keep sync changes across files | P2 | triv | app | M20 | app flag: when on, do not reset `sub-delay` on `file-loaded`; when off, restore the per-file value (or 0) | mpv resets `sub-delay` on file change by default, so "keep" is the behaviour that costs work. Per-file persistence (S27) is the more valuable half. |
| S32 | Secondary subtitle track (dual subs) | P1 | sm | prop | M20 | `{"command":["set_property","secondary-sid",4]}` (`no`\|`auto`\|0–8190, **def `no`**)<br>`secondary-sub-pos` (0–150, **def 0** = top) · `secondary-sub-delay` · `secondary-sub-scale` · `secondary-sub-visibility` · `secondary-sub-ass-override` (**def `strip`**)<br>read: `secondary-sub-text`, `secondary-sub-start`, `secondary-sub-end` | Three caveats users will hit: (1) styling and formatting tags are **always stripped** on the secondary track — do not promise full ASS. (2) Bitmap subtitles "will always be rendered in their usual position", so a PGS secondary **overlaps** the primary — block image tracks from the secondary selector. (3) `\an8` signs on the primary collide with the secondary. Offer one-click swap, as PotPlayer does. |
| S33 | Character encoding auto-detection (CP949/EUC-KR) | P0 | triv | prop | M18 | nothing to do — `--sub-codepage` defaults to `auto` and the bundled mpv has uchardet. Order: explicit `+cp` prefix → BOM → looks-like-UTF-8 → uchardet → `UTF-8-BROKEN` | Verified on the actual bundled binary: a CP949 SMI produced `libuchardet detected charset as UHC` and rendered Korean correctly. UHC = CP949 = Windows-949. **Add a startup assertion that `uchardet` appears in mpv's feature list** — if the build is ever swapped for one without it, this silently degrades to mojibake. |
| S34 | Manual encoding override | P0 | sm | prop | M18 | **two steps, both required:**<br>`{"command":["set_property","sub-codepage","+cp949"]}` — M18 owns `sub-codepage` — then **`ctx.commands.invoke('subs-tracks.reload')`**, because `sub-reload` is M17's (§3.7)<br>dropdown: `auto`, `+cp949`, `+euc-kr`, `+utf-8`, `+utf-16le`, `+cp932`, `+gb18030`, `+big5`, `+cp1252`, `+cp1251` | The leading `+` means **force**; without it mpv still short-circuits to UTF-8 if the data happens to validate. Verified the runtime path works (`+cp1252` + `sub-reload` turned 안녕하세요 into mojibake, proving re-decode). `sub-reload` works on **external tracks only** — mkv subtitles "are always assumed to be UTF-8", so grey the dropdown for embedded tracks. |
| S35 | OpenSubtitles search | P2 | md | ext | M21 | `GET https://api.opensubtitles.com/api/v1/subtitles?languages=ko&query=matrix`<br>headers `Api-Key: <key>`, `User-Agent: RLPlayer v<version>`, `Accept: application/json`<br>hash search: `?languages=ko&moviehash=<16 hex>`; hash = 64-bit LE sum of filesize + every uint64 in the first and last 64 KiB | **Four live-probed facts:** (1) an API key is mandatory even for `/login` (403 otherwise). (2) **query parameters must be alphabetically ordered** or you get a 301 with `X-OS-Rule: canonical`. (3) rate limit is 5 req/s with `RateLimit-*` headers on every response. (4) `/infos/languages` and `/infos/formats` need no auth. **Demoted to P2 and off by default behind an explicit consent dialog** — this sends a fingerprint of the user's file to a third party. Never auto-search on file open. |
| S36 | OpenSubtitles download and attach | P2 | md | ext | M21 | `POST /login` with `Api-Key` → `token`; then `Authorization: Bearer <token>`<br>`POST /download` `{"file_id": <id>}` → `{"link","remaining","reset_time"}`; GET the link, save to `subcache/`, then `{"command":["sub-add","<path>","select","<release>","<lang>"]}` | Anonymous download is **not** possible (503). **Do not hardcode a quota number** — the free-tier figure could not be verified; read `remaining` and `reset_time` from the `/download` response body and display those verbatim. Treat HTTP 406 as quota exhausted. |
| S37 | Pluggable subtitle providers | P2 | md | app | M21 | `interface SubtitleProvider { id; name; requiresAuth; search(ctx:{path,hash,size,title,langs}): Promise<Result[]>; download(r): Promise<Buffer> }` plus a registry modules self-register into | Do the interface now even if OpenSubtitles is the only implementation — retrofitting after the UI is wired to one API is the expensive version. PotPlayer's search tokens tell you what a provider needs: `%SS[.EXT]`, `%NAME[.EXT]`, `%SIZE`, `%HASH`. |
| S38 | Subtitle upload | skip | md | ext | — | — | Needs an account, a moderation flow and a metadata form; serves contributors, not viewers, and adds an outbound *write* path. Nobody switching from PotPlayer will abandon us over a missing upload button. |
| S39 | Copy the current subtitle line | P1 | triv | prop | M21 | `{"command":["get_property","sub-text"]}` → Electron `clipboard.writeText`<br>variants `sub-text/ass`, `sub-text/ass-full`, `secondary-sub-text` | Returns an **empty string for image subtitles** — disable the action for those. Reflects the current subtitle "regardless of sub visibility", so it works with subs hidden. |
| S40 | Subtitle browser (all lines, click to seek) | P1 | md | app | M21 | mpv exposes only the *current* event, so parse the file yourself: read the path from `track-list/N/external-filename` and parse SRT/ASS/VTT/SMI in TypeScript. Click → `{"command":["seek",<start>,"absolute","exact"]}`.<br>Embedded tracks: no mpv API to dump all events — build the list incrementally by observing `sub-text`/`sub-start`/`sub-end`, or shell out (see S43). | **Confirmed limitation:** there is no "give me all subtitle events" property. Watch the S28/S30 gotcha — a browser seek must use `raw_time * sub-speed + sub-delay` when either is non-default. Ship the external-file path first; it covers the Korean SMI case. |
| S41 | *(moved)* A-B repeat the current subtitle | — | — | — | **M26** | see §2.5 N20 | Owner resolved in §1.5. |
| S42 | Save / export a subtitle with sync baked in | P1 | md | app | M18 | pure TypeScript — **mpv cannot write subtitle files, do not go looking for a command.** Read source (or the converter's normalised copy), apply `sub-delay` and `sub-speed` to every timestamp, serialise, write UTF-8 with BOM. Three menu entries: Save as…, Save as video filename (`<dir>/<basename>.<lang>.srt`), Save SMI. | PotPlayer's changelog has "Fixed a problem in which Hangul was broken when subtitle sync was saved (smi)" — write SMI as UTF-8 and say so, or CP949 on request. Mostly serialisation work on the same model as S03 once that exists. |
| S43 | Extract an embedded subtitle to a file | P2 | sm | ext | M23 | `ffmpeg -y -i "movie.mkv" -map 0:s:2 -c:s srt "out.ko.srt"` (`-c:s ass` to keep styling, `-c:s copy` when already ASS)<br>image tracks: `-c:s copy` to `.sup` — no OCR<br>the `0:s:N` index is `track-list/N/ff-index` mapped to the subtitle-stream ordinal, **not** mpv's `sid` | **This is the only feature that would force bundling ffmpeg — and we will not.** mpv.exe statically links FFmpeg but exposes no CLI. Options in preference order: (a) skip; (b) build the list incrementally from `sub-text`; (c) detect an ffmpeg already on PATH and enable it only then, clearly labelled. |
| S44 | Subtitle translation | P2 | lg | ext | M21 | observe `sub-text`, POST the line to a translation API, render the result as the secondary subtitle — or, lower-latency, draw it in the HTML overlay we already have. Placement maps to `secondary-sub-pos` 0 (top) / 100+ (bottom). | Directly conflicts with the zero-network-at-rest guarantee: it streams what the user is watching to a third party line by line. If it ships at all: off by default, explicit consent naming the destination, **user-supplied API key**, never one we embed. Honestly, a P2 that may never ship. |
| S45 | Whisper speech-to-text subtitles | skip | lg | ext | — | would follow PotPlayer's model: an optional, separately downloaded engine. `ffmpeg -i in.mkv -vn -ar 16000 -ac 1 -f wav -` → whisper.cpp → SRT → `sub-add` | A different product surface: model management, GPU detection, download UI, multi-GB models, and a maintenance tail visible in PotPlayer's own changelog ("would not work on NVIDIA 5000 series", "added the ability to update the Whisper engine"). |
| S46 | SDH and regex subtitle filtering | P2 | triv | prop | M19 | `{"command":["set_property","sub-filter-sdh",true]}` (def no)<br>`sub-filter-sdh-harder` (def no) · `sub-filter-sdh-enclosures` (**default is** `(),[],（）`)<br>`{"command":["set_property","sub-filter-regex",["OpenSubtitles","Subtitles by"]]}`<br>`sub-filter-regex-enable` (def yes) · `-plain` (def no) · `-warn` (def no) · `--sub-filter-jsre` | Ship the regex filter with an **empty default list** plus an optional preset of known ad-line patterns. Never silently filter anything by default. |
| S47 | Subtitle timing cleanup | P2 | triv | prop | M20 | `{"command":["set_property","sub-fix-timing",true]}` (def no)<br>`sub-fix-timing-threshold` (def 210 ms) · `sub-fix-timing-keep` (def 400 ms)<br>`sub-stretch-durations` (def no) | **Verified: do not enable `sub-stretch-durations` as a blanket default.** On a dual-language SMI it produced a 596-hour event — a subtitle that never leaves the screen. Safe only on files with genuinely zero-duration events. mpv has no "maximum showing period" equivalent. |
| S48 | Subtitle fade effect / scrolling subtitles | skip | md | — | — | — | **No `sub-fade` anything exists** — the complete option list was checked. Could be faked with ASS `\fad()` in files we generate, but only those, and it would fight `sub-ass-override`. Scrolling subtitles are a broadcast feature with essentially no local-file audience. |
| S49 | Stereoscopic 3D subtitles | skip | lg | — | — | — | `docs/01` lists 3D output as an explicit non-goal; 3D subtitles follow it out the door. Listed only so nobody re-derives the decision. |
| S50 | Subtitle input / editing | skip | lg | — | — | — | `docs/01` states "Not an editor". The read-only browser (S40) delivers the navigation value without the editing surface. Aegisub and Subtitle Edit are better at this. |
| S51 | Embedded ASS font attachments + user font directory | P1 | triv | prop | M19 | `--embeddedfonts=yes` (**confirmed default `yes`** — the default is already right)<br>`{"command":["set_property","sub-fonts-dir","C:/Users/x/Documents/RLPlayer/fonts"]}`<br>settings: one checkbox "자막 파일에 포함된 글꼴 사용" + one folder picker | **Added from the critique** (PotPlayer preferences node `2080=Font Style` exposes "use embedded fonts"). The *behaviour* is already correct; the **setting** was absent, and on a fansub-heavy library "why is the typeface wrong on this one release" is a support ticket with a one-checkbox answer. Turning it **off** is the interesting direction: it forces `sub-font` to win, which is what someone with a broken attached font wants. |
| S52 | Closed captions (CEA-608/708) as a subtitle source | P1 | triv | prop | M17 | `--sub-create-cc-track=yes` (**confirmed present, default `no`**)<br>runtime: `{"command":["set_property","sub-create-cc-track",true]}` then reload the file — the track is created at demux time<br>the CC track then appears in `track-list` like any other and is selected with `sid` | **Added from the critique, and it is the missing engine feature behind §7.8's "IPTV/OTA TS is a heavy Korean use case" risk.** Korean broadcast TS recordings carry captions in-stream, and S01's twelve-format list does not mention captions at all. It is **one boolean**. Trap: it costs nothing when there are no captions, but it *does* change `track-list` numbering, so M17's per-file `sid` restore must match on `(lang, title, codec)` as S14 already requires, not on the raw id. |
| S53 | VSFilter colour compatibility for old SMI→ASS and legacy fansubs | P2 | triv | prop | M19 | `{"command":["set_property","sub-ass-vsfilter-color-compat","basic"]}`<br>choices `no` \| `basic` \| `full` \| `force-601`, **confirmed default `basic`** | **Added from the critique — not mentioned anywhere in the previous revision.** Old Korean SMI→ASS conversions and older fansub files were authored against VSFilter's BT.601 assumption and render with shifted colours without this. The default is already the safe one; the value of the row is (a) exposing `force-601` for the files where `basic` guesses wrong, and (b) writing down that the knob exists so nobody "fixes" wrong subtitle colours in our converter (M18) when the renderer setting is the answer. |

---

### 2.4 Capture & recording — 24 features (P0 3 · P1 14 · P2 7)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| C01 | Still capture to file, **with** subtitles, source resolution | P0 | triv | cmd | M22 | `{"command":["set_property","screenshot-directory","<dir>"]}`<br>`{"command":["set_property","screenshot-template","%F_%wH.%wM.%wS.%wT"]}`<br>`{"command":["set_property","screenshot-format","png"]}`<br>`{"command":["screenshot","subtitles"]}` → reply `{"error":"success","data":{"filename":"…"}}`<br>**PRECONDITION, not optional: `screenshot-directory` MUST already be set.** M22 writes it unconditionally in `setup()`, before any screenshot can be taken, and re-asserts it whenever the setting changes. | **Measured, and it is the trap that breaks every capture row on first run.** With `screenshot-directory` **unset**, `["screenshot","video"]` replies `{"filename":"mpv-shot0002.jpg"}` — a **bare relative name**, resolved against **mpv's** cwd, not ours. With it set, the reply is absolute: `{"filename":"C:/…/shots/rl_…_01.jpg"}`. The advice "use the reported filename, never one you construct" is right (mpv appends `%n` disambiguation) but it silently depended on a precondition nobody stated: `shell.showItemInFolder(r.filename)` (C20) and the toast both break on a relative path. **Rule: M22 sets `screenshot-directory` at `setup()`, and treats a non-absolute reply as a bug to log loudly, never as a path to use.** Prefer `screenshot` over `screenshot-to-file`: the latter accepts only `subtitles`/`video`/`window`, ignores the template, and returns null. |
| C02 | Still capture **without** subtitles | P0 | triv | cmd | M22 | `{"command":["screenshot","video"]}` | Unconditional — ignores the current `sub-visibility` state, which is what you want. Bind to Shift+S. |
| C03 | Copy the current frame to the clipboard | P0 | triv | app | M22 | 1. `await client.command(['screenshot-to-file', tmpPng, 'subtitles'])`<br>2. `clipboard.writeImage(nativeImage.createFromPath(tmpPng))` then `fs.rm(tmpPng)` | **CRITICAL — do not use `screenshot-raw`.** Verified twice (vo=null and vo=gpu-next): sending it over the JSON pipe makes **mpv exit with code 1**, killing playback, because `MPV_FORMAT_BYTE_ARRAY` has no JSON representation. It is client-API/Lua only. `clipboard.writeImage(nativeImage)` is also simpler than the current Blob + ClipboardItem path and gives free format conversion. |
| C04 | Capture at display resolution instead of source | P1 | triv | cmd | M22 | display + subs, no OSD: `{"command":["screenshot","scaled+subtitles"]}`<br>display + subs + OSD: `{"command":["screenshot","window"]}`<br>display, no subs: `{"command":["screenshot","scaled"]}`<br>**precondition as C01, plus: these two flags require a live window-backed VO** | **Measured: `scaled` and `window` return `error running command` when no window-backed VO is open**, while `["screenshot","video"]` succeeds in the same state. Two shipped states have no VO surface to grab: **audio-only playback with the video window hidden (A38, M11)** and **tray-only mode (U39, M32)**. So this row must either disable the display-resolution capture menu items in those states (`enabledWhen`), or fall back to `video` and say so in the toast — silently returning an error to a keypress is the one option that is not allowed. Verified by PNG header otherwise: with a 136×64 child window, `video`→1280×720, `window`→136×64. `scaled`/`osd` are **not accepted** by `screenshot-to-file` — use the `screenshot` command plus a template. |
| C05 | Capture folder + filename template | P1 | sm | prop | M22 | `{"command":["set_property","screenshot-directory","C:/Users/x/Pictures/RLPlayer"]}` — **written unconditionally at `setup()`, before any capture, because the reply path depends on it (C01)**<br>`{"command":["set_property","screenshot-template","%F_%wH.%wM.%wS.%wT_%#02n"]}`<br>specifiers: `%f %F %x %X{fb} %p %P %wH %wh %wM %wm %wS %ws %wf %wT %tX %{prop[:fb]} %[#][0X]n %%` | Observed and undocumented: `%p`/`%P` expand with `:` which is illegal in Windows filenames — mpv silently substitutes `_`. Use `%wH.%wM.%wS.%wT` if you want dots. If the template resolves to an existing file mpv will **not** overwrite; always include `%n` or a ms component. |
| C06 | Capture image format and quality | P1 | sm | prop | M22 | `screenshot-format` (`png`\|`jpg`\|`webp`\|`jxl`\|`avif`, **def jpg**)<br>`screenshot-jpeg-quality` 90 · `screenshot-png-compression` 7 · `screenshot-png-filter` 5 · `screenshot-webp-lossless` · `screenshot-webp-quality` 75 · `screenshot-webp-compression` 4 · `screenshot-jxl-distance` 1.0 · `screenshot-jxl-effort` 4<br>**`screenshot-high-bit-depth` → set `false`** · `screenshot-tag-colorspace` true · `screenshot-sw` false | **Measured bug in our defaults:** `screenshot-high-bit-depth` defaults to *yes*, so every PNG from an 8-bit H.264 source came out 16-bit — **5.37 MB for one 1280×720 frame**. Set it to `no` unless the source is 10-bit/HDR and the user opted in. mpv has **no BMP format** — offer PNG. |
| C07 | Capture at a custom width/height | P2 | triv | app | M22 | no mpv option. Post-resize: `nativeImage.createFromPath(tmp).resize({width:640, quality:'best'})` → `.toPNG()`/`.toJPEG(90)`<br>for offline jobs resize in the graph instead: `scale=<W>:-2:flags=lanczos` | Never do this with a `vf` on the live player — it would change what the user is watching. `-2` keeps aspect and forces an even height, which most encoders require. |
| C08 | Consecutive capture, live, interval-based | P1 | sm | app | M22 | main-process timer around the normal screenshot command; mpv has no interval mode:<br>`setInterval(async () => { const r = await c.command(['screenshot', withSubs?'subtitles':'video']); if (++n>=count) clearInterval(t) }, intervalMs)`<br>frame-interval mode (paused only): loop `screenshot` + `frame-step` | **Do not use mpv's `each-frame` flag.** `["screenshot","video+each-frame"]` captures *every* decoded frame with no interval control — at 30 fps that is 150 5-MB PNGs in five seconds. Screenshot encoding is async; the reply's filename is authoritative but the write may lag a few ms — **and it is only absolute because `screenshot-directory` was set at `setup()` (C01)**. |
| C09 | Consecutive capture, offline batch (faster than realtime) | P1 | sm | ext | M23 | second mpv in encode mode, no ffmpeg needed:<br>`mpv.exe "<in>" --no-config --load-scripts=no --ytdl=no --msg-level=all=error --no-audio --sid=no --start=<t0> --end=<t1> --hr-seek=yes --o="<dir>/<stem>_%04d.png" --of=image2 --ovc=png --vf=lavfi=[fps=1/<sec>,scale=<W>:-2:flags=lanczos]`<br>JPEG: `--ovc=mjpeg --ovcopts=global_quality=354,flags=+qscale` + `format=yuvj420p` in the graph | Verified end to end. `qscale` is **not** a libavcodec AVOption (mpv prints "AVOption 'qscale' not found") — use `global_quality=<q*118>,flags=+qscale`. Drop `--sid=no` to burn subtitles in. |
| C10 | Thumbnail contact sheet (scene grid) | P1 | md | ext | M23 | one encode-mode run, **cwd must be a temp dir containing the .ttf**:<br>`--o=sheet.png --of=image2 --ofopts=update=1 --ovc=png`<br>`--vf=lavfi=[fps=${cols*rows}/${dur},scale=${tileW}:-2,drawtext=fontfile=sheet.ttf:text='%{pts\:hms}':x=6:y=h-th-6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4,tile=${cols}x${rows}:margin=6:padding=4:color=0x1e1e1e,pad=iw:ih+70:0:70:color=0x1e1e1e,drawtext=fontfile=sheet.ttf:text='${header}':x=14:y=22:fontsize=22:fontcolor=0xE6E6E6]` | Three verified gotchas: (1) `fps=<tiles>/<duration>` yields exactly `<tiles>` frames; pass `--ofopts=update=1` anyway. (2) `drawtext` **requires** `fontfile=` — `font=Arial` fails, this build has no fontconfig. (3) **A Windows absolute path inside a lavfi option is impossible** — `C\:/…` and `C\\:/…` both fail graph parsing. The only thing that worked was a bare relative filename with the child's cwd set. See §7.7. |
| C11 | Clip export of an A-B range, re-encoded | P1 | md | ext | M23 | `mpv.exe "<in>" --no-config --msg-level=all=error --start=<t0> --end=<t1> --hr-seek=yes --input-ipc-server=\\.\pipe\rlplayer-encode-<id> --o="<out>.mp4" --of=mp4 --ovc=libx264 --ovcopts=preset=veryfast,crf=20 --oac=aac --oacopts=b=192000`<br>presets: HEVC MKV `--of=matroska --ovc=libx265 --ovcopts=preset=medium,crf=24`; VP9 WebM `--of=webm --ovc=libvpx-vp9 --ovcopts=crf=32,b=0 --oac=libopus`; AV1 MKV `--ovc=libsvtav1 --ovcopts=crf=32,preset=8`; NVENC `--ovc=h264_nvenc --ovcopts=preset=p5,rc=vbr,cq=23` | Verified. **`--ovcopts`/`--oacopts` are COMMA-separated**, not colon (`lossless=0:quality=75` fails with "Invalid chars"). `pix_fmt` is not an AVOption — force it with a `format=yuv420p` node in `--vf`. **There is no `--ovc=copy`** — for lossless see C13. Encoder inventory confirmed: libx264/libx265/libvpx-vp9/libsvtav1/libaom-av1/prores/ffv1/mjpeg/png/gif/webp plus `_nvenc`/`_qsv`/`_amf`/`_mf` variants. |
| C12 | Burn subtitles into an exported clip | P1 | triv | ext | M23 | **subtitles are burnt in by default in encode mode.** Carry the selection over: `--sid=<n>` (or `--sub-file="<path>"`) plus `--sub-delay`, `--sub-scale`, `--sub-ass-override=no`. To exclude: `--sid=no`. | Verified visually both ways (`--sub-file` and `--vf=lavfi=[subtitles=…]` both render). **Muxing subtitles as a soft track is NOT possible** — encode mode has no subtitle muxing. Burn-in or nothing; say so in the UI. |
| C13 | Lossless A-B cut via the demuxer cache | P2 | sm | cmd | M23 | requires the **main** player to run with a real cache: `--cache=yes --demuxer-max-bytes=1GiB --demuxer-max-back-bytes=1GiB --demuxer-readahead-secs=600`<br>`{"command":["dump-cache",<startSec>,<endSec>,"<out>.mkv"]}`<br>or `{"command":["ab-loop-align-cache"]}` then `{"command":["ab-loop-dump-cache","<out>.mkv"]}`<br>stop a continuous dump: `["dump-cache",0,0,""]` | Verified both ways: with default cache settings it produced a **636-byte empty file**; with a large cache it produced a valid 775 KB MKV instantly. Honest limits: only what is *in the cache* can be dumped; large dumps **freeze the player**; cut points land on keyframes and "the end may be slightly damaged". mpv calls it experimental. Label it "Fast lossless cut (approximate edges)", never the default. |
| C14 | GIF export with palette generation | P2 | sm | ext | M23 | single pass (recommended):<br>`--o="<out>.gif" --of=gif --ovc=gif --ofopts=loop=0 --vf=lavfi=[fps=15,scale=480:-2:flags=lanczos,format=rgb24,split[a][b];[a]palettegen=max_colors=192:stats_mode=single[p];[b][p]paletteuse=dither=sierra2_4a:new=1]`<br>two-pass: pass 1 `palettegen=max_colors=256:stats_mode=diff` → `pal.png`; pass 2 `[x];movie=pal.png[p];[x][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle` | Single pass **must** use `stats_mode=single`: `stats_mode=diff` produced **no output and no error**, because palettegen only emits at EOF and deadlocks a one-shot graph. `paletteuse=new=1` is required. `paletteuse`/`overlay` exist even though `--vf=lavfi=help` does not list them (that listing filters multi-input filters). 2 s at 480px/15fps ≈ 2.7–3.0 MB — show an estimate and cap duration. |
| C15 | Animated WebP export | P2 | triv | ext | M23 | `--o="<out>.webp" --of=webp --ovc=libwebp_anim --ovcopts=lossless=0,quality=75 --vf=lavfi=[fps=15,scale=480:-2:flags=lanczos]` | Verified: 560 KB for 2 s at 480px/12fps, roughly 1/5 the equivalent GIF. Remember the comma separator in `--ovcopts`. |
| C16 | Audio extraction / audio recording | P1 | sm | ext | M23 | `mpv.exe "<in>" --no-config --msg-level=all=error --no-video --start=<t0> --end=<t1> --hr-seek=yes --aid=<id> --o="<out>.mp3" --of=mp3 --oac=libmp3lame --oacopts=b=192000`<br>WAV `--of=wav --oac=pcm_s16le` · FLAC `--of=flac --oac=flac` · Opus `--of=opus --oac=libopus` · M4A `--of=ipod --oac=aac` · MKA `--of=matroska --oac=flac` | Verified. PotPlayer's audio recorder is a live tape-deck; because encode mode runs **faster than realtime**, an A-B range job is strictly better UX for a local file — same result, seconds instead of minutes, cancellable. Keep the tape-deck metaphor only for live network streams (C17). |
| C17 | Live stream recording (network sources only) | P2 | sm | prop | M23 | start `{"command":["set_property","stream-record","C:/…/rec.mkv"]}` · stop `{"command":["set_property","stream-record",""]}` | **Verified-negative and important: `stream-record` does nothing for local files.** With the default cache it produced a 0-byte file; with an 800 MiB cache, no file at all — it "will write only data that is appended at the end of the cache", which for a fully-buffered local file is nothing. **Only enable this menu item when the path is a URL/stream.** Also: the output container generally must match the input, and seeking or switching tracks during recording "might result in recording being stopped and/or broken files". |
| C18 | Encode job progress, queue and cancel | P1 | md | ext | M23 | give every job its own pipe and drive it like the main player:<br>`--input-ipc-server=\\.\pipe\rlplayer-job-${pid}-${jobId}`<br>`observe_property` on `percent-pos` and `time-pos`; `get_property duration`; cancel with `{"command":["quit"]}` | Verified: an encode-mode mpv accepts `--input-ipc-server` and emits a steady stream of property-change events while encoding, so **no stdout scraping is needed**. Run one job at a time (max 2) or libx265/libsvtav1 saturates every core and stutters playback. Spawn below-normal priority so playback always wins. |
| C19 | Hardware encoder selection | P2 | sm | ext | M23 | NVIDIA `--ovc=h264_nvenc --ovcopts=preset=p5,rc=vbr,cq=23` · Intel `--ovc=h264_qsv --ovcopts=global_quality=23` · AMD `--ovc=h264_amf --ovcopts=quality=balanced,rc=cqp,qp_i=23,qp_p=23` · vendor-agnostic `--ovc=h264_mf`<br>probe once against `av://lavfi:testsrc=duration=0.2` and cache the exit code | The encoders are **present** in the build but whether they *initialise* depends on GPU and driver, and the exact `--ovcopts` key names differ per vendor. Treat every hardware preset as "probe, then fall back to libx264", never a default. Quality at equal bitrate is worse than libx264 — label them "Fast (GPU)", not "Best". |
| C20 | Post-capture toast with Open folder / Copy | P1 | triv | app | M22 | `const r = await c.command(['screenshot','subtitles'])` → toast with `path.basename(r.filename)` and an action calling `shell.showItemInFolder(r.filename)` | The `screenshot` command's reply data is `{"filename":…}`; `screenshot-to-file` returns null. **It is an absolute path only because M22 set `screenshot-directory` at `setup()`** — unset, mpv returns a bare relative name like `mpv-shot0002.jpg` and both `shell.showItemInFolder` and the toast break on first run (C01). Assert `path.isAbsolute(r.filename)` and log loudly if it is not. `%n` disambiguation is the other reason never to construct the path yourself. |
| C21 | Capture settings panel | P1 | md | app | M22 | one config slice registered with `core/settings`: `imageDir`, `videoDir`, `audioDir`, `template`, `format`, `jpegQuality`, `pngCompression`, `highBitDepth`, `includeSubs`, `useDisplayResolution`, `sheet{cols,rows,tileWidth,includeSubs,header}`, `gif{fps,width,maxColors,dither}`, `clip{preset,crf}` | The existing config has only `screenshotDir: string` — keep that key working and migrate it into `capture.imageDir` on first load so nobody loses their setting. |
| C22 | Capture keybindings (PotPlayer-compatible) | P1 | triv | app | M22 | registered through `ctx.commands.register` with per-preset defaults:<br>default `S`, `Shift+S`, `Ctrl+S`, `Alt+N`, `Ctrl+G`, `Alt+C`<br>potplayer, **verified 8/8** against PotPlayer's own `English.ini` `[MenuString]` table on this machine: `Ctrl+E` Save Current Source Frame · `Ctrl+C` Copy Current Source Frame to Clipboard · `Ctrl+Alt+E` Save Current Screen Frame · `Ctrl+Alt+C` Copy Current Screen Frame · `Alt+N` Create Thumbnail Image · `Ctrl+G` Capture Consecutive Images · `Alt+C` Record Video · `Shift+G` Record Audio | **Settled — the uncertainty note that used to sit here is deleted.** The guessed preset was **8/8 correct**, read out of PotPlayer's shipped string table rather than a secondary source, so no live-install verification is outstanding for *these* keys. (§7.8's preset-accuracy risk still stands for the rest of the map, where ten entries are wrong — see §7.8.) The structural point survives and is worth keeping in the UI: the matrix is {source frame, screen frame} × {save, clipboard}, and users find the fourth key by pattern. |
| C24 | Delete the last saved frame | P2 | triv | app | M22 | keep the last N reply filenames from C01/C02/C04 in memory; the command calls `shell.trashItem(last)` and pops the stack; OSD "마지막 캡처 삭제됨 — Z로 되돌리기" | **Added from the critique** (PotPlayer `101_0_11_12_26`). Trivial, and a genuinely nice touch after a burst capture (C08) fills a folder with near-duplicates. **`shell.trashItem`, never `fs.unlinkSync`** — same rule as L36. Only ever deletes files *this session* reported writing, never an arbitrary path, and it is a no-op with an OSD if the stack is empty. |
| C23 | Capture submenu in the app and context menus | P1 | sm | app | M22 | `ctx.menu.contribute({parent:'video', id:'capture', label:'캡처', order:40, items:[…]})` | `src/main/menu.ts` already has `screenshot` and `screenshotClipboard` entries; the registration API must let this section **replace** them or they become duplicates. |

---
### 2.5 Navigation, bookmarks, chapters, history — 53 features (P0 16 · P1 18 · P2 16 · 3 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| N01 | Chapter list | P0 | triv | prop | M25 | `{"command":["observe_property",1,"chapter-list"]}` → `[{"title":string,"time":number}]`<br>also `chapters` (count), `chapter` (RW, 0-based, −1 = before first), `chapter-list/N/title`, `chapter-list/N/time` | Already wired in `OBSERVED`. A chapterless file returns `chapters: 0` and `chapter-list: []` (empty array, not null) — the panel must handle empty without crashing. |
| N02 | Chapter jump | P0 | triv | prop | M25 | `{"command":["set_property","chapter",<0-based n>]}` | "Setting this property results in an absolute seek to the start of the chapter." It **is already a seek** — do not follow it with your own `seek`. |
| N03 | Previous / next chapter | P0 | triv | cmd | M25 | `{"command":["add","chapter",1]}` / `{"command":["add","chapter",-1]}` | With `add`, a decrement "may go to the start of the current chapter instead of the previous chapter", governed by `--chapter-seek-threshold` (def 5.0, also a runtime property; −1 = always previous). That is the DVD behaviour users expect. **`ipc.ts` currently reimplements this by computing the index — replace it with `add chapter ±1`.** |
| N04 | Chapter ticks on the seek bar | P0 | sm | app | M25 | renderer layer: `left = (c.time / duration) * 100%`; hover shows the chapter title in the seek tooltip | Registered via `ctx.ui.seekbarLayer`. Ship it **on** by default — PotPlayer hiding it behind a checkbox is the mistake, not the model. |
| N05 | Chapter title on the OSD | P1 | triv | app | M25 | observe `chapter`; on change `ctx.osd.show({kind:'chapter', text:'Ch 3/12 — Opening'})` | We run `--osd-level=0 --no-osd-bar --osc=no`, so the overlay owns 100% of the OSD. Do not mix in mpv's `show-text` — two OSDs look broken. |
| N06 | Matroska edition / DVD title selection | P2 | sm | prop | M25 | `{"command":["set_property","edition",<0-based n>]}`; read `editions`, `edition-list` (`/N/id`, `/N/title`, `/N/default`), `current-edition` | **Verified:** on a plain MP4 the `editions` property is *unavailable* — the IPC get returns `undefined`, not 0. Hide the menu on undefined, do not render "0 editions". "Setting this property will restart playback", so treat it like a reload: re-apply resume position and re-emit the chapter list. |
| N07 | External chapter file | P2 | sm | prop | M25 | per-file option: `{"command":["loadfile","<path>","replace",-1,{"chapters-file":"C:/x.ffmeta"}]}` | Accepts a media file or an ffmetadata pseudo-format, but "doesn't work with OGM or XML chapters directly". Changing it mid-playback is untested — assume a reload is needed. |
| N08 | Auto-skip chapters by title (OP/ED) | P1 | sm | app | M25 | observe `chapter`; test `chapter-list[n].title` against a user regex; on match `{"command":["add","chapter",1]}` then OSD "Skipped: Opening — Z to undo"; undo = `{"command":["revert-seek"]}` | **Promoted P2 → P1, and it is only half the feature.** This is chapter-*title* matching, which does nothing at all on the markerless Korean drama and anime rips the feature exists for — those files have `chapters: 0`. **N51 is the other half and the two ship together**; this row is the cheap path for properly chaptered Matroska, N51 is the path for everything else. **Must be off by default and must always show the undo affordance** — silently moving playback is exactly what gets a player uninstalled. Default pattern is user-editable text, never a hardcoded list. |
| N09 | Ordered chapters (Matroska segment linking) | P2 | triv | prop | M25 | `--ordered-chapters=yes` is already mpv's default and we run `--no-config`, so it is on.<br>`--ordered-chapters-files=<playlist>` for out-of-directory references · `--chapter-merge-threshold=<ms>` (def 100) | Free — this row exists so nobody "optimises" it off. It makes `duration` and the chapter table reflect the *virtual* timeline, which the seek bar and resume store must respect (they do, since they read mpv's properties). |
| N10 | Named bookmarks per file | P1 | md | app | M26 | capture `{"command":["get_property","time-pos"]}`; jump `{"command":["seek",<t>,"absolute+exact"]}`<br>store: `<dataDir>/bookmarks.json`, keyed by the **same `resumeKey()`** the resume store uses, value `[{t,title,createdAt}]` | mpv has no bookmark concept — 100% ours. Reuse `resumeKey()` rather than inventing a second identity scheme, or a renamed file keeps its resume point and loses its bookmarks. **Always seek `absolute+exact`**: a bookmark that lands 12 s off is worse than no bookmark. PotPlayer caps at 2000; ~200 per file is plenty. |
| N11 | Bookmark manager panel | P1 | md | app | M26 | renderer panel over the store; row click → `{"command":["seek",<t>,"absolute+exact"]}`; optional all-files mode | The **filter box** is the part PotPlayer users actually mention — for a 3-hour lecture with 40 bookmarks a flat list is useless. Default the name to the timecode so a bookmark is never nameless. |
| N12 | Previous / next bookmark | P1 | triv | app | M26 | sort times; first `> time-pos + 0.25` (next) or last `< time-pos − 0.25` (prev); seek `absolute+exact` | **Do not copy PotPlayer's overloading of bookmark and chapter onto one key** — it is ambiguous when a file has both. Chapters get PgUp/PgDn, bookmarks get Shift+PgUp/PgDn. |
| N13 | Bookmark pins on the seek bar | P1 | sm | app | M26 | renderer layer: `left = (t / duration) * 100%` | Use a different **shape**, not only colour, from chapter ticks (chapters = thin full-height tick, bookmarks = pin below the bar) — WCAG, and it is also just clearer. |
| N14 | Bookmark thumbnails | P2 | sm | ext | M27 | on creation, ask M27's thumbnailer for one frame at that timestamp and write it to `<dataDir>/thumbs/<key>/<t>.png` via `{"command":["screenshot-to-file","<path>","video"]}` **on the thumbnailer instance** | Never screenshot on the main instance for this — it grabs at full resolution and costs a frame. |
| N15 | Bookmark export / import | P2 | sm | app | M26 | ours: `{version:1, file, bookmarks:[{t,title}]}`<br>also export ffmetadata so `--chapters-file` (N07) and mkvtoolnix can read it: `;FFMETADATA1` then per entry `[CHAPTER]\nTIMEBASE=1/1000\nSTART=<ms>\nEND=<ms>\ntitle=<name>` | Exporting to ffmetadata is the clever bit: it round-trips through our own N07 support and through mkvtoolnix, so users are never locked in. |
| N16 | Watched / bookmarked badges in the playlist | P2 | sm | app | M30 | join the playlist against `history.json` (finished flag, lastPosition/duration) and `bookmarks.json` by `resumeKey()` | `resumeKey()` calls `fs.statSync` per file — do this **once on playlist build**, not per render, or a 200-file playlist stutters. |
| N17 | A-B repeat | P0 | sm | prop | M26 | one-key cycle: `{"command":["ab-loop"]}` (A → B → clear)<br>explicit: `{"command":["set_property","ab-loop-a",<seconds>]}` / `ab-loop-b`<br>clear with the **string** `"no"`: `{"command":["set_property","ab-loop-a","no"]}` | **Verified:** setting 2.5 returns 2.5; setting `"no"` returns the string `"no"`. The TypeScript type is `number \| 'no'` — a naive `typeof data === 'number'` guard silently treats a cleared point as 0. Verified in mpv source: the loop-back seek is `MPSEEK_EXACT`, so the return to A is already frame-accurate; you do **not** need `--hr-seek=yes`. |
| N18 | Nudge A or B by ±0.1 s | P1 | triv | cmd | M26 | `{"command":["add","ab-loop-a",-0.1]}` / `+0.1`, same for `ab-loop-b` | **Guard first**: `add` on a property currently holding the string `"no"` errors. Read the property (or your mirrored state) and no-op if unset. Re-seek to A after nudging A so the user hears the new in-point. |
| N19 | Loop region drawn on the seek bar | P0 | sm | app | M26 | renderer layer: `left=(a/duration)*100%`, `width=((b-a)/duration)*100%`; dragging a handle sets `ab-loop-a`/`-b` | **`ab-loop-a` and `ab-loop-b` are not in `OBSERVED` today** — add them via `ctx.mpv.observe`. Without the visible region, A-B feels like a guess; this is the half that makes the feature. |
| N20 | Loop the current subtitle line | P1 | sm | prop | M26 | `a = {"command":["get_property","sub-start"]}`, `b = {"command":["get_property","sub-end"]}` (ms precision: `sub-start/full`), then set `ab-loop-a`/`-b` | The highest-value feature for the language-learning audience. Both properties return **null when no subtitle is on screen** — show an OSD "no subtitle here" rather than setting a zero-length loop. Apply `sub-delay` when converting (A/B are video time, `sub-start` is subtitle time) and add ~0.2 s of tail to B or the last syllable clips. |
| N21 | A-B loop count (repeat N times) | P2 | triv | prop | M26 | `{"command":["set_property","ab-loop-count",3]}`; progress via read-only `remaining-ab-loops`; restore with `"inf"` | **Verified:** the default `ab-loop-count` reads the *string* `"inf"` and `remaining-ab-loops` reads `-1` in that state (not null, not Infinity). Setting `ab-loop-count` to **0 disables A-B looping entirely** — never write 0 when the user means "off". |
| N22 | Saved A-B section list | P2 | sm | app | M26 | store sections in `bookmarks.json` alongside point bookmarks — a bookmark with a `b` field **is** a section. Activating writes both loop points and seeks to `a` with `absolute+exact`. | One panel, one file, one identity key. Do not build a second store. |
| N23 | Pause briefly at B before looping back | P2 | sm | app | M26 | do **not** set `ab-loop-b` in this mode. Observe `time-pos`; on crossing b: pause, wait N ms, `{"command":["seek",<a>,"absolute+exact"]}`, unpause. | Drive this off the **raw** property-change event, not the 100 ms coalesced state push, or the pause lands up to 100 ms late. |
| N24 | Frame step forward | P0 | triv | cmd | M24 | `{"command":["frame-step"]}` (= `["frame-step",1,"play"]`); N frames `["frame-step",10,"play"]`; mute the audio blip with `["frame-step",10,"mute"]` | **Measured** 0–80 ms per step (typically ~35 ms) on 1080p30 H.264. `play` mode literally plays forward then pauses, so a 100-frame step plays 100 frames — pass the `seek` flag for large jumps. Sets paused as a side effect. |
| N25 | Frame step **backward** | P0 | sm | cmd | M24 | `{"command":["frame-back-step"]}` (identical to `["frame-step",-1,"seek"]`); N back `["frame-step",-10,"seek"]` | **The hard one, and the verified IPC trap that will cost an hour:** `frame-step`/`frame-back-step` reply `{"error":"success"}` **immediately, before the position moves** — a `get_property time-pos` right after the reply returned the OLD position four times running; the position updated 120–170 ms later. **Drive the UI from the `time-pos` observer, never from a get after the command.** Measured asymmetry: back-step 120–171 ms vs forward 0–80 ms on an *easy* file (short GOP); long-GOP HEVC will be several hundred ms to over a second. Coalesce key repeat to one outstanding back-step. Does not work with audio-only playback — grey both buttons when `vid === false`. Only `-1` is guaranteed on VFR content. |
| N26 | Frame number in the stats overlay | P2 | triv | prop | M29 (section) | `estimated-frame-number`, `estimated-frame-count`, `container-fps`, `estimated-vf-fps`, `video-frame-info/picture-type` (`I`/`P`/`B`) | Both frame properties are documented **estimates** ("computed from two unreliable quantities"). Label them approximate or do not show them. Verified they track `frame-back-step` perfectly on CFR content. |
| N27 | Jump to previous / next keyframe | P2 | sm | cmd | M24 | closest honest approximation only: `{"command":["seek",0.1,"relative+keyframes"]}` / `-0.1` | **There is no keyframe index property in mpv** and I will not invent one. `relative+keyframes` snaps to *a* keyframe with no guarantee it is the adjacent one, and a small delta can land back on the same one. Label it "snap to keyframe", never "next keyframe". |
| N28 | Go-to-timecode dialog | P0 | sm | cmd | M24 | dispatch by input form: absolute (`1:23:45.5`, `23:45`, `95`) → `["seek",<sec>,"absolute+exact"]`; percent (`50%`) → `["seek",50,"absolute-percent+exact"]`; relative (`+30`) → `["seek",30,"relative+exact"]`; chapter (`#4`, 1-based) → `["set_property","chapter",3]` | **Do not implement by writing `time-pos`** — that works but its precision follows `--hr-seek` (default `default`), so it is implicitly keyframe-ish in some cases. Accept the same grammar as mpv's `--start` so the CLI and the dialog agree. |
| N29 | Configurable seek step sizes | P0 | triv | cmd | M24 | config `{tiny:1, small:5, large:30, huge:600}`<br>coarse: `{"command":["seek",<±n>,"relative"]}` — `keyframes` is mpv's default for relative seeks and is what makes them feel instant<br>fine (≤1 s): `{"command":["seek",<±n>,"relative+exact"]}` | Getting the exact/keyframes split backwards is precisely why some players feel imprecise. `ipc.ts`'s `seek:<n>` routes everything through one action with no `exact` flag — the action needs `exact?: boolean`, contributed through the registry rather than by editing `types.ts`. |
| N30 | Drag-to-scrub with live frame update | P0 | sm | cmd | M24 | during drag, fire-and-forget: `client.commandNoReply(["seek",<t>,"absolute+keyframes"])`<br>on release: `{"command":["seek",<t>,"absolute+exact"]}` | Throttle drag seeks to one per 60–80 ms; one per mousemove queues seeks faster than the demuxer can serve them and the scrub goes rubbery. `commandNoReply` already exists and is unused for seeking today. |
| N31 | Pause while dragging the seek bar | P2 | triv | app | M24 | on drag start remember `paused` and set `pause=true`; restore on release | Setting only. PotPlayer added this in `[260622]` — it is a live papercut for them too. |
| N32 | Undo the last seek | P1 | triv | cmd | M24 | `{"command":["revert-seek"]}`; plant a return point `["revert-seek","mark"]`; sticky `["revert-seek","mark-permanent"]` | "Calling this once jumps to the position before the seek. Calling it a second time undoes the revert itself. Only works within a single file." Badly underrated — it is the fix for "I overshot and now I cannot find my place", and the right undo affordance for N08. |
| N33 | Percent seek on the number keys | P2 | triv | cmd | M24 | `{"command":["seek",<n*10>,"absolute-percent"]}` (add `+exact` to make it precise) | Defaults to keyframes for `absolute-percent`. |
| N34 | *(moved)* Seek by subtitle line | — | — | — | **M20** | see §2.3 S29 | Owner resolved in §1.5. |
| N35 | Seek bar hover time tooltip | P0 | triv | app | M24 | renderer only: `t = (cursorX / barWidth) * duration` | The P0 version of the thumbnail preview — ship it first so the bar is never dead on hover. |
| N36 | Seek preview thumbnails | P1 | lg | ext | M27 | **spawn a second headless mpv in encode mode per open file, on its own pipe:**<br>`--no-config --msg-level=all=no --terminal=no --idle=yes --pause=yes --keep-open=always --load-scripts=no --osc=no --ytdl=no --load-stats-overlay=no --load-console=no --load-auto-profiles=no --media-controls=no --no-audio --no-sub --vid=<main vid> --edition=<main edition> --start=<t> --hr-seek=no --demuxer-readahead-secs=0 --demuxer-max-bytes=128KiB --vd-lavc-skiploopfilter=all --vd-lavc-fast --vd-lavc-threads=2 --hwdec=no --hwdec-software-fallback=1 --vf=scale=w=<W>:h=<H>,pad=w=<W>:h=<H>:x=-1:y=-1,format=bgra --sws-scaler=fast-bilinear --sws-allow-zimg=no --video-rotate=<main> --ovc=rawvideo --of=image2 --ofopts=update=1 --o=<TEMP>\rlplayer-thumb-<id>.out --input-ipc-server=\\.\pipe\rlplayer-thumb-<id> -- <video>`<br>on hover `{"command":["async","seek",<t>,"absolute+keyframes"]}` throttled to ~50 ms; ~150 ms after the pointer settles re-issue the same t with `absolute+exact`<br>read side: `rm(dst); rename(out,dst); accept only if size === W*H*4; readFileSync(dst)` | **Measured** at 288×162: keyframe 28–34 ms, exact 169–185 ms, output exactly 186 624 bytes = W×H×4, alpha 255. So keyframe-on-move, exact-on-settle, and the user never waits. **Deprecation fixes vs upstream thumbfast:** use `--load-console=no` (not `--load-osd-console=no`) and `--hwdec-software-fallback=1` (not `--vd-lavc-software-fallback=1`). **Windows pipe-path trap:** building `\\.\pipe\name` through templating silently halves backslashes — build it as `['','','.','pipe',id].join(String.fromCharCode(92))` and log `JSON.stringify(path)` once. mpv writes **BGRA**; swap bytes 0 and 2 for ImageData. Lazy spawn on first hover (~40–60 MB RSS), kill after 60 s idle, never spawn for URLs or audio-only. |
| N37 | Chapter title and timecode inside the preview tooltip | P1 | triv | app | M27 | overlay the formatted time plus the chapter whose `time` is the greatest ≤ hover t | Ship both on by default; PotPlayer's split into two separate checkboxes is settings clutter, not a feature. |
| N38 | Scene preview grid | P2 | md | ext | M27 | reuse the same thumbnailer at `scale=w=320:h=180,pad=…,format=bgra` and walk grid times with `{"command":["async","seek",<t>,"absolute+keyframes"]}`. Two modes: marker-based (one tile per chapter/bookmark, PotPlayer's own default) and interval (`t_i = duration * i / N`).<br>batch alternative: `--start=<t0> --sstep=<interval> --frames=<N> --vf=scale=320:-2 --ovc=mjpeg --of=image2 "--o=<dir>\%04d.jpg"` | Prefer the IPC-driven loop over `--sstep`: closing the panel must cancel immediately, and a batch process cannot be steered. Cache to `%LOCALAPPDATA%\RLPlayer\scenecache\<key>\` with an LRU byte cap or a 4K library silently eats a gigabyte. |
| N39 | Scene browser by subtitle intervals | P2 | md | app | M27 | enumerate subtitle start times (parse the external file via M18) and thumbnail each | **Honest limit:** mpv exposes no property listing all subtitle events, and for embedded subs you cannot enumerate beyond the demuxer's prefetch window. Gate the feature on an external subtitle being loaded. |
| N40 | Playback history list | P1 | md | app | M30 | `<dataDir>/history.json`, entries `{key, path, title, duration, lastPosition, playedAt, finished}`; same atomic write and LRU cap as the resume store | **Keep this separate from `resume.json`.** The resume store deliberately *deletes* entries when a file is finished so it never offers a stale resume; history wants to keep them with `finished:true` so the panel can show a checkmark. Two stores, one key function. |
| N41 | Resume from the last position | P0 | triv | app | M30 | **recommended, one command, verified:** `{"command":["loadfile","<path>","replace",-1,{"start":"2471.5"}]}` | **The 3rd argument must be `-1`** for the 4th options map to be read (mpv 0.38 breaking change). **Corrected symptom, measured:** without it the command does **not** silently drop the map — it **hard-errors** and nothing loads:<br>`["loadfile", path, "replace", {"start":"9.5"}]` → `{"error":"invalid parameter"}`<br>`["loadfile", path, "replace", -1, {"start":"5.5"}]` → `{"playlist_entry_id":2}`, lands at 5.5<br>This matters because an implementer told to expect *silence* will not check the reply, will see the file fail to open at all, and will hunt the bug somewhere else entirely. **Check the reply on every `loadfile`.** Values in the map must be **strings**. Verified: `{"start":"5.5"}` landed at 5.5 with **no frame-0 flash**; `{"start":"7.25","pause":"yes"}` landed at 7.266667 (the next 30 fps frame boundary) and stayed paused. **Verified event-order bug in the current code:** the sequence is `start-file` → `file-loaded` → seek → `playback-restart`, so `manager.ts` seeking on `file-loaded` renders a frame at position 0 first. If you keep the two-step path, wait for `playback-restart`. `{"start":"#2"}` on a chapterless file silently landed at 1.5 s rather than erroring — validate chapter counts before using `#c`. |
| N42 | Resume toast, never a modal | P0 | triv | app | M30 | already emits `ToastPayload{kind:'resume',…}`; restart action = `forget(file)` + `["seek",0,"absolute"]` + unpause | Implemented. Listed so the history panel work does not accidentally replace it with a dialog. |
| N43 | "Continue watching" on the idle screen | P1 | md | ext | M30 | join unfinished `history.json` entries with bookmark counts and a cached poster frame from M27; click → the N41 loadfile-with-start | Drop missing files silently (`fs.existsSync`) rather than showing dead tiles. This is `docs/01`'s "idle window: recent files + drop target" with the resume data attached. |
| N44 | Clear history, delete an entry, disable history | P1 | triv | app | M30 | `resume.ts` already exports `forget(file)` and `clearAll()`; mirror both on the history store. Config gains `keepHistory: boolean` beside `resumePlayback`. | **This is a trust feature, not a convenience.** A player whose pitch is "nothing recorded about you" cannot ship a local watch history you are unable to erase. Portable mode must keep both files inside the portable config dir. |
| N45 | Stable file identity for resume/history/bookmarks | P1 | sm | app | **core/per-file** | current: `resumeKey(file) = sha1(lowercase(abs path) + statSync(file).size)`; mpv's analogous knob is `resume-playback-check-mtime` | Consequences of the current key, to be decided deliberately (§7.9): a file **renamed in place loses** its position (the path is in the hash); a file **moved** loses it; a re-encode to the same size at the same path **wrongly keeps** it. Options: add mtime (safer, invalidates more) or a secondary size+duration index. |
| N46 | Play the next file at end of file | P0 | triv | app | M28 | **drive off the `end-file` event and gate on its reason**, which `eof-reached` cannot distinguish:<br>`client.on('mpv-event', (ev,msg) => { if (ev==='end-file' && msg.reason==='eof') advance() })`<br>reasons: `eof \| stop \| quit \| error \| redirect \| unknown` | With `--keep-open=yes` mpv **pauses** at EOF instead of advancing — that is exactly why the app must own the advance, and it is right, because the app applies natural sort and per-file resume. Gating on `reason === 'eof'` means a decode error no longer silently skips to the next episode and pressing Stop no longer advances. **We never offer to delete files after playback.** |
| N47 | Behaviour at the end of the playlist | P1 | triv | app | M28 | app policy in the EOF handler; config already has `repeat` and `shuffle`. Default: stop and return to the idle "continue watching" screen. | Never auto-quit. Never auto-shutdown the PC (PotPlayer offers this; it is a support-ticket generator). Never delete files. |
| N48 | *(moved)* Next / previous file | — | — | — | **M28** | see §2.6 L04 | Owner resolved in §1.5. |
| N49 | *(moved)* Gapless transitions | — | — | — | **M28** | see §2.6 L41 | Owner resolved in §1.5. |
| N51 | **Skip Intro / Skip Ending** (time-based, markerless files) | P1 | sm | app | M25 | pure app code; mpv is only observed. State per *series folder* (the directory, matched with M28's natural-sort sibling set): `{introStart, introEnd, endingStart}` in `<dataDir>/skip.json`, keyed by folder + the episode-name prefix M28 already computes for L50.<br>observe `time-pos`; when it enters a learned window, either auto-skip (`["seek",<end>,"absolute+exact"]`) or show a 5 s "Skip Intro" button, per the user's setting; undo is always `{"command":["revert-seek"]}`.<br>**Two dedicated keys**, matching PotPlayer's `101_0_9_8_1` / `_2` (`Skip Intro %s`, `Skip Ending %s`) plus its setup dialog on `'` and enable toggle on `Shift+'`. | **Added from the critique — PotPlayer ships this as a first-class keybound feature and the spec had no row for it.** N08 (chapter-title regex) is a *different mechanism* and does nothing on the files this feature exists for: Korean drama and anime rips typically carry **no chapter markers at all**. PotPlayer's is time-based — skip the first N seconds and the last M seconds of every file in a series — which is exactly what works there.<br>**Mechanism, in shipping order.** (1) **P0-equivalent fallback, and the thing that must exist first: manual set points.** "Set intro start / set intro end / set ending start here" from the current `time-pos`, stored for the folder, applied to every sibling. This is three commands and a JSON file, it is deterministic, and it is what the user can always fall back to when the clever paths guess wrong. (2) **Learned offsets.** After the user skips manually on two episodes in the same folder, offer to apply the same window to the rest; store the offsets, not a fingerprint. (3) **Audio-fingerprint matching across the folder (P2 extension, M27's engine).** Decode the first ~90 s and last ~120 s of two siblings at 8 kHz mono through the existing headless-mpv path, compute a cheap spectral-peak fingerprint, and cross-correlate: an OP/ED is the longest common audio run across episodes. This is the only path that works on a folder the user has never touched, and it is also the only part with a real failure mode, so it is **opt-in, never automatic, and always proposes rather than applies**.<br>**Non-negotiable, inherited from N08:** off by default, always show the undo, and never skip without an OSD naming what was skipped. Effort `sm` for (1)+(2); (3) is a separate `md` on top and should not block the row. |
| N52 | Named jump targets — start / middle / 30 s before end | P1 | triv | cmd | M24 | start `["seek",0,"absolute+exact"]` · middle `["seek",duration/2,"absolute+exact"]` · near-end `["seek",Math.max(0,duration-30),"absolute+exact"]`<br>PotPlayer keys `101_0_9_6_14/15/16`: `BackSpace`, `Ctrl+BackSpace`, `Shift+BackSpace` | **Added from the critique.** Three lines of code, and three real keys in the `potplayer` preset that currently map to nothing. Note this is also the correct home for `BackSpace` = go to start, which §7.8 records the current preset getting wrong (it binds `Home`/`End`, which in PotPlayer are previous/next **subtitle** position). Guard on `duration > 0` — it is `0`/unknown for live streams (R24). |
| N53 | Sleep timer — stop playback after N minutes | P2 | sm | app | M33 | a plain timer in main: on expiry `{"command":["set_property","pause",true]}` via the core transport, an OSD, and no other action. Presets 15/30/45/60/90 min and "end of this file". | **Added by splitting N47.** N47 says "Never auto-quit. Never auto-shutdown the PC" — that is a decision and a defensible one, but it lumped in the benign half. **"Stop playback after 45 minutes" is a bedtime feature with no support-ticket risk**; "shut down the PC when the playlist ends" is a different thing and stays declined (§2.10 C). Keeping them in one row meant the good half was never specified and the decline was never recorded. **This row may pause and it may stop. It may never quit the app, sleep, hibernate or shut down the machine.** |
| N50 | OSD feedback on every navigation action | P0 | triv | app | M24–M27 | draw in the overlay via `ctx.osd`. If mpv's own OSD were ever wanted: `{"command":["show-text","<msg>",1500]}` plus the `osd-on-seek` property (`no`\|`bar`\|`msg`\|`msg-bar`, def bar). | Every binding in this area needs a message: `Ch 4/12 Opening`, `Bookmark: intro riff`, `A set 1:12.4`, `Loop 1:12.4 – 1:18.9`, `Frame 4312`, `Resumed at 41:12`. |

---

### 2.6 Playlist & media info — 50 features (P0 12 · P1 19 · P2 18 · 1 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| L01 | Playlist panel toggle | P0 | triv | app | M28 | renderer only; persist open/closed in config. Bind **both** F6 (PotPlayer) and F8 (mpv frontends). | Free mpv fallback if ever wanted: `{"command":["script-binding","select/select-playlist"]}` (needs `--load-select=yes`, which survives `--load-scripts=no`). We do not use it. |
| L02 | Auto-populate the playlist from the containing folder | P0 | triv | app | M28 | already implemented via `scanFolder(file)`.<br>mpv-native equivalent we deliberately do **not** use: `--autocreate-playlist=same --directory-filter-types=video,audio` | Extension lists live in `VIDEO_EXTENSIONS`/`AUDIO_EXTENSIONS`. mpv's own defaults are queryable with `mpv --help=video-exts` if you want to align. |
| L03 | Natural sort matching Windows Explorer | P0 | triv | app | M28 | **done.** `naturalCompare()` validated against `StrCmpLogicalW` by `scripts/verify-natural-sort.mjs` over 27 000+ ordered pairs, 0 mismatches. | **Do not replace it with `Intl.Collator(undefined,{numeric:true})`** — that disagrees with Explorer on zero-padding (`01` vs `1`) and on ignorable punctuation. Re-run `npm run verify:sort` after any edit. Sort the full filename **including** extension, as Explorer does. |
| L04 | Next / previous file | P0 | triv | app | M28 | app-side `next()`/`previous()` + `loadfile … replace`. "Previous" restarts the current file if more than ~3 s in, else steps back a file. | The 3-second rule is a real convention (VLC, foobar2000, Spotify) and is already in the code. This and N46 must share one code path so resume-saving is identical either way. |
| L05 | Repeat off / one / all | P0 | triv | app | M28 | repeat-one should use `{"command":["set_property","loop-file","inf"]}` / `"no"`, **not** seek-to-0 | The current seek-to-0 approach re-buffers and shows a black frame. `loop-file` loops seamlessly. Repeat-all only maps natively if the whole queue lives in mpv's playlist, which it does not — keep that app-side. |
| L06 | Shuffle that does not destroy the original order | P0 | triv | app | M28 | `shuffleOrder(length, keepIndex)` shuffles an **index map** (Fisher-Yates, current item pinned first), not the items array | **Do not use mpv's `playlist-shuffle`** — its counterpart `playlist-unshuffle` is documented to work "only once" and to break if playlists were opened since. PotPlayer distinguishes shuffle-playback (non-destructive) from Sort→Random (destructive); ship both and make the destructive one undoable. |
| L07 | Drag-and-drop reorder | P0 | triv | app | M28 | implemented; `reorder(from,to)` splices and re-finds the index by comparing `currentFile` lowercased | Extend to multi-row drags once L08 lands: move the whole contiguous selection as a block and drop **before** the row under the cursor (Explorer semantics), not after. |
| L08 | Multi-select with bulk operations | P1 | sm | app | M28 | renderer `selection: Set<number>` + `anchorIndex`; Ctrl+A, Delete → `removeMany([...selection])`, Shift+Delete → delete-from-disk with confirm | **Remove in descending index order** so earlier splices do not shift later indices, and recompute the playing index **once** at the end, not per removal, or the playing item is lost. |
| L09 | Drop files or folders onto the window | P0 | sm | app | M28 | renderer `drop` → `webUtils.getPathForFile(file)` (Electron 32+; `File.path` was removed) → main. Insert-at-point: `insertAt(index, paths)`. | **Critical bug risk:** `manager.ts` does not pass `--drag-and-drop`, and mpv's default is `auto`. mpv's `WS_CHILD` window will register its own OLE drop target and **replace its own internal playlist** on a drop over the video, bypassing us entirely. **Add `--drag-and-drop=no`.** |
| L10 | Remove item, clear playlist | P0 | triv | app | M28 | `removeIndex(i)`; clear = truncate + `stop()` + push state | Provide **undo for Clear** (keep the last cleared array in memory for one action) — losing a hand-built 200-file queue to a misclick is a rage bug. Note mpv's own `playlist-clear` deliberately *keeps* the playing file, which is usually not what a Clear button should do. |
| L11 | Playlist persistence across restarts | P0 | sm | app | M28 | debounced (500 ms) atomic write of `{version, items, index, updatedAt}` to `<dataDir>/playlists.json`; on boot drop entries whose file is missing but **keep the count** in a toast ("3 files are missing") | **Do not reuse `config.json`** — a 500-entry playlist there makes every config write expensive and the file unreadable. Decide the multi-list schema (L37) **before** the first release writes a file users care about. |
| L12 | Add folder / add folder recursively | P1 | sm | app | M28 | `fs.readdirSync(dir,{recursive:true,withFileTypes:true})` then filter and sort by `naturalCompare(path.join(d.parentPath,d.name))`; dialog with `properties:['openDirectory','multiSelections']` | `recursive:true` does not follow symlinks, so no loop guard is needed. Warn above ~5000 files and run the scan in a `worker_threads` worker or the UI freezes on a NAS folder. Sort key must be the full relative path so `SeasonA/ep2` groups before `SeasonB/ep1`. |
| L13 | M3U / M3U8 import | P0 | sm | app | M28 | parse in JS: optional `#EXTM3U`; `#EXTINF:<seconds>,<title>` before each entry (−1 = unknown); other `#` lines are comments; resolve with `path.resolve(path.dirname(m3u), line)`.<br>`.m3u8` is UTF-8 by definition; `.m3u` is legacy — read UTF-8 and fall back to the ANSI codepage (949 for Korean users) on invalid UTF-8. Strip a leading BOM. | We parse it ourselves rather than using `{"command":["loadlist",…]}`, because `loadlist` puts entries in *mpv's* playlist, not ours. Verified against mpv's own `parse_m3u`: it splits `#EXTINF:` on the **first** comma. |
| L14 | M3U8 export | P1 | sm | app | M28 | `#EXTM3U\r\n` then per item `#EXTINF:${Math.round(dur)\|\|-1},${title}\r\n${relOrAbsPath}\r\n`; write UTF-8 **without BOM** (mpv's parser expects `#EXTM3U` as the literal first line); use `path.relative` when on the same drive | **mpv has no playlist-writing command of any kind** — export is unavoidably app-level. Write `-1` for unknown durations, never 0, which some players read as a zero-length track. |
| L15 | PLS import / export | P1 | sm | app | M28 | `[playlist]` section, then `File<N>=`, optional `Title<N>=`, `Length<N>=` (−1 = stream), plus `NumberOfEntries=` and `Version=2`. N is 1-based and **sparse** — sort by N, do not assume contiguity. | Keys are case-sensitive per spec but be liberal on read (`file1` too). |
| L16 | PotPlayer `.dpl` import / export | P2 | sm | app | M28 | UTF-8 with BOM:<br>`\uFEFFDAUMPLAYLIST` / `playname=<path>` / `playtime=0` / `topindex=0` / `1*file*<path>` / `1*played*0` / `1*duration2*7200` / `1*start*0` / `2*file*…`<br>parse: `line.split('*file*')[1]`; index is 1-based and prefixes every key | **Unverified:** the reference implementation documents `duration2` as seconds, but real PotPlayer-written files appear to use **milliseconds**. Verify against a file PotPlayer actually wrote before trusting either unit; on import, sanity-check (if `/1000` lands in a plausible range and the raw value would mean >24 h, treat it as ms). Whether `topindex` is required is also unverified. |
| L17 | ASX / XSPF import (read-only) | P2 | sm | app | M28 | ASX: extract `<Ref HREF="…"/>` inside each `<Entry>`, title from `<Title>`. XSPF: `<trackList><track><location>file:///C:/…</location>`, `decodeURIComponent`, strip the scheme, `/`→`\`. | **mpv cannot help here** — its manual states plainly "XML playlist formats are not supported". mpv's `ini` parser handles the old ASF `[Reference] Ref1=` redirector, which is a different thing from ASX. |
| L18 | CUE sheet support | P2 | md | cmd | M28 | hand the `.cue` to mpv: `{"command":["loadfile","<file.cue>","replace"]}`; read tracks from `{"command":["get_property","chapter-list"]}` and seek with `{"command":["set_property","chapter",N]}` | **Semantic mismatch to design around:** PotPlayer shows CUE tracks as playlist *items*; mpv models them as *chapters of one file*. Do not force them into `items` — that breaks next/prev, resume and shuffle. Render a nested "tracks" group under one playlist row. |
| L19 | Playlist search that filters | P1 | sm | app | M28 | renderer only: `terms.every(t => it.name.toLowerCase().includes(t))`; render the filtered list but keep the true index on `li.dataset.index`. **Disable drag-reorder while a filter is active.** | PotPlayer explicitly changed from find-next to filter, and explicitly made space mean AND. Copy both decisions — they were made after user feedback. |
| L20 | Sort menu (name/date/size/duration/extension/random) | P1 | sm | app | M28 | comparators over the item plus `size`, `mtimeMs`, `duration`; keep the pre-sort order in memory for one-level undo; re-find the playing index after every sort | Stat all items **once** and cache on the item, or sort-by-size over a network share stalls for seconds. Duration sort must degrade gracefully while the background probe fills in — show unprobed items at the end rather than blocking. |
| L21 | Duration, size and index columns | P1 | md | ext | M29 | duration for a non-playing file is **not** available from the playing instance — use the probe (L22). Size/date are free from `fs.statSync`. | Probe **lazily** and only for rows in or near the viewport (IntersectionObserver), then persist results keyed by `path + size + mtimeMs`. Probing 500 files eagerly on open is a startup-time regression against the <300 ms target. |
| L22 | Headless mpv probe for non-playing files | P1 | md | cmd | M29 | spawn once, lazily, keep it:<br>`mpv.exe --idle=yes --no-config --terminal=no --msg-level=all=no --vo=null --ao=null --no-video --no-audio --keep-open=no --ytdl=no --load-scripts=no --input-ipc-server=\\.\pipe\rlplayer-probe-<uuid>`<br>per file: `loadfile … replace` → await `file-loaded` (2 s timeout) → get `duration`, `track-list`, `metadata`, `file-format`, `file-size` → `stop` | `--no-video --no-audio` does **not** hide tracks: `track-list` comes from the demuxer and every `demux-*` field is available. `video-params`/`audio-params` are **not** (they need an initialised decoder) — use `demux-*` in the probe path. **Random pipe name per instance is mandatory** — mpv's IPC is "explicitly insecure" and exposes the `run` command. Serialise requests one file at a time. |
| L23 | Media info panel | P0 | md | prop | M29 | `file-format` (mp4 reports the comma list `mov,mp4,m4a,3gp,3g2,mj2`), `file-size`, `duration`, `media-title`, `path`, `filename`<br>`current-tracks/video/codec-desc`, `/codec`, `/codec-profile`, `/decoder-desc`<br>`video-params/w /h /dw /dh /pixelformat /average-bpp /aspect /aspect-name /par /sar`<br>`container-fps` (container claim, "can easily contain bogus values") + `estimated-vf-fps` (measured)<br>`video-bitrate`, `audio-bitrate`, `audio-params/channel-count /hr-channels /samplerate /format`<br>`hwdec-current`, `current-vo`, `current-ao`, `track-list`, `chapter-list`, `metadata` / `filtered-metadata` | **Trap:** `video-codec`, `video-format`, `audio-codec`, `audio-codec-name` are **not in the current manual** — many tutorials still use them. They survive only as undocumented aliases (`M_PROPERTY_ALIAS("video-codec","current-tracks/video/codec-desc")`). Use the `current-tracks/…` forms. Overall container bitrate has no property — compute `file-size * 8 / duration`. **Observe, do not poll:** `VIDEO_RECONFIG` fires property-change for `video-params`/`dwidth`/`container-fps`/`current-vo`/`track-list`; `AUDIO_RECONFIG` for `audio-params`/`audio-bitrate`/`current-ao`. |
| L24 | Per-track detail for every track | P1 | sm | prop | M29 | one call: `{"command":["get_property","track-list"]}`<br>fields: `id type src-id title lang default forced dependent visual-impaired hearing-impaired selected main-selection external external-filename codec codec-desc codec-profile decoder-desc ff-index format-name demux-w demux-h demux-fps demux-bitrate demux-channel-count demux-channels demux-samplerate demux-rotation demux-par demux-duration image albumart hls-bitrate replaygain-track-gain replaygain-album-gain dolby-vision-profile dolby-vision-level metadata` | `demux-*` values are container *claims* — the manual repeatedly says "(Not always accurate.)". Prefer `video-params`/`audio-params` for the **selected** track and `demux-*` for the others, and label the column "as declared by the container". `codec-profile` only exists once the track has been decoded. |
| L25 | Copy media info to clipboard | P1 | triv | app | M29 | `clipboard.writeText(renderInfoAsText(snapshot))`, grouped `Key: value` lines | Include `hwdec-current`, `current-vo`, `video-params/pixelformat` and `mpv-version` — those four are what make a rendering bug report actionable. |
| L26 | File properties dialog (our own) | P1 | md | app | M29 | `fs.statSync` (`size`, `birthtimeMs`, `mtimeMs`) + the probe snapshot; render in a second BrowserWindow mirroring the settings-window pattern; buttons `shell.showItemInFolder` and `clipboard.writeText` | Build our own rather than shelling to Windows — PotPlayer does the same, and it lets us show media info the shell has no idea about. |
| L27 | Windows shell Properties dialog | P2 | md | ext | M29 | `SHObjectProperties(hwnd, SHOP_FILEPATH /*0x2*/, absPath, NULL)` from shell32 via koffi<br>PowerShell fallback: `$s=New-Object -ComObject Shell.Application; $s.Namespace('<dir>').ParseName('<name>').InvokeVerb('Properties'); Start-Sleep -Seconds 3600` | Two real gotchas: it **pumps a modal message loop**, so calling it on Electron's main thread freezes the app for the dialog's lifetime — run it in a worker that calls `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)` first. And the PowerShell dialog **dies when that process exits**, which is why the sleep is there. Microsoft warns the API "may be altered or unavailable in subsequent versions". |
| L28 | Album art display for audio files | P1 | triv | prop | M29 | spawn args: `--audio-display=embedded-first` (or `external-first`), `--cover-art-auto=fuzzy` (default is `exact`, which only matches `<basename>.jpg`)<br>`--cover-art-whitelist` — **mpv's actual default, read back over IPC, is** `["AlbumArt","Album","cover","front","AlbumArtSmall","Folder",".folder","thumb"]`; leave it alone unless you are deliberately reordering<br>detect: `track-list/N/albumart` / `track-list/N/image`<br>rescan: `{"command":["rescan-external-files","reselect"]}` | **Corrected: an earlier revision quoted `cover,front,folder,AlbumArt,Album,AlbumArtSmall,.folder,thumb` as if it were mpv's default. It is not** — same set, different order, and upstream capitalises `Folder`. Harmless on NTFS, but the row read as a quotation and was not one. If we ever *do* reorder (putting `cover`/`front` first is defensible), say so in the row and in the settings tooltip rather than presenting it as the engine default. **These three are M11's spawn args, not M29's** — M29 is read-only over mpv (§3.7); it requests them. Set `--audio-display=no` **only** if you draw the cover in the overlay instead (L29), otherwise you get mpv's copy behind ours. |
| L29 | Album art inside our own UI | P2 | md | app | M29 | `music-metadata` (npm, MIT, **pure ESM** — dynamic-import it from CJS main):<br>`const mm = await import('music-metadata'); const md = await mm.parseFile(p,{duration:true}); const pic = md.common.picture?.[0]`<br>sidecar fallback: `cover\|folder\|front\|AlbumArt\|Album\|thumb` × `.jpg\|.jpeg\|.png\|.webp` | `music-metadata` also yields duration/bitrate/samplerate for **audio** files with no mpv probe at all — it may be the cheaper metadata source for music-heavy playlists. It does not parse MKV/MP4 usefully, so video still needs L22. |
| L30 | Thumbnail / cover-art view mode for playlist rows | P2 | lg | ext | M27 | CSS-grid mode switch + a `getThumb(path)` service caching into `<dataDir>/cache/thumbs`. Audio covers come from L29; **video thumbnails need M27's engine with video enabled**, which is a heavier probe than L22. | **Overlap warning:** N36 needs the exact same second-mpv-with-video infrastructure. Build **one** shared engine (M27), not two. Cover-art thumbnails for audio are small effort and can ship first. |
| L31 | Folder-tree browser ("File Navigator") | P2 | lg | app | M28 | `fsbrowse:list(dir)` → `{dirs, files}` from `readdirSync(withFileTypes)`, each sorted with `naturalCompare`; drive roots by probing `A:`–`Z:` or `Get-PSDrive -PSProvider FileSystem`; Backspace → `path.dirname` | Genuinely useful and the answer to the VLC-4.0 criticism ("you can't browse the local filesystem"). But it is a full second panel with its own virtualisation and keyboard model — do not start it before the playlist panel is finished. Network/FTP browsing is out of scope. |
| L32 | Folder monitoring (auto-refresh) | P2 | sm | app | M28 | `fs.watch(dir,{recursive:false}, debounce(200, rescan))`, one watcher per source directory, closed when the playlist is replaced. Diff against current items: append new files at their sorted position; mark vanished ones as missing (grey, strikethrough) rather than removing them mid-session. | `fs.watch` on Windows is `ReadDirectoryChangesW` and fires bursts — the debounce is mandatory. **Do not watch a UNC path**: it either does not fire or hammers the connection. |
| L33 | Remove missing files / remove duplicates | P1 | triv | app | M28 | missing: `Promise.all` of `fs.promises.access` with a concurrency cap of ~32 — a synchronous 500-item check over SMB blocks the main process for seconds<br>duplicates: case-insensitive `Set` on `path.resolve(p).toLowerCase()` | PotPlayer has duplicate *prevention* as a persisted option applied at add-time, not only as a cleanup command. Ship it both ways. |
| L34 | Copy path(s) / Reveal in Explorer | P1 | triv | app | M28 | `shell.showItemInFolder(item.path)`; `clipboard.writeText(paths.join('\r\n'))` — **CRLF**, which is what Windows apps expect from a multi-line paste | Copying the actual **file** (CF_HDROP, pasteable into Explorer) is **not possible** with Electron's clipboard API. Offer "Copy path" only and use drag-out (L35) for real file transfer. |
| L35 | Drag a playlist item out to Explorer | P2 | sm | app | M28 | `webContents.startDrag({ file: absPath, icon: nativeImage })` (or `files: string[]`), triggered from the renderer's `dragstart` via IPC, then `e.preventDefault()`. `icon` is **required** and must be a non-empty NativeImage or it throws. | Conflicts head-on with in-list reorder on the same rows. Disambiguate the way file managers do: a drag staying inside the panel reorders; a drag leaving the panel rect converts to `startDrag`. Get this wrong and reordering becomes impossible. Reorder is P0, drag-out is P2 — if it proves fragile, drag-out loses. |
| L36 | Rename / delete-from-disk from the playlist | P1 | sm | app | M28 | rename: `fs.renameSync`, update the item, and if it is playing re-issue `loadfile` with the preserved `time-pos`<br>delete: `await shell.trashItem(path)` — **never `fs.unlinkSync`** for a user-visible delete<br>sibling subs: glob the directory for the media basename × the subtitle extension list, offer as checked items in the confirm dialog | Renaming the **currently playing** file on Windows usually fails with EBUSY because mpv holds the handle — stop playback (`["stop","keep-playlist"]`), rename, reload with a seek. Always confirm deletes. |
| L37 | Multiple named playlists ("Albums") | P2 | md | app | M28 | `playlists.json`: `{version, active, lists: Record<string,{name,items,index,updatedAt}>}`; the transient queue is a reserved key `'__queue__'` never offered for rename | Cheap once L11 exists, **but it changes the persistence schema** — write the multi-list shape from day one and avoid a migration. |
| L38 | Total playlist duration / selection duration | P1 | triv | app | M28 | `items.reduce((s,it) => s + (it.duration ?? 0), 0)`, formatted `Xh Ym`; show "N of M timed" while the probe runs | Depends entirely on L22. Until durations exist show the item count alone — **never show a total that silently omits unprobed files.** |
| L39 | Played / unplayed markers and filter | P2 | sm | app | M30 | reuse the resume store: three states from `position/duration` — unwatched (no entry), in-progress (0.02–0.95), finished (>0.95, matching the "don't save in the last 5%" rule). Add a batch `lookupMany(paths)` so the panel does one IPC round-trip, not N. | Cross-module: the resume store belongs to `core/per-file`. **Ask for `lookupMany` rather than reaching into its file** — that is exactly the shared-file collision to avoid. |
| L40 | Playlist row tooltip with media info | P2 | sm | app | M29 | custom tooltip (not `title=`, too slow and unstyleable) from the cached metadata; request a probe on 300 ms hover-intent if unprobed | The hover-intent delay matters: firing a probe on every mouse traversal of a 500-row list builds a queue backlog. |
| L41 | Gapless-ish transition between playlist entries | P2 | lg | cmd | M28 | `--prefetch-playlist=yes` **only works on mpv's own playlist**, and we issue `loadfile … replace`, so mpv's playlist has exactly one entry and prefetch is a no-op today. Getting it means mirroring the queue with `loadfile … append`, driving with `playlist-play-index`, and observing `playlist-pos`. | **This is an architectural fork, not a flag.** Mirroring also unlocks `loop-playlist`, `playlist-shuffle`, `playlist-move` and `--osd-playlist-entry` — but it means mpv and RLPlayer both hold list state and every reorder/remove must be applied twice and kept consistent. **Recommendation: don't.** Accept the ~200 ms gap. See §7.6. |
| L42 | True seamless concatenation (EDL) | P2 | md | cmd | M28 | `{"command":["loadfile","edl://<edl specification>","replace"]}` | **Unverified:** the concrete syntax lives in mpv's `DOCS/edl-mpv.rst`, not the main manual — read it before implementing rather than guessing. EDL merges files into **one** playlist entry, so resume, per-file subtitle delay and the playlist highlight all need special handling. Genuinely niche. |
| L43 | Audio visualisation for music files | P2 | md | vf | M29 | `{"command":["set_property","lavfi-complex","[aid1] asplit [ao], showcqt=s=1280x720 [vo]"]}`; also `showwaves=s=1280x240:mode=cline`, `showspectrum=s=1280x720:slide=scroll`; combine with `--audio-display=no` | **Partially verified only** — `lavfi-complex` is real and this is the documented idiom, but the exact graph string was not tested against a running build, and `--lavfi-complex` interacts badly with track selection (tracks selected through it report no `main-selection`). Prototype before committing. Album art covers 90% of the want. |
| L44 | MediaInfo-grade container report | P2 | md | ext | M29 | bundle `MediaInfo.dll` via koffi (`MediaInfo_New/Open/Option('Output','JSON')/Inform/Close`) or ship `MediaInfo.exe --Output=JSON` | **Unverified licence claim to check before bundling:** MediaInfoLib is believed to have relicensed to BSD-2-Clause around v19.04, which would suit MIT — confirm against the actual LICENSE in the release you ship. **Honest recommendation: skip.** The `track-list` + `video-params` + `metadata` set already covers everything a *viewer* cares about, and a second metadata engine doubles the surface for "why do these two panels disagree" bugs. |
| L45 | *(moved)* mpv's built-in stats overlay | — | — | — | **M29** | `{"command":["script-binding","stats/display-page-1"]}` … `-page-5`, `-toggle`; needs `--load-stats-overlay=yes` (default, **not** disabled by `--load-scripts=no`) | Owner resolved in §1.5. Worth wiring behind an Advanced menu item purely as a diagnostic: it renders **inside mpv's own video surface**, so it works even when the HTML overlay is broken — which matters given the Electron transparency risk. |
| L47 | **Image files and slideshow playback** | P1 | sm | app + prop | M28 | images already flow through the normal `loadfile` path — mpv decodes them as a one-frame video.<br>`{"command":["set_property","image-display-duration",5]}` — **confirmed `Double (0 to inf) (default: 5)`**; `inf` means "hold until the user advances"<br>slideshow = the existing playlist advance with `image-display-duration` set and `keep-open` handled; `Jump to previous/next slide` are L04's next/previous under different labels (PotPlayer `101_0_6_8/9`)<br>while an image is showing, suppress the seek bar and the time display rather than drawing a 0-second timeline | **Added from the critique, and it closes a hole that was worse than a missing feature.** **P30 already registers a full image category** (`avif,bmp,gif,heic,…,webp`) in the file-association picker, and there was **no row anywhere in §2 describing what happens when Explorer hands us a `.jpg`.** Claiming a file type in Windows' Default Apps and then having no defined behaviour for it is indefensible — it is the one outcome worse than not registering. So: **either this row ships, or the image category comes out of P30 and §1.3 says plainly that we are not an image viewer.** We ship it: the work is a playlist mode plus one duration setting, mpv does the decoding, and it makes the audio/video/image trio consistent. **P30's image category still ships unchecked by default** — being able to open an image is not the same as wanting `.jpg` in Default Apps. |
| L48 | Favorites — one flat list, separate from playlists | P2 | sm | app | M28 | `<dataDir>/favorites.json` = `[{path, title, addedAt}]`; two commands, PotPlayer's keys `Alt+Insert` (add current item) and `Ctrl+Insert` (add current folder); rendered as one section in the playlist panel | **Added from the critique** (PotPlayer `101_0_3` Album/Favorites). L37 covers "multiple named playlists (Albums)" at P2, but Favorites is a **different, much cheaper concept**: one list, two keys, no manager UI required, no schema change to `playlists.json`. Ship it without waiting for L37. |
| L49 | Playback queue, separate from the playlist | P2 | sm | app | M28 | the `'__queue__'` key **already reserved** in L37's schema; "Add to playback queue" (`Q` in the playlist window, PotPlayer `101_0_9_9_2`) appends; "Clear playback queue" (`111_0_5`) truncates; the advance path (N46/L04) drains the queue before the main list | **Added from the critique.** L37's schema reserves `'__queue__'` — someone clearly knew about this — but there was **no feature row, so the reserved key had no owner and no behaviour.** Now it does. The semantic that matters: the queue is *consumed*, the playlist is *positional*, and finishing a queued item returns you to where you were in the main list. |
| L50 | "Add together similar files" on open — only-selected / similar / all | P1 | sm | app | M28 | on open, three modes (PotPlayer `101_0_15_5`). "Similar" = strip the episode token from the basename (`S\d+E\d+`, ` - \d+ `, `\[\d+\]`, a trailing bare number) and group siblings sharing the remaining prefix, then natural-sort within the group. Setting `onOpen: 'selected' \| 'similar' \| 'all'`, default `similar`. | **Added from the critique.** L02 always scans the whole folder, and "similar" is what stops a 400-file anime archive from becoming your queue because you double-clicked one episode. Reuse the same prefix computation N51 uses to key a series folder — write it once, in M28, and expose it so M25 can call it. |
| L46 | Receive the Explorer "Add to RLPlayer playlist" verb | P1 | sm | app | M28 | register an argv flag: `rlplayer.exe --enqueue -- "<path>"`; in the `second-instance` handler branch on it and call `appendMany(paths)` **without** changing the playing index | Explorer passes **one invocation per selected file** unless the verb sets `MultiSelectModel="Player"` (M34's job). Debounce ~150 ms and batch on our side too, or 20 selected files produce 20 appends and 20 redraws. |

---
### 2.7 UI, window behaviour, OSD, shell integration — 47 features (P0 12 · P1 21 · P2 13 · skip 1)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| U01 | OSD feedback for every state change | P0 | md | app | **core/osd** + M31 | draw in the overlay. Main pushes `{kind:'volume'\|'seek'\|'speed'\|'track'\|'subdelay'\|'audiodelay'\|'aspect'\|'zoom'\|'info'\|'error', text, value?, durationMs}`.<br>fallback path only: `{"command":["show-text","Volume 85%",1200,1]}` (`show-text <text> [<ms>\|-1 [<level>]]`) | mpv's own OSD **is** visible in our topology (it renders inside the child HWND), so `show-text` genuinely works as a debugging fallback. But HTML OSD is the right primary: DPI-correct, themeable, and it can avoid the control bar without fighting `--osd-margin-y-offset`. |
| U02 | OSD position, alignment, margins | P1 | sm | app | M31 | CSS driven by config `{osdAlignX, osdAlignY, osdMarginX, osdMarginY}`.<br>mpv equivalents if ever routed there: `--osd-align-x` (def left), `--osd-align-y` (def top), `--osd-margin-x` 16, `--osd-margin-y` 16, `--osd-margin-y-offset` (explicitly "intended for dynamic margin adjustments at runtime … to avoid OSD/UI overlap") | PotPlayer's labels are literally "Horizontal align", "Vertical align", "Top margin", "Right margin" — and its margins are **symmetric** ("Top margin" means top *and* bottom). Match that semantic so refugees are not surprised. |
| U03 | OSD font, size, scaling, duration | P1 | sm | app | M31 | config `{osdFont, osdFontSize, osdScaleByWindow, osdDurationMs}` → CSS `clamp()` keyed off overlay size.<br>mpv: `--osd-font` (def sans-serif), `--osd-font-size` 30, `--osd-scale`, `--osd-scale-by-window` (def yes), `--osd-duration` 1000, `--osd-bold`, `--osd-color`, `--osd-outline-color/-size`, `--osd-back-color`, `--osd-border-style`, `--osd-blur`, `--osd-shadow-offset` | `--osd-scale-by-window` is mpv's name for PotPlayer's "OSD text will resize according to the size of the window". |
| U04 | Which events produce an OSD message | P1 | sm | app | M31 | config `osdEvents: {volume, seek, speed, track, subDelay, audioDelay, aspect, zoom, chapter, playlist, cache}`; the OSD service filters before rendering | PotPlayer goes further and lets you author a template string. If we ever want that, mpv's `--osd-msg1/2/3` property-expansion syntax is the reference design — but expand against our own state, do not shell out to mpv. |
| U05 | Progress OSD (time + bar on demand) | P2 | triv | app | M31 | app-level. mpv equivalent: `{"command":["show-progress"]}`; related `--osd-bar=yes`, `--osd-on-seek=no\|bar\|msg\|msg-bar` (def bar), `--osd-bar-align-y`, `--osd-bar-w`, `--osd-bar-h`, `--osd-fractions` | Low value since our seek bar is one hover away. Bind it anyway for mpv refugees who press `P`. |
| U06 | Stats / media info overlay toggle | P1 | triv | cmd | M29 | `{"command":["script-binding","stats/display-stats-toggle"]}`; pages `stats/display-page-1` … `-page-5`, `-page-0`, and `-toggle` variants. Requires `--load-stats-overlay=yes` (the default). | Works even with `--input-builtin-bindings=no`, because `script-binding` invokes the registered name directly rather than going through the key table. It renders **inside mpv's child HWND**, so it appears *under* our overlay's opaque areas — keep the overlay chrome out of the top-left while it is up, or dim it. |
| U07 | Always-on-top: Never / Always / While playing / Fullscreen only | P0 | sm | app | M31 | `mainWindow.setAlwaysOnTop(on,'floating')`; the **overlay must outrank it**: `rendererWindow.setAlwaysOnTop(on,'pop-up-menu')`.<br>State machine re-evaluated on the `pause` property change, on `idle-active`, and on enter/leave-full-screen. | **mpv's `--ontop` is inert under `--wid`** — the handler is guarded by `if (!w32->parent)`. On Windows, levels `floating`…`status` sit **below** the taskbar; `pop-up-menu` and above sit above it. Bind Ctrl+T to **cycle** the four modes (PotPlayer muscle memory), not to toggle a boolean. |
| U08 | Fullscreen toggle | P0 | triv | app | M31 | `mainWindow.setFullScreen(true\|false)`; mpv's child follows automatically because it is `WS_CHILD` filling the client rect | **mpv's `fullscreen` property is inert under `--wid`** (`update_fullscreen_state()` starts with `if (w32->parent) return;`). Never send it. `setSimpleFullScreen` is macOS-only, so there is exactly one code path on Windows. |
| U09 | Fullscreen on a chosen monitor | P1 | sm | app | M31 | **two steps in this order:** `win.setBounds(display.bounds)` then `win.setFullScreen(true)`. Persist both `display.id` **and** `display.label` so the choice survives a reconnect where ids change. | Electron cannot go fullscreen on a display the window is not on, hence the move-then-fullscreen order. `--fs-screen`/`--fs-screen-name` are inert under `--wid`. Restore the pre-fullscreen bounds yourself — Electron restores to the *moved* bounds. |
| U10 | Black out other monitors in fullscreen | P2 | sm | app | M31 | per non-playback display: `new BrowserWindow({...d.bounds, frame:false, backgroundColor:'#000000', focusable:false, skipTaskbar:true, hasShadow:false, show:false})` then `.setAlwaysOnTop(true,'screen-saver')` and `.showInactive()`; destroy on leave-fullscreen and on `display-removed`/`-added`/`-metrics-changed` | **`focusable:false` is essential** or the blackout windows steal keyboard focus from the overlay, which is the only window that sees input. |
| U11 | Auto-hide chrome and cursor | P0 | sm | app | M31 | overlay-side idle timer + `cursor: none`; config `{autoHideMs: 1500, autoHideInWindowedMode: false}`. Pass `--cursor-autohide=no` so mpv does not fight. | mpv's `--cursor-autohide` is dead anyway: mpv calls `EnableWindow(w32->window, 0)` when a parent is set, so its child never receives mouse messages. **Never hide while the pointer is over the control bar** — that is the detail people notice. |
| U12 | Borderless / chrome-free mode | P1 | sm | app | M31 | our windows are already `frame:false`, so this is renderer state: `ui:setChrome('full'\|'minimal'\|'none')` plus `win.setAspectRatio(dw/dh)` while in `none` | `--border=no` / `--title-bar=no` are inert under `--wid`. In `none` mode you lose the only drag handle — keep whole-window drag active or users cannot move the window. |
| U13 | Window size presets relative to video (50/100/150/200%) | P1 | sm | app | M31 | `{"command":["get_property","video-out-params"]}` → use `.dw`/`.dh` ("video size as integers, scaled for correct aspect ratio"), then `win.setContentSize(round(dw*f), round(dh*f))`, clamped to the display work area and re-centred. Observe `video-out-params` so presets stay correct after a filter or rotation change. | **`--window-scale` and `current-window-scale` are inert under `--wid`** — the geometry handler literally returns `VO_FALSE` when a parent exists. Compute in Electron, through `ctx.window.setContentSize()` (§3.3.7), never by importing `windows.ts`. **R-18 is settled and no longer blocks this row: `dw`/`dh` DO account for `video-rotate`.** Measured on a 320×240 source — `set video-rotate 90` → `video-out-params` returns `dw:240, dh:320`. **No dw/dh swap logic is needed** anywhere, here or in U16. |
| U14 | Window size as a fraction of the desktop (30/45/60/75%) | P2 | triv | app | M31 | `win.setBounds({width: round(wa.width*f), height: round(wa.height*f), x: centred, y: centred})` | Cheap once the preset module exists; ship in the same commit as U13. |
| U15 | Fit window to video on open, capped to the work area | P0 | sm | app | M31 | on `file-loaded` read `video-out-params`, then `k = min(1, wa.width*0.8/dw, wa.height*0.8/dh)` and `setContentSize(dw*k, dh*k)`. Guard with a `userResizedSinceOpen` flag. Config `fitToVideoOnOpen: 'always'\|'first-only'\|'never'`. | Opening a 4K file must not create a 3840 px window. `--autofit`, `--autofit-larger`, `--autofit-smaller` and `--geometry` are all **inert under `--wid`** ("If an external window is specified using the --wid option, this option is ignored"). Copy PotPlayer's option list including "Do not use". |
| U16 | Aspect-locked window resizing | P1 | sm | app | M31 | `win.setAspectRatio(dw/dh)` after each `video-out-params` change; `setAspectRatio(0)` to release. In compat layout pass `extraSize`: `win.setAspectRatio(dw/dh, {width:0, height:controlBarHeight})` | The ratio is **not respected for programmatic `setSize`** — call `setAspectRatio(0)` around preset resizes and restore it after. |
| U17 | Remember window placement per monitor configuration | P1 | md | app | M31 | key the saved rect by a topology signature: `displays.map(d => id:x,y,WxH@scale).sort().join('\|')` hashed; store `{[sig]: {x,y,width,height,maximized}}`; validate against `getDisplayMatching(rect).workArea` on restore and re-clamp on `display-removed`/`-metrics-changed` | The basic single-rect version exists (`persistBounds`/`clampToDisplay`) — **extend it, do not duplicate it**. Per-topology keying is the difference between "remembers my window" and "remembers my window on my desk *and* on the train". Never persist bounds while fullscreen. |
| U18 | Magnetic snap to screen edges | P1 | md | app | M31 | inside the existing drag loop: for each display's `workArea`, if `\|candidate.x − wa.x\| ≤ 12` set `candidate.x = wa.x` (and symmetric cases), with a sticky offset so the user must exceed the threshold to break free. Config `{snapEnabled, snapThresholdPx: 12}` | `--snap-window` is inert under `--wid` (`snap_to_screen_edges()` returns false when a parent is set). Snapping to **other applications'** windows needs `EnumWindows`, i.e. a native addon — ship edges-only and label it honestly ("화면 가장자리에 자석처럼 붙기"). |
| U19 | Native Aero Snap during window drag | P1 | md | app | M31 | clean fix, on the **main** window's HWND: `ReleaseCapture(); SendMessageW(hwnd, WM_NCLBUTTONDOWN /*0x00A1*/, HTCAPTION /*2*/, 0);` — hands the drag to Windows and gives Aero Snap for free (tiny N-API addon or koffi).<br>Pure-JS fallback: detect the cursor within 8 px of the work-area edge during the drag loop, paint a preview, and apply `win.maximize()` / half-screen bounds on release. | **A real defect today, not a missing nicety:** `beginDrag()` moves the window with `setInterval` + `setPosition`, bypassing Windows' drag loop entirely, so Aero Snap, drag-to-maximize and the snap preview are all dead. `-webkit-app-region: drag` does **not** rescue overlay mode — the HTML lives in an owned sibling window, so dragging it would move the overlay, not the video window. Decision needed: **§7.9 D-4** (the single-native-addon question). *(An earlier revision pointed at a §7.10 that does not exist.)* |
| U20 | Mini player (picture-in-picture) | P1 | md | app | M31 | **no new window and no mpv restart** — mutate the existing window so `--wid` embedding is untouched: save bounds → `setAspectRatio(dw/dh)` → `setContentSize(480, …)` → move to a corner of `workArea` → `setAlwaysOnTop(true,'screen-saver')` on both windows → `setMinimumSize(240,135)` → `ui:setChrome('none')`. Exit restores everything. | Use `'screen-saver'`, not `'floating'`: on Windows only `pop-up-menu` and above sit above the taskbar. **Honest finding: PotPlayer has no dedicated PiP mode** — this is a place where we beat it rather than match it (IINA's mini player is one of the most-praised things about IINA). |
| U21 | Prevent display sleep during playback | P0 | triv | app | M33 | on play `id = powerSaveBlocker.start('prevent-display-sleep')`; on pause/stop/idle/close `powerSaveBlocker.stop(id)`. Drive from the observed `pause` plus `idle-active`. | mpv also does this itself via `--stop-screensaver=yes` (process-wide `SetThreadExecutionState`, **not** window-scoped, so it is *not* inert under `--wid`). Harmless redundancy — but drive the authoritative block from Electron, because only we know "paused by the user" from "buffering". |
| U22 | Audio-only power policy | P1 | triv | app | M33 | if `track-list` has no selected video track (or `vid === false`) use `powerSaveBlocker.start('prevent-app-suspension')`, else `'prevent-display-sleep'`; swap when the file changes | Treat cover-art-only files (`track-list/N/albumart === true`) as audio-only, or **every MP3 with embedded art pins the display awake.** |
| U23 | Pause on lock / minimize / focus loss | P2 | sm | app | M33 | `powerMonitor.on('lock-screen'\|'unlock-screen')`; `mainWindow.on('minimize'\|'restore')`; `on('blur'\|'focus')` — but listen on the **overlay** for focus, since that is the window holding keyboard focus. Each behind its own flag; remember whether the user had already paused. | "Pause on focus lost" is genuinely divisive — it breaks background listening. Default it off and label it clearly. `powerMonitor` must be required after `app.whenReady()`. |
| U24 | Media keys (Play/Pause, Next, Prev, Stop) | P1 | sm | app | M33 | `globalShortcut.register('MediaPlayPause'\|'MediaNextTrack'\|'MediaPreviousTrack'\|'MediaStop', cb)`; check the boolean return and surface a conflict rather than failing silently.<br>**Pass `--input-media-keys=no`** so mpv does not also grab `WM_APPCOMMAND`. | mpv's default is "yes (except for libmpv)", so with a spawned `mpv.exe` you **must** opt out explicitly. `globalShortcut` is truly global — recommended default `mediaKeys: 'focused'` (register on `browser-window-focus`, unregister on blur) with an `'always'` option, so we do not steal keys from Spotify permanently. |
| U25 | System-wide hotkeys | P2 | sm | app | M33 | `globalShortcut.register(accel, cb)` routed through the same command table; `isRegistered(accel)` for pre-flight conflict checks; `unregisterAll()` on `will-quit` | **Source uncertainty:** it could not be confirmed that PotPlayer offers per-binding *system-wide* hotkeys — what is documented is media-key control plus a rich in-app editor. Treat this as our own addition: default **off**, empty by default, and never register bare letters globally. |
| U26 | Taskbar thumbnail toolbar buttons | P1 | sm | app | M32 | `mainWindow.setThumbarButtons([{icon, tooltip:'이전', flags:['enabled'], click}, …])`; re-call whenever `pause` changes to swap the glyph; clear with `setThumbarButtons([])` | Max 7 buttons, and **the toolbar cannot be removed once set** — an empty array only clears the buttons. Requires `app.setAppUserModelId()` (already set). Call it on the **main** window, never the overlay (`skipTaskbar: true`). |
| U27 | Taskbar progress bar | P1 | triv | app | M32 | throttled to ~2 Hz off `time-pos`: `mainWindow.setProgressBar(duration>0 ? t/duration : -1, {mode: paused?'paused':'normal'})`; clear with `-1` | **`--taskbar-progress` is effectively inert:** mpv calls `SetProgressValue` on its own child HWND, which has no taskbar button, so nothing is drawn. Pass `--taskbar-progress=no` to make the intent explicit and drive it from Electron. |
| U28 | Taskbar overlay icon and thumbnail tooltip | P2 | triv | app | M32 | `mainWindow.setOverlayIcon(nativeImage /*16×16*/, '재생 중')`, `null` to clear; `setThumbnailToolTip(path.basename(currentPath))` | Genuinely useful when the window is minimised and audio is playing. |
| U29 | Taskbar thumbnail clip | P2 | triv | app | M32 | `mainWindow.setThumbnailClip({x,y,width,height})` in content coordinates; reset with all-zeros. In compat layout feed it the same rect the renderer reports via `setVideoRegion()`. | **Real risk:** DWM builds the thumbnail from the window's redirection surface, and mpv presents through a D3D11 **flip-model** swapchain in its own child HWND — the clipped region may come back **black**. Prototype before promising; if it is black, drop the feature rather than shipping a black preview. |
| U30 | Windows jump list (recent files + tasks) | P1 | sm | app | M32 | `app.setJumpList([{type:'custom', name:'최근 항목', items: recent.map(p => ({type:'task', title: basename(p), description:p, program: process.execPath, args:`"${p}"`, iconPath: process.execPath, iconIndex:0}))}, {type:'tasks', items:[…]}])`; check the return value (`ok`/`error`/`invalidSeparatorError`/`fileTypeRegistrationError`/`customCategoryAccessDeniedError`) | **Critical design constraint:** `fileTypeRegistrationError` — "an attempt was made to add a file link for a file type the app isn't registered to handle". Since we are portable-first and do **not** claim associations, recent entries must be `type:'task'` items that relaunch our exe with the path as an argument, **never `type:'file'`**. Separators are only legal in the standard `tasks` category. **Skip the whole feature in portable mode.** |
| U31 | Windows recent documents integration | P2 | triv | app | M32 | `app.addRecentDocument(absPath)`; `clearRecentDocuments()`; `getRecentDocuments()` | Writes shell state, so it must be **disabled in portable mode** alongside the jump list, and it needs an explicit off switch — some users treat the Windows recent list as a privacy leak, and our pitch is precisely about not doing things behind people's backs. |
| U32 | Drag-and-drop onto the window | P0 | triv | app | M31 | renderer `dragover` → `preventDefault()`; `drop` → `webUtils.getPathForFile(f)` → main. Pass **`--drag-and-drop=no`** so mpv's own handler never competes. | See L09 — this is the other half of the same bug. The drop target must be the **overlay** window in overlay layout; a drop over the video lands on the overlay, which is correct. |
| U33 | Modifier-aware drop (replace vs append) with a visible overlay | P1 | sm | app | M31 | `mode = (e.shiftKey \|\| e.ctrlKey) ? 'append' : 'replace'`; set `e.dataTransfer.dropEffect` to `'copy'`/`'move'` so the OS cursor matches; render a full-window label "재생" vs "재생목록에 추가" | PotPlayer's "advanced" variant pops a chooser dialog. A modifier plus a visible label is better UX and needs no dialog. |
| U34 | Drop onto the exe; folder arguments; `.lnk` | P0 | triv | app | M33 | extend `filesFromArgv()`: it currently does `statSync(p).isFile()` and **silently discards directories**. Keep both files and directories, expand directories via M28's natural sort, and resolve shortcuts with `shell.readShortcutLink(lnk).target` before the stat. | A concrete bug today: dropping a folder on the exe does nothing at all. PotPlayer explicitly fixed `.lnk` handling, which suggests users really do drop shortcuts. |
| U35 | Single-instance behaviour, three modes | P0 | sm | app | M33 | keep `requestSingleInstanceLock()` + `on('second-instance')`, but branch on `instanceMode: 'single'\|'multiple'\|'single-append'` — in `'multiple'` you must **not request the lock at all**. `--new-instance` bypasses regardless of config. | Ordering trap: `requestSingleInstanceLock()` must be called **before** `app.whenReady()`, so config must be readable that early. `app.getPath('userData')` is available pre-ready, so this works — but portable resolution (P36) must run first. |
| U36 | Theme: dark / light / follow Windows | P0 | sm | app | M31 | `nativeTheme.themeSource = 'system'\|'light'\|'dark'`; read `shouldUseDarkColors`; react to `nativeTheme.on('updated')` and broadcast. One token layer: `:root { --bg, --fg, --accent, --surface, --border, --osd-bg, --osd-fg }` switched by `[data-theme]`. Always `backgroundColor:'#000000'` on the video window. | Dark chrome around video is not a preference, it is the point — `docs/01` lists bright chrome as a top VLC grievance. Because our windows are `frame:false`, mpv's DWM dark-title-bar handling is irrelevant (and inert under `--wid` anyway). |
| U37 | Accent colour and Mica/Acrylic for secondary windows | P2 | triv | app | M31 | `win.setAccentColor(true \| '#RRGGBB' \| false)`; `new BrowserWindow({backgroundMaterial:'mica'\|'acrylic'\|'tabbed'\|'auto'\|'none'})` or `setBackgroundMaterial` | **Never apply `backgroundMaterial` to the video window** — mpv's opaque child HWND covers it entirely, so it costs compositing work for zero visible pixels. Settings and playlist windows only. |
| U38 | Window title / taskbar label | P0 | triv | app | M31 | on `file-loaded`: `mainWindow.setTitle(\`${mediaTitle \|\| basename(path)} — RLPlayer\`)`; on idle `'RLPlayer'`. Source from `media-title` with `filename` as fallback. | mpv's `--title` sets the title of *mpv's* window, which under `--wid` is an invisible child — inert for the taskbar. Cheap, and its absence is immediately visible in Alt+Tab. |
| U39 | System tray icon, four modes | P2 | sm | app | M32 | `new Tray(icon)` + `setToolTip` + `setContextMenu`; `on('double-click')` → show+focus; `mainWindow.setSkipTaskbar(true)`. Config `trayMode: 'taskbar'\|'both'\|'tray'\|'tray-when-minimized'`. | Must also handle "hide all windows when minimized": in tray-only mode the **overlay must be hidden too**, or an invisible always-on-top window is left floating over the desktop. `windows.ts` already hides the secondary window on `minimize` — reuse that path. |
| U40 | Center on start; resize about the centre | P1 | triv | app | M31 | centre: `win.center()` or explicit workArea maths.<br>centre-anchored resize: capture the centre before any programmatic `setContentSize`, then reposition to `{x: c.x − newW/2, y: c.y − newH/2}` and re-clamp. | Centre-anchored resize matters most for U13 — without it, pressing "200%" shoves the window off the bottom-right of the screen. Bundle it with the presets. |
| U41 | Do not steal focus when launched with a file | P2 | triv | app | M33 | use `showInactive()` instead of `show()` + `focus()`; skip `win.focus()` in the `second-instance` handler under the same flag | Sharp edge: the **overlay** is the only window that can see keyboard input, so if you later decide to take focus you must focus the overlay, never the main window. `showWindows()` already gets this right — preserve the invariant. |
| U42 | Per-monitor DPI awareness | P0 | triv | app | M31 | free with Electron (Chromium is per-monitor-DPI-v2). Requirement: express all overlay CSS in DIP px and never hardcode device pixels. **Do not set `--hidpi-window-scale`.** | Zero work, but explicit because the sizing maths in U13/U15/U16 must use DIP consistently: Electron's `setContentSize`/`getBounds` are **DIP**, while `video-out-params/dw` is in **real pixels**. Mixing them is how you get a window 1.5× too large on a 150% monitor. |
| U43 | Exclude window from screen capture | skip | triv | app | — | `setContentProtection(true)` | DRM-adjacent, no legitimate demand in a local-file player, and it will confuse users whose screen-share suddenly shows black. `--window-affinity` is inert under `--wid` anyway. Deliberately not shipping. |
| U44 | Customisable right-click menu | P2 | md | app | M38 | make the menu data-driven: a registry of `{id, labelKey, buildItem(state)}` plus a config array of ids and separators. Modules register items rather than editing `menu.ts`. | Only worth the *user-facing* customisation UI at P2 — but **the registry itself is Wave 0 work**, because nine implementers all need menu entries. |
| U46 | Three fullscreen modes — keep AR / stretch / stretch keeping AR | P1 | sm | app | M31 | all three are `ctx.window.setFullScreen(true)` plus one of **V23**'s fit modes, applied as a pair:<br>`Enter` keep AR → `keepaspect=true, panscan=0`<br>`Ctrl+Enter` stretch → `keepaspect=false`<br>`Ctrl+Alt+Enter` stretch keeping AR → `keepaspect=true, panscan=1.0`<br>M31 owns the window; the fit properties are **M02's**, so M31 requests them via `ctx.commands.invoke('video-geometry.setFitMode', …)` | **Added from the critique.** U08 has exactly one fullscreen. The stretch variants are a two-line combination of U08 and V23, they are muscle memory for the `Ctrl+Enter` crowd, and leaving them out means two PotPlayer keys land on nothing. Restore the previous fit mode on leaving fullscreen — the mode is a property of *being* fullscreen, not a global toggle. PotPlayer's fourth entry, **Desktop Mode** (`Shift+Enter`, video as wallpaper), is **declined** and recorded in §2.10 C. |
| U47 | Three-level info OSD — full / short / misc | P1 | sm | app | M29 | one surface, three densities, driven off the same snapshot M29 already builds:<br>`Tab` full playback + tag info (the existing L23 panel content) · `Shift+Tab` **short**: title, position/duration, current a/v/s track, hwdec · `Scroll Lock` misc: cache, dropped frames, `current-vo`, `hwdec-current`, `estimated-vf-fps` | **Added from the critique.** U06/L23 give exactly one stats surface; PotPlayer's tiered glance/detail model is genuinely better and there was no row for the short form. Cheap because it is a projection of data M29 already has — the work is deciding what the six-line version says, and the answer is "the six things that appear in every bug report". Contributed sections (`ctx.ui.statsSection`) declare which levels they appear at; default is `full` only, so a new section never clutters the glance view. |
| U45 | Window opacity | P2 | triv | app | M31 | `mainWindow.setOpacity(0.85)` and the overlay kept in sync; slider 0.3–1.0, exposed only in mini-player / always-on-top contexts | Opacity below 1 on a window hosting a D3D11 child HWND forces a layered-window path and **can visibly hurt playback smoothness**. Measure before promoting above P2; never make it the default. |

---

### 2.8 Streaming & external sources — 35 features (P0 4 · P1 15 · P2 11 · skip 3 · 2 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping | Trap to avoid |
|---|---|---|---|---|---|---|---|
| R01 | Open URL dialog | P0 | sm | cmd | M35 | `{"command":["loadfile","<url>","replace",-1,{"force-media-title":"<name>"}]}`<br>append instead: flags `"append-play"` | **The 3rd argument must be `-1`** when you pass the 4th options map. **Measured: without it the command hard-errors (`{"error":"invalid parameter"}`) and nothing loads — it does not silently drop the map.** Check the reply. Per-file options are automatically restored at end of playback — exactly what you want for per-stream user-agent / referrer / rtsp-transport. |
| R02 | Network protocol coverage (allowlist) | P0 | sm | prop | M35 | **ALLOW:** `http https ftp ftps sftp dav davs webdav webdavs smb mms mmsh mmst mmshttp rtmp rtmpe rtmps rtmpt rtmpte rtmpts rtp srtp srt rtsp rtsps udp udplite tcp tls dtls ipfs ipns data`<br>**DENY from clipboard / CLI / drag-drop / protocol handler:** `mpv:// av:// avdevice:// file:// fd:// fdclose:// hex:// memory:// null:// slice:// concat:// concatf:// edl:// lavf:// ffmpeg:// env:// archive:// appending://`<br>`--access-references=yes` (default) follows references inside opened files | `av://`/`avdevice://` reach libavdevice; `edl://`/`lavf://`/`env://` are arbitrary-input primitives; mpv's own docs call the IPC surface "explicitly insecure". Denying these is cheap insurance. Note `data:` must be written `data://` in mpv. |
| R03 | Recent-URL history | P1 | sm | app | M35 | JSON store beside the resume store: `{url, title (from `media-title`), lastPlayed}`, LRU-capped ~50 | Mirror PotPlayer's semantics exactly: keep **only user-entered URLs**, not URLs played from a playlist — otherwise an HLS master playlist floods your history with segment URLs. That toggle exists in PotPlayer for a reason. |
| R04 | Remote playlist files (.m3u/.m3u8/.pls/.asx) | P1 | sm | cmd | M35 | known playlist: `{"command":["loadlist","<url>","replace"]}`; ambiguous: just `loadfile` and let `demux_playlist` handle it.<br>Keep `--load-unsafe-playlists=no` (the default). | **HLS disambiguation:** a `.m3u8` may be an HLS manifest (play it) or a plain playlist (expand it). **Do not branch on extension.** Let `loadfile` decide; only fall back to `loadlist` if `track-list` comes back empty and the demuxer reported no streams. |
| R05 | yt-dlp site playback | P1 | md | ext | M36 | `--ytdl=yes --script-opts-append=ytdl_hook-ytdl_path=<abs path to yt-dlp.exe>`<br>force a URL through it: `loadfile "ytdl://<url>"` | **Verified by experiment:** `--ytdl=no` prevents `ytdl_hook.lua` from loading **at all**, and `--load-scripts=no` does *not* disable it. Setting the `ytdl` property at runtime therefore cannot retroactively load the script. **Recommended design so the toggle needs no restart:** always launch with `--ytdl=yes --script-opts-append=ytdl_hook-exclude=.*` (which makes zero network calls) and clear it at runtime with `{"command":["change-list","script-opts","append","ytdl_hook-exclude="]}`. Because we pass `--no-config`, `ytdl_path` **must be an absolute path**. |
| R06 | yt-dlp discovery / bring-your-own | P1 | sm | ext | M36 | ytdl_hook's own search order, extracted from the binary: `paths_to_search = {"yt-dlp","yt-dlp_x86","youtube-dl"}`; `o.ytdl_path` when non-empty **replaces** the list and is `;`-separated on Windows.<br>App probe order: `<userData>/tools/yt-dlp.exe` → `<exeDir>/tools/yt-dlp.exe` → `config.ytdlPath` → `where yt-dlp` → `%LOCALAPPDATA%\Microsoft\WinGet\Links\yt-dlp.exe` / scoop shims. Version probe: `<path> --version`. | **Licensing:** yt-dlp source is Unlicense, but the published PyInstaller executables are stated by the project to be **GPLv3+**. Shipping that `.exe` inside an MIT app's ZIP is at best mere aggregation. Not bundling it is simultaneously the licensing-safe, no-bundled-junk and update-problem answer. Do all three at once. |
| R07 | yt-dlp update, without reintroducing nagging | P1 | md | ext | M36 | yt-dlp updates **itself**; we never write an updater:<br>`<ytdlp.exe> --update-to nightly` · `-U` · `--update-to stable@2026.08.19`<br>**Trigger rule:** surface the update affordance only at the moment of an actual extraction failure, never on a timer. Detect via `{"command":["get_property","user-data/mpv/ytdl/json-subprocess-result"]}` (set by ytdl_hook, deleted on end-of-file). | Measured cadence: bursty, roughly monthly with reactive clusters; the project calls **nightly** "the recommended channel for regular users". One non-modal toast on failure, and that is the **only** time the app ever mentions updating anything. No background task, no scheduled task, no Run key, no launch check. |
| R08 | Stream quality / format selection | P1 | md | ext | M36 | ytdl_hook already does the hard part. Verified defaults in this build: `all_formats = true`, `force_all_formats = true` — with those on it builds an EDL exposing **every** yt-dlp format as a separate delay-loaded mpv track. So the quality menu **is** the track menu: read `track-list`, switch with `vid`/`aid`.<br>Be explicit anyway: `--script-opts-append=ytdl_hook-all_formats=yes` and `-force_all_formats=yes`. For richer labels read the cached yt-dlp JSON rather than spawning it again. | Switching `vid`/`aid` on an EDL **re-opens the underlying stream** — expect a visible rebuffer; show the buffering indicator, do not pretend it is instant. When yt-dlp returns no `requested_formats` (typical for an HLS master playlist) ytdl_hook deliberately does **not** split formats, so some sites legitimately show one quality. Not a bug. |
| R09 | Explicit `--ytdl-format` override | P2 | triv | prop | M36 | `{"command":["set_property","ytdl-format","bestvideo[height<=?1080][vcodec^=avc1]+bestaudio/best"]}`<br>presets: `""`, `bestvideo[height<=?1080]+bestaudio/best`, `…<=?720…`, `bestaudio/best` | "An empty value or `ytdl` does not pass a `--format` option at all." Takes effect on the **next** loadfile — prefer setting it per-file in the options map. Redundant with R08's track menu; ship the menu first. |
| R10 | Arbitrary yt-dlp options (cookies, proxy, auth, geo) | P2 | sm | prop | M36 | key without leading dashes; flag-style options need a trailing `=`:<br>`--ytdl-raw-options-append=cookies-from-browser=chrome`<br>`--ytdl-raw-options-append=proxy=http://127.0.0.1:3128`<br>`--ytdl-raw-options-append=force-ipv6=`<br>runtime: `{"command":["change-list","ytdl-raw-options","append","cookies-from-browser=chrome"]}` | Manual: "There is no sanity checking so it's possible to break things." `cookies-from-browser` reads the user's browser cookie DB — a meaningful privacy action for a zero-telemetry app. Make it **opt-in per source** with a one-line explanation, never a global default. The proxy does not apply to https URLs at playback time. |
| R11 | CDN per-connection throttling workaround | P1 | triv | prop | M35 | `--curl-max-request-size=8MiB` (default 0 = one open-ended request)<br>companions, all verified present: `--curl-enabled=yes`, `--curl-http-version=auto`, `--curl-max-redirects=16`, `--curl-max-retries=5`, `--curl-connect-timeout=30`, `--curl-buffer-size=4MiB`; debug `--msg-level=curl=trace` | **New and easy to miss.** mpv master gained an internal libcurl backend (HTTP/2 and HTTP/3, HSTS) replacing FFmpeg's for http/https/ftp/ftps, and this build has it. Manual: "a common workaround for per-connection bandwidth throttling employed by some CDNs, where each Range request is served at full speed but a single long-lived connection is rate-limited." Expose it as one "스트리밍이 자꾸 끊길 때" toggle, not a byte field. |
| R12 | HLS variant selection | P1 | triv | prop | M35 | `--hls-bitrate=<no\|min\|max\|<rate>>` (default `max`)<br>per-file: `{"command":["loadfile","<m3u8>","replace",-1,{"hls-bitrate":"3000000"}]}` | "The bitrate as used is sent by the server, and there's no guarantee it's actually meaningful." **There is no mid-stream ABR switching in mpv** — the choice is made at open time, so changing it requires a reload. Say so in the UI rather than letting the user think nothing happened. |
| R13 | MPEG-DASH playback | P1 | triv | prop | M35 | just `loadfile` the `.mpd`; force if probing picks wrong: `{"command":["loadfile","<url>","replace",-1,{"demuxer-lavf-format":"dash"}]}`<br>for yt-dlp sources: `--script-opts-append=ytdl_hook-use_manifests=yes` (default no) | FFmpeg's DASH support is weaker than its HLS support — no representation-selection option comparable to `--hls-bitrate`, and encrypted (CENC/Widevine) DASH will never work and should not be attempted. `use_manifests=yes` is off upstream for a reason; keep it an advanced toggle. |
| R14 | RTSP camera / NVR playback | P1 | sm | prop | M35 | `--rtsp-transport=<lavf\|udp\|udp_multicast\|tcp\|http>` (default `tcp`)<br>per-file camera preset: `{"command":["loadfile","rtsp://…","replace",-1,{"rtsp-transport":"tcp","profile":"low-latency","untimed":"yes","cache":"no"}]}`<br>verified `low-latency` profile contents: `audio-buffer=0, vd-lavc-threads=1, cache-pause=no, demuxer-lavf-o-add=fflags=+nobuffer, demuxer-lavf-probe-info=nostreams, demuxer-lavf-analyzeduration=0.1, video-sync=audio, interpolation=no, video-latency-hacks=yes, stream-buffer-size=4k` | **`--network-timeout` is broken for RTSP** and is (or should be) ignored: "merely setting the option will put RTSP into listening mode, which breaks any client uses." Do not wire a global network-timeout slider to RTSP. The documented workaround is `--demuxer-lavf-o`, but the correct key/unit for libavformat 63.6.100 is **unverified** — test against a real camera first (**§7.4 R-14**). |
| R15 | RTMP / SRT / UDP / RTP multicast | P2 | sm | prop | M35 | all present in `--list-protocols`.<br>IPTV multicast: `{"command":["loadfile","udp://@239.1.1.1:5000?fifo_size=1000000&overrun_nonfatal=1","replace",-1,{"profile":"low-latency","cache":"no","demuxer-lavf-format":"mpegts"}]}`<br>SRT: `srt://host:port?mode=caller&latency=200000` | Free from the engine. The only real work is not mangling the query string when parsing the URL, and **not treating `@` in `udp://@239…` as userinfo**. Multicast on Windows additionally needs the right interface (`localaddr=` via `stream-lavf-o`). |
| R16 | Buffering indicator and stall feedback | P0 | sm | prop | M35 | observe: `paused-for-cache` (stalled), `cache-buffering-state` (0–100, the number to render), `demuxer-cache-duration`, `demuxer-cache-time`, `demuxer-via-network` (**gate all this UI on it**), `cache-speed`, and `demuxer-cache-state` → `{fw-bytes, raw-input-rate, seekable-ranges:[{start,end}], bof-cached, eof-cached, cache-end, reader-pts, cache-duration, file-cache-bytes}` | Without this, every slow stream reads as a crashed player. **Draw `seekable-ranges` on the seek bar as the buffered region** — for a live stream that is literally the DVR window and it is the single most legible piece of streaming UI you can ship. `raw-input-rate` is documented "may be inaccurate or missing" — render it as a soft hint. |
| R17 | Cache size and readahead tuning | P1 | sm | prop | M35 | `--cache=<no\|auto\|yes>` (def auto) · `--cache-secs` (def 3600000) · **`--demuxer-max-bytes` (def 150MiB — the knob that actually caps the buffer)** · `--demuxer-max-back-bytes` (def 50MiB) · `--demuxer-readahead-secs` (def 1) · `--cache-pause` (def yes) · `--cache-pause-initial` (def no) · `--cache-pause-wait` (def 1) · `--stream-buffer-size` (def 128KiB)<br>presets: 기본 150MiB/50MiB · 불안정한 회선 1GiB/256MiB + `cache-secs=300` + `cache-pause-initial=yes` + `cache-pause-wait=5` · 저지연 `profile=low-latency, cache=no` | **The most misunderstood pair in mpv:** raising `--cache-secs` alone does nothing — "the default is set to something very high, so the achieved readahead will usually be limited by `--demuxer-max-bytes`". **If your settings UI has one buffer slider, it must move `demuxer-max-bytes`.** `--cache-pause-initial` also triggers after seeking, which is why raising `cache-pause-wait` makes seeks feel sluggish — pair them as presets. |
| R18 | Cache on disk | P2 | triv | prop | M35 | `--cache-on-disk=yes` · `--demuxer-cache-dir=<path>` (portable: beside the exe) · report `demuxer-cache-state/file-cache-bytes` | "The cache file is append-only. Even if the player appears to prune data, the freed space is not reused… when the media is closed the cache file is deleted." So it grows during a long live session. Also: with this on, `--demuxer-max-bytes` **applies to metadata only** ("50 MB per hour is typical") — your buffer slider silently changes meaning. Hide the byte sliders when it is on. |
| R19 | HTTP headers / User-Agent / Referer / cookies / proxy | P1 | sm | prop | M35 | **always per-file, never global:** `{"command":["loadfile","<url>","replace",-1,{"user-agent":"…","referrer":"…","http-header-fields":"X-Token: abc"}]}`<br>also `--cookies=yes --cookies-file=<netscape cookies.txt>`, `--http-proxy=http://host:port`<br>runtime list: `{"command":["change-list","http-header-fields","append","X-Token: abc"]}` | mpv's default user-agent is literally `libmpv`, which is a fingerprint and which some CDNs 403 — consider a normal browser UA for http(s) media. **The proxy "is silently ignored if it does not start with `http://`. Proxies are not used for https URLs."** — so an https stream bypasses the setting and the user thinks it is broken. Say it in the UI. |
| R20 | Per-stream TLS verification override | P2 | sm | prop | M35 | per-file only: `{"command":["loadfile","<https url>","replace",-1,{"tls-verify":"no"}]}`; also `--tls-ca-file`, `--tls-cert-file`, `--tls-key-file`<br>UX: on TLS failure offer "이 주소만 인증서 검증 건너뛰기", remember per-origin, and show a persistent lock-open badge while such a stream plays | Echo mpv's own wording in the UI: "Disabling this option allows man-in-the-middle attacks to silently substitute the content of an HTTPS stream and is only recommended as a per-stream override when verification fails for a known-good reason." **Never ship a global "ignore certificate errors" checkbox.** |
| R21 | *(moved)* Stream recording | — | — | — | **M23** | see §2.4 C17 | Owner resolved in §1.5; priority resolved to P2. |
| R22 | Track handling for network streams | P0 | sm | prop | M35 | same machinery as local files, but tracks appear **late**: `{"command":["observe_property",<id>,"track-list","node"]}` and re-render the menus on every change.<br>`--alang=ko,kor,en,eng --slang=ko,kor,en,eng`<br>for mpegts, per-file: `{"demuxer-lavf-probesize":"10MiB","demuxer-lavf-analyzeduration":"5"}` | The failure this prevents: user opens an IPTV channel, the audio menu shows one track, they conclude the app is broken — when the second audio PID simply had not been probed yet. **Observing rather than snapshotting `track-list` is the entire fix.** Note the `low-latency` profile sets `demuxer-lavf-probe-info=nostreams`, which makes this **worse** — do not apply it to multi-audio IPTV. |
| R23 | External subtitles for network streams | P1 | sm | cmd | M35 | `{"command":["sub-add","C:/subs/ep01.ko.srt","select","한국어","ko"]}` — a **URL works too**: "load the given subtitle file *or stream*"<br>external audio likewise via `audio-add`; `{"command":["sub-reload"]}` after editing | **Critical gap:** `--sub-auto` only ever scans the media file's own directory and `--sub-file-paths`. It does **nothing** for `http://` URLs, and no engine feature fills that. Compensate app-side: accept a dropped `.srt` while a stream plays (sub-add, not a playlist replace), add an explicit "자막 URL 추가…", and remember the subtitle attached to a given URL keyed by URL. Grey the auto-load indicator for streams rather than letting people think it failed. |
| R24 | Live stream seeking within the cache | P1 | sm | prop | M35 | `--force-seekable=yes` — "if the player thinks the media is not seekable… this option can forcibly enable it. For seeks within the cache, there's a good chance of success."<br>pair with `--demuxer-max-back-bytes=512MiB` (and `--cache-on-disk=yes` if that is too much RAM)<br>render the window from `demuxer-cache-state.seekable-ranges`, using `bof-cached`/`eof-cached` for the edges | For a live stream the seek bar should show **only the cached range**, not a 0..duration bar (`duration` is often unknown/0 for live). Getting this wrong is why live streams feel unseekable even when they are. |
| R25 | Webcam / capture-device input | P2 | md | ext | M37 | enumerate by spawning a throwaway mpv:<br>`mpv.exe --no-config av://dshow:video=dummy --demuxer-lavf-o=list_devices=true --msg-level=all=no,ffmpeg/demuxer=v --vo=null --ao=null --frames=1`<br>parse stderr: `/^\[ffmpeg\/demuxer\]\s+dshow:\s+"(.+)"\s+\((video\|audio)\)$/` and take the following `Alternative name` line as the stable id<br>open: `{"command":["loadfile","av://dshow:video=@device_pnp_…:audio=@device_cm_…","replace",-1,{"profile":"low-latency","untimed":"yes","cache":"no","demuxer-lavf-o":"video_size=1280x720,framerate=30,rtbufsize=100000000"}]}` | **Verified working on this machine** (found a virtual camera and a mic). Use the `@device_…` alternative name, **not** the friendly name — friendly names contain `:` and non-ASCII and break `av://` parsing. Enumeration requires a throwaway process and `avformat_open_input` is *expected* to fail after printing the list — that error is normal, do not surface it. Windows privacy settings can hide cameras; handle an empty list with a link to `ms-settings:privacy-webcam`. |
| R26 | DVD folder / ISO playback | P2 | md | prop | M37 | `{"command":["loadfile","dvd://","replace",-1,{"dvd-device":"D:\\"}]}` (or an ISO path)<br>specific title `dvd://3`; longest is the default<br>**titles are exposed as EDITIONS**: `{"command":["get_property","edition-list"]}`, `{"command":["set_property","edition",<n>]}`<br>`{"command":["set_property","dvd-angle",2]}`; `--dvd-speed=<n>`; `--stretch-dvd-subs` | There is **no `disc-titles` property** in modern mpv — verified absent. `dvdnav://` is an old alias for `dvd://`. **Licence warning:** this build reports `gpl`; an **LGPL mpv build loses DVD and CDDA entirely** (§7.3). mpv cannot decrypt CSS itself — it needs libdvdcss, which we do not ship. |
| R27 | Blu-ray folder / ISO / playlist selection | P2 | md | prop | M37 | `{"command":["loadfile","bd://","replace",-1,{"bluray-device":"D:\\"}]}` (ISO works since libbluray 1.0.1)<br>title forms: `bd://longest`, `bd://first`, `bd://menu`, `bd://mpls/<number>`, `bd://<index>`; `bluray://` and `br://` are aliases<br>`{"command":["set_property","bluray-angle",2]}`; enumerate playlists from the log at `--msg-level=bd=v` or from `edition-list` | PotPlayer's menu offers "Open Blu-ray files (*.MPLS)" precisely because playlist-picking is the normal workflow — copy that, it **is** the feature, not a workaround. AACS/BD+ decryption is not included: **be explicit in the UI that this opens decrypted folder/ISO rips, not retail discs.** |
| R28 | DVD / Blu-ray menu navigation | P2 | md | cmd | M37 | **present in mpv master, ABSENT from our pinned build** (verified: no `--disc-menu`, no `discnav`, no `disc-menu-active`). Requires bumping the pin — §7.2.<br>`--disc-menu=yes` (def no), or open `dvd://menu` / `bd://menu`<br>`{"command":["discnav","<action>"]}` — `up down left right select menu title-menu popup prev mouse-move mouse-click`<br>mouse: `{"command":["discnav","mouse-click",<x>,<y>]}` with x,y normalised 0–1 from the **source video**, not the window<br>`{"command":["observe_property",<id>,"disc-menu-active","flag"]}` | mpv auto-enables a `{discnav}` input section while a menu is up, but we run `--input-default-bindings=no` and own input — **we must forward these ourselves and use `disc-menu-active` to decide when arrow keys mean "menu" instead of "seek"**. Remaining honest limit: BD-J (Java) menus need a JRE and a BD-J stack we will not ship; BD-J-only discs boot to a blank menu. |
| R29 | Digital TV / DVB tuner | skip | lg | — | — | not available — see §2.10 | mpv's `dvb://` is Linux-only; the Windows build has zero `--dvbin-*` options and no `tv://` protocol. Say this out loud in the README. |
| R30 | Screen / game capture input | skip | lg | ext | — | technically `av://gdigrab:desktop` or `ddagrab`, deliberately not shipped | Recorder territory. Game capture requires injecting into other processes and **will** get us flagged by antivirus. The reputational cost alone settles it. |
| R31 | Personal broadcasting / relays / chat | skip | lg | — | — | out of scope by definition | An entire second product; and Kakao TV, the thing it integrated with, shut down 2026-06-22. |
| R32 | *(moved)* Online subtitle search | — | — | — | **M21** | see §2.3 S35/S36 | Owner resolved in §1.5, demoted to P2. |
| R33 | FTP / WebDAV / SMB remote file browser | P2 | lg | app | M35 | **playback is already free**: `ftp:// ftps:// sftp:// dav:// davs:// webdav:// webdavs:// httpproxy://` are in `--list-protocols`, and `smb://PATH` is documented.<br>The *browser* is app-level: WebDAV PROPFIND over Node http/https, an FTP LIST client, saved-server credentials via Electron `safeStorage` — **never plaintext**.<br>**Minimum viable version:** skip the tree, make the Open URL dialog remember servers and accept a directory URL by listing it inline. | PotPlayer's changelog shows this grew over a decade including "Fixed an issue where unable to get file list from a specific FTP server" — remote browsing is a long tail of server quirks. It is also the only feature in this area that **holds a secret**, which raises the bar on the portable-mode promise. The inline-listing shortcut is the honest scope. |
| R34 | Stream info readout | P1 | sm | prop | M29 (section) | `demuxer-via-network`, `current-demuxer`, **`stream-open-filename`** (the post-ytdl resolved URL), `path` (what the user typed), `video-bitrate`, `audio-bitrate`, `sub-bitrate`, `hls-bitrate`, `demuxer-cache-state/raw-input-rate`, `cache-speed`, `file-format`, `media-title`, `metadata` | Render only when `demuxer-via-network` is true. **Display `path` and `stream-open-filename` side by side** — the difference between what the user typed and what mpv actually opened is the first thing you need in any yt-dlp bug report. Same rule `docs/01` sets for hwdec. |
| R35 | OS-level `rlplayer://` URL handler | P2 | sm | app | M34 | `app.setAsDefaultProtocolClient('rlplayer')` + HKCU registration + argv forwarding through the existing single-instance plumbing. Strip the scheme and feed the remainder through **the same allowlist as R02**. | A remote-input surface: a malicious page can invoke it. The allowlist is not optional here. Never accept `file://` or `av://` through the handler. **Disabled in portable mode** — it is a registry write. |

---
### 2.9 Preferences, keybindings, file associations, portability — 63 features (P0 34 · P1 21 · P2 5 · 3 moved)

| # | Feature | Pri | Eff | Feas | Module | mpv mapping / implementation | Trap to avoid |
|---|---|---|---|---|---|---|---|
| P01 | Preferences window shell | P0 | md | app | M38 | reuse `openSettingsWindow()`. Exactly **eight** top-level sections, max two levels deep: general / playback / video / audio / subtitles / keys / filetypes / advanced. Sections register themselves: `registerSettingsSection({id:'keys', order:60, labelKey, render})`. | **Rule: never more than 8 top-level sections, never a third level, and no separate "Simple/Advanced" mode** — instead a collapsed 고급 group inside each section. Avoiding both VLC's thousand-item tree and PotPlayer's tab wall is the design goal of this whole area. |
| P02 | Settings search (including 초성) | P0 | md | app | M38 | search over label + keywords + setting id + **the underlying mpv option name**.<br>`const CHO=['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']`<br>`cho = s => [...s].map(c => { const i = c.charCodeAt(0)-0xAC00; return i>=0 && i<11172 ? CHO[Math.floor(i/588)] : c }).join('')` | Searching by mpv option name lets an mpv user find "that option I know" instantly — **mpv.net does not do this**. It is nearly free once descriptors carry `mpvOption`. |
| P03 | Setting descriptor registry | P0 | md | app | **core/settings** | `registerSetting({id:'video.hwdec', section:'video', labelKey, keywords:['hwdec','가속','dxva','d3d11'], type:'enum', default:'auto-safe', mpvOption:'hwdec'})` called at module import time. See §3.3. | **The core anti-collision device of this whole project.** Today `AppConfig` is one flat interface that all nine implementers would have to edit. Descriptor registry + a `Record<string, unknown>` store makes that contention disappear. |
| P04 | Apply-on-change (no OK/Cancel) | P0 | sm | app | M38 | `onChange` → `setConfig({[id]: value})` → 300 ms debounce → save; mpv-affecting values go through the owning module's `applySetting`. Descriptors carry `requiresRestart: true` and the UI shows an inline "재시작 후 적용" badge. | PotPlayer has an Apply button and some settings silently need a restart without saying so. The badge is the fix. |
| P05 | Modified indicator + per-setting revert | P1 | sm | app | M38 | `isModified = !deepEqual(current[id], descriptor.default)`; revert = write the default; section headers show a change count | "What did I change?" is the most common settings question, and with no answer people hit Reset All. |
| P06 | Raw mpv option passthrough (`mpv.conf`) | P1 | sm | cmd | M38 | put `--include=<dataDir>\mpv.conf` **at args index 0**; keep `--no-config` so `%APPDATA%\mpv` is still ignored.<br>Verified: `--include` is **position-dependent** — `--include A --volume=77` → 77 wins; `--volume=77 --include A` → the conf wins. | Putting it first means the user **cannot** break `--wid`, `--input-ipc-server`, `--vo` or `--input-vo-keyboard`. This buys real trust from mpv power users at almost no cost. But `scripts=` in a conf is **not** blocked by `--load-scripts=no` — see P44. |
| P07 | Versioned config schema | P0 | sm | app | **core/settings** | `{ "schema": 1, "data": { … } }`; per-store constants `{config, keybinds, mouse, resume, playlist}`; files `config.json`, `keybinds.json`, `mouse.json`, `resume.json`, `playlists.json`, `mpv.conf` | Split stores so a corrupt `keybinds.json` does not take video and audio settings down with it. |
| P08 | Migration runner | P0 | sm | app | **core/settings** | `registerMigration('config', {from:1, to:2, up(o){…}})`<br>`while (o.schema < CURRENT) { const m = migs.find(m => m.from === o.schema); if (!m) throw new SchemaGapError(o.schema); o = m.up(o); o.schema = m.to }`<br>copy `file → file + '.bak.v' + oldSchema` **before** migrating | A migration gap (no migration `from N`) must **throw** into the backup-recovery UI, never be silently skipped. |
| P09 | Downgrade protection | P0 | sm | app | **core/settings** | `if (raw.schema > CURRENT) { store.readOnly = true; showBanner() }` — do not migrate, do not save. Only on explicit user action move it to `file + '.from-v<N>.bak'` and start fresh. | Anyone running a portable copy from a USB stick on two PCs will hit this. Silently overwriting loses the whole config. |
| P10 | Preserve unknown keys | P1 | sm | app | **core/settings** | change `merge()` from `if (!(k in base)) continue` (which **discards**) to collecting into `__extra`, and re-spread on save | **A real bug in the current code:** running new → old → new permanently destroys every setting the old build did not know about. Ships together with P09. |
| P11 | Atomic write + `fsync` | P0 | triv | app | **core/settings** | `const fd = fs.openSync(tmp,'w'); fs.writeSync(fd, json); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, target)` | `config.ts` and `resume.ts` already do write-then-rename but **have no `fsync`**. `rename` is atomic, but there is no guarantee the tmp contents reached the disk — especially on a USB stick in portable mode. |
| P12 | Corrupt-file recovery | P1 | sm | app | **core/settings** | `catch { fs.renameSync(file, file + '.corrupt.' + Date.now()); toast({kind:'error', actionLabel:'폴더 열기', action:'openDataDir'}) }` | Both stores currently `catch` and silently fall back to defaults. To the user that reads as "settings reset themselves", which loses trust. |
| P13 | Command registry (actions as data) | P0 | md | app | **core/input** | `registerCommand({id:'seek.fwd5', category:'seek', labelKey, scope:'player', run(ctx){…}, osdKey, menuPath, defaults:{default:['ArrowRight'], potplayer:['ArrowRight'], mpv:['ArrowRight']}})` — promotes today's string protocol (`'seek:5'`) to ids | One table behind keys, mouse, gestures, menus and the command palette. `menuPath` makes keymap and menu a single source of truth — mpv.net does this via `#menu:` comments in input.conf and it is worth stealing. |
| P14 | Three keybinding presets | P0 | md | app | **core/input** | presets are **derived**, not hand-written: fold every registered command's `defaults[preset]`. Active bindings = `{...preset, ...overrides}`. | **Verified PotPlayer keys, re-transcribed from PotPlayer's own shipped `English.ini` `[MenuString]` table** (889 lines, on this machine) rather than from a secondary shortcut list: F5 Preferences, F6 Playlist, **F7 Control Panel…** , F2 open folder, F3 open file, **Enter fullscreen**, C/X speed ±, **Z speed reset**, `[`/`]` A/B points, `\` AB toggle, **D previous frame / F next frame**, G go-to-time, P add bookmark, H bookmarks, L Add/Select Subtitles, A audio track, `/` sub-sync reset, `<`/`>` sub ±0.5 s, Shift+`<`/`>` audio ±0.05 s, Ctrl+E screenshot, Ctrl+C clipboard, Ctrl+G burst, **Ctrl+Z flip horizontal**, **Ctrl+V flip vertical**, **BackSpace to start**, PgUp/PgDn prev/next file, **Shift+E equalizer toggle**, **Ctrl+T always-on-top**.<br>**Two corrections to this list itself:** an earlier revision said *F7 = Equalizer* (it is **Control Panel…**; the equalizer is a tab inside it and its own toggle is **Shift+E**) and *Q = speed/quality reset* (Q is **Disable/Last used Color Controls** — V03 states this correctly, and P14 contradicted V03 two hundred lines later; **speed reset is `Z`**).<br>**And the current `POTPLAYER_PRESET` has at least TEN wrong entries, not three** — see §7.8 for the enumerated list. Budget the transcription separately from the mechanism: PotPlayer's real map is ~500 bindings deep, and `md` covers the derived-preset machinery only. |
| P15 | Conflict detection | P0 | sm | app | **core/input** | build `Map<scope+'\|'+accel, CommandId[]>` and report entries with length > 1; the capture widget shows "이미 '{cmd}'에 지정되어 있습니다" with [바꾸기] [취소] | Must be **scope-aware**: the playlist panel's Delete and the player's Delete are not a conflict. PotPlayer added "run main-window hotkeys inside the playlist/bookmark editors", so scopes genuinely exist there too. |
| P16 | IME-safe accelerators (physical keys) | P0 | sm | app | **shared/input/accel** | `accelFromEvent(e)` must build from **`e.code`**, not `e.key`:<br>`[...(e.ctrlKey?['Ctrl']:[]), …, e.code].join('+')` → `'Ctrl+KeyS'`, `'Digit1'`, `'BracketLeft'`, `'ArrowRight'`, `'Space'`.<br>Display labels come separately from `navigator.keyboard.getLayoutMap()` or a static code→symbol table. | **The single most important finding in this area.** With the Korean IME active, Chromium delivers `key:'Process'`, `keyCode:229`, and even non-composing keys arrive as Hangul — so `S` becomes `'ㄴ'`. The current `eventToAccel()` uses `e.key`, so **every letter shortcut dies when 한/영 is on Korean**. For a Korean-market app this is a P0 bug. mpv has `--input-ime` for the same reason. |
| P17 | Key capture widget | P0 | sm | app | M39 | `keydown` with `{capture:true}`: Escape cancels, bare Tab passes through, everything else `preventDefault()` + `stopPropagation()` → `accelFromEvent(e)`. Disable the global key handler while capturing. | Escape and Tab are reserved for dialog operation. Alt+F4 cannot be captured at browser level — list it under "keys you cannot assign". |
| P18 | Multiple accelerators per command | P1 | sm | app | **core/input** | flip storage from `Record<Accel, CommandId>` to **`Record<CommandId, Accel[]>`**; build the reverse index at runtime; keybinds schema migration v1→v2 | With today's direction you cannot show "this command's keys" in the editor, and giving Fullscreen both F and Enter needs two rows. **Decide before more code depends on the shape** — it is cheapest now. |
| P19 | Searchable, sortable hotkey list | P1 | sm | app | M39 | flat table over the command registry: Command \| Category \| Key \| Scope; reuse P02's 초성 matcher | PotPlayer added hotkey sorting in `[210428]` — it is a real request. |
| P20 | Hotkey cheat sheet | P1 | sm | app | M39 | render the registry grouped by category, with `@media print` styles; `registerCommand({id:'app.cheatsheet', defaults:{default:['F1']}})` | PotPlayer buries this inside the About dialog. F1 is better. |
| P21 | Hand the keymap to mpv (optional path) | P2 | sm | cmd | — | `--input-builtin-bindings=no --input-conf=memory://<lines>` where lines are `"SPACE cycle pause\nRIGHT seek 5\nMBTN_LEFT_DBL cycle fullscreen"`<br>runtime: `load-input-conf <file>` or `keybind <name> <cmd>` | Verified working (`[input] Input config file memory://q quit parsed: 1 binds`). **Not needed today** — the overlay owns input via `--input-vo-keyboard=no --input-default-bindings=no --input-cursor=no`. Only relevant if we ever enable mpv scripts. The 189 valid key names come from `mpv --input-keylist`. |
| P22 | Mouse button binding | P0 | sm | app | **core/input** | use mpv's names verbatim (verified via `--input-keylist`): `MBTN_LEFT MBTN_MID MBTN_RIGHT MBTN_BACK MBTN_FORWARD MBTN_LEFT_DBL MBTN_MID_DBL MBTN_RIGHT_DBL MBTN9…MBTN19`<br>`const MB=['MBTN_LEFT','MBTN_MID','MBTN_RIGHT','MBTN_BACK','MBTN_FORWARD']; name = MB[e.button] ?? ('MBTN'+(e.button+4))`; modifiers as for keys | Using mpv's names keeps the config human-readable and means the strings still work if we ever delegate input to mpv (P21). Defaults: left = play/pause, left-double = fullscreen, mid = mute, right = context menu, back/forward = prev/next file. |
| P23 | Mouse wheel binding | P0 | sm | app | **core/input** | `WHEEL_UP WHEEL_DOWN WHEEL_LEFT WHEEL_RIGHT` plus modifier forms.<br>Defaults: wheel = volume ±5, **Shift+wheel = seek ±10 s (always available)**, Ctrl+wheel = zoom at cursor.<br>`e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN'`; pass `Math.abs(e.deltaY)/100` as a scale for high-resolution wheels | The "wheel = volume" and "wheel = seek" camps are both loud. Fixing Shift+wheel to seek means people who never open settings get both. |
| P24 | Double-click time / drag deadzone | P1 | triv | app | **core/input** | follow mpv's verified defaults as our constants: `--input-doubleclick-time` `Integer (0 to 1000) (default: 300)`, `--input-dragging-deadzone` `Integer (default: 3)` → `config.mouse.doubleClickMs = 300`, `dragDeadzonePx = 3` | Without a deadzone, moving the window toggles play/pause; without the double-click window, fullscreen flashes a pause first. Both decide how the app *feels*, so expose them. |
| P25 | *(moved)* Cursor auto-hide | — | — | — | **M31** | see §2.7 U11 | Owner resolved in §1.5. |
| P26 | ProgID + Capabilities registration | P0 | md | ext | M34 | **HKCU only** (ZIP distribution, never HKLM). Keys written:<br>`HKCU\Software\Classes\RLPlayer.file` (+`DefaultIcon`, `shell\open\command` = `"<exe>" -- "%1"`, `EditFlags=dword:00010000`)<br>`HKCU\Software\Classes\Applications\RLPlayer.exe` (+`SupportedTypes`)<br>`HKCU\Software\Clients\Media\RLPlayer\Capabilities` (+`FileAssociations`)<br>`HKCU\Software\RegisteredApplications` value `RLPlayer`<br>`HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\RLPlayer.exe`<br>apply: write UTF-16LE+BOM `.reg`, then `spawn('reg.exe',['import',path],{windowsHide:true})` | mpv's `osdep/w32_register.c` is the verified reference: it uses **one** ProgID and registers no extensions directly, because "mpv does not own any… Windows will prompt the user to choose the default application". **PotPlayer does the opposite** — measured on this machine, it creates `PotPlayer.MKV`/`PotPlayer.MP4` and overwrites `HKCR\.mkv`'s default, backing up the original in `DaumLiveBackup.bak`. Do not copy that. |
| P27 | Show the exact `.reg` before applying | P1 | sm | app | M34 | render the generated `.reg` text in a `<pre>` with a "파일로 저장" button; provide the un-register `.reg` on the same screen | The cheapest possible way to prove the "we don't hijack your associations" positioning **in the UI rather than in a README**. No other player does this. |
| P28 | Open the Windows Default Apps page | P0 | triv | app | M34 | `shell.openExternal('ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent('RLPlayer'))` with `.catch(() => shell.openExternal('ms-settings:defaultapps'))` | `registeredAppUser` reads `HKCU\Software\RegisteredApplications`; `registeredAppMachine` is the HKLM one. **The deep link only works on Win11 21H2+2023-04 CU and later** — Windows 10 and older 11 builds need the parameterless fallback. There is **no supported API** for an app to make itself the default (`SetAppAsDefaultAll` is deprecated since Windows 8 and does not work on 10/11). |
| P29 | `SHChangeNotify` after registration | P0 | sm | ext | M34 | `SHChangeNotify(SHCNE_ASSOCCHANGED /*0x08000000*/, SHCNF_DWORD\|SHCNF_FLUSH /*0x1003*/, NULL, NULL); Sleep(1000);`<br>Node without a native addon:<br>`powershell -NoProfile -NonInteractive -Command "Add-Type -Namespace W -Name Sh -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'; [W.Sh]::SHChangeNotify(0x08000000, 0x1003, [IntPtr]::Zero, [IntPtr]::Zero)"` | Without this, icons and the Windows Settings list do not refresh and the user thinks registration failed. Microsoft's docs specify the `Sleep(1000)`; PowerShell's ~400 ms startup partly covers it, but delay the success toast by a second to be safe. |
| P30 | Extension picker | P0 | sm | app | M34 | seed from mpv 0.41's verified defaults —<br>video: `3g2,3gp,avi,flv,ivf,m2ts,m4v,mj2,mkv,mov,mp4,mpeg,mpg,mxf,ogv,rmvb,ts,webm,wmv,y4m`<br>audio: `aac,ac3,aiff,ape,au,dts,eac3,flac,m4a,mka,mp1,mp2,mp3,mpc,oga,ogg,ogm,opus,tak,thd,tta,wav,wma,wv`<br>playlist: `cue,edl,m3u,m3u8,pls,strm`<br>image: `avif,bmp,gif,heic,heif,j2k,jp2,jpeg,jpg,jxl,png,qoi,svg,tga,tif,tiff,webp`<br>plus PotPlayer parity: `asf, divx, f4v, m2v, mpe, mts, ogx, rm, vob, wtv, mp2v, mpv, 3gpp, amv, dav` | **Ship the image category unchecked by default** — we have no intention of replacing a photo viewer, and taking `.jpg` earns instant hostility. Playlist (`.m3u8`) also unchecked by default. |
| P31 | Unregister | P0 | sm | ext | M34 | delete (mirroring mpv's `w32_unregister()`): `HKCU\Software\Classes\RLPlayer.file`, `…\RLPlayer.url`, `…\Applications\RLPlayer.exe`, `HKCU\Software\Clients\Media\RLPlayer`, the `RLPlayer` **value only** in `RegisteredApplications`, `App Paths\RLPlayer.exe`, the `SystemFileAssociations\{video,audio}\shell\RLPlayer.*` verbs, `Directory\shell\RLPlayer.Play`, and the Start Menu `.lnk`. Then `SHChangeNotify` again. | **We never wrote `UserChoice`, so we never delete it.** If the user made RLPlayer the default, Windows manages that state and will fall back to another app on its own. |
| P32 | Show which extensions we currently own | P1 | sm | ext | M34 | **read-only**: `reg query "HKCU\…\Explorer\FileExts\.mkv\UserChoice" /v ProgId` | **Never write this key.** The `Hash` is a Microsoft-private hash of SID + extension + ProgID + timestamp, and forging it *is* the association-hijacking behaviour that antivirus flags. Measured on this machine: `.mp4` → `Progid=PotPlayer.MP4`, `Hash=HHVo3xkXJL4=`. |
| P33 | No-hijack guarantee, enforced by CI | P0 | triv | app | M34 | GitHub Actions step:<br>`! grep -rniE "UserChoice\|SetAppAsDefaultAll\|LaunchAdvancedAssociationUI" src/ scripts/ \|\| (echo 'association hijack API detected'; exit 1)` | `docs/01`'s promise turned into a test. "We don't do that" is only meaningful when it is verifiable. |
| P34 | Explorer context menu — exactly two verbs | P1 | sm | ext | M34 | by PerceivedType, **not** per extension:<br>`HKCU\Software\Classes\SystemFileAssociations\video\shell\RLPlayer.Play` → `"<exe>" -- "%1"`<br>`…\RLPlayer.Enqueue` with **`MultiSelectModel="Player"`** → `"<exe>" --enqueue -- "%1"`<br>same for `audio`; folders via `HKCU\Software\Classes\Directory\shell\RLPlayer.Play` | `PerceivedType` verified present (`HKCR\.mkv` → `video`). **Honest limit to state in the UI:** on Windows 11 these appear under "추가 옵션 표시" (Shift+F10), not the top level — the top level needs MSIX/sparse packaging plus an `IExplorerCommand` COM handler, which is incompatible with ZIP-first distribution. `MultiSelectModel="Player"` is mandatory for Enqueue or 20 selected files launch 20 times. |
| P35 | Start Menu shortcut | P1 | sm | ext | M34 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\RLPlayer.lnk` via `powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('<lnk>'); $s.TargetPath='<exe>'; $s.WorkingDirectory='<dir>'; $s.Save()"` | mpv's source comment explains why this matters: "this is required for SystemMediaTransportControls to detect the app correctly. Which is quite stupid, but it's the only way to make it work." It is the precondition for U24's media-key integration. **Not created in portable mode.** |
| P36 | Portable mode detection | P0 | sm | app | **core/paths** | `RLPLAYER_HOME` env → `portable.txt` beside the exe → `portable_config/` beside the exe → `%APPDATA%\RLPlayer` | Mirrors mpv's own Windows convention (`$MPV_HOME` → `portable_config` → `%APPDATA%\mpv`), so mpv users' existing habit works. **This must be the first import in `src/main/index.ts` and run before `app.whenReady()`.** |
| P37 | Redirect every Electron write path | P0 | sm | app | **core/paths** | before `whenReady()`, immediately after resolving the dir:<br>`app.setPath('userData', dir)`<br>`app.setPath('sessionData', path.join(dir,'session'))`<br>`app.setPath('logs', path.join(dir,'logs'))`<br>`app.setPath('crashDumps', path.join(dir,'crash'))`<br>`app.commandLine.appendSwitch('disk-cache-dir', path.join(dir,'cache'))` | **The most common failure in Electron portable apps.** Setting only `userData` leaves `sessionData`, `crashDumps` and the GPU cache in `%APPDATA%` and `%LOCALAPPDATA%`. These five lines *are* the "leaves no trace" promise. |
| P38 | Ban registry writes in portable mode | P0 | triv | app | **core/paths** + M34 | `if (isPortable()) associations.disable()`; the filetypes settings section renders but is fully disabled with an explanatory line | **Disable and explain — do not hide.** A hidden section reads as a missing feature; a disabled one with a reason reads as a deliberate design. |
| P39 | Writability probe with fallback | P1 | sm | app | **core/paths** | `try { write+unlink '<dir>/.wtest' } catch { dir = %APPDATA%; portableFallback = true }`; one toast on first run plus a permanent line in Advanced | Happens for real: write-protected USB sticks, installs under Program Files, corporate folder policies. Silently discarding settings is the alternative. |
| P40 | Open the config folder | P0 | triv | app | M38 | `shell.openPath(dataDir())`; show the path as selectable text | Cheapest trust signal in the product: "your settings are exactly here" versus PotPlayer hiding them in the registry. |
| P41 | Portable-cleanliness CI test | P1 | sm | app | M34 | windows-latest job: run the packaged exe, sleep 5, then fail if `%APPDATA%\rlplayer` or `%LOCALAPPDATA%\rlplayer` exists, or if `reg query HKCU\Software\RegisteredApplications /v RLPlayer` succeeds | The portable twin of the network-monitor test. `docs/01`'s "verifiable guarantee" principle applied to this area. |
| P42 | Export settings | P1 | sm | app | M40 | single JSON, no zip, no dependencies:<br>`{ "app":"RLPlayer", "kind":"settings-bundle", "appVersion":"…", "exportedAt":"…", "schemas":{"config":1,"keybinds":1,"mouse":1}, "config":{…}, "keybinds":{…}, "mouse":{…}, "mpvConf":"…" }` | Human-readable and pasteable into a forum thread. **Never include `resume.json` by default** — absolute paths are personal information. |
| P43 | Import settings (validate → preview → backup) | P1 | sm | app | M40 | 1. reject unless `app==='RLPlayer' && kind==='settings-bundle'`<br>2. run each store through the migration runner<br>3. render a diff: "설정 12개, 단축키 4개가 바뀝니다"<br>4. `fs.copyFileSync(f, f+'.bak.'+Date.now())` then apply | Import without a preview is an irreversible destructive action. One diff screen removes most of the support load. |
| P44 | Import sanitisation (mpv.conf) | P0 | sm | app | M40 | strip these keys line-wise from any imported `mpv.conf`:<br>`/^\s*(script\|scripts\|script-opts\|load-scripts\|input-conf\|input-ipc-server\|wid\|config-dir\|include\|o\|terminal\|register\|unregister\|ytdl\|ytdl-path)\s*=/`<br>show removed lines in the import preview as "보안상 제외된 항목" | **`--load-scripts=no` only blocks the scripts *folder*; `scripts=evil.lua` inside a conf still loads.** Without this filter, "import my settings" becomes arbitrary code execution — the same class as IINA's CVE-2026-47114 (external input passed straight to mpv options). An allowlist would be safer but there are 1271 mpv options; a denylist plus unrestricted *manual* editing is the honest compromise. |
| P45 | UI language (Korean / English / system) | P0 | sm | app | **core/i18n** | `const sys = app.getPreferredSystemLanguages()[0] ?? 'en'`; `lang = cfg.language === 'auto' ? (sys.toLowerCase().startsWith('ko') ? 'ko' : 'en') : cfg.language`; shared `t(key, params)`; on change, main rebuilds Menu/Tray and renderers re-render | `src/main/index.ts` currently hardcodes strings like '재생 엔진을 시작할 수 없습니다'. **Error dialogs must go through `t()` too.** |
| P46 | Message catalog registry | P0 | sm | app | **core/i18n** | `registerMessages('ko', {'settings.keys.conflict': "이미 '{cmd}'에 지정되어 있습니다"})` at module import; core strings in `catalogs/{ko,en}.json`, feature strings in each feature's `messages.ts`. Key namespace enforced by module id. | The **second** major anti-collision device after P03. Without it, nine people edit one `ko.json`. |
| P47 | Korean particle (조사) helper | P1 | sm | app | **core/i18n** | ```josa(word, '을/를')``` — final-jamo test `(code − 0xAC00) % 28` for Hangul, plus a table for Latin/digit endings; `'으로/로'` has the ㄹ-batchim exception (jong === 8 → '로'). `t()` post-processes tokens like `{file:josa}을/를`. | "{file}을 재생할 수 없습니다" is wrong Korean half the time depending on the filename's last character. For a Korean-market app, skipping this reads as amateurish. |
| P48 | Missing-translation fallback | P2 | triv | app | **core/i18n** | `t = (k,p) => interp(CAT[lang][k] ?? CAT.en[k] ?? k, p)`; dev builds `console.warn` and dump missing keys at exit | Never render `undefined` or an empty string. |
| P49 | Per-file sticky settings | P0 | md | app | **core/per-file** | canonical option set adopted from mpv's `--watch-later-options` default **with `vf` and `af` struck out** (see the trap column):<br>`start,speed,pitch,edition,volume,mute,audio-delay,gamma,brightness,contrast,saturation,hue,deinterlace,panscan,aid,vid,sid,sub-delay,sub-speed,sub-pos,sub-visibility,sub-scale,sub-use-margins,sub-ass-force-margins,sub-ass-use-video-data,sub-ass-override,secondary-sid,secondary-sub-delay,secondary-sub-pos,secondary-sub-scale,secondary-sub-ass-override,secondary-sub-visibility,ab-loop-a,ab-loop-b,video-aspect-override,video-aspect-method,video-unscaled,video-pan-x,video-pan-y,video-rotate,video-crop,video-zoom,video-scale-x,video-scale-y,video-align-x,video-align-y`<br>store in `resume.json` as `ResumeEntry.opts`; **restore through the owning module's slice `apply()`, never with a raw `set_property` from here** — `core/per-file` owns no mpv properties (§3.7) | Two rules, one of them a defect fix.<br>**(1) `vf` and `af` are struck from the canonical list.** mpv's `--watch-later-options` default contains both (confirmed), and adopting the list verbatim meant this service would write a raw `vf`/`af` string on every `playback-restart` — exactly the raw command §0.2 rule 5 forbids every module from issuing, silently overwriting whatever `core/vf-chain` believed the chain to be. **`core/vf-chain` and `core/af-chain` register their own slices** and serialise their labelled slots themselves; the per-file store never touches the chain properties.<br>**(2) `core/per-file` writes nothing directly.** Every remembered key is applied by the module that owns that property, through its slice's `apply()`. That is what makes §3.7's ownership check hold at restore time as well as at runtime — otherwise the one service that touches everything would be the one service exempt from the rule.<br>We borrow mpv's option *names* but not its store: we run `--no-config` and identify files by a path+size hash whose rules differ from mpv's. |
| P50 | Choose what to remember per file | P1 | sm | app | **core/per-file** | `config.perFile.remember: string[]`.<br>**Default ON:** `start, aid, sid, sub-delay, audio-delay`. **Default OFF:** `speed, volume, mute, brightness, contrast, saturation, hue, video-zoom, video-rotate`. UI shows Korean labels with the mpv option name in the tooltip. | "The playback speed is stuck at 1.5× on its own" is the most common resume complaint, and **mpv's default saves `speed`**. Default OFF is correct. |
| P51 | Save only user-changed values | P1 | sm | app | **core/per-file** | on `file-loaded` snapshot `baseline` for the remembered keys; on exit/switch persist only keys where `!Object.is(current[k], baseline[k])`; if nothing differs keep only `position` | mpv's `watch-later` does not do this, so a file you once opened is frozen with that day's global defaults forever — change the global subtitle size later and it will not reach files you have seen. **This is one of our four deliberate improvements (§1.4).** |
| P52 | Preferred track languages (global) | P0 | triv | prop | M11/M17 | `--alang=kor,ko,jpn,ja,eng,en` and `--slang=kor,ko,eng,en`; runtime `{"command":["set_property","alang",[…]]}`. Settings UI is a drag-sortable chip list. | Without it, dual-audio releases need `A` pressed every episode. Putting `kor` first *is* the practical substance of localisation. |
| P53 | Resume on/off, video and audio separately | P1 | sm | app | **core/per-file** | `config.resume: {video: boolean, audio: boolean}`; gate `recordPosition()` on `isAudioOnly(track-list)`. Migrates the existing `resumePlayback: boolean` (config schema v1→v2). | Music should start from the beginning, films should resume. PotPlayer splits these into two separate options for a reason. |
| P54 | Forget this file / clear all history | P0 | triv | app | **core/per-file** | `forget(file)` and `clearAll()` already exist — expose them: playlist context menu "이 파일 기록 삭제", settings → 개인정보 "재생 기록 모두 삭제" with the stored count | Show the LRU state as a number ("저장된 파일 143/500"). Demonstrating that the store is bounded is itself a trust signal. |
| P55 | Reset: per setting / per section / everything | P0 | sm | app | M38 | `resetSetting(id)`, `resetSection(sectionId)`, `resetAll({keep: ('keybinds'\|'history'\|'filetypes')[]})`; always `fs.copyFileSync(file, file+'.bak.'+Date.now())` first | **Reset All must not touch the association registry** — that state lives outside the config files and reverting it is a separate, explicit "등록 해제" action. Say so in the confirm dialog. |
| P56 | Multiple instances toggle | P0 | sm | app | M33 | see U35 | Both camps are loud; PotPlayer ships it as an option too. |
| P57 | Minimize / focus behaviour | P2 | sm | app | M33 | see U23 | `pauseOnMinimize` alone is arguably worth P1. |
| P58 | Which OSD messages to show | P1 | sm | app | M31 | see U04 | The per-item toggle is what makes `docs/01`'s "every keybind fires an OSD" rule survive contact with users who find it noisy. |
| P59 | *(moved)* Screenshot dir / template | — | — | — | **M22** | see §2.4 C05 | Owner resolved in §1.5. |
| P60 | No updater — and say so in Settings | P0 | triv | app | M38 | one non-interactive line in Settings → 일반 plus a button calling `shell.openExternal(RELEASES_URL)`. **No auto-check code, no timer, no launch check.** | The product positioning is not "an update check you can turn off", it is "there is none". The **absence of a toggle** is the message. |
| P61 | Import PotPlayer settings | P2 | md | ext | M40 | **What is certain and shippable:** walk `HKCU\…\Explorer\FileExts` and collect extensions whose ProgId matches `PotPlayer.*`, then pre-check exactly those in P30's picker (verified on this machine: `.mp4 → PotPlayer.MP4`).<br>**What is not:** hotkey import. **Probe both roots, do not hardcode either** — the path depends on which build is installed. On this machine the key is **`HKCU\Software\DAUM\PotPlayer`**, with subkeys `Settings`, `Positions`, `BMItem_0`, `ExtensionSection`, `_UrlCookie`, `_UrlHeader`, `_UrlReferer`, `_UrlUserAgent`; other builds use `…\DAUM\PotPlayerMini64`, and a `PotPlayerMini64.ini` beside the exe if the user enabled that option. Value names and encoding remain **unverified**. Worth knowing before §2.10 D's "`.pbf` import is impossible" is treated as final: **`BMItem_0` is where PotPlayer's bookmarks actually live**, and it is a registry key, not the closed `.pbf` file. | **Do not promise hotkey migration.** Ship the extension-detection half, which is certain, useful, and improves the very first five minutes of switching. |
| P62 | *(moved)* Global hotkeys | — | — | — | **M33** | see §2.7 U25 | Owner resolved in §1.5. |
| P63 | CSS theme (skin replacement) | P2 | md | app | M31 | inject `<dataDir>/themes/<name>.css`, but **restrict the accepted surface** to `:root { --rl-*: … }` custom-property redefinitions; reject arbitrary selectors, `content` and `url()` at parse time. Built-ins: dark (default), light, follow-Windows. | PotPlayer's `.dsf` is an undocumented proprietary binary format — compatibility is impossible. Narrowing the promise to "colours, radii, font size" and saying so is better than implying skin parity. |

---

### 2.10 The declined and infeasible register (58 rows = 74 lost PotPlayer features + 7 of our own constraints)

**Read the count before the table.** These 58 rows are what §1.1's denominator is built
from, so how they are counted matters. Eleven rows bundle siblings under one shared reason
(marked with a `×n` below where they do), which is **23** more lost features than there are
rows; **seven** rows record an engineering constraint of *ours* rather than a PotPlayer
feature we lack, and are excluded from the denominator (they are still listed, because an
implementer needs them). 58 + 23 − 7 = **74**.

Not gaps — decisions, each with a reason an implementer can act on. Grouped by why.

**A. The engine physically cannot (FFmpeg/mpv has no such thing)**

| Item | Reason |
|---|---|
| H.264 MVC (Blu-ray 3D) decoding | FFmpeg has no MVC decoder; PotPlayer shells out to a proprietary Intel Media SDK DLL the user downloads separately. |
| WarpSharp | The aWarpSharp edge-warping algorithm is not implemented anywhere in our stack. CAS and unsharp cover the intent with different artifacts — **do not label either one WarpSharp**. |
| PotPlayer "Equi-Angular Cubemap 2x3" 360 layout | Verified: `v360 input=c2x3` is rejected and the graph fails to build. Only `c1x6`, `c3x2`, `c6x1` and `eac` exist. |
| Reverb (true Freeverb / convolution) | No reverb filter in FFmpeg; `afir` fails with a single input because mpv's af lavfi bridge cannot supply an IR. Stacked `aecho` is an approximation — label it "Room / Hall". |
| DTS re-encode passthrough | mpv ships exactly one runtime encoder filter, `lavcac3enc`. There is no `lavcdtsenc`. |
| Live EQ slider updates on `superequalizer` | Measured: no `process_command`, so every change reinitialises the chain. This is why the EQ maps to `anequalizer`. |
| A limiter protecting against mpv's own volume slider *(our constraint — excluded from the §1.1 denominator)* | Measured at signal level: `volume` and `volume-gain` are applied **after** the af chain. The obvious implementation silently does nothing — see A06. |
| HRTF binaural virtualisation (sofalizer / headphone) | `sofalizer` needs a `.sofa` database (verified: fails without one); `headphone` needs extra input streams the bridge cannot supply. |
| Subtitle fade / scrolling subtitles **(×2)** | No `sub-fade` anything exists in the complete option list. |
| "Maximum showing period" subtitle clamp | mpv has `sub-fix-timing*` and `sub-stretch-durations` but no upper bound. Only reachable by rewriting timestamps in our own converter. |
| Exact previous/next keyframe jump | No keyframe index property exists. `relative+keyframes` snaps to *a* keyframe with no adjacency guarantee. Ship it as "snap to keyframe" or not at all. |
| Reliable multi-frame backward step on VFR | mpv's own manual: "if the video is VFR, framestepping using seeks will probably not work correctly except for the -1 case." |
| TTML demuxing | FFmpeg has a TTML muxer but no demuxer. Converter only. |
| XML playlist formats through mpv | mpv's manual states plainly "XML playlist formats are not supported". ASX/XSPF must be parsed by us. |
| Enumerating all subtitle events | `sub-text`/`sub-start`/`sub-end` are strictly the current event. No property lists them. |
| Mid-stream adaptive bitrate (true ABR) | `--hls-bitrate` selects at open time only; changing quality requires a reload. Do not build UI implying smooth adaptation. |
| DVB / ATSC / analog TV **(×3)** | `dvb://` is Linux-only; the Windows build has no `--dvbin-*` and no `tv://`. |

**B. The `--wid` topology forbids it**

| Item | Reason |
|---|---|
| mpv's entire window-option surface *(our constraint — excluded)* | See §7.5 — the exhaustive list of inert options. This is the single most expensive class of bug in this project. |
| Shutter-glasses / page-flipping 3D, NVIDIA 3D Vision, Win8 stereo **(×3)** | All need quad-buffered stereo and an exclusive-fullscreen swapchain; mpv is a `--wid` child and never owns the swapchain. Also: 3D Vision was discontinued in 2019. |
| Recording exactly what gpu-next put on screen *(our constraint — excluded)* | mpv cannot tee its `vo_gpu_next` output (no D3D11 render-API backend; mpv#5979 open since 2018), and encode mode replaces the VO and re-decodes from source. **Our clip export reproduces the source picture, not your zoom/shader settings — say so in the UI.** |
| True HDR passthrough *beneath* the overlay *(our constraint — excluded)* | Partial, not total: HDR passthrough to the display works; the HTML overlay composites as SDR on top. Plan the control-bar contrast for that. |
| `screenshot-raw` for a lossless clipboard/preview path *(our constraint — excluded)* | Verified fatal: sending it over JSON IPC makes mpv exit with code 1 (`MPV_FORMAT_BYTE_ARRAY` has no JSON encoding). Only reachable if we ever move to in-process libmpv, which the settled architecture does not. |
| `stream-record` for local files | Verified: 0-byte file with the default cache, no file at all with a large one. It only writes data newly appended to the cache. |
| Live video inside the seek-bar hover preview | Would need a second realtime decode pipeline, undoing every optimisation that makes the thumbnailer cheap (`--vd-lavc-fast`, `skiploopfilter=all`, `hwdec=no`, 128 KiB demuxer). A still frame at ~30 ms delivers ~95% of the value. |
| Windows-absolute paths inside lavfi options *(our constraint — excluded)* | Verified three ways (`C\:/…`, `C\\:/…`, quoted) — all fail graph parsing. Every offline job must stage inputs into a temp dir and spawn with `cwd` set. |

**C. Out of product scope (we could, we won't)**

| Item | Reason |
|---|---|
| Screen recording, game capture, capture-device recording, PotScreenSaver **(×4)** | §1.3. |
| Personal broadcasting, relays, chat, monetisation **(×4)** | §1.3. |
| Subtitle editing, live subtitle input, subtitle upload **(×3)** | "Not an editor." The read-only browser gives the navigation value. |
| Whisper speech-to-text | A different product surface: model management, GPU detection, multi-GB downloads. PotPlayer's own changelog shows the maintenance tail. |
| Subtitle translation via an online engine | Streams what you are watching to a third party, line by line. P2 that may never ship, and only ever with a user-supplied key. |
| Media library, DLNA/Chromecast, web remote, cloud sync, accounts **(×5)** | §1.3. |
| Moving files on disk from the playlist | A file-manager operation with irreversible failure modes inside an app users have not granted file-management trust to. Rename and Recycle-Bin delete are the two worth having. |
| **Auto-shutdown / sleep / hibernate / exit at end of playback** **(×4)** (PotPlayer `101_0_15_4`, `101_0_15_8/9`) | **Recorded as a decline, which an earlier revision failed to do** — N47 stated the policy but never entered it here, and it lumped in the benign half. Powering down someone's machine on a timer is a support-ticket generator with an irreversible failure mode, and "the player turned my PC off" is not a bug we can debug after the fact. **The benign half now ships as N53 (sleep timer: pause/stop only).** We never quit the app, sleep, hibernate, or shut down the machine. |
| **Desktop Mode** (video as wallpaper, PotPlayer `Shift+Enter`) | Requires reparenting to Progman/WorkerW behind the desktop icons — a documented Windows shell hack, fragile across builds, and it fights the `--wid` child-HWND topology this whole app is built on. Declined; the three real fullscreen modes ship as **U46**. |
| Blu-ray MPLS *enumeration* as a playlist feature | Picking the main feature out of decoy playlists is a sub-project. Playing a chosen `bd://mpls/<n>` is supported at P2. |
| Scene browser inside a file navigator | N decodes of N non-playing files — the most expensive thing considered, for a browsing convenience. |
| AutoPlay handler for inserted discs | Registering it while disc support is P2 gives "I inserted a disc and nothing happened". |
| Making mpv's playlist the source of truth *(our constraint — excluded)* | Forfeits multi-select, cached per-item metadata, filter-without-mutating, undo, named lists, and non-destructive shuffle (`playlist-unshuffle` works exactly once). Recorded so the decision is known to have been examined. |
| mpv Lua/JS script auto-loading | Would turn settings import into a code-execution path. Needs its own opt-in design; out of scope here. |
| Window corner rounding control | Electron exposes only construction-time `roundedCorners`; mpv's `--window-corners` is inert. Needs a native `DwmSetWindowAttribute` call — not worth an addon. |
| Exclude window from screen capture | DRM-adjacent, no legitimate local-file demand, and it confuses screen-sharers. |

**D. Licensing / distribution refusals**

| Item | Reason |
|---|---|
| ASIO output | No ASIO AO in mpv (`--ao=help` lists only wasapi, openal, null, pcm); adding one needs a patched mpv fork plus the proprietary ASIO SDK, whose licence is incompatible with MIT/GPL redistribution. WASAPI exclusive covers the same need. |
| DSD native / DoP output **(×2)** | mpv decodes DSD to PCM; there is no bit-transparent path. The audience is a rounding error. |
| DirectShow renderer selection (VMR/EVR/madVR) and DirectShow DSP hosting **(×2)** | We are not a DirectShow graph host; mpv owns decode and presentation end to end. madVR is closed-source and unmaintained since 2020. The honest replacement is a two-entry VO menu, and the quality gap is in our favour. |
| PotPlayer pixel shaders (`.txt` HLSL) and the `.dsf` skin engine **(×2)** | Different formats expressing different things; no mechanical translation. Ship mpv-native GLSL and CSS tokens instead. |
| AviSynth real-time filtering | 32-bit-legacy scripting host requiring a separate install. VapourSynth **is** compiled in (`--vf=vapoursynth` exists) if anyone ever needs scripted filtering. |
| Bundling yt-dlp.exe | GPLv3+ published binaries; stales between releases; reads as "bundled stuff we didn't ask for". |
| Bundling ffmpeg.exe | 40–80 MB against a <80 MB budget, and unnecessary — mpv encode mode covers every use. |
| PotPlayer AngelScript extension system | Shipping a scripting runtime plus an extension auto-updater contradicts "no updater process, ever". |
| **Winamp DSP plugin hosting** (PotPlayer preferences node `2094`) | **Added so the register is complete** — its exact twin, DirectShow DSP hosting, was already declined here while this one was recorded nowhere at all. Same reasoning: we are not a plugin host, the plugins are 32-bit closed binaries with no licence we can reason about, and mpv's af chain plus our EQ/effects panel covers what people actually use them for. |
| MSIX / sparse package for Win11 top-level context menu | Incompatible with ZIP-first, registry-minimal distribution. |
| HKLM (all-users) association registration | Needs elevation and an installer. Two split registration locations is worse for the user than one. |
| One-click "make me the default" | No supported API on Win10/11; the only route is forging `UserChoice`, which is the hijacking behaviour we exist to escape. |
| Registry-stored settings (PotPlayer's default) | Incompatible with "leaves no trace". We store files only. |
| SMTC via WinRT | Electron 44 exposes no API and there is no maintained Node package; needs a native N-API addon with an x64+arm64 prebuild matrix. Media **keys** are covered cheaply via `globalShortcut`; SMTC is only the pretty card. Revisit if an addon lands for another reason (U19). |
| Cross-device sync of bookmarks/history | "No account, no cloud, no sync." Put the portable folder in a synced directory. |
| PotPlayer `.pbf` bookmark import | Undocumented closed format; a switcher imports once and never again. Exporting to ffmetadata is the better anti-lock-in move. |
| Full PotPlayer settings migration | Storage format unverified (opaque binary blobs under `HKCU\Software\DAUM\PotPlayerMini64`). Do not promise it. |

---
## 3. Module partition — the plugin API and who owns what

This is the section that makes a 40-way fan-out possible. **Read all of §3.1–§3.7 before
writing any feature code**, and treat **§3.7 (the mpv property owner map)** as the one you
must not skim: it is the difference between forty people working in parallel and forty
people finding out in integration that three of them were writing `aid`.

### 3.0 The design goal, stated as a constraint

> Adding a feature must mean **adding a directory**. It must never mean editing
> `types.ts`, `ipc.ts`, `preload/index.ts`, `menu.ts`, `keybinds.ts`, `config.ts`,
> `manager.ts`, `windows.ts` or `player.ts`.

Every one of those nine files is a merge-conflict magnet today. `windows.ts` (414 lines)
and `player.ts` (578 lines) were **missing from this list in an earlier revision**, which
is why M31/M32/M33 all had to edit `windows.ts` and why every one of `ipc.ts`'s 22 legacy
actions would have gained a second writer the moment Wave 1 landed. Both are closed below
(§3.3.7, §5.10). The API removes the need to touch any of the nine, using seven
mechanisms:

| Contention point | Mechanism |
|---|---|
| Module discovery | `import.meta.glob` over `features/*/index.ts` — the manifest file is written once in Wave 0 and never edited again |
| Settings schema | Descriptor **registry**; the settings UI is generated from it |
| Keybinds | Commands declare their own per-preset defaults; presets are *derived*, not authored |
| IPC + preload | One generic, namespace-validated bridge instead of a per-feature method on `window.api` |
| mpv spawn args | Modules *contribute* arg fragments with a priority; `manager.ts` concatenates; **duplicate option names are rejected across all contributors, not just core's** |
| **mpv properties** | **Declared ownership + a boot-time owner map + a rejecting `set()` (§3.7).** This is the mechanism that was missing: §3.6's "Must NOT touch" column was 40 rows of English enforcing nothing, while the vf/af chains — one property each — got real machinery |
| **Windows** | **`ctx.window` (§3.3.7).** Fullscreen, always-on-top, PiP, bounds, monitor placement and the sleep blocker are a *service*, not a shared file |
| Menus, panels, seek-bar layers, stats sections | Contribution registries keyed by id + order; **seek-bar layers can be interactive** (§3.4) |

### 3.1 Module discovery — the manifest that is written once

```ts
// src/main/features/index.ts   ── WAVE 0. Written once. Never edited again.
import type { FeatureModule } from '@shared/feature-api'
import { registry } from '../core/registry'

// Vite/electron-vite supports import.meta.glob in the main bundle.
// Adding src/main/features/<name>/index.ts is the ONLY step needed to ship a module.
const mods = import.meta.glob<{ default: FeatureModule }>('./*/index.ts', { eager: true })

export function collectFeatureModules(): FeatureModule[] {
  return Object.values(mods)
    .map((m) => m.default)
    .filter(Boolean)
}

export function loadAllFeatures(): Promise<void> {
  return registry.loadAll(collectFeatureModules())
}
```

If `import.meta.glob` ever proves unavailable in the main bundle, the fallback is
`scripts/gen-feature-manifest.mjs`, run in `prebuild`, emitting a gitignored
`src/main/features/manifest.generated.ts` with the same shape. **Either way no
implementer edits a shared list.** The renderer uses the identical pattern over
`src/renderer/src/features/*/index.ts`.

### 3.2 The module interface

```ts
// src/shared/feature-api.ts   ── WAVE 0
export type FeatureId  = string   // kebab-case, globally unique, e.g. 'video-color'
export type CommandId  = string   // `${FeatureId}.${verb}`  e.g. 'video-color.brightnessUp'
export type SettingId  = string   // `${FeatureId}.${key}`   e.g. 'video-color.brightness'
export type IpcChannel = string   // `${FeatureId}:${verb}`  e.g. 'video-color:reset'
export type PanelId    = string
export type Accel      = string   // physical-key accelerator, e.g. 'Ctrl+Shift+KeyS'

export interface FeatureModule {
  /** Must equal the directory name. Enforced at load time. */
  readonly id: FeatureId
  /** Other feature modules that must be set up first. Cycles throw at boot. */
  readonly dependsOn?: readonly FeatureId[]

  /**
   * Every mpv property this module is allowed to WRITE. Exact names, no globs
   * except a single trailing '*' (e.g. 'screenshot-*'), which must still not
   * overlap another module's claim.
   *
   * The registry builds a Map<property, FeatureId> at boot from these arrays and
   * THROWS, naming both modules and the property, on any duplicate or overlapping
   * claim. `ctx.mpv.set()` rejects a write to a property this module did not
   * declare. Reads are unrestricted — ownership is about writes only.
   *
   * This is the machine-checked form of §3.6's "Must NOT touch" column, and it is
   * mirrored into docs/parity/modules.json, which the fan-out is driven from.
   */
  readonly ownsProperties?: readonly string[]

  /**
   * Properties this module may write ONLY through `ctx.mpv.requestSet()`, i.e.
   * subject to the owner's arbitration. Declared so the dependency is visible in
   * review and in modules.json rather than hidden in a call site.
   */
  readonly requestsProperties?: readonly string[]

  /** Reserved vf/af labels (§5.5). Same duplicate detection as properties. */
  readonly ownsFilterLabels?: readonly string[]

  /** Called once, in dependency order, before the first window is shown. */
  setup(ctx: FeatureContext): void | Promise<void>
  /** Called on quit and on hot-reload in dev. Release timers, watchers, processes. */
  dispose?(): void | Promise<void>
}
```

### 3.3 `FeatureContext` — the whole surface a module is allowed to touch

```ts
export interface FeatureContext {
  readonly id: FeatureId
  readonly log: Logger                    // log.info/warn/error, auto-prefixed with the id
  readonly paths: PathService             // dataDir(), cacheDir(), isPortable(), tempJobDir()
  readonly mpv: MpvService
  readonly settings: SettingsService
  readonly commands: CommandService
  readonly ipc: IpcService
  readonly osd: OsdService
  readonly perFile: PerFileService
  readonly menu: MenuService
  readonly i18n: I18nService
  readonly lifecycle: LifecycleService
  /** Windows: fullscreen, ontop, PiP, bounds, monitors, sleep blocker. §3.3.7.
   *  Nothing in `src/main/windows.ts` is importable by a feature module. */
  readonly window: WindowService
  /** File/folder pickers. §3.3.8. Main-process modules must NOT import Electron
   *  `dialog` directly — then this context would not be "the whole surface". */
  readonly dialog: DialogService
  /** Only granted to modules that declare `usesVideoFilters` / `usesAudioFilters`. */
  readonly vf?: FilterChainService
  readonly af?: FilterChainService
}
```

#### 3.3.1 `MpvService` — the property bus and the only way to talk to mpv

```ts
export interface MpvService {
  /**
   * Refcounted observation. Many modules may observe the same property; the bus
   * issues exactly one `observe_property` to mpv and fans out.
   * Fires immediately with the current cached value if one exists.
   */
  observe<T = unknown>(name: string, cb: (value: T | undefined) => void): Unsubscribe

  /** Last value seen by the bus. `undefined` if never observed or mpv reported unavailable. */
  peek<T = unknown>(name: string): T | undefined

  get<T = unknown>(name: string): Promise<T>

  /**
   * Write a property this module OWNS.
   *
   * Rejects with OwnershipError if `name` is not in this module's
   * `ownsProperties`, naming the actual owner so the fix is obvious:
   *   "audio-loudness may not write 'aid' (owned by audio-tracks).
   *    Use ctx.mpv.requestSet() or invoke audio-tracks.reinitDecoder."
   *
   * In dev the rejection is thrown; in production it is logged, dropped and
   * counted, so one misbehaving module cannot corrupt another's state but also
   * cannot black-screen the player (§3.5 rule 5).
   */
  set(name: string, value: unknown): Promise<void>

  /**
   * The mediated path for a property another module owns. The registry routes it
   * to the owner's arbiter, which may apply it, transform it, defer it to a safe
   * moment, or refuse with a reason. Refusal is a normal outcome, not an error —
   * handle it. `name` must appear in this module's `requestsProperties`.
   *
   * An owner registers its arbiter once, in setup():
   *   ctx.mpv.arbitrate('aid', (value, req) => …)
   * With no arbiter registered, requestSet() refuses with 'no-arbiter' rather
   * than falling through to a raw write.
   */
  requestSet(name: string, value: unknown, reason: string):
    Promise<{ ok: true } | { ok: false; reason: string }>
  arbitrate(name: string, fn: (value: unknown, req: { from: FeatureId; reason: string })
    => Promise<{ ok: true } | { ok: false; reason: string }>): void

  /** Commands are ownership-checked too: a command whose first argument is a
   *  property write (`set_property`, `cycle`, `add`, `multiply`, `cycle-values`,
   *  `change-list`) is routed through the same check as set(). Raw `vf`/`af`
   *  commands are refused outright for every module (§0.2 rule 5). */
  command<T = unknown>(args: unknown[]): Promise<T>
  /** Fire-and-forget. For drag-scrub only. */
  commandNoReply(args: unknown[]): void

  /** Raw mpv events: 'file-loaded', 'end-file', 'playback-restart', 'seek', … */
  onEvent(event: string, cb: (msg: Record<string, unknown>) => void): Unsubscribe

  /**
   * Runs after `playback-restart` for each newly loaded file. Property writes made
   * before this point are DROPPED by mpv — every per-file restore must use this.
   */
  afterFileLoaded(cb: (path: string) => void | Promise<void>): Unsubscribe

  /**
   * Contribute mpv spawn arguments. Called before every spawn/respawn.
   * `priority` 0 runs first; core reserves 0 (`--wid`, `--input-ipc-server`) and
   * 1000 (nothing may follow).
   *
   * TWO checks, not one. A module returning an arg core already owns throws — that
   * was always true. It now ALSO throws when two feature modules contribute the
   * same option name, whatever the values: that hole let V33 (M05,
   * `--d3d11-output-format=rgba16f`) and V36 (M06, `--d3d11-output-format=rgb10_a2`)
   * both ship, both at P1, mutually exclusive, silent last-one-wins. Options whose
   * mpv semantics are additive (`--script-opts-append`, `--sub-auto-exts-append`,
   * `--ytdl-raw-options-append`) are exempt by an explicit allowlist in
   * core/mpv/reserved.ts, and nothing else is.
   *
   * An option that corresponds to a property follows that property's owner: if you
   * do not own `d3d11-output-format` you may not contribute `--d3d11-output-format`.
   */
  contributeArgs(priority: number, fn: () => string[]): void

  /** Ask for a respawn (VO change, exclusive-mode change). Debounced; shows a toast. */
  requestRestart(reason: string): void

  /** True while a network source is playing. Gates streaming-only UI. */
  readonly isNetworkSource: boolean
}
```

#### 3.3.2 `SettingsService` — contributing settings without touching a shared file

```ts
export type SettingType =
  | { kind: 'bool' }
  | { kind: 'int';    min?: number; max?: number; step?: number }
  | { kind: 'float';  min?: number; max?: number; step?: number }
  | { kind: 'string'; multiline?: boolean }
  | { kind: 'enum';   options: ReadonlyArray<{ value: string; labelKey: string }> }
  | { kind: 'path';   mode: 'file' | 'directory'; filters?: Electron.FileFilter[] }
  | { kind: 'list';   of: 'string' }
  | { kind: 'custom'; rendererComponent: string }   // renderer registers by this name

export interface SettingDescriptor<T = unknown> {
  readonly id: SettingId
  /** One of the eight fixed sections. New sections are NOT allowed. */
  readonly section: 'general'|'playback'|'video'|'audio'|'subtitles'|'keys'|'filetypes'|'advanced'
  readonly group?: string          // sub-heading inside the section
  readonly labelKey: string
  readonly descriptionKey?: string
  readonly type: SettingType
  readonly default: T
  /** Search keywords, including Korean. The mpv option name is indexed automatically. */
  readonly keywords?: readonly string[]
  /** The mpv option/property this maps to, for search and for the Advanced tooltip. */
  readonly mpvOption?: string
  readonly requiresRestart?: boolean
  readonly advanced?: boolean      // rendered inside a collapsed 고급 group
  readonly order?: number
  /** Hide when false. Re-evaluated whenever settings change. */
  readonly visibleWhen?: (get: <V>(id: SettingId) => V) => boolean
}

export interface SettingsService {
  /** Call at setup(). Ids must start with `${ctx.id}.` — enforced. */
  define(descriptors: readonly SettingDescriptor[]): void
  get<T>(id: SettingId): T
  set<T>(id: SettingId, value: T): void
  onChange<T>(id: SettingId, cb: (v: T, prev: T) => void): Unsubscribe
  /** Register a schema migration for this module's own settings only. */
  migrate(m: { from: number; to: number; up(data: Record<string, unknown>): Record<string, unknown> }): void
}
```

#### 3.3.3 `CommandService` — contributing keybinds without touching a shared file

```ts
export type CommandScope = 'player' | 'playlist' | 'settings' | 'global'

export interface CommandDescriptor {
  readonly id: CommandId                 // must start with `${ctx.id}.`
  readonly labelKey: string
  readonly category: string              // groups the cheat sheet and the editor
  readonly scope?: CommandScope          // default 'player'
  /**
   * Per-preset default accelerators. Presets are DERIVED by folding these —
   * there is no hand-written preset table anywhere.
   * Physical-key syntax only: 'KeyS', 'Digit1', 'BracketLeft', 'MBTN_LEFT_DBL',
   * 'WHEEL_UP', with modifiers in the fixed order Ctrl+Alt+Shift.
   */
  readonly defaults?: Partial<Record<'default' | 'potplayer' | 'mpv', readonly Accel[]>>
  /** Where this appears in the menu tree, e.g. 'video/capture'. Omit for no menu entry. */
  readonly menuPath?: string
  readonly menuOrder?: number
  /** Greyed out when this returns false. Re-evaluated on every state push. */
  readonly enabledWhen?: () => boolean
  run(arg?: unknown): void | Promise<void>
}

export interface CommandService {
  register(commands: readonly CommandDescriptor[]): void
  /** Invoke another module's command by id. Throws if unknown — no silent no-ops. */
  invoke(id: CommandId, arg?: unknown): Promise<void>
  has(id: CommandId): boolean
}
```

#### 3.3.4 `IpcService` + the generic preload bridge

```ts
export interface IpcService {
  /** Channel must be `${ctx.id}:${verb}` — enforced; duplicates throw at boot. */
  handle<Req, Res>(channel: IpcChannel, fn: (req: Req) => Res | Promise<Res>): void
  on<Req>(channel: IpcChannel, fn: (req: Req) => void): void
  /** Push to every renderer window (or a specific one). */
  send<T>(channel: IpcChannel, payload: T, target?: 'ui' | 'settings' | 'all'): void
}
```

```ts
// src/preload/index.ts  ── WAVE 0, then FROZEN. One generic bridge, no per-feature methods.
const CHANNEL_RE = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/
contextBridge.exposeInMainWorld('rl', {
  invoke: (channel: string, req?: unknown) => {
    if (!CHANNEL_RE.test(channel)) throw new Error(`bad channel: ${channel}`)
    return ipcRenderer.invoke(channel, req)
  },
  send: (channel: string, req?: unknown) => {
    if (!CHANNEL_RE.test(channel)) throw new Error(`bad channel: ${channel}`)
    ipcRenderer.send(channel, req)
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!CHANNEL_RE.test(channel)) throw new Error(`bad channel: ${channel}`)
    const h = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.off(channel, h)
  }
})
```

Main-side, the registry keeps an allowlist of every channel a module actually registered
and rejects anything else, so the regex is a shape check rather than the security
boundary. The existing typed `window.api` surface stays for the core player state — it is
**not** extended by feature modules.

#### 3.3.5 `OsdService`, `PerFileService`, `MenuService`, `I18nService`, `LifecycleService`

```ts
export type OsdKind =
  | 'volume' | 'seek' | 'speed' | 'track' | 'subdelay' | 'audiodelay'
  | 'aspect' | 'zoom' | 'chapter' | 'bookmark' | 'abloop' | 'frame' | 'info' | 'error'

export interface OsdService {
  show(msg: { kind: OsdKind; text: string; value?: number; durationMs?: number }): void
  /** Persistent, dismissible, with an optional action button. Not the OSD. */
  toast(t: { kind: 'info' | 'error' | 'resume'; message: string;
             actionLabel?: string; onAction?: () => void }): void
  /** Long-running work (encode jobs, scans). Returns a handle to update or finish. */
  progress(p: { id: string; labelKey: string; cancellable?: boolean }): ProgressHandle
}

export interface PerFileService {
  /**
   * Register one slice of per-file state. `capture` runs on file close/switch,
   * `apply` runs after `playback-restart`. Only keys whose value differs from the
   * baseline captured at file-load are persisted (P51).
   */
  slice<T extends Record<string, unknown>>(s: {
    key: string                              // `${ctx.id}` unless a module needs several
    capture(): T
    apply(value: Partial<T>): void | Promise<void>
    /** Which sub-keys the user has opted into remembering. Defaults from P50. */
    rememberDefaults: Partial<Record<keyof T, boolean>>
  }): void
  /** Stable identity for the current file. Shared by resume, history and bookmarks. */
  currentKey(): string | null
  forget(file: string): void
}

export interface MenuService {
  /** Contributes to the app menu and the right-click menu. `replaces` removes a legacy id. */
  contribute(section: {
    id: string; parent?: string; labelKey: string; order: number
    items: ReadonlyArray<{ commandId: CommandId } | { type: 'separator' }>
    replaces?: readonly string[]
  }): void
}

export interface I18nService {
  /** Keys must start with `${ctx.id}.` — enforced. */
  register(lang: 'ko' | 'en', messages: Record<string, string>): void
  t(key: string, params?: Record<string, string | number>): string
}

export interface LifecycleService {
  onReady(cb: () => void): void
  onQuit(cb: () => void | Promise<void>): void
  /** Register a child process so the registry can kill it on quit/crash. */
  trackProcess(p: import('node:child_process').ChildProcess): void
}
```

#### 3.3.6 `FilterChainService` — the vf/af contract

```ts
export interface FilterChainService {
  /**
   * Add or replace this module's labelled slot. Label must be `rl-<something>` and
   * must be pre-declared in the reserved label table (§5.5) — unregistered labels throw.
   * Changes made before `file-loaded` are queued, because mpv cannot validate them.
   */
  set(label: string, spec: string): void
  remove(label: string): void
  toggle(label: string, enabled: boolean): void
  /**
   * Live parameter update. Emits the VERIFIED FOUR-ARGUMENT form —
   *   ['vf-command', label, option, value, lavfiFilterName]
   *   ['af-command', label, option, value, lavfiFilterName]
   * — where the last argument is the libavfilter FILTER NAME, not the label and not
   * 'all'. The three-argument form fails with "error running command" on BOTH sides;
   * V09 documents the vf measurement, A27 the af one.
   *
   * Falls back to a full `set()` (label replacement, which preserves chain position)
   * when the filter does not implement process_command. Known refusers, measured:
   *   vf: unsharp          (V08 — the only enhancement filter that refuses)
   *   af: superequalizer, pan, loudnorm   (A27/A48)
   * Known acceptors, measured:
   *   vf: cas, eq, hqdn3d, deblock, v360  (V09, V38)
   *   af: volume, dynaudnorm, dialoguenhance, crossfeed, crystalizer,
   *       acompressor, bass, treble, stereotools
   * The service reports which path it took so a module can decide between a live
   * slider and commit-on-release without hardcoding the table itself.
   */
  command(label: string, option: string, value: string, lavfiFilterName: string):
    Promise<{ path: 'command' | 'rebuild' }>
  /** True if any CPU (lavfi) filter is active — drives the stats overlay warning. */
  readonly hasCpuFilter: boolean
}
```

#### 3.3.7 `WindowService` — the hole that made M31 a bottleneck

**This service exists because it was missing.** Traced end to end: **U07** always-on-top
needs `mainWindow.setAlwaysOnTop(on,'floating')` *and*
`rendererWindow.setAlwaysOnTop(on,'pop-up-menu')`; **U08** needs `setFullScreen`;
**U15** needs `setContentSize` plus a work-area clamp; **U26/U27** need `setThumbarButtons`
/ `setProgressBar` on the *main* window; **U41** needs `showInactive()`; **U46** needs
fullscreen plus a fit-mode change. `FeatureContext` exposed no window handle and no window
service, so **M31 (24 features, 8 of them P0), M32 (7 features) and M33 all had to edit
`src/main/windows.ts`** — one 414-line file, three implementers, which is precisely the
collision §3.0 promises to eliminate. `windows.ts` was not even on the forbidden list.

`src/main/windows.ts` becomes the *implementation* of this interface in Wave 0 and is then
frozen. It already exports most of what is needed (`getVideoWindow`, `getUiWindow`,
`getMpvHostWindow`, `setAlwaysOnTop`, `setFullScreen`, `toggleFullScreen`,
`toggleMaximize`, `beginDrag`, `persistBounds`, `clampToDisplay`, `syncOverlay`,
`setVideoRegion`) — U17's own trap already said "**extend it, do not duplicate it**",
which is only actionable once there is something to extend *through*.

```ts
export interface WindowService {
  // ---- the two-window topology, abstracted. No module ever gets a BrowserWindow. ----
  /** Which surface an operation applies to. 'both' keeps the overlay above the video
   *  window, which is the invariant every ontop/fullscreen call must preserve. */
  //   (docs/03: the overlay is an OWNED top-level window, not an HWND child)

  // ---- fullscreen ----
  isFullScreen(): boolean
  setFullScreen(on: boolean): void
  toggleFullScreen(): void
  /** U09. Moves first, then goes fullscreen — Electron cannot enter fullscreen on a
   *  display the window is not on. Restores the pre-fullscreen bounds, not the moved
   *  ones. Persists display.id AND display.label (ids change on reconnect). */
  setFullScreenOnDisplay(displayId: number): void
  onFullScreenChange(cb: (on: boolean) => void): Unsubscribe

  // ---- always-on-top (U07) ----
  /** Sets BOTH windows with the correct relative levels: main 'floating',
   *  overlay 'pop-up-menu'. On Windows, 'floating'…'status' sit BELOW the taskbar and
   *  'pop-up-menu' and above sit above it — getting this pair wrong is how the overlay
   *  ends up under the video. Modules never choose the level. */
  setAlwaysOnTop(mode: 'never' | 'always' | 'while-playing' | 'fullscreen-only'): void
  getAlwaysOnTop(): 'never' | 'always' | 'while-playing' | 'fullscreen-only'

  // ---- bounds, sizing, monitors (U13–U18, U40, U42) ----
  /** DIP, always. `video-out-params/dw`/`dh` are REAL PIXELS — the service does the
   *  conversion so the DIP-vs-device mistake (§7.7 trap 10) is made once, here. */
  getContentSize(): { width: number; height: number }
  setContentSize(width: number, height: number, opts?: { anchor?: 'center' | 'topleft' }): void
  getBounds(): Electron.Rectangle
  setBounds(b: Partial<Electron.Rectangle>, opts?: { clamp?: boolean }): void
  /** Aspect lock (U16). Pass 0 to release. Handles the "not respected for programmatic
   *  setSize" quirk by releasing and restoring around a programmatic resize itself. */
  setAspectRatio(ratio: number, extraSize?: { width: number; height: number }): void
  center(): void
  maximize(): void; unmaximize(): void; isMaximized(): boolean
  minimize(): void; restore(): void
  showInactive(): void                       // U41 — never steals focus
  /** Focus always goes to the OVERLAY: it is the only window that sees input. */
  focusInput(): void

  // ---- monitors ----
  displays(): ReadonlyArray<{ id: number; label: string; bounds: Electron.Rectangle
                              workArea: Electron.Rectangle; scaleFactor: number }>
  currentDisplay(): { id: number; label: string }
  /** U17. Bounds are stored per monitor-topology signature, not as one global rect. */
  persistBounds(): void
  restoreBounds(): void
  onDisplayChange(cb: () => void): Unsubscribe

  // ---- PiP / mini player (U20) ----
  /** Mutates the EXISTING window — no new window, no mpv respawn, so `--wid`
   *  embedding is untouched. Saves and restores bounds, aspect, ontop level,
   *  minimum size and chrome mode as one unit. */
  enterMiniPlayer(opts?: { width?: number; corner?: 'tl'|'tr'|'bl'|'br' }): void
  exitMiniPlayer(): void
  isMiniPlayer(): boolean

  // ---- chrome + layout ----
  setChrome(mode: 'full' | 'minimal' | 'none'): void
  readonly layoutMode: 'overlay' | 'compat'          // R-1; modules never branch on it
  /** Compat layout only: the rect the renderer reserved for video. */
  onVideoRegionChange(cb: (r: Electron.Rectangle) => void): Unsubscribe

  // ---- taskbar surface (M32 only; the registry grants it by module id) ----
  taskbar?: {
    setThumbarButtons(b: Electron.ThumbarButton[]): boolean
    setProgressBar(v: number, opts?: { mode: 'none'|'normal'|'indeterminate'|'error'|'paused' }): void
    setOverlayIcon(icon: Electron.NativeImage | null, description: string): void
    setThumbnailClip(r: Electron.Rectangle): void
    setThumbnailToolTip(s: string): void
  }

  // ---- sleep blocker (U21, U22) — one owner, refcounted like the property bus ----
  /** M33 owns the policy; anyone may state a requirement and the service resolves
   *  the strongest one. Returns a handle; releasing is mandatory and is also done
   *  automatically on dispose(). */
  blockSleep(kind: 'display' | 'app-suspension', reason: string): { release(): void }
}
```

**Ownership.** `core/window` (Wave 0) owns the implementation. **M31** owns the *policy*
for chrome, ontop mode, fit-to-video and placement; **M32** is the only module granted
`taskbar`; **M33** is the only module that sets a sleep-blocker *policy* (others may state
requirements). No feature module imports `windows.ts`, and CI greps for it the same way it
greps for `UserChoice`.

#### 3.3.8 `DialogService`

M22 (C05 folder picker), M28 (L12 add-folder, L13 open-playlist) and M40 (P42/P43
import/export) all need a picker. `paths` was provided and `dialog` was not, so each would
have imported Electron directly — at which point `FeatureContext` is no longer "the whole
surface a module is allowed to touch", which is the claim §3.3 makes.

```ts
export interface DialogService {
  openFiles(o: { titleKey: string; filters?: Electron.FileFilter[]
                 multi?: boolean; defaultPath?: string }): Promise<string[]>
  openDirectory(o: { titleKey: string; multi?: boolean; defaultPath?: string }): Promise<string[]>
  saveFile(o: { titleKey: string; defaultPath?: string
                filters?: Electron.FileFilter[] }): Promise<string | null>
  /** Confirmations. Destructive actions must pass `destructive: true`, which the host
   *  renders with the confirm button non-default. */
  confirm(o: { titleKey: string; messageKey: string; params?: Record<string, string|number>
               confirmKey: string; destructive?: boolean }): Promise<boolean>
}
```

All dialogs are parented to the correct window by the service (the **overlay** in overlay
layout — parenting to the video window puts the dialog behind it).

### 3.4 Renderer-side API

```ts
// src/renderer/src/core/feature-api.ts  ── WAVE 0
export interface RendererFeatureModule {
  readonly id: FeatureId
  setup(ctx: RendererFeatureContext): void
  dispose?(): void
}

export interface RendererFeatureContext {
  readonly id: FeatureId
  readonly ipc: { invoke<Req, Res>(ch: IpcChannel, r?: Req): Promise<Res>
                  send<Req>(ch: IpcChannel, r?: Req): void
                  on<T>(ch: IpcChannel, cb: (p: T) => void): Unsubscribe }
  readonly state: { get(): PlayerState; subscribe(cb: (s: PlayerState) => void): Unsubscribe }
  readonly t: (key: string, params?: Record<string, string | number>) => string

  /** A slide-out or docked panel. The host owns open/close and focus management. */
  panel(p: { id: PanelId; side: 'left' | 'right' | 'bottom'; titleKey: string
             order: number; mount(el: HTMLElement): () => void }): void

  /**
   * A layer over the seek bar: chapter ticks, bookmark pins, the A-B region,
   * buffered ranges, hover thumbnails.
   *
   * INTERACTIVE, not render-only. The previous signature was render-only — no
   * pointer events, no hit-testing, no drag contract — which made **N19, a P0,
   * unbuildable through the declared API**: its mapping says "dragging a handle sets
   * `ab-loop-a`/`-b`". N13 (bookmark pins) wants click-to-seek and N30 (drag-scrub,
   * M24) wants the bar itself, so three modules needed pointer interaction on one
   * bar and the API gave none of them a way to get it. Without this, M26 reaches
   * into the core seek-bar host and the collision just moves one directory over.
   */
  seekbarLayer(l: {
    id: string
    /** Paint order, low to high. Also the DEFAULT hit-test order, reversed: the
     *  visually topmost layer is offered the pointer first. */
    order: number
    render(ctx: SeekbarLayerCtx): void

    /**
     * Interaction is opt-in. A layer with no `hitTest` never receives pointer
     * events and behaves exactly as before, so chapter ticks stay three lines.
     *
     * Return a non-null handle id when the pointer at `x` (CSS px within the bar)
     * belongs to this layer — an A-B endpoint grip, a bookmark pin, a chapter tick.
     * Returning null passes the pointer to the next layer down and finally to the
     * host's own scrub behaviour (N30), which is therefore never stolen by accident.
     * `tolerancePx` defaults to 6 and is the only reason a 2 px pin is grabbable.
     */
    hitTest?(ctx: SeekbarLayerCtx & { x: number; tolerancePx: number }): string | null

    /** Fired only after this layer's own hitTest claimed the press. The host takes
     *  pointer capture, suppresses its scrub, and guarantees exactly one matching
     *  onPointerUp — including on pointercancel, window blur and Esc (`cancelled`). */
    onPointerDown?(e: SeekbarPointerEvent): void
    onPointerMove?(e: SeekbarPointerEvent): void
    onPointerUp?(e: SeekbarPointerEvent & { cancelled: boolean }): void

    /** Hover without a press. Used by N35 (time tooltip) and N36/N37 (thumbnails).
     *  Delivered to EVERY layer that declares it, hit-test independent, throttled by
     *  the host to one frame. `null` on leave. */
    onHover?(e: (SeekbarPointerEvent & { handle: string | null }) | null): void

    /** Tooltip content contributed at a hover position, merged by `order` into one
     *  tooltip — so the time (M24), the chapter title (M25/N37) and the thumbnail
     *  (M27) compose instead of stacking three floating boxes. */
    tooltip?(e: SeekbarPointerEvent): { el: HTMLElement; order: number } | null

    /** Keyboard equivalence is mandatory for any interactive layer: a bar you can
     *  only drag is a bar some users cannot use. The host focuses the layer's
     *  handles in order and routes arrows here. */
    onKey?(e: { handle: string; key: 'ArrowLeft'|'ArrowRight'|'Home'|'End'
                stepSec: number; shift: boolean }): void
  }): void

  /** A section in the stats/media-info overlay. */
  statsSection(s: {
    id: string; order: number; titleKey: string
    /** Which of U47's three densities this section appears at. Default ['full'] —
     *  a new section never clutters the glance view. */
    levels?: ReadonlyArray<'full' | 'short' | 'misc'>
    fields(): ReadonlyArray<{ labelKey: string; value: string }>
    /**
     * REFRESH CONTRACT — previously unstated, so every contributor guessed and M29
     * polled at some undefined cadence.
     *  'static'   fields() is called once per open (codec names, container).
     *  'onChange' fields() is called when one of `watch`'s properties changes; the
     *             host subscribes through the same refcounted bus, so contributing a
     *             section costs no extra observe_property.
     *  'poll'     fields() is called every `intervalMs`, minimum 250, only while the
     *             overlay is open and the window is visible.
     * Default: 'onChange' with an empty watch list, i.e. once per open.
     */
    refresh?: { mode: 'static' }
             | { mode: 'onChange'; watch: readonly string[] }
             | { mode: 'poll'; intervalMs: number }
  }): void

  /** A section in the settings window, for `type: 'custom'` descriptors or bespoke UI. */
  settingsSection(s: { id: string; section: SettingDescriptor['section']
                       order: number; titleKey: string; mount(el: HTMLElement): () => void }): void

  /** Register a custom control renderer referenced by `{kind:'custom', rendererComponent}`. */
  settingsComponent(name: string, mount: (el: HTMLElement, api: SettingBinding) => () => void): void

  readonly osd: { show(m: { kind: OsdKind; text: string; value?: number }): void }
}

export interface SeekbarLayerCtx {
  readonly el: HTMLElement
  readonly duration: number      // 0 or unknown for live streams (R24) — guard
  readonly width: number         // CSS px
  /** Convenience so no layer re-derives the mapping (and gets it wrong for a live
   *  stream whose bar spans `seekable-ranges` rather than 0..duration). */
  timeToX(t: number): number
  xToTime(x: number): number
}

export interface SeekbarPointerEvent {
  readonly handle: string        // whatever hitTest returned
  readonly x: number             // CSS px within the bar
  readonly time: number          // already converted
  readonly shift: boolean; readonly ctrl: boolean; readonly alt: boolean
  /** Suppress the host's own scrub for this gesture. Implied by a claimed hitTest;
   *  exposed for the hover case. */
  preventDefault(): void
}

/**
 * Worked example — N19, the P0 that could not be built before:
 *
 *   ctx.seekbarLayer({
 *     id: 'abloop', order: 20,
 *     render: c => drawRegion(c, a, b),
 *     hitTest: c => Math.abs(c.x - c.timeToX(a)) <= c.tolerancePx ? 'a'
 *                 : Math.abs(c.x - c.timeToX(b)) <= c.tolerancePx ? 'b' : null,
 *     onPointerMove: e => preview(e.handle, e.time),          // no mpv write yet
 *     onPointerUp:   e => { if (!e.cancelled)
 *                             ctx.ipc.send('nav-bookmarks:setLoopPoint',
 *                                          { which: e.handle, t: e.time }) },
 *     onKey: e => nudge(e.handle, e.key === 'ArrowLeft' ? -e.stepSec : e.stepSec)
 *   })
 *
 * The renderer half never writes mpv properties; it sends to its own main half,
 * which owns `ab-loop-a`/`-b` (§3.7). Both halves of the ownership rule hold.
 */
```

### 3.5 Registry semantics (what `core/registry` guarantees)

1. **Id equals directory name.** Mismatch throws at boot with both names in the message.
2. **Topological setup.** `dependsOn` is resolved; a cycle throws and names the cycle.
3. **Namespace enforcement.** A module may only register settings, commands, IPC
   channels and i18n keys prefixed with its own id. Violations throw at boot, not at
   runtime — so a namespace collision fails in CI, not in a user's hands.
4. **Duplicate detection.** Two modules registering the same setting/command/channel/
   filter-label is a boot error naming both modules.
5. **mpv property ownership (new, and the one this section was missing).** At boot the
   registry folds every module's `ownsProperties` into a single
   `Map<property, FeatureId>`. **Two modules claiming the same property — or a glob that
   overlaps another claim — is a boot error naming both modules and the property**, in the
   same breath as a duplicate command id. `ctx.mpv.set()` and the property-writing
   commands consult that map on every call and refuse a write the caller does not own,
   naming the owner and the mediated alternative. `ctx.mpv.requestSet()` routes to the
   owner's arbiter, and refuses with `'no-arbiter'` rather than falling through to a raw
   write if the owner registered none.
   **The map is asserted against `docs/parity/modules.json` in CI**, so the document and
   the code cannot drift: `test:property-ownership` fails if a module declares a property
   the manifest does not list, or vice versa. Boot additionally warns (does not fail) for
   any property written in §2's mappings that no module claims — the "`vid` has no owner
   at all" case, which is how that one was found.
6. **Spawn-arg disjointness.** No two contributors may return the same option name, core
   or otherwise (§3.3.1). Boot error, both module names.
7. **Isolation.** A throwing `setup()` disables that module, logs loudly, shows one toast,
   and lets the app start. One broken feature must never black-screen the player. Note the
   deliberate asymmetry with rules 4–6: a *collision* fails the build, because it is a
   programming error that CI must catch; a *runtime* failure inside one module degrades to
   that module only.
8. **Teardown.** `dispose()` runs on quit; `lifecycle.trackProcess` children are killed
   even if `dispose` throws; `blockSleep` handles and seek-bar pointer captures are
   released.

### 3.6 The module table

**Core (Wave 0)** — one owner, must land before anything else. Detailed in §5.

| Path | Owns |
|---|---|
| `src/main/core/paths.ts` | portable detection, Electron path redirection, data/cache/temp dirs, writability probe |
| `src/main/core/i18n/` | `t()`, catalog registry, language resolution, 조사 helper |
| `src/main/core/settings/` | descriptor registry, versioned store, migrations, downgrade guard, atomic+fsync writes |
| `src/main/core/registry.ts` | module discovery, dependency order, namespace enforcement, isolation |
| `src/main/core/mpv/bus.ts` | refcounted property observation, `afterFileLoaded`, spawn-arg contribution + duplicate-option rejection, respawn |
| `src/main/core/mpv/ownership.ts` | the property owner map (§3.7): folds `ownsProperties`, throws on duplicates, backs `set()`/`requestSet()`/`arbitrate()` |
| `src/main/core/window/` | the `WindowService` implementation (§3.3.7). **`src/main/windows.ts` moves in here and is then frozen**; no feature module imports it |
| `src/main/core/legacy-bridge.ts` | the transitional shim for `ipc.ts`'s 22 actions and the `Player` class (§5.10). **Deleted at the end of Wave 1** — it is the only file in this document with a scheduled death |
| `src/main/core/mpv/vf-chain.ts` | mpv's `vf` property, reserved labels, ordering policy, `file-loaded` queueing |
| `src/main/core/mpv/af-chain.ts` | mpv's `af` property, slot order, `af-command` wrapper, master bypass |
| `src/main/core/input/` | command registry, derived presets, conflict detection, mouse/wheel names |
| `src/shared/input/accel.ts` | `accelFromEvent` (**`e.code`-based**), normalisation, display labels |
| `src/main/core/osd/` | OSD bus, toast service, progress handles |
| `src/main/core/state/per-file.ts` | file identity, slice registry, baseline diffing, resume/opts persistence |
| `src/renderer/src/core/` | renderer registry, panel host, seek-bar layer host, stats host, settings host, OSD layer |
| `src/shared/feature-api.ts` | every interface in §3.2–§3.4 |

**Feature modules (Wave 1+)** — one implementer each, zero shared-file edits.

**The "Must NOT touch" column is now a summary, not the rule.** The rule is §3.7's owner
map, which the registry enforces at boot and `ctx.mpv.set()` enforces at every call, and
which `docs/parity/modules.json` carries in machine-readable form. Read this column for
intent; read §3.7 for what will actually throw.

| ID | Path (`src/main/features/…` unless noted) | Features | Depends on | Must NOT touch |
|---|---|---|---|---|
| **M01** | `video-color/` | V01–V07 | vf-chain | `deband` (M03), anything geometric |
| **M02** | `video-geometry/` | V22–V31 (incl. autocrop) | vf-chain | scaler props, `keepaspect` is **its own** — no other module writes it |
| **M03** | `video-enhance/` | V08–V16 | vf-chain | `colorlevels`/`normalize` (M01), deinterlace filters (M04) |
| **M04** | `video-deinterlace/` | V17–V21 | vf-chain | any other `@rl-deint` user; it owns the label exclusively |
| **M05** | `video-hdr/` | V32–V35 | vf-chain | `dither*` (M06), `video-output-levels` (M01) |
| **M06** | `video-scaler/` | V36, V44–V48 | vf-chain | `deband*` (M03), `tone-mapping*` (M05) |
| **M07** | `video-decode/` | V49–V52, V54 | mpv bus | `--vo` at runtime (restart-scoped, must go through `requestRestart`) |
| **M08** | `video-framerate/` | V41–V43 | vf-chain | `framedrop` is shared with nobody; do not touch `speed` (M10) |
| **M09** | `video-stereo360/` | V37–V40 | vf-chain | shares `@rl-3d`/`@rl-360`; mutually exclusive, enforced internally |
| **M10** | `audio-volume/` | A06–A09, A22–A24 | af-chain | **the only module allowed to write `volume` / `volume-gain`** |
| **M11** | `audio-tracks/` | A10–A12, A38, A44, P52 (alang half) | mpv bus | `sid`/`slang` (M17). **Owns `aid` and `vid` outright** and publishes the `audio-tracks.reinitDecoder` mediator that A20 (M15) and A36 (M13) must use instead of round-tripping `aid` themselves (§3.7) |
| **M12** | `audio-eq/` | A01–A03, A35, A49 | af-chain | `@rlnorm`, `@rlboost` |
| **M13** | `audio-loudness/` | A04, A05, A36, A37 | af-chain | `@rleq`, `volume` |
| **M14** | `audio-channels/` | A13–A17, A47 | af-chain | `audio-device` (M15) |
| **M15** | `audio-devices/` | A18–A21, A41–A43, A50 | af-chain | **owns every AO-reinit round-trip**; nothing else may re-set `audio-device` |
| **M16** | `audio-effects/` | A28–A34 | af-chain | `@rlnorm`, `@rleq`, `@rlch` |
| **M17** | `subs-tracks/` | S01, S02, S08–S16, S52, P52 (slang half) | mpv bus, M18 (converters) | `sub-*` styling props (M19), `sub-delay`/`sub-speed` (M20). **Owns `sub-reload`** and publishes `subs-tracks.reload` for M18 (S34) and M19 (S22) |
| **M18** | `subs-formats/` | S03–S07, S33, S34, S42 | — | anything mpv-stateful **except `sub-codepage`**. `sub-reload` is **M17's** — the earlier revision granted it here *and* assigned S12 to M17 *and* had M19 issue it in S22: three writers and a self-contradiction two pages apart. Call `subs-tracks.reload` |
| **M19** | `subs-style/` | S17–S26, S46, S51, S53 | mpv bus | `sub-delay`/`sub-speed` (M20), `sid` (M17), `sub-reload` (M17) |
| **M20** | `subs-sync/` | S27–S32, S47 | mpv bus | `ab-loop-*` (M26) |
| **M21** | `subs-browser/` | S35–S37, S39, S40, S44 | M18 | any write to `sid`; it asks M17 |
| **M22** | `capture-still/` | C01–C08, C20–C23 | mpv bus | `screenshot-raw` (fatal), any encode job |
| **M23** | `capture-encode/` | C09–C19, S43 | paths (temp job dirs) | the live mpv instance's properties, except `stream-record` |
| **M24** | `nav-seek/` | N24, N25, N27–N33, N35 | mpv bus | `chapter` (M25), `ab-loop-*` (M26) |
| **M25** | `nav-chapters/` | N01–N09, **N51** | mpv bus | `edition` restart handling must go through `requestRestart`; N51 reads `time-pos` and seeks through M24's command, it does not own seeking |
| **M26** | `nav-bookmarks/` | N10–N15, N17–N23 | mpv bus | `sub-delay` (reads only), `sid` |
| **M27** | `nav-thumbnails/` | N14 (render), N36–N39, L30 | paths | the main mpv instance — it owns a **separate** process |
| **M28** | `playlist/` | L01–L20, L31–L38, L41, L42, L46–L50, N46, N47, A40 | per-file, i18n | `loadfile` for non-queue purposes; other modules ask it to open files. Exposes the series-prefix helper L50/N51 share |
| **M29** | `mediainfo/` | L21–L29, L39 (data), L40, L43, L44, V55, A45, N26, R34, U06, **U47** | mpv bus | any property **write** — it is read-only over mpv and declares `ownsProperties: []`, which the registry enforces. L28's cover-art spawn args belong to **M11**; ask for them |
| **M30** | `history/` | N16, N40, N42–N45, L39 (UI) | per-file | `resume.json` internals — it uses `PerFileService` |
| **M31** | `shell-window/` | U01–U05, U07–U20, U32, U33, U36–U38, U40, U42, U45, **U46**, P58, P63 | osd, **core/window** | mpv's window options (all inert), taskbar APIs (M32), **`src/main/windows.ts` — use `ctx.window` (§3.3.7)**. M02 owns the fit-mode properties U46 needs; invoke `video-geometry.setFitMode` |
| **M32** | `shell-taskbar/` | U26–U31, U39 | **core/window** | window geometry (M31), **`windows.ts`**. It is the only module granted `ctx.window.taskbar` |
| **M33** | `shell-system/` | U21–U25, U34, U35, U41, **A51, N53**, P56, P57 | paths, **core/window** | file associations (M34), **`windows.ts`**. Owns the sleep-blocker *policy*; U41's `showInactive` is `ctx.window.showInactive()` |
| **M34** | `shell-associations/` | P26–P35, P38 (enforcement), P41, R35 | paths | anything outside `HKCU`; **`UserChoice` is forbidden and CI-checked** |
| **M35** | `stream-open/` | R01–R04, R11–R20, R22–R24, R33 | mpv bus | yt-dlp (M36), disc/device (M37) |
| **M36** | `stream-ytdl/` | R05–R10 | **M35** | the network allowlist (M35 owns it); **`vid`/`aid` (M11)** — R08's format switching goes through `audio-tracks.selectStreamFormat` |
| **M37** | `disc-devices/` | R25–R28 | mpv bus | `edition` semantics overlap with M25 — M37 sets, M25 renders |
| **M38** | `settings-ui/` (+ renderer) | P01, P02, P04, P05, P06, P40, P55, P60, U44 | core/settings | any feature's values; it only renders descriptors |
| **M39** | `input-ui/` (renderer) | P17, P19, P20 | core/input | binding storage; it calls the registry |
| **M40** | `transfer/` | P42–P44, P61 | core/settings, core/input | applying values directly; it goes through the stores |

Renderer halves live at `src/renderer/src/features/<same-id>/` with the same id, and are
discovered by the renderer's own glob. A module with no UI simply has no renderer half.

### 3.7 The mpv property owner map — enforced, not documented

**Why this section exists.** §3.5 used to guarantee namespace enforcement for settings,
commands, IPC channels and i18n keys, and duplicate detection for those plus filter
labels. The filter chains got real machinery: reserved labels, declared in §5.5,
"unregistered labels throw at boot". **`MpvService.set(name, value)` had none of it** — no
allowlist, no ownership check, no boot-time collision detection — while §3.6's "Must NOT
touch" column, the thing a 40-way fan-out rests on, was 40 rows of English. §0.2 rule 5
correctly identified uncontrolled `vf`/`af` as "the single most likely way for two modules
to silently destroy each other's work" and then built a registry for exactly two
properties. Every other property got nothing.

And the document contained **three live violations of its own table** before anyone had
typed a line of code. They are resolved below.

#### 3.7.1 The three conflicts, resolved

| Property | Writers found | **Owner** | How the others get it | Why |
|---|---|---|---|---|
| **`aid`** | **three** — M11 (A10–A12 track switching, plus a per-file slice that restores it on `playback-restart`, A44), M15 (A20 wrote `aid no` → `aid prevId` to force a chain reinit), M13 (A36 "pair with the aid round-trip") | **M11 `audio-tracks`** | `ctx.commands.invoke('audio-tracks.reinitDecoder', {reason})`. M11 performs the round-trip **serialised against its own per-file restore**, and returns only when the track it restored is selected again. | M11 is the only module that knows which track *should* be selected. An M15 round-trip racing M11's restore selects the wrong dub — a silent, intermittent, extremely annoying bug on dual-audio releases, and exactly the failure the ownership rule exists to prevent. |
| **`sub-reload`** | **three, plus a self-contradiction** — M18's "Must NOT touch" column claimed it (`except sub-codepage + sub-reload`), while **S12 was assigned to M17** with `sub-reload` as its entire mapping, and **S22 (M19)** said "issue `sub-reload` afterwards for external tracks" | **M17 `subs-tracks`** | `ctx.commands.invoke('subs-tracks.reload', {sid?})` | M17 owns `sid` and the external-track set, and `sub-reload` re-reads exactly those. M17 debounces (S12 already needs a ~300 ms debounce for its `fs.watch` loop), greys the action for embedded tracks, and re-applies `sid` afterwards. M18's row is corrected to `except sub-codepage`. |
| **`vid`** | **three, and no owner at all** — M11 (A38 background playback writes `vid=no`), M36 (R08 switches `vid`/`aid` to pick a yt-dlp format), `core/per-file` (P49 persists and restores it, because it is in mpv's `--watch-later-options` default) | **M11 `audio-tracks`** | M36: `ctx.commands.invoke('audio-tracks.selectStreamFormat', {vid, aid})`. `core/per-file`: through **M11's slice `apply()`**, never a raw write (P49). | `vid` and `aid` are the same decision on an EDL-backed yt-dlp source — switching either re-opens the underlying stream — so one module must hold both. M11 already owns `aid`; giving it `vid` costs nothing and removes the last unowned property in the matrix. |

#### 3.7.2 The map

Reads are unrestricted; this table governs **writes** only. Anything not listed is owned
by nobody, and a module writing it fails the boot check — adding a property means adding
it here *and* to `modules.json`, which CI cross-checks.

| Owner | Properties it may write |
|---|---|
| `core/mpv/bus` | `pause`, `keep-open`, `idle`, `force-window`, `msg-level`, `input-*` — the transport and the process itself |
| `core/vf-chain` | **`vf`** (and nothing else) |
| `core/af-chain` | **`af`** (and nothing else) |
| `core/per-file` | **none.** Every remembered value is written by the owning module's slice `apply()` (P49) |
| `core/window` | none — every mpv window option is inert under `--wid` (§7.5) |
| **M01** video-color | `brightness`, `contrast`, `saturation`, `hue`, `gamma`, `video-output-levels` |
| **M02** video-geometry | `video-aspect-override`, `video-aspect-method`, `keepaspect`, `panscan`, `video-unscaled`, `video-zoom`, `video-pan-x`, `video-pan-y`, `video-scale-x`, `video-scale-y`, `video-align-x`, `video-align-y`, `video-crop`, `video-rotate`, `video-margin-ratio-top`, `-bottom`, `-left`, `-right` |
| **M03** video-enhance | `deband`, `deband-threshold`, `deband-range`, `deband-grain`, `deband-iterations` |
| **M04** video-deinterlace | `deinterlace`, `deinterlace-field-parity` |
| **M05** video-hdr | `tone-mapping`, `tone-mapping-param`, **`tone-mapping-max-boost`**, `target-peak`, `target-contrast`, `target-colorspace-hint`, `target-colorspace-hint-mode`, `hdr-compute-peak`, `hdr-peak-percentile`, `hdr-contrast-recovery`, `allow-delayed-peak-detect`, `gamut-mapping-mode`, `inverse-tone-mapping` |
| **M06** video-scaler | `scale`, `dscale`, `cscale` and every `*-antiring`/`-blur`/`-radius`/`-param1`/`-param2`/`-clamp`/`-window` suffix, `dither`, `dither-depth`, `correct-downscaling`, `linear-downscaling`, `sigmoid-upscaling`, `glsl-shaders`, `glsl-shader-opts`, `icc-profile`, `icc-profile-auto`, `icc-intent`, `icc-3dlut-size`, `icc-use-luma`, `lut`, `lut-type`, `image-lut`, `image-lut-type` |
| **M07** video-decode | `hwdec`, `hwdec-codecs`, `hwdec-software-fallback`, `hwdec-extra-frames`, `vo`, `gpu-api`, `gpu-context`, `d3d11-adapter`, `d3d11-warp`, `d3d11-feature-level`, `d3d11-output-mode`, `d3d11-sync-interval`, `d3d11-flip`, **`d3d11-output-format`**, **`d3d11-output-csp`**, `background`, `background-color`, `background-tile-color-0`, `-1`, `background-tile-size`, `background-blur-radius`, `corner-rounding` |
| **M08** video-framerate | `video-sync`, `framedrop`, `display-fps-override`, `interpolation`, `tscale` |
| **M09** video-stereo360 | none (labels `rl-3d`, `rl-360` only) |
| **M10** audio-volume | `volume`, `volume-gain`, `mute`, `audio-delay`, `speed`, `pitch`, `audio-pitch-correction` |
| **M11** audio-tracks | **`aid`**, **`vid`**, `alang`, `audio-display`, `cover-art-auto`, `cover-art-whitelist`, `track-auto-selection`, `subs-with-matching-audio` *(shared decision with M17 — M11 writes it, M17 requests)* |
| **M12** audio-eq | none (labels `rleq`, `rlpre`, `rltone`, `rlfeq`) |
| **M13** audio-loudness | `replaygain`, `replaygain-preamp`, `replaygain-clip`, `replaygain-fallback`, `ad-lavc-ac3drc` (labels `rlnorm`, `rlnight`, `rldlg`) |
| **M14** audio-channels | `audio-channels`, `audio-normalize-downmix`, `ad-lavc-downmix`, `ad-lavc-threads` (label `rlch`) |
| **M15** audio-devices | `audio-device`, `audio-exclusive`, **`audio-spdif`** (validated against the five names first), `audio-samplerate`, `audio-format`, `audio-buffer`, `wasapi-exclusive-buffer`, `audio-stream-silence`, `audio-wait-open`, `audio-fallback-to-null` (label `rlac3`) |
| **M16** audio-effects | none (labels `rlfx`, `rlcry`, `rlnr`) |
| **M17** subs-tracks | `sid`, `secondary-sid`, `slang`, `sub-visibility`, `secondary-sub-visibility`, `sub-auto`, `sub-auto-exts`, `sub-file-paths`, `subs-fallback`, `subs-fallback-forced`, `subs-match-os-language`, **`sub-create-cc-track`**, **`sub-reload`** |
| **M18** subs-formats | `sub-codepage` |
| **M19** subs-style | `sub-font`, `sub-font-size`, `sub-bold`, `sub-italic`, `sub-color`, `sub-outline-color`, `sub-outline-size`, `sub-back-color`, `sub-shadow-offset`, `sub-border-style`, `sub-pos`, `sub-margin-x`, `sub-margin-y`, `sub-margin-y-offset`, `sub-align-x`, `sub-align-y`, `sub-justify`, `sub-spacing`, `sub-line-spacing`, `sub-blur`, `sub-scale`, `sub-scale-by-window`, `sub-scale-with-window`, `sub-ass-scale-with-window`, `sub-ass-override`, `sub-scale-signs`, `sub-ass-style-overrides`, `sub-ass-styles`, **`sub-ass-vsfilter-color-compat`**, `sub-use-margins`, `sub-ass-force-margins`, `sub-gauss`, `stretch-dvd-subs`, `stretch-image-subs-to-screen`, `image-subs-video-resolution`, `sub-forced-events-only`, `image-subs-hdr-peak`, `sub-hdr-peak`, `sub-filter-sdh`, `sub-filter-sdh-harder`, `sub-filter-sdh-enclosures`, `sub-filter-regex`, `sub-filter-regex-enable`, `sub-filter-regex-plain`, `sub-filter-regex-warn`, **`embeddedfonts`**, **`sub-fonts-dir`**, `secondary-sub-scale`, `secondary-sub-pos`, `secondary-sub-ass-override` |
| **M20** subs-sync | `sub-delay`, `secondary-sub-delay`, `sub-speed`, `sub-fix-timing`, `sub-fix-timing-threshold`, `sub-fix-timing-keep`, `sub-stretch-durations` |
| **M21** subs-browser | none — it asks M17 for `sid` and M20 for delay |
| **M22** capture-still | `screenshot-directory`, `screenshot-template`, `screenshot-format`, `screenshot-jpeg-quality`, `screenshot-png-compression`, `screenshot-png-filter`, `screenshot-webp-lossless`, `screenshot-webp-quality`, `screenshot-webp-compression`, `screenshot-jxl-distance`, `screenshot-jxl-effort`, `screenshot-high-bit-depth`, `screenshot-tag-colorspace`, `screenshot-sw` |
| **M23** capture-encode | `stream-record` — and nothing else on the live instance; its jobs are separate processes on their own pipes |
| **M24** nav-seek | none. Seeking is a command, not a property; `revert-seek` and `frame-step` are M24's commands and the registry treats command ownership the same way |
| **M25** nav-chapters | `chapter`, `edition`, `chapter-seek-threshold`, `chapter-merge-threshold`, `ordered-chapters` |
| **M26** nav-bookmarks | `ab-loop-a`, `ab-loop-b`, `ab-loop-count` |
| **M27** nav-thumbnails | none on the main instance — it owns a **separate** mpv process outright |
| **M28** playlist | `loop-file`, `loop-playlist`, `gapless-audio`, `prefetch-playlist`, **`image-display-duration`**; and it is the only module that may issue `loadfile`/`stop` for queue purposes |
| **M29** mediainfo | **none** — read-only over mpv, declared as `ownsProperties: []` |
| **M30** history | none — it goes through `PerFileService` |
| **M31–M34** shell-* | **none.** Every mpv window option is inert under `--wid` (§7.5), which is why they need `ctx.window`, not property access |
| **M35** stream-open | `cache`, `cache-secs`, `demuxer-max-bytes`, `demuxer-max-back-bytes`, `demuxer-readahead-secs`, `cache-pause`, `cache-pause-initial`, `cache-pause-wait`, `stream-buffer-size`, `cache-on-disk`, `demuxer-cache-dir`, `force-seekable`, `hls-bitrate`, `rtsp-transport`, `user-agent`, `referrer`, `http-header-fields`, `cookies`, `cookies-file`, `http-proxy`, `tls-verify`, `tls-ca-file`, `tls-cert-file`, `tls-key-file`, `network-timeout`, `curl-*` |
| **M36** stream-ytdl | `ytdl`, `ytdl-format`, `ytdl-raw-options`, `script-opts` (its own `ytdl_hook-*` entries, appended via `change-list`, never replaced) |
| **M37** disc-devices | `dvd-device`, `dvd-angle`, `dvd-speed`, `bluray-device`, `bluray-angle`, `disc-menu` *(when the pin moves — §7.2)* |
| **M38–M40** settings/input/transfer | **none.** They write *stores*, and the owning modules react |

#### 3.7.3 Mediator commands (the sanctioned cross-module path)

Every one of these is a normal `CommandDescriptor` in the owner's `commands.ts`, so it
appears in the cheat sheet's internal section, is invocable in tests, and shows up in a
stack trace with a name.

| Command | Owner | Callers | Contract |
|---|---|---|---|
| `audio-tracks.reinitDecoder({reason})` | M11 | M15 (A20), M13 (A36) | Round-trips `aid` off and back to the currently *intended* track, serialised against M11's per-file restore. Resolves after `playback-restart`. |
| `audio-tracks.selectStreamFormat({vid, aid})` | M11 | M36 (R08) | Applies both together; the caller is told a rebuffer is expected so it can show the buffering indicator (R08 already requires this). |
| `subs-tracks.reload({sid?})` | M17 | M18 (S34), M19 (S22) | Debounced ~300 ms, no-op for embedded tracks, re-applies `sid` after. |
| `video-geometry.setFitMode(mode)` | M02 | M31 (U46), M09 | The only way to move `keepaspect`/`panscan`; M02 also resets zoom/pan state, which V23 requires and a raw write would skip. |
| `playlist.openPaths(paths, mode)` | M28 | M33 (U34), M34, M35 | The single entry point for "play these files". |
| `playlist.seriesPrefix(path)` | M28 | M25 (N51) | Shared episode-prefix computation, written once (L50). |

Anything not on this list, a module does not get. Adding a mediator is a one-line PR
against the owner's module and a row here — cheap, visible, and reviewable, which is the
whole point.

**Files each module owns** (the pattern, identical for all 40):

```
src/main/features/<id>/
  index.ts        default-exports the FeatureModule; the only file the registry imports
  settings.ts     its SettingDescriptor[] and migrations
  commands.ts     its CommandDescriptor[]
  messages.ts     registerMessages('ko'|'en', {...})
  <domain>.ts     the actual logic (may be several files)
  types.ts        types local to this module — NOT in src/shared/types.ts
  __tests__/      node:test files
src/renderer/src/features/<id>/
  index.ts        default-exports the RendererFeatureModule
  panel.ts        panel/UI code
  panel.css       styles scoped under a single root class
```

### 3.8 `modules.json` — the machine-readable partition

`docs/parity/modules.json` is this section in a form a script can read, and **the
implementation fan-out is driven off it, not off the prose above.** One array, one object
per module, **55 modules** — the 15 Wave-0 core pieces plus the 40 feature modules:

```jsonc
{
  "id": "M11",                                  // the id used everywhere, incl. dependsOn
  "path": "src/main/features/audio-tracks/",
  "title": "Audio and video track selection",
  "wave": 1,                                    // 0 core, 1 parallel, 2 one upstream dep
  "priority": "P0",                             // the highest priority among its features
  "dependsOn": ["core-mpv-bus"],
  "ownedProperties": ["aid", "vid", "alang", …],  // §3.7, verbatim
  "requestsProperties": [],                     // mediated access it needs from others
  "ownedFilterLabels": [],                      // §5.5 reserved labels
  "ownedFiles": ["src/main/features/audio-tracks/",
                 "src/renderer/src/features/audio-tracks/"],
  "features": ["A10","A11","A12","A38","A44","P52"],   // row ids from §2
  "mustNotTouch": ["src/main/ipc.ts", "src/main/windows.ts", …]
}
```

**`features` is generated from §2, not hand-written** — the Module column of every row is
parsed, so the manifest cannot drift from the matrix. Ranges (`M01–M09`), core owners
(`core/vf-chain`) and shared rows (`M11/M17`) all resolve.

**Three invariants, checked before this file was committed** and re-checked by
`test:property-ownership` in CI:

| Invariant | Result |
|---|---|
| Every id named in a `dependsOn` exists as a module | **holds** — 55 ids, every dependency resolves |
| No mpv property is owned twice | **holds** — 288 distinct properties, zero collisions (36 filter labels likewise) |
| No file is owned twice | **holds** — 110 distinct paths, zero collisions |

411 of the 422 §2 rows resolve to an owning module. The 11 that do not are **deliberate**:
the 10 `skip` rows, which are declines with no implementation, and **P21** (handing the
keymap to mpv), which is an explicitly unowned alternative path recorded so nobody
re-derives it. A row that is neither `skip` nor P21 and has no owner is a bug in this
document, and the generator reports it.

---
## 4. Dependency order

### 4.1 The waves

```
WAVE 0 — CORE (blocking; nothing else may start)
  0a  core/paths ────────────────┐  (must be the first import in main/index.ts)
  0b  shared/feature-api         │
  0c  core/i18n ─────────────────┤
  0d  core/settings ─────────────┤
  0e  core/registry ─────────────┤  needs 0b,0c,0d
  0f  core/mpv/bus ──────────────┤  needs 0e
  0g  core/input + shared/accel ─┤  needs 0e
  0h  core/osd ──────────────────┤  needs 0e
  0i  core/state/per-file ───────┤  needs 0d,0f
  0j  core/mpv/vf-chain ─────────┤  needs 0f
  0k  core/mpv/af-chain ─────────┤  needs 0f
  0l  core/mpv/ownership ────────┤  needs 0e,0f   ← property owner map (§3.7)
  0m  core/window ───────────────┤  needs 0e      ← WindowService (§3.3.7);
                                 │                 windows.ts moves in and freezes
  0n  core/legacy-bridge ────────┤  needs 0e,0g   ← the ipc.ts / Player shim (§5.10),
                                 │                 deleted again at the end of Wave 1
  0o  renderer/core hosts ───────┘  needs 0b + the generic preload bridge;
                                    includes the INTERACTIVE seek-bar host (§3.4)

WAVE 1 — 38 modules in parallel. No module in this wave depends on another module.
  M01 M02 M03 M04 M05 M06 M07 M08 M09      (video, all need vf-chain only)
  M10 M11 M12 M13 M14 M15 M16              (audio, all need af-chain only)
  M17 M18 M19 M20                          (subtitles)
  M22 M23                                  (capture)
  M24 M25 M26 M27                          (navigation)
  M28 M29 M30                              (playlist / mediainfo / history)
  M31 M32 M33 M34                          (shell)
  M35 M37                                  (streaming / disc)
  M38 M39 M40                              (settings UI / keybind UI / transfer)

WAVE 2 — 2 modules with a single upstream dependency
  M21 subs-browser  ← M18 (needs the subtitle parsers)
  M36 stream-ytdl   ← M35 (needs the URL pipeline and the protocol allowlist)
```

**40 feature modules; 38 are startable the moment Wave 0 lands.**

### 4.2 Soft ordering (not blocking, but sequence the work sensibly)

These are *contributions*, not dependencies — the consumer works fine without them, it
just shows less:

| Producer | Consumer | Nature |
|---|---|---|
| M01, M04, M05, M07, M11, M15, M29, M35 | **M29** stats sections | additive; M29 ships with core fields and gains sections as modules land |
| M25 (chapter ticks), M26 (bookmark pins + A-B region), M35 (buffered ranges) | seek-bar layer host | additive; the bar renders fine with zero layers |
| every module | **M38** settings UI | M38 renders whatever descriptors exist; it does not know module names |
| every module | **M39** cheat sheet | same |
| M27 (poster frames) | M30 continue-watching | falls back to a placeholder tile |
| M27 (headless decode) | M25 **N51** audio-fingerprint detection | the P2 third tier only; N51's manual set points and learned offsets need nothing from M27 |
| M28 (`playlist.seriesPrefix`) | M25 **N51** | N51 falls back to "this folder" if the helper is absent |
| M18 (parsers) | M28 playlist (`.cue` display) | falls back to a single row |

### 4.3 Recommended landing order inside Wave 1

If fewer than 38 people are available, land in this order — it front-loads the P0 count
and unblocks the soft consumers earliest:

1. **M28 playlist**, **M17 subs-tracks**, **M24 nav-seek**, **M31 shell-window**,
   **M10 audio-volume** — between them these carry 41 P0 features and are what makes the
   app usable at all.
2. **M07 video-decode**, **M19 subs-style**, **M20 subs-sync**, **M25 nav-chapters**,
   **M26 nav-bookmarks**, **M02 video-geometry**, **M22 capture-still**, **M30 history**,
   **M33 shell-system**, **M11 audio-tracks**, **M29 mediainfo**, **M18 subs-formats**,
   **M34 shell-associations**, **M38 settings-ui** — the rest of P0.
3. **M05 video-hdr**, **M04 video-deinterlace**, **M01 video-color**, **M14 audio-channels**,
   **M35 stream-open**, **M39 input-ui** — the remaining P0 stragglers plus high-value P1.
4. Everything else, P1 first.

### 4.4 Wave 0 is genuinely serial

Wave 0 is **15** pieces and roughly two weeks for one or two people — four more than an
earlier revision counted, because the four partition holes are all Wave-0 work:
`core/mpv/ownership` (0l), `core/window` (0m), `core/legacy-bridge` (0n) and the
interactive seek-bar host inside 0o. Together they are perhaps three or four days. That is
the difference between forty people working in parallel and forty people *believing* they
are working in parallel: `aid`, `sub-reload` and `vid` were already broken **on paper**,
before anyone had typed anything, and `windows.ts` had three owners. **Do not fan out
before it is done and its tests are green.** Every hour saved by starting Wave 1 early is
repaid several times over in merge conflicts, because Wave 1 modules that were written
against a moving API all need rewriting at once.

The one legitimate parallelisation inside Wave 0: `core/paths`, `shared/feature-api` and
`core/i18n` have no dependencies on each other and can be written simultaneously.

---

## 5. Shared infrastructure — built once, before the fan-out

Each subsection is specified tightly enough to implement without further design work.

### 5.1 `core/paths` — portable resolution and Electron path redirection

**Must be the first import in `src/main/index.ts`, executing before `app.whenReady()`.**

```ts
export function resolveDataDir(): string {
  const exeDir = path.dirname(app.getPath('exe'))
  if (process.env.RLPLAYER_HOME) return process.env.RLPLAYER_HOME
  if (fs.existsSync(path.join(exeDir, 'portable.txt')))     return path.join(exeDir, 'data')
  if (fs.existsSync(path.join(exeDir, 'portable_config')))  return path.join(exeDir, 'portable_config')
  return path.join(app.getPath('appData'), 'RLPlayer')
}
```

Then, unconditionally and immediately:

```ts
app.setPath('userData', dir)
app.setPath('sessionData', path.join(dir, 'session'))
app.setPath('logs',       path.join(dir, 'logs'))
app.setPath('crashDumps', path.join(dir, 'crash'))
app.commandLine.appendSwitch('disk-cache-dir', path.join(dir, 'cache'))
```

Also provides: `cacheDir()`, `subCacheDir()`, `thumbCacheDir()`, `sceneCacheDir()`,
`tempJobDir(jobId)` (a per-job directory for lavfi staging — see §7.7),
`isPortable()`, `portableFallback: boolean` (from the writability probe, P39).

**Directory layout** (identical in both modes, only the root differs):

```
<dataDir>/
  config.json  keybinds.json  mouse.json  resume.json  playlists.json
  bookmarks.json  history.json  audio-eq-presets.json  mpv.conf
  themes/   subcache/   cache/{thumbs,art}/   session/  logs/  crash/
```

### 5.2 `core/settings` — descriptor registry + versioned store

Three responsibilities, deliberately separated into three files:

**`registry.ts`** — `define()`, `get()`, `set()`, `onChange()`, namespace enforcement,
duplicate detection, and `listAll()` for the settings UI. Values live in a single
`Record<SettingId, unknown>`; a missing key resolves to the descriptor's `default`, which
is what makes "only persist what changed" (P51) work for global settings too.

**`store.ts`** — a generic versioned JSON store instantiated once per file:

```ts
interface Store<T> {
  read(): T                 // migrate → validate → merge-with-unknown-preserved
  write(patch: Partial<T>): void   // debounced 300 ms, atomic, fsync'd
  readonly readOnly: boolean       // true when schema > CURRENT (P09)
  readonly recovered: boolean      // true when a .corrupt.<ts> file was quarantined
}
```

Required behaviours, all of which are current bugs or gaps:
- `fs.openSync` → `writeSync` → **`fsyncSync`** → `closeSync` → `renameSync` (P11).
- Unknown keys collected into `__extra` and re-spread on write (P10).
- `schema > CURRENT` ⇒ read-only + banner, no migration, no save (P09).
- Parse failure ⇒ rename to `<file>.corrupt.<ts>` + error toast (P12).
- `<file>.bak.v<old>` copied before any migration (P08).

**`migrations.ts`** — `registerMigration(storeId, {from, to, up})` and a runner that
throws `SchemaGapError` rather than skipping.

**Initial schema versions:** `config: 1`, `keybinds: 1`, `mouse: 1`, `resume: 1`,
`playlists: 1`. **Write `playlists.json` in the multi-list shape from day one** (§2.6 L37)
so the Albums feature needs no migration later.

### 5.3 `core/mpv/bus` — the property-observation bus

Wraps the existing `MpvManager`/`MpvClient`; does not replace them.

- **Refcounted observation.** `observe(name, cb)` increments a refcount, issues
  `observe_property` only on the 0→1 transition, and fans out on `property-change`.
  Unsubscribing on the 1→0 transition issues `unobserve_property`. Today's fixed
  `OBSERVED` array becomes the bus's initial subscriptions for the core `PlayerState`.
- **Value cache + `peek()`.** Every observed value is cached so a module registering late
  gets the current value synchronously.
- **`undefined` is a legitimate value.** mpv reports "property unavailable" for
  `editions` on MP4, `current-ao` with no AO, and others. The bus must pass `undefined`
  through, never coerce it to `0` or `''`.
- **`afterFileLoaded`.** Subscribes to `playback-restart`, **not** `file-loaded` — the
  verified event order is `start-file` → `file-loaded` → seek → `playback-restart`, and
  writes made at `file-loaded` can be dropped or produce a visible frame-0 flash (N41).
- **Spawn-arg contribution.** `contributeArgs(priority, fn)`; the manager concatenates by
  priority at spawn. Core reserves priority 0 for `--wid`, `--input-ipc-server`,
  `--no-config`, the input-suppression flags and `--vo`. **A module returning an arg core
  already owns throws at boot.** Reserved arg prefixes are listed in `core/mpv/reserved.ts`.
- **`requestRestart(reason)`.** Debounced 250 ms; saves per-file state, respawns mpv,
  re-embeds via `--wid`, restores position and per-file options, and shows one toast.
- **`isNetworkSource`.** Derived from `demuxer-via-network`, for the many "only for
  streams" gates.

New spawn args that Wave 0 must add to the base set (each is a verified defect fix):

| Arg | Why |
|---|---|
| `--drag-and-drop=no` | mpv's default `auto` registers its own OLE drop target on the child HWND and replaces its own playlist (L09/U32) |
| `--sub-file-paths=sub;subs;subtitles;자막` | the current colon-separated, case-variant value scans one directory and creates duplicate tracks (S09) |
| `--background=color --background-color='#FF000000'` | mpv's default letterbox fill is a checkerboard (V52) |
| `--screenshot-high-bit-depth=no` | the default produces 5 MB 16-bit PNGs from 8-bit sources (C06) |
| `--volume-max=100` | all boost moves into the af chain so the limiter actually works (A06) |
| `--input-media-keys=no` | Electron owns media keys (U24) |
| `--taskbar-progress=no` | mpv paints on a child HWND with no taskbar button (U27) |
| `--cursor-autohide=no` | the overlay owns the cursor (U11) |
| `--include=<dataDir>\mpv.conf` **at index 0** | user passthrough that cannot override core args (P06) |
| `--ytdl=yes --script-opts-append=ytdl_hook-exclude=.*` | makes the yt-dlp toggle restart-free while still making zero network calls (R05) |

### 5.4 `core/input` — command registry, derived presets, IME-safe accelerators

**`shared/input/accel.ts`** is the single most important file here:

```ts
export function accelFromEvent(e: KeyboardEvent): Accel {
  const parts: string[] = []
  if (e.ctrlKey)  parts.push('Ctrl')
  if (e.altKey)   parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.code)          // 'KeyS' | 'Digit1' | 'BracketLeft' | 'ArrowRight' | 'Space'
  return parts.join('+')
}
```

`e.code`, never `e.key` (P16). Display labels come from a static code→symbol table,
refined by `navigator.keyboard.getLayoutMap()` when available. Modifier order is fixed at
`Ctrl+Alt+Shift` so string comparison is safe.

Mouse and wheel share the accelerator namespace using **mpv's own names** (P22, P23), so
config files stay readable and the strings remain valid if input is ever delegated to mpv.

The registry stores `Record<CommandId, Accel[]>` (P18) and derives each preset by folding
every registered command's `defaults`. Conflict detection is scope-aware. `keybinds.json`
holds only user overrides.

### 5.5 `core/mpv/vf-chain` and `core/mpv/af-chain`

Two files, same shape, different ordering policies. **These are the highest-risk shared
components after the bus**, because a bug here silently corrupts nine modules' work.

**Reserved labels — declared here, enforced at boot:**

```
vf: rl-levels rl-autolevel rl-cshift rl-sharpen rl-soften rl-denoise rl-tdenoise
    rl-gdenoise rl-deblock rl-mblur rl-deint rl-hflip rl-vflip rl-rotate rl-3d
    rl-360 rl-vsr rl-dv rl-lut rl-cropdetect rl-mi rl-truehdr
af: rlch rleq rlpre rlfx rldlg rlnorm rlnight rlcry rlnr rltone rlac3 rltempo rlfeq rlboost
```

**vf ordering policy (enforced, not advisory):**
`deint → dv → 3d/360 → denoise/deblock → sharpen/soften → mblur → vsr → lut → rotate → hflip/vflip`

**af ordering policy:** `rlch → rleq/rlpre/rltone/rlfeq → rlfx/rlcry/rlnr → rldlg → rlnorm/rlnight → rltempo → rlac3 → rlboost`
— **boost and limiter last, always** (A06/A26).

Both must:
- Queue every change until `file-loaded`; mpv cannot validate filter commands before the
  first frame is decoded and may leave a broken chain.
- Rebuild the whole chain with one `af set` / use `vf add @label:` replacement semantics
  (verified: re-adding a used label replaces rather than appends).
- Support disable-in-place (`@label:!lavfi=[…]`) so settings survive a toggle (A25).
- Expose `hasCpuFilter` — every lavfi filter forces hardware-decoded frames back to system
  memory, and the stats overlay must be able to say so.
- Wrap **both** `af-command` **and `vf-command`** in the **verified four-argument form**
  `['<x>f-command', label, option, value, lavfiFilterName]`. The three-argument form fails
  with "error running command" on **both** sides, and `'all'` as the fourth argument fails
  too. An earlier revision stated this correctly for `af` (A27, §7.7 trap 4) and wrote the
  vf side with three arguments (V09), which would have led the first video implementer to
  conclude `vf-command` does not work at all and fall back to graph rebuilds everywhere.
- Keep the **refuser table** (§3.3.6) in one place here, not in nine modules: `unsharp`
  refuses `vf-command`; `superequalizer`, `pan` and `loudnorm` refuse `af-command`. For a
  refuser, `command()` transparently rebuilds via label replacement and reports
  `{path:'rebuild'}` so the caller can choose commit-on-release instead of a live slider.

### 5.6 `core/osd` — one OSD surface, one toast surface

Main-side bus + renderer-side layer. Because we run `--osd-level=0 --no-osd-bar --osc=no`,
**the overlay owns 100% of the OSD** and mpv's `show-text` is used only as a debugging
fallback. Mixing the two looks broken.

- `show()` coalesces same-`kind` messages (dragging volume produces one updating OSD, not
  forty stacked ones).
- Per-kind enable/disable from config (U04/P58) is applied **in the service**, so no
  module has to check whether its OSD is wanted.
- `toast()` is separate: persistent, dismissible, optional action. Used by resume (N42),
  capture (C20), device loss (A43), corrupt config (P12), yt-dlp failure (R07).
- `progress()` returns a handle for encode jobs (C18) and folder scans (L12).

### 5.7 `core/state/per-file` — one identity, many slices

- **Identity.** `resumeKey(file)` stays `sha1(lowercase(absolute path) + size)` for now;
  §7.9 is the open decision. It is exposed once, here, and used by resume, history,
  bookmarks and per-file options so all four agree on what "the same file" means.
- **Slices.** Modules register `{key, capture, apply, rememberDefaults}`. The store never
  knows what a slice contains.
- **Baseline diffing (P51).** On `playback-restart` the service snapshots each slice; on
  file close/switch it persists only keys that differ from that baseline. This is what
  makes later default changes still reach already-seen files.
- **Two stores, deliberately.** `resume.json` **deletes** an entry once the file is
  finished (so a stale resume is never offered — the mpv#2052 rationale, already
  implemented in `resume-rules.ts`); `history.json` **keeps** it with `finished: true` so
  the history panel can show a checkmark (N40).
- **Ordering.** `apply()` runs after `playback-restart`, in registration order, and each
  slice's failures are isolated — one module's bad restore must not abort the others.
- Provides the batch `lookupMany(paths)` the playlist needs for watched badges (L39).

### 5.8 Renderer core hosts

`src/renderer/src/core/` provides: the renderer module registry (same glob pattern), the
panel host (open/close, focus trap, Esc), the seek-bar layer host (ordered canvas/DOM
layers with a shared `duration`/`width` context), the stats host, the settings host
(descriptor-driven form generation + custom component slots), the OSD layer, and the
theme token layer (`tokens.css`, U36).

The panel host is also where the **compat-layout** difference lives: in compat mode
panels dock rather than float, and the video region is an inset box. Feature modules must
never branch on layout mode themselves — the host does it.

### 5.9 What Wave 0 must delete or fix in existing code

These are known defects, all of which belong to Wave 0 because they sit in shared files:

| File | Change |
|---|---|
| `src/main/mpv/manager.ts` | `--sub-file-paths` separator and case duplicates (S09); add the ten args in §5.3; migrate `aspect: '-1'` → `'no'` (V22); `mapTracks()` must keep `audio-channels` (A10); wait for `playback-restart` not `file-loaded`, or move to `loadfile … -1 {start}` (N41) |
| `src/main/player.ts` | `applyBoostFilter()` is a measured no-op — rewrite per A06 |
| `src/main/services/config.ts` | `merge()` discards unknown keys (P10); no `fsync` (P11); silent fallback on corrupt (P12) |
| `src/main/services/resume.ts` | no `fsync`; silent fallback; extend for slices (§5.7) |
| `src/shared/keybinds.ts` | `eventToAccel()` uses `e.key` — IME-fatal (P16); three wrong PotPlayer bindings (P14); flip the storage direction (P18) |
| `src/main/ipc.ts` | `chapterNext/Prev` reimplement the seek threshold (N03); `seek` action lacks `exact` (N29); `SUB_EXTENSIONS` incomplete (S11); `handleIncomingPaths()` treats audio files as media (A12). **And the 22-action legacy table is migrated and then deleted — §5.10** |
| `src/main/player.ts` | `applyBoostFilter()` (above), and the whole 578-line class is dismantled by §5.10 |
| `src/main/index.ts` | `filesFromArgv()` discards directories (U34); hardcoded Korean strings must go through `t()` (P45) |
| `src/main/windows.ts` | `beginDrag()` polling bypasses Windows' drag loop, killing Aero Snap (U19). **The file moves into `core/window/` and becomes the `WindowService` implementation (§3.3.7), then freezes** — it is not a file feature modules edit |

### 5.10 Retiring the legacy `Player` class and `ipc.ts`'s 22-action table

**This is a blocking Wave-0 item, and leaving it unstated was a partition hole.**
`src/main/ipc.ts` dispatches 22 string actions — `volume`, `mute`, `speed`, `speedReset`,
`frameBack`, `frameForward`, `screenshot`, `screenshotClipboard`, `toggleSubs`,
`cycleSub`, `cycleAudio`, `subDelay`, `audioDelay`, `chapterNext`, `chapterPrev`, `next`,
`previous`, `fullscreen`, `alwaysOnTop`, `togglePlaylist`, `seek`, `stop` — all routed
through the 578-line `Player` class. **Every one of those 22 is claimed by a Wave-1
module** (M10, M17, M20, M22, M24, M25, M28, M31). §5.9 listed four small fixes to
`ipc.ts` and never said what happens to the dispatch table, so after Wave 1 `volume` would
have had two writers (`Player` and M10), `chapter` two (`Player` and M25), `sid` two, and
so on — with the legacy path still wired to the existing renderer and the existing
keybinds. **§3.5's duplicate detection would not have caught any of it, because `Player`
is not a module** and never declares anything.

#### Where each action goes

| Legacy action | New owner | New command id |
|---|---|---|
| `volume`, `mute` | **M10** | `audio-volume.set`, `audio-volume.toggleMute` |
| `speed`, `speedReset` | **M10** | `audio-volume.setSpeed`, `audio-volume.resetSpeed` |
| `audioDelay` | **M10** | `audio-volume.setAudioDelay` |
| `cycleAudio` | **M11** | `audio-tracks.cycle` |
| `toggleSubs`, `cycleSub` | **M17** | `subs-tracks.toggleVisibility`, `subs-tracks.cycle` |
| `subDelay` | **M20** | `subs-sync.setDelay` |
| `screenshot`, `screenshotClipboard` | **M22** | `capture-still.save`, `capture-still.toClipboard` |
| `seek`, `frameBack`, `frameForward` | **M24** | `nav-seek.seek` *(gains the `exact` flag N29 needs)*, `nav-seek.frameBack`, `nav-seek.frameForward` |
| `chapterNext`, `chapterPrev` | **M25** | `nav-chapters.next`, `nav-chapters.prev` *(become `add chapter ±1`, dropping the reimplemented threshold — N03)* |
| `next`, `previous`, `stop`, `togglePlaylist` | **M28** | `playlist.next`, `playlist.prev`, `playlist.stop`, `playlist.togglePanel` |
| `fullscreen`, `alwaysOnTop` | **M31** | `shell-window.toggleFullScreen`, `shell-window.cycleAlwaysOnTop` *(a 4-mode cycle, U07, not a boolean)* |

Play/pause and the core `PlayerState` push are **not** migrated: they stay in
`core/mpv/bus` as the transport, which is why `pause` is a core-owned property in §3.7.

#### The shim, and its expiry date

`core/legacy-bridge.ts` (Wave-0 piece 0n) is a table of exactly these 22 entries mapping
each legacy action string to a `ctx.commands.invoke(id)` call:

```ts
// core/legacy-bridge.ts — TRANSITIONAL. Deleted at the end of Wave 1.
const LEGACY: Record<string, (arg?: unknown) => Promise<void>> = {
  volume:      v => commands.invoke('audio-volume.set', v),
  chapterNext: () => commands.invoke('nav-chapters.next'),
  // …20 more
}
```

Four rules make it safe rather than another place for state to live:

1. **The shim never touches mpv.** It only forwards. If a target command does not exist
   yet — its module has not landed — it logs once and no-ops with an OSD, so the app
   remains usable throughout the migration instead of half-dead in the middle of it.
2. **`Player` is dismantled, not wrapped.** Each method moves into the module that claims
   it, in that module's own PR. `player.ts` shrinks as Wave 1 lands and is deleted with
   the shim. Nothing new is ever added to it — CI fails on a line-count increase, which is
   a crude check that works.
3. **The renderer is repointed incrementally.** The existing typed `window.api` surface
   keeps working (§3.3.4 already says feature modules do not extend it); each renderer
   call site switches to `rl.invoke('<feature>:…')` as its module lands.
4. **The shim has a deadline in CI.** `test:legacy-shim` asserts the table only shrinks,
   and fails the build outright once every one of the 22 has an owner — at which point the
   shim, the `Player` class and the legacy dispatch are deleted in one commit. **A
   compatibility layer with no expiry date becomes permanent**, and a permanent one here
   would mean every action in the list keeps its second writer forever.

---
## 6. Verification plan

"It compiles" and "it looked right once" are not acceptance. Every module below states a
**falsifiable** check. Where a check is automatable it belongs in `npm test` or CI; where
it is not, it belongs in a per-module `VERIFY.md` checklist an implementer ticks in the PR.

### 6.1 Sample media manifest

Build this once and check the small items into `samples/` (large ones go in a documented
download script — `samples/fetch-samples.mjs` — because the repo must stay small).

| Id | File | Must contain | Used by |
|---|---|---|---|
| **SM-A** | `bbb.mp4` *(exists)* | H.264 + AAC, 1080p30, CFR, short | everything smoke-level |
| **SM-B** | `bbb_long.mp4` *(exists)* | ≥10 min | resume, seek, thumbnails, history |
| **SM-C** | `mixed.mkv` | **HEVC 10-bit + DTS + AC-3 + embedded ASS with typeset signs + 2 audio tracks (jpn/eng) + chapters titled `Opening`/`Ending`** | M04, M11, M17, M19, M25, M29 — the single most valuable sample |
| **SM-D** | `hdr10.mkv` | HEVC PQ, BT.2020, `max-luma` set | M05, M06, M29 |
| **SM-E** | `interlaced.ts` | 1080i MPEG-2 with a 3:2 pulldown segment, 2 audio PIDs | M04, M08, R22 |
| **SM-F** | `korean.smi` + `korean-broken.smi` | CP949, `<P Class=KRCC>` **and** `<P Class=ENCC>` at identical `Start=`; the broken copy uses lowercase `<sami>` and two leading blank lines | **M18 — the highest-value subtitle test** |
| **SM-G** | `pgs.mkv` | PGS image subtitles + a text track | M19 (control greying), M25 |
| **SM-H** | `letterbox.mkv` | true 2.35:1 in a 16:9 frame, one bright scene and one dark scene | M02 autocrop |
| **SM-I** | `vfr.mp4` | variable frame rate screen recording | M24 (back-step limits) |
| **SM-J** | `subs/` | `.srt` with BOM, `.ass` with signs, MicroDVD `.sub` (≥3 lines), `.vtt`, a 25 fps frame-based sub | M17, M18, M20 |
| **SM-K** | `rotated.mp4` | phone portrait video with rotation metadata | M02, V58, U13 — **keep it as the R-18 regression guard**: `dw`/`dh` are now known to account for `video-rotate`, and this sample is what proves it stays true |
| **SM-L** | `album/` | MP3 with embedded art, FLAC with art, a folder with `cover.jpg` and no embedded art | M29 L28/L29, U22 |
| **SM-M** | `ordered/` | Matroska ordered-chapters set (2 segments) + an MKV with two editions | M25 N06/N09 |
| **SM-N** | `stereo3d.mkv` | half-SBS with `StereoMode` set | M09 |
| **SM-O** | `hls/` | a local HLS master + variants served by `python -m http.server` | M35 — **no external network in tests** |
| **SM-P** | `surround.mkv` | 5.1 AC-3 and a 5.1 FLAC | M13, M14, M15 |
| **SM-Q** | *(hardware)* | an AV receiver over HDMI/SPDIF | M15 A20 only — cannot be automated, see §7.4 |
| **SM-R** | *(optional)* | a decrypted DVD `VIDEO_TS` folder and a BD `BDMV` folder | M37 |

### 6.2 Automated suites that must exist before Wave 1 ends

| Suite | What it proves |
|---|---|
| `npm run verify:sort` *(exists)* | `naturalCompare` still matches `StrCmpLogicalW` over 27 000+ pairs |
| `test:registry` | boot with a deliberately bad module: wrong id, duplicate setting, duplicate channel, dependency cycle, throwing `setup()`. Each must fail loudly **and the app must still start** (rule 5, §3.5) |
| `test:accel` | a table of synthetic `KeyboardEvent`s **including `key:'Process', keyCode:229` and `key:'ㄴ', code:'KeyS'`** all resolve to the same accelerator |
| `test:settings-store` | round-trip; unknown-key preservation; `schema > CURRENT` read-only; corrupt-file quarantine; migration gap throws; `fsync` called (spy) |
| `test:per-file` | baseline diffing persists only changed keys; finished files are deleted from resume but kept in history |
| `test:chains` | vf/af ordering policy, label replacement, disable-in-place, queueing before `file-loaded`, unregistered-label rejection |
| `test:network-zero` | run the packaged app on a local file under a network monitor for 60 s: **zero outbound connections** (`docs/01`'s core guarantee) |
| `test:portable-clean` | run the packaged exe, quit, assert nothing in `%APPDATA%\rlplayer`, `%LOCALAPPDATA%\rlplayer`, or `HKCU\…\RegisteredApplications` (P41) |
| `test:no-hijack` | grep for `UserChoice` / `SetAppAsDefaultAll` / `LaunchAdvancedAssociationUI` (P33) |
| `test:reserved-args` | every module's `contributeArgs` output is disjoint from the core-reserved prefix list **and from every other module's** — the V33/V36 `--d3d11-output-format` collision must fail the build |
| `test:property-ownership` | boot two modules claiming the same property: **boot error naming both**. Assert `ctx.mpv.set()` rejects a non-owned write and names the owner. Assert `requestSet()` reaches the arbiter and that refusal is propagated, not swallowed. **Assert the boot map and `docs/parity/modules.json` agree in both directions**, so the spec and the code cannot drift |
| `test:seekbar-interaction` | a synthetic pointer sequence over three registered layers hits the topmost claimant only; a claimed press suppresses the host scrub; every `onPointerDown` gets exactly one `onPointerUp`, including on `pointercancel` and window blur; keyboard nudging moves the same handle |
| `test:window-service` | no file under `src/main/features/**` imports `windows.ts` or constructs a `BrowserWindow` (grep, same shape as `test:no-hijack`); `blockSleep` refcounts and releases on `dispose()` |
| `test:legacy-shim` | the 22-entry table only ever shrinks; the suite **fails the build** once all 22 have owners, forcing the shim's deletion (§5.10) |

### 6.3 Per-module acceptance

| Module | Prove it works by… | Sample |
|---|---|---|
| **core/paths** | drop `portable.txt` beside a packaged build, run, quit, then assert `%APPDATA%` and `%LOCALAPPDATA%` are untouched **and** `data/session`, `data/cache`, `data/logs` exist | — |
| **core/settings** | kill the process mid-write 20× in a loop; `config.json` must always parse afterwards. Hand-edit `schema` to 99 and confirm read-only + banner | — |
| **core/mpv/bus** | two modules observe `time-pos`; assert exactly **one** `observe_property` on the wire (log the raw pipe). Unsubscribe one; assert no `unobserve`. Unsubscribe both; assert `unobserve` | SM-A |
| **core/input** | with the Korean IME **on**, every letter binding still fires (this is the whole point of §5.4) | — |
| **core/vf/af-chain** | enable denoise, sharpen, deinterlace and hflip together; read back `vf` and assert the documented order; toggle one off and assert the others survive with their settings | SM-C |
| **core/osd** | drag the volume slider across its range; exactly one OSD element exists in the DOM at any time | SM-A |
| **core/mpv/ownership** | boot a fixture where two modules claim `aid`: the app **fails to start with both module names and the property in the message**. Then, at runtime, have M13 call `set('aid', 2)`: rejected, owner named, nothing written. Have it call `requestSet` instead: M11's arbiter runs and the reply is propagated. Finally assert the boot map equals `docs/parity/modules.json` in both directions | — |
| **core/window** | `grep -r "windows.ts\|new BrowserWindow" src/main/features/` returns nothing. Ontop mode `always` puts the overlay above the video window **and** above the taskbar (screenshot). Enter and exit the mini player 20× and assert bounds, aspect, ontop level and chrome return exactly to their pre-PiP values | dual-monitor rig |
| **renderer seek-bar host** | with chapter ticks, bookmark pins and the A-B region all registered, grabbing an A-B handle moves **only** that handle and does not scrub; releasing outside the window still delivers `onPointerUp {cancelled:true}`; Tab reaches every handle and arrows nudge it | SM-B |
| **core/legacy-bridge** | every one of the 22 legacy actions still works with **zero** feature modules loaded (it no-ops with an OSD) and with all of them loaded (it forwards). `test:legacy-shim` fails the build once the table is empty | SM-A |
| **core/per-file** | set audio track 2 and `sub-delay` −0.4 on SM-C, close, reopen: both restored, and `speed` (default-OFF) is **not** | SM-C |
| **M01 video-color** | brightness ±100 visibly changes the picture **with hwdec active** (`hwdec-current` non-`no`) — proves it is a VO-level property, not a filter | SM-A |
| **M02 video-geometry** | zoom in 10 steps and back out 10 steps returns `video-zoom` to exactly 0 (proves the log2 maths); Ctrl+wheel at a corner keeps that corner's pixel under the cursor; autocrop on SM-H yields 2.35:1 from the bright scene | SM-H, SM-K |
| **M03 video-enhance** | toggle deband on a dark gradient and see banding disappear **without** `hasCpuFilter` becoming true (it is a GPU pass); toggle hqdn3d and see `hasCpuFilter` become true | SM-D |
| **M04 video-deinterlace** | comb artifacts on SM-E disappear; `deinterlace-active` reports the truth; switching to the manual `bwdif` filter does **not** leave both active | SM-E |
| **M05 video-hdr** | SM-D on an SDR monitor is not washed-out grey; the stats section reports `gamma: pq`; passthrough on an HDR monitor makes the overlay visibly SDR-dim (expected, documented) | SM-D |
| **M06 video-scaler** | switching fast/balanced/high changes `scale` and `dither`, and each value is individually resettable (proves no `apply-profile`) | SM-A |
| **M07 video-decode** | force `dxva2` and confirm the UI reports the **actual** `hwdec-current` fallback rather than claiming success; force `no` and confirm software decode | SM-C |
| **M08 video-framerate** | 23.976 content on a 60 Hz panel shows no pulldown judder on a slow pan with `display-resample`; disabling it makes the judder reappear | SM-B |
| **M09 video-stereo360** | SM-N auto-detects via `video-params/stereo-in` and 3D-to-2D produces one normal picture; the 360 dropdown contains no `c2x3` entry | SM-N |
| **M10 audio-volume** | **measure it**: `--ao=pcm` render at UI 200% and assert the peak is limited (this is the A06 regression test, and the current code fails it) | SM-A |
| **M11 audio-tracks** | SM-C's menu shows `[jpn] … FLAC 5.1` style labels; `alang=jpn` auto-selects on open; dropping a `.mka` **attaches** rather than replacing playback | SM-C |
| **M12 audio-eq** | drag one band from −12 to +12 with audio playing: no gap, no click (proves `af-command`, not chain rebuild) | SM-A |
| **M13 audio-loudness** | dialogue in a loud action scene becomes audible with night mode on; `--ad-lavc-ac3drc=1` on SM-P produces a different, better result than the generic compressor | SM-P |
| **M14 audio-channels** | 5.1 → stereo keeps the centre channel audible (speak-only test clip); `audio-out-params` shows 2ch while `audio-params` shows 6ch | SM-P |
| **M15 audio-devices** | unplug a USB output mid-playback: playback continues, a toast appears, and the device list re-enumerates. Passthrough needs SM-Q — mark it **unverified in CI** and require a hardware sign-off | SM-P, SM-Q |
| **M16 audio-effects** | each effect loads and can be reset to off; `stereotools mlev=0` is never emitted (it fails to load) | SM-A |
| **M17 subs-tracks** | SM-C exposes every embedded track with language and forced flags; a `Show - 02.srt` beside `[Group] Show - 02 [1080p].mkv` **is** picked up (the mpv-fuzzy gap); `subs/` subfolder is scanned (the semicolon fix) | SM-C, SM-J |
| **M18 subs-formats** | **SM-F is the acceptance test**: the multi-language SMI yields **two** selectable tracks and the Korean line is visible; the malformed copy loads instead of silently rendering nothing; forcing `+cp1252` produces mojibake and switching back fixes it | SM-F |
| **M19 subs-style** | on SM-C with `sub-ass-override=no`, typeset signs stay where the release put them; with `force`, our font applies; with a PGS track selected the font controls are **greyed, not ignored** | SM-C, SM-G |
| **M20 subs-sync** | snap-sync on a deliberately +2 s desynced SRT lands the line on the current frame; `sub-speed=25/23.976` fixes progressive drift on the frame-based sample, and `sub-fps` demonstrably does **not** | SM-J |
| **M21 subs-browser** | the browser lists every line of an external SMI and clicking row 200 seeks there within one frame of its start, **with a non-zero `sub-delay` applied** | SM-F |
| **M22 capture-still** | a PNG from SM-A is 8-bit and under ~1 MB (the high-bit-depth fix); the toast's "open folder" reveals exactly the file mpv reported; clipboard paste works in Paint | SM-A |
| **M23 capture-encode** | export a 10 s clip with burnt-in subtitles and play it back in another player; cancel a 5-minute export and confirm the child process is gone from Task Manager | SM-C |
| **M24 nav-seek** | **10 consecutive backward frame steps land on 10 distinct, consecutively decreasing timestamps** (the async-reply trap); holding the key does not queue more than one outstanding step; the buttons grey out on an audio-only file | SM-A, SM-I |
| **M25 nav-chapters** | ticks appear at the right positions on SM-C; pressing prev-chapter 2 s into a chapter goes to that chapter's start (threshold behaviour); the edition menu is **hidden**, not "0 editions", on SM-A. **N51:** set intro start/end on episode 1 of a **chapterless** 12-file folder, then confirm episodes 2–12 offer the skip at the same offsets, that the OSD names what was skipped, and that `revert-seek` undoes it. Off by default, verified by a fresh-profile run | SM-C, SM-M, 12-file folder |
| **M26 nav-bookmarks** | a bookmark survives an app restart and a file **rename in place** (or does not — whichever §7.9 decides, but the behaviour must be the documented one); A-B clear sets the string `"no"` and the UI does not show 0:00 | SM-B |
| **M27 nav-thumbnails** | hovering the seek bar shows a frame in **under 50 ms** on SM-B; the thumbnailer process dies 60 s after the last hover; no thumbnailer is spawned for an audio-only file or a URL | SM-B, SM-L |
| **M28 playlist** | open episode 3 of a 12-file folder: order matches Explorer exactly (screenshot diff), position is 3/12; EOF advances; **a decode error does not advance** (truncate a file to force one). **L47:** double-click a `.jpg` from Explorer and it **opens and displays** rather than doing nothing — the specific failure P30's image category would otherwise ship. **L50:** opening one episode out of a 400-file mixed folder queues the ~12 siblings sharing its prefix, not all 400 | 12-file folder, an image folder |
| **M29 mediainfo** | the panel reports the same codec string as MediaInfo for SM-C and SM-D; "copy info" output pasted into an issue contains `hwdec-current` and `current-vo` | SM-C, SM-D |
| **M30 history** | finishing a file removes it from resume but leaves a ✓ in history; "clear history" leaves zero rows and an empty file on disk | SM-B |
| **M31 shell-window** | window size, monitor and maximised state survive a restart **and** a monitor unplug-replug; fullscreen on monitor 2 works from monitor 1; cursor hides after 1.5 s but never while over the control bar | dual-monitor rig |
| **M32 shell-taskbar** | thumbar buttons appear and the play/pause glyph swaps; taskbar progress tracks playback; jump list entries **launch** rather than erroring (the `fileTypeRegistrationError` trap) | SM-B |
| **M33 shell-system** | display does not sleep during a 20-minute video but **does** during a 20-minute MP3; dropping a folder on the exe opens it; `--new-instance` opens a second window while single-instance is on | SM-B, SM-L |
| **M34 shell-associations** | register, then confirm RLPlayer appears in Windows Settings → Default apps; unregister, then confirm `reg query` finds none of the eight keys; portable build shows the section disabled | packaged build |
| **M35 stream-open** | SM-O plays; the buffered region is drawn on the seek bar; `av://` pasted into the URL box is **rejected**; pulling the local server mid-play shows "stalled", not a frozen frame | SM-O |
| **M36 stream-ytdl** | with the feature off, a 60 s network monitor shows zero outbound connections **even though `--ytdl=yes` was passed** (proves the `exclude=.*` design); with it on and yt-dlp absent, the failure toast names the missing binary | — |
| **M37 disc-devices** | webcam enumeration lists the machine's real devices; DVD folder playback shows titles as editions. Menu navigation is **blocked on §7.2** and must not be claimed until the pin moves | SM-R |
| **M38 settings-ui** | searching `ㅎㄷㅇ` finds 하드웨어 가속; searching `hwdec` finds it too; every descriptor in the registry is reachable from the UI (assert count in a test) | — |
| **M39 input-ui** | rebind fullscreen to a key already used, confirm the conflict UI appears and resolving it updates both rows; the cheat sheet prints on one page | — |
| **M40 transfer** | export on machine A, import on machine B: settings and keybinds match; an imported `mpv.conf` containing `scripts=evil.lua` shows that line as excluded and never reaches mpv | two profiles |

### 6.4 Cross-cutting checks run at every release

1. **Compat layout parity.** Every P0 feature must be exercised once with
   `layoutMode: 'compat'`. The two documented exceptions (video area not clickable, chrome
   does not auto-hide) are the only permitted differences.
2. **DPI.** Run the P0 checklist at 100%, 150% and 200% scaling, and drag the window
   between two monitors with different scale factors mid-playback.
3. **Korean IME on.** Run the keyboard portion of the checklist with 한/영 set to Korean.
4. **Cold start under 300 ms to first frame** on SM-A (the `docs/01` target).
5. **Unpacked size under 80 MB.**

---

## 7. Risk register

Ordered by expected cost. Each entry states who owns it and what would retire it.

### 7.1 The top three

| # | Risk | Impact | Owner | Mitigation / what retires it |
|---|---|---|---|---|
| **R-1** | **Electron transparent-window black screen (issue #40515).** A minority of Windows GPU/driver combinations render `transparent: true` windows black. The only upstream workaround is disabling hardware acceleration, which is unacceptable for a video player. **Every renderer feature in this spec is affected** — if the overlay is black, the whole UI is gone. | Catastrophic for affected users; unknowable share | core / M31 | Compat layout already exists and is selectable in settings. **Retire by:** (a) making the setting reachable *without* the overlay (a CLI flag `--layout=compat` and a tray/menu entry on the main window), (b) auto-detecting a black overlay at first run and offering the switch, (c) running the §6.4 compat parity checklist every release so compat never rots into a broken second-class mode. |
| **R-2** | **`--wid` renders most of mpv's window API inert, and the failure is silent.** Verified in `w32_common.c`: `--border`, `--title-bar`, `--show-in-taskbar`, `--fullscreen`, `--ontop`, `--snap-window`, `--window-minimized`, `--window-maximized`, `--window-affinity`, `--window-corners`, backdrop, cursor-passthrough, IME, transparency and the whole geometry family (`--geometry`, `--autofit*`, `--window-scale`) all early-return or return `VO_FALSE` when a parent is set. `--taskbar-progress` paints on a child HWND with no taskbar button. | High: an implementer can spend a day on code that looks correct and does nothing | core/mpv bus | **Retire by** a hard-coded reserved-option list in `core/mpv/reserved.ts` that **throws at boot** if any module contributes one of these args, plus this table reproduced in the module README. Cheap, and it converts a silent no-op into a build failure. |
| **R-3** | **Volume boost is measurably broken today and the fix changes stored values.** mpv applies `volume`/`volume-gain` **after** the af chain, so the current `applyBoostFilter()` (volume 150 + limiter in `af`) is a no-op; measured peaks confirm it. Separately, mpv's volume percentage is **cubic** (150% = 3.37× = +10.6 dB), so the OSD number has always been misleading. | High: audible clipping today; fixing it changes what every stored `volume` value sounds like | M10 | Move all boost into `@rlboost` with `--volume-max=100`; add the §6.3 M10 signal-level regression test. **Open decision:** migrate stored `volume` through the cube-root curve, or reset to 100 once on upgrade. Recommend migrate, with a one-time toast. |

### 7.2 Version-dependent (the pinned mpv build decides these)

| Feature | Status in the pinned build | Consequence |
|---|---|---|
| DVD / Blu-ray **menu navigation** (`--disc-menu`, `discnav`, `disc-menu-active`) | **Absent.** Present in mpv master as of 2026-08-28. | R28 cannot ship without bumping the pin. The exact introducing commit was not identified — **find it before pinning**, and treat an engine bump mid-project as a full regression pass (§6.2 + §6.3 for M01–M09 at minimum). |
| libcurl network backend (`--curl-*`) | **Present** | R11 is available. It is new enough that it is easy to miss it exists. |
| `all_formats` / `force_all_formats` default `true` in `ytdl_hook` | **Present, both true** | R08's quality menu is nearly free — but the default has changed historically, so **pass both explicitly** rather than relying on it. |
| `rubberband` / `rubberband-3` | **Both present** | A23's R3 engine is available. |
| GPL build (`gpl` in feature list, `-Ddvdnav=enabled -Dlibbluray=enabled`) | **Yes** | See R-4 below. |
| `uchardet` | **Present** | S33 works. **Add a startup assertion** — if the build is ever swapped for one without it, Korean subtitles silently become mojibake with no error. |

### 7.3 External binaries, licensing and bundle size

| # | Risk | Assessment |
|---|---|---|
| **R-4** | **GPL vs LGPL mpv build.** The pinned build reports `gpl` and was built with dvdnav and libbluray. An LGPL build (`-Dgpl=false`) **loses DVD and CDDA entirely**, and the encode-mode codec list collapses to AAC/Opus/VP9/AV1 — no libx264, libx265 or libmp3lame. | This decides M23's entire preset table and whether M37 exists at all. `docs/01` open question #1 has never been closed. **It must be closed before M23 starts.** Our MIT licence survives either way because mpv is a separate process exchanging data, not code (`docs/03`) — the question is purely which features the engine has. |
| **R-5** | **ffmpeg is NOT needed.** Verified: mpv encode mode covers clip export, GIF, animated WebP, contact sheets, burst frames and audio extraction. | Good news, recorded so nobody re-adds an 80 MB dependency. The single exception is S43 (extract an embedded subtitle to disk), which we therefore **do not ship** except opportunistically against an ffmpeg already on PATH. |
| **R-6** | **yt-dlp is GPLv3+ as a published binary** (source is Unlicense; the PyInstaller `.exe` bundles GPLv3+ code). Its extractors break when sites change, on a bursty roughly-monthly cadence. | **Never bundled.** Optional, user-initiated download to `<userData>/tools/`, self-updating via `--update-to nightly`, and the update prompt appears **only** at the moment of an actual extraction failure. This is simultaneously the licensing-safe, no-bundled-junk and no-nag answer. |
| **R-7** | **MediaInfoLib licence unverified** (believed BSD-2-Clause since ~v19.04). | L44 is P2 and the recommendation is to skip it. If anyone revives it, verify against the LICENSE file in the shipped release, not from memory. |
| **R-8** | **A native addon may become necessary** for Aero Snap (`WM_NCLBUTTONDOWN`), `SHChangeNotify` and the shell property sheet — and it would also unlock SMTC. | Each currently has a PowerShell or JS workaround. Adding an addon means a prebuild matrix (x64 + arm64) and complicates the reproducible-build promise. **Decide once**, for all four — five, with A51 system volume — rather than per feature (**§7.9 D-4**). |
| **R-9** | **Bundling a font for `drawtext`.** C10's contact sheet needs an explicit `fontfile=` (no fontconfig in this build) referenced *relatively* from the job's cwd. | Alternative: compose the sheet in a hidden `<canvas>` — better typography, correct Korean glyphs, no font-licence question, at the cost of N seek+screenshot round-trips instead of one decode pass. **Recommendation: canvas for the header, `drawtext` only for per-tile timestamps.** |

### 7.4 Mappings the researchers could not verify

These must be tested by the owning implementer **before** any UI is built on them.
**R-10, R-11 and R-18 have been settled by measurement and are struck through below**;
they are left in place, crossed out, rather than deleted, so that anyone who read the
earlier revision can see the answer instead of wondering whether the row was dropped by
accident. **C22's capture-key uncertainty is likewise settled** — 8/8 correct against
PotPlayer's own string table — and its note has been removed from that row.

| # | Uncertain mapping | Owner | How to settle it |
|---|---|---|---|
| ~~R-10~~ | **SETTLED — retired from this table.** `v360` **does** implement `process_command`: `["vf-command","rl-360","yaw","20","v360"]` → `success`. | M09 | **V38 drops `lg` → `sm` and the bundled-GLSL-shader plan is deleted.** Residual, and it is a measurement not an unknown: v360 rebuilds its projection maps per command, so measure the frame cost before promising smooth dragging. |
| ~~R-11~~ | **SETTLED — retired from this table.** Measured with the correct four-argument form: `cas` ✓ · `eq` ✓ · `hqdn3d` ✓ · `deblock` ✓ · `v360` ✓ · **`unsharp` ✗** (`error running command`). And the arity is **four** arguments, not three — the three-argument form fails for every filter. | M03, core/vf-chain | **`unsharp` (V08) is the only enhancement filter that must rebuild its graph per slider tick**, which is why V09's "make CAS the default and hide unsharp behind classic" is now load-bearing rather than stylistic. The refuser table lives in `core/vf-chain` (§5.5), not in nine modules. |
| **R-12** | Is `qsv` / `qsv-copy` functional in this build, or merely accepted by the option parser? `--hwdec=help` lists it; the upstream manual does not document QSV on Windows. | M07 | Test on Intel hardware. If non-functional, remove it from the dropdown rather than shipping a decoder that silently falls back. |
| **R-13** | Bitstream passthrough end to end (AC-3/DTS-HD/TrueHD/Atmos over HDMI). The option parses and the `aid` reinit round-trip works, but no receiver was available. | M15 | Requires SM-Q hardware. **Do not claim passthrough support in release notes until someone signs off with a receiver.** Also confirm whether the `aid no → aid N` round-trip is enough to toggle it without reloading the file. |
| **R-14** | The correct RTSP timeout key/unit for libavformat 63.6.100. mpv's `--network-timeout` is documented as broken for RTSP; the workaround is `--demuxer-lavf-o`, but the `timeout` vs `stimeout` and seconds-vs-microseconds question is exactly what the warning is about. | M35 | Test against a real IP camera before exposing any RTSP timeout control. |
| **R-15** | `.dpl` `duration2` — seconds or milliseconds? The reference implementation says seconds; real PotPlayer files look like milliseconds. | M28 | PotPlayer is installed on the dev machine: save one `.dpl` and look. Blocks a confident importer, which is our best interop win with a switcher's existing files. |
| **R-16** | Does mpv pass `CREATE_NO_WINDOW` when `ytdl_hook` spawns `yt-dlp.exe`? | M36 | If not, every YouTube URL flashes a console window — very visible. Test before shipping R05. |
| **R-17** | Does the taskbar thumbnail contain mpv's D3D11 flip-model surface, or black? | M32 | Prototype U29 before promising it. The same answer decides whether the plain hover preview shows video at all. |
| ~~R-18~~ | **SETTLED — retired from this table. Yes, `dw`/`dh` DO account for `video-rotate`.** Measured: 320×240 source, `set video-rotate 90` → `video-out-params` reports `dw:240, dh:320`. | M31 | **No dw/dh swap logic is needed anywhere.** U13, U14, U15, U16 and V58 are unblocked as written. Keep SM-K in the sample set as a regression guard, not as an open question. |
| **R-19** | Electron `nativeImage.createFromBitmap` channel order for the thumbnailer's BGRA buffer. | M27 | Test with a known-red frame. If the preview comes out blue, that is the swizzle. |
| **R-20** | OpenSubtitles free-tier daily download quota. | M21 | **Do not settle it — design around it.** Never hardcode a number; read `remaining` and `reset_time` from the `/download` response body and display those verbatim. Treat HTTP 406 as exhausted. |
| **R-21** | Does the CPU cost of lavfi filters make the enhancement group a real feature or a trap? Every lavfi filter forces hwdec frames back to system RAM. | M03 | Measure denoise on a 4K HDR file with `hwdec=d3d11va`: unwatchable, or merely a warm laptop? This determines whether the whole enhancement panel ships. |

### 7.5 The `--wid` inert-option list (reproduce this in every module README)

`--border`, `--title-bar`, `--show-in-taskbar`, `--fullscreen`, `--fs-screen`,
`--fs-screen-name`, `--ontop`, `--ontop-level`, `--snap-window`, `--window-minimized`,
`--window-maximized`, `--window-affinity`, `--window-corners`, `--window-scale`,
`--geometry`, `--autofit`, `--autofit-larger`, `--autofit-smaller`, `--keepaspect-window`,
`--title`, `--cursor-autohide`, `--input-cursor`, `--hidpi-window-scale`, dark-mode and
backdrop handling, native touch, IME. Plus `--taskbar-progress`, which is live but paints
on an HWND with no taskbar button. **Setting any of these appears to work and does
nothing.**

### 7.6 Architectural decisions deliberately left as-is

| Decision | Why we are not changing it now |
|---|---|
| The app owns the playlist; mpv's playlist always has one entry | Keeps Explorer sort order, per-file resume, multi-select, non-destructive shuffle and undo. Cost: `--prefetch-playlist` is a no-op and there is a ~200 ms gap between episodes (L41). Revisit **only** if users complain about the gap specifically. |
| Two windows (overlay) rather than `mpv_render_context` | Settled in `docs/03`. The render API would enable host-drawn overlays over the video and a cleaner PiP, but it has no D3D11 backend (mpv#5979, open since 2018). |
| Separate mpv process over JSON IPC rather than linked libmpv | This is what keeps the MIT licence intact. It also permanently forecloses `screenshot-raw` (C03). |
| `--no-config` | Predictable behaviour and no accidental user-config interference; the cost is that mpv-side profiles and `profile-cond` auto-profiles are unavailable (V45, V54), which is why those are implemented app-side. |

### 7.7 Implementation traps worth a second mention

1. **A Windows absolute path cannot appear inside a lavfi option.** Verified three ways.
   Every offline job stages its font/palette into `paths.tempJobDir(jobId)` and spawns with
   `cwd` set, referencing bare relative filenames.
2. **`loadfile`'s third argument must be `-1`** when passing the fourth options map.
   Without it the command **hard-errors** (`{"error":"invalid parameter"}`) — it does
   **not** silently drop the map, as an earlier revision said three separate times. The
   difference costs debugging time: told to expect silence, you will not check the reply,
   you will see the file not load at all, and you will look for the bug somewhere else.
3. **`frame-step` replies before it moves.** Drive the UI from the observer.
4. **`af-command` AND `vf-command` need four arguments**, the last being the lavfi
   **filter name** — not the label, not `'all'`. Both sides, same shape. `unsharp` refuses
   `vf-command` outright and must be rebuilt instead (V08).
5. **`screenshot-raw` kills mpv over JSON IPC.**
5b. **`screenshot` returns a BARE RELATIVE FILENAME unless `screenshot-directory` is
   set first** — `{"filename":"mpv-shot0002.jpg"}`, resolved against mpv's cwd. Every
   capture row that consumes the reply path depends on M22 having written that property at
   `setup()` (C01). Assert `path.isAbsolute` on the reply.
5c. **`screenshot` with `scaled` or `window` fails when there is no window-backed VO** —
   audio-only with the video window hidden (A38) and tray-only mode (U39) are both shipped
   states where it returns `error running command` while `video` succeeds (C04).
6. **`--sub-file-paths` uses `;` on Windows**, and case-variant entries create duplicate
   tracks on NTFS.
7. **Clearing an A-B point yields the string `"no"`**, not a number.
8. **`editions` is `undefined`, not `0`, on non-Matroska files.**
9. **Building `\\.\pipe\name` through templating silently eats backslashes.**
10. **DIP vs device pixels:** Electron geometry is DIP, `video-out-params/dw` is real pixels.

### 7.8 Product-level risks

| Risk | Mitigation |
|---|---|
| **Scope creep back toward parity.** 126 P2 features are a standing temptation, and each one is permanent maintenance on a project whose pitch is that it stays small. | The P2 list is a *backlog*, not a roadmap. Adding a P2 feature should require deleting one or arguing it into P1 in writing. |
| **The two network features erode the zero-network promise by accretion.** | Both are off by default, both behind explicit consent, and `test:network-zero` runs on every release. Any third network feature needs an explicit product decision, not a PR. |
| **Korean-market assumptions may not survive contact.** IPTV/OTA TS streams are a heavy PotPlayer use case in Korea; if that turns out to be a priority, R22's mpegts probing work moves from P1 to P0. | Ask before Wave 1 ends; it is a one-row priority change, not a redesign. |
| **PotPlayer keybind preset accuracy — understated by a factor of three.** An earlier revision said "three bindings are wrong". Checked against PotPlayer's own shipped `English.ini` `[MenuString]` table, `src/shared/keybinds.ts`'s `POTPLAYER_PRESET` has at least **ten** wrong entries: `F`→fullscreen (PotPlayer: **F = next frame**; fullscreen is **Enter**) · `D`→frameForward (PotPlayer: **D = previous frame**) · `,`/`.`→frame step (PotPlayer: **subtitle sync ±**) · `S`→screenshot (PotPlayer: **S = Pixel Shaders menu**) · `L`→togglePlaylist (PotPlayer: **L = Add/Select Subtitles**; playlist is **F6**) · `T`→alwaysOnTop (PotPlayer: **Ctrl+T**) · `Home`/`End`→seekStart/seekEnd (PotPlayer: **previous/next subtitle position**; start-of-file is **BackSpace**, see N52) · `Ctrl+Q`→quit (PotPlayer: **Ctrl+Q = Extend/Crop Video**). Only `M`, `C`, `X`, `Z`, `Ctrl+C` and `Escape` are right. **The capture keys, by contrast, are settled and 8/8 correct** (C22). | Re-derive the whole `potplayer` preset from `English.ini` rather than patching it entry by entry, and diff the result against the current table in a test. Getting muscle memory *wrong* is worse than not shipping the preset. **Unresolved and needing a person: N33 binds `1`–`9` to percent-seek, while in PotPlayer `` ` 1 2 3 4 5 6 7 8 9 0 `` are window sizes (`101_0_19`).** P15's conflict detector is scope-aware inside our own registry but cannot know the `potplayer` preset is claiming keys N33 also wants — someone must resolve that by hand before the preset ships. |

### 7.9 Open decisions that must be made by a person, not discovered in code

| # | Decision | Recommendation |
|---|---|---|
| **D-1** | GPL or LGPL mpv build (R-4) | GPL. It is what the pinned build already is, our licence analysis holds either way, and LGPL costs DVD, CDDA, x264, x265 and mp3lame. |
| **D-2** | File identity: keep `path + size`, or add mtime, or add a content-shape index? Today a renamed **or** moved file loses its resume *and* its bookmarks, and a same-size re-encode at the same path wrongly keeps them. | Add a secondary `size + duration` index so a moved file can be recovered, but keep `path + size` as the primary key. Do **not** add mtime — it invalidates on every touch. |
| **D-3** | Stored `volume` migration when A06 lands | Migrate through the cube-root curve with a one-time toast, rather than resetting to 100. |
| **D-4** | One native addon for Aero Snap + `SHChangeNotify` + shell properties + SMTC, or PowerShell/JS workarounds throughout? | Ship v1.0 with workarounds; revisit as a single addon decision for v1.1. It is the difference between "correct" and "no build dependency", and it should be made once. |
| **D-5** | Thumbnailer lifecycle: lazy-on-first-hover (cheap at rest, first hover slow) or eager-on-file-load (instant, always ~50 MB)? | Lazy + 60 s idle kill. Confirm against the "lightweight" positioning. |
| **D-6** | Does the thumbnailer mirror the main instance's crop and filter chain? | No for v1.0. It is more correct (a cropped 2.35:1 video otherwise previews with the bars back) but it couples M27 to M02's state. |
| **D-7** | Should mpv's `--include=mpv.conf` passthrough (P06) be linted for dangerous keys even when the user wrote it themselves, or only on import (P44)? | Only on import. It is the user's own file; warn in the editor, do not censor. |
| **D-8** | Do we register an OpenSubtitles API consumer under the project name (key ships in the binary, revocable) or require each user to paste their own? | Project key, with a "Login…" button for the user's own account, matching PotPlayer. Revisit if it gets revoked. |
| **D-9** | Portable marker: `portable.txt` (current) or `portable_config/` (mpv convention)? | Accept both. One extra `existsSync`. |
| **D-10** | Default capture folder in portable mode: `<Pictures>/RLPlayer` or `<exeDir>/Capture`? | `<exeDir>/Capture` in portable mode only. It matches the leave-no-trace promise and PotPlayer's own habit. |
| **D-11** | **N51 skip intro/ending: how far do we go?** Manual set points only, plus learned offsets, or also audio-fingerprint detection across a folder? | Ship (1) manual set points and (2) learned offsets in the P1 row — they are deterministic, cheap and always correct-by-construction. Treat (3) fingerprinting as a separate opt-in `md` on top that **proposes and never applies**. A wrong automatic skip is a worse bug than no skip at all, and this feature's whole audience is people watching something for the first time. |
| **D-12** | **Do we ship image playback (L47), or drop the image category from P30 (§2.9)?** | **Ship L47.** The previous revision did the second half of a feature it never specified: it registered `.jpg` in the Default Apps picker with no defined behaviour behind it. Of the two coherent options — implement it, or say in §1.3 that we are not an image viewer — implementing is cheap (mpv already decodes images through `loadfile`; `--image-display-duration` exists) and the association picker keeps images **unchecked by default** either way. |

---

## Appendix A — reserved namespaces

| Namespace | Owner | Rule |
|---|---|---|
| `rl-*` vf labels, `rl*` af labels | `core/vf-chain` / `core/af-chain` | Declared in §5.5. Unregistered labels throw at boot. |
| `<feature-id>.` | that module | settings ids, command ids, i18n keys |
| `<feature-id>:` | that module | IPC channels |
| `--wid`, `--input-ipc-server`, `--no-config`, `--input-*`, `--osc`, `--osd-*`, `--vo`, `--gpu-context` | core/mpv bus | modules contributing these throw at boot |
| **every writable mpv property** | the single module named in **§3.7** | `ctx.mpv.set()` rejects a write from any other module and names the owner; two modules claiming one property is a **boot error**; `docs/parity/modules.json` carries the same map and CI cross-checks the two |
| **spawn option names** | first (and only) contributor | duplicate option names across contributors throw at boot, core-owned or not; the additive `*-append` options are the only allowlisted exception |
| `src/main/windows.ts`, `src/main/player.ts` | `core/window`, `core/legacy-bridge` | no feature module imports either; CI greps `src/main/features/**` for both |
| `player:*`, `playlist:*`, `config:*`, `window:*`, `system:*`, `ui:*` | existing core IPC | frozen; feature modules use their own namespace |

## Appendix B — quick reference: features by module

Counted from §2 after deduplication, so these numbers reconcile exactly with §1.1. Rows
moved to another area under §1.5 are counted **once**, in the owning area. The 16 rows
added from the completeness critique are marked in the "added" column.

| Area (§) | Rows | added | P0 | P1 | P2 | skip | Owning modules |
|---|---:|---:|---:|---:|---:|---:|---|
| 2.1 Video | 58 | 2 | 11 | 18 | 29 | 0 | `core/vf-chain`, M01–M09, M29 |
| 2.2 Audio | 49 | 1 | 8 | 20 | 20 | 1 | `core/af-chain`, M10–M16, M29, M33 |
| 2.3 Subtitles | 52 | 3 | 15 | 18 | 14 | 5 | M17–M21, M23 |
| 2.4 Capture | 24 | 1 | 3 | 14 | 7 | 0 | M22, M23 |
| 2.5 Navigation | 50 | 3 | 16 | 18 | 16 | 0 | M24–M27, M28, M30, M33, `core/per-file` |
| 2.6 Playlist & media info | 49 | 4 | 12 | 19 | 18 | 0 | M27, M28, M29, M30 |
| 2.7 UI, window, OSD, shell | 47 | 2 | 12 | 21 | 13 | 1 | `core/osd`, `core/window`, M29, M31–M34, M38 |
| 2.8 Streaming & external | 33 | 0 | 4 | 15 | 11 | 3 | M29, M34, M35–M37 |
| 2.9 Preferences & portability | 60 | 0 | 34 | 21 | 5 | 0 | `core/settings`, `core/input`, `core/i18n`, `core/paths`, `core/per-file`, M11, M17, M22, M31, M33, M34, M38–M40 |
| **Total** | **422** | **16** | **115** | **164** | **133** | **10** | 40 feature modules + 15 core pieces |

Cross-check against §1.1: 115 + 164 + 133 + 10 = **422** ✓ · backlog 422 + declined and
infeasible register 74 = **496**, the denominator · parity numerators 99 (P0) and 254
(P0+P1) after removing the 25 infrastructure rows §1.1 names individually.

**Machine-readable form: `docs/parity/modules.json`.** Every module in the table above
appears there with its owned properties, owned files, feature rows, dependencies and
must-not-touch list. Three invariants hold and are asserted by `test:property-ownership`:
every id in a `dependsOn` exists, **no property is owned twice**, and **no file is owned
twice**. The implementation fan-out is driven off that file, not off this table.

Several modules appear in more than one area because a feature's *owner* is decided by
which mpv property it writes, not by which researcher inventoried it — M29 `mediainfo`
collects stats sections from five areas, and M34 `shell-associations` owns one streaming
row (`rlplayer://`) because it is a registry write.
