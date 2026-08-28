import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M07 video-decode, renderer half.
 *
 * WAVE 0 SEED, and the PROOF that `ctx.statsSection()` is a real contribution
 * point. The decoder rows in the stats overlay are contributed from here; the
 * overlay's `main.ts` does not know this module exists, and a second module
 * wanting a row adds a directory rather than a branch in a shared file.
 *
 * `refresh: onChange` rather than a poll: `hwdec-current` flips exactly once
 * per file, when mpv commits to a decoder, and a timer would burn a wake-up a
 * second to notice.
 */

interface DecodeStats {
  hwdec: string
  hwdecCurrent: string
  vo: string
  codec: string
  width: number
  height: number
}

let stats: DecodeStats | null = null

const mod: RendererFeatureModule = {
  id: 'video-decode',

  setup(ctx): void {
    if (ctx.surface !== 'player') return

    const refresh = (): void => {
      void ctx.ipc
        .invoke<undefined, DecodeStats>('video-decode:stats')
        .then((s) => {
          stats = s
        })
        .catch(() => {
          stats = null
        })
    }
    refresh()
    ctx.state.subscribe(refresh)

    ctx.statsSection({
      id: 'video-decode.stats',
      order: 20,
      titleKey: 'video-decode.stats',
      refresh: { mode: 'onChange', watch: ['hwdec-current', 'video-codec', 'width', 'height'] },
      fields: () => {
        const s = stats
        if (!s) return []
        return [
          { labelKey: 'video-decode.statsHwdec', value: s.hwdec },
          { labelKey: 'video-decode.statsCurrent', value: s.hwdecCurrent },
          { labelKey: 'video-decode.statsVo', value: s.vo },
          { labelKey: 'video-decode.statsCodec', value: s.codec },
          {
            labelKey: 'video-decode.statsSize',
            value: s.width > 0 ? `${s.width} × ${s.height}` : '-'
          }
        ]
      }
    })
  }
}

export default mod
