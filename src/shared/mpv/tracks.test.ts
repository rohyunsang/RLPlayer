import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RENUMBERING_COMMANDS,
  TRACK_SELECTION_PROPERTIES,
  describeIdentity,
  findByIdentity,
  identityOf,
  isTrackSelectionProperty,
  planReselection,
  type TrackLike
} from './tracks.ts'

/**
 * THE MEASURED LISTS. Bare mpv, `--sub-auto=fuzzy` (our own spawn arg), a real
 * CP949 `kor.smi` and a `kor_srt.srt` beside `kor.mp4`. `sub-reload` renumbers
 * AND reorders, and mpv re-selects the right file by itself.
 */
const BEFORE: TrackLike[] = [
  { id: 1, type: 'video', codec: 'h264' },
  { id: 1, type: 'audio', codec: 'aac', lang: 'und' },
  {
    id: 1,
    type: 'sub',
    external: true,
    selected: true,
    'external-filename': 'C:\\media\\kor.smi'
  },
  { id: 2, type: 'sub', external: true, 'external-filename': 'C:\\media\\kor_srt.srt' }
]

const AFTER: TrackLike[] = [
  { id: 1, type: 'video', codec: 'h264' },
  { id: 1, type: 'audio', codec: 'aac', lang: 'und' },
  { id: 2, type: 'sub', external: true, 'external-filename': 'C:\\media\\kor_srt.srt' },
  {
    id: 3,
    type: 'sub',
    external: true,
    selected: true,
    'external-filename': 'C:\\media\\kor.smi'
  }
]

const smiBefore = BEFORE.find((t) => t.type === 'sub' && t.id === 1)!

test('the captured index is WRONG after sub-reload — the defect, as an assertion', () => {
  // What the old code did: keep `sid` (1) and write it back. After the reload
  // there is no sub track 1 at all, which is why mpv answered "success" and
  // then held `sid=false`.
  const stale = 1
  assert.equal(
    AFTER.some((t) => t.type === 'sub' && t.id === stale),
    false,
    'if a sub track 1 still existed after the reload the defect would be invisible'
  )
})

test('an ORDINAL match would pick the WRONG subtitle, which is worse than losing it', () => {
  const id = identityOf(BEFORE, smiBefore)
  assert.equal(id.ordinal, 0, 'kor.smi was the first sub before the reload')
  const byOrdinal = AFTER.filter((t) => t.type === 'sub')[id.ordinal]
  assert.equal(
    byOrdinal!['external-filename'],
    'C:\\media\\kor_srt.srt',
    'the ordinal moved too: this is why the filename tier is first'
  )
})

test('findByIdentity re-finds kor.smi at its NEW id, by external filename', () => {
  const id = identityOf(BEFORE, smiBefore)
  const m = findByIdentity(AFTER, id)
  assert.ok(m, 'kor.smi must be found after the renumber')
  assert.equal(m.track.id, 3)
  assert.equal(m.tier, 'external-filename')
})

test('planReselection writes NOTHING when mpv already re-selected correctly', () => {
  const id = identityOf(BEFORE, smiBefore)
  // mpv's own post-reload selection: sid=3.
  const plan = planReselection(AFTER, id, 3)
  assert.deepEqual(plan, { kind: 'already', id: 3, tier: 'external-filename' })
})

test('planReselection writes the NEW id when mpv dropped the selection', () => {
  const id = identityOf(BEFORE, smiBefore)
  const plan = planReselection(AFTER, id, false)
  assert.deepEqual(plan, { kind: 'write', id: 3, tier: 'external-filename' })
})

test('an external track whose file is GONE is lost, never matched by ordinal', () => {
  const id = identityOf(BEFORE, smiBefore)
  const withoutSmi = AFTER.filter((t) => t['external-filename'] !== 'C:\\media\\kor.smi')
  const plan = planReselection(withoutSmi, id, false)
  assert.deepEqual(plan, { kind: 'lost' })
  // The dangerous alternative, spelled out: there IS a sub track in the list,
  // and an ordinal fallback would have selected it.
  assert.equal(withoutSmi.filter((t) => t.type === 'sub').length, 1)
})

test('path case and slash direction do not break the filename tier', () => {
  const id = identityOf(BEFORE, smiBefore)
  const shouty: TrackLike[] = [
    { id: 7, type: 'sub', external: true, 'external-filename': 'c:/MEDIA/KOR.SMI' }
  ]
  assert.equal(findByIdentity(shouty, id)?.track.id, 7)
})

test('embedded tracks fall back through title, lang and ordinal', () => {
  const before: TrackLike[] = [
    { id: 1, type: 'sub', title: '한국어', lang: 'kor' },
    { id: 2, type: 'sub', title: 'English', lang: 'eng' }
  ]
  const after: TrackLike[] = [
    { id: 4, type: 'sub', title: 'English', lang: 'eng' },
    { id: 5, type: 'sub', title: '한국어', lang: 'kor' }
  ]
  const id = identityOf(before, before[0]!)
  const m = findByIdentity(after, id)
  assert.equal(m?.track.id, 5)
  assert.equal(m?.tier, 'title+lang')
})

test('an untitled embedded track still resolves by lang', () => {
  const before: TrackLike[] = [
    { id: 1, type: 'audio', lang: 'jpn' },
    { id: 2, type: 'audio', lang: 'eng' }
  ]
  const after: TrackLike[] = [
    { id: 9, type: 'audio', lang: 'eng' },
    { id: 8, type: 'audio', lang: 'jpn' }
  ]
  const id = identityOf(before, before[0]!)
  assert.equal(findByIdentity(after, id)?.track.id, 8)
})

test('a completely anonymous track falls back to its ordinal, and says so', () => {
  const before: TrackLike[] = [
    { id: 1, type: 'audio' },
    { id: 2, type: 'audio' }
  ]
  const after: TrackLike[] = [
    { id: 3, type: 'audio' },
    { id: 4, type: 'audio' }
  ]
  const id = identityOf(before, before[1]!)
  const m = findByIdentity(after, id)
  assert.equal(m?.track.id, 4)
  assert.equal(m?.tier, 'ordinal')
})

test('the four index-holding properties, and the commands that renumber them', () => {
  assert.deepEqual([...TRACK_SELECTION_PROPERTIES], ['sid', 'aid', 'vid', 'secondary-sid'])
  for (const p of TRACK_SELECTION_PROPERTIES) assert.equal(isTrackSelectionProperty(p), true)
  assert.equal(isTrackSelectionProperty('sub-codepage'), false)
  // aid and vid have the same exposure as sid; their reload commands are listed.
  for (const c of ['sub-reload', 'audio-reload', 'video-reload', 'rescan-external-files']) {
    assert.ok(RENUMBERING_COMMANDS.includes(c), `${c} renumbers and must be listed`)
  }
})

test('describeIdentity names the file, because a log that says "#1" says nothing', () => {
  const id = identityOf(BEFORE, smiBefore)
  assert.match(describeIdentity(id), /kor\.smi/)
})
