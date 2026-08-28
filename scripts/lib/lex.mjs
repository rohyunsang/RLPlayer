/**
 * A comment- and string-aware lexer for the grep-shaped guarantees.
 *
 * WHY THIS EXISTS. `check-forbidden.mjs` iterated `text.split(/\r?\n/)` and
 * tested each line on its own. Three escalations were measured walking straight
 * past it, and all three resolved at runtime to the same `core/mpv/vf-chain`
 * singleton:
 *
 *     await import(
 *       '../../core/mpv/vf-chain.ts'
 *     )
 *     createRequire(import.meta.url)('../../core/mpv/vf-chain.ts')
 *     await import(
 *       head + tail
 *     )
 *
 * No single LINE of any of them matches a rule, because the specifier and the
 * `import(` are on different lines. A line is not a unit of syntax; the file is.
 *
 * The other half of the same bug points the other way. The line scanner skipped
 * a line whose FIRST non-space characters were `//`, `*` or `/*`, so a rule
 * could not fire on prose — but it also could not fire on `const x = 1 // …`'s
 * code half, and it happily fired on the second line of a multi-line string.
 * Getting comments right needs the same state machine as getting multi-line
 * matches right.
 *
 * This is a lexer, not a parser, and the distinction is worth stating plainly:
 * it tracks exactly the four states that matter — code, line comment, block
 * comment, string (single, double, template) — plus regex literals, which have
 * to be recognised or a `/` inside one starts a phantom comment. It does not
 * build a syntax tree, and it does not need to: every rule here asks "does this
 * text appear in code" or "does this text appear in a string literal", and both
 * are lexical questions.
 *
 * Two views come back, both the same length as the input so an index maps to a
 * line number in either:
 *
 *   `code`  — comments blanked, string CONTENTS kept. Import specifiers are
 *             strings, so this is the view the module-path rules run on.
 *   `bare`  — comments AND string contents blanked. Identifier rules run here,
 *             so `'the default-apps fetch'` and `"npm run fetch:mpv"` are prose
 *             rather than violations.
 */

const NL = '\n'

/** True when a `/` at `i` starts a regex literal rather than a division. */
function regexAllowedBefore(text, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j]
    if (c === ' ' || c === '\t' || c === '\r' || c === NL) continue
    if ('([{,;:=!&|?+-*%~^<>'.includes(c)) return true
    // `return /re/`, `typeof /re/`, `case /re/` — a word boundary before the
    // slash is a division only after an identifier, and these are keywords.
    const word = /[A-Za-z0-9_$]/.test(c)
    if (!word) return c === ')' ? false : true
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--
    const ident = text.slice(k + 1, j + 1)
    return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await'].includes(ident)
  }
  return true
}

/**
 * @param {string} text
 * @returns {{ code: string, bare: string, lineAt: (i: number) => number }}
 */
export function lex(text) {
  const code = new Array(text.length)
  const bare = new Array(text.length)
  const keep = (i) => {
    code[i] = text[i]
    bare[i] = text[i]
  }
  /** Blank a character, but never a newline: line numbers must survive. */
  const blankBoth = (i) => {
    const c = text[i] === NL ? NL : ' '
    code[i] = c
    bare[i] = c
  }
  const blankBareOnly = (i) => {
    code[i] = text[i]
    bare[i] = text[i] === NL ? NL : ' '
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== NL) blankBoth(i++)
      continue
    }
    if (c === '/' && next === '*') {
      blankBoth(i++)
      blankBoth(i++)
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) blankBoth(i++)
      if (i < text.length) {
        blankBoth(i++)
        blankBoth(i++)
      }
      continue
    }
    // HTML comments, for the .html files this also scans.
    if (c === '<' && text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i)
      const stop = end < 0 ? text.length : end + 3
      while (i < stop) blankBoth(i++)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      keep(i++) // the opening quote stays in both views
      while (i < text.length) {
        if (text[i] === '\\') {
          blankBareOnly(i++)
          if (i < text.length) blankBareOnly(i++)
          continue
        }
        if (text[i] === c) break
        // A template literal may run over many lines; a single- or double-quoted
        // string may not, and an unterminated one would otherwise eat the file.
        if (c !== '`' && text[i] === NL) break
        blankBareOnly(i++)
      }
      if (i < text.length) keep(i++)
      continue
    }
    if (c === '/' && regexAllowedBefore(text, i)) {
      const start = i
      let j = i + 1
      let ok = false
      let inClass = false
      while (j < text.length && text[j] !== NL) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) {
          ok = true
          break
        }
        j++
      }
      if (ok) {
        // A regex literal is CODE in both views: `/core\/mpv/` is a rule, not a
        // module path, and blanking it would hide a rule that greps for one.
        while (i <= j) keep(i++)
        while (i < text.length && /[dgimsuvy]/.test(text[i])) keep(i++)
        continue
      }
      i = start
    }
    keep(i++)
  }

  const lineStarts = [0]
  for (let k = 0; k < text.length; k++) if (text[k] === NL) lineStarts.push(k + 1)
  const lineAt = (idx) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  return { code: code.join(''), bare: bare.join(''), lineAt }
}
