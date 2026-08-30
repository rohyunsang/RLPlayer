import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'

/**
 * M10 audio-volume — volume, mute, speed and audio delay.
 *
 * WAVE 0 SEED. This module exists now because it is the new owner of five of
 * the twenty-two legacy `ipc.ts` actions (§5.10); the Wave-1 implementer takes
 * it from here and adds A06-A09 and A22-A24.
 *
 * It is the ONLY module allowed to write `volume` / `volume-gain` (§3.7).
 */

const MAX_VOLUME = 150
const MIN_SPEED = 0.25
const MAX_SPEED = 4

let ctx: FeatureContext
let boostOn = false

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const round2 = (v: number): number => Math.round(v * 100) / 100

function volume(): number {
  return ctx.mpv.peek<number>('volume') ?? loadConfig().volume
}
function speed(): number {
  return ctx.mpv.peek<number>('speed') ?? 1
}
function audioDelay(): number {
  return ctx.mpv.peek<number>('audio-delay') ?? 0
}

async function setVolume(value: number): Promise<void> {
  const v = clamp(Math.round(value), 0, MAX_VOLUME)
  await ctx.mpv.set('volume', v)
  saveConfig({ volume: v })
  applyBoost(v)
  ctx.osd.show({ kind: 'volume', text: `${v}%`, value: v / MAX_VOLUME })
}

/**
 * A06. Above 100%, raw gain clips badly on exactly the content people boost
 * for: quiet dialogue in a wide-dynamic-range film. The boost path gets a soft
 * limiter instead — dynaudnorm lifts the quiet passages, alimiter catches the
 * peaks before they square off.
 *
 * v0.1 issued a raw `af add @rlboost:...`, which is the one thing §0.2 rule 5
 * forbids: it fights every other module's filter work. It goes through the af
 * chain now, which also guarantees the limiter is LAST in the chain — a limiter
 * anywhere else is not a limiter.
 */
function applyBoost(v: number): void {
  const want = ctx.settings.get<boolean>('audio-volume.boostLimiter') && v > 100
  if (want === boostOn) return
  boostOn = want
  if (want) {
    ctx.af?.set('rlboost', 'lavfi=[dynaudnorm=f=250:g=9:p=0.85:m=4.0,alimiter=limit=0.94:level=false]')
  } else {
    ctx.af?.remove('rlboost')
  }
}

async function setSpeed(value: number): Promise<void> {
  const v = clamp(round2(value), MIN_SPEED, MAX_SPEED)
  await ctx.mpv.set('speed', v)
  saveConfig({ speed: v })
  ctx.osd.show({ kind: 'speed', text: `${v.toFixed(2)}×` })
}

async function setAudioDelay(value: number): Promise<void> {
  const v = round2(value)
  await ctx.mpv.set('audio-delay', v)
  ctx.osd.show({ kind: 'audiodelay', text: `오디오 ${v > 0 ? '+' : ''}${v.toFixed(2)}초` })
}

const mod: FeatureModule = {
  id: 'audio-volume',
  ownsProperties: [
    'volume',
    'volume-gain',
    'volume-max',
    'mute',
    'audio-delay',
    'speed',
    'pitch',
    'audio-pitch-correction'
  ],
  ownsFilterLabels: ['rlboost'],
  usesAudioFilters: true,

  setup(c): void {
    ctx = c
    const cfg = loadConfig()

    // A06's soft limiter. Hardcoded as `#volumeBoostLimiter` in the shared
    // settings.html before this — the M38 <-> M10 collision.
    ctx.settings.define([
      {
        id: 'audio-volume.boostLimiter',
        section: 'audio',
        labelKey: 'audio-volume.boostLimiterLabel',
        descriptionKey: 'audio-volume.boostLimiterDesc',
        type: { kind: 'bool' },
        default: true,
        keywords: ['증폭', '리미터', 'boost', 'limiter', 'normalize'],
        order: 20
      }
    ])
    if (typeof cfg.volumeBoostLimiter === 'boolean') {
      ctx.settings.set('audio-volume.boostLimiter', cfg.volumeBoostLimiter)
    }
    ctx.settings.onChange<boolean>('audio-volume.boostLimiter', (v) => {
      saveConfig({ volumeBoostLimiter: v })
      applyBoost(volume())
    })

    // v0.1 shipped a 0-150 slider. A06 will move all boost into the af chain
    // and drop this to 100; until then, changing it here would be a regression
    // the user notices immediately.
    ctx.mpv.contributeArgs(10, () => [
      `--volume-max=${MAX_VOLUME}`,
      `--volume=${cfg.volume}`,
      `--mute=${cfg.muted ? 'yes' : 'no'}`,
      `--speed=${cfg.speed}`
    ])

    ctx.mpv.afterFileLoaded(() => {
      applyBoost(volume())
    })

    ctx.perFile.slice({
      key: 'audio-volume',
      capture: () => ({ audioDelay: audioDelay() }),
      apply: async (v) => {
        if (typeof v.audioDelay === 'number') await ctx.mpv.set('audio-delay', v.audioDelay)
      },
      rememberDefaults: { audioDelay: true }
    })

    ctx.commands.register([
      {
        id: 'audio-volume.set',
        labelKey: 'audio-volume.set',
        category: 'audio',
        internal: true,
        run: (arg) => setVolume(Number(arg))
      },
      {
        id: 'audio-volume.up5',
        labelKey: 'audio-volume.up5',
        category: 'audio',
        defaults: { default: ['ArrowUp'], potplayer: ['ArrowUp'] },
        run: () => setVolume(volume() + 5)
      },
      {
        id: 'audio-volume.down5',
        labelKey: 'audio-volume.down5',
        category: 'audio',
        defaults: { default: ['ArrowDown'], potplayer: ['ArrowDown'] },
        run: () => setVolume(volume() - 5)
      },
      {
        id: 'audio-volume.up2',
        labelKey: 'audio-volume.up2',
        category: 'audio',
        defaults: { mpv: ['Digit0'] },
        run: () => setVolume(volume() + 2)
      },
      {
        id: 'audio-volume.down2',
        labelKey: 'audio-volume.down2',
        category: 'audio',
        defaults: { mpv: ['Digit9'] },
        run: () => setVolume(volume() - 2)
      },
      {
        id: 'audio-volume.toggleMute',
        labelKey: 'audio-volume.toggleMute',
        category: 'audio',
        menuPath: 'audio',
        menuOrder: 10,
        defaults: { default: ['KeyM'], potplayer: ['KeyM'], mpv: ['KeyM'] },
        run: async () => {
          const next = ctx.mpv.peek<boolean>('mute') !== true
          await ctx.mpv.set('mute', next)
          saveConfig({ muted: next })
          ctx.osd.show({ kind: 'volume', text: next ? '음소거' : `${volume()}%` })
        }
      },
      {
        id: 'audio-volume.setSpeed',
        labelKey: 'audio-volume.setSpeed',
        category: 'playback',
        internal: true,
        run: (arg) => setSpeed(Number(arg))
      },
      {
        id: 'audio-volume.speedUp',
        labelKey: 'audio-volume.speedUp',
        category: 'playback',
        defaults: { default: ['BracketRight'], potplayer: ['KeyC'], mpv: ['BracketRight'] },
        run: () => setSpeed(speed() + 0.25)
      },
      {
        id: 'audio-volume.speedDown',
        labelKey: 'audio-volume.speedDown',
        category: 'playback',
        defaults: { default: ['BracketLeft'], potplayer: ['KeyX'], mpv: ['BracketLeft'] },
        run: () => setSpeed(speed() - 0.25)
      },
      {
        id: 'audio-volume.resetSpeed',
        labelKey: 'audio-volume.resetSpeed',
        category: 'playback',
        defaults: { default: ['Backspace'], potplayer: ['KeyZ'], mpv: ['Backspace'] },
        run: () => setSpeed(1)
      },
      {
        id: 'audio-volume.setAudioDelay',
        labelKey: 'audio-volume.setAudioDelay',
        category: 'audio',
        internal: true,
        run: (arg) => setAudioDelay(Number(arg))
      },
      {
        id: 'audio-volume.audioDelayUp',
        labelKey: 'audio-volume.audioDelayUp',
        category: 'audio',
        defaults: { default: ['Shift+KeyA'] },
        run: () => setAudioDelay(audioDelay() + 0.1)
      },
      {
        id: 'audio-volume.audioDelayDown',
        labelKey: 'audio-volume.audioDelayDown',
        category: 'audio',
        defaults: { default: ['Shift+KeyZ'] },
        run: () => setAudioDelay(audioDelay() - 0.1)
      }
    ])

    ctx.i18n.register('ko', {
      'audio-volume.boostLimiterLabel': '볼륨 증폭 시 소프트 리미터',
      'audio-volume.boostLimiterDesc':
        '100%를 넘길 때 단순 증폭 대신 다이내믹 정규화와 리미터를 적용해 조용한 대사를 키우면서 피크가 찌그러지는 것을 막습니다.',
      'audio-volume.set': '볼륨 지정',
      'audio-volume.up5': '볼륨 +5%',
      'audio-volume.down5': '볼륨 -5%',
      'audio-volume.up2': '볼륨 +2%',
      'audio-volume.down2': '볼륨 -2%',
      'audio-volume.toggleMute': '음소거',
      'audio-volume.setSpeed': '재생 속도 지정',
      'audio-volume.speedUp': '재생 속도 +0.25×',
      'audio-volume.speedDown': '재생 속도 -0.25×',
      'audio-volume.resetSpeed': '재생 속도 초기화',
      'audio-volume.setAudioDelay': '오디오 싱크 지정',
      'audio-volume.audioDelayUp': '오디오 싱크 +0.1초',
      'audio-volume.audioDelayDown': '오디오 싱크 -0.1초'
    })
    ctx.i18n.register('en', {
      'audio-volume.boostLimiterLabel': 'Soft limiter when boosting',
      'audio-volume.boostLimiterDesc':
        'Above 100%, apply dynamic normalisation and a limiter instead of plain gain, so quiet dialogue comes up without the peaks clipping.',
      'audio-volume.set': 'Set volume',
      'audio-volume.up5': 'Volume +5%',
      'audio-volume.down5': 'Volume -5%',
      'audio-volume.up2': 'Volume +2%',
      'audio-volume.down2': 'Volume -2%',
      'audio-volume.toggleMute': 'Mute',
      'audio-volume.setSpeed': 'Set speed',
      'audio-volume.speedUp': 'Speed +0.25x',
      'audio-volume.speedDown': 'Speed -0.25x',
      'audio-volume.resetSpeed': 'Reset speed',
      'audio-volume.setAudioDelay': 'Set audio delay',
      'audio-volume.audioDelayUp': 'Audio delay +0.1s',
      'audio-volume.audioDelayDown': 'Audio delay -0.1s'
    })
  }
}

export default mod
