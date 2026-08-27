import fs from 'node:fs'
import path from 'node:path'

export const SUB_EXTENSIONS = ['srt', 'ass', 'ssa', 'sub', 'vtt', 'idx', 'smi', 'lrc']

const SUB_SET = new Set(SUB_EXTENSIONS)

/** Folders people conventionally drop subtitle files into. */
const SUB_DIRS = ['Subs', 'subs', 'Subtitles', 'subtitles', 'Sub', 'sub']

function isSub(name: string): boolean {
  return SUB_SET.has(path.extname(name).slice(1).toLowerCase())
}

/**
 * Find external subtitles belonging to `video`.
 *
 * Matches on the filename stem, so `Show.S01E02.mkv` picks up
 * `Show.S01E02.srt`, `Show.S01E02.en.srt`, `Show.S01E02.forced.ass`, and the
 * same names inside a sibling `Subs/` folder.
 */
export function findExternalSubs(video: string): string[] {
  const dir = path.dirname(video)
  const stem = path.basename(video, path.extname(video)).toLowerCase()
  const found: string[] = []

  const scan = (folder: string, requireStem: boolean): void => {
    let names: string[]
    try {
      names = fs.readdirSync(folder)
    } catch {
      return
    }
    for (const name of names) {
      if (!isSub(name)) continue
      const subStem = path.basename(name, path.extname(name)).toLowerCase()
      // `Show.S01E02.en` starts with `show.s01e02`, so prefix-matching picks up
      // language and "forced" suffixes without matching unrelated files.
      if (requireStem && !subStem.startsWith(stem)) continue
      found.push(path.join(folder, name))
    }
  }

  scan(dir, true)
  for (const sd of SUB_DIRS) {
    const folder = path.join(dir, sd)
    if (!fs.existsSync(folder)) continue
    // Inside a dedicated Subs/ folder, accept loose matches too: releases often
    // name them `2_English.srt` with no relation to the video's stem.
    scan(folder, false)
  }

  // Exact-stem matches first, so the primary subtitle wins track slot 1.
  return dedupe(found).sort((a, b) => {
    const as = path.basename(a, path.extname(a)).toLowerCase() === stem ? 0 : 1
    const bs = path.basename(b, path.extname(b)).toLowerCase() === stem ? 0 : 1
    return as - bs || a.localeCompare(b)
  })
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((p) => {
    const k = p.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
