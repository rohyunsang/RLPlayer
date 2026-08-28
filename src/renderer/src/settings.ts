import { bootSettingsWindow } from './core/settings-form.ts'
import { loadRendererFeatures } from './core'

/**
 * The settings window entry point, and deliberately nothing else.
 *
 * This file used to be 108 lines of `hwdec.addEventListener(...)`,
 * `subScale.addEventListener(...)`, one handler per setting, and it collided
 * with five separate modules at once. It is now a stub: the form is GENERATED
 * from the descriptors modules register (`src/renderer/src/core/settings-form.ts`),
 * and the same feature glob the overlay uses runs here too, so a module's
 * `ctx.settingsSection()` and `ctx.settingsComponent()` reach this window
 * without anyone editing it.
 *
 * If you are adding a setting and find yourself here, stop: the change belongs
 * in your own module's `ctx.settings.define()`.
 */
void bootSettingsWindow(() => loadRendererFeatures('settings'))
