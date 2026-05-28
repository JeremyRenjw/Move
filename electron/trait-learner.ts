import fs from 'fs/promises'
import path from 'path'
import type { PetTraits } from '@shared/types'
import type { CharacterConfigStore } from './character'
import type { PetManager } from './pets'
import type { MoodEngine } from './mood-engine'

// ─── Types ───

export type SignalKind =
  | 'greet_engaged'   // user opened notification quickly
  | 'greet_ignored'   // notification sat unread >10min
  | 'feedback_pos'    // user gave positive feedback
  | 'feedback_neg'    // user gave negative feedback
  | 'chat_active'     // user chatted >5 times today
  | 'chat_sparse'     // user barely chatted today
  | 'late_night'      // user active 0-6am
  | 'tool_heavy'      // user used many tools in chat

export interface TraitSignal {
  kind: SignalKind
  weight: number   // 0-1, strength of this signal
  ts: number
}

export interface TraitAdjustment {
  date: string
  axis: keyof PetTraits
  delta: number       // signed change applied
  reason: string      // human-readable
}

// ─── Config ───

const LEARNING_RATE = 0.02     // max trait change per axis per day
const DECAY_RATE = 0.005       // drift toward 0.5 when no signals
const TRAIT_MIN = 0.1
const TRAIT_MAX = 0.9
const LOG_FILE = 'learning-log.jsonl'

// Signal → trait direction weights
// Each entry: [axis, direction multiplier]
const SIGNAL_MAP: Record<SignalKind, [keyof PetTraits, number][]> = {
  greet_engaged: [['sociability', 1]],
  greet_ignored: [['sociability', -1]],
  feedback_pos:  [['sociability', 0.5], ['playfulness', 0.5]],
  feedback_neg:  [['independence', 0.5]],
  chat_active:   [['sociability', 0.5]],
  chat_sparse:   [['independence', 0.5]],
  late_night:    [['energy_volatility', 1]],
  tool_heavy:    [['playfulness', 1]],
}

const AXIS_LABEL: Record<keyof PetTraits, string> = {
  sociability: '社交性', independence: '独立性',
  playfulness: '玩心', energy_volatility: '活力波动',
}

// ─── TraitLearner ───

export class TraitLearner {
  private signals: TraitSignal[] = []
  private lastLearnDate = ''
  private logPath: string

  constructor(
    private deps: {
      chars: CharacterConfigStore
      pets: PetManager
      mood: MoodEngine
    },
    memoryRoot: string,
  ) {
    this.logPath = path.join(memoryRoot, LOG_FILE)
  }

  /** Record an interaction signal (called from IPC handlers). */
  record(kind: SignalKind, weight = 1): void {
    this.signals.push({ kind, weight: Math.max(0, Math.min(1, weight)), ts: Date.now() })
    // Cap buffer at 500 signals to avoid unbounded growth
    if (this.signals.length > 500) {
      this.signals = this.signals.slice(-300)
    }
  }

  /** Daily learning pass — called from reflector.tick(). Idempotent per calendar day. */
  async learn(petId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    if (this.lastLearnDate === today) return
    this.lastLearnDate = today

    const now = Date.now()
    const dayAgo = now - 24 * 60 * 60 * 1000
    const recent = this.signals.filter(s => s.ts >= dayAgo)

    // Aggregate signals into per-axis deltas
    const deltas: Record<keyof PetTraits, number> = {
      sociability: 0, independence: 0, playfulness: 0, energy_volatility: 0,
    }

    for (const sig of recent) {
      const mapping = SIGNAL_MAP[sig.kind]
      for (const [axis, direction] of mapping) {
        deltas[axis] += sig.weight * direction
      }
    }

    // Apply learning rate: scale aggregated deltas, clamp to ±LEARNING_RATE
    const adjustments: TraitAdjustment[] = []
    const axes: (keyof PetTraits)[] = ['sociability', 'independence', 'playfulness', 'energy_volatility']

    for (const axis of axes) {
      let delta = deltas[axis] * LEARNING_RATE
      // Clamp per-day change
      delta = Math.max(-LEARNING_RATE, Math.min(LEARNING_RATE, delta))

      // Decay toward 0.5 when no signals for this axis
      if (Math.abs(deltas[axis]) < 0.01) {
        delta = -DECAY_RATE * Math.sign(0)  // will be handled below
        delta = 0  // no signal → decay handled separately
      }

      if (Math.abs(delta) > 0.0001) {
        adjustments.push({
          date: today,
          axis,
          delta: Math.round(delta * 10000) / 10000,
          reason: this.buildReason(axis, deltas[axis] > 0, recent),
        })
      }
    }

    // Decay axes with no signals toward 0.5
    for (const axis of axes) {
      if (Math.abs(deltas[axis]) < 0.01) {
        adjustments.push({
          date: today,
          axis,
          delta: 0,  // placeholder, actual delta computed from current value
          reason: '无信号，缓慢回归中性',
        })
      }
    }

    if (adjustments.length === 0) return

    // Apply to character config
    await this.applyAdjustments(petId, adjustments)

    // Trim old signals
    this.signals = this.signals.filter(s => s.ts >= dayAgo)
  }

  private buildReason(axis: keyof PetTraits, positive: boolean, signals: TraitSignal[]): string {
    const label = AXIS_LABEL[axis]
    const arrow = positive ? '↑' : '↓'
    // Find dominant signal kind
    const kindCounts = new Map<string, number>()
    for (const s of signals) {
      kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + s.weight)
    }
    const dominant = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    const reasonMap: Record<string, string> = {
      greet_engaged: '你经常点开打招呼通知',
      greet_ignored: '你不太关注打招呼通知',
      feedback_pos: '你给了正面反馈',
      feedback_neg: '你给了负面反馈',
      chat_active: '你聊天很频繁',
      chat_sparse: '你最近聊天较少',
      late_night: '你经常深夜活跃',
      tool_heavy: '你大量使用工具',
    }
    const why = dominant ? reasonMap[dominant[0]] ?? dominant[0] : '综合行为'
    return `${label} ${arrow} · ${why}`
  }

  private async applyAdjustments(petId: string, adjustments: TraitAdjustment[]): Promise<void> {
    const cfg = await this.deps.chars.get(petId)
    const current = cfg.traitsOverride ?? {}

    // Compute new override values
    const newOverride: Partial<PetTraits> = { ...current }
    for (const adj of adjustments) {
      if (adj.reason === '无信号，缓慢回归中性') {
        // Decay toward 0.5
        const cur = newOverride[adj.axis] ?? 0.5
        const decay = -DECAY_RATE * Math.sign(cur - 0.5)
        const next = Math.max(TRAIT_MIN, Math.min(TRAIT_MAX, cur + decay))
        adj.delta = Math.round((next - cur) * 10000) / 10000
        if (Math.abs(adj.delta) < 0.001) continue
        newOverride[adj.axis] = Math.round(next * 10000) / 10000
      } else {
        const cur = newOverride[adj.axis] ?? 0.5
        const next = Math.max(TRAIT_MIN, Math.min(TRAIT_MAX, cur + adj.delta))
        newOverride[adj.axis] = Math.round(next * 10000) / 10000
      }
    }

    // Save
    const updated: CharacterConfig = { ...cfg, traitsOverride: newOverride }
    await this.deps.chars.save(updated)

    // Hot-reload params if this is the active pet
    if (petId === this.deps.pets.getActiveId()) {
      const params = await this.deps.pets.resolveParams(petId, this.deps.chars)
      this.deps.mood.setParams(params)
    }

    // Append to learning log
    const entries = adjustments.filter(a => Math.abs(a.delta) > 0.0001)
    if (entries.length > 0) {
      const lines = entries.map(a => JSON.stringify(a)).join('\n') + '\n'
      await fs.appendFile(this.logPath, lines, 'utf-8').catch(() => {})
    }
  }

  /** Read learning history for UI display. */
  async getLog(days: number): Promise<TraitAdjustment[]> {
    try {
      const raw = await fs.readFile(this.logPath, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days)
      const cutoffStr = cutoff.toISOString().slice(0, 10)
      return lines
        .map(l => JSON.parse(l) as TraitAdjustment)
        .filter(a => a.date >= cutoffStr)
    } catch {
      return []
    }
  }
}

// Import CharacterConfig type for the save call
import type { CharacterConfig } from '@shared/types'
