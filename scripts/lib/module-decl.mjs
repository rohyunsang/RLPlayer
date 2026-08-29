/**
 * A module's OWN declarations — `ownsProperties`, `ownsCommands`,
 * `ownsFilterLabels`, `dependsOn`, `requestsProperties` — read from the AST of
 * whatever file actually default-exports the `FeatureModule`.
 *
 * WHY THIS REPLACED A REGEX. `src/main/core/mpv/ownership.test.ts` compares
 * every implemented module's declarations against `docs/parity/modules.json` in
 * both directions, and that test is the ONLY thing standing between a module and
 * a self-granted property claim: `OwnerMap` is built from CODE
 * (`registry.ts:126`), so `assertWrite('stream-open', 'demuxer-lavf-format')`
 * returns **true** the moment the module lists it, whatever the manifest says.
 * Measured — planting it in M35's array turns that test red, which is the check
 * working.
 *
 * It read the declarations like this:
 *
 *     const m = new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`).exec(src)
 *     return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])
 *
 * which is comment-aware (the whole file is stripped first — a real fix for a
 * real defect) and still blind three ways, each of which makes the test report
 * agreement it did not check:
 *
 *   1. A NON-LITERAL ARRAY. `ownsProperties: [...forbiddenPropertyNames(), 'cache']`
 *      captures only the quoted names; the spread is invisible, so a module can
 *      claim any number of properties the manifest never sees. Both directions
 *      of the test pass. Verified by planting exactly that on M35.
 *   2. NO ARRAY AT ALL. `ownsProperties: KNOWN` matches nothing, `exec` returns
 *      null, the helper returns `[]` — and for any row whose manifest list is
 *      also empty, both directions pass vacuously while the module owns
 *      whatever `KNOWN` holds.
 *   3. THE WRONG FILE. It reads `<dir>/index.ts` only. M22 and M23 already split
 *      a `manifest.ts` out of `index.ts` (because they import `electron`
 *      directly and `index.ts` is therefore unloadable by a test), and the next
 *      module that moves its `FeatureModule` literal out of `index.ts` is read
 *      as declaring nothing.
 *
 * So: parse, resolve the default export, read the properties, and — the part
 * that matters — REPORT anything that cannot be read statically instead of
 * returning an empty list. A claim this reader cannot see is a failure of the
 * reader, exactly as an unreadable `mustNotTouch` entry is a failure of
 * `check-ownership.mjs`.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const DECL_FIELDS = [
  'ownsProperties',
  'ownsCommands',
  'ownsFilterLabels',
  'dependsOn',
  'requestsProperties'
]

function stringOf(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

/** The object literal a file default-exports, directly or through a const. */
function defaultExportedObject(src) {
  let assigned = null
  for (const stmt of src.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      let e = stmt.expression
      while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
      if (ts.isObjectLiteralExpression(e)) return e
      if (ts.isIdentifier(e)) assigned = e.text
    }
  }
  if (assigned === null) return null
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== assigned || !d.initializer) continue
      let init = d.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) return init
    }
  }
  return null
}

/**
 * Read one module directory.
 *
 * @returns `{ id, file, fields, unreadable }` — `fields` maps each declaration
 * field to the string list it holds; `unreadable` lists the ones whose value is
 * not a static array of string literals, WITH the source text, so the caller
 * fails loudly rather than treating them as absent. `null` when the directory
 * has no default-exported module object (a reserved slot).
 */
export function readModuleDeclaration(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => e.name)
    // index.ts first, then the rest, so the common case is one parse.
    .sort((a, b) => (a === 'index.ts' ? -1 : b === 'index.ts' ? 1 : a.localeCompare(b)))

  for (const name of files) {
    const file = path.join(dir, name)
    const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const obj = defaultExportedObject(src)
    if (!obj) continue
    /** @type {Record<string, string[]>} */
    const fields = {}
    const unreadable = []
    let id = null
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null
      if (key === 'id') {
        id = stringOf(p.initializer)
        continue
      }
      if (!DECL_FIELDS.includes(key)) continue
      let init = p.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (!ts.isArrayLiteralExpression(init)) {
        unreadable.push({ field: key, text: init.getText(src), why: 'not an array literal' })
        continue
      }
      const out = []
      let bad = null
      for (const el of init.elements) {
        const s = stringOf(el)
        if (s === null) {
          bad = el.getText(src)
          break
        }
        out.push(s)
      }
      if (bad !== null) {
        unreadable.push({
          field: key,
          text: bad,
          why: 'an element that is not a string literal (a spread, a call or a variable)'
        })
        continue
      }
      fields[key] = out
    }
    // A module object must at least carry its own id; anything else with a
    // default export (a helper, a spec table) is not the module.
    if (id === null) continue
    return { id, file, fields, unreadable }
  }
  return null
}

/** Every implemented module directory under `src/main/features`. */
export function moduleDirs(repo) {
  const base = path.join(repo, 'src', 'main', 'features')
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(base, name, 'index.ts')))
    .sort()
}
