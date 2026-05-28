import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { default: fs.promises }
})
vi.mock('fs', async () => {
  const { fs } = await import('memfs')
  return { default: fs }
})

import { MoodEngine } from '../electron/mood-engine'
import type { SystemStats } from '../src-shared/types'
import { DEFAULT_PARAMS } from '../electron/pet-traits'

const normalStats: SystemStats = {
  cpu: 20, ramUsed: 4e9, ramTotal: 16e9, diskUsed: 50,
  claudeRunning: false, codexRunning: false,
}

const heavyStats: SystemStats = {
  cpu: 92, ramUsed: 15e9, ramTotal: 16e9, diskUsed: 90,
  claudeRunning: true, codexRunning: true,
}

beforeEach(async () => {
  const { vol } = await import('memfs')
  vol.reset()
  // Mock current hour to 14 (afternoon) so time-based mood doesn't interfere
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 4, 26, 14, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MoodEngine', () => {
  it('starts with calm mood and default values', () => {
    const engine = new MoodEngine('/mood')
    const state = engine.getMoodState()
    expect(state.mood).toBe('calm')
    expect(state.energy).toBe(80)
    expect(state.affection).toBe(30)
    expect(state.streak).toBe(0)
  })

  it('tick returns lonely for fresh engine with no interactions', () => {
    const engine = new MoodEngine('/mood')
    // Default: lastInteraction=0, so hoursSince=999 → lonely during waking hours
    const mood = engine.tick(normalStats)
    expect(mood).toBe('lonely')
  })

  it('tick returns happy after recent interaction with good stats', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    const mood = engine.tick(normalStats)
    expect(mood).toBe('happy')
  })

  it('onInteraction(chat) increases affection and energy', () => {
    const engine = new MoodEngine('/mood')
    const before = engine.getMoodState()
    engine.onInteraction('chat')
    const after = engine.getMoodState()
    // First chat also triggers the "hoursSince > 2" bonus (+5)
    expect(after.affection).toBe(before.affection + 2 + 5)
    expect(after.energy).toBe(Math.min(100, before.energy + 3))
    expect(after.lastInteraction).toBeGreaterThan(0)
    expect(after.streak).toBe(1)
  })

  it('onInteraction(feedback_pos) gives big affection boost', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('feedback_pos')
    const state = engine.getMoodState()
    expect(state.affection).toBe(38) // 30 + 8
  })

  it('onInteraction(feedback_neg) reduces affection', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('feedback_neg')
    const state = engine.getMoodState()
    expect(state.affection).toBe(27) // 30 - 3
  })

  it('onInteraction(task_fail) drains energy', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('task_fail')
    const state = engine.getMoodState()
    expect(state.energy).toBe(70) // 80 - 10
  })

  it('tick returns worried when system is overloaded', () => {
    const engine = new MoodEngine('/mood')
    // Need some recent interaction to avoid lonely override
    engine.onInteraction('chat')
    const mood = engine.tick(heavyStats)
    expect(mood).toBe('worried')
  })

  it('computeMood returns excited when affection is very high and recent interaction', () => {
    const engine = new MoodEngine('/mood')
    // Pump up affection
    for (let i = 0; i < 25; i++) engine.onInteraction('feedback_pos')
    const state = engine.getMoodState()
    expect(state.affection).toBeGreaterThan(70)
    // Recent interaction + good stats → excited
    const mood = engine.tick(normalStats)
    expect(mood).toBe('excited')
  })

  it('buildMoodContext produces descriptive text', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    engine.tick(normalStats)
    const ctx = engine.buildMoodContext()
    expect(ctx).toContain('情绪状态')
    expect(ctx).toContain('体力')
    expect(ctx).toContain('关系')
  })

  it('toAnimState maps moods correctly', () => {
    const engine = new MoodEngine('/mood')
    // Default calm → idle
    expect(engine.toAnimState()).toBe('idle')
  })

  it('persists and loads state', async () => {
    const engine1 = new MoodEngine('/mood')
    engine1.onInteraction('feedback_pos')
    engine1.onInteraction('feedback_pos')
    await engine1.save()

    const engine2 = new MoodEngine('/mood')
    const state = engine2.getMoodState()
    expect(state.affection).toBeGreaterThan(30)
    expect(state.lastInteraction).toBeGreaterThan(0)
  })

  it('streak increments on consecutive days', () => {
    const engine = new MoodEngine('/mood')
    // First interaction
    engine.onInteraction('chat')
    expect(engine.getMoodState().streak).toBe(1)

    // Simulate "yesterday" by setting lastInteraction to 25 hours ago
    const state = engine.getMoodState()
    state.lastInteraction = Date.now() - 25 * 3600_000
    // Directly patch internal state for test
    ;(engine as unknown as { state: typeof state }).state = state

    engine.onInteraction('chat')
    expect(engine.getMoodState().streak).toBe(2)
  })

  it('streak resets after 2+ days gap', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    const state = engine.getMoodState()
    state.lastInteraction = Date.now() - 3 * 86_400_000
    ;(engine as unknown as { state: typeof state }).state = state

    engine.onInteraction('chat')
    expect(engine.getMoodState().streak).toBe(1)
  })

  // ─── Evolution / XP tests ───

  it('starts at baby stage with 0 XP', () => {
    const engine = new MoodEngine('/mood')
    expect(engine.getStage()).toBe('baby')
    expect(engine.getMoodState().xp).toBe(0)
  })

  it('addXp increases XP and returns null when no evolution', () => {
    const engine = new MoodEngine('/mood')
    const result = engine.addXp(10)
    expect(result).toBeNull()
    expect(engine.getMoodState().xp).toBe(10)
  })

  it('addXp triggers evolution to child at 100 XP', () => {
    const engine = new MoodEngine('/mood')
    const evolved = engine.addXp(100)
    expect(evolved).toBe('child')
    expect(engine.getStage()).toBe('child')
  })

  it('addXp triggers evolution to teen at 300 XP', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(300)
    expect(engine.getStage()).toBe('teen')
  })

  it('addXp triggers evolution to adult at 700 XP', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(700)
    expect(engine.getStage()).toBe('adult')
  })

  it('addXp triggers evolution to elder at 1500 XP', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(1500)
    expect(engine.getStage()).toBe('elder')
  })

  it('XP never goes below 0', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(-100)
    expect(engine.getMoodState().xp).toBe(0)
    expect(engine.getStage()).toBe('baby')  // no devolution
  })

  it('onInteraction(chat) does NOT award XP (XP is learning-driven)', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    expect(engine.getMoodState().xp).toBe(0) // no XP for chatting
  })

  it('onInteraction(feedback_pos) does NOT award XP (XP is learning-driven)', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('feedback_pos')
    expect(engine.getMoodState().xp).toBe(0)
  })

  it('onInteraction(feedback_neg) deducts XP', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(10)
    engine.onInteraction('feedback_neg')
    expect(engine.getMoodState().xp).toBe(9) // 10 - 1
  })

  it('onInteraction(task_fail) deducts XP', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(5)
    engine.onInteraction('task_fail')
    expect(engine.getMoodState().xp).toBe(3) // 5 - 2
  })

  it('addXp awards learning milestone XP directly', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(15, 'playbook_created')
    expect(engine.getMoodState().xp).toBe(15)
    engine.addXp(8, 'fact_remembered')
    expect(engine.getMoodState().xp).toBe(23)
  })

  it('stageForXp returns correct stages', () => {
    expect(MoodEngine.stageForXp(0)).toBe('baby')
    expect(MoodEngine.stageForXp(99)).toBe('baby')
    expect(MoodEngine.stageForXp(100)).toBe('child')
    expect(MoodEngine.stageForXp(299)).toBe('child')
    expect(MoodEngine.stageForXp(300)).toBe('teen')
    expect(MoodEngine.stageForXp(699)).toBe('teen')
    expect(MoodEngine.stageForXp(700)).toBe('adult')
    expect(MoodEngine.stageForXp(1499)).toBe('adult')
    expect(MoodEngine.stageForXp(1500)).toBe('elder')
    expect(MoodEngine.stageForXp(9999)).toBe('elder')
  })

  it('evolve callback fires on stage change', () => {
    const engine = new MoodEngine('/mood')
    const cb = vi.fn()
    engine.setEvolveCallback(cb)
    engine.addXp(100)
    expect(cb).toHaveBeenCalledWith('child', 'baby')
  })

  it('evolve callback does not fire when XP increases without stage change', () => {
    const engine = new MoodEngine('/mood')
    const cb = vi.fn()
    engine.setEvolveCallback(cb)
    engine.addXp(50)
    expect(cb).not.toHaveBeenCalled()
  })

  it('evolution is irreversible — XP drop cannot cause devolution', () => {
    const engine = new MoodEngine('/mood')
    engine.addXp(150)  // child (100)
    expect(engine.getStage()).toBe('child')
    engine.addXp(-200)  // XP goes to 0
    expect(engine.getStage()).toBe('child')  // still child, no devolution
  })

  it('getStageConfig returns correct config for each stage', () => {
    const engine = new MoodEngine('/mood')
    const cfg = engine.getStageConfig()
    expect(cfg.label).toBe('幼崽')
    expect(cfg.personality).toContain('好奇')
  })

  it('buildMoodContext includes stage info', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    engine.tick(normalStats)
    const ctx = engine.buildMoodContext()
    expect(ctx).toContain('成长阶段')
    expect(ctx).toContain('幼崽')
  })

  // ─── setParams tests ───

  it('setParams respects custom lonelyHoursThreshold', () => {
    const engine = new MoodEngine('/mood')
    engine.onInteraction('chat')
    // At this point, lastInteraction is now. Set it 1.5h ago.
    const state = (engine as unknown as { state: typeof engine.getMoodState() }).state
    state.lastInteraction = Date.now() - 1.5 * 3_600_000

    // Default threshold=2h: 1.5h gap does NOT trigger lonely
    engine.setParams(DEFAULT_PARAMS)
    expect(engine.tick(normalStats)).not.toBe('lonely')

    // Reset lastInteraction to 1.5h ago (tick mutated energy but not lastInteraction for lonely check)
    state.lastInteraction = Date.now() - 1.5 * 3_600_000

    // Threshold=1h: 1.5h gap DOES trigger lonely (during waking hours, which this test is)
    engine.setParams({ ...DEFAULT_PARAMS, lonelyHoursThreshold: 1 })
    const result = engine.tick(normalStats)
    // Only assert if we're in waking hours (the test runs at 14:00 via vi.setSystemTime)
    expect(result).toBe('lonely')
  })

  it('setParams respects custom energyRecoveryChat', () => {
    const engine = new MoodEngine('/mood')
    const before = engine.getMoodState()
    engine.setParams({ ...DEFAULT_PARAMS, energyRecoveryChat: 8 })
    engine.onInteraction('chat')
    const after = engine.getMoodState()
    expect(after.energy).toBe(Math.min(100, before.energy + 8))
  })
})
