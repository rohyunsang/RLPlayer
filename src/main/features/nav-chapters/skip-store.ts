import fs from 'node:fs'
import path from 'node:path'
import {
  SKIP_STORE_VERSION,
  sanitizeStore,
  type SkipFolder,
  type SkipStoreData
} from './skip-model.ts'

/**
 * `<dataDir>/skip.json`, the store §2.5's N51 row names.
 *
 * This is deliberately NOT `ctx.perFile.slice()`, which is the store M26 chose
 * and the one a reviewer will ask about. The per-file service is keyed by
 * `resumeKey()` — a one-way hash of path plus size — and N51's whole premise is
 * that a window learned on episode 3 applies to episodes 1..12, which are twelve
 * different keys. There is no per-file identity that answers "this folder".
 *
 * What that costs is the store guarantees §3.3.2 gives away for free, so they
 * are reimplemented here and only here: an atomic write via tmp + rename, an
 * fsync before the rename (a bookmark that survives a clean quit but not a
 * crash is the defect P11 exists for), and a corrupt file moved aside rather
 * than deleted, so a hand-edited `skip.json` can be recovered by the person who
 * hand-edited it.
 */

export class SkipStore {
  readonly #file: string
  readonly #log: { warn(...a: unknown[]): void }
  #data: SkipStoreData = { version: SKIP_STORE_VERSION, folders: {} }
  #loaded = false
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(file: string, log: { warn(...a: unknown[]): void }) {
    this.#file = file
    this.#log = log
  }

  get file(): string {
    return this.#file
  }

  /**
   * Read once, tolerate everything.
   *
   * A missing file is the normal first run. A corrupt one is quarantined to
   * `skip.json.corrupt.<ts>` and the session starts empty — the same policy
   * `core/settings` applies (P12), for the same reason: refusing to start
   * because a JSON file has a stray comma is a worse outcome than losing two
   * numbers.
   */
  load(): SkipStoreData {
    if (this.#loaded) return this.#data
    this.#loaded = true
    let text: string
    try {
      text = fs.readFileSync(this.#file, 'utf8')
    } catch {
      return this.#data
    }
    try {
      this.#data = sanitizeStore(JSON.parse(text) as unknown)
    } catch (e) {
      this.#quarantine(text, e as Error)
    }
    return this.#data
  }

  #quarantine(text: string, err: Error): void {
    const dest = `${this.#file}.corrupt.${Date.now()}`
    try {
      fs.writeFileSync(dest, text, 'utf8')
      this.#log.warn(`skip.json was unreadable (${err.message}); kept a copy at ${dest}`)
    } catch {
      this.#log.warn(`skip.json was unreadable (${err.message}) and could not be copied aside`)
    }
    this.#data = { version: SKIP_STORE_VERSION, folders: {} }
  }

  folder(key: string): SkipFolder | undefined {
    return this.load().folders[key]
  }

  /** Replace one folder's record. `undefined` removes it. */
  put(key: string, record: SkipFolder | undefined): void {
    const data = this.load()
    const empty =
      record === undefined ||
      (record.window === undefined &&
        (record.intro === undefined || record.intro.length === 0) &&
        (record.ending === undefined || record.ending.length === 0))
    if (empty) {
      if (data.folders[key] === undefined) return
      delete data.folders[key]
    } else {
      data.folders[key] = record
    }
    this.#dirty = true
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.flush()
    }, 400)
    this.#timer.unref?.()
  }

  /**
   * Atomic, fsynced, and never throws upward.
   *
   * The fsync is on the temp FILE, before the rename — fsyncing after the rename
   * is the ordering that loses the write on power loss while looking correct in
   * code review.
   */
  flush(): void {
    if (!this.#dirty) return
    const tmp = `${this.#file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeFileSync(fd, JSON.stringify(this.#data, null, 2), 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, this.#file)
      this.#dirty = false
    } catch (e) {
      this.#log.warn(`could not write ${this.#file}: ${(e as Error).message}`)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* a locked temp file is retried on the next flush */
      }
    }
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.flush()
  }
}
