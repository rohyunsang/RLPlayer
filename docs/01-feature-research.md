# FreeViewer — Feature Research & Prioritized Specification

> Research doc v1. Target: a free, open-source, no-nonsense Windows desktop video player
> that a PotPlayer user can switch to without feeling downgraded — and without ads,
> nag screens, bundled junk, or telemetry.
>
> Last updated: 2026-08-28

---

## Executive Summary

1. **Do not write a decoder or renderer.** Build the playback engine on **libmpv** (embeddable mpv) and put a real native Windows GUI on top. That single decision delivers ~70% of the P0 table for free: FFmpeg demux/decode, D3D11VA/DXVA2/NVDEC/QSV hwdec, libass ASS rendering, watch-later resume, A-B loop, screenshots with/without subs, WASAPI exclusive + bitstream passthrough. This is the path IINA, Celluloid, Haruna and mpv.net took.
2. **The gap in the market is not codecs, it is the GUI.** VLC is criticized for a dated, badly-organized UI; mpv is criticized for having effectively no GUI and a manual that reads as a lookup table. PotPlayer won on Windows because it was a good GUI over a good engine — then lost trust over ads and bundling. FreeViewer's reason to exist is "PotPlayer's UX, mpv's engine, nobody's adware."
3. **Ship-blocking (P0) is smaller than it looks:** open/play everything, seek well, subtitles that just work (auto-load + delay + ASS fidelity), audio/subtitle track switching, resume-from-position, a naturally-sorted playlist, remembered window state, single-instance, remappable keys, portable mode.
4. **The differentiator is negative-space engineering:** no updater process, no telemetry, no first-run "recommendations", no installer checkboxes, no bundled codec pack, a portable ZIP that never touches the registry unless asked. This must be a written, testable product guarantee — not a README claim.
5. **Two features punch far above their cost:** resume-from-last-position and natural sort for episode numbers. Both cheap; both are what make a player feel "mine".
6. **Two features are unexpectedly expensive and belong in P1:** thumbnail seek preview (needs a second decode pipeline) and refresh-rate matching (needs display-mode switching and GPU-driver edge cases).
7. **Keybindings must be data, not code, from commit one.** PotPlayer and mpv conventions genuinely conflict (`F`, `Q`, `PgUp`, `[`/`]`, `<`/`>`). Ship three presets — Default / PotPlayer-compatible / mpv-compatible — plus a remap UI. This dissolves an argument you cannot otherwise win.
8. **You cannot programmatically claim file associations on Windows 10/11.** Design onboarding around opening the Windows "Default apps" page, not a registry hack that will read as hijacking.
9. **Accessibility is P1 but architecturally P0:** a custom-drawn canvas with no UI Automation tree makes screen-reader support a later rewrite. Use a UI framework with a real accessibility tree.
10. **Scope discipline:** 3D output, TV tuners, screen recording and a media library are all things PotPlayer has and nobody switching to FreeViewer will miss on day one. P2 or never.

---

## Architecture Recommendation (drives every "impl note" below)

| Decision | Recommendation | Rationale |
|---|---|---|
| Playback engine | **libmpv** (`mpv-2.dll`), driven via `mpv_command` / `mpv_set_property` / property observers | Gets FFmpeg, libass, hwdec, watch-later, ab-loop, screenshots, audio filters, WASAPI passthrough in one dependency |
| Video surface | `mpv_render_context` with the **D3D11 / ANGLE-OpenGL** render API composited into the app swapchain — **or** `--wid` native window embedding for v0.1 | `--wid` is ~30 min of work and correct for v0.1; the render API is required later for host-drawn overlays, PiP, and thumbnail compositing |
| GUI framework | Native Windows framework with a real UI Automation tree (WinUI 3 / WPF / Qt Widgets). **Not** a custom-drawn canvas, **not** Electron | Accessibility, Windows text scaling, dark mode, small install size and fast startup all follow from this |
| Config format | Human-readable text (TOML/INI/JSON) in a single directory; **portable mode = config dir sits beside the exe** | PortableApps convention: self-contained, no registry writes |
| License | GPLv2+ is the low-friction choice (matches a GPL FFmpeg/mpv build). For LGPL, build FFmpeg **without** `--enable-gpl` and use an LGPL mpv build — verify per component; this is a real constraint, not a formality | Must be settled before the first release, not after |

---

## P0 — Ship-blocking (v0.1)

**Definition of done: a PotPlayer user can uninstall PotPlayer, use FreeViewer for a week of normal local-file viewing, and not hit a wall.**

### Playback core

| Feature | Why | Implementation note |
|---|---|---|
| Containers: MKV, MP4/M4V, AVI, WMV/ASF, MOV, TS/M2TS, WEBM, FLV, OGV, 3GP | These are the actual files on a Windows disk. MKV + MP4 are ~90%; TS/M2TS is broadcast rips; AVI/WMV is the 2005 archive nobody deletes | Free with libmpv. Do **not** ship a codec pack or register DirectShow filters |
| Video codecs: H.264, HEVC/H.265 (8/10-bit), AV1, VP9, VP8, MPEG-2, MPEG-4 ASP (Xvid/DivX), WMV3/VC-1, ProRes | HEVC is the 4K default; AV1 is now the web/streaming default; ProRes appears for anyone touching editing output; MPEG-2 for DVD rips | libmpv/FFmpeg. **Ship your own FFmpeg** — never depend on the Microsoft Store HEVC/AV1 extensions, a top complaint about the built-in Windows player |
| Audio codecs: AAC, AC-3, E-AC-3, DTS, DTS-HD, TrueHD, FLAC, Opus, Vorbis, MP3, PCM, ALAC, WMA | AC-3/E-AC-3/DTS are what movie rips carry; Opus/FLAC are what modern encodes carry | Free with libmpv |
| Hardware decode, auto-selected, with a **visible on/off toggle** | 4K HEVC/AV1 is unwatchable on many laptops without it; hwdec is also the #1 cause of green frames / black video, so disabling must be one click | `hwdec=auto-safe` (prefers `d3d11va`, falls back `dxva2` / `nvdec` / `vulkan`). **Show the selected decoder in the stats overlay** so bug reports are actionable. Put "Force software decoding" in the Video menu, not buried in settings |
| Software fallback that never fails silently | If hwdec breaks, degrade to software rather than show a black window | Observe `hwdec-current`; if no video frames arrive within N seconds of load, auto-retry with `hwdec=no` and surface a one-line OSD notice |
| Smooth file transitions inside a playlist | Binge-watching a season | `--prefetch-playlist=yes` |
| Tolerant handling of broken/partial files | Half-downloaded MKVs, truncated recordings | FFmpeg is already tolerant; make the UI show "playing with errors" instead of refusing to open |

### Playback controls

| Feature | Why | Implementation note |
|---|---|---|
| Seek bar: click-to-seek, drag-to-scrub with live frame update | Baseline expectation | `seek <t> absolute+keyframes` while dragging, `absolute+exact` on release. Keyframe seek during drag is what makes scrubbing feel instant |
| Keyboard seek ladder: ±5s / ±1s precise / ±30s | 5s = "missed a line", 1s = subtitle alignment, 30s = "skip the intro" | ±1s must be `exact` (decode-accurate); the others `keyframes`. Mixing these up is why some players feel imprecise |
| Frame step forward **and backward** | Screenshot hunting, frame comparison. Backward step is where cheap players give up | `frame-step` / `frame-back-step`. Back-step needs a decoded-frame cache — libmpv has it; without libmpv this is genuinely hard |
| Speed 0.25×–4.0× with pitch-corrected audio | Lectures/podcasts at 1.5×, action review at 0.5×. Chipmunk audio is a dealbreaker | `speed` property; keep `audio-pitch-correction=yes`. Always show current speed in the OSD when ≠ 1.0 |
| A-B repeat (set A → set B → clear) | Language learning, music practice, technique review — a genuinely used PotPlayer feature | `ab-loop-a` / `ab-loop-b`. One key cycles the three states. **Draw the loop region on the seek bar** |
| Chapters: list, jump, prev/next | MKV rips and anime carry OP/ED chapters; skipping the intro is a daily action | `chapter-list` property; render chapter ticks on the seek bar — the visible half of the feature, and the half usually skipped |
| **Resume from last position** | Highest value-to-cost feature in this document. Losing your place is the most common reason a player feels hostile | Store `path-hash → {position, audio track, sub track, sub delay, speed}` in a small SQLite/JSON store. Rules: don't save if <60s watched; **don't save within the last 5% or last 90s** (you finished it — mpv shipped this exact fix); resume silently with a dismissible OSD toast ("Resumed at 41:12 — Backspace to restart"), never a modal dialog |
| Playback history (recently-played list in the menu) | "What was that file called" | Same store as resume; a plain list view suffices for v0.1 |
| Stop / close returns to a usable idle window | Not a black void | Idle screen = recent files + drop target |

### Subtitles

| Feature | Why | Implementation note |
|---|---|---|
| Formats: SRT, ASS, SSA, VTT, SUB/IDX (VobSub), PGS/SUP, MicroDVD | SRT + ASS cover almost everything; VobSub/PGS come from DVD/BD rips and are image-based, so they need a different render path | libmpv handles all. Image subs cannot be restyled — **grey out font settings** when one is active rather than silently ignoring them |
| Embedded track enumeration + switching, showing **language and track title** | "Signs & Songs" vs "Full Subtitles" is the difference between a usable and a useless menu. MPC-HC is specifically praised for exposing track metadata | `track-list` gives `lang`, `title`, `default`, `forced`. Render `[eng] Full Subtitles (ASS)` — never `Track 3` |
| External auto-load with **exact + fuzzy** matching | The #1 subtitle complaint. `Movie.srt`, `Movie.en.srt`, `Movie.eng.forced.ass`, and `Subs/Movie.srt` must all be found | `sub-auto=fuzzy` (matches any file *containing* the video basename) + `sub-file-paths=subs:Subs:subtitles:Subtitles`. mpv's own community argues fuzzy should be default — make it yours |
| "Add subtitle file…" + **drag a .srt onto the window** | Escape hatch when auto-load misses | Drop handler: if the dropped file has a subtitle extension, `sub-add` instead of replacing playback. This one behavior wins people over |
| Subtitle delay ± with visible value and a reset key | Desync is constant with scene releases | `sub-delay`, ±0.1s fine / ±0.5s coarse. **Persist per file** in the resume store |
| Full ASS/SSA fidelity (positioning, karaoke, `\move`, `\clip`, MKV-embedded fonts) | The anime/fansub audience is a large slice of the power-user market and will test this immediately | libass with `--sub-ass-override=no` **by default** so release styling is honored. Provide an explicit "Force my style" mode (mpv's `u`) — silent override is how players get accused of breaking subtitles |
| Style overrides for plain-text subs: font, size, color, outline, shadow, background box, vertical position | Accessibility and taste; legibility on bright scenes is a real problem | `sub-font`, `sub-font-size`, `sub-color`, `sub-border-size/color`, `sub-back-color`, `sub-pos`. Live preview in the settings panel |
| Multiple subtitle tracks, cycle key, visibility toggle | Baseline | `sid` cycling + `sub-visibility` |
| Optional subtitle rendering into the letterbox margin | More comfortable on ultrawide content | `sub-use-margins` / `sub-ass-force-margins` |

### Audio

| Feature | Why | Implementation note |
|---|---|---|
| Audio track switching showing language + title + channel layout | Dual-audio releases, commentary tracks | `track-list`: display `[jpn] 5.1 FLAC` — channel count matters when choosing a track |
| Audio delay ± with visible value and reset | Sync drift on TS captures and re-muxes | `audio-delay`; persist per file |
| **Volume above 100% (to 200%) with clipping protection** | Quiet dialogue in movie mixes is among the most common complaints in home viewing. A player capped at 100% reads as broken | `volume-max=200`. Above 100% apply a **soft limiter**, not raw gain, or loud passages distort and users blame the player |
| Automatic stereo downmix on 2-channel devices | Playing 5.1 on laptop speakers and losing the center (dialogue) channel is a classic support ticket | Let libmpv/`ao=wasapi` downmix; verify the center channel is boosted in the matrix, not merely summed |
| Mute, distinct from volume 0 | Baseline | |

### Video

| Feature | Why | Implementation note |
|---|---|---|
| Aspect ratio override: Auto / 4:3 / 16:9 / 16:10 / 2.35:1 / Stretch / custom | Badly-flagged AVI and TS files | `video-aspect-override` |
| Zoom + pan + reset | Cropping black bars on bad encodes; ultrawide viewing | `video-zoom`, `video-pan-x/y`, `panscan`. Ctrl+Wheel zooms **at the cursor**, not at center |
| Rotate 90/180/270 | Phone video shot sideways. Everyone hits this | `video-rotate` |
| Screenshot: **with subs**, **without subs**, **copy frame to clipboard** | The three distinct things people actually want. PotPlayer's Ctrl+E / Ctrl+C are muscle memory | `screenshot video` (no subs/OSD) vs `screenshot subtitles` vs `screenshot window`. Configurable output dir + filename template `%F-%P.png`; **default to a dedicated folder, not the video's folder**, unless the user opts in. Clipboard copy requires the host to read the frame back |
| Correct-by-default video output | Full-range vs limited-range mishandling is a long-standing grievance against several players | Default `vo=gpu-next` where stable; validate against a black-level test pattern before release |

### Playlist

| Feature | Why | Implementation note |
|---|---|---|
| Open a file → **auto-populate the playlist with the rest of the folder**, positioned at that file | This is what makes episode binging work; it is what people mean by "it just works" | Enumerate sibling files with known media extensions, sort, set `playlist-pos` |
| **Natural / alphanumeric sort** (`Ep2` before `Ep10`) | Lexicographic sort putting episode 10 before episode 2 is a small bug with an outsized rage response | Use `StrCmpLogicalW` from `shlwapi.dll` — exactly Explorer's ordering, so the playlist matches the folder the user just looked at. Do not roll your own |
| Next / previous file; playlist panel highlighting the current item | Baseline | `playlist-next` / `playlist-prev` |
| Repeat off / one / all; shuffle | Baseline | `loop-file`, `loop-playlist`, `playlist-shuffle`. **Shuffle must not destroy the original order** — shuffle an index map so toggling it off restores order |
| Drag-drop files/folders; modifier decides append vs replace | Baseline; ambiguity here is annoying | Plain drop = replace and play; Shift/Ctrl drop = append. Show the mode in the drop overlay |
| Playlist persistence across restarts | Reopening should not lose the queue | Debounced serialize to the config dir |
| Remove / clear / reveal in Explorer (context menu) | Baseline | |

### UI / UX

| Feature | Why | Implementation note |
|---|---|---|
| Fullscreen: `Enter` / `F` / double-click; `Esc` exits; controls auto-hide with the cursor; cursor hides after ~1.5s | Baseline, and auto-hide timing is a "feel" detail people notice | Auto-hide must not fire while the pointer is over the control bar |
| Always-on-top toggle | Watching while working — one of the most-used small features | `WS_EX_TOPMOST` |
| OSD for volume, seek, speed, track changes, sub delay | Feedback for every keyboard action. Without it, keyboard control feels like guessing | libmpv `show-text` or host-drawn. **Every keybind that changes state must produce OSD feedback.** This is a rule, not a suggestion |
| Dark mode by default, plus light, plus "follow Windows" | Bright white chrome around video is actively unpleasant; VLC is criticized for exactly this | Read `AppsUseLightTheme`; apply `DWMWA_USE_IMMERSIVE_DARK_MODE` to the title bar |
| Remember window size, position, monitor, maximized state | Baseline; forgetting it is a daily papercut | Persist per monitor-config; validate the restored rect is still on a connected display |
| Single instance by default (new file opens in the existing window), **with a real option to allow multiple** | PotPlayer has exactly this option; both behaviors have strong constituencies | Named mutex + named pipe forwarding argv to the running instance |
| "Fit window to video" on load, capped to the monitor work area | Opening a 4K file must not create a window bigger than the screen | Scale to ≤80% of work area on first open; respect the user's manual resize afterwards |
| Instant startup — target **<300 ms to first frame** warm | Startup speed is a primary reason people leave heavier players | No splash screen. Defer settings UI, playlist DB and file-association checks until after first frame. Never enumerate audio devices or scan folders on the startup path |

### Shell integration

| Feature | Why | Implementation note |
|---|---|---|
| CLI args: file paths, `--fullscreen`, `--sub-file`, `--start=<time>`, `--new-instance`, plus `--` passthrough of mpv options | Scripting, "Open with", power users | Keep an explicit allowlist for passthrough and document it |
| Drag-drop onto the .exe and onto a shortcut | Baseline | argv handling |
| File-association **registration** (ProgID, icons, verbs) + a settings button that opens the Windows Default Apps page | On Windows 10/11 an app can register capabilities but **cannot silently set itself default** — Microsoft deliberately routes this through Settings, per extension | Register `HKCU\Software\Classes\FreeViewer.mkv` etc. + `RegisteredApplications`, then launch the Default Apps settings URI. **Never write `UserChoice` hashes** — that is association hijacking and gets flagged by AV |
| Explorer context menu: "Play with FreeViewer", "Add to FreeViewer playlist" | The second verb is the useful one and most players omit it | Verbs on the ProgID and on `SystemFileAssociations` for media perceived types. **Exactly two entries** — context-menu spam is itself a complaint |
| Portable mode: if `portable.txt` (or a `config\` dir) exists beside the exe, write **all** state there and touch nothing else | The core trust promise. USB stick / synced folder / "gone without a trace" | Detect at startup before any config read. In portable mode, disable file-association registration entirely and say so in the UI |

### Keyboard / mouse

| Feature | Why | Implementation note |
|---|---|---|
| Full remapping of every action, in a plain-text file, editable in-app | Muscle memory is personal and non-negotiable; PotPlayer users have years of it | Command table: `action id → {default key, description, category}`; bindings file overrides. Ship a searchable Keyboard settings page **and** an in-app cheat sheet on `F1`/`?` |
| Three presets: **Default (hybrid)**, **PotPlayer-compatible**, **mpv-compatible** | The conventions genuinely conflict; presets end the argument | Presets are just alternate bindings files |
| Mouse wheel = volume by default, **switchable to seek**, with `Shift+Wheel` = seek always | Both camps exist and both are loud. Give both without requiring config | |
| Left click = play/pause; double-click = fullscreen; right-click = context menu | PotPlayer / VLC / YouTube convention | Needs a drag threshold and a double-click delay so it doesn't fire on window drags or the first half of a double-click |

### The anti-PotPlayer guarantees (P0 — these *are* the product)

| Guarantee | Why | Implementation note |
|---|---|---|
| **No auto-updater process. Ever.** No background service, no scheduled task, no Run key | Update nagging is the user's stated #1 complaint and a widely documented pattern of user hostility | At most an *opt-in, off-by-default* "check on launch" that fails silently and never shows a modal. Default: Help → "Check for updates" opens the releases page in a browser |
| **Zero telemetry; zero network calls at rest** | Trust is the entire pitch; "Daum PotPlayer — Spyware?" threads exist for a reason | No outbound connection unless the user plays a URL or clicks a link. Make it verifiable: document it, and keep a CI test running the player on a local file under a network monitor |
| **No bundled software, no installer checkboxes, no "recommended" offers** | PotPlayer's bundling — and the KMPlayer precedent where the opt-out reportedly stopped working — is exactly the trust failure being escaped | Primary distribution is a **ZIP** (portable). Optional MSI with a single Install button and no offers |
| **No in-app ads or popups of any kind**, including region-targeted ones | Ad popups inside PotPlayer are a live grievance | Trivial to honor; state it in the README as a project rule |
| Small footprint | "Lightweight" is a stated reason people choose players | Target <80 MB unpacked including libmpv/FFmpeg. Strip unused FFmpeg components in a custom build if needed |
| Reproducible builds from public CI with published checksums | "Open source" only means something if the binary matches the source | GitHub Actions build + checksums on every release |

---

## P1 — v0.5

| Feature | Why | Implementation note |
|---|---|---|
| **Thumbnail seek preview** on hover/drag | Now an expectation set by YouTube/Netflix; PotPlayer has it. Absence reads as "cheap" | Cheapest correct approach is thumbfast's: a **second hidden libmpv instance** decoding at low resolution over IPC, writing raw frames the host blits. Pre-generating a sprite sheet is too slow for large files. Cache per file in the config dir with an LRU cap |
| Mini player / PiP: compact always-on-top window with minimal controls | The "watch while working" workflow; a headline modern-player feature | Borderless resizable window, fixed aspect, hover control strip. Requires the render-API path for host-drawn overlays |
| Audio output device selection + hot-swap without stopping playback | Headphones vs speakers vs HDMI receiver | `audio-device`; enumerate via libmpv's device list. Handle device-disappeared gracefully |
| WASAPI **exclusive mode** + bitstream passthrough (AC-3, E-AC-3, DTS, DTS-HD MA, TrueHD/Atmos) | The HTPC/receiver audience will not switch without it | `ao=wasapi`, `audio-exclusive=yes`, `audio-spdif=ac3,eac3,dts-hd,truehd`. Ship **off by default** — exclusive mode blocks other apps' audio and generates confused bug reports |
| Volume normalization ("night mode") | Quiet dialogue / loud explosions is the most-cited home audio complaint | Offer **two** honestly-labelled modes: `dynaudnorm` (aggressive, per-frame, can pump) and `loudnorm` / EBU R128 (per-file, cleaner). Also honor ReplayGain tags for audio files (`replaygain=track/album`) |
| 10-band equalizer with a few presets | PotPlayer parity; laptop-speaker users want voice/bass boost | FFmpeg `superequalizer` or `firequalizer` via `af`. Keep presets short: Flat / Voice / Bass / Treble |
| Secondary subtitle track (dual subs) | Language learners — a real, vocal niche; Haruna advertises it as a headline feature | `secondary-sid` + `secondary-sub-pos` |
| Deinterlacing (auto-detect + manual) | TS/DVD captures and old camcorder footage | `deinterlace=auto`; prefer `bwdif` over `yadif` |
| Color adjustments: brightness, contrast, saturation, gamma, hue | Dark scenes on a bad panel | `brightness` / `contrast` / `saturation` / `gamma` / `hue` + a reset button |
| Crop (manual + auto black-bar detection) | Ultrawide viewing; badly-letterboxed rips | `video-crop`; auto via `cropdetect` sampling a few seconds |
| HDR: tone-map HDR10/HLG → SDR by default, optional HDR passthrough on HDR displays | 4K content is HDR; washed-out grey playback on an SDR monitor is a very visible defect | `vo=gpu-next` + `target-colorspace-hint` for passthrough; `tone-mapping=bt.2390` for SDR output. Do **not** attempt Dolby Vision profile handling in P1 |
| Refresh-rate matching | 23.976 fps on 60 Hz produces 3:2 pulldown judder, most visible on slow pans — the classic HTPC problem | Two layers: (a) always run `video-sync=display-resample` — cheap, big win, no mode switching; (b) optional true mode switching via `ChangeDisplaySettingsEx`. Ship (a) in P1, gate (b) behind a setting with a "this can cause a black flash" warning |
| Windows System Media Transport Controls (SMTC) + media keys | Play/pause from a keyboard media key or the Windows volume overlay; expected of any modern media app | `ISystemMediaTransportControls`; publish title, artwork, position |
| Bookmarks / named positions per file | PotPlayer feature with real fans (study, reference, long recordings) | Store alongside resume data; render marks on the seek bar |
| Playlist: save/load `.m3u8`, sort by name/date/size/duration, search/filter, remove-missing | Managing a 200-file queue | |
| Playback history panel with resume points ("Continue watching") | Turns the resume store into a visible feature | |
| Accessibility pass | Legal/ethical baseline and a real user population; media players are commonly non-conformant | Every control keyboard-reachable in a sensible tab order; **visible focus indicators** (WCAG 2.4.7); UI Automation names on every control; announce state changes (play↔pause, mute↔unmute); respect Windows text scaling and high-contrast themes; never convey state by color alone |
| Network/URL playback (paste a URL, open a stream) | HTTP/HLS/RTSP come free with FFmpeg | libmpv handles it. Optional **opt-in** yt-dlp integration — off by default and a clearly separate download, or it reintroduces "bundled stuff" |
| Searchable settings + command palette | mpv's community explicitly asks for a settings UI; VLC is criticized for burying things in nested menus | One search box over every setting and every command |
| Per-file "sticky" settings (audio track, sub track, delay, speed, aspect) | Resuming a series should restore your track choices | Same store as resume. Also remember preferred **languages** globally (`alang` / `slang`) so new files auto-pick correct tracks |
| Subtitle style presets, including a "readable" preset (large, outlined, background box) | Accessibility and across-the-room TV viewing | |
| Respectful update check | Some people do want updates | Manual menu item only, or opt-in launch check. Never modal, never blocking, never auto-downloading |

---

## P2 — Nice-to-have

| Feature | Why | Implementation note |
|---|---|---|
| Custom shaders (Anime4K, FSR/CAS sharpening, ravu/nnedi upscalers) | Big draw for the enthusiast slice currently maintaining mpv configs | `glsl-shaders` — needs only a UI to browse and toggle `.glsl` files |
| Skins / theming beyond light + dark | PotPlayer parity; low value, high maintenance | Only if theming is already token-based |
| Video filters: sharpen, denoise, debanding | Banding on gradients is visible on low-bitrate encodes | `deband=yes` is one property and arguably belongs in P1; sharpen/denoise via `vf` |
| Frame interpolation (SVP-style motion smoothing) | Loved by a minority, hated by a majority; expensive | Third-party integration at best |
| Screen recording / clip export / GIF export | PotPlayer parity | Shell out to the bundled FFmpeg with an in/out-point UI |
| Screenshot burst / contact sheet | Niche but cheap once screenshots exist | |
| DVD / Blu-ray with menu navigation | Shrinking use case; BD-J menus are a swamp | Folder/ISO playback without menus is nearly free; **menus are not** |
| TV tuner / capture device / webcam input | PotPlayer parity, very small audience | |
| 3D output (SBS / TAB / anaglyph) and 360° video | PotPlayer parity; 3D TVs are dead. 360° is a modest GPU-shader lift if ever wanted | |
| DLNA / Chromecast / cast-to-TV | Nice, but a large protocol surface | |
| Media library with metadata scraping and posters | This is a different product (Kodi/Plex). Resist | |
| Global (system-wide) hotkeys | Requested by the always-on-top / background-audio crowd | `RegisterHotKey`; off by default and conflict-checked |
| Lua/JS scripting API | mpv's script ecosystem is a genuine moat; exposing the command table is most of the work | Only after the command table stabilizes |
| Web remote control (phone as remote) | HTPC use | Local HTTP server — conflicts with the no-network promise unless clearly opt-in |
| Multi-monitor fullscreen target selection | HTPC / dual monitor | |
| Audio visualizer for music files | PotPlayer parity | |

---

## Recommended Default Keybindings

Design rules:

1. **Bare keys never do destructive or hard-to-undo things.** No bare-key quit — mpv's `q` is a trap for PotPlayer users, PotPlayer's `Q` (reset speed) is a trap for mpv users, so neither wins the bare key.
2. **In-file navigation gets the bare keys; cross-file navigation gets a modifier.** Skipping to the next *file* loses your place; skipping a *chapter* does not.
3. **Every binding that changes state fires an OSD message.**
4. Conflicts with PotPlayer/mpv are resolved by the preset system, not by argument.

### Playback

| Key | Action | Origin |
|---|---|---|
| `Space` | Play / Pause | both |
| `Left click` on video | Play / Pause | PotPlayer, VLC |
| `Ctrl+W` | Close current file (return to idle) | Windows |
| `Alt+F4` / `Ctrl+Q` | Quit (saves position) | Windows |
| `[` | Speed −10% | mpv |
| `]` | Speed +10% | mpv |
| `Backspace` | Reset speed to 1.0× | mpv |
| `L` | A-B loop: set A → set B → clear | mpv |

### Seeking

| Key | Action | Notes |
|---|---|---|
| `Left` / `Right` | Seek ∓5s / ±5s | keyframe seek |
| `Shift+Left` / `Shift+Right` | Seek ∓1s / ±1s | **exact** seek |
| `Ctrl+Left` / `Ctrl+Right` | Seek ∓30s / ±30s | PotPlayer convention |
| `Shift+PgUp` / `Shift+PgDn` | Seek ∓10min / ±10min | mpv |
| `,` / `.` | Frame step back / forward | mpv |
| `PgUp` / `PgDn` | Previous / next **chapter** | mpv; see design rule 2 |
| `Home` | Seek to start | |
| `Ctrl+G` / `G` | Go to timestamp… | PotPlayer |
| `Shift+Backspace` | Undo last seek | mpv — underrated, keep it |

### Volume & audio

| Key | Action |
|---|---|
| `Up` / `Down` | Volume +5% / −5% (PotPlayer/VLC convention — deliberately **not** mpv's 1-minute seek) |
| `Mouse wheel` | Volume (configurable to seek) |
| `Middle click` / `M` | Mute toggle |
| `A` | Cycle audio track (PotPlayer) |
| `Ctrl+=` / `Ctrl+-` | Audio delay +0.1s / −0.1s |
| `Ctrl+Backspace` | Reset audio delay |

### Subtitles

| Key | Action |
|---|---|
| `V` | Toggle subtitle visibility |
| `J` / `Shift+J` | Next / previous subtitle track |
| `Z` / `Shift+Z` | Subtitle delay −0.1s / +0.1s |
| `<` / `>` | Subtitle delay −0.5s / +0.5s (PotPlayer coarse step) |
| `/` | Reset subtitle delay (PotPlayer) |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | Subtitle size + / − |
| `R` / `Shift+R` | Move subtitles up / down |
| `U` | Cycle ASS style override (respect release ↔ force my style) |
| `Alt+O` | Open subtitle file… (PotPlayer) |

### Video & window

| Key | Action |
|---|---|
| `F` / `Enter` / double-click | Toggle fullscreen |
| `Esc` | Exit fullscreen (does **not** quit) |
| `T` | Always on top |
| `Shift+A` | Cycle aspect ratio |
| `D` | Cycle deinterlace |
| `Ctrl+R` / `Ctrl+Shift+R` | Rotate 90° CW / CCW |
| `Alt++` / `Alt+-` | Zoom in / out |
| `Ctrl+Wheel` | Zoom at cursor |
| `Alt+Arrows` | Pan |
| `Alt+Backspace` | Reset zoom & pan |
| `S` | Screenshot (with subtitles) |
| `Shift+S` | Screenshot (no subtitles) |
| `Ctrl+C` / `Ctrl+E` | Copy frame to clipboard / save screenshot (PotPlayer aliases) |
| `I` | Toggle stats & media info overlay |
| `O` | Cycle OSD / progress display |
| `Alt+1` / `Alt+2` / `Alt+0` | Window to 100% / 200% / 50% of video size |

### Playlist & app

| Key | Action |
|---|---|
| `Ctrl+PgUp` / `Ctrl+PgDn` | Previous / next file |
| Mouse back / forward buttons | Previous / next file |
| `F6` / `F8` | Toggle playlist panel (PotPlayer / mpv aliases) |
| `Ctrl+O` / `F3` | Open file… |
| `Ctrl+Shift+O` / `F2` | Open folder… |
| `Ctrl+V` | Open / append URL from clipboard |
| `Ctrl+P` / `F5` | Preferences |
| `F1` / `?` | Keyboard cheat sheet |

### Mouse summary

| Input | Action |
|---|---|
| Left click | Play / pause (drag threshold applied) |
| Left double-click | Fullscreen |
| Left drag (windowed) | Move window |
| Right click | Context menu |
| Wheel | Volume (default) — option: seek |
| `Shift+Wheel` | Seek ±10s (always available) |
| `Ctrl+Wheel` | Zoom at cursor |
| Middle click | Mute |
| Back / Forward buttons | Previous / next file |
| Hover seek bar | Time tooltip (P0) → thumbnail preview (P1) |

---

## What Users Hate — Evidence

### 1. Bundled adware and installer offers
PotPlayer's official installer was reported as bundling adware (McAfee SiteAdvisor), present in updates as well as fresh installs, with users reporting that in some versions "there is no checkbox to disable the adware installation." One warning captures the fear precisely: *"This happened to KMPlayer too… First, it's bundled with wares. Then, the installer malfunctioned and install the bundled wares even when you've chosen to opt out."*
→ [VideoHelp: "PotPlayer now Adware!"](https://forum.videohelp.com/threads/393452-PotPlayer-now-Adware!) · [VideoHelp: "Potplayer: how to install without adware?"](https://forum.videohelp.com/threads/396710-Potplayer-how-to-install-without-adware) · [VideoHelp: "PotPlayer Ad-Addons?"](https://forum.videohelp.com/threads/393905-PotPlayer-Ad-Addons)

**FreeViewer response:** ZIP-first distribution; installer with no offers; documented as a project rule.

### 2. In-app ads and region-targeted popups
A dedicated thread exists asking users whether they see ad popups *inside* the player and correlating it with their country — the ad behavior varies by region, which is worse than a uniform policy because it is invisible to most reviewers.
→ [VideoHelp: "Do you have a popup ad in PotPlayer – and where are you from?"](https://forum.videohelp.com/threads/404415-Do-you-have-a-popup-ad-in-PotPlayer-and-where-are-you-from)

**FreeViewer response:** no ads, ever, anywhere, for anyone.

### 3. Closed source ⇒ spyware suspicion you cannot disprove
Once a player is closed-source and phones home, users have no way to resolve their own suspicion, and threads like "Daum PotPlayer – Spyware? – Please help" are the result. The suspicion itself is the damage.
→ [VideoHelp: "Daum PotPlayer - Spyware? - Please help"](https://forum.videohelp.com/threads/385977-Daum-PotPlayer-Spyware-Please-help)

**FreeViewer response:** open source plus a *verifiable* no-network-at-rest guarantee, tested in CI.

### 4. Update nagging
Documented as a general pattern of vendor hostility: users face "an avalanche of dialogs prompting me to install software updates," and aggressive nagging *backfires* — it pushes users to disable updates entirely. Windows 10's upgrade nag screens are the canonical case.
→ [Ctrl blog: "The constant software update tyranny"](https://www.ctrl.blog/entry/software-update-tyranny.html) · [PCWorld: Windows 10 pop-up](https://pcworld.com/article/3073457/how-microsofts-nasty-new-windows-10-pop-up-tricks-you-into-upgrading.html) · [TechRadar: nag screens are back](https://www.techradar.com/news/microsofts-windows-10-nag-screens-are-back-with-a-vengeance)

**FreeViewer response:** no updater process at all; manual check only.

### 5. VLC's UI — the open-source cautionary tale
Most-cited criticisms: flat, low-contrast controls that blend into the background; no proper dark mode on desktop; overcrowded nested menus hiding essential functions; inconsistent placement across platforms; an interface that "hasn't appeared to change significantly in 20 years." One HN comment: *"VLC's UI sucks so terribly, it's like they went WAY out of their way to make it [bad]."* People keep it installed anyway — *"it still works when everything else fails"* — which is the definition of being a fallback, not a daily driver.
→ [HN 13573499](https://news.ycombinator.com/item?id=13573499) · [HN 3607350](https://news.ycombinator.com/item?id=3607350) · [Blogsolute: "VLC is NOT Best Video Player"](https://www.blogsolute.com/vlc-player-sucks/29195/)

**FreeViewer response:** dark mode default, flat menu hierarchy, searchable settings, no nested-submenu archaeology.

### 6. mpv has no GUI — the other cautionary tale
mpv's own community has filed this repeatedly: *"RFC: there should be an official GUI"* (twice), plus a request for a basic settings/options menu. Users report mpv is "very overwhelming and confusing" for beginners, that the manual functions "more like a lookup table than a real guide," and that existing frontends are "either lacking any new features over mpv, look like something from the early 90s, or both." The maintainers' position is that most devs have no interest in building one.
→ [mpv Discussion #13901](https://github.com/mpv-player/mpv/discussions/13901) · [mpv Issue #5500](https://github.com/mpv-player/mpv/issues/5500) · [mpv Discussion #14566 "Configuration options menu"](https://github.com/mpv-player/mpv/discussions/14566) · [HN 32139842](https://news.ycombinator.com/item?id=32139842)

**FreeViewer response:** this gap *is* the product — a real GUI over the mpv engine.

### 7. Subtitles not auto-loading
mpv users argue `sub-auto=fuzzy` should be the *default* because exact matching silently fails on how real subtitle files are named (`Movie.en.srt`, `[Group] Movie [1080p].ass`, `Subs/Movie.srt`). Related long-standing requests: reload subtitles without reloading the video; remember the last video+subtitle pairing.
→ [mpv #12389 "subs-auto=fuzzy … should be default"](https://github.com/mpv-player/mpv/issues/12389) · [mpv #15657 on sub-auto semantics](https://github.com/mpv-player/mpv/issues/15657) · [mpv #11229 "refresh subtitles"](https://github.com/mpv-player/mpv/issues/11229) · [asbplayer #975 remember video+subtitle pair](https://github.com/asbplayer/asbplayer/issues/975)

**FreeViewer response:** fuzzy by default, subtitle subfolder search, drag-drop a .srt to attach, per-file delay persistence, reload-subs command.

### 8. Resume that doesn't resume — or resumes at the wrong spot
Kodi shipped a patch precisely because resume seeks were keyframe-based and "the resume point may only be hit by chance." mpv shipped a patch to *stop* saving position when already at the end of a video, because otherwise finished files keep resuming.
→ [xbmc PR #13665 "do an accurate seek for auto-resume"](https://github.com/xbmc/xbmc/pull/13665) · [mpv PR #2052 "Don't 'save position on quit' if we're (approximately) at the end"](https://github.com/mpv-player/mpv/pull/2052)

**FreeViewer response:** exact seek on resume; don't save within the last 5% / 90s; don't save under 60s watched.

### 9. Judder from refresh-rate mismatch
23.976 fps content on a 60 Hz display cannot divide evenly, so frames are held for uneven durations — 3:2 pulldown judder, "most visible during slow camera pans." The /r/htpc wiki's rule: refresh rate should equal the frame rate or be a whole-number multiple of it.
→ [/r/htpc wiki: Video Setup Guide](https://r-htpc.github.io/wiki/video)

**FreeViewer response:** `video-sync=display-resample` always on (P1); optional true mode-switching behind a setting.

### 10. Hardware decoding that silently breaks video
The /r/htpc guide's whole calibration workflow assumes hwdec can corrupt output — it instructs users to disable hardware acceleration first, validate, then re-enable and re-test. Players that hide which decoder is in use make this undiagnosable.
→ [/r/htpc wiki: Video Setup Guide](https://r-htpc.github.io/wiki/video)

**FreeViewer response:** decoder name always visible in the stats overlay; one-click software fallback; automatic fallback if no frames arrive.

### 11. File-association hijacking — and, conversely, being unable to set defaults
On Windows 10/11 there is no supported way to programmatically change a user's default app; the only working route is Settings → Apps → Default apps, and it must be done **per extension** (setting `.mp4` does not set `.mkv`). Apps that force it via `UserChoice` registry hacks are treated as hijackers.
→ [Level1Techs: "Windows 11: Programmatically change default apps/file associations"](https://forum.level1techs.com/t/windows-11-programmatically-change-default-apps-file-associations/223635) · [Microsoft: Default Programs](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs)

**FreeViewer response:** register capabilities properly, then hand the user a one-click shortcut to the Windows Settings page with a short explanation. Portable mode registers nothing.

### 12. Wrong playlist sort order
`file10.mp4` sorting before `file2.mp4` is the classic. Windows itself solves this: `StrCmpLogicalW` "is smart enough to realize that track9.mp3 < track10.mp3" and reproduces Explorer's exact ordering.
→ [Matthew van Eerde: "Using StrCmpLogicalW to sort strings the way the shell does"](https://matthewvaneerde.wordpress.com/2015/02/03/using-strcmplogicalw-to-sort-strings-the-way-the-shell-does/) · [MSDN: StrCmpLogicalW](https://learn.microsoft.com/en-us/windows/desktop/api/shlwapi/nf-shlwapi-strcmplogicalw)

### 13. Quiet dialogue, loud everything else
The most common living-room audio complaint. The technical split matters: `loudnorm` targets a fixed LUFS per EBU R128 (cleaner, per file), while `dynaudnorm` adjusts frame-by-frame and "sounds more 'radio-processed' and can introduce pumping artifacts."
→ [FFmpeg audio normalization comparison](https://www.ffmpeg-micro.com/blog/ffmpeg-normalize-audio-volume) · [mpv #10767 "Volume normalization"](https://github.com/mpv-player/mpv/issues/10767) · [ReplayGain](https://en.wikipedia.org/wiki/ReplayGain)

### 14. Media players unusable without a mouse
Common accessibility failures: controls unreachable by keyboard; focus indicators removed for aesthetics (a WCAG 2.4.7 violation that "makes the player unusable for sighted keyboard users"); state changes (play↔pause, mute↔unmute) not exposed, so screen readers never announce them.
→ [W3C WAI: Media Players](https://www.w3.org/WAI/media/av/player) · [Accessible.org: Video Player Accessibility Best Practices](https://accessible.org/video-player-accessibility-best-practices/) · [Harvard: Provide an accessible media player](https://accessibility.huit.harvard.edu/provide-accessible-media-player)

---

## Explicit Non-Goals

Stating these up front prevents scope creep and sets expectations honestly:

- **Not a media library / server.** No metadata scraping, no posters, no watch-state sync. Kodi, Plex and Jellyfin exist.
- **Not an editor.** No trimming or re-encoding UI beyond (maybe) clip export in P2.
- **Not a downloader.** yt-dlp integration, if it ever ships, is opt-in and separately installed.
- **No Blu-ray menu (BD-J) support.** Folder/ISO playback without menus only.
- **No TV tuner, capture device, or broadcast features.**
- **No account, no cloud, no sync.**
- **No 3D output.**

---

## Open Questions to Settle Before Coding

1. **License:** GPLv2+ (easy, matches a GPL FFmpeg/mpv build) vs LGPL (requires a carefully configured non-GPL FFmpeg and mpv build). Decide before the first public commit.
2. **GUI stack:** WinUI 3 (modern, good a11y, larger runtime footprint) vs Qt Widgets (portable, small, mature) vs WPF (mature .NET, dated). Weigh against the <80 MB / <300 ms targets.
3. **Video surface for v0.1:** `--wid` embedding (fast to build, host cannot draw over the video) vs `mpv_render_context` from the start (needed for PiP overlays and thumbnail rendering in P1). Starting with `--wid` and migrating is a known-cost refactor.
4. **Resume store:** SQLite vs a JSON file. SQLite is more robust as history grows; JSON is more inspectable and portable-friendly.
5. **Minimum Windows version:** Windows 10 1809 is a reasonable floor (D3D11 hwdec, dark mode APIs, modern shell APIs). Windows 7 support would cost D3D11VA quality and dark mode.

---

## Sources

**PotPlayer — features and grievances**
- https://potplayer.dev/features.html
- https://potplayer.info/features/
- https://www.videohelp.com/software/PotPlayer
- https://forum.videohelp.com/threads/393452-PotPlayer-now-Adware!
- https://forum.videohelp.com/threads/396710-Potplayer-how-to-install-without-adware
- https://forum.videohelp.com/threads/393905-PotPlayer-Ad-Addons
- https://forum.videohelp.com/threads/404415-Do-you-have-a-popup-ad-in-PotPlayer-and-where-are-you-from
- https://forum.videohelp.com/threads/385977-Daum-PotPlayer-Spyware-Please-help
- https://forum.videohelp.com/threads/375411-How-to-setup-Daum-PotPlayer-to-output-TrueHD-and-DTS-HD
- https://forum.videohelp.com/threads/389852-%5BSOLVED%5D-PotPlayer-command-line-open-new-video-in-same-window

**Keybindings**
- https://mpv.io/manual/master/#keyboard-control
- https://tutorialtactic.com/blog/potplayer-shortcuts/
- https://defkey.com/potplayer-shortcuts
- https://forum.videohelp.com/threads/412878-Alternative-custom-keyboard-shortcuts-for-PotPlayer
- https://forums.highrez.co.uk/viewtopic.php?t=1997 (MPC-HC mouse wheel behavior)

**Engine / embedding / hardware decode**
- https://mpv.io/manual/master/
- https://github.com/mpv-player/mpv-examples/tree/master/libmpv
- https://github.com/mpv-player/mpv/wiki/FAQ
- https://github.com/mysteryx93/LibMpv-OpenGL
- https://deepwiki.com/FFmpeg/FFmpeg/7-hardware-acceleration
- https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html
- https://en.wikipedia.org/wiki/DirectX_Video_Acceleration

**GUI gap / player comparisons**
- https://github.com/mpv-player/mpv/discussions/13901
- https://github.com/mpv-player/mpv/issues/5500
- https://github.com/mpv-player/mpv/discussions/14566
- https://github.com/mpv-player/mpv/issues/3730
- https://news.ycombinator.com/item?id=32139842
- https://news.ycombinator.com/item?id=13573499
- https://news.ycombinator.com/item?id=3607350
- https://news.ycombinator.com/item?id=16004609
- https://news.ycombinator.com/item?id=32195512
- https://news.ycombinator.com/item?id=14783867
- https://www.blogsolute.com/vlc-player-sucks/29195/

**Subtitles**
- https://github.com/mpv-player/mpv/issues/12389
- https://github.com/mpv-player/mpv/issues/15657
- https://github.com/mpv-player/mpv/issues/11229
- https://www.baeldung.com/linux/mpv-subtitles-automatic
- https://github.com/Masaiki/xy-VSFilter
- https://github.com/asbplayer/asbplayer/issues/975

**Resume / watch-later**
- https://github.com/mpv-player/mpv/pull/2052
- https://github.com/mpv-player/mpv/issues/7613
- https://github.com/xbmc/xbmc/pull/13665
- https://hotkeycheatsheet.com/guides/mpv-watch-later-and-playlist-workflows

**Audio**
- https://www.ffmpeg-micro.com/blog/ffmpeg-normalize-audio-volume
- https://github.com/mpv-player/mpv/issues/10767
- https://en.wikipedia.org/wiki/ReplayGain
- https://r-htpc.github.io/wiki/audio
- https://www.svp-team.com/forum/viewtopic.php?id=5912

**Video quality / HDR / refresh rate**
- https://r-htpc.github.io/wiki/video
- https://r-htpc.github.io/wiki/hdr
- https://github.com/mpv-player/mpv/discussions/14757
- https://carlosfelic.io/misc/best-mpv-config-2026/
- https://www.coconut.co/articles/av1-supported-devices-complete-list-updates
- https://hothardware.com/news/av1-codec-support-and-importance-explained

**Windows platform**
- https://learn.microsoft.com/en-us/windows/win32/shell/default-programs
- https://forum.level1techs.com/t/windows-11-programmatically-change-default-apps-file-associations/223635
- https://learn.microsoft.com/en-us/windows/desktop/api/shlwapi/nf-shlwapi-strcmplogicalw
- https://matthewvaneerde.wordpress.com/2015/02/03/using-strcmplogicalw-to-sort-strings-the-way-the-shell-does/
- https://www.dotnet-guide.com/how-to-restrict-a-program-to-single-instance-in-net.html
- https://comcomponent.com/en/blog/single-instance-mutex-guide/
- https://portableapps.com/manuals/PortableApps.comLauncher/ref/paf/index.html
- https://portableapps.com/manuals/PortableApps.comLauncher/ref/paf/layout.html

**Thumbnails**
- https://deepwiki.com/hooke007/mpv_PlayKit/3.3-thumbfast-timeline-thumbnails
- https://dev.to/masonwritescode/build-scrub-bar-thumbnail-previews-with-ffmpeg-and-a-webvtt-sprite-3ei2

**Update fatigue**
- https://www.ctrl.blog/entry/software-update-tyranny.html
- https://pcworld.com/article/3073457/how-microsofts-nasty-new-windows-10-pop-up-tricks-you-into-upgrading.html
- https://www.techradar.com/news/microsofts-windows-10-nag-screens-are-back-with-a-vengeance

**Accessibility**
- https://www.w3.org/WAI/media/av/player
- https://accessible.org/video-player-accessibility-best-practices/
- https://accessibility.huit.harvard.edu/provide-accessible-media-player
- https://www.siteimprove.com/blog/media-accessibility-standards/
