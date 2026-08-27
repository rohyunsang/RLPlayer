#!/usr/bin/env node
/**
 * The grep-shaped guarantees, in one place.
 *
 * Three of the spec's §6.2 suites are greps rather than unit tests, because
 * what they assert is the ABSENCE of code:
 *
 *   test:no-hijack      — never write a UserChoice hash, never call the
 *                         undocumented default-app APIs (P33)
 *   test:window-service — no feature module imports windows.ts or constructs a
 *                         BrowserWindow (§3.3.7)
 *   no-updater          — no electron-updater, no autoUpdater, no version ping.
 *                         The absence IS the feature; docs/01 makes it the
 *                         reason the project exists.
 *
 * Run: npm run check:forbidden
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|js|mjs|html)$/.test(entry.name)) out.push(full)
  }
  return out
}

const srcFiles = walk(path.join(repo, 'src'))
const rel = (f) => path.relative(repo, f).replace(/\\/g, '/')

function forbid(files, pattern, message, allow = () => false) {
  for (const file of files) {
    if (allow(rel(file))) continue
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      // A line that explains why we do NOT do something is not a violation.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (pattern.test(line)) failures.push(`${rel(file)}:${i + 1}  ${message}\n    ${line.trim()}`)
    })
  }
}

// --- test:no-hijack (P33) --------------------------------------------------
forbid(
  srcFiles,
  /UserChoice|SetAppAsDefaultAll|LaunchAdvancedAssociationUI/,
  'file associations must never be hijacked; send the user to ms-settings:defaultapps'
)

// --- no updater, no telemetry ----------------------------------------------
forbid(
  srcFiles,
  /electron-updater|autoUpdater|checkForUpdatesAndNotify/,
  'there is no auto-update in this app, and the absence is the product'
)

// --- test:window-service (§3.3.7) ------------------------------------------
const featureFiles = srcFiles.filter((f) => /\/(main|renderer\/src)\/features\//.test(rel(f)))
forbid(
  featureFiles,
  /from\s+['"][^'"]*window\/windows['"]|require\(['"][^'"]*windows['"]\)/,
  'no feature module imports windows.ts — use ctx.window (§3.3.7)'
)
forbid(featureFiles, /new BrowserWindow/, 'no feature module constructs a BrowserWindow')

// --- the other forbidden shared files (§3.0) -------------------------------
forbid(
  featureFiles,
  /from\s+['"][^'"]*(\/ipc|\/core\/menu|\/core\/legacy-bridge|preload\/index|shared\/keybinds)['"]/,
  'no feature module imports a shared core file — everything arrives on FeatureContext'
)

// --- one module never imports another (§3.0) -------------------------------
for (const file of featureFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const own = rel(file).split('/features/')[1]?.split('/')[0]
  for (const m of text.matchAll(/from\s+['"]([^'"]*\/features\/([a-z0-9-]+)\/[^'"]*)['"]/g)) {
    if (m[2] !== own) {
      failures.push(
        `${rel(file)}  module '${own}' imports module '${m[2]}' directly. ` +
          `Cross-module calls go through ctx.commands.invoke() (§3.7.3).`
      )
    }
  }
}

if (failures.length > 0) {
  console.error('check:forbidden found %d violation(s):\n', failures.length)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('check:forbidden: clean (%d files scanned)', srcFiles.length)
