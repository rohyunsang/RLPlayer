import { ContributionError } from '../errors.ts'
import type { I18nService } from '@shared/feature-api'

/**
 * core/i18n — message catalogs, `t()` and the 조사 helper. WAVE 0 — FROZEN.
 *
 * Korean is the default language and English is the fallback of last resort,
 * not the other way round: this is a Korean-market player and a missing ko
 * string should be visible in testing, not papered over.
 */

export type Lang = 'ko' | 'en'

const catalogs: Record<Lang, Map<string, string>> = {
  ko: new Map(),
  en: new Map()
}

let current: Lang = 'ko'

export function setLanguage(lang: Lang): void {
  current = lang
}

export function getLanguage(): Lang {
  return current
}

/** Resolve from the OS locale on first boot. */
export function resolveLanguage(locale: string): Lang {
  return locale.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

export function registerMessages(
  ownerId: string | null,
  lang: Lang,
  messages: Record<string, string>
): void {
  const catalog = catalogs[lang]
  for (const [key, value] of Object.entries(messages)) {
    if (ownerId && !key.startsWith(`${ownerId}.`)) {
      throw new ContributionError(
        `module '${ownerId}' registered i18n key '${key}', which is outside its namespace. ` +
          `Keys must start with '${ownerId}.' (Appendix A).`
      )
    }
    catalog.set(key, value)
  }
}

/**
 * 조사 (Korean particle) agreement. `t('x', {name})` alone produces
 * "파일를 / 자막을" nonsense; every user-visible sentence with an interpolated
 * filename needs this. Written once, here.
 *
 * Usage in a catalog string: `{name}{을/를} 찾을 수 없습니다`
 */
export function josa(word: string, pair: string): string {
  const [withFinal = '', withoutFinal = ''] = pair.split('/')
  const last = word.trim().slice(-1)
  if (!last) return withoutFinal
  const code = last.charCodeAt(0)
  // Hangul syllables: 0xAC00..0xD7A3, final consonant = (code - 0xAC00) % 28
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? withoutFinal : withFinal
  }
  // Digits and Latin letters read aloud in Korean: these end in a consonant.
  if (/[0-9]$/.test(last)) return '02345679'.includes(last) ? withFinal : withoutFinal
  if (/[a-zA-Z]$/.test(last)) return 'lmnrLMNR'.includes(last) ? withFinal : withoutFinal
  return withoutFinal
}

const PARAM = /\{([^{}]+)\}/g

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = catalogs[current].get(key) ?? catalogs.en.get(key) ?? catalogs.ko.get(key) ?? key
  if (!params && !raw.includes('{')) return raw
  let last = ''
  return raw.replace(PARAM, (_m, name: string) => {
    if (name.includes('/')) {
      const particle = josa(last, name)
      return particle
    }
    const v = params?.[name]
    last = v === undefined ? '' : String(v)
    return last
  })
}

/**
 * The whole resolved catalog, flattened for the renderer.
 *
 * Both renderer windows call `ctx.t()` while they build DOM, so they need the
 * strings synchronously once they are up. They fetch this once at boot rather
 * than round-tripping per key, and English backfills anything the current
 * language is missing — the same precedence `t()` applies here.
 */
export function messageCatalog(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of catalogs.en) out[k] = v
  for (const [k, v] of catalogs[current]) out[k] = v
  return out
}

export function createI18nService(ownerId: string): I18nService {
  return {
    register: (lang, messages) => registerMessages(ownerId, lang, messages),
    t
  }
}

/** The core catalog: strings owned by main itself, not by any feature module. */
export function registerCoreMessages(): void {
  registerMessages(null, 'ko', {
    'core.startFailed': 'RLPlayer 시작 실패',
    'core.engineFailed': '재생 엔진을 시작할 수 없습니다',
    'core.engineHint': '"npm run fetch:mpv"를 실행해 mpv를 내려받으세요.',
    'core.moduleFailed': '{id} 기능을 불러오지 못했습니다',
    'core.configRecovered': '설정 파일이 손상되어 초기화했습니다. 이전 파일은 보관했습니다.',
    'core.configReadOnly': '더 새로운 버전이 만든 설정 파일입니다. 읽기 전용으로 실행합니다.',
    'core.portableFallback':
      '휴대용 폴더에 쓸 수 없어 사용자 폴더에 설정을 저장합니다.',
    'core.unknownCommand': '알 수 없는 명령입니다: {id}',
    'core.notImplemented': '{id} 기능은 아직 준비되지 않았습니다',
    'core.stats': '재생 정보',
    'core.statsEmpty': '표시할 정보가 없습니다',
    'core.statsError': '오류',
    'core.settingsTitle': 'RLPlayer 설정',
    'core.section.general': '일반',
    'core.section.playback': '재생',
    'core.section.video': '화면',
    'core.section.audio': '오디오',
    'core.section.subtitles': '자막',
    'core.section.keys': '단축키',
    'core.section.filetypes': '파일 연결',
    'core.section.advanced': '고급',
    'core.settingsSearch': '설정 검색',
    'core.settingsNoResults': '검색 결과가 없습니다',
    'core.settingsAdvanced': '고급 설정 표시',
    'core.settingsRestart': '다시 시작해야 적용됩니다',
    'core.browse': '변경',
    'core.reset': '기본값으로 초기화',
    'core.close': '닫기',
    'core.about': '정보',
    'core.aboutVersion': '버전',
    'core.aboutMode': '모드',
    'core.aboutPortable': '휴대용 (exe 옆에 설정 저장)',
    'core.aboutInstalled': '설치형',
    'core.aboutConfig': '설정 파일',
    'core.aboutEngine': '재생 엔진',
    'core.aboutNoNetwork':
      'RLPlayer는 자동 업데이트를 하지 않고, 실행 중 어떤 네트워크 요청도 보내지 않습니다.',
    'core.openConfigFolder': '설정 폴더 열기',
    'core.fileTypes': '파일 연결',
    'core.fileTypesHint':
      'Windows 10/11은 앱이 스스로 기본 프로그램으로 등록하는 것을 허용하지 않습니다. 아래 버튼으로 설정을 연 뒤 동영상 형식마다 RLPlayer를 직접 선택해 주세요.',
    'core.openDefaultApps': 'Windows 기본 앱 설정 열기',
    'core.keybindPreset': '단축키 프리셋',
    'core.keybindPreset.default': 'RLPlayer 기본',
    'core.keybindPreset.potplayer': 'PotPlayer 호환',
    'core.keybindPreset.mpv': 'mpv 호환',
    'core.keybindHint':
      '개별 단축키는 설정 파일의 keybinds 항목에서 바꿀 수 있습니다. 프리셋 위에 덮어쓰는 방식이라 바꾸고 싶은 키만 적으면 됩니다.',
    'core.toggleStats': '재생 정보 표시',
    'core.ownershipRefused':
      '{id} 기능이 다른 기능의 설정을 바꾸려다 차단되었습니다. 재생 정보(I)에서 자세한 내용을 볼 수 있습니다.',
    'core.refusals': '차단된 쓰기',
    'core.refusalsNone': '없음'
  })
  registerMessages(null, 'en', {
    'core.startFailed': 'RLPlayer failed to start',
    'core.engineFailed': 'Could not start the playback engine',
    'core.engineHint': 'Run "npm run fetch:mpv" to download mpv.',
    'core.moduleFailed': 'The {id} feature failed to load',
    'core.configRecovered': 'The settings file was corrupt and has been reset; the old one was kept.',
    'core.configReadOnly': 'This settings file was written by a newer build. Running read-only.',
    'core.portableFallback': 'The portable folder is not writable; settings go to your user folder.',
    'core.unknownCommand': 'Unknown command: {id}',
    'core.notImplemented': '{id} is not available yet',
    'core.stats': 'Playback statistics',
    'core.statsEmpty': 'Nothing to show',
    'core.statsError': 'Error',
    'core.settingsTitle': 'RLPlayer settings',
    'core.section.general': 'General',
    'core.section.playback': 'Playback',
    'core.section.video': 'Video',
    'core.section.audio': 'Audio',
    'core.section.subtitles': 'Subtitles',
    'core.section.keys': 'Shortcuts',
    'core.section.filetypes': 'File types',
    'core.section.advanced': 'Advanced',
    'core.settingsSearch': 'Search settings',
    'core.settingsNoResults': 'No matching settings',
    'core.settingsAdvanced': 'Show advanced settings',
    'core.settingsRestart': 'Takes effect after a restart',
    'core.browse': 'Browse',
    'core.reset': 'Reset to defaults',
    'core.close': 'Close',
    'core.about': 'About',
    'core.aboutVersion': 'Version',
    'core.aboutMode': 'Mode',
    'core.aboutPortable': 'Portable (settings next to the exe)',
    'core.aboutInstalled': 'Installed',
    'core.aboutConfig': 'Settings file',
    'core.aboutEngine': 'Playback engine',
    'core.aboutNoNetwork':
      'RLPlayer never auto-updates and makes no network request while it runs.',
    'core.openConfigFolder': 'Open settings folder',
    'core.fileTypes': 'File types',
    'core.fileTypesHint':
      'Windows 10/11 does not let an app make itself the default handler. Open Settings below and pick RLPlayer for each video format.',
    'core.openDefaultApps': 'Open Windows default apps',
    'core.keybindPreset': 'Shortcut preset',
    'core.keybindPreset.default': 'RLPlayer default',
    'core.keybindPreset.potplayer': 'PotPlayer compatible',
    'core.keybindPreset.mpv': 'mpv compatible',
    'core.keybindHint':
      'Individual shortcuts live under `keybinds` in the settings file. They layer on top of the preset, so you only list the keys you want to change.',
    'core.toggleStats': 'Show playback statistics',
    'core.ownershipRefused':
      '{id} tried to change another feature’s state and was blocked. Press I for details.',
    'core.refusals': 'Blocked writes',
    'core.refusalsNone': 'none'
  })
}
