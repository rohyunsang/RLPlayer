import { app, clipboard, ClipboardItem, nativeImage, shell } from 'electron'
import type {
  AppPathName,
  DecodedImage,
  ImageService,
  ShellService
} from '@shared/feature-api'

/**
 * core/shell — §3.3.9 and §3.3.10.
 *
 * THE MEASUREMENT THAT PRODUCED THIS FILE. Two of the thirteen landed modules
 * import Electron directly, and both of them do it for exactly this:
 *
 *     src/main/features/capture-still/index.ts:3
 *       import { app, clipboard, ClipboardItem, nativeImage, shell } from 'electron'
 *     src/main/features/capture-encode/index.ts:3
 *       import { app, shell } from 'electron'
 *     src/main/features/mediainfo/index.ts:4
 *       import { clipboard, shell } from 'electron'
 *
 * One import line, and the module's `index.ts` cannot be loaded by `node --test`
 * at all. That is not a theoretical cost: M22 and M23 each split a `manifest.ts`
 * out of `index.ts` for no reason except to give their tests something loadable
 * to read their declarations from, and `spec-gaps.test.ts`-style suites that
 * `import mod from './index.ts'` are simply not available to them. Twenty-five
 * modules are queued behind the same wall, and §2.4 hands four more shell rows
 * (C20, C23, C24, L34) and two app-path rows (C05, P59) to modules that do not
 * exist yet.
 *
 * So the surface moves here, and the modules get `ctx.shell` / `ctx.image`. The
 * same reasoning that produced `core/dialog.ts` one round earlier, with the
 * receipts this time.
 *
 * TWO THINGS ABOUT THE CLIPBOARD, both verified against the RUNNING Electron 44
 * rather than against its typings:
 *
 *   Object.getOwnPropertyNames(Object.getPrototypeOf(clipboard))
 *     -> clear, has, read, readText, write, writeText   (+ selection)
 *   typeof clipboard.writeImage -> 'undefined'
 *   typeof clipboard.readImage  -> 'undefined'
 *
 * §2.4 C03 prescribed `clipboard.writeImage(nativeImage.createFromPath(tmp))`
 * and called it "simpler than the current Blob + ClipboardItem path". Following
 * it literally is a runtime `writeImage is not a function` on the first Ctrl+C,
 * past typecheck and past any test that mocks Electron. M22 found it and worked
 * around it; the spec row is corrected, and this is the one supported path so
 * the next module cannot rediscover it.
 *
 * And `clipboard.writeText` is a Promise in 44. Every §2 row that names it —
 * S39, L25, L26, L34 — reads as synchronous, so `copyText` is async here and a
 * module that forgets to await gets a floating promise rather than a silent
 * failure to copy.
 */

/** The OS folders a module may ask for. Closed on purpose: `app.getPath` also
 *  answers 'userData', 'sessionData', 'logs' and 'crashDumps', and a module
 *  reaching those would be routing around `ctx.paths`, which owns portable mode
 *  and the profile redirection (P36-P39). */
const ALLOWED: Record<AppPathName, Parameters<typeof app.getPath>[0]> = {
  pictures: 'pictures',
  videos: 'videos',
  music: 'music',
  downloads: 'downloads',
  documents: 'documents',
  desktop: 'desktop',
  home: 'home',
  temp: 'temp',
  exe: 'exe'
}

/**
 * DID THE WRITE ACTUALLY LAND?
 *
 * `clipboard.write()` and `clipboard.writeText()` RESOLVE UNCONDITIONALLY.
 * Measured on a box that denies clipboard access — `clip.exe` answers "Access
 * denied" and `GetClipboardSequenceNumber` stays frozen at 1359 across writes —
 * with the pinned Electron 44 and this exact code path:
 *
 *     clipboard.writeText('RLPLAYER-PROBE-…')  -> resolved
 *     clipboard.readText()                     -> ""
 *     clipboard.write([ClipboardItem png])     -> resolved
 *     clipboard.has('image/png')               -> false
 *     clipboard.read()                         -> [ { types: [] } ]
 *
 * and the app showed "클립보드에 복사했습니다". A success toast that fires on a
 * resolved promise is not evidence about the clipboard; it is evidence that the
 * call returned. So both paths read the clipboard back, and the failure message
 * names the likely cause rather than saying "failed".
 *
 * The image check asks TWO independent questions because Electron 44 exposes no
 * `availableFormats` and no `readImage` (its clipboard is
 * `clear/has/read/readText/write/writeText` and nothing else): `has()` for the
 * format, and `read()` for the item types. A working box needs only one of them
 * to say yes; the denying box above answers no to both.
 */
async function clipboardHasPng(): Promise<boolean> {
  try {
    if (await clipboard.has('image/png')) return true
  } catch {
    /* `has` can refuse an unknown format name; the read below is the fallback */
  }
  try {
    const items = (await clipboard.read()) as Array<{ types?: readonly string[] }>
    return items.some((i) => (i.types ?? []).some((t) => /png|image/i.test(t)))
  } catch {
    return false
  }
}

export function createShellService(ownerId: string): ShellService {
  return {
    showItemInFolder(fullPath: string): void {
      shell.showItemInFolder(fullPath)
    },
    async openPath(fullPath: string): Promise<string> {
      return shell.openPath(fullPath)
    },
    async trashItem(fullPath: string): Promise<void> {
      await shell.trashItem(fullPath)
    },
    async copyText(text: string): Promise<void> {
      await clipboard.writeText(text)
      // READ IT BACK. See the note above `assertLanded`.
      let back: string
      try {
        back = String(await clipboard.readText())
      } catch (e) {
        throw new Error(
          `the clipboard could not be read back after writing (${(e as Error).message}), so ` +
            `whether the copy landed is unknown. Reporting failure rather than success.`
        )
      }
      if (back !== text) {
        throw new Error(
          `the clipboard write was accepted and did not land: ${text.length} character(s) were ` +
            `written and the clipboard holds ${back.length}. On Windows this is normally ` +
            `another process holding the clipboard open, or a policy denying access to it.`
        )
      }
    },
    async copyImagePng(png: Uint8Array): Promise<void> {
      // A fresh ArrayBuffer-backed copy: a Uint8Array that is a VIEW into a
      // larger pool (which `fs.readFile` can return) would put the pool's whole
      // contents on the clipboard.
      const bytes = new Uint8Array(png.length)
      bytes.set(png)
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
      ])
      if (!(await clipboardHasPng())) {
        throw new Error(
          `the clipboard accepted a ${png.length}-byte PNG and does not hold an image: neither ` +
            `clipboard.has('image/png') nor clipboard.read() reports one. On Windows this is ` +
            `normally another process holding the clipboard open, or a policy denying access.`
        )
      }
    },
    appPath(name: AppPathName): string {
      const key = ALLOWED[name]
      if (!key) {
        throw new Error(
          `module '${ownerId}' asked for app path '${name}', which ctx.shell does not expose. ` +
            `Profile and cache locations are ctx.paths' (§12); this is for OS folders only.`
        )
      }
      return app.getPath(key)
    }
  }
}

/** Electron's `nativeImage` ships exactly two encoders. C07 depends on knowing. */
const ENCODABLE = ['png', 'jpg', 'jpeg'] as const

function wrap(img: Electron.NativeImage): DecodedImage | null {
  if (img.isEmpty()) return null
  const size = img.getSize()
  return {
    width: size.width,
    height: size.height,
    resize(width: number): DecodedImage {
      const out = wrap(img.resize({ width, quality: 'best' }))
      if (!out) throw new Error(`resize to ${width}px produced an empty image`)
      return out
    },
    toPng(): Uint8Array {
      return new Uint8Array(img.toPNG())
    },
    toJpeg(quality: number): Uint8Array {
      return new Uint8Array(img.toJPEG(Math.min(100, Math.max(1, Math.round(quality)))))
    }
  }
}

export function createImageService(): ImageService {
  return {
    encodableFormats: ENCODABLE,
    read(source: string | Uint8Array): DecodedImage | null {
      const img =
        typeof source === 'string'
          ? nativeImage.createFromPath(source)
          : nativeImage.createFromBuffer(Buffer.from(source))
      return wrap(img)
    }
  }
}
