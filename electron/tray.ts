import { app, Menu, nativeImage, Tray } from 'electron'
import path from 'path'
import type { WindowManager } from './windows'

export class TrayManager {
  private tray: Tray | null = null
  private readonly onFloatVisibilityChanged = (): void => this.refresh()

  constructor(
    private wm: WindowManager,
    private assetsDir: string
  ) {}

  create(): void {
    if (this.tray) return

    const icon = this.loadIcon()
    this.tray = new Tray(icon)
    this.tray.setToolTip('Mote')
    this.wm.on('float-visibility-changed', this.onFloatVisibilityChanged)
    this.refresh()
    console.log('[tray] menu bar icon created')
  }

  refresh(): void {
    if (!this.tray) return
    const petVisible = this.wm.isFloatVisible()
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: petVisible ? '隐藏宠物' : '显示宠物', click: () => petVisible ? this.wm.hideFloat() : this.wm.showFloat() },
      { label: '打开聊天', click: () => this.wm.openPanel() },
      { label: '打开设置', click: () => this.wm.openSettings() },
      { type: 'separator' },
      { label: '退出 Mote', click: () => app.quit() },
    ]))
  }

  destroy(): void {
    this.wm.off('float-visibility-changed', this.onFloatVisibilityChanged)
    this.tray?.destroy()
    this.tray = null
  }

  private loadIcon(): Electron.NativeImage {
    const generated = nativeImage.createFromDataURL(
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
          <path fill="black" d="M9 2.1c3.1 0 5.7 2.3 5.7 5.1 0 1.9-1.2 3.6-3 4.5l.6 2.2c.1.4-.3.7-.6.5l-2.3-1.3H9c-3.1 0-5.7-2.3-5.7-5.1S5.9 2.1 9 2.1Z"/>
          <circle cx="6.8" cy="7.6" r="1.1" fill="white"/>
          <circle cx="11.2" cy="7.6" r="1.1" fill="white"/>
          <path d="M6.8 10c1.3 1 3.1 1 4.4 0" fill="none" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      `)
    )
    if (!generated.isEmpty()) {
      generated.setTemplateImage(true)
      return generated
    }

    const candidates = [
      path.join(this.assetsDir, 'iconTemplate.png'),
      path.join(this.assetsDir, 'icon.png'),
    ]
    for (const p of candidates) {
      const icon = nativeImage.createFromPath(p)
      if (!icon.isEmpty()) {
        icon.setTemplateImage(true)
        return icon.resize({ width: 18, height: 18 })
      }
    }
    return nativeImage.createEmpty()
  }
}
