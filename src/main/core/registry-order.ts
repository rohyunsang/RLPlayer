import { ContributionError } from './errors.ts'

/**
 * The pure half of core/registry: id validation and dependency ordering.
 * Split out from registry.ts so `test:registry` can exercise every boot-time
 * failure without an Electron app object anywhere near it.
 */

export interface DiscoveredModule {
  /** Directory name the module was found in. */
  dir: string
  id: string
  dependsOn?: readonly string[]
}

/**
 * `dependsOn` HAS ONE NAMESPACE, and until this table existed it had two.
 *
 * `docs/parity/modules.json` rows say `"dependsOn": ["core-af-chain"]` and
 * `["core-mpv-bus", "M18"]`; code `dependsOn` took feature-module DIRECTORY ids
 * and nothing else. So a module author who mirrored their own manifest row —
 * the row written for them, in the file the review reads — failed to boot:
 *
 *   topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['core-af-chain'] }])
 *   -> ContributionError: module 'audio-eq' dependsOn 'core-af-chain',
 *      which is not a loaded feature module.
 *
 * and nothing compared the two files, so the manifest's dependency graph — 40
 * feature rows, 15 core rows, the artefact the whole partition is reviewed
 * against — had no encoding in code at all.
 *
 * Both namespaces are legal now and mean different things:
 *
 *   a CORE piece id      — satisfied by construction. Core is fully up before
 *                          the first feature `setup()` runs, so there is no
 *                          ordering to do; the entry is documentation, and it
 *                          is checked for spelling.
 *   a FEATURE id that is loaded    — a real edge.
 *   a FEATURE id in the manifest
 *     that is NOT loaded           — deferred, not an error. M17's row depends
 *                          on M18 (`subs-formats`), which Wave 1 has not built.
 *                          Same rule as a reserved filter label with no
 *                          implementation: a reservation without code is the
 *                          partition working. The registry logs it once.
 *   anything else        — a boot error, and the message says which namespace
 *                          the author has reached into.
 *
 * `manifest.test.ts` asserts these two lists ARE the manifest's, in both
 * directions, so this table cannot rot the way the prose did.
 */
export const MANIFEST_CORE_IDS: readonly string[] = [
  'core-paths',
  'core-feature-api',
  'core-i18n',
  'core-settings',
  'core-registry',
  'core-mpv-bus',
  'core-mpv-ownership',
  'core-vf-chain',
  'core-af-chain',
  'core-input',
  'core-osd',
  'core-per-file',
  'core-window',
  'core-legacy-bridge',
  'core-renderer'
]

/** Every feature-module directory the manifest reserves — built or not. */
export const MANIFEST_FEATURE_IDS: readonly string[] = [
  'video-color',
  'video-geometry',
  'video-enhance',
  'video-deinterlace',
  'video-hdr',
  'video-scaler',
  'video-decode',
  'video-framerate',
  'video-stereo360',
  'audio-volume',
  'audio-tracks',
  'audio-eq',
  'audio-loudness',
  'audio-channels',
  'audio-devices',
  'audio-effects',
  'subs-tracks',
  'subs-formats',
  'subs-style',
  'subs-sync',
  'subs-browser',
  'capture-still',
  'capture-encode',
  'nav-seek',
  'nav-chapters',
  'nav-bookmarks',
  'nav-thumbnails',
  'playlist',
  'mediainfo',
  'history',
  'shell-window',
  'shell-taskbar',
  'shell-system',
  'shell-associations',
  'stream-open',
  'stream-ytdl',
  'disc-devices',
  'settings-ui',
  'input-ui',
  'transfer'
]

const CORE_SET = new Set(MANIFEST_CORE_IDS)
const FEATURE_SET = new Set(MANIFEST_FEATURE_IDS)
/** `M03`, `N51`, `A27` — a spec/manifest ROW id, not a module id. */
const ROW_ID_RE = /^[A-Z]\d{2}$/

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function validateIds(mods: readonly DiscoveredModule[]): void {
  const seen = new Map<string, string>()
  for (const m of mods) {
    if (!ID_RE.test(m.id)) {
      throw new ContributionError(
        `module in 'features/${m.dir}/' has id '${m.id}', which is not kebab-case.`
      )
    }
    if (m.id !== m.dir) {
      // Both names, always: "id must equal the directory" is not actionable
      // without knowing which two strings disagree.
      throw new ContributionError(
        `module id '${m.id}' does not match its directory 'features/${m.dir}/'. ` +
          `Rename one so they agree — the registry, modules.json and every namespace ` +
          `check key off this id.`
      )
    }
    const dup = seen.get(m.id)
    if (dup) {
      throw new ContributionError(`duplicate module id '${m.id}' in '${dup}' and '${m.dir}'.`)
    }
    seen.set(m.id, m.dir)
  }
}

/**
 * Dependencies the manifest records that this build cannot order against,
 * because the module is reserved but not implemented yet. The registry logs
 * these once at boot: the depending module runs, and it is the module's job to
 * cope with the helper being absent (§3.6 — N51 falls back to "this folder" if
 * `playlist.seriesPrefix` is not there).
 */
export function deferredDeps(mods: readonly DiscoveredModule[]): { id: string; dep: string }[] {
  const loaded = new Set(mods.map((m) => m.id))
  const out: { id: string; dep: string }[] = []
  for (const m of mods) {
    for (const dep of m.dependsOn ?? []) {
      if (!loaded.has(dep) && FEATURE_SET.has(dep)) out.push({ id: m.id, dep })
    }
  }
  return out
}

/** Topological order. A cycle throws and NAMES the cycle. */
export function topoSort<T extends DiscoveredModule>(mods: readonly T[]): T[] {
  const byId = new Map(mods.map((m) => [m.id, m]))
  const state = new Map<string, 'visiting' | 'done'>()
  const out: T[] = []

  const visit = (m: T, trail: string[]): void => {
    const s = state.get(m.id)
    if (s === 'done') return
    if (s === 'visiting') {
      const at = trail.indexOf(m.id)
      const cycle = [...trail.slice(at === -1 ? 0 : at), m.id].join(' → ')
      throw new ContributionError(`dependency cycle between feature modules: ${cycle}`)
    }
    state.set(m.id, 'visiting')
    for (const dep of m.dependsOn ?? []) {
      const target = byId.get(dep)
      if (!target) {
        // Not loaded. Three different situations, three different answers —
        // see MANIFEST_CORE_IDS above for why they are not all errors.
        if (CORE_SET.has(dep)) continue
        if (FEATURE_SET.has(dep)) continue
        throw new ContributionError(unknownDepMessage(m.id, dep))
      }
      visit(target, [...trail, m.id])
    }
    state.set(m.id, 'done')
    out.push(m)
  }

  for (const m of mods) visit(m, [])
  return out
}

function unknownDepMessage(id: string, dep: string): string {
  if (ROW_ID_RE.test(dep)) {
    return (
      `module '${id}' dependsOn '${dep}', which is a docs/parity/modules.json ROW id, ` +
      `not a module id. dependsOn takes the other module's id — its directory name — ` +
      `or a core piece id. Look the row up in modules.json: its 'path' is ` +
      `'src/main/features/<id>/', and that <id> is the string you want.`
    )
  }
  const near = nearestId(dep)
  return (
    `module '${id}' dependsOn '${dep}', which is neither a loaded feature module, ` +
    `a module reserved in docs/parity/modules.json, nor a core piece id.` +
    (near ? ` Did you mean '${near}'?` : '') +
    ` A dependency on a reserved-but-unbuilt module is fine and is deferred; a name ` +
    `that is in no namespace at all is a typo.`
  )
}

/**
 * The closest real id within two edits, or undefined.
 *
 * A transposition is the typo people actually make (`core-af-chian`), and the
 * first version of this hint compared hyphen-stripped strings for equality,
 * which catches `core_af_chain` and misses every transposition — so the message
 * that exists to name the intended id said nothing in the common case.
 */
function nearestId(dep: string): string | undefined {
  const want = dep.toLowerCase()
  let best: { id: string; d: number } | undefined
  for (const id of [...MANIFEST_CORE_IDS, ...MANIFEST_FEATURE_IDS]) {
    const d = editDistance(want, id)
    if (d <= 2 && (!best || d < best.d)) best = { id, d }
  }
  return best?.id
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      row[j] = Math.min(sub, (prev[j] as number) + 1, (row[j - 1] as number) + 1)
    }
    prev = row
  }
  return prev[b.length] as number
}
