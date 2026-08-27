import test from 'node:test'
import assert from 'node:assert/strict'
import {
  finishedThreshold,
  shouldOffer,
  shouldRemember,
  MIN_RESUME_SECONDS
} from './resume-rules.ts'

const MINUTE = 60
const HOUR = 3600

test('a brief accidental open is not remembered', () => {
  assert.equal(shouldRemember(5, HOUR), false)
  assert.equal(shouldRemember(59, HOUR), false)
  // Exactly at the threshold counts as watched.
  assert.equal(shouldRemember(MIN_RESUME_SECONDS, HOUR), true)
})

test('a position in the middle of a film is remembered', () => {
  assert.equal(shouldRemember(45 * MINUTE, 2 * HOUR), true)
  assert.equal(shouldRemember(3 * MINUTE, 10 * MINUTE), true)
})

test('a finished film is forgotten, so it restarts next time', () => {
  // 2h film: 5% is 6 minutes, which beats the 90s floor.
  const twoHours = 2 * HOUR
  assert.equal(finishedThreshold(twoHours), twoHours - 6 * MINUTE)
  assert.equal(shouldRemember(twoHours - 7 * MINUTE, twoHours), true)
  assert.equal(shouldRemember(twoHours - 5 * MINUTE, twoHours), false)
  assert.equal(shouldRemember(twoHours, twoHours), false)
})

test('short files use the 90s floor rather than a tiny percentage', () => {
  // A 10-minute episode: 5% is only 30s, so the 90s floor must win, otherwise
  // the last minute of an episode would be stored as "resume here".
  const tenMin = 10 * MINUTE
  assert.equal(finishedThreshold(tenMin), tenMin - 90)
  assert.equal(shouldRemember(tenMin - 100, tenMin), true)
  assert.equal(shouldRemember(tenMin - 80, tenMin), false)
})

test('long films use the 5% margin rather than the 90s floor', () => {
  // A 3-hour film: 5% is 9 minutes, comfortably past the floor.
  const threeHours = 3 * HOUR
  assert.equal(finishedThreshold(threeHours), threeHours - 9 * MINUTE)
  assert.equal(shouldRemember(threeHours - 10 * MINUTE, threeHours), true)
  assert.equal(shouldRemember(threeHours - 8 * MINUTE, threeHours), false)
})

test('nonsense input never gets stored', () => {
  assert.equal(shouldRemember(NaN, HOUR), false)
  assert.equal(shouldRemember(120, NaN), false)
  assert.equal(shouldRemember(120, 0), false)
  assert.equal(shouldRemember(-5, HOUR), false)
  assert.equal(shouldRemember(Infinity, HOUR), false)
})

test('a stored position is only offered back if it is far enough in', () => {
  assert.equal(shouldOffer(10), false)
  assert.equal(shouldOffer(MIN_RESUME_SECONDS), true)
  assert.equal(shouldOffer(45 * MINUTE), true)
  assert.equal(shouldOffer(NaN), false)
})
