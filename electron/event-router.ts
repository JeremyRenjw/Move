import type { NotifyEvent, NotifyEventName, NotifyToolName, EventKind, SessionInfo } from '../src-shared/types'
import type { SessionRegistry } from './session-registry'
import type { PetAggregator } from './pet-aggregator'
import { nextState } from './pet-state-machine'

const DEBOUNCE_MS = 10_000
const RECENT_MAX  = 20
const ERROR_RX    = /\b(error|failed|fatal|exception|panic)\b/i

interface RouterDeps {
  showBubble: (label: string, source: string) => void
  onEvent?:   (ev: NotifyEvent) => void
  registry:   SessionRegistry
  aggregator: PetAggregator
}

interface TemplateKey { event: NotifyEventName; tool: NotifyToolName | '*' }

const TEMPLATES: Array<{ key: TemplateKey; render: (ev: NotifyEvent) => string | null }> = [
  { key: { event: 'SessionStart', tool: '*' },          render: () => null /* never bubble */ },
  { key: { event: 'Error',        tool: '*' },          render: ev => `⚠️ ${ev.tool} 报错了` },
  { key: { event: 'Stop',         tool: 'claude' },     render: () => 'Claude 跑完啦，回来看看吧～' },
  { key: { event: 'Stop',         tool: 'codex' },      render: () => 'Codex 完成了～' },
  { key: { event: 'Stop',         tool: 'test' },       render: () => '✓ 测试事件已收到' },
  { key: { event: 'Notification', tool: 'claude' },     render: () => 'Claude 在叫你（可能要 y/n）' },
  { key: { event: 'Notification', tool: 'codex' },      render: () => 'Codex 在叫你' },
  { key: { event: 'PermissionRequest', tool: '*' },     render: ev => `${ev.tool} 等你授权` },
]

export class EventRouter {
  private lastSent  = new Map<string, number>()
  private recentBuf: NotifyEvent[] = []
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: RouterDeps) {
    // Prune stale sessions every 60s
    this.pruneTimer = setInterval(() => {
      const removed = this.deps.registry.pruneStale()
      if (removed.length > 0) {
        console.log(`[event-router] pruned ${removed.length} stale sessions`)
        this.deps.aggregator.recompute()
      }
    }, 60_000)
  }

  stop(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null }
  }

  handle(ev: NotifyEvent & { eventKind?: EventKind }): void {
    this.deps.onEvent?.(ev)

    // Push into recent buffer (newest first)
    this.recentBuf.unshift(ev)
    if (this.recentBuf.length > RECENT_MAX) this.recentBuf.length = RECENT_MAX

    // ─── State machine path: if we have a sessionId and eventKind, drive the FSM ───
    const eventKind = ev.eventKind ?? this.deriveEventKind(ev)
    const sessionId = ev.sessionId

    if (sessionId && eventKind) {
      this.handleWithStateMachine(sessionId, ev.tool, ev.cwd, eventKind, ev.ts, ev.payload)
    }

    // ─── Bubble path: backward-compatible bubble logic ───
    const effective = this.classify(ev)
    const tpl = TEMPLATES.find(t =>
      t.key.event === effective.event &&
      (t.key.tool === '*' || t.key.tool === effective.tool)
    )
    if (!tpl) return
    const label = tpl.render(effective)
    if (label === null) return

    const key = `${effective.tool}|${effective.event}|${effective.cwd}`
    const now = Date.now()
    const last = this.lastSent.get(key) ?? 0
    if (now - last < DEBOUNCE_MS) return
    this.lastSent.set(key, now)

    this.deps.showBubble(label, `notify:${effective.tool}`)
  }

  private handleWithStateMachine(
    sessionId: string,
    tool: NotifyToolName,
    cwd: string,
    eventKind: EventKind,
    ts: number,
    payload?: Record<string, unknown>
  ): void {
    const { registry, aggregator } = this.deps
    const now = ts * 1000 // ts is unix seconds, convert to ms

    // Ensure session exists
    if (!registry.session(sessionId)) {
      registry.upsert(sessionId, tool, cwd, now)
    } else {
      registry.patch(sessionId, s => {
        s.lastActivityAt = now
        if (cwd) s.cwd = cwd
      })
    }

    // Session end → remove
    if (eventKind === 'session_end') {
      registry.remove(sessionId)
      aggregator.recompute()
      return
    }

    // Run state machine
    const current = registry.session(sessionId)?.currentState ?? 'idle'
    const next = nextState(current, eventKind)
    if (next) {
      registry.transition(sessionId, next, now)

      // Update session title from user_prompt payload
      if (eventKind === 'user_prompt' && payload?.prompt) {
        const prompt = String(payload.prompt)
        registry.patch(sessionId, s => { s.title = prompt.slice(0, 32) })
      }
    }

    aggregator.recompute()
  }

  private deriveEventKind(ev: NotifyEvent): EventKind | null {
    switch (ev.event) {
      case 'SessionStart': return 'session_start'
      case 'Stop':         return ev.extra?.exitCode !== 0 ? 'error' : 'stop'
      case 'Notification': return typeof ev.extra?.message === 'string' && ERROR_RX.test(ev.extra.message)
        ? 'error' : 'notification'
      case 'PermissionRequest': return 'permission_ask'
      default: return null
    }
  }

  recent(): NotifyEvent[] { return [...this.recentBuf] }

  private classify(ev: NotifyEvent): NotifyEvent {
    if (ev.event === 'Stop' && typeof ev.extra?.exitCode === 'number' && ev.extra.exitCode !== 0) {
      return { ...ev, event: 'Error' }
    }
    if (ev.event === 'Notification' && typeof ev.extra?.message === 'string' && ERROR_RX.test(ev.extra.message)) {
      return { ...ev, event: 'Error' }
    }
    return ev
  }
}
