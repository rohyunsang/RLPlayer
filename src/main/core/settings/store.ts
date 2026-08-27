import nodeFs from 'node:fs'
import type { SettingsMigration } from '@shared/feature-api'

/**
 * core/settings/store — the generic versioned JSON store (§5.2).
 * WAVE 0 — FROZEN. One instance per file: config, keybinds, mouse, resume,
 * playlists, bookmarks, history.
 *
 * Deliberately free of any Electron import so it can be unit-tested directly
 * under `node --test`. Every filesystem call goes through the injectable `fs`
 * surface below, which is what lets `test:settings-store` spy on fsync.
 */

export class SchemaGapError extends Error {
  constructor(storeId: string, from: number, to: number) {
    super(
      `settings store "${storeId}": no migration path from schema ${from} to ${to}. ` +
        `Register the missing step with registerMigration() — skipping it would ` +
        `silently discard the user's data.`
    )
    this.name = 'SchemaGapError'
  }
}

/** The exact slice of node:fs the store uses. Injectable for tests. */
export interface StoreFs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  mkdirSync(p: string, o: { recursive: true }): string | undefined
  openSync(p: string, flags: string): number
  writeSync(fd: number, data: string): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(a: string, b: string): void
  copyFileSync(a: string, b: string): void
}

const realFs: StoreFs = {
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  openSync: (p, flags) => nodeFs.openSync(p, flags),
  writeSync: (fd, data) => nodeFs.writeSync(fd, data),
  fsyncSync: (fd) => nodeFs.fsyncSync(fd),
  closeSync: (fd) => nodeFs.closeSync(fd),
  renameSync: (a, b) => nodeFs.renameSync(a, b),
  copyFileSync: (a, b) => nodeFs.copyFileSync(a, b)
}

export interface StoreOptions<T extends object> {
  id: string
  file: string
  version: number
  defaults: T
  migrations?: readonly SettingsMigration[]
  /**
   * Schema to assume when the file has no `schema` field at all. Defaults to
   * `version`, i.e. "an unversioned file is current" — right for config.json,
   * which shipped in v0.1 without one. Set it to 0 for a store whose SHAPE
   * changed, so the 0→1 migration actually runs instead of the old contents
   * being silently swept into __extra.
   */
  legacyVersion?: number
  /** Debounce for write(). 0 makes every write synchronous (tests). */
  debounceMs?: number
  fs?: StoreFs
  now?: () => number
  onError?: (kind: 'corrupt' | 'write' | 'readonly', detail: string) => void
}

const EXTRA = '__extra'

export interface Store<T extends object> {
  read(): T
  write(patch: Partial<T>): void
  replace(next: T): void
  flush(): void
  readonly readOnly: boolean
  readonly recovered: boolean
  readonly path: string
}

export function createStore<T extends object>(opts: StoreOptions<T>): Store<T> {
  const fs = opts.fs ?? realFs
  const now = opts.now ?? Date.now
  const debounceMs = opts.debounceMs ?? 300
  const migrations = [...(opts.migrations ?? [])]

  let cache: T | null = null
  let readOnly = false
  let recovered = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  function fresh(): T {
    return { ...opts.defaults, [EXTRA]: {} } as unknown as T
  }

  function isPlain(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }

  function quarantine(): void {
    try {
      fs.renameSync(opts.file, `${opts.file}.corrupt.${now()}`)
    } catch {
      /* nothing better to do; the fresh defaults still load */
    }
    recovered = true
    opts.onError?.('corrupt', opts.file)
  }

  /**
   * P10: keys we do not know about are preserved verbatim in `__extra` and
   * re-spread on write. Without this, opening an older build once silently
   * deletes every setting the newer build added.
   */
  function merge(raw: Record<string, unknown>): T {
    const out = { ...opts.defaults } as Record<string, unknown>
    const extra: Record<string, unknown> = isPlain(raw[EXTRA]) ? { ...raw[EXTRA] } : {}
    for (const [k, v] of Object.entries(raw)) {
      if (k === EXTRA || k === 'schema') continue
      if (v === undefined) continue
      if (k in opts.defaults) {
        const base = (opts.defaults as Record<string, unknown>)[k]
        out[k] = isPlain(base) && isPlain(v) ? { ...base, ...v } : v
      } else {
        extra[k] = v
      }
    }
    out[EXTRA] = extra
    return out as T
  }

  function migrate(raw: Record<string, unknown>): Record<string, unknown> {
    const from =
      typeof raw['schema'] === 'number'
        ? (raw['schema'] as number)
        : (opts.legacyVersion ?? opts.version)
    if (from === opts.version) return raw

    if (from > opts.version) {
      // P09: a newer schema means an older build is reading a newer file. Never
      // migrate downwards and never save — that is how a downgrade eats a
      // config. Read-only plus a banner is the honest behaviour.
      readOnly = true
      opts.onError?.('readonly', `schema ${from} > ${opts.version}`)
      return raw
    }

    // P08: keep the pre-migration file. A migration bug must be recoverable by
    // hand, and it always is if the original is still on disk.
    try {
      fs.copyFileSync(opts.file, `${opts.file}.bak.v${from}`)
    } catch {
      /* best-effort */
    }

    let data = raw
    let at = from
    while (at < opts.version) {
      const step = migrations.find((m) => m.from === at)
      if (!step) throw new SchemaGapError(opts.id, at, opts.version)
      data = step.up(data)
      at = step.to
    }
    data['schema'] = opts.version
    return data
  }

  function read(): T {
    if (cache) return cache
    if (!fs.existsSync(opts.file)) {
      cache = fresh()
      return cache
    }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(opts.file, 'utf8'))
    } catch {
      // P12: never silently start from defaults over a file that exists. The
      // user's settings are quarantined where they can get them back, and the
      // toast tells them it happened.
      quarantine()
      cache = fresh()
      return cache
    }
    if (!isPlain(raw)) {
      quarantine()
      cache = fresh()
      return cache
    }
    cache = merge(migrate(raw))
    return cache
  }

  function serialise(value: T): string {
    const body: Record<string, unknown> = { schema: opts.version }
    for (const [k, v] of Object.entries(value)) {
      if (k === EXTRA) continue
      body[k] = v
    }
    const extra = (value as Record<string, unknown>)[EXTRA]
    if (isPlain(extra)) {
      for (const [k, v] of Object.entries(extra)) if (!(k in body)) body[k] = v
    }
    return JSON.stringify(body, null, 2)
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty || readOnly || !cache) return
    dirty = false
    const target = opts.file
    const tmp = `${target}.tmp`
    try {
      const dir = target.replace(/[\\/][^\\/]*$/, '')
      if (dir && dir !== target) fs.mkdirSync(dir, { recursive: true })
      // P11: open → write → FSYNC → close → rename. Without the fsync the
      // rename can land before the bytes do, and a power loss leaves a
      // zero-length config that parses as corrupt on next boot.
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, serialise(cache))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, target)
    } catch (e) {
      opts.onError?.('write', (e as Error).message)
    }
  }

  function schedule(): void {
    dirty = true
    if (readOnly) return
    if (debounceMs <= 0) {
      flush()
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, debounceMs)
    // Never hold the event loop open for a settings write.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  return {
    read,
    write(patch: Partial<T>): void {
      const cur = read()
      const next = { ...cur } as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue
        const base = (cur as Record<string, unknown>)[k]
        next[k] = isPlain(base) && isPlain(v) ? { ...base, ...v } : v
      }
      cache = next as T
      schedule()
    },
    replace(next: T): void {
      read()
      cache = { ...next } as T
      schedule()
    },
    flush,
    get readOnly(): boolean {
      read()
      return readOnly
    },
    get recovered(): boolean {
      read()
      return recovered
    },
    path: opts.file
  }
}
