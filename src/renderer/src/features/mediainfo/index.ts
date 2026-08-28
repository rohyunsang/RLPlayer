import './mediainfo.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'
import type {
  InfoDensity,
  InfoGroup,
  InfoRow,
  InfoTab,
  MediaInfoState,
  TrackRow
} from './wire.ts'

/**
 * M29 mediainfo, renderer half.
 *
 * Five contributions, no shared file touched:
 *
 *   ctx.transportButton()  the toolbar toggle
 *   ctx.panel()            L23's info panel, L24's track list, L26's properties
 *   ctx.statsSection()  x5 V55, A45, N26, R34 and the general block, each
 *                          declaring which of U47's levels it belongs to
 *   ctx.settingsSection()  the two things a descriptor cannot say: that frame
 *                          numbers are estimates, and that mpv's own stats
 *                          overlay draws INSIDE the video surface
 *
 * Nothing here writes an mpv property and nothing here reads one: every value
 * on screen arrives as a display-ready string in `MediaInfoState`, built by the
 * main half from one snapshot. That is not only the ownership rule (section 10,
 * "a renderer layer never writes an mpv property") -- it is what makes the
 * clipboard report (L25) provably identical to what the user is looking at,
 * which is the whole point of L25.
 *
 * ---------------------------------------------------------------------------
 * U47's THREE DENSITIES ARE RENDERED HERE, NOT IN THE STATS OVERLAY, AND WHY
 * ---------------------------------------------------------------------------
 * `StatsSection.levels` exists, `stats-host.ts` honours it, and the only caller
 * of `toggleStats(level)` in shipped code is `main.ts`'s
 * `if (name === 'toggleStats') toggleStats('full')`. So 'short' and 'misc' are
 * unreachable from anywhere a module can stand: `RendererFeatureContext` has no
 * method that opens the stats overlay at a level, and importing
 * `core/stats-host` is a `check:forbidden` failure. U47's tiering therefore
 * lives on this module's OWN panel, which it fully owns; every stats section
 * below declares `levels: ['full']`, because that is the only level the overlay
 * can be put into, and a section claiming a home the user can never open is the
 * same defect one level down. `stats-levels.test.ts` fails if any section here
 * claims an unreachable level. Reported rather than worked around.
 */

const EMPTY: MediaInfoState = {
  open: false,
  density: 'full',
  tab: 'info',
  available: false,
  path: null,
  filename: '',
  title: '',
  network: false,
  groups: [],
  short: [],
  misc: [],
  tracks: [],
  properties: null,
  artUrl: null,
  hasEmbeddedArt: false,
  updatedAt: 0
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const svg = (d: string): SVGSVGElement => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 16 16')
  s.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  s.appendChild(p)
  return s
}

const mod: RendererFeatureModule = {
  id: 'mediainfo',

  setup(ctx): void {
    /**
     * The settings window runs the same glob, so both halves of this `setup()`
     * are guarded rather than one. The settings sections belong in the settings
     * window and the panel belongs in the player, and neither is a no-op in the
     * other -- building the panel's DOM in the settings window is wasted work
     * and `panel()` would ignore it anyway.
     */
    if (ctx.surface === 'settings') {
      ctx.settingsSection({
        id: 'mediainfo.notes',
        section: 'advanced',
        order: 22,
        titleKey: 'mediainfo.title',
        mount(host): () => void {
          const wrap = el('div', 'mi-notes')
          wrap.appendChild(el('p', undefined, ctx.t('mediainfo.approxNote')))
          wrap.appendChild(el('p', undefined, ctx.t('mediainfo.demuxClaimNote')))
          wrap.appendChild(el('p', undefined, ctx.t('mediainfo.mpvStatsHint')))
          host.appendChild(wrap)
          return () => wrap.remove()
        }
      })
      return
    }
    if (ctx.surface !== 'player') return

    /**
     * DECLARE FIRST, SUBSCRIBE LAST (section 10).
     *
     * `ctx.state.subscribe` replays synchronously inside `setup()`, and M25
     * shipped a live bug by declaring a paint variable below its subscribe: the
     * replayed paint threw a TDZ ReferenceError, which killed the rest of
     * `setup()` so its `seekbarLayer()` never registered at all. Every binding a
     * repaint touches is declared here, above every registration.
     */
    let state: MediaInfoState = EMPTY
    let repaintPanel: () => void = () => {}
    let expanded = new Set<number>()

    // -- the stats sections' own copy --------------------------------------
    /**
     * The stats overlay pulls rather than being pushed: `fields()` is
     * synchronous and the value has to be there when it is called. The invoke is
     * also what keeps the main half's live tick alive, so the tick stops on its
     * own a few seconds after the overlay closes and nothing has to say goodbye.
     */
    let statsState: MediaInfoState = EMPTY
    const pullStats = (): void => {
      void ctx.ipc
        .invoke<undefined, MediaInfoState>('mediainfo:snapshot')
        .then((s) => {
          statsState = s
        })
        .catch(() => {
          statsState = EMPTY
        })
    }

    const groupFields = (id: InfoGroup['id']): ReadonlyArray<InfoRow> =>
      statsState.groups.find((g) => g.id === id)?.rows ?? []

    // -- the transport button ---------------------------------------------
    ctx.transportButton({
      id: 'mediainfo.toggle',
      order: 55,
      labelKey: 'mediainfo.togglePanel',
      mount(button, api): () => void {
        // A lower-case i in a circle: the one glyph every player uses for this.
        button.appendChild(svg('M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.2a1 1 0 110 2 1 1 0 010-2zM7 7.5h2V12H7z'))
        api.pressed(false)
        return ctx.ipc.on<MediaInfoState>('mediainfo:state', (s) => api.pressed(s.open))
      },
      onClick(): void {
        ctx.ipc.send('mediainfo:togglePanel')
      }
    })

    // -- the panel (L23 / L24 / L26 / U47) --------------------------------
    ctx.panel({
      id: 'mediainfo',
      side: 'right',
      // playlist is 10 and nav-bookmarks is 20; a duplicate order is rejected
      // at registration naming both panels, so this is deliberately off the
      // round numbers rather than "the next one".
      order: 29,
      titleKey: 'mediainfo.title',
      mount(host): () => void {
        const head = el('div', 'mi-head')
        const h2 = el('h2', undefined, ctx.t('mediainfo.title'))
        head.appendChild(h2)

        const tools = el('div', 'mi-tools')
        const toolButton = (labelKey: string, pathData: string, onClick: () => void): HTMLButtonElement => {
          const b = el('button', 'icon-btn small')
          b.type = 'button'
          b.title = ctx.t(labelKey)
          b.setAttribute('aria-label', ctx.t(labelKey))
          b.appendChild(svg(pathData))
          b.addEventListener('click', onClick)
          tools.appendChild(b)
          return b
        }
        toolButton('mediainfo.copyInfo', 'M5 1h7v2H5zM3 4h11v11H3zm2 2v7h7V6z', () =>
          ctx.ipc.send('mediainfo:copy')
        )
        const folderBtn = toolButton(
          'mediainfo.showInFolder',
          'M1 3h5l2 2h7v9H1z',
          () => ctx.ipc.send('mediainfo:showInFolder')
        )
        const shellBtn = toolButton(
          'mediainfo.shellPropertiesCmd',
          'M8 1l2 2h4v11H2V3h4zM7 6h2v5H7z',
          () => ctx.ipc.send('mediainfo:shellProperties')
        )
        head.appendChild(tools)

        // -- U47's density switch, and the tab strip ----------------------
        const densities = el('div', 'mi-densities')
        densities.setAttribute('role', 'tablist')
        const densityButtons = new Map<InfoDensity, HTMLButtonElement>()
        for (const d of ['full', 'short', 'misc'] as const) {
          const b = el('button', 'mi-seg', ctx.t(`mediainfo.density.${d}`))
          b.type = 'button'
          b.setAttribute('role', 'tab')
          b.addEventListener('click', () => ctx.ipc.send('mediainfo:setDensity', { density: d }))
          densities.appendChild(b)
          densityButtons.set(d, b)
        }

        const tabs = el('div', 'mi-tabs')
        tabs.setAttribute('role', 'tablist')
        const tabButtons = new Map<InfoTab, HTMLButtonElement>()
        for (const tb of ['info', 'tracks', 'properties'] as const) {
          const b = el('button', 'mi-seg', ctx.t(`mediainfo.tab.${tb}`))
          b.type = 'button'
          b.setAttribute('role', 'tab')
          b.addEventListener('click', () => ctx.ipc.send('mediainfo:setTab', { tab: tb }))
          tabs.appendChild(b)
          tabButtons.set(tb, b)
        }

        const art = el('img', 'mi-art')
        art.alt = ctx.t('mediainfo.artAlt')
        art.hidden = true

        const body = el('div', 'mi-body')

        host.append(head, densities, tabs, art, body)

        // ---------------------------------------------------------------
        // rendering
        // ---------------------------------------------------------------

        const rowsInto = (parent: HTMLElement, rows: readonly InfoRow[]): void => {
          const dl = el('dl', 'mi-rows')
          for (const r of rows) {
            // `t()` returns an unknown key unchanged, which is exactly what a
            // metadata TAG name needs -- a container can carry any tag and
            // inventing i18n keys for `MusicBrainz Album Artist Id` is not a
            // translation problem. See `tagsGroup` in the main half.
            dl.appendChild(el('dt', undefined, ctx.t(r.labelKey)))
            // textContent, never innerHTML: every one of these strings comes
            // out of file metadata.
            dl.appendChild(el('dd', undefined, r.value))
          }
          parent.appendChild(dl)
        }

        const groupInto = (parent: HTMLElement, g: InfoGroup): void => {
          const section = el('section', 'mi-group')
          section.appendChild(el('h3', undefined, ctx.t(g.titleKey)))
          rowsInto(section, g.rows)
          parent.appendChild(section)
        }

        const trackInto = (parent: HTMLElement, t: TrackRow): void => {
          const box = el('div', `mi-track${t.selected ? ' mi-track-selected' : ''}`)
          const btn = el('button', 'mi-track-head')
          btn.type = 'button'
          const open = expanded.has(t.id)
          btn.setAttribute('aria-expanded', open ? 'true' : 'false')
          btn.appendChild(el('span', 'mi-track-type', t.type))
          btn.appendChild(el('span', 'mi-track-summary', t.summary))
          if (t.selected) {
            btn.appendChild(el('span', 'mi-track-flag', ctx.t('mediainfo.selectedTrack')))
          }
          btn.addEventListener('click', () => {
            if (expanded.has(t.id)) expanded.delete(t.id)
            else expanded.add(t.id)
            repaintPanel()
          })
          box.appendChild(btn)
          if (open) rowsInto(box, t.detail)
          parent.appendChild(box)
        }

        repaintPanel = (): void => {
          host.hidden = !state.open
          if (!state.open) return

          for (const [d, b] of densityButtons) {
            const on = state.density === d
            b.classList.toggle('mi-on', on)
            b.setAttribute('aria-selected', on ? 'true' : 'false')
          }
          // The tab strip is meaningless in the two condensed views: they are
          // projections, not a different set of tabs.
          tabs.hidden = state.density !== 'full'
          for (const [tb, b] of tabButtons) {
            const on = state.tab === tb
            b.classList.toggle('mi-on', on)
            b.setAttribute('aria-selected', on ? 'true' : 'false')
          }

          folderBtn.disabled = state.path === null || state.network
          shellBtn.disabled = state.path === null || state.network

          if (state.artUrl !== null) {
            art.src = state.artUrl
            art.hidden = false
          } else {
            art.hidden = true
            art.removeAttribute('src')
          }

          body.textContent = ''
          if (!state.available) {
            body.appendChild(el('p', 'mi-empty', ctx.t('mediainfo.empty')))
            return
          }

          if (state.density === 'short') {
            rowsInto(body, state.short)
            return
          }
          if (state.density === 'misc') {
            rowsInto(body, state.misc)
            return
          }

          if (state.tab === 'tracks') {
            if (state.tracks.length === 0) {
              body.appendChild(el('p', 'mi-empty', ctx.t('mediainfo.empty')))
              return
            }
            body.appendChild(el('p', 'mi-note', ctx.t('mediainfo.demuxClaimNote')))
            for (const t of state.tracks) trackInto(body, t)
            return
          }

          if (state.tab === 'properties') {
            const p = state.properties
            if (p === null) {
              body.appendChild(el('p', 'mi-empty', ctx.t('mediainfo.empty')))
              return
            }
            rowsInto(body, p.rows)
            if (state.hasEmbeddedArt) {
              body.appendChild(el('p', 'mi-note', ctx.t('mediainfo.embeddedArt')))
            }
            return
          }

          for (const g of state.groups) groupInto(body, g)
          if (state.hasEmbeddedArt && state.artUrl === null) {
            body.appendChild(el('p', 'mi-note', ctx.t('mediainfo.embeddedArt')))
          }
        }

        const off = ctx.ipc.on<MediaInfoState>('mediainfo:state', (s) => {
          state = s
          repaintPanel()
        })
        // The main half is authoritative and does not replay, so ask once.
        ctx.ipc.send('mediainfo:request')
        repaintPanel()

        return () => {
          off()
          repaintPanel = () => {}
          expanded = new Set<number>()
          host.textContent = ''
        }
      }
    })

    // -- the stats sections ------------------------------------------------
    /**
     * Orders are deliberately odd numbers in the 70s. Every cross-module
     * ordering namespace rejects a tie now, and core's own refusal block sits at
     * 90 with M07's decoder rows at 20, so a module picking "the next round
     * number" is how two Wave-1 modules collide and neither boots.
     *
     * `levels` is declared on every section because U47 says the default is
     * `full` only ("so a new section never clutters the glance view") while
     * `stats-host.ts` treats an ABSENT `levels` as every level. Declaring it is
     * the difference between agreeing with the spec and agreeing with the host.
     *
     * And every one of them says `['full']`, because that is the only level the
     * overlay can be put into. Measured across shipped code:
     *
     *   $ grep -rn 'toggleStats(|setStatsVisible(' --include=*.ts src/ | grep -v test
     *   src/renderer/src/core/stats-host.ts:155  (the definition)
     *   src/renderer/src/core/stats-host.ts:168  (the definition)
     *   src/renderer/src/main.ts:593   if (name === 'toggleStats') toggleStats('full')
     *
     * `stats-levels.test.ts` in the main half is the check, and it is written so
     * that declaring an unreachable level here FAILS it rather than shipping a
     * section with an invisible home.
     */
    ctx.statsSection({
      id: 'mediainfo.general',
      order: 71,
      titleKey: 'mediainfo.group.general',
      levels: ['full'],
      refresh: { mode: 'onChange', watch: ['path', 'file-format', 'duration', 'file-size'] },
      fields: () => {
        pullStats()
        return groupFields('general')
      }
    })
    ctx.statsSection({
      id: 'mediainfo.video',
      order: 73,
      titleKey: 'mediainfo.group.video',
      levels: ['full'],
      refresh: { mode: 'onChange', watch: ['video-params', 'container-fps', 'video-bitrate'] },
      fields: () => {
        pullStats()
        return groupFields('video')
      }
    })
    ctx.statsSection({
      id: 'mediainfo.audio',
      order: 75,
      titleKey: 'mediainfo.group.audio',
      levels: ['full'],
      // A45: `audio-params` and `audio-out-params` DIFFER and both matter, and
      // AUDIO_RECONFIG is what moves them.
      refresh: { mode: 'onChange', watch: ['audio-params', 'audio-out-params', 'current-ao'] },
      fields: () => {
        pullStats()
        return groupFields('audio')
      }
    })
    ctx.statsSection({
      id: 'mediainfo.pipeline',
      order: 77,
      titleKey: 'mediainfo.group.pipeline',
      // V55 is the block a rendering bug report is pasted from, and it BELONGS
      // in U47's misc glance view -- but 'misc' is not a level the overlay can
      // be put into from anywhere a module can stand (see the header, and
      // `stats-levels.test.ts`, which fails if this ever claims one that is
      // unreachable). Declaring `['full','misc']` here would be a section the
      // user can never see in one of its two declared homes.
      levels: ['full'],
      refresh: { mode: 'poll', intervalMs: 1000 },
      fields: () => {
        pullStats()
        return groupFields('pipeline')
      }
    })
    ctx.statsSection({
      id: 'mediainfo.frames',
      order: 79,
      titleKey: 'mediainfo.group.frames',
      levels: ['full'],
      // N26: `estimated-frame-number` changes every frame and has no property
      // worth observing, which is what `poll` is for. The label already says
      // the number is an estimate.
      refresh: { mode: 'poll', intervalMs: 500 },
      fields: () => {
        pullStats()
        return groupFields('frames')
      }
    })
    ctx.statsSection({
      id: 'mediainfo.stream',
      order: 81,
      titleKey: 'mediainfo.group.stream',
      levels: ['full'],
      // R34 renders only when `demuxer-via-network` is true, and the main half
      // is what decides that: the group is simply absent otherwise, so this
      // returns nothing rather than a block of dashes.
      refresh: { mode: 'poll', intervalMs: 1000 },
      fields: () => {
        pullStats()
        return groupFields('stream')
      }
    })

    pullStats()
    ctx.state.subscribe(() => pullStats())
  }
}

export default mod
