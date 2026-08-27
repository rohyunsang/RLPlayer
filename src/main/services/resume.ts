import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataDir } from './config'
import type { ResumeEntry } from '@shared/types'

const FILE = (): string => path.join(dataDir(), 'resume.json')
const MAX_ENTRIES = 500

/**
 * Below this many seconds in, an open was probably accidental -- saving it just
 * pollutes the store with entries the user never wants offered back.
 */
const MIN_RESUME_SECONDS = 60

/**
 * Treat a file as finished once the position is inside the last 90 seconds OR
 * the last 5% of its runtime, whichever margin is larger. Percentage alone
 * mishandles short clips; a flat margin alone mishandles 3-hour films. This is
 * the same rule mpv settled on in its own watch-later handling (mpv PR #2052).
 */
const END_MARGIN_SECONDS = 90
const END_MARGIN_FRACTION = 0.05

function finishedThreshold(duration: number): number {
  return duration - Math.max(END_MARGIN_SECONDS, duration * END_MARGIN_FRACTION)
}

/**
 * Identify a file by path + size rather than by content hash: hashing a 4 GB
 * MKV on every open would be unusable, and path+size is stable enough that a
 * renamed-in-place file keeps its position while a different file never
 * inherits one.
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

type Store = Record<string, ResumeEntry>

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) return parsed as Store
  } catch {
    /* first run, or corrupt file: start clean */
  }
  return {}
}

function write(store: Store): void {
  try {
    const entries = Object.entries(store)
    // Keep the store bounded: drop the oldest once it grows past MAX_ENTRIES.
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      store = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    }
    const target = FILE()
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8')
    fs.renameSync(tmp, target)
  } catch (e) {
    console.error('[resume] save failed:', (e as Error).message)
  }
}

export function recordPosition(file: string, position: number, duration: number): void {
  if (!file || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return
  const store = read()
  const key = resumeKey(file)
  if (position < MIN_RESUME_SECONDS || position > finishedThreshold(duration)) {
    // Finished (or barely started): forget it so next open starts fresh.
    if (store[key]) {
      delete store[key]
      write(store)
    }
    return
  }
  store[key] = { key, path: file, position, duration, updatedAt: Date.now() }
  write(store)
}

/** Returns the saved position for a file, or null if there is nothing useful. */
export function lookupPosition(file: string): ResumeEntry | null {
  const entry = read()[resumeKey(file)]
  if (!entry) return null
  if (entry.position < MIN_RESUME_SECONDS) return null
  return entry
}

export function forget(file: string): void {
  const store = read()
  const key = resumeKey(file)
  if (store[key]) {
    delete store[key]
    write(store)
  }
}

export function clearAll(): void {
  write({})
}
