import { ContributionError } from './errors.ts'

/**
 * core/menu-model — the pure half of the contributed menu.
 *
 * WHY THIS FILE EXISTS. `CommandDescriptor.menuPath` and `menuOrder` sat in the
 * public API with ZERO consumers. Nothing anywhere read either field:
 *
 *   $ grep -rn 'menuPath\|menuOrder' src/ scripts/
 *   src/main/features/audio-eq/index.ts:398:      menuPath: 'audio',
 *   src/main/features/audio-volume/index.ts:181:  menuPath: 'audio',
 *   src/main/features/subs-tracks/index.ts:133:   menuPath: 'subtitles',
 *   src/shared/feature-api.ts:364:  readonly menuPath?: string
 *   src/shared/feature-api.ts:365:  readonly menuOrder?: number
 *
 * Three modules declared a menu location and got no menu entry, and neither of
 * the two that had no `ctx.menu.contribute()` call — M12's equaliser toggle and
 * M10's mute — appeared in the context menu at all. §P13 promises the opposite:
 * "`menuPath` makes keymap and menu a single source of truth". A field the API
 * documents and nothing reads is worse than an absent one; the author has no way
 * to tell it did nothing.
 *
 * It is read now. A command with a `menuPath` becomes a menu item under a FIXED
 * root, labelled by the command's own `labelKey` and carrying the command's own
 * accelerator, with no section to contribute and no shared file to edit. The
 * heavier `ctx.menu.contribute()` stays for what a flat item cannot express —
 * dynamic track lists, radio groups, checkboxes.
 *
 * Kept separate from `menu.ts` because that file imports `electron`, and this is
 * the same split as `registry-order.ts` out of `registry.ts`: every boot-time
 * failure and the whole ordering policy are unit-testable with no Electron
 * anywhere near them.
 */

/**
 * The menu's top level, in the order it renders. FIXED, exactly like the eight
 * settings sections in §7 and for the same reason: a context menu with forty
 * module-shaped roots is the thing this design exists to prevent.
 *
 * The number is the root's base order in the same space `ctx.menu.contribute()`
 * uses, so a contributed section and a command-derived root interleave by one
 * rule instead of one appearing arbitrarily after the other.
 */
export const MENU_ROOTS: readonly { path: string; order: number }[] = [
  { path: 'playback', order: 10 },
  { path: 'video', order: 20 },
  { path: 'audio', order: 30 },
  { path: 'subtitles', order: 40 },
  { path: 'navigate', order: 50 },
  { path: 'capture', order: 60 },
  { path: 'window', order: 70 },
  { path: 'tools', order: 80 }
]

const ROOT_ORDER = new Map(MENU_ROOTS.map((r) => [r.path, r.order]))

/** What the model needs from a command. A subset of `CommandDescriptor`. */
export interface MenuCommand {
  id: string
  labelKey: string
  menuPath?: string | undefined
  menuOrder?: number | undefined
  internal?: boolean | undefined
}

export interface MenuGroup {
  path: string
  /** Base order of the root, for interleaving with contributed sections. */
  order: number
  items: { commandId: string; labelKey: string; order: number }[]
}

/**
 * Reject a bad placement AT REGISTRATION, the way a duplicate command id is
 * rejected — not at popup time, where the module that caused it is long gone
 * from the stack.
 *
 * `taken` is the (path, order) slots already claimed, carried across modules by
 * the caller. A DUPLICATE ORDER WITHIN ONE PATH IS AN ERROR, for the reason the
 * seek-bar layers taught: `order` is the only thing deciding which item comes
 * first, so a tie silently hands the decision to module discovery order —
 * alphabetical directory order, which nobody chose and nothing documents.
 */
export function validateMenuPlacement(
  ownerId: string,
  commands: readonly MenuCommand[],
  taken: Map<string, string>
): void {
  for (const c of commands) {
    const path = c.menuPath
    if (path === undefined) {
      if (c.menuOrder !== undefined) {
        throw new ContributionError(
          `command '${c.id}' (${ownerId}) sets menuOrder ${c.menuOrder} but no menuPath, ` +
            `so it has no menu entry to order. Add a menuPath from: ` +
            `${MENU_ROOTS.map((r) => r.path).join(' ')}.`
        )
      }
      continue
    }
    if (c.internal) {
      throw new ContributionError(
        `command '${c.id}' (${ownerId}) is internal: true and also sets menuPath ` +
          `'${path}'. An internal command is a mediator — it is hidden from the ` +
          `keybind editor and the cheat sheet, and putting it in the menu contradicts ` +
          `that. Drop one of the two.`
      )
    }
    /**
     * EXACTLY ONE OF THE EIGHT ROOTS — no nesting. `menuPath: 'audio/devices'`
     * would need a label for the submenu, and the only place that label could
     * come from is an i18n key: a module may only register keys under its own id
     * (§ i18n namespace check), so a `core.menu.audio.devices` string is one the
     * module CANNOT provide. A submenu whose title is permanently the raw key is
     * not a feature. Nesting is what ctx.menu.contribute() is for; it carries
     * its own labelKey.
     */
    if (!ROOT_ORDER.has(path)) {
      const nested = path.includes('/')
      throw new ContributionError(
        `command '${c.id}' (${ownerId}) has menuPath '${path}', which is not one of the ` +
          `fixed menu roots: ${MENU_ROOTS.map((r) => r.path).join(' ')}. ` +
          (nested
            ? `menuPath does not nest — a submenu needs a title, and its i18n key would ` +
              `have to live in core's namespace. Use ctx.menu.contribute({ labelKey, ` +
              `items: [{ commandId: '${c.id}' }] }) for a submenu.`
            : `New roots are not allowed, for the same reason §7 fixes the eight settings ` +
              `sections.`)
      )
    }
    if (c.menuOrder === undefined) {
      throw new ContributionError(
        `command '${c.id}' (${ownerId}) has menuPath '${path}' but no menuOrder. ` +
          `Order is what decides which item comes first, and leaving it out makes the ` +
          `menu depend on module load order. Pick a number and record it in ` +
          `docs/parity/02-wave0-api.md.`
      )
    }
    const slot = `${path}#${c.menuOrder}`
    const clash = taken.get(slot)
    if (clash) {
      throw new ContributionError(
        `duplicate menu slot: '${clash}' and '${c.id}' (${ownerId}) both claim menuOrder ` +
          `${c.menuOrder} under menuPath '${path}'. order is the only thing deciding ` +
          `which comes first, so a tie makes the menu depend on module load order. ` +
          `Pick distinct orders and record them in docs/parity/02-wave0-api.md.`
      )
    }
    taken.set(slot, c.id)
  }
}

/**
 * The command-derived groups, in render order. Commands with no `menuPath` are
 * absent, as are internal ones.
 */
export function commandMenuGroups(commands: readonly MenuCommand[]): MenuGroup[] {
  const byPath = new Map<string, MenuGroup>()
  for (const c of commands) {
    if (!c.menuPath || c.internal) continue
    const order = ROOT_ORDER.get(c.menuPath)
    if (order === undefined) continue
    let group = byPath.get(c.menuPath)
    if (!group) {
      group = { path: c.menuPath, order, items: [] }
      byPath.set(c.menuPath, group)
    }
    group.items.push({ commandId: c.id, labelKey: c.labelKey, order: c.menuOrder ?? 0 })
  }
  for (const g of byPath.values()) g.items.sort((a, b) => a.order - b.order)
  return [...byPath.values()].sort(
    (a, b) => a.order - b.order || a.path.localeCompare(b.path)
  )
}

