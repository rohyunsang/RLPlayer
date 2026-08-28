import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * THE PROMISED `ctx.paths` SURFACE MUST EXIST.
 *
 * `artCacheDir()` was implemented in `core/paths.ts:131`, promised to every
 * module by §12 of `docs/parity/02-wave0-api.md`, and present in NEITHER the
 * `PathService` interface NOR the `pathService` object that `ctx.paths` actually
 * is. So `ctx.paths.artCacheDir()` was `undefined`, and the first module to
 * follow the guide -- M27's poster frames, M30's continue-watching thumbnails --
 * would have crashed with "artCacheDir is not a function".
 *
 * Nothing caught it because nothing compared the three lists. There are three,
 * and a gap between any two is a broken promise:
 *
 *   1. what §12 of the guide PROMISES        (`ctx.paths.x()`)
 *   2. what `PathService` DECLARES           (the type modules program against)
 *   3. what `pathService` ACTUALLY CARRIES   (the object at runtime)
 *
 * SOURCE PARSING, DELIBERATELY, AND WITH ITS OWN GUARD. `core/paths.ts` imports
 * `electron`, so `node --test` cannot import it and read the object. Every check
 * in this repo that reads source has to answer "what if the parse silently stops
 * matching?", because that is how a check comes to report clean for everything:
 * so each parse below asserts a MINIMUM COUNT and a KNOWN MEMBER first. If the
 * regexes rot, this file fails rather than passing vacuously.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

const pathsSrc = fs.readFileSync(path.join(here, 'paths.ts'), 'utf8')
const apiSrc = fs.readFileSync(path.join(repo, 'src', 'shared', 'feature-api.ts'), 'utf8')
const guideSrc = fs.readFileSync(
  path.join(repo, 'docs', 'parity', '02-wave0-api.md'),
  'utf8'
)

/** The keys of the `pathService` object literal — what `ctx.paths` really is. */
function serviceKeys(): Set<string> {
  const start = pathsSrc.indexOf('export const pathService: PathService = {')
  assert.ok(start >= 0, 'the pathService object literal has moved; this parse is blind')
  const body = pathsSrc.slice(start, pathsSrc.indexOf('\n}\n', start))
  const keys = new Set<string>()
  // `mpvBinary,` (shorthand) and `get portableFallback(): boolean {`.
  for (const m of body.matchAll(/^\s{2}(?:get\s+)?([A-Za-z][A-Za-z0-9_]*)\s*[,(:]/gm)) {
    keys.add(m[1] as string)
  }
  return keys
}

/** The members `PathService` declares. */
function interfaceMembers(): Set<string> {
  const start = apiSrc.indexOf('export interface PathService {')
  assert.ok(start >= 0, 'the PathService interface has moved; this parse is blind')
  const body = apiSrc.slice(start, apiSrc.indexOf('\n}\n', start))
  const out = new Set<string>()
  for (const m of body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z][A-Za-z0-9_]*)\s*[(:]/gm)) {
    out.add(m[1] as string)
  }
  return out
}

/** Everything §12 of the guide tells a module it may call. */
function promisedByGuide(): Set<string> {
  const out = new Set<string>()
  for (const m of guideSrc.matchAll(/ctx\.paths\.([A-Za-z][A-Za-z0-9_]*)/g)) {
    out.add(m[1] as string)
  }
  // The §12 code block writes the tail of a chain without repeating the prefix:
  //   ctx.paths.dataDir() / cacheDir() / subCacheDir() / …
  // Reading only `ctx.paths.x` would have found ONE of the seven, which is the
  // shape of a parse that reports clean for six broken promises.
  const block = guideSrc.slice(guideSrc.indexOf('## 12. Paths and lifecycle'))
  for (const line of block.split('\n').slice(0, 12)) {
    if (!line.includes('ctx.paths') && !/^\s+[a-z]/.test(line)) continue
    for (const m of line.matchAll(/(?:^|[\s/])([a-z][A-Za-z0-9_]*)\s*\(/g)) {
      out.add(m[1] as string)
    }
  }
  return out
}

test('the three parses are alive, or every assertion below is vacuous', () => {
  const service = serviceKeys()
  const declared = interfaceMembers()
  const promised = promisedByGuide()
  assert.ok(service.size >= 9, `parsed only ${service.size} pathService keys: ${[...service]}`)
  assert.ok(declared.size >= 9, `parsed only ${declared.size} PathService members`)
  assert.ok(promised.size >= 7, `parsed only ${promised.size} promises from §12: ${[...promised]}`)
  for (const known of ['dataDir', 'cacheDir', 'thumbCacheDir', 'mpvBinary']) {
    assert.ok(service.has(known), `the pathService parse missed '${known}'`)
    assert.ok(declared.has(known), `the PathService parse missed '${known}'`)
    assert.ok(promised.has(known), `the §12 parse missed '${known}'`)
  }
})

test('every path §12 promises is DECLARED and IMPLEMENTED', () => {
  const service = serviceKeys()
  const declared = interfaceMembers()
  const missing: string[] = []
  for (const name of promisedByGuide()) {
    if (!declared.has(name)) missing.push(`${name}: promised by §12, not in PathService`)
    if (!service.has(name)) missing.push(`${name}: promised by §12, not on pathService`)
  }
  assert.deepEqual(
    missing,
    [],
    'docs/parity/02-wave0-api.md §12 promises a path a module cannot actually reach:\n  ' +
      missing.join('\n  ') +
      '\nThis is exactly how ctx.paths.artCacheDir() came to be undefined.'
  )
})

test('every member PathService declares is on the object ctx.paths actually is', () => {
  const service = serviceKeys()
  const missing = [...interfaceMembers()].filter((n) => !service.has(n))
  assert.deepEqual(
    missing,
    [],
    `PathService declares ${missing.join(', ')}, which the pathService object does not carry. ` +
      `TypeScript would normally catch that -- it did not here because the interface did not ` +
      `declare artCacheDir either. The two lists are compared directly now.`
  )
})

test('every directory accessor paths.ts exports is reachable through ctx.paths', () => {
  // The other direction, and the one that failed: `artCacheDir` was exported
  // from paths.ts and simply never wired up. An accessor that exists and is not
  // reachable is either a promise nobody kept or dead code; both want a name.
  const exported = new Set<string>()
  for (const m of pathsSrc.matchAll(/export function ([A-Za-z][A-Za-z0-9_]*)\(\): string/g)) {
    exported.add(m[1] as string)
  }
  assert.ok(exported.size >= 8, `parsed only ${exported.size} exported accessors`)
  const service = serviceKeys()
  // Core's own, with a reason each: `initPaths()` must run before
  // `app.whenReady()` and handing a module the ability to re-root the profile
  // is not a path accessor at all; `themesDir()` belongs to core's theme
  // loader; `root()` is the private base every accessor is built on. Anything
  // else that returns a directory is a module surface and belongs on ctx.paths.
  const coreOnly = new Set(['root', 'themesDir', 'initPaths'])
  const unreachable = [...exported].filter((n) => !service.has(n) && !coreOnly.has(n))
  assert.deepEqual(
    unreachable,
    [],
    `paths.ts exports ${unreachable.join(', ')} and ctx.paths cannot reach it. Either add it ` +
      `to PathService + pathService, or add it to this test's coreOnly list with a reason.`
  )
})

test('artCacheDir specifically, by name, because it is the one that was missing', () => {
  assert.ok(interfaceMembers().has('artCacheDir'), 'PathService.artCacheDir')
  assert.ok(serviceKeys().has('artCacheDir'), 'pathService.artCacheDir')
  assert.match(
    pathsSrc,
    /export function artCacheDir\(\): string \{\s*return ensure\(path\.join\(cacheDir\(\), 'art'\)\)/,
    "artCacheDir must stay inside cacheDir(), because profile-cleanup's APP_SUBTREES " +
      "lists 'cache/art' by that literal path"
  )
})
