# LLM Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an `Agenda` module that lets an LLM autonomously propose pet goals in parallel with the existing rule engine, raising the pet's autonomy from rule-driven to LLM-driven while keeping the rule engine as a safety net.

**Architecture:** New `electron/agenda.ts` holds a persisted queue of `PendingGoal`. It is triggered by (a) idle heartbeat every 25 min, (b) `EventStore` listener (debounced 5s, throttled 3 min). On trigger it calls a new `ai.planAgenda()` returning up to 3 goals with `delayMinutes` / `ttlMinutes`. `DriveEngine.tick()` merges `agenda.peek(now)` with rule goals through the existing `applyModifiers` + `dedup` pipeline. Failure modes degrade to pure-rule behavior.

**Tech Stack:** TypeScript, Electron, vitest, OpenAI/Anthropic SDK (existing in `ai.ts`).

**Spec:** `docs/superpowers/specs/2026-05-28-llm-agenda-design.md`

**Scope:** This plan covers P1 + P2 from the spec (skeleton + heartbeat + parallel wiring + event-driven trigger + persistence + feedback sharing). P3 (read-only tools) and P4 (replay & rollout) are separate plans.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-shared/types.ts` | Add `source?: 'rule' \| 'agenda'` to `PetGoal`. |
| `electron/agenda.ts` (new) | `Agenda` class + `PendingGoal` type. Holds queue, schedules ticks, calls `ai.planAgenda`, persists to JSONL. |
| `electron/ai.ts` | New `planAgenda()` method following the same pattern as `reflect()`. |
| `electron/event-store.ts` | Add `addListener(fn)` / `removeListener(fn)`; call listeners after each `append()`. |
| `electron/drive-engine.ts` | Inject optional `agenda` dep; in `tick()` merge `agenda.peek(now)` with rule goals; call `agenda.consume(id)` after executing an agenda-sourced goal. |
| `electron/main.ts` | Construct `Agenda`, register as `EventStore` listener, pass into `DriveEngine`, honor `PET_AGENDA_OFF` env var. |
| `tests/agenda.test.ts` (new) | Unit tests for queue, peek/consume, debounce, persistence. |
| `tests/agenda.persistence.test.ts` (new) | Tests for JSONL write/replay/compaction. |
| `tests/drive-engine-with-agenda.test.ts` (new) | Integration tests for rule+agenda merge through DriveEngine. |
| `tests/event-store.test.ts` | Extend (or create if missing) with listener tests. |

---

## Task 1: Add `source` field to `PetGoal`

**Files:**
- Modify: `src-shared/types.ts:358-366`

- [ ] **Step 1: Edit type definition**

Locate `PetGoal` and add the optional `source` field.

```typescript
export interface PetGoal {
  id: string
  kind: PetGoalKind
  priority: number        // 0-100, 越高越优先
  action: 'bubble' | 'agent_task'
  bubble?: string         // bubble 模式的文案
  agentGoal?: string      // agent_task 模式的目标描述
  cooldownKey: string     // 用于防重复
  source?: 'rule' | 'agenda'  // default 'rule' when omitted
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src-shared/types.ts
git commit -m "feat(types): add PetGoal.source field for rule/agenda provenance"
```

---

## Task 2: Add listener hook to `EventStore`

**Files:**
- Modify: `electron/event-store.ts`
- Test: `tests/event-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/event-store.test.ts` if missing. If it already exists, append.

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventStore } from '../electron/event-store'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-store-'))
}

describe('EventStore.addListener', () => {
  let dir: string
  let store: EventStore

  beforeEach(() => {
    dir = tmpDir()
    store = new EventStore(dir)
  })

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/event-store.test.ts`
Expected: FAIL — `store.addListener is not a function`.

- [ ] **Step 3: Implement listener support**

Edit `electron/event-store.ts`. Add a listener array and notify after `append`:

```typescript
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { PetEvent } from '@shared/types'

const EVENTS_FILE = 'events.jsonl'
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

export type EventListener = (petId: string, ev: PetEvent) => void

export class EventStore {
  private listeners: EventListener[] = []

  constructor(private root: string, private maxBytes: number = DEFAULT_MAX_BYTES) {}

  addListener(fn: EventListener): void {
    this.listeners.push(fn)
  }

  removeListener(fn: EventListener): void {
    this.listeners = this.listeners.filter(l => l !== fn)
  }

  private notify(petId: string, ev: PetEvent): void {
    for (const fn of this.listeners) {
      try { fn(petId, ev) } catch (err) { console.error('[event-store] listener threw:', err) }
    }
  }

  // ...existing private methods unchanged...

  async append(petId: string, ev: Omit<PetEvent, 'id' | 'ts'>): Promise<string> {
    const full: PetEvent = { id: randomUUID(), ts: Date.now(), ...ev }
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    await this.rotateIfNeeded(petId)
    await fs.appendFile(this.activeFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    this.notify(petId, full)
    return full.id
  }

  // ...other methods unchanged...
}
```

Keep all existing methods (`recent`, `range`, `byType`, private `petDir` / `activeFile` / `archiveName` / `rotateIfNeeded`) intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/event-store.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/event-store.ts tests/event-store.test.ts
git commit -m "feat(event-store): add addListener/removeListener notified after append"
```

---

## Task 3: Define `PendingGoal` and `Agenda` skeleton (no LLM yet)

**Files:**
- Create: `electron/agenda.ts`
- Test: `tests/agenda.test.ts`

This task builds the queue mechanics with NO LLM call — that comes in Task 5.

- [ ] **Step 1: Write the failing test**

Create `tests/agenda.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Agenda, type PendingGoal } from '../electron/agenda'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-'))
}

function makeDeps(overrides: Partial<any> = {}): any {
  return {
    ai:             { planAgenda: async () => ({ goals: [] }) },
    events:         { range: async () => [], recent: async () => [], byType: async () => [] },
    facts:          { list: async () => [] },
    mood:           { buildMoodContext: () => '', getEnergy: () => 50, tick: () => 'calm' },
    chars:          { getApiConfig: async () => ({ provider: 'claude', model: 'm', baseUrl: '' }), getApiKey: async () => 'k' },
    getStats:       () => ({ cpu: 20, ramUsed: 1e9, ramTotal: 16e9, diskUsed: 30 }),
    getPersona:     async () => 'persona',
    getActivePetId: () => 'stlulu',
    getParams:      () => ({ greetAffectionThreshold: 30, greetHoursThreshold: 4, checkInHoursThreshold: 8, curiosityAffectionThreshold: 70, goalKindMultipliers: {}, cooldownMsByKind: {} }),
    dataDir:        tmpDir(),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agenda.test.ts`
Expected: FAIL — `Cannot find module '../electron/agenda'`.

- [ ] **Step 3: Create `electron/agenda.ts` skeleton**

```typescript
import fs from 'fs'
import path from 'path'
import type { AiEngine } from './ai'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { MoodEngine } from './mood-engine'
import type { CharacterConfigStore } from './character'
import type { PetGoal, SystemStats, DriveParams, PetEvent } from '../src-shared/types'

export interface PendingGoal extends PetGoal {
  notBefore: number
  expiresAt: number
  reason:    string
  createdAt: number
}

export interface AgendaDeps {
  ai:             AiEngine
  events:         EventStore
  facts:          FactStore
  mood:           MoodEngine
  chars:          CharacterConfigStore
  getStats:       () => SystemStats
  getPersona:     () => Promise<string>
  getActivePetId: () => string | null
  getParams:      () => DriveParams
  dataDir:        string
}

export class Agenda {
  private goals: PendingGoal[] = []
  private inflight = false
  private lastTickAt = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null

  constructor(private deps: AgendaDeps) {}

  /** Testing-only injection. */
  injectForTest(goals: PendingGoal[]): void {
    this.goals = [...goals]
  }

  start(): void {
    // Heartbeat wiring added in Task 5.
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.heartbeat = null
    this.debounceTimer = null
  }

  peek(now: number): PetGoal[] {
    const active = this.goals
      .filter(g => now >= g.notBefore && now < g.expiresAt)
      .sort((a, b) => b.priority - a.priority)
    return active.map(g => ({
      id:          g.id,
      kind:        g.kind,
      priority:    g.priority,
      action:      g.action,
      bubble:      g.bubble,
      agentGoal:   g.agentGoal,
      cooldownKey: g.cooldownKey,
      source:      'agenda',
    }))
  }

  consume(id: string): void {
    this.goals = this.goals.filter(g => g.id !== id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agenda.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/agenda.ts tests/agenda.test.ts
git commit -m "feat(agenda): skeleton with peek/consume queue mechanics"
```

---

## Task 4: Add `ai.planAgenda()` method

**Files:**
- Modify: `electron/ai.ts` (append a new method on `AiEngine`)
- Test: `tests/ai-plan-agenda.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/ai-plan-agenda.test.ts`. The test exercises the JSON parser directly — we extract a pure function from `planAgenda` to keep things testable without mocking the LLM SDK.

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-plan-agenda.test.ts`
Expected: FAIL — `parsePlanAgendaResponse` not exported.

- [ ] **Step 3: Implement parser and `planAgenda` in `electron/ai.ts`**

At the top of `electron/ai.ts` (or near the other types around line ~60), add the type and parser:

```typescript
export interface PlannedGoal {
  kind:         'greet' | 'check_in' | 'comfort' | 'curiosity' | 'celebrate' | 'remind_rest' | 'system_check'
  bubble?:      string
  agentGoal?:   string
  priority:     number
  delayMinutes: number
  ttlMinutes:   number
  reason:       string
}

export interface PlanAgendaResult {
  goals:         PlannedGoal[]
  silentReason?: string
}

const VALID_KINDS: ReadonlySet<string> = new Set(
  ['greet', 'check_in', 'comfort', 'curiosity', 'celebrate', 'remind_rest', 'system_check']
)

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function extractJsonBlob(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace  = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1)
  return text.trim()
}

export function parsePlanAgendaResponse(raw: string): PlanAgendaResult {
  let parsed: any
  try {
    parsed = JSON.parse(extractJsonBlob(raw))
  } catch {
    return { goals: [], silentReason: 'parse_error' }
  }
  if (!parsed || !Array.isArray(parsed.goals)) {
    return { goals: [], silentReason: 'no_goals_array' }
  }
  const cleaned: PlannedGoal[] = []
  for (const g of parsed.goals) {
    if (!g || typeof g !== 'object') continue
    if (!VALID_KINDS.has(g.kind)) continue
    if (typeof g.priority !== 'number' || typeof g.delayMinutes !== 'number' || typeof g.ttlMinutes !== 'number') continue
    cleaned.push({
      kind:         g.kind,
      bubble:       typeof g.bubble === 'string' ? g.bubble : undefined,
      agentGoal:    typeof g.agentGoal === 'string' ? g.agentGoal : undefined,
      priority:     clamp(Math.round(g.priority), 0, 100),
      delayMinutes: Math.max(0, Math.round(g.delayMinutes)),
      ttlMinutes:   Math.max(1, Math.round(g.ttlMinutes)),
      reason:       typeof g.reason === 'string' ? g.reason : '',
    })
  }
  cleaned.sort((a, b) => b.priority - a.priority)
  const top = cleaned.slice(0, 3)
  const out: PlanAgendaResult = { goals: top }
  if (top.length === 0 && typeof parsed.silentReason === 'string') {
    out.silentReason = parsed.silentReason
  }
  return out
}
```

Then add the `planAgenda` method on the `AiEngine` class. Place it next to `reflect()` (around line 951):

```typescript
async planAgenda(opts: {
  apiConfig:     ApiConfig
  apiKey:        string
  petPersona:    string
  moodContext:   string
  stats:         { cpu: number; ramUsed: number; ramTotal: number; diskUsed: number }
  recentEvents:  { type: string; source: string; data: Record<string, unknown>; ts: number }[]
  todayTimeline: { type: string; source: string; ts: number }[]
  topFacts:      { type: string; content: string; confidence: number }[]
  recentBubbles: string[]
  existingGoals: { kind: string; reason: string }[]
  signal?:       AbortSignal
}): Promise<PlanAgendaResult> {
  const { apiConfig, apiKey, petPersona, moodContext, stats, recentEvents, todayTimeline, topFacts, recentBubbles, existingGoals, signal } = opts
  const openaiBase = apiConfig.baseUrl
    ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
    : undefined

  const prompt = `${petPersona}

你是这个宠物的「议程脑」。你的工作：决定接下来一段时间里宠物想做什么。

可用 goal kind：
- greet:        打招呼/想念
- check_in:     例行关心
- comfort:      安慰
- curiosity:    好奇心驱动的提问
- celebrate:    庆祝成就
- remind_rest:  提醒休息
- system_check: 系统状态异常（agentGoal 是一条 shell 任务描述）

${moodContext ? moodContext + '\n' : ''}
当前系统：CPU ${stats.cpu}%，RAM ${(stats.ramUsed/1e9).toFixed(1)}/${(stats.ramTotal/1e9).toFixed(1)}GB，磁盘 ${stats.diskUsed}%

最近 30 分钟事件：
${JSON.stringify(recentEvents.slice(-30))}

今日时间线摘要：
${JSON.stringify(todayTimeline.slice(-30))}

你已知的事实（按置信度）：
${topFacts.map(f => `[${f.type}] ${f.content} (conf=${f.confidence})`).join('\n') || '（空）'}

最近说过的话（不要重复）：
${recentBubbles.slice(-10).map(b => '- ' + b).join('\n') || '（空）'}

队列里已有但未执行的 goal：
${existingGoals.map(g => `- ${g.kind}: ${g.reason}`).join('\n') || '（空）'}

规则：
1. 最多 3 个 goal，宁少勿多。沉默是默认选项。
2. 已有的类似 goal 不要再加。
3. 用户 5 分钟内有交互 + cpu<70% → 倾向沉默。
4. priority 0-100；delayMinutes 0 为立即；ttlMinutes 决定多久过期。
5. bubble 文案 ≤ 28 字。agentGoal 仅用于 system_check。

只输出一行严格 JSON：
{"goals":[{"kind":"...","bubble":"...","priority":50,"delayMinutes":0,"ttlMinutes":30,"reason":"..."}]}
或：{"goals":[],"silentReason":"..."}`

  const FAIL: PlanAgendaResult = { goals: [], silentReason: 'network_or_timeout' }
  try {
    if (apiConfig.provider === 'claude') {
      const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
      const resp = await client.messages.create({
        model: apiConfig.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }, { signal })
      const block = resp.content.find(b => b.type === 'text')
      const text = block && block.type === 'text' ? block.text.trim() : ''
      return parsePlanAgendaResponse(text)
    }
    const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
    const resp = await client.chat.completions.create({
      model:       apiConfig.model,
      max_tokens:  800,
      messages:    [{ role: 'user', content: prompt }],
    }, { signal })
    return parsePlanAgendaResponse(resp.choices?.[0]?.message?.content ?? '')
  } catch {
    return FAIL
  }
}
```

`Anthropic` and `OpenAI` are already imported at the top of `ai.ts` (used by `reflect`). `ApiConfig` is the existing type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-plan-agenda.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/ai.ts tests/ai-plan-agenda.test.ts
git commit -m "feat(ai): add planAgenda + parsePlanAgendaResponse with top-3 cap"
```

---

## Task 5: Agenda heartbeat tick that calls `planAgenda` and enqueues goals

**Files:**
- Modify: `electron/agenda.ts`
- Modify: `tests/agenda.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/agenda.test.ts`:

```typescript
import type { PlanAgendaResult } from '../electron/ai'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agenda.test.ts`
Expected: FAIL — `a.tick is not a function` (or planAgenda not called).

- [ ] **Step 3: First, add `agenda_tick` to the EventType union**

Open `src-shared/types.ts`. Find `export type EventType =` (around line 392) and add `agenda_tick` to the union:

```typescript
export type EventType =
  // ...existing values...
  | 'agenda_tick'
```

Run: `grep -n "EventType =" src-shared/types.ts` to confirm the location. Add `'agenda_tick'` alongside `'reflector_tick'` if it exists; otherwise append at the bottom of the union.

- [ ] **Step 4: Implement `tick()` in `electron/agenda.ts`**

Replace the empty `start()` and add `tick()`:

```typescript
const TICK_MS = 25 * 60_000   // 25 minutes
const LLM_TIMEOUT_MS = 8_000
const MAX_QUEUE_SIZE = 20

export class Agenda {
  // ...existing fields...

  start(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      this.tick('idle').catch(err => console.error('[agenda] heartbeat tick failed:', err))
    }, TICK_MS)
    this.heartbeat.unref()
  }

  async tick(reason: 'idle' | 'event'): Promise<void> {
    if (this.inflight) return
    const petId = this.deps.getActivePetId() ?? 'stlulu'

    const apiKey    = await this.deps.chars.getApiKey().catch(() => '')
    const apiConfig = await this.deps.chars.getApiConfig().catch(() => null)
    if (!apiKey || !apiConfig) return    // safety net: silently degrade

    this.inflight = true
    const startMs = Date.now()
    try {
      const now = Date.now()
      const [recentEvents, todayTimeline, topFacts, persona] = await Promise.all([
        this.deps.events.range(petId, now - 30 * 60_000, now).catch(() => []),
        this.deps.events.range(petId, now - 24 * 3600_000, now).catch(() => []),
        this.deps.facts.list(petId, { minConfidence: 0.5, limit: 20 }).catch(() => []),
        this.deps.getPersona().catch(() => ''),
      ])

      const stats       = this.deps.getStats()
      const moodContext = this.deps.mood.buildMoodContext()
      const existing    = this.goals
        .filter(g => now < g.expiresAt)
        .map(g => ({ kind: g.kind, reason: g.reason }))

      const signal = AbortSignal.timeout(LLM_TIMEOUT_MS)
      const result = await this.deps.ai.planAgenda({
        apiConfig,
        apiKey,
        petPersona:    persona,
        moodContext,
        stats,
        recentEvents:  recentEvents.map(e => ({ type: e.type, source: e.source, data: e.data, ts: e.ts })),
        todayTimeline: todayTimeline.map(e => ({ type: e.type, source: e.source, ts: e.ts })),
        topFacts:      topFacts.map(f => ({ type: f.type, content: f.content, confidence: f.confidence })),
        recentBubbles: [],   // wired in a later task; empty for now
        existingGoals: existing,
        signal,
      })

      const afterNow = Date.now()
      for (const g of result.goals) {
        const pending: PendingGoal = {
          id:          randomUUID(),
          kind:        g.kind,
          priority:    g.priority,
          action:      g.kind === 'system_check' ? 'agent_task' : 'bubble',
          bubble:      g.bubble,
          agentGoal:   g.agentGoal,
          cooldownKey: g.kind,
          source:      'agenda',
          notBefore:   afterNow + g.delayMinutes * 60_000,
          expiresAt:   afterNow + g.ttlMinutes * 60_000,
          reason:      g.reason,
          createdAt:   afterNow,
        }
        this.goals.push(pending)
      }

      // Cap memory queue.
      if (this.goals.length > MAX_QUEUE_SIZE) {
        this.goals.sort((a, b) => b.priority - a.priority)
        this.goals = this.goals.slice(0, MAX_QUEUE_SIZE)
      }

      await this.deps.events.append(petId, {
        type:   'agenda_tick',
        source: 'reflector',
        data:   {
          reason,
          goalsProposed: result.goals.length,
          goalsAccepted: result.goals.length,
          llmMs:         Date.now() - startMs,
          silentReason:  result.silentReason ?? null,
        },
      }).catch(err => console.error('[agenda] event append failed:', err))

      this.lastTickAt = afterNow
    } finally {
      this.inflight = false
    }
  }
}
```

Add `randomUUID` import at the top of the file:

```typescript
import { randomUUID } from 'crypto'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agenda.test.ts`
Expected: PASS — all tests including new tick tests green.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/agenda.ts src-shared/types.ts tests/agenda.test.ts
git commit -m "feat(agenda): heartbeat tick calls planAgenda and enqueues goals"
```

---

## Task 6: Event-driven tick with debounce and throttle

**Files:**
- Modify: `electron/agenda.ts`
- Modify: `tests/agenda.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/agenda.test.ts`:

```typescript
describe('Agenda.onEvent debounce/throttle', () => {
  it('coalesces multiple onEvent calls within 5s window into a single tick', async () => {
    let calls = 0
    const deps = makeDeps({
      ai: { planAgenda: async () => { calls++; return { goals: [] } } },
    })
    const a = new Agenda(deps)
    a.onEvent('chat')
    a.onEvent('hook')
    a.onEvent('task')
    // Wait past the debounce window.
    await new Promise(r => setTimeout(r, 60))   // we'll use a short debounce in tests
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
```

For these tests to be fast, we need configurable timings.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agenda.test.ts`
Expected: FAIL — `a.onEvent is not a function`.

- [ ] **Step 3: Add configurable timings + `onEvent` to `electron/agenda.ts`**

Replace the module-level constants with an options-aware approach. Modify the class to accept optional timings via deps:

```typescript
export interface AgendaDeps {
  // ...existing...
  /** Test-only: override timings. Defaults are production values. */
  timings?: {
    heartbeatMs?: number   // default 25 * 60_000
    debounceMs?: number    // default 5_000
    throttleMs?: number    // default 3 * 60_000
    llmTimeoutMs?: number  // default 8_000
  }
}

const DEFAULT_TIMINGS = {
  heartbeatMs:  25 * 60_000,
  debounceMs:   5_000,
  throttleMs:   3 * 60_000,
  llmTimeoutMs: 8_000,
}
```

Inside the class, store resolved timings and add `onEvent`:

```typescript
export class Agenda {
  private goals: PendingGoal[] = []
  private inflight = false
  private lastTickAt = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private timings: typeof DEFAULT_TIMINGS

  constructor(private deps: AgendaDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) }
  }

  // ...peek, consume, injectForTest unchanged...

  start(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      this.tick('idle').catch(err => console.error('[agenda] heartbeat tick failed:', err))
    }, this.timings.heartbeatMs)
    this.heartbeat.unref()
  }

  onEvent(_kind: 'hook' | 'chat' | 'task'): void {
    const now = Date.now()
    if (now - this.lastTickAt < this.timings.throttleMs) return  // throttled
    if (this.debounceTimer) return                                // already queued
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.tick('event').catch(err => console.error('[agenda] event tick failed:', err))
    }, this.timings.debounceMs)
  }
}
```

Update the `tick()` method's existing `AbortSignal.timeout(LLM_TIMEOUT_MS)` to use `this.timings.llmTimeoutMs`. Remove the now-unused module-level constants `TICK_MS` and `LLM_TIMEOUT_MS` (replaced by `this.timings`).

Update the test helper in `tests/agenda.test.ts` to pass small timings — modify `makeDeps`:

```typescript
function makeDeps(overrides: Partial<any> = {}): any {
  return {
    // ...existing fields...
    timings: { debounceMs: 30, throttleMs: 200, heartbeatMs: 60_000, llmTimeoutMs: 5_000 },
    ...overrides,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agenda.test.ts`
Expected: PASS — all tests green including the two new debounce/throttle tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/agenda.ts tests/agenda.test.ts
git commit -m "feat(agenda): event-driven tick with debounce + 3-minute throttle"
```

---

## Task 7: JSONL persistence + replay + compaction

**Files:**
- Modify: `electron/agenda.ts`
- Create: `tests/agenda.persistence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agenda.persistence.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agenda.persistence.test.ts`
Expected: FAIL — `a.loadFromDisk is not a function`.

- [ ] **Step 3: Add persistence to `electron/agenda.ts`**

Add imports if not already present:

```typescript
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
```

Add private helpers and public load/compaction methods inside the `Agenda` class:

```typescript
private static COMPACT_THRESHOLD_LINES = 500

private agendaFile(petId: string): string {
  return path.join(this.deps.dataDir, 'pets', petId, 'agenda.jsonl')
}

async loadFromDisk(): Promise<void> {
  const petId = this.deps.getActivePetId() ?? 'stlulu'
  const file = this.agendaFile(petId)
  if (!fsSync.existsSync(file)) return
  const raw = await fs.readFile(file, 'utf-8')
  const byId = new Map<string, PendingGoal>()
  for (const line of raw.split('\n')) {
    if (!line) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'add' && rec.goal && typeof rec.goal.id === 'string') {
      byId.set(rec.goal.id, rec.goal as PendingGoal)
    } else if (rec.type === 'consume' && typeof rec.id === 'string') {
      byId.delete(rec.id)
    }
  }
  const now = Date.now()
  this.goals = [...byId.values()].filter(g => now < g.expiresAt)
}

private async appendRecord(petId: string, rec: object): Promise<void> {
  const file = this.agendaFile(petId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf-8')
}

private async compactIfNeeded(petId: string): Promise<void> {
  const file = this.agendaFile(petId)
  if (!fsSync.existsSync(file)) return
  const stat = fsSync.statSync(file)
  // Quick line count via byte heuristic OR explicit count
  const raw = await fs.readFile(file, 'utf-8')
  const lineCount = raw.split('\n').filter(Boolean).length
  if (lineCount < Agenda.COMPACT_THRESHOLD_LINES) return
  const now = Date.now()
  const snapshot = this.goals.filter(g => now < g.expiresAt)
  const body = snapshot.map(g => JSON.stringify({ type: 'add', goal: g })).join('\n')
  await fs.writeFile(file, body ? body + '\n' : '', 'utf-8')
}

/** Test hook. */
async compactIfNeededForTest(): Promise<void> {
  const petId = this.deps.getActivePetId() ?? 'stlulu'
  await this.compactIfNeeded(petId)
}
```

Now wire persistence into `tick()` and `consume()`. In `tick()`, after pushing each pending goal, also append:

```typescript
for (const g of result.goals) {
  const pending: PendingGoal = { /* ...as before... */ }
  this.goals.push(pending)
  await this.appendRecord(petId, { type: 'add', goal: pending }).catch(err => console.error('[agenda] append failed:', err))
}

// After enqueue, check compaction.
await this.compactIfNeeded(petId).catch(err => console.error('[agenda] compaction failed:', err))
```

And update `consume()`:

```typescript
consume(id: string): void {
  const before = this.goals.length
  this.goals = this.goals.filter(g => g.id !== id)
  if (this.goals.length === before) return
  const petId = this.deps.getActivePetId() ?? 'stlulu'
  this.appendRecord(petId, { type: 'consume', id, ts: Date.now() }).catch(err => console.error('[agenda] consume append failed:', err))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agenda.persistence.test.ts tests/agenda.test.ts`
Expected: PASS — all persistence tests + existing agenda tests still green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/agenda.ts tests/agenda.persistence.test.ts
git commit -m "feat(agenda): JSONL persistence with replay and compaction"
```

---

## Task 8: Integrate Agenda into DriveEngine

**Files:**
- Modify: `electron/drive-engine.ts`
- Create: `tests/drive-engine-with-agenda.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/drive-engine-with-agenda.test.ts`:

```typescript
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
  // Build a minimal Agenda by hand to avoid LLM/IO. We construct with a stub deps then inject goals.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/drive-engine-with-agenda.test.ts`
Expected: FAIL — `agenda` is not a known dep; goals not merged.

- [ ] **Step 3: Modify `DriveDeps` in `electron/drive-engine.ts`**

Add `agenda?: Agenda` to `DriveDeps`. At the top of the file add the import:

```typescript
import type { Agenda } from './agenda'
```

Inside `DriveDeps`:

```typescript
export interface DriveDeps {
  // ...existing fields...
  agenda?: Agenda
}
```

- [ ] **Step 4: Merge agenda goals inside `DriveEngine.tick()`**

Locate `async tick()` (line ~373). After computing `goals = this.evaluate(ctx)` and `filtered = this.dedup(goals, now, params)`, change the order so we merge BEFORE modifiers. Replace the merge/sort section:

```typescript
async tick(): Promise<void> {
  const now = Date.now()
  const mood = this.deps.mood
  const stats = this.deps.getStats()
  const params = this.deps.getParams?.() ?? DEFAULT_PARAMS

  // Decay feedback scores toward 1.0 (unchanged)
  for (const [kind, score] of this.feedback) {
    const decayed = score + (1.0 - score) * (1 - FEEDBACK_DECAY)
    this.feedback.set(kind, Math.max(FEEDBACK_MIN, Math.min(FEEDBACK_MAX, decayed)))
  }

  const ctx: RuleContext = {
    mood:       mood.tick(stats),
    energy:     mood.getEnergy(),
    affection:  mood.getAffection(),
    streak:     mood.getStreak(),
    hoursSince: mood.getHoursSinceInteraction(),
    waking:     mood.isWakingHours(),
    stats,
    hasEvents:  false,
    now,
    params,
  }

  const petId = this.deps.getActivePetId() ?? 'stlulu'
  const recentEvents = await this.deps.events.range(petId, now - 30 * 60_000, now)
  ctx.hasEvents = recentEvents.length > 0

  // ─── Merge rule goals + agenda goals ───
  const ruleGoals  = this.evaluate(ctx)                          // already modifier+sorted
  const agendaRaw  = this.deps.agenda?.peek(now) ?? []
  // Run agenda goals through the same modifier pipeline so mood/feedback applies.
  const agendaMod  = this.applyModifiers(agendaRaw.map(g => ({ ...g, source: 'agenda' as const })), ctx.mood, ctx.energy, params)
  const merged     = [...ruleGoals, ...agendaMod].sort((a, b) => b.priority - a.priority)
  const filtered   = this.dedup(merged, now, params)

  if (filtered.length === 0) return

  const goal = filtered[0]
  const feedbackScore = this.getFeedbackScore(goal.kind)
  console.log(`[drive-engine] goal: ${goal.kind} (p=${goal.priority}, action=${goal.action}, source=${goal.source ?? 'rule'}, feedback=${feedbackScore.toFixed(2)})`)

  this.cooldowns.set(goal.cooldownKey, now)

  try {
    if (goal.action === 'bubble' && goal.bubble) {
      this.recentBubbleKinds.push({ kind: goal.kind, ts: now })
      const label = await enrichBubbleText({ deps: this.deps, goal, petId, recentEvents })
      this.deps.wm.showBubble({ source: 'watcher', label, timestamp: now })
      this.deps.mood.onInteraction('chat')
    } else if (goal.action === 'agent_task' && goal.agentGoal) {
      try {
        const result = await this.deps.agentScheduler.executeOneShot(goal.agentGoal, { maxRounds: 3 })
        if (result) {
          this.deps.wm.showBubble({ source: 'watcher', label: result.slice(0, 50), timestamp: Date.now() })
        }
        this.deps.mood.onInteraction('task_ok')
        this.feedbackPositive(goal.kind)
      } catch (err) {
        this.deps.mood.onInteraction('task_fail')
        this.feedbackNegative(goal.kind)
        throw err
      }
    }

    // ─── If goal came from agenda, mark it consumed ───
    if (goal.source === 'agenda' && this.deps.agenda) {
      this.deps.agenda.consume(goal.id)
    }

    this.deps.wm.broadcast(IPC.DRIVE_GOAL, { goal })
  } catch (err) {
    console.error(`[drive-engine] execute goal ${goal.kind} failed:`, err)
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/drive-engine-with-agenda.test.ts tests/drive-engine.test.ts`
Expected: PASS — both new integration tests and existing drive-engine tests stay green.

If pre-existing `drive-engine.test.ts` fails because it inspects log lines or behavior we changed, inspect the failure and fix only the obvious breakage. The merge logic should be a strict superset.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/drive-engine.ts tests/drive-engine-with-agenda.test.ts
git commit -m "feat(drive-engine): merge agenda goals through modifier pipeline; consume on execute"
```

---

## Task 9: Wire Agenda in `main.ts` with kill switch

**Files:**
- Modify: `electron/main.ts`

This is wiring only — no new tests. We verify by typecheck + a quick manual smoke.

- [ ] **Step 1: Locate construction site in `electron/main.ts`**

Find where `DriveEngine` is constructed. Search for `new DriveEngine`:

```bash
grep -n "new DriveEngine\|DriveEngine(" electron/main.ts
```

- [ ] **Step 2: Add Agenda construction and EventStore listener**

Right after `events`, `facts`, `mood`, `chars` are constructed (around line ~120-200) and BEFORE `new DriveEngine(...)`, add:

```typescript
import { Agenda } from './agenda'   // add to imports at top of file
```

Then near where other singletons are built:

```typescript
const agendaOff = process.env.PET_AGENDA_OFF === '1'
const agenda = agendaOff ? undefined : new Agenda({
  ai,
  events,
  facts,
  mood,
  chars,
  getStats:       () => latestStats,           // use whatever variable holds the polled stats
  getPersona:     async () => await chars.getPersona().catch(() => ''),
  getActivePetId: () => pets.getActiveId(),    // use the actual accessor in this codebase
  getParams:      () => params.current,        // use the actual accessor in this codebase
  dataDir:        path.join(userData, 'memory'),
})

if (agenda) {
  await agenda.loadFromDisk().catch(err => console.error('[main] agenda load failed:', err))
  events.addListener((_petId, ev) => {
    const kind = ev.source === 'chat' ? 'chat' : ev.source === 'hook' ? 'hook' : ev.source === 'cli' ? 'task' : null
    if (kind) agenda.onEvent(kind)
  })
  agenda.start()
}
```

**Adapt the accessor names** to whatever the codebase already uses. If `getStats` / `getActivePetId` / `getParams` exist in similar form (e.g. for `DriveEngine`), reuse the same lambdas. Search for how `DriveEngine` already gets these values and copy verbatim.

Then pass `agenda` into `DriveEngine`:

```typescript
const drive = new DriveEngine({
  // ...existing deps...
  agenda,
})
```

On shutdown (look for `app.on('before-quit')` or similar), call `agenda?.stop()`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. If TypeScript complains about a mismatched accessor type, adjust the lambda — DO NOT widen the dep type.

- [ ] **Step 4: Smoke run (manual, optional)**

Build once and inspect logs:

```bash
npm run build
```

Expected: build succeeds; no `[agenda]` errors in compile output. (Runtime smoke is in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat(main): wire Agenda with EventStore listener and PET_AGENDA_OFF kill switch"
```

---

## Task 10: Run full test suite + typecheck

**Files:** none modified

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: PASS — full suite green, including new agenda tests.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no errors anywhere.

- [ ] **Step 3: If any pre-existing test broke**

Inspect the failure. The merge changes in Task 8 should be a strict superset, so any breakage is suspicious — investigate before patching the test.

Do NOT modify pre-existing tests to make them pass unless you've confirmed the behavior change is intended (e.g. log format change, source field appearing in event payloads).

- [ ] **Step 4: Commit if any test patches were needed**

```bash
git add tests/
git commit -m "test: adapt existing tests to PetGoal.source field"
```

(Skip if nothing needed patching.)

---

## Task 11: Manual smoke test

**Files:** none modified

- [ ] **Step 1: Start the app**

Run: `npm run dev`

- [ ] **Step 2: Watch for agenda activity**

Within 25 minutes, you should see one of:
- A log line `[drive-engine] goal: <kind> (..., source=agenda, ...)` indicating an LLM-proposed goal was executed.
- An `agenda_tick` event in the EventStore (check `~/.../memory/<petId>/events.jsonl` for `"type":"agenda_tick"`).

You can accelerate this by interacting with the pet (chat, hook events) — `onEvent` will fire and trigger an agenda tick after 5s debounce.

- [ ] **Step 3: Verify kill switch**

Stop the app, restart with `PET_AGENDA_OFF=1 npm run dev`. Confirm no `agenda_tick` events appear and no `source=agenda` goals are logged. Behavior should match pre-Agenda baseline.

- [ ] **Step 4: Verify persistence**

Stop the app while there are unconsumed agenda goals in memory (a fresh restart, then quickly kill before 25 min). Check `<userData>/memory/pets/<petId>/agenda.jsonl` exists with `{"type":"add",...}` lines. Restart and confirm any non-expired goals are still in play (log line on next drive tick).

- [ ] **Step 5: Final commit if any tweaks emerged from smoke**

```bash
git add -A
git commit -m "chore(agenda): smoke fixes"
```

(Skip if nothing needed tweaking.)

---

## Done Criteria

All of these are true:

1. `npm test` is green
2. `npx tsc --noEmit` is green
3. `agenda_tick` events appear in the event store on heartbeat + on user interaction
4. At least one `source=agenda` goal has been observed executing in a real run
5. `PET_AGENDA_OFF=1` makes the app behave identically to pre-Agenda
6. Restart preserves non-expired agenda goals

When all six pass, this plan is done. P3 (LLM read-only tools) and P4 (scenario replay + rollout) are separate plans.
