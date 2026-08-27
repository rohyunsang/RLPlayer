import path from 'node:path'

/**
 * What counts as a video, an audio file or a subtitle. WAVE 0 — FROZEN.
 *
 * These tables are shared rather than living inside one module, because at
 * least three modules need to agree on them (M28 routes dropped paths, M17
 * decides what to attach, M34 registers file associations) and three private
 * copies would drift the first time someone added `.jxl`.
 *
 * S11: the v0.1 subtitle list was seven extensions long and missed `.sup`,
 * `.pgs`, `.ttml`, `.sami` and `.mks`, so dropping a PGS track on the window
 * tried to PLAY it.
 */

export const VIDEO_EXTENSIONS = [
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'webm', 'ts', 'm2ts', 'mts',
  'flv', 'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'rmvb', 'rm', 'asf', 'divx',
  'f4v', 'm2v', 'mpv', 'qt', 'dat', 'amv'
]

export const AUDIO_EXTENSIONS = [
  'mp3', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wav', 'wma', 'ape', 'alac', 'aiff', 'dsf'
]

export const SUB_EXTENSIONS = [
  'srt', 'ass', 'ssa', 'sub', 'idx', 'vtt', 'smi', 'sami', 'lrc',
  'mks', 'ttml', 'dfxp', 'sup', 'pgs', 'usf', 'rt'
]

const MEDIA = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])
const SUBS = new Set(SUB_EXTENSIONS)

export function extensionOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase()
}

export function isMediaFile(file: string): boolean {
  return MEDIA.has(extensionOf(file))
}

export function isSubtitleFile(file: string): boolean {
  return SUBS.has(extensionOf(file))
}
