import { ipcMain, type BrowserWindow } from 'electron'
import { ContributionError } from './errors.ts'
import type { IpcChannel, IpcService } from '@shared/feature-api'

/**
 * core/ipc — the main half of the generic, namespace-validated bridge
 * (§3.3.4). WAVE 0 — FROZEN.
 *
 * `src/preload/index.ts` exposes ONE generic `rl.invoke/send/on`. That regex in
 * the preload is a shape check, not the security boundary; THIS file is the
 * boundary. A channel exists only because a module registered it under its own
 * id, and `ipcMain` has no handler for anything else, so a compromised renderer
 * cannot reach a channel nobody published.
 *
 * Nobody edits `preload/index.ts` again. That was the point.
 */

const CHANNEL_RE = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/

export type WindowLookup = (target: 'ui' | 'settings' | 'all') => BrowserWindow[]

export class FeatureIpc {
  private readonly channels = new Map<IpcChannel, string>()

  private readonly windows: WindowLookup

  constructor(windows: WindowLookup) {
    this.windows = windows
  }

  private claim(ownerId: string, channel: IpcChannel): void {
    if (!CHANNEL_RE.test(channel)) {
      throw new ContributionError(
        `module '${ownerId}' registered IPC channel '${channel}', which is malformed. ` +
          `Channels are '<feature-id>:<verb>'.`
      )
    }
    if (!channel.startsWith(`${ownerId}:`)) {
      throw new ContributionError(
        `module '${ownerId}' registered IPC channel '${channel}', which is outside its namespace. ` +
          `Channels must start with '${ownerId}:' (Appendix A).`
      )
    }
    const existing = this.channels.get(channel)
    if (existing) {
      throw new ContributionError(
        `duplicate IPC channel '${channel}': registered by both '${existing}' and '${ownerId}'.`
      )
    }
    this.channels.set(channel, ownerId)
  }

  /** Every channel a module actually registered — the allowlist. */
  registered(): readonly IpcChannel[] {
    return [...this.channels.keys()].sort()
  }

  createService(ownerId: string): IpcService {
    const self = this
    return {
      handle<Req, Res>(channel: IpcChannel, fn: (req: Req) => Res | Promise<Res>): void {
        self.claim(ownerId, channel)
        ipcMain.handle(channel, (_e, req: Req) => fn(req))
      },
      on<Req>(channel: IpcChannel, fn: (req: Req) => void): void {
        self.claim(ownerId, channel)
        ipcMain.on(channel, (_e, req: Req) => fn(req))
      },
      send<T>(channel: IpcChannel, payload: T, target: 'ui' | 'settings' | 'all' = 'ui'): void {
        if (!CHANNEL_RE.test(channel) || !channel.startsWith(`${ownerId}:`)) {
          throw new ContributionError(
            `module '${ownerId}' pushed on '${channel}', which is outside its namespace.`
          )
        }
        for (const win of self.windows(target)) {
          if (!win.isDestroyed()) win.webContents.send(channel, payload)
        }
      }
    }
  }
}
