import fs from 'node:fs'
import path from 'node:path'
import type { FeatureContext, FeatureModule, Unsubscribe } from '@shared/feature-api'
import {
  BAND_COUNT,
  BAND_FREQ,
  EQ_FILTER,
  GAIN_LIMIT,
  PREAMP_FILTER,
  changeArgsForBand,
  clampGain,
  effectivePreamp,
  equaliserSpec,
  flatGains,
  parseGains,
  preampSpec,
  preampValue,
  serialiseGains
} from './eq.ts'
import {
  BUILT_IN_PRESETS,
  PRESET_FILE,
  findPreset,
  findPresetByGains,
  mergePresets,
  nextPreset,
  parsePresetFile,
  serialisePresetFile,
  type EqPreset
} from './presets.ts'

/**
 * M12 audio-eq — A01 (10-band graphic EQ), A02 (presets) and A03 (preamp).
 *
 * THE PILOT FOR TWO THINGS, so both are spelled out here.
 *
 * 1. THE af-CHAIN. This module never issues `af` or `af-command` itself — the
 *    ownership map refuses both for every feature module (§5). It declares
 *    `usesAudioFilters` and its four reserved labels and talks to `ctx.af`.
 *    `@rleq` is the equaliser and `@rlpre` the preamp; the chain emits them in
 *    §5.5 policy order (rlch -> rleq -> rlpre -> ...), so the preamp lands
 *    AFTER the boost it exists to compensate for, whatever order they were set
 *    in. `@rltone` (A35) and `@rlfeq` (A49) are this module's too and are
 *    claimed here so nothing else can take them; both are P2 and unbuilt.
 *
 * 2. LIVE UPDATES VS REBUILDS. A slider drag must not rebuild the chain: an
 *    `af set` reinitialises every filter in it and the audio clicks. So the
 *    drag goes down `audio-eq:preview`, which issues only the verified
 *    four-argument form
 *
 *        ['af-command', 'rleq', 'change', '<idx>|f=..|w=..|g=..', 'anequalizer']
 *
 *    (the fourth argument is the libavfilter FILTER NAME; the three-argument
 *    form and `'all'` both fail — A27), and the SETTING is written once on
 *    pointer release. That commit is the only rebuild, and it exists because
 *    the slot's stored spec has to end up truthful: any other module touching
 *    the chain later re-serialises every slot, and a stale `@rleq` spec would
 *    silently undo the drag.
 *
 * 3. NOT `superequalizer` (A48): linear multipliers, a 0-20 range, and no
 *    `af-command` at all. `anequalizer` is the one the spec verified.
 */

interface PresetWire {
  id: string
  builtIn: boolean
  gains: number[]
}

interface EqState {
  enabled: boolean
  gains: number[]
  autoPreamp: boolean
  manualPreamp: number
  /** What is actually on `@rlpre` right now. */
  preamp: number
  presets: PresetWire[]
  /** The preset the current curve equals, or null for a hand-shaped curve. */
  presetId: string | null
  /**
   * The band centres and the dB limit, sent rather than duplicated.
   *
   * The renderer needs them to label and bound the sliders, and it CANNOT
   * import them: `eq.ts` lives in this module's main directory, `tsconfig.web`
   * is `composite`, and a composite project rejects a file outside its
   * `include`. The two halves of a module have no file they both own — see the
   * report. Sending the table keeps one copy of the verified numbers.
   */
  freqs: number[]
  limit: number
}

let ctx: FeatureContext
/** The live curve. Diverges from the stored setting only during a drag. */
let gains: number[] = flatGains()
/** True once `@rleq`/`@rlpre` have a slot, so `ctx.af.command()` has a target. */
let slotsLive = false
/** The chain queues everything before `file-loaded`, and an `af-command` issued
 *  then fails and falls back to a rebuild. Do not send one before there is a
 *  filter graph to talk to. */
let fileLoaded = false
let presets: readonly EqPreset[] = BUILT_IN_PRESETS
const subscriptions: Unsubscribe[] = []

const enabled = (): boolean => ctx.settings.get<boolean>('audio-eq.enabled')
const autoPreampOn = (): boolean => ctx.settings.get<boolean>('audio-eq.autoPreamp')
const manualPreamp = (): number => ctx.settings.get<number>('audio-eq.preamp')
const currentPreamp = (): number => effectivePreamp(gains, autoPreampOn(), manualPreamp())

// --- presets on disk -------------------------------------------------------

function presetPath(): string {
  return path.join(ctx.paths.dataDir(), PRESET_FILE)
}

/**
 * Re-read on every use rather than caching. The file is meant to be edited by
 * hand and swapped between machines (A02: "ship presets as data so users can
 * share JSON"), so a cache would mean "restart the player to see your own
 * file", which is exactly the kind of thing people report as data loss.
 */
function loadPresets(): readonly EqPreset[] {
  try {
    const text = fs.readFileSync(presetPath(), 'utf8')
    presets = mergePresets(BUILT_IN_PRESETS, parsePresetFile(text))
  } catch {
    // Missing is the normal case; unreadable is not worth a toast on every open.
    presets = BUILT_IN_PRESETS
  }
  return presets
}

function writeUserPresets(list: readonly EqPreset[]): boolean {
  try {
    fs.mkdirSync(ctx.paths.dataDir(), { recursive: true })
    fs.writeFileSync(presetPath(), serialisePresetFile(list), 'utf8')
    presets = mergePresets(BUILT_IN_PRESETS, list.filter((p) => !p.builtIn))
    return true
  } catch (e) {
    ctx.log.warn(`could not write ${PRESET_FILE}: ${(e as Error).message}`)
    return false
  }
}

// --- the chain -------------------------------------------------------------

/** A full rebuild: both slots re-specified and re-toggled. One per commit. */
function applyChain(): void {
  const af = ctx.af
  if (!af) return
  const on = enabled()
  // Nothing has ever been applied and the EQ is off: leave the chain empty
  // rather than parking two disabled filters in it forever.
  if (!on && !slotsLive) return
  af.set('rleq', equaliserSpec(gains))
  af.set('rlpre', preampSpec(currentPreamp()))
  slotsLive = true
  // `toggle(label, false)` disables IN PLACE (`@rleq:!lavfi=[...]`), so the
  // curve survives being switched off and on again without a re-`set`.
  af.toggle('rleq', on)
  af.toggle('rlpre', on)
}

function canCommand(): boolean {
  return Boolean(ctx.af) && enabled() && slotsLive && fileLoaded
}

/**
 * A03. The preamp tracks the curve while the curve is being dragged.
 *
 * The fifth argument is the spec the `rlpre` slot must hold AFTER this change,
 * and it is required rather than optional for a measured reason: without it the
 * chain's slot kept the PREVIOUS `volume=` value, so the next whole-chain
 * rebuild -- another module's `af set`, an mpv respawn, the next file -- pushed
 * the old preamp back and undid the drag. `preampSpec()` is the same function
 * `applyChain()` uses, so there is one expression of the A03 row and not two.
 */
async function pushPreamp(): Promise<void> {
  if (!canCommand()) return
  const db = currentPreamp()
  await ctx.af?.command('rlpre', 'volume', preampValue(db), PREAMP_FILTER, preampSpec(db))
}

/**
 * One band, live. Eight `change` commands — one per declared channel — and no
 * `af set` anywhere, which is the entire point of the four-argument form.
 *
 * Every one of the eight carries the SAME post-change spec, because it is the
 * spec of the whole 80-entry graph once this band has moved on every declared
 * channel; the eight commands are how mpv is told, not eight different states.
 * Without it the chain's slot still held `g=0` for the band the user had just
 * dragged (measured), and the next `af set` flattened it again. `equaliserSpec`
 * is the same function `applyChain()` uses.
 */
async function pushBand(band: number): Promise<void> {
  if (!canCommand()) return
  const gain = gains[band] ?? 0
  const spec = equaliserSpec(gains)
  for (const arg of changeArgsForBand(band, gain)) {
    await ctx.af?.command('rleq', 'change', arg, EQ_FILTER, spec)
  }
  await pushPreamp()
}

// --- state ----------------------------------------------------------------

function state(): EqState {
  const list = loadPresets()
  return {
    enabled: enabled(),
    gains: [...gains],
    autoPreamp: autoPreampOn(),
    manualPreamp: manualPreamp(),
    preamp: currentPreamp(),
    presets: list.map((p) => ({ id: p.id, builtIn: p.builtIn, gains: [...p.gains] })),
    presetId: findPresetByGains(list, gains)?.id ?? null,
    freqs: [...BAND_FREQ],
    limit: GAIN_LIMIT
  }
}

/** Push to the settings window, whose `SettingBinding.onChange` only fires for
 *  writes the form itself made — a preset applied from a keybind is invisible
 *  to it otherwise. */
function broadcast(): void {
  ctx.ipc.send('audio-eq:state', state(), 'settings')
}

/**
 * Commit a curve: persist it, and rebuild ONCE.
 *
 * `settings.set()` is a no-op when the value is unchanged, so the onChange
 * cannot be relied on — but it also must not be doubled up, which is why this
 * compares first instead of applying unconditionally afterwards. A drag that
 * ends where it started still has to re-apply, because the live `af-command`s
 * in between moved the running filter away from the stored spec.
 */
function commitGains(next: readonly number[]): void {
  const text = serialiseGains(next)
  const unchanged = ctx.settings.get<string>('audio-eq.bands') === text
  ctx.settings.set('audio-eq.bands', text)
  if (!unchanged) return
  gains = parseGains(text)
  applyChain()
  broadcast()
}

/**
 * The manual preamp is an ordinary bounded `float` descriptor, and the
 * GENERATED slider writes on every `input` event — one write per pixel. The
 * live value goes out immediately as an `af-command`; the slot spec, which is
 * a rebuild, waits for the gesture to stop.
 */
let syncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    applyChain()
    broadcast()
  }, 300)
}

function osd(text: string): void {
  ctx.osd.show({ kind: 'info', text })
}

function presetLabel(p: EqPreset): string {
  return p.builtIn ? ctx.i18n.t(`audio-eq.preset.${p.id}`) : p.id
}

// --- module ---------------------------------------------------------------

const mod: FeatureModule = {
  id: 'audio-eq',
  dependsOn: [],
  usesAudioFilters: true,
  // §5.5 reserved labels. `rltone` (A35 bass/treble shelves) and `rlfeq` (A49
  // linear-phase FIR) are M12's in docs/parity/modules.json and are claimed
  // here so no one else can take them; neither is implemented yet.
  ownsFilterLabels: ['rleq', 'rlpre', 'rltone', 'rlfeq'],

  setup(c): void {
    ctx = c

    ctx.settings.define([
      {
        id: 'audio-eq.enabled',
        section: 'audio',
        group: 'audio-eq.group',
        labelKey: 'audio-eq.enabled',
        descriptionKey: 'audio-eq.enabledDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['이퀄라이저', '이큐', 'equalizer', 'eq'],
        order: 30
      },
      {
        /**
         * THE CUSTOM COMPONENT (§7's escape hatch), and the reason this module
         * is its pilot. Ten bands are ten values that only mean anything
         * together: a generated row of ten sliders would carry no frequency
         * scale, no preset list and no shared readout, and dragging one would
         * write the setting sixty times a second. The component renders the
         * whole EQ and commits once on release.
         *
         * The VALUE is a comma-separated string, not an array — see
         * serialiseGains() for why the registry's Object.is comparison makes
         * that the difference between P51 working and not.
         */
        id: 'audio-eq.bands',
        section: 'audio',
        group: 'audio-eq.group',
        labelKey: 'audio-eq.bands',
        descriptionKey: 'audio-eq.bandsDesc',
        type: { kind: 'custom', rendererComponent: 'audio-eq.bands' },
        default: serialiseGains(flatGains()),
        keywords: ['밴드', '프리셋', 'band', 'preset', 'gain'],
        order: 31
      },
      {
        id: 'audio-eq.autoPreamp',
        section: 'audio',
        group: 'audio-eq.group',
        labelKey: 'audio-eq.autoPreamp',
        descriptionKey: 'audio-eq.autoPreampDesc',
        type: { kind: 'bool' },
        default: true,
        keywords: ['프리앰프', '클리핑', 'preamp', 'clip'],
        order: 32
      },
      {
        id: 'audio-eq.preamp',
        section: 'audio',
        group: 'audio-eq.group',
        labelKey: 'audio-eq.preamp',
        // The description carries "only when auto is off" because there is no
        // way to say it structurally: SettingDescriptor.visibleWhen exists in
        // the API and the generated form never reads it (see the report).
        descriptionKey: 'audio-eq.preampDesc',
        type: { kind: 'float', min: -12, max: 12, step: 0.5 },
        default: 0,
        keywords: ['프리앰프', 'preamp', 'gain'],
        order: 33
      }
    ])

    gains = parseGains(ctx.settings.get<string>('audio-eq.bands'))

    ctx.settings.onChange<string>('audio-eq.bands', (v) => {
      gains = parseGains(v)
      applyChain()
      broadcast()
    })
    ctx.settings.onChange<boolean>('audio-eq.enabled', (v) => {
      applyChain()
      osd(ctx.i18n.t(v ? 'audio-eq.osdOn' : 'audio-eq.osdOff'))
      broadcast()
    })
    ctx.settings.onChange<boolean>('audio-eq.autoPreamp', () => {
      // One write per click: rebuild now.
      applyChain()
      broadcast()
    })
    ctx.settings.onChange<number>('audio-eq.preamp', () => {
      if (autoPreampOn()) return
      void pushPreamp()
      scheduleSync()
    })

    // The chain queues writes made before the first frame and mpv drops
    // property writes made at `file-loaded`; §3.3.1 says every per-file apply
    // hangs off afterFileLoaded, and an af-command needs a live graph.
    subscriptions.push(
      ctx.mpv.afterFileLoaded(() => {
        fileLoaded = true
        applyChain()
      }),
      ctx.mpv.onEvent('end-file', () => {
        fileLoaded = false
      })
    )

    // --- IPC, for the settings component --------------------------------

    ctx.ipc.handle<void, EqState>('audio-eq:query', async () => state())

    /**
     * The live half of a drag. Deliberately `on`, not `handle`: this fires per
     * pointer move and a reply nobody awaits is a round trip nobody needs.
     * It does NOT persist — the component writes the setting on release.
     */
    ctx.ipc.on<{ band: number; gain: number }>('audio-eq:preview', (req) => {
      const band = Number(req?.band)
      if (!Number.isInteger(band) || band < 0 || band >= BAND_COUNT) return
      gains[band] = clampGain(req?.gain)
      void pushBand(band)
    })

    ctx.ipc.on<{ name: string }>('audio-eq:savePreset', (req) => {
      const name = String(req?.name ?? '').trim()
      if (!name) return
      const user = loadPresets().filter((p) => !p.builtIn && p.id !== name)
      const ok = writeUserPresets([
        ...user,
        { id: name, gains: [...gains], builtIn: false }
      ])
      if (ok) osd(ctx.i18n.t('audio-eq.osdSaved', { name }))
      broadcast()
    })

    ctx.ipc.on<{ id: string }>('audio-eq:deletePreset', (req) => {
      const id = String(req?.id ?? '')
      const user = loadPresets().filter((p) => !p.builtIn && p.id !== id)
      writeUserPresets(user)
      broadcast()
    })

    // --- commands --------------------------------------------------------

    ctx.commands.register([
      {
        id: 'audio-eq.toggle',
        labelKey: 'audio-eq.toggle',
        category: 'audio',
        menuPath: 'audio',
        // PotPlayer opens its equaliser from the same chord; mpv has no EQ of
        // its own, so its preset gets nothing rather than an invention.
        defaults: { default: ['Ctrl+KeyE'], potplayer: ['Ctrl+KeyE'] },
        run: () => {
          ctx.settings.set('audio-eq.enabled', !enabled())
        }
      },
      {
        id: 'audio-eq.nextPreset',
        labelKey: 'audio-eq.nextPreset',
        category: 'audio',
        run: () => {
          const p = nextPreset(loadPresets(), gains)
          if (!p) return
          commitGains(p.gains)
          osd(presetLabel(p))
        }
      },
      {
        id: 'audio-eq.reset',
        labelKey: 'audio-eq.reset',
        category: 'audio',
        run: () => {
          commitGains(flatGains())
          osd(ctx.i18n.t('audio-eq.osdReset'))
        }
      },
      {
        id: 'audio-eq.applyPreset',
        labelKey: 'audio-eq.applyPreset',
        category: 'audio',
        internal: true,
        run: (arg) => {
          const p = findPreset(loadPresets(), String(arg ?? ''))
          if (!p) return
          commitGains(p.gains)
          osd(presetLabel(p))
        }
      },
      {
        id: 'audio-eq.setBand',
        labelKey: 'audio-eq.setBand',
        category: 'audio',
        internal: true,
        run: (arg) => {
          const req = arg as { band?: number; gain?: number } | undefined
          const band = Number(req?.band)
          if (!Number.isInteger(band) || band < 0 || band >= BAND_COUNT) return
          const next = [...gains]
          next[band] = clampGain(req?.gain)
          commitGains(next)
        }
      },
      {
        id: 'audio-eq.setPreamp',
        labelKey: 'audio-eq.setPreamp',
        category: 'audio',
        internal: true,
        run: (arg) => {
          ctx.settings.set('audio-eq.autoPreamp', false)
          ctx.settings.set('audio-eq.preamp', clampGain(arg))
        }
      }
    ])

    ctx.i18n.register('ko', {
      'audio-eq.group': '이퀄라이저',
      'audio-eq.enabled': '이퀄라이저 사용',
      'audio-eq.enabledDesc': '10밴드 그래픽 이퀄라이저를 오디오 필터 체인에 넣습니다.',
      'audio-eq.bands': '밴드와 프리셋',
      'audio-eq.bandsDesc':
        '밴드당 ±12 dB. 슬라이더를 놓는 순간에만 저장되고, 끄는 동안에는 필터를 다시 만들지 않고 값만 바꿉니다.',
      'audio-eq.autoPreamp': '프리앰프 자동',
      'audio-eq.autoPreampDesc':
        '가장 크게 올린 밴드만큼 미리 낮춰서 클리핑을 막습니다. EqualizerAPO와 같은 방식입니다.',
      'audio-eq.preamp': '프리앰프',
      'audio-eq.preampDesc': '프리앰프 자동을 껐을 때만 적용됩니다.',
      'audio-eq.toggle': '이퀄라이저 켜기/끄기',
      'audio-eq.nextPreset': '다음 이퀄라이저 프리셋',
      'audio-eq.reset': '이퀄라이저 초기화',
      'audio-eq.applyPreset': '이퀄라이저 프리셋 적용',
      'audio-eq.setBand': '이퀄라이저 밴드 지정',
      'audio-eq.setPreamp': '프리앰프 지정',
      'audio-eq.preset.flat': '평탄',
      'audio-eq.preset.voice': '대사',
      'audio-eq.preset.bass': '저음 강조',
      'audio-eq.preset.treble': '고음 강조',
      'audio-eq.preset.loudness': '작은 소리 보정',
      'audio-eq.presetCustom': '사용자 곡선',
      'audio-eq.presetLabel': '프리셋',
      'audio-eq.presetName': '프리셋 이름',
      'audio-eq.save': '저장',
      'audio-eq.delete': '삭제',
      'audio-eq.resetButton': '초기화',
      'audio-eq.preampReadout': '프리앰프',
      'audio-eq.osdOn': '이퀄라이저 켬',
      'audio-eq.osdOff': '이퀄라이저 끔',
      'audio-eq.osdReset': '이퀄라이저 초기화',
      'audio-eq.osdSaved': '{name}{을/를} 저장했습니다'
    })
    ctx.i18n.register('en', {
      'audio-eq.group': 'Equalizer',
      'audio-eq.enabled': 'Enable equalizer',
      'audio-eq.enabledDesc': 'Insert the 10-band graphic equalizer into the audio filter chain.',
      'audio-eq.bands': 'Bands and presets',
      'audio-eq.bandsDesc':
        '±12 dB per band. The value is saved when you release a slider; dragging updates the running filter in place instead of rebuilding it.',
      'audio-eq.autoPreamp': 'Automatic preamp',
      'audio-eq.autoPreampDesc':
        'Attenuate by as much as the largest boost so the result cannot clip — what EqualizerAPO does.',
      'audio-eq.preamp': 'Preamp',
      'audio-eq.preampDesc': 'Used only when the automatic preamp is off.',
      'audio-eq.toggle': 'Toggle equalizer',
      'audio-eq.nextPreset': 'Next equalizer preset',
      'audio-eq.reset': 'Reset equalizer',
      'audio-eq.applyPreset': 'Apply equalizer preset',
      'audio-eq.setBand': 'Set equalizer band',
      'audio-eq.setPreamp': 'Set preamp',
      'audio-eq.preset.flat': 'Flat',
      'audio-eq.preset.voice': 'Voice',
      'audio-eq.preset.bass': 'Bass boost',
      'audio-eq.preset.treble': 'Treble boost',
      'audio-eq.preset.loudness': 'Loudness',
      'audio-eq.presetCustom': 'Custom',
      'audio-eq.presetLabel': 'Preset',
      'audio-eq.presetName': 'Preset name',
      'audio-eq.save': 'Save',
      'audio-eq.delete': 'Delete',
      'audio-eq.resetButton': 'Reset',
      'audio-eq.preampReadout': 'Preamp',
      'audio-eq.osdOn': 'Equalizer on',
      'audio-eq.osdOff': 'Equalizer off',
      'audio-eq.osdReset': 'Equalizer reset',
      'audio-eq.osdSaved': 'Saved {name}'
    })
  },

  dispose(): void {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = null
    for (const off of subscriptions.splice(0)) off()
  }
}

export default mod
