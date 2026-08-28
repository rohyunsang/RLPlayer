/**
 * The ORDERING PARTITION: the seven cross-module `order` namespaces, read out of
 * the code with the TypeScript AST and cross-checked against
 * `docs/parity/modules.json` in both directions.
 *
 * WHY THIS FILE EXISTS. Every other cross-module namespace in this repository is
 * partitioned in the manifest — `ownedFiles`, `ownedProperties`, `ownedCommands`,
 * `ownedFilterLabels` — so a second claimant is a MANIFEST CONFLICT that
 * `npm test` reports by name. Ordering had no partition key at all, and yet a
 * duplicate `order` is strictly worse than a duplicate property: `claimSlot()` in
 * `src/renderer/src/core/feature-host.ts` and `MenuRegistry.contribute()` THROW,
 * the throw is a ContributionError, and a ContributionError out of a module's
 * setup is re-thrown by the registry — the app does not start. It collided twice
 * in one nine-module round (seek-bar layers at 10, menu sections at 45).
 *
 * WHY THE CHECK THAT EXISTED DID NOT SEE IT. `feature-host.test.ts`'s "the
 * shipped contributions hold distinct orders in every namespace" paired `id:` to
 * `order:` with a regex and a 400/600-character window:
 *
 *     /ctx\.panel\(\{\s*\n?\s*id:\s*'([^']+)'[\s\S]{0,400}?order:\s*(\d+)/g
 *
 * Three independent ways for that to report clean on a real duplicate, all three
 * live in the delivered tree:
 *
 *   1. THE WINDOW. Two of M25's own contributions sit further than 400 characters
 *      from their `id:` — `nav-chapters.skipPrompt` (a transport button at 60,
 *      `src/renderer/src/features/nav-chapters/index.ts:283`) and
 *      `nav-chapters.skipBands` (a seek-bar layer at 15, :225) — because M25
 *      added an 11-line comment between the two keys to document the collision
 *      this very test had caught. The test was blinded by the note about itself.
 *   2. THE KEY ORDER. `order:` before `id:` never matches at all.
 *   3. THE VALUE. `order: MENU_ORDER` is not `(\d+)`. M22 contributes at a named
 *      constant, and that contribution was invisible.
 *
 * Measured: putting `stream-open.toggle`'s duplicate back (`order: 50` on
 * `nav-chapters.skipPrompt`) gave `npm test` 1143 pass / 0 fail while the runtime
 * host threw `duplicate transport button order 50`.
 *
 * So this reader does not scan text. It parses each file with `typescript`'s own
 * parser and walks the AST, which makes a comment structurally incapable of
 * separating two properties of one object literal, and resolves an `order:` that
 * is a named constant — in the same file or imported from a sibling — to its
 * number.
 *
 * `scripts/lib/lex.mjs` (the repo's comment/string lexer) is the right tool for
 * "does this token appear in code"; it is the wrong tool for "which object
 * literal is this property in", which is a syntax question. `typescript` is
 * already a devDependency and `tsc` already parses every one of these files.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * THE SEVEN NAMESPACES.
 *
 * `unique: true` means the runtime REJECTS a tie and the app does not boot, so a
 * tie here is a build-breaking manifest conflict. `unique: false` is a BAND:
 * spawn-arg priority is shared by eight modules on purpose and the bus makes
 * ties deterministic by owner id instead of rejecting them (`core/mpv/bus.ts`),
 * so what the partition buys there is that a module cannot move between bands
 * unnoticed — which decides whose `--sub-codepage` wins.
 *
 * `scope` narrows the namespace where the runtime narrows it: two settings
 * sections may share an order in different pages, and two menu sections may
 * share one under different parents, because neither pair is ever sorted against
 * the other.
 *
 * THE EIGHTH CANDIDATE, DELIBERATELY EXCLUDED: `ctx.settings.define()`'s
 * `order?`. `SettingsRegistry` already sorts by `(order, id)`, so a tie is
 * deterministic without coordination and nothing throws. It is named here rather
 * than silently omitted, because "which namespaces is this check blind to" must
 * be answerable from this file.
 */
export const NAMESPACES = [
  {
    ns: 'panel',
    /** How it is called in a module. Matched on the AST, not on text. */
    call: 'panel',
    unique: true,
    scopeKey: null,
    host: 'claimSlot() in src/renderer/src/core/feature-host.ts',
    what: 'a docked side panel'
  },
  {
    ns: 'transportButton',
    call: 'transportButton',
    unique: true,
    scopeKey: null,
    host: 'claimSlot() in src/renderer/src/core/feature-host.ts',
    what: "a control in the transport bar's button row"
  },
  {
    ns: 'statsSection',
    call: 'statsSection',
    unique: true,
    scopeKey: null,
    host: 'claimSlot() in src/renderer/src/core/feature-host.ts',
    what: 'a block in the stats overlay'
  },
  {
    ns: 'settingsSection',
    call: 'settingsSection',
    unique: true,
    scopeKey: 'section',
    host: 'claimSlot() in src/renderer/src/core/feature-host.ts',
    what: 'prose or an action inside one settings page'
  },
  {
    ns: 'seekbarLayer',
    call: 'seekbarLayer',
    unique: true,
    scopeKey: null,
    host: 'SeekbarHost.register() in src/renderer/src/core/seekbar-host.ts',
    what: 'a painted, hit-tested seek-bar layer'
  },
  {
    ns: 'menuSection',
    call: 'menu.contribute',
    unique: true,
    scopeKey: 'parent',
    host: 'MenuRegistry.contribute() in src/main/core/menu.ts',
    what: 'a section of the contributed native menu'
  },
  {
    ns: 'spawnArgPriority',
    call: 'mpv.contributeArgs',
    /** A BAND. Eight modules share 10 by design; the bus breaks ties by owner id. */
    unique: false,
    positional: true,
    scopeKey: null,
    host: 'MpvBus.contributeArgs() in src/main/core/mpv/bus.ts',
    what: 'the priority band an mpv spawn-argument contribution is applied in'
  }
]

export const NAMESPACE_IDS = NAMESPACES.map((n) => n.ns)
const BY_NS = new Map(NAMESPACES.map((n) => [n.ns, n]))

// ---------------------------------------------------------------------------
// The AST reader
// ---------------------------------------------------------------------------

/** Every `.ts` file under `dir`, excluding declaration files. */
function walkTs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkTs(full, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/**
 * Module-level `const NAME = <number>` in one file, so `order: MENU_ORDER`
 * resolves. Also picks up `export const`, which is how M22 declares its own.
 */
function numericConsts(src) {
  const out = new Map()
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue
      const v = literalNumber(d.initializer)
      if (v !== null) out.set(d.name.text, v)
    }
  }
  return out
}

/** A numeric literal, or a negated one. Nothing else — a computed order is a bug. */
function literalNumber(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text)
  }
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalNumber(node.expression)
  }
  return null
}

function stringLiteral(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text
  }
  return null
}

/** Resolve a relative import specifier to a file on disk. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const cand of [base, base.replace(/\.ts$/, '') + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

/** `{ imported name -> file }` for every relative import in a file. */
function importSources(src, file) {
  const out = new Map()
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    const spec = stringLiteral(stmt.moduleSpecifier)
    if (!spec) continue
    const target = resolveImport(file, spec)
    if (!target) continue
    const named = stmt.importClause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) out.set(el.name.text, target)
    }
  }
  return out
}

/**
 * Read every ordering claim out of one source file.
 *
 * A claim is a call whose callee ENDS in one of the seven names and whose
 * argument shape carries an order. Matching on the callee's tail rather than on
 * `ctx.` is deliberate: M25 contributes from `skip-intro.ts` through a local
 * alias, core contributes through `deps.menu.contribute`, and a rule that
 * insisted on the literal text `ctx.panel({` is a text rule wearing an AST hat.
 */
export function readClaimsFromFile(file, text, cache = new Map()) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const consts = numericConsts(src)
  const imports = importSources(src, file)
  const claims = []
  const unresolved = []

  /** `order:` may be a literal or a named constant, here or one import away. */
  const resolveOrder = (node) => {
    const direct = literalNumber(node)
    if (direct !== null) return direct
    if (ts.isIdentifier(node)) {
      if (consts.has(node.text)) return consts.get(node.text)
      const from = imports.get(node.text)
      if (from) {
        let other = cache.get(from)
        if (!other) {
          other = numericConsts(
            ts.createSourceFile(from, fs.readFileSync(from, 'utf8'), ts.ScriptTarget.Latest, true)
          )
          cache.set(from, other)
        }
        if (other.has(node.text)) return other.get(node.text)
      }
    }
    return null
  }

  const lineOf = (node) => src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const tail = node.expression.name.text
      const obj = node.expression.expression
      const objText = obj.getText(src)
      const qualified = /^[A-Za-z0-9_$.]+$/.test(objText)
        ? `${objText.split('.').slice(-1)[0]}.${tail}`
        : tail
      for (const spec of NAMESPACES) {
        const matches = spec.call.includes('.') ? qualified === spec.call : tail === spec.call
        if (!matches) continue

        if (spec.positional) {
          // `ctx.mpv.contributeArgs(10, () => [...])` — the priority is arg 0.
          const order = node.arguments[0] ? resolveOrder(node.arguments[0]) : null
          if (order === null) break // the service DEFINITION in the bus, not a claim
          claims.push({
            ns: spec.ns,
            id: null,
            order,
            scope: '',
            file,
            line: lineOf(node)
          })
          break
        }

        const arg = node.arguments.find((a) => ts.isObjectLiteralExpression(a))
        if (!arg) break // `this.contribute(ownerId, section)` — a forward, not a claim
        let id = null
        let orderNode = null
        let scope = ''
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p)) continue
          const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null
          if (key === 'id') id = stringLiteral(p.initializer)
          else if (key === 'order') orderNode = p.initializer
          else if (spec.scopeKey && key === spec.scopeKey) {
            scope = stringLiteral(p.initializer) ?? '?'
          }
        }
        if (orderNode === null) break
        const order = resolveOrder(orderNode)
        if (id === null || order === null) {
          unresolved.push({
            ns: spec.ns,
            file,
            line: lineOf(node),
            why:
              id === null
                ? "its `id` is not a plain string literal, so no partition key can name it"
                : `its \`order\` (${orderNode.getText(src)}) is not a number or a named numeric constant`
          })
          break
        }
        claims.push({ ns: spec.ns, id, order, scope, file, line: lineOf(node) })
        break
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return { claims, unresolved }
}

/**
 * Every ordering claim in the tree, with repo-relative forward-slash paths.
 *
 * `*.test.ts` is excluded: a test constructs colliding contributions ON PURPOSE
 * (`assert.throws(() => section('mediainfo.stats', 20), orderClash)`), so
 * counting them would make the fixture that proves the host rejects a tie into a
 * tie of its own.
 */
export function scanRepoClaims(repo) {
  const roots = [
    path.join(repo, 'src', 'main'),
    path.join(repo, 'src', 'renderer', 'src'),
    path.join(repo, 'src', 'shared')
  ]
  const files = roots.flatMap((r) => walkTs(r)).filter((f) => !f.endsWith('.test.ts'))
  const cache = new Map()
  const claims = []
  const unresolved = []
  for (const file of files.sort()) {
    const rel = path.relative(repo, file).split(path.sep).join('/')
    const read = readClaimsFromFile(file, fs.readFileSync(file, 'utf8'), cache)
    for (const c of read.claims) claims.push({ ...c, file: rel })
    for (const u of read.unresolved) unresolved.push({ ...u, file: rel })
  }
  return { claims, unresolved, fileCount: files.length }
}

/**
 * The menu's FIXED top-level roots, read from `core/menu-model.ts`.
 *
 * These share ONE ordering space with `ctx.menu.contribute()` — `buildTemplate()`
 * merges contributed sections and command-derived roots into one `blocks` array
 * and sorts it by `order` — so a section at 10 and the `playback` root at 10 are
 * a real tie that `MenuRegistry`'s duplicate check cannot see, because it only
 * compares sections against sections. Six such ties exist in the delivered tree.
 */
export function readMenuRoots(repo) {
  const file = path.join(repo, 'src', 'main', 'core', 'menu-model.ts')
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MENU_ROOTS' &&
      node.initializer
    ) {
      let init = node.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue
          let p = null
          let order = null
          for (const prop of el.properties) {
            if (!ts.isPropertyAssignment(prop)) continue
            const key = ts.isIdentifier(prop.name) ? prop.name.text : null
            if (key === 'path') p = stringLiteral(prop.initializer)
            if (key === 'order') order = literalNumber(prop.initializer)
          }
          if (p !== null && order !== null) out.push({ path: p, order })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

// ---------------------------------------------------------------------------
// The manifest side
// ---------------------------------------------------------------------------

/** Which row owns a repo-relative file. The partition check guarantees ≤ 1. */
export function ownerOf(modules, file) {
  for (const row of modules) {
    for (const entry of row.ownedFiles ?? []) {
      if (entry.endsWith('/') ? file.startsWith(entry) : file === entry) return row.id
    }
  }
  return null
}

/**
 * The id prefix a row's claims must carry: the module DIRECTORY for a feature
 * row (`M25` -> `nav-chapters`), and `core` for every core piece — core's
 * contributions are `core.playback`, not `core-mpv-bus.playback`, and the
 * runtime namespace check in `MenuRegistry.contribute()` agrees.
 */
export function namespaceIdOf(row) {
  const dir = /^src\/main\/features\/([a-z0-9-]+)\/$/.exec(row.path ?? '')?.[1]
  if (dir) return dir
  return row.id.startsWith('core-') ? 'core' : row.id
}

/** Flatten `ownedOrders` into the same claim shape the AST reader produces. */
export function manifestClaims(modules) {
  const claims = []
  for (const row of modules) {
    const table = row.ownedOrders ?? {}
    for (const ns of Object.keys(table)) {
      for (const c of table[ns] ?? []) {
        claims.push({
          ns,
          id: c.id ?? null,
          order: c.order,
          scope: c.scope ?? '',
          tiesRoot: c.tiesRoot ?? null,
          row: row.id
        })
      }
    }
  }
  return claims
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const key = (c) => `${c.ns} ${c.scope ?? ''} ${c.id ?? ''}`
const slot = (c) => `${c.ns} ${c.scope ?? ''} ${c.order}`

/**
 * Compare the manifest's ordering partition against the code, in BOTH
 * directions, and detect a collision in the manifest alone.
 *
 * @param {object} args
 * @param {readonly object[]} args.modules      parsed modules.json
 * @param {readonly object[]} args.codeClaims   from `scanRepoClaims`
 * @param {readonly object[]} args.unresolved   from `scanRepoClaims`
 * @param {readonly {path: string, order: number}[]} args.menuRoots
 * @returns {string[]} problems, empty when clean
 */
export function checkOrdering({ modules, codeClaims, unresolved = [], menuRoots = [] }) {
  const problems = []
  const declared = manifestClaims(modules)

  // --- 0. shape ------------------------------------------------------------
  for (const row of modules) {
    if (row.ownedOrders === undefined) {
      problems.push(
        `${row.id} has no 'ownedOrders' key. Every row carries the ordering partition, ` +
          `empty ({}) if the row contributes no ordered surface — a MISSING key and an ` +
          `empty one must not look the same to this check.`
      )
      continue
    }
    if (typeof row.ownedOrders !== 'object' || Array.isArray(row.ownedOrders)) {
      problems.push(`${row.id}'s 'ownedOrders' must be an object keyed by namespace.`)
      continue
    }
    for (const ns of Object.keys(row.ownedOrders)) {
      if (!BY_NS.has(ns)) {
        problems.push(
          `${row.id} declares orders in namespace '${ns}', which is not one of the seven: ` +
            `${NAMESPACE_IDS.join(', ')}.`
        )
        continue
      }
      const spec = BY_NS.get(ns)
      const list = row.ownedOrders[ns]
      if (!Array.isArray(list)) {
        problems.push(`${row.id}'s ownedOrders.${ns} must be an array.`)
        continue
      }
      for (const c of list) {
        if (!Number.isInteger(c?.order)) {
          problems.push(
            `${row.id}'s ownedOrders.${ns} entry ${JSON.stringify(c)} has no integer 'order'.`
          )
          continue
        }
        if (spec.positional) continue
        if (typeof c.id !== 'string' || c.id.length === 0) {
          problems.push(
            `${row.id}'s ownedOrders.${ns} entry at order ${c.order} has no 'id'. The id is the ` +
              `partition key: without it a collision cannot name both claimants.`
          )
          continue
        }
        const own = namespaceIdOf(row)
        if (own !== 'core' && !c.id.startsWith(own)) {
          problems.push(
            `${row.id} claims ${ns} id '${c.id}', which is outside its own namespace ` +
              `('${own}.…'). The runtime rejects this too (${spec.host}).`
          )
        }
      }
    }
  }
  if (problems.length > 0) return problems

  // --- 1. duplicate id inside one namespace --------------------------------
  const seen = new Map()
  for (const c of declared) {
    if (c.id === null) continue
    const k = key(c)
    if (seen.has(k)) {
      problems.push(
        `two rows claim ${c.ns} id '${c.id}': ${seen.get(k).row} and ${c.row}. Ids are ` +
          `'<module>.<name>' and globally unique.`
      )
    } else seen.set(k, c)
  }

  // --- 2. THE COLLISION, detectable from the manifest alone ----------------
  const bySlot = new Map()
  for (const c of declared) {
    const spec = BY_NS.get(c.ns)
    if (!spec || !spec.unique) continue
    const s = slot(c)
    const prev = bySlot.get(s)
    if (prev && prev.id !== c.id) {
      problems.push(
        `ORDERING COLLISION — ${c.ns} order ${c.order}` +
          (c.scope ? ` in scope '${c.scope}'` : '') +
          `: '${prev.id}' (${prev.row}) and '${c.id}' (${c.row}).\n` +
          `    This is a BOOT FAILURE, not a layout wobble: ${spec.host} throws a ` +
          `ContributionError,\n` +
          `    the registry re-throws it, and the app does not start. Pick distinct orders and ` +
          `record them\n` +
          `    in both rows' ownedOrders.${c.ns} in docs/parity/modules.json.`
      )
    } else if (!prev) bySlot.set(s, c)
  }

  // --- 3. an order the AST could not read ----------------------------------
  for (const u of unresolved) {
    problems.push(
      `${u.file}:${u.line} contributes a ${u.ns} whose claim cannot be read: ${u.why}.\n` +
        `    An ordering claim has to be a static fact or it cannot be partitioned. Use a ` +
        `string-literal id and\n` +
        `    a numeric literal or a module-level numeric constant.`
    )
  }

  // --- 4. code -> manifest -------------------------------------------------
  const declaredByKey = new Map(declared.filter((c) => c.id !== null).map((c) => [key(c), c]))
  const declaredPositional = new Map()
  for (const c of declared.filter((x) => x.id === null)) {
    declaredPositional.set(`${c.ns} ${c.row} ${c.order}`, c)
  }
  for (const c of codeClaims) {
    const row = ownerOf(modules, c.file)
    if (row === null) {
      problems.push(
        `${c.file}:${c.line} contributes a ${c.ns} and no row of modules.json owns that file, ` +
          `so the claim has no owner. check:partition says the same thing from the other side.`
      )
      continue
    }
    if (c.id === null) {
      // A band claim is keyed by (namespace, row, order).
      if (!declaredPositional.has(`${c.ns} ${row} ${c.order}`)) {
        problems.push(
          `${c.file}:${c.line} contributes ${c.ns} ${c.order} and ${row}'s ` +
            `ownedOrders.${c.ns} does not declare that band.\n` +
            `    Add { "order": ${c.order} } to ${row}'s ownedOrders.${c.ns}.`
        )
      }
      continue
    }
    const d = declaredByKey.get(key(c))
    if (!d) {
      problems.push(
        `${c.file}:${c.line} contributes ${c.ns} '${c.id}' at order ${c.order}` +
          (c.scope ? ` (scope '${c.scope}')` : '') +
          ` and NO row declares it.\n` +
          `    Add { "id": "${c.id}", "order": ${c.order}${c.scope ? `, "scope": "${c.scope}"` : ''} } ` +
          `to ${row}'s ownedOrders.${c.ns} in docs/parity/modules.json.`
      )
      continue
    }
    if (d.row !== row) {
      problems.push(
        `${c.file}:${c.line} contributes ${c.ns} '${c.id}', which ${d.row} declares — but that ` +
          `file is owned by ${row}.`
      )
    }
    if (d.order !== c.order) {
      problems.push(
        `${c.file}:${c.line} contributes ${c.ns} '${c.id}' at order ${c.order}, and ${d.row}'s ` +
          `ownedOrders.${c.ns} says ${d.order}.\n` +
          `    The manifest is the partition; the code is the fact. Make them agree.`
      )
    }
  }

  // --- 5. manifest -> code -------------------------------------------------
  const codeByKey = new Map(codeClaims.filter((c) => c.id !== null).map((c) => [key(c), c]))
  const codePositional = new Set()
  for (const c of codeClaims.filter((x) => x.id === null)) {
    codePositional.add(`${c.ns} ${ownerOf(modules, c.file)} ${c.order}`)
  }
  for (const c of declared) {
    if (c.id === null) {
      if (!codePositional.has(`${c.ns} ${c.row} ${c.order}`)) {
        problems.push(
          `${c.row} declares ${c.ns} band ${c.order} and no file it owns contributes at that ` +
            `priority. A reserved order nobody uses is how a partition rots.`
        )
      }
      continue
    }
    if (!codeByKey.has(key(c))) {
      problems.push(
        `${c.row} declares ${c.ns} '${c.id}' at order ${c.order}` +
          (c.scope ? ` (scope '${c.scope}')` : '') +
          ` and no code contributes it.\n` +
          `    Either the contribution was renamed or removed, or its scope changed. A declared ` +
          `order that\n` +
          `    is not in the code holds a slot against 25 modules that are about to ask for one.`
      )
    }
  }

  // --- 6. the menu's ONE space: sections vs the fixed roots ----------------
  const rootByOrder = new Map(menuRoots.map((r) => [r.order, r.path]))
  for (const c of declared) {
    if (c.ns !== 'menuSection') continue
    const atRoot = (c.scope ?? '') === ''
    const tied = atRoot ? rootByOrder.get(c.order) : undefined
    if (tied !== undefined && c.tiesRoot !== tied) {
      problems.push(
        `${c.row}'s menu section '${c.id}' is at order ${c.order}, which is also the fixed ` +
          `menu ROOT '${tied}'.\n` +
          `    MenuRegistry only compares sections against sections, but buildTemplate() sorts ` +
          `contributed\n` +
          `    sections and command-derived roots in ONE array, so this tie decides a block ` +
          `sequence that\n` +
          `    nothing rejects. Declare it: "tiesRoot": "${tied}" on that claim (and keep ` +
          `core/menu.ts's\n` +
          `    documented tie-break), or move the section off ${c.order}.`
      )
    }
    if (c.tiesRoot !== null && tied !== c.tiesRoot) {
      problems.push(
        `${c.row}'s menu section '${c.id}' declares tiesRoot '${c.tiesRoot}' and does not ` +
          `actually tie it (order ${c.order}${tied ? `, which is root '${tied}'` : ' ties no root'}). ` +
          `A stale acknowledgement is worse than none.`
      )
    }
  }

  return problems
}

/** A one-line-per-namespace summary, for the CLI and for a passing test. */
export function summarise(codeClaims) {
  return NAMESPACES.map((spec) => {
    const mine = codeClaims.filter((c) => c.ns === spec.ns)
    return `${spec.ns}: ${mine.length} claim(s)`
  })
}
