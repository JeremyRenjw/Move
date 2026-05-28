import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FactStore } from '../electron/fact-store'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-fs-')) }

describe('FactStore', () => {
  let dir: string
  let store: FactStore

  beforeEach(() => { dir = tmp(); store = new FactStore(dir) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('adds a fact with auto id + ts', async () => {
    const id = await store.add('p', {
      type: 'preference',
      content: '用户喜欢 dark mode',
      confidence: 0.8,
      source: { note: 'user-said' }
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const all = await store.list('p')
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(id)
    expect(all[0].content).toBe('用户喜欢 dark mode')
    expect(typeof all[0].ts).toBe('number')
  })

  it('list filters by type', async () => {
    await store.add('p', { type: 'preference', content: 'a', confidence: 1, source: {} })
    await store.add('p', { type: 'project',    content: 'b', confidence: 1, source: {} })
    await store.add('p', { type: 'preference', content: 'c', confidence: 1, source: {} })

    const prefs = await store.list('p', { type: 'preference' })
    expect(prefs).toHaveLength(2)
    expect(prefs.every(f => f.type === 'preference')).toBe(true)
  })

  it('list filters by minConfidence', async () => {
    await store.add('p', { type: 'event', content: 'low',  confidence: 0.3, source: {} })
    await store.add('p', { type: 'event', content: 'high', confidence: 0.9, source: {} })

    const out = await store.list('p', { minConfidence: 0.5 })
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('high')
  })

  it('list respects limit (newest first)', async () => {
    // Write directly to control timestamps (store.add uses Date.now() which may collide)
    const petDir = path.join(dir, 'p')
    fs.mkdirSync(petDir, { recursive: true })
    const facts = [
      { id: 'id-0', ts: 1000, type: 'event', content: 'c0', confidence: 1, source: {} },
      { id: 'id-1', ts: 2000, type: 'event', content: 'c1', confidence: 1, source: {} },
      { id: 'id-2', ts: 3000, type: 'event', content: 'c2', confidence: 1, source: {} },
      { id: 'id-3', ts: 4000, type: 'event', content: 'c3', confidence: 1, source: {} },
      { id: 'id-4', ts: 5000, type: 'event', content: 'c4', confidence: 1, source: {} },
    ]
    fs.writeFileSync(
      path.join(petDir, 'facts.jsonl'),
      facts.map(f => JSON.stringify(f)).join('\n') + '\n'
    )
    const out = await store.list('p', { limit: 2 })
    expect(out).toHaveLength(2)
    expect(out[0].content).toBe('c4')
    expect(out[1].content).toBe('c3')
  })

  it('list excludes superseded facts by default', async () => {
    // 直接写文件构造一个 superseded 状态
    const petDir = path.join(dir, 'p')
    fs.mkdirSync(petDir, { recursive: true })
    const f1 = { id: 'old', ts: 1, type: 'preference', content: 'old', confidence: 1, source: {}, superseded_by: 'new' }
    const f2 = { id: 'new', ts: 2, type: 'preference', content: 'new', confidence: 1, source: {} }
    fs.writeFileSync(path.join(petDir, 'facts.jsonl'), JSON.stringify(f1) + '\n' + JSON.stringify(f2) + '\n')

    const out = await store.list('p')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('new')
  })

  it('supersede writes a new fact and marks the old one', async () => {
    const oldId = await store.add('p', {
      type: 'preference', content: '住北京', confidence: 1, source: {}
    })
    const newId = await store.supersede('p', oldId, {
      type: 'preference', content: '住上海', confidence: 1, source: { note: 'corrected' }
    })

    const visible = await store.list('p')
    expect(visible).toHaveLength(1)
    expect(visible[0].id).toBe(newId)

    const all = await store.list('p', { includeSuperseded: true })
    expect(all).toHaveLength(2)
    const oldFact = all.find(f => f.id === oldId)
    expect(oldFact?.superseded_by).toBe(newId)
  })

  it('delete physically removes a fact line', async () => {
    const id = await store.add('p', {
      type: 'event', content: 'x', confidence: 1, source: {}
    })
    await store.delete('p', id)
    const all = await store.list('p', { includeSuperseded: true })
    expect(all).toHaveLength(0)
  })
})
