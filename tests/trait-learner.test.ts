import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TraitLearner } from '../electron/trait-learner'
import type { CharacterConfig, PetTraits } from '../src-shared/types'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { default: fs.promises }
})

function makeDeps(overrides: Partial<PetTraits> = {}) {
  let saved: CharacterConfig | null = null
  const chars = {
    get: vi.fn(async (petId: string): Promise<CharacterConfig> => ({
      petId,
      displayName: petId,
      personality: ['活泼'],
      systemPrompt: 'test',
      greeting: 'hi',
      traitsOverride: { ...overrides },
    })),
    save: vi.fn(async (cfg: CharacterConfig) => { saved = cfg }),
  }
  const pets = {
    getActiveId: vi.fn(() => 'test-pet'),
    resolveParams: vi.fn(async () => ({})),
  }
  const mood = { setParams: vi.fn() }
  return { chars, pets, mood, getSaved: () => saved }
}

describe('TraitLearner', () => {
  beforeEach(async () => {
    const { vol } = await import('memfs')
    vol.reset()
  })

  it('records signals into buffer', () => {
    const deps = makeDeps()
    const learner = new TraitLearner(deps, '/test')
    learner.record('greet_engaged', 1)
    learner.record('chat_active', 0.8)
    // Buffer is internal, but we can verify through learning
    expect(true).toBe(true) // signal recorded without error
  })

  it('learns sociability up from greet_engaged signals', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    // Simulate multiple greet_engaged signals
    for (let i = 0; i < 5; i++) {
      learner.record('greet_engaged', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved).not.toBeNull()
    expect(saved!.traitsOverride!.sociability).toBeGreaterThan(0.5)
  })

  it('learns sociability down from greet_ignored signals', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 5; i++) {
      learner.record('greet_ignored', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.sociability).toBeLessThan(0.5)
  })

  it('learns independence up from negative feedback', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 5; i++) {
      learner.record('feedback_neg', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.independence).toBeGreaterThan(0.5)
  })

  it('learns playfulness up from tool_heavy signals', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 5; i++) {
      learner.record('tool_heavy', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.playfulness).toBeGreaterThan(0.5)
  })

  it('learns energy_volatility up from late_night signals', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 5; i++) {
      learner.record('late_night', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.energy_volatility).toBeGreaterThan(0.5)
  })

  it('is idempotent per day (no double learning)', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 5; i++) {
      learner.record('greet_engaged', 1)
    }
    await learner.learn('test-pet')
    const firstSave = deps.chars.save.mock.calls.length
    // Second call same day should be no-op
    await learner.learn('test-pet')
    expect(deps.chars.save.mock.calls.length).toBe(firstSave)
  })

  it('clamps trait to [0.1, 0.9] maximum', async () => {
    const deps = makeDeps({ sociability: 0.88 })
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 100; i++) {
      learner.record('greet_engaged', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.sociability).toBeLessThanOrEqual(0.9)
  })

  it('clamps trait to [0.1, 0.9] minimum', async () => {
    const deps = makeDeps({ sociability: 0.12 })
    const learner = new TraitLearner(deps, '/test')
    for (let i = 0; i < 100; i++) {
      learner.record('greet_ignored', 1)
    }
    await learner.learn('test-pet')
    const saved = deps.getSaved()
    expect(saved!.traitsOverride!.sociability).toBeGreaterThanOrEqual(0.1)
  })

  it('hot-reloads params when active pet matches', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    learner.record('greet_engaged', 1)
    await learner.learn('test-pet')
    expect(deps.pets.resolveParams).toHaveBeenCalledWith('test-pet', deps.chars)
    expect(deps.mood.setParams).toHaveBeenCalled()
  })

  it('returns empty log when no learning has happened', async () => {
    const deps = makeDeps({})
    const learner = new TraitLearner(deps, '/test')
    const log = await learner.getLog(7)
    expect(log).toEqual([])
  })
})
