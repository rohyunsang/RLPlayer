import type { FeatureModule } from '@shared/feature-api'

/**
 * M08 video-framerate — frame timing.
 *
 * WAVE 0 SEED, and it exists mainly to OWN `--video-sync`. v0.1 passed
 * `--video-sync=display-resample` from `manager.ts`; leaving it in core would
 * have meant the Wave-1 implementer of M08 hit a spawn-arg collision against
 * core with no obvious owner to negotiate with. One twenty-line module makes
 * the ownership honest.
 */
const mod: FeatureModule = {
  id: 'video-framerate',
  ownsProperties: [
    'video-sync',
    'framedrop',
    'display-fps-override',
    'interpolation',
    'tscale'
  ],

  setup(ctx): void {
    // Cheap, and it kills most judder on non-24Hz displays.
    ctx.mpv.contributeArgs(10, () => ['--video-sync=display-resample'])
    ctx.i18n.register('ko', { 'video-framerate.name': '프레임 타이밍' })
    ctx.i18n.register('en', { 'video-framerate.name': 'Frame timing' })
  }
}

export default mod
