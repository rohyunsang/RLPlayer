/**
 * M23 capture-encode — every DECLARATION, in a file with no Electron in it.
 *
 * WHY IT IS SPLIT OUT. `index.ts` imports `electron` for `app.getPath()` and
 * `shell.showItemInFolder()`, which makes it unloadable under `node --test`
 * (§13: "keep the logic you want to test free of Electron imports"). The
 * settings descriptors and the two message catalogs are pure data, and they are
 * where a whole class of user-visible defect lives — a `labelKey` with no
 * catalog entry renders as the raw key, and a Korean catalog missing a key the
 * English one has renders as English in the middle of a Korean sentence. Neither
 * is caught by a typecheck and neither is visible in review of a 500-line
 * object. `declarations.test.ts` asserts both, in both directions.
 */
import type { SettingDescriptor } from '@shared/feature-api'
import { AUDIO_FORMATS, CLIP_PRESETS, GIF_DITHERS } from './encode-args.ts'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const enumOptions = <T extends { id: string }>(
  rows: readonly T[],
  prefix: string
): ReadonlyArray<{ value: string; labelKey: string }> =>
  rows.map((r) => ({ value: r.id, labelKey: `capture-encode.${prefix}.${r.id}` }))

export function descriptors(): SettingDescriptor[] {
  return [
    {
      id: 'capture-encode.videoDir',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.videoDirLabel',
      descriptionKey: 'capture-encode.videoDirDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      keywords: ['내보내기', '클립', 'export', 'clip', 'folder'],
      order: 40
    },
    {
      id: 'capture-encode.audioDir',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.audioDirLabel',
      descriptionKey: 'capture-encode.audioDirDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      keywords: ['음원 추출', 'audio', 'extract', 'folder'],
      order: 41
    },
    {
      id: 'capture-encode.clipPreset',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipPresetLabel',
      descriptionKey: 'capture-encode.clipPresetDesc',
      type: { kind: 'enum', options: enumOptions(CLIP_PRESETS, 'preset') },
      default: 'h264-mp4',
      keywords: ['코덱', 'codec', 'x264', 'x265', 'vp9', 'av1', 'nvenc'],
      order: 42
    },
    {
      id: 'capture-encode.clipQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipQualityLabel',
      descriptionKey: 'capture-encode.clipQualityDesc',
      type: { kind: 'int', min: 0, max: 51, step: 1 },
      default: 20,
      keywords: ['crf', '품질', 'quality'],
      order: 43
    },
    {
      id: 'capture-encode.clipWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipWidthLabel',
      descriptionKey: 'capture-encode.clipWidthDesc',
      type: { kind: 'int', min: 0, max: 3840, step: 2 },
      default: 0,
      advanced: true,
      keywords: ['해상도', 'resolution', 'scale'],
      order: 44
    },
    {
      id: 'capture-encode.burnSubs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burnSubsLabel',
      descriptionKey: 'capture-encode.burnSubsDesc',
      type: { kind: 'bool' },
      default: true,
      keywords: ['자막', 'subtitle', 'burn'],
      order: 45
    },
    {
      id: 'capture-encode.audioFormat',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.audioFormatLabel',
      type: { kind: 'enum', options: enumOptions(AUDIO_FORMATS, 'audio') },
      default: 'mp3',
      keywords: ['mp3', 'flac', 'wav', 'opus', 'm4a'],
      order: 46
    },
    {
      id: 'capture-encode.gifFps',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifFpsLabel',
      type: { kind: 'int', min: 5, max: 30, step: 1 },
      default: 15,
      keywords: ['gif', 'fps'],
      order: 47
    },
    {
      id: 'capture-encode.gifWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifWidthLabel',
      type: { kind: 'int', min: 160, max: 960, step: 16 },
      default: 480,
      keywords: ['gif', 'width', '너비'],
      order: 48
    },
    {
      id: 'capture-encode.gifColors',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifColorsLabel',
      descriptionKey: 'capture-encode.gifColorsDesc',
      type: { kind: 'int', min: 32, max: 256, step: 16 },
      default: 192,
      advanced: true,
      keywords: ['gif', 'palette', '팔레트'],
      order: 49
    },
    {
      id: 'capture-encode.gifDither',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifDitherLabel',
      type: {
        kind: 'enum',
        options: GIF_DITHERS.map((d) => ({ value: d, labelKey: `capture-encode.dither.${d}` }))
      },
      default: 'sierra2_4a',
      advanced: true,
      keywords: ['gif', 'dither', '디더링'],
      order: 50
    },
    {
      id: 'capture-encode.gifMaxSeconds',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifMaxSecondsLabel',
      descriptionKey: 'capture-encode.gifMaxSecondsDesc',
      type: { kind: 'int', min: 1, max: 60, step: 1 },
      default: 15,
      keywords: ['gif', 'duration', '길이'],
      order: 51
    },
    {
      id: 'capture-encode.webpQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.webpQualityLabel',
      type: { kind: 'int', min: 0, max: 100, step: 5 },
      default: 75,
      advanced: true,
      keywords: ['webp', 'quality'],
      order: 52
    },
    {
      id: 'capture-encode.burstFormat',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstFormatLabel',
      type: {
        kind: 'enum',
        options: [
          { value: 'png', labelKey: 'capture-encode.burstFormat.png' },
          { value: 'jpg', labelKey: 'capture-encode.burstFormat.jpg' }
        ]
      },
      default: 'png',
      keywords: ['연속 캡처', 'burst', 'png', 'jpg'],
      order: 53
    },
    {
      id: 'capture-encode.burstIntervalSec',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstIntervalLabel',
      type: { kind: 'float', min: 0.2, max: 300, step: 0.2 },
      default: 5,
      keywords: ['간격', 'interval', 'burst'],
      order: 54
    },
    {
      id: 'capture-encode.burstWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstWidthLabel',
      type: { kind: 'int', min: 160, max: 3840, step: 16 },
      default: 1280,
      advanced: true,
      keywords: ['burst', 'width'],
      order: 55
    },
    {
      id: 'capture-encode.burstJpegQscale',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstJpegQscaleLabel',
      descriptionKey: 'capture-encode.burstJpegQscaleDesc',
      type: { kind: 'int', min: 2, max: 31, step: 1 },
      default: 3,
      advanced: true,
      mpvOption: 'ovcopts=global_quality',
      keywords: ['jpeg', 'qscale', '품질'],
      order: 56
    },
    {
      id: 'capture-encode.sheetCols',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetColsLabel',
      type: { kind: 'int', min: 2, max: 8, step: 1 },
      default: 4,
      keywords: ['thumbnail', '장면', 'sheet', 'grid'],
      order: 57
    },
    {
      id: 'capture-encode.sheetRows',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetRowsLabel',
      type: { kind: 'int', min: 2, max: 12, step: 1 },
      default: 5,
      keywords: ['thumbnail', 'sheet', 'grid'],
      order: 58
    },
    {
      id: 'capture-encode.sheetTileWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetTileWidthLabel',
      descriptionKey: 'capture-encode.sheetTileWidthDesc',
      type: { kind: 'int', min: 160, max: 640, step: 16 },
      default: 320,
      advanced: true,
      keywords: ['sheet', 'tile'],
      order: 59
    },
    {
      id: 'capture-encode.maxConcurrent',
      section: 'advanced',
      group: 'capture',
      labelKey: 'capture-encode.maxConcurrentLabel',
      descriptionKey: 'capture-encode.maxConcurrentDesc',
      type: { kind: 'int', min: 1, max: 2, step: 1 },
      default: 1,
      advanced: true,
      keywords: ['동시', 'queue', 'concurrent'],
      order: 60
    },
    {
      id: 'capture-encode.streamRecordExt',
      section: 'advanced',
      group: 'capture',
      labelKey: 'capture-encode.streamRecordExtLabel',
      descriptionKey: 'capture-encode.streamRecordExtDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'mkv', labelKey: 'capture-encode.rec.mkv' },
          { value: 'ts', labelKey: 'capture-encode.rec.ts' },
          { value: 'mp4', labelKey: 'capture-encode.rec.mp4' }
        ]
      },
      default: 'mkv',
      advanced: true,
      mpvOption: 'stream-record',
      keywords: ['녹화', 'record', 'stream'],
      order: 61
    }
  ]
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

export const KO: Record<string, string> = {
  'capture-encode.videoDirLabel': '클립·GIF 저장 폴더',
  'capture-encode.videoDirDesc':
    '비워 두면 원본 파일과 같은 폴더에 저장합니다. 쓸 수 없으면 비디오\\RLPlayer(휴대용 모드에서는 exe 옆의 Export)를 씁니다.',
  'capture-encode.audioDirLabel': '추출한 소리 저장 폴더',
  'capture-encode.audioDirDesc': '비워 두면 원본 파일과 같은 폴더, 그다음 음악\\RLPlayer 순서입니다.',
  'capture-encode.clipPresetLabel': '클립 내보내기 프리셋',
  'capture-encode.clipPresetDesc':
    'GPU 프리셋은 쓰기 전에 실제로 초기화되는지 한 번 검사하고, 실패하면 libx264로 되돌립니다. 같은 비트레이트에서 화질은 libx264가 더 좋습니다.',
  'capture-encode.clipQualityLabel': '클립 품질 (낮을수록 고화질)',
  'capture-encode.clipQualityDesc':
    'crf·cq·global_quality·qp 가운데 그 인코더가 쓰는 이름으로 전달됩니다. 20 전후가 눈에 거슬리지 않는 범위입니다.',
  'capture-encode.clipWidthLabel': '클립 가로 크기 (0 = 원본)',
  'capture-encode.clipWidthDesc': '세로는 비율을 맞춰 짝수로 자동 계산합니다.',
  'capture-encode.burnSubsLabel': '자막을 영상에 새겨 넣기',
  'capture-encode.burnSubsDesc':
    '인코딩 모드에는 자막 트랙을 담는 기능이 없습니다. 새겨 넣기 아니면 없음, 둘 중 하나입니다.',
  'capture-encode.audioFormatLabel': '소리 추출 형식',
  'capture-encode.gifFpsLabel': 'GIF·WebP 초당 프레임',
  'capture-encode.gifWidthLabel': 'GIF·WebP 가로 크기',
  'capture-encode.gifColorsLabel': 'GIF 팔레트 색 수',
  'capture-encode.gifColorsDesc': '한 번의 패스로 팔레트를 만들고 바로 적용합니다.',
  'capture-encode.gifDitherLabel': 'GIF 디더링',
  'capture-encode.gifMaxSecondsLabel': 'GIF 최대 길이 (초)',
  'capture-encode.gifMaxSecondsDesc':
    'A-B 구간이 없으면 현재 위치에서 이 길이만큼 만듭니다. 480픽셀 15fps에서 2초가 약 2.8MB입니다.',
  'capture-encode.webpQualityLabel': 'WebP 품질',
  'capture-encode.burstFormatLabel': '연속 캡처 형식',
  'capture-encode.burstIntervalLabel': '연속 캡처 간격 (초)',
  'capture-encode.burstWidthLabel': '연속 캡처 가로 크기',
  'capture-encode.burstJpegQscaleLabel': 'JPEG 품질 (2 = 최고)',
  'capture-encode.burstJpegQscaleDesc': 'libavcodec 단위로 환산해 넘깁니다 (q × 118).',
  'capture-encode.sheetColsLabel': '장면 모아보기 열 수',
  'capture-encode.sheetRowsLabel': '장면 모아보기 행 수',
  'capture-encode.sheetTileWidthLabel': '장면 모아보기 칸 너비',
  'capture-encode.sheetTileWidthDesc':
    '이 빌드에서는 칸마다 시간을 찍지 못합니다. drawtext에 필요한 글꼴 경로를 필터 그래프에 넣을 방법이 없습니다.',
  'capture-encode.maxConcurrentLabel': '동시에 처리할 작업 수',
  'capture-encode.maxConcurrentDesc':
    '1을 권합니다. libx265·libsvtav1은 모든 코어를 다 쓰기 때문에 재생이 끊길 수 있습니다.',
  'capture-encode.streamRecordExtLabel': '스트림 녹화 컨테이너',
  'capture-encode.streamRecordExtDesc':
    '입력과 같은 컨테이너를 써야 하는 경우가 많습니다. 녹화 중 탐색하거나 트랙을 바꾸면 녹화가 끊기거나 파일이 깨질 수 있습니다.',

  'capture-encode.preset.h264-mp4': 'H.264 MP4 (호환성)',
  'capture-encode.preset.hevc-mkv': 'HEVC MKV (용량 절약)',
  'capture-encode.preset.vp9-webm': 'VP9 WebM',
  'capture-encode.preset.av1-mkv': 'AV1 MKV (느림)',
  'capture-encode.preset.nvenc-mp4': '빠름 (NVIDIA GPU)',
  'capture-encode.preset.qsv-mp4': '빠름 (Intel GPU)',
  'capture-encode.preset.amf-mp4': '빠름 (AMD GPU)',
  'capture-encode.preset.mf-mp4': '빠름 (Windows 공용)',
  'capture-encode.audio.mp3': 'MP3 192kbps',
  'capture-encode.audio.wav': 'WAV (무손실, 큼)',
  'capture-encode.audio.flac': 'FLAC (무손실)',
  'capture-encode.audio.opus': 'Opus',
  'capture-encode.audio.m4a': 'M4A (AAC)',
  'capture-encode.audio.mka': 'MKA (FLAC)',
  'capture-encode.dither.sierra2_4a': 'Sierra2 4A (기본)',
  'capture-encode.dither.sierra2': 'Sierra2',
  'capture-encode.dither.floyd_steinberg': 'Floyd–Steinberg',
  'capture-encode.dither.bayer': 'Bayer',
  'capture-encode.dither.none': '없음',
  'capture-encode.burstFormat.png': 'PNG (무손실)',
  'capture-encode.burstFormat.jpg': 'JPEG (작음)',
  'capture-encode.rec.mkv': 'MKV',
  'capture-encode.rec.ts': 'TS',
  'capture-encode.rec.mp4': 'MP4',

  'capture-encode.exportClip': '구간 클립 내보내기',
  'capture-encode.extractAudio': '구간 소리 추출',
  'capture-encode.exportGif': 'GIF 만들기',
  'capture-encode.exportWebp': '움직이는 WebP 만들기',
  'capture-encode.burstFrames': '연속 이미지 저장 (빠른 일괄)',
  'capture-encode.contactSheet': '장면 모아보기 이미지',
  'capture-encode.losslessCut': '빠른 무손실 잘라내기 (경계 대략)',
  'capture-encode.stopCacheDump': '캐시 기록 멈추기',
  'capture-encode.toggleStreamRecord': '스트림 녹화 켜기/끄기',
  'capture-encode.cancel': '취소',
  'capture-encode.cancelAll': '진행 중인 내보내기 모두 취소',
  'capture-encode.menuTitle': '내보내기',

  'capture-encode.jobRunning': '내보내는 중',
  'capture-encode.started': '{label} 시작 — {detail}',
  'capture-encode.finished': '{name}{을/를} 저장했습니다',
  'capture-encode.openFolder': '폴더 열기',
  'capture-encode.cancelled': '{label}{을/를} 취소했습니다',
  'capture-encode.failed': '{label} 실패: {reason}',
  'capture-encode.needLocalFile': '로컬 파일을 재생하는 중에만 쓸 수 있습니다',
  'capture-encode.needRange': '먼저 A-B 구간을 지정하거나 파일 길이를 확인해 주세요',
  'capture-encode.hwFellBack': 'GPU 인코더를 쓸 수 없어 libx264로 진행합니다',
  'capture-encode.gifTooLong': 'GIF는 {cap}초까지만 만듭니다. A-B 구간을 줄여 주세요',
  'capture-encode.gifEstimate': '예상 약 {mb}MB',
  'capture-encode.cacheTooSmall':
    '무손실 잘라내기는 큰 디먹서 캐시가 필요합니다 (현재 {mb}MB). 스트림 캐시 설정은 이 모듈이 정할 수 없습니다',
  'capture-encode.cutWorking': '캐시에서 잘라내는 중 — 잠시 재생이 멈출 수 있습니다',
  'capture-encode.cutEmpty': '캐시에 담긴 구간이 없어 빈 파일이 나왔습니다',
  'capture-encode.cutStopped': '캐시 기록을 멈췄습니다',
  'capture-encode.recNeedsStream': '스트림 녹화는 네트워크 원본에서만 동작합니다',
  'capture-encode.recStarted': '{name}{으로/로} 녹화를 시작했습니다',
  'capture-encode.recStopped': '녹화를 멈췄습니다 — {name}',
  'capture-encode.noJobs': '진행 중인 작업이 없습니다',
  'capture-encode.burstTooMany':
    '이 설정이면 파일 {frames}개가 만들어집니다 (최대 {max}개). A-B 구간을 지정하거나 간격을 늘려 주세요',
  // The renderer half's strings (panel, transport button, settings prose).
  'capture-encode.showJobs': '내보내기 작업 목록 보기',
  'capture-encode.panelTitle': '내보내기 작업',
  'capture-encode.transportButton': '내보내기 작업 목록',
  'capture-encode.jobsEmpty': '진행 중인 작업이 없습니다. 아래에서 바로 시작할 수 있습니다.',
  'capture-encode.cancelJob': '이 작업 취소',
  'capture-encode.quickActions': '바로 시작',
  'capture-encode.state.queued': '대기 중',
  'capture-encode.state.running': '진행 중',
  'capture-encode.state.done': '완료',
  'capture-encode.state.failed': '실패',
  'capture-encode.state.cancelled': '취소됨',
  'capture-encode.limitsTitle': '내보내기가 할 수 있는 것과 못 하는 것',
  'capture-encode.limits.ffmpeg':
    '모든 내보내기는 이미 들어 있는 mpv를 인코딩 모드로 한 번 더 띄워서 처리합니다. ffmpeg를 따로 담지 않으므로 설치 용량은 늘지 않습니다.',
  'capture-encode.limits.subs':
    '자막은 영상에 새겨 넣는 방식만 됩니다. 인코딩 모드에는 자막 트랙을 담는 기능이 없습니다.',
  'capture-encode.limits.sheet':
    '장면 모아보기에는 칸마다 시간을 찍지 못합니다. drawtext에 글꼴 파일 경로가 필요한데, 필터 그래프에 윈도우 절대 경로를 넣을 수 없습니다.',
  'capture-encode.limits.hw':
    'GPU 인코더는 쓰기 전에 한 번 검사합니다. 초기화에 실패하면 조용히 libx264로 되돌립니다.',
  'capture-encode.limits.cut':
    '빠른 무손실 잘라내기는 디먹서 캐시에 담긴 부분만 잘라낼 수 있고, 경계는 키프레임에 맞춰집니다.',
  'capture-encode.limits.stream':
    '스트림 녹화는 네트워크 원본에서만 동작합니다. 로컬 파일에서는 mpv가 아무것도 쓰지 않습니다.'
}

export const EN: Record<string, string> = {
  'capture-encode.videoDirLabel': 'Clip and GIF folder',
  'capture-encode.videoDirDesc':
    "Empty means beside the source file. If that is not writable, Videos\\RLPlayer (or Export beside the exe in portable mode).",
  'capture-encode.audioDirLabel': 'Extracted audio folder',
  'capture-encode.audioDirDesc': 'Empty means beside the source file, then Music\\RLPlayer.',
  'capture-encode.clipPresetLabel': 'Clip export preset',
  'capture-encode.clipPresetDesc':
    'A GPU preset is probed once for whether it actually initialises, and falls back to libx264 if not. At equal bitrate libx264 still looks better.',
  'capture-encode.clipQualityLabel': 'Clip quality (lower is better)',
  'capture-encode.clipQualityDesc':
    'Passed as crf, cq, global_quality or qp — whichever name that encoder uses. Around 20 is visually clean.',
  'capture-encode.clipWidthLabel': 'Clip width (0 = source)',
  'capture-encode.clipWidthDesc': 'Height follows the aspect ratio and is forced even.',
  'capture-encode.burnSubsLabel': 'Burn subtitles into the export',
  'capture-encode.burnSubsDesc':
    'Encode mode cannot mux a subtitle track at all. It is burn-in or nothing.',
  'capture-encode.audioFormatLabel': 'Audio extraction format',
  'capture-encode.gifFpsLabel': 'GIF / WebP frames per second',
  'capture-encode.gifWidthLabel': 'GIF / WebP width',
  'capture-encode.gifColorsLabel': 'GIF palette colours',
  'capture-encode.gifColorsDesc': 'The palette is generated and applied in one pass.',
  'capture-encode.gifDitherLabel': 'GIF dithering',
  'capture-encode.gifMaxSecondsLabel': 'Maximum GIF length (seconds)',
  'capture-encode.gifMaxSecondsDesc':
    'With no A-B range, this much is taken from the current position. 2 s at 480 px and 15 fps is about 2.8 MB.',
  'capture-encode.webpQualityLabel': 'WebP quality',
  'capture-encode.burstFormatLabel': 'Consecutive image format',
  'capture-encode.burstIntervalLabel': 'Consecutive image interval (seconds)',
  'capture-encode.burstWidthLabel': 'Consecutive image width',
  'capture-encode.burstJpegQscaleLabel': 'JPEG quality (2 = best)',
  'capture-encode.burstJpegQscaleDesc': "Converted to libavcodec's units on the way out (q × 118).",
  'capture-encode.sheetColsLabel': 'Contact sheet columns',
  'capture-encode.sheetRowsLabel': 'Contact sheet rows',
  'capture-encode.sheetTileWidthLabel': 'Contact sheet tile width',
  'capture-encode.sheetTileWidthDesc':
    'Per-tile timestamps are unavailable in this build: drawtext needs a font path, and a filter graph cannot carry one.',
  'capture-encode.maxConcurrentLabel': 'Jobs at once',
  'capture-encode.maxConcurrentDesc':
    'Keep this at 1. libx265 and libsvtav1 will use every core and playback is what must not stutter.',
  'capture-encode.streamRecordExtLabel': 'Stream recording container',
  'capture-encode.streamRecordExtDesc':
    'The container generally has to match the input. Seeking or switching tracks while recording may stop the recording or break the file.',

  'capture-encode.preset.h264-mp4': 'H.264 MP4 (compatible)',
  'capture-encode.preset.hevc-mkv': 'HEVC MKV (smaller)',
  'capture-encode.preset.vp9-webm': 'VP9 WebM',
  'capture-encode.preset.av1-mkv': 'AV1 MKV (slow)',
  'capture-encode.preset.nvenc-mp4': 'Fast (NVIDIA GPU)',
  'capture-encode.preset.qsv-mp4': 'Fast (Intel GPU)',
  'capture-encode.preset.amf-mp4': 'Fast (AMD GPU)',
  'capture-encode.preset.mf-mp4': 'Fast (Windows generic)',
  'capture-encode.audio.mp3': 'MP3 192 kbps',
  'capture-encode.audio.wav': 'WAV (lossless, large)',
  'capture-encode.audio.flac': 'FLAC (lossless)',
  'capture-encode.audio.opus': 'Opus',
  'capture-encode.audio.m4a': 'M4A (AAC)',
  'capture-encode.audio.mka': 'MKA (FLAC)',
  'capture-encode.dither.sierra2_4a': 'Sierra2 4A (default)',
  'capture-encode.dither.sierra2': 'Sierra2',
  'capture-encode.dither.floyd_steinberg': 'Floyd–Steinberg',
  'capture-encode.dither.bayer': 'Bayer',
  'capture-encode.dither.none': 'None',
  'capture-encode.burstFormat.png': 'PNG (lossless)',
  'capture-encode.burstFormat.jpg': 'JPEG (small)',
  'capture-encode.rec.mkv': 'MKV',
  'capture-encode.rec.ts': 'TS',
  'capture-encode.rec.mp4': 'MP4',

  'capture-encode.exportClip': 'Export clip of the range',
  'capture-encode.extractAudio': 'Extract audio of the range',
  'capture-encode.exportGif': 'Export GIF',
  'capture-encode.exportWebp': 'Export animated WebP',
  'capture-encode.burstFrames': 'Consecutive images (offline batch)',
  'capture-encode.contactSheet': 'Contact sheet image',
  'capture-encode.losslessCut': 'Fast lossless cut (approximate edges)',
  'capture-encode.stopCacheDump': 'Stop cache recording',
  'capture-encode.toggleStreamRecord': 'Toggle stream recording',
  'capture-encode.cancel': 'Cancel',
  'capture-encode.cancelAll': 'Cancel every running export',
  'capture-encode.menuTitle': 'Export',

  'capture-encode.jobRunning': 'Exporting',
  'capture-encode.started': '{label} started — {detail}',
  'capture-encode.finished': 'Saved {name}',
  'capture-encode.openFolder': 'Open folder',
  'capture-encode.cancelled': '{label} cancelled',
  'capture-encode.failed': '{label} failed: {reason}',
  'capture-encode.needLocalFile': 'Only available while a local file is playing',
  'capture-encode.needRange': 'Set an A-B range first, or wait for the duration to be known',
  'capture-encode.hwFellBack': 'The GPU encoder is unusable here; continuing with libx264',
  'capture-encode.gifTooLong': 'GIFs are capped at {cap} s. Shorten the A-B range',
  'capture-encode.gifEstimate': 'about {mb} MB',
  'capture-encode.cacheTooSmall':
    'A lossless cut needs a large demuxer cache (currently {mb} MB), and this module does not own the cache settings',
  'capture-encode.cutWorking': 'Cutting from the cache — playback may pause briefly',
  'capture-encode.cutEmpty': 'Nothing of that range was in the cache, so the file came out empty',
  'capture-encode.cutStopped': 'Cache recording stopped',
  'capture-encode.recNeedsStream': 'Stream recording only works on a network source',
  'capture-encode.recStarted': 'Recording to {name}',
  'capture-encode.recStopped': 'Recording stopped — {name}',
  'capture-encode.noJobs': 'Nothing is running',
  'capture-encode.burstTooMany':
    'These settings would write {frames} files (the limit is {max}). Set an A-B range or raise the interval.',
  // The renderer half's strings (panel, transport button, settings prose).
  'capture-encode.showJobs': 'Show export jobs',
  'capture-encode.panelTitle': 'Export jobs',
  'capture-encode.transportButton': 'Export jobs',
  'capture-encode.jobsEmpty': 'Nothing running. You can start an export below.',
  'capture-encode.cancelJob': 'Cancel this job',
  'capture-encode.quickActions': 'Start',
  'capture-encode.state.queued': 'Queued',
  'capture-encode.state.running': 'Running',
  'capture-encode.state.done': 'Done',
  'capture-encode.state.failed': 'Failed',
  'capture-encode.state.cancelled': 'Cancelled',
  'capture-encode.limitsTitle': 'What export can and cannot do',
  'capture-encode.limits.ffmpeg':
    'Every export runs the bundled mpv a second time in encode mode. No ffmpeg is shipped, so the install does not grow.',
  'capture-encode.limits.subs':
    'Subtitles can only be burnt into the picture. Encode mode has no subtitle muxing at all.',
  'capture-encode.limits.sheet':
    'The contact sheet has no per-tile timestamps: drawtext needs a font-file path, and a Windows absolute path cannot appear inside a filter graph.',
  'capture-encode.limits.hw':
    'GPU encoders are probed before use. If one will not initialise, the job quietly falls back to libx264.',
  'capture-encode.limits.cut':
    'Fast lossless cut can only take what is in the demuxer cache, and its edges land on keyframes.',
  'capture-encode.limits.stream':
    'Stream recording works for network sources only. On a local file mpv writes nothing.'
}

