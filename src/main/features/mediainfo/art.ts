/**
 * M29 mediainfo -- L29's sidecar cover-art lookup.
 *
 * L29 offers two sources: the `music-metadata` package for EMBEDDED pictures,
 * and a sidecar file beside the media. Only the second is implemented here, and
 * the reason is not preference:
 *
 *   - `music-metadata` is not a dependency of this project, and adding one means
 *     editing `package.json`, which is on every module's forbidden list
 *     (docs/parity/02-wave0-api.md section 0, rule 4). So the embedded-picture
 *     path is not something this module can add on its own; it is a review.
 *   - the mpv-side display path for embedded art (L28: `--audio-display=
 *     embedded-first`, `--cover-art-auto=fuzzy`) belongs to M11 by ownership --
 *     "These three are M11's spawn args, not M29's ... it requests them" -- and
 *     M11's mediator for them exists in `modules.json` and in no code. See the
 *     `requestAlbumArtDisplay` comment in `index.ts`.
 *
 * What IS possible without either is: report that the file has embedded art
 * (`track-list/N/albumart`, which is a read and needs nobody's permission), and
 * find a sidecar image. That covers L29's own fallback list exactly.
 *
 * Pure apart from the injected directory reader, so `art.test.ts` runs with no
 * disk at all.
 */

/** L29's list, verbatim: `cover|folder|front|AlbumArt|Album|thumb`. */
const ART_STEMS = ['cover', 'folder', 'front', 'albumart', 'album', 'thumb']
/** L29's list, verbatim: `.jpg|.jpeg|.png|.webp`. */
const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

export interface ArtDeps {
  /** File names in a directory, or null when it cannot be read. */
  readDir(dir: string): string[] | null
  /** `path.join`, injected so this file needs no `node:path`. */
  join(dir: string, name: string): string
}

/**
 * The cover image beside a media file, or null.
 *
 * Two candidate shapes, most specific first:
 *
 *  1. `<basename>.jpg` and friends -- the file named after the media itself.
 *     This is what mpv's own default `--cover-art-auto=exact` matches, and L28
 *     notes that default "only matches `<basename>.jpg`".
 *  2. L29's generic stems (`cover`, `folder`, ...), matched case-insensitively.
 *     NTFS is case-insensitive, but the comparison is explicit rather than
 *     relying on that: the same code runs against a fixture list in the test.
 *
 * The order inside each shape follows `ART_EXTS`, so a folder with both
 * `cover.jpg` and `cover.png` resolves the same way every time. A stable answer
 * matters more than which of the two is "better": an art panel that alternates
 * between two images across restarts reads as a bug.
 */
export function findSidecarArt(
  mediaPath: string,
  deps: ArtDeps,
  basename?: string
): string | null {
  const slash = Math.max(mediaPath.lastIndexOf('\\'), mediaPath.lastIndexOf('/'))
  if (slash < 0) return null
  const dir = mediaPath.slice(0, slash)
  const file = mediaPath.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  const stem = (basename ?? (dot > 0 ? file.slice(0, dot) : file)).toLowerCase()

  const names = deps.readDir(dir)
  if (!names) return null

  const lower = new Map<string, string>()
  for (const n of names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n)

  for (const ext of ART_EXTS) {
    const hit = lower.get(`${stem}${ext}`)
    if (hit) return deps.join(dir, hit)
  }
  for (const s of ART_STEMS) {
    for (const ext of ART_EXTS) {
      const hit = lower.get(`${s}${ext}`)
      if (hit) return deps.join(dir, hit)
    }
  }
  return null
}

/**
 * A `file://` URL the overlay can put in an `<img src>`.
 *
 * Built by hand rather than with `pathToFileURL` because the renderer half must
 * be able to read it verbatim and a Windows path needs both the leading slash
 * and per-segment escaping. `#` and `?` in a filename are the two that actually
 * break an `<img src>`; encodeURIComponent on each segment covers those and the
 * spaces, and leaves the drive colon alone.
 */
export function toFileUrl(p: string): string {
  const normalised = p.replace(/\\/g, '/')
  const parts = normalised.split('/').map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
  return `file:///${parts.join('/').replace(/^\/+/, '')}`
}
