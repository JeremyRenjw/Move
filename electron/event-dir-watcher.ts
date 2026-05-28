import * as fs from 'node:fs'
import * as path from 'node:path'
import type { NotifyEvent, EventKind } from '@shared/types'

/** Map new EventKind values to legacy NotifyEventName for backward compatibility */
const KIND_TO_NOTIFY: Record<string, NotifyEvent['event']> = {
  session_start: 'SessionStart',
  session_end: 'Stop',
  stop: 'Stop',
  error: 'Stop',
  notification: 'Notification',
  permission_ask: 'PermissionRequest',
  permission_resolved: 'PermissionRequest',
  user_prompt: 'SessionStart',
  pre_tool_use: 'SessionStart',
  post_tool_use: 'SessionStart',
  thinking_start: 'SessionStart',
  ask_user: 'Notification',
  ask_user_resolved: 'Notification',
}

export class EventDirWatcher {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private dir: string,
    private handler: (ev: NotifyEvent & { eventKind?: EventKind }) => void,
    private intervalMs = 100
  ) {}

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    this.scanExisting()
    if (this.timer) return
    this.timer = setInterval(() => this.scanPending(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Write a synthetic event file (used by test-event IPC). */
  writeEvent(ev: NotifyEvent): void {
    const file = path.join(this.dir, `${Date.now()}-test-${Math.random().toString(36).slice(2, 8)}.json`)
    fs.writeFileSync(file, JSON.stringify(ev))
  }

  private scanExisting(): void {
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).sort()
      for (const f of files) this.processFile(path.join(this.dir, f))
    } catch { /* dir may not exist yet */ }
  }

  private scanPending(): void {
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
      for (const f of files) this.processFile(path.join(this.dir, f))
    } catch { /* ignore */ }
  }

  private processFile(filePath: string): void {
    let shouldUnlink = true

    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      if (!text.trim()) {
        // The writer may still be creating this file; keep it for a later scan.
        shouldUnlink = false
        return
      }

      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(text) as Record<string, unknown>
      } catch (err) {
        if (err instanceof SyntaxError && String(err.message).includes('Unexpected end of JSON input')) {
          // Another process can briefly expose a partially-written JSON file.
          // Do not log or delete it yet; the next scan will retry once writing finishes.
          shouldUnlink = false
          return
        }
        throw err
      }

      // New enriched format: { event: EventKind, sessionId, payload, ... }
      const eventKind = raw.event as EventKind | undefined
      const sessionId = raw.sessionId as string | undefined
      const payload = raw.payload as Record<string, unknown> | undefined

      // Legacy format: { event: NotifyEventName, tool, ... }
      const tool = raw.tool as string | undefined
      const cwd = (raw.cwd as string) ?? process.cwd()
      const ts = (raw.ts as number) ?? Math.floor(Date.now() / 1000)

      if (!eventKind || !tool) return

      // Determine NotifyEventName: if it's already a legacy name, use it; otherwise map
      const isLegacyName = ['Stop', 'Notification', 'PermissionRequest', 'SessionStart', 'Error'].includes(eventKind)
      const notifyEvent = isLegacyName
        ? (eventKind as NotifyEvent['event'])
        : (KIND_TO_NOTIFY[eventKind] ?? 'SessionStart')

      const ev: NotifyEvent & { eventKind?: EventKind } = {
        event: notifyEvent,
        tool: tool as NotifyEvent['tool'],
        cwd,
        ts,
        sessionId,
        payload,
        extra: payload,
        eventKind: isLegacyName ? undefined : eventKind,
      }

      this.handler(ev)
    } catch (err) {
      console.error('[event-dir] bad file:', filePath, err)
    } finally {
      if (shouldUnlink) {
        try { fs.unlinkSync(filePath) } catch { /* already gone */ }
      }
    }
  }
}
