/**
 * M29 mediainfo -- the message catalogue.
 *
 * ONE TABLE, TWO CATALOGUES. Korean and English are declared as a pair per key
 * rather than as two objects, because two objects drift: a key added to one and
 * not the other renders as the raw key (`ctx.t()` returns its argument for an
 * unknown key, by design -- that is what lets a metadata TAG name be its own
 * label), and a raw key in the panel is a silent defect that no typecheck and no
 * test would have seen. `i18n.test.ts` asserts the two catalogues have identical
 * key sets and that every label key the render model can emit is in the table.
 *
 * Keys must start with `mediainfo.` -- `core/i18n` throws at boot otherwise
 * (section 11).
 */

type Pair = readonly [ko: string, en: string]

const M: Readonly<Record<string, Pair>> = {
  // --- the panel and its chrome -------------------------------------------
  'mediainfo.title': ['미디어 정보', 'Media info'],
  'mediainfo.empty': ['재생 중인 파일이 없습니다', 'Nothing is playing'],
  'mediainfo.togglePanel': ['미디어 정보 패널', 'Media info panel'],
  'mediainfo.close': ['닫기', 'Close'],
  'mediainfo.tab.info': ['정보', 'Info'],
  'mediainfo.tab.tracks': ['트랙', 'Tracks'],
  'mediainfo.tab.properties': ['파일 속성', 'File properties'],
  'mediainfo.density.full': ['전체', 'Full'],
  'mediainfo.density.short': ['간략', 'Short'],
  'mediainfo.density.misc': ['기타', 'Misc'],
  'mediainfo.expand': ['자세히', 'Details'],
  'mediainfo.selectedTrack': ['선택됨', 'selected'],
  'mediainfo.artAlt': ['앨범 아트', 'Album art'],
  'mediainfo.embeddedArt': ['내장 앨범 아트 있음', 'Embedded cover art present'],
  'mediainfo.noArt': ['앨범 아트를 찾을 수 없습니다', 'No cover art found'],
  'mediainfo.probing': ['정보를 읽는 중…', 'Reading media info…'],
  'mediainfo.approxNote': [
    '프레임 번호는 추정값입니다',
    'Frame numbers are estimates'
  ],
  'mediainfo.demuxClaimNote': [
    'demux 값은 컨테이너가 선언한 값입니다',
    'demux values are as declared by the container'
  ],

  // --- commands ------------------------------------------------------------
  'mediainfo.showFull': ['미디어 정보 (전체)', 'Media info (full)'],
  'mediainfo.showShort': ['미디어 정보 (간략)', 'Media info (short)'],
  'mediainfo.showMisc': ['미디어 정보 (기타)', 'Media info (misc)'],
  'mediainfo.copyInfo': ['미디어 정보 복사', 'Copy media info'],
  'mediainfo.fileProperties': ['파일 속성', 'File properties'],
  'mediainfo.shellPropertiesCmd': ['Windows 파일 속성', 'Windows file properties'],
  'mediainfo.mpvStatsToggle': ['mpv 내장 통계 표시', 'Toggle mpv built-in stats'],
  'mediainfo.mpvStatsNextPage': ['mpv 통계 다음 페이지', 'mpv stats: next page'],

  // --- toasts --------------------------------------------------------------
  'mediainfo.copied': ['미디어 정보를 클립보드에 복사했습니다', 'Media info copied to clipboard'],
  'mediainfo.copyFailed': ['복사 실패: {reason}', 'Copy failed: {reason}'],
  'mediainfo.noFile': ['먼저 파일을 재생하세요', 'Play a file first'],
  'mediainfo.showInFolder': ['폴더 열기', 'Show in folder'],
  'mediainfo.shellUnavailable': [
    'Windows 속성 창을 열 수 없습니다 (로컬 파일만 지원)',
    'Cannot open the Windows properties dialog (local files only)'
  ],
  'mediainfo.mpvStatsHint': [
    'mpv 통계는 영상 위에 직접 그려집니다',
    'mpv draws its stats inside the video surface'
  ],

  // --- settings ------------------------------------------------------------
  'mediainfo.probeEnabled': ['재생하지 않는 파일도 정보 읽기', 'Probe files that are not playing'],
  'mediainfo.probeEnabled.desc': [
    '재생 목록의 길이/트랙 정보를 별도의 mpv로 읽습니다',
    'Reads duration and track counts for playlist rows with a second mpv'
  ],
  'mediainfo.probeTimeoutMs': ['정보 읽기 제한 시간 (ms)', 'Probe timeout (ms)'],
  'mediainfo.probeIdleSec': ['정보 읽기 프로세스 유지 시간 (초)', 'Probe process idle timeout (s)'],
  'mediainfo.refreshMs': ['패널 갱신 주기 (ms)', 'Panel refresh interval (ms)'],
  'mediainfo.showApproxFrames': ['프레임 번호 표시 (추정값)', 'Show frame numbers (estimates)'],
  'mediainfo.albumArt': ['앨범 아트 표시', 'Show cover art'],
  'mediainfo.copyIncludesTags': ['복사에 태그 포함', 'Include tags when copying'],
  'mediainfo.copyIncludesTrackDetail': [
    '복사에 트랙 상세 포함',
    'Include per-track detail when copying'
  ],

  // --- report --------------------------------------------------------------
  'mediainfo.report.heading': ['RLPlayer 미디어 정보', 'RLPlayer media info'],

  // --- group titles --------------------------------------------------------
  'mediainfo.group.general': ['일반', 'General'],
  'mediainfo.group.video': ['비디오', 'Video'],
  'mediainfo.group.audio': ['오디오', 'Audio'],
  'mediainfo.group.subs': ['자막', 'Subtitles'],
  'mediainfo.group.pipeline': ['재생 파이프라인', 'Playback pipeline'],
  'mediainfo.group.frames': ['프레임', 'Frames'],
  'mediainfo.group.stream': ['스트림', 'Stream'],
  'mediainfo.group.tags': ['태그', 'Tags'],
  'mediainfo.group.chapters': ['챕터', 'Chapters'],
  'mediainfo.group.tracks': ['트랙', 'Tracks'],
  'mediainfo.group.diagnostics': ['진단 정보', 'Diagnostics'],
  'mediainfo.group.file': ['파일', 'File'],

  // --- fields --------------------------------------------------------------
  'mediainfo.f.filename': ['파일 이름', 'File name'],
  'mediainfo.f.title': ['제목', 'Title'],
  'mediainfo.f.path': ['경로', 'Path'],
  'mediainfo.f.directory': ['폴더', 'Folder'],
  'mediainfo.f.container': ['컨테이너', 'Container'],
  'mediainfo.f.demuxer': ['디먹서', 'Demuxer'],
  'mediainfo.f.duration': ['길이', 'Duration'],
  'mediainfo.f.size': ['크기', 'Size'],
  'mediainfo.f.created': ['만든 날짜', 'Created'],
  'mediainfo.f.modified': ['수정한 날짜', 'Modified'],
  'mediainfo.f.overallBitrate': ['전체 비트레이트 (계산값)', 'Overall bitrate (computed)'],
  'mediainfo.f.videoCodec': ['비디오 코덱', 'Video codec'],
  'mediainfo.f.decoder': ['디코더', 'Decoder'],
  'mediainfo.f.resolution': ['해상도', 'Resolution'],
  'mediainfo.f.displayResolution': ['표시 해상도', 'Display resolution'],
  'mediainfo.f.aspect': ['화면 비율', 'Aspect ratio'],
  'mediainfo.f.par': ['픽셀 비율 (PAR)', 'Pixel aspect (PAR)'],
  'mediainfo.f.pixelFormat': ['픽셀 포맷', 'Pixel format'],
  'mediainfo.f.hwPixelFormat': ['하드웨어 픽셀 포맷', 'HW pixel format'],
  'mediainfo.f.bpp': ['평균 비트/픽셀', 'Average bits per pixel'],
  'mediainfo.f.containerFps': ['컨테이너 fps (선언값)', 'Container fps (declared)'],
  'mediainfo.f.measuredFps': ['측정 fps', 'Measured fps'],
  'mediainfo.f.videoBitrate': ['비디오 비트레이트', 'Video bitrate'],
  'mediainfo.f.audioCodec': ['오디오 코덱', 'Audio codec'],
  'mediainfo.f.audioDecoder': ['오디오 디코더', 'Audio decoder'],
  'mediainfo.f.channelsIn': ['채널 (원본)', 'Channels (source)'],
  'mediainfo.f.channelsOut': ['채널 (출력)', 'Channels (output)'],
  'mediainfo.f.sampleRateIn': ['샘플레이트 (원본)', 'Sample rate (source)'],
  'mediainfo.f.sampleRateOut': ['샘플레이트 (출력)', 'Sample rate (output)'],
  'mediainfo.f.formatIn': ['샘플 포맷 (원본)', 'Sample format (source)'],
  'mediainfo.f.formatOut': ['샘플 포맷 (출력)', 'Sample format (output)'],
  'mediainfo.f.audioBitrate': ['오디오 비트레이트', 'Audio bitrate'],
  'mediainfo.f.ao': ['오디오 출력', 'Audio output'],
  'mediainfo.f.af': ['오디오 필터', 'Audio filters'],
  'mediainfo.f.subCount': ['자막 트랙 수', 'Subtitle tracks'],
  'mediainfo.f.subCodec': ['자막 코덱', 'Subtitle codec'],
  'mediainfo.f.subLang': ['자막 언어', 'Subtitle language'],
  'mediainfo.f.subTitle': ['자막 이름', 'Subtitle name'],
  'mediainfo.f.hwdec': ['하드웨어 디코더', 'Hardware decoder'],
  'mediainfo.f.vo': ['비디오 출력', 'Video output'],
  'mediainfo.f.gpuContext': ['GPU 컨텍스트', 'GPU context'],
  'mediainfo.f.colorMatrix': ['색 행렬', 'Colour matrix'],
  'mediainfo.f.colorLevels': ['색 레벨', 'Colour levels'],
  'mediainfo.f.primaries': ['색 원색', 'Primaries'],
  'mediainfo.f.gammaCurve': ['감마 곡선', 'Transfer curve'],
  'mediainfo.f.maxLuma': ['최대 휘도', 'Max luminance'],
  'mediainfo.f.minLuma': ['최소 휘도', 'Min luminance'],
  'mediainfo.f.maxCll': ['MaxCLL', 'MaxCLL'],
  'mediainfo.f.maxFall': ['MaxFALL', 'MaxFALL'],
  'mediainfo.f.stereoIn': ['스테레오 모드', 'Stereo mode'],
  'mediainfo.f.rotate': ['회전', 'Rotation'],
  'mediainfo.f.deinterlaceActive': ['디인터레이스 동작', 'Deinterlace active'],
  'mediainfo.f.displayFps': ['디스플레이 fps', 'Display fps'],
  'mediainfo.f.measuredDisplayFps': ['측정 디스플레이 fps', 'Measured display fps'],
  'mediainfo.f.vf': ['비디오 필터', 'Video filters'],
  'mediainfo.f.mpvVersion': ['mpv 버전', 'mpv version'],
  'mediainfo.f.frameApprox': ['프레임 (추정)', 'Frame (approx.)'],
  'mediainfo.f.pictureType': ['픽처 타입', 'Picture type'],
  'mediainfo.f.interlaced': ['인터레이스', 'Interlaced'],
  'mediainfo.f.repeat': ['반복 프레임', 'Repeated frame'],
  'mediainfo.f.framesDropped': ['버린 프레임', 'Frames dropped'],
  'mediainfo.f.decoderFramesDropped': ['디코더가 버린 프레임', 'Decoder frames dropped'],
  'mediainfo.f.requestedUrl': ['입력한 주소', 'Requested URL'],
  'mediainfo.f.openedUrl': ['실제로 연 주소', 'Opened URL'],
  'mediainfo.f.hlsBitrate': ['HLS 비트레이트', 'HLS bitrate'],
  'mediainfo.f.subBitrate': ['자막 비트레이트', 'Subtitle bitrate'],
  'mediainfo.f.rawInputRate': ['입력 속도', 'Input rate'],
  'mediainfo.f.cacheSpeed': ['캐시 속도', 'Cache speed'],
  'mediainfo.f.cacheDuration': ['캐시 길이', 'Cache duration'],
  'mediainfo.f.tagsTruncated': ['표시하지 않은 태그', 'Tags not shown'],
  'mediainfo.f.position': ['위치', 'Position'],
  'mediainfo.f.videoTrack': ['비디오 트랙', 'Video track'],
  'mediainfo.f.audioTrack': ['오디오 트랙', 'Audio track'],
  'mediainfo.f.subTrack': ['자막 트랙', 'Subtitle track'],

  // --- per-track detail (L24) ---------------------------------------------
  'mediainfo.f.trackCodec': ['코덱', 'Codec'],
  'mediainfo.f.trackDecoder': ['디코더', 'Decoder'],
  'mediainfo.f.trackFormatName': ['포맷 이름', 'Format name'],
  'mediainfo.f.trackLang': ['언어', 'Language'],
  'mediainfo.f.trackTitle': ['이름', 'Title'],
  'mediainfo.f.trackDemuxRes': ['해상도 (선언값)', 'Resolution (declared)'],
  'mediainfo.f.trackDemuxFps': ['fps (선언값)', 'fps (declared)'],
  'mediainfo.f.trackDemuxBitrate': ['비트레이트 (선언값)', 'Bitrate (declared)'],
  'mediainfo.f.trackDemuxChannels': ['채널 (선언값)', 'Channels (declared)'],
  'mediainfo.f.trackDemuxSampleRate': ['샘플레이트 (선언값)', 'Sample rate (declared)'],
  'mediainfo.f.trackDemuxDuration': ['길이 (선언값)', 'Duration (declared)'],
  'mediainfo.f.trackDemuxRotation': ['회전 (선언값)', 'Rotation (declared)'],
  'mediainfo.f.trackDemuxPar': ['PAR (선언값)', 'PAR (declared)'],
  'mediainfo.f.trackHlsBitrate': ['HLS 비트레이트', 'HLS bitrate'],
  'mediainfo.f.trackReplayGainTrack': ['ReplayGain (트랙)', 'ReplayGain (track)'],
  'mediainfo.f.trackReplayGainAlbum': ['ReplayGain (앨범)', 'ReplayGain (album)'],
  'mediainfo.f.trackDvProfile': ['Dolby Vision 프로파일', 'Dolby Vision profile'],
  'mediainfo.f.trackDvLevel': ['Dolby Vision 레벨', 'Dolby Vision level'],
  'mediainfo.f.trackExternalFile': ['외부 파일', 'External file'],
  'mediainfo.f.trackSrcId': ['소스 id', 'Source id'],
  'mediainfo.f.trackFfIndex': ['FFmpeg 인덱스', 'FFmpeg index'],
  'mediainfo.f.trackMainSelection': ['주 선택 번호', 'Main selection']
}

export const KO: Record<string, string> = Object.fromEntries(
  Object.entries(M).map(([k, v]) => [k, v[0]])
)
export const EN: Record<string, string> = Object.fromEntries(
  Object.entries(M).map(([k, v]) => [k, v[1]])
)

/** For the catalogue test: the keys, once. */
export const KEYS: readonly string[] = Object.keys(M)
