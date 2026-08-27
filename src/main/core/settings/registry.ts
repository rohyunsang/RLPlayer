import { ContributionError } from '../errors.ts'
import type { SettingDescriptor, SettingId, Unsubscribe } from '@shared/feature-api'

/**
 * core/settings/registry — descriptor registry (§5.2). WAVE 0 — FROZEN.
 *
 * Values live in ONE `Record<SettingId, unknown>`; a missing key resolves to
 * the descriptor's default. That is what makes "only persist what changed"
 * (P51) work for global settings too, and it is why the settings UI can be
 * generated with no knowledge of any module.
 */

export interface ValueBacking {
  read(): Record<string, unknown>
  write(values: Record<string, unknown>): void
}

type Listener = (v: unknown, prev: unknown) => void

export class SettingsRegistry {
  private readonly descriptors = new Map<SettingId, SettingDescriptor>()
  private readonly owners = new Map<SettingId, string>()
  private readonly listeners = new Map<SettingId, Set<Listener>>()
  private values: Record<string, unknown>

  private readonly backing: ValueBacking

  constructor(backing: ValueBacking) {
    this.backing = backing
    this.values = { ...backing.read() }
  }

  define(ownerId: string, descriptors: readonly SettingDescriptor[]): void {
    for (const d of descriptors) {
      if (!d.id.startsWith(`${ownerId}.`)) {
        throw new ContributionError(
          `module '${ownerId}' defined setting '${d.id}', which is outside its namespace. ` +
            `Setting ids must start with '${ownerId}.' (Appendix A).`
        )
      }
      const existing = this.owners.get(d.id)
      if (existing) {
        throw new ContributionError(
          `duplicate setting id '${d.id}': claimed by both '${existing}' and '${ownerId}'.`
        )
      }
      this.owners.set(d.id, ownerId)
      this.descriptors.set(d.id, d)
    }
  }

  has(id: SettingId): boolean {
    return this.descriptors.has(id)
  }

  descriptor(id: SettingId): SettingDescriptor | undefined {
    return this.descriptors.get(id)
  }

  listAll(): readonly SettingDescriptor[] {
    return [...this.descriptors.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id)
    )
  }

  get<T>(id: SettingId): T {
    if (id in this.values) return this.values[id] as T
    const d = this.descriptors.get(id)
    if (!d) {
      throw new ContributionError(
        `unknown setting '${id}'. Every id must be declared with settings.define() first.`
      )
    }
    return d.default as T
  }

  set<T>(id: SettingId, value: T): void {
    const prev = this.get<T>(id)
    if (Object.is(prev, value)) return
    const d = this.descriptors.get(id)
    // P51: a value equal to the default is REMOVED, not stored, so a later
    // default change still reaches users who never touched the setting.
    if (d && Object.is(d.default, value)) delete this.values[id]
    else this.values[id] = value
    this.backing.write(this.values)
    for (const cb of this.listeners.get(id) ?? []) {
      try {
        cb(value, prev)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  onChange<T>(id: SettingId, cb: (v: T, prev: T) => void): Unsubscribe {
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(cb as Listener)
    return () => set?.delete(cb as Listener)
  }

  /** Everything the settings UI needs, without it importing any module. */
  snapshot(): Array<{ descriptor: SettingDescriptor; value: unknown }> {
    return this.listAll().map((d) => ({ descriptor: d, value: this.get(d.id) }))
  }

  /** Re-read after an external write (settings window, import). */
  refresh(): void {
    this.values = { ...this.backing.read() }
  }
}
