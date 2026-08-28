/**
 * A resolve hook that makes `node --test` resolve imports the way the BUNDLER
 * does — and it exists because without it a large part of `src/main` cannot be
 * loaded by any test at all.
 *
 * THE GAP THIS CLOSES, measured before it existed. Two specifier shapes are
 * legal TypeScript under `moduleResolution: bundler`, are what electron-vite
 * emits from, and are used throughout core — and Node's own ESM resolver
 * rejects both:
 *
 *   import { labelForAccel } from '@shared/input/accel'   // path alias
 *   import { getVideoWindow } from './window/windows'     // no extension
 *
 * So:
 *
 *   $ cat > src/main/core/input/zz-probe.test.ts   # import('./index.ts')
 *   $ node --test src/main/core/input/zz-probe.test.ts
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\src\main\mpv\manager'
 *       imported from …\src\main\core\paths.ts
 *
 * `npm test` was green with 395 tests while that was true, because every test
 * that existed happened to sit on a file whose whole import graph spells its
 * relative imports with an explicit `.ts`. The files that do not — `core/menu.ts`,
 * `core/input/index.ts`, `core/registry.ts`, `src/main/ipc.ts` — were untestable
 * BY CONSTRUCTION, and a module author who writes a value import from
 * `@shared/features/<id>/wire.ts` (the one file both halves of a module can
 * share) gets a green typecheck, a green build, and a test file that cannot
 * load. That is not "these files have no tests yet"; it is a test suite that
 * cannot be pointed at them.
 *
 * WHAT IT DOES, and nothing else:
 *   1. `@shared/x` → `<repo>/src/shared/x`, the same single alias the three
 *      configs declare (`scripts/check-aliases.test.mjs` fails if they drift).
 *   2. an extensionless relative/absolute specifier → the first of
 *      `<s>.ts`, `<s>.mts`, `<s>/index.ts`, `<s>.mjs`, `<s>.js`, `<s>/index.js`
 *      that exists on disk. Same order a bundler tries.
 *
 * Anything else is handed straight to Node. It never invents a module: if no
 * candidate exists it defers, so a genuine typo still fails with Node's own
 * error rather than a confusing one from here.
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

/** The one alias, resolved from this file's location: scripts/lib → repo root. */
const REPO_ROOT = new URL('../../', import.meta.url)
export const ALIASES = Object.freeze({
  '@shared/': new URL('src/shared/', REPO_ROOT).href
})

/** Extension candidates, in bundler order. */
const EXTS = ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js']

function isFile(url) {
  try {
    return fs.statSync(fileURLToPath(url)).isFile()
  } catch {
    return false
  }
}

/**
 * `<spec>` → the first candidate that exists, or null.
 * Only called when the specifier has no extension we recognise, so appending is
 * never destructive.
 */
function probe(baseHref) {
  if (isFile(baseHref) && /\.[a-z]+$/i.test(baseHref)) return baseHref
  for (const ext of EXTS) {
    const candidate = `${baseHref}${ext}`
    if (isFile(candidate)) return candidate
  }
  for (const ext of EXTS) {
    const candidate = `${baseHref}/index${ext}`
    if (isFile(candidate)) return candidate
  }
  return null
}

export function resolveSpecifier(specifier, parentURL) {
  for (const [prefix, target] of Object.entries(ALIASES)) {
    if (specifier.startsWith(prefix)) {
      const rest = specifier.slice(prefix.length)
      const direct = new URL(rest, target).href
      // An alias hit that already names a real file (a `.ts` specifier) is used
      // as-is; otherwise probe extensions.
      return isFile(direct) ? direct : probe(direct)
    }
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!parentURL) return null
    const direct = new URL(specifier, parentURL).href
    if (isFile(direct)) return null // Node resolves it fine; do not interfere.
    return probe(direct)
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  const hit = resolveSpecifier(specifier, context.parentURL)
  if (hit) return { url: hit, shortCircuit: true, format: formatFor(hit) }
  return nextResolve(specifier, context)
}

function formatFor(href) {
  if (/\.(m?ts|cts)$/.test(href)) return undefined // let Node type-strip it
  if (/\.mjs$/.test(href)) return 'module'
  if (/\.cjs$/.test(href)) return 'commonjs'
  return undefined
}

/** Exported for the drift check. */
export function aliasTargets() {
  return Object.fromEntries(
    Object.entries(ALIASES).map(([k, v]) => [k, fileURLToPath(v).replace(/\\/g, '/')])
  )
}

export { pathToFileURL }
