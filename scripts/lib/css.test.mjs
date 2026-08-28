import test from 'node:test'
import assert from 'node:assert/strict'
import { rulesIn, selectorTokens, symbolsIn } from './css.mjs'

/**
 * The extractor `check-partition.mjs` rule 4 is built on.
 *
 * Every case below is here because the regex it replaced got it wrong, and the
 * first two are the exact violations that were planted in core `styles.css` and
 * reported clean with exit 0.
 */

const names = (set) => [...set].sort()

test('the FIRST rule inside an at-rule is extracted', () => {
  // HOLE 1. The old prelude regex was /(^|\}|;)([^{}]+)\{/ -- the prelude had to
  // follow `}`, `;` or start-of-file. After `@media (min-width: 1px) {` the
  // preceding character is `{`, so the first rule in every at-rule block was
  // invisible. `.bm-pin` planted there was reported clean.
  const css = `@media (min-width: 1px) {
    .bm-pin { color: red }
    .second { color: blue }
  }`
  assert.deepEqual(names(symbolsIn(css).all), ['class:bm-pin', 'class:second'])
  assert.deepEqual(names(symbolsIn(css).leftmost), ['class:bm-pin', 'class:second'])
})

test('at-rules nest, and every level is descended into', () => {
  const css = `@layer base { @supports (display: grid) { @media screen { .deep { color: red } } } }`
  assert.deepEqual(names(symbolsIn(css).all), ['class:deep'])
  assert.equal(rulesIn(css)[0].atRules.length, 3)
})

test('every token after a combinator is extracted, not just the leftmost', () => {
  // HOLE 2. `/[.#]([A-Za-z][A-Za-z0-9_-]*)/.exec(part)` returns the FIRST match
  // only, so a name that appears after a descendant combinator in a core
  // stylesheet had no way to be seen at all. `.seek-layer .thumb-preview`
  // planted in core styles.css was reported clean.
  const t = selectorTokens('.seek-layer .thumb-preview')
  assert.deepEqual(names(t.all), ['class:seek-layer', 'class:thumb-preview'])
  assert.deepEqual(names(t.leftmost), ['class:seek-layer'])
})

test('leftmost survives every combinator, and every comma part has one', () => {
  const t = selectorTokens('.a > .b, .c + .d ~ .e, .f.g .h')
  assert.deepEqual(names(t.leftmost), ['class:a', 'class:c', 'class:f', 'class:g'])
  assert.deepEqual(names(t.all), [
    'class:a',
    'class:b',
    'class:c',
    'class:d',
    'class:e',
    'class:f',
    'class:g',
    'class:h'
  ])
})

test('ids and classes are different symbols even when they share a word', () => {
  // `.seek` (core's slider class) and `#seek` (the element it is on) collapsing
  // into one key made whichever was scanned first shadow the other, silently and
  // in the direction that reports fewer problems.
  const t = selectorTokens('#seek.seek')
  assert.deepEqual(names(t.all), ['class:seek', 'id:seek'])
})

test('a pseudo-class argument belongs to the compound it qualifies', () => {
  const t = selectorTokens('.row:not(.hidden):is(.a, .b) .child')
  assert.deepEqual(names(t.leftmost), ['class:a', 'class:b', 'class:hidden', 'class:row'])
  assert.ok(t.all.has('class:child'))
})

test('attribute selectors and strings contribute nothing', () => {
  const t = selectorTokens('[data-x=".not-a-class"] .real, [href="#not-an-id"]')
  assert.deepEqual(names(t.all), ['class:real'])
})

test('a comment inside a selector does not become a name', () => {
  const t = selectorTokens('.a /* .commented-out */ .b')
  assert.deepEqual(names(t.all), ['class:a', 'class:b'])
})

test('hex colours in declarations are not selectors', () => {
  // The regex ran over the whole stylesheet text, so `color: #fff` and
  // `#e5484d` were candidate "ids". A parser never sees a declaration value.
  const css = '.x { color: #fff; border-color: #e5484d; background: url("#hash") }'
  assert.deepEqual(names(symbolsIn(css).all), ['class:x'])
})

test('@keyframes steps are not selectors', () => {
  const css = '@keyframes toast-in { from { opacity: 0 } to { opacity: 1 } }\n.z { color: red }'
  assert.deepEqual(names(symbolsIn(css).all), ['class:z'])
})

test('a rule after a declaration ending in `;` still works, and so does the first one', () => {
  // The old regex needed `}`, `;` or start-of-file before a prelude, which is
  // why it happened to work at the top level at all. Both shapes, explicitly.
  const css = '.first { color: red }\n.second { color: blue }'
  assert.deepEqual(names(symbolsIn(css).all), ['class:first', 'class:second'])
})

test('escaped characters in a class name are read as part of the name', () => {
  const t = selectorTokens('.w\\:full .a')
  assert.ok(t.all.has('class:w:full'))
  assert.ok(t.all.has('class:a'))
})

test('the two planted violations, side by side with what the old regex saw', () => {
  // Both of these were planted in core styles.css, referenced only from feature
  // modules, and `npm run check:partition` printed "clean" and exited 0.
  const css = `@media (min-width: 1px) {\n  .bm-pin { top: 0 }\n}\n.seek-layer .thumb-preview { top: 0 }`
  const old = (text) => {
    const out = new Set()
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\}|;)([^{}]+)\{/g)) {
      const prelude = (m[2] ?? '').trim()
      if (prelude.startsWith('@') || prelude.includes(':root')) continue
      for (const part of prelude.split(',')) {
        const first = /[.#]([A-Za-z][A-Za-z0-9_-]*)/.exec(part)
        if (first) out.add(`class:${first[1]}`)
      }
    }
    return out
  }
  const oldSaw = old(css)
  assert.equal(oldSaw.has('class:bm-pin'), false, 'the old regex would have caught the at-rule case')
  assert.equal(oldSaw.has('class:thumb-preview'), false, 'the old regex would have caught the combinator case')
  const now = symbolsIn(css).all
  assert.ok(now.has('class:bm-pin'))
  assert.ok(now.has('class:thumb-preview'))
})
