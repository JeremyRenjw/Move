import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { EventStore } from '../electron/event-store'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-es-')) }

describe('EventStore', () => {
  let dir: string
  let store: EventStore

  beforeEach(() => { dir = tmp(); store = new EventStore(dir) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('appends an event with auto id + ts', async () => {
    const id = await store.append('pet1', {
      type: 'chat_turn', source: 'chat', data: { foo: 1 }
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const lines = fs.readFileSync(
      path.join(dir, 'pet1', 'events.jsonl'), 'utf-8'
    ).trim().split('\n')
    expect(lines).toHaveLength(1)
    const ev = JSON.parse(lines[0])
    expect(ev.id).toBe(id)
    expect(ev.type).toBe('chat_turn')
    expect(ev.source).toBe('chat')
    expect(ev.data).toEqual({ foo: 1 })
    expect(typeof ev.ts).toBe('number')
  })

  it('isolates events per petId', async () => {
    await store.append('a', { type: 'chat_turn', source: 'chat', data: {} })
    await store.append('b', { type: 'chat_turn', source: 'chat', data: {} })
    const aRecent = await store.recent('a', 10)
    const bRecent = await store.recent('b', 10)
    expect(aRecent).toHaveLength(1)
    expect(bRecent).toHaveLength(1)
    expect(aRecent[0].id).not.toBe(bRecent[0].id)
  })

  it('recent returns newest first up to N', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append('p', { type: 'chat_turn', source: 'chat', data: { i } })
    }
    const last3 = await store.recent('p', 3)
    expect(last3).toHaveLength(3)
    expect((last3[0].data as { i: number }).i).toBe(4)
    expect((last3[2].data as { i: number }).i).toBe(2)
  })

  it('recent returns [] when no file', async () => {
    const out = await store.recent('nobody', 5)
    expect(out).toEqual([])
  })

  it('range returns events within [fromTs, toTs]', async () => {
    const now = Date.now()
    // 直接写文件以便控制 ts
    const dir2 = path.join(dir, 'p2')
    fs.mkdirSync(dir2, { recursive: true })
    const file = path.join(dir2, 'events.jsonl')
    const evs = [
      { id: 'a', ts: now - 5000, type: 'chat_turn', source: 'chat', data: {} },
      { id: 'b', ts: now - 3000, type: 'chat_turn', source: 'chat', data: {} },
      { id: 'c', ts: now - 1000, type: 'chat_turn', source: 'chat', data: {} },
      { id: 'd', ts: now + 1000, type: 'chat_turn', source: 'chat', data: {} },
    ]
    fs.writeFileSync(file, evs.map(e => JSON.stringify(e)).join('\n') + '\n')

    const got = await store.range('p2', now - 4000, now)
    expect(got.map(e => e.id)).toEqual(['b', 'c'])
  })

  it('byType filters and limits', async () => {
    await store.append('p', { type: 'chat_turn',  source: 'chat', data: {} })
    await store.append('p', { type: 'cli_task',   source: 'cli',  data: {} })
    await store.append('p', { type: 'chat_turn',  source: 'chat', data: {} })
    await store.append('p', { type: 'chat_turn',  source: 'chat', data: {} })

    const chats = await store.byType('p', 'chat_turn', 2)
    expect(chats).toHaveLength(2)
    expect(chats.every(e => e.type === 'chat_turn')).toBe(true)
  })

  it('rotates active file when it exceeds the size limit', async () => {
    const small = new EventStore(dir)
    // 用一个小阈值版本（构造函数接受第二个参数）
    const tiny = new EventStore(dir, 200)
    // 先写几条把文件撑过 200 字节
    for (let i = 0; i < 5; i++) {
      await tiny.append('rot', {
        type: 'chat_turn', source: 'chat',
        data: { filler: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx' }
      })
    }
    const petDir = path.join(dir, 'rot')
    const files = fs.readdirSync(petDir).sort()
    // 应该有 1 个归档文件（events.YYYY-MM.jsonl）+ 当前 events.jsonl
    expect(files.some(f => /^events\.\d{4}-\d{2}\.jsonl$/.test(f))).toBe(true)
    expect(files.includes('events.jsonl')).toBe(true)
    void small
  })

  it('recent / range / byType only read the active file, not archives', async () => {
    const tiny = new EventStore(dir, 200)
    for (let i = 0; i < 5; i++) {
      await tiny.append('rot2', {
        type: 'chat_turn', source: 'chat',
        data: { filler: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx', i }
      })
    }
    const r = await tiny.recent('rot2', 100)
    // 归档掉的不读，所以 recent 数量小于 5
    expect(r.length).toBeLessThan(5)
    expect(r.length).toBeGreaterThan(0)
  })
})

describe('EventStore.addListener', () => {
  let dir: string
  let store: EventStore

  beforeEach(() => { dir = tmp(); store = new EventStore(dir) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('notifies listeners after append with the appended event', async () => {
    const seen: any[] = []
    store.addListener((petId, ev) => seen.push({ petId, ev }))
    const id = await store.append('stlulu', { type: 'chat_turn', source: 'chat', data: {} })
    expect(seen).toHaveLength(1)
    expect(seen[0].petId).toBe('stlulu')
    expect(seen[0].ev.id).toBe(id)
    expect(seen[0].ev.type).toBe('chat_turn')
    expect(seen[0].ev.ts).toBeTypeOf('number')
  })

  it('removeListener stops notifications', async () => {
    const seen: any[] = []
    const fn = (_: string, ev: any) => seen.push(ev)
    store.addListener(fn)
    store.removeListener(fn)
    await store.append('stlulu', { type: 'chat_turn', source: 'chat', data: {} })
    expect(seen).toHaveLength(0)
  })

  it('listener throwing does not break append or other listeners', async () => {
    const ok: any[] = []
    store.addListener(() => { throw new Error('boom') })
    store.addListener((_, ev) => ok.push(ev))
    const id = await store.append('stlulu', { type: 'chat_turn', source: 'chat', data: {} })
    expect(id).toBeTypeOf('string')
    expect(ok).toHaveLength(1)
  })
})
