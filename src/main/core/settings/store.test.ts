import test from 'node:test'
import assert from 'node:assert/strict'
import { SchemaGapError, createStore, type StoreFs } from './store.ts'

/**
 * test:settings-store (§6.2): "round-trip; unknown-key preservation;
 * schema > CURRENT read-only; corrupt-file quarantine; migration gap throws;
 * fsync called (spy)."
 */

interface Fake {
  fs: StoreFs
  files: Map<string, string>
  fsyncs: number
  renames: Array<[string, string]>
  copies: Array<[string, string]>
}

function fakeFs(initial: Record<string, string> = {}): Fake {
  const files = new Map(Object.entries(initial))
  const open = new Map<number, string>()
  const buffers = new Map<number, string>()
  let nextFd = 3
  const state: Fake = {
    files,
    fsyncs: 0,
    renames: [],
    copies: [],
    fs: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => {
        const v = files.get(p)
        if (v === undefined) throw new Error(`ENOENT ${p}`)
        return v
      },
      mkdirSync: () => undefined,
      openSync: (p) => {
        const fd = nextFd++
        open.set(fd, p)
        buffers.set(fd, '')
        return fd
      },
      writeSync: (fd, data) => {
        buffers.set(fd, (buffers.get(fd) ?? '') + data)
        return data.length
      },
      fsyncSync: () => {
        state.fsyncs++
      },
      closeSync: (fd) => {
        const p = open.get(fd)
        if (p) files.set(p, buffers.get(fd) ?? '')
        open.delete(fd)
        buffers.delete(fd)
      },
      renameSync: (a, b) => {
        state.renames.push([a, b])
        const v = files.get(a)
        files.delete(a)
        if (v !== undefined) files.set(b, v)
      },
      copyFileSync: (a, b) => {
        state.copies.push([a, b])
        const v = files.get(a)
        if (v !== undefined) files.set(b, v)
      }
    }
  }
  return state
}

interface Cfg extends Record<string, unknown> {
  volume: number
  window: { width: number; height: number }
}

const DEFAULTS: Cfg = { volume: 100, window: { width: 1100, height: 660 } }

function store(f: Fake, over: Record<string, unknown> = {}): ReturnType<typeof createStore<Cfg>> {
  return createStore<Cfg>({
    id: 'config',
    file: 'C:/data/config.json',
    version: 1,
    defaults: DEFAULTS,
    debounceMs: 0,
    fs: f.fs,
    now: () => 1234,
    ...over
  })
}

test('round-trips values and merges nested objects over defaults', () => {
  const f = fakeFs()
  const s = store(f)
  s.write({ volume: 55 })
  s.flush()

  const reread = store(fakeFs(Object.fromEntries(f.files)))
  assert.equal(reread.read().volume, 55)
  assert.deepEqual(reread.read().window, { width: 1100, height: 660 })
})

test('unknown keys are preserved and written back (P10)', () => {
  const f = fakeFs({
    'C:/data/config.json': JSON.stringify({ schema: 1, volume: 70, futureFeature: { a: 1 } })
  })
  const s = store(f)
  assert.equal(s.read().volume, 70)
  s.write({ volume: 80 })
  s.flush()
  const written = JSON.parse(f.files.get('C:/data/config.json') ?? '{}')
  assert.deepEqual(
    written.futureFeature,
    { a: 1 },
    'opening an older build once must not delete what a newer one added'
  )
  assert.equal(written.volume, 80)
})

test('the write is open -> write -> FSYNC -> close -> rename (P11)', () => {
  const f = fakeFs()
  const s = store(f)
  s.write({ volume: 42 })
  s.flush()
  assert.equal(f.fsyncs, 1, 'without fsync a power loss leaves a zero-length config')
  assert.deepEqual(f.renames, [['C:/data/config.json.tmp', 'C:/data/config.json']])
})

test('a schema NEWER than ours is read-only, and never saved (P09)', () => {
  const f = fakeFs({
    'C:/data/config.json': JSON.stringify({ schema: 99, volume: 33 })
  })
  const problems: string[] = []
  const s = store(f, { onError: (kind: string) => problems.push(kind) })
  assert.equal(s.readOnly, true)
  assert.equal(s.read().volume, 33)
  s.write({ volume: 1 })
  s.flush()
  assert.equal(f.fsyncs, 0, 'a downgrade must never overwrite a newer file')
  assert.ok(problems.includes('readonly'))
})

test('a corrupt file is quarantined, not silently replaced (P12)', () => {
  const f = fakeFs({ 'C:/data/config.json': '{ this is not json' })
  const problems: string[] = []
  const s = store(f, { onError: (kind: string) => problems.push(kind) })
  assert.equal(s.read().volume, 100, 'defaults take over')
  assert.equal(s.recovered, true)
  assert.deepEqual(f.renames, [['C:/data/config.json', 'C:/data/config.json.corrupt.1234']])
  assert.ok(problems.includes('corrupt'))
})

test('a migration runs, after backing the old file up (P08)', () => {
  const f = fakeFs({ 'C:/data/config.json': JSON.stringify({ schema: 1, loudness: 7 }) })
  const s = createStore<Cfg>({
    id: 'config',
    file: 'C:/data/config.json',
    version: 2,
    defaults: DEFAULTS,
    debounceMs: 0,
    fs: f.fs,
    migrations: [{ from: 1, to: 2, up: (d) => ({ ...d, volume: (d.loudness as number) * 10 }) }]
  })
  assert.equal(s.read().volume, 70)
  assert.deepEqual(f.copies, [['C:/data/config.json', 'C:/data/config.json.bak.v1']])
})

test('a missing migration step THROWS rather than skipping', () => {
  const f = fakeFs({ 'C:/data/config.json': JSON.stringify({ schema: 1, volume: 5 }) })
  const s = createStore<Cfg>({
    id: 'config',
    file: 'C:/data/config.json',
    version: 3,
    defaults: DEFAULTS,
    debounceMs: 0,
    fs: f.fs,
    migrations: [{ from: 2, to: 3, up: (d) => d }]
  })
  assert.throws(() => s.read(), SchemaGapError)
})

test('legacyVersion makes an unversioned file migrate instead of vanishing', () => {
  // v0.1 wrote resume.json as a bare map with no `schema` field at all.
  const f = fakeFs({
    'C:/data/config.json': JSON.stringify({ abc123: { position: 42 } })
  })
  const s = createStore<{ entries: Record<string, unknown> }>({
    id: 'resume',
    file: 'C:/data/config.json',
    version: 1,
    legacyVersion: 0,
    defaults: { entries: {} },
    debounceMs: 0,
    fs: f.fs,
    migrations: [
      {
        from: 0,
        to: 1,
        up: (d) => {
          const entries: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(d)) {
            if (k !== 'schema' && k !== 'entries') entries[k] = v
          }
          return { entries }
        }
      }
    ]
  })
  assert.deepEqual(s.read().entries, { abc123: { position: 42 } })
})

test('a value written back equal to the previous one still round-trips', () => {
  const f = fakeFs()
  const s = store(f)
  s.write({ window: { width: 800, height: 600 } })
  s.flush()
  assert.deepEqual(s.read().window, { width: 800, height: 600 })
})
