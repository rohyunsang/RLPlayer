# Third-party notices

RLPlayer itself is licensed under the MIT License (see `LICENSE`).
It redistributes the following third-party software.

---

## mpv

- **Project:** <https://mpv.io> / <https://github.com/mpv-player/mpv>
- **Bundled build:** [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake)
  release `20260814`, asset `mpv-x86_64-20260814-git-7b8915bc1d.7z`
  (SHA-256 pinned in `scripts/fetch-mpv.mjs`)
- **Licence:** GNU General Public License v2 or later (GPLv2+).
  Parts of mpv are LGPLv2.1+; see `licenses/mpv-Copyright.txt` for the
  per-component breakdown.
- **Full licence text:** `licenses/GPL-2.0.txt`, `licenses/LGPL-2.1.txt`

### Why RLPlayer can be MIT-licensed while shipping GPL software

RLPlayer does **not** link against libmpv, and contains no mpv source code.
It spawns `mpv.exe` as a **separate operating-system process** and communicates
with it exclusively over mpv's documented JSON IPC protocol, across a Windows
named pipe. The two programs exchange data, not code; neither is a derivative
work of the other, and each remains independently licensed.

This is the "aggregate" / separate-program arrangement described in section 2
of the GPLv2 and in the FSF's own guidance on the boundary between programs
communicating at arm's length.

If you modify RLPlayer to link libmpv directly — for example by embedding
`libmpv-2.dll` and calling `mpv_create()` — **that changes the analysis**, and
the combined work would need to be distributed under the GPL.

### Obtaining mpv's source

mpv is free software. The complete corresponding source for the bundled build
is available from:

- mpv: <https://github.com/mpv-player/mpv>
- The exact build recipe and toolchain:
  <https://github.com/shinchiro/mpv-winbuild-cmake>

The bundled binary corresponds to mpv git revision `7b8915bc1d`.

---

## FFmpeg

The bundled mpv binary is statically linked against FFmpeg, which supplies the
demuxers, decoders and filters that let RLPlayer play essentially any container
and codec without relying on Microsoft Store codec extensions.

- **Project:** <https://ffmpeg.org>
- **Licence:** LGPLv2.1+ for the core; the shinchiro build enables GPL
  components, so the resulting binary as distributed is GPLv2+.
- **Full licence text:** `licenses/LGPL-2.1.txt`, `licenses/GPL-2.0.txt`

Other libraries statically linked into that same binary include libass
(subtitle rendering, ISC), libplacebo (LGPLv2.1+), zlib, libjpeg, freetype,
fribidi, harfbuzz, uchardet and others. Their notices are carried in the
upstream build recipe linked above.

---

## Electron / Chromium / Node.js

RLPlayer's user interface runs on Electron.

- **Project:** <https://electronjs.org>
- **Licence:** MIT (Electron), BSD-3-Clause (Chromium), MIT (Node.js)

Electron ships its own `LICENSES.chromium.html` inside the installed
application directory, which contains the complete notices for Chromium and its
own bundled third-party components.

---

## What RLPlayer does not do

For the avoidance of doubt, and because it is the reason this application
exists: RLPlayer performs **no network requests at startup or during
playback**, contains **no auto-updater**, and collects **no telemetry** of any
kind. mpv is launched with `--ytdl=no` and `--load-scripts=no` so that it, too,
stays entirely offline. The only network access in the whole program is the
Help → "업데이트 확인" menu item, which opens the GitHub releases page in your
default browser when you click it.
