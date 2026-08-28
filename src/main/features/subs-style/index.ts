import type { FeatureContext, FeatureModule, Unsubscribe } from '@shared/feature-api'
import {
  PRESETS,
  ROWS,
  argFor,
  coerce,
  cycleChoicesOf,
  cycleNext,
  descriptors,
  fromMpv,
  isImageSubCodec,
  presetWrites,
  resetWrites,
  rowByKey,
  settingIdOf,
  stepValue,
  toMpv,
  type StyleRow
} from './style.ts'
import { mirrorLegacyStyle, readLegacyStyle } from './legacy.ts'

/**
 * M19 subs-style — S17–S26, S46, S51, S53.
 *
 * Font, size, colour, outline, shadow, background box, position, margins,
 * bold/italic, the five-state ASS override, SDH/regex filtering, embedded fonts
 * and VSFilter colour compatibility: fifty mpv properties, all owned here.
 *
 * THREE DECISIONS WORTH READING BEFORE CHANGING ANYTHING.
 *
 * 1. THE ASS OVERRIDE IS OFF BY DEFAULT, and mpv's own default is `scale`. A
 *    release group's styling is part of the release — a typeset sign moved to
 *    our font and our margin is worse than no styling at all — so `no` is the
 *    default and the other four states are one select away. This is the only
 *    place the module deliberately diverges from the binary's default, and
 *    `style.ts` records it in the row's `mpvDefault` so the divergence is data
 *    rather than a comment.
 *
 * 2. EVERY VALUE GOES THROUGH `coerce()`. An out-of-range property write does
 *    not clamp and does not report a range error: it FAILS with `unsupported
 *    format for accessing property` (measured — see style.ts). So a preset, a
 *    repeated keybind or a hand-edited config.json that overshoots would be a
 *    silent no-op, which is the shape of "this setting does nothing" in a bug
 *    report. Clamping is the module's job, not mpv's.
 *
 * 3. THE SETTINGS ARE THE SOURCE, NOT THE PROPERTIES. Every row is contributed
 *    as a spawn argument AND written on change, so the state survives an mpv
 *    respawn (`ctx.mpv.requestRestart` from M07, a VO switch) with no per-file
 *    restore and no reading back from mpv. The three String-list rows are the
 *    exception: they are property writes only, because mpv's CLI splits a string
 *    list on `,` and `sub-filter-sdh-enclosures` has commas and brackets INSIDE
 *    its default value (`(),[],（）`).
 *
 * What this module does NOT do, on purpose:
 *   - it never issues `sub-reload`. That is M17's command; the two rows libass
 *     only reads at track-parse time call `subs-tracks.reload` (S22).
 *   - it never touches `sub-speed` or `sub-fps`. See the report: the first is
 *     M20's, the second is owned by nobody.
 */

let ctx: FeatureContext
const subscriptions: Unsubscribe[] = []
/** The codec of the SELECTED subtitle track, for S25's image-subtitle warning. */
let subCodec: string | null = null
let reloadPending = false

// --- reading and writing one row ------------------------------------------

function valueOf(row: StyleRow): unknown {
  return coerce(row, ctx.settings.get<unknown>(settingIdOf(row)))
}

function writeSetting(row: StyleRow, value: unknown): void {
  ctx.settings.set(settingIdOf(row), coerce(row, value))
}

function pushRow(row: StyleRow): void {
  const sent = toMpv(row, valueOf(row))
  void ctx.mpv.set(row.mpv, sent).catch(async (e: Error) => {
    /**
     * A refused write here is a real defect — a range this table got wrong, or a
     * property this build does not have — so it is logged rather than swallowed,
     * but it must not take the rest of the batch down with it.
     *
     * AND IT SAYS WHAT MPV ACTUALLY HOLDS. An out-of-range write fails with
     * `unsupported format for accessing property` and leaves the OLD value in
     * place (finding 2), so the settings store and mpv have silently diverged at
     * exactly this point. `could not set sub-pos` alone sends the next person
     * hunting a type error; `could not set sub-pos to 200 (mpv holds 100)` names
     * the range problem. `fromMpv()` and not `coerce()` for the readback —
     * finding 1.
     */
    let held = 'unreadable'
    try {
      held = JSON.stringify(fromMpv(row, await ctx.mpv.get<unknown>(row.mpv)))
    } catch {
      /* the property may not exist in this build, which the message below says */
    }
    ctx.log.warn(
      `could not set ${row.mpv} to ${JSON.stringify(sent)} (mpv holds ${held}): ${e.message}`
    )
  })
}

/**
 * S22. libass reads `sub-ass-style-overrides` and `sub-ass-styles` when it
 * parses the track, so an already-loaded EXTERNAL track keeps its old styling
 * until it is re-read. `sub-reload` is M17's command and M17 debounces it,
 * greys it for embedded tracks and re-applies `sid` afterwards — all three of
 * which are why this is a mediator call and not a command of ours.
 */
function requestReload(): void {
  if (reloadPending) return
  if (!ctx.commands.has('subs-tracks.reload')) return
  reloadPending = true
  setTimeout(() => {
    reloadPending = false
    void ctx.commands.invoke('subs-tracks.reload').catch(() => undefined)
  }, 0)
}

// --- the settings-window state (S25) --------------------------------------

/**
 * The payload of `subs-style:state`.
 *
 * DUPLICATED, and not by choice: `src/shared/features/subs-style/` is not in
 * M19's `ownedFiles`, so the wire type §10 says belongs in one file compiled by
 * both halves has to be written twice. The other copy is in
 * `src/renderer/src/features/subs-style/index.ts`. See the report.
 */
export interface SubsStyleUiState {
  /** True while the selected subtitle track is a bitmap format (S25). */
  imageSub: boolean
  codec: string | null
  assOverride: string
  presets: readonly string[]
  /**
   * Setting id -> the current `#AARRGGBB`, for the four `custom` colour controls.
   *
   * WHY THE PAYLOAD CARRIES VALUES AT ALL. `SettingBinding.onChange` fires only
   * for writes the settings FORM made, so a colour changed by a preset, by
   * `resetStyle` or by a keybind leaves the swatch showing the old colour with
   * no way to know. That is a property of the core binding, not a bug in it —
   * M12 hit the same thing and answered it the same way, with its own state
   * channel. A colour control that lies about the colour is worse than none.
   */
  colors: Readonly<Record<string, string>>
}

/** The payload's key set, pinned by `module.test.ts`. See the duplication note. */
export const UI_STATE_KEYS = ['assOverride', 'codec', 'colors', 'imageSub', 'presets'] as const

function uiState(): SubsStyleUiState {
  const row = rowByKey('assOverride')
  const colors: Record<string, string> = {}
  for (const r of ROWS) if (r.kind === 'color') colors[settingIdOf(r)] = String(valueOf(r))
  return {
    imageSub: isImageSubCodec(subCodec),
    codec: subCodec,
    assOverride: row ? String(valueOf(row)) : 'no',
    presets: PRESETS.map((p) => p.id),
    colors
  }
}

/**
 * Coalesced to one message per turn. `applyPreset` writes eight settings, each
 * of which would otherwise be its own broadcast and its own full re-render of
 * the settings page's section.
 */
let broadcastQueued = false
function broadcast(): void {
  if (broadcastQueued) return
  broadcastQueued = true
  queueMicrotask(() => {
    broadcastQueued = false
    ctx.ipc.send('subs-style:state', uiState(), 'settings')
  })
}

// --- OSD helpers ----------------------------------------------------------

function osd(text: string): void {
  ctx.osd.show({ kind: 'info', text })
}

function optLabel(key: string, value: unknown): string {
  return ctx.i18n.t(`subs-style.opt.${key}.${String(value)}`)
}

// --- commands -------------------------------------------------------------

function stepRow(key: string, delta: number, label: string, fmt: (v: number) => string): void {
  const row = rowByKey(key)
  if (!row) return
  const next = stepValue(row, valueOf(row), delta)
  writeSetting(row, next)
  osd(`${label} ${fmt(next)}`)
}

/**
 * The keybindable half of an enum row. Steps the row's CYCLE list, which for
 * `assOverride` is S21's four states and not the select's five — see
 * `StyleRow.cycleChoices`.
 */
function cycleRow(key: string): void {
  const row = rowByKey(key)
  if (!row) return
  const choices = cycleChoicesOf(row)
  if (choices.length === 0) return
  const next = cycleNext(choices, valueOf(row))
  writeSetting(row, next)
  osd(`${ctx.i18n.t(`subs-style.label.${key}`)}: ${optLabel(key, next)}`)
}

function toggleRow(key: string, onKey: string, offKey: string): void {
  const row = rowByKey(key)
  if (!row) return
  const next = valueOf(row) !== true
  writeSetting(row, next)
  osd(ctx.i18n.t(next ? onKey : offKey))
}

function applyPreset(id: string): void {
  const writes = presetWrites(id)
  const ids = Object.keys(writes)
  if (ids.length === 0) return
  for (const settingId of ids) ctx.settings.set(settingId, writes[settingId])
  osd(ctx.i18n.t(`subs-style.preset.${id}`))
  broadcast()
}

const mod: FeatureModule = {
  id: 'subs-style',
  // Copied verbatim from the modules.json row (§1): `core-mpv-bus` is satisfied
  // by construction and `subs-tracks` is a real edge — M17 must be up before
  // this module can call its reload mediator.
  dependsOn: ['core-mpv-bus', 'subs-tracks'],
  /**
   * All fifty, and the table in `style.ts` is the single expression of them:
   * `style.test.ts` asserts this array, the table and the `ownedProperties` of
   * M19's row in `docs/parity/modules.json` are the same set, in both
   * directions. A property that reaches mpv from a row nobody declared, or a
   * declaration with no row behind it, fails that test.
   */
  ownsProperties: [
    'sub-font',
    'sub-font-size',
    'sub-bold',
    'sub-italic',
    'sub-color',
    'sub-outline-color',
    'sub-outline-size',
    'sub-back-color',
    'sub-shadow-offset',
    'sub-border-style',
    'sub-pos',
    'sub-margin-x',
    'sub-margin-y',
    'sub-align-x',
    'sub-align-y',
    'sub-justify',
    'sub-spacing',
    'sub-line-spacing',
    'sub-margin-y-offset',
    'sub-scale-signs',
    'sub-ass-style-overrides',
    'sub-ass-styles',
    'sub-ass-force-margins',
    'stretch-dvd-subs',
    'stretch-image-subs-to-screen',
    'image-subs-video-resolution',
    'sub-forced-events-only',
    'image-subs-hdr-peak',
    'sub-hdr-peak',
    'sub-filter-sdh',
    'sub-filter-sdh-harder',
    'sub-filter-sdh-enclosures',
    'sub-filter-regex',
    'sub-filter-regex-enable',
    'sub-filter-regex-plain',
    'sub-filter-regex-warn',
    'secondary-sub-ass-override',
    'sub-blur',
    'sub-scale',
    'sub-scale-by-window',
    'sub-scale-with-window',
    'sub-ass-override',
    'sub-ass-scale-with-window',
    'sub-ass-vsfilter-color-compat',
    'sub-use-margins',
    'sub-gauss',
    'embeddedfonts',
    'sub-fonts-dir',
    'secondary-sub-scale',
    'secondary-sub-pos'
  ],

  async setup(c): Promise<void> {
    ctx = c

    /**
     * FIRST, before anything that can resolve a key. `settings.define()` snapshots
     * descriptors whose labels the settings window later resolves, the legacy
     * migration below can emit an OSD line, and `ctx.i18n.t()` returns the raw KEY
     * for a message that is not registered yet — which is how a Korean UI ends up
     * showing `subs-style.label.font` to somebody. Nothing here is expensive.
     */
    registerMessages()

    ctx.settings.define(descriptors())

    /**
     * v0.1.1 carried exactly two of these as `AppConfig` fields, wired to
     * `<input id="subScale">` and `<select id="subAssOverride">` in the shared
     * settings.html — the M38 collision §7 describes. Bring them across once,
     * before anything is applied, so an upgrading user's subtitle size survives.
     * `subAssOverride` was a BOOLEAN there; the row's `boolMap` turns `true`
     * into `force`, which is what the checkbox meant.
     */
    const legacy = await readLegacyStyle()
    if (legacy.subScale !== undefined) {
      const row = rowByKey('scale')
      if (row) writeSetting(row, legacy.subScale)
    }
    if (legacy.subAssOverride !== undefined) {
      const row = rowByKey('assOverride')
      if (row) writeSetting(row, legacy.subAssOverride)
    }

    for (const row of ROWS) {
      subscriptions.push(
        ctx.settings.onChange<unknown>(settingIdOf(row), () => {
          pushRow(row)
          if (row.reload) requestReload()
          // Everything the settings page's own section renders — the override
          // state and the four colours — has to reach it however it changed:
          // form, keybind, menu radio, preset or reset.
          if (row.key === 'assOverride' || row.kind === 'color') broadcast()
          if (row.key === 'assOverride') {
            void mirrorLegacyStyle({ subAssOverride: valueOf(row) === 'force' })
          }
          if (row.key === 'scale') {
            void mirrorLegacyStyle({ subScale: valueOf(row) as number })
          }
        })
      )
    }

    /**
     * Priority 10, the same band every other Wave-1 module contributes in. One
     * option per row, so the first frame of the first file is already styled;
     * `argFor()` returns null for the three list rows and for an empty path,
     * and the table's names are unique, which is what keeps the duplicate-option
     * boot check (§4) quiet.
     */
    ctx.mpv.contributeArgs(10, () => {
      const args: string[] = []
      for (const row of ROWS) {
        const arg = argFor(row, valueOf(row))
        if (arg) args.push(arg)
      }
      return args
    })

    subscriptions.push(
      /**
       * The list rows, plus the two paths, applied after `playback-restart`.
       * `afterFileLoaded` and never `file-loaded`: a write made at
       * `file-loaded` can be dropped outright (§3).
       */
      ctx.mpv.afterFileLoaded(() => {
        for (const row of ROWS) if (row.noArg) pushRow(row)
        broadcast()
      }),
      /**
       * S25. `current-tracks/sub/codec` is `undefined` with no subtitle
       * selected and unavailable at idle — both legitimate values, neither
       * coerced to `''` by the bus. Verified observable against the pinned
       * binary.
       */
      ctx.mpv.observe<string>('current-tracks/sub/codec', (codec) => {
        const next = typeof codec === 'string' ? codec : null
        if (next === subCodec) return
        subCodec = next
        broadcast()
      })
    )

    ctx.ipc.handle<void, SubsStyleUiState>('subs-style:query', () => uiState())
    ctx.ipc.on<{ id?: string }>('subs-style:applyPreset', (req) => {
      applyPreset(String(req?.id ?? ''))
    })
    /**
     * Reset is not a preset — it clears every row back to its descriptor default
     * rather than writing a named subset — so the settings page needs its own
     * channel rather than a magic preset id that `presetById()` would have to
     * pretend not to find.
     */
    ctx.ipc.on<void>('subs-style:reset', () => {
      void ctx.commands.invoke('subs-style.resetStyle')
    })

    ctx.commands.register([
      /**
       * THE THREE LEGACY-BRIDGE IDS. `src/main/ipc.ts`'s `applyConfigChanges()`
       * invokes `subs-style.setScale` (number) and `subs-style.setAssOverride`
       * (BOOLEAN) by name whenever the v0.1 config surface changes, and that
       * file is core's. The ids and the argument shapes are therefore a contract
       * this module may not quietly rename; `setAssOverrideMode` is the
       * five-state entry point added beside the boolean one rather than in place
       * of it.
       */
      {
        id: 'subs-style.setScale',
        labelKey: 'subs-style.cmd.setScale',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const row = rowByKey('scale')
          if (!row) return
          writeSetting(row, Number(arg))
          osd(`${ctx.i18n.t('subs-style.label.scale')} ${(valueOf(row) as number).toFixed(2)}×`)
        }
      },
      {
        id: 'subs-style.setPos',
        labelKey: 'subs-style.cmd.setPos',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const row = rowByKey('pos')
          if (row) writeSetting(row, Number(arg))
        }
      },
      {
        id: 'subs-style.setAssOverride',
        labelKey: 'subs-style.cmd.setAssOverride',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const row = rowByKey('assOverride')
          // The legacy surface is a checkbox: `true` means "use MY font", which
          // is `force`, and `false` means "leave the release alone", which is
          // `no`. Anything else is treated as the five-state string.
          if (row) writeSetting(row, typeof arg === 'boolean' ? arg : String(arg))
        }
      },
      {
        id: 'subs-style.setAssOverrideMode',
        labelKey: 'subs-style.cmd.setAssOverrideMode',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const row = rowByKey('assOverride')
          if (row) writeSetting(row, String(arg))
        }
      },

      // --- keybindable ----------------------------------------------------
      {
        id: 'subs-style.scaleUp',
        labelKey: 'subs-style.cmd.scaleUp',
        category: 'subtitles',
        // The mpv preset gets mpv's own pair; `Shift+KeyG`/`Shift+KeyF` are
        // subs-sync's under `default` only, so the two never collide inside one
        // preset.
        defaults: { default: ['Alt+Equal'], potplayer: ['Alt+Equal'], mpv: ['Shift+KeyG'] },
        run: () =>
          stepRow('scale', 0.1, ctx.i18n.t('subs-style.label.scale'), (v) => `${v.toFixed(2)}×`)
      },
      {
        id: 'subs-style.scaleDown',
        labelKey: 'subs-style.cmd.scaleDown',
        category: 'subtitles',
        defaults: { default: ['Alt+Minus'], potplayer: ['Alt+Minus'], mpv: ['Shift+KeyF'] },
        run: () =>
          stepRow('scale', -0.1, ctx.i18n.t('subs-style.label.scale'), (v) => `${v.toFixed(2)}×`)
      },
      {
        id: 'subs-style.posUp',
        labelKey: 'subs-style.cmd.posUp',
        category: 'subtitles',
        // `sub-pos` counts DOWNWARDS: 100 is the authored position and >100
        // moves the text lower, so "up" subtracts. mpv's own `r` does the same.
        defaults: { default: ['Alt+ArrowUp'], potplayer: ['Alt+ArrowUp'], mpv: ['KeyR'] },
        run: () => stepRow('pos', -1, ctx.i18n.t('subs-style.label.pos'), (v) => String(v))
      },
      {
        id: 'subs-style.posDown',
        labelKey: 'subs-style.cmd.posDown',
        category: 'subtitles',
        defaults: {
          default: ['Alt+ArrowDown'],
          potplayer: ['Alt+ArrowDown'],
          mpv: ['Shift+KeyR']
        },
        run: () => stepRow('pos', 1, ctx.i18n.t('subs-style.label.pos'), (v) => String(v))
      },
      {
        id: 'subs-style.cycleAssOverride',
        labelKey: 'subs-style.cmd.cycleAssOverride',
        category: 'subtitles',
        menuPath: 'subtitles',
        menuOrder: 20,
        defaults: { default: ['Alt+KeyA'], potplayer: ['Alt+KeyA'] },
        run: () => cycleRow('assOverride')
      },
      {
        id: 'subs-style.cycleBorderStyle',
        labelKey: 'subs-style.cmd.cycleBorderStyle',
        category: 'subtitles',
        defaults: { default: ['Alt+KeyB'], potplayer: ['Alt+KeyB'] },
        run: () => cycleRow('borderStyle')
      },
      {
        id: 'subs-style.toggleBold',
        labelKey: 'subs-style.cmd.toggleBold',
        category: 'subtitles',
        run: () => toggleRow('bold', 'subs-style.osd.boldOn', 'subs-style.osd.boldOff')
      },
      {
        id: 'subs-style.toggleSdh',
        labelKey: 'subs-style.cmd.toggleSdh',
        category: 'subtitles',
        run: () => toggleRow('filterSdh', 'subs-style.osd.sdhOn', 'subs-style.osd.sdhOff')
      },
      {
        id: 'subs-style.toggleEmbeddedFonts',
        labelKey: 'subs-style.cmd.toggleEmbeddedFonts',
        category: 'subtitles',
        run: () =>
          toggleRow('embeddedFonts', 'subs-style.osd.embeddedOn', 'subs-style.osd.embeddedOff')
      },
      {
        id: 'subs-style.applyPreset',
        labelKey: 'subs-style.cmd.applyPreset',
        category: 'subtitles',
        internal: true,
        run: (arg) => applyPreset(String(arg ?? ''))
      },
      {
        /**
         * The arg-driven half of the border-style row: the menu renders it as a
         * radio group, `cycleBorderStyle` is the keybindable half. Both write the
         * same setting, so there is one source of truth and no state to sync.
         */
        id: 'subs-style.applyBorderStyle',
        labelKey: 'subs-style.cmd.applyBorderStyle',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const row = rowByKey('borderStyle')
          if (!row) return
          writeSetting(row, String(arg))
          osd(
            `${ctx.i18n.t('subs-style.label.borderStyle')}: ${optLabel('borderStyle', String(arg))}`
          )
        }
      },
      {
        id: 'subs-style.resetStyle',
        labelKey: 'subs-style.cmd.resetStyle',
        category: 'subtitles',
        defaults: { default: ['Alt+Digit0'], potplayer: ['Alt+Digit0'] },
        run: () => {
          const writes = resetWrites()
          for (const id of Object.keys(writes)) ctx.settings.set(id, writes[id])
          osd(ctx.i18n.t('subs-style.osd.reset'))
          broadcast()
        }
      }
    ])

    ctx.menu.contribute({
      id: 'subs-style.menu',
      labelKey: 'subs-style.menuTitle',
      // 40 is the `subtitles` root, 41 is M17's track section. This sits under
      // both, which is where "how it looks" belongs relative to "which track".
      order: 42,
      items: [
        {
          labelKey: 'subs-style.menuPresets',
          submenu: PRESETS.map((p) => ({
            labelKey: `subs-style.preset.${p.id}`,
            commandId: 'subs-style.applyPreset',
            arg: p.id
          }))
        },
        {
          labelKey: 'subs-style.label.assOverride',
          submenu: [
            {
              dynamic: () => {
                const row = rowByKey('assOverride')
                const current = row ? String(valueOf(row)) : 'no'
                return (row?.choices ?? []).map((v) => ({
                  labelKey: `subs-style.opt.assOverride.${v}`,
                  commandId: 'subs-style.setAssOverrideMode',
                  arg: v,
                  radio: true,
                  checked: v === current
                }))
              }
            }
          ]
        },
        {
          labelKey: 'subs-style.label.borderStyle',
          submenu: [
            {
              dynamic: () => {
                const row = rowByKey('borderStyle')
                const current = row ? String(valueOf(row)) : ''
                return (row?.choices ?? []).map((v) => ({
                  labelKey: `subs-style.opt.borderStyle.${v}`,
                  commandId: 'subs-style.applyBorderStyle',
                  arg: v,
                  radio: true,
                  checked: v === current
                }))
              }
            }
          ]
        },
        { type: 'separator' },
        { commandId: 'subs-style.scaleUp' },
        { commandId: 'subs-style.scaleDown' },
        { commandId: 'subs-style.posUp' },
        { commandId: 'subs-style.posDown' },
        { type: 'separator' },
        { commandId: 'subs-style.toggleBold' },
        { commandId: 'subs-style.toggleSdh' },
        { commandId: 'subs-style.toggleEmbeddedFonts' },
        { commandId: 'subs-style.resetStyle' }
      ]
    })

  },

  dispose(): void {
    for (const off of subscriptions.splice(0)) off()
  }
}

// --- i18n -----------------------------------------------------------------

function registerMessages(): void {
  ctx.i18n.register('ko', {
    'subs-style.menuTitle': '자막 모양',
    'subs-style.menuPresets': '자막 스타일 프리셋',

    'subs-style.group.font': '글꼴과 크기',
    'subs-style.group.colour': '색상과 테두리',
    'subs-style.group.position': '위치와 여백',
    'subs-style.group.ass': 'ASS/SSA 스타일과 글꼴',
    'subs-style.group.filter': '자막 텍스트 필터',
    'subs-style.group.image': '이미지 자막 (PGS·VobSub)',

    'subs-style.label.font': '글꼴',
    'subs-style.desc.font':
      '글꼴 이름을 그대로 적습니다. Windows는 DirectWrite를 쓰므로 "Malgun Gothic"과 "맑은 고딕" 둘 다 됩니다.',
    'subs-style.label.fontSize': '글자 크기',
    'subs-style.desc.fontSize':
      '창 높이 720픽셀 기준입니다. 창 크기에 따라 자동으로 커지므로 창을 키울 때마다 다시 맞출 필요가 없습니다.',
    'subs-style.label.bold': '굵게',
    'subs-style.desc.bold': 'ASS 자막에는 스타일 덮어쓰기가 "강제"일 때만 적용됩니다.',
    'subs-style.label.italic': '기울임',
    'subs-style.desc.italic': 'ASS 자막에는 스타일 덮어쓰기가 "강제"일 때만 적용됩니다.',
    'subs-style.label.scale': '자막 배율',
    'subs-style.desc.scale':
      'ASS 자막에도 함께 적용되어 간판·효과 자막이 어긋날 수 있습니다. 되도록 글자 크기를 조절하세요.',
    'subs-style.label.spacing': '자간',
    'subs-style.desc.spacing': '글자 사이 간격입니다.',
    'subs-style.label.lineSpacing': '행간',
    'subs-style.desc.lineSpacing': '두 줄 이상일 때 줄 사이 간격입니다.',
    'subs-style.label.blur': '흐림',
    'subs-style.desc.blur': '글자 경계를 부드럽게 합니다. 0이면 끔.',
    'subs-style.label.scaleByWindow': '창 크기에 따라 배율 적용',
    'subs-style.desc.scaleByWindow': '끄면 영상 해상도를 기준으로 크기를 정합니다.',
    'subs-style.label.scaleWithWindow': '창 크기에 따라 크기 조정',
    'subs-style.desc.scaleWithWindow': '창을 키우면 자막도 같이 커집니다.',

    'subs-style.label.color': '글자 색',
    'subs-style.desc.color': '투명도를 포함한 색입니다.',
    'subs-style.label.outlineColor': '테두리 색',
    'subs-style.desc.outlineColor': '글자 외곽선 색입니다.',
    'subs-style.label.outlineSize': '테두리 두께',
    'subs-style.desc.outlineSize': '0이면 테두리를 그리지 않습니다.',
    'subs-style.label.backColor': '배경·그림자 색',
    'subs-style.desc.backColor':
      'mpv에서 그림자 색과 배경 상자 색은 같은 값입니다(--sub-shadow-color는 --sub-back-color의 다른 이름).',
    'subs-style.label.shadowOffset': '그림자 거리',
    'subs-style.desc.shadowOffset':
      'mpv에는 그림자 "크기"가 없고 거리만 있습니다. 0이면 그림자를 그리지 않습니다.',
    'subs-style.label.borderStyle': '테두리 방식',
    'subs-style.desc.borderStyle':
      '"배경 상자"는 자막 줄 전체에 반투명 상자를 깔아 밝은 장면에서도 읽히게 합니다.',

    'subs-style.label.pos': '세로 위치',
    'subs-style.desc.pos':
      '100이 원래 위치이고 커질수록 아래로 내려갑니다. 100을 넘으면 글자가 잘릴 수 있어, 올릴 때는 아래 여백을 쓰는 편이 안전합니다.',
    'subs-style.label.marginX': '좌우 여백',
    'subs-style.desc.marginX':
      'mpv에는 자막을 좌우로 미는 값이 없어, 가로 정렬을 왼쪽으로 두고 이 값을 키워 흉내냅니다.',
    'subs-style.label.marginY': '아래 여백',
    'subs-style.desc.marginY': '자막을 올릴 때는 세로 위치보다 이 값을 쓰세요.',
    'subs-style.label.marginYOffset': '아래 여백 보정',
    'subs-style.desc.marginYOffset':
      '조작 막대가 자막을 가릴 때 잠깐 밀어 올리려고 만든 값입니다.',
    'subs-style.label.alignX': '가로 정렬',
    'subs-style.desc.alignX': 'ASS 자막에는 적용되지 않습니다.',
    'subs-style.label.alignY': '세로 정렬',
    'subs-style.desc.alignY': 'ASS 자막에는 적용되지 않습니다.',
    'subs-style.label.justify': '줄 정렬',
    'subs-style.desc.justify': '여러 줄일 때 줄을 어느 쪽에 맞출지 정합니다.',
    'subs-style.label.useMargins': '검은 띠에도 자막 그리기',
    'subs-style.desc.useMargins':
      '화면 위아래 검은 띠 영역까지 자막을 내보냅니다. 자막이 없을 때도 아래쪽에 항상 같은 여백을 두려면 이 설정이 아니라 화면 설정의 "아래쪽 화면 여백"을 쓰세요.',
    'subs-style.label.assForceMargins': 'ASS 자막도 검은 띠에 그리기',
    'subs-style.desc.assForceMargins': 'ASS 자막에도 위 설정을 강제합니다.',

    'subs-style.label.assOverride': 'ASS 스타일 덮어쓰기',
    'subs-style.desc.assOverride':
      '기본값은 "끔"입니다. 제작자가 지정한 글꼴·위치를 그대로 보여 줍니다. "강제"로 두면 위의 글꼴·색상 설정이 이깁니다.',
    'subs-style.label.scaleSigns': '간판 자막도 배율 적용',
    'subs-style.desc.scaleSigns':
      '자막 배율·글자 크기를 간판·효과 자막(위치가 지정된 ASS 이벤트)에도 함께 적용합니다. "비율"이나 "강제" 모드에서 애니메이션 자막이 어긋나지 않게 해 줍니다.',
    'subs-style.label.assScaleWithWindow': 'ASS 자막도 창 크기에 맞추기',
    'subs-style.desc.assScaleWithWindow': '제작자 의도와 달라질 수 있어 기본은 끔입니다.',
    'subs-style.label.assStyleOverrides': 'ASS 스타일 개별 지정',
    'subs-style.desc.assStyleOverrides':
      '한 줄에 하나씩. 예: Default.Bold=1 · Default.Fontname=맑은 고딕 · ScaledBorderAndShadow=yes. 덮어쓰기가 "끔"이면 무시됩니다.',
    'subs-style.label.assStyles': 'ASS 스타일 파일',
    'subs-style.desc.assStyles': '.ass 파일의 스타일 정의만 가져와 씁니다.',
    'subs-style.label.vsfilterColorCompat': 'VSFilter 색 호환',
    'subs-style.desc.vsfilterColorCompat':
      '오래된 SMI→ASS 변환본과 옛 팬자막은 BT.601을 전제로 만들어져 이 설정 없이는 색이 틀어집니다. 기본값이 안전한 값이며, 틀리는 파일에만 force-601로 바꾸세요.',
    'subs-style.label.embeddedFonts': '자막 파일에 포함된 글꼴 사용',
    'subs-style.desc.embeddedFonts':
      '끄면 첨부 글꼴을 무시하고 위에서 고른 글꼴을 씁니다. 첨부 글꼴이 깨진 파일에 쓰세요.',
    'subs-style.label.fontsDir': '추가 글꼴 폴더',
    'subs-style.desc.fontsDir': '이 폴더의 글꼴을 자막에 쓸 수 있게 합니다.',
    'subs-style.label.secondaryScale': '보조 자막 배율',
    'subs-style.desc.secondaryScale': '두 번째 자막(secondary)에만 적용됩니다.',
    'subs-style.label.secondaryPos': '보조 자막 세로 위치',
    'subs-style.desc.secondaryPos': '0이면 화면 맨 위입니다.',
    'subs-style.label.secondaryAssOverride': '보조 자막 스타일 덮어쓰기',
    'subs-style.desc.secondaryAssOverride': 'mpv 기본값은 "태그 제거"입니다.',

    'subs-style.label.filterSdh': '청각장애인용 표기 제거',
    'subs-style.desc.filterSdh': '[효과음], (웃음) 같은 표기를 지웁니다.',
    'subs-style.label.filterSdhHarder': '더 강하게 제거',
    'subs-style.desc.filterSdhHarder': '화자 이름까지 지웁니다. 잘못 지울 수 있습니다.',
    'subs-style.label.filterSdhEnclosures': '제거할 괄호',
    'subs-style.desc.filterSdhEnclosures': '한 줄에 한 쌍씩. 전각 괄호（）도 기본에 들어 있습니다.',
    'subs-style.label.filterRegex': '정규식으로 줄 지우기',
    'subs-style.desc.filterRegex':
      '한 줄에 하나씩. 기본값은 비어 있습니다 — 아무 줄도 저절로 지워지지 않습니다.',
    'subs-style.label.filterRegexEnable': '정규식 필터 사용',
    'subs-style.desc.filterRegexEnable': '목록을 지우지 않고 잠시 끌 때 씁니다.',
    'subs-style.label.filterRegexPlain': '정규식 대신 단순 문자열',
    'subs-style.desc.filterRegexPlain': '위 목록을 정규식이 아닌 그냥 글자로 취급합니다.',
    'subs-style.label.filterRegexWarn': '지운 줄을 로그에 남기기',
    'subs-style.desc.filterRegexWarn': '어떤 줄이 지워졌는지 확인할 때 켜세요.',

    'subs-style.label.gauss': '이미지 자막 흐림',
    'subs-style.desc.gauss':
      '0이 아니면 소프트웨어 확대를 강제해 느려질 수 있습니다. 저해상도 DVD 자막에만 쓰세요.',
    'subs-style.label.stretchDvdSubs': 'DVD 자막 늘리기',
    'subs-style.desc.stretchDvdSubs': '화면비가 바뀐 DVD 자막을 영상에 맞춥니다.',
    'subs-style.label.stretchImageSubsToScreen': '이미지 자막을 화면에 맞추기',
    'subs-style.desc.stretchImageSubsToScreen': '검은 띠까지 포함해 늘립니다.',
    'subs-style.label.imageSubsVideoResolution': '이미지 자막을 영상 해상도로',
    'subs-style.desc.imageSubsVideoResolution': '창 크기 대신 영상 해상도를 기준으로 그립니다.',
    'subs-style.label.forcedEventsOnly': '강제 자막만 표시',
    'subs-style.desc.forcedEventsOnly': '외국어 대사 등 강제 표시 항목만 보여 줍니다.',
    'subs-style.label.imageSubsHdrPeak': '이미지 자막 HDR 밝기',
    'subs-style.desc.imageSubsHdrPeak':
      'HDR 영상에서 이미지 자막이 눈이 아플 만큼 밝으면 낮추세요.',
    'subs-style.label.subHdrPeak': '글자 자막 HDR 밝기',
    'subs-style.desc.subHdrPeak': '기본값은 영상에 맞춰 자동으로 정합니다.',

    'subs-style.opt.borderStyle.outline-and-shadow': '테두리와 그림자',
    'subs-style.opt.borderStyle.opaque-box': '불투명 상자',
    'subs-style.opt.borderStyle.background-box': '배경 상자',
    'subs-style.opt.alignX.left': '왼쪽',
    'subs-style.opt.alignX.center': '가운데',
    'subs-style.opt.alignX.right': '오른쪽',
    'subs-style.opt.alignY.top': '위',
    'subs-style.opt.alignY.center': '가운데',
    'subs-style.opt.alignY.bottom': '아래',
    'subs-style.opt.justify.auto': '자동',
    'subs-style.opt.justify.left': '왼쪽',
    'subs-style.opt.justify.center': '가운데',
    'subs-style.opt.justify.right': '오른쪽',
    'subs-style.opt.assOverride.no': '끔 (제작자 스타일 그대로)',
    'subs-style.opt.assOverride.yes': '일부 적용',
    'subs-style.opt.assOverride.scale': '크기만 적용',
    'subs-style.opt.assOverride.force': '강제 (내 글꼴로)',
    'subs-style.opt.assOverride.strip': 'ASS 태그 제거',
    'subs-style.opt.secondaryAssOverride.no': '끔',
    'subs-style.opt.secondaryAssOverride.yes': '일부 적용',
    'subs-style.opt.secondaryAssOverride.scale': '크기만 적용',
    'subs-style.opt.secondaryAssOverride.force': '강제',
    'subs-style.opt.secondaryAssOverride.strip': 'ASS 태그 제거',
    'subs-style.opt.vsfilterColorCompat.no': '끔',
    'subs-style.opt.vsfilterColorCompat.basic': '기본',
    'subs-style.opt.vsfilterColorCompat.full': '전체',
    'subs-style.opt.vsfilterColorCompat.force-601': 'BT.601 강제',
    'subs-style.opt.imageSubsHdrPeak.sdr': 'SDR',
    'subs-style.opt.imageSubsHdrPeak.video': '영상에 맞춤',
    'subs-style.opt.imageSubsHdrPeak.video-static': '영상 고정값',
    'subs-style.opt.imageSubsHdrPeak.video-dynamic': '영상 동적값',
    'subs-style.opt.imageSubsHdrPeak.203': '203 nit',
    'subs-style.opt.imageSubsHdrPeak.400': '400 nit',
    'subs-style.opt.imageSubsHdrPeak.1000': '1000 nit',
    'subs-style.opt.imageSubsHdrPeak.4000': '4000 nit',
    'subs-style.opt.subHdrPeak.auto': '자동',
    'subs-style.opt.subHdrPeak.sdr': 'SDR',
    'subs-style.opt.subHdrPeak.203': '203 nit',
    'subs-style.opt.subHdrPeak.400': '400 nit',
    'subs-style.opt.subHdrPeak.1000': '1000 nit',
    'subs-style.opt.subHdrPeak.4000': '4000 nit',

    'subs-style.preset.readable': '잘 읽히게',
    'subs-style.preset.fansub': '팬자막 그대로',
    'subs-style.preset.accessible': '큰 글씨',
    'subs-style.presetDesc':
      '프리셋은 아래 값들을 한 번에 바꿉니다. 바꾼 뒤에도 하나씩 다시 고칠 수 있습니다.',

    'subs-style.cmd.setScale': '자막 배율 지정',
    'subs-style.cmd.setPos': '자막 위치 지정',
    'subs-style.cmd.setAssOverride': '자막 스타일 강제',
    'subs-style.cmd.setAssOverrideMode': 'ASS 스타일 덮어쓰기 지정',
    'subs-style.cmd.scaleUp': '자막 크게',
    'subs-style.cmd.scaleDown': '자막 작게',
    'subs-style.cmd.posUp': '자막 위로',
    'subs-style.cmd.posDown': '자막 아래로',
    'subs-style.cmd.cycleAssOverride': 'ASS 스타일 덮어쓰기 순환',
    'subs-style.cmd.cycleBorderStyle': '자막 테두리 방식 순환',
    'subs-style.cmd.applyBorderStyle': '자막 테두리 방식 지정',
    'subs-style.cmd.toggleBold': '자막 굵게 켜기/끄기',
    'subs-style.cmd.toggleSdh': '청각장애인용 표기 제거 켜기/끄기',
    'subs-style.cmd.toggleEmbeddedFonts': '포함된 글꼴 사용 켜기/끄기',
    'subs-style.cmd.applyPreset': '자막 스타일 프리셋 적용',
    'subs-style.cmd.resetStyle': '자막 모양 초기화',

    'subs-style.osd.boldOn': '자막 굵게 켬',
    'subs-style.osd.boldOff': '자막 굵게 끔',
    'subs-style.osd.sdhOn': '청각장애인용 표기 제거 켬',
    'subs-style.osd.sdhOff': '청각장애인용 표기 제거 끔',
    'subs-style.osd.embeddedOn': '포함된 글꼴 사용',
    'subs-style.osd.embeddedOff': '포함된 글꼴 무시',
    'subs-style.osd.reset': '자막 모양 초기화',

    'subs-style.imageSubWarning':
      '지금 선택된 자막은 이미지 자막({codec})입니다. 글꼴·색상·테두리 설정은 이 자막에 적용되지 않고, 아래 "이미지 자막" 항목만 적용됩니다.',
    'subs-style.assOffNote':
      'ASS 스타일 덮어쓰기가 "끔"이라 ASS/SSA 자막에는 위의 글꼴·색상 설정이 적용되지 않습니다. 제작자 스타일을 그대로 보여 주는 기본 동작입니다.',

    // --- the renderer half's own strings ---
    'subs-style.ui.sectionTitle': '자막 모양 — 프리셋과 지금 상태',
    'subs-style.ui.noTrack': '지금 켜져 있는 자막이 없어, 아래 설정은 자막을 켠 뒤에 보입니다.',
    'subs-style.ui.textTrack': '지금 선택된 자막은 글자 자막입니다. 아래 설정이 모두 적용됩니다.',
    'subs-style.ui.alpha': '불투명도',
    'subs-style.ui.colorHex': '색 코드',
    'subs-style.ui.colorHint': '#AARRGGBB 또는 #RRGGBB로 적을 수 있습니다.',
    'subs-style.ui.colorInvalid': '색 코드를 알아볼 수 없어 이전 값을 그대로 둡니다.',
    'subs-style.ui.preview': '미리보기'
  })

  ctx.i18n.register('en', {
    'subs-style.menuTitle': 'Subtitle appearance',
    'subs-style.menuPresets': 'Style presets',

    'subs-style.group.font': 'Font and size',
    'subs-style.group.colour': 'Colour and border',
    'subs-style.group.position': 'Position and margins',
    'subs-style.group.ass': 'ASS/SSA styling and fonts',
    'subs-style.group.filter': 'Text filtering',
    'subs-style.group.image': 'Image subtitles (PGS/VobSub)',

    'subs-style.label.font': 'Font',
    'subs-style.desc.font':
      'A family name as installed. Windows uses DirectWrite, so both "Malgun Gothic" and "맑은 고딕" work.',
    'subs-style.label.fontSize': 'Font size',
    'subs-style.desc.fontSize':
      'Scaled pixels at a window height of 720 — it auto-scales with the window, so there is nothing to redo on resize.',
    'subs-style.label.bold': 'Bold',
    'subs-style.desc.bold': 'Applies to ASS subtitles only when the override is "force".',
    'subs-style.label.italic': 'Italic',
    'subs-style.desc.italic': 'Applies to ASS subtitles only when the override is "force".',
    'subs-style.label.scale': 'Subtitle scale',
    'subs-style.desc.scale':
      'Affects ASS subtitles too and can break typeset signs. Prefer the font size where you can.',
    'subs-style.label.spacing': 'Letter spacing',
    'subs-style.desc.spacing': 'Space between characters.',
    'subs-style.label.lineSpacing': 'Line spacing',
    'subs-style.desc.lineSpacing': 'Space between lines of a multi-line subtitle.',
    'subs-style.label.blur': 'Blur',
    'subs-style.desc.blur': 'Softens glyph edges. 0 is off.',
    'subs-style.label.scaleByWindow': 'Scale by window',
    'subs-style.desc.scaleByWindow': 'Off sizes text against the video resolution instead.',
    'subs-style.label.scaleWithWindow': 'Scale with window',
    'subs-style.desc.scaleWithWindow': 'Subtitles grow as the window grows.',

    'subs-style.label.color': 'Text colour',
    'subs-style.desc.color': 'Colour with alpha.',
    'subs-style.label.outlineColor': 'Outline colour',
    'subs-style.desc.outlineColor': 'The colour of the glyph outline.',
    'subs-style.label.outlineSize': 'Outline size',
    'subs-style.desc.outlineSize': '0 disables the outline.',
    'subs-style.label.backColor': 'Background / shadow colour',
    'subs-style.desc.backColor':
      'One value for both in mpv: --sub-shadow-color is an alias for --sub-back-color.',
    'subs-style.label.shadowOffset': 'Shadow offset',
    'subs-style.desc.shadowOffset':
      'mpv has no shadow SIZE — the shadow is offset-driven. 0 draws none.',
    'subs-style.label.borderStyle': 'Border style',
    'subs-style.desc.borderStyle':
      '"Background box" lays a translucent box behind the whole line, which stays readable on bright scenes.',

    'subs-style.label.pos': 'Vertical position',
    'subs-style.desc.pos':
      '100 is the authored position; higher moves down. Above 100 text can be cut off, so raise with the bottom margin instead.',
    'subs-style.label.marginX': 'Horizontal margin',
    'subs-style.desc.marginX':
      'mpv has no horizontal subtitle offset; align left and grow this to approximate one.',
    'subs-style.label.marginY': 'Bottom margin',
    'subs-style.desc.marginY': 'Prefer this over the vertical position when raising subtitles.',
    'subs-style.label.marginYOffset': 'Bottom margin offset',
    'subs-style.desc.marginYOffset':
      'Intended for a transient nudge while the control bar covers the subtitle.',
    'subs-style.label.alignX': 'Horizontal alignment',
    'subs-style.desc.alignX': 'Does not apply to ASS subtitles.',
    'subs-style.label.alignY': 'Vertical alignment',
    'subs-style.desc.alignY': 'Does not apply to ASS subtitles.',
    'subs-style.label.justify': 'Line justification',
    'subs-style.desc.justify': 'How multi-line subtitles line up.',
    'subs-style.label.useMargins': 'Draw into the letterbox bars',
    'subs-style.desc.useMargins':
      'Lets subtitles use the black bars above and below. To reserve a fixed bottom band even when no subtitle is showing, use the video bottom margin in the video settings instead — mpv has no subtitle-side equivalent.',
    'subs-style.label.assForceMargins': 'Force margins for ASS too',
    'subs-style.desc.assForceMargins': 'Applies the setting above to ASS subtitles as well.',

    'subs-style.label.assOverride': 'ASS style override',
    'subs-style.desc.assOverride':
      'Off by default, so release-group styling renders as authored. "Force" makes the font and colour settings above win.',
    'subs-style.label.scaleSigns': 'Scale typeset signs',
    'subs-style.desc.scaleSigns':
      'Applies the subtitle scale and font size to signs too (positioned ASS events). This is what keeps typeset signs from drifting in "scale" and "force" mode on anime.',
    'subs-style.label.assScaleWithWindow': 'Scale ASS with the window',
    'subs-style.desc.assScaleWithWindow': 'Off by default; on can diverge from the author intent.',
    'subs-style.label.assStyleOverrides': 'Targeted ASS style overrides',
    'subs-style.desc.assStyleOverrides':
      'One per line, e.g. Default.Bold=1 · Default.Fontname=Malgun Gothic · ScaledBorderAndShadow=yes. Ignored while the override is "no".',
    'subs-style.label.assStyles': 'ASS styles file',
    'subs-style.desc.assStyles': 'Takes the style definitions from an .ass file.',
    'subs-style.label.vsfilterColorCompat': 'VSFilter colour compatibility',
    'subs-style.desc.vsfilterColorCompat':
      'Old SMI→ASS conversions and older fansubs were authored against BT.601 and shift colour without this. The default is the safe one; use force-601 for files it guesses wrong.',
    'subs-style.label.embeddedFonts': 'Use fonts embedded in the subtitle file',
    'subs-style.desc.embeddedFonts':
      'Off forces your chosen font to win — what you want when an attached font is broken.',
    'subs-style.label.fontsDir': 'Extra fonts folder',
    'subs-style.desc.fontsDir': 'Fonts in this folder become available to subtitles.',
    'subs-style.label.secondaryScale': 'Secondary subtitle scale',
    'subs-style.desc.secondaryScale': 'Applies to the secondary track only.',
    'subs-style.label.secondaryPos': 'Secondary subtitle position',
    'subs-style.desc.secondaryPos': '0 is the top of the frame.',
    'subs-style.label.secondaryAssOverride': 'Secondary ASS style override',
    'subs-style.desc.secondaryAssOverride': "mpv's default here is \"strip\".",

    'subs-style.label.filterSdh': 'Remove SDH annotations',
    'subs-style.desc.filterSdh': 'Drops [sound effects] and (laughs) style annotations.',
    'subs-style.label.filterSdhHarder': 'Remove more aggressively',
    'subs-style.desc.filterSdhHarder': 'Also drops speaker names. Can remove real dialogue.',
    'subs-style.label.filterSdhEnclosures': 'Brackets to strip',
    'subs-style.desc.filterSdhEnclosures':
      'One pair per line. The full-width pair （） is in the default because Korean SMI rips use it.',
    'subs-style.label.filterRegex': 'Drop lines matching',
    'subs-style.desc.filterRegex': 'One per line. Empty by default — nothing is ever filtered silently.',
    'subs-style.label.filterRegexEnable': 'Enable regex filtering',
    'subs-style.desc.filterRegexEnable': 'Turn the list off without deleting it.',
    'subs-style.label.filterRegexPlain': 'Treat patterns as plain text',
    'subs-style.desc.filterRegexPlain': 'Matches literally instead of as a regular expression.',
    'subs-style.label.filterRegexWarn': 'Log removed lines',
    'subs-style.desc.filterRegexWarn': 'Turn on to see which lines were dropped.',

    'subs-style.label.gauss': 'Image subtitle blur',
    'subs-style.desc.gauss':
      'Non-zero forces software scaling and can be slow. For low-resolution DVD subtitles.',
    'subs-style.label.stretchDvdSubs': 'Stretch DVD subtitles',
    'subs-style.desc.stretchDvdSubs': 'Fits anamorphic DVD subtitles to the video.',
    'subs-style.label.stretchImageSubsToScreen': 'Stretch image subtitles to the screen',
    'subs-style.desc.stretchImageSubsToScreen': 'Includes the letterbox bars.',
    'subs-style.label.imageSubsVideoResolution': 'Use the video resolution',
    'subs-style.desc.imageSubsVideoResolution': 'Renders against the video size, not the window.',
    'subs-style.label.forcedEventsOnly': 'Forced events only',
    'subs-style.desc.forcedEventsOnly': 'Shows only the events flagged as forced.',
    'subs-style.label.imageSubsHdrPeak': 'Image subtitle HDR peak',
    'subs-style.desc.imageSubsHdrPeak':
      'Lower this when image subtitles are painfully bright on HDR content.',
    'subs-style.label.subHdrPeak': 'Text subtitle HDR peak',
    'subs-style.desc.subHdrPeak': 'Auto follows the video.',

    'subs-style.opt.borderStyle.outline-and-shadow': 'Outline and shadow',
    'subs-style.opt.borderStyle.opaque-box': 'Opaque box',
    'subs-style.opt.borderStyle.background-box': 'Background box',
    'subs-style.opt.alignX.left': 'Left',
    'subs-style.opt.alignX.center': 'Centre',
    'subs-style.opt.alignX.right': 'Right',
    'subs-style.opt.alignY.top': 'Top',
    'subs-style.opt.alignY.center': 'Centre',
    'subs-style.opt.alignY.bottom': 'Bottom',
    'subs-style.opt.justify.auto': 'Auto',
    'subs-style.opt.justify.left': 'Left',
    'subs-style.opt.justify.center': 'Centre',
    'subs-style.opt.justify.right': 'Right',
    'subs-style.opt.assOverride.no': 'Off (as authored)',
    'subs-style.opt.assOverride.yes': 'Apply some',
    'subs-style.opt.assOverride.scale': 'Scale only',
    'subs-style.opt.assOverride.force': 'Force my styling',
    'subs-style.opt.assOverride.strip': 'Strip ASS tags',
    'subs-style.opt.secondaryAssOverride.no': 'Off',
    'subs-style.opt.secondaryAssOverride.yes': 'Apply some',
    'subs-style.opt.secondaryAssOverride.scale': 'Scale only',
    'subs-style.opt.secondaryAssOverride.force': 'Force',
    'subs-style.opt.secondaryAssOverride.strip': 'Strip ASS tags',
    'subs-style.opt.vsfilterColorCompat.no': 'Off',
    'subs-style.opt.vsfilterColorCompat.basic': 'Basic',
    'subs-style.opt.vsfilterColorCompat.full': 'Full',
    'subs-style.opt.vsfilterColorCompat.force-601': 'Force BT.601',
    'subs-style.opt.imageSubsHdrPeak.sdr': 'SDR',
    'subs-style.opt.imageSubsHdrPeak.video': 'Follow video',
    'subs-style.opt.imageSubsHdrPeak.video-static': 'Video, static',
    'subs-style.opt.imageSubsHdrPeak.video-dynamic': 'Video, dynamic',
    'subs-style.opt.imageSubsHdrPeak.203': '203 nits',
    'subs-style.opt.imageSubsHdrPeak.400': '400 nits',
    'subs-style.opt.imageSubsHdrPeak.1000': '1000 nits',
    'subs-style.opt.imageSubsHdrPeak.4000': '4000 nits',
    'subs-style.opt.subHdrPeak.auto': 'Auto',
    'subs-style.opt.subHdrPeak.sdr': 'SDR',
    'subs-style.opt.subHdrPeak.203': '203 nits',
    'subs-style.opt.subHdrPeak.400': '400 nits',
    'subs-style.opt.subHdrPeak.1000': '1000 nits',
    'subs-style.opt.subHdrPeak.4000': '4000 nits',

    'subs-style.preset.readable': 'Readable',
    'subs-style.preset.fansub': 'Fansub-safe',
    'subs-style.preset.accessible': 'Large print',
    'subs-style.presetDesc':
      'A preset writes several of the values below at once. Everything stays editable afterwards.',

    'subs-style.cmd.setScale': 'Set subtitle scale',
    'subs-style.cmd.setPos': 'Set subtitle position',
    'subs-style.cmd.setAssOverride': 'Override subtitle styling',
    'subs-style.cmd.setAssOverrideMode': 'Set ASS style override',
    'subs-style.cmd.scaleUp': 'Subtitles larger',
    'subs-style.cmd.scaleDown': 'Subtitles smaller',
    'subs-style.cmd.posUp': 'Subtitles up',
    'subs-style.cmd.posDown': 'Subtitles down',
    'subs-style.cmd.cycleAssOverride': 'Cycle ASS style override',
    'subs-style.cmd.cycleBorderStyle': 'Cycle subtitle border style',
    'subs-style.cmd.applyBorderStyle': 'Set subtitle border style',
    'subs-style.cmd.toggleBold': 'Toggle bold subtitles',
    'subs-style.cmd.toggleSdh': 'Toggle SDH filtering',
    'subs-style.cmd.toggleEmbeddedFonts': 'Toggle embedded fonts',
    'subs-style.cmd.applyPreset': 'Apply subtitle style preset',
    'subs-style.cmd.resetStyle': 'Reset subtitle appearance',

    'subs-style.osd.boldOn': 'Bold subtitles on',
    'subs-style.osd.boldOff': 'Bold subtitles off',
    'subs-style.osd.sdhOn': 'SDH filtering on',
    'subs-style.osd.sdhOff': 'SDH filtering off',
    'subs-style.osd.embeddedOn': 'Using embedded fonts',
    'subs-style.osd.embeddedOff': 'Ignoring embedded fonts',
    'subs-style.osd.reset': 'Subtitle appearance reset',

    'subs-style.imageSubWarning':
      'The selected subtitle track is an image format ({codec}). Font, colour and border settings do not apply to it — only the "Image subtitles" group below does.',
    'subs-style.assOffNote':
      'The ASS style override is off, so the font and colour settings above do not apply to ASS/SSA subtitles. That is the default: release styling renders as authored.',

    // --- the renderer half's own strings ---
    'subs-style.ui.sectionTitle': 'Subtitle appearance — presets and current state',
    'subs-style.ui.noTrack':
      'No subtitle track is on, so nothing below is being drawn yet. Turn a track on to see the effect.',
    'subs-style.ui.textTrack':
      'The selected subtitle track is a text track, so everything below applies to it.',
    'subs-style.ui.alpha': 'Opacity',
    'subs-style.ui.colorHex': 'Hex',
    'subs-style.ui.colorHint': 'Either #AARRGGBB or #RRGGBB.',
    'subs-style.ui.colorInvalid': 'That is not a colour we can read, so the previous value stands.',
    'subs-style.ui.preview': 'Preview'
  })
}

export default mod
