import './stream-ytdl.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M36 stream-ytdl, renderer half.
 *
 * Three contribution points and no shared file touched:
 *
 *   `settingsComponent('stream-ytdl.picker')` — §7's `custom` escape hatch, used
 *       for the one thing a descriptor genuinely cannot express: WHERE yt-dlp was
 *       found on this machine and WHICH version it is. Both are discovered at
 *       runtime, both change when the user installs or updates it, and the
 *       version comes from running the binary — so there is no static option
 *       list to enumerate. (Compare M15's output-device picker, the other real
 *       case.)
 *   `settingsSection`  — the three things R06/R07/R08 say to state in words: why
 *       yt-dlp is not bundled, that there is no auto-update, and that a single
 *       quality is normal for some sites.
 *   `statsSection`     — R08's quality list in the `I` overlay, where it can sit
 *       beside the buffering numbers M35 contributes.
 *
 * WHAT IS DELIBERATELY NOT HERE: a quality PANEL. R08's finding is that
 * "the quality menu IS the track menu: read `track-list`, switch with
 * `vid`/`aid`", and the track menu belongs to M11. Building a second track
 * switcher here would be two UIs writing one decision — the exact duplication
 * §3.7 exists to prevent — so this half shows the list read-only and the switch
 * goes through `audio-tracks.selectStreamFormat`.
 */

interface QualityOption {
  readonly id: number
  readonly kind: 'video' | 'audio'
  readonly selected: boolean
  readonly label: string
}

type YtdlOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'extraction-failed'; readonly detail: string; readonly updateWorthy: boolean }

interface YtdlState {
  readonly enabled: boolean
  readonly binary: string | null
  readonly version: string | null
  readonly outcome: YtdlOutcome
  readonly quality: readonly QualityOption[]
  readonly singleFormatIsNormal: boolean
  readonly privacyKeys: readonly string[]
}

const EMPTY: YtdlState = {
  enabled: false,
  binary: null,
  version: null,
  outcome: { kind: 'none' },
  quality: [],
  singleFormatIsNormal: true,
  privacyKeys: []
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const mod: RendererFeatureModule = {
  id: 'stream-ytdl',

  setup(ctx): void {
    let state: YtdlState = EMPTY
    const listeners = new Set<(s: YtdlState) => void>()

    ctx.ipc.on<YtdlState>('stream-ytdl:state', (s) => {
      if (!s) return
      state = s
      for (const cb of listeners) cb(s)
    })

    const refresh = (): void => {
      void ctx.ipc
        .invoke<undefined, YtdlState>('stream-ytdl:getState')
        .then((s) => {
          if (!s) return
          state = s
          for (const cb of listeners) cb(s)
        })
        .catch(() => undefined)
    }

    if (ctx.surface === 'settings') {
      /**
       * The picker. Note what it does NOT do: it never probes on its own. The
       * version is whatever the main half already knows; running the binary
       * happens when the user presses "look again", because R06's probe is a
       * child process and this app does not start processes on a page load.
       */
      ctx.settingsComponent('stream-ytdl.picker', (host, binding) => {
        const wrap = el('div', 'sy-picker')

        const row = el('div', 'sy-row')
        const pathBox = el('div', 'sy-path')
        const detect = el('button', 'sy-btn', ctx.t('stream-ytdl.detect'))
        detect.type = 'button'
        row.append(pathBox, detect)

        const meta = el('div', 'sy-meta')

        const manual = el('div', 'sy-row')
        const input = el('input', 'sy-path')
        input.type = 'text'
        input.spellcheck = false
        input.setAttribute('aria-label', ctx.t('stream-ytdl.path'))
        const save = el('button', 'sy-btn', ctx.t('stream-ytdl.detect'))
        save.type = 'button'
        save.textContent = '↵'
        save.title = ctx.t('stream-ytdl.path')
        manual.append(input, save)

        wrap.append(row, meta, manual)
        host.appendChild(wrap)

        const render = (s: YtdlState): void => {
          const found = s.binary !== null
          pathBox.classList.toggle('sy-missing', !found)
          pathBox.textContent = found
            ? ctx.t('stream-ytdl.statusFound', { path: s.binary as string })
            : ctx.t('stream-ytdl.statusMissing')
          pathBox.title = s.binary ?? ''
          meta.textContent =
            s.version === null ? '' : ctx.t('stream-ytdl.statusVersion', { version: s.version })
        }

        detect.addEventListener('click', () => ctx.ipc.send('stream-ytdl:detect'))
        const commit = (): void => {
          binding.set<string>(input.value.trim())
          ctx.ipc.send('stream-ytdl:detect')
        }
        save.addEventListener('click', commit)
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        })

        input.value = binding.get<string>() ?? ''
        const offBinding = binding.onChange(() => {
          input.value = binding.get<string>() ?? ''
        })

        listeners.add(render)
        render(state)
        refresh()

        return () => {
          offBinding()
          listeners.delete(render)
          wrap.remove()
        }
      })

      ctx.settingsSection({
        id: 'stream-ytdl.notes',
        section: 'playback',
        order: 14,
        titleKey: 'stream-ytdl.notesTitle',
        mount(host): () => void {
          const wrap = el('div', 'sy-notes')
          for (const key of [
            'stream-ytdl.noteLicense',
            'stream-ytdl.noteUpdate',
            'stream-ytdl.noteQuality'
          ]) {
            wrap.appendChild(el('p', undefined, ctx.t(key)))
          }
          const privacy = el('div', 'sy-privacy')
          privacy.hidden = true
          wrap.appendChild(privacy)

          const render = (s: YtdlState): void => {
            privacy.hidden = s.privacyKeys.length === 0
            privacy.textContent = `${ctx.t('stream-ytdl.privacyWarning')} (${s.privacyKeys.join(
              ', '
            )})`
          }
          listeners.add(render)
          render(state)
          refresh()

          host.appendChild(wrap)
          return () => {
            listeners.delete(render)
            wrap.remove()
          }
        }
      })
      return
    }

    // -----------------------------------------------------------------------
    // The player surface: R08's list in the stats overlay.
    // -----------------------------------------------------------------------
    refresh()
    ctx.statsSection({
      id: 'stream-ytdl.stats',
      order: 40,
      titleKey: 'stream-ytdl.qualityTitle',
      // R08/R22: the formats appear LATE on a network source, so this follows
      // `track-list` rather than reading it once.
      refresh: { mode: 'onChange', watch: ['track-list', 'vid', 'aid'] },
      fields: () => {
        const s = state
        if (!s.enabled || s.quality.length === 0) return []
        const rows: Array<{ labelKey: string; value: string }> = []
        if (s.version !== null) {
          rows.push({ labelKey: 'stream-ytdl.statusVersion', value: s.version })
        }
        for (const q of s.quality) {
          rows.push({
            // The label carries the id, so two tracks reporting the same
            // resolution are still distinguishable.
            labelKey: q.kind === 'video' ? 'stream-ytdl.qualityTitle' : 'stream-ytdl.selectQuality',
            value: `${q.selected ? '● ' : ''}#${q.id} ${q.label}`
          })
        }
        if (s.singleFormatIsNormal) {
          // R08's honest caveat: some sites legitimately show one quality, and a
          // user staring at a single entry needs to be told that is not a bug.
          rows.push({ labelKey: 'stream-ytdl.qualityTitle', value: ctx.t('stream-ytdl.qualitySingle') })
        }
        return rows
      }
    })
  }
}

export default mod
