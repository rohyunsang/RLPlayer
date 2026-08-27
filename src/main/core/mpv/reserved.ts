import { ContributionError } from '../errors.ts'

/**
 * core/mpv/reserved — what a module may not put on mpv's command line.
 * WAVE 0 — FROZEN.
 *
 * Three separate rules, all checked at boot by `validateArgContributions()`:
 *
 *  1. CORE-RESERVED. `--wid`, `--input-ipc-server`, `--no-config`, `--input-*`,
 *     `--osc`, `--osd-*`, `--vo`, `--gpu-context` belong to the bus. A module
 *     contributing one throws.
 *  2. INERT UNDER --wid (§7.5). This is the rule that exists because the bug it
 *     prevents is invisible: mpv accepts `--fullscreen`, reports success, and
 *     does nothing, because with `--wid` it does not own a window. Twenty-five
 *     options behave that way. A module contributing one gets a clear error
 *     naming the flag and the Electron API to use instead, rather than a
 *     mystery at runtime.
 *  3. DUPLICATES ACROSS CONTRIBUTORS. Two feature modules contributing the same
 *     option name throw, whatever the values. This is the V33/V36 case:
 *     `--d3d11-output-format=rgba16f` (M05) and `=rgb10_a2` (M06), both P1,
 *     mutually exclusive, silent last-one-wins. The only exemption is mpv's
 *     genuinely additive `*-append` family, listed below and nothing else.
 */

export interface ArgContribution {
  ownerId: string
  priority: number
  args: readonly string[]
}

/** Option names the bus owns outright. */
export const CORE_RESERVED_OPTIONS: readonly string[] = [
  'wid',
  'input-ipc-server',
  'no-config',
  'config',
  'config-dir',
  'osc',
  'vo',
  'gpu-context',
  'idle',
  'force-window',
  'keep-open',
  'terminal',
  'msg-level',
  'load-scripts',
  'include',
  'drag-and-drop'
]

/** Prefix families the bus owns: `--input-*`, `--osd-*`. */
export const CORE_RESERVED_PREFIXES: readonly string[] = ['input-', 'osd-']

/**
 * §7.5 — every one of these is accepted by mpv and then silently ignored,
 * because `--wid` means mpv is not managing a window. Reproduced in the module
 * author's guide; enforced here so nobody has to have read it.
 */
export const WID_INERT_OPTIONS: readonly string[] = [
  'border',
  'title-bar',
  'show-in-taskbar',
  'fullscreen',
  'fs',
  'fs-screen',
  'fs-screen-name',
  'ontop',
  'ontop-level',
  'snap-window',
  'window-minimized',
  'window-maximized',
  'window-affinity',
  'window-corners',
  'window-scale',
  'geometry',
  'autofit',
  'autofit-larger',
  'autofit-smaller',
  'keepaspect-window',
  'title',
  'cursor-autohide',
  'input-cursor',
  'hidpi-window-scale',
  'native-touch',
  'taskbar-progress'
]

/** The Electron-side replacement, named in the error so the fix is obvious. */
const WID_INERT_ADVICE: Record<string, string> = {
  fullscreen: 'ctx.window.setFullScreen()',
  fs: 'ctx.window.setFullScreen()',
  'fs-screen': 'ctx.window.setFullScreenOnDisplay()',
  'fs-screen-name': 'ctx.window.setFullScreenOnDisplay()',
  ontop: 'ctx.window.setAlwaysOnTop()',
  'ontop-level': 'ctx.window.setAlwaysOnTop() — modules never choose the level',
  border: 'ctx.window.setChrome()',
  'title-bar': 'ctx.window.setChrome()',
  'show-in-taskbar': 'ctx.window.taskbar (M32 only)',
  'taskbar-progress': 'ctx.window.taskbar.setProgressBar()',
  geometry: 'ctx.window.setBounds()',
  autofit: 'ctx.window.setContentSize()',
  'autofit-larger': 'ctx.window.setContentSize()',
  'autofit-smaller': 'ctx.window.setContentSize()',
  'window-scale': 'ctx.window.setContentSize()',
  'window-maximized': 'ctx.window.maximize()',
  'window-minimized': 'ctx.window.minimize()',
  'snap-window': 'Electron handles Aero Snap; there is nothing to set',
  'keepaspect-window': 'ctx.window.setAspectRatio()',
  title: 'the overlay draws the title; set it in the renderer',
  'cursor-autohide': 'the overlay owns the cursor',
  'input-cursor': 'the overlay owns the cursor'
}

/**
 * mpv options whose semantics are genuinely additive, so two contributors are
 * fine. Explicit allowlist — nothing else is exempt.
 */
export const ADDITIVE_OPTIONS: readonly string[] = [
  'script-opts-append',
  'sub-auto-exts-append',
  'sub-file-paths-append',
  'ytdl-raw-options-append',
  'audio-file-paths-append',
  'http-header-fields-append',
  'glsl-shaders-append',
  'vf-append',
  'af-append'
]

/** `--sub-auto=fuzzy` → 'sub-auto'. `--no-config` → 'config' (mpv's negation). */
export function optionNameOf(arg: string): string | null {
  if (!arg.startsWith('--')) return null
  const body = arg.slice(2)
  const eq = body.indexOf('=')
  let name = eq === -1 ? body : body.slice(0, eq)
  if (name.startsWith('no-')) name = name.slice(3)
  return name
}

function isCoreReserved(name: string): boolean {
  if (CORE_RESERVED_OPTIONS.includes(name)) return true
  return CORE_RESERVED_PREFIXES.some((p) => name.startsWith(p))
}

/**
 * The boot check. Throws `ContributionError` naming both contributors, or the
 * flag and its Electron replacement, so the build fails rather than the user.
 */
export function validateArgContributions(contributions: readonly ArgContribution[]): void {
  const seen = new Map<string, string>()
  for (const c of contributions) {
    const local = new Set<string>()
    for (const arg of c.args) {
      const name = optionNameOf(arg)
      if (name === null) continue

      if (c.ownerId !== 'core/mpv/bus' && isCoreReserved(name)) {
        throw new ContributionError(
          `module '${c.ownerId}' contributes '${arg}', but '--${name}' is reserved by core/mpv/bus ` +
            `(Appendix A). Core sets it at spawn; ask for a change through ctx.mpv.requestRestart().`
        )
      }

      // Core is exempt from the inert check, and only core. §5.3 asks for
      // `--cursor-autohide=no` and `--taskbar-progress=no` in the base set
      // while §7.5 lists both as inert; setting them is harmless belt-and-
      // braces if a future mpv changes its mind about what --wid implies. A
      // FEATURE module contributing one is still a boot error, because there
      // the flag is standing in for window work that has to happen in Electron.
      if (c.ownerId !== 'core/mpv/bus' && WID_INERT_OPTIONS.includes(name)) {
        const advice = WID_INERT_ADVICE[name] ?? 'ctx.window (§3.3.7)'
        throw new ContributionError(
          `module '${c.ownerId}' contributes '${arg}', which is INERT under --wid (§7.5). ` +
            `mpv accepts it, reports success and does nothing, because it does not own the window. ` +
            `Use ${advice} instead.`
        )
      }

      if (ADDITIVE_OPTIONS.includes(name)) continue

      if (local.has(name)) {
        throw new ContributionError(
          `module '${c.ownerId}' contributes '--${name}' twice in one batch.`
        )
      }
      local.add(name)

      const owner = seen.get(name)
      if (owner && owner !== c.ownerId) {
        throw new ContributionError(
          `spawn-arg collision on '--${name}': contributed by both '${owner}' and '${c.ownerId}'. ` +
            `Duplicate option names are rejected across ALL contributors, not just core's ` +
            `(§3.3.1) — this is the V33/V36 --d3d11-output-format case, where last-one-wins ` +
            `would be silent. One owner, one option.`
        )
      }
      seen.set(name, c.ownerId)
    }
  }
}

/** Flatten contributions into a spawn argv, priority ascending, stable. */
export function composeArgs(contributions: readonly ArgContribution[]): string[] {
  const sorted = [...contributions].sort((a, b) => a.priority - b.priority)
  const out: string[] = []
  for (const c of sorted) out.push(...c.args)
  return out
}
