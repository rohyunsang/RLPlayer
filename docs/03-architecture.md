# RLPlayer architecture

Decision record for how RLPlayer puts an HTML user interface on top of an mpv
video surface on Windows, and why it does it that way.

---

## The constraint everything follows from

Chromium's `<video>` element cannot play what people actually have on disk:
Matroska containers, HEVC, AC3/E-AC3/DTS audio, or ASS subtitles. mpv plays all
of it. So RLPlayer uses mpv as its playback engine.

On Windows, `mpv --wid=<HWND>` creates a **child HWND** inside the window you
give it. A child HWND is composited by the desktop window manager **above**
whatever Chromium paints in that same window. That single fact drives the whole
design: **any HTML drawn in the window that hosts mpv is invisible.**

## Chosen approach: two windows (validated by spike)

Before any UI code was written, a ~90-line spike proved three things:

1. mpv embeds into an Electron window via `--wid` and plays a file.
2. A second, transparent Electron window created with `parent:` renders visibly
   on top of that video.
3. Resizing keeps both in sync with no black bars and no flicker.

All three held, so the two-window design was adopted with no fallback needed.

```
┌─ mainWindow ────────────────────────────────┐
│  opaque, frameless, has the taskbar entry   │
│  its HWND is passed to mpv --wid            │
│  ┌───────────────────────────────────────┐  │
│  │  mpv child HWND (fills the window)    │  │
│  │  renders ABOVE Chromium's output      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
        ▲ owned by (not an HWND child of)
┌─ rendererWindow ────────────────────────────┐
│  transparent, frameless, skipTaskbar        │
│  ALL HTML UI lives here                     │
│  composites ABOVE mpv's child HWND          │
│  captures every mouse and keyboard event    │
└─────────────────────────────────────────────┘
```

Electron's `parent:` produces an **owned top-level window**, not an HWND child.
Owned windows sit above their owner in z-order, which is exactly why the overlay
beats mpv's child window.

### Consequences of the overlay covering everything

Because the overlay covers the main window completely, Windows never delivers
hit-test messages to the frame underneath. Three things had to be rebuilt by
hand, all in `src/main/windows.ts`:

- **Window move** — the titlebar sends `beginDrag('move')`; main polls
  `screen.getCursorScreenPoint()` at 60 Hz and repositions the main window
  while the renderer holds pointer capture.
- **Edge resize** — eight hit zones in the overlay's DOM, same polling
  mechanism with an edge argument.
- **Focus** — only the overlay can see input. If the main window ever takes
  focus (taskbar click, Alt+Tab), a `focus` handler hands focus straight back
  to the overlay. Without this the keyboard silently stops working; this was
  found during end-to-end testing, not by reading the docs.

## `--wid` must be read as an unsigned 32-bit integer

```ts
const hwnd = win.getNativeWindowHandle().readUInt32LE(0) // NOT readBigUInt64LE
```

`getNativeWindowHandle()` returns an 8-byte buffer on x64, but mpv's manual
specifies that the value passed to `--wid` is cast to `uint32_t`, and
`w32_common.c` rejects anything that is not `> 0`. Reading it as a signed
32-bit value or as a full 64-bit value makes mpv **silently ignore `--wid`** and
open its own floating window instead of embedding — the failure looks like "the
video plays in a separate window and my main window is black". Windows
guarantees window handles fit in 32 bits, so the truncation is correct, not
lossy. `getHwnd()` asserts `hwnd > 0` and throws a clear error otherwise.

## Video output flags

```
--vo=gpu-next --gpu-context=d3d11
```

`gpu-next` on a D3D11 context is the most efficient path for a `--wid` child
window and the only one that can do HDR passthrough. `--vo=gpu` is exposed in
settings as the fallback for older hardware. Also set: `--hwdec=auto-safe`,
`--video-sync=display-resample` (cheap, removes most judder), `--keep-open=yes`.

## Compatibility layout (fallback mode)

Electron issue **#40515**: `transparent: true` windows render black for a
minority of Windows GPU/driver combinations, and the only upstream workaround is
disabling hardware acceleration — unacceptable for a video player. A user hit by
this would be left with a black rectangle and no way out.

So RLPlayer ships a second layout, selectable in settings under
**화면 → 화면 구성 → 호환 모드**, which uses **no transparent window at all**:

```
┌─ mainWindow (opaque, hosts the HTML UI directly) ─┐
│  titlebar                                         │
│ ┌───────────────────────────────────────────────┐ │
│ │ mpvHost: opaque owned child window, sized to  │ │
│ │ the .video-region box the renderer reserves   │ │
│ └───────────────────────────────────────────────┘ │
│  control bar                                      │
└───────────────────────────────────────────────────┘
```

The renderer measures `#videoRegion` with a `ResizeObserver` and reports the
rectangle to main, which positions `mpvHost` over exactly that area. The UI is
*docked around* the video rather than floating over it, so no Chromium pixel
ever needs to sit under mpv's HWND.

Renderer code is shared between both modes — only the window geometry, the
`transparent` flag, and a `body.compat` CSS class differ.

Known trade-offs of compat mode, documented rather than hidden:

- The video area cannot receive clicks (mpv's child HWND is topmost there), so
  click-to-pause and double-click-to-fullscreen over the video do not work.
  `mpvHost` is created `focusable: false` so clicking it does not steal
  keyboard focus from the shell; every control remains reachable by button and
  keyboard.
- Chrome never auto-hides, because hiding it would resize the video underneath.

## Process and licence boundary

mpv runs as a **separate process**, never linked. RLPlayer speaks mpv's JSON IPC
protocol over a Windows named pipe (`\\.\pipe\rlplayer-mpv-<pid>-<ts>`), with
request-id correlation and property observation (`src/main/mpv/client.ts`).

This is also what keeps RLPlayer's MIT licence intact while shipping GPLv2+
software: the two programs exchange data, not code. Linking `libmpv` instead
would change that analysis. See `THIRD-PARTY-NOTICES.md`.

mpv is launched with `--input-default-bindings=no --input-vo-keyboard=no
--input-cursor=no --osc=no --no-osd-bar --idle=yes --force-window=yes` so it
never competes with the overlay for input, and with `--no-config --ytdl=no
--load-scripts=no` so it stays predictable and offline.

## Natural sort

`naturalCompare()` in `src/main/services/playlist.ts` reproduces Windows'
`StrCmpLogicalW` so playlist order matches File Explorer exactly. The character
rank table, the ignorable handling of apostrophe and hyphen, and the
zero-padding rule were **measured against the real shlwapi API**, not guessed:
`scripts/verify-natural-sort.mjs` diffs 27,000+ ordered pairs (including Korean,
accented Latin and a deterministic fuzz corpus) against Win32 and currently
reports 0 mismatches. `playlist.test.ts` pins the cases users actually hit.

Three behaviours that a naive comparator gets wrong:

| case | Explorer order | why |
| --- | --- | --- |
| `a.mkv` before `a1.mkv` | punctuation precedes digits | word sort, not code points |
| `a1.mkv` before `a-b.mkv` | `-` is *ignorable*, so `a-b` sorts as `ab` | |
| `S01E10` before `S1E2` | zero padding decides before the later digit run | |

## Known limitations in v0.1

- Restoring a window geometry saved under a different monitor layout could
  leave the window straddling two displays, which was observed to leave mpv's
  D3D11 swapchain rendering black. `clampToDisplay()` now restores strictly
  inside a single display's work area; a window the user *manually* drags to
  straddle two monitors may still hit the underlying mpv/driver behaviour.
- Compat mode's video area is not clickable (see above).
- If the main process is killed forcibly (not a normal quit or crash), the mpv
  child process can survive as an orphan. Normal quit paths dispose of it.
