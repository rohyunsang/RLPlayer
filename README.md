# RLPlayer

A free, open-source, ad-free Windows video player that plays everything and
**never nags you about anything**.

Built on [mpv](https://mpv.io) for playback and Electron for the interface.
MIT licensed.

---

## Why this exists

Most Windows video players are excellent software wrapped in something you have
to tolerate: bundled adware in the installer, an updater that interrupts you
mid-film, a "premium" upsell, or telemetry you did not ask for.

RLPlayer's design constraints:

- **No auto-updater.** There is no `electron-updater`, no background version
  check, nothing that can interrupt playback. Update checking is a menu item
  (도움말 → 업데이트 확인) that opens the GitHub releases page in your browser
  when *you* click it.
- **No network access at startup or during playback.** mpv itself is launched
  with `--ytdl=no --load-scripts=no`. The only outbound request the program can
  ever make is the releases page you explicitly asked for — and that opens in
  your browser, it is not fetched. See "Zero network, and how it is enforced"
  below, because the interesting half of that promise is not our code.
- **No telemetry, no analytics, no crash reporting.**
- **No ads, no bundled software, no upsell.**

### Zero network, and how it is enforced

Our own code makes no network request. That is the easy half, and
`npm run check:forbidden` greps for `fetch`, `net.request`, `XMLHttpRequest`,
`WebSocket`, `sendBeacon`, `node:http(s)` and any remote origin so it stays
true.

The hard half is Chromium. RLPlayer is an Electron app, and Chromium does its
own background networking whether or not the app asks for it: a captive-portal
probe to `gstatic.com/generate_204`, a component-updater poll, a network-time
query, an optimization-hints fetch. We measured one outbound TCP:443 to a Google
host attributed to RLPlayer's own NetworkService child on a single launch, which
then did not reproduce over three later runs. An intermittent violation you
cannot reproduce is indistinguishable from one you have fixed, so guessing was
not good enough.

Every one of those subsystems is now switched off by name, before Chromium
finishes reading its command line (`src/main/core/no-network.ts`). Run
`RLPlayer.exe --print-network-policy` to see the exact list any build applies.
In summary:

| Switched off | Stops |
|---|---|
| `--disable-background-networking` | the whole background-request family: the component updater's first poll, the safe-browsing update, the captive-portal probe, the sync fetcher |
| `--disable-component-update` | the component updater specifically — the likeliest source of the TCP:443 we saw |
| `--disable-domain-reliability` | network-failure telemetry uploads |
| `--no-pings` | hyperlink auditing, CSP `report-uri`, NEL reports |
| `--disable-client-side-phishing-detection` | the phishing-model download |
| `--disable-sync`, `--disable-default-apps`, `--no-first-run`, `--no-default-browser-check` | Chrome-browser features that fetch on startup |
| `--disable-breakpad` | Chromium's own crash uploader (Electron's `crashReporter` is never started either) |
| `--disable-features=NetworkTimeServiceQuerying,OptimizationHints,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationGuideModelDownloading,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,SegmentationPlatform,Translate` | the network-time query, the optimization-hint and model downloads, Cast/DIAL discovery on your LAN, autofill server round-trips, the certificate-transparency log-list download |
| `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost` | **everything else.** Nothing in RLPlayer resolves a hostname — not one line — so mapping every host to NOTFOUND cannot break a feature that exists, and it turns "we disabled the subsystems we know about" into "a subsystem we have never heard of cannot reach one either" |

`npm run net:watch` is the proof: it cold-launches the app five times, walks the
whole process tree (browser, GPU, renderers, the NetworkService child and mpv)
with `Get-NetTCPConnection` once a second, and fails on any remote address that
is not loopback. Five cold launches, thirty seconds each, zero outbound
connections.

## Features

**Playback** — plays essentially anything, because FFmpeg is statically linked
into the bundled mpv: MKV, MP4, AVI, MOV, WMV, WebM, TS/M2TS, FLV, VOB, RMVB and
more; HEVC, AV1, VP9, H.264; AC3, E-AC3, DTS, TrueHD, FLAC, Opus. No Microsoft
Store codec extensions required.

**Resume where you left off** — RLPlayer remembers your position per file and
offers to continue, with a dismissible toast and a "처음부터" button. It
deliberately does *not* remember a file you barely started (under 60 seconds) or
one you finished (within the last 90 seconds or last 5%, whichever is larger),
and it resumes with an exact seek rather than a keyframe seek, so you land where
you actually stopped.

**Playlist with correct sorting** — auto-populated from the folder of the file
you opened, ordered exactly the way File Explorer orders it. `ep2` comes before
`ep10`. Next/previous, shuffle, repeat one/all, drag-to-reorder, togglable side
panel.

**Subtitles** — external subtitles are found automatically next to the video and
in `Subs/`, `Subtitles/` subfolders (`sub-auto=fuzzy`), so
`Show.S01E02.en.srt` attaches to `Show.S01E02.mkv`. Embedded track switching,
delay adjustment, size and position offsets. ASS styling is rendered as the
release group authored it by default; forcing your own styling is opt-in.
Dropping a `.srt` onto the window attaches it to what is already playing rather
than replacing playback.

**Audio** — track switching, delay adjustment, output device selection, and
volume up to 150%. Above 100% a soft limiter (dynamic normalisation plus a peak
limiter) engages instead of raw gain, so quiet dialogue comes up without the
loud parts clipping.

**Video** — fullscreen, always-on-top, aspect-ratio override, rotation,
screenshots to file or straight to the clipboard.

**Interface** — dark and minimal, custom frameless titlebar, controls that
auto-hide on mouse idle in fullscreen, OSD feedback for volume/seek/speed,
remembers window size and position. Built from real semantic HTML (`<button>`,
`<input type="range">`, proper labels and focus handling) so it works with
screen readers and keyboard navigation.

**Keyboard** — three presets, shipped as editable data: RLPlayer default,
PotPlayer-compatible, and mpv-compatible. In the default preset nothing quits
the app without a modifier, bare keys navigate *within* a file, and modifier
keys navigate *across* files.

**Portable mode** — put a file named `portable.txt` next to `RLPlayer.exe` and
all settings live in a `data/` folder beside the executable instead of in
`%APPDATA%`.

## Installing

Download `RLPlayer Setup <version>.exe` from the
[releases page](https://github.com/rohyunsang/RLPlayer/releases) and run it. The
installer lets you choose the install location and installs per-user, so it does
not need administrator rights.

A portable `.zip` is also published — unpack it anywhere and rename
`portable.txt.example` to `portable.txt`.

### Making RLPlayer the default player

Windows 10 and 11 **do not allow an application to make itself the default
handler** for a file type. Any program claiming to do this is writing forged
`UserChoice` registry hashes, which is association hijacking and routinely gets
flagged by antivirus software. RLPlayer does not do that.

What the installer *does* do is register the file types properly so that Windows
offers RLPlayer as a choice. To finish the job:

- **Settings → 설정 → 파일 연결 → "Windows 기본 앱 설정 열기"**, then pick
  RLPlayer for each video type you want, **or**
- right-click a video file → 연결 프로그램 → 다른 앱 선택 → RLPlayer →
  "항상 이 앱을 사용".

This is a Windows restriction, not a bug in RLPlayer.

## Keyboard shortcuts (default preset)

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `←` / `→` | Seek ∓5 seconds |
| `Shift`+`←` / `→` | Seek ∓60 seconds |
| `Ctrl`+`←` / `→` | Previous / next **file** |
| `PgUp` / `PgDn` | Previous / next chapter |
| `↑` / `↓` | Volume ±5% |
| `M` | Mute |
| `F` / `Enter` | Fullscreen |
| `Esc` | Leave fullscreen |
| `[` / `]` | Speed ∓0.25× |
| `Backspace` | Reset speed |
| `,` / `.` | Frame step back / forward |
| `S` / `Ctrl`+`S` | Screenshot to file / to clipboard |
| `V` / `J` | Toggle subtitles / cycle subtitle track |
| `A` | Cycle audio track |
| `L` | Toggle playlist |
| `T` | Always on top |
| `Ctrl`+`O` | Open file |
| `Ctrl`+`,` | Settings |
| `Ctrl`+`Q` | Quit |
| Mouse wheel | Volume |
| Double-click | Fullscreen |

Every binding lives in `config.json` under `keybinds` and layers on top of the
chosen preset, so you only need to list the keys you want to change. The full
current list is available from 도움말 → 단축키 목록.

## Building from source

Requires Node.js 20+ (developed on 24) and Windows.

```bash
git clone https://github.com/rohyunsang/RLPlayer.git
cd RLPlayer
npm install          # postinstall downloads and verifies the mpv binary
npm run dev          # run in development
```

`npm install` runs `scripts/fetch-mpv.mjs`, which downloads a pinned
[shinchiro mpv build](https://github.com/shinchiro/mpv-winbuild-cmake), verifies
its SHA-256, extracts it to `resources/mpv/`, and runs `mpv.exe --version` to
confirm it works. The binary is not committed to git. To fetch it manually:

```bash
npm run fetch:mpv
```

Other scripts:

```bash
npm run typecheck    # tsc over main, preload and renderer
npm test             # unit tests (natural sort, resume rules)
npm run verify:sort  # diff naturalCompare against the real Win32 StrCmpLogicalW
npm run make:icon    # regenerate build/icon.ico
npm run build        # compile to out/
npm run dist         # build + produce the NSIS installer and portable zip in dist/
```

`npm run dist` produces:

- `dist/RLPlayer Setup <version>.exe` — Korean NSIS wizard with a licence page,
  per-user install, changeable install directory
- `dist/RLPlayer-<version>-win.zip` — portable build

### Project layout

```
src/main/          Electron main process
  mpv/client.ts    mpv JSON IPC over a Windows named pipe
  mpv/manager.ts   mpv process lifecycle and observed-property state
  windows.ts       two-window embedding, both layout modes, move/resize
  player.ts        playback, playlist, resume, screenshots
  services/        config, resume rules, natural sort
src/preload/       typed contextBridge API (no raw IPC reaches the renderer)
src/renderer/      the UI
src/shared/        types and keybind presets shared across processes
docs/03-architecture.md   why the embedding works the way it does
```

If you are going to change anything about window handling, read
[`docs/03-architecture.md`](docs/03-architecture.md) first — the constraints
there are not obvious and are easy to break silently.

## Security notes

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
and reaches the main process only through a typed preload bridge that exposes
named operations rather than `ipcRenderer`. Navigation and window-open are
blocked in the UI window. Strings derived from filesystem paths reach the DOM
through `textContent`, never `innerHTML`.

## Licence

RLPlayer is MIT licensed — see [`LICENSE`](LICENSE).

It redistributes mpv, which is **GPLv2+**. RLPlayer does not link against
libmpv; it runs `mpv.exe` as a separate process and talks to it over a named
pipe, so the two remain independently licensed programs. Full details, licence
texts and source-availability information are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Non-goals

Deliberately out of scope: media library management, Blu-ray BD-J menus, 3D
video, TV tuner support, and cloud sync.
