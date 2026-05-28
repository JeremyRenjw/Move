import { describe, it, expect } from 'vitest'
import { parsePlanAgendaResponse } from '../electron/ai'

describe('parsePlanAgendaResponse', () => {
  it('parses a well-formed response with goals', () => {
    const text = JSON.stringify({
      goals: [
        { kind: 'greet', bubble: 'hi', priority: 60, delayMinutes: 0, ttlMinutes: 30, reason: 'idle' },
        { kind: 'curiosity', bubble: 'whatcha doing?', priority: 40, delayMinutes: 5, ttlMinutes: 60, reason: 'long gap' },
      ],
    })
    const out = parsePlanAgendaResponse(text)
    expect(out.goals).toHaveLength(2)
    expect(out.goals[0].kind).toBe('greet')
    expect(out.goals[0].priority).toBe(60)
  })

  it('returns silentReason when goals is empty', () => {
    const out = parsePlanAgendaResponse(JSON.stringify({ goals: [], silentReason: 'user busy' }))
    expect(out.goals).toEqual([])
    expect(out.silentReason).toBe('user busy')
  })

  it('truncates to top-3 goals by priority when more than 3', () => {
    const text = JSON.stringify({
      goals: [
        { kind: 'greet', priority: 10, delayMinutes: 0, ttlMinutes: 30, reason: 'a' },
        { kind: 'check_in', priority: 90, delayMinutes: 0, ttlMinutes: 30, reason: 'b' },
        { kind: 'comfort', priority: 50, delayMinutes: 0, ttlMinutes: 30, reason: 'c' },
        { kind: 'curiosity', priority: 70, delayMinutes: 0, ttlMinutes: 30, reason: 'd' },
        { kind: 'celebrate', priority: 30, delayMinutes: 0, ttlMinutes: 30, reason: 'e' },
      ],
    })
    const out = parsePlanAgendaResponse(text)
    expect(out.goals.map(g => g.priority)).toEqual([90, 70, 50])
  })

  it('drops goals with invalid kind', () => {
    const text = JSON.stringify({
      goals: [
        { kind: 'greet', priority: 50, delayMinutes: 0, ttlMinutes: 30, reason: 'ok' },
        { kind: 'nonsense', priority: 50, delayMinutes: 0, ttlMinutes: 30, reason: 'bad' },
      ],
    })
    const out = parsePlanAgendaResponse(text)
    expect(out.goals.map(g => g.kind)).toEqual(['greet'])
  })

  it('drops goals missing required numeric fields', () => {
    const text = JSON.stringify({
      goals: [
        { kind: 'greet', priority: 50, delayMinutes: 0, ttlMinutes: 30, reason: 'ok' },
        { kind: 'comfort', delayMinutes: 0, ttlMinutes: 30, reason: 'no priority' },
      ],
    })
    const out = parsePlanAgendaResponse(text)
    expect(out.goals).toHaveLength(1)
  })

  it('returns empty on malformed JSON', () => {
    const out = parsePlanAgendaResponse('not json at all')
    expect(out.goals).toEqual([])
    expect(out.silentReason).toBe('parse_error')
  })

  it('extracts JSON from text that wraps it in markdown fences', () => {
    const text = '```json\n{"goals":[{"kind":"greet","priority":40,"delayMinutes":0,"ttlMinutes":30,"reason":"x"}]}\n```'
    const out = parsePlanAgendaResponse(text)
    expect(out.goals).toHaveLength(1)
  })

  it('clamps priority to 0-100', () => {
    const text = JSON.stringify({
      goals: [
        { kind: 'greet', priority: 250, delayMinutes: 0, ttlMinutes: 30, reason: 'too high' },
        { kind: 'comfort', priority: -10, delayMinutes: 0, ttlMinutes: 30, reason: 'too low' },
      ],
    })
    const out = parsePlanAgendaResponse(text)
    expect(out.goals[0].priority).toBe(100)
    expect(out.goals[1].priority).toBe(0)
  })
})
