import './settings.css'
import {
  fetchMessages,
  onContributionsChanged,
  settingsComponents,
  settingsSections,
  t
} from './feature-host.ts'
import type { SettingType } from '../../../shared/feature-api.ts'
import type { SettingBinding } from '../../../shared/renderer-api.ts'

/**
 * The settings window, GENERATED.
 *
 * What this replaces: a hand-written `settings.html` with `<select id="hwdec">`,
 * `<select id="vo">`, `<input id="subScale">` and five more, wired one by one in
 * a hand-written `settings.ts`, all backed by fields on `AppConfig` in
 * `src/shared/types.ts`. Those three files sit in every module's
 * `mustNotTouch`, and the audit found five collisions on them at once — M38
 * against M07 (`hwdec`, `vo`), M15 (`audioDevice`), M19 (`subScale`,
 * `subAssOverride`), M17 (`autoLoadSubs`) and M10 (`volumeBoostLimiter`).
 *
 * Nothing in this file names a setting. It asks main for the descriptor list,
 * renders a control per `type.kind`, and writes back by id. Adding a setting is
 * `ctx.settings.define()` in your own module directory and nothing else.
 *
 * Two escape hatches, for the things a descriptor genuinely cannot express:
 *   - `{ kind: 'custom', rendererComponent }` looks up `ctx.settingsComponent()`
 *     — the audio-device list has to be queried from mpv at open time, so no
 *     static `enum` can describe it.
 *   - `ctx.settingsSection()` mounts arbitrary markup into one of the eight
 *     fixed sections, for prose and buttons rather than values.
 */

const SECTIONS = [
  'general',
  'playback',
  'video',
  'audio',
  'subtitles',
  'keys',
  'filetypes',
  'advanced'
] as const

type Section = (typeof SECTIONS)[number]

interface SettingRow {
  id: string
  section: Section
  group?: string
  label: string
  description?: string
  type: SettingType
  value: unknown
  default: unknown
  mpvOption?: string
  requiresRestart?: boolean
  advanced?: boolean
  order?: number
  keywords?: readonly string[]
  /** `false` when the descriptor's `visibleWhen` predicate excludes it. */
  visible?: boolean
}

interface SystemInfo {
  version: string
  portable: boolean
  configPath: string
  readOnly: boolean
  mpv: string
}

const bridge = window.rl
const api = window.rlplayer

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

let rows: SettingRow[] = []
const listeners = new Map<string, Set<() => void>>()
/** Set by bootSettingsWindow so a visibility change can re-render in place. */
let formRoot: HTMLElement | null = null

/** The visibility vector, used to decide whether a write changed the FORM. */
const visKey = (list: readonly SettingRow[]): string =>
  list.map((r) => (r.visible === false ? '0' : '1')).join('')

async function writeSetting(id: string, value: unknown): Promise<void> {
  await bridge.invoke('core-settings:set', { id, value })
  const row = rows.find((r) => r.id === id)
  if (row) row.value = value
  for (const cb of listeners.get(id) ?? []) {
    try {
      cb()
    } catch (e) {
      console.error(`[settings] listener for '${id}' threw:`, e)
    }
  }
  /**
   * `visibleWhen` is a predicate over OTHER settings, so writing one row can
   * change whether another applies -- that is the entire point of it, and the
   * reason it cannot be evaluated here: the function lives in main. Re-fetch
   * and re-render ONLY when the visibility vector actually moved.
   *
   * Not on every write, deliberately. A bounded int/float writes on each
   * `input` event, so re-rendering unconditionally would tear the slider out
   * from under the pointer mid-drag; comparing the vector first makes the
   * common case free.
   */
  if (!formRoot) return
  try {
    const fresh = (await bridge.invoke('core-settings:list')) as SettingRow[]
    if (visKey(fresh) === visKey(rows)) return
    rows = fresh
    await render(formRoot)
  } catch (e) {
    console.error('[settings] could not refresh visibility:', e)
  }
}

/** The binding a `custom` component is handed. */
function bindingFor(row: SettingRow): SettingBinding {
  return {
    get<T>(): T {
      return (rows.find((r) => r.id === row.id)?.value ?? row.default) as T
    },
    set<T>(v: T): void {
      void writeSetting(row.id, v)
    },
    onChange(cb): () => void {
      let set = listeners.get(row.id)
      if (!set) {
        set = new Set()
        listeners.set(row.id, set)
      }
      set.add(cb)
      return () => set?.delete(cb)
    }
  }
}

// --- one control per descriptor kind ---------------------------------------

function controlFor(row: SettingRow): HTMLElement {
  const box = el('div', 'setting-control')
  const type = row.type

  switch (type.kind) {
    case 'bool': {
      const input = el('input')
      input.type = 'checkbox'
      input.checked = row.value === true
      input.addEventListener('change', () => void writeSetting(row.id, input.checked))
      box.appendChild(input)
      break
    }
    case 'int':
    case 'float': {
      const stepped = type.step ?? (type.kind === 'int' ? 1 : 0.05)
      // A bounded number is a slider with a readout; an unbounded one is a
      // number box, because a slider with no ends is a lie about the range.
      if (type.min !== undefined && type.max !== undefined) {
        const input = el('input')
        input.type = 'range'
        input.min = String(type.min)
        input.max = String(type.max)
        input.step = String(stepped)
        input.value = String(row.value ?? row.default)
        const out = el('output', undefined, format(Number(input.value), type.kind))
        input.addEventListener('input', () => {
          out.textContent = format(Number(input.value), type.kind)
          void writeSetting(row.id, Number(input.value))
        })
        box.append(input, out)
      } else {
        const input = el('input')
        input.type = 'number'
        if (type.min !== undefined) input.min = String(type.min)
        if (type.max !== undefined) input.max = String(type.max)
        input.step = String(stepped)
        input.value = String(row.value ?? row.default)
        input.addEventListener('change', () => void writeSetting(row.id, Number(input.value)))
        box.appendChild(input)
      }
      break
    }
    case 'string': {
      if (type.multiline) {
        const area = el('textarea')
        area.value = String(row.value ?? '')
        area.addEventListener('change', () => void writeSetting(row.id, area.value))
        box.appendChild(area)
      } else {
        const input = el('input')
        input.type = 'text'
        input.value = String(row.value ?? '')
        input.addEventListener('change', () => void writeSetting(row.id, input.value))
        box.appendChild(input)
      }
      break
    }
    case 'enum': {
      const select = el('select')
      for (const opt of type.options) {
        const o = el('option', undefined, t(opt.labelKey))
        o.value = opt.value
        select.appendChild(o)
      }
      select.value = String(row.value ?? row.default)
      select.addEventListener('change', () => void writeSetting(row.id, select.value))
      box.appendChild(select)
      break
    }
    case 'path': {
      const input = el('input')
      input.type = 'text'
      input.readOnly = true
      input.value = String(row.value ?? '')
      const browse = el('button', 'btn', t('core.browse'))
      browse.type = 'button'
      browse.addEventListener('click', async () => {
        const picked = (await bridge.invoke('core-settings:browse', {
          mode: type.mode,
          filters: type.filters ?? []
        })) as string | null
        if (picked === null) return
        input.value = picked
        await writeSetting(row.id, picked)
      })
      box.append(input, browse)
      break
    }
    case 'list': {
      // One entry per line: a list of subtitle folders or extensions is edited
      // far more comfortably as text than as a row of chips.
      const area = el('textarea')
      area.value = Array.isArray(row.value) ? (row.value as string[]).join('\n') : ''
      area.addEventListener('change', () =>
        void writeSetting(
          row.id,
          area.value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      )
      box.appendChild(area)
      break
    }
    case 'custom': {
      const mount = settingsComponents.get(type.rendererComponent)
      if (!mount) {
        // A descriptor naming a component nobody registered is a wiring bug in
        // the owning module, and silence would hide it.
        box.appendChild(
          el('span', 'hint', `missing settings component '${type.rendererComponent}'`)
        )
        break
      }
      const host = el('div', 'setting-custom')
      box.appendChild(host)
      try {
        mount(host, bindingFor(row))
      } catch (e) {
        console.error(`[settings] component '${type.rendererComponent}' failed:`, e)
      }
      break
    }
  }

  if (row.requiresRestart) box.appendChild(el('span', 'restart-badge', t('core.settingsRestart')))
  if (row.mpvOption) {
    const tag = el('span', 'mpv-option', `--${row.mpvOption}`)
    tag.title = `--${row.mpvOption}`
    box.appendChild(tag)
  }
  return box
}

function format(v: number, kind: 'int' | 'float'): string {
  return kind === 'int' ? String(Math.round(v)) : v.toFixed(2)
}

// --- the page ---------------------------------------------------------------

function renderRow(row: SettingRow): HTMLElement {
  const line = el('label', 'row setting')
  line.dataset['settingId'] = row.id
  if (row.advanced) line.dataset['advanced'] = 'true'
  line.dataset['search'] = [row.label, row.description ?? '', row.id, row.mpvOption ?? '', ...(row.keywords ?? [])]
    .join(' ')
    .toLowerCase()

  const labelBox = el('div', 'setting-label')
  labelBox.appendChild(el('strong', undefined, row.label))
  if (row.description) labelBox.appendChild(el('small', undefined, row.description))
  line.append(labelBox, controlFor(row))
  return line
}

function renderSection(section: Section, root: HTMLElement): void {
  // `visible === false` means the descriptor's visibleWhen excluded it. It is
  // dropped rather than `hidden`, so the search filter and the "no results"
  // line below both count only rows that actually apply.
  const mine = rows.filter((r) => r.section === section && r.visible !== false)
  const contributed = settingsSections.filter((s) => s.section === section)
  if (mine.length === 0 && contributed.length === 0 && !CORE_BLOCKS[section]) return

  const box = el('section')
  box.dataset['section'] = section
  box.appendChild(el('h2', undefined, t(`core.section.${section}`)))

  // Descriptors first, grouped by their `group`, then whatever
  // ctx.settingsSection() contributed, then core's own fixed blocks.
  const groups = new Map<string, SettingRow[]>()
  for (const r of mine) {
    const key = r.group ?? ''
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  for (const [group, list] of groups) {
    if (group) box.appendChild(el('h3', 'group-title', t(group)))
    for (const r of list) box.appendChild(renderRow(r))
  }

  for (const spec of contributed) {
    const host = el('div', 'settings-contributed')
    host.dataset['sectionId'] = spec.id
    box.appendChild(host)
    try {
      spec.mount(host)
    } catch (e) {
      console.error(`[settings] section '${spec.id}' failed to mount:`, e)
      host.remove()
    }
  }

  CORE_BLOCKS[section]?.(box)
  root.appendChild(box)
}

/**
 * Core's own blocks. These are not settings: they are prose and buttons that
 * belong to the app rather than to any module — the keybind preset (core-input
 * owns the presets), the file-association explanation Windows forces on us, and
 * the About block. Everything else on this page comes from a descriptor.
 */
const CORE_BLOCKS: Partial<Record<Section, (box: HTMLElement) => void>> = {
  keys(box) {
    const row = el('label', 'row')
    row.appendChild(el('span', 'label', t('core.keybindPreset')))
    const select = el('select')
    for (const p of ['default', 'potplayer', 'mpv'] as const) {
      const o = el('option', undefined, t(`core.keybindPreset.${p}`))
      o.value = p
      select.appendChild(o)
    }
    void api.config.get().then((c) => {
      select.value = c.keybindPreset
    })
    select.addEventListener('change', () => {
      void api.config.set({ keybindPreset: select.value as 'default' | 'potplayer' | 'mpv' })
    })
    row.appendChild(select)
    box.appendChild(row)
    box.appendChild(el('p', 'hint', t('core.keybindHint')))
    const open = el('button', 'btn', t('core.openConfigFolder'))
    open.type = 'button'
    open.addEventListener('click', () => api.system.openConfigFolder())
    box.appendChild(open)
  },
  filetypes(box) {
    box.appendChild(el('p', 'hint', t('core.fileTypesHint')))
    const open = el('button', 'btn', t('core.openDefaultApps'))
    open.type = 'button'
    open.addEventListener('click', () => api.system.openDefaultAppsSettings())
    box.appendChild(open)
  },
  general(box) {
    const dl = el('dl', 'info')
    const info = el('h3', 'group-title', t('core.about'))
    box.append(info, dl)
    void api.system.info().then((i: SystemInfo) => {
      const put = (k: string, v: string, mono = false): void => {
        dl.appendChild(el('dt', undefined, k))
        dl.appendChild(el('dd', mono ? 'mono' : undefined, v))
      }
      put(t('core.aboutVersion'), i.version)
      put(t('core.aboutMode'), i.portable ? t('core.aboutPortable') : t('core.aboutInstalled'))
      put(t('core.aboutConfig'), i.configPath, true)
      put(t('core.aboutEngine'), i.mpv, true)
    })
    box.appendChild(el('p', 'hint', t('core.aboutNoNetwork')))
  }
}

function applyFilter(root: HTMLElement, query: string, showAdvanced: boolean): void {
  const q = query.trim().toLowerCase()
  let anyVisible = false
  for (const section of root.querySelectorAll<HTMLElement>('section')) {
    let visible = 0
    for (const row of section.querySelectorAll<HTMLElement>('.row.setting')) {
      const advancedHidden = row.dataset['advanced'] === 'true' && !showAdvanced
      const matches = q === '' || (row.dataset['search'] ?? '').includes(q)
      row.hidden = advancedHidden || !matches
      if (!row.hidden) visible++
    }
    // With a query typed, prose blocks and contributed sections are noise.
    const proseOnly = section.querySelectorAll('.row.setting').length === 0
    section.hidden = q !== '' && (proseOnly || visible === 0)
    if (!section.hidden) anyVisible = true
  }
  const empty = root.querySelector<HTMLElement>('.settings-empty')
  if (empty) empty.hidden = anyVisible
}

async function render(root: HTMLElement): Promise<void> {
  root.textContent = ''

  const toolbar = el('div', 'settings-toolbar')
  const search = el('input')
  search.type = 'search'
  search.placeholder = t('core.settingsSearch')
  search.setAttribute('aria-label', t('core.settingsSearch'))
  const advWrap = el('label')
  const adv = el('input')
  adv.type = 'checkbox'
  advWrap.append(adv, document.createTextNode(t('core.settingsAdvanced')))
  toolbar.append(search, advWrap)
  root.appendChild(toolbar)

  for (const section of SECTIONS) renderSection(section, root)
  root.appendChild(el('p', 'settings-empty', t('core.settingsNoResults')))

  const refilter = (): void => applyFilter(root, search.value, adv.checked)
  search.addEventListener('input', refilter)
  adv.addEventListener('change', refilter)
  refilter()
}

function renderFooter(): HTMLElement {
  const footer = el('footer')
  const reset = el('button', 'btn danger', t('core.reset'))
  reset.type = 'button'
  reset.addEventListener('click', async () => {
    rows = (await bridge.invoke('core-settings:reset')) as SettingRow[]
    const root = document.getElementById('settingsRoot')
    if (root) await render(root)
  })
  const close = el('button', 'btn primary', t('core.close'))
  close.type = 'button'
  close.addEventListener('click', () => api.settings.close())
  footer.append(reset, close)
  return footer
}

/**
 * Boot the settings window. Called once from `src/renderer/src/settings.ts`.
 *
 * `loadFeatures` is passed in rather than imported so this file stays free of
 * `import.meta.glob` and can be reasoned about (and, where it matters, tested)
 * on its own.
 */
export async function bootSettingsWindow(loadFeatures: () => void): Promise<void> {
  const root = document.getElementById('settingsRoot')
  if (!root) throw new Error('missing #settingsRoot')
  formRoot = root

  await fetchMessages((ch) => bridge.invoke(ch))

  // Modules register their settingsSection()s and settingsComponent()s during
  // setup, so they must be loaded BEFORE the first render.
  loadFeatures()

  rows = (await bridge.invoke('core-settings:list')) as SettingRow[]
  await render(root)
  document.body.appendChild(renderFooter())
  document.title = t('core.settingsTitle')

  // A module that registers late (an async setup) still gets rendered.
  onContributionsChanged(() => void render(root))
}
