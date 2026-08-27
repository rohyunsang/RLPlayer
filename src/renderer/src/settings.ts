import './settings.css'
import type { AppConfig } from '@shared/types'

const api = window.rlplayer

const $ = <T extends HTMLElement>(id: string): T => {
  const n = document.getElementById(id)
  if (!n) throw new Error(`missing #${id}`)
  return n as T
}

const resumePlayback = $<HTMLInputElement>('resumePlayback')
const hwdec = $<HTMLSelectElement>('hwdec')
const audioDevice = $<HTMLSelectElement>('audioDevice')
const volumeBoostLimiter = $<HTMLInputElement>('volumeBoostLimiter')
const autoLoadSubs = $<HTMLInputElement>('autoLoadSubs')
const subAssOverride = $<HTMLInputElement>('subAssOverride')
const subScale = $<HTMLInputElement>('subScale')
const subScaleOut = $<HTMLOutputElement>('subScaleOut')
const keybindPreset = $<HTMLSelectElement>('keybindPreset')
const screenshotDir = $<HTMLInputElement>('screenshotDir')
const layoutMode = $<HTMLSelectElement>('layoutMode')
const vo = $<HTMLSelectElement>('vo')

let config: AppConfig | null = null
/** Guards the change handlers while we populate controls from config. */
let loading = false

function apply(cfg: AppConfig): void {
  loading = true
  config = cfg
  resumePlayback.checked = cfg.resumePlayback
  hwdec.value = cfg.hwdec
  volumeBoostLimiter.checked = cfg.volumeBoostLimiter
  autoLoadSubs.checked = cfg.autoLoadSubs
  subAssOverride.checked = cfg.subAssOverride
  subScale.value = String(cfg.subScale)
  subScaleOut.textContent = `${cfg.subScale.toFixed(2)}×`
  keybindPreset.value = cfg.keybindPreset
  screenshotDir.value = cfg.screenshotDir
  layoutMode.value = cfg.layoutMode
  vo.value = cfg.vo
  loading = false
}

async function patch(p: Partial<AppConfig>): Promise<void> {
  if (loading) return
  config = await api.config.set(p)
}

resumePlayback.addEventListener('change', () => void patch({ resumePlayback: resumePlayback.checked }))
hwdec.addEventListener('change', () => void patch({ hwdec: hwdec.value }))
volumeBoostLimiter.addEventListener('change', () =>
  void patch({ volumeBoostLimiter: volumeBoostLimiter.checked })
)
autoLoadSubs.addEventListener('change', () => void patch({ autoLoadSubs: autoLoadSubs.checked }))
subAssOverride.addEventListener('change', () => void patch({ subAssOverride: subAssOverride.checked }))
subScale.addEventListener('input', () => {
  const v = Number(subScale.value)
  subScaleOut.textContent = `${v.toFixed(2)}×`
  void patch({ subScale: v })
})
keybindPreset.addEventListener('change', () =>
  void patch({ keybindPreset: keybindPreset.value as AppConfig['keybindPreset'] })
)
audioDevice.addEventListener('change', () => void patch({ audioDevice: audioDevice.value }))

$('pickDir').addEventListener('click', async () => {
  const dir = await api.system.chooseScreenshotDir()
  if (dir === null) return
  screenshotDir.value = dir
  await patch({ screenshotDir: dir })
})

layoutMode.addEventListener('change', () =>
  void patch({ layoutMode: layoutMode.value as AppConfig['layoutMode'] })
)
vo.addEventListener('change', () => void patch({ vo: vo.value }))
$('relaunch').addEventListener('click', () => api.system.relaunch())

$('openDefaults').addEventListener('click', () => api.system.openDefaultAppsSettings())
$('openConfig').addEventListener('click', () => api.system.openConfigFolder())
$('close').addEventListener('click', () => api.settings.close())
$('reset').addEventListener('click', async () => {
  apply(await api.config.reset())
})

async function init(): Promise<void> {
  apply(await api.config.get())

  const [devices, info] = await Promise.all([api.system.audioDevices(), api.system.info()])
  audioDevice.textContent = ''
  for (const d of devices.length > 0 ? devices : [{ name: 'auto', description: '자동' }]) {
    const opt = document.createElement('option')
    opt.value = d.name
    opt.textContent = d.description
    audioDevice.appendChild(opt)
  }
  audioDevice.value = config?.audioDevice ?? 'auto'

  $('version').textContent = info.version
  $('mode').textContent = info.portable ? '휴대용 (exe 옆에 설정 저장)' : '설치형'
  $('configPath').textContent = info.configPath
  $('cfgPath').textContent = info.configPath
  $('mpvPath').textContent = info.mpv
}

void init()
