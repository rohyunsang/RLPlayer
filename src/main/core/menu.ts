import { Menu, type MenuItemConstructorOptions } from 'electron'
import { ContributionError } from './errors.ts'
import { t } from './i18n/index.ts'
import type { CommandRegistry } from './input/registry.ts'
import { getVideoWindow } from './window/windows'
import { commandMenuGroups } from './menu-model.ts'
import type { MenuNode, MenuService } from '@shared/feature-api'

/**
 * core/menu — the contributed menu (§3.3.5). WAVE 0 — FROZEN.
 *
 * A native menu, not an HTML one: it renders above mpv's child HWND without any
 * of the overlay's z-order caveats. Built fresh on every popup so track lists
 * and toggles reflect current state.
 *
 * The legacy `src/main/menu.ts` hardcoded every item and reached straight into
 * `Player`. It is gone: each item now arrives from the module that owns the
 * behaviour behind it, which is why adding a feature never means editing a menu.
 */

interface Section {
  ownerId: string
  id: string
  parent?: string
  labelKey: string
  order: number
  items: readonly MenuNode[]
  replaces?: readonly string[]
}

export class MenuRegistry {
  private readonly sections: Section[] = []
  private readonly ids = new Set<string>()

  private readonly commands: CommandRegistry

  constructor(commands: CommandRegistry) {
    this.commands = commands
  }

  contribute(ownerId: string, section: Omit<Section, 'ownerId'>): void {
    const id = section.id
    if (!id.startsWith(`${ownerId}.`) && !id.startsWith(ownerId)) {
      throw new ContributionError(
        `module '${ownerId}' contributed menu section '${id}', which is outside its namespace.`
      )
    }
    if (this.ids.has(id)) {
      throw new ContributionError(`duplicate menu section id '${id}'.`)
    }
    /**
     * A DUPLICATE `order` WITHIN ONE PARENT IS REJECTED TOO, and this one was
     * already live: `nav-chapters.menu` and `nav-thumbnails.menu` both
     * contributed at order 45, so which of the two appeared first in the context
     * menu was decided by feature discovery order — alphabetical directory
     * order, which nobody chose and nothing documented. Found by auditing every
     * cross-module ordering namespace after the seek-bar layers collided at 10.
     *
     * Scoped to `parent`, because sections under different parents are never
     * sorted against each other.
     */
    const clash = this.sections.find(
      (s) => s.order === section.order && (s.parent ?? '') === (section.parent ?? '')
    )
    if (clash) {
      throw new ContributionError(
        `duplicate menu section order ${section.order}${
          section.parent ? ` under '${section.parent}'` : ''
        }: '${clash.id}' (${clash.ownerId}) and '${id}' (${ownerId}). order is the only thing ` +
          `deciding which comes first, so a tie makes the menu depend on module load order. ` +
          `Pick distinct orders and record them in docs/parity/02-wave0-api.md.`
      )
    }
    this.ids.add(id)
    this.sections.push({ ...section, ownerId })
  }

  createService(ownerId: string): MenuService {
    return { contribute: (s) => this.contribute(ownerId, s) }
  }

  buildTemplate(): MenuItemConstructorOptions[] {
    const removed = new Set<string>()
    for (const s of this.sections) for (const r of s.replaces ?? []) removed.add(r)

    /**
     * Two contribution mechanisms, ONE ordering space. A contributed section
     * carries an explicit `order`; a `menuPath` group takes its root's base
     * order from MENU_ROOTS. Merging them here rather than appending one after
     * the other is what makes `menuPath` a first-class placement instead of a
     * second-rate one — an `audio` command lands next to the audio section, not
     * in a lump at the bottom.
     */
    const blocks: {
      order: number
      /** 0 = a contributed section, 1 = a command-derived root. See the sort. */
      kind: 0 | 1
      key: string
      render: () => MenuItemConstructorOptions[]
    }[] = []

    for (const section of this.sections.filter((s) => !removed.has(s.id) && !s.parent)) {
      blocks.push({
        order: section.order,
        kind: 0,
        key: section.id,
        render: () => {
          const children = this.sections
            .filter((s) => s.parent === section.id && !removed.has(s.id))
            .sort((a, b) => a.order - b.order)
          const items = [...section.items, ...children.flatMap((c) => c.items)]
          return items.flatMap((n) => this.node(n))
        }
      })
    }

    for (const group of commandMenuGroups(this.commands.all())) {
      blocks.push({
        order: group.order,
        kind: 1,
        key: group.path,
        render: () =>
          group.items
            .map((i) => ({ commandId: i.commandId }) as MenuNode)
            .flatMap((n) => this.node(n))
      })
    }

    /**
     * THE TIE-BREAK, MADE EXPLICIT — and it was load-order-dependent before.
     *
     * `MenuRegistry.contribute()` rejects two SECTIONS sharing an order under one
     * parent, and nothing compares a section against a command-derived ROOT, whose
     * base order comes from `MENU_ROOTS` in the same space. Seven such ties exist
     * in the shipped tree: `playlist.menuOpen` 10 = root `playback`,
     * `core.playback` 20 = root `video`, `playlist.menuQueue` 30 = root `audio`,
     * `audio-tracks.menu` 40 = root `subtitles`, `video-geometry.menu` 50 = root
     * `navigate`, `capture-still.menu` 60 = root `capture`,
     * `shell-window.menu` 70 = root `window`.
     *
     * `Array.prototype.sort` is stable, so before this the tie fell to insertion
     * order: every section first, in `this.sections` order, which is the order the
     * registry set the modules up in, which is `import.meta.glob`'s directory
     * order. That is precisely the "an ordering nobody chose" this file's own
     * duplicate-order error message refuses for sections.
     *
     * (order, kind, key) is total, independent of load order, and reproduces
     * today's rendering exactly: sections came before roots at a tie then, and
     * `kind` keeps them there. `docs/parity/modules.json` now records each tie as
     * `tiesRoot` on the claim, and `npm run check:ordering` fails on a NEW,
     * undeclared one.
     */
    blocks.sort((a, b) => a.order - b.order || a.kind - b.kind || a.key.localeCompare(b.key))

    const out: MenuItemConstructorOptions[] = []
    for (const block of blocks) {
      const rendered = block.render()
      if (rendered.length === 0) continue
      if (out.length > 0) out.push({ type: 'separator' })
      out.push(...rendered)
    }
    return out
  }

  private node(n: MenuNode): MenuItemConstructorOptions[] {
    if ('type' in n && n.type === 'separator') return [{ type: 'separator' }]
    if ('dynamic' in n && typeof n.dynamic === 'function') {
      return n.dynamic().flatMap((child) => this.node(child))
    }
    const item = n as Exclude<MenuNode, { type: 'separator' } | { dynamic(): readonly MenuNode[] }>
    const cmd = item.commandId ? this.commands.get(item.commandId) : undefined
    const label = item.label ?? (item.labelKey ? t(item.labelKey) : cmd ? t(cmd.labelKey) : '')
    if (!label) return []

    const options: MenuItemConstructorOptions = { label }
    if (item.submenu) options.submenu = item.submenu.flatMap((c) => this.node(c))
    if (item.checked !== undefined) {
      options.type = item.radio ? 'radio' : 'checkbox'
      options.checked = item.checked
    }
    if (item.enabled !== undefined) options.enabled = item.enabled
    else if (cmd?.enabledWhen) options.enabled = cmd.enabledWhen()

    if (item.commandId) {
      const id = item.commandId
      const arg = item.arg
      options.click = (): void => {
        void this.commands.invoke(id, arg).catch((e: Error) => {
          console.error(`[menu] ${id} failed:`, e.message)
        })
      }
      const accel = this.accelFor(id)
      if (accel) {
        options.accelerator = accel
        // Display only. The overlay owns key handling; letting Electron bind
        // these would double-fire every shortcut.
        options.registerAccelerator = false
      }
    }
    return [options]
  }

  private accelFor(commandId: string): string | undefined {
    const accels = this.commands.effectiveBindings()[commandId]
    const first = accels?.[0]
    return first ? toElectronAccelerator(first) : undefined
  }

  popup(x?: number, y?: number): void {
    const win = getVideoWindow()
    if (!win) return
    const menu = Menu.buildFromTemplate(this.buildTemplate())
    menu.popup({ window: win, ...(x !== undefined && y !== undefined ? { x, y } : {}) })
  }
}

const CODE_TO_ELECTRON: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/'
}

/** Physical accel → Electron's display accelerator. Returns '' when there is
 *  no equivalent (mouse and wheel bindings), which the caller drops. */
export function toElectronAccelerator(accel: string): string {
  const parts = accel.split('+')
  const base = parts.pop() ?? ''
  let key = CODE_TO_ELECTRON[base]
  if (!key && /^Key[A-Z]$/.test(base)) key = base.slice(3)
  if (!key && /^Digit\d$/.test(base)) key = base.slice(5)
  if (!key && /^F\d{1,2}$/.test(base)) key = base
  if (!key) return ''
  return [...parts, key].join('+')
}
