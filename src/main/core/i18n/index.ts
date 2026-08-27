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
    'core.notImplemented': '{id} 기능은 아직 준비되지 않았습니다'
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
    'core.notImplemented': '{id} is not available yet'
  })
}
