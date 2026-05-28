import { execFile } from 'child_process'
import { promisify } from 'util'
import type { NotificationEvent } from '@shared/types'
import {
  getNotificationEventLabel,
  NOTIFICATION_SOURCES,
  type NotificationSourceKey,
} from '@shared/notification-sources'

const exec = promisify(execFile)

const TARGETS = Object.fromEntries(
  NOTIFICATION_SOURCES
    .filter(s => s.key === 'wechat' || s.key === 'wework')
    .map(s => [s.label, s.key])
) as Record<string, Extract<NotificationSourceKey, 'wechat' | 'wework'>>

const RATE_LIMIT_MS = 30_000
const POLL_MS = 3_000

const SCRIPT = `
tell application "System Events"
  tell process "Dock"
    set out to ""
    repeat with itm in (UI elements of list 1)
      try
        set nm to name of itm
        set bdg to value of attribute "AXStatusLabel" of itm
        if bdg is not missing value then
          set out to out & nm & "\t" & bdg & linefeed
        end if
      end try
    end repeat
    return out
  end tell
end tell
`

export class NotificationWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastCount = new Map<Extract<NotificationSourceKey, 'wechat' | 'wework'>, number>()
  private lastShown = new Map<Extract<NotificationSourceKey, 'wechat' | 'wework'>, number>()

  constructor(
    private onEvent: (ev: NotificationEvent) => void,
    private onClear?: (source: Extract<NotificationSourceKey, 'wechat' | 'wework'>) => void
  ) {}

  async start(): Promise<void> {
    console.log('[notif] watcher starting (dock-badge mode)')
    try {
      const initial = await this.readBadges()
      for (const [src, n] of initial) this.lastCount.set(src, n)
      console.log('[notif] initial badge counts:', Object.fromEntries(initial))
    } catch (err) {
      console.error('[notif] initial read failed:', err)
    }
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[notif] tick error:', err))
    }, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async readBadges(): Promise<Map<Extract<NotificationSourceKey, 'wechat' | 'wework'>, number>> {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', SCRIPT])
    const map = new Map<Extract<NotificationSourceKey, 'wechat' | 'wework'>, number>()
    for (const line of stdout.split('\n')) {
      const [name, val] = line.split('\t')
      if (!name || !val) continue
      const source = TARGETS[name.trim()]
      if (!source) continue
      const n = parseInt(val.trim(), 10)
      map.set(source, isNaN(n) ? 0 : n)
    }
    for (const src of Object.values(TARGETS)) {
      if (!map.has(src)) map.set(src, 0)
    }
    return map
  }

  private async tick(): Promise<void> {
    const cur = await this.readBadges()
    for (const [src, n] of cur) {
      const prev = this.lastCount.get(src) ?? 0
      if (n > prev) {
        const now = Date.now()
        const last = this.lastShown.get(src) ?? 0
        if (now - last >= RATE_LIMIT_MS) {
          this.lastShown.set(src, now)
          console.log(`[notif] ${src} badge ${prev} -> ${n}, emit`)
          this.onEvent({ source: src, label: getNotificationEventLabel(src) ?? src, timestamp: now })
        } else {
          console.log(`[notif] ${src} badge ${prev} -> ${n}, rate-limited`)
        }
      } else if (n === 0 && prev > 0) {
        console.log(`[notif] ${src} badge cleared (${prev} -> 0)`)
        this.onClear?.(src)
      }
      this.lastCount.set(src, n)
    }
  }
}
