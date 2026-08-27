import { Menu, type MenuItemConstructorOptions } from 'electron'
import { ContributionError } from './errors.ts'
import { t } from './i18n/index.ts'
import type { CommandRegistry } from './input/registry.ts'
import { getVideoWindow } from './window/windows'
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

  constructor(private readonly commands: CommandRegistry) {}

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
    this.ids.add(id)
    this.sections.push({ ...section, ownerId })
  }

  createService(ownerId: string): MenuService {
    return { contribute: (s) => this.contribute(ownerId, s) }
  }

  buildTemplate(): MenuItemConstructorOptions[] {
    const removed = new Set<string>()
    for (const s of this.sections) for (const r of s.replaces ?? []) removed.add(r)

    const ordered = this.sections
      .filter((s) => !removed.has(s.id) && !s.parent)
      .sort((a, b) => a.order - b.order)

    const out: MenuItemConstructorOptions[] = []
    for (const section of ordered) {
      const children = this.sections
        .filter((s) => s.parent === section.id && !removed.has(s.id))
        .sort((a, b) => a.order - b.order)
      const items = [...section.items, ...children.flatMap((c) => c.items)]
      const rendered = items.flatMap((n) => this.node(n))
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
