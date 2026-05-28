import type { AiEngine } from './ai'
import type { ApiConfig, WatcherNote, WatcherStatus } from '@shared/types'

interface WatchOptions {
  command: string
  apiConfig: ApiConfig
  apiKey: string
  onLine: (line: string) => void
  onNote: (note: WatcherNote) => void
  intervalMs?: number
  maxLines?: number
}

interface WatchHandle {
  pushLine: (line: string) => void
  finish: () => void
}

export class CliWatcher {
  constructor(private ai: AiEngine) {}

  start(opts: WatchOptions): WatchHandle {
    const intervalMs = opts.intervalMs ?? 8000
    const maxLines = opts.maxLines ?? 60
    const start = Date.now()
    const buffer: string[] = []
    let newSinceTick = 0
    let lastStatus: WatcherStatus = 'ok'
    let lastNoteAt = 0
    let finished = false

    const tick = async (): Promise<void> => {
      if (finished) return
      const hadNew = newSinceTick > 0
      newSinceTick = 0
      const elapsedSec = Math.round((Date.now() - start) / 1000)
      const judgement = await this.ai.judge({
        apiConfig: opts.apiConfig,
        apiKey: opts.apiKey,
        command: opts.command,
        elapsedSec,
        recentLines: buffer.slice(-30),
        hadNewOutput: hadNew
      })
      if (!judgement) return

      // De-noise: only notify on status change or when non-ok persists.
      // Never re-notify 'ok' — it's just noise.
      const now = Date.now()
      const repeated = judgement.status === lastStatus
      const stale = now - lastNoteAt > 30_000
      if (judgement.status !== 'ok' && (!repeated || stale)) {
        opts.onNote({ status: judgement.status, note: judgement.note, timestamp: now })
        lastNoteAt = now
      } else if (!repeated && judgement.status === 'ok' && lastStatus !== 'ok') {
        // Recovered from error → notify once
        opts.onNote({ status: judgement.status, note: judgement.note, timestamp: now })
        lastNoteAt = now
      }
      lastStatus = judgement.status
    }

    const timer = setInterval(() => { tick().catch(err => console.error('[watcher] tick error:', err)) }, intervalMs)

    return {
      pushLine: (line: string) => {
        buffer.push(line)
        if (buffer.length > maxLines) buffer.splice(0, buffer.length - maxLines)
        newSinceTick++
        opts.onLine(line)
      },
      finish: () => {
        finished = true
        clearInterval(timer)
      }
    }
  }
}
