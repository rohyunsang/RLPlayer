import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * test:bus-capability — the ownership-bypass regression suite.
 *
 * WHAT IT WOULD HAVE CAUGHT. `core/mpv/bus.ts` exported a singleton, and eight
 * routes off it all LANDED A WRITE in the live mpv from a file under
 * `src/main/features/`:
 *
 *   mpvBus.createService('victim').set('speed', 1.5)   -> speed = 1.5
 *   mpvBus.createService('core/mpv/bus')               -> core's own id, accepted
 *   mpvBus.createService('x', { privileged: true })    -> privilege for the asking
 *   mpvBus.setOwnerMap(new OwnerMap([...'a*'..'z*']))  -> disarmed all 38 guards
 *   mpvBus.contributeArgs('core/mpv/bus', 0, …)        -> --speed=4, --wid=999
 *   mpvBus.chainExec(['vf','set','hflip'])             -> bypassed vf-chain
 *
 * The only barrier was a grep, and the grep matched `from '...'` only, so
 * `await import('../../core/mpv/bus.ts')` walked around all of it while
 * `check:forbidden` printed "clean (90 files scanned)" and exited 0.
 *
 * These are SOURCE assertions because `bus.ts` imports Electron and cannot be
 * loaded under `node --test`. That is not a weakness here: what has to be true
 * is a shape — no instance is exported, one core file creates it, nothing
 * outside core imports it — and a shape is exactly what a source check can
 * prove for every file at once, on every push, without a desktop session.
 *
 * `scripts/check-forbidden.mjs --self-test` covers the grep half, with the
 * dynamic-import escalations as fixtures it must keep catching.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const bus = fs.readFileSync(path.join(here, 'bus.ts'), 'utf8')

function sourcesUnder(rel: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|js)$/.test(e.name)) {
        out.push({
          file: path.relative(repo, full).replace(/\\/g, '/'),
          text: fs.readFileSync(full, 'utf8')
        })
      }
    }
  }
  walk(path.join(repo, rel))
  return out
}

test('the bus exports no instance — there is nothing to import and use', () => {
  // `export const mpvBus = new MpvBus()` is the entire bug. Every one of the
  // eight bypass routes started with that identifier.
  assert.ok(
    !/export\s+const\s+mpvBus/.test(bus),
    'core/mpv/bus.ts exports a bus INSTANCE again. A singleton with a public ' +
      'createService() is not an ownership system; it is a suggestion.'
  )
  assert.ok(
    !/^export class MpvBus/m.test(bus),
    'the MpvBus class is exported: `new MpvBus()` in a feature module would spawn a second ' +
      'mpv against the same HWND. Export the TYPE only.'
  )
  assert.match(bus, /export type \{ MpvBus \}/)
  assert.match(bus, /export function createMpvBus\(\): MpvBus/)
})

test('the bus can be created exactly once', () => {
  // A module that reaches for `await import('.../bus.ts')` must find a factory
  // that refuses, not one that hands out a second bus with no owner map.
  assert.match(bus, /let created = false/)
  assert.match(bus, /if \(created\) \{[\s\S]*?throw new ContributionError/)
})

test('exactly one file in the app creates the bus', () => {
  const callers = sourcesUnder('src')
    .filter((s) => !s.file.endsWith('.test.ts'))
    // The factory's own definition is not a call site.
    .filter((s) => s.file !== 'src/main/core/mpv/bus.ts')
    .filter((s) => /\bcreateMpvBus\s*\(/.test(s.text))
  assert.deepEqual(
    callers.map((c) => c.file),
    ['src/main/index.ts'],
    'the bus is created once, at boot, in src/main/index.ts'
  )
})

test('nothing outside src/main/core imports the bus at all', () => {
  const offenders = sourcesUnder('src')
    .filter((s) => !s.file.startsWith('src/main/core/') && s.file !== 'src/main/index.ts')
    // An IMPORT, not a mention: manager.ts's header comment says where its argv
    // comes from, and a check that fires on prose is a check people silence.
    .filter((s) => /(?:from|import|require)\s*\(?\s*['"][^'"]*core\/mpv\/bus/.test(s.text))
    .map((s) => s.file)
  assert.deepEqual(offenders, [], `these files import core/mpv/bus: ${offenders.join(', ')}`)
})

test('the privileged surface is unreachable from outside the bus', () => {
  // `setOwnerMap` was the worst of the eight: one module installing its own
  // OwnerMap disarmed all thirty-eight hardened attacks AND locked the
  // legitimate owner out of its own property.
  assert.match(bus, /setOwnerMap\(map: OwnerMap, moduleIds: readonly string\[\]\)/)
  assert.match(bus, /if \(this\.owners\) \{\s*throw new ContributionError/)
  // `contributeArgs` used to take the id from the caller, which bought the
  // reserved.ts exemptions and with them --speed=4 / --wid=999 / --vo=gpu.
  assert.match(bus, /private contributeArgs\(ownerId: string/)
  // `chainExec` was public and its own comment said it "buys a module exactly
  // nothing"; it bought a filter-chain write past core/vf-chain's arbitration.
  assert.match(bus, /private chainExec<T>/)
})

test('createService validates the id and refuses to grant privilege on request', () => {
  assert.match(bus, /const PRIVILEGED_IDS: ReadonlySet<string>/)
  assert.match(bus, /if \(privileged && !PRIVILEGED_IDS\.has\(ownerId\)\)/)
  assert.match(bus, /!bus\.knownIds\.has\(ownerId\)/)
})

test('naming yourself core is not a credential', () => {
  // MEASURED: `createService('core/mpv/bus')` — WITHOUT the privileged flag,
  // which is the thing that was actually checked — was minted a working service
  // and wrote core's `pause`. The id check read
  //   `!privileged && !PRIVILEGED_IDS.has(ownerId) && !bus.knownIds.has(ownerId)`
  // so any of the three core ids skipped it entirely, and `assertWrite` then
  // consulted the owner map, which agrees that core owns `pause`.
  // CODE ONLY. bus.ts quotes the broken expression in the comment that explains
  // why it is gone, and an assertion that fires on prose is an assertion people
  // delete the prose to satisfy.
  const code = bus.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(
    code,
    /!privileged && !PRIVILEGED_IDS\.has\(ownerId\) && !bus\.knownIds\.has\(ownerId\)/,
    'the id check exempts core ids again. Core mints its services with ' +
      '{ privileged: true } from src/main/index.ts; it never needs the exemption, and the ' +
      'exemption is what let a feature module claim the core id.'
  )
  assert.match(
    code,
    /if \(!privileged && !bus\.knownIds\.has\(ownerId\)\)/,
    'every non-privileged id must be one core/registry actually loaded'
  )
})

test('the command SHAPE is checked before any other guard, for privileged callers too', () => {
  // `assertCommandShape` has to run above the `if (privileged) return true`
  // early-out: a boxed argument is not a permission question, it is a command
  // the guards cannot read, and core has no business sending one either.
  const start = bus.indexOf('const checkCommand = (args: unknown[]): boolean => {')
  assert.ok(start > 0, 'checkCommand not found in bus.ts')
  const body = bus.slice(start, bus.indexOf(`${String.fromCharCode(10)}    }`, start))
  const shapeAt = body.indexOf('assertCommandShape(args)')
  const privilegedAt = body.indexOf('if (privileged) return true')
  assert.ok(shapeAt >= 0, 'checkCommand no longer validates the command shape')
  assert.ok(privilegedAt >= 0)
  assert.ok(
    shapeAt < privilegedAt,
    'the shape check moved below the privileged early-out, so a boxed command from core ' +
      'reaches mpv unread again'
  )
})

test('only the registry mints a module service, and it bakes in the real id', () => {
  const registry = fs.readFileSync(path.join(repo, 'src/main/core/registry.ts'), 'utf8')
  assert.match(registry, /mpv: registry\.deps\.mpv\.createService\(id\)/)
  const minters = sourcesUnder('src')
    .filter((s) => !s.file.endsWith('.test.ts'))
    .filter((s) => /\.createService\(/.test(s.text) && /mpv/i.test(s.text))
    .map((s) => s.file)
    .filter((f) => f !== 'src/main/core/ipc.ts')
  assert.deepEqual(
    minters.sort(),
    ['src/main/core/mpv/bus.ts', 'src/main/core/registry.ts', 'src/main/index.ts'],
    'an mpv service is minted in exactly three places: the bus that defines it, the registry ' +
      'that hands one to each module, and index.ts for core transport'
  )
})

test('the filter chains get their exec from the bus, not from a public method', () => {
  for (const kind of ['vf', 'af']) {
    const chain = fs.readFileSync(path.join(here, `${kind}-chain.ts`), 'utf8')
    assert.ok(!/from '\.\/bus\.ts'/.test(chain), `${kind}-chain.ts imports the bus directly`)
  }
  assert.match(bus, /chain\.attachExec\(\{ command: \(args\) => this\.chainExec\(args\) \}\)/)
})

/**
 * THE COSMETIC ASSERTION THIS REPLACES.
 *
 * The old test was `assert.ok(!/chainExec/.test(chain))` — a grep for a NAME, on
 * a file that never had that name in it. The field is called `exec`, it was a
 * TypeScript `private` (which erases to an ordinary enumerable own property),
 * and the chain SINGLETON was exported, so all of this ran from a feature module
 * and all of it landed:
 *
 *     const { vfChain } = await import('../../core/mpv/vf-chain.ts')
 *     Object.keys(vfChain)                          // includes 'exec'
 *     vfChain.exec.command(['vf', 'set', 'hflip'])  // raw chain write
 *     vfChain.claim('attacker-module', ['rl-lut'])  // stole a reserved label
 *
 * Both halves of that were wrong: grepping a name proves nothing about the
 * runtime object, and the name was not even the right one. So this asserts on
 * the real thing — what the module EXPORTS, and what the exported value's own
 * properties are when you look at it.
 */
test('vf-chain and af-chain export a factory and no instance', async () => {
  for (const kind of ['vf', 'af']) {
    const mod: Record<string, unknown> = await import(`./${kind}-chain.ts`)
    const factory = kind === 'vf' ? 'createVfChain' : 'createAfChain'
    assert.deepEqual(
      Object.keys(mod).sort(),
      [factory],
      `${kind}-chain.ts exports more than its factory. An exported FilterChain instance is ` +
        `reachable in one dynamic import, and every one of its fields with it.`
    )

    const admin = (mod[factory] as () => Record<string, unknown>)()
    for (const forbidden of ['exec', 'slots', 'claims', 'cfg', 'ready', 'pending', 'applying']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(admin, forbidden),
        false,
        `${kind} chain admin has an own property '${forbidden}' at RUNTIME`
      )
      assert.equal(admin[forbidden], undefined, `${kind} chain admin.${forbidden} is readable`)
    }
    assert.deepEqual(
      Object.keys(admin).sort(),
      ['attachExec', 'claim', 'hasCpuFilter', 'onFileLoaded', 'onUnload', 'serialise', 'serviceFor'],
      `the ${kind} admin surface grew a member; every one of them is a way in`
    )

    // Created ONCE. A module that dynamic-imports the file finds a factory that
    // refuses rather than a second chain with no claims and a live exec.
    assert.throws(() => (mod[factory] as () => unknown)(), /created once/)
  }
})

test('feature modules are imported LAZILY, so core is wired before any of them runs', () => {
  // With `{ eager: true }` every feature module's top-level code ran during the
  // import of src/main/index.ts — before main(), before the bus existed, and
  // therefore in a position to race core for anything claimed once.
  const discovery = fs.readFileSync(path.join(repo, 'src/main/features/index.ts'), 'utf8')
  assert.match(discovery, /import\.meta\.glob<\{ default: FeatureModule \}>\([\s\S]*?eager: false/)
  assert.match(discovery, /export async function collectFeatureModules\(\)/)
})
