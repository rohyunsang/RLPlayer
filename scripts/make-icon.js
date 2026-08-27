/**
 * Renders build/icon.ico from an inline SVG, using Electron itself as the
 * rasteriser so the build needs no image dependencies.
 *
 *   npm run make:icon
 *
 * The .ico embeds PNG entries at every size Windows asks for (16..256), which
 * Vista and later accept directly. electron-builder requires a 256px entry.
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const OUT_DIR = path.join(__dirname, '..', 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#6fa9ff"/>
      <stop offset="1" stop-color="#2f6fd0"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="224" height="224" rx="52" fill="url(#bg)"/>
  <rect x="16" y="16" width="224" height="224" rx="52" fill="url(#gloss)"/>
  <path d="M104 84 L180 128 L104 172 Z" fill="#ffffff" stroke="#ffffff"
        stroke-width="18" stroke-linejoin="round"/>
</svg>`

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;overflow:hidden}
  svg{display:block}
</style></head><body>${SVG}</body></html>`

/** Pack PNG buffers into a Windows .ico container. */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length

  entries.forEach(({ size, buf }, i) => {
    const e = 16 * i
    // 0 means 256 in the ICO directory format.
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2) // palette entries
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(buf.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)])
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  // Give the compositor a beat to paint the gradient before capturing.
  await new Promise((r) => setTimeout(r, 400))

  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })
  if (shot.isEmpty()) throw new Error('capturePage returned an empty image')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), shot.toPNG())

  const entries = SIZES.map((size) => ({
    size,
    buf: size === 256 ? shot.toPNG() : shot.resize({ width: size, height: size }).toPNG()
  }))
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries))

  console.log(`[make-icon] wrote build/icon.ico (${SIZES.join(', ')}) and build/icon.png`)
  app.quit()
}).catch((e) => {
  console.error('[make-icon] failed:', e)
  process.exit(1)
})
