import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PetGoal, PetMood, SystemStats } from '../src-shared/types'

// DriveEngine doesn't import fs, so we don't need memfs mocks.
// We test via the exported evaluate() and dedup() methods.

import { DriveEngine } from '../electron/drive-engine'
import type { DriveDeps } from '../electron/drive-engine'
import { traitsToParams, DEFAULT_PARAMS } from '../electron/pet-traits'

const normalStats: SystemStats = {
  cpu: 20, ramUsed: 4e9, ramTotal: 16e9, diskUsed: 50,
  claudeRunning: false, codexRunning: false,
}

const heavyStats: SystemStats = {
  cpu: 92, ramUsed: 15e9, ramTotal: 16e9, diskUsed: 90,
  claudeRunning: true, codexRunning: true,
}

function makeDeps(overrides?: Partial<{
  mood: { tick: () => PetMood; getEnergy: () => number; getAffection: () => number; getStreak: () => number; getHoursSinceInteraction: () => number; isWakingHours: () => boolean; onInteraction: (k: string) => void; buildMoodContext: () => string }
  ai: DriveDeps['ai']
  chars: DriveDeps['chars']
  factStore: DriveDeps['factStore']
  getPersona: DriveDeps['getPersona']
}>): DriveDeps {
  const defaultMood = {
    tick: () => 'calm' as PetMood,
    getEnergy: () => 80,
    getAffection: () => 50,
    getStreak: () => 0,
    getHoursSinceInteraction: () => 0.5,
    isWakingHours: () => true,
    onInteraction: vi.fn(),
    buildMoodContext: () => 'calm',
  }
  return {
    mood: (overrides?.mood ?? defaultMood) as DriveDeps['mood'],
    wm: {
      showBubble: vi.fn(),
      broadcast: vi.fn(),
    } as unknown as DriveDeps['wm'],
    agentScheduler: {
      executeOneShot: vi.fn().mockResolvedValue('done'),
    } as unknown as DriveDeps['agentScheduler'],
    events: {
      range: vi.fn().mockResolvedValue([]),
    } as unknown as DriveDeps['events'],
    getStats: () => normalStats,
    getActivePetId: () => 'stlulu',
    getParams: () => DEFAULT_PARAMS,
    ai: overrides?.ai,
    chars: overrides?.chars,
    factStore: overrides?.factStore,
    getPersona: overrides?.getPersona,
  }
}

function llmDeps(generateBubble: (...args: unknown[]) => Promise<string | null>) {
  return {
    ai: { generateBubble: vi.fn(generateBubble) } as unknown as DriveDeps['ai'],
    chars: {
      getApiConfig: vi.fn().mockResolvedValue({ provider: 'openai', model: 'm', baseUrl: '' }),
      getApiKey: vi.fn().mockResolvedValue('test-key'),
    } as unknown as DriveDeps['chars'],
    factStore: {
      list: vi.fn().mockResolvedValue([]),
    } as unknown as DriveDeps['factStore'],
    getPersona: vi.fn().mockResolvedValue('test-persona'),
  }
}

describe('DriveEngine.evaluate', () => {
  it('returns empty goals for healthy state', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'happy', energy: 80, affection: 60, streak: 1,
      hoursSince: 0.5, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals).toEqual([])
  })

  it('produces greet goal when affection low + long absence + waking', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'calm', energy: 80, affection: 20, streak: 0,
      hoursSince: 3, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'greet')).toBe(true)
    const greet = goals.find(g => g.kind === 'greet')!
    expect(greet.action).toBe('bubble')
    expect(greet.priority).toBe(80)
  })

  it('produces comfort goal when lonely', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'lonely', energy: 80, affection: 50, streak: 1,
      hoursSince: 3, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'comfort')).toBe(true)
  })

  it('produces remind_rest when low energy + not waking hours', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'tired', energy: 20, affection: 50, streak: 1,
      hoursSince: 1, waking: false, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'remind_rest')).toBe(true)
    expect(goals.find(g => g.kind === 'remind_rest')!.action).toBe('bubble')
  })

  it('produces system_check agent_task when worried + high CPU', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'worried', energy: 80, affection: 50, streak: 1,
      hoursSince: 0.5, waking: true, stats: heavyStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'system_check')).toBe(true)
    const check = goals.find(g => g.kind === 'system_check')!
    expect(check.action).toBe('agent_task')
    expect(check.agentGoal).toBeTruthy()
  })

  it('produces celebrate on streak milestone', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'happy', energy: 80, affection: 60, streak: 6,
      hoursSince: 0.1, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'celebrate')).toBe(true)
  })

  it('does not celebrate on non-multiple-of-3 streak', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'happy', energy: 80, affection: 60, streak: 4,
      hoursSince: 0.1, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'celebrate')).toBe(false)
  })

  it('produces curiosity when excited + high affection', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'excited', energy: 80, affection: 85, streak: 5,
      hoursSince: 0.2, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    expect(goals.some(g => g.kind === 'curiosity')).toBe(true)
  })

  it('produces check_in when long absence + waking + decent affection', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'calm', energy: 80, affection: 50, streak: 1,
      hoursSince: 5, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(),
    })
    // Should have check_in but NOT greet (affection >= 30)
    expect(goals.some(g => g.kind === 'check_in')).toBe(true)
    expect(goals.some(g => g.kind === 'greet')).toBe(false)
  })

  it('sorts goals by priority descending', () => {
    const engine = new DriveEngine(makeDeps())
    const goals = engine.evaluate({
      mood: 'lonely', energy: 20, affection: 20, streak: 6,
      hoursSince: 0.1, waking: false, stats: heavyStats,
      hasEvents: false, now: Date.now(),
    })
    for (let i = 1; i < goals.length; i++) {
      expect(goals[i - 1].priority).toBeGreaterThanOrEqual(goals[i].priority)
    }
  })
})

describe('DriveEngine.dedup', () => {
  it('passes through goals with no cooldown', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
    ]
    expect(engine.dedup(goals, Date.now())).toHaveLength(1)
  })

  it('filters goals within cooldown window', () => {
    const engine = new DriveEngine(makeDeps())
    const now = Date.now()
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
    ]
    // First tick — passes
    expect(engine.dedup(goals, now)).toHaveLength(1)
    // Simulate cooldown being set (as tick() would do)
    ;(engine as any).cooldowns.set('greet', now)
    // Second tick immediately — blocked
    expect(engine.dedup(goals, now + 1000)).toHaveLength(0)
    // After cooldown expires — passes again
    expect(engine.dedup(goals, now + 30 * 60_000 + 1)).toHaveLength(1)
  })

  it('different cooldown keys are independent', () => {
    const engine = new DriveEngine(makeDeps())
    const now = Date.now()
    ;(engine as any).cooldowns.set('greet', now)
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
      { id: '2', kind: 'comfort', priority: 75, action: 'bubble', bubble: 'miss you', cooldownKey: 'comfort' },
    ]
    const filtered = engine.dedup(goals, now + 1000)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].kind).toBe('comfort')
  })
})

describe('DriveEngine.tick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 26, 14, 0, 0))
  })

  it('shows bubble for greet goal', async () => {
    const deps = makeDeps({
      mood: {
        tick: () => 'calm',
        getEnergy: () => 80,
        getAffection: () => 20,
        getStreak: () => 0,
        getHoursSinceInteraction: () => 3,
        isWakingHours: () => true,
        onInteraction: vi.fn(),
        buildMoodContext: () => 'calm',
      },
    })
    const engine = new DriveEngine(deps)
    await engine.tick()

    expect(deps.wm.showBubble).toHaveBeenCalled()
    const call = (deps.wm.showBubble as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.source).toBe('watcher')
    expect(typeof call.label).toBe('string')
    expect(deps.mood.onInteraction).toHaveBeenCalledWith('chat')
  })

  it('calls executeOneShot for agent_task goals', async () => {
    const deps = makeDeps({
      mood: {
        tick: () => 'worried',
        getEnergy: () => 80,
        getAffection: () => 50,
        getStreak: (): number => 1,
        getHoursSinceInteraction: () => 0.5,
        isWakingHours: () => true,
        onInteraction: vi.fn(),
        buildMoodContext: () => 'worried',
      },
    })
    // Override stats to be heavy
    deps.getStats = () => heavyStats
    const engine = new DriveEngine(deps)
    await engine.tick()

    expect(deps.agentScheduler.executeOneShot).toHaveBeenCalled()
    expect(deps.mood.onInteraction).toHaveBeenCalledWith('task_ok')
  })

  it('does nothing when no goals pass cooldown', async () => {
    const deps = makeDeps()
    const engine = new DriveEngine(deps)
    // Normal state → no goals
    await engine.tick()
    expect(deps.wm.showBubble).not.toHaveBeenCalled()
    expect(deps.agentScheduler.executeOneShot).not.toHaveBeenCalled()
  })

  const lonelyMoodDeps = () => ({
    mood: {
      tick: () => 'lonely' as PetMood,
      getEnergy: () => 80,
      getAffection: () => 50,
      getStreak: () => 1,
      getHoursSinceInteraction: () => 3,
      isWakingHours: () => true,
      onInteraction: vi.fn(),
      buildMoodContext: () => 'lonely',
    },
  })

  it('falls back to pool when ai dep is missing', async () => {
    const deps = makeDeps(lonelyMoodDeps())
    const engine = new DriveEngine(deps)
    await engine.tick()
    const call = (deps.wm.showBubble as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(typeof call.label).toBe('string')
    expect(call.label.length).toBeGreaterThan(0)
    expect(call.label).not.toBe('UNIQUE_LLM_LINE_XYZ')
  })

  it('uses LLM text when ai.generateBubble resolves', async () => {
    const deps = makeDeps({
      ...lonelyMoodDeps(),
      ...llmDeps(async () => 'UNIQUE_LLM_LINE_XYZ'),
    })
    const engine = new DriveEngine(deps)
    await engine.tick()
    const call = (deps.wm.showBubble as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.label).toBe('UNIQUE_LLM_LINE_XYZ')
    expect((deps.ai!.generateBubble as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
  })

  it('falls back to pool when ai.generateBubble throws', async () => {
    const deps = makeDeps({
      ...lonelyMoodDeps(),
      ...llmDeps(async () => { throw new Error('network down') }),
    })
    const engine = new DriveEngine(deps)
    await engine.tick()
    const call = (deps.wm.showBubble as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(typeof call.label).toBe('string')
    expect(call.label.length).toBeGreaterThan(0)
    expect(call.label).not.toBe('UNIQUE_LLM_LINE_XYZ')
  })
})

describe('DriveEngine mood multipliers', () => {
  it('lonely mood boosts greet and comfort priority', () => {
    const engine = new DriveEngine(makeDeps())
    const baseGoals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
      { id: '2', kind: 'comfort', priority: 75, action: 'bubble', bubble: 'miss', cooldownKey: 'comfort' },
      { id: '3', kind: 'check_in', priority: 35, action: 'bubble', bubble: 'hey', cooldownKey: 'check_in' },
    ]
    const modified = engine.applyModifiers(baseGoals, 'lonely', 80)
    const greet = modified.find(g => g.kind === 'greet')!
    const comfort = modified.find(g => g.kind === 'comfort')!
    const checkIn = modified.find(g => g.kind === 'check_in')!
    expect(greet.priority).toBe(120)   // 80 * 1.5
    expect(comfort.priority).toBe(113) // Math.round(75 * 1.5)
    expect(checkIn.priority).toBe(46)  // Math.round(35 * 1.3)
  })

  it('tired mood suppresses system_check priority', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'system_check', priority: 65, action: 'agent_task', agentGoal: 'check', cooldownKey: 'system_check' },
    ]
    const modified = engine.applyModifiers(goals, 'tired', 80)
    expect(modified[0].priority).toBe(46) // Math.round(65 * 0.7)
  })

  it('calm mood has no multiplier effect', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
    ]
    const modified = engine.applyModifiers(goals, 'calm', 80)
    expect(modified[0].priority).toBe(80) // unchanged
  })
})

describe('DriveEngine feedback', () => {
  it('starts at neutral feedback score of 1.0', () => {
    const engine = new DriveEngine(makeDeps())
    expect(engine.getFeedbackScore('greet')).toBe(1.0)
  })

  it('positive feedback increases score', () => {
    const engine = new DriveEngine(makeDeps())
    engine.feedbackPositive('greet')
    expect(engine.getFeedbackScore('greet')).toBeGreaterThan(1.0)
  })

  it('negative feedback decreases score', () => {
    const engine = new DriveEngine(makeDeps())
    engine.feedbackNegative('greet')
    expect(engine.getFeedbackScore('greet')).toBeLessThan(1.0)
  })

  it('feedback score clamps at boundaries', () => {
    const engine = new DriveEngine(makeDeps())
    for (let i = 0; i < 100; i++) engine.feedbackPositive('greet')
    expect(engine.getFeedbackScore('greet')).toBeLessThanOrEqual(2.0)
    for (let i = 0; i < 200; i++) engine.feedbackNegative('greet')
    expect(engine.getFeedbackScore('greet')).toBeGreaterThanOrEqual(0.2)
  })

  it('feedback affects priority via applyModifiers', () => {
    const engine = new DriveEngine(makeDeps())
    engine.feedbackNegative('greet') // score ~0.85
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
    ]
    const modified = engine.applyModifiers(goals, 'calm', 80)
    expect(modified[0].priority).toBeLessThan(80)
  })

  it('onBubbleCleared gives positive feedback for recent bubbles', () => {
    const engine = new DriveEngine(makeDeps())
    // Simulate a recent bubble
    ;(engine as any).recentBubbleKinds = [{ kind: 'greet', ts: Date.now() }]
    engine.onBubbleCleared()
    expect(engine.getFeedbackScore('greet')).toBeGreaterThan(1.0)
  })

  it('onBubbleCleared ignores old bubbles', () => {
    const engine = new DriveEngine(makeDeps())
    ;(engine as any).recentBubbleKinds = [{ kind: 'greet', ts: Date.now() - 120_000 }]
    engine.onBubbleCleared()
    expect(engine.getFeedbackScore('greet')).toBe(1.0)
  })
})

describe('DriveEngine mood constraints', () => {
  it('drops agent_task goals when energy < 30', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
      { id: '2', kind: 'system_check', priority: 65, action: 'agent_task', agentGoal: 'check', cooldownKey: 'system_check' },
    ]
    const modified = engine.applyModifiers(goals, 'worried', 20)
    expect(modified).toHaveLength(1)
    expect(modified[0].kind).toBe('greet')
  })

  it('keeps agent_task goals when energy >= 30', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 80, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
      { id: '2', kind: 'system_check', priority: 65, action: 'agent_task', agentGoal: 'check', cooldownKey: 'system_check' },
    ]
    const modified = engine.applyModifiers(goals, 'worried', 50)
    expect(modified).toHaveLength(2)
  })

  it('lonely mood promotes social goal above non-social', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'system_check', priority: 90, action: 'agent_task', agentGoal: 'check', cooldownKey: 'system_check' },
      { id: '2', kind: 'comfort', priority: 50, action: 'bubble', bubble: 'miss', cooldownKey: 'comfort' },
    ]
    const modified = engine.applyModifiers(goals, 'lonely', 80)
    // comfort should be promoted above system_check
    expect(modified[0].kind).toBe('comfort')
    expect(modified[0].priority).toBeGreaterThan(modified[1].priority)
  })

  it('lonely mood does not boost when social goal is already highest', () => {
    const engine = new DriveEngine(makeDeps())
    const goals: PetGoal[] = [
      { id: '1', kind: 'greet', priority: 100, action: 'bubble', bubble: 'hi', cooldownKey: 'greet' },
      { id: '2', kind: 'system_check', priority: 60, action: 'agent_task', agentGoal: 'check', cooldownKey: 'system_check' },
    ]
    const modified = engine.applyModifiers(goals, 'lonely', 80)
    // greet already on top, should not change
    expect(modified[0].kind).toBe('greet')
  })
})

describe('DriveEngine reads from params', () => {
  it('greet rule uses params.greetAffectionThreshold', () => {
    const engine = new DriveEngine(makeDeps())
    const params = { ...DEFAULT_PARAMS, greetAffectionThreshold: 50, greetHoursThreshold: 1 }
    const goals = engine.evaluate({
      mood: 'calm', energy: 80, affection: 40, streak: 0,
      hoursSince: 2, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(), params,
    })
    // affection=40 < threshold 50, hoursSince=2 > threshold 1 → greet fires
    expect(goals.some(g => g.kind === 'greet')).toBe(true)
  })

  it('check_in rule uses params.checkInHoursThreshold', () => {
    const engine = new DriveEngine(makeDeps())
    const params = { ...DEFAULT_PARAMS, checkInHoursThreshold: 6 }
    const goals = engine.evaluate({
      mood: 'calm', energy: 80, affection: 50, streak: 1,
      hoursSince: 5, waking: true, stats: normalStats,
      hasEvents: false, now: Date.now(), params,
    })
    // hoursSince=5 < checkInHoursThreshold=6 → check_in should NOT fire
    expect(goals.some(g => g.kind === 'check_in')).toBe(false)
  })

  it('applies params.goalKindMultipliers on top of mood multipliers', () => {
    function priorityFor(taotaoOrStlulu: 'taotao' | 'stlulu') {
      const deps = makeDeps()
      const p = taotaoOrStlulu === 'taotao'
        ? traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
        : traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })
      const engine = new DriveEngine(deps)
      const goals = engine.evaluate({
        mood: 'lonely', energy: 80, affection: 25, streak: 0,
        hoursSince: 2.5, waking: true, stats: normalStats,
        hasEvents: false, now: Date.now(), params: p,
      })
      return goals.find(g => g.kind === 'comfort')?.priority ?? 0
    }
    expect(priorityFor('taotao')).toBeGreaterThan(priorityFor('stlulu'))
  })

  it('dedup uses params.cooldownMsByKind when present', () => {
    const engine = new DriveEngine(makeDeps())
    const params = { ...DEFAULT_PARAMS, cooldownMsByKind: { greet: 60 * 60_000 } }
    const now = 10_000_000
    ;(engine as any).cooldowns.set('greet', now - 45 * 60_000)
    const goals = [{ id: 'x', kind: 'greet' as const, priority: 80, action: 'bubble' as const, bubble: 'hi', cooldownKey: 'greet' }]
    // 45min < 60min cooldown → still blocked
    expect(engine.dedup(goals, now, params)).toHaveLength(0)
    // After 70min: allowed
    expect(engine.dedup(goals, now + 25 * 60_000, params)).toHaveLength(1)
  })
})

describe('behavioral divergence — taotao vs stlulu', () => {
  it('with the same context, taotao has higher social goal priority than stlulu', () => {
    const taotaoParams = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    const stluluParams = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })

    function topGoalAndPriority(params: typeof taotaoParams) {
      const engine = new DriveEngine(makeDeps())
      const goals = engine.evaluate({
        mood: 'lonely', energy: 80, affection: 25, streak: 0,
        hoursSince: 2.5, waking: true, stats: normalStats,
        hasEvents: false, now: Date.now(), params,
      })
      return { top: goals[0]?.kind, priority: goals[0]?.priority ?? 0 }
    }

    const tao = topGoalAndPriority(taotaoParams)
    const stl = topGoalAndPriority(stluluParams)
    expect(tao.priority).toBeGreaterThan(stl.priority)
  })

  it('taotao lonelyHoursThreshold < 1.5h, stlulu >= 1.5h', () => {
    const tao = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    const stl = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })
    expect(tao.lonelyHoursThreshold).toBeLessThan(1.5)
    expect(stl.lonelyHoursThreshold).toBeGreaterThanOrEqual(1.5)
  })
})
