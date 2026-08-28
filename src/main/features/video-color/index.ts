import type {
  CommandDescriptor,
  FeatureContext,
  FeatureModule,
  MenuNode,
  SettingDescriptor,
  Unsubscribe
} from '@shared/feature-api'
import {
  AUTOLEVEL_SMOOTHING,
  CHROMA_SHIFT_DEFAULTS,
  CHROMA_SHIFT_LIMIT,
  COLOUR_KNOBS,
  COLOUR_MAX,
  COLOUR_MIN,
  LEVELS_DEFAULTS,
  NEUTRAL,
  OUTPUT_LEVELS,
  type ChromaShiftState,
  type ColourKnob,
  type ColourTuple,
  type LevelsState,
  type LiveOption,
  type OutputLevels,
  autoLevelSpec,
  changedKnobs,
  chromaShiftLiveOptions,
  chromaShiftSpec,
  clampColour,
  isNeutral,
  levelsLiveOptions,
  levelsSpec,
  osdFraction,
  signed,
  toOutputLevels,
  toTuple
} from './colour.ts'

/**
 * M01 video-color — V01–V07 and this module's half of V53.
 *
 * WHAT IS A PROPERTY AND WHAT IS A FILTER, because the two halves of this
 * module cost completely different amounts:
 *
 *  - brightness, contrast, saturation, hue and gamma (V01, V02) plus
 *    `video-output-levels` (V04) are NATIVE mpv properties. Under gpu-next they
 *    are VO-level render parameters: free, hwdec-safe, and observable, so they
 *    can be driven from a key repeat without a thought.
 *  - `rl-levels` (V05), `rl-autolevel` (V06) and `rl-cshift` (V07) are lavfi
 *    filters, so every one of them forces hwdec frames back to system memory.
 *    They are off by default, they say so in the settings window, and they are
 *    the reason this module declares `usesVideoFilters`.
 *
 * §2 V02, and the correction that matters: an earlier revision justified using
 * the `gamma` PROPERTY by calling `--gamma-factor` deprecated. It is not —
 * `--list-options` marks only `--gamma-auto`. The property is still the right
 * choice, for a different and better reason: it is observable and per-file
 * persistable, which a startup option is not. So this module writes `gamma` and
 * contributes `--gamma` (the property's own spawn form), and touches
 * `--gamma-factor` nowhere.
 *
 * WHERE THE LIVE VALUE LIVES. Deliberately not in one place for everything, and
 * both halves follow a precedent already in this tree:
 *
 *  - the five knobs: mpv is the truth, read through `ctx.mpv.peek()`, kept warm
 *    by the observers V01 asks for. That is M10's model for `volume`, and it is
 *    what makes a per-file override (which must NOT become the user's default)
 *    representable at all.
 *  - the three filter toggles: the settings store is the truth, mirrored into
 *    `filters` — M03's model, because a lavfi slot has no mpv property to
 *    observe and the menu checkmark has to come from somewhere.
 *
 * A key press writes mpv first and then records the new value as the user's
 * preference; a PER-FILE restore writes mpv only. That asymmetry is the whole
 * of V53 here: the file remembers what you did to it, and the file does not
 * silently redefine what every other file starts from.
 */

const LEVELS_LABEL = 'rl-levels'
const AUTOLEVEL_LABEL = 'rl-autolevel'
const CSHIFT_LABEL = 'rl-cshift'

/** §2 V01 gives no keys for these; mpv's own map moves them one unit per press. */
const STEP = 1

let ctx: FeatureContext

/** V03's "last used" tuple. §2 V03: "Keep the state in the app." */
let lastUsed: ColourTuple | null = null

/**
 * Whether the per-file slice has already restored THIS file.
 *
 * This exists so the module does not depend on the order in which core happens
 * to register its `afterFileLoaded` handlers. Both orders are correct here: if
 * this module's handler runs first it applies the user's defaults and the slice
 * then overrides them; if the slice ran first, `restored` is already true and
 * the defaults are not applied over the top of a restore. See
 * `module.test.ts`, which drives both orders.
 */
let restored = false

/** Mirrors the three filter toggles (see the header). */
const filters = { levels: false, autoLevel: false, chromaShift: false }

/** Everything to release on quit: observers, event hooks, settings listeners. */
let offs: Unsubscribe[] = []

/**
 * True while THIS module is writing its own settings store.
 *
 * `SettingsRegistry.set()` calls its `onChange` listeners SYNCHRONOUSLY
 * (`core/settings/registry.ts`), and this module subscribes to every id it
 * defines so that the settings WINDOW moving a slider reaches mpv. Without this
 * flag every gesture ran the apply path twice — measured, before the fix:
 *
 *   `video-color.brightnessUp` once            -> OSD ['밝기 +1', '밝기 +1']
 *   `video-color.reset` from a non-neutral tuple -> five per-knob readouts
 *                                                  stacked under '색 조정 초기화됨'
 *
 * which is precisely the "one updating readout rather than forty stacked ones"
 * §3.3.5 asks for, inverted. The second apply was a no-op on the pipe (mpv
 * already held the value), so only the OSD showed it — a duplicate nothing but a
 * test that counts messages can see.
 *
 * It is a flag rather than "drop the OSD from the listener" because the listener
 * is the ONLY signal for a settings-window edit while video plays behind it, and
 * dropping it there would have traded a visible duplicate for a silent gap.
 */
let storing = false

/** Write this module's own setting without re-entering the apply path. */
function store<T>(id: string, value: T): void {
  storing = true
  try {
    ctx.settings.set(id, value)
  } finally {
    storing = false
  }
}

const num = (id: string): number => ctx.settings.get<number>(id)
const flag = (id: string): boolean => ctx.settings.get<boolean>(id)

const settingIdOf = (knob: ColourKnob): string => `video-color.${knob}`

/** The user's default tuple: what a file with no memory of its own starts from. */
const defaultTuple = (): ColourTuple =>
  toTuple(Object.fromEntries(COLOUR_KNOBS.map((k) => [k, num(settingIdOf(k))])))

/** What mpv is holding, falling back to the preference before the first frame. */
const liveTuple = (): ColourTuple =>
  toTuple(
    Object.fromEntries(
      COLOUR_KNOBS.map((k) => [k, ctx.mpv.peek<number>(k) ?? num(settingIdOf(k))])
    )
  )

const levelsState = (): LevelsState => ({
  black: num('video-color.levelsBlack'),
  white: num('video-color.levelsWhite')
})

const chromaShiftState = (): ChromaShiftState => ({
  horizontal: num('video-color.chromaShiftH'),
  vertical: num('video-color.chromaShiftV')
})

const t = (key: string): string => ctx.i18n.t(key)

// ---------------------------------------------------------------------------
// The five properties
// ---------------------------------------------------------------------------

function showKnobOsd(knob: ColourKnob, value: number): void {
  ctx.osd.show({
    kind: 'info',
    text: `${t(`video-color.${knob}`)} ${signed(value)}`,
    value: osdFraction(value)
  })
}

/** mpv only. Never writes the settings store — see the header. */
async function applyKnob(knob: ColourKnob, value: number, osd = true): Promise<void> {
  const v = clampColour(value)
  if (ctx.mpv.peek<number>(knob) !== v) await ctx.mpv.set(knob, v)
  if (osd) showKnobOsd(knob, v)
}

async function applyTuple(next: Readonly<ColourTuple>): Promise<void> {
  // Only the knobs that actually move. A whole-tuple write is five round trips
  // on the pipe, and mpv redraws for each one. No per-knob OSD either: the
  // caller (a reset, a restore, the last-used toggle) shows one message for the
  // whole gesture instead of five stacked readouts.
  for (const knob of changedKnobs(liveTuple(), next)) await applyKnob(knob, next[knob], false)
}

/** A user gesture: apply, then remember it as the preference for the next file. */
async function setKnob(knob: ColourKnob, value: number): Promise<void> {
  const v = clampColour(value)
  await applyKnob(knob, v)
  // Ordered deliberately: the write above is unconditional, so a per-file
  // override that happens to equal the stored preference still reaches mpv.
  // `settings.set` fires `onChange` only on a real change, and the re-apply it
  // triggers is a no-op because mpv already holds `v`.
  store(settingIdOf(knob), v)
}

const stepKnob = (knob: ColourKnob, delta: number): Promise<void> =>
  setKnob(knob, liveTuple()[knob] + delta)

// ---------------------------------------------------------------------------
// V04 — video-output-levels
// ---------------------------------------------------------------------------

/** mpv only, and only one of the three values mpv accepts. */
async function applyOutputLevels(value: OutputLevels): Promise<void> {
  if (ctx.mpv.peek<string>('video-output-levels') !== value) {
    await ctx.mpv.set('video-output-levels', value)
  }
}

/** A gesture: apply, then remember it. Same asymmetry as `setKnob`. */
async function setOutputLevels(value: unknown): Promise<void> {
  const v = toOutputLevels(value)
  await applyOutputLevels(v)
  store('video-color.outputLevels', v)
  ctx.osd.show({
    kind: 'info',
    text: `${t('video-color.outputLevels')}: ${t(`video-color.outputLevels.${v}`)}`
  })
}

// ---------------------------------------------------------------------------
// The three filter slots
// ---------------------------------------------------------------------------

/**
 * Reconcile one labelled slot with the state this module wants it in.
 *
 * This is M03's `applySlot` again, near enough line for line, and that is worth
 * saying out loud rather than quietly copying: `ctx.vf` has `set`, `toggle`,
 * `command`, `has`, `isEnabled` and `specOf`, but no "make this label be this
 * spec, enabled or not" operation, so every module that owns a filter label
 * writes this same twenty lines. Reported as an API gap rather than factored
 * out, because the only place it could be shared from is a core file.
 */
async function applySlot(
  label: string,
  on: boolean,
  spec: string,
  liveOptions: readonly LiveOption[] | undefined
): Promise<void> {
  const vf = ctx.vf
  // Undefined unless `usesVideoFilters` is declared; the registry makes an
  // undeclared use a type error rather than a crash.
  if (!vf) return

  if (!on) {
    // Disable IN PLACE (§5): the slot keeps its spec, so coming back is not a
    // full chain rebuild and the user's values survive the toggle.
    //
    // `isEnabled` and not just `has`: the parameter listeners call through here
    // on every slider tick whether or not the filter is on, so without it a
    // drag on a switched-off black point emitted one `toggle(label, false)` per
    // tick against a slot that was already disabled.
    if (vf.has(label) && vf.isEnabled(label)) vf.toggle(label, false)
    return
  }

  const liveSlot = vf.has(label) && vf.isEnabled(label)
  if (liveSlot && vf.specOf(label) === spec) return

  if (!liveSlot || liveOptions === undefined || liveOptions.length === 0) {
    // The whole spec has to be in the slot BEFORE it is switched on, or the
    // frame in between shows the previous settings.
    vf.set(label, spec)
    vf.toggle(label, true)
    return
  }

  for (const o of liveOptions) await vf.command(label, o.option, o.value, o.filter, spec)
}

/**
 * `knob` names the ONE control the user just moved, which is what makes a live
 * `vf-command` possible. A restore or a fresh enable moves everything at once
 * and has to be a rebuild.
 *
 * `colorlevels` and `chromashift` are NOT on §2's measured accept list (`cas`,
 * `eq`, `hqdn3d`, `deblock`, `v360`) and neither is on the chain's refuser list,
 * so `command()` will try the four-argument form and fall back to a rebuild by
 * itself if the filter turns out not to implement `process_command`. Either way
 * the slot ends up holding `spec`, which is the point of the required argument.
 */
const applyLevels = (knob?: keyof LevelsState): Promise<void> => {
  const state = levelsState()
  return applySlot(
    LEVELS_LABEL,
    filters.levels,
    levelsSpec(state),
    knob ? levelsLiveOptions(state, knob) : undefined
  )
}

const applyAutoLevel = (): Promise<void> =>
  // No live options: `smoothing` is a constant (V06) and the two colour points
  // are literals, so this slot only ever goes on or off.
  applySlot(AUTOLEVEL_LABEL, filters.autoLevel, autoLevelSpec(), undefined)

const applyChromaShift = (knob?: keyof ChromaShiftState): Promise<void> => {
  const state = chromaShiftState()
  return applySlot(
    CSHIFT_LABEL,
    filters.chromaShift,
    chromaShiftSpec(state),
    knob ? chromaShiftLiveOptions(state, knob) : undefined
  )
}

const applyAllFilters = async (): Promise<void> => {
  await applyLevels()
  await applyAutoLevel()
  await applyChromaShift()
}

// ---------------------------------------------------------------------------
// V03 — reset, and the last-used toggle
// ---------------------------------------------------------------------------

/**
 * V03 / PotPlayer `Q` — "Disable / Last used Color Controls".
 *
 * §2 V03: there is no mpv-side restore primitive. `apply-profile <name> restore`
 * needs config-file profiles and this player runs `--no-config`; `apply-profile`
 * is also banned outright by §3.7.2, because the set of properties a profile
 * touches lives inside mpv where nothing can police it. So the tuple is kept
 * here, in app state, exactly as the row says.
 */
async function toggleLastUsed(): Promise<void> {
  const current = liveTuple()
  if (!isNeutral(current)) {
    lastUsed = current
    await applyTuple(NEUTRAL)
    for (const k of COLOUR_KNOBS) store(settingIdOf(k), 0)
    ctx.osd.show({ kind: 'info', text: t('video-color.osd.colourOff') })
    return
  }
  if (!lastUsed) {
    ctx.osd.show({ kind: 'info', text: t('video-color.osd.nothingToRestore') })
    return
  }
  const wanted = lastUsed
  await applyTuple(wanted)
  for (const k of COLOUR_KNOBS) store(settingIdOf(k), wanted[k])
  ctx.osd.show({ kind: 'info', text: t('video-color.osd.colourOn') })
}

/**
 * V53's second rule: "offer a per-file 'reset video settings' so a bad saved
 * state is recoverable". Everything this module can do to the picture goes back
 * to mpv's own defaults, including the three filter slots — a saved state the
 * user cannot see is exactly the one they need a single button for.
 */
async function resetAll(): Promise<void> {
  lastUsed = null
  await applyTuple(NEUTRAL)
  for (const k of COLOUR_KNOBS) store(settingIdOf(k), 0)

  store('video-color.outputLevels', 'auto')
  await applyOutputLevels('auto')

  filters.levels = false
  filters.autoLevel = false
  filters.chromaShift = false
  store('video-color.levels', false)
  store('video-color.autoLevel', false)
  store('video-color.chromaShift', false)
  store('video-color.levelsBlack', LEVELS_DEFAULTS.black)
  store('video-color.levelsWhite', LEVELS_DEFAULTS.white)
  store('video-color.chromaShiftH', CHROMA_SHIFT_DEFAULTS.horizontal)
  store('video-color.chromaShiftV', CHROMA_SHIFT_DEFAULTS.vertical)
  await applyAllFilters()

  ctx.osd.show({ kind: 'info', text: t('video-color.osd.reset') })
}

async function toggleFilter(which: keyof typeof filters): Promise<void> {
  filters[which] = !filters[which]
  const id =
    which === 'levels'
      ? 'video-color.levels'
      : which === 'autoLevel'
        ? 'video-color.autoLevel'
        : 'video-color.chromaShift'
  store(id, filters[which])
  if (which === 'levels') await applyLevels()
  else if (which === 'autoLevel') await applyAutoLevel()
  else await applyChromaShift()
  ctx.osd.show({
    kind: 'info',
    text: t(`video-color.osd.${which}${filters[which] ? 'On' : 'Off'}`)
  })
}

// ---------------------------------------------------------------------------
// §4.2 — this module's contribution to M29's stats overlay
// ---------------------------------------------------------------------------

/**
 * One row of the stats block. §4.2 names M01 as a producer of an M29 stats
 * section, additive and non-blocking.
 *
 * The shape is declared HERE and again in the renderer half, which is the
 * hand-duplication §3.4 says `src/shared/features/<id>/` exists to prevent —
 * except that M01's manifest row does not list that directory (only M12's, M26's
 * and M27's do), so this module may not create it. Reported as a finding. It is
 * kept to two string fields so the duplication is three lines and cannot drift
 * silently: `value` is already formatted in main, and the renderer only resolves
 * `labelKey` through its own `t()`.
 */
interface StatsRow {
  labelKey: string
  value: string
}

/**
 * The five knobs, the output range, and WHICH of the three lavfi slots is live.
 *
 * The last row is the point of the whole block: §6.3's acceptance criterion for
 * this module is "brightness ±100 visibly changes the picture with hwdec active
 * — proves it is a VO-level property, not a filter", and the way to see that in
 * the app is a readout that says the knobs moved while no CPU filter is in the
 * chain. `ctx.vf.hasCpuFilter` is the whole chain's answer across every module,
 * so this reports only its own three labels.
 */
function statsRows(): StatsRow[] {
  const tuple = liveTuple()
  const active: string[] = []
  if (filters.levels) active.push(LEVELS_LABEL)
  if (filters.autoLevel) active.push(AUTOLEVEL_LABEL)
  if (filters.chromaShift) active.push(CSHIFT_LABEL)
  return [
    ...COLOUR_KNOBS.map((k) => ({
      labelKey: `video-color.${k}`,
      value: signed(tuple[k])
    })),
    {
      labelKey: 'video-color.outputLevels',
      value: toOutputLevels(ctx.mpv.peek<string>('video-output-levels'))
    },
    {
      labelKey: 'video-color.statsCpuFilters',
      value: active.length === 0 ? '—' : active.join(', ')
    }
  ]
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** The five sliders, in COLOUR_KNOBS order. */
function knobDescriptors(): SettingDescriptor[] {
  const keywords: Record<ColourKnob, string[]> = {
    brightness: ['밝기', 'brightness'],
    contrast: ['명암', '콘트라스트', 'contrast'],
    saturation: ['채도', 'saturation', 'color'],
    hue: ['색조', '색상', 'hue'],
    gamma: ['감마', 'gamma']
  }
  return COLOUR_KNOBS.map((knob, i) => ({
    id: settingIdOf(knob),
    section: 'video' as const,
    group: 'colour',
    labelKey: `video-color.${knob}`,
    descriptionKey: knob === 'gamma' ? 'video-color.gammaDesc' : undefined,
    type: { kind: 'int' as const, min: COLOUR_MIN, max: COLOUR_MAX, step: 1 },
    default: NEUTRAL[knob],
    mpvOption: knob,
    keywords: keywords[knob],
    order: 10 + i
  }))
}

/** One `<knob>Up` / `<knob>Down` pair per knob (§3.4: one accel per step). */
function stepCommands(): CommandDescriptor[] {
  // mpv's own map, which is the only published binding for any of these:
  // 1/2 contrast, 3/4 brightness, 5/6 gamma, 7/8 saturation. Physical codes
  // (P16) — with the Korean IME composing, `e.key` is 'Process' for letters,
  // and a digit row is no different in principle.
  const accels: Partial<Record<ColourKnob, { down: string; up: string }>> = {
    contrast: { down: 'Digit1', up: 'Digit2' },
    brightness: { down: 'Digit3', up: 'Digit4' },
    gamma: { down: 'Digit5', up: 'Digit6' },
    saturation: { down: 'Digit7', up: 'Digit8' }
  }
  const out: CommandDescriptor[] = []
  for (const knob of COLOUR_KNOBS) {
    const pair = accels[knob]
    for (const dir of ['Up', 'Down'] as const) {
      const accel = pair ? (dir === 'Up' ? pair.up : pair.down) : undefined
      out.push({
        id: `video-color.${knob}${dir}`,
        labelKey: `video-color.${knob}${dir}`,
        category: 'video',
        ...(accel ? { defaults: { mpv: [accel] } } : {}),
        run: () => stepKnob(knob, dir === 'Up' ? STEP : -STEP)
      })
    }
  }
  return out
}

const mod: FeatureModule = {
  id: 'video-color',
  // Copied verbatim from this module's row in docs/parity/modules.json (§3.2):
  // one namespace on both sides, and a core piece is satisfied by construction.
  dependsOn: ['core-vf-chain'],

  // Spelled out rather than computed from COLOUR_KNOBS: the manifest-vs-code
  // checks read these arrays out of the SOURCE, and a computed array reads to
  // them as an empty one.
  ownsProperties: [
    'brightness',
    'contrast',
    'gamma',
    'hue',
    'saturation',
    'video-output-levels'
  ],
  ownsFilterLabels: ['rl-levels', 'rl-autolevel', 'rl-cshift'],
  usesVideoFilters: true,

  setup(c): void {
    ctx = c

    ctx.settings.define([
      ...knobDescriptors(),
      {
        id: 'video-color.outputLevels',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.outputLevels',
        descriptionKey: 'video-color.outputLevelsDesc',
        type: {
          kind: 'enum',
          options: OUTPUT_LEVELS.map((v) => ({
            value: v,
            labelKey: `video-color.outputLevels.${v}`
          }))
        },
        default: 'auto',
        mpvOption: 'video-output-levels',
        keywords: ['범위', 'TV', 'PC', 'levels', 'range', 'limited', 'full'],
        advanced: true,
        order: 20
      },
      {
        id: 'video-color.levels',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.levels',
        descriptionKey: 'video-color.levelsDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['블랙', '화이트', '레벨', 'levels', 'black', 'white', 'colorlevels'],
        order: 30
      },
      {
        id: 'video-color.levelsBlack',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.levelsBlack',
        type: { kind: 'float', min: 0, max: 0.5, step: 0.0025 },
        default: LEVELS_DEFAULTS.black,
        keywords: ['블랙', '레벨', 'black', 'level'],
        order: 31,
        visibleWhen: (get) => get<boolean>('video-color.levels')
      },
      {
        id: 'video-color.levelsWhite',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.levelsWhite',
        type: { kind: 'float', min: 0.5, max: 1, step: 0.0025 },
        default: LEVELS_DEFAULTS.white,
        keywords: ['화이트', '레벨', 'white', 'level'],
        order: 32,
        visibleWhen: (get) => get<boolean>('video-color.levels')
      },
      {
        id: 'video-color.autoLevel',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.autoLevel',
        descriptionKey: 'video-color.autoLevelDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['자동', '레벨', 'auto', 'level', 'normalize'],
        order: 40
      },
      {
        id: 'video-color.chromaShift',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.chromaShift',
        descriptionKey: 'video-color.chromaShiftDesc',
        type: { kind: 'bool' },
        default: false,
        keywords: ['색', '틀어짐', '보정', 'chroma', 'shift', 'offset'],
        advanced: true,
        order: 50
      },
      {
        id: 'video-color.chromaShiftH',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.chromaShiftH',
        type: { kind: 'int', min: -CHROMA_SHIFT_LIMIT, max: CHROMA_SHIFT_LIMIT, step: 1 },
        default: CHROMA_SHIFT_DEFAULTS.horizontal,
        keywords: ['색', '가로', 'chroma', 'horizontal'],
        advanced: true,
        order: 51,
        visibleWhen: (get) => get<boolean>('video-color.chromaShift')
      },
      {
        id: 'video-color.chromaShiftV',
        section: 'video',
        group: 'colour',
        labelKey: 'video-color.chromaShiftV',
        type: { kind: 'int', min: -CHROMA_SHIFT_LIMIT, max: CHROMA_SHIFT_LIMIT, step: 1 },
        default: CHROMA_SHIFT_DEFAULTS.vertical,
        keywords: ['색', '세로', 'chroma', 'vertical'],
        advanced: true,
        order: 52,
        visibleWhen: (get) => get<boolean>('video-color.chromaShift')
      }
    ])

    filters.levels = flag('video-color.levels')
    filters.autoLevel = flag('video-color.autoLevel')
    filters.chromaShift = flag('video-color.chromaShift')

    /**
     * --- the settings WINDOW -> mpv ---------------------------------------
     *
     * Every listener below is guarded by `storing`, because this module writes
     * the same ids itself and `SettingsRegistry.set()` calls listeners
     * synchronously. Unguarded, one key press applied twice and announced twice;
     * see `storing`'s declaration for the measurement.
     */
    const onSetting = <T>(id: string, fn: (v: T) => void): void => {
      offs.push(
        ctx.settings.onChange<T>(id, (v) => {
          if (!storing) fn(v)
        })
      )
    }

    for (const knob of COLOUR_KNOBS) {
      onSetting<number>(settingIdOf(knob), (v) => {
        void applyKnob(knob, v)
      })
    }
    onSetting<string>('video-color.outputLevels', (v) => {
      void applyOutputLevels(toOutputLevels(v))
    })
    onSetting<boolean>('video-color.levels', (v) => {
      filters.levels = v
      void applyLevels()
    })
    onSetting<number>('video-color.levelsBlack', () => {
      void applyLevels('black')
    })
    onSetting<number>('video-color.levelsWhite', () => {
      void applyLevels('white')
    })
    onSetting<boolean>('video-color.autoLevel', (v) => {
      filters.autoLevel = v
      void applyAutoLevel()
    })
    onSetting<boolean>('video-color.chromaShift', (v) => {
      filters.chromaShift = v
      void applyChromaShift()
    })
    onSetting<number>('video-color.chromaShiftH', () => {
      void applyChromaShift('horizontal')
    })
    onSetting<number>('video-color.chromaShiftV', () => {
      void applyChromaShift('vertical')
    })

    /**
     * V01: "Observe all four so settings and OSD stay in sync." All FIVE, plus
     * `video-output-levels`. The bus refcounts, so this is one
     * `observe_property` per name however many modules ask, it fires
     * immediately with the cached value, and it is what lets `liveTuple()` be
     * a `peek()` rather than a round trip on every key repeat.
     */
    for (const name of [...COLOUR_KNOBS, 'video-output-levels']) {
      offs.push(
        ctx.mpv.observe(name, () => {
          /* the bus caches it; `peek()` is the read */
        })
      )
    }

    /**
     * §4: an option follows its property's owner, and all six are this
     * module's. Contributing them means the user's picture is correct on the
     * first frame instead of one property-write round trip after it — and it
     * survives a respawn (a VO change, an exclusive-mode change) for free,
     * because contributors run again on every spawn.
     *
     * `--gamma`, not `--gamma-factor`: the property's own spawn form, so the
     * value mpv comes up with and the value this module writes later are the
     * same scale. (`--gamma-factor` is live, not deprecated — see the header —
     * it is simply a different, multiplicative control.)
     */
    ctx.mpv.contributeArgs(20, () => {
      const tuple = liveTuple()
      return [
        ...COLOUR_KNOBS.map((k) => `--${k}=${tuple[k]}`),
        `--video-output-levels=${toOutputLevels(ctx.settings.get<string>('video-color.outputLevels'))}`
      ]
    })

    // --- V53 --------------------------------------------------------------

    offs.push(
      ctx.mpv.onEvent('start-file', () => {
        restored = false
      })
    )

    /**
     * A file with no memory of its own starts from the user's defaults, and the
     * previous file's per-file override does NOT leak into it.
     *
     * Nothing else does this: the per-file service diffs against a baseline it
     * snapshots at load time and writes back only what differs, so a file with
     * no stored slice never has `apply()` called at all — and mpv's properties
     * are process-global, so without this the +20 brightness someone set for
     * one episode silently follows them to the next film. `restored` keeps it
     * order-independent (see its declaration).
     */
    offs.push(
      ctx.mpv.afterFileLoaded(async () => {
        if (restored) return
        await applyTuple(defaultTuple())
        await applyOutputLevels(toOutputLevels(ctx.settings.get<string>('video-color.outputLevels')))
        await applyAllFilters()
      })
    )

    /**
     * The five knobs, the output-level choice and the three toggles are
     * per-file; the filter PARAMETERS are not.
     *
     * That split is M03's, for M03's reason: a file remembering "black point
     * 0.071" makes a later default change unshippable (P51), while a file
     * remembering "auto-level was on for this transfer" is exactly the point.
     * `apply()` writes mpv and never the settings store, so a per-file value
     * cannot redefine what other files start from.
     */
    ctx.perFile.slice({
      key: 'video-color',
      capture: () => {
        const tuple = liveTuple()
        return {
          ...tuple,
          outputLevels: toOutputLevels(ctx.mpv.peek<string>('video-output-levels')),
          levels: filters.levels,
          autoLevel: filters.autoLevel,
          chromaShift: filters.chromaShift
        }
      },
      apply: async (v) => {
        restored = true
        await applyTuple(toTuple(v as Record<string, unknown>))
        if (typeof v.outputLevels === 'string') {
          await ctx.mpv.set('video-output-levels', toOutputLevels(v.outputLevels))
        }
        if (typeof v.levels === 'boolean') filters.levels = v.levels
        if (typeof v.autoLevel === 'boolean') filters.autoLevel = v.autoLevel
        if (typeof v.chromaShift === 'boolean') filters.chromaShift = v.chromaShift
        await applyAllFilters()
      },
      rememberDefaults: {
        brightness: true,
        contrast: true,
        saturation: true,
        hue: true,
        gamma: true,
        outputLevels: true,
        levels: true,
        autoLevel: true,
        chromaShift: true
      }
    })

    // --- commands ---------------------------------------------------------

    ctx.commands.register([
      ...stepCommands(),
      {
        id: 'video-color.toggleLastUsed',
        labelKey: 'video-color.toggleLastUsed',
        category: 'video',
        // PotPlayer `Q` is "Disable / Last used Color Controls", re-transcribed
        // from its own English.ini. An earlier revision of §7.8 had Q as the
        // speed reset; that is `Z`, and it belongs to M10.
        defaults: { potplayer: ['KeyQ'] },
        run: () => toggleLastUsed()
      },
      {
        id: 'video-color.reset',
        labelKey: 'video-color.reset',
        category: 'video',
        run: () => resetAll()
      },
      {
        id: 'video-color.toggleLevels',
        labelKey: 'video-color.toggleLevels',
        category: 'video',
        run: () => toggleFilter('levels')
      },
      {
        id: 'video-color.toggleAutoLevel',
        labelKey: 'video-color.toggleAutoLevel',
        category: 'video',
        run: () => toggleFilter('autoLevel')
      },
      {
        id: 'video-color.toggleChromaShift',
        labelKey: 'video-color.toggleChromaShift',
        category: 'video',
        run: () => toggleFilter('chromaShift')
      },
      {
        id: 'video-color.setOutputLevels',
        labelKey: 'video-color.setOutputLevels',
        category: 'video',
        internal: true,
        run: (arg) => setOutputLevels(arg)
      },
      {
        id: 'video-color.setKnob',
        labelKey: 'video-color.setKnob',
        category: 'video',
        // The arg-driven entry point the renderer half and the legacy bridge
        // use; hidden from the keybind editor because a binding carries no
        // argument (§3.4).
        internal: true,
        run: (arg) => {
          const req = (arg ?? {}) as { knob?: unknown; value?: unknown }
          const knob = COLOUR_KNOBS.find((k) => k === req.knob)
          if (!knob) return
          return setKnob(knob, clampColour(req.value))
        }
      }
    ])

    // The renderer half's "reset" button (settings surface) …
    ctx.ipc.on('video-color:reset', () => {
      void resetAll()
    })
    // … and the stats block's pull (player surface). A pull rather than a push
    // because `StatsSection.fields()` is synchronous, so the renderer has to
    // hold the last answer and re-ask — the same shape as core's own
    // `core.refusals` section, and for the same reason.
    ctx.ipc.handle<void, { rows: StatsRow[] }>('video-color:stats', () => ({
      rows: statsRows()
    }))

    ctx.menu.contribute({
      id: 'video-color.menu',
      labelKey: 'video-color.menuTitle',
      order: 51,
      items: [
        {
          dynamic(): readonly MenuNode[] {
            const current = toOutputLevels(ctx.mpv.peek<string>('video-output-levels'))
            return [
              {
                labelKey: 'video-color.toggleLastUsed',
                commandId: 'video-color.toggleLastUsed',
                checked: !isNeutral(liveTuple())
              },
              { type: 'separator' },
              {
                labelKey: 'video-color.levels',
                commandId: 'video-color.toggleLevels',
                checked: filters.levels
              },
              {
                labelKey: 'video-color.autoLevel',
                commandId: 'video-color.toggleAutoLevel',
                checked: filters.autoLevel
              },
              {
                labelKey: 'video-color.chromaShift',
                commandId: 'video-color.toggleChromaShift',
                checked: filters.chromaShift
              },
              {
                labelKey: 'video-color.outputLevels',
                submenu: [
                  {
                    dynamic: (): readonly MenuNode[] =>
                      OUTPUT_LEVELS.map((v: OutputLevels) => ({
                        labelKey: `video-color.outputLevels.${v}`,
                        commandId: 'video-color.setOutputLevels',
                        arg: v,
                        radio: true,
                        checked: current === v
                      }))
                  }
                ]
              },
              { type: 'separator' },
              { labelKey: 'video-color.reset', commandId: 'video-color.reset' }
            ]
          }
        }
      ]
    })

    ctx.i18n.register('ko', {
      'video-color.menuTitle': '화면 색 조정',
      'video-color.brightness': '밝기',
      'video-color.contrast': '명암',
      'video-color.saturation': '채도',
      'video-color.hue': '색조',
      'video-color.gamma': '감마',
      'video-color.gammaDesc':
        '재생 중 바로 반영되고 파일별로 기억됩니다. 시작 옵션(--gamma-factor)과 달리 값을 되읽을 수 있어서 이 쪽을 씁니다.',
      'video-color.brightnessUp': '밝기 올리기',
      'video-color.brightnessDown': '밝기 내리기',
      'video-color.contrastUp': '명암 올리기',
      'video-color.contrastDown': '명암 내리기',
      'video-color.saturationUp': '채도 올리기',
      'video-color.saturationDown': '채도 내리기',
      'video-color.hueUp': '색조 올리기',
      'video-color.hueDown': '색조 내리기',
      'video-color.gammaUp': '감마 올리기',
      'video-color.gammaDown': '감마 내리기',
      'video-color.outputLevels': '출력 범위',
      'video-color.outputLevelsDesc':
        'TV(제한) 범위와 PC(전체) 범위. 검은 부분이 뿌옇거나 반대로 뭉개질 때만 바꾸세요. 일부 출력 장치는 이 값을 조용히 무시합니다.',
      'video-color.outputLevels.auto': '자동',
      'video-color.outputLevels.limited': '제한 (TV, 16-235)',
      'video-color.outputLevels.full': '전체 (PC, 0-255)',
      'video-color.setOutputLevels': '출력 범위 선택',
      'video-color.setKnob': '색 값 지정',
      'video-color.levels': '블랙/화이트 레벨',
      'video-color.levelsDesc':
        'CPU 필터입니다. 하드웨어 디코딩 화면이 메모리로 복사되므로 4K에서는 부담이 큽니다.',
      'video-color.levelsBlack': '블랙 포인트',
      'video-color.levelsWhite': '화이트 포인트',
      'video-color.autoLevel': '자동 레벨 보정',
      'video-color.autoLevelDesc':
        `CPU 필터입니다. 장면이 바뀔 때 화면이 출렁이지 않도록 평활화 값을 ${AUTOLEVEL_SMOOTHING}으로 고정했습니다.`,
      'video-color.chromaShift': '색 위치 보정',
      'video-color.chromaShiftDesc':
        '색 성분만 옮깁니다. 휘도를 옮기는 필터는 없으므로 색 틀어짐 보정에만 쓰세요. CPU 필터입니다.',
      'video-color.chromaShiftH': '색 가로 이동',
      'video-color.chromaShiftV': '색 세로 이동',
      'video-color.toggleLevels': '블랙/화이트 레벨 켜기/끄기',
      'video-color.toggleAutoLevel': '자동 레벨 보정 켜기/끄기',
      'video-color.toggleChromaShift': '색 위치 보정 켜기/끄기',
      'video-color.toggleLastUsed': '색 조정 끄기/되살리기',
      'video-color.reset': '색 조정 초기화',
      'video-color.stats': '화면 색 조정',
      'video-color.statsCpuFilters': 'CPU 필터',
      'video-color.help': '화면 색 조정',
      'video-color.helpProps': '밝기·명암·채도·색조·감마는 GPU에서 처리되므로 성능 부담이 없습니다.',
      'video-color.helpFilters':
        '아래 세 항목은 CPU 필터라서 하드웨어 디코딩 화면을 메모리로 복사합니다. 필요할 때만 켜세요.',
      'video-color.helpReset': '이 파일의 색 조정 초기화',
      'video-color.osd.reset': '색 조정 초기화됨',
      'video-color.osd.colourOff': '색 조정 끔',
      'video-color.osd.colourOn': '색 조정 되살림',
      'video-color.osd.nothingToRestore': '되살릴 색 조정이 없습니다',
      'video-color.osd.levelsOn': '블랙/화이트 레벨 켜짐',
      'video-color.osd.levelsOff': '블랙/화이트 레벨 꺼짐',
      'video-color.osd.autoLevelOn': '자동 레벨 보정 켜짐',
      'video-color.osd.autoLevelOff': '자동 레벨 보정 꺼짐',
      'video-color.osd.chromaShiftOn': '색 위치 보정 켜짐',
      'video-color.osd.chromaShiftOff': '색 위치 보정 꺼짐'
    })
    ctx.i18n.register('en', {
      'video-color.menuTitle': 'Colour',
      'video-color.brightness': 'Brightness',
      'video-color.contrast': 'Contrast',
      'video-color.saturation': 'Saturation',
      'video-color.hue': 'Hue',
      'video-color.gamma': 'Gamma',
      'video-color.gammaDesc':
        'Applies live and is remembered per file. Preferred over the startup option (--gamma-factor) because the property can be read back.',
      'video-color.brightnessUp': 'Brightness up',
      'video-color.brightnessDown': 'Brightness down',
      'video-color.contrastUp': 'Contrast up',
      'video-color.contrastDown': 'Contrast down',
      'video-color.saturationUp': 'Saturation up',
      'video-color.saturationDown': 'Saturation down',
      'video-color.hueUp': 'Hue up',
      'video-color.hueDown': 'Hue down',
      'video-color.gammaUp': 'Gamma up',
      'video-color.gammaDown': 'Gamma down',
      'video-color.outputLevels': 'Output range',
      'video-color.outputLevelsDesc':
        'TV (limited) versus PC (full) range. Change it only when blacks look washed out or crushed. Some outputs silently ignore it.',
      'video-color.outputLevels.auto': 'Auto',
      'video-color.outputLevels.limited': 'Limited (TV, 16-235)',
      'video-color.outputLevels.full': 'Full (PC, 0-255)',
      'video-color.setOutputLevels': 'Set output range',
      'video-color.setKnob': 'Set colour value',
      'video-color.levels': 'Black / white level',
      'video-color.levelsDesc':
        'A CPU filter: hardware-decoded frames are copied back to system memory. Costly at 4K.',
      'video-color.levelsBlack': 'Black point',
      'video-color.levelsWhite': 'White point',
      'video-color.autoLevel': 'Auto level',
      'video-color.autoLevelDesc':
        `A CPU filter. Smoothing is fixed at ${AUTOLEVEL_SMOOTHING} so the picture does not pump on every cut.`,
      'video-color.chromaShift': 'Chroma offset',
      'video-color.chromaShiftDesc':
        'Moves the chroma planes only. There is no luma-offset filter, so use this for colour misalignment. A CPU filter.',
      'video-color.chromaShiftH': 'Chroma horizontal',
      'video-color.chromaShiftV': 'Chroma vertical',
      'video-color.toggleLevels': 'Toggle black / white level',
      'video-color.toggleAutoLevel': 'Toggle auto level',
      'video-color.toggleChromaShift': 'Toggle chroma offset',
      'video-color.toggleLastUsed': 'Disable / last-used colour controls',
      'video-color.reset': 'Reset colour',
      'video-color.stats': 'Colour',
      'video-color.statsCpuFilters': 'CPU filters',
      'video-color.help': 'Colour adjustment',
      'video-color.helpProps':
        'Brightness, contrast, saturation, hue and gamma run on the GPU and cost nothing.',
      'video-color.helpFilters':
        'The three below are CPU filters and copy hardware-decoded frames back to system memory. Switch them on only when you need them.',
      'video-color.helpReset': 'Reset colour for this file',
      'video-color.osd.reset': 'Colour reset',
      'video-color.osd.colourOff': 'Colour controls off',
      'video-color.osd.colourOn': 'Colour controls restored',
      'video-color.osd.nothingToRestore': 'No colour adjustment to restore',
      'video-color.osd.levelsOn': 'Black / white level on',
      'video-color.osd.levelsOff': 'Black / white level off',
      'video-color.osd.autoLevelOn': 'Auto level on',
      'video-color.osd.autoLevelOff': 'Auto level off',
      'video-color.osd.chromaShiftOn': 'Chroma offset on',
      'video-color.osd.chromaShiftOff': 'Chroma offset off'
    })
  },

  dispose(): void {
    // No timers and no processes. What there IS to release is every observer,
    // event hook and settings listener registered above — the bus refcounts its
    // `observe_property`s, so leaving them registered leaves mpv observing six
    // properties for a module that is gone. `lastUsed` is app state and dies
    // with the process, which is what V03 asks for.
    for (const off of offs) off()
    offs = []
    lastUsed = null
  }
}

export default mod
