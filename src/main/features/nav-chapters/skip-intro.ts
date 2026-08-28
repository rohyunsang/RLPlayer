import path from 'node:path'
import fs from 'node:fs'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/media-types'
import { detectWindows } from './skip-detect.ts'
import {
  DEFAULT_TUNING,
  applyProposal,
  clearPoint,
  classifyJump,
  enteredWindow,
  folderKey,
  formatClock,
  jumpKind,
  learnEnding,
  learnIntro,
  observationFile,
  recordObservation,
  resolveWindows,
  setPoint,
  windowAt,
  type EndingAnchor,
  type ResolvedWindows,
  type SkipFolder,
  type SkipKind,
  type SkipWindow
} from './skip-model.ts'
import { SkipStore } from './skip-store.ts'
import type { FeatureContext, Unsubscribe } from '@shared/feature-api'

/**
 * N51 — Skip Intro / Skip Ending, the wiring. M25's row; added to §2.5 after an
 * audit found PotPlayer ships it on two dedicated keys and the spec had no row.
 *
 * The three tiers, in the order §2.5 requires them to exist:
 *
 *   1. MANUAL SET POINTS. Three commands and a JSON file. Deterministic, and the
 *      thing the user falls back to when the clever paths guess wrong. This tier
 *      must work with tiers 2 and 3 switched off, which is why nothing below is
 *      allowed to depend on them.
 *   2. LEARNED OFFSETS. Two hand-made skips in one folder that agree become a
 *      PROPOSAL. `skip-model.ts` cannot express "apply"; only a toast action can.
 *   3. AUDIO FINGERPRINT (`skip-detect.ts`). Opt-in, explicit command, proposes.
 *
 * THE FOUR RULES THAT ARE NOT NEGOTIABLE, inherited from N08 and from D-11:
 *
 *   - off by default (`nav-chapters.skipEnabled` defaults to `false`);
 *   - no automatic skip from anything but a window THIS FOLDER recorded — the
 *     `skipIntroSeconds` fallback is reachable only by an explicit keypress,
 *     because "auto-skip 90 s of every file" is a wrong skip on every film;
 *   - an OSD naming what was skipped, every time;
 *   - the undo affordance, every time.
 *
 * OWNERSHIP. This module writes no mpv property at all. Seeking is M24's command
 * (§3.6: "N51 seeks through M24's command, it does not own seeking"), so every
 * jump is `ctx.commands.invoke('nav-seek.seek', …)`. The series prefix is M28's
 * computation (`playlist.seriesPrefix`), asked for rather than re-derived, and
 * §3.6's fallback — "this folder" — is what happens when M28 is not in the
 * build. The renderer half never writes anything; it sends here.
 */

const EOF_MARGIN_SEC = 0.35
const PROMPT_ARM_MS = 5000

/**
 * The panel/seek-bar payload.
 *
 * DUPLICATED, and it should not be. §10 says "your two halves DO have a file
 * they both compile: `src/shared/features/<your id>/`" and that the directory is
 * listed in your row's `ownedFiles` — and M25's row lists only its two feature
 * directories, so `src/shared/features/nav-chapters/wire.ts` would be a file
 * `check:partition` reports as owned by NOBODY (verified: the check fails on it).
 * Editing `modules.json` is not this module's to do, so the type is written
 * twice, which is precisely the defect §10 was added to end. Reported as a
 * finding; the copy in `src/renderer/src/features/nav-chapters/skip-regions.ts`
 * must be kept in step by hand until the row claims the directory.
 */
export interface SkipPanelState {
  open: boolean
  enabled: boolean
  mode: 'prompt' | 'auto'
  hasFile: boolean
  folderLabel: string
  introStart: number | null
  introEnd: number | null
  endingStart: number | null
  source: 'manual' | 'learned' | 'fingerprint' | null
  detecting: boolean
  fingerprintOptIn: boolean
  duration: number
}

export interface SkipInstallation {
  dispose(): void
}

export function installSkip(ctx: FeatureContext): SkipInstallation {
  const store = new SkipStore(path.join(ctx.paths.dataDir(), 'skip.json'), ctx.log)
  const offs: Unsubscribe[] = []

  let key: string | null = null
  let file: string | null = null
  let prefix = ''
  let windows: ResolvedWindows = {}
  let prevTime: number | null = null
  /** Kinds this file has already answered: skipped, undone or declined. */
  const settled = new Set<SkipKind>()
  let lastSkip: { kind: SkipKind; from: number } | null = null
  let promptArmedUntil = 0
  const proposedThisSession = new Set<string>()
  let detecting = false
  let panelOpen = false

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  const enabled = (): boolean => ctx.settings.get<boolean>('nav-chapters.skipEnabled') === true
  const mode = (): 'prompt' | 'auto' =>
    ctx.settings.get<string>('nav-chapters.skipMode') === 'auto' ? 'auto' : 'prompt'
  const anchor = (): EndingAnchor =>
    ctx.settings.get<string>('nav-chapters.skipEndingAnchor') === 'absolute' ? 'absolute' : 'end'
  const learnOn = (): boolean => ctx.settings.get<boolean>('nav-chapters.skipLearn') === true
  const fingerprintOn = (): boolean =>
    ctx.settings.get<boolean>('nav-chapters.skipFingerprint') === true
  const introSeconds = (): number =>
    Math.max(1, ctx.settings.get<number>('nav-chapters.skipIntroSeconds') || 90)

  const duration = (): number => ctx.mpv.peek<number>('duration') ?? 0
  const timePos = (): number => ctx.mpv.peek<number>('time-pos') ?? 0
  const idle = (): boolean => ctx.mpv.peek<boolean>('idle-active') === true

  // -------------------------------------------------------------------------
  // Store access
  // -------------------------------------------------------------------------

  const record = (): SkipFolder | undefined => (key === null ? undefined : store.folder(key))
  const currentWindow = (): SkipWindow | undefined => record()?.window

  function writeWindow(w: SkipWindow | undefined): void {
    if (key === null) return
    const rec: SkipFolder = { ...(record() ?? {}) }
    if (w) rec.window = w
    else delete rec.window
    store.put(key, rec)
    recompute()
    push()
  }

  function writeObservation(kind: SkipKind, from: number, to: number): void {
    if (key === null || file === null) return
    const rec: SkipFolder = { ...(record() ?? {}) }
    const obs = {
      file: observationFile(file),
      from,
      to,
      duration: duration(),
      at: Date.now()
    }
    if (kind === 'intro') rec.intro = recordObservation(rec.intro, obs)
    else rec.ending = recordObservation(rec.ending, obs)
    store.put(key, rec)
    maybePropose(kind, rec)
  }

  function recompute(): void {
    windows = resolveWindows(currentWindow(), duration(), anchor())
  }

  // -------------------------------------------------------------------------
  // Seeking, always through M24
  // -------------------------------------------------------------------------

  async function seekTo(seconds: number): Promise<boolean> {
    if (!ctx.commands.has('nav-seek.seek')) {
      // M24 owns `seek` (§2.1). Without it there is no sanctioned way to move
      // playback, and issuing `['seek', …]` here is the exact ownership bypass
      // the guard exists to refuse. Fail visibly rather than quietly.
      ctx.log.warn('nav-seek.seek is not registered; skip cannot seek')
      return false
    }
    await ctx.commands.invoke('nav-seek.seek', {
      seconds: Math.max(0, seconds),
      absolute: true,
      quiet: true
    })
    return true
  }

  function label(kind: SkipKind): string {
    return kind === 'intro' ? ctx.i18n.t('nav-chapters.intro') : ctx.i18n.t('nav-chapters.ending')
  }

  /**
   * Perform one skip, with the OSD and the undo the row demands.
   *
   * `osd.show` names what was skipped and coalesces (it is gone in a second);
   * the toast carries the undo and lives long enough to press. Both, because the
   * row asks for both and because they answer different questions: "what just
   * happened to my playback" and "how do I get it back".
   */
  async function performSkip(kind: SkipKind, reason: 'auto' | 'manual' | 'prompt'): Promise<void> {
    const from = timePos()
    const win = kind === 'intro' ? windows.intro : windows.ending
    const dur = duration()
    let target: number
    if (win) {
      target = kind === 'intro' ? win.end : Math.max(0, dur - EOF_MARGIN_SEC)
    } else if (kind === 'intro') {
      // PotPlayer's `Skip Intro %s`: no learned window, so jump the configured
      // amount. Reachable ONLY from an explicit keypress — see the header.
      target = from + introSeconds()
    } else {
      if (!(dur > 0)) return
      target = Math.max(0, dur - EOF_MARGIN_SEC)
    }
    if (!(await seekTo(target))) return
    settled.add(kind)
    lastSkip = { kind, from }
    ctx.osd.show({
      kind: 'seek',
      text: ctx.i18n.t('nav-chapters.skipped', {
        what: label(kind),
        at: formatClock(target)
      })
    })
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('nav-chapters.skipped', {
        what: label(kind),
        at: formatClock(target)
      }),
      actionLabel: ctx.i18n.t('nav-chapters.undo'),
      onAction: () => void undoSkip()
    })
    ctx.log.info(`skip ${kind} (${reason}): ${from.toFixed(1)} -> ${target.toFixed(1)}`)
    push()
  }

  /**
   * Undo.
   *
   * §2.5 spells the undo `{"command":["revert-seek"]}`. `revert-seek` is M24's
   * command (§2.1) and M24 exposes NO mediator for it — `nav-seek.seek` is the
   * only one — so issuing it from here would be refused by the owner map, and
   * adding the mediator is a one-line PR against a module this row may not
   * touch. Reported as a finding.
   *
   * The absolute seek back to the recorded origin is not a workaround for its own
   * sake: it is deterministic where `revert-seek` is a stack whose top may be a
   * seek some OTHER module made in between. Either way, the affordance the row
   * requires is present and it lands the user where they were.
   */
  async function undoSkip(): Promise<void> {
    const last = lastSkip
    if (!last) return
    lastSkip = null
    if (!(await seekTo(last.from))) return
    // The window is still under the playhead, so without this the next `time-pos`
    // callback would re-enter it and skip again — an undo that undoes itself.
    settled.add(last.kind)
    ctx.osd.show({
      kind: 'seek',
      text: ctx.i18n.t('nav-chapters.undone', { what: label(last.kind) })
    })
  }

  // -------------------------------------------------------------------------
  // The window watcher
  // -------------------------------------------------------------------------

  function onTime(value: number | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    const next = value
    const prev = prevTime
    prevTime = next

    if (prev !== null) {
      const jump = jumpKind(prev, next, DEFAULT_TUNING)
      if (jump === 'forward') {
        // A hand-made forward jump is the evidence tier 2 learns from. It is
        // recorded whatever the setting says; only the PROPOSAL is gated, so
        // switching learning on later still has something to work with.
        const kind = classifyJump(prev, next, duration(), DEFAULT_TUNING)
        if (kind) writeObservation(kind, prev, next)
      } else if (jump === 'backward') {
        // The user deliberately went back. If they landed inside a window they
        // want to watch it, so this file's offer is spent.
        const inside = windowAt(next, windows)
        if (inside) settled.add(inside)
      }
    }

    if (!enabled()) return
    const entered = enteredWindow(prev, next, windows)
    if (!entered || settled.has(entered)) return
    if (mode() === 'auto') {
      void performSkip(entered, 'auto')
      return
    }
    offerSkip(entered)
  }

  /**
   * The 5 s "Skip Intro" affordance.
   *
   * §2.5 asks for a five-second button. The only transient surface a module can
   * reach is `ctx.osd.toast()`, whose lifetime is core's (6 s for `info`) and
   * which a module cannot retract — so the BUTTON cannot be withdrawn when the
   * playhead leaves the window. What is enforced here instead is the offer's
   * validity: pressing it after `PROMPT_ARM_MS`, or once playback has left the
   * window, does nothing rather than yanking playback from wherever the user has
   * got to. Reported as a finding.
   */
  function offerSkip(kind: SkipKind): void {
    settled.add(kind)
    promptArmedUntil = Date.now() + PROMPT_ARM_MS
    const armedFor = kind
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('nav-chapters.offer', { what: label(kind) }),
      actionLabel: ctx.i18n.t('nav-chapters.skipNow'),
      onAction: () => {
        if (Date.now() > promptArmedUntil) return
        if (windowAt(timePos(), windows) !== armedFor) return
        void performSkip(armedFor, 'prompt')
      }
    })
  }

  // -------------------------------------------------------------------------
  // Tier 2 — proposals
  // -------------------------------------------------------------------------

  function maybePropose(kind: SkipKind, rec: SkipFolder): void {
    if (!learnOn() || key === null) return
    const tag = `${key}|${kind}`
    if (proposedThisSession.has(tag)) return
    const existing = currentWindow()
    // A folder that already has the window does not need to be asked about it.
    if (kind === 'intro' && existing?.introEnd !== undefined) return
    if (kind === 'ending' && existing?.endingLead !== undefined) return

    const proposal =
      kind === 'intro'
        ? learnIntro(rec.intro, DEFAULT_TUNING)
        : learnEnding(rec.ending, DEFAULT_TUNING)
    if (!proposal) return
    proposedThisSession.add(tag)

    const what =
      proposal.kind === 'intro'
        ? `${formatClock(proposal.introStart)}–${formatClock(proposal.introEnd)}`
        : ctx.i18n.t('nav-chapters.leadOf', { sec: Math.round(proposal.endingLead) })
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('nav-chapters.learnedOffer', {
        what: label(kind),
        range: what,
        n: proposal.files.length
      }),
      actionLabel: ctx.i18n.t('nav-chapters.apply'),
      onAction: () => {
        writeWindow(applyProposal(currentWindow(), proposal, 'learned', Date.now()))
        ctx.osd.toast({
          kind: 'info',
          message: ctx.i18n.t('nav-chapters.applied', { what: label(kind) })
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Tier 3 — the opt-in fingerprint run
  // -------------------------------------------------------------------------

  const MEDIA = new Set<string>([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])

  /**
   * The nearest sibling episode, or null.
   *
   * §2.5 says the folder is "matched with M28's natural-sort sibling set", and
   * M28 exposes `playlist.seriesPrefix` but NOT the sibling set, so this reads
   * the directory itself and filters by the prefix M28 computed. That is a
   * duplication of L02/L50's scan and it is reported as a finding; what it is
   * NOT is a duplication of the prefix rule, which is the part that would
   * actually drift.
   */
  function siblingOf(current: string): string | null {
    let names: string[]
    try {
      names = fs.readdirSync(path.dirname(current))
    } catch {
      return null
    }
    const dir = path.dirname(current)
    const self = path.basename(current).toLowerCase()
    const want = prefix.trim().toLowerCase()
    const candidates = names
      .filter((n) => n.toLowerCase() !== self)
      .filter((n) => MEDIA.has(path.extname(n).slice(1).toLowerCase()))
      .filter((n) => want === '' || n.toLowerCase().startsWith(want))
      .sort((a, b) => a.localeCompare(b, 'ko'))
    const first = candidates[0]
    return first === undefined ? null : path.join(dir, first)
  }

  async function runDetect(): Promise<void> {
    if (detecting) return
    if (!fingerprintOn()) {
      ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('nav-chapters.detectOptIn') })
      return
    }
    const current = file
    if (current === null || idle()) return
    const sibling = siblingOf(current)
    if (sibling === null) {
      ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('nav-chapters.detectNoSibling') })
      return
    }
    detecting = true
    push()
    const job = ctx.osd.progress({
      id: 'nav-chapters.skipDetect',
      labelKey: 'nav-chapters.detecting',
      cancellable: true
    })
    try {
      const result = await detectWindows(
        {
          spawn: (o) => ctx.engine.spawn(o),
          jobDir: ctx.paths.tempJobDir('nav-chapters-skip'),
          log: ctx.log,
          cancelled: () => job.cancelled
        },
        current,
        sibling
      )
      job.done()
      if (job.cancelled) return
      const parts: string[] = []
      if (result.intro) {
        parts.push(
          `${ctx.i18n.t('nav-chapters.intro')} ${formatClock(result.intro.start)}–${formatClock(result.intro.end)}`
        )
      }
      if (result.ending?.lead !== undefined) {
        parts.push(
          `${ctx.i18n.t('nav-chapters.ending')} ${ctx.i18n.t('nav-chapters.leadOf', {
            sec: Math.round(result.ending.lead)
          })}`
        )
      }
      if (parts.length === 0) {
        ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('nav-chapters.detectNothing') })
        return
      }
      // PROPOSES. The action below is the only path from a fingerprint to a
      // stored window, and a human has to press it (D-11).
      ctx.osd.toast({
        kind: 'info',
        message: ctx.i18n.t('nav-chapters.detectFound', {
          what: parts.join(' · '),
          name: path.basename(sibling)
        }),
        actionLabel: ctx.i18n.t('nav-chapters.apply'),
        onAction: () => {
          let w = currentWindow()
          if (result.intro) {
            w = applyProposal(
              w,
              {
                kind: 'intro',
                introStart: result.intro.start,
                introEnd: result.intro.end,
                files: result.compared
              },
              'fingerprint',
              Date.now()
            )
          }
          if (result.ending?.lead !== undefined) {
            w = applyProposal(
              w,
              { kind: 'ending', endingLead: result.ending.lead, files: result.compared },
              'fingerprint',
              Date.now()
            )
          }
          writeWindow(w)
          ctx.osd.toast({
            kind: 'info',
            message: ctx.i18n.t('nav-chapters.applied', { what: ctx.i18n.t('nav-chapters.skip') })
          })
        }
      })
    } catch (e) {
      job.done()
      ctx.log.warn(`skip detect failed: ${(e as Error).message}`)
      ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('nav-chapters.detectFailed') })
    } finally {
      detecting = false
      push()
    }
  }

  // -------------------------------------------------------------------------
  // The renderer half
  // -------------------------------------------------------------------------

  function panelState(): SkipPanelState {
    const w = currentWindow()
    return {
      open: panelOpen,
      enabled: enabled(),
      mode: mode(),
      hasFile: file !== null && !idle(),
      folderLabel: prefix.trim() === '' ? ctx.i18n.t('nav-chapters.thisFolder') : prefix,
      introStart: windows.intro ? windows.intro.start : null,
      introEnd: windows.intro ? windows.intro.end : null,
      endingStart: windows.ending ? windows.ending.start : null,
      source: w?.source ?? null,
      detecting,
      fingerprintOptIn: fingerprintOn(),
      duration: duration()
    }
  }

  function push(): void {
    ctx.ipc.send('nav-chapters:skipState', panelState())
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  ctx.settings.define([
    {
      id: 'nav-chapters.skipEnabled',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipEnabled',
      descriptionKey: 'nav-chapters.skipEnabledDesc',
      type: { kind: 'bool' },
      // OFF BY DEFAULT. N08's trap, inherited verbatim: "silently moving
      // playback is exactly what gets a player uninstalled."
      default: false,
      keywords: ['건너뛰기', '인트로', 'skip', 'intro', 'opening', 'ending', 'op', 'ed'],
      order: 60
    },
    {
      id: 'nav-chapters.skipMode',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipMode',
      type: {
        kind: 'enum',
        options: [
          { value: 'prompt', labelKey: 'nav-chapters.skipMode.prompt' },
          { value: 'auto', labelKey: 'nav-chapters.skipMode.auto' }
        ]
      },
      default: 'prompt',
      keywords: ['자동', 'auto', 'prompt'],
      order: 61
    },
    {
      id: 'nav-chapters.skipIntroSeconds',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipIntroSeconds',
      descriptionKey: 'nav-chapters.skipIntroSecondsDesc',
      type: { kind: 'int', min: 5, max: 600, step: 5 },
      default: 90,
      order: 62
    },
    {
      id: 'nav-chapters.skipEndingAnchor',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipEndingAnchor',
      descriptionKey: 'nav-chapters.skipEndingAnchorDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'end', labelKey: 'nav-chapters.skipEndingAnchor.end' },
          { value: 'absolute', labelKey: 'nav-chapters.skipEndingAnchor.absolute' }
        ]
      },
      default: 'end',
      advanced: true,
      order: 63
    },
    {
      id: 'nav-chapters.skipLearn',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipLearn',
      descriptionKey: 'nav-chapters.skipLearnDesc',
      type: { kind: 'bool' },
      default: true,
      order: 64
    },
    {
      id: 'nav-chapters.skipFingerprint',
      section: 'playback',
      group: 'skip',
      labelKey: 'nav-chapters.skipFingerprint',
      descriptionKey: 'nav-chapters.skipFingerprintDesc',
      type: { kind: 'bool' },
      // OPT-IN (§2.5 tier 3, D-11). Even switched on it only ever proposes.
      default: false,
      advanced: true,
      order: 65
    }
  ])

  ctx.commands.register([
    {
      id: 'nav-chapters.skipIntro',
      labelKey: 'nav-chapters.skipIntro',
      category: 'navigation',
      // PotPlayer binds `'` to Skip Setup and `Shift+'` to the enable toggle and
      // leaves the two skip keys to the user; `;`/`Shift+;` keeps the cluster
      // together and neither was taken by any registered command.
      defaults: { default: ['Semicolon'], potplayer: ['Semicolon'] },
      enabledWhen: () => !idle(),
      run: () => performSkip('intro', 'manual')
    },
    {
      id: 'nav-chapters.skipEnding',
      labelKey: 'nav-chapters.skipEnding',
      category: 'navigation',
      defaults: { default: ['Shift+Semicolon'], potplayer: ['Shift+Semicolon'] },
      enabledWhen: () => !idle() && duration() > 0,
      run: () => performSkip('ending', 'manual')
    },
    {
      id: 'nav-chapters.skipToggle',
      labelKey: 'nav-chapters.skipToggle',
      category: 'navigation',
      defaults: { default: ['Shift+Quote'], potplayer: ['Shift+Quote'] },
      run: () => {
        const on = !enabled()
        ctx.settings.set('nav-chapters.skipEnabled', on)
        ctx.osd.show({
          kind: 'info',
          text: ctx.i18n.t(on ? 'nav-chapters.skipOn' : 'nav-chapters.skipOff')
        })
        push()
      }
    },
    {
      id: 'nav-chapters.skipSetup',
      labelKey: 'nav-chapters.skipSetup',
      category: 'navigation',
      defaults: { default: ['Quote'], potplayer: ['Quote'] },
      run: () => {
        panelOpen = !panelOpen
        push()
      }
    },
    {
      id: 'nav-chapters.skipSetIntroStart',
      labelKey: 'nav-chapters.skipSetIntroStart',
      category: 'navigation',
      enabledWhen: () => !idle(),
      run: () => setHere('introStart')
    },
    {
      id: 'nav-chapters.skipSetIntroEnd',
      labelKey: 'nav-chapters.skipSetIntroEnd',
      category: 'navigation',
      enabledWhen: () => !idle(),
      run: () => setHere('introEnd')
    },
    {
      id: 'nav-chapters.skipSetEndingStart',
      labelKey: 'nav-chapters.skipSetEndingStart',
      category: 'navigation',
      enabledWhen: () => !idle() && duration() > 0,
      run: () => setHere('endingStart')
    },
    {
      id: 'nav-chapters.skipClearIntro',
      labelKey: 'nav-chapters.skipClearIntro',
      category: 'navigation',
      run: () => clearHere('intro')
    },
    {
      id: 'nav-chapters.skipClearEnding',
      labelKey: 'nav-chapters.skipClearEnding',
      category: 'navigation',
      run: () => clearHere('ending')
    },
    {
      id: 'nav-chapters.skipUndo',
      labelKey: 'nav-chapters.skipUndo',
      category: 'navigation',
      enabledWhen: () => lastSkip !== null,
      run: () => undoSkip()
    },
    {
      id: 'nav-chapters.skipDetect',
      labelKey: 'nav-chapters.skipDetect',
      category: 'navigation',
      enabledWhen: () => !idle() && !detecting,
      run: () => runDetect()
    }
  ])

  function setHere(point: 'introStart' | 'introEnd' | 'endingStart'): void {
    if (key === null || idle()) return
    const t = timePos()
    writeWindow(setPoint(currentWindow(), point, t, duration(), Date.now()))
    // Whatever this file already answered, a fresh set point is a fresh offer.
    settled.clear()
    ctx.osd.show({
      kind: 'info',
      text: ctx.i18n.t(`nav-chapters.set.${point}`, { at: formatClock(t) })
    })
  }

  function clearHere(which: SkipKind): void {
    if (key === null) return
    writeWindow(clearPoint(currentWindow(), which, Date.now()))
    settled.delete(which)
    ctx.osd.show({ kind: 'info', text: ctx.i18n.t('nav-chapters.cleared', { what: label(which) }) })
  }

  ctx.ipc.on<{ action?: string }>('nav-chapters:skipAction', (req) => {
    const action = req?.action ?? ''
    switch (action) {
      case 'introStart':
      case 'introEnd':
      case 'endingStart':
        setHere(action)
        break
      case 'clearIntro':
        clearHere('intro')
        break
      case 'clearEnding':
        clearHere('ending')
        break
      case 'toggleEnabled':
        void ctx.commands.invoke('nav-chapters.skipToggle')
        break
      case 'toggleMode':
        ctx.settings.set('nav-chapters.skipMode', mode() === 'auto' ? 'prompt' : 'auto')
        push()
        break
      case 'detect':
        void runDetect()
        break
      case 'close':
        panelOpen = false
        push()
        break
      case 'sync':
        push()
        break
      default:
        break
    }
  })

  ctx.menu.contribute({
    id: 'nav-chapters.skipMenu',
    labelKey: 'nav-chapters.skip',
    order: 48,
    items: [
      {
        labelKey: 'nav-chapters.skip',
        submenu: [
          { commandId: 'nav-chapters.skipToggle', checked: enabled() },
          { commandId: 'nav-chapters.skipSetup' },
          { type: 'separator' },
          { commandId: 'nav-chapters.skipIntro' },
          { commandId: 'nav-chapters.skipEnding' },
          { commandId: 'nav-chapters.skipUndo' },
          { type: 'separator' },
          { commandId: 'nav-chapters.skipSetIntroStart' },
          { commandId: 'nav-chapters.skipSetIntroEnd' },
          { commandId: 'nav-chapters.skipSetEndingStart' },
          { commandId: 'nav-chapters.skipClearIntro' },
          { commandId: 'nav-chapters.skipClearEnding' },
          { type: 'separator' },
          { commandId: 'nav-chapters.skipDetect' }
        ]
      }
    ]
  })

  // -------------------------------------------------------------------------
  // Per-file wiring
  // -------------------------------------------------------------------------

  offs.push(
    ctx.mpv.afterFileLoaded((loaded) => {
      void onFileLoaded(loaded)
    })
  )

  async function onFileLoaded(loaded: string): Promise<void> {
    file = loaded
    prevTime = null
    settled.clear()
    lastSkip = null
    prefix = await seriesPrefixOf(loaded)
    key = folderKey(loaded, prefix)
    recompute()
    push()
  }

  /**
   * M28's prefix, or "this folder".
   *
   * §3.6: "N51 falls back to 'this folder' if `playlist.seriesPrefix` is not
   * there" — and the manifest reserving a module this build has not implemented
   * is a DEFERRED dependency, not a boot error, so this path is reachable and
   * `has()` is the check, not a try/catch around a throw.
   */
  async function seriesPrefixOf(f: string): Promise<string> {
    if (!ctx.commands.has('playlist.seriesPrefix')) return ''
    try {
      const p = await ctx.commands.query<string>('playlist.seriesPrefix', f)
      return typeof p === 'string' ? p : ''
    } catch (e) {
      ctx.log.warn(`playlist.seriesPrefix failed: ${(e as Error).message}`)
      return ''
    }
  }

  offs.push(ctx.mpv.observe<number>('time-pos', onTime))
  offs.push(
    ctx.mpv.observe<number>('duration', () => {
      recompute()
      push()
    })
  )
  for (const id of [
    'nav-chapters.skipEnabled',
    'nav-chapters.skipMode',
    'nav-chapters.skipEndingAnchor',
    'nav-chapters.skipFingerprint'
  ]) {
    offs.push(
      ctx.settings.onChange(id, () => {
        recompute()
        push()
      })
    )
  }

  ctx.lifecycle.onQuit(() => store.dispose())

  ctx.i18n.register('ko', {
    'nav-chapters.skip': '건너뛰기',
    'nav-chapters.intro': '인트로',
    'nav-chapters.ending': '엔딩',
    'nav-chapters.thisFolder': '이 폴더',
    'nav-chapters.skipIntro': '인트로 건너뛰기',
    'nav-chapters.skipEnding': '엔딩 건너뛰기',
    'nav-chapters.skipToggle': '건너뛰기 사용',
    'nav-chapters.skipSetup': '건너뛰기 설정...',
    'nav-chapters.skipSetIntroStart': '여기를 인트로 시작으로',
    'nav-chapters.skipSetIntroEnd': '여기를 인트로 끝으로',
    'nav-chapters.skipSetEndingStart': '여기를 엔딩 시작으로',
    'nav-chapters.skipClearIntro': '인트로 구간 지우기',
    'nav-chapters.skipClearEnding': '엔딩 구간 지우기',
    'nav-chapters.skipUndo': '건너뛰기 되돌리기',
    'nav-chapters.skipDetect': '오디오로 구간 찾기',
    'nav-chapters.skipOn': '건너뛰기 켜짐',
    'nav-chapters.skipOff': '건너뛰기 꺼짐',
    'nav-chapters.skipped': '{what}{을/를} 건너뛰었습니다 ({at})',
    'nav-chapters.undone': '{what} 건너뛰기를 되돌렸습니다',
    'nav-chapters.undo': '되돌리기',
    'nav-chapters.offer': '{what}{을/를} 건너뛸까요?',
    'nav-chapters.skipNow': '건너뛰기',
    'nav-chapters.apply': '적용',
    'nav-chapters.applied': '{what} 구간을 이 폴더에 적용했습니다',
    'nav-chapters.cleared': '{what} 구간을 지웠습니다',
    'nav-chapters.leadOf': '끝에서 {sec}초',
    'nav-chapters.learnedOffer': '{n}개 화에서 {what} 구간({range})이 같습니다. 폴더 전체에 적용할까요?',
    'nav-chapters.set.introStart': '인트로 시작: {at}',
    'nav-chapters.set.introEnd': '인트로 끝: {at}',
    'nav-chapters.set.endingStart': '엔딩 시작: {at}',
    'nav-chapters.detecting': '오디오 구간 분석 중...',
    'nav-chapters.detectOptIn': '오디오 분석은 설정에서 먼저 켜야 합니다',
    'nav-chapters.detectNoSibling': '같은 시리즈의 다른 파일을 찾지 못했습니다',
    'nav-chapters.detectNothing': '공통 구간을 찾지 못했습니다',
    'nav-chapters.detectFailed': '오디오 분석에 실패했습니다',
    'nav-chapters.detectFound': '{name}와 비교: {what}. 적용할까요?',
    'nav-chapters.skipEnabled': '인트로/엔딩 건너뛰기',
    'nav-chapters.skipEnabledDesc':
      '폴더에 저장된 구간에 도달하면 건너뛰거나 건너뛸지 물어봅니다. 저장된 구간이 없으면 아무 일도 하지 않습니다.',
    'nav-chapters.skipMode': '건너뛰는 방식',
    'nav-chapters.skipMode.prompt': '물어보기',
    'nav-chapters.skipMode.auto': '자동으로 건너뛰기',
    'nav-chapters.skipIntroSeconds': '인트로 건너뛰기 기본 길이(초)',
    'nav-chapters.skipIntroSecondsDesc':
      '저장된 구간이 없을 때 인트로 건너뛰기 키가 앞으로 이동하는 시간입니다. 자동 건너뛰기에는 쓰이지 않습니다.',
    'nav-chapters.skipEndingAnchor': '엔딩 구간 기준',
    'nav-chapters.skipEndingAnchorDesc':
      '회차마다 길이가 다르므로 기본값은 파일 끝에서부터 계산합니다.',
    'nav-chapters.skipEndingAnchor.end': '파일 끝에서부터',
    'nav-chapters.skipEndingAnchor.absolute': '절대 시간',
    'nav-chapters.skipLearn': '건너뛴 구간 학습',
    'nav-chapters.skipLearnDesc':
      '같은 폴더의 두 화 이상에서 같은 구간을 직접 건너뛰면 폴더 전체에 적용할지 물어봅니다.',
    'nav-chapters.skipFingerprint': '오디오로 인트로/엔딩 찾기(실험적)',
    'nav-chapters.skipFingerprintDesc':
      '같은 폴더의 다른 화와 오디오를 비교해 공통 구간을 찾습니다. 직접 실행해야 하고, 항상 제안만 하며 자동으로 적용하지 않습니다.',
    'nav-chapters.skipPanelTitle': '건너뛰기 설정',
    'nav-chapters.skipPanelFolder': '폴더',
    'nav-chapters.skipPanelNone': '설정된 구간이 없습니다',
    'nav-chapters.skipPanelClose': '닫기',
    'nav-chapters.skipPanelSource.manual': '직접 설정',
    'nav-chapters.skipPanelSource.learned': '학습됨',
    'nav-chapters.skipPanelSource.fingerprint': '오디오 분석'
  })
  ctx.i18n.register('en', {
    'nav-chapters.skip': 'Skip',
    'nav-chapters.intro': 'the intro',
    'nav-chapters.ending': 'the ending',
    'nav-chapters.thisFolder': 'this folder',
    'nav-chapters.skipIntro': 'Skip intro',
    'nav-chapters.skipEnding': 'Skip ending',
    'nav-chapters.skipToggle': 'Enable skip',
    'nav-chapters.skipSetup': 'Skip setup...',
    'nav-chapters.skipSetIntroStart': 'Set intro start here',
    'nav-chapters.skipSetIntroEnd': 'Set intro end here',
    'nav-chapters.skipSetEndingStart': 'Set ending start here',
    'nav-chapters.skipClearIntro': 'Clear intro window',
    'nav-chapters.skipClearEnding': 'Clear ending window',
    'nav-chapters.skipUndo': 'Undo skip',
    'nav-chapters.skipDetect': 'Find windows from audio',
    'nav-chapters.skipOn': 'Skip on',
    'nav-chapters.skipOff': 'Skip off',
    'nav-chapters.skipped': 'Skipped {what} ({at})',
    'nav-chapters.undone': 'Undid the {what} skip',
    'nav-chapters.undo': 'Undo',
    'nav-chapters.offer': 'Skip {what}?',
    'nav-chapters.skipNow': 'Skip',
    'nav-chapters.apply': 'Apply',
    'nav-chapters.applied': 'Applied {what} to this folder',
    'nav-chapters.cleared': 'Cleared {what}',
    'nav-chapters.leadOf': '{sec}s before the end',
    'nav-chapters.learnedOffer':
      '{n} episodes agree on {what} ({range}). Apply to the whole folder?',
    'nav-chapters.set.introStart': 'Intro start: {at}',
    'nav-chapters.set.introEnd': 'Intro end: {at}',
    'nav-chapters.set.endingStart': 'Ending start: {at}',
    'nav-chapters.detecting': 'Analysing audio...',
    'nav-chapters.detectOptIn': 'Turn on audio analysis in settings first',
    'nav-chapters.detectNoSibling': 'No other episode found in this folder',
    'nav-chapters.detectNothing': 'No shared audio run found',
    'nav-chapters.detectFailed': 'Audio analysis failed',
    'nav-chapters.detectFound': 'Compared with {name}: {what}. Apply?',
    'nav-chapters.skipEnabled': 'Skip intro / ending',
    'nav-chapters.skipEnabledDesc':
      'When playback reaches a window this folder has stored, skip it or offer to. With no stored window nothing happens.',
    'nav-chapters.skipMode': 'How to skip',
    'nav-chapters.skipMode.prompt': 'Ask first',
    'nav-chapters.skipMode.auto': 'Skip automatically',
    'nav-chapters.skipIntroSeconds': 'Default intro skip (seconds)',
    'nav-chapters.skipIntroSecondsDesc':
      'How far the skip-intro key jumps when this folder has no stored window. Never used for automatic skips.',
    'nav-chapters.skipEndingAnchor': 'Ending window anchor',
    'nav-chapters.skipEndingAnchorDesc':
      'Episode runtimes differ, so the default measures back from the end of the file.',
    'nav-chapters.skipEndingAnchor.end': 'From the end of the file',
    'nav-chapters.skipEndingAnchor.absolute': 'Absolute time',
    'nav-chapters.skipLearn': 'Learn skipped windows',
    'nav-chapters.skipLearnDesc':
      'When you skip the same window by hand on two episodes in one folder, offer to apply it to the rest.',
    'nav-chapters.skipFingerprint': 'Find intro/ending from audio (experimental)',
    'nav-chapters.skipFingerprintDesc':
      'Compares audio with another episode in the folder to find the shared run. You have to run it, and it only ever proposes — it never applies on its own.',
    'nav-chapters.skipPanelTitle': 'Skip setup',
    'nav-chapters.skipPanelFolder': 'Folder',
    'nav-chapters.skipPanelNone': 'No window set',
    'nav-chapters.skipPanelClose': 'Close',
    'nav-chapters.skipPanelSource.manual': 'Set by hand',
    'nav-chapters.skipPanelSource.learned': 'Learned',
    'nav-chapters.skipPanelSource.fingerprint': 'From audio'
  })

  return {
    dispose(): void {
      for (const off of offs) off()
      offs.length = 0
      store.dispose()
    }
  }
}
