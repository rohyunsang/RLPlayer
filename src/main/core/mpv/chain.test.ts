import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AF_ORDER,
  AF_REFUSERS,
  VF_ORDER,
  VF_REFUSERS,
  createChain,
  filterArgs,
  specOption,
  specReflects,
  type ChainAdmin
} from './chain.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * test:chains (§6.2): "vf/af ordering policy, label replacement,
 * disable-in-place, queueing before file-loaded, unregistered-label rejection."
 *
 * AND, since this file's last round, the thing that actually shipped broken:
 * EVERY `command()` TEST ASSERTS THE RESULTING STATE, NOT THE EMITTED COMMAND.
 *
 * The four-argument `<x>f-command` bug survived a full test file because every
 * assertion here stopped at `sent[0]` — the command was emitted correctly and
 * the chain's own model of the filter was left holding the previous value, so
 * the next whole-chain rebuild reverted it. `chain.test.ts:346` was titled
 * "omitting the spec still works" and asserted only the emitted command, which
 * is exactly the shape of assertion that let it through.
 *
 * So there are now TWO oracles on every live-update test:
 *
 *   1. `chain.serialise()` — what the chain believes, and therefore what the
 *      next rebuild will send.
 *   2. `mpv.chainString()` — a model of what mpv actually holds, built by
 *      APPLYING the commands the chain sent (`vf set` replaces the graph,
 *      `vf-command` mutates one option of one filter in place, exactly as
 *      libavfilter's process_command does).
 *
 * A test passes only when the two AGREE and both hold the new value. Under the
 * old code every one of them fails, which is the point.
 */

// ---------------------------------------------------------------------------
// A model of mpv's filter graph, driven by the commands the chain sends.
// ---------------------------------------------------------------------------

/** Split on `sep` at bracket depth 0: a slot spec holds `[...]` with commas. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

interface FakeMpv {
  /** Feed it one command the chain sent. Returns false for "filter refused". */
  apply(args: unknown[]): boolean
  /** The graph as mpv would report it back, in the order it was set. */
  chainString(): string
  /** One named option of one filter inside one label's spec. */
  option(label: string, filter: string, option: string): string | undefined
  spec(label: string): string | undefined
}

/**
 * `refusers` are the filters this fake mpv answers `<x>f-command` with an error
 * for, which is how the real refuser fallback gets exercised end to end rather
 * than only through the chain's own table.
 */
function fakeMpv(kind: 'vf' | 'af', refusers: readonly string[]): FakeMpv {
  const slots = new Map<string, { spec: string; enabled: boolean }>()
  const order: string[] = []

  const put = (label: string, spec: string, enabled: boolean): void => {
    if (!slots.has(label)) order.push(label)
    slots.set(label, { spec, enabled })
  }

  return {
    apply(args): boolean {
      const [verb, a, b, c, d] = args as string[]
      if (verb === kind && a === 'set') {
        slots.clear()
        order.length = 0
        for (const part of splitTop(b ?? '', ',')) {
          const seg = part.trim()
          if (seg === '') continue
          const m = /^@([A-Za-z0-9-]+):(!?)([\s\S]*)$/.exec(seg)
          assert.ok(m, `mpv cannot parse the slot '${seg}'`)
          put(m[1] as string, m[3] as string, m[2] !== '!')
        }
        return true
      }
      if (verb === `${kind}-command`) {
        assert.equal(args.length, 5, `${kind}-command takes FOUR arguments plus the verb`)
        const label = a as string
        const option = b as string
        const value = c as string
        const filter = d as string
        const slot = slots.get(label)
        assert.ok(slot, `${kind}-command on '${label}', which mpv has no filter for`)
        if (refusers.includes(filter)) return false
        /**
         * A01: `anequalizer`'s `change` replaces the WHOLE entry addressed by an
         * index that counts across every declared channel. It is modelled
         * properly rather than skipped, because `change` is not a named option
         * of the filter and it is therefore the ONE production shape where a
         * lagging spec could not be caught by reading the spec back.
         */
        if (filter === 'anequalizer' && option === 'change') {
          const [idxRaw, ...pairs] = value.split('|')
          const idx = Number(idxRaw)
          const args = filterArgs(slot.spec, 'anequalizer')
          if (args !== undefined && Number.isInteger(idx)) {
            const entries = args.split('|')
            const target = entries[idx]
            if (target !== undefined) {
              const chan = /^(c\d+)/.exec(target.trim())?.[1] ?? `c${idx}`
              entries[idx] = `${chan} ${pairs.map((p) => p.trim()).join(' ')} t=0`
              slot.spec = slot.spec.replace(args, entries.join('|'))
            }
          }
          return true
        }
        // Otherwise process_command replaces one NAMED option in place. A filter
        // with positional arguments cannot express the change at all, which is
        // exactly why the value has to come back out of the SPEC on the next
        // rebuild — and why `command()` has to keep the spec honest.
        const cur = specOption(slot.spec, filter, option)
        if (cur !== undefined) {
          slot.spec = slot.spec.replace(`${option}=${cur}`, `${option}=${value}`)
        }
        return true
      }
      return true
    },
    chainString(): string {
      return order
        .filter((l) => slots.has(l))
        .map((l) => {
          const s = slots.get(l) as { spec: string; enabled: boolean }
          return `@${l}:${s.enabled ? '' : '!'}${s.spec}`
        })
        .join(',')
    },
    option(label, filter, option): string | undefined {
      const spec = slots.get(label)?.spec
      return spec === undefined ? undefined : specOption(spec, filter, option)
    },
    spec(label): string | undefined {
      return slots.get(label)?.spec
    }
  }
}

/**
 * The chain is driven the way production drives it: through the ADMIN object
 * `createChain()` returns, and through one `serviceFor(id)` facade per module.
 * The `FilterChain` instance is not exported and not reachable — which is the
 * fix for `vfChain.exec.command(['vf','set','hflip'])` — so a test that reached
 * for it would be testing a shape production no longer has.
 *
 * The exec now feeds a `FakeMpv` as well as recording, so `mpv` below is the
 * second oracle described at the top of this file.
 */
function makeChain(kind: 'vf' | 'af' = 'vf'): {
  chain: ChainAdmin & {
    set: Setter
    remove: Remover
    toggle: Toggler
    command: Commander
    svc: (owner: string) => FilterChainService
  }
  sent: unknown[][]
  mpv: FakeMpv
} {
  const sent: unknown[][] = []
  const refusers = kind === 'vf' ? VF_REFUSERS : AF_REFUSERS
  const mpv = fakeMpv(kind, refusers)
  const admin = createChain({
    kind,
    order: kind === 'vf' ? VF_ORDER : AF_ORDER,
    refusers
  })
  const services = new Map<string, FilterChainService>()
  const svc = (owner: string): FilterChainService => {
    let s = services.get(owner)
    if (!s) {
      s = admin.serviceFor(owner)
      services.set(owner, s)
    }
    return s
  }
  const chain = {
    claim: admin.claim,
    serviceFor: admin.serviceFor,
    attachExec: admin.attachExec,
    onFileLoaded: admin.onFileLoaded,
    onUnload: admin.onUnload,
    serialise: admin.serialise,
    get hasCpuFilter(): boolean {
      return admin.hasCpuFilter
    },
    svc,
    set: (owner: string, label: string, spec: string) => svc(owner).set(label, spec),
    remove: (owner: string, label: string) => svc(owner).remove(label),
    toggle: (owner: string, label: string, on: boolean) => svc(owner).toggle(label, on),
    command: (
      owner: string,
      label: string,
      opt: string,
      value: string,
      filter: string,
      spec: string
    ) => svc(owner).command(label, opt, value, filter, spec)
  }
  chain.attachExec({
    command: async (args: unknown[]) => {
      sent.push(args)
      // A refuser makes the real exec REJECT, and the chain's catch is what
      // turns that into a rebuild. Modelling it as a resolve would leave the
      // catch path untested.
      if (!mpv.apply(args)) {
        throw new Error(`${String(args[4])} does not implement process_command`)
      }
      return undefined
    }
  })
  return { chain, sent, mpv }
}

type Setter = (owner: string, label: string, spec: string) => void
type Remover = (owner: string, label: string) => void
type Toggler = (owner: string, label: string, on: boolean) => void
type Commander = (
  owner: string,
  label: string,
  opt: string,
  value: string,
  filter: string,
  /** REQUIRED: the spec the slot must hold after the change. */
  spec: string
) => Promise<{ path: 'command' | 'rebuild' }>

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Both oracles agree, and they agree on `expected`. */
function assertAgrees(
  chain: { serialise(): string },
  mpv: FakeMpv,
  expected: string,
  why: string
): void {
  assert.equal(chain.serialise(), expected, `the CHAIN's state is wrong: ${why}`)
  assert.equal(mpv.chainString(), expected, `MPV's state is wrong: ${why}`)
}

test('the chain object hands out no path back to its own state', () => {
  const admin = createChainProbe()
  for (const forbidden of ['exec', 'slots', 'claims', 'cfg', 'ready', 'pending', 'applying']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(admin, forbidden),
      false,
      `the chain admin exposes '${forbidden}' at RUNTIME. TypeScript's \`private\` erases to an ` +
        `ordinary enumerable property, which is how vfChain.exec.command(['vf','set','hflip']) ` +
        `landed a raw filter-chain write from a feature module.`
    )
    assert.equal(
      (admin as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `chain admin.${forbidden} is readable`
    )
  }
  assert.deepEqual(
    Object.keys(admin).sort(),
    ['attachExec', 'claim', 'hasCpuFilter', 'onFileLoaded', 'onUnload', 'serialise', 'serviceFor'],
    'the admin surface is exactly these seven; anything else is a way in'
  )
})

function createChainProbe(): ChainAdmin {
  return createChain({ kind: 'vf', order: VF_ORDER, refusers: VF_REFUSERS })
}

test('an unregistered label throws at claim time, naming the reserved table', () => {
  const { chain } = makeChain()
  assert.throws(() => chain.claim('video-enhance', ['rl-nonsense']), /reserved label table/)
})

test('two modules claiming one label is a boot error naming both', () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  assert.throws(
    () => chain.claim('video-scaler', ['rl-sharpen']),
    (e: Error) => {
      assert.match(e.message, /video-enhance/)
      assert.match(e.message, /video-scaler/)
      return true
    }
  )
})

test('a module may not touch a label it does not own', () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  assert.throws(
    () => chain.set('video-hdr', 'rl-sharpen', 'lavfi=[cas]'),
    /owned by 'video-enhance'/
  )
})

test('changes before file-loaded are QUEUED, not sent', async () => {
  const { chain, sent, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  assert.equal(sent.length, 0, 'mpv cannot validate a filter before the first frame')
  assert.equal(mpv.chainString(), '', 'and mpv holds nothing')

  chain.onFileLoaded()
  await tick()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], ['vf', 'set', '@rl-sharpen:lavfi=[cas=strength=0.4]'])
  assertAgrees(chain, mpv, '@rl-sharpen:lavfi=[cas=strength=0.4]', 'the queue flushed')
})

test('the chain is emitted in POLICY order, not registration order', async () => {
  const { chain, mpv } = makeChain()
  chain.claim('video-geometry', ['rl-hflip', 'rl-rotate'])
  chain.claim('video-enhance', ['rl-sharpen', 'rl-denoise'])
  chain.claim('video-deinterlace', ['rl-deint'])
  chain.onFileLoaded()

  // Registered deliberately backwards.
  chain.set('video-geometry', 'rl-hflip', 'lavfi=[hflip]')
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas]')
  chain.set('video-enhance', 'rl-denoise', 'lavfi=[hqdn3d]')
  chain.set('video-deinterlace', 'rl-deint', 'lavfi=[yadif]')
  await tick()

  assertAgrees(
    chain,
    mpv,
    '@rl-deint:lavfi=[yadif],@rl-denoise:lavfi=[hqdn3d],@rl-sharpen:lavfi=[cas],@rl-hflip:lavfi=[hflip]',
    'deint -> denoise -> sharpen -> hflip, whatever order they arrived in'
  )
})

test('toggling off disables IN PLACE so the settings survive', async () => {
  const { chain, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  chain.toggle('video-enhance', 'rl-sharpen', false)
  await tick()
  assertAgrees(chain, mpv, '@rl-sharpen:!lavfi=[cas=strength=0.4]', 'disabled in place')
  chain.toggle('video-enhance', 'rl-sharpen', true)
  await tick()
  assertAgrees(chain, mpv, '@rl-sharpen:lavfi=[cas=strength=0.4]', 're-enabled in place')
})

test('setting an existing label REPLACES it rather than appending', async () => {
  const { chain, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.2]')
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.9]')
  await tick()
  assertAgrees(chain, mpv, '@rl-sharpen:lavfi=[cas=strength=0.9]', 'replaced, not appended')
})

// ---------------------------------------------------------------------------
// command(): the four-argument form, and the STATE it leaves behind
// ---------------------------------------------------------------------------

test('command() emits the four-argument form AND leaves chain and mpv agreeing', async () => {
  const { chain, sent, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  sent.length = 0

  const res = await chain.command(
    'video-enhance',
    'rl-sharpen',
    'strength',
    '0.55',
    'cas',
    'lavfi=[cas=strength=0.55]'
  )
  assert.equal(res.path, 'command')
  assert.deepEqual(
    sent[0],
    ['vf-command', 'rl-sharpen', 'strength', '0.55', 'cas'],
    'the last argument is the lavfi FILTER NAME, not the label and not "all"'
  )
  // THE ASSERTION THE OLD TEST STOPPED ONE LINE SHORT OF.
  assert.equal(mpv.option('rl-sharpen', 'cas', 'strength'), '0.55', 'mpv took the live value')
  assertAgrees(
    chain,
    mpv,
    '@rl-sharpen:lavfi=[cas=strength=0.55]',
    'the chain must hold what mpv holds, or the next rebuild reverts it'
  )
})

test('a foreign module rebuilding the chain does NOT revert a live command', async () => {
  const { chain, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.claim('video-color', ['rl-levels'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()

  await chain.command(
    'video-enhance',
    'rl-sharpen',
    'strength',
    '0.55',
    'cas',
    'lavfi=[cas=strength=0.55]'
  )

  // ANOTHER module touching its OWN slot rebuilds the whole graph. This is the
  // moment the live value used to disappear, and nothing in the module that owns
  // rl-sharpen is even running at the time.
  chain.set('video-color', 'rl-levels', 'lavfi=[eq=contrast=1.1]')
  await tick()

  assertAgrees(
    chain,
    mpv,
    '@rl-levels:lavfi=[eq=contrast=1.1],@rl-sharpen:lavfi=[cas=strength=0.55]',
    "a foreign module's set() must not roll back a live vf-command"
  )
  assert.equal(mpv.option('rl-sharpen', 'cas', 'strength'), '0.55')
})

test('the same holds across an mpv respawn, which re-applies from the slots', async () => {
  const { chain, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  await chain.command(
    'video-enhance',
    'rl-sharpen',
    'strength',
    '0.8',
    'cas',
    'lavfi=[cas=strength=0.8]'
  )

  // A respawn: mpv forgets everything, the chain re-applies on file-loaded.
  chain.onUnload()
  chain.set('video-enhance', 'rl-sharpen', chain.svc('video-enhance').specOf('rl-sharpen') as string)
  chain.onFileLoaded()
  await tick()
  assertAgrees(chain, mpv, '@rl-sharpen:lavfi=[cas=strength=0.8]', 'the respawn keeps 0.8')
})

test('V08: unsharp REFUSES vf-command, and the rebuild carries the NEW spec', async () => {
  const { chain, sent, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set(
    'video-enhance',
    'rl-sharpen',
    'lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.0]'
  )
  await tick()
  sent.length = 0

  const res = await chain.command(
    'video-enhance',
    'rl-sharpen',
    'luma_amount',
    '1.2',
    'unsharp',
    'lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.2]'
  )
  assert.equal(res.path, 'rebuild', 'unsharp is the only vf filter that refuses vf-command')
  assert.equal(sent[0]?.[0], 'vf')
  assert.equal(sent[0]?.[1], 'set')
  // Under the old code mpv received luma_amount=1.0 here: the rebuild
  // re-serialised the slot, and the slot still held the pre-change spec. V08 is
  // the one row the vf-chain pilot exists for.
  assert.equal(mpv.option('rl-sharpen', 'unsharp', 'luma_amount'), '1.2')
  assertAgrees(
    chain,
    mpv,
    '@rl-sharpen:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.2]',
    'the rebuild is the only way unsharp moves at all'
  )
})

test('af has its own order, and the boost/limiter is LAST', async () => {
  const { chain, mpv } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.claim('audio-volume', ['rlboost'])
  chain.claim('audio-channels', ['rlch'])
  chain.onFileLoaded()
  chain.set('audio-volume', 'rlboost', 'lavfi=[alimiter]')
  chain.set('audio-eq', 'rleq', 'lavfi=[superequalizer]')
  chain.set('audio-channels', 'rlch', 'lavfi=[pan]')
  await tick()
  assertAgrees(
    chain,
    mpv,
    '@rlch:lavfi=[pan],@rleq:lavfi=[superequalizer],@rlboost:lavfi=[alimiter]',
    'a limiter anywhere but the end is not a limiter (A06/A26)'
  )
})

test('an af refuser carries its new spec through the rebuild too', async () => {
  const { chain, sent, mpv } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.onFileLoaded()
  chain.set('audio-eq', 'rleq', 'lavfi=[superequalizer=1b=5]')
  await tick()
  sent.length = 0

  const res = await chain.command(
    'audio-eq',
    'rleq',
    '1b',
    '9',
    'superequalizer',
    'lavfi=[superequalizer=1b=9]'
  )
  assert.equal(res.path, 'rebuild')
  assert.equal(sent[0]?.[2], '@rleq:lavfi=[superequalizer=1b=9]')
  assertAgrees(chain, mpv, '@rleq:lavfi=[superequalizer=1b=9]', 'superequalizer refuses af-command')
})

test('A01: anequalizer change, eight channels, one post-change spec', async () => {
  // M12's real shape: `change` is not a named parameter of anequalizer, so the
  // spec is the only thing that can carry the new gain, and the chain held g=0
  // for the dragged band until this argument became required.
  const { chain, mpv } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.onFileLoaded()
  const flat = 'lavfi=[anequalizer=c0 f=500 w=350 g=0 t=0|c1 f=500 w=350 g=0 t=0]'
  const lifted = 'lavfi=[anequalizer=c0 f=500 w=350 g=9 t=0|c1 f=500 w=350 g=9 t=0]'
  chain.set('audio-eq', 'rleq', flat)
  await tick()

  for (const arg of ['0|f=500|w=350|g=9', '1|f=500|w=350|g=9']) {
    const res = await chain.command('audio-eq', 'rleq', 'change', arg, 'anequalizer', lifted)
    assert.equal(res.path, 'command', 'anequalizer implements process_command')
  }
  assertAgrees(chain, mpv, `@rleq:${lifted}`, 'the whole 10-band graph moved with the band')

  // And the revert that used to follow: any other slot changing rebuilds.
  chain.claim('audio-volume', ['rlboost'])
  chain.set('audio-volume', 'rlboost', 'lavfi=[alimiter]')
  await tick()
  assert.match(mpv.spec('rleq') ?? '', /g=9/, 'the lifted band survived a foreign rebuild')
})

test('a filter that unexpectedly refuses falls back, and still lands the new spec', async () => {
  // `cas` is NOT in the refuser table, so this exercises the catch path: the
  // exec rejects, the chain rebuilds, and the rebuild must carry the new value.
  const { chain, mpv } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  const logged: string[] = []
  const admin = createChain({
    kind: 'vf',
    order: VF_ORDER,
    refusers: [],
    log: (m) => logged.push(m)
  })
  admin.claim('video-enhance', ['rl-sharpen'])
  const svc = admin.serviceFor('video-enhance')
  const mpv2 = fakeMpv('vf', ['cas'])
  admin.attachExec({
    command: async (args: unknown[]) => {
      if (!mpv2.apply(args)) throw new Error('cas does not implement process_command')
      return undefined
    }
  })
  admin.onFileLoaded()
  svc.set('rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  const res = await svc.command('rl-sharpen', 'strength', '0.55', 'cas', 'lavfi=[cas=strength=0.55]')
  assert.equal(res.path, 'rebuild')
  assert.equal(mpv2.option('rl-sharpen', 'cas', 'strength'), '0.55')
  assert.equal(admin.serialise(), '@rl-sharpen:lavfi=[cas=strength=0.55]')
  assert.match(logged.join('\n'), /refused vf-command/)
  void mpv
})

// ---------------------------------------------------------------------------
// The guard: a five-argument call with a STALE spec is the same bug
// ---------------------------------------------------------------------------

test('a spec that does not express the change is refused, naming the tier', async () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()

  // The exact mistake a required argument does not stop by itself: passing the
  // spec you already had.
  await assert.rejects(
    () =>
      chain.command(
        'video-enhance',
        'rl-sharpen',
        'strength',
        '0.55',
        'cas',
        'lavfi=[cas=strength=0.4]'
      ),
    (e: Error) => {
      assert.match(e.message, /tier 1/)
      assert.match(e.message, /names 'strength' and sets it to '0\.4', not '0\.55'/)
      return true
    }
  )
  assert.equal(
    chain.serialise(),
    '@rl-sharpen:lavfi=[cas=strength=0.4]',
    'a refused command changes nothing at all'
  )
})

test('a non-string spec from an untyped caller is refused loudly, not silently', async () => {
  // The compiler stops `command(l, o, v, f)` now, but `any` gets past it, and a
  // silently-undefined spec is precisely the old behaviour.
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  const svc = chain.svc('video-enhance') as unknown as {
    command: (...a: unknown[]) => Promise<unknown>
  }
  await assert.rejects(
    () => svc.command('rl-sharpen', 'strength', '0.55', 'cas'),
    /spec.*required|is not a string/i
  )
})

test('specReflects grades each of the four production call shapes', () => {
  // Every one of these is the literal shape a shipped call site produces, and
  // the TIER is asserted so nobody has to trust that the guard is equally
  // strong everywhere. Tier 3 is weak on purpose and says so.
  assert.deepEqual(
    specReflects('lavfi=[cas=strength=0.55]', 'cas', 'strength', '0.55'),
    { ok: true, tier: 1 },
    'M03 sharpen (CAS): the spec names the option'
  )
  assert.deepEqual(
    specReflects(
      'lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.2:chroma_amount=0.0]',
      'unsharp',
      'luma_amount',
      '1.2'
    ),
    { ok: true, tier: 1 },
    'M03 sharpen (V08 unsharp)'
  )
  assert.deepEqual(
    specReflects(
      'lavfi=[volume=volume=-6dB:precision=float]',
      'volume',
      'volume',
      '-6dB'
    ),
    { ok: true, tier: 1 },
    "M12 preamp: the filter and its option share a name, and 'volume=volume=' must parse"
  )
  assert.deepEqual(
    specReflects(
      'lavfi=[anequalizer=c0 f=500 w=350 g=9 t=0|c1 f=500 w=350 g=9 t=0]',
      'anequalizer',
      'change',
      '0|f=500|w=350|g=9'
    ),
    { ok: true, tier: 2 },
    'M12 band: change is not a named option, so every k=v pair in the value is checked'
  )
  assert.deepEqual(
    specReflects('lavfi=[hqdn3d=5.5:3:6:4.5]', 'hqdn3d', 'luma_spatial', '5.5'),
    { ok: true, tier: 3 },
    'M03 denoise: hqdn3d is positional, so only a whole-token substring check is possible'
  )

  // …and each tier catches the stale spec it is responsible for.
  assert.equal(specReflects('lavfi=[cas=strength=0.4]', 'cas', 'strength', '0.55').ok, false)
  assert.equal(
    specReflects(
      'lavfi=[anequalizer=c0 f=500 w=350 g=0 t=0]',
      'anequalizer',
      'change',
      '0|f=500|w=350|g=9'
    ).ok,
    false,
    'tier 2 sees g=0 behind a g=9 command'
  )
  assert.equal(
    specReflects('lavfi=[hqdn3d=4:3:6:4.5]', 'hqdn3d', 'luma_spatial', '5.5').ok,
    false,
    'tier 3 sees a stale positional spec for every value but the one already there'
  )
  assert.equal(
    specReflects('lavfi=[cas=strength=0.55]', 'unsharp', 'luma_amount', '1.2').ok,
    false,
    'a spec for the wrong filter entirely'
  )
  // The boundary that makes tier 2 and 3 non-vacuous.
  assert.equal(
    specReflects('lavfi=[anequalizer=c0 f=5000 w=350 g=9 t=0]', 'anequalizer', 'change', '0|f=500').ok,
    false,
    "'f=500' must not match inside 'f=5000'"
  )
  assert.equal(
    specReflects('lavfi=[anequalizer=c0 f=500 w=350 g=9.5 t=0]', 'anequalizer', 'change', '0|g=9').ok,
    false,
    "'g=9' must not match inside 'g=9.5'"
  )
})

test('the spec parsers handle the wrapper, the graph and the positional case', () => {
  assert.equal(filterArgs('lavfi=[cas=strength=0.4]', 'cas'), 'strength=0.4')
  assert.equal(filterArgs('lavfi=[hqdn3d=4:3:6:4.5]', 'hqdn3d'), '4:3:6:4.5')
  assert.equal(filterArgs('lavfi=[format=yuv420p,cas=strength=0.4]', 'cas'), 'strength=0.4')
  assert.equal(filterArgs('lavfi=[hflip]', 'hflip'), '')
  assert.equal(filterArgs('lavfi=[cas=strength=0.4]', 'unsharp'), undefined)
  assert.equal(specOption('lavfi=[hqdn3d=4:3:6:4.5]', 'hqdn3d', 'luma_spatial'), undefined)
})

// ---------------------------------------------------------------------------
// The reads that replaced M03's shadow copy of the chain
// ---------------------------------------------------------------------------

test('has/isEnabled/specOf answer what chain-sync.ts used to shadow', async () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.claim('video-color', ['rl-levels'])
  chain.onFileLoaded()
  const m03 = chain.svc('video-enhance')

  assert.equal(m03.has('rl-sharpen'), false)
  assert.equal(m03.isEnabled('rl-sharpen'), false)
  assert.equal(m03.specOf('rl-sharpen'), undefined)

  m03.set('rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await tick()
  assert.equal(m03.has('rl-sharpen'), true)
  assert.equal(m03.isEnabled('rl-sharpen'), true)
  assert.equal(m03.specOf('rl-sharpen'), 'lavfi=[cas=strength=0.4]')

  m03.toggle('rl-sharpen', false)
  assert.equal(m03.has('rl-sharpen'), true, 'disable-in-place keeps the slot')
  assert.equal(m03.isEnabled('rl-sharpen'), false)
  assert.equal(m03.specOf('rl-sharpen'), 'lavfi=[cas=strength=0.4]', 'and keeps the settings')

  // specOf tracks a live command, which is the whole point.
  m03.toggle('rl-sharpen', true)
  await m03.command('rl-sharpen', 'strength', '0.7', 'cas', 'lavfi=[cas=strength=0.7]')
  assert.equal(m03.specOf('rl-sharpen'), 'lavfi=[cas=strength=0.7]')
})

test('the three reads are ownership-checked like every other label call', () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  const m01 = chain.svc('video-color')
  for (const call of [
    () => m01.has('rl-sharpen'),
    () => m01.isEnabled('rl-sharpen'),
    () => m01.specOf('rl-sharpen')
  ]) {
    assert.throws(call, /owned by 'video-enhance'/)
  }
})

test('hasCpuFilter reports whether any lavfi filter is live', () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  assert.equal(chain.hasCpuFilter, false)
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas]')
  assert.equal(chain.hasCpuFilter, true)
  chain.toggle('video-enhance', 'rl-sharpen', false)
  assert.equal(chain.hasCpuFilter, false, 'a disabled filter costs nothing')
})

// ---------------------------------------------------------------------------
// The compensating file is gone, and nothing may bring it back
// ---------------------------------------------------------------------------

test('no module keeps its own copy of the chain state any more', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..', '..', '..')
  const features = path.join(repo, 'src', 'main', 'features')

  assert.equal(
    fs.existsSync(path.join(features, 'video-enhance', 'chain-sync.ts')),
    false,
    'chain-sync.ts is back. It existed only to compensate for command() not tracking the ' +
      'live value; M03 carried 201 lines + 247 of test, and M01/M09/M13/M14 would each ' +
      'have copied it. The fix belongs in core/mpv/chain.ts.'
  )

  // A module holding `applied`/`desired` spec pairs is the same shadow copy
  // under a different name. This is a source scan and therefore weak — it can
  // only see the shape it knows — so it is a backstop for the deletion above,
  // not the argument.
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const src = fs.readFileSync(p, 'utf8')
        if (/\bapplied\s*:\s*string\s*\|\s*null\b/.test(src) && /\bdesired\b/.test(src)) {
          offenders.push(path.relative(repo, p))
        }
      }
    }
  }
  walk(features)
  assert.deepEqual(offenders, [], 'a module is keeping desired/applied specs again')
})
