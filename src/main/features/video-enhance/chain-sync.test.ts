import test from 'node:test'
import assert from 'node:assert/strict'
import { createSlotSync, type SlotSync } from './chain-sync.ts'

/**
 * A stand-in for `ctx.vf` that behaves the way `core/mpv/chain.ts` was measured
 * to behave, including the part this module exists to work around: for a
 * refusing filter, `command()` returns `{path:'rebuild'}` after re-applying the
 * chain from the spec the SLOT already holds. It does not carry the new value.
 */
function fakeChain(refusers: readonly string[] = []) {
  const calls: string[] = []
  const slots = new Map<string, { spec: string; enabled: boolean }>()
  /** What mpv would be showing: the enabled slots' specs, in insertion order. */
  const rendered = (): string =>
    [...slots]
      .filter(([, s]) => s.enabled)
      .map(([label, s]) => `@${label}:${s.spec}`)
      .join(',')

  return {
    calls,
    slots,
    rendered,
    vf: {
      set(label: string, spec: string): void {
        calls.push(`set ${label} ${spec}`)
        const prev = slots.get(label)
        slots.set(label, { spec, enabled: prev?.enabled ?? true })
      },
      toggle(label: string, enabled: boolean): void {
        calls.push(`toggle ${label} ${enabled}`)
        const slot = slots.get(label)
        if (slot) slot.enabled = enabled
      },
      remove(label: string): void {
        calls.push(`remove ${label}`)
        slots.delete(label)
      },
      async command(
        label: string,
        option: string,
        value: string,
        filter: string
      ): Promise<{ path: 'command' | 'rebuild' }> {
        calls.push(`command ${label} ${option} ${value} ${filter}`)
        if (refusers.includes(filter)) {
          // The measured behaviour: a whole-chain re-apply of the OLD specs.
          calls.push(`rebuild ${rendered()}`)
          return { path: 'rebuild' }
        }
        const slot = slots.get(label)
        if (slot) slot.spec = slot.spec.replace(new RegExp(`${option}=[^:\\]]+`), `${option}=${value}`)
        return { path: 'command' }
      }
    }
  }
}

/** A scheduler the test drives by hand, so nothing sleeps. */
function manualClock() {
  let pending: (() => void) | null = null
  return {
    schedule: (fn: () => void): unknown => {
      pending = fn
      return 1
    },
    cancel: (): void => {
      pending = null
    },
    tick(): void {
      const fn = pending
      pending = null
      fn?.()
    },
    get armed(): boolean {
      return pending !== null
    }
  }
}

function subject(refusers: readonly string[] = []): {
  chain: ReturnType<typeof fakeChain>
  clock: ReturnType<typeof manualClock>
  sync: SlotSync
} {
  const chain = fakeChain(refusers)
  const clock = manualClock()
  const sync = createSlotSync({ vf: chain.vf, schedule: clock.schedule, cancel: clock.cancel })
  return { chain, clock, sync }
}

const CAS_04 = 'lavfi=[cas=strength=0.4]'
const CAS_055 = 'lavfi=[cas=strength=0.55]'
const cas = (value: string): [{ option: string; value: string; filter: string }] => [
  { option: 'strength', value, filter: 'cas' }
]

test('the first update creates the slot with set(), never with a command', () => {
  const { chain, sync } = subject()
  return sync.update('rl-sharpen', CAS_04, cas('0.4')).then((path) => {
    assert.equal(path, 'set')
    assert.deepEqual(chain.calls, ['set rl-sharpen ' + CAS_04, 'toggle rl-sharpen true'])
    assert.equal(chain.rendered(), '@rl-sharpen:' + CAS_04)
  })
})

test('a live-capable filter takes the four-argument command, not a rebuild', async () => {
  const { chain, clock, sync } = subject()
  await sync.update('rl-sharpen', CAS_04, cas('0.4'))
  chain.calls.length = 0

  assert.equal(await sync.update('rl-sharpen', CAS_055, cas('0.55')), 'command')
  assert.deepEqual(chain.calls, ['command rl-sharpen strength 0.55 cas'])
  assert.equal(chain.rendered(), '@rl-sharpen:' + CAS_055)

  // …and the chain's own copy of the spec is made authoritative once the drag
  // stops, so the next whole-chain rebuild does not revert the live value.
  assert.deepEqual(sync.pendingLabels(), ['rl-sharpen'])
  clock.tick()
  assert.deepEqual(chain.calls, ['command rl-sharpen strength 0.55 cas', 'set rl-sharpen ' + CAS_055])
  assert.equal(sync.appliedSpec('rl-sharpen'), CAS_055)
})

test('a drag is one rebuild, not one per tick', async () => {
  const { chain, clock, sync } = subject()
  await sync.update('rl-sharpen', CAS_04, cas('0.4'))
  chain.calls.length = 0
  for (const v of ['0.45', '0.5', '0.55', '0.6']) {
    await sync.update('rl-sharpen', `lavfi=[cas=strength=${v}]`, cas(v))
  }
  clock.tick()
  assert.equal(chain.calls.filter((c) => c.startsWith('set ')).length, 1)
  assert.equal(chain.calls.filter((c) => c.startsWith('command ')).length, 4)
  assert.equal(chain.rendered(), '@rl-sharpen:lavfi=[cas=strength=0.6]')
})

/**
 * THE V08 REGRESSION, and the reason this file exists.
 *
 * §5 says `command()` "transparently rebuilds for the refusers … so you can
 * choose commit-on-release without hardcoding the table". Taken literally that
 * is a no-op slider: the rebuild re-emits the spec the slot already holds,
 * which is the value from BEFORE the change. Follow it and `unsharp`'s luma
 * slider moves in the UI and nothing happens on screen.
 */
test('a refusing filter still ends up showing the NEW value', async () => {
  const { chain, sync } = subject(['unsharp'])
  const before = 'lavfi=[unsharp=luma_amount=1.0]'
  const after = 'lavfi=[unsharp=luma_amount=1.4]'
  await sync.update('rl-sharpen', before)
  chain.calls.length = 0

  const path = await sync.update('rl-sharpen', after, [
    { option: 'luma_amount', value: '1.4', filter: 'unsharp' }
  ])
  assert.equal(path, 'rebuild')
  // The chain's own rebuild used the OLD spec; the set() after it is what makes
  // the change real.
  assert.deepEqual(chain.calls, [
    'command rl-sharpen luma_amount 1.4 unsharp',
    'rebuild @rl-sharpen:' + before,
    'set rl-sharpen ' + after
  ])
  assert.equal(chain.rendered(), '@rl-sharpen:' + after)
})

test('a filter that refused once is never sent a command again', async () => {
  const { chain, sync } = subject(['unsharp'])
  await sync.update('rl-sharpen', 'lavfi=[unsharp=luma_amount=1.0]')
  await sync.update('rl-sharpen', 'lavfi=[unsharp=luma_amount=1.4]', [
    { option: 'luma_amount', value: '1.4', filter: 'unsharp' }
  ])
  assert.equal(sync.refuses('unsharp'), true)
  chain.calls.length = 0

  const path = await sync.update('rl-sharpen', 'lavfi=[unsharp=luma_amount=1.8]', [
    { option: 'luma_amount', value: '1.8', filter: 'unsharp' }
  ])
  assert.equal(path, 'set')
  assert.deepEqual(chain.calls, ['set rl-sharpen lavfi=[unsharp=luma_amount=1.8]'])
})

test('disabling is in place, and re-enabling does not re-send an unchanged spec', async () => {
  const { chain, sync } = subject()
  await sync.update('rl-denoise', 'lavfi=[hqdn3d=4:3:6:4.5]')
  chain.calls.length = 0

  sync.disable('rl-denoise')
  assert.deepEqual(chain.calls, ['toggle rl-denoise false'])
  assert.equal(chain.rendered(), '', 'the slot is disabled, not removed')
  assert.equal(chain.slots.get('rl-denoise')?.spec, 'lavfi=[hqdn3d=4:3:6:4.5]', 'settings survive')

  chain.calls.length = 0
  assert.equal(await sync.update('rl-denoise', 'lavfi=[hqdn3d=4:3:6:4.5]'), 'set')
  assert.deepEqual(chain.calls, ['toggle rl-denoise true'])
  assert.equal(chain.rendered(), '@rl-denoise:lavfi=[hqdn3d=4:3:6:4.5]')
})

test('disabling a slot that was never created touches nothing', () => {
  const { chain, sync } = subject()
  sync.disable('rl-sharpen')
  assert.deepEqual(chain.calls, [])
})

test('a spec change while disabled lands before the slot comes back on', async () => {
  const { chain, sync } = subject()
  await sync.update('rl-denoise', 'lavfi=[hqdn3d=4:3:6:4.5]')
  sync.disable('rl-denoise')
  chain.calls.length = 0

  await sync.update('rl-denoise', 'lavfi=[hqdn3d=2:2:6:4.5]')
  assert.deepEqual(chain.calls, [
    'set rl-denoise lavfi=[hqdn3d=2:2:6:4.5]',
    'toggle rl-denoise true'
  ])
  assert.equal(chain.rendered(), '@rl-denoise:lavfi=[hqdn3d=2:2:6:4.5]')
})

test('re-applying the same spec is a no-op, not another chain rebuild', async () => {
  const { chain, sync } = subject()
  await sync.update('rl-sharpen', CAS_04, cas('0.4'))
  chain.calls.length = 0
  assert.equal(await sync.update('rl-sharpen', CAS_04, cas('0.4')), 'noop')
  assert.deepEqual(chain.calls, [])
})

test('flush() lands a pending sync early — a new file rebuilds from the slots', async () => {
  const { chain, clock, sync } = subject()
  await sync.update('rl-sharpen', CAS_04, cas('0.4'))
  await sync.update('rl-sharpen', CAS_055, cas('0.55'))
  chain.calls.length = 0

  sync.flush()
  assert.deepEqual(chain.calls, ['set rl-sharpen ' + CAS_055])
  assert.equal(clock.armed, false, 'the debounce timer is cancelled, not left to fire twice')
  assert.deepEqual(sync.pendingLabels(), [])
})

test('dispose() leaves no timer behind', async () => {
  const { clock, sync } = subject()
  await sync.update('rl-sharpen', CAS_04, cas('0.4'))
  await sync.update('rl-sharpen', CAS_055, cas('0.55'))
  assert.equal(clock.armed, true)
  sync.dispose()
  assert.equal(clock.armed, false)
})
