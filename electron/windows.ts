import { BrowserWindow, screen, app, Menu, nativeImage } from 'electron'
import { EventEmitter } from 'events'
import path from 'path'
import { normalizeNotificationSourceLabel } from '@shared/notification-sources'

const appIconPath = path.join(__dirname, '../../assets/icon.png')
let appIcon: Electron.NativeImage | null = null
try {
  appIcon = nativeImage.createFromPath(appIconPath)
} catch { /* icon may not exist in dev */ }

export class WindowManager extends EventEmitter {
  float:    BrowserWindow | null = null
  panel:    BrowserWindow | null = null
  settings: BrowserWindow | null = null
  notificationsMuted = false

  private preloadPath: string
  private panelHideTimer: NodeJS.Timeout | null = null
  private unreadItems: { label: string; ts: number }[] = []
  private getSourceKey: ((label: string) => string) | null = null
  private isSourceEnabled: (() => Record<string, boolean>) | null = null

  constructor(opts?: { getSourceKey?: (label: string) => string; isSourceEnabled?: () => Record<string, boolean> }) {
    super()
    this.preloadPath = path.join(__dirname, '../preload/index.js')
    this.getSourceKey = opts?.getSourceKey ?? null
    this.isSourceEnabled = opts?.isSourceEnabled ?? null
  }

  addUnread(label: string): void {
    const now = Date.now()
    const recent = this.unreadItems.find(i => i.label === label && now - i.ts < 10_000)
    if (recent) return
    this.unreadItems.push({ label, ts: now })
    if (this.unreadItems.length > 50) this.unreadItems = this.unreadItems.slice(-50)
    this.broadcastNotification()
  }

  clearUnread(): void {
    this.unreadItems = []
    this.broadcast('notification:clear', {})
  }

  clearSource(label: string): void {
    this.unreadItems = this.unreadItems.filter(i => i.label !== label)
    this.broadcastNotification()
  }

  private broadcastNotification(): void {
    const count = this.unreadItems.length
    const items = this.unreadItems.slice(-10)
    this.broadcast('notification:unread', { count, items })
  }

  createFloat(): BrowserWindow {
    if (this.float && !this.float.isDestroyed()) return this.float

    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    const float = new BrowserWindow({
      width: 280, height: 240,
      x: width - 140, y: height - 250,
      transparent: true, frame: false,
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false, hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.float = float

    float.on('show', () => this.emitFloatVisibilityChanged())
    float.on('hide', () => this.emitFloatVisibilityChanged())
    float.on('closed', () => {
      if (this.float === float) this.float = null
      this.emitFloatVisibilityChanged()
    })

    float.webContents.on('context-menu', () => {
      Menu.buildFromTemplate([
        { label: '打开设置', click: () => { if (!this.settings) this.createSettings(); this.settings?.show() } },
        { label: '隐藏宠物', click: () => this.hideFloat() },
        { label: '开发者工具', click: () => float.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ]).popup({ window: float })
    })

    float.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[float-renderer] ${message}`)
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      float.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/float/index.html')
    } else {
      float.loadFile(path.join(__dirname, '../renderer/float/index.html'))
    }
    return float
  }

  createPanel(): BrowserWindow {
    const [fx, fy] = this.float?.getPosition() ?? [100, 100]
    this.panel = new BrowserWindow({
      width: 480, height: 600,
      x: fx + 110, y: Math.max(0, fy - 200),
      frame: false, transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    if (process.env['ELECTRON_RENDERER_URL']) {
      this.panel.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/panel/index.html')
    } else {
      this.panel.loadFile(path.join(__dirname, '../renderer/panel/index.html'))
    }
    this.panel.on('closed', () => { this.panel = null })
    // Hide on blur (click outside panel) after a short delay so clicking
    // back into the panel cancels the hide.
    this.panel.on('blur', () => {
      this.panelHideTimer = setTimeout(() => this.panel?.hide(), 200)
    })
    this.panel.on('focus', () => {
      if (this.panelHideTimer) { clearTimeout(this.panelHideTimer); this.panelHideTimer = null }
    })
    this.panel.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[panel-renderer] ${message}`)
    })
    this.panel.webContents.on('context-menu', () => {
      Menu.buildFromTemplate([
        { label: '开发者工具', click: () => this.panel?.webContents.openDevTools({ mode: 'detach' }) }
      ]).popup({ window: this.panel! })
    })
    return this.panel
  }

  createSettings(): BrowserWindow {
    this.settings = new BrowserWindow({
      width: 720, height: 560,
      frame: true, alwaysOnTop: false,
      ...(appIcon ? { icon: appIcon } : {}),
      title: 'Mote Settings',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    if (process.env['ELECTRON_RENDERER_URL']) {
      this.settings.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/settings/index.html')
    } else {
      this.settings.loadFile(path.join(__dirname, '../renderer/settings/index.html'))
    }
    this.settings.on('closed', () => { this.settings = null })
    return this.settings
  }

  togglePanel(): void {
    if (!this.panel || this.panel.isDestroyed()) {
      this.createPanel()
    }
    if (this.panel!.isVisible()) {
      this.panel!.hide()
    } else {
      this.repositionPanel()
      this.panel!.show()
    }
  }

  openPanel(): void {
    if (!this.panel || this.panel.isDestroyed()) this.createPanel()
    this.repositionPanel()
    this.panel!.show()
  }

  openSettings(): void {
    if (!this.settings || this.settings.isDestroyed()) this.createSettings()
    this.settings?.show()
  }

  isFloatVisible(): boolean {
    return Boolean(this.float && !this.float.isDestroyed() && this.float.isVisible())
  }

  showFloat(): void {
    const win = this.createFloat()
    if (win.isMinimized()) win.restore()
    win.setAlwaysOnTop(true)
    win.show()
    win.moveTop()
    this.emitFloatVisibilityChanged()
  }

  hideFloat(): void {
    if (this.panel && !this.panel.isDestroyed()) this.panel.hide()
    if (!this.float || this.float.isDestroyed()) {
      this.emitFloatVisibilityChanged()
      return
    }
    this.float.hide()
    this.emitFloatVisibilityChanged()
  }

  toggleFloat(): void {
    if (this.isFloatVisible()) this.hideFloat()
    else this.showFloat()
  }

  repositionPanel(): void {
    if (!this.float || !this.panel) return
    const [fx, fy] = this.float.getPosition()
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const pw = 480
    const ph = 600
    const x = (fx + 110 + pw < sw) ? fx + 110 : fx - pw - 10
    const y = Math.min(Math.max(0, fy - 200), sh - ph)
    this.panel.setPosition(x, y)
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.float, this.panel, this.settings]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  showBubble(payload: unknown): void {
    if (this.notificationsMuted) return
    const p = payload as { label?: string; source?: string }
    const shortName = normalizeNotificationSourceLabel(p)
    // Check if this source is enabled
    if (this.getSourceKey && this.isSourceEnabled) {
      const key = this.getSourceKey(shortName)
      const enabled = this.isSourceEnabled()
      if (key && enabled[key] === false) return
    }
    this.addUnread(shortName)
  }

  private emitFloatVisibilityChanged(): void {
    this.emit('float-visibility-changed', this.isFloatVisible())
  }
}
