import type { FeatureContext, FeatureModule, MenuNode, SettingId } from '@shared/feature-api'
import {
  DENOISE_DEFAULTS,
  SHARPEN_DEFAULTS,
  type DenoiseKnob,
  type DenoiseState,
  type LiveOption,
  type SharpenKnob,
  type SharpenMode,
  type SharpenState,
  denoiseLiveOptions,
  denoiseSpec,
  sharpenLiveOption,
  sharpenSpec
} from './specs.ts'

/**
 * M03 video-enhance — V08–V16's enhancement filters. This pass ships the three
 * the §2.1 table marks P1: sharpen (V08 classic unsharp / V09 CAS), denoise 3D
 * (V11) and deband (V15). V10 soften, V12 temporal denoise, V13 gradual
 * denoise, V14 deblock and V16 motion blur are the same shape and reuse
 * `specs.ts`; their labels are left unclaimed until they are built, so nothing
 * reserves a chain slot it does not fill.
 *
 * Three things about this module are not obvious and are all measured:
 *
 *  1. `vf-command` takes FOUR arguments, the last of which is the libavfilter
 *     FILTER NAME (`cas`, `hqdn3d`) rather than the label. `ctx.vf.command()`
 *     has that signature; the three-argument form fails on both sides (V09).
 *  2. `unsharp` refuses `vf-command` outright, so V08's row is specified as a
 *     full chain rebuild. That is why CAS is the DEFAULT sharpener here and
 *     unsharp sits behind "classic": every drag on a 4K frame otherwise
 *     rebuilds the graph and forces an hwdec copy-back.
 *  3. Deband is the one enhancement that is free — a gpu-next render pass,
 *     five properties and no filter, so no lavfi pass and no copy-back. It is
 *     therefore more prominent here than it is in PotPlayer.
 *
 * THIS MODULE NO LONGER KEEPS A COPY OF THE CHAIN'S STATE, and that is the
 * headline change since the pilot. `ctx.vf.command()` used to leave the chain's
 * slot holding the PRE-change spec, so a live `vf-command` was reverted by the
 * next whole-chain rebuild and a rebuild for `unsharp` re-sent the old value.
 * This module compensated with `chain-sync.ts`: 201 lines keeping `desired` and
 * `applied` specs, a debounced authoritative `set()`, and a learned refuser
 * table. It was a SECOND model of the chain's state, which is how the two come
 * to disagree — and M01, M09, M13 and M14 would each have written it again.
 *
 * `ctx.vf.command()` now takes the post-change spec as a REQUIRED argument and
 * verifies it, and `ctx.vf.has/isEnabled/specOf` answer the three questions the
 * shadow copy existed for. `applySlot()` below is the whole of what is left.
 */

const SHARPEN_LABEL = 'rl-sharpen'
const DENOISE_LABEL = 'rl-denoise'

let ctx: FeatureContext

/**
 * The EFFECTIVE state of the three toggles, which is not the same thing as the
 * setting: V53 lets a file remember that denoise was on for it, while the
 * settings store holds the user's preference for a file that has no memory.
 */
const live = { sharpen: false, denoise: false, deband: false }

const num = (id: SettingId): number => ctx.settings.get<number>(id)

function sharpenState(): SharpenState {
  return {
    mode: ctx.settings.get<SharpenMode>('video-enhance.sharpenMode'),
    strength: num('video-enhance.sharpenStrength'),
    lumaAmount: num('video-enhance.sharpenLuma'),
    chromaAmount: num('video-enhance.sharpenChroma')
  }
}

function denoiseState(): DenoiseState {
  return {
    luma: num('video-enhance.denoiseLuma'),
    chroma: num('video-enhance.denoiseChroma'),
    time: num('video-enhance.denoiseTime')
  }
}

/**
 * Hand one labelled slot its current spec — live where libavfilter allows it.
 *
 * The three questions this used to need a shadow copy of the chain to answer are
 * now `ctx.vf.has()`, `ctx.vf.isEnabled()` and `ctx.vf.specOf()`, so there is
 * exactly one model of the chain and it lives in the chain.
 *
 * `liveOptions` is the set of `<x>f-command` payloads for the ONE control the user just
 * moved, or undefined when several options moved at once (a sharpen MODE switch
 * is a different filter entirely; a per-file restore moves the whole slice). The
 * refuser table is not duplicated here: `command()` falls back to a rebuild by
 * itself and carries the new spec through it, which is the entire reason the
 * spec argument is required.
 */
async function applySlot(
  label: string,
  on: boolean,
  spec: string,
  liveOptions: readonly LiveOption[] | undefined
): Promise<void> {
  const vf = ctx.vf
  // `ctx.vf` exists only because `usesVideoFilters` is declared below; the
  // registry leaves the field undefined otherwise, deliberately, so an
  // undeclared use is a type error rather than a crash at runtime.
  if (!vf) return

  if (!on) {
    // Disable IN PLACE (`@label:!spec`), never `remove()`: §5's disable-in-place
    // is what lets a toggle survive with its settings, and tearing the slot down
    // would also cost a full chain rebuild on the way back in.
    if (vf.has(label)) vf.toggle(label, false)
    return
  }

  const liveSlot = vf.has(label) && vf.isEnabled(label)
  if (liveSlot && vf.specOf(label) === spec) return

  // First appearance, coming back from a disable, or a change that moves more
  // than one option: the slot has to carry the whole spec BEFORE it is switched
  // on, or the frame in between shows the previous settings.
  if (!liveSlot || liveOptions === undefined || liveOptions.length === 0) {
    vf.set(label, spec)
    vf.toggle(label, true)
    return
  }

  for (const o of liveOptions) {
    await vf.command(label, o.option, o.value, o.filter, spec)
  }
}

/**
 * `knob` names the single control the user just moved, which is what makes a
 * live `vf-command` possible at all: a mode change, or a restore of a whole
 * per-file slice, moves several options at once and has to be a rebuild.
 */
async function applySharpen(knob?: SharpenKnob): Promise<void> {
  const state = sharpenState()
  const option = knob ? sharpenLiveOption(state, knob) : undefined
  await applySlot(SHARPEN_LABEL, live.sharpen, sharpenSpec(state), option ? [option] : undefined)
}

async function applyDenoise(knob?: DenoiseKnob): Promise<void> {
  const state = denoiseState()
  await applySlot(
    DENOISE_LABEL,
    live.denoise,
    denoiseSpec(state),
    knob ? denoiseLiveOptions(state, knob) : undefined
  )
}

/**
 * V15. Five properties, no filter. The parameters go first so switching it on
 * never shows a frame at the previous threshold.
 */
async function applyDeband(): Promise<void> {
  await ctx.mpv.set('deband-threshold', Math.round(num('video-enhance.debandThreshold')))
  await ctx.mpv.set('deband-range', Math.round(num('video-enhance.debandRange')))
  await ctx.mpv.set('deband-grain', Math.round(num('video-enhance.debandGrain')))
  await ctx.mpv.set('deband-iterations', Math.round(num('video-enhance.debandIterations')))
  await ctx.mpv.set('deband', live.deband)
}

function osd(key: string): void {
  ctx.osd.show({ kind: 'info', text: ctx.i18n.t(key) })
}

async function toggle(which: 'sharpen' | 'denoise' | 'deband'): Promise<void> {
  live[which] = !live[which]
  // The toggle is also the user's preference for the next file; the per-file
  // slice's baseline diffing (P51) decides what is worth persisting per file.
  // The apply below is not skipped when this write also fires `onChange`: it is
  // idempotent (the second pass is a `noop` in the slot sync), and the write is
  // a NO-OP — so no onChange at all — whenever a per-file restore has already
  // moved `live` away from the stored preference.
  ctx.settings.set(`video-enhance.${which}`, live[which])
  if (which === 'sharpen') await applySharpen()
  else if (which === 'denoise') await applyDenoise()
  else await applyDeband()
  osd(`video-enhance.osd.${which}${live[which] ? 'On' : 'Off'}`)
}

const mod: FeatureModule = {
  id: 'video-enhance',

  // V15 is properties, not a filter: the whole deband family is M03's.
  ownsProperties: [
    'deband',
    'deband-threshold',
    'deband-range',
    'deband-grain',
    'deband-iterations'
  ],

  // M03's seven slots, exactly as `modules.json` reserves them. This pass fills
  // two — `rl-sharpen` (V08/V09) and `rl-denoise` (V11); V10 soften, V12
  // temporal denoise, V13 gradual denoise, V14 deblock and V16 motion blur are
  // the same shape and reuse `specs.ts`. The claim is what stops another module
  // taking a label out from under them, so it matches the manifest rather than
  // this pass's subset.
  //
  // Spelled out rather than built from the constants above: the checks in this
  // repo read a module's declarations out of the SOURCE (importing one would
  // drag Electron in), and a computed array reads to them as an empty one.
  ownsFilterLabels: [
    'rl-sharpen',
    'rl-denoise',
    'rl-soften',
    'rl-tdenoise',
    'rl-gdenoise',
    'rl-deblock',
    'rl-mblur'
  ],
  usesVideoFilters: true,

  setup(c): void {
    ctx = c

    ctx.settings.define([
      {
        id: 'video-enhance.sharpen',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.sharpen',
        descriptionKey: 'video-enhance.sharpenDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['선명', '샤픈', 'sharpen', 'cas', 'unsharp'],
        order: 110
      },
      {
        id: 'video-enhance.sharpenMode',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.sharpenMode',
        descriptionKey: 'video-enhance.sharpenModeDesc',
        type: {
          kind: 'enum',
          options: [
            { value: 'cas', labelKey: 'video-enhance.sharpenMode.cas' },
            { value: 'unsharp', labelKey: 'video-enhance.sharpenMode.unsharp' }
          ]
        },
        default: SHARPEN_DEFAULTS.mode,
        keywords: ['선명', 'sharpen', 'cas', 'unsharp'],
        order: 111,
        visibleWhen: (get) => get<boolean>('video-enhance.sharpen')
      },
      {
        id: 'video-enhance.sharpenStrength',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.sharpenStrength',
        type: { kind: 'float', min: 0, max: 1, step: 0.05 },
        default: SHARPEN_DEFAULTS.strength,
        keywords: ['선명', '강도', 'cas', 'strength'],
        order: 112,
        visibleWhen: (get) =>
          get<boolean>('video-enhance.sharpen') &&
          get<string>('video-enhance.sharpenMode') === 'cas'
      },
      {
        id: 'video-enhance.sharpenLuma',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.sharpenLuma',
        type: { kind: 'float', min: -2, max: 5, step: 0.1 },
        default: SHARPEN_DEFAULTS.lumaAmount,
        keywords: ['선명', '휘도', 'luma', 'unsharp'],
        order: 113,
        visibleWhen: (get) =>
          get<boolean>('video-enhance.sharpen') &&
          get<string>('video-enhance.sharpenMode') === 'unsharp'
      },
      {
        id: 'video-enhance.sharpenChroma',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.sharpenChroma',
        type: { kind: 'float', min: -2, max: 5, step: 0.1 },
        default: SHARPEN_DEFAULTS.chromaAmount,
        keywords: ['선명', '색', 'chroma', 'unsharp'],
        order: 114,
        visibleWhen: (get) =>
          get<boolean>('video-enhance.sharpen') &&
          get<string>('video-enhance.sharpenMode') === 'unsharp'
      },

      {
        id: 'video-enhance.denoise',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.denoise',
        descriptionKey: 'video-enhance.denoiseDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['노이즈', '잡티', 'denoise', 'hqdn3d', 'denoise3d'],
        order: 120
      },
      {
        id: 'video-enhance.denoiseLuma',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.denoiseLuma',
        type: { kind: 'float', min: 0, max: 10, step: 0.5 },
        default: DENOISE_DEFAULTS.luma,
        keywords: ['노이즈', '휘도', 'luma', 'denoise'],
        order: 121,
        visibleWhen: (get) => get<boolean>('video-enhance.denoise')
      },
      {
        id: 'video-enhance.denoiseChroma',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.denoiseChroma',
        type: { kind: 'float', min: 0, max: 10, step: 0.5 },
        default: DENOISE_DEFAULTS.chroma,
        keywords: ['노이즈', '색', 'chroma', 'denoise'],
        order: 122,
        visibleWhen: (get) => get<boolean>('video-enhance.denoise')
      },
      {
        id: 'video-enhance.denoiseTime',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.denoiseTime',
        descriptionKey: 'video-enhance.denoiseTimeDesc',
        type: { kind: 'float', min: 0, max: 15, step: 0.5 },
        default: DENOISE_DEFAULTS.time,
        keywords: ['노이즈', '시간', 'temporal', 'denoise'],
        order: 123,
        visibleWhen: (get) => get<boolean>('video-enhance.denoise')
      },

      {
        id: 'video-enhance.deband',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.deband',
        descriptionKey: 'video-enhance.debandDesc',
        type: { kind: 'bool' },
        default: false,
        mpvOption: 'deband',
        keywords: ['밴딩', '띠', 'deband', 'banding', 'gradient'],
        order: 130
      },
      {
        id: 'video-enhance.debandThreshold',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.debandThreshold',
        type: { kind: 'int', min: 0, max: 4096, step: 1 },
        default: 48,
        mpvOption: 'deband-threshold',
        keywords: ['밴딩', '임계', 'deband', 'threshold'],
        order: 131,
        visibleWhen: (get) => get<boolean>('video-enhance.deband')
      },
      {
        id: 'video-enhance.debandRange',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.debandRange',
        type: { kind: 'int', min: 1, max: 64, step: 1 },
        default: 16,
        mpvOption: 'deband-range',
        keywords: ['밴딩', '반경', 'deband', 'range', 'radius'],
        order: 132,
        visibleWhen: (get) => get<boolean>('video-enhance.deband')
      },
      {
        id: 'video-enhance.debandGrain',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.debandGrain',
        type: { kind: 'int', min: 0, max: 4096, step: 1 },
        default: 32,
        mpvOption: 'deband-grain',
        keywords: ['밴딩', '그레인', 'deband', 'grain', 'dither'],
        order: 133,
        visibleWhen: (get) => get<boolean>('video-enhance.deband')
      },
      {
        id: 'video-enhance.debandIterations',
        section: 'video',
        group: 'enhance',
        labelKey: 'video-enhance.debandIterations',
        type: { kind: 'int', min: 0, max: 16, step: 1 },
        default: 1,
        mpvOption: 'deband-iterations',
        keywords: ['밴딩', '반복', 'deband', 'iterations'],
        advanced: true,
        order: 134,
        visibleWhen: (get) => get<boolean>('video-enhance.deband')
      }
    ])

    live.sharpen = ctx.settings.get<boolean>('video-enhance.sharpen')
    live.denoise = ctx.settings.get<boolean>('video-enhance.denoise')
    live.deband = ctx.settings.get<boolean>('video-enhance.deband')

    ctx.settings.onChange<boolean>('video-enhance.sharpen', (v) => {
      live.sharpen = v
      void applySharpen()
    })
    ctx.settings.onChange<string>('video-enhance.sharpenMode', () => {
      // A mode change is a different filter entirely: rebuild, never a command.
      void applySharpen()
    })
    ctx.settings.onChange<number>('video-enhance.sharpenStrength', () => {
      void applySharpen('strength')
    })
    ctx.settings.onChange<number>('video-enhance.sharpenLuma', () => {
      void applySharpen('lumaAmount')
    })
    ctx.settings.onChange<number>('video-enhance.sharpenChroma', () => {
      void applySharpen('chromaAmount')
    })

    ctx.settings.onChange<boolean>('video-enhance.denoise', (v) => {
      live.denoise = v
      void applyDenoise()
    })
    ctx.settings.onChange<number>('video-enhance.denoiseLuma', () => {
      void applyDenoise('luma')
    })
    ctx.settings.onChange<number>('video-enhance.denoiseChroma', () => {
      void applyDenoise('chroma')
    })
    ctx.settings.onChange<number>('video-enhance.denoiseTime', () => {
      void applyDenoise('time')
    })

    ctx.settings.onChange<boolean>('video-enhance.deband', (v) => {
      live.deband = v
      void applyDeband()
    })
    for (const id of [
      'video-enhance.debandThreshold',
      'video-enhance.debandRange',
      'video-enhance.debandGrain',
      'video-enhance.debandIterations'
    ]) {
      ctx.settings.onChange<number>(id, () => {
        void applyDeband()
      })
    }

    // Deband is spawn-settable and M03 owns every one of these properties, so
    // the state comes up with the process instead of as a round of property
    // writes after it (§4: an option follows its property's owner).
    ctx.mpv.contributeArgs(20, () => [
      `--deband=${live.deband ? 'yes' : 'no'}`,
      `--deband-threshold=${Math.round(num('video-enhance.debandThreshold'))}`,
      `--deband-range=${Math.round(num('video-enhance.debandRange'))}`,
      `--deband-grain=${Math.round(num('video-enhance.debandGrain'))}`,
      `--deband-iterations=${Math.round(num('video-enhance.debandIterations'))}`
    ])

    // The chain queues everything before `file-loaded` itself, so the initial
    // slots can be registered right here.
    void applySharpen()
    void applyDenoise()

    // NO `afterFileLoaded` FLUSH ANY MORE. It used to exist because a live
    // `vf-command` left the chain's slot holding the old spec and this module
    // held the new one in a debounce timer, so a new file re-applied the chain
    // from stale slots unless the timer was forced first. The slot is now
    // updated by `command()` itself, so the chain the next file gets is already
    // the one the user is looking at, and there is nothing to flush.

    // V53. Only the three toggles are per-file: the strengths are a preference,
    // and a file remembering "denoise 6.5" would make a later default change
    // unshippable (P51). `core/per-file` diffs against the load-time baseline,
    // so a toggle the user never touched for this file is never written.
    ctx.perFile.slice({
      key: 'video-enhance',
      capture: () => ({
        sharpen: live.sharpen,
        denoise: live.denoise,
        deband: live.deband
      }),
      apply: async (v) => {
        if (typeof v.sharpen === 'boolean') {
          live.sharpen = v.sharpen
          await applySharpen()
        }
        if (typeof v.denoise === 'boolean') {
          live.denoise = v.denoise
          await applyDenoise()
        }
        if (typeof v.deband === 'boolean') {
          live.deband = v.deband
          await applyDeband()
        }
      },
      rememberDefaults: { sharpen: true, denoise: true, deband: true }
    })

    /**
     * No `defaults` on any of these, and that is deliberate rather than
     * unfinished: §2.1 assigns no key to V08–V16 in any of the three presets,
     * and three other Wave-1 modules are landing in the same tree. A preset is
     * the FOLD of every module's defaults, so an invented accelerator here is a
     * conflict somebody else has to discover. They are all bindable in the
     * keybind editor, which is what the user actually needs.
     */
    ctx.commands.register([
      {
        id: 'video-enhance.toggleSharpen',
        labelKey: 'video-enhance.toggleSharpen',
        category: 'video',
        run: () => toggle('sharpen')
      },
      {
        id: 'video-enhance.toggleDenoise',
        labelKey: 'video-enhance.toggleDenoise',
        category: 'video',
        run: () => toggle('denoise')
      },
      {
        id: 'video-enhance.toggleDeband',
        labelKey: 'video-enhance.toggleDeband',
        category: 'video',
        run: () => toggle('deband')
      },
      {
        id: 'video-enhance.setSharpenMode',
        labelKey: 'video-enhance.setSharpenMode',
        category: 'video',
        internal: true,
        run: (arg) => {
          const mode: SharpenMode = arg === 'unsharp' ? 'unsharp' : 'cas'
          ctx.settings.set('video-enhance.sharpenMode', mode)
        }
      },
      {
        id: 'video-enhance.reset',
        labelKey: 'video-enhance.reset',
        category: 'video',
        // V53's other half: a bad saved state has to be recoverable without
        // opening the settings window.
        run: async () => {
          live.sharpen = false
          live.denoise = false
          live.deband = false
          ctx.settings.set('video-enhance.sharpen', false)
          ctx.settings.set('video-enhance.denoise', false)
          ctx.settings.set('video-enhance.deband', false)
          await applySharpen()
          await applyDenoise()
          await applyDeband()
          osd('video-enhance.osd.reset')
        }
      }
    ])

    ctx.menu.contribute({
      id: 'video-enhance.menu',
      labelKey: 'video-enhance.menuTitle',
      order: 55,
      items: [
        {
          dynamic(): readonly MenuNode[] {
            const mode = ctx.settings.get<string>('video-enhance.sharpenMode')
            return [
              {
                labelKey: 'video-enhance.sharpen',
                commandId: 'video-enhance.toggleSharpen',
                checked: live.sharpen
              },
              {
                labelKey: 'video-enhance.sharpenMode',
                submenu: [
                  {
                    labelKey: 'video-enhance.sharpenMode.cas',
                    commandId: 'video-enhance.setSharpenMode',
                    arg: 'cas',
                    radio: true,
                    checked: mode === 'cas'
                  },
                  {
                    labelKey: 'video-enhance.sharpenMode.unsharp',
                    commandId: 'video-enhance.setSharpenMode',
                    arg: 'unsharp',
                    radio: true,
                    checked: mode === 'unsharp'
                  }
                ]
              },
              {
                labelKey: 'video-enhance.denoise',
                commandId: 'video-enhance.toggleDenoise',
                checked: live.denoise
              },
              {
                labelKey: 'video-enhance.deband',
                commandId: 'video-enhance.toggleDeband',
                checked: live.deband
              },
              { type: 'separator' },
              { labelKey: 'video-enhance.reset', commandId: 'video-enhance.reset' }
            ]
          }
        }
      ]
    })

    ctx.i18n.register('ko', {
      'video-enhance.menuTitle': '화면 보정',
      'video-enhance.sharpen': '선명하게',
      'video-enhance.sharpenDesc':
        'CPU 필터라 하드웨어 디코딩 화면이 메모리로 복사됩니다. 4K에서는 부담이 큽니다.',
      'video-enhance.sharpenMode': '선명화 방식',
      'video-enhance.sharpenModeDesc':
        'CAS는 값을 바꾸면 즉시 반영되고 윤곽선 링잉이 없습니다. 클래식(언샤프)은 값을 바꿀 때마다 필터를 다시 만듭니다.',
      'video-enhance.sharpenMode.cas': 'CAS (권장)',
      'video-enhance.sharpenMode.unsharp': '클래식 (언샤프)',
      'video-enhance.sharpenStrength': '선명화 강도',
      'video-enhance.sharpenLuma': '밝기 선명화 양',
      'video-enhance.sharpenChroma': '색 선명화 양',
      'video-enhance.denoise': '노이즈 제거',
      'video-enhance.denoiseDesc': '공간 + 시간 노이즈 제거(hqdn3d). CPU 필터입니다.',
      'video-enhance.denoiseLuma': '밝기 노이즈',
      'video-enhance.denoiseChroma': '색 노이즈',
      'video-enhance.denoiseTime': '시간 노이즈',
      'video-enhance.denoiseTimeDesc':
        '앞뒤 프레임을 함께 봅니다. 구간 이동 직후 몇 프레임이 뭉개지는 것은 정상입니다.',
      'video-enhance.deband': '밴딩 제거',
      'video-enhance.debandDesc':
        'GPU에서 처리하므로 화면 보정 중 유일하게 성능 부담이 거의 없습니다.',
      'video-enhance.debandThreshold': '밴딩 임계값',
      'video-enhance.debandRange': '밴딩 반경',
      'video-enhance.debandGrain': '그레인 추가량',
      'video-enhance.debandIterations': '반복 횟수',
      'video-enhance.toggleSharpen': '선명하게 켜기/끄기',
      'video-enhance.toggleDenoise': '노이즈 제거 켜기/끄기',
      'video-enhance.toggleDeband': '밴딩 제거 켜기/끄기',
      'video-enhance.setSharpenMode': '선명화 방식 선택',
      'video-enhance.reset': '화면 보정 초기화',
      'video-enhance.osd.sharpenOn': '선명하게 켜짐',
      'video-enhance.osd.sharpenOff': '선명하게 꺼짐',
      'video-enhance.osd.denoiseOn': '노이즈 제거 켜짐',
      'video-enhance.osd.denoiseOff': '노이즈 제거 꺼짐',
      'video-enhance.osd.debandOn': '밴딩 제거 켜짐',
      'video-enhance.osd.debandOff': '밴딩 제거 꺼짐',
      'video-enhance.osd.reset': '화면 보정 초기화됨'
    })
    ctx.i18n.register('en', {
      'video-enhance.menuTitle': 'Enhancement',
      'video-enhance.sharpen': 'Sharpen',
      'video-enhance.sharpenDesc':
        'A CPU filter: hardware-decoded frames are copied back to system memory. Costly at 4K.',
      'video-enhance.sharpenMode': 'Sharpen method',
      'video-enhance.sharpenModeDesc':
        'CAS updates live and has no edge ringing. Classic (unsharp) rebuilds the filter on every change.',
      'video-enhance.sharpenMode.cas': 'CAS (recommended)',
      'video-enhance.sharpenMode.unsharp': 'Classic (unsharp)',
      'video-enhance.sharpenStrength': 'Sharpen strength',
      'video-enhance.sharpenLuma': 'Luma amount',
      'video-enhance.sharpenChroma': 'Chroma amount',
      'video-enhance.denoise': 'Denoise',
      'video-enhance.denoiseDesc': 'Spatial + temporal denoise (hqdn3d). A CPU filter.',
      'video-enhance.denoiseLuma': 'Luma',
      'video-enhance.denoiseChroma': 'Chroma',
      'video-enhance.denoiseTime': 'Time',
      'video-enhance.denoiseTimeDesc':
        'Looks at neighbouring frames. A couple of soft frames right after a seek is normal.',
      'video-enhance.deband': 'Deband',
      'video-enhance.debandDesc':
        'Runs on the GPU — the only enhancement here that costs almost nothing.',
      'video-enhance.debandThreshold': 'Deband threshold',
      'video-enhance.debandRange': 'Deband radius',
      'video-enhance.debandGrain': 'Added grain',
      'video-enhance.debandIterations': 'Iterations',
      'video-enhance.toggleSharpen': 'Toggle sharpen',
      'video-enhance.toggleDenoise': 'Toggle denoise',
      'video-enhance.toggleDeband': 'Toggle deband',
      'video-enhance.setSharpenMode': 'Set sharpen method',
      'video-enhance.reset': 'Reset enhancement',
      'video-enhance.osd.sharpenOn': 'Sharpen on',
      'video-enhance.osd.sharpenOff': 'Sharpen off',
      'video-enhance.osd.denoiseOn': 'Denoise on',
      'video-enhance.osd.denoiseOff': 'Denoise off',
      'video-enhance.osd.debandOn': 'Deband on',
      'video-enhance.osd.debandOff': 'Deband off',
      'video-enhance.osd.reset': 'Enhancement reset'
    })
  },

  dispose(): void {
    // Nothing to release: the debounce timers this module used to own went with
    // `chain-sync.ts`, and the chain's slots are core's to tear down.
  }
}

export default mod
