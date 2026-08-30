import { ContributionError } from '../errors.ts'
import { validateMenuPlacement } from '../menu-model.ts'
// Relative, not '@shared/...': this file is unit-tested under `node --test`,
// which strips types but does not know the bundler's path aliases.
import { normalizeAccel } from '../../../shared/input/accel.ts'
import type {
  Accel,
  CommandDescriptor,
  CommandId,
  CommandScope,
  PresetName
} from '@shared/feature-api'

/**
 * core/input — the command registry and the DERIVED keybind presets (§5.4).
 * WAVE 0 — FROZEN.
 *
 * There is no hand-written preset table anywhere. Every command carries its own
 * per-preset defaults and a preset is the fold of them, which is the only way
 * "adding a feature means adding a directory" can hold for keybinds: a module
 * that ships a new command ships its Default/PotPlayer/mpv bindings with it,
 * and all three presets grow without anyone editing a shared file.
 *
 * P18: storage is `Record<CommandId, Accel[]>` — one command, many keys —
 * rather than `Record<Accel, action>`. The accel→command lookup the renderer
 * needs is DERIVED from it. Storing it the other way round makes "what is F9
 * bound to" easy and "what keys run screenshot" impossible, and the second
 * question is the one a rebinding UI asks.
 */

export interface KeybindFile extends Record<string, unknown> {
  preset: PresetName
  /** User overrides only. A command absent here uses its preset defaults. */
  bindings: Record<CommandId, Accel[]>
}

export interface KeybindBacking {
  read(): KeybindFile
  write(patch: Partial<KeybindFile>): void
}

export interface Conflict {
  accel: Accel
  scope: CommandScope
  commandIds: CommandId[]
}

export class CommandRegistry {
  private readonly commands = new Map<CommandId, CommandDescriptor>()
  private readonly owners = new Map<CommandId, string>()
  /**
   * `menuPath#menuOrder` -> the command that claimed it. Carried across modules
   * so two modules cannot claim one menu slot; see core/menu-model.ts.
   */
  private readonly menuSlots = new Map<string, string>()

  private readonly backing: KeybindBacking

  constructor(backing: KeybindBacking) {
    this.backing = backing
  }

  register(ownerId: string, descriptors: readonly CommandDescriptor[]): void {
    for (const d of descriptors) {
      if (!d.id.startsWith(`${ownerId}.`)) {
        throw new ContributionError(
          `module '${ownerId}' registered command '${d.id}', which is outside its namespace. ` +
            `Command ids must start with '${ownerId}.' (Appendix A).`
        )
      }
      const existing = this.owners.get(d.id)
      if (existing) {
        throw new ContributionError(
          `duplicate command id '${d.id}': registered by both '${existing}' and '${ownerId}'.`
        )
      }
      this.owners.set(d.id, ownerId)
      this.commands.set(d.id, d)
    }
    // menuPath/menuOrder are checked here, not at popup time: a bad placement is
    // a contribution error and must name the module that made it.
    validateMenuPlacement(ownerId, descriptors, this.menuSlots)
  }

  has(id: CommandId): boolean {
    return this.commands.has(id)
  }

  get(id: CommandId): CommandDescriptor | undefined {
    return this.commands.get(id)
  }

  all(): readonly CommandDescriptor[] {
    return [...this.commands.values()]
  }

  ownerOf(id: CommandId): string | undefined {
    return this.owners.get(id)
  }

  async invoke(id: CommandId, arg?: unknown): Promise<void> {
    await this.query(id, arg)
  }

  async query<T>(id: CommandId, arg?: unknown): Promise<T> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      // No silent no-ops: a typo'd mediator id must show up as a stack trace
      // with a name in it, not as a feature that quietly does nothing.
      throw new Error(`unknown command '${id}'`)
    }
    return (await cmd.run(arg)) as T
  }

  // --- presets -----------------------------------------------------------

  preset(): PresetName {
    return this.backing.read().preset
  }

  setPreset(preset: PresetName): void {
    this.backing.write({ preset })
  }

  /** The fold: every registered command's defaults for one preset. */
  presetBindings(preset: PresetName): Record<CommandId, Accel[]> {
    const out: Record<CommandId, Accel[]> = {}
    for (const cmd of this.commands.values()) {
      const accels = cmd.defaults?.[preset]
      if (accels && accels.length > 0) out[cmd.id] = accels.map(normalizeAccel)
    }
    return out
  }

  /** Preset defaults with the user's own overrides layered on top. */
  effectiveBindings(): Record<CommandId, Accel[]> {
    const file = this.backing.read()
    const out = this.presetBindings(file.preset)
    for (const [id, accels] of Object.entries(file.bindings ?? {})) {
      if (!Array.isArray(accels)) continue
      if (accels.length === 0) delete out[id]
      else out[id] = accels.map(normalizeAccel)
    }
    return out
  }

  setBinding(id: CommandId, accels: readonly Accel[]): void {
    const file = this.backing.read()
    this.backing.write({ bindings: { ...file.bindings, [id]: accels.map(normalizeAccel) } })
  }

  clearOverrides(): void {
    this.backing.write({ bindings: {} })
  }

  /**
   * accel → command, for the overlay's keydown handler. Scope-aware: two
   * commands may share a key if they can never be live at the same time.
   */
  resolve(scope: CommandScope = 'player'): Record<Accel, CommandId> {
    const out: Record<Accel, CommandId> = {}
    for (const [id, accels] of Object.entries(this.effectiveBindings())) {
      const cmd = this.commands.get(id)
      if (!cmd) continue
      const cmdScope = cmd.scope ?? 'player'
      if (cmdScope !== 'global' && cmdScope !== scope) continue
      for (const accel of accels) out[accel] = id
    }
    return out
  }

  /** P15. Scope-aware, and it reports rather than resolving: a conflict the
   *  user created deliberately is their business, but they must be told. */
  conflicts(): Conflict[] {
    const byKey = new Map<string, { scope: CommandScope; ids: CommandId[] }>()
    for (const [id, accels] of Object.entries(this.effectiveBindings())) {
      const scope = this.commands.get(id)?.scope ?? 'player'
      for (const accel of accels) {
        const key = `${scope} :: ${accel}`
        let entry = byKey.get(key)
        if (!entry) {
          entry = { scope, ids: [] }
          byKey.set(key, entry)
        }
        entry.ids.push(id)
      }
    }
    const out: Conflict[] = []
    for (const [key, entry] of byKey) {
      if (entry.ids.length < 2) continue
      out.push({ accel: key.split(' :: ')[1] ?? '', scope: entry.scope, commandIds: entry.ids })
    }
    return out
  }
}
