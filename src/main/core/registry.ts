import { ContributionError } from './errors.ts'
import { validateIds, topoSort, type DiscoveredModule } from './registry-order.ts'
import { CORE_OWNERSHIP, OwnerMap } from './mpv/ownership.ts'
import { vfChain, createVfService } from './mpv/vf-chain.ts'
import { afChain, createAfService } from './mpv/af-chain.ts'
import type { MpvBus } from './mpv/bus.ts'
import { createI18nService, t } from './i18n/index.ts'
import { createWindowService, releaseSleepBlocksFor } from './window/index.ts'
import { createDialogService } from './dialog.ts'
import { createNetworkService } from './no-network.ts'
import { pathService } from './paths.ts'
import type { SettingsRegistry } from './settings/registry.ts'
import type { CommandRegistry } from './input/registry.ts'
import type { FeatureIpc } from './ipc.ts'
import type { OsdBus } from './osd/index.ts'
import type { PerFileManager } from './state/per-file.ts'
import type { MenuRegistry } from './menu.ts'
import type { FeatureContext, FeatureModule, Logger } from '@shared/feature-api'

/**
 * core/registry — module discovery, dependency order, namespace enforcement,
 * isolation (§3.5). WAVE 0 — FROZEN.
 *
 * The asymmetry in §3.5 rule 7 is deliberate and is implemented literally
 * below: a COLLISION (duplicate property, duplicate command, duplicate channel,
 * bad namespace, arg clash, dependency cycle) throws out of the isolation
 * try/catch and the app refuses to start, because it is a programming error CI
 * must catch. A RUNTIME failure inside one module's setup() disables that
 * module, logs loudly, shows one toast, and lets the app start — one broken
 * feature must never black-screen the player.
 */

export interface RegistryDeps {
  /**
   * THE bus, created once in `src/main/index.ts` and handed here.
   *
   * It used to be an imported singleton, which meant every feature module
   * could import it too and mint itself a service under any id it liked. The
   * registry is now the only holder, and `contextFor()` below is the only
   * place a service is ever minted.
   */
  mpv: MpvBus
  settings: SettingsRegistry
  commands: CommandRegistry
  ipc: FeatureIpc
  osd: OsdBus
  perFile: PerFileManager
  menu: MenuRegistry
  toast(message: string, kind: 'info' | 'error'): void
}

export interface LoadedModule extends DiscoveredModule {
  module: FeatureModule
  ok: boolean
  error?: string
}

export class Registry {
  private readonly loaded: LoadedModule[] = []
  private readonly quitHooks: Array<() => void | Promise<void>> = []
  private readonly readyHooks: Array<() => void> = []
  private readonly processes = new Set<{ pid?: number | undefined; kill(s?: string): boolean }>()
  private owners: OwnerMap | null = null

  private readonly deps: RegistryDeps

  constructor(deps: RegistryDeps) {
    this.deps = deps
    // The chains get their raw exec from the bus, in a closure. This is the
    // only call site, and `chainExec` is private to the bus.
    deps.mpv.registerChain(vfChain)
    deps.mpv.registerChain(afChain)
  }

  ownerMap(): OwnerMap | null {
    return this.owners
  }

  modules(): readonly LoadedModule[] {
    return this.loaded
  }

  async loadAll(discovered: readonly { dir: string; module: FeatureModule }[]): Promise<void> {
    const specs: (DiscoveredModule & { module: FeatureModule })[] = discovered.map((d) => ({
      dir: d.dir,
      id: d.module.id,
      dependsOn: d.module.dependsOn,
      module: d.module
    }))

    // 1. Static checks. Every one of these fails the boot.
    validateIds(specs)
    const ordered = topoSort(specs)

    // 2. The property owner map (§3.7). Two modules claiming one property is a
    //    boot error naming both, in the same breath as a duplicate command id.
    this.owners = new OwnerMap([...CORE_OWNERSHIP, ...ordered.map((s) => s.module)])
    // The id list is what `createService` checks against: a service can only be
    // minted for a module the registry actually loaded.
    this.deps.mpv.setOwnerMap(this.owners, ordered.map((s) => s.id))

    // 3. Filter labels, same duplicate detection.
    for (const s of ordered) {
      const labels = s.module.ownsFilterLabels ?? []
      const vf = labels.filter((l) => l.startsWith('rl-'))
      const af = labels.filter((l) => !l.startsWith('rl-'))
      if (vf.length) vfChain.claim(s.id, vf)
      if (af.length) afChain.claim(s.id, af)
    }

    // 4. setup(), in dependency order, isolated.
    for (const s of ordered) {
      const entry: LoadedModule = { dir: s.dir, id: s.id, module: s.module, ok: false }
      this.loaded.push(entry)
      try {
        await s.module.setup(this.contextFor(s.module))
        entry.ok = true
      } catch (e) {
        if (e instanceof ContributionError) throw e
        entry.error = (e as Error).message
        console.error(`[registry] module '${s.id}' setup failed:`, e)
        this.deps.toast(t('core.moduleFailed', { id: s.id }), 'error')
      }
    }

    // 5. Spawn-arg disjointness, once every contributor has registered.
    this.deps.mpv.validateContributions()

    // 6. A property written in the spec's mappings that nobody claims is a
    //    warning, not a failure — that is how "`vid` has no owner at all" was
    //    found, and a warning is what makes the next one findable too.
    this.warnUnowned()
  }

  private warnUnowned(): void {
    const owned = new Set(this.owners?.entries().map((e) => e.property) ?? [])
    const expected = ['pause', 'volume', 'mute', 'speed', 'aid', 'sid', 'vid']
    const missing = expected.filter((p) => !owned.has(p) && !this.owners?.ownerOf(p))
    if (missing.length > 0) {
      console.warn(`[registry] mpv properties with no owner: ${missing.join(', ')}`)
    }
  }

  private logger(id: string): Logger {
    return {
      info: (...a) => console.log(`[${id}]`, ...a),
      warn: (...a) => console.warn(`[${id}]`, ...a),
      error: (...a) => console.error(`[${id}]`, ...a)
    }
  }

  private contextFor(mod: FeatureModule): FeatureContext {
    const id = mod.id
    const registry = this
    const ctx: FeatureContext = {
      id,
      log: this.logger(id),
      paths: pathService,
      mpv: registry.deps.mpv.createService(id),
      settings: {
        define: (d) => registry.deps.settings.define(id, d),
        get: (sid) => registry.deps.settings.get(sid),
        set: (sid, v) => registry.deps.settings.set(sid, v),
        onChange: (sid, cb) => registry.deps.settings.onChange(sid, cb),
        migrate: () => {
          /* module-local migrations run inside the config store's chain */
        }
      },
      commands: {
        register: (c) => registry.deps.commands.register(id, c),
        invoke: (cid, arg) => registry.deps.commands.invoke(cid, arg),
        query: (cid, arg) => registry.deps.commands.query(cid, arg),
        has: (cid) => registry.deps.commands.has(cid)
      },
      ipc: this.deps.ipc.createService(id),
      osd: this.deps.osd.createService(t),
      perFile: this.deps.perFile.createService(id),
      menu: this.deps.menu.createService(id),
      i18n: createI18nService(id),
      lifecycle: {
        onReady: (cb) => registry.readyHooks.push(cb),
        onQuit: (cb) => registry.quitHooks.push(cb),
        trackProcess: (p) => registry.processes.add(p)
      },
      window: createWindowService(id),
      dialog: createDialogService(),
      network: createNetworkService(id)
    }
    // vf/af are granted only to modules that declared they need them, so an
    // accidental `ctx.vf!.set(...)` in a module that never declared it is a
    // type error and then a crash in dev, not a silent chain write.
    if (mod.usesVideoFilters) (ctx as { vf?: unknown }).vf = createVfService(id)
    if (mod.usesAudioFilters) (ctx as { af?: unknown }).af = createAfService(id)
    return ctx
  }

  fireReady(): void {
    for (const cb of this.readyHooks) {
      try {
        cb()
      } catch (e) {
        console.error('[registry] onReady hook threw:', (e as Error).message)
      }
    }
  }

  async dispose(): Promise<void> {
    for (const hook of this.quitHooks) {
      try {
        await hook()
      } catch (e) {
        console.error('[registry] onQuit hook threw:', (e as Error).message)
      }
    }
    for (const entry of this.loaded) {
      releaseSleepBlocksFor(entry.id)
      try {
        await entry.module.dispose?.()
      } catch (e) {
        console.error(`[registry] '${entry.id}' dispose threw:`, (e as Error).message)
      }
    }
    // Tracked children are killed even if dispose() threw: an orphaned encoder
    // holding a file handle is worse than a noisy log line.
    for (const p of this.processes) {
      try {
        p.kill()
      } catch {
        /* already gone */
      }
    }
    this.processes.clear()
  }
}
