import type { AiEngine } from './ai'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { WindowManager } from './windows'
import type { MoodEngine } from './mood-engine'
import type { TraitLearner } from './trait-learner'
import type { SystemStats } from '../src-shared/types'
import { IPC } from '../src-shared/types'

// Local copy to avoid importing from ai.ts (Task 2.1 adds reflect() there in parallel)
export interface ReflectorDecision {
  action:  'silent' | 'propose'
  bubble?: string
  detail?: string
}

interface ReflectorDeps {
  ai:            AiEngine
  events:        EventStore
  facts:         FactStore
  wm:            WindowManager
  mood:          MoodEngine
  traitLearner?: TraitLearner
  getStats:      () => SystemStats
  getPersona:    () => Promise<string>
  getActivePetId: () => string | null
}

const TICK_MS = 20 * 60_000  // 20 minutes

export class Reflector {
  private timer: NodeJS.Timeout | null = null

  constructor(private deps: ReflectorDeps) {}

  /** Start periodic reflector ticks */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[reflector] periodic tick failed:', err))
    }, TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'

    // 1. Get recent 30min events
    const now = Date.now()
    const recentEvents = await this.deps.events.range(petId, now - 30 * 60_000, now)

    // 2. If no new events, skip (save API calls)
    if (recentEvents.length === 0) return

    // 3. Get top facts
    const facts = await this.deps.facts.list(petId, { minConfidence: 0.5, limit: 30 })

    // 4. Get system stats
    const stats = this.deps.getStats()

    // 5. Update mood and get context
    const mood = this.deps.mood.tick(stats)
    const moodContext = this.deps.mood.buildMoodContext()

    // Broadcast mood + stage to float window for animation
    const stage = this.deps.mood.getStage()
    this.deps.wm.broadcast(IPC.MOOD_CHANGED, { mood, stage })

    // 6. Ask AI
    const decision: ReflectorDecision = await this.deps.ai.reflect({
      recentEvents: recentEvents.map(e => ({ type: e.type, source: e.source, data: e.data, ts: e.ts })),
      facts: facts.map(f => ({ type: f.type, content: f.content, confidence: f.confidence })),
      stats,
      petPersona: await this.deps.getPersona(),
      moodContext,
    }).catch(err => {
      console.error('[reflector] ai.reflect failed:', err)
      return { action: 'silent' as const }
    })

    // 6. Record reflector_tick event
    await this.deps.events.append(petId, {
      type: 'reflector_tick',
      source: 'reflector',
      data: { decision, eventsCount: recentEvents.length }
    }).catch(err => console.error('[reflector] event append failed:', err))

    // 7. If propose, queue bubble
    if (decision.action === 'propose' && decision.bubble) {
      this.deps.wm.showBubble({
        source: 'watcher',
        label: decision.bubble,
        timestamp: now
      })
    }

    // 8. Record behavioral signals
    const hasChat = recentEvents.some(e => e.type === 'chat_turn')
    if (!hasChat) {
      this.deps.traitLearner?.record('chat_sparse', 0.3)
    }
    const hour = new Date().getHours()
    if (hour >= 0 && hour < 6 && recentEvents.length > 0) {
      this.deps.traitLearner?.record('late_night', 0.5)
    }

    // 9. Daily trait learning pass
    await this.deps.traitLearner?.learn(petId)
  }
}
