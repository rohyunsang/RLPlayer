import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { shouldOffer, shouldRemember } from '../../services/resume-rules.ts'
import type { PerFileService, PerFileSlice } from '@shared/feature-api'
import type { ResumeEntry } from '@shared/types'

/**
 * core/state/per-file — one identity, many slices (§5.7). WAVE 0 — FROZEN.
 *
 * Four things that used to be four different opinions now agree because they
 * all ask this file: resume, history, bookmarks and per-file options.
 *
 * TWO STORES, DELIBERATELY. `resume.json` DELETES an entry once the file is
 * finished, so a stale position is never offered back; `history.json` KEEPS it
 * with `finished: true` so the history panel can show a checkmark (N40). One
 * store cannot do both without one of the two features lying.
 *
 * PH-2: `vf` and `af` are struck from the remembered set. mpv's
 * `--watch-later-options` default includes them, and restoring a raw filter
 * string would overwrite whatever core/vf-chain believes the chain to be —
 * the exact raw write §0.2 rule 5 forbids. The chain owners register slices
 * instead.
 */

export const NEVER_REMEMBERED = new Set(['vf', 'af'])

export interface ResumeFile extends Record<string, unknown> {
  entries: Record<string, ResumeEntry>
}

export interface HistoryEntry {
  key: string
  path: string
  name: string
  position: number
  duration: number
  finished: boolean
  playedAt: number
}

export interface HistoryFile extends Record<string, unknown> {
  entries: Record<string, HistoryEntry>
}

export interface OptsFile extends Record<string, unknown> {
  /** resumeKey → sliceKey → { field: value } */
  entries: Record<string, Record<string, Record<string, unknown>>>
}

export interface StoreLike<T> {
  read(): T
  write(patch: Partial<T>): void
  flush(): void
}

const MAX_RESUME_ENTRIES = 500
const MAX_HISTORY_ENTRIES = 2000

/**
 * D-2: `path + size` stays the primary key. Hashing a 4 GB MKV on every open is
 * not an option, and path+size is stable enough that a file moved in place
 * keeps its position while a different file never inherits one.
 */
export function resumeKey(file: string): string {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    size = 0
  }
  return crypto
    .createHash('sha1')
    .update(path.resolve(file).toLowerCase())
    .update(String(size))
    .digest('hex')
}

interface RegisteredSlice {
  ownerId: string
  slice: PerFileSlice<Record<string, unknown>>
  baseline: Record<string, unknown> | null
}

export class PerFileManager {
  private readonly slices: RegisteredSlice[] = []
  private current: { path: string; key: string } | null = null

  private readonly stores: {
    resume: StoreLike<ResumeFile>
    history: StoreLike<HistoryFile>
    opts: StoreLike<OptsFile>
  }

  constructor(stores: {
    resume: StoreLike<ResumeFile>
    history: StoreLike<HistoryFile>
    opts: StoreLike<OptsFile>
  }) {
    this.stores = stores
  }

  registerSlice(ownerId: string, slice: PerFileSlice<Record<string, unknown>>): void {
    this.slices.push({ ownerId, slice, baseline: null })
  }

  currentKey(): string | null {
    return this.current?.key ?? null
  }

  currentPath(): string | null {
    return this.current?.path ?? null
  }

  // --- resume ------------------------------------------------------------

  lookupPosition(file: string): ResumeEntry | null {
    const entry = this.stores.resume.read().entries[resumeKey(file)]
    if (!entry) return null
    return shouldOffer(entry.position) ? entry : null
  }

  lookupMany(paths: readonly string[]): Record<string, { position: number; finished: boolean }> {
    const resume = this.stores.resume.read().entries
    const history = this.stores.history.read().entries
    const out: Record<string, { position: number; finished: boolean }> = {}
    for (const p of paths) {
      const key = resumeKey(p)
      const r = resume[key]
      const h = history[key]
      if (r) out[p] = { position: r.position, finished: false }
      else if (h) out[p] = { position: h.position, finished: h.finished }
    }
    return out
  }

  recordPosition(file: string, position: number, duration: number, name: string): void {
    if (!file || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return
    const key = resumeKey(file)
    const resume = { ...this.stores.resume.read().entries }
    const finished = !shouldRemember(position, duration)

    if (finished) {
      if (resume[key]) {
        delete resume[key]
        this.stores.resume.write({ entries: resume })
      }
    } else {
      resume[key] = { key, path: file, position, duration, updatedAt: Date.now() }
      this.stores.resume.write({ entries: bound(resume, MAX_RESUME_ENTRIES, (e) => e.updatedAt) })
    }

    // N40: history keeps what resume drops, so "watched" survives finishing.
    const history = { ...this.stores.history.read().entries }
    history[key] = {
      key,
      path: file,
      name,
      position,
      duration,
      finished: finished && position > 0,
      playedAt: Date.now()
    }
    this.stores.history.write({ entries: bound(history, MAX_HISTORY_ENTRIES, (e) => e.playedAt) })
  }

  forget(file: string): void {
    const key = resumeKey(file)
    const resume = { ...this.stores.resume.read().entries }
    if (resume[key]) {
      delete resume[key]
      this.stores.resume.write({ entries: resume })
    }
  }

  // --- slices ------------------------------------------------------------

  /**
   * Called after `playback-restart`. Baseline FIRST, then apply: the baseline
   * has to be the state a fresh file starts in, or every restored value would
   * compare equal to it and never be written back (P51).
   */
  async onFileLoaded(file: string): Promise<void> {
    this.current = { path: file, key: resumeKey(file) }
    const saved = this.stores.opts.read().entries[this.current.key] ?? {}

    for (const reg of this.slices) {
      try {
        reg.baseline = { ...reg.slice.capture() }
      } catch (e) {
        reg.baseline = null
        console.error(`[per-file] ${reg.ownerId} capture() threw:`, (e as Error).message)
      }
    }
    for (const reg of this.slices) {
      const value = saved[reg.slice.key]
      if (!value) continue
      const wanted: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (NEVER_REMEMBERED.has(k)) continue
        if (reg.slice.rememberDefaults[k] === false) continue
        wanted[k] = v
      }
      if (Object.keys(wanted).length === 0) continue
      try {
        // Isolated: one module's bad restore must not abort the others.
        await reg.slice.apply(wanted)
      } catch (e) {
        console.error(`[per-file] ${reg.ownerId} apply() threw:`, (e as Error).message)
      }
    }
  }

  /** Called on file close/switch and on quit. */
  captureSlices(): void {
    const key = this.current?.key
    if (!key) return
    const all = { ...this.stores.opts.read().entries }
    const bucket: Record<string, Record<string, unknown>> = {}

    for (const reg of this.slices) {
      let now: Record<string, unknown>
      try {
        now = reg.slice.capture()
      } catch {
        continue
      }
      const baseline = reg.baseline ?? {}
      const diff: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(now)) {
        if (NEVER_REMEMBERED.has(k)) continue
        if (reg.slice.rememberDefaults[k] === false) continue
        // P51: only what DIFFERS from the baseline is persisted, so changing a
        // default later still reaches files the user has already opened.
        if (!Object.is(baseline[k], v)) diff[k] = v
      }
      if (Object.keys(diff).length > 0) bucket[reg.slice.key] = diff
    }

    if (Object.keys(bucket).length > 0) all[key] = bucket
    else delete all[key]
    this.stores.opts.write({ entries: all })
  }

  onFileClosing(): void {
    this.captureSlices()
    this.current = null
  }

  flush(): void {
    this.stores.resume.flush()
    this.stores.history.flush()
    this.stores.opts.flush()
  }

  createService(ownerId: string): PerFileService {
    const mgr = this
    return {
      slice<T extends Record<string, unknown>>(s: PerFileSlice<T>): void {
        mgr.registerSlice(ownerId, s as unknown as PerFileSlice<Record<string, unknown>>)
      },
      currentKey: () => mgr.currentKey(),
      currentPath: () => mgr.currentPath(),
      forget: (file) => mgr.forget(file),
      lookupMany: (paths) => mgr.lookupMany(paths),
      recordPosition: (file, position, duration) =>
        mgr.recordPosition(file, position, duration, path.basename(file)),
      resumeFor: (file) => {
        const e = mgr.lookupPosition(file)
        return e ? { position: e.position, duration: e.duration } : null
      },
      captureNow: () => mgr.captureSlices()
    }
  }
}

function bound<T>(map: Record<string, T>, max: number, age: (v: T) => number): Record<string, T> {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  entries.sort((a, b) => age(b[1]) - age(a[1]))
  return Object.fromEntries(entries.slice(0, max))
}
