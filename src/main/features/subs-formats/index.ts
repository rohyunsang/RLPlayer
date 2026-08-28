import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { FeatureContext, FeatureModule, MenuNode } from '@shared/feature-api'
import { PROBE_ARGS, parseMpvFeatures } from './capability.ts'
import { CODEPAGES, DEFAULT_CODEPAGE, codepageOptions, decoderFor } from './codepages.ts'
import { isConvertibleExtension, planConversion } from './convert.ts'
import type { ConversionPlan, ConvertOptions } from './convert.ts'
import type { RubyMode } from './ass.ts'
import { bakeCues, encodeCp949, isReadableForExport, readSubtitle, toSmi, toSrt, utf8WithBom } from './serialise.ts'
import { decodeSubtitle } from './text.ts'

/**
 * M18 subs-formats — SMI/SAMI, TTML and character encoding (S03–S07, S33, S34,
 * S42). The single most Korean-market-critical module in the product: a Korean
 * rip ships a `.smi` in CP949, and mpv's support for that combination is
 * partial in three specific, measured ways.
 *
 * WHAT THIS MODULE OWNS: `sub-codepage`, and nothing else. In particular it does
 * NOT own `sub-reload` (M17's, §3.7.1 — the spec had three claimants for it two
 * pages apart) and it does not own `sub-add`, so every track it produces is
 * handed to M17's mediator rather than added here.
 *
 * WHAT IT DOES, in order of how much it matters to a Korean user:
 *
 *  1. S33 — leaves auto-detection alone and ASSERTS it exists. `--sub-codepage`
 *     defaults to `auto`, whose fourth step is uchardet, and the pinned binary
 *     has it (`libuchardet detected charset as UHC` on a real CP949 SMI). If the
 *     binary is ever swapped for one without it, every Korean subtitle silently
 *     becomes mojibake, so the absence is a loud boot-time error.
 *  2. S34 — a forced-codepage dropdown and a keybind, both of which write
 *     `sub-codepage` and then call `subs-tracks.reload`. The `+` prefix is
 *     mandatory: without it mpv short-circuits to UTF-8 whenever the bytes
 *     happen to validate.
 *  3. S03/S04 — the SMI converter, for the two cases FFmpeg gets wrong: two
 *     `<SYNC>` at the same PTS (the Korean line is the one that disappears) and
 *     a header that is not byte-exactly `<SAMI>` (total silence).
 *  4. S05/S06 — ruby and per-class CSS, both off by default.
 *  5. S07 — TTML/DFXP, which has no demuxer in FFmpeg at all.
 *  6. S42 — export with `sub-delay`/`sub-speed` baked in, UTF-8 with a BOM (or
 *     CP949 on request).
 *
 * WHAT DOES NOT WORK, said out loud rather than left to be discovered:
 *
 *  - The original multi-language `.smi` track stays in the track list beside the
 *    two split tracks. Removing it needs `sub-remove`, which is M17's and has no
 *    mediator; adding one is a one-line PR against M17 (§2's own words). Until
 *    then the user sees three subtitle entries and the preferred one is selected
 *    for them.
 *  - `subs-tracks.addFile` takes a path and nothing else, so the `title` and
 *    `lang` arguments S03 specifies for `sub-add` cannot be passed. The track
 *    shows up under its cache file name; the language is carried by the
 *    `.<lang>.` infix in that name, which `--sub-auto=exact` parsing understands
 *    but `sub-add` does not.
 *  - Our detector is not uchardet. mpv decodes everything it can demux itself;
 *    the files THIS module rewrites are decoded here first, by a BOM/UTF-8/CJK
 *    scorer with a Korean prior (see `text.ts`). A Japanese Shift-JIS multi-class
 *    `.smi` can be mis-detected where mpv's uchardet would have been right. The
 *    escape hatch is the S34 dropdown, which forces both decoders at once.
 *  - Embedded (in-container) subtitles cannot be exported: mpv exposes only the
 *    current event, and there is no dump-all API. S40 (M21) tracks that.
 */

let ctx: FeatureContext
/**
 * The codepage in effect for the file playing now, which is NOT the same thing
 * as the setting: the setting is the default for the next file, the per-file
 * slice can override it for this one, and S34's keybind changes only this one.
 */
let currentCodepage = DEFAULT_CODEPAGE
let lastPlan: { file: string; plan: ConversionPlan; added: string[] } | null = null
/** Cache paths already handed to M17 for the file playing now. */
const addedThisFile = new Set<string>()
let warnedNoMediator = false

const SUB_DIRS = ['sub', 'subs', 'subtitles', '자막']
/** A subtitle nobody sane ships larger than this; a guard, not a limit. */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface RawTrack {
  id: number
  type: string
  external?: boolean
  selected?: boolean
  lang?: string
  title?: string
  'external-filename'?: string
}

const rawTracks = (): RawTrack[] => ctx.mpv.peek<RawTrack[]>('track-list') ?? []

function convertOptions(): ConvertOptions {
  return {
    forcedDecoder: decoderFor(currentCodepage),
    rubyMode: ctx.settings.get<RubyMode>('subs-formats.rubyMode'),
    useSubtitleStyle: ctx.settings.get<boolean>('subs-formats.useSubtitleStyle'),
    preferredLangs: preferredLangs()
  }
}

function preferredLangs(): string[] {
  const raw = ctx.settings.get<string[]>('subs-formats.preferredLangs')
  const list = (Array.isArray(raw) ? raw : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length > 0)
  return list.length > 0 ? list : ['ko']
}

// ---------------------------------------------------------------------------
// S33 — the uchardet assertion
// ---------------------------------------------------------------------------

/**
 * Run `mpv --no-config -v --version` once and check the feature list.
 *
 * NOT through `ctx.engine.spawn()`, and that is a deliberate, reported gap
 * rather than a shortcut. Core always applies `--msg-level=all=no` to a
 * secondary engine (it says so in `EngineService`'s own contract), and that flag
 * SUPPRESSES the "List of enabled features" line this probe exists to read; it
 * also always applies `--idle=yes` and an IPC pipe, which a `--version` probe
 * neither needs nor survives. `ctx.paths.mpvBinary()` is sanctioned for exactly
 * this shape of use ("a version string in a bug report"), and the child is
 * handed to `ctx.lifecycle.trackProcess()` so the no-orphan-mpv guarantee still
 * holds.
 *
 * Never awaited by `setup()`: a subtitle capability check must not be able to
 * delay the first frame.
 */
function assertUchardet(): void {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(ctx.paths.mpvBinary(), [...PROBE_ARGS], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    ctx.log.warn('uchardet probe could not start:', (e as Error).message)
    return
  }
  // `LifecycleService.trackProcess` is typed `kill(signal?: string)`, while
  // Node's `ChildProcess.kill` takes `NodeJS.Signals | number`, so a real child
  // process — the only thing this method exists for — is not assignable to its
  // own parameter. Adapted here rather than left as a cast; it is a one-word fix
  // in `feature-api.ts` and it is in the report.
  ctx.lifecycle.trackProcess({
    pid: child.pid,
    kill: (signal?: string) => child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
  })
  let out = ''
  const timer = setTimeout(() => child.kill(), 5000)
  child.stdout?.on('data', (b: Buffer) => {
    out += b.toString('utf8')
  })
  // mpv writes its banner to stdout, but a build with a different msg-level
  // default could put it on stderr; read both rather than conclude "absent".
  child.stderr?.on('data', (b: Buffer) => {
    out += b.toString('utf8')
  })
  child.on('error', (e) => {
    clearTimeout(timer)
    ctx.log.warn('uchardet probe failed:', e.message)
  })
  child.on('close', () => {
    clearTimeout(timer)
    const report = parseMpvFeatures(out)
    if (report.hasUchardet) {
      ctx.log.info(`mpv ${report.version}: uchardet present, S33 auto-detection is live`)
      return
    }
    // Loud, once, and it names the consequence rather than the flag.
    ctx.log.error(
      `mpv ${report.version} has no uchardet in its feature list ` +
        `(${report.features.length} features read). --sub-codepage=auto will fall through ` +
        `to UTF-8-BROKEN, so every CP949 subtitle will render as mojibake.`
    )
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t('subs-formats.noUchardet'),
      actionLabel: ctx.i18n.t('subs-formats.forceCp949'),
      onAction: () => void applyCodepage('+cp949', true)
    })
  })
}

// ---------------------------------------------------------------------------
// S34 — the forced codepage
// ---------------------------------------------------------------------------

/**
 * Both halves of S34's "two steps, both required": write `sub-codepage`, then
 * ask M17 to reload. `sub-reload` re-reads EXTERNAL tracks only — mkv subtitles
 * "are always assumed to be UTF-8" — which is why M17's mediator is a no-op for
 * an embedded track and why the dropdown is greyed for one.
 */
async function applyCodepage(value: string, announce: boolean): Promise<void> {
  currentCodepage = value
  try {
    await ctx.mpv.set('sub-codepage', value)
  } catch (e) {
    ctx.log.warn('sub-codepage write failed:', (e as Error).message)
    return
  }
  if (ctx.commands.has('subs-tracks.reload')) {
    await ctx.commands.invoke('subs-tracks.reload')
  } else if (!warnedNoMediator) {
    warnedNoMediator = true
    ctx.log.warn(
      "subs-tracks.reload is not registered, so the codepage change will only " +
        'take effect on the next file. sub-reload is M17\'s command (§3.7.1).'
    )
  }
  if (announce) {
    ctx.osd.show({
      kind: 'track',
      text: ctx.i18n.t('subs-formats.codepageOsd', { name: codepageLabel(value) })
    })
  }
}

function codepageLabel(value: string): string {
  const entry = CODEPAGES.find((c) => c.mpv === value)
  return entry ? ctx.i18n.t(entry.labelKey) : value
}

function selectedExternalSub(): RawTrack | null {
  const sid = ctx.mpv.peek<number | false>('sid')
  const t = rawTracks().find((x) => x.type === 'sub' && x.id === sid)
  return t?.external && t['external-filename'] ? t : null
}

// ---------------------------------------------------------------------------
// S03/S04/S07 — the conversion pass
// ---------------------------------------------------------------------------

/** Files worth looking at for the file now playing, newest decision first. */
export function convertibleCandidates(
  videoPath: string | null,
  listDir: (dir: string) => string[],
  alreadyLoaded: readonly string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string): void => {
    const key = p.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  // Anything mpv DID manage to load and that we can improve on.
  for (const f of alreadyLoaded) if (isConvertibleExtension(f)) push(f)
  if (!videoPath) return out

  /**
   * …plus a sibling scan, which is here for one reason: an `.smi` whose header
   * is not byte-exactly `<SAMI>` never appears in `track-list` at all. Its probe
   * score is 1, below `--demuxer-lavf-probescore`'s 26, so mpv reports "can not
   * open external file" and there is nothing for us to notice. Without this
   * scan, S04 — three verified total-silence failures — would be unreachable.
   *
   * It is NOT S10's fuzzy matching and deliberately does not become it: the only
   * candidates are files whose name is the video's basename, optionally followed
   * by a dotted suffix (`Movie.smi`, `Movie.ko.smi`, `Movie.KRCC.smi`). Scoring
   * release tags and episode numbers is M17's row, and duplicating it here would
   * produce two different answers to the same question.
   */
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase()
  for (const d of [dir, ...SUB_DIRS.map((s) => path.join(dir, s))]) {
    for (const name of listDir(d)) {
      if (!isConvertibleExtension(name)) continue
      const stem = name.slice(0, name.length - path.extname(name).length).toLowerCase()
      if (stem !== base && !stem.startsWith(`${base}.`)) continue
      push(path.join(d, name))
    }
  }
  return out
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

async function convertPass(announce: boolean): Promise<void> {
  const videoPath = ctx.perFile.currentPath()
  const loaded = rawTracks()
    .filter((t) => t.type === 'sub' && t.external)
    .map((t) => t['external-filename'] ?? '')
    .filter((f) => f.length > 0)
  const cacheDir = ctx.paths.subCacheDir()
  const candidates = convertibleCandidates(videoPath, listDirSafe, loaded).filter(
    // Never convert our own output: it is already ASS or a repaired SMI, and a
    // second pass would fork the cache on every load.
    (p) => path.resolve(path.dirname(p)).toLowerCase() !== path.resolve(cacheDir).toLowerCase()
  )
  if (candidates.length === 0) {
    if (announce) ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('subs-formats.nothingToDo') })
    return
  }

  let converted = 0
  for (const source of candidates) {
    const plan = await convertOne(source, cacheDir)
    if (plan) converted += plan
  }
  if (announce && converted === 0) {
    ctx.osd.toast({ kind: 'info', message: ctx.i18n.t('subs-formats.nothingToDo') })
  }
}

/** @returns how many tracks were handed to M17, or null when nothing was done. */
async function convertOne(source: string, cacheDir: string): Promise<number | null> {
  let bytes: Uint8Array
  try {
    const stat = fs.statSync(source)
    if (stat.size > MAX_SOURCE_BYTES) {
      ctx.log.warn(`${source} is ${stat.size} bytes; not converting`)
      return null
    }
    bytes = new Uint8Array(fs.readFileSync(source))
  } catch (e) {
    ctx.log.warn(`cannot read ${source}:`, (e as Error).message)
    return null
  }

  const plan = planConversion(bytes, source, convertOptions())
  lastPlan = { file: source, plan, added: [] }
  if (plan.kind === 'none' || plan.kind === 'unsupported' || plan.outputs.length === 0) {
    ctx.log.info(`${path.basename(source)}: ${plan.kind} (${plan.reasonKey}), left to mpv`)
    return null
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true })
  } catch (e) {
    ctx.log.error('cannot create the subtitle cache:', (e as Error).message)
    return null
  }

  // The PREFERRED output goes LAST, because the only way in to `sub-add` is
  // M17's `subs-tracks.addFile`, which always passes `select`. Ordering is
  // therefore the whole selection mechanism; a mediator taking the flag would be
  // better and is in the report.
  const ordered = [...plan.outputs].sort((a, b) => Number(a.preferred) - Number(b.preferred))
  let added = 0
  for (const out of ordered) {
    const target = path.join(cacheDir, out.fileName)
    if (addedThisFile.has(target.toLowerCase())) continue
    try {
      // Always UTF-8 with a BOM. The repaired `.smi` is re-read by mpv, and a
      // BOM is the one thing that makes its encoding unambiguous to uchardet,
      // to Notepad and to FFmpeg's FFTextReader all three.
      if (!fs.existsSync(target)) fs.writeFileSync(target, utf8WithBom(out.text))
    } catch (e) {
      ctx.log.error(`cannot write ${target}:`, (e as Error).message)
      continue
    }
    if (!ctx.commands.has('subs-tracks.addFile')) {
      if (!warnedNoMediator) {
        warnedNoMediator = true
        ctx.log.warn(
          'subs-tracks.addFile is not registered, so the converted track cannot be added. ' +
            'sub-add is M17\'s command (§3.7.1) and this module may not issue it.'
        )
      }
      break
    }
    try {
      await ctx.commands.invoke('subs-tracks.addFile', target)
      addedThisFile.add(target.toLowerCase())
      lastPlan.added.push(out.fileName)
      added++
    } catch (e) {
      ctx.log.error(`subs-tracks.addFile refused ${target}:`, (e as Error).message)
    }
  }

  if (added > 0) {
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t(`subs-formats.toast.${plan.kind}`, {
        name: path.basename(source),
        count: added
      })
    })
  }
  ctx.ipc.send('subs-formats:report', report(), 'all')
  return added
}

/** What the stats overlay and a bug report want to see. */
export interface FormatsReport {
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

function report(): FormatsReport {
  return {
    codepage: currentCodepage,
    encoding: lastPlan?.plan.encoding ?? '',
    kind: lastPlan?.plan.kind ?? '',
    reasonKey: lastPlan?.plan.reasonKey ?? '',
    file: lastPlan ? path.basename(lastPlan.file) : '',
    classes: lastPlan?.plan.diagnostics.classes ?? [],
    duplicateTimestamps: lastPlan?.plan.diagnostics.duplicateTimestamps ?? 0,
    probeScore: lastPlan?.plan.diagnostics.probeScore ?? 0,
    added: lastPlan?.added ?? []
  }
}

// ---------------------------------------------------------------------------
// S42 — export
// ---------------------------------------------------------------------------

type ExportTarget = 'ask' | 'beside' | 'smi'

async function exportSubtitle(target: ExportTarget): Promise<void> {
  const track = selectedExternalSub()
  const source = track?.['external-filename'] ?? ''
  if (source.length === 0) {
    // Honest refusal. mpv exposes only the CURRENT subtitle event, so there is
    // no way to read an embedded track's timeline; pretending otherwise would
    // write a one-line file.
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('subs-formats.exportNeedsExternal') })
    return
  }
  if (!isReadableForExport(source)) {
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t('subs-formats.exportUnreadable', { name: path.basename(source) })
    })
    return
  }

  let text: string
  try {
    text = decodeSubtitle(new Uint8Array(fs.readFileSync(source)), decoderFor(currentCodepage)).text
  } catch (e) {
    ctx.osd.toast({ kind: 'error', message: `${path.basename(source)}: ${(e as Error).message}` })
    return
  }

  const read = readSubtitle(text, source, { preferredLangs: preferredLangs() })
  const delay = ctx.mpv.peek<number>('sub-delay') ?? 0
  const speed = ctx.mpv.peek<number>('sub-speed') ?? 1
  const cues = bakeCues(read.cues, { delay, speed })
  if (cues.length === 0) {
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('subs-formats.exportEmpty') })
    return
  }

  const videoPath = ctx.perFile.currentPath()
  const lang = track?.lang ?? read.exportedClass.toLowerCase() ?? 'und'
  const ext = target === 'smi' ? 'smi' : 'srt'
  const suggested =
    videoPath !== null
      ? path.join(
          path.dirname(videoPath),
          `${path.basename(videoPath, path.extname(videoPath))}.${lang || 'und'}.${ext}`
        )
      : `${path.basename(source, path.extname(source))}.${ext}`

  let out = suggested
  if (target !== 'beside') {
    const picked = await ctx.dialog.saveFile({
      titleKey: 'subs-formats.saveTitle',
      defaultPath: suggested,
      filters:
        target === 'smi'
          ? [{ name: 'SAMI', extensions: ['smi'] }]
          : [{ name: 'SubRip', extensions: ['srt'] }]
    })
    if (!picked) return
    out = picked
  }

  const body =
    target === 'smi' ? toSmi(cues, read.exportedClass || 'KRCC', lang || 'ko') : toSrt(cues)
  let bytes: Uint8Array
  let lost = 0
  if (target === 'smi' && ctx.settings.get<string>('subs-formats.exportEncoding') === 'cp949') {
    const enc = encodeCp949(body)
    bytes = enc.bytes
    lost = enc.unmappable
  } else {
    bytes = utf8WithBom(body)
  }

  try {
    fs.writeFileSync(out, bytes)
  } catch (e) {
    ctx.osd.toast({ kind: 'error', message: `${path.basename(out)}: ${(e as Error).message}` })
    return
  }
  ctx.osd.toast({
    kind: 'info',
    message: ctx.i18n.t('subs-formats.exported', {
      name: path.basename(out),
      count: cues.length,
      cls: read.exportedClass
    })
  })
  if (lost > 0) {
    // Counted, never silent: S42 quotes PotPlayer's own "Hangul was broken when
    // subtitle sync was saved" bug, and a damaged file with no warning is that
    // bug with better manners.
    ctx.osd.toast({
      kind: 'error',
      message: ctx.i18n.t('subs-formats.exportLossy', { count: lost })
    })
  }
}

// ---------------------------------------------------------------------------
// Cache hygiene
// ---------------------------------------------------------------------------

function pruneCache(): void {
  const dir = ctx.paths.subCacheDir()
  const cutoff = Date.now() - CACHE_TTL_MS
  let removed = 0
  for (const name of listDirSafe(dir)) {
    // Only files this module's `cacheKey()` could have produced: 16 hex chars,
    // a dot, and one of our two output extensions. Never a blanket unlink of a
    // directory core also hands to other modules.
    if (!/^[0-9a-f]{16}\..*\.(ass|srt|smi)$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full)
        removed++
      }
    } catch {
      /* a file another window is reading; next launch will get it */
    }
  }
  if (removed > 0) ctx.log.info(`pruned ${removed} stale converted subtitle(s)`)
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const mod: FeatureModule = {
  id: 'subs-formats',
  // Copied verbatim from this module's `modules.json` row, which is the same
  // namespace as this field (§1). `subs-tracks` is deliberately NOT here: M17
  // depends on M18, and naming it back would be the cycle the registry refuses.
  dependsOn: ['core-settings'],
  ownsProperties: ['sub-codepage'],

  setup(c): void {
    ctx = c

    ctx.settings.define([
      {
        id: 'subs-formats.codepage',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.codepageLabel',
        descriptionKey: 'subs-formats.codepageDesc',
        type: { kind: 'enum', options: codepageOptions() },
        default: DEFAULT_CODEPAGE,
        mpvOption: 'sub-codepage',
        keywords: ['인코딩', '한글', '깨짐', 'cp949', 'euc-kr', 'encoding', 'charset', 'mojibake'],
        order: 20
      },
      {
        id: 'subs-formats.autoConvert',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.autoConvertLabel',
        descriptionKey: 'subs-formats.autoConvertDesc',
        type: { kind: 'bool' },
        default: true,
        keywords: ['smi', 'sami', '변환', 'convert', 'ttml'],
        order: 22
      },
      {
        id: 'subs-formats.preferredLangs',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.preferredLangsLabel',
        descriptionKey: 'subs-formats.preferredLangsDesc',
        type: { kind: 'list', of: 'string' },
        default: ['ko', 'en'],
        keywords: ['언어', 'language', 'krcc', 'encc'],
        order: 24
      },
      {
        id: 'subs-formats.useSubtitleStyle',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.useStyleLabel',
        descriptionKey: 'subs-formats.useStyleDesc',
        type: { kind: 'bool' },
        default: false,
        advanced: true,
        keywords: ['스타일', 'style', 'css', 'smi'],
        order: 26
      },
      {
        id: 'subs-formats.rubyMode',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.rubyLabel',
        descriptionKey: 'subs-formats.rubyDesc',
        type: {
          kind: 'enum',
          options: [
            { value: 'drop', labelKey: 'subs-formats.ruby.drop' },
            { value: 'inline', labelKey: 'subs-formats.ruby.inline' },
            { value: 'above', labelKey: 'subs-formats.ruby.above' }
          ]
        },
        default: 'drop',
        advanced: true,
        keywords: ['루비', '독음', '한자', 'ruby', 'furigana'],
        order: 28
      },
      {
        id: 'subs-formats.exportEncoding',
        section: 'subtitles',
        group: 'encoding',
        labelKey: 'subs-formats.exportEncodingLabel',
        descriptionKey: 'subs-formats.exportEncodingDesc',
        type: {
          kind: 'enum',
          options: [
            { value: 'utf8-bom', labelKey: 'subs-formats.export.utf8' },
            { value: 'cp949', labelKey: 'subs-formats.export.cp949' }
          ]
        },
        default: 'utf8-bom',
        advanced: true,
        keywords: ['저장', 'export', 'save', 'cp949'],
        order: 30
      }
    ])

    currentCodepage = ctx.settings.get<string>('subs-formats.codepage') || DEFAULT_CODEPAGE

    // Spawn-time half of S34. `auto` is mpv's own default, and passing it
    // explicitly costs nothing and makes the value visible in a bug report.
    ctx.mpv.contributeArgs(20, () => [
      `--sub-codepage=${ctx.settings.get<string>('subs-formats.codepage') || DEFAULT_CODEPAGE}`
    ])

    ctx.settings.onChange<string>('subs-formats.codepage', (v) => {
      void applyCodepage(v || DEFAULT_CODEPAGE, false)
    })

    /**
     * S14 lists `subCodepage` among the per-file values to remember, and this is
     * its half: the property is M18's, so the slice is M18's. It stores only the
     * FORCED value — a file left on `auto` stores nothing, so a later change to
     * the global default still reaches it (P51's rule, applied to a slice).
     */
    ctx.perFile.slice({
      key: 'subs-formats',
      capture: () => ({ codepage: currentCodepage }),
      apply: async (v) => {
        const want = typeof v.codepage === 'string' ? v.codepage : DEFAULT_CODEPAGE
        if (want === currentCodepage) return
        await applyCodepage(want, false)
      },
      rememberDefaults: { codepage: true }
    })

    ctx.mpv.afterFileLoaded(() => {
      addedThisFile.clear()
      lastPlan = null
      currentCodepage = ctx.settings.get<string>('subs-formats.codepage') || DEFAULT_CODEPAGE
      if (!ctx.settings.get<boolean>('subs-formats.autoConvert')) return
      void convertPass(false).catch((e) => ctx.log.error('conversion pass failed:', e))
    })

    ctx.ipc.handle<void, FormatsReport>('subs-formats:report', () => report())

    ctx.commands.register([
      {
        id: 'subs-formats.convert',
        labelKey: 'subs-formats.convert',
        category: 'subtitles',
        menuPath: 'subtitles',
        menuOrder: 25,
        enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
        run: () => convertPass(true)
      },
      {
        id: 'subs-formats.cycleCodepage',
        labelKey: 'subs-formats.cycleCodepage',
        category: 'subtitles',
        defaults: { default: ['Alt+KeyC'], potplayer: ['Alt+KeyC'] },
        run: async () => {
          const at = CODEPAGES.findIndex((c) => c.mpv === currentCodepage)
          const next = CODEPAGES[(at + 1) % CODEPAGES.length]
          if (next) await applyCodepage(next.mpv, true)
        }
      },
      {
        id: 'subs-formats.setCodepage',
        labelKey: 'subs-formats.setCodepage',
        category: 'subtitles',
        internal: true,
        run: async (arg) => {
          const want = String(arg ?? DEFAULT_CODEPAGE)
          if (!CODEPAGES.some((c) => c.mpv === want)) {
            ctx.log.warn(`unknown codepage '${want}'`)
            return
          }
          await applyCodepage(want, true)
        }
      },
      {
        /**
         * Mediator for S11. M17 routes a dropped or dialog-opened `.smi`/`.ttml`
         * through here first; the answer is the cache paths to `sub-add`, in the
         * order they should be added (preferred LAST, because `sub-add … select`
         * is the only shape available). Returns an empty array when mpv can load
         * the file itself, which is the common case and the point of the rule
         * "convert only what mpv gets WRONG".
         */
        id: 'subs-formats.prepare',
        labelKey: 'subs-formats.prepare',
        category: 'subtitles',
        internal: true,
        run: (arg) => {
          const file = String(arg ?? '')
          if (file.length === 0 || !isConvertibleExtension(file)) return []
          try {
            const bytes = new Uint8Array(fs.readFileSync(file))
            const plan = planConversion(bytes, file, convertOptions())
            if (plan.outputs.length === 0) return []
            const cacheDir = ctx.paths.subCacheDir()
            fs.mkdirSync(cacheDir, { recursive: true })
            const ordered = [...plan.outputs].sort(
              (a, b) => Number(a.preferred) - Number(b.preferred)
            )
            return ordered.map((o) => {
              const target = path.join(cacheDir, o.fileName)
              if (!fs.existsSync(target)) fs.writeFileSync(target, utf8WithBom(o.text))
              return { path: target, lang: o.lang, title: o.title, preferred: o.preferred }
            })
          } catch (e) {
            ctx.log.warn(`prepare(${file}) failed:`, (e as Error).message)
            return []
          }
        }
      },
      {
        id: 'subs-formats.saveAs',
        labelKey: 'subs-formats.saveAs',
        category: 'subtitles',
        enabledWhen: () => selectedExternalSub() !== null,
        run: () => exportSubtitle('ask')
      },
      {
        id: 'subs-formats.saveBeside',
        labelKey: 'subs-formats.saveBeside',
        category: 'subtitles',
        enabledWhen: () => selectedExternalSub() !== null,
        run: () => exportSubtitle('beside')
      },
      {
        id: 'subs-formats.saveSmi',
        labelKey: 'subs-formats.saveSmi',
        category: 'subtitles',
        enabledWhen: () => selectedExternalSub() !== null,
        run: () => exportSubtitle('smi')
      }
    ])

    ctx.menu.contribute({
      id: 'subs-formats.menu',
      labelKey: 'subs-formats.menuTitle',
      order: 43,
      items: [
        {
          labelKey: 'subs-formats.codepageLabel',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                // Radio group over the ten measured values. `sub-reload` works
                // on external tracks only, so an embedded selection greys the
                // whole group rather than offering a change that does nothing.
                const external = selectedExternalSub() !== null
                return CODEPAGES.map((cp) => ({
                  labelKey: cp.labelKey,
                  commandId: 'subs-formats.setCodepage',
                  arg: cp.mpv,
                  radio: true,
                  checked: cp.mpv === currentCodepage,
                  enabled: external || cp.mpv === currentCodepage
                }))
              }
            }
          ]
        },
        { commandId: 'subs-formats.convert' },
        { type: 'separator' },
        {
          labelKey: 'subs-formats.saveMenu',
          submenu: [
            { commandId: 'subs-formats.saveAs' },
            { commandId: 'subs-formats.saveBeside' },
            { commandId: 'subs-formats.saveSmi' }
          ]
        }
      ]
    })

    ctx.lifecycle.onReady(() => {
      assertUchardet()
      pruneCache()
    })

    ctx.i18n.register('ko', {
      'subs-formats.cp.auto': '자동 감지',
      'subs-formats.cp.cp949': '한국어 (CP949/UHC)',
      'subs-formats.cp.euckr': '한국어 (EUC-KR)',
      'subs-formats.cp.utf8': 'UTF-8',
      'subs-formats.cp.utf16le': 'UTF-16 LE',
      'subs-formats.cp.cp932': '일본어 (CP932)',
      'subs-formats.cp.gb18030': '중국어 간체 (GB18030)',
      'subs-formats.cp.big5': '중국어 번체 (Big5)',
      'subs-formats.cp.cp1252': '서유럽 (CP1252)',
      'subs-formats.cp.cp1251': '키릴 (CP1251)',
      'subs-formats.codepageLabel': '자막 문자 인코딩',
      'subs-formats.codepageDesc':
        '자동 감지는 mpv의 uchardet을 사용합니다. 한글이 깨져 보일 때만 CP949로 고정하세요. 외부 자막 파일에만 적용됩니다.',
      'subs-formats.autoConvertLabel': 'SMI / TTML 자동 변환',
      'subs-formats.autoConvertDesc':
        '한 파일에 두 언어가 들어 있는 SMI(KRCC/ENCC)는 mpv가 한국어 줄을 잃어버립니다. 이 옵션은 언어별 트랙으로 나누고, 머리글이 깨진 SMI를 고쳐서 불러옵니다. 원본 파일은 절대 수정하지 않습니다.',
      'subs-formats.preferredLangsLabel': '선호 자막 언어',
      'subs-formats.preferredLangsDesc': '변환된 트랙 중 무엇을 먼저 선택할지 정합니다.',
      'subs-formats.useStyleLabel': '자막에 지정된 스타일 사용',
      'subs-formats.useStyleDesc':
        'SMI의 <STYLE> 블록에 있는 글꼴과 색을 그대로 씁니다. 대부분의 한국어 SMI는 흰색 기본 글꼴만 지정하므로 보통 켤 필요가 없습니다.',
      'subs-formats.rubyLabel': '한자 독음(루비) 처리',
      'subs-formats.rubyDesc':
        'libass에는 루비 기능이 없어 어떤 방식이든 근사치입니다. 기본값은 독음을 버리고 본문만 남깁니다.',
      'subs-formats.ruby.drop': '독음 버리기 (권장)',
      'subs-formats.ruby.inline': '괄호로 붙이기 — 漢字(한자)',
      'subs-formats.ruby.above': '화면 위쪽에 따로 표시',
      'subs-formats.exportEncodingLabel': 'SMI 저장 인코딩',
      'subs-formats.exportEncodingDesc':
        'UTF-8(BOM)은 어떤 편집기에서도 한글이 깨지지 않습니다. 옛 프로그램과 주고받을 때만 CP949를 쓰세요.',
      'subs-formats.export.utf8': 'UTF-8 (BOM 포함)',
      'subs-formats.export.cp949': 'CP949 (옛 방식)',
      'subs-formats.convert': '자막 형식 변환 다시 시도',
      'subs-formats.cycleCodepage': '자막 인코딩 전환',
      'subs-formats.setCodepage': '자막 인코딩 선택',
      'subs-formats.prepare': '자막 변환 준비',
      'subs-formats.saveAs': '다른 이름으로 자막 저장...',
      'subs-formats.saveBeside': '동영상 이름으로 자막 저장',
      'subs-formats.saveSmi': 'SMI로 자막 저장...',
      'subs-formats.saveMenu': '자막 저장 (싱크 반영)',
      'subs-formats.saveTitle': '자막 저장',
      'subs-formats.menuTitle': '자막 형식 / 인코딩',
      'subs-formats.codepageOsd': '자막 인코딩: {name}',
      'subs-formats.noUchardet':
        '이 mpv 빌드에는 uchardet이 없어 자막 인코딩을 자동으로 감지할 수 없습니다. 한글 자막이 깨질 수 있습니다.',
      'subs-formats.forceCp949': 'CP949로 고정',
      'subs-formats.nothingToDo': '변환할 자막이 없습니다. mpv가 그대로 읽을 수 있는 형식입니다.',
      'subs-formats.toast.split': '{name}: 언어별 자막 {count}개로 나눴습니다',
      'subs-formats.toast.repair': '{name}: 머리글을 고쳐서 불러왔습니다',
      'subs-formats.toast.ttml': '{name}: TTML 자막 {count}개를 변환했습니다',
      'subs-formats.exportNeedsExternal':
        '외부 자막 파일만 저장할 수 있습니다. 내장 자막은 mpv가 전체 내용을 알려주지 않습니다.',
      'subs-formats.exportUnreadable': '{name} 형식은 저장용으로 읽을 수 없습니다.',
      'subs-formats.exportEmpty': '저장할 자막 줄이 없습니다.',
      'subs-formats.exported': '{name} 저장 완료 ({count}줄)',
      'subs-formats.exportLossy': 'CP949로 표현할 수 없는 문자 {count}개를 ?로 바꿨습니다.',
      'subs-formats.reason.native': 'mpv가 그대로 읽을 수 있음',
      'subs-formats.reason.split': '같은 시각에 두 언어가 있어 나눔',
      'subs-formats.reason.collide': '같은 시각에 두 줄이 있어 나눔',
      'subs-formats.reason.repair': '머리글이 규격에 맞지 않아 고침',
      'subs-formats.reason.ttml': 'TTML은 mpv가 읽지 못해 변환',
      'subs-formats.reason.unsupported': '지원하지 않는 형식',
      'subs-formats.reason.notTtml': '타임드 텍스트 문서가 아님',
      'subs-formats.reason.empty': '표시할 자막 줄이 없음',
      'subs-formats.help.detect':
        '한국어 자막은 대부분 CP949(=UHC, Windows-949)로 저장되어 있습니다. mpv에 내장된 uchardet이 이를 자동으로 감지하므로 보통은 아무것도 바꿀 필요가 없습니다. 그래도 한글이 깨져 보이면 위에서 "한국어 (CP949/UHC)"로 고정하세요.',
      'subs-formats.help.convert':
        'SMI 파일 하나에 한국어와 영어가 같은 시각으로 들어 있으면 mpv는 먼저 나오는 줄(보통 한국어)을 잃어버립니다. 자동 변환은 언어별로 나눈 사본을 캐시 폴더에 만들어 트랙으로 추가하고, <SAMI> 머리글이 규격에 맞지 않아 아예 열리지 않던 파일도 고쳐서 불러옵니다. 원본 파일은 어떤 경우에도 수정하지 않습니다.',
      'subs-formats.help.limits':
        '알려진 한계: 변환 후에도 원본 SMI 트랙이 목록에 남아 있습니다(제거는 자막 트랙 모듈의 권한입니다). 변환 대상 파일은 mpv가 아니라 이 프로그램이 직접 인코딩을 추정하므로, 일본어 Shift-JIS 다국어 SMI 등은 위 목록에서 직접 고정해야 할 수 있습니다. 내장(컨테이너 안) 자막은 저장할 수 없습니다.',
      'subs-formats.stats': '자막 형식',
      'subs-formats.stats.codepage': '인코딩 설정',
      'subs-formats.stats.detected': '감지된 인코딩',
      'subs-formats.stats.conversion': '변환',
      'subs-formats.stats.classes': 'SMI 클래스',
      'subs-formats.stats.dups': '겹친 타임스탬프',
      'subs-formats.stats.added': '추가된 트랙'
    })

    ctx.i18n.register('en', {
      'subs-formats.cp.auto': 'Auto-detect',
      'subs-formats.cp.cp949': 'Korean (CP949/UHC)',
      'subs-formats.cp.euckr': 'Korean (EUC-KR)',
      'subs-formats.cp.utf8': 'UTF-8',
      'subs-formats.cp.utf16le': 'UTF-16 LE',
      'subs-formats.cp.cp932': 'Japanese (CP932)',
      'subs-formats.cp.gb18030': 'Chinese Simplified (GB18030)',
      'subs-formats.cp.big5': 'Chinese Traditional (Big5)',
      'subs-formats.cp.cp1252': 'Western European (CP1252)',
      'subs-formats.cp.cp1251': 'Cyrillic (CP1251)',
      'subs-formats.codepageLabel': 'Subtitle character encoding',
      'subs-formats.codepageDesc':
        "Auto-detect uses mpv's uchardet. Force CP949 only when Korean text looks like garbage. External subtitle files only.",
      'subs-formats.autoConvertLabel': 'Convert SMI / TTML automatically',
      'subs-formats.autoConvertDesc':
        'An SMI holding two languages (KRCC/ENCC) loses its Korean line in mpv. This splits it into one track per language and repairs a malformed SMI header. Your file is never modified.',
      'subs-formats.preferredLangsLabel': 'Preferred subtitle languages',
      'subs-formats.preferredLangsDesc': 'Which converted track gets selected first.',
      'subs-formats.useStyleLabel': 'Use the style defined in the subtitle',
      'subs-formats.useStyleDesc':
        "Applies the font and colours from the SMI <STYLE> block. Most Korean SMI files only set a font and white text, so this rarely helps.",
      'subs-formats.rubyLabel': 'Ruby (한자 독음) handling',
      'subs-formats.rubyDesc':
        'libass has no ruby primitive, so every option is an approximation. The default drops the reading and keeps the base line intact.',
      'subs-formats.ruby.drop': 'Drop the reading (recommended)',
      'subs-formats.ruby.inline': 'In brackets — 漢字(한자)',
      'subs-formats.ruby.above': 'On a separate line at the top',
      'subs-formats.exportEncodingLabel': 'SMI export encoding',
      'subs-formats.exportEncodingDesc':
        'UTF-8 with a BOM opens correctly everywhere. Use CP949 only for old tools that need it.',
      'subs-formats.export.utf8': 'UTF-8 (with BOM)',
      'subs-formats.export.cp949': 'CP949 (legacy)',
      'subs-formats.convert': 'Retry subtitle format conversion',
      'subs-formats.cycleCodepage': 'Cycle subtitle encoding',
      'subs-formats.setCodepage': 'Set subtitle encoding',
      'subs-formats.prepare': 'Prepare subtitle conversion',
      'subs-formats.saveAs': 'Save subtitle as...',
      'subs-formats.saveBeside': 'Save subtitle next to the video',
      'subs-formats.saveSmi': 'Save subtitle as SMI...',
      'subs-formats.saveMenu': 'Save subtitle (sync applied)',
      'subs-formats.saveTitle': 'Save subtitle',
      'subs-formats.menuTitle': 'Subtitle format / encoding',
      'subs-formats.codepageOsd': 'Subtitle encoding: {name}',
      'subs-formats.noUchardet':
        'This mpv build has no uchardet, so subtitle encoding cannot be detected automatically. Korean subtitles may be mojibake.',
      'subs-formats.forceCp949': 'Force CP949',
      'subs-formats.nothingToDo': 'Nothing to convert — mpv can read these subtitles as they are.',
      'subs-formats.toast.split': '{name}: split into {count} tracks by language',
      'subs-formats.toast.repair': '{name}: header repaired and loaded',
      'subs-formats.toast.ttml': '{name}: converted {count} TTML track(s)',
      'subs-formats.exportNeedsExternal':
        'Only external subtitle files can be saved: mpv exposes just the current event of an embedded track.',
      'subs-formats.exportUnreadable': 'Cannot read {name} back for export.',
      'subs-formats.exportEmpty': 'There are no subtitle lines to save.',
      'subs-formats.exported': 'Saved {name} ({count} lines)',
      'subs-formats.exportLossy': '{count} character(s) could not be written as CP949 and became ?.',
      'subs-formats.reason.native': 'mpv reads this natively',
      'subs-formats.reason.split': 'two languages share a timestamp',
      'subs-formats.reason.collide': 'two lines share a timestamp',
      'subs-formats.reason.repair': 'the header is not byte-exact',
      'subs-formats.reason.ttml': 'FFmpeg has no TTML demuxer',
      'subs-formats.reason.unsupported': 'unsupported format',
      'subs-formats.reason.notTtml': 'not a timed-text document',
      'subs-formats.reason.empty': 'no renderable lines',
      'subs-formats.help.detect':
        'Korean subtitles are almost always stored as CP949 (= UHC, Windows-949). The uchardet library inside mpv detects that on its own, so normally there is nothing to change here. If Korean text still looks like garbage, pin "Korean (CP949/UHC)" above.',
      'subs-formats.help.convert':
        'When one SMI file holds Korean and English at the same timestamps, mpv loses whichever line comes first — which in Korean releases is the Korean one. Automatic conversion writes one copy per language into the cache folder and adds them as tracks, and it also repairs files whose <SAMI> header is not byte-exact and which therefore would not open at all. Your own file is never modified.',
      'subs-formats.help.limits':
        'Known limits: after conversion the original SMI track is still listed (removing it belongs to the subtitle-track module). Files we convert are decoded by this app rather than by mpv, so an unusual case — a Japanese Shift-JIS multi-language SMI, say — may need the encoding pinned above. Embedded (in-container) subtitles cannot be saved.',
      'subs-formats.stats': 'Subtitle format',
      'subs-formats.stats.codepage': 'Encoding setting',
      'subs-formats.stats.detected': 'Detected encoding',
      'subs-formats.stats.conversion': 'Conversion',
      'subs-formats.stats.classes': 'SMI classes',
      'subs-formats.stats.dups': 'Colliding timestamps',
      'subs-formats.stats.added': 'Tracks added'
    })
  },

  dispose(): void {
    addedThisFile.clear()
    lastPlan = null
  }
}

export default mod
