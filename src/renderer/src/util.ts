/** Format seconds as m:ss, or h:mm:ss once past an hour. */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

/** Strip the directory and extension from a path, for display. */
export function displayName(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p
  return base
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Every string that reaches the DOM in this app goes through textContent, never
 * innerHTML. This helper exists so that intent is explicit at each call site
 * where the value is derived from a file path.
 */
export function setText(el: Element, value: string): void {
  el.textContent = value
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
