import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventRouter } from '../electron/event-router'
import type { NotifyEvent } from '../src-shared/types'

describe('EventRouter', () => {
  let bubbles: { label: string; source: string }[]
  let router: EventRouter

  beforeEach(() => {
    bubbles = []
    router = new EventRouter({
      showBubble: (label, source) => { bubbles.push({ label, source }) }
    })
  })

  it('emits a bubble for Stop+claude with the right template', () => {
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].label).toMatch(/Claude.*完/)
  })

  it('emits a bubble for PermissionRequest+codex', () => {
    router.handle({ event: 'PermissionRequest', tool: 'codex', cwd: '/x', ts: 1 })
    expect(bubbles[0].label).toMatch(/codex.*授权/i)
  })

  it('does NOT bubble on SessionStart (only updates context)', () => {
    router.handle({ event: 'SessionStart', tool: 'claude', cwd: '/x', ts: 1 })
    expect(bubbles).toHaveLength(0)
  })

  it('classifies Stop+exitCode!=0 as Error', () => {
    router.handle({ event: 'Stop', tool: 'codex', cwd: '/x', ts: 1, extra: { exitCode: 2 } })
    expect(bubbles[0].label).toMatch(/⚠️.*codex/)
  })

  it('classifies Notification+error-keyword as Error', () => {
    router.handle({ event: 'Notification', tool: 'claude', cwd: '/x', ts: 1, extra: { message: 'fatal failed' } })
    expect(bubbles[0].label).toMatch(/⚠️.*claude/)
  })

  it('debounces same (tool,event,cwd) within 10s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-23T12:00:00Z'))
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 2 })
    expect(bubbles).toHaveLength(1)
    vi.setSystemTime(new Date('2026-05-23T12:00:11Z'))
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 3 })
    expect(bubbles).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not debounce different cwd', () => {
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/a', ts: 1 })
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/b', ts: 2 })
    expect(bubbles).toHaveLength(2)
  })

  it('keeps a recent-events ring buffer (max 20, newest first)', () => {
    for (let i = 0; i < 25; i++) {
      router.handle({ event: 'Stop', tool: 'codex', cwd: `/x${i}`, ts: i })
    }
    const recent = router.recent()
    expect(recent).toHaveLength(20)
    expect(recent[0].cwd).toBe('/x24')
    expect(recent[19].cwd).toBe('/x5')
  })

  it('records SessionStart in recent buffer even though it does not bubble', () => {
    router.handle({ event: 'SessionStart', tool: 'claude', cwd: '/x', ts: 1 })
    expect(router.recent()).toHaveLength(1)
    expect(bubbles).toHaveLength(0)
  })
})
