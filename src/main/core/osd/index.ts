import type { OsdKind, OsdService, ProgressHandle } from '@shared/feature-api'

/**
 * core/osd — one OSD surface, one toast surface (§5.6). WAVE 0 — FROZEN.
 *
 * We run mpv with `--osd-level=0 --no-osd-bar --osc=no`, so the OVERLAY owns
 * 100% of the OSD and mpv's `show-text` is a debugging fallback only. Mixing
 * the two looks broken, which is why no module is given a way to reach it.
 *
 * `show()` coalesces by `kind` in the renderer, so dragging the volume slider
 * produces one updating OSD element and not forty stacked ones. The per-kind
 * enable/disable from config (U04/P58) is applied HERE, so no module has to
 * check whether its own OSD is wanted.
 */

export type OsdSend = (channel: string, payload: unknown) => void

export class OsdBus {
  private nextToastId = 1
  private readonly toastActions = new Map<number, () => void>()
  private readonly progressCancelled = new Set<string>()

  constructor(
    private readonly send: OsdSend,
    private readonly isKindEnabled: (kind: OsdKind) => boolean = () => true
  ) {}

  show(msg: { kind: OsdKind; text: string; value?: number; durationMs?: number }): void {
    if (!this.isKindEnabled(msg.kind)) return
    this.send('ui:osd', {
      kind: msg.kind,
      text: msg.text,
      value: msg.value,
      durationMs: msg.durationMs
    })
  }

  toast(t: {
    kind: 'info' | 'error' | 'resume'
    message: string
    actionLabel?: string
    onAction?: () => void
  }): void {
    const id = this.nextToastId++
    if (t.onAction) this.toastActions.set(id, t.onAction)
    this.send('ui:toast', {
      id,
      kind: t.kind,
      message: t.message,
      actionLabel: t.actionLabel
    })
  }

  /** Called from IPC when the user clicks a toast's action button. */
  runToastAction(id: number): void {
    const fn = this.toastActions.get(id)
    this.toastActions.delete(id)
    try {
      fn?.()
    } catch (e) {
      console.error('[osd] toast action threw:', (e as Error).message)
    }
  }

  cancelProgress(id: string): void {
    this.progressCancelled.add(id)
  }

  progress(p: { id: string; label: string; cancellable?: boolean }): ProgressHandle {
    const bus = this
    this.progressCancelled.delete(p.id)
    this.send('ui:progress', { id: p.id, label: p.label, cancellable: p.cancellable })
    return {
      update(u): void {
        bus.send('ui:progress', {
          id: p.id,
          label: u.labelKey ?? p.label,
          fraction: u.fraction,
          detail: u.detail,
          cancellable: p.cancellable
        })
      },
      done(): void {
        bus.progressCancelled.delete(p.id)
        bus.send('ui:progress', { id: p.id, label: p.label, done: true })
      },
      get cancelled(): boolean {
        return bus.progressCancelled.has(p.id)
      }
    }
  }

  createService(translate: (key: string) => string): OsdService {
    const bus = this
    return {
      show: (m) => bus.show(m),
      toast: (t) => bus.toast(t),
      progress: (p) =>
        bus.progress({ id: p.id, label: translate(p.labelKey), cancellable: p.cancellable })
    }
  }
}
