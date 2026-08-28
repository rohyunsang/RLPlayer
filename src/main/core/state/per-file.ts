import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { shouldOffer, shouldRemember } from '../../services/resume-rules.ts'
import type { PerFileService, PerFileSlice, SettingsMigration } from '@shared/feature-api'
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

/**
 * One file's stored slices.
 *
 * SCHEMA 2. Schema 1 was `resumeKey -> sliceKey -> {field: value}` and carried
 * neither a timestamp nor the path, which made two things impossible:
 *
 *   * EVICTION. `resume.json` is capped at 500 entries and `history.json` at
 *     2000, both by recency. This store was UNCAPPED and never evicted: every
 *     file ever opened kept a bucket forever, with the slice payloads of every
 *     module that ever registered one. Nothing could be dropped because nothing
 *     recorded when a bucket was last touched.
 *   * ENUMERATION. `resumeKey()` is a one-way hash of path+size, so a bucket
 *     could be read only by hashing a path you already had. N11's all-files
 *     bookmark mode and N16's playlist badges both need "what do you have",
 *     and neither could ask.
 */
export interface OptsBucket {
  /** Path this key was computed from. The hash is one-way; this is not. */
  path: string
  /** Last capture, in ms. Drives eviction. */
  updatedAt: number
  /** sliceKey → { field: value } */
  slices: Record<string, Record<string, unknown>>
}

export interface OptsFile extends Record<string, unknown> {
  entries: Record<string, OptsBucket>
}

/**
 * The 1 -> 2 migration. It lives HERE, next to the shape it is migrating, and
 * not inline in `src/main/index.ts` where it was first written -- `index.ts`
 * imports electron, so a migration declared there cannot be unit-tested, and a
 * migration nobody can test is one that eats user data in silence. This is the
 * same reason menu-model.ts is split out of menu.ts.
 *
 * The path is unrecoverable for an existing bucket, because the key is a one-way
 * hash of path+size: it comes back as '' and that bucket simply does not appear
 * in `storedFiles()` until its file is played again. The SLICE DATA -- the part a
 * user would notice losing -- is carried across intact.
 */
export const OPTS_MIGRATIONS: readonly SettingsMigration[] = [
  {
    from: 1,
    to: 2,
    up: (data): Record<string, unknown> => {
      const old = (data['entries'] ?? {}) as Record<string, unknown>
      const entries: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(old)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const bucket = value as Record<string, unknown>
        // Already schema 2 -- a newer build wrote it and then downgraded. Do not
        // wrap it a second time; that would bury the slices one level deeper and
        // silently lose every one of them. Verified by a test that fails when
        // this early-out is removed.
        if ('slices' in bucket) {
          entries[key] = bucket
          continue
        }
        entries[key] = { path: '', updatedAt: 0, slices: bucket }
      }
      return { entries }
    }
  }
]

export interface StoreLike<T> {
  read(): T
  write(patch: Partial<T>): void
  flush(): void
}

const MAX_RESUME_ENTRIES = 500
const MAX_HISTORY_ENTRIES = 2000
/**
 * Between the other two, and for the same reason they have one at all: a bucket
 * holds every registered module's per-file payload, so this is the store that
 * grows fastest per entry. Evicted oldest-first by `updatedAt`.
 */
const MAX_OPTS_ENTRIES = 1000

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

  /**
   * A STRICTLY INCREASING timestamp, and it is load-bearing for eviction.
   *
   * `Date.now()` has millisecond resolution, so opening several files inside one
   * millisecond stamps them all identically — and `bound()` sorts newest-first
   * with a STABLE sort, so a run of ties resolves to insertion order and the
   * OLDEST entries are the ones kept. Measured on the 1005-file eviction test:
   * the cap held at 1000 and the five entries dropped were ep1000..ep1004, the
   * five newest, which is exactly backwards. The resume and history stores are
   * bounded by the same helper and had the same tie.
   */
  private lastStamp = 0

  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

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
      resume[key] = { key, path: file, position, duration, updatedAt: this.stamp() }
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
      playedAt: this.stamp()
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
    const saved = this.stores.opts.read().entries[this.current.key]?.slices ?? {}

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

    /**
     * START FROM WHAT IS ALREADY STORED, minus the keys the modules registered
     * on THIS boot own. Anything left is a slice whose owner is not here, and it
     * is kept verbatim.
     *
     * This used to start from `{}`, so the bucket was rebuilt from the registered
     * slices alone — and a stored slice whose module was not registered was
     * discarded. That collides with a documented guarantee: a module whose
     * `setup()` throws is disabled while the app still runs. Such a module
     * registers no slice, so every file played while it was broken silently
     * DELETED its saved state for that file, and one bad release took the user's
     * per-file settings with it. Worse, when no registered slice produced a diff
     * the whole entry was deleted, taking every OTHER module's data for that
     * file too.
     *
     * P10 is the same principle one level up: the store preserves unknown keys
     * across versions rather than sweeping away what this build does not
     * recognise.
     */
    const bucket: Record<string, Record<string, unknown>> = { ...(all[key]?.slices ?? {}) }
    for (const reg of this.slices) delete bucket[reg.slice.key]

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

    if (Object.keys(bucket).length > 0) {
      all[key] = {
        path: this.current?.path ?? all[key]?.path ?? '',
        updatedAt: this.stamp(),
        slices: bucket
      }
    } else delete all[key]
    // Note the branch above is now reached only when NOTHING is left at all —
    // no diff from any registered slice and no preserved foreign slice — which
    // is the only case where deleting the entry loses nothing.
    this.stores.opts.write({ entries: bound(all, MAX_OPTS_ENTRIES, (e) => e.updatedAt) })
  }

  // --- reading OTHER files (§9) ------------------------------------------

  /**
   * The stored slices for any file, not just the current one.
   *
   * The service could read nothing but the file being played, which is what
   * made N11's all-files bookmark mode and N16's playlist badges inexpressible:
   * both ask about files that are not open. Returns null rather than an empty
   * object when there is no bucket, so "nothing stored" and "stored empty" stay
   * distinguishable.
   */
  slicesFor(file: string): Record<string, Record<string, unknown>> | null {
    const bucket = this.stores.opts.read().entries[resumeKey(file)]
    return bucket ? bucket.slices : null
  }

  sliceFor(file: string, sliceKey: string): Record<string, unknown> | null {
    return this.slicesFor(file)?.[sliceKey] ?? null
  }

  /**
   * Every file with stored slices, newest first. The enumeration N11 needs:
   * `resumeKey()` is one-way, so without the path on the bucket a caller could
   * only ever ask about a path it already had.
   */
  storedFiles(): { key: string; path: string; updatedAt: number; sliceKeys: string[] }[] {
    return Object.entries(this.stores.opts.read().entries)
      .map(([key, b]) => ({
        key,
        path: b.path,
        updatedAt: b.updatedAt,
        sliceKeys: Object.keys(b.slices)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Capture AND fsync, for data that must survive a crash rather than a clean
   * quit. `captureNow()` only reaches the store, whose write is debounced 300 ms
   * and whose flush otherwise happens on quit — so a module that had just
   * captured a bookmark and then lost the process lost the bookmark.
   */
  persistNow(): void {
    this.captureSlices()
    this.stores.opts.flush()
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
      captureNow: () => mgr.captureSlices(),
      persistNow: () => mgr.persistNow(),
      slicesFor: (file) => mgr.slicesFor(file),
      sliceFor: (file, sliceKey) => mgr.sliceFor(file, sliceKey),
      storedFiles: () => mgr.storedFiles()
    }
  }
}

function bound<T>(map: Record<string, T>, max: number, age: (v: T) => number): Record<string, T> {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  entries.sort((a, b) => age(b[1]) - age(a[1]))
  return Object.fromEntries(entries.slice(0, max))
}
