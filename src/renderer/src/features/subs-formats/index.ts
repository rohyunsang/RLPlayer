import type { RendererFeatureContext, RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M18 subs-formats, renderer half.
 *
 * Two contributions and no controls, on purpose: every one of this module's six
 * settings is an ordinary descriptor (an `enum`, three `bool`s, a `list`), so
 * §7's generated form renders them and there is nothing here to hand-build.
 * `{ kind: 'custom' }` exists for choices that are not knowable statically —
 * M15's device list — and reaching for it to draw a select the form already
 * draws would be the escape hatch doing harm.
 *
 * What DOES need a renderer half:
 *
 *  1. A stats row (`I`). Encoding is the single most common Korean support
 *     question — "why is my subtitle 안녕하세요 vs ¾È³çÇϼ¼¿ä" — and the answer is
 *     three values the user cannot otherwise see: what the codepage setting is,
 *     what our detector actually chose, and whether the file was converted. This
 *     is the row a screenshot in a bug report has to contain.
 *  2. A prose block under the subtitle settings. The module does things to files
 *     on disk (it writes converted copies into the cache) and it has real limits
 *     (our detector is not uchardet; the original multi-language track stays in
 *     the list). `ctx.settingsSection()` is where that belongs — a tooltip on a
 *     checkbox cannot say it and a support page nobody opens is not an answer.
 *
 * THE WIRE TYPE IS DECLARED LOCALLY, and that is a reported gap rather than a
 * choice. The consolidation phase gave module halves `src/shared/features/<id>/`
 * for exactly this, and M12 uses it — but `src/shared/features/subs-formats/`
 * is NOT in this module's `ownedFiles` in `docs/parity/modules.json`, so
 * creating it would be an ownership violation that `scripts/check-ownership.mjs`
 * fails the build for. Importing the main half instead would drag `node:fs` and
 * `node:child_process` into the renderer bundle. So the shape is restated here
 * and both ends are asserted against it in tests; the manifest row wants one
 * line adding.
 */

interface FormatsReport {
  codepage: string
  encoding: string
  kind: string
  reasonKey: string
  file: string
  classes: readonly string[]
  duplicateTimestamps: number
  probeScore: number
  added: readonly string[]
}

const EMPTY: FormatsReport = {
  codepage: 'auto',
  encoding: '',
  kind: '',
  reasonKey: '',
  file: '',
  classes: [],
  duplicateTimestamps: 0,
  probeScore: 0,
  added: []
}

let report: FormatsReport = EMPTY

/** '—' rather than '' or 'undefined': an empty stats cell reads as a bug. */
const dash = (s: string): string => (s.length > 0 ? s : '—')

const mod: RendererFeatureModule = {
  id: 'subs-formats',

  setup(ctx: RendererFeatureContext): void {
    if (ctx.surface === 'player') {
      const pull = (): void => {
        void ctx.ipc
          .invoke<void, FormatsReport>('subs-formats:report')
          .then((r) => {
            report = r ?? EMPTY
          })
          .catch(() => {
            report = EMPTY
          })
      }
      pull()
      // The main half also pushes after a conversion, so the poll is only there
      // to keep the row honest while the overlay is open and nothing has changed.
      ctx.ipc.on<FormatsReport>('subs-formats:report', (r) => {
        report = r ?? EMPTY
      })

      ctx.statsSection({
        id: 'subs-formats.stats',
        order: 45,
        titleKey: 'subs-formats.stats',
        levels: ['full'],
        refresh: { mode: 'poll', intervalMs: 2000 },
        fields: () => {
          pull()
          const rows = [
            { labelKey: 'subs-formats.stats.codepage', value: report.codepage },
            { labelKey: 'subs-formats.stats.detected', value: dash(report.encoding) },
            {
              labelKey: 'subs-formats.stats.conversion',
              value:
                report.kind.length > 0
                  ? `${report.kind} — ${ctx.t(report.reasonKey)}`
                  : ctx.t('subs-formats.reason.native')
            }
          ]
          // The SMI-specific rows only appear when there was an SMI, so an
          // ordinary MP4 does not get three empty lines.
          if (report.classes.length > 0) {
            rows.push({
              labelKey: 'subs-formats.stats.classes',
              value: report.classes.map((c) => (c.length > 0 ? c : '(default)')).join(', ')
            })
          }
          if (report.duplicateTimestamps > 0) {
            rows.push({
              labelKey: 'subs-formats.stats.dups',
              value: String(report.duplicateTimestamps)
            })
          }
          if (report.added.length > 0) {
            rows.push({
              labelKey: 'subs-formats.stats.added',
              value: `${report.added.length} (${report.file})`
            })
          }
          return rows
        }
      })
    }

    if (ctx.surface === 'settings') {
      ctx.settingsSection({
        id: 'subs-formats.help',
        section: 'subtitles',
        order: 5,
        titleKey: 'subs-formats.menuTitle',
        mount(el) {
          const box = document.createElement('div')
          // No stylesheet: one paragraph of prose does not justify a CSS file in
          // a build where `check:partition` is content-granular about selectors.
          box.style.cssText = 'font-size:12px;line-height:1.6;opacity:0.8;max-width:52em'
          for (const key of [
            'subs-formats.help.detect',
            'subs-formats.help.convert',
            'subs-formats.help.limits'
          ]) {
            const p = document.createElement('p')
            p.textContent = ctx.t(key)
            box.appendChild(p)
          }
          el.appendChild(box)
          return () => box.remove()
        }
      })
    }
  }
}

export default mod
