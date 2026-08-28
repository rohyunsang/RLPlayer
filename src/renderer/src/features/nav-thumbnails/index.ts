import './nav-thumbnails.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'
import type { Chapter } from '../../../../shared/types.ts'
import { bucketTime, chapterAt, LruMap, shouldShowChapter } from './preview-state.ts'

/**
 * M27 nav-thumbnails, renderer half — N36's preview and N37's caption.
 *
 * The layer declares NO `hitTest`, and that is a design decision rather than an
 * omission: a preview is a thing you look at, not a thing you grab. Host rule 1
 * says interaction is opt-in, so this layer receives no pointer events at all
 * and can never steal a press from M26's bookmark pins, M25's chapter ticks or
 * the host's own drag-scrub. Rule 4 (keyboard equivalence) applies to layers
 * with a `hitTest`; there is nothing here to reach with Tab, because there is
 * nothing here to activate.
 *
 * Everything visible is contributed as ONE tooltip fragment, so the timecode
 * (core, order 0), this preview (order 10) and M25's chapter title on a tick
 * (order 20) compose inside the single `.seek-hover` box instead of stacking
 * three floating ones. `main.ts` is not touched, and neither is `styles.css`.
 */

/**
 * The hover cadence, both halves measured on the pinned mpv.
 *
 * A keyframe seek came back in 8-21 ms and an exact one in up to 185 ms, so the
 * pointer gets keyframes while it moves and one exact frame once it settles.
 * The user never waits for the slow one.
 */
const MOVE_THROTTLE_MS = 50
const SETTLE_MS = 150

interface ThumbStatus {
  enabled: boolean
  available: boolean
  width: number
  height: number
  stepSec: number
}

interface ThumbFrame {
  key: string
  time: number
  width: number
  height: number
  exact: boolean
  rgba: Uint8Array
}

const mod: RendererFeatureModule = {
  id: 'nav-thumbnails',

  setup(ctx): void {
    if (ctx.surface !== 'player') return

    // ---- DECLARE FIRST, SUBSCRIBE LAST -----------------------------------
    // `ctx.state.subscribe()` replays the last state SYNCHRONOUSLY, so the
    // first `onState` runs inside this setup(). M25 learned this the hard way:
    // a `let` below its subscribe made the replayed paint a TDZ
    // ReferenceError, which killed the rest of setup() and left a permanently
    // throwing subscriber behind. Nothing below this line is referenced by a
    // callback registered above it.

    let duration = 0
    let chapters: readonly Chapter[] = []
    let status: ThumbStatus = {
      enabled: true,
      available: false,
      width: 288,
      height: 162,
      stepSec: 1
    }

    /** Bucketed time -> decoded frame. Sweeping the bar twice decodes once. */
    const cache = new LruMap<ThumbFrame>(96)

    /** Seek-bar geometry, captured in render() so the caption can de-duplicate. */
    let barWidth = 0

    // The tooltip fragment is built ONCE and handed back on every hover. The
    // host tears the tooltip's children out on each pointermove and re-appends
    // whatever the layers return, so returning the same nodes keeps the canvas
    // bitmap alive across moves — and a frame that arrives while the pointer is
    // standing still is painted into a node that is already on screen.
    const wrap = document.createElement('span')
    wrap.className = 'rl-thumb-tip'
    const canvas = document.createElement('canvas')
    canvas.className = 'rl-thumb-canvas'
    const caption = document.createElement('span')
    caption.className = 'rl-thumb-chapter'
    wrap.appendChild(canvas)
    wrap.appendChild(caption)

    let hoverTime: number | null = null
    let paintedTime: number | null = null
    let lastRequestAt = 0
    let moveTimer: ReturnType<typeof setTimeout> | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    function clearTimers(): void {
      if (moveTimer !== null) clearTimeout(moveTimer)
      if (settleTimer !== null) clearTimeout(settleTimer)
      moveTimer = null
      settleTimer = null
    }

    function keyFor(time: number): string {
      return time.toFixed(3)
    }

    function paint(frame: ThumbFrame): void {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      const g = canvas.getContext('2d')
      if (!g) return
      // Main already swapped BGRA to RGBA: mpv writes the platform order and
      // ImageData reads the other one (§2.6 N36). Copied rather than wrapped:
      // the payload's backing buffer arrives from structured clone and
      // `ImageData` will not take a view over one it cannot prove is not shared.
      const bytes = new Uint8ClampedArray(frame.rgba)
      g.putImageData(new ImageData(bytes, frame.width, frame.height), 0, 0)
      canvas.hidden = false
      paintedTime = frame.time
    }

    function paintIfWanted(frame: ThumbFrame): void {
      if (hoverTime === null) return
      // Compared with a tolerance rather than by key: main's bucket is
      // authoritative and the overlay's copy of the arithmetic only has to land
      // in the same neighbourhood.
      if (Math.abs(frame.time - hoverTime) > Math.max(status.stepSec, 0.001)) return
      // An exact frame supersedes the keyframe one; a keyframe frame must not
      // overwrite an exact frame that is already up.
      if (paintedTime !== null && Math.abs(paintedTime - frame.time) < 1e-6 && !frame.exact) return
      paint(frame)
    }

    function ask(time: number, exact: boolean): void {
      lastRequestAt = Date.now()
      void ctx.ipc
        .invoke<{ t: number; exact: boolean }, ThumbFrame | null>('nav-thumbnails:request', {
          t: time,
          exact
        })
        .then((frame) => {
          if (!frame) return
          cache.set(keyFor(frame.time), frame)
          paintIfWanted(frame)
        })
    }

    function request(time: number, exact: boolean): void {
      const cached = cache.get(keyFor(time))
      if (cached && (cached.exact || !exact)) {
        paintIfWanted(cached)
        if (!exact) return
      }
      const since = Date.now() - lastRequestAt
      if (since >= MOVE_THROTTLE_MS) {
        ask(time, exact)
        return
      }
      // Trailing edge: the pointer is still moving, so the newest position wins
      // rather than the one that happened to land on the throttle boundary.
      if (moveTimer !== null) clearTimeout(moveTimer)
      moveTimer = setTimeout(() => {
        moveTimer = null
        if (hoverTime !== null) ask(hoverTime, exact)
      }, MOVE_THROTTLE_MS - since)
    }

    function usable(): boolean {
      return status.enabled && status.available && duration > 0
    }

    // ---- state, then contributions ---------------------------------------

    ctx.state.subscribe((s) => {
      duration = s.duration
      chapters = s.chapters
    })

    ctx.ipc.on<ThumbStatus>('nav-thumbnails:statusChanged', (s) => {
      status = s
      cache.clear()
      hoverTime = null
      paintedTime = null
      canvas.hidden = true
      clearTimers()
    })
    ctx.ipc.on<ThumbFrame>('nav-thumbnails:frame', (frame) => {
      cache.set(keyFor(frame.time), frame)
      paintIfWanted(frame)
    })
    // The module's main half may have finished its file-load push before this
    // window existed; ask once rather than waiting for the next file.
    void ctx.ipc
      .invoke<undefined, ThumbStatus>('nav-thumbnails:status')
      .then((s) => {
        if (s) status = s
      })
      .catch(() => undefined)

    ctx.seekbarLayer({
      id: 'nav-thumbnails.preview',
      // Core's timecode is order 0 and M25's chapter title is order 20, so the
      // preview sits between them in the one shared tooltip.
      order: 10,

      render(c): void {
        // No hitTest, so this layer paints nothing onto the bar itself; the
        // only thing it needs from render() is the bar's width, for the
        // chapter-caption de-duplication below.
        barWidth = c.width
      },

      onHover(e): void {
        if (e === null || !usable()) {
          hoverTime = null
          paintedTime = null
          canvas.hidden = true
          clearTimers()
          return
        }
        const time = bucketTime(e.time, duration, status.stepSec)
        if (hoverTime !== null && Math.abs(time - hoverTime) < 1e-6) return
        hoverTime = time
        request(time, false)
        // ~150 ms after the pointer settles, re-ask for the same position with
        // an exact seek. Cancelled by the next move, so a sweep never queues
        // one of these per bucket it passed through.
        if (settleTimer !== null) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (hoverTime !== null) request(hoverTime, true)
        }, SETTLE_MS)
      },

      tooltip(e): { el: HTMLElement; order: number } | null {
        if (!usable()) return null
        const t = bucketTime(e.time, duration, status.stepSec)
        // Keep whatever is on the canvas while the next frame decodes: a
        // preview that blanks between buckets flickers on every hover.
        canvas.hidden = paintedTime === null

        const pxPerSec = duration > 0 && barWidth > 0 ? barWidth / duration : 0
        const ch = shouldShowChapter(chapters, t, pxPerSec) ? chapterAt(chapters, t) : null
        caption.textContent = ch ? ch.title : ''
        caption.hidden = ch === null
        return { el: wrap, order: 10 }
      }
    })
  }
}

export default mod
