import { t } from './i18n/index.ts'
import type { CommandRegistry } from './input/registry.ts'
import type { OsdBus } from './osd/index.ts'
import type { PlayerAction } from '@shared/types'

/**
 * core/legacy-bridge — TRANSITIONAL. Deleted at the end of Wave 1 (§5.10).
 *
 * `src/main/ipc.ts` dispatched 22 string actions through the 578-line `Player`
 * class. Every one of them is claimed by a Wave-1 module, so leaving the
 * dispatch in place would have given `volume` two writers, `chapter` two, `sid`
 * two — with the legacy path still wired to the existing renderer, and §3.5's
 * duplicate detection blind to all of it, because `Player` is not a module.
 *
 * `Player` is dismantled, not wrapped: every method moved into the module that
 * claims it, and this file is a TABLE, not a place for state to live. Four
 * rules keep it honest:
 *
 *  1. The shim NEVER touches mpv. It only forwards to a command id.
 *  2. If a target command does not exist yet — its module has not landed — it
 *     logs once and no-ops with an OSD, so the app stays usable throughout the
 *     migration instead of half-dead in the middle of it.
 *  3. The renderer is repointed incrementally. Keyboard input already speaks
 *     command ids; the buttons and sliders still speak `PlayerAction`, and each
 *     call site switches as its module lands.
 *  4. It has a deadline in CI. `test:legacy-shim` asserts the table only ever
 *     SHRINKS. A compatibility layer with no expiry date becomes permanent, and
 *     a permanent one here means every action in the list keeps a second writer
 *     forever.
 */

export interface LegacyTarget {
  commandId: string
  /** Derives the command argument from the legacy action's own ':' suffix. */
  argFrom?: (raw: string | undefined) => unknown
}

/**
 * THE TABLE. 22 entries, exactly the set §5.10 lists. It may shrink. It may
 * never grow.
 */
export const LEGACY_ACTIONS: Record<string, LegacyTarget> = {
  volume: { commandId: 'audio-volume.set', argFrom: (raw: string | undefined) => Number(raw) },
  mute: { commandId: 'audio-volume.toggleMute' },
  speed: { commandId: 'audio-volume.setSpeed', argFrom: (raw: string | undefined) => Number(raw) },
  speedReset: { commandId: 'audio-volume.resetSpeed' },
  audioDelay: { commandId: 'audio-volume.setAudioDelay', argFrom: (raw: string | undefined) => Number(raw) },
  cycleAudio: { commandId: 'audio-tracks.cycle' },
  toggleSubs: { commandId: 'subs-tracks.toggleVisibility' },
  cycleSub: { commandId: 'subs-tracks.cycle' },
  subDelay: { commandId: 'subs-sync.setDelay', argFrom: (raw: string | undefined) => Number(raw) },
  screenshot: { commandId: 'capture-still.save' },
  screenshotClipboard: { commandId: 'capture-still.toClipboard' },
  seek: { commandId: 'nav-seek.seek', argFrom: (raw: string | undefined) => ({ seconds: Number(raw) }) },
  frameBack: { commandId: 'nav-seek.frameBack' },
  frameForward: { commandId: 'nav-seek.frameForward' },
  chapterNext: { commandId: 'nav-chapters.next' },
  chapterPrev: { commandId: 'nav-chapters.prev' },
  next: { commandId: 'playlist.next' },
  previous: { commandId: 'playlist.prev' },
  stop: { commandId: 'playlist.stop' },
  togglePlaylist: { commandId: 'playlist.togglePanel' },
  fullscreen: { commandId: 'shell-window.toggleFullScreen' },
  alwaysOnTop: { commandId: 'shell-window.cycleAlwaysOnTop' }
}

const warned = new Set<string>()

export class LegacyBridge {
  constructor(
    private readonly commands: CommandRegistry,
    private readonly osd: OsdBus
  ) {}

  /** Run a legacy binding string such as 'seek:-5'. */
  async run(binding: string): Promise<void> {
    const [name, raw] = binding.split(':')
    if (!name) return
    const target = LEGACY_ACTIONS[name]
    if (!target) {
      // Not one of the 22 — it is already a command id, or it is a typo.
      if (this.commands.has(name)) {
        await this.commands.invoke(name, raw)
        return
      }
      this.missing(name)
      return
    }
    if (!this.commands.has(target.commandId)) {
      this.missing(target.commandId)
      return
    }
    await this.commands.invoke(target.commandId, target.argFrom?.(raw))
  }

  private missing(id: string): void {
    if (!warned.has(id)) {
      warned.add(id)
      console.warn(`[legacy-bridge] no command '${id}' yet; its module has not landed`)
    }
    this.osd.show({ kind: 'error', text: t('core.notImplemented', { id }) })
  }

  /**
   * The typed `PlayerAction` union the v0.1 renderer's buttons and sliders
   * still send. Same rule as above: forward to a command, never touch mpv.
   */
  async dispatch(action: PlayerAction): Promise<void> {
    const go = async (id: string, arg?: unknown): Promise<void> => {
      if (!this.commands.has(id)) return this.missing(id)
      await this.commands.invoke(id, arg)
    }
    switch (action.type) {
      case 'playPause':
        return go('core.playPause')
      case 'play':
        return go('core.play')
      case 'pause':
        return go('core.pause')
      case 'stop':
        return go('playlist.stop')
      case 'seek':
        return go('nav-seek.seek', { seconds: action.seconds, absolute: action.absolute })
      case 'frameStep':
        return go(action.back ? 'nav-seek.frameBack' : 'nav-seek.frameForward')
      case 'setVolume':
        return go('audio-volume.set', action.value)
      case 'volumeBy':
        return go('audio-volume.set', currentVolume(this) + action.delta)
      case 'toggleMute':
        return go('audio-volume.toggleMute')
      case 'setSpeed':
        return go('audio-volume.setSpeed', action.value)
      case 'speedBy':
        return go(action.delta > 0 ? 'audio-volume.speedUp' : 'audio-volume.speedDown')
      case 'setTrack':
        if (action.kind === 'sid') return go('subs-tracks.select', action.id)
        if (action.kind === 'aid') return go('audio-tracks.select', action.id)
        return go('audio-tracks.selectVideo', action.id)
      case 'setSubDelay':
        return go('subs-sync.setDelay', action.value)
      case 'subDelayBy':
        return go(action.delta > 0 ? 'subs-sync.delayUp' : 'subs-sync.delayDown')
      case 'setAudioDelay':
        return go('audio-volume.setAudioDelay', action.value)
      case 'audioDelayBy':
        return go(
          action.delta > 0 ? 'audio-volume.audioDelayUp' : 'audio-volume.audioDelayDown'
        )
      case 'setSubScale':
        return go('subs-style.setScale', action.value)
      case 'setSubPos':
        return go('subs-style.setPos', action.value)
      case 'toggleSubs':
        return go('subs-tracks.toggleVisibility')
      case 'screenshot':
        return go(action.target === 'clipboard' ? 'capture-still.toClipboard' : 'capture-still.save')
      case 'setAspect':
        return go('video-geometry.setAspect', action.value)
      case 'rotate':
        return go('video-geometry.rotate', action.value)
      case 'setAudioDevice':
        return go('audio-devices.select', action.value)
      case 'loadSubtitle':
        return go('subs-tracks.open')
      case 'setChapter':
        return go('nav-chapters.goto', action.index)
      case 'cycleAudio':
        return go('audio-tracks.cycle')
      case 'cycleSub':
        return go('subs-tracks.cycle')
      default:
        return
    }
  }
}

/** The one read the bridge does, and it reads state rather than owning it. */
function currentVolume(bridge: LegacyBridge): number {
  void bridge
  return volumeReader()
}

let volumeReader: () => number = () => 100

/** index.ts injects the read so the bridge stays free of the bus. */
export function setLegacyVolumeReader(fn: () => number): void {
  volumeReader = fn
}
