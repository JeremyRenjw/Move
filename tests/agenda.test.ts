import { describe, it, expect, beforeEach } from 'vitest'
import { Agenda, type PendingGoal } from '../electron/agenda'
import type { PlanAgendaResult } from '../electron/ai'

function makeDeps(overrides: Partial<any> = {}): any {
  return {
    ai:             { planAgenda: async () => ({ goals: [] }) },
    events:         { range: async () => [], recent: async () => [], byType: async () => [], append: async () => 'evid' },
    facts:          { list: async () => [] },
    mood:           { buildMoodContext: () => '', getEnergy: () => 50, tick: () => 'calm' },
    chars:          { getApiConfig: async () => ({ provider: 'claude', model: 'm', baseUrl: '' }), getApiKey: async () => 'k' },
    getStats:       () => ({ cpu: 20, ramUsed: 1e9, ramTotal: 16e9, diskUsed: 30 }),
    getPersona:     async () => 'persona',
    getActivePetId: () => 'stlulu',
    getParams:      () => ({ greetAffectionThreshold: 30, greetHoursThreshold: 4, checkInHoursThreshold: 8, curiosityAffectionThreshold: 70, goalKindMultipliers: {}, cooldownMsByKind: {} }),
    dataDir:        '/tmp/agenda-test',
    timings:        { debounceMs: 30, throttleMs: 200, heartbeatMs: 60_000, llmTimeoutMs: 5_000 },
    ...overrides,
  }
}

function fakeGoal(opts: { notBefore?: number; expiresAt?: number; kind?: any; id?: string } = {}): PendingGoal {
  const now = Date.now()
  return {
    id:          opts.id ?? 'g-' + Math.random().toString(36).slice(2),
    kind:        opts.kind ?? 'greet',
    priority:    50,
    action:      'bubble',
    bubble:      'hi',
    cooldownKey: opts.kind ?? 'greet',
    source:      'agenda',
    notBefore:   opts.notBefore ?? now,
    expiresAt:   opts.expiresAt ?? now + 60_000,
    reason:      'test',
    createdAt:   now,
  }
}

describe('Agenda.peek', () => {
  it('returns goals where notBefore <= now < expiresAt', () => {
    const a = new Agenda(makeDeps())
    const now = 10_000
    a.injectForTest([
      fakeGoal({ id: 'past',    notBefore: 0,     expiresAt: 5_000 }),   // expired
      fakeGoal({ id: 'future',  notBefore: 20_000, expiresAt: 30_000 }), // not yet
      fakeGoal({ id: 'now',     notBefore: 5_000,  expiresAt: 15_000 }), // active
    ])
    const out = a.peek(now)
    expect(out.map(g => g.id)).toEqual(['now'])
  })

  it('returns multiple active goals sorted by priority desc', () => {
    const a = new Agenda(makeDeps())
    const now = 10_000
    a.injectForTest([
      { ...fakeGoal({ id: 'lo', notBefore: 0, expiresAt: 99_999 }), priority: 30 },
      { ...fakeGoal({ id: 'hi', notBefore: 0, expiresAt: 99_999 }), priority: 80 },
    ])
    const out = a.peek(now)
    expect(out.map(g => g.id)).toEqual(['hi', 'lo'])
  })

  it('stamps source="agenda" on returned PetGoals', () => {
    const a = new Agenda(makeDeps())
    a.injectForTest([fakeGoal({ id: 'x', notBefore: 0 })])
    const out = a.peek(Date.now())
    expect(out[0].source).toBe('agenda')
  })
})

describe('Agenda.consume', () => {
  it('removes goal from queue so subsequent peek omits it', () => {
    const a = new Agenda(makeDeps())
    const now = 10_000
    a.injectForTest([fakeGoal({ id: 'one', notBefore: 0, expiresAt: 99_999 })])
    expect(a.peek(now).map(g => g.id)).toEqual(['one'])
    a.consume('one')
    expect(a.peek(now)).toEqual([])
  })

  it('is a no-op for unknown id', () => {
    const a = new Agenda(makeDeps())
    expect(() => a.consume('does-not-exist')).not.toThrow()
  })
})

describe('Agenda.tick (no LLM tool use)', () => {
  it('enqueues goals returned by ai.planAgenda', async () => {
    const planResult: PlanAgendaResult = {
      goals: [
        { kind: 'curiosity', bubble: 'whatcha up to?', priority: 55, delayMinutes: 0, ttlMinutes: 30, reason: 'idle' },
      ],
    }
    const deps = makeDeps({
      ai: { planAgenda: async () => planResult },
    })
    const a = new Agenda(deps)
    await a.tick('idle')
    const got = a.peek(Date.now() + 1)
    expect(got.map(g => g.kind)).toEqual(['curiosity'])
    expect(got[0].source).toBe('agenda')
  })

  it('respects delayMinutes via notBefore', async () => {
    const deps = makeDeps({
      ai: { planAgenda: async () => ({
        goals: [{ kind: 'greet', bubble: 'hi later', priority: 40, delayMinutes: 10, ttlMinutes: 60, reason: 'queue ahead' }],
      }) },
    })
    const a = new Agenda(deps)
    const before = Date.now()
    await a.tick('idle')
    const immediate = a.peek(before + 1000)
    expect(immediate).toEqual([])             // not yet
    const later = a.peek(before + 11 * 60_000)
    expect(later.map(g => g.kind)).toEqual(['greet'])
  })

  it('inflight mutex: a second concurrent tick is a no-op', async () => {
    let calls = 0
    const deps = makeDeps({
      ai: { planAgenda: async () => {
        calls++
        await new Promise(r => setTimeout(r, 30))
        return { goals: [] } as PlanAgendaResult
      } },
    })
    const a = new Agenda(deps)
    await Promise.all([a.tick('idle'), a.tick('idle'), a.tick('idle')])
    expect(calls).toBe(1)
  })

  it('skips when api key is missing', async () => {
    let called = false
    const deps = makeDeps({
      chars: { getApiConfig: async () => ({ provider: 'claude', model: 'm', baseUrl: '' }), getApiKey: async () => '' },
      ai: { planAgenda: async () => { called = true; return { goals: [] } as PlanAgendaResult } },
    })
    const a = new Agenda(deps)
    await a.tick('idle')
    expect(called).toBe(false)
  })

  it('records agenda_tick event via events.append', async () => {
    const appended: any[] = []
    const planResult: PlanAgendaResult = { goals: [] , silentReason: 'busy' }
    const deps = makeDeps({
      ai:     { planAgenda: async () => planResult },
      events: {
        range:  async () => [],
        recent: async () => [],
        byType: async () => [],
        append: async (petId: string, ev: any) => { appended.push({ petId, ev }); return 'evid' },
      },
    })
    const a = new Agenda(deps)
    await a.tick('idle')
    const tickEv = appended.find(x => x.ev.type === 'agenda_tick')
    expect(tickEv).toBeTruthy()
    expect(tickEv.ev.data.reason).toBe('idle')
    expect(tickEv.ev.data.goalsProposed).toBe(0)
    expect(tickEv.ev.data.silentReason).toBe('busy')
  })
})

describe('Agenda.onEvent debounce/throttle', () => {
  it('coalesces multiple onEvent calls within debounce window into a single tick', async () => {
    let calls = 0
    const deps = makeDeps({
      ai: { planAgenda: async () => { calls++; return { goals: [] } } },
    })
    const a = new Agenda(deps)
    a.onEvent('chat')
    a.onEvent('hook')
    a.onEvent('task')
    // Wait past the debounce window (timings.debounceMs = 30)
    await new Promise(r => setTimeout(r, 60))
    expect(calls).toBeLessThanOrEqual(1)
  })

  it('honors 3-minute throttle: onEvent right after a tick does nothing', async () => {
    let calls = 0
    const deps = makeDeps({
      ai: { planAgenda: async () => { calls++; return { goals: [] } } },
    })
    const a = new Agenda(deps)
    await a.tick('idle')               // sets lastTickAt
    expect(calls).toBe(1)
    a.onEvent('chat')
    await new Promise(r => setTimeout(r, 60))
    expect(calls).toBe(1)              // throttled
  })
})
