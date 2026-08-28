import assert from 'node:assert/strict'
import test from 'node:test'
import { findSidecarArt, toFileUrl, type ArtDeps } from './art.ts'

/**
 * L29's sidecar cover-art lookup, with the directory reader injected so this
 * runs with no disk at all.
 */

const deps = (names: string[] | null): ArtDeps => ({
  readDir: () => names,
  join: (dir, name) => `${dir}\\${name}`
})

test('the file named after the media wins over a generic stem', () => {
  // mpv's own default `--cover-art-auto=exact` matches only `<basename>.jpg`
  // (L28), so that is the most specific candidate and it goes first.
  const hit = findSidecarArt('D:\\music\\Album\\track.flac', deps(['cover.jpg', 'track.jpg']))
  assert.equal(hit, 'D:\\music\\Album\\track.jpg')
})

test("L29's generic stems are matched in the row's own order", () => {
  assert.equal(
    findSidecarArt('D:\\a\\t.flac', deps(['thumb.jpg', 'folder.png', 'cover.webp'])),
    'D:\\a\\cover.webp'
  )
  assert.equal(findSidecarArt('D:\\a\\t.flac', deps(['thumb.png', 'front.png'])), 'D:\\a\\front.png')
})

test('extension order is stable, so the answer does not alternate across restarts', () => {
  // A folder with both `cover.jpg` and `cover.png` must resolve the same way
  // every time: an art panel that swaps images between launches reads as a bug,
  // and which of the two is "better" matters far less than the answer being
  // fixed.
  const both = ['cover.png', 'cover.jpg']
  assert.equal(findSidecarArt('D:\\a\\t.flac', deps(both)), 'D:\\a\\cover.jpg')
  assert.equal(findSidecarArt('D:\\a\\t.flac', deps([...both].reverse())), 'D:\\a\\cover.jpg')
})

test('matching is case-insensitive but the ORIGINAL casing is returned', () => {
  // NTFS is case-insensitive, but the comparison is explicit rather than
  // relying on it -- and the path handed back has to be the real one on disk,
  // or an `<img src>` built from it 404s on a case-sensitive share.
  assert.equal(findSidecarArt('D:\\a\\T.FLAC', deps(['AlbumArt.JPG'])), 'D:\\a\\AlbumArt.JPG')
  assert.equal(findSidecarArt('D:\\a\\Track.flac', deps(['TRACK.Png'])), 'D:\\a\\TRACK.Png')
})

test('no art, an unreadable directory and a bare filename all answer null', () => {
  assert.equal(findSidecarArt('D:\\a\\t.flac', deps(['notes.txt'])), null)
  assert.equal(findSidecarArt('D:\\a\\t.flac', deps(null)), null)
  assert.equal(findSidecarArt('t.flac', deps(['cover.jpg'])), null)
})

test('forward slashes work, because a URL-shaped path still has a directory', () => {
  assert.equal(findSidecarArt('D:/a/t.flac', deps(['cover.jpg'])), 'D:/a\\cover.jpg')
})

test('a file with no extension uses the whole name as the stem', () => {
  assert.equal(findSidecarArt('D:\\a\\track', deps(['track.jpg'])), 'D:\\a\\track.jpg')
})

test('an explicit basename overrides the one derived from the path', () => {
  assert.equal(
    findSidecarArt('D:\\a\\t.flac', deps(['album.jpg']), 'album'),
    'D:\\a\\album.jpg'
  )
})

test('the file URL escapes the two characters that actually break an <img src>', () => {
  // `#` truncates at the fragment and `?` at the query; a space merely looks
  // wrong. The drive letter's colon is left alone -- encoding it produces
  // `file:///D%3A/` which Chromium does not resolve.
  assert.equal(toFileUrl('D:\\a\\b.jpg'), 'file:///D:/a/b.jpg')
  assert.equal(toFileUrl('D:\\a b\\c.jpg'), 'file:///D:/a%20b/c.jpg')
  assert.equal(toFileUrl('D:\\a\\track #1.jpg'), 'file:///D:/a/track%20%231.jpg')
  assert.equal(toFileUrl('D:\\a\\q?.jpg'), 'file:///D:/a/q%3F.jpg')
  assert.equal(toFileUrl('D:\\한글\\커버.jpg'), 'file:///D:/%ED%95%9C%EA%B8%80/%EC%BB%A4%EB%B2%84.jpg')
})

test('a UNC path keeps both leading slashes collapsed into the URL host slot', () => {
  // Not a correctness claim about UNC URLs -- it is a guard that the function
  // produces SOMETHING parseable rather than `file:////\\`. A share path is
  // what a music library on a NAS actually looks like.
  const url = toFileUrl('\\\\nas\\music\\cover.jpg')
  assert.ok(url.startsWith('file:///'))
  assert.equal(url.includes('\\'), false)
  assert.ok(url.endsWith('/cover.jpg'))
})
