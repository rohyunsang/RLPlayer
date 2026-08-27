/**
 * Pure decision rules for resume-from-position.
 *
 * Kept free of any Electron or filesystem import so the behaviour can be unit
 * tested directly -- these three thresholds are the whole difference between a
 * resume feature people love and one they turn off.
 */

/**
 * Below this many seconds in, an open was probably accidental. Remembering it
 * just pollutes the store with positions nobody wants offered back.
 */
export const MIN_RESUME_SECONDS = 60

/**
 * Treat a file as finished once the position falls inside the last 90 seconds
 * OR the last 5% of its runtime, whichever margin is larger. A percentage alone
 * mishandles short clips; a flat margin alone mishandles three-hour films.
 * This is the rule mpv settled on for its own watch-later handling.
 */
export const END_MARGIN_SECONDS = 90
export const END_MARGIN_FRACTION = 0.05

/** The position past which a file counts as watched to the end. */
export function finishedThreshold(duration: number): number {
  return duration - Math.max(END_MARGIN_SECONDS, duration * END_MARGIN_FRACTION)
}

/** True when a position is worth storing for later resumption. */
export function shouldRemember(position: number, duration: number): boolean {
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return false
  if (duration <= 0 || position <= 0) return false
  if (position < MIN_RESUME_SECONDS) return false
  return position <= finishedThreshold(duration)
}

/** True when a stored position is worth offering back to the user. */
export function shouldOffer(position: number): boolean {
  return Number.isFinite(position) && position >= MIN_RESUME_SECONDS
}
