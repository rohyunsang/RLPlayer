/**
 * M22 capture-still — the DECLARATIVE half: setting descriptors, the C22
 * keybinding table, the menu layout and both message catalogs.
 *
 * WHY THIS IS A SEPARATE FILE, AND IT IS NOT TIDINESS. `index.ts` statically
 * imports `electron` (`app`, `clipboard`, `ClipboardItem`, `nativeImage`,
 * `shell` — C03, C07, C20 and C24 each need one of them) and
 * `../../services/config.ts` for C21's legacy `screenshotDir`. Either import
 * makes the module UNLOADABLE by any test, measured, the same finding M19 wrote
 * up in `subs-style/legacy.ts`:
 *
 *     src/main/mpv/manager.ts:5  import { app } from 'electron'
 *     SyntaxError: The requested module 'electron' does not provide an export
 *                  named 'app'
 *
 * So everything in `index.ts` was unverifiable by construction — including the
 * two things in this module most likely to be quietly wrong and least likely to
 * be noticed: a `labelKey` with no catalog entry (it renders as the raw key), and
 * C22's PotPlayer bindings, which §2.4 says were read out of PotPlayer's own
 * `English.ini` and verified 8/8 and which nothing in the tree asserted.
 *
 * Everything here is a plain value. `manifest.test.ts` loads it with no Electron
 * and no `FeatureContext` and checks it against itself.
 */

import type { CommandDescriptor, PresetName, SettingDescriptor } from '@shared/feature-api'
import {
  BURST_MAX_COUNT,
  BURST_MAX_INTERVAL_MS,
  BURST_MIN_COUNT,
  BURST_MIN_INTERVAL_MS,
  CAPTURE_FORMATS,
  DEFAULT_TEMPLATE,
  RESIZE_MAX_WIDTH
} from './capture.ts'

// ---------------------------------------------------------------------------
// Settings (C05, C06, C07, C21, P59)
// ---------------------------------------------------------------------------

export function descriptors(): SettingDescriptor[] {
  const formats = CAPTURE_FORMATS.map((f) => ({
    value: f,
    labelKey: `capture-still.format.${f}`
  }))
  return [
    {
      id: 'capture-still.directory',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.directoryLabel',
      descriptionKey: 'capture-still.directoryDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      mpvOption: 'screenshot-directory',
      keywords: ['스크린샷', '캡처', 'screenshot', 'capture', 'folder', '폴더'],
      order: 30
    },
    {
      id: 'capture-still.template',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.templateLabel',
      descriptionKey: 'capture-still.templateDesc',
      type: { kind: 'string' },
      default: DEFAULT_TEMPLATE,
      mpvOption: 'screenshot-template',
      keywords: ['파일명', '템플릿', 'template', 'filename'],
      order: 31
    },
    {
      id: 'capture-still.format',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.formatLabel',
      // C06: mpv has no BMP writer. PNG is the lossless offer instead.
      type: { kind: 'enum', options: formats },
      default: 'png',
      mpvOption: 'screenshot-format',
      keywords: ['형식', 'format', 'png', 'jpg', 'webp'],
      order: 32
    },
    {
      id: 'capture-still.jpegQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.jpegQualityLabel',
      type: { kind: 'int', min: 0, max: 100, step: 1 },
      default: 90,
      mpvOption: 'screenshot-jpeg-quality',
      keywords: ['품질', 'quality', 'jpeg'],
      order: 33,
      visibleWhen: (get) => get<string>('capture-still.format') === 'jpg'
    },
    {
      id: 'capture-still.pngCompression',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.pngCompressionLabel',
      type: { kind: 'int', min: 0, max: 9, step: 1 },
      default: 7,
      mpvOption: 'screenshot-png-compression',
      keywords: ['압축', 'compression', 'png'],
      order: 34,
      visibleWhen: (get) => get<string>('capture-still.format') === 'png'
    },
    {
      id: 'capture-still.highBitDepth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.highBitDepthLabel',
      descriptionKey: 'capture-still.highBitDepthDesc',
      type: { kind: 'bool' },
      // C06, MEASURED: mpv defaults this to `yes`, which turned every PNG from
      // an 8-bit H.264 source into a 16-bit 5.37 MB file.
      default: false,
      mpvOption: 'screenshot-high-bit-depth',
      keywords: ['비트', 'bit depth', 'hdr'],
      advanced: true,
      order: 35
    },
    {
      /**
       * C07. `0` is off, which is the default: mpv has no option for this, so
       * every non-zero value costs a read-back and a re-encode of the file mpv
       * just wrote. The minimum is not 0 because a 1-pixel capture is never
       * what anybody meant; `clampResizeWidth` maps 0 to "off" and anything in
       * (0, 64) up to 64.
       */
      id: 'capture-still.resizeWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.resizeWidthLabel',
      descriptionKey: 'capture-still.resizeWidthDesc',
      type: { kind: 'int', min: 0, max: RESIZE_MAX_WIDTH, step: 16 },
      default: 0,
      keywords: ['크기', '너비', 'width', 'resize', 'scale'],
      advanced: true,
      order: 36
    },
    {
      id: 'capture-still.includeSubs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.includeSubsLabel',
      type: { kind: 'bool' },
      default: true,
      keywords: ['자막', 'subtitles'],
      order: 37
    },
    {
      id: 'capture-still.useDisplayResolution',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.useDisplayResolutionLabel',
      descriptionKey: 'capture-still.useDisplayResolutionDesc',
      type: { kind: 'bool' },
      default: false,
      keywords: ['해상도', 'resolution', 'display', 'scaled'],
      order: 38
    },
    {
      id: 'capture-still.burstCount',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstCountLabel',
      type: { kind: 'int', min: BURST_MIN_COUNT, max: BURST_MAX_COUNT, step: 1 },
      default: 10,
      keywords: ['연속', 'burst', 'consecutive', '장수'],
      order: 39
    },
    {
      id: 'capture-still.burstIntervalMs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstIntervalLabel',
      type: {
        kind: 'int',
        min: BURST_MIN_INTERVAL_MS,
        max: BURST_MAX_INTERVAL_MS,
        step: 100
      },
      default: 1000,
      keywords: ['간격', 'interval', 'burst'],
      order: 40
    },
    {
      id: 'capture-still.burstMode',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstModeLabel',
      descriptionKey: 'capture-still.burstModeDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'time', labelKey: 'capture-still.burstMode.time' },
          { value: 'frame', labelKey: 'capture-still.burstMode.frame' }
        ]
      },
      default: 'time',
      keywords: ['연속', 'burst', 'frame', '프레임'],
      order: 41
    }
  ]
}

// ---------------------------------------------------------------------------
// C22 — the keybinding table
// ---------------------------------------------------------------------------

/**
 * Per-preset defaults, split out so they can be asserted.
 *
 * §2.4 C22 is settled: the `potplayer` column was read out of PotPlayer's own
 * shipped `English.ini` `[MenuString]` table and is **8/8 correct**, of which
 * five keys are M22's (the other three — `Alt+N` thumbnail sheet, `Alt+C` record
 * video, `Shift+G` record audio — are M23's). The structural point worth keeping
 * is that the matrix is {source frame, screen frame} × {save, clipboard}: users
 * find the fourth key by pattern, so all four must exist and must differ only in
 * the modifier.
 *
 * Note what is deliberately NOT here: PotPlayer's `S` is the Pixel Shaders menu,
 * not a screenshot, so `KeyS` appears only in the `default` and `mpv` columns.
 */
export const CAPTURE_KEYS: Record<string, Partial<Record<PresetName, readonly string[]>>> = {
  save: { default: ['KeyS'], potplayer: ['Ctrl+KeyE'], mpv: ['KeyS'] },
  saveNoSubs: { default: ['Shift+KeyS'], mpv: ['Shift+KeyS'] },
  toClipboard: { default: ['Ctrl+KeyS'], potplayer: ['Ctrl+KeyC'], mpv: ['Ctrl+KeyS'] },
  saveDisplay: { default: ['Ctrl+Shift+KeyS'], potplayer: ['Ctrl+Alt+KeyE'] },
  displayToClipboard: { default: ['Ctrl+Alt+KeyC'], potplayer: ['Ctrl+Alt+KeyC'] },
  burstToggle: { default: ['Ctrl+KeyG'], potplayer: ['Ctrl+KeyG'] },
  deleteLast: { default: ['Ctrl+Shift+Delete'] },
  openFolder: {}
}

/** Every command this module registers, in the order they are declared. */
export const COMMAND_VERBS: readonly string[] = Object.keys(CAPTURE_KEYS)

export function commandId(verb: string): string {
  return `capture-still.${verb}`
}

// ---------------------------------------------------------------------------
// C23 — the capture submenu
// ---------------------------------------------------------------------------

/**
 * The submenu's contents, as verbs plus separators.
 *
 * A titled SUBMENU rather than the eight items flattened into the context menu's
 * root, and that shape is forced: `core/menu.ts` renders a contributed section
 * as a bare block of its `items` separated by separators and NEVER draws the
 * section's own `labelKey` (read `buildTemplate()` — `section.labelKey` is not
 * referenced once). So the only way to get a title is an item that owns a
 * submenu, which is what `menuPath`'s own boot error also tells you when it says
 * "a submenu needs a title … use ctx.menu.contribute({ labelKey … })".
 *
 * `menuOrder` under the fixed `capture` root was the alternative and it renders
 * FLAT, which C23 does not ask for.
 */
export type MenuEntry = { separator: true } | { verb: string }

export const MENU_ENTRIES: readonly MenuEntry[] = [
  { verb: 'save' },
  { verb: 'saveNoSubs' },
  { verb: 'toClipboard' },
  { separator: true },
  { verb: 'saveDisplay' },
  { verb: 'displayToClipboard' },
  { separator: true },
  { verb: 'burstToggle' },
  { separator: true },
  { verb: 'openFolder' },
  { verb: 'deleteLast' }
]

/**
 * The contributed section's order.
 *
 * 60 by agreement with M23, which documents 62 for its own encode section
 * ("M22 capture-still holds 60"). It is also the `capture` root's base order in
 * `MENU_ROOTS`, which is deliberate — a `menuPath: 'capture'` command from any
 * module lands in the same band — and it is the one ordering namespace with NO
 * tie check, because `core/menu.ts` merges contributed sections and menuPath
 * groups into one `blocks` array and only sections are checked against each
 * other. Reported rather than worked around.
 */
export const MENU_ORDER = 60

/** Static metadata for every command; `run`/`enabledWhen` are wired in index.ts. */
export type CommandMeta = Pick<CommandDescriptor, 'id' | 'labelKey' | 'category' | 'defaults'>

export function commandMeta(verb: string): CommandMeta {
  return {
    id: commandId(verb),
    labelKey: commandId(verb),
    category: 'capture',
    defaults: CAPTURE_KEYS[verb] ?? {}
  }
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

export const KO: Record<string, string> = {

    'capture-still.menuTitle': '캡처',
    'capture-still.save': '현재 프레임 저장',
    'capture-still.saveNoSubs': '자막 없이 프레임 저장',
    'capture-still.toClipboard': '현재 프레임 클립보드 복사',
    'capture-still.saveDisplay': '화면 해상도로 저장',
    'capture-still.displayToClipboard': '화면 해상도로 클립보드 복사',
    'capture-still.burstToggle': '연속 캡처 시작/중지',
    'capture-still.burstProgress': '연속 캡처',
    'capture-still.deleteLast': '마지막 캡처 삭제',
    'capture-still.openFolder': '폴더 열기',
    'capture-still.saved': '{name}{을/를} 저장했습니다',
    'capture-still.savedFallback': '{name}{을/를} 저장했습니다 (화면 해상도를 쓸 수 없어 원본 해상도로 저장)',
    'capture-still.copied': '현재 프레임을 클립보드에 복사했습니다',
    'capture-still.failed': '캡처에 실패했습니다',
    'capture-still.relativeReply':
      '캡처 파일 경로를 확인할 수 없습니다. 저장 폴더 설정을 확인하세요.',
    'capture-still.burstStarted': '연속 캡처 {n}장 시작',
    'capture-still.burstDone': '연속 캡처 {n}장 완료',
    'capture-still.burstStopped': '연속 캡처 중지 ({n}장 저장)',
    'capture-still.burstNeedsPause': '프레임 단위 연속 캡처는 일시정지 상태에서만 됩니다',
    'capture-still.deleted': '{name}{을/를} 휴지통으로 보냈습니다',
    'capture-still.deleteFailed': '삭제하지 못했습니다',
    'capture-still.nothingToDelete': '삭제할 캡처가 없습니다',
    'capture-still.directoryLabel': '캡처 저장 폴더',
    'capture-still.directoryDesc':
      '비워 두면 사진 폴더의 RLPlayer (휴대용 모드에서는 exe 옆의 Capture) 를 씁니다.',
    'capture-still.templateLabel': '파일명 템플릿',
    'capture-still.templateDesc':
      '%F 파일명 · %wH.%wM.%wS.%wT 재생 위치(ms) · %#02n 일련번호. %p 와 %P 는 콜론을 포함해 밑줄로 바뀝니다.',
    'capture-still.formatLabel': '이미지 형식',
    'capture-still.format.png': 'PNG (무손실)',
    'capture-still.format.jpg': 'JPEG',
    'capture-still.format.webp': 'WebP',
    'capture-still.format.jxl': 'JPEG XL',
    'capture-still.format.avif': 'AVIF',
    'capture-still.jpegQualityLabel': 'JPEG 품질',
    'capture-still.pngCompressionLabel': 'PNG 압축 수준',
    'capture-still.highBitDepthLabel': '고비트 심도로 저장',
    'capture-still.highBitDepthDesc':
      '8비트 영상에서도 16비트 PNG를 만들어 파일이 5배 커집니다. 10비트/HDR 원본에만 켜세요.',
    'capture-still.resizeWidthLabel': '캡처 가로 크기 (0 = 원본)',
    'capture-still.resizeWidthDesc': '0 이 아니면 저장 후 이 너비로 다시 인코딩합니다. PNG 와 JPEG 만 가능합니다.',
    'capture-still.savedResized': '{name}{을/를} {w}px 로 저장했습니다',
    'capture-still.resizeUnsupported': '이 형식은 크기를 바꿀 수 없어 원본 크기로 저장했습니다 (PNG/JPEG 만 가능)',
    'capture-still.includeSubsLabel': '자막 포함',
    'capture-still.useDisplayResolutionLabel': '화면 해상도로 캡처',
    'capture-still.useDisplayResolutionDesc':
      '원본 대신 지금 보이는 크기로 저장합니다. 영상 창이 없으면 원본 해상도로 대체됩니다.',
    'capture-still.burstCountLabel': '연속 캡처 장수',
    'capture-still.burstIntervalLabel': '연속 캡처 간격 (ms)',
    'capture-still.burstModeLabel': '연속 캡처 방식',
    'capture-still.burstModeDesc': '프레임 단위는 일시정지 상태에서만 동작합니다.',
    'capture-still.burstMode.time': '시간 간격',
    'capture-still.burstMode.frame': '프레임 단위',
    'capture-still.warn.colon-specifier': '%p / %P 는 콜론을 포함해 밑줄로 바뀝니다',
    'capture-still.warn.illegal-literal': '파일명에 쓸 수 없는 문자가 있습니다',
    'capture-still.warn.no-disambiguator':
      '%n 이나 %wT 가 없어 같은 초에 찍은 캡처가 저장되지 않습니다 — 일련번호를 붙였습니다',
    'capture-still.transportButton': '캡처 (Shift 클릭: 클립보드, Ctrl 클릭: 연속)',
    'capture-still.templateHelp': '파일명 템플릿 지시자',
    'capture-still.legend.F': '확장자 없는 파일명',
    'capture-still.legend.f': '확장자를 포함한 파일명',
    'capture-still.legend.pos': '재생 위치 — 시/분/초/밀리초',
    'capture-still.legend.n': '일련번호 (두 자리, 0 채움)',
    'capture-still.legend.date': '오늘 날짜',
    'capture-still.legend.prop': 'mpv 속성 값 (예: 제목)',
    'capture-still.legend.percent': '% 문자 그대로',
    'capture-still.legend.note':
      '%p 와 %P 는 콜론을 포함하므로 Windows 에서 밑줄로 바뀝니다. %n 이나 %wT 가 없으면 같은 이름의 파일을 덮어쓰지 않고 저장이 조용히 실패하므로, 자동으로 일련번호를 붙입니다.'
}

export const EN: Record<string, string> = {

    'capture-still.menuTitle': 'Capture',
    'capture-still.save': 'Save current frame',
    'capture-still.saveNoSubs': 'Save frame without subtitles',
    'capture-still.toClipboard': 'Copy current frame',
    'capture-still.saveDisplay': 'Save at display resolution',
    'capture-still.displayToClipboard': 'Copy at display resolution',
    'capture-still.burstToggle': 'Start/stop consecutive capture',
    'capture-still.burstProgress': 'Consecutive capture',
    'capture-still.deleteLast': 'Delete last capture',
    'capture-still.openFolder': 'Open folder',
    'capture-still.saved': 'Saved {name}',
    'capture-still.savedFallback': 'Saved {name} (no display surface — used source resolution)',
    'capture-still.copied': 'Frame copied to the clipboard',
    'capture-still.failed': 'Capture failed',
    'capture-still.relativeReply':
      'mpv reported a relative capture path; check the capture folder setting.',
    'capture-still.burstStarted': 'Consecutive capture: {n} frames',
    'capture-still.burstDone': 'Consecutive capture finished ({n} frames)',
    'capture-still.burstStopped': 'Consecutive capture stopped ({n} frames saved)',
    'capture-still.burstNeedsPause': 'Frame-by-frame capture needs the player paused',
    'capture-still.deleted': 'Moved {name} to the Recycle Bin',
    'capture-still.deleteFailed': 'Could not delete the file',
    'capture-still.nothingToDelete': 'No capture from this session to delete',
    'capture-still.directoryLabel': 'Capture folder',
    'capture-still.directoryDesc':
      'Leave empty for Pictures\\RLPlayer (or Capture beside the exe in portable mode).',
    'capture-still.templateLabel': 'Filename template',
    'capture-still.templateDesc':
      '%F filename · %wH.%wM.%wS.%wT position with ms · %#02n counter. %p and %P expand with colons, which Windows turns into underscores.',
    'capture-still.formatLabel': 'Image format',
    'capture-still.format.png': 'PNG (lossless)',
    'capture-still.format.jpg': 'JPEG',
    'capture-still.format.webp': 'WebP',
    'capture-still.format.jxl': 'JPEG XL',
    'capture-still.format.avif': 'AVIF',
    'capture-still.jpegQualityLabel': 'JPEG quality',
    'capture-still.pngCompressionLabel': 'PNG compression',
    'capture-still.highBitDepthLabel': 'Save at high bit depth',
    'capture-still.highBitDepthDesc':
      'Writes 16-bit PNGs even from 8-bit video, roughly 5x the file size. Only for 10-bit/HDR sources.',
    'capture-still.resizeWidthLabel': 'Capture width (0 = source)',
    'capture-still.resizeWidthDesc': 'Non-zero re-encodes each capture at this width after saving. PNG and JPEG only.',
    'capture-still.savedResized': 'Saved {name} at {w}px',
    'capture-still.resizeUnsupported': 'This format cannot be resized, so the capture was kept at full size (PNG/JPEG only)',
    'capture-still.includeSubsLabel': 'Include subtitles',
    'capture-still.useDisplayResolutionLabel': 'Capture at display resolution',
    'capture-still.useDisplayResolutionDesc':
      'Saves what is on screen instead of the source frame. Falls back to source resolution when there is no video window.',
    'capture-still.burstCountLabel': 'Consecutive capture: frames',
    'capture-still.burstIntervalLabel': 'Consecutive capture: interval (ms)',
    'capture-still.burstModeLabel': 'Consecutive capture mode',
    'capture-still.burstModeDesc': 'Frame-by-frame only works while paused.',
    'capture-still.burstMode.time': 'Time interval',
    'capture-still.burstMode.frame': 'Frame by frame',
    'capture-still.warn.colon-specifier': '%p / %P expand with colons and become underscores',
    'capture-still.warn.illegal-literal': 'The template contains characters Windows rejects',
    'capture-still.warn.no-disambiguator':
      'No %n or %wT: mpv will not overwrite, so a second capture in the same second would be lost — a counter was appended',
    'capture-still.transportButton': 'Capture (Shift-click: clipboard, Ctrl-click: burst)',
    'capture-still.templateHelp': 'Filename template specifiers',
    'capture-still.legend.F': 'Filename without extension',
    'capture-still.legend.f': 'Filename with extension',
    'capture-still.legend.pos': 'Playback position — h/m/s/ms',
    'capture-still.legend.n': 'Counter (two digits, zero padded)',
    'capture-still.legend.date': 'Today’s date',
    'capture-still.legend.prop': 'An mpv property, e.g. the title',
    'capture-still.legend.percent': 'A literal percent sign',
    'capture-still.legend.note':
      '%p and %P expand with colons, which Windows turns into underscores. Without %n or %wT mpv refuses to overwrite and the capture silently does not happen, so a counter is appended for you.'
}
