import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSettingRows, rowVisible, toRow } from './settings-rows.ts'
import type { SettingDescriptor, SettingId } from './feature-api.ts'

/**
 * `visibleWhen`, WHICH HAD NO TESTS AT ALL.
 *
 * `grep -rln visibleWhen src --include=*.test.ts` was EMPTY against a 395-test
 * suite. The feature landed in two shared files -- `src/main/ipc.ts:145-155` and
 * `src/renderer/src/core/settings-form.ts:311` -- and the only evidence it
 * worked was one hand-driven observation, "35 rows became 24". M03 shipped
 * fourteen descriptors that depend on it.
 *
 * It could not be tested where it was: both halves lived in files that import
 * Electron or touch the DOM. So the pure half moved to `src/shared`, which is
 * also the fix for `SettingRow` having been declared twice. What follows covers
 * the cases a hand-driven count cannot distinguish.
 */

function descriptor(over: Partial<SettingDescriptor> = {}): SettingDescriptor {
  return {
    id: 'video-enhance.sharpenStrength',
    section: 'video',
    labelKey: 'video-enhance.sharpenStrength',
    type: { kind: 'float', min: 0, max: 1, step: 0.05 },
    default: 0.4,
    ...over
  }
}

/** A settings bag, as `get` sees it. */
function reader(values: Record<string, unknown>): <V>(id: SettingId) => V {
  return <V,>(id: SettingId): V => values[id] as V
}

const t = (key: string): string => `T:${key}`

test('a descriptor with no visibleWhen is always visible', () => {
  assert.equal(rowVisible(descriptor(), reader({})), true)
  // …and the row carries no `visible` field at all, so a renderer that predates
  // the feature is unaffected and the IPC payload does not grow.
  const row = toRow(descriptor(), 0.4, t, true)
  assert.equal('visible' in row, false)
})

test('a predicate deciding false marks the row, and only with the literal false', () => {
  const shown = descriptor({ visibleWhen: (get) => get<boolean>('video-enhance.sharpen') })
  assert.equal(rowVisible(shown, reader({ 'video-enhance.sharpen': true })), true)
  assert.equal(rowVisible(shown, reader({ 'video-enhance.sharpen': false })), false)
  assert.equal(
    rowVisible(shown, reader({})),
    true,
    'a `get` of a setting that is not defined yet returns undefined, and undefined is not ' +
      'false. Module load order decides whether the reader runs before the writer, and a row ' +
      'the user cannot reach is worse than one they did not expect.'
  )
  assert.equal(rowVisible(descriptor({ visibleWhen: () => 0 as never }), reader({})), true)
  assert.equal(rowVisible(descriptor({ visibleWhen: () => '' as never }), reader({})), true)
  assert.equal(rowVisible(descriptor({ visibleWhen: () => null as never }), reader({})), true)
})

test('a predicate that THROWS shows the row, and says so once', () => {
  // §3.5 rule 7. One module's bad predicate must not blank a page every other
  // module also renders into, and the safe direction is to show.
  const errors: string[] = []
  const original = console.error
  console.error = (...a: unknown[]) => errors.push(a.join(' '))
  try {
    const bad = descriptor({
      id: 'video-enhance.boom',
      visibleWhen: () => {
        throw new Error('nope')
      }
    })
    assert.equal(rowVisible(bad, reader({})), true)
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /video-enhance\.boom/)
  assert.match(errors[0] ?? '', /nope/)
})

test("M03's fourteen descriptors, as the settings window receives them", () => {
  // The real chain from `video-enhance/index.ts`: a master toggle, a mode enum
  // that appears only when the toggle is on, and two pairs of sliders that
  // appear only for their own mode. This is the "35 rows -> 24" observation,
  // written down as an assertion instead of a number in a commit message.
  const rows: SettingDescriptor[] = [
    descriptor({ id: 'video-enhance.sharpen', type: { kind: 'bool' }, default: false }),
    descriptor({
      id: 'video-enhance.sharpenMode',
      type: { kind: 'enum', options: [{ value: 'cas', labelKey: 'a' }] },
      default: 'cas',
      visibleWhen: (get) => get<boolean>('video-enhance.sharpen')
    }),
    descriptor({
      id: 'video-enhance.sharpenStrength',
      visibleWhen: (get) =>
        get<boolean>('video-enhance.sharpen') &&
        get<string>('video-enhance.sharpenMode') === 'cas'
    }),
    descriptor({
      id: 'video-enhance.sharpenLuma',
      visibleWhen: (get) =>
        get<boolean>('video-enhance.sharpen') &&
        get<string>('video-enhance.sharpenMode') === 'unsharp'
    })
  ]
  const snapshot = (values: Record<string, unknown>) =>
    rows.map((d) => ({ descriptor: d, value: values[d.id] ?? d.default }))
  const visibleIds = (values: Record<string, unknown>): string[] =>
    buildSettingRows(snapshot(values), reader(values), t)
      .filter((r) => r.visible !== false)
      .map((r) => r.id)

  assert.deepEqual(
    visibleIds({ 'video-enhance.sharpen': false, 'video-enhance.sharpenMode': 'cas' }),
    ['video-enhance.sharpen'],
    'sharpen off: only the master toggle'
  )
  assert.deepEqual(
    visibleIds({ 'video-enhance.sharpen': true, 'video-enhance.sharpenMode': 'cas' }),
    ['video-enhance.sharpen', 'video-enhance.sharpenMode', 'video-enhance.sharpenStrength'],
    'CAS: strength, not the unsharp pair'
  )
  assert.deepEqual(
    visibleIds({ 'video-enhance.sharpen': true, 'video-enhance.sharpenMode': 'unsharp' }),
    ['video-enhance.sharpen', 'video-enhance.sharpenMode', 'video-enhance.sharpenLuma'],
    'unsharp: the luma slider, not CAS strength'
  )
})

test('the predicate sees the LIVE value, not the default', () => {
  // The bug this rules out: evaluating against `descriptor.default` instead of
  // the store would make every dependent row visible on a fresh profile and
  // never change again, which is indistinguishable from "it works" if you only
  // ever count rows once.
  const d = descriptor({
    id: 'a.child',
    visibleWhen: (get) => get<boolean>('a.parent')
  })
  const parent = descriptor({ id: 'a.parent', type: { kind: 'bool' }, default: true })
  const values = { 'a.parent': false }
  const built = buildSettingRows(
    [
      { descriptor: parent, value: values['a.parent'] },
      { descriptor: d, value: 0 }
    ],
    reader(values),
    t
  )
  assert.equal(built[1]?.visible, false, 'the default is true and the live value is false')
})

test('toRow omits absent optional fields rather than sending undefined', () => {
  const row = toRow(descriptor(), 0.4, t)
  assert.deepEqual(Object.keys(row).sort(), [
    'default',
    'id',
    'label',
    'section',
    'type',
    'value'
  ])
  const full = toRow(
    descriptor({
      group: 'enhance',
      descriptionKey: 'video-enhance.sharpenDesc',
      mpvOption: 'sharpen',
      requiresRestart: true,
      advanced: true,
      order: 112,
      keywords: ['선명']
    }),
    0.4,
    t,
    false
  )
  assert.equal(full.description, 'T:video-enhance.sharpenDesc')
  assert.equal(full.group, 'enhance')
  assert.equal(full.visible, false)
})

test('labels are resolved in MAIN, so the settings window never sees a key', () => {
  const row = toRow(descriptor({ labelKey: 'x.y' }), 1, (k) => (k === 'x.y' ? '선명화 강도' : k))
  assert.equal(row.label, '선명화 강도')
})

// ---------------------------------------------------------------------------
// The other half of the defect: nothing checked that the two ends agreed
// ---------------------------------------------------------------------------

test('SettingRow is declared exactly ONCE in the tree', () => {
  // It was declared in `src/main/ipc.ts` and again in
  // `src/renderer/src/core/settings-form.ts`. Both compiled, neither knew about
  // the other, and `visible?: boolean` had to be added to both by hand.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..')
  const declarations: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      const src = fs.readFileSync(full, 'utf8')
      if (/^\s*(?:export\s+)?interface SettingRow\b/m.test(src)) {
        declarations.push(path.relative(repo, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(repo, 'src'))
  assert.deepEqual(
    declarations,
    ['src/shared/settings-rows.ts'],
    'a wire type declared in more than one place is two types that happen to agree today'
  )
})
