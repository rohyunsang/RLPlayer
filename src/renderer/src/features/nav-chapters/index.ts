import './nav-chapters.css'
import {
  EMPTY_STATE,
  rangeLabel,
  regionBands,
  sanitizePrompt,
  type SkipPanelState
} from './skip-regions.ts'
import type { RendererFeatureModule, RendererFeatureContext } from '../../../../shared/renderer-api.ts'
import type { Chapter } from '../../../../shared/types.ts'

/**
 * M25 nav-chapters, renderer half.
 *
 * WAVE 0 SEED, and it is here as the PROOF that the interactive seek-bar layer
 * works end to end: chapter ticks are drawn by a contributed layer, the ticks
 * are click-to-seek through `hitTest` + `onPointerUp`, the tick under the
 * pointer contributes a tooltip fragment, and arrow keys nudge the focused
 * tick. None of that was expressible in the render-only contract the spec
 * originally declared.
 *
 * Two of those three used to be a claim rather than a fact. `tooltip()` was
 * written and shipped and NEVER CALLED -- `main.ts` assigned the hover readout
 * directly, so the fragment was dead code -- and `onKey()` could not fire
 * because the overlay returned early on every arrow key inside a range input.
 * The host composes the tooltip from fragments now and the arrows reach
 * `key()`, so this module declares `handles()` (rule 4) and paints its own
 * focus ring from `ctx.focusedHandle`.
 *
 * Note the ownership rule holding on both halves: this file never writes an
 * mpv property. It sends to its own main half, which owns `chapter`.
 */

let chapters: Chapter[] = []
let duration = 0

const mod: RendererFeatureModule = {
  id: 'nav-chapters',

  setup(ctx): void {
    /**
     * The layer's container is CORE'S, handed to `render` as `c.el`. This module
     * used to create its own `<div class="seek-layer seek-chapters">`, which
     * meant knowing core's class name, which is how its two private selectors
     * ended up in core's stylesheet. It paints into what it is given now.
     */
    let host: HTMLElement | null = null

    // `ctx.state.subscribe` REPLAYS the last state synchronously (renderer-core
    // fires immediately when it already has one), so everything paint() closes
    // over has to exist before the subscribe, not after it. Declaring `ticks`
    // below the subscribe made the very first replayed paint() a TDZ
    // ReferenceError, which killed the rest of setup() — including the
    // seekbarLayer() registration — and left a permanently throwing subscriber
    // behind. Order is load-bearing here.
    let ticks: HTMLElement[] = []

    let focusedHandle: string | null = null

    function paint(): void {
      if (!host) return
      host.textContent = ''
      ticks = []
      if (duration <= 0 || chapters.length < 2) return
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i]
        if (!ch) continue
        const tick = document.createElement('span')
        tick.className = 'seek-chapter-tick'
        // A handle you can Tab to but cannot see is worse than one you cannot
        // reach: the arrows would move something invisible.
        if (focusedHandle === String(i)) tick.classList.add('focused')
        tick.style.left = `${(ch.time / duration) * 100}%`
        tick.title = ch.title
        host.appendChild(tick)
        ticks.push(tick)
      }
    }

    ctx.state.subscribe((s) => {
      chapters = s.chapters
      duration = s.duration
      paint()
    })

    ctx.seekbarLayer({
      id: 'nav-chapters.ticks',
      order: 10,
      render(c): void {
        host = c.el
        focusedHandle = c.focusedHandle
        paint()
      },
      /** Rule 4: every tick is Tab-reachable, in time order. */
      handles(): readonly string[] {
        return chapters.length < 2 ? [] : chapters.map((_, i) => String(i))
      },
      /** A 2px tick is only grabbable because of `tolerancePx`. */
      hitTest(c): string | null {
        if (chapters.length < 2 || c.duration <= 0) return null
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i]
          if (!ch) continue
          if (Math.abs(c.x - c.timeToX(ch.time)) <= c.tolerancePx) return String(i)
        }
        return null
      },
      onPointerUp(e): void {
        if (e.cancelled) return
        const index = Number(e.handle)
        if (Number.isFinite(index)) ctx.ipc.send('nav-chapters:goto', { index })
      },
      /**
       * The chapter title of the tick UNDER THE POINTER, and only then.
       *
       * `tooltip()` fires at every pointer position, not only where `hitTest`
       * claimed, and the shipped version of this function was
       * `chapters[Number(e.handle)]` against a host that passed `''` for "no
       * handle". `Number('') === 0`, so this fragment rendered unconditionally,
       * always naming chapter 0. Measured over 24 positions in the packaged
       * build: 24/24 printed "Intro", and 22 of them contradicted M27's caption
       * inside the same `#seekHover` box — at 5:00 and 9:20 the tooltip read
       * "Intro" and "End" at once.
       *
       * Two things stop it coming back. The host's event is a discriminated
       * union, so `e.claimed` is the first thing this reads; and the absent case
       * carries `handle: undefined`, so even `Number(e.handle)` would be `NaN`
       * and index nothing.
       *
       * `role: 'chapter'` is how this composes with M27's caption, which answers
       * the same question for positions that are not on a tick. The host keeps
       * one of the two — this one when the pointer is on a tick, because "the
       * chapter you are pointing at" beats "the chapter this position is in".
       */
      tooltip(e): { el: HTMLElement; order: number; role: string } | null {
        if (!e.claimed) return null
        const index = Number(e.handle)
        if (!Number.isInteger(index)) return null
        const ch = chapters[index]
        if (!ch) return null
        const el = document.createElement('span')
        el.className = 'seek-tip-chapter'
        el.textContent = ch.title
        return { el, order: 20, role: 'chapter' }
      },
      onKey(e): void {
        const index = Number(e.handle)
        if (!Number.isFinite(index)) return
        if (e.key === 'Home') return ctx.ipc.send('nav-chapters:goto', { index: 0 })
        if (e.key === 'End') {
          return ctx.ipc.send('nav-chapters:goto', { index: chapters.length - 1 })
        }
        const delta = e.key === 'ArrowLeft' ? -1 : 1
        ctx.ipc.send('nav-chapters:goto', { index: index + delta })
      }
    })

    // The overlay and the settings window run the same glob, and none of N51's
    // three surfaces exists in the settings window. Branching here rather than
    // relying on the host to ignore the contributions keeps the IPC subscription
    // and the `sync` round-trip out of a window that has nothing to draw.
    if (ctx.surface === 'player') installSkipUi(ctx)
  }
}

/**
 * N51's UI: the setup panel, the seek-bar bands, and the 5 s prompt button.
 *
 * THIS FILE NEVER WRITES ANYTHING. Every control sends one
 * `nav-chapters:skipAction` and waits to be told the new state, which is why the
 * panel has no local copy of the window it is editing: the main half owns
 * `skip.json`, decides what a set point means, and pushes back. A panel that
 * optimistically drew the value it just sent would disagree with the store
 * whenever the model declined the edit -- and `setPoint()` declines edits
 * routinely, because it keeps the intro pair ordered.
 *
 * THE 5-SECOND BUTTON. §2.5 asks for one, and a `ctx.osd.toast()` cannot be it:
 * its lifetime is core's and a module cannot retract it, so the button outlives
 * the window. `transportButton()` can -- the module owns everything inside the
 * button core created, including whether it is `hidden` -- so this is a real
 * button that appears when the main half says the playhead entered a window and
 * removes itself when it says otherwise or when its own timer runs out. The
 * remaining gap is that the transport bar auto-hides with the chrome, so the
 * main half also sends an OSD line; a floating button over the video is not
 * expressible through any contribution point (a `panel()` is a fixed dock whose
 * geometry is core's CSS). Reported as a finding.
 */
function installSkipUi(ctx: RendererFeatureContext): void {
  let skip: SkipPanelState = EMPTY_STATE
  const paints: Array<(s: SkipPanelState) => void> = []

  const repaint = (): void => {
    for (const p of paints) p(skip)
  }

  ctx.ipc.on<SkipPanelState>('nav-chapters:skipState', (s) => {
    if (s === null || typeof s !== 'object') return
    skip = { ...EMPTY_STATE, ...s }
    repaint()
  })
  // Ask once: a window opened after the main half's last push would otherwise
  // show an empty panel until the next set point.
  ctx.ipc.send('nav-chapters:skipAction', { action: 'sync' })

  const act = (action: string): void => ctx.ipc.send('nav-chapters:skipAction', { action })

  // --- the seek-bar bands --------------------------------------------------

  let bandHost: HTMLElement | null = null

  function paintBands(): void {
    if (!bandHost) return
    bandHost.textContent = ''
    for (const b of regionBands(skip)) {
      const el = document.createElement('span')
      el.className = `skip-band skip-band-${b.kind}`
      el.style.left = `${b.leftPct}%`
      el.style.width = `${b.widthPct}%`
      el.title = ctx.t(b.kind === 'intro' ? 'nav-chapters.intro' : 'nav-chapters.ending')
      bandHost.appendChild(el)
    }
  }
  paints.push(paintBands)

  ctx.seekbarLayer({
    id: 'nav-chapters.skipBands',
    /**
     * 15: above the chapter ticks (10) and below the bookmark pins (20).
     *
     * These are FILLED regions and the ticks are 2 px lines, so painting the
     * bands after the ticks would hide them; painting before the pins keeps
     * M26's pins on top, which is right because a pin is a point the user placed
     * and a band is a range this module inferred.
     *
     * No `hitTest`: with one, rule 4 requires `handles()`, and every pixel of a
     * 90-second band would become a Tab stop that does the same thing as the
     * skip key. The bands are information; the keys and the button are the
     * controls.
     */
    order: 15,
    render(c): void {
      bandHost = c.el
      paintBands()
    }
  })

  // --- the 5 s prompt button ----------------------------------------------

  let promptButton: HTMLButtonElement | null = null
  let promptLabelEl: HTMLElement | null = null
  let promptTimer: ReturnType<typeof setTimeout> | null = null

  function hidePrompt(): void {
    if (promptTimer !== null) {
      clearTimeout(promptTimer)
      promptTimer = null
    }
    if (promptButton) promptButton.hidden = true
  }

  ctx.ipc.on<unknown>('nav-chapters:skipPrompt', (raw) => {
    const prompt = sanitizePrompt(raw)
    if (prompt === null || prompt.kind === null) {
      hidePrompt()
      return
    }
    if (!promptButton || !promptLabelEl) return
    promptLabelEl.textContent = prompt.label ?? ctx.t('nav-chapters.skip')
    promptButton.hidden = false
    if (promptTimer !== null) clearTimeout(promptTimer)
    // The button withdraws itself. The main half ALSO refuses a stale press, so
    // this timer is the visible half of a rule that is enforced on both sides --
    // a renderer timer that the user's machine delayed must not be able to move
    // playback out of a scene they are watching.
    promptTimer = setTimeout(() => {
      promptTimer = null
      hidePrompt()
    }, prompt.ms ?? 5000)
  })

  ctx.transportButton({
    id: 'nav-chapters.skipPrompt',
    /**
     * 60. The row is 10 subs-tracks, 20 playlist, 30 nav-bookmarks, 40
     * capture-still, 50 stream-open, 55 mediainfo, 70 capture-encode; core's own
     * controls end at 100.
     *
     * This was 50, which was free when it was written and was M35's by the time
     * the suite ran -- eight modules are landing in this tree at once, and the
     * ordering namespaces are the one thing that cannot be reasoned about from
     * inside one module. `core/feature-host.test.ts` names both claimants, which
     * is the only reason this was a failing test rather than a silent
     * load-order-decides-it in the shipped build.
     */
    order: 60,
    labelKey: 'nav-chapters.skipNow',
    mount(button): () => void {
      promptButton = button
      button.hidden = true
      button.classList.add('skip-prompt-btn')
      const label = document.createElement('span')
      label.className = 'skip-prompt-label'
      promptLabelEl = label
      button.appendChild(label)
      const arrow = document.createElement('span')
      arrow.className = 'skip-prompt-arrow'
      arrow.textContent = '\u00bb'
      arrow.setAttribute('aria-hidden', 'true')
      button.appendChild(arrow)
      return (): void => {
        hidePrompt()
        promptButton = null
        promptLabelEl = null
        label.remove()
        arrow.remove()
      }
    },
    onClick(): void {
      hidePrompt()
      act('promptAccept')
    }
  })

  // --- the setup panel ----------------------------------------------------

  ctx.panel({
    id: 'nav-chapters.skip',
    side: 'right',
    // 40. The dock is 10 playlist, 20 nav-bookmarks, 29 mediainfo, 30
    // stream-open, 70 capture-encode. Same collision as the transport button
    // above, same detector.
    order: 40,
    titleKey: 'nav-chapters.skipPanelTitle',
    mount(host): () => void {
      host.classList.add('skip-panel')

      const head = document.createElement('div')
      head.className = 'skip-head'
      const title = document.createElement('h2')
      title.textContent = ctx.t('nav-chapters.skipPanelTitle')
      head.appendChild(title)
      const close = document.createElement('button')
      close.className = 'skip-close'
      close.type = 'button'
      close.textContent = '\u00d7'
      close.setAttribute('aria-label', ctx.t('nav-chapters.skipPanelClose'))
      close.addEventListener('click', () => act('close'))
      head.appendChild(close)
      host.appendChild(head)

      const folder = document.createElement('p')
      folder.className = 'skip-folder'
      host.appendChild(folder)

      const toggles = document.createElement('div')
      toggles.className = 'skip-toggles'
      const enableBtn = document.createElement('button')
      enableBtn.type = 'button'
      enableBtn.className = 'skip-toggle'
      enableBtn.addEventListener('click', () => act('toggleEnabled'))
      const modeBtn = document.createElement('button')
      modeBtn.type = 'button'
      modeBtn.className = 'skip-toggle'
      modeBtn.addEventListener('click', () => act('toggleMode'))
      toggles.append(enableBtn, modeBtn)
      host.appendChild(toggles)

      interface Row {
        wrap: HTMLElement
        value: HTMLElement
      }

      const row = (labelKey: string, actions: Array<[string, string]>): Row => {
        const wrap = document.createElement('div')
        wrap.className = 'skip-row'
        const label = document.createElement('span')
        label.className = 'skip-row-label'
        label.textContent = ctx.t(labelKey)
        const value = document.createElement('span')
        value.className = 'skip-row-value'
        const tools = document.createElement('span')
        tools.className = 'skip-row-tools'
        for (const [textKey, action] of actions) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'skip-mini'
          b.textContent = ctx.t(textKey)
          b.addEventListener('click', () => act(action))
          tools.appendChild(b)
        }
        wrap.append(label, value, tools)
        host.appendChild(wrap)
        return { wrap, value }
      }

      const introStartRow = row('nav-chapters.skipSetIntroStart', [
        ['nav-chapters.skipPanelSet', 'introStart']
      ])
      const introEndRow = row('nav-chapters.skipSetIntroEnd', [
        ['nav-chapters.skipPanelSet', 'introEnd'],
        ['nav-chapters.skipPanelClear', 'clearIntro']
      ])
      const endingRow = row('nav-chapters.skipSetEndingStart', [
        ['nav-chapters.skipPanelSet', 'endingStart'],
        ['nav-chapters.skipPanelClear', 'clearEnding']
      ])

      const summary = document.createElement('p')
      summary.className = 'skip-summary'
      host.appendChild(summary)

      const detect = document.createElement('button')
      detect.type = 'button'
      detect.className = 'skip-detect'
      detect.addEventListener('click', () => act('detect'))
      host.appendChild(detect)

      const hint = document.createElement('p')
      hint.className = 'skip-hint'
      hint.textContent = ctx.t('nav-chapters.skipPanelHint')
      host.appendChild(hint)

      const paint = (s: SkipPanelState): void => {
        // The panel opens and closes ITSELF. `panel-host` mounts every panel
        // hidden and watches the element for `hidden`, because the module is the
        // only thing that knows whether its own state says "be visible".
        host.hidden = !s.open
        folder.textContent = `${ctx.t('nav-chapters.skipPanelFolder')}: ${s.folderLabel}`
        enableBtn.textContent = `${ctx.t('nav-chapters.skipToggle')}: ${ctx.t(
          s.enabled ? 'nav-chapters.skipPanelOn' : 'nav-chapters.skipPanelOff'
        )}`
        enableBtn.setAttribute('aria-pressed', String(s.enabled))
        modeBtn.textContent = `${ctx.t('nav-chapters.skipPanelMode')}: ${ctx.t(
          s.mode === 'auto' ? 'nav-chapters.skipMode.auto' : 'nav-chapters.skipMode.prompt'
        )}`

        const unset = ctx.t('nav-chapters.skipPanelUnset')
        introStartRow.value.textContent = rangeLabel(null, s.introStart) ?? unset
        introEndRow.value.textContent = rangeLabel(s.introStart, s.introEnd) ?? unset
        endingRow.value.textContent = rangeLabel(s.endingStart, s.duration || null) ?? unset
        for (const r of [introStartRow, introEndRow, endingRow]) {
          r.wrap.classList.toggle('skip-row-disabled', !s.hasFile)
        }

        const source =
          s.source === null ? null : ctx.t(`nav-chapters.skipPanelSource.${s.source}`)
        summary.textContent = !s.hasFile
          ? ctx.t('nav-chapters.skipPanelNoFile')
          : source === null
            ? ctx.t('nav-chapters.skipPanelNone')
            : source

        detect.textContent = ctx.t(
          s.detecting ? 'nav-chapters.detecting' : 'nav-chapters.skipDetect'
        )
        detect.disabled = s.detecting || !s.hasFile
        detect.classList.toggle('skip-detect-off', !s.fingerprintOptIn)
        detect.title = s.fingerprintOptIn ? '' : ctx.t('nav-chapters.detectOptIn')
      }

      paints.push(paint)
      paint(skip)
      return (): void => {
        const at = paints.indexOf(paint)
        if (at >= 0) paints.splice(at, 1)
      }
    }
  })
}

export default mod
