import { dialog } from 'electron'
import { getDialogParent } from './window/windows'
import { t } from './i18n/index.ts'
import type { DialogService } from '@shared/feature-api'

/**
 * core/dialog — §3.3.8. WAVE 0 — FROZEN.
 *
 * M22, M28 and M40 all need a picker. `paths` was on FeatureContext and
 * `dialog` was not, so each would have imported Electron directly — at which
 * point FeatureContext is no longer "the whole surface a module is allowed to
 * touch", which is the claim §3.3 makes.
 *
 * Parenting is the service's job: in overlay layout the dialog must belong to
 * the OVERLAY window. Parent it to the video window and it opens *behind* the
 * video, which looks exactly like a hang.
 */
export function createDialogService(): DialogService {
  return {
    async openFiles(o): Promise<string[]> {
      const parent = getDialogParent()
      if (!parent) return []
      const res = await dialog.showOpenDialog(parent, {
        title: t(o.titleKey),
        defaultPath: o.defaultPath,
        filters: o.filters,
        properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile']
      })
      return res.canceled ? [] : res.filePaths
    },
    async openDirectory(o): Promise<string[]> {
      const parent = getDialogParent()
      if (!parent) return []
      const res = await dialog.showOpenDialog(parent, {
        title: t(o.titleKey),
        defaultPath: o.defaultPath,
        properties: o.multi
          ? ['openDirectory', 'multiSelections', 'createDirectory']
          : ['openDirectory', 'createDirectory']
      })
      return res.canceled ? [] : res.filePaths
    },
    async saveFile(o): Promise<string | null> {
      const parent = getDialogParent()
      if (!parent) return null
      const res = await dialog.showSaveDialog(parent, {
        title: t(o.titleKey),
        defaultPath: o.defaultPath,
        filters: o.filters
      })
      return res.canceled ? null : (res.filePath ?? null)
    },
    async confirm(o): Promise<boolean> {
      const parent = getDialogParent()
      if (!parent) return false
      const res = await dialog.showMessageBox(parent, {
        type: o.destructive ? 'warning' : 'question',
        title: t(o.titleKey),
        message: t(o.messageKey, o.params),
        buttons: [t(o.confirmKey), t('core.cancel')],
        // A destructive action must never be the button Enter presses.
        defaultId: o.destructive ? 1 : 0,
        cancelId: 1
      })
      return res.response === 0
    }
  }
}
