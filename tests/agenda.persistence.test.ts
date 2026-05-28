import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Agenda, type PendingGoal } from '../electron/agenda'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-persist-'))
}

function baseDeps(dataDir: string): any {
  return {
    ai:             { planAgenda: async () => ({ goals: [] }) },
    events:         { range: async () => [], recent: async () => [], byType: async () => [], append: async () => 'id' },
    facts:          { list: async () => [] },
    mood:           { buildMoodContext: () => '', tick: () => 'calm' },
    chars:          { getApiConfig: async () => ({ provider: 'claude', model: 'm', baseUrl: '' }), getApiKey: async () => 'k' },
    getStats:       () => ({ cpu: 20, ramUsed: 1e9, ramTotal: 16e9, diskUsed: 30 }),
    getPersona:     async () => 'persona',
    getActivePetId: () => 'stlulu',
    getParams:      () => ({}) as any,
    dataDir,
    timings: { debounceMs: 30, throttleMs: 200, heartbeatMs: 60_000, llmTimeoutMs: 5_000 },
  }
}

function fakeGoal(opts: Partial<PendingGoal> = {}): PendingGoal {
  const now = Date.now()
  return {
    id:          'g-' + Math.random().toString(36).slice(2),
    kind:        'greet',
    priority:    50,
    action:      'bubble',
    bubble:      'hi',
    cooldownKey: 'greet',
    source:      'agenda',
    notBefore:   now,
    expiresAt:   now + 60_000,
    reason:      'test',
    createdAt:   now,
    ...opts,
  }
}

describe('Agenda persistence', () => {
  let dir: string
  beforeEach(() => { dir = tmpDir() })

  it('writes append-on-enqueue and replays goals on construction', async () => {
    const a = new Agenda(baseDeps(dir))
    await a.tick('idle')   // empty goals; still creates dir

    // Manually enqueue via tick by mocking ai.planAgenda
    const deps2 = baseDeps(dir)
    deps2.ai = { planAgenda: async () => ({
      goals: [
        { kind: 'greet',    bubble: 'hi',  priority: 60, delayMinutes: 0, ttlMinutes: 30, reason: 'x' },
        { kind: 'check_in', bubble: 'sup', priority: 40, delayMinutes: 0, ttlMinutes: 30, reason: 'y' },
      ],
    }) }
    const b = new Agenda(deps2)
    await b.loadFromDisk()
    await b.tick('idle')

    // New instance replays
    const c = new Agenda(baseDeps(dir))
    await c.loadFromDisk()
    const got = c.peek(Date.now() + 1)
    expect(got.length).toBe(2)
    expect(got.map(g => g.kind).sort()).toEqual(['check_in', 'greet'])
  })

  it('replay applies consume records', async () => {
    const goal = fakeGoal({ id: 'specific', notBefore: 0, expiresAt: Date.now() + 60_000 })
    const file = path.join(dir, 'pets', 'stlulu', 'agenda.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file,
      JSON.stringify({ type: 'add', goal }) + '\n' +
      JSON.stringify({ type: 'consume', id: 'specific', ts: Date.now() }) + '\n'
    )
    const a = new Agenda(baseDeps(dir))
    await a.loadFromDisk()
    expect(a.peek(Date.now() + 1)).toEqual([])
  })

  it('replay drops expired goals', async () => {
    const goal = fakeGoal({ id: 'old', notBefore: 0, expiresAt: 100 }) // already expired
    const file = path.join(dir, 'pets', 'stlulu', 'agenda.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ type: 'add', goal }) + '\n')
    const a = new Agenda(baseDeps(dir))
    await a.loadFromDisk()
    expect(a.peek(Date.now() + 1)).toEqual([])
  })

  it('compaction rewrites file when over threshold', async () => {
    const file = path.join(dir, 'pets', 'stlulu', 'agenda.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Write 600 add+consume pairs to exceed threshold
    let body = ''
    for (let i = 0; i < 600; i++) {
      const g = fakeGoal({ id: `g${i}`, notBefore: 0, expiresAt: Date.now() + 60_000 })
      body += JSON.stringify({ type: 'add', goal: g }) + '\n'
      body += JSON.stringify({ type: 'consume', id: `g${i}`, ts: Date.now() }) + '\n'
    }
    fs.writeFileSync(file, body)
    const a = new Agenda(baseDeps(dir))
    await a.loadFromDisk()
    await a.compactIfNeededForTest()
    const after = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    expect(after.length).toBeLessThan(50)   // empty queue → file is small
  })
})
