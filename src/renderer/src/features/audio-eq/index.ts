import './audio-eq.css'
/**
 * ONE definition of each wire type, checked at BOTH ends. `EqState` and
 * `PresetWire` were declared here and again in this module's main half, on
 * opposite sides of `audio-eq:state`, with nothing comparing them.
 */
import type { EqState, PresetWire } from '../../../../shared/features/audio-eq/wire.ts'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M12 audio-eq, renderer half — the `{ kind: 'custom' }` component for the
 * ten bands (§7).
 *
 * WHY A COMPONENT AND NOT TEN DESCRIPTORS. Ten bounded `float` descriptors
 * would render: they would be ten separate rows, each a horizontal slider with
 * its own label, in an arbitrary vertical order, with no frequency scale, no
 * preset list and no shared preamp readout — and the generated form writes the
 * setting on every `input` event, so one drag would be sixty round trips and
 * sixty chain rebuilds. An equaliser is one control with ten handles, which is
 * exactly the case the escape hatch is for.
 *
 * THE TWO PATHS, and they are deliberately different:
 *   - dragging  -> `audio-eq:preview`, coalesced to one message per frame, and
 *     the main half turns it into `af-command … change` on the running filter;
 *   - releasing -> `binding.set()`, which persists and rebuilds once.
 *
 * `binding.onChange` only fires for writes the settings form itself made, so
 * an EQ change from a keybind (Ctrl+E, next-preset) would leave this page
 * stale. That is what `audio-eq:state` is for.
 */

/**
 * The value of the synthetic "Custom" option in the preset <select>.
 *
 * THE EMPTY STRING, and that is not arbitrary: a preset id is a TRIMMED,
 * NON-EMPTY string -- `presets.ts` drops any row whose `name.trim()` is empty and
 * every built-in id is a literal -- so '' is the one value that provably cannot
 * collide with a real preset id. Nothing else about this option needs a magic
 * string: `presets.find(p => p.id === '')` is always undefined, which is exactly
 * what "the curve matches no preset" means.
 *
 * IT USED TO BE `'\0custom'` -- a RAW NUL BYTE at offset 1527 of this file.
 * Git classifies a file containing a NUL as binary, so `git diff` rendered all 326
 * lines of this module as `Bin 0 -> 11349 bytes` and `git grep`/`rg` answered
 * "binary file matches" with no line numbers: the whole file landed unreviewable
 * and no reviewer could have seen this line. `npm run check:control-chars` fails
 * the build on any control character in tracked source now, and `.gitattributes`
 * pins every source extension to `text` so a future one cannot flip a file to
 * binary in the diff either.
 */
const CUSTOM = ''

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  // textContent, never innerHTML: a user preset name is user data.
  if (text !== undefined) node.textContent = text
  return node
}

/** 31 / 1k / 16k — the scale people read, not the number. */
function freqLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

function formatDb(v: number): string {
  const n = Math.round(v * 10) / 10
  return `${n > 0 ? '+' : ''}${n}`
}

function parseGains(value: string, count: number): number[] {
  const parts = value.split(',')
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const n = Number(parts[i])
    out.push(Number.isFinite(n) ? n : 0)
  }
  return out
}

const mod: RendererFeatureModule = {
  id: 'audio-eq',

  setup(ctx): void {
    // The EQ has no overlay half; registering the component in the player
    // window would be harmless and pointless.
    if (ctx.surface !== 'settings') return

    ctx.settingsComponent('audio-eq.bands', (host, binding) => {
      // DECLARE FIRST, SUBSCRIBE LAST (§10). Everything the listeners below
      // close over exists before any of them can run.
      let bands = 10
      let gains: number[] = new Array<number>(bands).fill(0)
      let limit = 12
      let freqs: number[] = []
      let autoPreamp = true
      let manualPreamp = 0
      let presets: PresetWire[] = []
      let dragging = false
      let frame = 0
      const queued = new Map<number, number>()

      const root = el('div', 'eq-panel')
      const presetRow = el('div', 'eq-row')
      const presetLabel = el('label', 'eq-label', ctx.t('audio-eq.presetLabel'))
      const presetSelect = el('select', 'eq-preset')
      const deleteBtn = el('button', 'eq-btn', ctx.t('audio-eq.delete'))
      deleteBtn.type = 'button'
      presetLabel.appendChild(presetSelect)
      presetRow.append(presetLabel, deleteBtn)

      const bandRow = el('div', 'eq-bands')
      const sliders: HTMLInputElement[] = []
      const readouts: HTMLElement[] = []
      const labels: HTMLElement[] = []

      const footer = el('div', 'eq-row')
      const preampOut = el('span', 'eq-preamp')
      const resetBtn = el('button', 'eq-btn', ctx.t('audio-eq.resetButton'))
      resetBtn.type = 'button'
      const nameInput = el('input', 'eq-name')
      nameInput.type = 'text'
      nameInput.placeholder = ctx.t('audio-eq.presetName')
      const saveBtn = el('button', 'eq-btn', ctx.t('audio-eq.save'))
      saveBtn.type = 'button'
      footer.append(preampOut, resetBtn, nameInput, saveBtn)

      root.append(presetRow, bandRow, footer)
      host.appendChild(root)

      const serialise = (): string => gains.map((g) => Math.round(g * 10) / 10).join(',')

      const effectivePreamp = (): number =>
        autoPreamp ? -Math.max(0, ...gains) : manualPreamp

      const paintPreamp = (): void => {
        const db = Math.round(effectivePreamp() * 10) / 10
        preampOut.textContent = `${ctx.t('audio-eq.preampReadout')} ${formatDb(db)} dB`
      }

      /** Which preset the current curve IS. The main half answers the same
       *  question the same way; nothing stores a "selected preset". */
      const matchPreset = (): PresetWire | null =>
        presets.find(
          (p) =>
            p.gains.length === gains.length &&
            p.gains.every((g, i) => Math.round(g * 10) === Math.round((gains[i] ?? 0) * 10))
        ) ?? null

      const paintPresetSelect = (): void => {
        const current = matchPreset()
        presetSelect.textContent = ''
        for (const p of presets) {
          const o = el('option')
          o.value = p.id
          o.textContent = p.builtIn ? ctx.t(`audio-eq.preset.${p.id}`) : p.id
          presetSelect.appendChild(o)
        }
        if (!current) {
          const o = el('option')
          o.value = CUSTOM
          o.textContent = ctx.t('audio-eq.presetCustom')
          presetSelect.appendChild(o)
        }
        presetSelect.value = current?.id ?? CUSTOM
        deleteBtn.disabled = !current || current.builtIn
      }

      const paintBands = (): void => {
        for (let i = 0; i < sliders.length; i++) {
          const g = gains[i] ?? 0
          const slider = sliders[i]
          const out = readouts[i]
          if (slider && document.activeElement !== slider) slider.value = String(g)
          if (out) out.textContent = formatDb(g)
          const label = labels[i]
          if (label && freqs[i] !== undefined) label.textContent = freqLabel(freqs[i] as number)
        }
        paintPreamp()
        paintPresetSelect()
      }

      const buildBands = (count: number): void => {
        bandRow.textContent = ''
        sliders.length = 0
        readouts.length = 0
        labels.length = 0
        for (let i = 0; i < count; i++) {
          const cell = el('div', 'eq-band')
          const out = el('output', 'eq-gain', '0')
          const slider = el('input', 'eq-slider')
          slider.type = 'range'
          slider.min = String(-limit)
          slider.max = String(limit)
          slider.step = '0.5'
          slider.value = String(gains[i] ?? 0)
          slider.setAttribute('aria-label', `${freqLabel(freqs[i] ?? 0)} Hz`)
          const label = el('span', 'eq-freq', freqLabel(freqs[i] ?? 0))
          slider.addEventListener('pointerdown', () => {
            dragging = true
          })
          slider.addEventListener('input', () => {
            gains[i] = Number(slider.value)
            out.textContent = formatDb(gains[i] as number)
            paintPreamp()
            queue(i)
          })
          // 'change' is the release (and every keyboard step). ONE write, one
          // rebuild — the drag itself never touches the settings store.
          slider.addEventListener('change', () => {
            dragging = false
            commit()
          })
          cell.append(out, slider, label)
          bandRow.appendChild(cell)
          sliders.push(slider)
          readouts.push(out)
          labels.push(label)
        }
      }

      const queue = (band: number): void => {
        queued.set(band, gains[band] ?? 0)
        if (frame) return
        // Coalesce to one message per frame: a pointer can produce far more
        // `input` events than the filter graph has any use for.
        frame = requestAnimationFrame(() => {
          frame = 0
          for (const [b, gain] of queued) ctx.ipc.send('audio-eq:preview', { band: b, gain })
          queued.clear()
        })
      }

      const commit = (): void => {
        binding.set(serialise())
        paintPresetSelect()
      }

      const applyState = (s: EqState): void => {
        presets = s.presets
        autoPreamp = s.autoPreamp
        manualPreamp = s.manualPreamp
        limit = s.limit > 0 ? s.limit : 12
        freqs = s.freqs
        root.classList.toggle('eq-off', !s.enabled)
        const count = s.freqs.length || s.gains.length || bands
        if (count !== bands || sliders.length === 0) {
          bands = count
          gains = s.gains.slice(0, bands)
          buildBands(bands)
        } else if (!dragging) {
          gains = s.gains.slice(0, bands)
        }
        if (!dragging) paintBands()
        else paintPresetSelect()
      }

      presetSelect.addEventListener('change', () => {
        const p = presets.find((x) => x.id === presetSelect.value)
        if (!p) return
        gains = p.gains.slice(0, bands)
        paintBands()
        commit()
      })
      deleteBtn.addEventListener('click', () => {
        const p = matchPreset()
        if (!p || p.builtIn) return
        ctx.ipc.send('audio-eq:deletePreset', { id: p.id })
      })
      resetBtn.addEventListener('click', () => {
        gains = new Array<number>(bands).fill(0)
        paintBands()
        commit()
      })
      saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim()
        if (!name) return
        // Commit first: the main half saves the curve it currently holds.
        commit()
        ctx.ipc.send('audio-eq:savePreset', { name })
        nameInput.value = ''
      })

      // The form's own writes (including ours, and the Reset-all button in the
      // settings footer).
      const offBinding = binding.onChange(() => {
        const next = parseGains(binding.get<string>() || '', bands)
        if (next.join() === gains.join()) return
        gains = next
        paintBands()
      })

      // Everything the settings form cannot see: a keybind, a preset cycle, a
      // preset file that changed on disk.
      const offState = ctx.ipc.on<EqState>('audio-eq:state', (s) => applyState(s))

      // A pointerdown that never moves fires no `change`, so the drag flag has
      // to be cleared by the pointer, not by the value: `dragging` stuck true
      // would freeze this panel against every push from the main half.
      const endDrag = (): void => {
        dragging = false
      }
      window.addEventListener('pointerup', endDrag)
      window.addEventListener('pointercancel', endDrag)

      gains = parseGains(binding.get<string>() || '', bands)
      buildBands(bands)
      paintBands()
      void ctx.ipc
        .invoke<undefined, EqState>('audio-eq:query')
        .then(applyState)
        .catch(() => {
          /* the skeleton above is already usable; the labels stay numeric */
        })

      return () => {
        offBinding()
        offState()
        window.removeEventListener('pointerup', endDrag)
        window.removeEventListener('pointercancel', endDrag)
        if (frame) cancelAnimationFrame(frame)
        root.remove()
      }
    })
  }
}

export default mod
