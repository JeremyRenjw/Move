import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Reflector } from '../electron/reflector'
import type { PetEvent, SystemStats } from '../src-shared/types'

const MOCK_STATS: SystemStats = {
  cpu: 30, ramUsed: 4e9, ramTotal: 16e9,
  diskUsed: 40, claudeRunning: false, codexRunning: false
}

function makeEvents(n: number): PetEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    ts: Date.now() - (n - i) * 1000,
    type: 'hook_signal' as const,
    source: 'hook' as const,
    data: { event: 'Stop', tool: 'claude' }
  }))
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    ai:            { reflect: vi.fn().mockResolvedValue({ action: 'silent' }) },
    events:        { range: vi.fn().mockResolvedValue(makeEvents(3)), append: vi.fn().mockResolvedValue('new-id') },
    facts:         { list: vi.fn().mockResolvedValue([]) },
    wm:            { showBubble: vi.fn(), broadcast: vi.fn() },
    mood:          { tick: vi.fn().mockReturnValue('calm'), buildMoodContext: vi.fn().mockReturnValue('[情绪状态] 平静'), getStage: vi.fn().mockReturnValue('baby') },
    getStats:      vi.fn().mockReturnValue(MOCK_STATS),
    getPersona:    vi.fn().mockReturnValue('You are a helpful pet.'),
    getActivePetId: vi.fn().mockReturnValue('stlulu'),
    ...overrides,
  } as any
}

describe('Reflector', () => {
  it('calls ai.reflect when there are recent events; no bubble on silent', async () => {
    const deps = makeDeps()
    const ref = new Reflector(deps)
    await ref.tick()

    expect(deps.ai.reflect).toHaveBeenCalledTimes(1)
    expect(deps.wm.showBubble).not.toHaveBeenCalled()
  })

  it('shows bubble when ai.reflect returns propose', async () => {
    const deps = makeDeps({
      ai: { reflect: vi.fn().mockResolvedValue({ action: 'propose', bubble: '磁盘快满了', detail: 'disk 90%' }) }
    })
    const ref = new Reflector(deps)
    await ref.tick()

    expect(deps.wm.showBubble).toHaveBeenCalledTimes(1)
    expect(deps.wm.showBubble).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'watcher', label: '磁盘快满了' })
    )
  })

  it('skips ai.reflect when no recent events (early return)', async () => {
    const deps = makeDeps({
      events: { range: vi.fn().mockResolvedValue([]), append: vi.fn() }
    })
    const ref = new Reflector(deps)
    await ref.tick()

    expect(deps.ai.reflect).not.toHaveBeenCalled()
    expect(deps.events.append).not.toHaveBeenCalled()
  })

  it('catches ai.reflect error, records reflector_tick, no bubble', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      ai: { reflect: vi.fn().mockRejectedValue(new Error('API quota exceeded')) }
    })
    const ref = new Reflector(deps)
    await ref.tick()

    // ai.reflect was called
    expect(deps.ai.reflect).toHaveBeenCalledTimes(1)
    // error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      '[reflector] ai.reflect failed:',
      expect.any(Error)
    )
    // reflector_tick still recorded (with silent decision from catch)
    expect(deps.events.append).toHaveBeenCalledWith('stlulu', expect.objectContaining({
      type: 'reflector_tick',
      source: 'reflector',
    }))
    // no bubble
    expect(deps.wm.showBubble).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('uses default petId stlulu when getActivePetId returns null', async () => {
    const deps = makeDeps({ getActivePetId: vi.fn().mockReturnValue(null) })
    const ref = new Reflector(deps)
    await ref.tick()

    expect(deps.events.range).toHaveBeenCalledWith('stlulu', expect.any(Number), expect.any(Number))
  })
})
