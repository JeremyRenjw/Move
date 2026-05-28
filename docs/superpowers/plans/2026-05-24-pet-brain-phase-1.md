# 阶段 1：事件流 + 结构化记忆 实施 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给宠物加一个统一的事件流（`events.jsonl`）和结构化记忆（`facts.jsonl`），作为后续 reflector、playbook、反馈循环的数据基础。

**Architecture:** 新建两个 store 类（`EventStore` / `FactStore`，挂在 `MemoryStore` 上），在 ipc.ts / event-router.ts / monitor.ts 五个写入点上接入事件追加；改造 `ai.summarizeForMemory` 在产出 markdown 之外额外输出结构化 facts。所有事件/事实写到每个宠物自己的 `memory/<petId>/` 目录下，新增功能不破坏现有的 MEMORY.md 流。

**Tech Stack:** TypeScript / Electron / Node fs `appendFile` / vitest / 真实临时目录测试（参照 `hook-installer.test.ts`）。

---

## 文件结构

**新建**：
- `electron/event-store.ts` — `EventStore` 类，jsonl 追加/读取/按月归档
- `electron/fact-store.ts` — `FactStore` 类，结构化 fact 追加/查询/supersede
- `tests/event-store.test.ts`
- `tests/fact-store.test.ts`
- `tests/ai-facts.test.ts` — `parseFactsBlock` 单元测试

**修改**：
- `src-shared/types.ts` — 新增 `PetEvent` / `EventType` / `MemoryFact` / `MemoryFactType` 类型
- `electron/ai.ts` — `summarizeForMemory` 返回值变成 `{ markdown, facts }`，prompt 加 facts JSON 输出要求；导出 `parseFactsBlock`
- `electron/memory.ts` — `summarizeAndAppend` 接受新格式并把 facts 写到 fact-store
- `electron/main.ts` — 实例化 EventStore / FactStore，注入 ipc/router
- `electron/ipc.ts` — 5 个写入点 append 事件
- `electron/event-router.ts` — 加 `onEvent` 钩子写事件流
- `electron/monitor.ts` — 加 30 分钟节流采样回调

---

## 任务总览

| Task | 名称 | 估时 |
|---|---|---|
| 1 | 类型定义 | 10 min |
| 2 | EventStore：append + recent | 30 min |
| 3 | EventStore：range + byType | 20 min |
| 4 | EventStore：50MB rotate | 20 min |
| 5 | FactStore：add + list | 25 min |
| 6 | FactStore：supersede + delete | 20 min |
| 7 | `ai.summarizeForMemory` 拆出 facts | 40 min |
| 8 | `memory.summarizeAndAppend` 接 fact-store | 20 min |
| 9 | main.ts 装配 + 注入 | 20 min |
| 10 | ipc.ts 接入 chat_turn / cli_task 事件 | 30 min |
| 11 | event-router.ts 接入 hook_signal 事件 | 20 min |
| 12 | monitor.ts 加 30min 节流采样 | 25 min |
| 13 | 集成验证 + 提交 | 20 min |

---

### Task 1: 在 types.ts 加事件流和 fact 类型

**Files:**
- Modify: `src-shared/types.ts`（末尾追加）

- [ ] **Step 1: 在 types.ts 末尾追加新类型**

打开 `src-shared/types.ts`，在文件末尾追加：

```ts
// ─── Pet brain: 事件流 + 结构化记忆 ───

export type EventType =
  | 'chat_turn'
  | 'cli_task'
  | 'hook_signal'
  | 'system_snapshot'
  | 'reflector_tick'
  | 'user_feedback'
  | 'playbook_created'
  | 'playbook_used'

export type EventSource = 'chat' | 'cli' | 'hook' | 'system' | 'reflector' | 'user'

export interface PetEvent {
  id:     string             // uuid v4
  ts:     number             // epoch ms
  type:   EventType
  source: EventSource
  data:   Record<string, unknown>
}

export type MemoryFactType =
  | 'user_profile'
  | 'preference'
  | 'project'
  | 'event'
  | 'feedback'

export interface MemoryFact {
  id:            string
  ts:            number
  type:          MemoryFactType
  content:       string
  confidence:    number          // 0..1
  source: {
    eventId?: string
    note?:    string             // 'summarized' | 'user-said' | 'corrected'
  }
  superseded_by?: string         // 被新 fact 取代时指向新 id
}
```

- [ ] **Step 2: 跑 build 确认类型不冲突**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`，无 TS 错误。

- [ ] **Step 3: 提交**

```bash
git add src-shared/types.ts
git commit -m "feat(types): add PetEvent and MemoryFact for pet brain phase 1"
```

---

### Task 2: EventStore — append + recent（先写测试）

**Files:**
- Create: `tests/event-store.test.ts`
- Create: `electron/event-store.ts`

- [ ] **Step 1: 写第一组失败测试**

创建 `tests/event-store.test.ts`：

```ts
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
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -20
```

Expected: 测试失败，因为 `electron/event-store.ts` 还不存在。

- [ ] **Step 3: 实现最小 EventStore**

创建 `electron/event-store.ts`：

```ts
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { PetEvent } from '@shared/types'

const EVENTS_FILE = 'events.jsonl'

export class EventStore {
  constructor(private root: string) {}

  private petDir(petId: string): string {
    return path.join(this.root, petId)
  }

  private activeFile(petId: string): string {
    return path.join(this.petDir(petId), EVENTS_FILE)
  }

  async append(petId: string, ev: Omit<PetEvent, 'id' | 'ts'>): Promise<string> {
    const full: PetEvent = { id: randomUUID(), ts: Date.now(), ...ev }
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(this.activeFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    return full.id
  }

  async recent(petId: string, n: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    return tail.map(l => JSON.parse(l) as PetEvent).reverse()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -10
```

Expected: 4 个测试都 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/event-store.ts tests/event-store.test.ts
git commit -m "feat(event-store): append + recent (per-pet jsonl)"
```

---

### Task 3: EventStore — range + byType

**Files:**
- Modify: `tests/event-store.test.ts`
- Modify: `electron/event-store.ts`

- [ ] **Step 1: 在测试文件里追加新一组失败测试**

在 `tests/event-store.test.ts` 末尾、`})` 关闭 describe 之前追加：

```ts
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
```

并在文件最顶 import 里加：`import fs from 'node:fs'`（如果还没有）。注意已有的 `import * as fs from 'node:fs'` 可能要改成 `import fs from 'node:fs'` 或保持现状——保持现状的话上面用 `fs.mkdirSync` 仍然能调到。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -10
```

Expected: 2 个新测试失败（"range is not a function"、"byType is not a function"）。

- [ ] **Step 3: 在 EventStore 加 range 和 byType**

打开 `electron/event-store.ts`，在 `recent` 方法下方追加：

```ts
  async range(petId: string, fromTs: number, toTs: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const out: PetEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      const ev = JSON.parse(line) as PetEvent
      if (ev.ts >= fromTs && ev.ts <= toTs) out.push(ev)
    }
    return out
  }

  async byType(petId: string, type: PetEvent['type'], limit: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const out: PetEvent[] = []
    const lines = raw.split('\n').filter(Boolean)
    // 倒着扫，攒够 limit 就停
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const ev = JSON.parse(lines[i]) as PetEvent
      if (ev.type === type) out.push(ev)
    }
    return out
  }
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -10
```

Expected: 全部 6 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/event-store.ts tests/event-store.test.ts
git commit -m "feat(event-store): range + byType queries"
```

---

### Task 4: EventStore — 50MB 月度归档

**Files:**
- Modify: `tests/event-store.test.ts`
- Modify: `electron/event-store.ts`

- [ ] **Step 1: 写归档行为的失败测试**

在 `tests/event-store.test.ts` describe 末尾追加：

```ts
  it('rotates active file when it exceeds the size limit', async () => {
    const small = new EventStore(dir)
    // 用一个小阈值版本（构造函数接受第二个参数）
    const tiny = new (await import('../electron/event-store')).EventStore(dir, 200)
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
    const tiny = new (await import('../electron/event-store')).EventStore(dir, 200)
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -15
```

Expected: 2 个新测试失败（"EventStore is not a constructor with 2 args" 或归档文件没产生）。

- [ ] **Step 3: 在 EventStore 加阈值参数 + 归档逻辑**

打开 `electron/event-store.ts`，把 constructor 和 append 改成：

```ts
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

export class EventStore {
  constructor(private root: string, private maxBytes: number = DEFAULT_MAX_BYTES) {}

  private petDir(petId: string): string {
    return path.join(this.root, petId)
  }

  private activeFile(petId: string): string {
    return path.join(this.petDir(petId), EVENTS_FILE)
  }

  private archiveName(): string {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return `events.${d.getFullYear()}-${mm}.jsonl`
  }

  private async rotateIfNeeded(petId: string): Promise<void> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return
    const stat = await fs.stat(file)
    if (stat.size < this.maxBytes) return
    const archive = path.join(this.petDir(petId), this.archiveName())
    // 若已存在归档（同月），追加到末尾再删原文件
    if (fsSync.existsSync(archive)) {
      const tail = await fs.readFile(file, 'utf-8')
      await fs.appendFile(archive, tail, 'utf-8')
      await fs.unlink(file)
    } else {
      await fs.rename(file, archive)
    }
  }

  async append(petId: string, ev: Omit<PetEvent, 'id' | 'ts'>): Promise<string> {
    const full: PetEvent = { id: randomUUID(), ts: Date.now(), ...ev }
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    await this.rotateIfNeeded(petId)
    await fs.appendFile(this.activeFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    return full.id
  }
```

`recent` / `range` / `byType` 不需要改（它们已经只读 active 文件）。

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/event-store.test.ts 2>&1 | tail -10
```

Expected: 全部 8 个 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/event-store.ts tests/event-store.test.ts
git commit -m "feat(event-store): monthly archive rotation on size threshold"
```

---

### Task 5: FactStore — add + list

**Files:**
- Create: `tests/fact-store.test.ts`
- Create: `electron/fact-store.ts`

- [ ] **Step 1: 写测试**

创建 `tests/fact-store.test.ts`：

```ts
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
    for (let i = 0; i < 5; i++) {
      await store.add('p', {
        type: 'event', content: `c${i}`, confidence: 1, source: {}
      })
    }
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
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/fact-store.test.ts 2>&1 | tail -10
```

Expected: 失败（模块不存在）。

- [ ] **Step 3: 实现 FactStore**

创建 `electron/fact-store.ts`：

```ts
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { MemoryFact, MemoryFactType } from '@shared/types'

const FACTS_FILE = 'facts.jsonl'

interface ListOpts {
  type?:          MemoryFactType
  minConfidence?: number
  limit?:         number
  includeSuperseded?: boolean
}

export class FactStore {
  constructor(private root: string) {}

  private factFile(petId: string): string {
    return path.join(this.root, petId, FACTS_FILE)
  }

  async add(petId: string, fact: Omit<MemoryFact, 'id' | 'ts'>): Promise<string> {
    const full: MemoryFact = { id: randomUUID(), ts: Date.now(), ...fact }
    const dir = path.join(this.root, petId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(this.factFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    return full.id
  }

  async list(petId: string, opts: ListOpts = {}): Promise<MemoryFact[]> {
    const file = this.factFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    let facts = raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as MemoryFact)
    if (!opts.includeSuperseded) facts = facts.filter(f => !f.superseded_by)
    if (opts.type) facts = facts.filter(f => f.type === opts.type)
    if (opts.minConfidence != null) facts = facts.filter(f => f.confidence >= opts.minConfidence!)
    facts.sort((a, b) => b.ts - a.ts)  // newest first
    if (opts.limit != null) facts = facts.slice(0, opts.limit)
    return facts
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/fact-store.test.ts 2>&1 | tail -10
```

Expected: 5 个 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/fact-store.ts tests/fact-store.test.ts
git commit -m "feat(fact-store): add + list with type/confidence/limit filters"
```

---

### Task 6: FactStore — supersede + delete

**Files:**
- Modify: `tests/fact-store.test.ts`
- Modify: `electron/fact-store.ts`

- [ ] **Step 1: 加测试**

在 `tests/fact-store.test.ts` describe 末尾追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/fact-store.test.ts 2>&1 | tail -10
```

Expected: 2 个新测试失败。

- [ ] **Step 3: 实现 supersede + delete**

在 `electron/fact-store.ts` `list` 方法后面追加：

```ts
  async supersede(petId: string, oldId: string, newFact: Omit<MemoryFact, 'id' | 'ts'>): Promise<string> {
    const newId = await this.add(petId, newFact)
    // 把 oldId 那一行重写
    const file = this.factFile(petId)
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).map(l => {
      const f = JSON.parse(l) as MemoryFact
      if (f.id === oldId) f.superseded_by = newId
      return JSON.stringify(f)
    })
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8')
    return newId
  }

  async delete(petId: string, id: string): Promise<void> {
    const file = this.factFile(petId)
    if (!fsSync.existsSync(file)) return
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).filter(l => {
      const f = JSON.parse(l) as MemoryFact
      return f.id !== id
    })
    await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
  }
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/fact-store.test.ts 2>&1 | tail -10
```

Expected: 7 个全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/fact-store.ts tests/fact-store.test.ts
git commit -m "feat(fact-store): supersede (logical replace) + delete (physical remove)"
```

---

### Task 7: 改造 `ai.summarizeForMemory` 让它额外输出 facts

**Files:**
- Create: `tests/ai-facts.test.ts`
- Modify: `electron/ai.ts`

- [ ] **Step 1: 写一个纯函数 `parseFactsBlock` 的失败测试**

创建 `tests/ai-facts.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseFactsBlock } from '../electron/ai'

describe('parseFactsBlock', () => {
  it('extracts a JSON array of facts from a fenced code block', () => {
    const text = `
- 用户偏好 dark mode
- 在做宠物 app

\`\`\`facts
[
  {"type":"preference","content":"喜欢 dark mode","confidence":0.9},
  {"type":"project","content":"在做宠物 app","confidence":0.95}
]
\`\`\`
`
    const out = parseFactsBlock(text)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('preference')
    expect(out[0].confidence).toBe(0.9)
    expect(out[1].content).toBe('在做宠物 app')
  })

  it('returns [] when no facts block', () => {
    expect(parseFactsBlock('just markdown')).toEqual([])
  })

  it('returns [] when block has invalid JSON', () => {
    const text = '```facts\nnot json\n```'
    expect(parseFactsBlock(text)).toEqual([])
  })

  it('filters out entries with unknown type', () => {
    const text = '```facts\n[{"type":"weird","content":"x","confidence":1}]\n```'
    expect(parseFactsBlock(text)).toEqual([])
  })

  it('clamps confidence into [0,1]', () => {
    const text = '```facts\n[{"type":"event","content":"x","confidence":2}]\n```'
    const out = parseFactsBlock(text)
    expect(out[0].confidence).toBe(1)
  })

  it('strips facts block from markdown for the human-readable part', () => {
    const text = `头部
\`\`\`facts
[{"type":"event","content":"x","confidence":0.5}]
\`\`\`
尾部`
    // parseFactsBlock 不负责剥离，剥离由调用方做。这里只验证 parse 返回正确。
    const out = parseFactsBlock(text)
    expect(out).toHaveLength(1)
  })
})

describe('stripFactsBlock', () => {
  it('removes the fenced facts block, keeps surrounding markdown', async () => {
    const { stripFactsBlock } = await import('../electron/ai')
    const text = `头部内容

\`\`\`facts
[{"type":"event","content":"x","confidence":0.5}]
\`\`\`

尾部内容`
    const out = stripFactsBlock(text)
    expect(out).toContain('头部内容')
    expect(out).toContain('尾部内容')
    expect(out).not.toContain('facts')
    expect(out).not.toContain('```')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/ai-facts.test.ts 2>&1 | tail -10
```

Expected: 失败（`parseFactsBlock` 和 `stripFactsBlock` 没导出）。

- [ ] **Step 3: 在 ai.ts 添加 parser + stripper**

打开 `electron/ai.ts`，在文件顶部 import 后追加：

```ts
const VALID_FACT_TYPES = new Set(['user_profile', 'preference', 'project', 'event', 'feedback'])

export interface ExtractedFact {
  type:       'user_profile' | 'preference' | 'project' | 'event' | 'feedback'
  content:    string
  confidence: number
}

export function parseFactsBlock(text: string): ExtractedFact[] {
  const m = text.match(/```facts\s*\n([\s\S]*?)\n```/)
  if (!m) return []
  let arr: unknown
  try { arr = JSON.parse(m[1]) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const out: ExtractedFact[] = []
  for (const item of arr) {
    const o = item as { type?: string; content?: string; confidence?: number }
    if (!o || typeof o.content !== 'string' || !o.content.trim()) continue
    if (typeof o.type !== 'string' || !VALID_FACT_TYPES.has(o.type)) continue
    const c = Math.max(0, Math.min(1, Number(o.confidence ?? 0.5)))
    out.push({ type: o.type as ExtractedFact['type'], content: o.content.trim(), confidence: c })
  }
  return out
}

export function stripFactsBlock(text: string): string {
  return text.replace(/```facts\s*\n[\s\S]*?\n```\s*/g, '').trim()
}
```

然后修改 `MEMORY_INSTRUCTION` 末尾的输出说明（找到 `MEMORY_INSTRUCTION` 那个 const，把最后一行从"只输出新增的 markdown 列表，或 NONE"改为）：

```ts
const MEMORY_INSTRUCTION = `下面是对话历史。请挑出**值得长期记住**的事实，按这些类别合并到现有记忆里：
- 用户偏好（工具、风格、习惯）
- 用户身份/背景（角色、技术栈、项目）
- 重要事件或决定
- 用户给你的反馈（什么该做、什么不该做)

要求：
- markdown 列表格式，每条一行
- 不要保存当前任务细节、闲聊、临时上下文
- 与现有记忆重复的不要写
- 没什么值得记的就回复一个字符串"NONE"

现有记忆：
{{EXISTING}}

对话历史：
{{HISTORY}}

输出格式：先输出 markdown 列表（人类阅读），如果有可结构化的事实，**额外**在末尾追加一个 fenced 代码块：

\`\`\`facts
[
  {"type":"preference|user_profile|project|event|feedback","content":"一句话事实","confidence":0.0-1.0}
]
\`\`\`

如果完全没东西记，只输出 NONE，没别的。`
```

最后改造 `summarizeForMemory` 的**返回值**——把它从 `Promise<string | null>` 改为 `Promise<{ markdown: string; facts: ExtractedFact[] } | null>`：

```ts
async summarizeForMemory(opts: {
  apiConfig: ApiConfig
  apiKey: string
  history: ChatMessage[]
  existingMemory: string
}): Promise<{ markdown: string; facts: ExtractedFact[] } | null> {
  const { apiConfig, apiKey, history, existingMemory } = opts
  const openaiBase = apiConfig.baseUrl
    ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
    : undefined
  const historyText = history
    .filter(m => m.role === 'user' || m.role === 'pet')
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n\n')
  const prompt = MEMORY_INSTRUCTION
    .replace('{{EXISTING}}', existingMemory || '（空）')
    .replace('{{HISTORY}}', historyText)

  let text = ''
  if (apiConfig.provider === 'claude') {
    const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
    const resp = await client.messages.create({
      model: apiConfig.model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    })
    const block = resp.content.find(b => b.type === 'text')
    text = block && block.type === 'text' ? block.text.trim() : ''
  } else {
    const client = new OpenAI({ apiKey, baseURL: apiConfig.baseUrl || undefined })
    const resp = await client.chat.completions.create({
      model: apiConfig.model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    })
    text = (resp.choices?.[0]?.message?.content ?? '').trim()
  }

  if (!text || text === 'NONE') return null
  const facts = parseFactsBlock(text)
  const markdown = stripFactsBlock(text)
  if (!markdown && facts.length === 0) return null
  return { markdown, facts }
}
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/ai-facts.test.ts 2>&1 | tail -10
```

Expected: 7 个全部 PASS。

- [ ] **Step 5: 跑 build 验证类型**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`。如果有 TS 错误说 `summarizeForMemory` 的调用方期望 `string`，**先不修，下一个 Task 来修**——但如果阻塞 build，临时让调用方 `as unknown as string` 兜底。实际上调用方在 `MemoryStore.summarizeAndAppend` 里，下一个 Task 处理。

如果 build 报错指向 `memory.ts:55`，临时改 memory.ts 那行：

```ts
const summary = await summarizer.summarizeForMemory({ history, existingMemory: existing })
if (!summary || !summary.trim()) return
```

→

```ts
const result = await summarizer.summarizeForMemory({ history, existingMemory: existing })
if (!result || !result.markdown.trim()) return
const summary = result.markdown
```

（只是把字段访问改对，下个 Task 会把 facts 也用上）

- [ ] **Step 6: 提交**

```bash
git add electron/ai.ts tests/ai-facts.test.ts electron/memory.ts
git commit -m "feat(ai): summarizeForMemory now also returns structured facts"
```

---

### Task 8: `memory.summarizeAndAppend` 把 facts 写到 FactStore

**Files:**
- Modify: `electron/memory.ts`

- [ ] **Step 1: 改写 MemoryStore，注入 FactStore**

打开 `electron/memory.ts`，整体改成：

```ts
import fs from 'fs/promises'
import path from 'path'
import type { ChatMessage } from '@shared/types'
import type { FactStore } from './fact-store'
import type { ExtractedFact } from './ai'

const MEMORY_FILE = 'MEMORY.md'
const SESSIONS_FILE = 'sessions.jsonl'
const MAX_MEMORY_CHARS = 8000

export interface MemorySummarizer {
  summarizeForMemory(opts: {
    history: ChatMessage[]
    existingMemory: string
  }): Promise<{ markdown: string; facts: ExtractedFact[] } | null>
}

export class MemoryStore {
  private root: string

  constructor(userData: string, private facts?: FactStore) {
    this.root = path.join(userData, 'memory')
  }

  private petDir(petId: string): string {
    return path.join(this.root, petId)
  }

  async readMemory(petId: string): Promise<string> {
    try {
      const raw = await fs.readFile(path.join(this.petDir(petId), MEMORY_FILE), 'utf-8')
      if (raw.length > MAX_MEMORY_CHARS) return raw.slice(-MAX_MEMORY_CHARS)
      return raw
    } catch {
      return ''
    }
  }

  async appendSession(petId: string, history: ChatMessage[]): Promise<void> {
    if (history.length === 0) return
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify({ ts: Date.now(), history }) + '\n'
    await fs.appendFile(path.join(dir, SESSIONS_FILE), line, 'utf-8')
  }

  async summarizeAndAppend(
    petId: string,
    summarizer: MemorySummarizer,
    history: ChatMessage[]
  ): Promise<void> {
    if (history.length < 2) return
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    const existing = await this.readMemory(petId)
    const result = await summarizer.summarizeForMemory({ history, existingMemory: existing })
    if (!result) return

    if (result.markdown.trim()) {
      const stamp = new Date().toISOString().slice(0, 10)
      const block = `\n## ${stamp}\n${result.markdown.trim()}\n`
      await fs.appendFile(path.join(dir, MEMORY_FILE), block, 'utf-8')
    }

    if (this.facts && result.facts.length > 0) {
      for (const f of result.facts) {
        await this.facts.add(petId, {
          type:       f.type,
          content:    f.content,
          confidence: f.confidence,
          source:     { note: 'summarized' }
        }).catch(err => console.error('[memory] add fact failed:', err))
      }
    }
  }
}
```

- [ ] **Step 2: 跑 build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`，无 TS 错误。

- [ ] **Step 3: 跑现有测试确认没有回归**

```bash
npx vitest run tests/ 2>&1 | tail -10
```

Expected: 在改动前已经失败的 4 个测试还失败，但**没有新增失败**。具体说：character/monitor/runner 那 4 个老 bug 仍然 fail，其它全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add electron/memory.ts
git commit -m "feat(memory): forward extracted facts to FactStore when present"
```

---

### Task 9: main.ts 装配 EventStore + FactStore

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: 在 main.ts 里实例化两个 store**

打开 `electron/main.ts`，在 import 块中加：

```ts
import { EventStore }           from './event-store'
import { FactStore }            from './fact-store'
```

在 `const memory = new MemoryStore(userData)` 这行**之前**加：

```ts
    const events = new EventStore(path.join(userData, 'memory'))
    const facts  = new FactStore(path.join(userData, 'memory'))
```

把那行改成：

```ts
    const memory  = new MemoryStore(userData, facts)
```

然后把 `registerIpcHandlers({...})` 调用里加上 `events`：

```ts
    registerIpcHandlers({
      wm, pets, chars, ai, runner, cleanup, monitor, memory, watcher,
      getStats: () => latestStats,
      eventRouter, eventServer, runtimeState,
      events
    })
```

- [ ] **Step 2: 在 ipc.ts 的 deps 类型里临时加 events 字段（光声明不用，下个 task 用）**

打开 `electron/ipc.ts`，找到 `registerIpcHandlers` 的 deps 类型签名，加：

```ts
export function registerIpcHandlers(deps: {
  wm:          WindowManager
  // ... 已有的
  events:      EventStore   // 新增
}): void {
```

在文件顶部 import：

```ts
import type { EventStore } from './event-store'
```

并在 `const { wm, ... } = deps` 那一行补上 `events`：

```ts
  const { wm, pets, chars, ai, runner, cleanup, memory, watcher, getStats, eventRouter, eventServer, runtimeState, events } = deps
  void events  // 下个 task 会用
```

- [ ] **Step 3: 跑 build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`，无 TS 错误。

- [ ] **Step 4: 提交**

```bash
git add electron/main.ts electron/ipc.ts
git commit -m "feat(main): wire EventStore and FactStore into MemoryStore + ipc deps"
```

---

### Task 10: ipc.ts 接 chat_turn / cli_task 事件

**Files:**
- Modify: `electron/ipc.ts`

- [ ] **Step 1: 在 CHAT_SEND handler 接入 chat_turn 事件**

打开 `electron/ipc.ts`，删掉上一步加的 `void events`。

找到 slash 分支末尾（`wm.broadcast(IPC.CHAT_DONE, {})` 之前，也就是 CLI 跑完之后）的 try/catch 之后，加：

```ts
      events.append(petId, {
        type: 'cli_task', source: 'cli',
        data: { cmd: slash.cmd, args, viaSlash: true, prompt: slash.prompt }
      }).catch(err => console.error('[events] append failed:', err))
```

具体定位：在 slash 分支的 `} catch (err) { ... }` 之后、`wm.broadcast(IPC.CHAT_DONE, {})` 之前。

接着在 AI 主路径里。找到 `const { text: replyText, toolCall } = await ai.chat({...})` 拿到 replyText 之后、`if (toolCall) {` 之前，加：

```ts
      events.append(petId, {
        type: 'chat_turn', source: 'chat',
        data: {
          userMsg: message.slice(0, 500),
          petReply: replyText.slice(0, 500),
          hadToolCall: !!toolCall
        }
      }).catch(err => console.error('[events] append failed:', err))
```

然后在 AI 主路径的 toolCall 分支里，CLI 跑完之后（`wm.broadcast(IPC.CLI_DONE, ...)` 之后、`await ai.chat({... 任务完成 ...})` 之前），加：

```ts
        events.append(petId, {
          type: 'cli_task', source: 'cli',
          data: {
            cmd, args, viaSlash: false,
            prompt: toolCall.prompt,
            exitCode: result.exitCode,
            outputTail: result.output.slice(-500)
          }
        }).catch(err => console.error('[events] append failed:', err))
```

- [ ] **Step 2: 跑 build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`。

- [ ] **Step 3: 手动确认事件流写入**

```bash
npm run dev &
APP_PID=$!
sleep 5
# 在 panel 里发一句话（这一步需要你手动），然后查文件
ls -la "$HOME/Library/Application Support/Mote/memory/stlulu/" 2>/dev/null || \
  ls -la "$HOME/Library/Application Support/mote/memory/stlulu/" 2>/dev/null || \
  find "$HOME/Library/Application Support" -name "events.jsonl" -path "*mote*" 2>/dev/null | head -3
kill $APP_PID 2>/dev/null
```

Expected: 能看到 `events.jsonl` 文件，里面有 chat_turn 行。

> 注意：这步需要你在 app 里手动发一句话。如果跑 plan 的是 subagent，subagent 没法点 UI，跳过这步、靠 build 通过和下个 task 的集成测试做收尾。

- [ ] **Step 4: 提交**

```bash
git add electron/ipc.ts
git commit -m "feat(ipc): emit chat_turn + cli_task events on every chat round"
```

---

### Task 11: event-router.ts 接 hook_signal 事件

**Files:**
- Modify: `electron/event-router.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: 在 EventRouter 加 onEvent 回调**

打开 `electron/event-router.ts`，在 `RouterDeps` 接口加：

```ts
interface RouterDeps {
  showBubble: (label: string, source: string) => void
  onEvent?:   (ev: NotifyEvent) => void   // raw event hook (for event-stream logging)
}
```

在 `handle()` 方法**最顶**（`this.recentBuf.unshift(ev)` **之前**）加：

```ts
    this.deps.onEvent?.(ev)
```

> 这里钉死：用原始事件，不要用 `effective`（classify 后的）。Spec 明确写了"原始 hook 事件，debounce 之前"。

- [ ] **Step 2: 在 main.ts 把 store 接到 router**

打开 `electron/main.ts`，找到 `const eventRouter = new EventRouter({...})`，改成：

```ts
    const eventRouter = new EventRouter({
      showBubble: (label, source) => wm.showBubble({ source: 'watcher', label, timestamp: Date.now() }),
      onEvent: ev => {
        const petId = pets.getActiveId() ?? 'stlulu'
        events.append(petId, {
          type: 'hook_signal', source: 'hook', data: ev
        }).catch(err => console.error('[events] hook signal failed:', err))
      }
    })
```

注意：上面用到的 `events` 必须已经在 main.ts 里实例化（Task 9 做过）。

- [ ] **Step 3: 跑 build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`。

- [ ] **Step 4: 跑现有 event-router 测试，确保新 onEvent 字段是可选的、不影响老测试**

```bash
npx vitest run tests/event-router.test.ts 2>&1 | tail -10
```

Expected: 全部 PASS（老测试没传 onEvent，可选字段不应破坏）。

- [ ] **Step 5: 提交**

```bash
git add electron/event-router.ts electron/main.ts
git commit -m "feat(event-router): forward raw hook events to EventStore via onEvent hook"
```

---

### Task 12: monitor.ts 加 30 分钟节流采样

**Files:**
- Modify: `electron/main.ts`

> Spec 明确说"现有 5 秒 MONITOR_STATS 不进事件流"，所以最干净的做法是不动 monitor.ts，在 main.ts 里加一个 setInterval。

- [ ] **Step 1: 在 main.ts 加 30 分钟节流采样**

打开 `electron/main.ts`，找到 `monitor.start(stats => {...})` 块**之后**，加：

```ts
    const SNAPSHOT_MS = 30 * 60_000
    setInterval(() => {
      const petId = pets.getActiveId() ?? 'stlulu'
      events.append(petId, {
        type: 'system_snapshot', source: 'system', data: latestStats
      }).catch(err => console.error('[events] snapshot failed:', err))
    }, SNAPSHOT_MS).unref()
```

`.unref()` 让这个 timer 不阻塞 Electron 退出。

- [ ] **Step 2: 跑 build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`。

- [ ] **Step 3: 提交**

```bash
git add electron/main.ts
git commit -m "feat(main): periodic system_snapshot every 30min into event stream"
```

---

### Task 13: 集成验证 + 收尾

**Files:**（无新增改动）

- [ ] **Step 1: 跑全套测试，确保没有新增失败**

```bash
npx vitest run tests/ 2>&1 | grep -E "Test Files|Tests " | tail -3
```

Expected:
```
Test Files  3 failed | 9 passed (12)
      Tests  4 failed | 64 passed (68)
```

（Files 数从 10 涨到 12 因为加了 event-store + fact-store；Tests 加了大约 14 个；老 4 个失败不变）

如果新增了失败测试，停下来定位修复，**不要**进 step 2。

- [ ] **Step 2: 跑一次完整 build 确认无 TS 错误**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built`。

- [ ] **Step 3: 看 git log**

```bash
git log --oneline master..HEAD
```

Expected: 看到 task 1-12 一共大约 12 个 commit，全部 conventional commit 风格。

- [ ] **Step 4: 推上去**

```bash
git push
```

Expected: push 成功（upstream 已设）。

- [ ] **Step 5: 通知用户阶段 1 完成**

text: "阶段 1 完成，已推到 `feat/cli-hook-watchdog`。可以打开 app 跑几分钟看 `~/Library/Application Support/Mote/memory/<petId>/events.jsonl` 是否在累积，确认无误后开阶段 2。"

---

## 验收清单（spec 阶段 1 验收对照）

- [x] 启动后 events.jsonl 累积 → Task 9-12 接入完成，运行时自动累积
- [x] facts.jsonl 能看到结构化事实 → Task 7+8 改造 summarizeForMemory 写入
- [x] MEMORY.md 继续工作不退化 → Task 8 保留原行为
- [x] 现有功能不受影响 → 所有改动都是新增/包装，Task 13 跑全套测试验证
