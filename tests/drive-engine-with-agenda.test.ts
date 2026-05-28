import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DriveEngine } from '../electron/drive-engine'
import { Agenda, type PendingGoal } from '../electron/agenda'
import { DEFAULT_PARAMS } from '../electron/pet-traits'
import type { PetGoal } from '../src-shared/types'

function fakeGoal(opts: Partial<PendingGoal> = {}): PendingGoal {
  const now = Date.now()
  return {
    id:          'g-' + Math.random().toString(36).slice(2),
    kind:        'curiosity',
    priority:    50,
    action:      'bubble',
    bubble:      'agenda bubble',
    cooldownKey: 'curiosity',
    source:      'agenda',
    notBefore:   now,
    expiresAt:   now + 60_000,
    reason:      'test',
    createdAt:   now,
    ...opts,
  }
}

function makeMockAgenda(goals: PendingGoal[]): Agenda {
  const consumed: string[] = []
  const fakeDeps: any = {
    ai:     { planAgenda: async () => ({ goals: [] }) },
    events: { range: async () => [], append: async () => 'id' },
    facts:  { list: async () => [] },
    mood:   { buildMoodContext: () => '' },
    chars:  { getApiConfig: async () => null, getApiKey: async () => '' },
    getStats:       () => ({ cpu: 0, ramUsed: 0, ramTotal: 0, diskUsed: 0 }),
    getPersona:     async () => '',
    getActivePetId: () => 'stlulu',
    getParams:      () => DEFAULT_PARAMS,
    dataDir:        '/tmp/none',
    timings:        { debounceMs: 10, throttleMs: 100, heartbeatMs: 60_000, llmTimeoutMs: 1_000 },
  }
  const a = new Agenda(fakeDeps)
  a.injectForTest(goals)
  const origConsume = a.consume.bind(a)
  a.consume = (id: string) => { consumed.push(id); origConsume(id) }
  ;(a as any).__consumed = consumed
  return a
}

function makeDriveDeps(agenda: Agenda | undefined): any {
  return {
    mood: {
      tick: () => 'calm' as const,
      getEnergy: () => 80,
      getAffection: () => 60,
      getStreak: () => 0,
      getHoursSinceInteraction: () => 0,
      isWakingHours: () => true,
      onInteraction: vi.fn(),
      buildMoodContext: () => '',
    },
    wm:             { showBubble: vi.fn(), broadcast: vi.fn() },
    agentScheduler: { executeOneShot: async () => 'ok' },
    events:         { range: async () => [] },
    getStats:       () => ({ cpu: 30, ramUsed: 1e9, ramTotal: 16e9, diskUsed: 30 }),
    getActivePetId: () => 'stlulu',
    getParams:      () => DEFAULT_PARAMS,
    agenda,
  }
}

describe('DriveEngine + Agenda', () => {
  it('peeks agenda goals and includes them in the merged set', async () => {
    const agenda = makeMockAgenda([fakeGoal({ id: 'a1', priority: 90 })])
    const deps = makeDriveDeps(agenda)
    const engine = new DriveEngine(deps)
    await engine.tick()
    expect(deps.wm.showBubble).toHaveBeenCalled()
    const arg = deps.wm.showBubble.mock.calls[0][0]
    expect(arg.label).toBe('agenda bubble')
    expect((agenda as any).__consumed).toContain('a1')
  })

  it('rule goal beats lower-priority agenda goal', async () => {
    const agenda = makeMockAgenda([fakeGoal({ id: 'a1', kind: 'curiosity', priority: 20 })])
    const deps = makeDriveDeps(agenda)
    // Make rule trigger: affection low + long absence → greet (priority 80)
    deps.mood.getAffection = () => 10
    deps.mood.getHoursSinceInteraction = () => 6
    const engine = new DriveEngine(deps)
    await engine.tick()
    expect(deps.wm.showBubble).toHaveBeenCalled()
    expect((agenda as any).__consumed).toEqual([])  // agenda goal not consumed
  })

  it('agenda goal wins when its priority exceeds rule goals', async () => {
    const agenda = makeMockAgenda([fakeGoal({ id: 'a1', kind: 'curiosity', priority: 95, bubble: 'agenda wins' })])
    const deps = makeDriveDeps(agenda)
    // Trigger rule greet at priority 80
    deps.mood.getAffection = () => 10
    deps.mood.getHoursSinceInteraction = () => 6
    const engine = new DriveEngine(deps)
    await engine.tick()
    const arg = deps.wm.showBubble.mock.calls[0][0]
    expect(arg.label).toBe('agenda wins')
    expect((agenda as any).__consumed).toEqual(['a1'])
  })

  it('without agenda dep, engine behaves identically to old code', async () => {
    const deps = makeDriveDeps(undefined)
    deps.mood.getAffection = () => 10
    deps.mood.getHoursSinceInteraction = () => 6
    const engine = new DriveEngine(deps)
    await engine.tick()
    expect(deps.wm.showBubble).toHaveBeenCalled()
  })
})
