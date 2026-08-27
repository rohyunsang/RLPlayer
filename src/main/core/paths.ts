import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { PathService } from '@shared/feature-api'

/**
 * core/paths — portable resolution and Electron path redirection (§5.1).
 * WAVE 0 — FROZEN.
 *
 * `initPaths()` MUST be the first thing `src/main/index.ts` does, before
 * `app.whenReady()`. Electron caches `userData` the first time anything asks
 * for it, and Chromium picks its disk-cache directory during startup: redirect
 * either one late and a "portable" build has already written to %APPDATA%,
 * which is the exact promise portable mode exists to keep.
 */

let dataRoot = ''
let portable = false
let fallback = false

/** D-9: accept both markers. One extra existsSync. */
function detectRoot(): { dir: string; portable: boolean } {
  const exeDir = path.dirname(app.getPath('exe'))
  const env = process.env['RLPLAYER_HOME']
  if (env) return { dir: env, portable: true }
  if (exists(path.join(exeDir, 'portable.txt'))) {
    return { dir: path.join(exeDir, 'data'), portable: true }
  }
  if (exists(path.join(exeDir, 'portable_config'))) {
    return { dir: path.join(exeDir, 'portable_config'), portable: true }
  }
  return { dir: path.join(app.getPath('appData'), 'RLPlayer'), portable: false }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** P39: a portable build on a read-only stick must degrade, not crash. */
function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'x')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export function initPaths(): string {
  if (dataRoot) return dataRoot
  const detected = detectRoot()
  let dir = detected.dir
  portable = detected.portable

  if (!writable(dir)) {
    if (portable) {
      fallback = true
      portable = false
      dir = path.join(app.getPath('appData'), 'RLPlayer')
      fs.mkdirSync(dir, { recursive: true })
    } else {
      // Nothing we can do about a non-writable %APPDATA%; let it fail loudly
      // at the first write rather than silently losing the user's settings.
    }
  }

  dataRoot = dir
  app.setPath('userData', dir)
  app.setPath('sessionData', path.join(dir, 'session'))
  app.setPath('logs', path.join(dir, 'logs'))
  app.setPath('crashDumps', path.join(dir, 'crash'))
  app.commandLine.appendSwitch('disk-cache-dir', path.join(dir, 'cache'))
  return dataRoot
}

function root(): string {
  return dataRoot || initPaths()
}

function ensure(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* surfaced by the caller's own write */
  }
  return dir
}

export function dataDir(): string {
  return ensure(root())
}
export function cacheDir(): string {
  return ensure(path.join(root(), 'cache'))
}
export function subCacheDir(): string {
  return ensure(path.join(root(), 'subcache'))
}
export function thumbCacheDir(): string {
  return ensure(path.join(cacheDir(), 'thumbs'))
}
export function sceneCacheDir(): string {
  return ensure(path.join(cacheDir(), 'scenes'))
}
export function artCacheDir(): string {
  return ensure(path.join(cacheDir(), 'art'))
}
export function logsDir(): string {
  return ensure(path.join(root(), 'logs'))
}
export function themesDir(): string {
  return ensure(path.join(root(), 'themes'))
}

/**
 * A per-job scratch directory. §7.7 trap 1: a Windows absolute path cannot
 * appear inside a lavfi option, so offline jobs stage their fonts and palettes
 * here and spawn with `cwd` set, referencing bare relative filenames.
 */
export function tempJobDir(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'job'
  return ensure(path.join(cacheDir(), 'jobs', safe))
}

export function isPortable(): boolean {
  if (!dataRoot) initPaths()
  return portable
}

export function portableFallback(): boolean {
  if (!dataRoot) initPaths()
  return fallback
}

export function filePath(name: string): string {
  return path.join(dataDir(), name)
}

export const pathService: PathService = {
  dataDir,
  cacheDir,
  subCacheDir,
  thumbCacheDir,
  sceneCacheDir,
  logsDir,
  tempJobDir,
  isPortable,
  get portableFallback(): boolean {
    return portableFallback()
  }
}
