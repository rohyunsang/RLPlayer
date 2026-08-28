import './subs-style.css'
import type { RendererFeatureModule, SettingBinding } from '../../../../shared/renderer-api.ts'

/**
 * M19 subs-style, renderer half — S18's four colour controls and the live
 * "does any of this apply right now?" section.
 *
 * TWO CONTRIBUTIONS, both settings-window only. There is no overlay half: every
 * user-facing action this module has is a command, so it is already in the
 * context menu and the keybind editor, and a subtitle-styling panel floating
 * over the video would be a worse place to drag a colour than the settings page.
 *
 * ── 1. `subs-style.color`, and why the escape hatch is justified here ──
 * `SettingType` has no colour kind. Four of S18's five knobs are `#AARRGGBB`
 * with a MEANINGFUL ALPHA (`sub-back-color` defaults to `#AF000000` — 69%
 * black), and the alternatives inside the API are:
 *   - `{ kind: 'string' }`: a text box where a typo silently falls back to the
 *     row default, with no swatch and no way to see 69% of anything;
 *   - `{ kind: 'enum' }`: a list of named colours, which is not a colour picker.
 * So this is the case §7 means by "what a descriptor genuinely cannot express".
 * Reported as an API gap (a `color` descriptor kind) rather than treated as
 * normal.
 *
 * `<input type="color">` carries no alpha in any browser, so the control is a
 * checkerboarded swatch + an RGB picker + an alpha slider + a hex field, and the
 * hex field is authoritative: it is the one place a user can paste the exact
 * value out of a fansub group's style line.
 *
 * ── 2. THE DUPLICATION, and it is not a choice ──
 * `SubsStyleUiState`, `parseColor` and `formatColor` exist here AND in
 * `src/main/features/subs-style/{index,style}.ts`. §10's answer to a wire type
 * shared by both halves is `src/shared/features/<id>/`, which is how M12 does
 * it — and `src/shared/features/subs-style/` is NOT in M19's `ownedFiles` in
 * `docs/parity/modules.json`, so creating it would fail both
 * `check:partition` (unowned tracked file) and `check-ownership`. Writing it
 * twice is the only thing left that does not break a rule. Reported.
 *
 * The runtime guard below is what stands in for the compiler: if the main half's
 * payload loses a key, the section says so in the console instead of rendering a
 * blank note.
 */

/** Must equal `UI_STATE_KEYS` in the main half. Sorted, so the check is order-free. */
const UI_STATE_KEYS = ['assOverride', 'codec', 'colors', 'imageSub', 'presets'] as const

interface SubsStyleUiState {
  imageSub: boolean
  codec: string | null
  assOverride: string
  presets: readonly string[]
  colors: Readonly<Record<string, string>>
}

function isUiState(v: unknown): v is SubsStyleUiState {
  if (typeof v !== 'object' || v === null) return false
  const missing = UI_STATE_KEYS.filter((k) => !(k in (v as Record<string, unknown>)))
  if (missing.length > 0) {
    console.error(
      `[subs-style] subs-style:state is missing ${missing.join(', ')} — the two halves of the ` +
        `wire type have drifted (see the duplication note in this file).`
    )
    return false
  }
  return true
}

// --- colour, duplicated from style.ts for the reason above -----------------

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, '0')

/** Canonical mpv colour: `#AARRGGBB`, which is also what mpv reads back. */
function formatColor(c: Rgba): string {
  return `#${hex2(c.a)}${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
}

/** `#RRGGBB` (accepted by mpv, opaque) and `#AARRGGBB`. Anything else is null. */
function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(input.trim())
  if (!m) return null
  const h = m[1] as string
  if (h.length === 6) {
    return {
      a: 255,
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    }
  }
  return {
    a: parseInt(h.slice(0, 2), 16),
    r: parseInt(h.slice(2, 4), 16),
    g: parseInt(h.slice(4, 6), 16),
    b: parseInt(h.slice(6, 8), 16)
  }
}

const FALLBACK: Rgba = { r: 255, g: 255, b: 255, a: 255 }

// --- tiny DOM helpers ------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  // textContent, never innerHTML: a codec name and a hex string are both data.
  if (text !== undefined) node.textContent = text
  return node
}

const mod: RendererFeatureModule = {
  id: 'subs-style',

  setup(ctx): void {
    // The player window runs the same glob and has neither of these hosts.
    if (ctx.surface !== 'settings') return

    /**
     * The most recent broadcast, shared by every mounted colour control.
     *
     * One subscription for the module rather than one per control: four colour
     * rows mounted at once would otherwise register four listeners for the same
     * message, and `settingsComponent` is re-mounted on every visibility-driven
     * re-render of the form.
     */
    const colorSinks = new Set<(colors: Readonly<Record<string, string>>) => void>()
    let state: SubsStyleUiState | null = null
    const stateSinks = new Set<(s: SubsStyleUiState) => void>()

    ctx.ipc.on<unknown>('subs-style:state', (p) => {
      if (!isUiState(p)) return
      state = p
      for (const sink of stateSinks) sink(p)
      for (const sink of colorSinks) sink(p.colors)
    })

    void ctx.ipc
      .invoke<undefined, unknown>('subs-style:query')
      .then((p) => {
        if (!isUiState(p)) return
        state = p
        for (const sink of stateSinks) sink(p)
        for (const sink of colorSinks) sink(p.colors)
      })
      .catch(() => {
        /* main is not up yet; the broadcast will arrive */
      })

    // --- S18: the #AARRGGBB control ---------------------------------------

    ctx.settingsComponent('subs-style.color', (host, binding: SettingBinding) => {
      // DECLARE FIRST, SUBSCRIBE LAST: everything the listeners close over
      // exists before any of them can run.
      let rgba: Rgba = parseColor(binding.get<string>()) ?? FALLBACK
      /** Which setting this instance is bound to, learned from the payload. */
      let boundId: string | null = null

      const root = el('div', 'substyle-color')
      const swatch = el('span', 'substyle-swatch')
      const fill = el('span', 'substyle-swatch-fill')
      swatch.appendChild(fill)

      const picker = el('input', 'substyle-picker')
      picker.type = 'color'
      picker.setAttribute('aria-label', ctx.t('subs-style.ui.preview'))

      const alphaLabel = el('label', 'substyle-small', ctx.t('subs-style.ui.alpha'))
      const alpha = el('input', 'substyle-alpha')
      alpha.type = 'range'
      alpha.min = '0'
      alpha.max = '255'
      alpha.step = '1'
      alphaLabel.appendChild(alpha)

      const hexLabel = el('label', 'substyle-small', ctx.t('subs-style.ui.colorHex'))
      const hex = el('input', 'substyle-hex')
      hex.type = 'text'
      hex.spellcheck = false
      hex.maxLength = 9
      hexLabel.appendChild(hex)

      const hint = el('small', 'substyle-small', ctx.t('subs-style.ui.colorHint'))

      root.append(swatch, picker, alphaLabel, hexLabel, hint)
      host.appendChild(root)

      /** Repaint every control from `rgba`, without firing any of them. */
      const paint = (): void => {
        fill.style.backgroundColor = `rgba(${rgba.r},${rgba.g},${rgba.b},${(rgba.a / 255).toFixed(3)})`
        picker.value = `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`.toLowerCase()
        alpha.value = String(rgba.a)
        hex.value = formatColor(rgba)
        hex.classList.remove('substyle-bad')
        hint.textContent = ctx.t('subs-style.ui.colorHint')
      }

      const commit = (next: Rgba): void => {
        rgba = next
        paint()
        binding.set(formatColor(rgba))
      }

      picker.addEventListener('input', () => {
        const c = parseColor(picker.value)
        if (c) commit({ ...c, a: rgba.a })
      })
      alpha.addEventListener('input', () => {
        commit({ ...rgba, a: Number(alpha.value) })
      })
      /**
       * `change`, not `input`: a hex field is typed one character at a time, and
       * on `input` every intermediate string is an invalid colour. Committing on
       * blur/Enter is what makes pasting `#C0000000` out of a style line work.
       */
      hex.addEventListener('change', () => {
        const c = parseColor(hex.value)
        if (!c) {
          // Say so, and keep the last good value rather than silently reverting
          // — a field that snaps back with no message reads as a broken control.
          hex.classList.add('substyle-bad')
          hint.textContent = ctx.t('subs-style.ui.colorInvalid')
          hex.value = formatColor(rgba)
          return
        }
        commit(c)
      })

      paint()

      const offBinding = binding.onChange(() => {
        rgba = parseColor(binding.get<string>()) ?? rgba
        paint()
      })

      /**
       * A colour changed OUTSIDE the form — a preset, `resetStyle`, a keybind.
       * The binding cannot see those, so the broadcast is the only route.
       *
       * The instance learns WHICH setting it is by matching its current value
       * against the payload once: the host hands a component a `SettingBinding`
       * and no id, so there is nothing else to key on. Where two colour rows
       * happen to hold the same value the first match wins, which is harmless —
       * both would be repainted to that same value anyway.
       */
      const sink = (colors: Readonly<Record<string, string>>): void => {
        if (boundId === null) {
          const mine = formatColor(rgba)
          boundId = Object.keys(colors).find((k) => colors[k] === mine) ?? null
          if (boundId === null) return
        }
        const next = parseColor(colors[boundId])
        if (!next || formatColor(next) === formatColor(rgba)) return
        rgba = next
        paint()
      }
      colorSinks.add(sink)
      if (state) sink(state.colors)

      return () => {
        offBinding()
        colorSinks.delete(sink)
        root.remove()
      }
    })

    // --- S25/S21: what actually applies to the track playing right now -----

    ctx.settingsSection({
      id: 'subs-style.state',
      section: 'subtitles',
      order: 10,
      titleKey: 'subs-style.ui.sectionTitle',
      mount(el0): () => void {
        const root = el('div', 'substyle-section')

        const desc = el('p', undefined, ctx.t('subs-style.presetDesc'))
        const presets = el('div', 'substyle-presets')
        const note = el('p', 'substyle-note')
        const assNote = el('p', 'substyle-note substyle-info')

        root.append(desc, presets, note, assNote)
        el0.appendChild(root)

        /**
         * The preset buttons are built from the payload's `presets`, not from a
         * list typed here. A preset added in `style.ts` appears without a second
         * edit, and a preset removed there cannot leave a button that invokes
         * nothing.
         */
        const paintPresets = (ids: readonly string[]): void => {
          presets.textContent = ''
          for (const id of ids) {
            const b = el('button', 'btn', ctx.t(`subs-style.preset.${id}`))
            b.type = 'button'
            b.addEventListener('click', () => ctx.ipc.send('subs-style:applyPreset', { id }))
            presets.appendChild(b)
          }
          const reset = el('button', 'btn', ctx.t('subs-style.cmd.resetStyle'))
          reset.type = 'button'
          reset.addEventListener('click', () => ctx.ipc.send('subs-style:reset'))
          presets.appendChild(reset)
        }

        const paint = (s: SubsStyleUiState): void => {
          paintPresets(s.presets)

          note.classList.toggle('substyle-warn', s.imageSub)
          note.classList.toggle('substyle-info', !s.imageSub)
          if (s.imageSub) {
            // S25: say it, rather than greying nine controls with no reason
            // given. `{codec}` is mpv's own codec name, which is what a search
            // for "why are my PGS subs not changing" turns up.
            note.textContent = ctx.t('subs-style.imageSubWarning', { codec: s.codec ?? '?' })
          } else if (s.codec === null) {
            note.textContent = ctx.t('subs-style.ui.noTrack')
          } else {
            note.textContent = ctx.t('subs-style.ui.textTrack')
          }

          // S21: the default is `no`, so this note is the ANSWER to the most
          // likely support question this module will ever generate — "I changed
          // the font and nothing happened". It appears only when it is true.
          const off = s.assOverride === 'no' || s.assOverride === 'strip'
          assNote.textContent = off ? ctx.t('subs-style.assOffNote') : ''
          assNote.hidden = !off
        }

        stateSinks.add(paint)
        if (state) paint(state)
        else paintPresets([])

        return () => {
          stateSinks.delete(paint)
          root.remove()
        }
      }
    })
  }
}

export default mod
