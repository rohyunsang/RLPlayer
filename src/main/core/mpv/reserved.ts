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
 * "An option follows its property's owner" (§4 of the module author's guide),
 * as code rather than as prose.
 *
 * Until now this rule was documented and unimplemented, and the gap had a
 * name: M05 (video-hdr, V33) and M06 (video-scaler, V36) BOTH declare
 * `requestsProperties: ['d3d11-output-format']` — a property M07 owns — and
 * both need it set before the first frame, so both would have reached for
 * `contributeArgs('--d3d11-output-format=...')`. The duplicate check would
 * then have thrown at boot and the app would have hard-refused to start the
 * day the second of them landed. Nobody would have found that in review,
 * because each module is correct on its own.
 *
 * With the owner map wired in, the failure moves to whichever of the two adds
 * the contribution FIRST, at that module's own boot, with M07 named — and the
 * fix (ask M07's arbiter) is in the message.
 */
export type OptionOwnerLookup = (option: string) => string | null

/**
 * mpv options whose name is not literally their property's name. Small and
 * explicit: guessing a mapping is how you end up refusing a legitimate flag.
 */
const OPTION_PROPERTY_ALIASES: Record<string, string> = {
  // `--vf-add` / `--af-add` are the chains' own; the property is `vf` / `af`.
  'vf-add': 'vf',
  'af-add': 'af',
  'vf-append': 'vf',
  'af-append': 'af'
}

function propertyForOption(name: string): string {
  return OPTION_PROPERTY_ALIASES[name] ?? name
}

/**
 * The boot check. Throws `ContributionError` naming both contributors, or the
 * flag and its Electron replacement, so the build fails rather than the user.
 *
 * `ownerOf` is the property owner map. It is optional only so the reserved-args
 * suite can exercise the other three rules in isolation; the bus always passes
 * it.
 */
export function validateArgContributions(
  contributions: readonly ArgContribution[],
  ownerOf?: OptionOwnerLookup
): void {
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

      // §4: an option follows its property's owner. Checked BEFORE the
      // additive exemption, because `--vf-append` is additive as an option and
      // still belongs to the chain that owns `vf`.
      if (c.ownerId !== 'core/mpv/bus' && ownerOf) {
        const property = propertyForOption(name)
        const owner = ownerOf(property)
        if (owner !== null && owner !== c.ownerId) {
          throw new ContributionError(
            `module '${c.ownerId}' contributes '${arg}', but the '${property}' property is ` +
              `owned by '${owner}' (§3.7). An option follows its property's owner: a spawn arg ` +
              `is a property write that happens before the first frame, and letting a ` +
              `non-owner set one is exactly the silent last-one-wins race the owner map ` +
              `exists to stop. Ask ${owner} through ctx.mpv.requestSet('${property}', …) or ` +
              `its mediator command, and let ${owner} contribute the arg.`
          )
        }
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

/**
 * Flatten contributions into a spawn argv, priority ascending, then by OWNER ID.
 *
 * `priority` is deliberately a BAND rather than a slot here — eight modules
 * share 10 today, and rejecting a duplicate the way the seek bar and the menu
 * now do would be wrong: contributing `--audio-file-auto=fuzzy` and
 * `--sub-auto=fuzzy` at the same priority is not a conflict, and a real option
 * collision is caught by `validateArgContributions` instead, which names both
 * modules.
 *
 * But a TIE still has to resolve the same way on every launch. It used to fall
 * to `this.contributions` push order, i.e. feature discovery order, i.e.
 * `import.meta.glob`'s directory listing — so "which module's `--vo` wins" was
 * an accident of alphabetisation. Sorting the tie by owner id makes the argv
 * byte-identical across launches, which also means a bug report's command line
 * is reproducible.
 */
export function composeArgs(contributions: readonly ArgContribution[]): string[] {
  const sorted = [...contributions].sort(
    (a, b) => a.priority - b.priority || a.ownerId.localeCompare(b.ownerId)
  )
  const out: string[] = []
  for (const c of sorted) out.push(...c.args)
  return out
}
