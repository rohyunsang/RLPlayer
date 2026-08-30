/**
 * M26 nav-bookmarks — the types that cross this module's own IPC boundary.
 *
 * `Bookmark` and `BookmarkPanelState` were declared in `bookmarks.ts`,
 * `main/features/nav-bookmarks/index.ts` AND
 * `renderer/src/features/nav-bookmarks/index.ts`. Three declarations of one
 * payload, because a module's two halves share no compilation unit
 * (`tsconfig.web.json` excludes `src/main`). `src/shared/**` is in both configs;
 * this directory is owned by M26. See
 * `src/shared/features/nav-thumbnails/wire.ts` for the whole argument.
 *
 * Wire-only: no DOM, no `node:*`, no Electron, no behaviour.
 */

export interface Bookmark {
  /**
   * Stable for the life of the entry. Every IPC verb addresses a bookmark by id,
   * never by index: the panel filters and re-sorts, and an index into a filtered
   * list is the classic "deleted the wrong row" bug.
   */
  id: string
  /** The point, in seconds on the file's (possibly ordered-chapter) timeline. */
  t: number
  /** N22: a bookmark WITH a `b` field IS a saved A-B section. One store. */
  b?: number
  title: string
  createdAt: number
}

/** Everything the panel, the pins layer and the A-B layer render from. */
export interface BookmarkPanelState {
  open: boolean
  duration: number
  bookmarks: Bookmark[]
  loop: {
    a: number | null
    b: number | null
    /**
     * N23: B is held here and never written to mpv, so the UI has to be told
     * which mode drew the region it is looking at.
     */
    soft: boolean
    count: number
    remaining: number | null
  }
}
