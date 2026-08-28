import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArgContributions } from './reserved.ts'
import { OwnerMap } from './ownership.ts'

/**
 * §4's fourth rule: "An option follows its property's owner."
 *
 * It was written in the module author's guide and implemented nowhere.
 * `validateArgContributions` checked core-reserved names, the wid-inert list
 * and duplicates, and nothing else — so a module could set any property it
 * liked, before the first frame, simply by contributing the spawn arg for it.
 *
 * The concrete case, from the audit: M05 (video-hdr, V33) and M06
 * (video-scaler, V36) both declare `requestsProperties: ['d3d11-output-format']`
 * — a property M07 owns. It is spawn-scoped, so both would have contributed
 * `--d3d11-output-format`, and the app would have HARD-REFUSED TO BOOT on the
 * duplicate check the day the second of them landed. Each module is correct in
 * isolation, which is exactly why review would not have caught it.
 */

const M07 = new OwnerMap([
  {
    id: 'video-decode',
    ownsProperties: ['hwdec', 'vo', 'd3d11-output-format', 'd3d11-output-csp', 'd3d11-*']
  },
  { id: 'video-hdr', ownsProperties: ['tone-mapping'], requestsProperties: ['d3d11-output-format'] },
  { id: 'video-scaler', ownsProperties: ['dither', 'scale'] },
  { id: 'core/vf-chain', ownsProperties: ['vf'] }
])

const ownerOf = (p: string): string | null => M07.ownerOf(p)

test('a module may not contribute an option whose property it does not own', () => {
  assert.throws(
    () =>
      validateArgContributions(
        [{ ownerId: 'video-hdr', priority: 10, args: ['--d3d11-output-format=rgba16f'] }],
        ownerOf
      ),
    (e: Error) => {
      assert.match(e.message, /video-hdr/)
      assert.match(e.message, /video-decode/)
      assert.match(e.message, /d3d11-output-format/)
      assert.match(e.message, /requestSet/)
      return true
    }
  )
})

test('the V33 / V36 case fails at the FIRST module, not the second', () => {
  // This is the whole point. Under the old rules M05 alone was fine and M06
  // alone was fine, and the pair was a boot failure -- so the bill fell on
  // whoever merged second, weeks later, with no clue why. Now either one fails
  // on its own, at its own boot, with M07 named.
  for (const id of ['video-hdr', 'video-scaler']) {
    assert.throws(
      () =>
        validateArgContributions(
          [{ ownerId: id, priority: 10, args: ['--d3d11-output-format=rgb10_a2'] }],
          ownerOf
        ),
      /owned by 'video-decode'/,
      `${id} should have been refused on its own`
    )
  }
})

test('the owner itself may contribute its own option', () => {
  assert.doesNotThrow(() =>
    validateArgContributions(
      [
        {
          ownerId: 'video-decode',
          priority: 10,
          args: ['--hwdec=auto-safe', '--d3d11-output-format=rgba16f']
        }
      ],
      ownerOf
    )
  )
})

test('an option nobody owns a property for is still allowed', () => {
  // The rule is "follows its owner", not "must have an owner". Plenty of mpv
  // options have no property at all.
  assert.doesNotThrow(() =>
    validateArgContributions(
      [{ ownerId: 'subs-tracks', priority: 10, args: ['--sub-auto=fuzzy'] }],
      ownerOf
    )
  )
})

test('mpv negation is resolved before the owner is looked up', () => {
  // `--no-hwdec` is the `hwdec` property.
  assert.throws(
    () =>
      validateArgContributions(
        [{ ownerId: 'video-hdr', priority: 10, args: ['--no-hwdec'] }],
        ownerOf
      ),
    /owned by 'video-decode'/
  )
})

test('an aliased option follows the property it actually writes', () => {
  // `--vf-append` is on the additive allowlist, so the duplicate rule lets two
  // contributors through -- but it still writes `vf`, which the chain owns, and
  // two modules appending to the chain behind the chain's back is precisely the
  // silent mutual destruction §0.2 rule 5 exists to stop. The owner check runs
  // BEFORE the additive exemption for that reason.
  assert.throws(
    () =>
      validateArgContributions(
        [{ ownerId: 'video-hdr', priority: 10, args: ['--vf-append=lavfi=[null]'] }],
        ownerOf
      ),
    /owned by 'core\/vf-chain'/
  )
})

test('core is exempt, because core composes the base argv', () => {
  assert.doesNotThrow(() =>
    validateArgContributions(
      [{ ownerId: 'core/mpv/bus', priority: 0, args: ['--vo=gpu-next', '--hwdec=auto-safe'] }],
      ownerOf
    )
  )
})

test('without an owner map the other three rules still hold', () => {
  // The lookup is optional so this suite can isolate the rules; the bus always
  // passes it.
  assert.throws(
    () =>
      validateArgContributions([
        { ownerId: 'video-hdr', priority: 10, args: ['--d3d11-output-format=rgba16f'] },
        { ownerId: 'video-scaler', priority: 10, args: ['--d3d11-output-format=rgb10_a2'] }
      ]),
    /spawn-arg collision/
  )
})
