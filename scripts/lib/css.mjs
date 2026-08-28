/**
 * A real CSS reader for `check-partition.mjs`, replacing a regex that could not
 * see most of the repo's own stylesheets.
 *
 * WHAT THE REGEX MISSED, measured against this repo's four stylesheets rather
 * than argued about. The extractor was:
 *
 *     for (const m of css.matchAll(/(^|\}|;)([^{}]+)\{/g)) {
 *       const prelude = m[2].trim()
 *       if (prelude.startsWith('@') || prelude.includes(':root')) continue
 *       for (const part of prelude.split(',')) {
 *         const first = /[.#]([A-Za-z][A-Za-z0-9_-]*)/.exec(part)   // LEFTMOST only
 *         if (first) names.add(first[1])
 *       }
 *     }
 *
 * and it had two independent holes:
 *
 *   1. THE FIRST RULE INSIDE ANY AT-RULE IS INVISIBLE. The prelude has to be
 *      preceded by `}`, `;` or start-of-file. After `@media (min-width: 1px) {`
 *      the preceding character is `{`, so the first rule in the block never
 *      matches. `@media`, `@supports`, `@container`, `@layer`: every one of
 *      them hides its first rule, and a planted `.bm-pin` inside one was
 *      reported clean with exit 0.
 *
 *   2. ONLY THE LEFTMOST TOKEN OF EACH COMMA PART IS TAKEN. `.seek-layer
 *      .thumb-preview` in a core stylesheet defines `.thumb-preview` and the
 *      extractor saw only `seek-layer`, so a feature's private class sitting in
 *      a file 40 of the 55 module rows are told not to touch was invisible by
 *      construction.
 *
 * Instrumented against the repo's own CSS, 15 selector tokens were already
 * unextractable, 7 of them in core `styles.css`: boosted, close, error, play,
 * primary, show, small. Every one of them is a name a Wave-1 module could
 * legitimately want, and none of them had a canary.
 *
 * So: `postcss` walks the rules -- it is a real parser, it descends into every
 * at-rule, and it is not this repo's job to reimplement it -- and the selector
 * tokenizer below is a state machine over ONE selector string. The tokenizer is
 * the part worth reading, because it is the part that has to be right:
 *
 *   - `,` at depth 0 separates the parts a selector list is made of;
 *   - a run of whitespace, `>`, `+` or `~` at depth 0 ends a COMPOUND, which is
 *     what "leftmost" means and the only reason the distinction survives;
 *   - `(` `)` nest (`:not(.a)`, `:is(.a, .b)`) and do NOT end a compound;
 *   - `[` `]` are skipped whole, so `[data-x=".not-a-class"]` contributes
 *     nothing;
 *   - quoted strings are skipped, backslash escapes are honoured, and `/ * ... * /`
 *     inside a selector is a comment.
 *
 * Both views come back, because the rules above it need different ones:
 *
 *   `all`      -- every class and id anywhere in the selector. A core stylesheet
 *                 mentioning a name AT ALL is what rule 4a asks about.
 *   `leftmost` -- the first compound of each part only. `.pl-tools .icon-btn` in
 *                 the playlist's own stylesheet is a module styling a core
 *                 component INSIDE its own subtree, which is what a shared
 *                 component is for; rules 4b and 4c would be noise without this.
 */
import postcss from 'postcss'

/** At-rules whose children are not selectors. `from`/`to`/`50%` are not classes. */
const NOT_SELECTORS = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-feature-values'])

const isIdentStart = (c) => /[A-Za-z_-]/.test(c)
const isIdentChar = (c) => /[A-Za-z0-9_-]/.test(c)

/**
 * Every class and id in one selector string, split into `all` and `leftmost`.
 *
 * `leftmost` is per comma part: `.a .b, .c .d` has two leftmost compounds,
 * `a` and `c`. Pseudo-class arguments (`:not(.x)`) belong to the compound they
 * qualify, so `.a:not(.x)` is leftmost `{a, x}` -- both name the subject.
 */
export function selectorTokens(selector) {
  const all = new Set()
  const leftmost = new Set()

  let i = 0
  const n = selector.length
  // Which compound of the current comma part we are in; 0 is the leftmost.
  let compound = 0
  let compoundHasContent = false
  let depth = 0

  const startNewPart = () => {
    compound = 0
    compoundHasContent = false
  }
  const endCompound = () => {
    if (compoundHasContent) {
      compound += 1
      compoundHasContent = false
    }
  }

  while (i < n) {
    const c = selector[i]

    // comments
    if (c === '/' && selector[i + 1] === '*') {
      const end = selector.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    // strings
    if (c === '"' || c === "'") {
      i += 1
      while (i < n) {
        if (selector[i] === '\\') i += 2
        else if (selector[i] === c) {
          i += 1
          break
        } else i += 1
      }
      compoundHasContent = true
      continue
    }
    // attribute selectors, skipped whole
    if (c === '[') {
      let d = 1
      i += 1
      while (i < n && d > 0) {
        const a = selector[i]
        if (a === '\\') {
          i += 2
          continue
        }
        if (a === '"' || a === "'") {
          i += 1
          while (i < n) {
            if (selector[i] === '\\') i += 2
            else if (selector[i] === a) {
              i += 1
              break
            } else i += 1
          }
          continue
        }
        if (a === '[') d += 1
        else if (a === ']') d -= 1
        i += 1
      }
      compoundHasContent = true
      continue
    }
    if (c === '(') {
      depth += 1
      i += 1
      continue
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (c === ',' && depth === 0) {
      startNewPart()
      i += 1
      continue
    }
    if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f')) {
      endCompound()
      i += 1
      continue
    }
    if (depth === 0 && (c === '>' || c === '+' || c === '~')) {
      // `~=` only appears inside `[...]`, which never reaches here.
      endCompound()
      i += 1
      continue
    }
    if (c === '.' || c === '#') {
      let j = i + 1
      // A leading escape (`.\.foo`) is legal; treat the escaped char as ident.
      if (selector[j] === '\\') j += 2
      else if (!isIdentStart(selector[j] ?? '')) {
        // `#` starting a hex-looking token cannot occur in a valid selector,
        // and `.5` is not one either. Skip the sigil rather than invent a name.
        i += 1
        compoundHasContent = true
        continue
      }
      let name = ''
      while (j < n) {
        if (selector[j] === '\\') {
          name += selector[j + 1] ?? ''
          j += 2
          continue
        }
        if (!isIdentChar(selector[j])) break
        name += selector[j]
        j += 1
      }
      if (name !== '') {
        const kind = c === '.' ? 'class' : 'id'
        all.add(`${kind}:${name}`)
        if (compound === 0) leftmost.add(`${kind}:${name}`)
      }
      compoundHasContent = true
      i = j
      continue
    }
    if (c === '\\') {
      i += 2
      compoundHasContent = true
      continue
    }
    compoundHasContent = true
    i += 1
  }

  return { all, leftmost }
}

/**
 * Every rule in a stylesheet, at-rules descended into, with the at-rule path it
 * sits under. `postcss` throws on genuinely broken CSS: that is a failure worth
 * having, because a stylesheet this cannot read is one it also cannot check.
 */
export function rulesIn(cssText, from = '<css>') {
  const root = postcss.parse(cssText, { from })
  const out = []
  root.walkRules((rule) => {
    const path = []
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') path.unshift(`@${p.name} ${p.params}`.trim())
    }
    const skipped = path.some((a) => NOT_SELECTORS.has(a.slice(1).split(/\s/)[0]))
    if (skipped) return
    out.push({ selector: rule.selector, atRules: path })
  })
  return out
}

/**
 * The class and id symbols a stylesheet defines, as `'class:name'` /
 * `'id:name'` keys, in both views. This is the function `check-partition.mjs`
 * calls; everything above it exists so that this one cannot quietly stop
 * matching.
 */
export function symbolsIn(cssText, from = '<css>') {
  const all = new Set()
  const leftmost = new Set()
  for (const { selector } of rulesIn(cssText, from)) {
    const t = selectorTokens(selector)
    for (const k of t.all) all.add(k)
    for (const k of t.leftmost) leftmost.add(k)
  }
  return { all, leftmost }
}
