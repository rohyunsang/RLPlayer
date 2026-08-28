import test from 'node:test'
import assert from 'node:assert/strict'
import { AF_ORDER, AF_REFUSERS, VF_ORDER, VF_REFUSERS, createChain, type ChainAdmin } from './chain.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * test:chains (§6.2): "vf/af ordering policy, label replacement,
 * disable-in-place, queueing before file-loaded, unregistered-label rejection."
 */

/**
 * The chain is driven the way production drives it: through the ADMIN object
 * `createChain()` returns, and through one `serviceFor(id)` facade per module.
 * The `FilterChain` instance is not exported and not reachable — which is the
 * fix for `vfChain.exec.command(['vf','set','hflip'])` — so a test that reached
 * for it would be testing a shape production no longer has.
 */
function makeChain(kind: 'vf' | 'af' = 'vf'): {
  chain: ChainAdmin & { set: Setter; remove: Remover; toggle: Toggler; command: Commander }
  sent: unknown[][]
} {
  const sent: unknown[][] = []
  const admin = createChain({
    kind,
    order: kind === 'vf' ? VF_ORDER : AF_ORDER,
    refusers: kind === 'vf' ? VF_REFUSERS : AF_REFUSERS
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
    set: (owner: string, label: string, spec: string) => svc(owner).set(label, spec),
    remove: (owner: string, label: string) => svc(owner).remove(label),
    toggle: (owner: string, label: string, on: boolean) => svc(owner).toggle(label, on),
    command: (
      owner: string,
      label: string,
      opt: string,
      value: string,
      filter: string,
      spec?: string
    ) => svc(owner).command(label, opt, value, filter, spec)
  }
  // The exec is attached rather than constructed in: only core/mpv/bus can
  // hand out a raw vf/af command, and a test stands in for it here.
  chain.attachExec({
    command: async (args: unknown[]) => {
      sent.push(args)
      return undefined
    }
  })
  return { chain, sent }
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
  /** The spec the slot should hold after the change; see FilterChainService. */
  spec?: string
) => Promise<{ path: 'command' | 'rebuild' }>

test('the chain object hands out no path back to its own state', () => {
  const { chain } = makeChain()
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
  void chain
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
  assert.throws(() => chain.claim('video-scaler', ['rl-sharpen']), (e: Error) => {
    assert.match(e.message, /video-enhance/)
    assert.match(e.message, /video-scaler/)
    return true
  })
})

test('a module may not touch a label it does not own', () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  assert.throws(() => chain.set('video-hdr', 'rl-sharpen', 'lavfi=[cas]'), /owned by 'video-enhance'/)
})

test('changes before file-loaded are QUEUED, not sent', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  assert.equal(sent.length, 0, 'mpv cannot validate a filter before the first frame')

  chain.onFileLoaded()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], ['vf', 'set', '@rl-sharpen:lavfi=[cas=strength=0.4]'])
})

test('the chain is emitted in POLICY order, not registration order', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-geometry', ['rl-hflip', 'rl-rotate'])
  chain.claim('video-enhance', ['rl-sharpen', 'rl-denoise'])
  chain.claim('video-deinterlace', ['rl-deint'])
  chain.onFileLoaded()

  // Registered deliberately backwards.
  chain.set('video-geometry', 'rl-hflip', 'lavfi=[hflip]')
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas]')
  chain.set('video-enhance', 'rl-denoise', 'lavfi=[hqdn3d]')
  chain.set('video-deinterlace', 'rl-deint', 'lavfi=[yadif]')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(
    chain.serialise(),
    '@rl-deint:lavfi=[yadif],@rl-denoise:lavfi=[hqdn3d],@rl-sharpen:lavfi=[cas],@rl-hflip:lavfi=[hflip]',
    'deint -> denoise -> sharpen -> hflip, whatever order they arrived in'
  )
  assert.ok(sent.length > 0)
})

test('toggling off disables IN PLACE so the settings survive', async () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  chain.toggle('video-enhance', 'rl-sharpen', false)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(chain.serialise(), '@rl-sharpen:!lavfi=[cas=strength=0.4]')
  chain.toggle('video-enhance', 'rl-sharpen', true)
  assert.equal(chain.serialise(), '@rl-sharpen:lavfi=[cas=strength=0.4]')
})

test('setting an existing label REPLACES it rather than appending', async () => {
  const { chain } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.2]')
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.9]')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(chain.serialise(), '@rl-sharpen:lavfi=[cas=strength=0.9]')
})

test('command() emits the VERIFIED FOUR-ARGUMENT form', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await new Promise((r) => setTimeout(r, 0))
  sent.length = 0

  const res = await chain.command('video-enhance', 'rl-sharpen', 'strength', '0.55', 'cas')
  assert.equal(res.path, 'command')
  assert.deepEqual(
    sent[0],
    ['vf-command', 'rl-sharpen', 'strength', '0.55', 'cas'],
    'the last argument is the lavfi FILTER NAME, not the label and not "all"'
  )
})

test('a measured refuser rebuilds instead, and says so', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[unsharp=5:5:1.0]')
  await new Promise((r) => setTimeout(r, 0))
  sent.length = 0

  const res = await chain.command('video-enhance', 'rl-sharpen', 'luma_amount', '1.2', 'unsharp')
  assert.equal(res.path, 'rebuild', 'unsharp is the only vf filter that refuses vf-command')
  assert.equal(sent[0]?.[0], 'vf')
  assert.equal(sent[0]?.[1], 'set')
})

test('af has its own order, and the boost/limiter is LAST', async () => {
  const { chain } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.claim('audio-volume', ['rlboost'])
  chain.claim('audio-channels', ['rlch'])
  chain.onFileLoaded()
  chain.set('audio-volume', 'rlboost', 'lavfi=[alimiter]')
  chain.set('audio-eq', 'rleq', 'lavfi=[superequalizer]')
  chain.set('audio-channels', 'rlch', 'lavfi=[pan]')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(
    chain.serialise(),
    '@rlch:lavfi=[pan],@rleq:lavfi=[superequalizer],@rlboost:lavfi=[alimiter]'
  )
})

test('af refusers are the measured three', async () => {
  const { chain } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.onFileLoaded()
  chain.set('audio-eq', 'rleq', 'lavfi=[superequalizer]')
  await new Promise((r) => setTimeout(r, 0))
  const res = await chain.command('audio-eq', 'rleq', '1b', '5', 'superequalizer')
  assert.equal(res.path, 'rebuild')
  const ok = await chain.command('audio-eq', 'rleq', 'volume', '1.5', 'volume')
  assert.equal(ok.path, 'command')
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

/**
 * The two tests above assert WHICH PATH `command()` took and stop there, and
 * that is exactly how this shipped broken: the path was right and the result
 * was wrong on both branches. These assert the chain string mpv would receive.
 */
test('a rebuild carries the NEW spec, not the one the slot already held', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[unsharp=5:5:1.0]')
  await new Promise((r) => setTimeout(r, 0))
  sent.length = 0

  const res = await chain.command(
    'video-enhance',
    'rl-sharpen',
    'luma_amount',
    '1.2',
    'unsharp',
    'lavfi=[unsharp=5:5:1.2]'
  )
  assert.equal(res.path, 'rebuild')
  assert.equal(
    sent[0]?.[2],
    '@rl-sharpen:lavfi=[unsharp=5:5:1.2]',
    'unsharp is the ONE vf refuser and V08 is the one row the pilot exists for; ' +
      'without the spec this rebuild re-sent 1.0 and the slider did nothing'
  )
  assert.equal(chain.serialise(), '@rl-sharpen:lavfi=[unsharp=5:5:1.2]')
})

test('after a LIVE command the slot agrees with mpv, so the next rebuild does not revert it', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.claim('video-color', ['rl-levels'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await new Promise((r) => setTimeout(r, 0))

  await chain.command(
    'video-enhance',
    'rl-sharpen',
    'strength',
    '0.55',
    'cas',
    'lavfi=[cas=strength=0.55]'
  )
  sent.length = 0

  // ANOTHER module touching its own slot rebuilds the whole chain. That is the
  // moment the live value used to disappear -- and nothing in the module that
  // owns rl-sharpen is even running at the time.
  chain.set('video-color', 'rl-levels', 'lavfi=[eq=contrast=1.1]')
  await new Promise((r) => setTimeout(r, 0))
  assert.match(
    String(sent[0]?.[2]),
    /@rl-sharpen:lavfi=\[cas=strength=0\.55\]/,
    'a foreign module’s set() must not roll back a live vf-command'
  )
})

test('an af refuser carries its new spec too (pan/loudnorm/superequalizer)', async () => {
  const { chain, sent } = makeChain('af')
  chain.claim('audio-eq', ['rleq'])
  chain.onFileLoaded()
  chain.set('audio-eq', 'rleq', 'lavfi=[superequalizer=1b=5]')
  await new Promise((r) => setTimeout(r, 0))
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
})

test('omitting the spec still works, so existing three-argument callers are unbroken', async () => {
  const { chain, sent } = makeChain()
  chain.claim('video-enhance', ['rl-sharpen'])
  chain.onFileLoaded()
  chain.set('video-enhance', 'rl-sharpen', 'lavfi=[cas=strength=0.4]')
  await new Promise((r) => setTimeout(r, 0))
  sent.length = 0
  const res = await chain.command('video-enhance', 'rl-sharpen', 'strength', '0.55', 'cas')
  assert.equal(res.path, 'command')
  assert.deepEqual(sent[0], ['vf-command', 'rl-sharpen', 'strength', '0.55', 'cas'])
})
