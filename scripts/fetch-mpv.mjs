#!/usr/bin/env node
/**
 * Downloads + extracts a pinned mpv Windows build into resources/mpv/.
 *
 * The binary is deliberately NOT committed to git (see .gitignore). This script
 * makes the build reproducible: the release tag and the SHA-256 of the archive
 * are pinned below, and the download is rejected if the hash does not match.
 *
 * mpv is GPLv2+. RLPlayer (MIT) spawns mpv.exe as a SEPARATE PROCESS and speaks
 * to it over a JSON IPC named pipe. It does not link against libmpv, so the
 * copyleft does not propagate to RLPlayer's own source. We ship mpv's license
 * text alongside the binary -- see THIRD-PARTY-NOTICES.md.
 */
import { createWriteStream, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'resources', 'mpv')
const CACHE = path.join(ROOT, '.cache')

// --- pinned release -------------------------------------------------------
const MPV = {
  tag: '20260814',
  asset: 'mpv-x86_64-20260814-git-7b8915bc1d.7z',
  sha256: '1bf3b029da2c98e605e00e85f21ee3142f22a1dcc4ceb5c827b5c51e36e390f9',
  size: 33583248
}
const URL = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${MPV.tag}/${MPV.asset}`
// --------------------------------------------------------------------------

const log = (...a) => console.log('[fetch-mpv]', ...a)

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function sha256(file) {
  const h = crypto.createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

/** Follows redirects; GitHub release downloads bounce to objects.githubusercontent.com. */
async function download(url, dest) {
  log('downloading', url)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let seen = 0
  let lastPct = -1
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.length
    if (total) {
      const pct = Math.floor((seen / total) * 100)
      if (pct >= lastPct + 10) { lastPct = pct; log(`  ${pct}% (${(seen / 1048576).toFixed(1)} MB)`) }
    }
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once('drain', r))
    }
  }
  await new Promise((r, j) => { out.end(); out.on('finish', r); out.on('error', j) })
}

/** Resolve the 7za binary bundled by the 7zip-bin package (a dep of electron-builder). */
async function sevenZip() {
  try {
    const mod = await import('7zip-bin')
    const p = mod.default?.path7za ?? mod.path7za
    if (p && (await exists(p))) return p
  } catch { /* fall through */ }
  for (const c of ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe']) {
    if (await exists(c)) return c
  }
  throw new Error('No 7z extractor found. Run `npm install` first (installs 7zip-bin), or install 7-Zip.')
}

async function main() {
  const mpvExe = path.join(DEST, 'mpv.exe')
  const stamp = path.join(DEST, '.version')

  if (await exists(mpvExe)) {
    const cur = (await fs.readFile(stamp, 'utf8').catch(() => '')).trim()
    if (cur === MPV.asset) { log('mpv already present and up to date ->', mpvExe); return verify(mpvExe) }
    log('pinned mpv version changed, refreshing...')
    await fs.rm(DEST, { recursive: true, force: true })
  }

  await fs.mkdir(CACHE, { recursive: true })
  const archive = path.join(CACHE, MPV.asset)

  let ok = false
  if (await exists(archive)) {
    log('found cached archive, verifying...')
    ok = (await sha256(archive)) === MPV.sha256
    if (!ok) { log('cached archive is corrupt, re-downloading'); await fs.rm(archive, { force: true }) }
  }
  if (!ok) {
    await download(URL, archive)
    const got = await sha256(archive)
    if (got !== MPV.sha256) {
      await fs.rm(archive, { force: true })
      throw new Error(`SHA-256 mismatch for ${MPV.asset}\n  expected ${MPV.sha256}\n  got      ${got}`)
    }
    log('sha256 ok')
  }

  const sz = await sevenZip()
  await fs.mkdir(DEST, { recursive: true })
  log('extracting with', sz)
  const r = spawnSync(sz, ['x', archive, `-o${DEST}`, '-y'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`7z exited with ${r.status}`)

  if (!(await exists(mpvExe))) throw new Error(`extraction finished but ${mpvExe} is missing`)

  // Strip pieces we never use, to keep the installer small.
  for (const junk of ['mpv.com', 'installer', 'updater.bat', 'update.bat', 'doc']) {
    await fs.rm(path.join(DEST, junk), { recursive: true, force: true }).catch(() => {})
  }

  await fs.writeFile(stamp, MPV.asset)
  await verify(mpvExe)
}

/** Actually run the binary -- a download that cannot execute is worse than no download. */
function verify(mpvExe) {
  return new Promise((resolve, reject) => {
    const p = spawn(mpvExe, ['--version'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('error', reject)
    p.on('close', (code) => {
      const first = out.split('\n')[0].trim()
      if (code !== 0 || !/mpv/i.test(out)) return reject(new Error(`mpv.exe --version failed (exit ${code}): ${out.slice(0, 300)}`))
      log('verified ->', first)
      resolve()
    })
  })
}

main().catch((e) => { console.error('[fetch-mpv] FAILED:', e.message); process.exit(1) })
