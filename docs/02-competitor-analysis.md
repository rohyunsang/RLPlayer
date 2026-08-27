# FreeViewer — Competitor Analysis & Playback Engine Architecture

**Research date:** 2026-08-28
**Scope:** Desktop video players relevant to a new open-source Windows player intended to replace PotPlayer.
**Method:** Primary sources wherever possible — upstream source code, GitHub API metadata, official manuals, measured release assets, vendor EULAs, CVE records. Sizes and dates were measured live, not recalled.

---

## 0. Executive summary

**Engine verdict:** Build on **libmpv**, embedded as a **native child window via the `wid` option**, running `--vo=gpu-next --gpu-context=d3d11 --hwdec=auto`.

Do **not** build on Chromium's `<video>` element. Do **not** build on libVLC. And on Windows specifically, do **not** use libmpv's *render* API — despite it being upstream's nominal recommendation — unless you are prepared to give up `gpu-next`, HDR passthrough, and (if you share a framebuffer with your UI toolkit) your entire UI's framerate.

The shell is a second, separable decision, and the evidence points at **WebView2 (Tauri, or a thin native shell) over Electron** — because WebView2's transparent background is a first-class supported API that composites over sibling native content in the same window, which is exactly what an HTML overlay on a hardware-decoded video surface requires. Electron's equivalent (`transparent: true`) is a decade-old bug farm that black-screens for a meaningful fraction of Windows users.

There is a production reference implementation of exactly this architecture: **Stremio's `stremio-shell-ng`**. Its README documents a measured **2–5× efficiency win** over the render-API architecture the same team shipped previously.

**Three findings that should shape strategy beyond the engine choice:**

1. **mpv.net is orphaned.** Its maintainer announced retirement for health reasons in April 2025 and **died in February 2026**; his sister posted the news to the issue tracker in May 2026. No fork above 7 stars has stepped up; 156 issues are open. Haruna and Celluloid are Linux-first. **There is currently no actively-maintained, modern-UI, Windows-first mpv frontend.** That is the gap.
2. **VLC 4.0 has been in development for 8 years and 9 months** (master became `4.0.0-dev` on 2017-11-30) and still has not shipped on desktop. Its replacement UI is already being criticised — before launch — for being touch-derived and unable to browse the local filesystem. The desktop player UI is the least-defended part of this whole market.
3. **Codec coverage is not a differentiator.** VLC, mpv, Kodi, Plex and Jellyfin all bottom out in FFmpeg. Trust, UI, and size are where this is won.

---

## 1. Comparison table

| Player | License | Engine / architecture | Install size (measured) | Update / monetization behavior | Key strength | Key weakness |
|---|---|---|---|---|---|---|
| **PotPlayer** | Freeware, closed, restrictive EULA (Kakao) | DirectShow + internal forked-FFmpeg codecs; DXVA2/D3D11/NVDEC/QuickSync | ~33–55 MB installer, ~30–40 MB installed | Silent self-update from vendor CDN; ads 2019–21 (Korea build only); AV bundling; persistent nags; new anti-tamper integrity checks | Deepest feature set on Windows; best-in-class SMI/Korean subtitles; tolerant of broken `.ts` | Closed source; CVSS 9.8 RCE history in its own demuxers; EULA-disclosed telemetry; FFmpeg Hall of Shame; 3 divergent binaries |
| **VLC** | **GPLv2+ (app) / LGPLv2.1+ (libVLC only)** | Module framework; own demuxers + libavcodec; 363 plugin DLLs; D3D11VA | **43.8 MB** installer → **182.7 MiB / 851 files** on disk | **None.** No ads, telemetry, or account. Refused "tens of millions of Euros" to monetize | Plays anything, including damaged media and discs; 6 billion downloads; unmatched trust | UI widely hated; preferences maze; 4.0 nine years late; the LGPL is a 0.18 MiB shim over mostly-GPL plugins |
| **mpv** | GPLv2+, **LGPLv2.1+ via `-Dgpl=false`** | libavcodec + `vo_gpu_next` (libplacebo); config-driven, no GUI | **32.0 MiB** .7z → **120.0 MiB / 13 files**; `mpv.exe` is 114.2 MiB static | **None.** | Best renderer in the category; clean C API; **libmpv is one 114 MiB DLL** | No GUI by design; no official binaries; LGPL build requires deliberate configuration |
| **mpv.net** | GPL-2.0 | **C#/.NET WinForms + libmpv via `wid`** | **36.3 MB** setup / 108.9 MB portable (+ .NET 10 runtime) | **None.** | The closest existing reference implementation; full mpv config + script compatibility | **Orphaned — maintainer died Feb 2026.** 156 open issues, no successor fork |
| **MPC-HC (clsid2)** | GPL-3.0 | DirectShow + LAV Filters + MPC Video Renderer | **21.88 MB** installer (2.8.1) | **None.** | Smallest full-featured player; bundles decoders + renderer; monthly releases | DirectShow is legacy per Microsoft; merit-system fragility; MFC UI |
| **MPC-BE** | GPL-3.0 | DirectShow + LAV Filters | **18.96 MB** installer (1.9.1) | **None.** | Even smaller; active | Same DirectShow structural problems |
| **KMPlayer** | Adware, closed (Pandora TV) | DirectShow; "64X" appears MPC-HC-derived | ~57 MB dl / **150 MB installed** | Bundleware installer; in-player ads; **flagged PUP by Kaspersky** | Brand recognition in Korea | Worst distribution hygiene here; live GPL-compliance questions |
| **GOM Player** | Adware + paid tier | DirectShow | 22–32 MB free / 200 MB (Plus) | Ads; ₩11,000 lifetime Plus; codec-finder upsell; 3-layer ad installer | Historically strong SMI + broken-file playback | **2014 update-server supply-chain compromise** (§4.7); privacy incidents |
| **IINA** (macOS) | GPL-3.0 | **Swift + libmpv render API** (GL→Metal) | 104.24 MB DMG (v1.4.4) | **None.** | Best UX in the category — music mode, PiP, floating OSC, JS plugins. **46,104 stars — more than mpv itself** | macOS only; render API costs it `gpu-next` and Dolby Vision; CVE-2026-47114 |
| **Screenbox** | GPL-3.0 | **WinUI/UWP + LibVLCSharp** | **259.8 MB** msixbundle / 338.4 MB zip | **None.** | Runs on Windows *and Xbox*; VLC's full codec stack | Enormous; issue tracker full of HDR/VSR black screens |
| **Stremio `shell-ng`** | *(no SPDX declared)* | **WebView2 + libmpv `wid` + gpu-next + d3d11** | ~10 MB shell + libmpv | Ad-free client | **The reference architecture for FreeViewer** | Windows-only shell; thin docs; unlicensed repo |
| **Jellyfin Desktop** | GPL-2.0 | **Qt WebEngine + libmpv render API** | **149 MB** installer | **None.** | Proves web-UI-over-libmpv ships at scale | Forced to `gpu-api=opengl` on Windows — the exact tax §3.3 warns about |
| **LosslessCut** | GPL-2.0 | **Electron + Chromium `<video>`** + JPEG-stream fallback | **139.4 MB** (win 7z) | **None.** | 43,243 stars | Cannot play HEVC/AC3/MKV properly. Codec issue open since 2018 |
| **Glucose** | EUPL-1.2 | **Tauri + WebView2 `<video>`** | **4.6 MB** | **None.** | Beautiful, tiny | Black-screens on HEVC. *"It works fine with VLC."* |
| **Kodi** | GPL-2.0 | `VideoPlayer` + FFmpeg 8.1.2; XML skins; SQLite library | **74.0 MiB** installer | **None** (non-profit) | Full media-center, no daemon/account | Wrong scope for a file player |
| **Plex** | Proprietary | Forked FFmpeg; server + 20 clients; cloud Relay | Server 95.8 MiB + Desktop 178.8 MiB ≈ **288 MB** | **Plex Pass. Lifetime went $119.99 → $749.99 (6.25×). Remote streaming of your own files paywalled.** | Polished; remote access that works | Proprietary, account-gated even locally, telemetry, monetized |
| **Jellyfin** | GPL-2.0 | Emby 3.5.2 fork; C#/ASP.NET + `jellyfin-ffmpeg` | Server 159.7 MiB + Desktop 149.1 MiB ≈ **324 MB** | **None.** | Open-source Plex equivalent, no telemetry | Server-first; desktop client still has no v2.0 Windows binary |

---

## 2. What "engine" actually means here

A desktop video player is four separable layers. Most architecture arguments confuse them:

1. **Demux + decode** — container to frames. (FFmpeg/libavcodec, or DirectShow filters.)
2. **Render + present** — color management, scaling, tone mapping, and getting a frame on screen with correct colorspace metadata. (`vo_gpu_next`/libplacebo on D3D11; VLC's `direct3d11`; DirectShow's EVR/madVR/MPC-VR.)
3. **Surface ownership** — *who owns the pixels*: a native child HWND, or a texture you composite yourself.
4. **UI toolkit** — how you draw controls.

**Layer 1 is a solved commodity.** Every serious player bottoms out in FFmpeg. Nobody wins there.

**Layer 3 is where every architecture in this space actually succeeds or fails**, and it is the layer almost every "Electron vs Tauri" comparison ignores. Most of §3 is about layer 3.

---

## 3. Engine architecture recommendation

### 3.1 Ranked verdict

| Rank | Architecture | Verdict |
|---|---|---|
| **1** | **WebView2 shell (Tauri or thin native shell) + libmpv in-process, `wid` embedding, `vo=gpu-next`, `gpu-context=d3d11`** | **Recommended.** Full hardware pipeline *and* HTML overlay. Proven in production by Stremio, measured at 2–5× the alternative. |
| **2** | **C#/.NET (WinUI 3 / WPF / WinForms) + libmpv `wid`** — the mpv.net approach | Strong and boring. Pick this if the team is a .NET team. Loses HTML/CSS theming; inherits WPF airspace hacks if you go WPF. |
| **3** | **Electron + libmpv `wid`** | Works, but you solve the overlay problem yourself, and pay ~150 MB of Chromium for a UI toolkit you then can't draw over the video with. |
| **4** | **Electron/Tauri + libmpv *render API*** (SW readback, or Electron 40 shared texture) | Solves overlay; forfeits `gpu-next`, HDR passthrough, and — if you share a framebuffer — your UI framerate. Only available packages are v0.1.x with 0–3 stars. |
| **5** | **C#/.NET + LibVLCSharp** | VideoLAN documents the airspace problem in their own README and ships a three-window hack for it. 525 files, weaker renderer, oldest airspace bug open since 2018. |
| **DQ** | **Chromium `<video>` (Electron or Tauri/WebView2)** | **Disqualified.** Cannot play the formats this app exists to play. |

### 3.2 Why Chromium `<video>` is disqualified

Not close. Per [Chromium's own audio/video page](https://www.chromium.org/audio-video/):

- **Containers:** MP4, Ogg, WebM, WAV, Matroska, HLS.
- **Video:** AV1, VP8, VP9 (open build); H.264 and HEVC only in *branded* builds — and **HEVC "requires hardware support."**
- **Audio:** FLAC, MP3, Opus, PCM, Vorbis (open); AAC and xHE-AAC in branded builds.

What that list does *not* contain is the entire reason PotPlayer users use PotPlayer:

- **No AC-3 / E-AC-3 / DTS / DTS-HD / TrueHD.** These are the standard audio tracks in the MKV rips and Blu-ray remuxes the target library is made of. There is no flag; the code is not there.
- **No software HEVC.** Chrome's HEVC is hardware-only ([chromestatus 5186511939567616](https://chromestatus.com/feature/5186511939567616)). No supported GPU → no playback. Many Windows systems additionally need Microsoft's [HEVC Video Extensions](https://apps.microsoft.com/detail/9nmzlz57r3t7) — a **$0.99 Store purchase** for non-OEM installs.
- **Matroska support is nominal.** Chromium lists Matroska but in practice only carries VP8/VP9/Opus/Vorbis inside it. An ordinary H.264+AAC MKV fails — documented in [jellyfin-web #7651](https://github.com/jellyfin/jellyfin-web/issues/7651), where the server correctly picks DirectPlay and the browser still fails *because the container itself isn't supported by the HTML5 video element*.
- **No ASS/SSA rendering, no PGS, no SMI.** `<track>` speaks WebVTT and nothing else. For a player whose Korean users care most about SMI with Ruby tags, this alone ends it.
- **No HDR passthrough, no >8-channel audio, no bitstreaming to a receiver, no VVC, no MPEG-2/VOB, no RealMedia.**

**This is not theoretical — two well-starred projects are living it:**

- **Glucose Media Player** (Tauri, 113★): [#42 "H.265/HEVC black screen"](https://github.com/rudi-q/glucose_media_player/issues/42), open since 2026-04-29 — *"H.265/HEVC video have audio and subtitles working but no video, just a black screen. **It works fine with VLC.**"* Its `Cargo.toml` has no mpv and no ffmpeg bindings. Installer: a lovely 4.6 MB.
- **LosslessCut** (Electron, **43,243★**): [#88](https://github.com/mifi/lossless-cut/issues/88) is the canonical thread, still open, maintainer: *"I'm not sure how to do this with electron… I think it is not a trivial task."* Its fallback is *"FFmpeg-assisted software decoding to playback in a **lower quality**… FFmpeg will **stream low-resolution JPEG images**"* to a canvas. Hardcoded codec blacklist in source: `prores, mpeg4, mpeg2video, tscc2, dvvideo, mjpeg, ffv1`.

43,000 stars did not make the problem go away. It is architectural.

**Tauri's WebView2 is worse, not better:** it inherits Edge's codec set rather than a Chromium build you control, and there is no `ffmpeg_branding` knob at all. Tauri maintainer guidance in [discussion #15171](https://github.com/orgs/tauri-apps/discussions/15171) (2026): *"The webview already has a hardware-accelerated **H.264** decoder on every platform Tauri supports"* — recommending remux to fMP4 + MSE. H.264 only. No HEVC, MKV, AC3, or DTS. See also [#11559](https://github.com/tauri-apps/tauri/issues/11559), [#8579](https://github.com/tauri-apps/tauri/issues/8579), [#8725](https://github.com/tauri-apps/tauri/issues/8725).

**One clarification, since it is often confused:** Electron's official prebuilt binaries **do** ship proprietary codecs (H.264/AAC). The proof is in the release assets — every release includes a separate small `ffmpeg-vXX-win32-x64.zip` (0.7 MB in v44.0.0) whose entire purpose is to *replace* the default libffmpeg with a non-proprietary one. Codecs are not Electron's problem. The problem is that even with them, Chromium's coverage is a fraction of what this app needs.

### 3.3 The real decision: `wid` embedding vs the render API

libmpv offers two embedding models. The [official mpv-examples README](https://github.com/mpv-player/mpv-examples/blob/master/libmpv/README.md) describes both:

**(a) Native window embedding (`wid`).** You hand mpv a parent window handle; mpv creates a child window inside it and owns those pixels completely.

**(b) The render API (`vo=libmpv`).** You create a GL context and call `mpv_render_context_render()` per frame; you own the pixels and composite them yourself.

Upstream says the render API is *"currently recommended over window embedding"* — but read the stated reasons: **X11 focus policy** and **macOS/Qt stability**. Neither applies on Windows. And on Windows the render API carries costs the README does not mention.

**Cost 1 — no `gpu-next`, no D3D11.** Verified against current master (2026-08). `include/mpv/render.h` defines exactly two API types:

```c
#define MPV_RENDER_API_TYPE_OPENGL "opengl"
#define MPV_RENDER_API_TYPE_SW     "sw"
```

There is **no D3D11 render API** and no `MPV_RENDER_PARAM_BACKEND`. [mpv#5979](https://github.com/mpv-player/mpv/issues/5979), requesting a D3D11 backend, has been open since July 2018 with no assignees, no PRs, no branches. A render-API client therefore gets the older `gpu` VO on OpenGL (or ANGLE), not the libplacebo-based `gpu-next` that became mpv's default in v0.41.0.

**Cost 2 — no HDR passthrough.** `DOCS/man/options.rst` on `--target-colorspace-hint`: *"Currently, this is supported on Wayland, **D3D11** and winvk contexts… **Requires a supporting driver and `--vo=gpu-next`.**"* A render-API client is on OpenGL and on `gpu`. Both conditions fail. HDR content gets tone-mapped to SDR, permanently.

**Cost 3 — the software path is not a fallback.** `render.h` on `MPV_RENDER_API_TYPE_SW`, verbatim: *"provides an extremely simple (but slow) renderer to memory surfaces. **You probably don't want to use this.**"* … *"This method of rendering is very slow, because everything, including color conversion, scaling, and OSD rendering, is done on the CPU, single-threaded. In particular, large video or display sizes, as well as presence of OSD or subtitles can make it **too slow for realtime**."*

**Cost 4 — it can cap your entire UI's framerate.** This is the finding nobody expects. From [mpvQC's ADR 0016](https://github.com/mpvqc/mpvQC/blob/main/docs/adr/0016-linux-render-video-into-a-shared-framebuffer.md), verbatim:

> **"Sharing one framebuffer between the UI and the video ties Qt's paint rate to the video's: at 24 fps, menus and other UI animations paint no faster than the video does. We built a second, offscreen framebuffer for mpv once, decoupled from Qt's own paint cadence, to fix this, then reverted it.** The current stopgap is tuning mpv's `video-timing-offset`… — **a workaround, not a fix.**"

Note that mpvQC uses **`--wid` on Windows** and only falls back to the render API on Linux *because Wayland has no window-embedding protocol at all*.

**Cost 5 — the compositor tax, in shipped code.** Jellyfin Desktop is the only shipping web-UI-over-mpv app using the render API. `src/player/MpvVideoItem.cpp`:

```cpp
Q_EMIT setProperty("vo", "libmpv");
#ifdef Q_OS_WIN32
    // Force desktop OpenGL and disable advanced features for compatibility with older GPUs
    Q_EMIT setProperty("gpu-api", "opengl");
    Q_EMIT setProperty("opengl-es", "no");
#endif
```

Forced desktop OpenGL. ANGLE out of the path. D3D11 unavailable.

**Cost 6 — IINA, independently, on a third platform.** *"Many color related fixes are only being added by mpv to the new renderer… Unfortunately GPU Next is not available yet to library clients such as IINA."* Dolby Vision is out of reach; IINA renders visibly darker than mpv; HDR peak computation is disabled in the libmpv render path.

**The decisive evidence — a real A/B test by one team on one app.** Stremio shipped both architectures and wrote down the result. From [`stremio-shell-ng`'s README](https://github.com/Stremio/stremio-shell-ng), verbatim:

> In all three, this architecture excels the Qt-based shell: it is about **2-5x more efficient** depending on the use case, as it allows MPV to render directly in the window through it's optimal video output rather than using libmpv to integrate with Qt.
>
> This is due to Qt having a complex rendering pipeline involving ANGLE and multiple levels of composing and drawing to textures, which inhibits full HW acceleration.
>
> Meanwhile in this setup MPV uses whichever pipeline it considers to be optimal (like the mpv desktop app), which is normally **d3d11**, allowing full HW acceleration.

Corroborated by their own older repo: [stremio-shell#441](https://github.com/Stremio/stremio-shell/issues/441) records that **the libmpv render API doesn't support `gpu-next`**, which is what they needed for HDR.

**Conclusion: on Windows, use `wid`.** Upstream's recommendation is correct on X11 and macOS. On Windows it is a downgrade on every axis that matters, and four independent teams (Stremio, mpvQC, Jellyfin, IINA) have paid for it.

### 3.4 Does `mpv --wid` into an Electron window actually work on Windows?

**Yes — and the most common reason people report it failing is a one-line bug.**

mpv's manual is explicit ([`DOCS/man/options.rst`](https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst)):

> **`--wid=<ID|-1>`** … On win32, the ID is interpreted as `HWND`. **Pass it as value cast to `uint32_t` (all Windows handles are 32-bit), this is important as mpv will not accept negative values.** mpv will create its own window and set the wid window as parent, like with X11. The value `0` is interpreted specially, and mpv will draw on top of the desktop wallpaper and below desktop icons.

The enforcement is right there in `video/out/w32_common.c`:

```c
if (w32->opts->WinID == 0) {
    set_raised_desktop();
    w32->parent = get_workerw_hwnd();
    w32->embed_desktop = true;
} else if (w32->opts->WinID > 0) {          // <-- strictly positive only
    w32->parent = (HWND)(intptr_t)(w32->opts->WinID);
}
```

If `wid` is negative, `w32->parent` stays NULL and mpv silently creates a **detached top-level window** instead of embedding. That is the entire content of the two most-cited "it doesn't work" reports:

- [**Node-MPV #106**](https://github.com/j-holub/Node-MPV/issues/106) — "Embed mpv in Electron Browser Window", still open. The reporter's code:
  ```js
  const winID = remote.getCurrentWindow().getNativeWindowHandle().hbuf.readInt32LE(0);
  ```
  `readInt32LE` is **signed**. Any HWND with the high bit of its low dword set yields a negative number, mpv rejects it, and the video "starts but is invisible." The fix is `readUInt32LE(0)`.
- [**mpv#10189**](https://github.com/mpv-player/mpv/issues/10189) — "On Windows, libmpv sometimes creates a detached window with wid option". Reporter: *"Sometimes `wid` is negative. We noticed this behavior on long-running machines (some machines have 49+ days of uptime)… 357500724, **-797637628**, **-1665923796**, 5572158."* Same root cause, arriving via Qt's `winId()`.

**Read the handle unsigned. Always.** `buf.readUInt32LE(0)`, or `Number(buf.readBigUInt64LE(0))` — never `readInt32LE`. Assert `wid > 0` before passing it.

**How the embedding behaves.** From `w32_common.c`:

```c
CreateWindowExW(WS_EX_NOPARENTNOTIFY, cls, MPV_WINDOW_CLASS_NAME,
                WS_CHILD | WS_VISIBLE, 0, 0, r.right, r.bottom,
                w32->parent, 0, HINST_THISCOMPONENT, w32);
install_parent_hook(w32);
```

A real `WS_CHILD` HWND filling the parent's client rect. Then `install_parent_hook()` does something important for the in-process-vs-subprocess decision:

```c
DWORD tid = GetWindowThreadProcessId(w32->parent, &pid);
if (pid == GetCurrentProcessId()) {
    // If the parent lives inside the current process, install a Windows hook
    w32->parent_win_hook = SetWindowsHookExW(WH_CALLWNDPROC, parent_win_hook, NULL, tid);
} else {
    // Otherwise, use a WinEvent hook. These don't seem to be as smooth as
    // Windows hooks, but they can be delivered across process boundaries.
    w32->parent_evt_hook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, ...);
}
```

mpv's own source comment is the argument: **in-process libmpv gets the smooth resize path; a spawned `mpv.exe` gets the explicitly-worse cross-process one.** If you care about resize behavior — and in a video player you do — load `libmpv-2.dll` in-process rather than shelling out.

### 3.5 Known problems with `wid`, and what to do about them

| Problem | Reality | Mitigation |
|---|---|---|
| **Negative HWND → detached window** | Real; the #1 cause of "it doesn't work" reports | Read the handle **unsigned**; assert `wid > 0` |
| **Overlay / "airspace"** | Real and fundamental. mpv's `WS_CHILD` HWND owns its pixels | See §3.6 — this is the whole shell decision |
| **Input capture — the undocumented tax** | mpv's child window swallows input. mpv.net's `MainForm.WndProc` hand-forwards **~28 Win32 messages** to it | Budget a full day. See §4.5 for the exact list |
| **Resize flicker / lag** | Real when mpv runs out-of-process (`SetWinEventHook`, "not as smooth" per mpv's own comment) | Use in-process libmpv; handle `WM_SIZING`/`WM_ENTERSIZEMOVE` on the parent |
| **Keyboard input** | mpv can steal keys | `--input-vo-keyboard=no` (mpv docs: *"generally useful for embedding only"*); mpv.net also sets `input-builtin-bindings=false` and feeds its own `input.conf` via `memory://` |
| **DPI** | mpv is DPI-aware (`GetDpiForMonitor`, `AdjustWindowRectExForDpi`, `WM_DPICHANGED`). In embedded mode it defers sizing to the parent — `if (w32->parent) return;` guards `window_set_pos`/`window_resize` | Own the sizing in the shell; let mpv letterbox inside the rect it's given |
| **Transparency** | mpv sets `WS_EX_LAYERED\|WS_EX_TRANSPARENT` only for click-through; it does not composite with a parent's alpha | Don't try to make the mpv window translucent — make the *webview* transparent instead |
| **Screenshot capture** | **Not a problem.** `screenshot` / `screenshot-to-file` operate on decoded frames inside mpv, independent of the window model | Use mpv's own commands. Never `BitBlt` the HWND — you'd get black under overlay-plane presentation |
| **Window destroyed under mpv** | Handled: `case WM_NCDESTROY:` with the comment *"Sometimes only WM_NCDESTROY is received in --wid mode"* → mpv posts `MP_KEY_CLOSE_WIN` | Tear down libmpv before destroying the parent |
| **`--geometry` ignored** | Documented behavior when `--wid` is set | Size the parent window yourself |
| **`wid=0` is a trap** | `0` means "draw on the desktop wallpaper, below icons" — and the manual warns Windows may destroy that window during a wallpaper slideshow transition | Never pass 0. Assert it |

### 3.6 The overlay problem — and why it selects the shell

Because mpv's video lives in a `WS_CHILD` HWND, HTML in a sibling surface cannot simply be drawn on top of it. This is the classic *airspace* problem, and it is the constraint that makes the shell choice non-arbitrary.

**WebView2 solves it natively — first-class, supported API.** `ICoreWebView2Controller2::put_DefaultBackgroundColor` accepts alpha 0, and per Microsoft's docs, *"in the case of a transparent DefaultBackgroundColor, WebView will render hosting app content as the background"* (Windows 8+; only alpha 0 or 255 — no translucency). Stremio does exactly this — `src/stremio_app/stremio_wevbiew/wevbiew.rs`:

```rust
controller2.put_default_background_color(webview2_sys::Color {
    r: 255, g: 255, b: 255, a: 0,      // fully transparent
}).ok();
```

…while `src/stremio_app/stremio_player/player.rs` sets up mpv in the *same* parent window:

```rust
set_property!("wid", window_handle as i64);
set_property!("hwdec", "auto");
set_property!("vo", "gpu-next,gpu,");     // gpu-next preferred, gpu fallback
for (name, value) in [
    ("gpu-context", "d3d11"),
    ("d3d11-output-format", "auto"),
    ("d3d11-output-csp", "auto"),
    ("target-colorspace-hint", "auto"),   // HDR passthrough
    ("target-colorspace-hint-mode", "target"),
    ("tone-mapping", "bt.2390"),
    ("dither-depth", "auto"),
    ("deband", "yes"),
    ("scale", "spline36"),
    ("cscale", "spline36"),
] { ... }
```

Both are children of one native window (`src/stremio_app/app.rs`, using `native-windows-gui`):

```rust
#[nwg_partial(parent: window)] pub player: Player;    // mpv via wid, d3d11
#[nwg_partial(parent: window)] pub webview: WebView;  // WebView2, alpha 0, on top
```

That is the entire architecture in twenty lines, in production, with HDR passthrough intact.

**Electron does not solve it natively — and its transparency is actively unreliable.** Electron's transparency is a whole-window property (`transparent: true`), not a per-surface background color, and it carries a long tail of documented Windows bugs:

- [**#40515**](https://github.com/electron/electron/issues/40515) — "window transparency not respected (black/gray background) on some systems", **open, affecting Electron 25 through 37**, Windows 10 and 11. The reporter estimates **~5% of their Windows users** hit it, *"the vast majority showing a true black screen."* The only known fix: **disable hardware acceleration** — which defeats the entire purpose.
- [#10069](https://github.com/electron/electron/issues/10069) flicker on show; [#1391](https://github.com/electron/electron/issues/1391) / [#1671](https://github.com/electron/electron/issues/1671) white flash on resize; [#10994](https://github.com/electron/electron/issues/10994) click-through behaves differently with and without hardware acceleration; [#28439](https://github.com/electron/electron/issues/28439) a full-screen transparent overlay drops a 120 fps game to ~20 fps. Fixes are still landing as recently as [PR #49428](https://github.com/electron/electron/pull/49428) / Electron 39.2.6.

Building a video player's core compositing on a bug that black-screens 5% of your users is not a good trade.

**If Electron is non-negotiable**, the four workarounds in descending order of sanity:

1. **Put the chrome around the video, not over it**, and use mpv's own OSC for in-video UI. mpv's script ecosystem is excellent here — [uosc](https://github.com/tomasklaen/uosc) (3,340★), [ModernZ](https://github.com/Samillion/ModernZ) (1,184★), [thumbfast](https://github.com/po5/thumbfast) (1,674★) for seekbar thumbnails. Cheapest path to a shippable v1.
2. **Push your HTML OSD into mpv as a bitmap.** mpv's `overlay-add` command accepts raw BGRA, including *"a raw memory address for use as bitmap memory by passing a memory address as integer prefixed with an `&` character."* Render controls with Electron offscreen rendering, hand mpv the pointer. Real, composites at native quality — but *"passing the wrong thing here will crash the player."*
3. **A second frameless, always-on-top, click-through overlay window** synced to the video rect ([electron-overlay-window](https://github.com/SnosMe/electron-overlay-window) pattern). Works; janky under fast resize and multi-monitor moves.
4. **Give up the hardware path** and use the render API into Chromium — see §3.8.

**PPAPI is dead — do not go looking for `mpv.js`.** [`Kagami/mpv.js`](https://github.com/Kagami/mpv.js) (446★, CC0) embedded libmpv as a Pepper plugin. It died in stages: Electron 5 mixed sandbox ([#64](https://github.com/Kagami/mpv.js/issues/64) — you had to pass `--no-sandbox` to play video), libmpv deprecating `render_gl.h` ([#76](https://github.com/Kagami/mpv.js/issues/76)), Chromium 89 / Electron 13 (`glGetString(GL_VERSION) returned NULL`, [#101](https://github.com/Kagami/mpv.js/issues/101)), and finally [Chromium removing command-line PPAPI plugin loading](https://issues.chromium.org/issues/40151562). [electron#11322](https://github.com/electron/electron/issues/11322) — filed by an FFmpeg/mpv contributor — notes PPAPI was *"the only supported mechanism of integrating native graphical content into an Electron app"* and was **closed with no replacement provided**. It never had working hardware decode either: [#5](https://github.com/Kagami/mpv.js/issues/5), open since 2017, measures **80% CPU in mpv.js vs 10% in standalone mpv**. [#99 "Project dead?"](https://github.com/Kagami/mpv.js/issues/99) has no maintainer reply since 2022. Its README still tells you to use Electron 1.7/2.x.

There is a striking footnote. In [mpv-examples#27](https://github.com/mpv-player/mpv-examples/issues/27) (2019), an mpv developer dismissed the very approach that later won:

> *"On X11 and win32 you could embed the mpv window, but then it would cover the electron contents fully with no way to render web content over it… **Maybe (very maybe) you could on win32 create another window on top of that and use alpha transparency** (not sure if that works), but that's the end of it."*

That "very maybe" is exactly what Stremio shipped five years later. The mpv developers guessed the right answer and talked themselves out of it.

### 3.7 Don't reinvent the OSD — and don't reinvent the config

Two decisions that repeatedly separate trusted mpv frontends from disposable ones:

**Enable mpv's built-in OSC rather than writing your own.** mpv.net does exactly this (`SetPropertyString("osc", "yes")`). You inherit `uosc`, `ModernZ`, `ModernX`, `thumbfast` and the entire Lua/JS script ecosystem unchanged. mpv's reference UI is *itself* a Lua script (`osc.lua`), which is precisely why the frontend ecosystem works. Users have built four competing OSC replacements totalling ~7,000 stars — that demand is free to capture and expensive to duplicate.

**Hand libmpv a real `mpv.conf`.** `SetPropertyString("config-dir", ConfigFolder)` + `config=yes` makes **libmpv itself** parse the config, so users get full mpv compatibility for free. mpv's own Windows convention is worth copying exactly: `$MPV_HOME` → a `portable_config` folder next to the executable → `%APPDATA%\mpv\`. mpv.net mirrors this as `MPVNET_HOME` → `portable_config` → `%APPDATA%\mpv.net`. This is why mpv power users trust mpv.net and don't trust skinned black boxes.

### 3.8 The state of Electron ⇄ libmpv packages in 2026

This matters more than any theoretical argument: **there is no production-grade Electron mpv integration.** Measured today via the GitHub API:

| Package | License | Stars | Last push | Approach |
|---|---|---|---|---|
| `REVENGE977/electron-libmpv` | MIT | **3** | 2026-07-30 | N-API C++ addon, HWND embedding — *"Replaces legacy Pepper plugin architecture used in mpv.js with a native C++ window-embedding architecture that hooks directly into the host OS window handle for zero-copy hardware acceleration."* Windows-only. **Correct architecture, unproven.** |
| `yscoder/electron-mpv-video` | MIT | **0** | 2026-07-27 | Render API into Chromium. Three modes: `shared-texture` (**requires Electron 40+**, validated only against 40.10.5), `webgl` and `canvas2d` (both software readback). |
| `nini22P/tauri-plugin-libmpv` | MPL-2.0 | 21 | 2025-11-24 | libmpv via a Rust wrapper DLL. **Windows: "Fully tested." Linux: "Window embedding is not working." macOS: untested.** Requires `"transparent": true`. |
| `nini22P/tauri-plugin-mpv` | MPL-2.0 | 29 | 2025-11-23 | Spawns `mpv.exe`, drives it over JSON IPC. Same platform matrix. |
| `Kagami/mpv.js` | CC0-1.0 | 446 | 2024-01-17 | **Dead** (PPAPI). |
| `j-holub/Node-MPV` | MIT | 130 | 2023-04-23 | JSON IPC wrapper only, no embedding. Unmaintained since 2021 — and [#113](https://github.com/j-holub/Node-MPV/issues/113) reports the npm package now points at a **transferred/hijacked repo**. Do not depend on it. |

Compare the alternatives you could instead crib from: **mpv.net** (GPL-2.0, 5,350★, C#), **Jellyfin Desktop** (GPL-2.0, 5,663★, C++/Qt, pushed 2026-08-14), **Stremio shell-ng** (production, pushed 2026-08-25), **Screenbox** (GPL-3.0, 4,087★).

Choosing Electron means **you** write and maintain the native addon. Choosing WebView2 or .NET means you start from a working, actively-maintained reference.

`electron-mpv-video`'s README states the trade honestly (translated from Chinese): *"video continues to be rendered by Chromium, so the app can easily place HTML controls and other UI on top of the video."* That is the render-API bargain — overlay freedom bought with `gpu-next`, HDR passthrough, and (in the two non-experimental modes) CPU readback of every frame.

### 3.9 If you use JSON IPC

Only relevant if you spawn `mpv.exe` rather than loading libmpv in-process. Per [`DOCS/man/ipc.rst`](https://mpv.io/manual/master/#json-ipc):

- Windows uses a named pipe. From the manual: *"On Windows, named pipes are used, so the path refers to the pipe namespace (`\\.\pipe\<name>`). If the `\\.\pipe\` prefix is missing, mpv will add it automatically."*
- Newline-delimited minified UTF-8 JSON: `{ "command": ["set_property", "pause", true], "request_id": 1 }`. Responses `{ "error": "success", "data": null, "request_id": 1 }`; events `{ "event": "..." }`. `request_id` must be an integer.
- The manual explicitly names **.NET's `NamedPipeClientStream`** as the way to do overlapped duplex I/O on Windows — effectively an endorsement for a .NET client.
- **Security warning, verbatim:** *"This is not intended to be a secure network protocol. It is explicitly insecure: there is no authentication, no encryption, and the commands themselves are insecure too. For example, the `run` command is exposed, which can run arbitrary system commands."* **Randomize the pipe name per instance. Never expose it.**

Given §3.4's finding that out-of-process embedding takes mpv's explicitly-worse resize path, IPC is best treated as a **low-risk on-ramp and a crash-isolation fallback**, not the design. It buys you process isolation (a decoder crash can't kill your UI) and a working player in days; plan the in-process migration for when you need frame-accurate overlay compositing.

### 3.10 Deployment logistics — the comparison that settles libmpv vs libVLC

Both engines are roughly the same number of bytes. They are not remotely the same shape.

| | **libVLC** (`VideoLAN.LibVLC.Windows` 3.0.23.1) | **libmpv** (shinchiro 20260814) |
|---|---|---|
| Files copied into your app | **525** (x64 RID alone) | **1** |
| Bytes | **101.8 MiB** x64 (282.1 MiB for all three RIDs) | **114.4 MiB** |
| Shape | `libvlc.dll` (0.18 MiB) + `libvlccore.dll` (2.69 MiB) + a 363-DLL `plugins/` forest | `libmpv-2.dll` |
| Airspace-free render path | Unofficial/unsupported ([issue #342](https://code.videolan.org/videolan/LibVLCSharp/-/issues/342), open since 2020) | Documented and supported (render API) |
| LGPL cleanliness on Windows | Engine LGPL, **plugins mostly GPL** (including the Qt UI and much of the decode path) | **Fully LGPL with `-Dgpl=false`**, losing only X11/OSS/VDPAU/JACK/DVD/CDDA/DVB/CACA — every one irrelevant on Windows |
| Official .NET bindings | **Yes** (LibVLCSharp) | No — you write the P/Invoke layer |
| Renderer quality | Good | **Best in class** (`gpu-next`/libplacebo, user shaders, HDR) |

One replaceable DLL is trivially code-signable, trivially versioned, and trivially satisfies LGPL §6's relinking requirement. A 525-file tree is none of those — and it can't be trimmed, single-file'd, or statically linked *precisely because* the LGPL forbids it.

LibVLCSharp's one genuine advantage is that official .NET bindings exist. That is a few weeks of P/Invoke work against a permanent architectural constraint. Easy trade.

### 3.11 Licensing, since it constrains the choice

- **mpv/libmpv** defaults to GPLv2+ but has a real LGPLv2.1+ mode. The switch is now Meson's **`-Dgpl=false`** (the old waf `--enable-lgpl` is gone). From mpv's [`Copyright`](https://github.com/mpv-player/mpv/blob/master/Copyright) file: *"The mpv program is licensed the GNU Lesser General Public License LGPL version 2 or later … if built without using any GPL only files."* Relicensing began June 2015 and is **still partial** — the file warns the switch does not by itself grant you LGPL. An LGPL build loses X11 VO, OSS audio, VDPAU, JACK, DVD, CDDA, DVB, CACA, and the legacy Direct3D VO. **On Windows that costs you nothing**: D3D11 output, D3D11VA hwdec, WASAPI and libplacebo/`gpu-next` are all intact. Prebuilt LGPL binaries exist — [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild) publishes `mpv-dev-lgpl-x86_64-*.7z` (26.7 MB compressed).
- **libVLC** is LGPLv2.1+ (relicensed 2011-12-21) — but the LGPL covers a 0.18 MiB façade in front of 363 mostly-GPL plugins. This is not academic: in summer 2023 **Unity banned VideoLAN's publisher account** over LGPL dependencies and delisted the VLC-for-Unity assets; VideoLAN offered to strip the LGPL code and were told they were not welcome back.
- **FFmpeg's LGPL §6 obligations are real.** PotPlayer, KMPlayer and GOM Player are all on FFmpeg's Hall of Shame. Publishing exact source and build scripts for your bundled FFmpeg/mpv is both a legal requirement and a direct differentiator against all three.
- **If you read mpv.net's source, you are looking at GPL-2.0 code.** The MIT-licensed alternative, [`hudec117/Mpv.NET-lib-`](https://github.com/hudec117/Mpv.NET-lib-) (151★, WinForms + WPF), was **archived in December 2022**.

**Decide GPL-vs-permissive before writing the loader.** It is a one-line build decision with permanent consequences.

### 3.12 Recommended concrete stack

```
Shell:        WebView2 (Tauri v2, or a thin Rust/C++ shell modeled on stremio-shell-ng)
              WebView2 controller DefaultBackgroundColor = { a: 0 }
Engine:       libmpv-2.dll, loaded in-process (LGPL build, -Dgpl=false)
Embedding:    mpv property "wid" = parent HWND, passed UNSIGNED; assert > 0
Video out:    vo = "gpu-next,gpu,"      gpu-context = d3d11
              hwdec = auto-safe          (NOT on by default — you must set it)
HDR:          target-colorspace-hint = auto
              target-colorspace-hint-mode = target
              tone-mapping = bt.2390
Quality:      scale = spline36, cscale = spline36, deband = yes, dither-depth = auto
OSD:          osc = yes  — use mpv's own OSC; inherit uosc/ModernZ/thumbfast
Input:        input-vo-keyboard = no; input-builtin-bindings = false
              shell owns the keymap, feeds mpv via input-conf = memory://<content>
Config:       config-dir = <app config>, config = yes  → libmpv parses mpv.conf itself
              resolution order: $FREEVIEWER_HOME → ./portable_config → %APPDATA%
Fallback:     if libmpv fails to init, spawn mpv.exe + JSON IPC over a
              randomized named pipe (degraded resize, but never a black window)
```

If the team is a .NET team, substitute the shell with WinUI 3 and read `mpv.net`'s `src/MpvNet/Player.cs` — the whole embedding is three lines:

```csharp
MainHandle = mpv_create();
SetPropertyString("force-window", "yes");
SetPropertyLong("wid", formHandle.ToInt64());
```

### 3.13 A dissent, recorded and resolved

One research stream in this analysis reached the **opposite** conclusion — that `wid` should be avoided because it reproduces the airspace problem, and the render API should be used instead via ANGLE + D3D11 interop. That reasoning is sound *if the airspace problem is unsolvable*. On Windows it is not:

- **WebView2's transparent background is a supported, documented API**, and Stremio ships it to millions of users.
- **Stremio measured the alternative and found `wid` 2–5× more efficient.**
- **mpvQC, on Windows, uses `wid`** — and falls back to the render API only on Wayland, only because Wayland offers no embedding protocol.
- The render API's ANGLE+interop path is precisely the *"complex rendering pipeline involving ANGLE and multiple levels of composing"* that Stremio's README blames for the 2–5× gap.

The dissent is right about one thing worth carrying forward: **if you are locked into WPF**, you get the airspace hack either way (LibVLCSharp and `wid` both), and the interop path deserves a prototype. But WinUI 3 and WebView2 both offer real compositing, and the recommendation stands.

---

## 4. Per-player deep dives

### 4.1 PotPlayer — the incumbent

**License:** Freeware, closed source. Licensor is **Kakao Corp.** (Daum merged into Kakao in 2014).
**Engine:** DirectShow with a large set of *internal, non-swappable* codecs — a forked FFmpeg (`ffcodec.dll`) plus its own splitters and renderers. Hardware decode via DXVA/DXVA2, D3D11, NVDEC/CUDA and Intel Quick Sync. An optional **OpenCodec** pack adds DTS, MLP, TrueHD, software HEVC and H.264 MVC 3D. It can also be pointed at external filters (LAV Filters, madVR).
**Size:** ~33–55 MB installer depending on variant; ~30–40 MB installed. The 64-bit installer is *smaller* than the 32-bit one because it drops the internet/chat/broadcasting/TVPot components and RealMedia codecs.

**Lineage.** Written by **Kang Yong-Huee (강용희)** — the same author who wrote KMPlayer (2002). He sold KMPlayer to Pandora TV in 2007, joined Daum, and launched PotPlayer in May 2008. He ran development in the open out of a Daum Cafe forum for years, which is a large part of the Korean brand loyalty.

**Three corrections to common assumptions:**

1. **`potplayer.daum.net` is dead.** DNS returns NXDOMAIN. The Korean domestic site shut down **2026-07-01**; `potplayer.tv` is now the only live site. Kakao TV itself shut down 2026-06-22, and the `[260622]` build removed Kakao TV integration entirely.
2. **There *is* an official English changelog** — just unlinked: `https://t1.daumcdn.net/potplayer/PotPlayer/v4/Update2/UpdateEng.html`, going back to v1.5.32007 (February 2012). The real criticism isn't "no English changelog"; it's that this is a bare CDN HTML file with no RSS, no version tags, no diff, and no source.
3. **It is very much alive.** `[260819]` (2026-08-19) added an **ARM64 build**, per-side double-click actions, and playlist sort by release date. Recent releases added **libass subtitle rendering** and in-house HLS/DASH (`[260401]`), and **real-time speech-to-text subtitle generation** (`[250909]`). Roughly quarterly cadence, still adding real features. Positioning that assumes PotPlayer is abandoned will be wrong.

**Why Korean users love it.**
- **SMI/SAMI subtitle handling is best in class** — Ruby tags, encoding auto-detection, multiple simultaneous tracks, on-the-fly resync. SAMI is the Korean de-facto subtitle format and nobody else handles it properly.
- **Broken and partial `.ts` playback.** Korean OTA/IPTV recordings are transport streams; PotPlayer plays damaged ones where others fail.
- Native Korean UI, Daum/Kakao portal integration, and the Naver/Daum subtitle ecosystem.
- Genuinely light on low-end hardware.

**Update and monetization behavior — the actual grievance.**
- **Ads and bundling from July 2019.** Bundled third-party antivirus (users specifically report Avast) plus pop-up ads in the lower-right corner. Opt-out checkboxes reportedly didn't always work, and in some builds were removed. Wikipedia records the ads as gone by 2021.
- **Region-discriminatory ads.** Kakao served ads to the *Korean* build while the multilingual build stayed ad-free — and tightened the check after users worked around it by switching language.
- **2021 cookie-reading incident** — PotPlayer was caught reading browser cookies; Kakao called it an advertising-system error.
- **Update nagging** — long-standing complaints that "never check for updates" doesn't persist across restarts, that it prompts to update to the version already installed, and that having both 32-bit and 64-bit installed produces perpetual nags. Recent builds added **code-integrity checks that block third-party modification of the executable**, actively defeating the community's nag-removal patches.
- **Telemetry is disclosed in the EULA**: "system information (OS type, CPU, memory, graphics card, etc.)" with no described granular opt-out. The EULA also forbids reverse engineering, modification and redistribution, and reserves the right to remove features.

**Security — the structural argument for open source.**

| CVE | CVSS | Detail |
|---|---|---|
| CVE-2021-40212 | **9.8** | Out-of-bounds write in 1.7.21523 → code execution |
| CVE-2018-16797 | 7.8 | Heap overflow in `PotPlayerMini.exe` via crafted `.wav` → RCE |
| CVE-2013-7185 | 7.8 | `.avi` memory corruption |
| CVE-2013-3942 | 7.8 | Insecure DLL loading (DLL hijack) |
| CVE-2022-4246 | 7.5 | MID file handler DoS |

Every one is a **media-parsing bug in closed-source internal demuxers/decoders**. A player built on hardened, continuously-fuzzed upstream libraries has a structurally better story, and it is worth saying so out loud.

**License compliance.** PotPlayer is on **FFmpeg's Hall of Shame** — the complaint being that Daum shipped a self-compiled `ffcodec.dll` whose published source did not match the distributed binary, an LGPL §6 violation. Unresolved for over a decade.

### 4.2 VLC — the trust benchmark and the UI cautionary tale

**License — the dual situation, precisely.** This is routinely stated wrong. There are two licenses on two different artifacts:

| Artifact | License |
|---|---|
| **VLC media player** (the app, the Qt interface, most plugins) | **GPL-2.0-or-later** |
| **libVLC / libVLCcore** (the engine: `libvlc.dll`, `libvlccore.dll`) | **LGPL-2.1-or-later** |

The relicensing happened **2011-12-21** ([press release](https://www.videolan.org/press/lgpl-libvlc.html)) — ~150 developers, ~80,000 lines, non-responders' code rewritten. Verbatim: *"The license of VLC media player will continue to be GPLv2 or later."* The driver was App Store compatibility.

**The trap:** LGPL-2.1 §6 is not "free for commercial use, done." You must dynamically link, ship source or a written offer, permit modification for the customer's own use and reverse engineering for debugging, and allow the user to **relink** against a modified libVLC. In practice: `libvlc.dll` must ship as a replaceable loose DLL — never statically linked, never inside a signed single-file bundle. And **the plugins are where it gets sharp**: `libvlc.dll` is LGPL, but the 363 plugin DLLs it loads are mostly GPL, including `libqt_plugin.dll` and much of the decode path.

Not theoretical: in summer 2023 **Unity banned VideoLAN's publisher account** over LGPL dependencies and delisted the VLC-for-Unity assets. VideoLAN offered to strip all LGPL code; Unity said they were not welcome back regardless. They had to build [their own store](https://mfkl.github.io/2024/01/10/unity-double-oss-standards.html) at Videolabs.

**Architecture, measured.** Unpacking `vlc-3.0.23-win64.zip`:

| Component | Size | Note |
|---|---|---|
| `libvlc.dll` | **0.18 MiB** | The public LGPL API surface — a thin façade |
| `libvlccore.dll` | 2.69 MiB | Module loader, clock, ES/input/output pipeline |
| `plugins/` | **132.7 MiB across 363 DLLs** | Everything else |
| `plugins/gui/libqt_plugin.dll` | 16.66 MiB | **The entire desktop UI is a plugin** |
| `plugins/codec/libavcodec_plugin.dll` | 16.53 MiB | FFmpeg, wrapped as one module |
| **Total on disk** | **182.7 MiB / 851 files** | |

The core builds a processing graph at runtime by probing modules by capability and priority. **VLC keeps its own demuxers, muxers and protocol modules** (MP4, MKV, TS, AVI, ASF, HTTP, RTSP, DVD/BD, DVB) and delegates most *codec* work to libavcodec. That's the opposite split from most players, and it's why VLC opens broken and exotic containers that FFmpeg-only players choke on — the demuxers are hand-maintained and forgiving.

**Install size, byte-exact from `get.videolan.org`:**

| Release | Bytes | Size | Date |
|---|---|---|---|
| 3.0.21 win64 exe | 44,943,296 | 42.9 MiB | 2024-06-05 |
| 3.0.22 win64 exe | 45,548,048 | 43.4 MiB | 2025-11-27 |
| **3.0.23 win64 exe** | **45,948,080** | **43.8 MiB** | 2025-12-31 |
| 3.0.23 msi | 60,608,512 | 57.8 MiB | |
| 3.0.23 portable 7z | 39,583,707 | 37.8 MiB | |
| **3.0.23 unpacked** | **191,616,157** | **182.7 MiB / 851 files** | |

**The VLC 4.0 saga — the definitive timeline.** Master became `4.0.0-dev` in [commit 6e8e1ef](https://github.com/videolan/vlc/commit/6e8e1ef305025cce2cdf2d4be26054d13bf7d694), by Jean-Baptiste Kempf, **2017-11-30**. **That is 8 years and 9 months ago, and VLC 4.0 still has not shipped on desktop.**

- 2018-02 — VLC 3.0 "Vetinari" ships
- 2019-02 — 4.0 previewed at FOSDEM; first nightlies
- 2021-02 — press cycle: "VLC 4.0 coming later this year." It did not.
- 2023-12 — the UI-redesign milestone stands at **36 of 111 tasks**
- 2025-11 / 2025-12 — 3.0.22 and 3.0.23 ship instead, **backporting Qt6, dark mode and Windows ARM64 into the 3.x branch**
- 2026-07-23 — Kempf blogs that **VLC 4.0.0-alpha "Otto Chriek"** is shipping in production on Amazon Fire TV / Vega OS: *"it is the **first VLC 4.0 in production**. Before VLC 4.0 is even released on the desktop, it is shipping today, on real devices."* On desktop: *"The desktop release is coming too. Slowly, yes."*

The new UI is **Qt Quick / QML**, shared between the TV and desktop builds.

**Why the UI is disliked — sourced.** The canonical HN comment, [id=13573499](https://news.ycombinator.com/item?id=13573499): *"VLC's UI sucks so terribly, it's like they went WAY out of their way to make it suck on purpose, and stubbornly refuse to acknowledge that there are any problems or ever consider fixing them."* Re-litigated in 2024 at [id=41281153](https://news.ycombinator.com/item?id=41281153), which quotes a VLC core dev's response to UI complaints — *"I'll be waiting for your patch. Surely you're not as lazy and incompetent as the existing volunteer developers"*.

The single best-aimed complaint, [id=45905858](https://news.ycombinator.com/item?id=45905858) (2025-11): *"It's insane that clicking on the video in the VLC interface does nothing. In every other app it is play/pause. There's a way to enable it deep in settings… but it should be the default."*

**The preferences maze.** Simple mode plus an "All" mode with thousands of settings in a tree. The canonical example: "don't resize my window" lives at **Interface → Main Interfaces → Qt → "Resize interface to the native video size."** Nobody finds that. The pattern — the correct setting exists and nobody can locate it — is the defining VLC UX failure.

**The traffic cone** comes from a 1996 student tradition at École Centrale Paris of collecting road cones after parties. VLC has **never** shipped a modern default skin; the skins engine is a legacy Winamp-era system almost nobody uses.

**And the 4.0 UI is already being criticised — before it ships.** [Dedoimedo's preview](https://www.dedoimedo.com/computers/vlc-4-preview.html): *"As always, ALWAYS, when you introduce touch stuff to the desktop, you lose efficiency."* Specifics: you **can't browse the local filesystem** (it shows location handlers and a media library; the file menu hides behind a three-dot icon); pale grey-on-grey; video opens in a separate window with no controls; more clicks than 3.x for everything. [9to5Mac](https://9to5mac.com/2021/02/16/vlc-4-user-interface/) independently called it "an iOS-like approach to simplicity."

**Strategic read:** VLC is about to replace a UI people hate with a UI people already dislike for the *opposite* reason — library-first, touch-derived, filesystem-hostile. **There is a wide-open lane for a desktop player that is unapologetically file-first and mouse-first.**

**Trust is VLC's real asset, and the bar to clear.** 1 billion downloads (2012) → 3 billion (2019) → 5 billion (2024) → **6 billion (CES, January 2025)**. No ads, no telemetry, no account, no bundleware. Kempf publicly refused offers reported as *"several tens of millions of Euros"* to monetize. Updates are a manual check-for-updates prompt — no background updater service. **Monetization behavior: none.**

**CES 2025 offline AI subtitles.** Announced 2025-01-13: local, offline automatic subtitle generation and translation across 100+ languages, built on **`whisper.cpp`** running **inside the VLC executable** — no cloud, no account, no subscription. **As of August 2026 it has still not shipped in a stable release**; it's gated behind VLC 4.0. There is an opportunity here: nobody has shipped this on Windows yet, and PotPlayer already ships a speech-to-text subtitle generator.

**Hardware decoding on Windows.** On by default since 3.0. **D3D11VA** is the primary path (`modules/codec/avcodec/d3d11va.c`, Windows 8+), paired with the `direct3d11` video output, zero-copy where the driver allows; **DXVA2** is the Windows 7 fallback. Controlled by `--avcodec-hw=`. Caveat: D3D11VA output goes to VLC's own D3D11 swapchain — any host needing the frame in its *own* GPU context is fighting the design.

### 4.3 LibVLCSharp — official, and still the wrong foundation

[github.com/videolan/libvlcsharp](https://github.com/videolan/libvlcsharp) — **1,805★, LGPL-2.1, branch `3.x`, last push 2026-08-05.** Actively maintained. Note only 4 open GitHub issues, because the real tracker is GitLab at `code.videolan.org`.

**Framework matrix (genuinely impressive):** WPF, WinForms, GTK, Avalonia, Eto.Forms, UWP, **WinUI 3** (split into `LibVLCSharp.WinUI` in 3.10.0), Uno Platform 5, .NET MAUI, Xamarin.*, Unity3D, ASP.NET Core, headless .NET Standard 1.1+.

**Package sizes — the number that matters.** Measured against `api.nuget.org`:

| Package | Version | .nupkg | Note |
|---|---|---|---|
| `LibVLCSharp` | 3.10.1 | 2.65 MiB | managed bindings |
| `LibVLCSharp.WPF` | 3.10.1 | 0.05 MiB | |
| **`VideoLAN.LibVLC.Windows`** | **3.0.23.1** | **128.06 MiB** | native engine |
| `VideoLAN.LibVLC.Windows` | 3.0.21 (2024-09) | 85.82 MiB | for comparison — **+49% in 19 months** |

Unpacked, 3.0.23.1 is **282.1 MiB** across three RIDs: x64 **101.8 MiB / 525 files**, x86 98.3 MiB / 525 files, arm64 82.0 MiB / 512 files. **A single-RID x64 .NET app copies ~102 MiB across 525 files into `bin/`** — your installer, your code-signing surface, your MSIX payload, your antivirus scan time. And per §3.11 it *must not* be trimmed or single-file'd, or the LGPL breaks.

**The WPF airspace problem, in VideoLAN's own words** ([WPF README](https://github.com/videolan/libvlcsharp/blob/3.x/src/LibVLCSharp.WPF/README.md)):

> *"If you encounter UI issues with the WPF VideoView in your application, you may be running into what is called* airspace *limitations."*
> *"The `VideoView` appears as a container in your XAML … but **it is really a detached window over your video control**."*

The workaround is a stack of three windows: WPF window → `WindowsFormsHost` child HWND (video) → a second transparent top-level `ForegroundWindow` carrying your overlay, manually synced to the video rect. That forces non-idiomatic XAML — overlays must be *inside* the `VideoView`, not siblings — and it comes with documented restrictions: **non-uniform scale, negative scale (mirroring) and non-uniform `Viewbox` are limited; rotation and skew are unsupported.** Mouse events need a non-transparent background on the overlay; the docs literally suggest `#02000000` (alpha 2/255) as the hit-testing hack.

**Open issues, with dates:**

- [#67 — WPF video view "invisible" when alignments are set](https://code.videolan.org/videolan/LibVLCSharp/-/issues/67) — **open since 2018-11-30. Seven years and nine months.**
- [#524 — WPF: support ScrollViewer](https://code.videolan.org/videolan/LibVLCSharp/-/issues/524) — open since 2021-11-30
- [#523 — overlay position hook not working properly](https://code.videolan.org/videolan/LibVLCSharp/-/issues/523) — *"the overlay flies around somewhere on the window when the position of the window is changed"*, reproducible in VideoLAN's own sample
- [#641 — video disappears when switching themes](https://code.videolan.org/videolan/LibVLCSharp/-/issues/641) · [#557 — VideoView lies on top of all other XAML](https://code.videolan.org/videolan/LibVLCSharp/-/issues/557) · [#491 — hidden when TabControl selection changes](https://code.videolan.org/videolan/LibVLCSharp/-/issues/491) · [#383](https://code.videolan.org/videolan/LibVLCSharp/-/issues/383) · [#381 — unable to receive mouse events](https://code.videolan.org/videolan/LibVLCSharp/-/issues/381) · [#267](https://code.videolan.org/videolan/LibVLCSharp/-/issues/267) · [#130](https://code.videolan.org/videolan/LibVLCSharp/-/issues/130)
- **D3D11 interop:** [#342 — `libvlc_video_set_output_callbacks` + `D3DImage`](https://code.videolan.org/videolan/LibVLCSharp/-/issues/342), the "proper" airspace-free route — open since 2020, never became the supported default
- **Memory leaks:** [#252 (UWP)](https://code.videolan.org/videolan/LibVLCSharp/-/issues/252) open since 2019-11-01; [#442 — memory grows when switching Media](https://code.videolan.org/videolan/LibVLCSharp/-/issues/442) open since 2021-02-23

The [NEWS file](https://github.com/videolan/libvlcsharp/blob/3.x/NEWS) reads like a chronicle of the same fight: *"WPF: Add WS_CLIPCHILDREN window style to fix white window background"*, *"WPF: support Viewbox contained and scaled video host"*, fixes for disappearing foreground windows, D3D11 device-creation fallbacks, zero-window-height crashes. Recent commits are all Uno/WinUI/MAUI plumbing. **The WPF airspace architecture is frozen, not being revisited.**

**Performance forces a bad choice.** The HWND path is fast (D3D11, hardware-decoded, zero-copy) but carries the airspace hack. The bitmap/`ImageSource` path is airspace-free but copies every decoded frame into a managed WPF surface — reports converge on *"really slow and uses too much CPU, especially for 4K videos."*

**Real-world confirmation: Screenbox** ([huynhsontung/Screenbox](https://github.com/huynhsontung/Screenbox), GPL-3.0, **4,087★**, pushed 2026-08-27, 234 open issues) is LibVLCSharp + WinUI/UWP, running on Windows and **Xbox**. **v0.21.0 msixbundle = 259.8 MB; sideload zip = 338.4 MB.** Its tracker is a catalogue of the GPU/HDR interop pain you inherit: [#1078](https://github.com/huynhsontung/Screenbox/issues/1078) black screen in windowed mode with HDR/HEVC under NVIDIA VSR; [#877](https://github.com/huynhsontung/Screenbox/issues/877) / [#729](https://github.com/huynhsontung/Screenbox/issues/729) black screen with RTX VSR; [#711](https://github.com/huynhsontung/Screenbox/issues/711) stuttering and corruption; [#728](https://github.com/huynhsontung/Screenbox/issues/728) / [#656](https://github.com/huynhsontung/Screenbox/issues/656) playback crashes.

**Net assessment:** LibVLCSharp gets you a .NET API in an afternoon and an enormous framework matrix. It costs ~102 MiB × 525 files in your output directory, a seven-year-old unsolved airspace architecture on WPF, transform restrictions that break any design using rotation or non-uniform scaling, and LGPL relinking obligations that forbid single-file deployment. **For a player where the overlay UI *is* the product, this is the wrong foundation.**

### 4.4 mpv — the engine

**License:** GPL-2.0-or-later by default; **LGPL-2.1-or-later** via Meson's `-Dgpl=false`. See §3.11 — on Windows the LGPL build costs nothing.
**Lineage:** MPlayer → mplayer2 (~2010) → **mpv** (2012, by Vincent "wm4" Lang; first release 2013-08-07). Zero developer overlap with MPlayer today. From the [FAQ](https://github.com/mpv-player/mpv/wiki/FAQ): *"While MPlayer focuses on maintenance and not breaking old code and features, mpv wanted to go in the other direction, modernization."*
**36,705 stars.** Latest stable **v0.41.0 (2025-12-21)**.

**Architecture.** FFmpeg for essentially everything decode-side — unlike VLC, mpv maintains no parallel demuxer stack. Plus **libplacebo**, **libass** (best-in-class ASS/SSA rendering), and optional Lua/JS.

**The crown jewel is `vo_gpu_next`.** A from-scratch GPU renderer over OpenGL/Vulkan/D3D11 with 100+ tunables: scalers (`ewa_lanczossharp`, `spline36`), correct linear-light scaling, debanding, dithering, ICC color management, HDR tone-mapping, frame interpolation, and **user shaders** (`.hook` — this is what makes Anime4K / RAVU / FSRCNNX possible). Built on libplacebo, it **became the default in v0.41.0**: *"faster across the board, owing to refactors and rewrites of many key algorithms (EWA scaling, frame interpolation, color management, PRNG/debanding), and aggressively merges shader passes wherever possible."*

**Windows hardware decode, from the manual:**
```
:d3d11va:      requires --vo=gpu or --vo=gpu-next with --gpu-context=d3d11
               or --gpu-context=angle (Windows 8+ only)
:d3d11va-copy: copies video back to system RAM (Windows 8+ only)
:dxva2:        requires --vo=gpu with --gpu-context=d3d11, angle, or dxinterop
```
**Critical gotcha:** *"Hardware decoding is not enabled by default, to keep the out-of-the-box configuration as reliable as possible."* **A frontend must set `hwdec` itself.** The manual also flags `dxva2` as "not safe" — it "appears to always use BT.601 for forced RGB conversion." Use `d3d11va` / `auto-safe`.

**No GUI, by design.** The homepage: mpv *"strives for minimalism and provides no real GUI."* The FAQ: *"**Q: Does mpv have a GUI?** No. But there is the OSC (on-screen-controller)."* The OSC is `osc.lua` — **a Lua script, not C++**. The reference UI is a scriptable overlay, which is precisely why the frontend ecosystem exists and works.

**Config-driven.** Every CLI flag is a config key; one namespace across CLI, `mpv.conf`, `input.conf`, IPC, and scripting. Windows paths from the manual: `%APPDATA%/mpv/`, cache at `%LOCALAPPDATA%/mpv/cache`, watch-later at `%LOCALAPPDATA%/mpv/watch_later`, `$MPV_HOME` overrides everything, and **`portable_config`** next to `mpv.exe` overrides all of it — *"provided for convenience"* because *"Windows is very special."*

**Scripting:** Lua (primary), **JavaScript** (MuJS — *"near identical to its Lua support"*, with `mp`, `mp.utils`, `mp.msg`, `mp.options`, `mp.input` preloaded), and C plugins. Scripts register key bindings, observe properties, hook the load pipeline, and draw OSD overlays.

**The user-script ecosystem is the real GUI, and it is healthy:**

| Script | Stars | License | Last push |
|---|---|---|---|
| [tomasklaen/uosc](https://github.com/tomasklaen/uosc) | **3,340** | LGPL-2.1 | 2026-08-03 |
| [po5/thumbfast](https://github.com/po5/thumbfast) | **1,674** | MPL-2.0 | 2026-08-12 |
| [Samillion/ModernZ](https://github.com/Samillion/ModernZ) | **1,184** | LGPL-2.1 | 2026-06-04 |
| [cyl0/ModernX](https://github.com/cyl0/ModernX) | 755 | — | 2026-02-04 |

~7,000 stars of user-built UI on an engine whose authors refuse to write one. That demand is free to capture and expensive to duplicate.

**libmpv C API** (`mpv/client.h`, `MPV_CLIENT_API_VERSION = 2.5`, 45 exported functions):

```c
mpv_handle *mpv_create(void);
int  mpv_initialize(mpv_handle *ctx);
int  mpv_set_option_string(mpv_handle *ctx, const char *name, const char *data);
int  mpv_command(mpv_handle *ctx, const char **args);
int  mpv_set_property_string(mpv_handle *ctx, const char *name, const char *data);
int  mpv_observe_property(mpv_handle *ctx, uint64_t reply_userdata,
                          const char *name, mpv_format format);
mpv_event *mpv_wait_event(mpv_handle *ctx, double timeout);
void mpv_set_wakeup_callback(mpv_handle *ctx, void (*cb)(void *d), void *d);
void mpv_terminate_destroy(mpv_handle *ctx);
```

Plus `mpv_create_client` / `mpv_create_weak_client` (multiple independent clients on one core), `mpv_hook_add` / `mpv_hook_continue` (intercept the load pipeline), `mpv_command_node` (nested maps/arrays via `MPV_FORMAT_NODE`), `mpv_request_log_messages`, `mpv_abort_async_command`.

**Render API threading rules are strict** and worth reading before you commit to that path: one `mpv_render_*` call at a time; never from a wakeup callback; the GL context must be current on the calling thread and be the same one the context was created with — *"otherwise, undefined behavior will occur"*; and the render thread must not call non-render libmpv APIs or wait on a thread that does, or you get **deadlocks made non-fatal by timeouts, degrading playback quality.**

**Install size, measured** (shinchiro `20260814`, `v0.41.0-922-gf4d13e1c2`):

| Package | Compressed | Uncompressed | Files |
|---|---|---|---|
| `mpv-x86_64` (player) | **32.0 MiB** | **120.0 MiB** | **13** |
| `mpv-dev-x86_64` (libmpv SDK) | 29.7 MiB | 114.4 MiB | **6** |

Inside: **`mpv.exe` = 114.21 MiB, one statically-linked binary**; **`libmpv-2.dll` = 114.21 MiB, one file** (plus `libmpv.dll.a` and four headers). Compare §3.10.

**No official binaries.** [mpv.io/installation](https://mpv.io/installation/): *"All binary packages are unofficial third-party builds, except as noted."* Use **shinchiro** or **zhongfly** (the latter also publishes LGPL builds).

**Why developers build frontends on it.** The [Applications using mpv](https://github.com/mpv-player/mpv/wiki/Applications-using-mpv) wiki lists ~60. **IINA has 46,104 stars — more than mpv itself (36,705).** That is the strongest possible evidence that the frontend, not the engine, is the product users want. Both **Plex's C++ HTPC client** and **Jellyfin Desktop** use mpv; the two largest media-center vendors independently concluded that writing a playback engine is not worth it.

The reason, put plainly: FFmpeg is a *toolkit*; libmpv is a *player*. A/V sync, seeking, subtitle timing and rendering, audio device switching, HDR tone-mapping, hwdec fallback chains, and a decade of "this weird file plays wrong" bug reports all arrive pre-solved.

### 4.5 mpv.net — the closest reference implementation, and a vacancy

**GPL-2.0 · C# · 5,350★ · 220 forks · v7.1.2.0 (2026-01-09) · 156 open issues**
**Size:** 36.3 MB setup / 108.9 MB portable zip. Requires .NET 10 Desktop Runtime (not bundled).

This is the single most directly relevant project to FreeViewer: a Windows GUI wrapped around libmpv, in a managed language, using `wid` embedding.

> **⚠️ The project is orphaned.** Maintainer stax76 (Frank) announced retirement for health reasons in [issue #733](https://github.com/mpvnet-player/mpv.net/issues/733) on 2025-04-30. On **2026-05-07 his sister posted in that same thread that he passed away in February 2026**, adding that the family cannot manage the technical or financial side. Last code commit: 2026-02-09. **No fork has stepped up** — the largest, `WandersondeSouza/mpv.net`, has 7 stars and is mostly release-script hardening; everything else is a 0–1 star mirror. Combined with Haruna and Celluloid being Linux-first, **there is currently no actively-maintained, modern-UI, Windows-first mpv frontend.**

**Architecture.** A WinForms `MainForm` hosts everything and is itself the `wid` target; a `Player` class wraps libmpv over P/Invoke; **WPF** handles the secondary windows (`ConfWindow`, `InputWindow`, `MsgBoxEx`) plus a vendored subset of HandyControl. Dark mode via `DwmSetWindowAttribute(Handle, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, ...)`.

`src/MpvNet.Windows/WinForms/MainForm.cs:71` → `Player.Init(Handle, true);`
`src/MpvNet/Player.cs`:

```csharp
public void Init(IntPtr formHandle, bool processCommandLine)
{
    MainHandle = mpv_create();
    ...
    if (formHandle != IntPtr.Zero)
    {
        SetPropertyString("force-window", "yes");
        SetPropertyLong("wid", formHandle.ToInt64());
    }
    SetPropertyBool("input-default-bindings", true);
    SetPropertyBool("input-builtin-bindings", false);   // shell owns the keymap
    SetPropertyBool("input-media-keys", true);
    SetPropertyString("config-dir", ConfigFolder);
    SetPropertyString("config", "yes");
    SetPropertyString("osc", "yes");                    // use mpv's own OSC
    SetPropertyString("screenshot-directory", "~~desktop/");
    ...
    if (!string.IsNullOrEmpty(UsedInputConfContent))
        SetPropertyString("input-conf", @"memory://" + UsedInputConfContent);
}
```

**Five patterns worth stealing verbatim:**

1. **`input-builtin-bindings = false` + `input-conf=memory://<content>`** — the shell composes the keymap and hands it to mpv in memory. No temp files, and it keeps mpv's `input.conf` semantics.
2. **`config-dir` pointed at the app's own folder** with `config=yes`, so **libmpv itself parses `mpv.conf`**. Full mpv config compatibility for free.
3. **Config resolution order:** `MPVNET_HOME` → `<exe dir>\portable_config` → `%APPDATA%\mpv.net`, mirroring mpv's own Windows convention exactly.
4. **`osc=yes` — do not write your own OSC.** Inherits `thumbfast`, `uosc`, `ModernZ` and the whole script ecosystem unchanged.
5. **The menu is generated from `input.conf`.** `App.MenuSyntax = "#menu:"` — keybindings annotated with a `#menu:` comment become the WPF `ContextMenu` tree. Track/audio/subtitle submenus are rebuilt live from libmpv's track list, issuing `set vid`/`aid`/`sid`. One source of truth for keys and menus.

**The hidden cost of `wid` that nobody advertises.** mpv creates a child window of class `"mpv"` inside the form, and it swallows input. `MainForm.WndProc` locates it and hand-forwards roughly **28 Win32 messages**:

```csharp
if (MpvWindowHandle == IntPtr.Zero)
    MpvWindowHandle = FindWindowEx(Handle, IntPtr.Zero, "mpv", null);

if (MpvWindowHandle != IntPtr.Zero && !ignore)
    m.Result = SendMessage(MpvWindowHandle, m.Msg, m.WParam, m.LParam);
```

Covering `WM_SETFOCUS`, `WM_KILLFOCUS`, `WM_MOUSEACTIVATE`, every `WM_*BUTTON*` variant (L/R/M/X, down/up/dblclk), `WM_MOUSEWHEEL`, `WM_MOUSEHWHEEL`, `WM_KEYDOWN/UP`, `WM_SYSKEYDOWN/UP`, twelve `WM_IME_*` messages, and `WM_MOUSELEAVE` — plus `WM_APPCOMMAND` translated to mpv keypresses for media keys (`MpvHelp.WM_APPCOMMAND_to_mpv_key()` → `Player.Command("keypress " + key)`) and `WM_INPUTLANGCHANGE` → `ActivateKeyboardLayout`. **Budget a full day for this.** Setting `--input-vo-keyboard=no` reduces but does not eliminate it.

**Related .NET libraries.** [`hudec117/Mpv.NET-lib-`](https://github.com/hudec117/Mpv.NET-lib-) (151★, **MIT**, WinForms + WPF) is the permissively-licensed alternative to reading mpv.net's GPL source — but it was **archived in December 2022**. Upstream also ships an official [`csharp` WinForms `wid` example](https://github.com/mpv-player/mpv-examples/tree/master/libmpv) in mpv-examples.

### 4.6 MPC-HC / MPC-BE / LAV Filters — the lightweight incumbents

Measured live from the GitHub Releases API:

| Project | License | Latest | Date | Size | Stars |
|---|---|---|---|---|---|
| **clsid2/mpc-hc** | GPL-3.0 | 2.8.1 | 2026-08-22 | **21.88 MB** x64 installer | 15,541 |
| **Aleksoid1978/MPC-BE** | GPL-3.0 | 1.9.1 | 2026-08-08 | 18.96 MB x64 installer | 4,424 |
| **Nevcairiel/LAVFilters** | GPL-2.0 | 0.83 | 2026-08-17 | 15.54 MB installer | 9,110 |
| **Aleksoid1978/VideoRenderer** | GPL-3.0 | 0.10.7 | 2026-08-01 | **0.79 MB** | 1,704 |

Original MPC-HC was discontinued 2017-07-16 ("a shortage of active developers with C/C++ experience"). The **clsid2 fork is the live one** and is thriving — 55,861 downloads of the 2.8.1 x64 installer within days of release. Current feature set is competitive: dark/light themes, **seekbar thumbnail previews**, HDR and Dolby Vision, HEVC/VVC/AV1/AC4, **libass + WebVTT** subtitle rendering, a **web remote UI for phone control over LAN**, yt-dlp integration, playback speed with pitch correction, resume position, A-B repeat.

**Why it's lightweight:** it delegates. MPC-HC is a DirectShow graph builder plus an MFC UI; demuxing, decoding and rendering live in LAV Filters and MPC Video Renderer. VLC by contrast bundles its own implementation of nearly everything — hence 21.88 MB vs 43.8 MB.

**Why not to copy it.** DirectShow's filter selection is driven by a **"merit" integer that each filter's own author writes into the registry**. Merit has no relationship to quality; highest merit wins. And once a filter accepts input, **DirectShow will not try another filter** even if the first crashes — there is no fallback. That single design decision is the entire origin of "codec pack hell": ffdshow registers a deliberately enormous merit and hijacks ~95% of decode decisions when installed; K-Lite Full has historically shipped four subtly incompatible MPEG/MP4 splitters and two different VSFilter versions. Filters compete by escalating their own priority — a registry arms race. One bad installer breaks playback **system-wide for every DirectShow application**, because the state is global.

Microsoft classifies DirectShow as **legacy**, *"superseded by MediaPlayer, IMFMediaEngine, and Audio/Video Capture in Media Foundation,"* and strongly recommends new code not use it and existing code be rewritten. It still works and will for years, but it is a dead-end API with global mutable state. libmpv is process-local and deterministic. **Do not repeat the mistake.**

Also worth knowing: **madVR is effectively in maintenance.** madVR Labs has pivoted to the Envy hardware video processor line (Envy Extreme/Pro MK3, 8K/48Gbps HDMI 2.1, previewed at ISE 2026). **MPC Video Renderer** is where active free-renderer development happens — and at 0.79 MB it is a remarkable piece of engineering.

### 4.7 KMPlayer and GOM Player — the cautionary tales

**KMPlayer** (Pandora TV). Adware-supported, closed source. Latest **2026.7.24.12**; ~57 MB download, **150 MB installed** per its own system requirements. Historically shipped with the **installCore** bundler; community reports describe an installer that *"ignores what you select and installs toolbars even if the options are NOT checked."* **Kaspersky flags it as an Unwanted Program**; herdProtect showed detection by seven engines. Independent reviewers describe **KMPlayer 64X as an MPC-HC clone** with a barely-modified GUI — if true, a GPLv3 compliance problem stacked on the adware problem. Also on FFmpeg's Hall of Shame. Highest install size, worst distribution hygiene, weakest technical differentiation of the three Korean players.

**GOM Player** (GOM & Company, formerly Gretech). First released 2003-01-07; won the Korean market on **SMI support and broken-file playback** in the P2P era — decisive when Sasami Player died and Adrenaline was unstable. Latest 2.3.122 (2026-08-18), 22–32 MB. Free tier is ad-supported; **GOM Player Plus** is ₩11,000 lifetime and adds AI upscaling and 90-language speech-recognition subtitles. Its **Codec Finder** is a monetization surface — detect a missing codec, route the user into GOM's own download flow. Its subtitle auto-search fingerprints your files, which triggered 2007 privacy allegations about transmitted filenames.

**The 2014 supply-chain attack is the single most important incident in this space.** GOM Player's **Japan-region update server was compromised**. The update served `GoMPLAYER_JPSETUP.EXE`, a RAR containing both the legitimate update *and* a malicious payload: an `install.exe` stub detected architecture, XOR-decrypted embedded files (key `0x14`), and registered a malicious **OCX in multiple registry locations to hijack `explorer.exe`**, extracting C2 credentials from base64+XOR-encoded PDFs. Kaspersky detection: **`Backdoor.Win32.Miancha`**.

On 2014-01-07 Japanese media reported an infected PC at the **Monju fast breeder reactor** (Japan Atomic Energy Agency). The Atlantic Council's *Breaking Trust* supply-chain study reports **over 40,000 internal emails exfiltrated**, and uses it as the canonical case of innocuous code reaching a high-consequence target — Monju was almost certainly collateral of a mass-distribution compromise, not the intended target. GOM Player had ~6 million Japanese users at the time. JPCERT confirmed administrative systems were hit.

> **Attribution caveat:** this is often misattributed to North Korea / DarkSeoul. DarkSeoul (2013-03-20, wiper against South Korean broadcasters and banks) is a **separate incident**. Published analysis of the GOM Player compromise — Kaspersky/Securelist, LAC Corporation, Atlantic Council — does **not** attribute it to the DPRK, and there is no FireEye writeup specific to it. **Cite Securelist, not the DPRK claim.**

By the 2020s GOM had lost the Korean market to PotPlayer. Also on FFmpeg's Hall of Shame.

**The lesson for FreeViewer:** the differentiator against all three Korean incumbents is not features — PotPlayer's feature set is genuinely excellent and still growing. It is **the distribution channel**. Signed, reproducible, publicly-buildable releases from a public repo, with no self-updating binary pulled from a vendor-controlled server, is the entire pitch. The Monju incident is the proof that this is not a theoretical concern.

### 4.8 IINA — steal the UX, note the render-API tax

**GPL-3.0 · Swift · 46,104★ · v1.4.4 (2026-06-24) · 104.24 MB DMG · macOS 12+ / 10.15+ Intel · last push 2026-08-26**

The best-designed player in the category, and **more starred than mpv itself**. What's worth stealing:

- **The floating OSC** — auto-hiding, repositionable (floating / top / bottom-in-window), native-feeling rather than a skinned overlay.
- **Music mode** — collapses the window to compact audio-player chrome when playing audio. The most-copied IINA idea, and nothing on Windows does it well.
- **Thumbnail scrub preview** on the seekbar. (mpv equivalent: `thumbfast`, free with mpv's OSC.)
- **Native Picture-in-Picture**, for local files and online video.
- **A JavaScript plugin system** — a `.iinaplugin` folder with `Info.json` plus JS, able to control playback, **call the mpv API directly**, do network and filesystem work, and add custom UI; typedoc'd API at docs.iina.io with an `iina-plugin` CLI (added 1.4.0). This is the most interesting extensibility model in desktop video: it gives users mpv's power without making them write Lua. **A FreeViewer built on a web shell is unusually well-placed to do this better than anyone.**
- yt-dlp integration including YouTube playlists, online subtitle search, browser "send to IINA" extensions, macOS-idiomatic gestures and media-key/Now Playing integration.

**317 commits on `develop` since v1.4.4** — a complete UI redesign (1.5.0) is in progress.

**The render-API tax, in IINA's own words.** IINA uses libmpv's render API (OpenGL-on-Metal), not `wid`:

- *"Many color related fixes are only being added by mpv to the new renderer… Unfortunately GPU Next is not available yet to library clients such as IINA."* Dolby Vision is therefore out of reach.
- *"mpv's gpu/libmpv backend is always darker"* — IINA renders visibly darker than mpv, compounded by IINA enabling ICC profile loading by default where mpv does not.
- HDR peak computation gets disabled in the libmpv render path (missing compute-shader/SSBO support in that context).
- `MPV_RENDER_PARAM_ICC_PROFILE` is awkward to use without mpv's internal allocation system.
- Assorted: high CPU on incomplete videos (#2609), excessive CPU when the playlist panel is open (#3162), no exposure of mpv's `scale`/`cscale` settings (#2572).

This is the same tax Stremio measured (§3.3) and mpvQC hit from a different angle — three teams, three platforms, same conclusion.

**Security lesson — CVE-2026-47114 (CVSS 8.8).** IINA before 1.4.3 allowed **argument injection (CWE-88)** through its `iina://open` URL scheme: `mpv_`-prefixed query parameters (e.g. `mpv_options`, `input-commands`) were passed straight into mpv as startup options, so a crafted web link could achieve **arbitrary command execution as the current user** — no valid media file required, only the browser's protocol prompt. Reported by researcher *stackpointer*, published via VulnCheck 2026-05-21. Fixed in 1.4.3 with a parameter **allowlist**; 1.4.4 added guards against using `iina://` to modify local files.

**If FreeViewer ships a URL scheme, an IPC surface, or a plugin API over a full-featured engine, allowlist from day one — never blocklist.**

### 4.9 The web-UI-over-mpv hybrids — direct architectural precedent

These are the only projects that have shipped the thing FreeViewer wants to be. Read all three before writing code.

**⭐ Stremio `stremio-shell-ng`** — Rust, WebView2 + libmpv `wid` + `vo=gpu-next` + `gpu-context=d3d11`, pushed 2026-08-25. **This is the blueprint** — see §3.3 and §3.6 for the code and the documented 2–5× win over their previous Qt shell. Note their explicit size reasoning: *"we use the native WebView2, which is Chromium based but shipped as a part of Windows 10: therefore we do not need to ship our own 'distribution' of Chromium."*

Caveat: **no SPDX license is declared on the repo** — read it for reference, don't copy code without clearing it. The older Qt shell [`Stremio/stremio-shell`](https://github.com/Stremio/stremio-shell) (GPL-3.0, 915★) and the community fork [`Zaarrg/stremio-community-v5`](https://github.com/Zaarrg/stremio-community-v5) (GPL-3.0, 860★, WebView2 + Qt6) are also worth reading. [stremio-shell#441](https://github.com/Stremio/stremio-shell/issues/441) records that the libmpv render API doesn't support `gpu-next`, which is what pushed them off it.

**Jellyfin Desktop** (formerly Jellyfin Media Player; descended from the archived Plex Media Player) — GPL-2.0, C++, **5,663★**, last push 2026-08-14, v2.0.0 tagged 2025-12-14. Qt WebEngine renders the Jellyfin web client; a native `PlayerComponent` drives libmpv; **`QWebChannel` bridges JavaScript to native**. It uses the **render API** and pays for it on Windows (see §3.3 for the forced-OpenGL code). **Windows installer: 149 MB** — Chromium inside Qt. Excellent source of ideas for the **JS ⇄ native command bridge**; a cautionary example on rendering and on size. Note also: v2.0.0 was tagged in December 2025 and **still has no Windows binary** — 1.12.0 (March 2025) remains the newest. Even well-staffed OSS struggles to ship a desktop client.

**mpvQC** — GPL-3.0, PySide6 + QML, 79★ but **only 5 open issues and pushed 2026-08-25**; the best-documented codebase in this survey. It keeps [Architecture Decision Records](https://github.com/mpvqc/mpvQC/tree/main/docs/adr), and three are directly load-bearing:

- **[ADR 0016](https://github.com/mpvqc/mpvQC/blob/main/docs/adr/0016-linux-render-video-into-a-shared-framebuffer.md)** — *"On Windows the player embeds mpv as a native child window. Wayland has no protocol for embedding a foreign window at all, so Linux instead renders mpv through libmpv's render API… X11 does support native embedding, but a second path just for it isn't worth building."* Plus the framerate-cap finding quoted in §3.3.
- **[ADR 0004](https://github.com/mpvqc/mpvQC/blob/main/docs/adr/0004-windows-keep-native-frame.md)** — keep the full native Windows frame and reclaim only the caption strip via a negative top margin, rather than going frameless. A frameless window *"costs the native drop shadow, the borders, the rounded corners, snap layouts and the DWM maximize and restore animations."* **Steal this.**
- **[ADR 0020](https://github.com/mpvqc/mpvQC/blob/main/docs/adr/0020-windows-decide-the-frame-through-read-only-probes.md)** — decide the frame through read-only probes.

### 4.10 The `<video>`-tag players — proof the shortcut fails

Two well-starred projects took the "just use the WebView's video element" shortcut. Both are permanently limited by it. Details and issue links are in §3.2; the summary:

| | **Glucose Media Player** | **LosslessCut** |
|---|---|---|
| Stack | Svelte + Tauri 2 + WebView2 `<video>` | Electron + Chromium `<video>` |
| License / stars | EUPL-1.2 · 113★ | GPL-2.0 · **43,243★** |
| Installer | **4.6 MB** | **139.4 MB** (win 7z) |
| Fatal issue | [#42](https://github.com/rudi-q/glucose_media_player/issues/42) HEVC black screen — *"It works fine with VLC."* | [#88](https://github.com/mifi/lossless-cut/issues/88) native codec support, open since 2018 |
| Workaround | None | FFmpeg streams **low-resolution JPEGs** to a canvas |

43,000 stars did not make the problem go away. Glucose's 4.6 MB installer is the most seductive number in this entire document, and it is bought by not playing the files.

### 4.11 Media centers — the scope trap

|  | **Kodi 21.3 "Omega"** | **Plex** | **Jellyfin 10.11.11** |
|---|---|---|---|
| License | GPL-2.0-or-later | **Proprietary** | GPL-2.0 |
| Engine | `VideoPlayer` on FFmpeg 8.1.2; XML skins; SQLite `MyVideos###.db` | Forked FFmpeg ("Plex New Transcoder"), C++ server, 20+ clients, cloud Relay | Fork of Emby 3.5.2 (Emby closed-sourced 2018-12-08; Jellyfin shipped **22 days later**) |
| Windows install | **74.0 MiB** | Server 95.8 + Desktop 178.8 ≈ **288 MB** | Server 159.7 + Desktop 149.1 ≈ **324 MB** |
| Background service | **No** | Yes | Yes |
| Account required | **No** | **Yes — even for local playback** | No |
| Telemetry | No | Yes, opt-out | **None** |
| Monetization | Donations (non-profit) | **Plex Pass** | Donations |

**The Plex monetization story is the single most useful competitive fact in this brief:**

| Tier | Pre-2025 | From 2025-04-29 | From 2026-07-01 |
|---|---|---|---|
| Monthly | $4.99 | $6.99 | $6.99 |
| Annual | $39.99 | $69.99 (+75%) | $69.99 |
| **Lifetime** | **$119.99** | $249.99 | **$749.99** |

**Lifetime went from $119.99 to $749.99 — 6.25× in 26 months.** And Plex **paywalled remote playback of your own personal media**: *"it is no longer offered as a free feature on Plex."* Announced 2025-03-19, enforced from November 2025 on Roku, then Fire TV / Samsung / LG / Vizio / PlayStation / Xbox from 2026-04-29. Coverage: [TechCrunch](https://techcrunch.com/2025/03/19/streamer-plex-raises-subscription-price-for-the-first-time-in-a-decade/) · [9to5Mac (enforcement)](https://9to5mac.com/2025/11/27/plex-paywall-for-remote-streaming-now-being-enforced/) · [AppleInsider — *"Ludicrous… too expensive for watching your owned media"*](https://appleinsider.com/articles/26/05/19/ludicrous-plex-lifetime-pass-increase-to-74999-is-too-expensive-for-watching-your-owned-media) · [HN 43422965](https://news.ycombinator.com/item?id=43422965).

**Why a double-click-a-file player must not go here.** Each step looks small and is a permanent workstream:

1. **"Remember what I watched"** → a database. Schema, migrations, corruption recovery, backup/restore, forever. Kodi's `MyVideos###.db` carries a version number *because the schema breaks between releases*. Jellyfin spent an entire major release (10.11) on EF Core migration plus built-in backups.
2. **"Show me posters"** → metadata scrapers. Third-party APIs you don't control, rate limits, wrong-match bugs, artwork caching. Kodi's scraper API keys have been **invalidated by DMCA takedowns triggered by other people's add-ons** — an outage with no engineering fix.
3. **"Play it on the TV downstairs"** → a background service. Starts at boot, survives logoff, no UI, own logging and crash recovery. This is where a desktop app becomes infrastructure.
4. **"My TV can't do HEVC"** → transcoding. **Both Plex and Jellyfin maintain their own FFmpeg forks.** Then you own QSV-vs-oneVPL, NVENC session limits, VAAPI driver bugs, AMF, VideoToolbox, RKMPP, HDR tone-mapping and Dolby Vision profiles across every GPU your users have.
5. **"Let my brother in"** → accounts, sessions, permissions, parental controls, password resets.
6. **"From his house"** → remote access, where the economics break. Either you tell users to do port forwarding + DDNS + TLS + reverse proxy (Jellyfin's answer), or you run relay infrastructure (Plex's answer — metered at 2 Mbps paid / 1 Mbps free — and why a lifetime pass now costs $749.99). Once you are paying for other people's video bandwidth, the paywall is arithmetic, not greed. The fury lands on you either way.
7. **"On my Roku"** → N client apps. Plex maintains 20+.

**Kodi is the instructive middle case: 74 MiB because it deliberately refused the server half.** No daemon, no accounts, no transcoding, no relay. It took steps 1–2 and stopped. That 74 MiB vs 288/324 MB gap *is* the cost of steps 3–7, and it is the wall a desktop player should treat as hard.

The genuinely useful thing in this cluster is **Jellyfin Desktop's client architecture** (§4.9), not the Jellyfin server.

---

## 5. Ideas worth stealing

**Architecture**

1. **Stremio's shell layout** — one native parent HWND; mpv as a `wid` child on `gpu-next`/d3d11; a transparent WebView2 controller on top. Twenty lines, production-proven, HDR intact.
2. **mpvQC's ADR 0004: keep the native window frame.** Reclaim only the caption strip via a negative top margin instead of going frameless. You keep the drop shadow, borders, rounded corners, **snap layouts**, and DWM maximize/restore animations — all of which frameless custom chrome silently destroys.
3. **Jellyfin Desktop's `QWebChannel` bridge design** — a clean, typed JS ⇄ native command surface. The pattern transfers directly to `postMessage`/`window.chrome.webview`.
4. **JSON IPC as a crash-isolation fallback.** If in-process libmpv fails to initialize, spawn `mpv.exe` over a randomized named pipe. The user never sees a black window.

**Configuration and extensibility**

5. **Hand libmpv a real `mpv.conf`** (`config-dir` + `config=yes`). Full upstream config compatibility for free — and it's why power users trust mpv.net over skinned black boxes.
6. **mpv's config resolution order**: `$APP_HOME` → `./portable_config` → `%APPDATA%`. Portable mode should be a folder, not a checkbox.
7. **`input-conf=memory://`** — compose the keymap in the shell, hand it to mpv in memory. No temp files.
8. **mpv.net's `#menu:` annotation** — generate the menu tree from `input.conf` comments. One source of truth for keys and menus.
9. **Enable mpv's built-in OSC (`osc=yes`)** rather than writing your own, and inherit `uosc` (3,340★), `ModernZ` (1,184★), `thumbfast` (1,674★) and the whole Lua/JS ecosystem for free.
10. **IINA's JavaScript plugin system** — a manifest folder, a typed API, a scaffolding CLI, direct mpv API access. The single best extensibility model in desktop video, and a web-shell player is better placed to build it than IINA was.

**UX**

11. **IINA's music mode** — collapse to compact audio chrome when playing audio. Nothing on Windows does this well.
12. **IINA's floating, repositionable OSC** and **native Picture-in-Picture**.
13. **Seekbar thumbnail previews** — MPC-HC has them, IINA has them, `thumbfast` gives them to you.
14. **MPC-HC's LAN remote UI** — control playback from a phone browser, no app, no account.
15. **PotPlayer's Korean-market fit, which no Western player replicates:** SMI/SAMI with **Ruby tag** support, aggressive subtitle encoding auto-detection, per-file subtitle resync, and tolerant playback of damaged/partial `.ts` files. These are cheap to implement and they are the concrete reason Korean users won't switch.
16. **Click-on-video toggles play/pause by default.** VLC's most-upvoted single complaint. Free win.
17. **File-first, mouse-first.** VLC 4.0 is being criticised pre-launch for hiding the filesystem behind a media library. Be the opposite, loudly.

**Positioning**

18. **Match MPC-HC on size.** 21.88 MB *including* bundled decoders and renderer is the bar. Realistic target with libmpv: ~40 MB installer / ~140 MiB installed — beats VLC on disk, matches mpv.
19. **Reproducible, signed, publicly-buildable releases**, with the exact FFmpeg/mpv source and build scripts published. This is simultaneously an LGPL §6 obligation, the answer to the FFmpeg Hall of Shame, and the direct answer to the GOM Player supply-chain compromise.
20. **State the boundary publicly:** no background service, no library database, no accounts, no network listener, no telemetry, no transcoding. Plex just spent a decade of goodwill on a 6.25× price hike and a paywall on watching your own files. Being **structurally incapable** of ever doing that is the strongest positioning available.

---

## 6. Traps to avoid

**Engine**

1. **Do not use Chromium's `<video>` element.** No AC3/DTS/TrueHD, hardware-only HEVC, nominal MKV, WebVTT-only subtitles, no HDR passthrough. Glucose (4.6 MB, black-screens on HEVC) and LosslessCut (43k★, still unsolved after 7 years) are the proof.
2. **Do not use mpv.js.** PPAPI is gone from Chromium; Electron closed its replacement request with no replacement; it never had working hardware decode (80% CPU vs 10%); last README targets Electron 1.7.
3. **Do not depend on `node-mpv`.** Unmaintained since 2021, can't help with embedding, and its npm package now points at a transferred repo ([#113](https://github.com/j-holub/Node-MPV/issues/113)).
4. **Do not use the libmpv render API on Windows** unless you have measured and accepted losing `gpu-next`, HDR passthrough, and possibly your UI's framerate. `MPV_RENDER_API_TYPE_SW` is explicitly *"too slow for realtime"* by its own header.
5. **Do not build on DirectShow.** Microsoft calls it legacy. The merit system plus no-fallback error handling is the root cause of two decades of codec hell, and the state is global to the machine.
6. **Do not build on libVLC for an overlay-heavy player.** 525 files, a seven-year-old unsolved airspace architecture, rotation/skew unsupported on WPF, and LGPL terms that forbid the single-file deployment you'd want.

**Implementation**

7. **Never read the HWND as a signed int.** `readInt32LE` / `winId()` can produce negatives; mpv silently detaches into its own window. Use unsigned; assert `wid > 0`.
8. **Never pass `wid=0`.** It means "draw on the desktop wallpaper below icons," and Windows may destroy that window during a wallpaper slideshow transition.
9. **Hardware decoding is off by default in mpv.** You must set `hwdec` yourself. Prefer `d3d11va`/`auto-safe`; the manual flags `dxva2` as "not safe" (forced BT.601 RGB conversion).
10. **Don't spawn `mpv.exe` if you care about resize smoothness.** mpv's own source says the cross-process `SetWinEventHook` path is *"not as smooth"* than the in-process hook.
11. **Budget for the input-forwarding tax.** ~28 Win32 messages hand-forwarded to mpv's child HWND, plus `WM_APPCOMMAND` media-key translation and `WM_INPUTLANGCHANGE`. Nobody documents this; mpv.net's `WndProc` is the reference.
12. **Never `BitBlt` the mpv HWND for screenshots.** Use `screenshot` / `screenshot-to-file` — overlay-plane presentation gives you a black rectangle.
13. **Randomize the JSON IPC pipe name per instance.** The mpv manual: *"explicitly insecure: there is no authentication, no encryption"*, and the `run` command executes arbitrary system commands.
14. **Allowlist, never blocklist, any external input reaching engine options.** IINA's CVE-2026-47114 (CVSS 8.8) was a convenience URL scheme that forwarded `mpv_*` query parameters straight into mpv.
15. **Don't rely on Electron's `transparent: true`.** [#40515](https://github.com/electron/electron/issues/40515) is open across Electron 25–37; a reporter estimates ~5% of Windows users get a black screen, and the only fix is disabling hardware acceleration.
16. **Don't go frameless casually.** You lose the drop shadow, borders, rounded corners, snap layouts, and DWM animations (mpvQC ADR 0004).

**Licensing and process**

17. **Decide GPL vs LGPL before writing the loader.** libmpv defaults to GPL; `-Dgpl=false` gives you LGPL and costs nothing on Windows. This is a one-line build flag with permanent consequences. Note `mpv.net` is GPL-2.0 — reading its source constrains you.
18. **Publish the exact FFmpeg/mpv source and build scripts.** PotPlayer, KMPlayer and GOM Player are all on FFmpeg's Hall of Shame for shipping binaries whose published source didn't match. Don't join them.
19. **Never ship a self-updating binary from a server you control without signing and reproducibility.** GOM Player's 2014 update-server compromise exfiltrated 40,000+ emails from a nuclear facility. This is the failure mode the whole open-source pitch exists to prevent.

**Scope**

20. **Do not build a library database, a metadata scraper, a background service, an account system, a network listener, or a transcoder.** Kodi is 74 MiB because it stopped at step 2; Plex and Jellyfin are ~300 MB because they didn't. Each step is permanent, and step 6 is where the paywalls come from.
21. **Do not assume PotPlayer is dying.** It shipped an ARM64 build, libass rendering, in-house HLS/DASH and speech-to-text subtitles within the last twelve months. Compete on trust, size and UI — not on the claim that it's abandoned.

---

## 7. Sources

**mpv / libmpv**
- https://mpv.io/ · https://mpv.io/installation/ · https://mpv.io/manual/master/#json-ipc
- https://github.com/mpv-player/mpv · [`Copyright`](https://github.com/mpv-player/mpv/blob/master/Copyright) · [`DOCS/man/options.rst`](https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst) · `DOCS/man/ipc.rst` · `DOCS/man/vo.rst` · `DOCS/man/input.rst` · `include/mpv/render.h` · `video/out/w32_common.c`
- https://github.com/mpv-player/mpv/wiki/FAQ · [Applications using mpv](https://github.com/mpv-player/mpv/wiki/Applications-using-mpv) · [GPU-Next vs GPU](https://github.com/mpv-player/mpv/wiki/GPU-Next-vs-GPU)
- https://github.com/mpv-player/mpv/issues/10189 (negative `wid`) · https://github.com/mpv-player/mpv/issues/5979 (D3D11 render API, open since 2018)
- https://github.com/mpv-player/mpv-examples/blob/master/libmpv/README.md · https://github.com/mpv-player/mpv-examples/issues/27
- Builds: https://github.com/shinchiro/mpv-winbuild-cmake/releases · https://github.com/zhongfly/mpv-winbuild/releases
- Scripts: https://github.com/tomasklaen/uosc · https://github.com/po5/thumbfast · https://github.com/Samillion/ModernZ · https://github.com/cyl0/ModernX

**Reference implementations**
- https://github.com/Stremio/stremio-shell-ng — `src/stremio_app/{app.rs, stremio_player/player.rs, stremio_wevbiew/wevbiew.rs}`
- https://github.com/Stremio/stremio-shell · https://github.com/Stremio/stremio-shell/issues/441 · https://github.com/Zaarrg/stremio-community-v5
- https://github.com/mpvnet-player/mpv.net — `src/MpvNet/Player.cs`, `src/MpvNet.Windows/WinForms/MainForm.cs`, `src/MpvNet/InputConf.cs` · https://github.com/mpvnet-player/mpv.net/issues/733
- https://github.com/jellyfin/jellyfin-desktop — `src/player/{MpvVideoItem.cpp, PlayerComponent.cpp}` · https://github.com/plexinc/plex-media-player (archived)
- https://github.com/mpvqc/mpvQC/tree/main/docs/adr — ADRs 0004, 0016, 0020
- https://github.com/iina/iina · https://iina.io/ · https://docs.iina.io/ · https://github.com/iina/iina/discussions/5109
- https://github.com/celluloid-player/celluloid · https://invent.kde.org/multimedia/haruna · https://github.com/KDE/mpvqt · https://github.com/tsl0922/ImPlay · https://github.com/u8sand/Baka-MPlayer

**Electron / Tauri / WebView2**
- https://github.com/Kagami/mpv.js — issues [#5](https://github.com/Kagami/mpv.js/issues/5), [#51](https://github.com/Kagami/mpv.js/issues/51), [#64](https://github.com/Kagami/mpv.js/issues/64), [#76](https://github.com/Kagami/mpv.js/issues/76), [#99](https://github.com/Kagami/mpv.js/issues/99), [#101](https://github.com/Kagami/mpv.js/issues/101)
- https://github.com/electron/electron/issues/11322 (PPAPI replacement) · https://github.com/electron/electron/issues/18954 · https://issues.chromium.org/issues/40151562
- https://github.com/electron/electron/issues/40515 (transparency black screen) · [#10069](https://github.com/electron/electron/issues/10069) · [#1391](https://github.com/electron/electron/issues/1391) · [#1671](https://github.com/electron/electron/issues/1671) · [#10994](https://github.com/electron/electron/issues/10994) · [#28439](https://github.com/electron/electron/issues/28439) · [PR #49428](https://github.com/electron/electron/pull/49428)
- https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering · https://github.com/electron/electron/pull/42001 (shared-texture OSR)
- https://github.com/j-holub/Node-MPV/issues/106 · https://github.com/j-holub/Node-MPV/issues/113
- https://github.com/REVENGE977/electron-libmpv · https://github.com/yscoder/electron-mpv-video
- https://github.com/nini22P/tauri-plugin-libmpv · https://github.com/nini22P/tauri-plugin-mpv · https://github.com/orgs/tauri-apps/discussions/6343 · https://github.com/orgs/tauri-apps/discussions/15171 · https://github.com/tauri-apps/wry/discussions/284
- https://github.com/rudi-q/glucose_media_player/issues/42 · https://github.com/mifi/lossless-cut/issues/88
- WebView2 transparency: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2
- https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding

**Chromium codecs**
- https://www.chromium.org/audio-video/ · https://chromestatus.com/feature/5186511939567616 · https://github.com/jellyfin/jellyfin-web/issues/7651 · https://apps.microsoft.com/detail/9nmzlz57r3t7

**VLC / LibVLCSharp**
- https://www.videolan.org/ · https://www.videolan.org/vlc/features.html · https://get.videolan.org/vlc/last/win64/
- https://www.videolan.org/press/lgpl-libvlc.html · https://github.com/videolan/vlc/commit/6e8e1ef305025cce2cdf2d4be26054d13bf7d694
- https://jbkempf.com/blog/2026/vlc-vegaos/ · https://www.dedoimedo.com/computers/vlc-4-preview.html · https://9to5mac.com/2021/02/16/vlc-4-user-interface/
- https://news.ycombinator.com/item?id=13573499 · https://news.ycombinator.com/item?id=41281153 · https://news.ycombinator.com/item?id=45905858
- https://github.com/videolan/libvlcsharp · [WPF README](https://github.com/videolan/libvlcsharp/blob/3.x/src/LibVLCSharp.WPF/README.md) · [NEWS](https://github.com/videolan/libvlcsharp/blob/3.x/NEWS)
- GitLab issues: [#67](https://code.videolan.org/videolan/LibVLCSharp/-/issues/67) · [#342](https://code.videolan.org/videolan/LibVLCSharp/-/issues/342) · [#383](https://code.videolan.org/videolan/LibVLCSharp/-/issues/383) · [#442](https://code.videolan.org/videolan/LibVLCSharp/-/issues/442) · [#523](https://code.videolan.org/videolan/LibVLCSharp/-/issues/523) · [#524](https://code.videolan.org/videolan/LibVLCSharp/-/issues/524)
- https://mfkl.github.io/2024/01/10/unity-double-oss-standards.html · https://github.com/huynhsontung/Screenbox

**PotPlayer / KMPlayer / GOM**
- https://en.wikipedia.org/wiki/PotPlayer · https://en.namu.wiki/w/%ED%8C%9F%ED%94%8C%EB%A0%88%EC%9D%B4%EC%96%B4 · http://potplayer.tv/publicRelation · https://t1.daumcdn.net/potplayer/PotPlayer/v4/Update2/UpdateEng.html
- https://vulmon.com/searchpage?q=potplayer · https://forum.videohelp.com/threads/393452-PotPlayer-now-Adware!
- https://en.wikipedia.org/wiki/KMPlayer · https://www.kmplayer.com/pc · https://malwaretips.com/threads/kmplayer-detected-as-unwanted-program-by-kaspersky.75398/
- https://en.wikipedia.org/wiki/GOM_Player · https://www.gomlab.com/gomplayerplus-media-player/
- **https://securelist.com/abused-update-of-gom-player-poses-a-threat/58240/** (primary source for the 2014 compromise)
- https://www.atlanticcouncil.org/in-depth-research-reports/report/breaking-trust-shades-of-crisis-across-an-insecure-software-supply-chain/ · https://www.lac.co.jp/english/report/pdf/apt_report_vol1_en.pdf

**MPC-HC family**
- https://github.com/clsid2/mpc-hc · https://github.com/Aleksoid1978/MPC-BE · https://github.com/Nevcairiel/LAVFilters · https://github.com/Aleksoid1978/VideoRenderer
- https://en.wikipedia.org/wiki/Media_Player_Classic · https://learn.microsoft.com/en-us/windows/win32/directshow/directshow · https://codecpackguide.com/faq.htm

**Media centers**
- https://kodi.tv/ · https://www.plex.tv/ · https://jellyfin.org/
- https://techcrunch.com/2025/03/19/streamer-plex-raises-subscription-price-for-the-first-time-in-a-decade/ · https://9to5mac.com/2025/11/27/plex-paywall-for-remote-streaming-now-being-enforced/ · https://appleinsider.com/articles/26/05/19/ludicrous-plex-lifetime-pass-increase-to-74999-is-too-expensive-for-watching-your-owned-media · https://news.ycombinator.com/item?id=43422965

**Security advisories**
- CVE-2026-47114 (IINA argument injection) — https://vulnerability.circl.lu/vuln/cve-2026-47114 · GHSA-w5xh-98j7-jp5q
- CVE-2021-40212, CVE-2018-16797, CVE-2013-7185, CVE-2013-3942, CVE-2022-4246 (PotPlayer)
