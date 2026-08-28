import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTtml, parseTtmlTime, ttmlTextToPlain } from './ttml.ts'
import { ttmlDocument, HELLO_KO } from './fixtures.ts'

/**
 * S07. FFmpeg has a TTML muxer and NO demuxer, so either this converter is right
 * or the file does not play at all — there is no engine behaviour to fall back
 * on and nothing to compare against.
 *
 * `parseTtmlTime` returning null must mean "no cue". A time expression this
 * parser does not understand, silently read as 0, is a subtitle stuck at the
 * start of the film — which is the shape of failure this whole module exists to
 * prevent, so the null path is asserted as hard as the success path.
 */

test('clock-time, with and without fractions and frames', () => {
  assert.equal(parseTtmlTime('00:00:01.000', 1, 30), 1000)
  assert.equal(parseTtmlTime('01:02:03', 1, 30), 3723000)
  assert.equal(parseTtmlTime('00:00:01,500', 1, 30), 1500)
  assert.equal(parseTtmlTime('00:00:01:15', 1, 30), 1500)
})

test('offset-time in every unit the row names', () => {
  assert.equal(parseTtmlTime('123.4s', 1, 30), 123400)
  assert.equal(parseTtmlTime('500ms', 1, 30), 500)
  assert.equal(parseTtmlTime('3.5m', 1, 30), 210000)
  assert.equal(parseTtmlTime('1h', 1, 30), 3600000)
  assert.equal(parseTtmlTime('12f', 1, 24), 500)
  assert.equal(parseTtmlTime('3000t', 1000, 30), 3000)
  // tickRate is the whole point of `t`: the same number is a different time.
  assert.equal(parseTtmlTime('3000t', 1, 30), 3000000)
})

test('an unparseable time is null and never zero', () => {
  for (const bad of [undefined, '', '  ', 'soon', '1:2:3', '00:99:00', '5x', '1..2s']) {
    assert.equal(parseTtmlTime(bad, 1, 30), null, JSON.stringify(bad))
  }
  assert.equal(parseTtmlTime('12f', 1, 0), null, 'frames with no frame rate is unknowable')
  assert.equal(parseTtmlTime('3000t', 0, 30), null, 'ticks with no tick rate is unknowable')
})

test('the document is grouped by xml:lang, inherited from <div>', () => {
  const doc = parseTtml(ttmlDocument())
  assert.deepEqual(doc.langs, ['ko', 'en'])
  assert.equal(doc.tickRate, 1000)
  assert.deepEqual(
    doc.cues.filter((c) => c.lang === 'ko').map((c) => [c.startMs, c.endMs, c.text]),
    [
      [1000, 3500, HELLO_KO],
      [4000, 6000, '두\n번째'],
      [7000, 9000, '세 번째']
    ]
  )
  assert.deepEqual(
    doc.cues.filter((c) => c.lang === 'en').map((c) => c.text),
    ['Hello']
  )
})

test('a namespace prefix on the elements and attributes changes nothing', () => {
  const doc = parseTtml(
    [
      '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xml:lang="ko">',
      '<tt:body><tt:div>',
      '<tt:p tt:begin="1s" tt:end="2s">가</tt:p>',
      '</tt:div></tt:body></tt:tt>'
    ].join('\n')
  )
  assert.deepEqual(
    doc.cues.map((c) => [c.startMs, c.endMs, c.text, c.lang]),
    [[1000, 2000, '가', 'ko']]
  )
})

test('a <p> with no usable begin is dropped, not placed at zero', () => {
  const doc = parseTtml(
    ['<tt xml:lang="ko"><body><div>', '<p end="2s">언제?</p>', '</div></body></tt>'].join('\n')
  )
  assert.deepEqual(doc.cues, [])
})

test('inline markup is stripped and <br/> is a line break', () => {
  assert.equal(ttmlTextToPlain('a<br/>b'), 'a\nb')
  assert.equal(ttmlTextToPlain('<span tts:color="red">가</span>나'), '가나')
  assert.equal(ttmlTextToPlain('  a   b  '), 'a b')
  assert.equal(ttmlTextToPlain('&amp;lt'), '&lt')
})
