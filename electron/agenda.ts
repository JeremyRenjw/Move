import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import type { AiEngine, PlanAgendaResult } from './ai'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { MoodEngine } from './mood-engine'
import type { CharacterConfigStore } from './character'
import type { PetGoal, SystemStats, DriveParams, PetEvent } from '../src-shared/types'

const MAX_QUEUE_SIZE = 20
const COMPACT_THRESHOLD_LINES = 500

const DEFAULT_TIMINGS = {
  heartbeatMs:  25 * 60_000,
  debounceMs:   5_000,
  throttleMs:   3 * 60_000,
  llmTimeoutMs: 30_000,
}

export interface PendingGoal extends PetGoal {
  notBefore: number
  expiresAt: number
  reason:    string
  createdAt: number
}

export interface AgendaDeps {
  ai:             AiEngine
  events:         EventStore
  facts:          FactStore
  mood:           MoodEngine
  chars:          CharacterConfigStore
  getStats:       () => SystemStats
  getPersona:     () => Promise<string>
  getActivePetId: () => string | null
  getParams:      () => DriveParams
  dataDir:        string
  timings?: {
    heartbeatMs?: number
    debounceMs?: number
    throttleMs?: number
    llmTimeoutMs?: number
  }
}

export class Agenda {
  private goals: PendingGoal[] = []
  private inflight = false
  private lastTickAt = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private timings: typeof DEFAULT_TIMINGS

  constructor(private deps: AgendaDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
  }

  private agendaFile(petId: string): string {
    return path.join(this.deps.dataDir, 'pets', petId, 'agenda.jsonl')
  }

  async loadFromDisk(): Promise<void> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    const file = this.agendaFile(petId)
    if (!fsSync.existsSync(file)) return
    const raw = await fs.readFile(file, 'utf-8')
    const byId = new Map<string, PendingGoal>()
    for (const line of raw.split('\n')) {
      if (!line) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type === 'add' && rec.goal && typeof rec.goal.id === 'string') {
        byId.set(rec.goal.id, rec.goal as PendingGoal)
      } else if (rec.type === 'consume' && typeof rec.id === 'string') {
        byId.delete(rec.id)
      }
    }
    const now = Date.now()
    this.goals = [...byId.values()].filter(g => now < g.expiresAt)
  }

  private async appendRecord(petId: string, rec: object): Promise<void> {
    const file = this.agendaFile(petId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf-8')
  }

  private async compactIfNeeded(petId: string): Promise<void> {
    const file = this.agendaFile(petId)
    if (!fsSync.existsSync(file)) return
    const raw = await fs.readFile(file, 'utf-8')
    const lineCount = raw.split('\n').filter(Boolean).length
    if (lineCount < COMPACT_THRESHOLD_LINES) return
    const snapshot = this.goals.filter(g => Date.now() < g.expiresAt)
    const body = snapshot.map(g => JSON.stringify({ type: 'add', goal: g })).join('\n')
    await fs.writeFile(file, body ? body + '\n' : '', 'utf-8')
  }

  /** Test hook. */
  async compactIfNeededForTest(): Promise<void> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    await this.compactIfNeeded(petId)
  }

  /** Testing-only injection. */
  injectForTest(goals: PendingGoal[]): void {
    this.goals = [...goals]
  }

  start(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      this.tick('idle').catch(err => console.error('[agenda] heartbeat tick failed:', err))
    }, this.timings.heartbeatMs)
    this.heartbeat.unref()
  }

  async tick(reason: 'idle' | 'event'): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    const petId = this.deps.getActivePetId() ?? 'stlulu'

    try {
      const apiKey    = await this.deps.chars.getApiKey().catch(() => '')
      const apiConfig = await this.deps.chars.getApiConfig().catch(() => null)
      if (!apiKey || !apiConfig) return    // safety net: silently degrade

      const startMs = Date.now()
      const now = Date.now()
      const [recentEvents, todayTimeline, topFacts, persona] = await Promise.all([
        this.deps.events.range(petId, now - 30 * 60_000, now).catch(() => []),
        this.deps.events.range(petId, now - 24 * 3600_000, now).catch(() => []),
        this.deps.facts.list(petId, { minConfidence: 0.5, limit: 20 }).catch(() => []),
        this.deps.getPersona().catch(() => ''),
      ])

      const stats       = this.deps.getStats()
      const moodContext = this.deps.mood.buildMoodContext()
      const existing    = this.goals
        .filter(g => now < g.expiresAt)
        .map(g => ({ kind: g.kind, reason: g.reason }))

      const signal = AbortSignal.timeout(this.timings.llmTimeoutMs)
      const result = await this.deps.ai.planAgenda({
        apiConfig,
        apiKey,
        petPersona:    persona,
        moodContext,
        stats,
        recentEvents:  recentEvents.map(e => ({ type: e.type, source: e.source, data: e.data, ts: e.ts })),
        todayTimeline: todayTimeline.map(e => ({ type: e.type, source: e.source, ts: e.ts })),
        topFacts:      topFacts.map(f => ({ type: f.type, content: f.content, confidence: f.confidence })),
        recentBubbles: [],   // wired in a later task; empty for now
        existingGoals: existing,
        signal,
      })

      const afterNow = Date.now()
      for (const g of result.goals) {
        const pending: PendingGoal = {
          id:          randomUUID(),
          kind:        g.kind,
          priority:    g.priority,
          action:      g.kind === 'system_check' ? 'agent_task' : 'bubble',
          bubble:      g.bubble,
          agentGoal:   g.agentGoal,
          cooldownKey: g.kind,
          source:      'agenda',
          notBefore:   afterNow + g.delayMinutes * 60_000,
          expiresAt:   afterNow + g.ttlMinutes * 60_000,
          reason:      g.reason,
          createdAt:   afterNow,
        }
        this.goals.push(pending)
        await this.appendRecord(petId, { type: 'add', goal: pending }).catch(err => console.error('[agenda] append failed:', err))
      }

      // Cap memory queue.
      const queueLenBefore = this.goals.length
      if (this.goals.length > MAX_QUEUE_SIZE) {
        this.goals.sort((a, b) => b.priority - a.priority)
        this.goals = this.goals.slice(0, MAX_QUEUE_SIZE)
      }
      const goalsAccepted = this.goals.length - queueLenBefore
      await this.compactIfNeeded(petId).catch(err => console.error('[agenda] compaction failed:', err))

      await this.deps.events.append(petId, {
        type:   'agenda_tick',
        source: 'reflector',
        data:   {
          reason,
          goalsProposed: result.goals.length,
          goalsAccepted,
          llmMs:         Date.now() - startMs,
          silentReason:  result.silentReason ?? null,
        },
      }).catch(err => console.error('[agenda] event append failed:', err))

      this.lastTickAt = afterNow
    } finally {
      this.inflight = false
    }
  }

  onEvent(_kind: 'hook' | 'chat' | 'task'): void {
    const now = Date.now()
    if (now - this.lastTickAt < this.timings.throttleMs) return  // throttled
    if (this.debounceTimer) return                                // already queued
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.tick('event').catch(err => console.error('[agenda] event tick failed:', err))
    }, this.timings.debounceMs)
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.heartbeat = null
    this.debounceTimer = null
  }

  peek(now: number): PetGoal[] {
    const active = this.goals
      .filter(g => now >= g.notBefore && now < g.expiresAt)
      .sort((a, b) => b.priority - a.priority)
    return active.map(g => ({
      id:          g.id,
      kind:        g.kind,
      priority:    g.priority,
      action:      g.action,
      bubble:      g.bubble,
      agentGoal:   g.agentGoal,
      cooldownKey: g.cooldownKey,
      source:      'agenda',
    }))
  }

  consume(id: string): void {
    const before = this.goals.length
    this.goals = this.goals.filter(g => g.id !== id)
    if (this.goals.length === before) return  // no actual removal
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    this.appendRecord(petId, { type: 'consume', id, ts: Date.now() }).catch(err => console.error('[agenda] consume append failed:', err))
  }
}
