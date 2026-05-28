# LLM 自主议程（Agenda）设计

**日期**：2026-05-28
**作者**：通过 brainstorming 协作产出
**状态**：待实施
**背景**：当前宠物的「决策大脑」是 `drive-engine.ts` 里 7 条硬编码 `if` 规则，LLM 仅作为「被规则召唤的文案生成器」，整体评分 5/10。本 spec 引入并联的 LLM 议程模块，让宠物能基于上下文自主决定何时说话、说什么、做什么，目标把「自主性」从 0 抬到 7+。

---

## 1. 目标与非目标

### 目标
- 让 LLM 周期性地观察上下文（事件、心情、事实、统计），自主产出一个带优先级和时间窗的 goal 队列。
- 与现有规则系统**并联**而非替换，规则继续承担兜底安全网。
- 复用 DriveEngine 现有 cooldown / feedback / mood-multiplier 管线，所有 goal 走同一套排序与去重。
- 失败优雅：LLM 不可用时，宠物退化到现有规则行为，不崩、不卡。

### 非目标
- **本 spec 不替换** `drive-engine.ts` 的规则。规则继续存在并执行。
- **本 spec 不引入语义检索 / embedding**。检索仍是子串匹配（独立 spec 解决）。
- **本 spec 不重写 trait-learner**。学习器留作下一 spec。
- **本 spec 默认不上写工具**（写 fact / 改 hook / 访问文件）。仅在 P3 引入只读工具。

---

## 2. 总体架构

新增 `electron/agenda.ts` 模块。Agenda 与规则系统并联，由 DriveEngine 在每个 tick 内合并两路 goal。

```
┌────────────────────────────────────────────────────────┐
│ DriveEngine.tick (现有，每 2 分钟)                      │
│   规则 evaluate(ctx) → ruleGoals[]                      │
│   agenda.peek(now)   → llmGoals[]   ← 新增              │
│   merged = [...ruleGoals, ...llmGoals]                  │
│   applyModifiers + dedup + 取 top → 执行                │
└────────────────────────────────────────────────────────┘
              ▲
              │ 写入 goal 队列
              │
┌────────────────────────────────────────────────────────┐
│ Agenda (新增模块)                                        │
│   ─ goals: PendingGoal[] (内存 + 持久化 JSONL)           │
│   ─ tick() 触发：① 事件流变化 ② 闲心跳（25 分钟）        │
│   ─ tick() 内调 ai.planAgenda(ctx) → goal list          │
│   ─ peek(now): 返回到期且未消费的 goal                   │
│   ─ consume(id): 标记执行过                              │
└────────────────────────────────────────────────────────┘
```

### 3 个不变量

1. **规则不动**：LLM 挂了 / 超时 / 没钥匙 / 失控时，宠物依然能凭现有规则活着。
2. **统一管线**：所有 LLM goal 走同一个 `applyModifiers + dedup + cooldown` 管线——心情倍数、反馈倍数、冷却时间对 LLM goal 同样生效。
3. **Agenda 只产 goal，不直接执行**：执行权（`wm.showBubble` / `agentScheduler`）始终在 DriveEngine 手里，Agenda 不能绕过。

---

## 3. Agenda 模块接口

文件：`electron/agenda.ts`

```typescript
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
  dataDir:        string   // agenda.jsonl 存放目录
}

export class Agenda {
  private goals: PendingGoal[] = []        // 内存队列
  private inflight = false                 // LLM 调用互斥
  private lastTickAt = 0
  private debounceTimer: NodeJS.Timeout | null = null

  constructor(private deps: AgendaDeps) {}

  start(): void                            // 启动闲心跳 (25 分钟)
  stop(): void

  /** 事件驱动入口：event-router 在新事件到达时调用 */
  async onEvent(kind: 'hook' | 'chat' | 'task'): Promise<void>

  /** 闲心跳入口：定时器调 */
  async tick(reason: 'idle' | 'event'): Promise<void>

  /** DriveEngine.tick() 取到期 goal */
  peek(now: number): PetGoal[]

  /** DriveEngine 执行后标记 */
  consume(id: string): void
}
```

### PendingGoal 类型

```typescript
interface PendingGoal extends PetGoal {
  notBefore:  number     // 时间戳，到点才可被 peek 返回
  expiresAt:  number     // 时间戳，过期自动丢弃
  reason:     string     // LLM 给的「为什么」，仅日志/调试用
  createdAt:  number     // 创建时间戳
}
```

`PetGoal` 需在 `src-shared/types.ts` 上加 `source?: 'rule' | 'agenda'`（默认 `'rule'`），用于 DriveEngine 区分。

### 触发逻辑

| 触发源 | 频率 / 节流 |
|---|---|
| **闲心跳** | 25 分钟一次（避开 5 分钟 cache TTL 的低效区） |
| **事件触发** | 5 秒防抖窗口；如果距上次 tick < 3 分钟则跳过 |
| **互斥** | `inflight=true` 期间所有触发跳过 |
| **失败** | LLM 报错 / 超时 → 不抛、不重试，下个 tick 再来 |

### 持久化

- 路径：`<dataDir>/pets/<petId>/agenda.jsonl`，其中 `dataDir` 由 `main.ts` 在构造 Agenda 时传入，与 EventStore/FactStore 现有 dataDir 一致（即 `app.getPath('userData')` 下的应用数据目录）。
- 文件格式：JSONL，每行一条记录，两种 schema：
  - 新增：`{ "type": "add", "goal": PendingGoal }`
  - 消费：`{ "type": "consume", "id": string, "ts": number }`
- 写入时机：`onEvent` / `tick` 产生新 goal 后追加 `add` 记录；`consume(id)` 追加 `consume` 记录。所有写入为同步追加，无 fsync。
- 启动时重建：读全文件 → 按时间顺序回放 → 应用 consume 标记 → 过滤已过期 → 装入内存队列。
- 文件膨胀：超过 500 行时启动 compaction，重写为「当前队列快照」。

---

## 4. LLM 接口设计

在 `ai.ts` 新增 `planAgenda(input)` 方法。

### 输入

```typescript
interface PlanAgendaInput {
  apiConfig:     ApiConfig
  apiKey:        string
  persona:       string
  moodContext:   string          // 来自 mood.buildMoodContext()
  stats:         SystemStats
  recentEvents:  EventRow[]      // 最近 30 分钟
  todayTimeline: EventRow[]      // 今日关键事件摘要（chat/task/hook）
  topFacts:      Fact[]          // 置信度 >= 0.5 的 top 20
  recentBubbles: string[]        // 最近 10 条说过的话（防重复）
  existingGoals: PendingGoal[]   // 当前队列中未消费的 goal
}
```

### 输出

```typescript
interface PlanAgendaOutput {
  goals: Array<{
    kind:         PetGoal['kind']    // 复用现有 kind 枚举
    bubble?:      string             // 想说的话
    agentGoal?:   string             // 想做的任务
    priority:     number             // 0-100
    delayMinutes: number             // 0 = 立即；30 = 半小时后
    ttlMinutes:   number             // 过期时间
    reason:       string             // 提这个 goal 的理由
  }>
  silentReason?: string              // goals=[] 时给出原因，记录在日志
}
```

### Prompt 结构（按 cache 友好性排序）

1. **系统说明（静态，走 prompt cache）**
   - 「你是宠物的『议程脑』」
   - 可用 `kind` 枚举与含义
   - 输出 schema（严格 JSON）
   - 安全规则：宁少勿多、沉默是默认选项
2. **persona + 当前 traits（半静态）**
3. **今日 timeline + topFacts（慢变）**
4. **当前 mood / stats / recentEvents / existingGoals（快变，每次重写）**

### 写进 prompt 的硬约束

- 最多产 3 个 goal，超出由后处理截断
- `existingGoals` 里已有的类似 goal 不要再加
- 没必要说话就返回 `goals: []`，沉默是默认选项
- `cpu < 70%` 且用户 5 分钟内有交互 → 倾向 silent

### 调用上下文预算

目标 10-20k tokens 上下文（中等档）。预估：
- `recentEvents` 30 分钟通常 < 50 条
- `todayTimeline` 摘要后 < 30 条
- `topFacts` 20 条
- 其余静态部分 ~3k

### 超时

8 秒。超时后整批 silent，记 `agenda_timeout` event。

---

## 5. 与 DriveEngine 的对接

改动集中在 `drive-engine.ts`。

### DriveDeps 新增可选字段

```typescript
export interface DriveDeps {
  // ...现有字段不变...
  agenda?: Agenda    // 可选；不传则纯规则模式
}
```

### tick() 内并联

```typescript
async tick() {
  // ...现有 ctx 构建不变...

  const ruleGoals = this.evaluate(ctx)
  const llmGoals  = this.deps.agenda?.peek(now) ?? []   // ← 新增

  const merged   = [...ruleGoals, ...llmGoals]
  const ranked   = this.applyModifiers(merged, mood, energy, params)
  const filtered = this.dedup(ranked, now, params)

  if (filtered.length === 0) return
  const goal = filtered[0]

  // ...执行逻辑不变...

  if (goal.source === 'agenda') {
    this.deps.agenda?.consume(goal.id)
  }
  this.cooldowns.set(goal.cooldownKey, now)
}
```

### PetGoal 加 source 字段

`src-shared/types.ts`：
```typescript
export interface PetGoal {
  // ...现有字段...
  source?: 'rule' | 'agenda'   // 默认 'rule'
}
```

### Agenda → PetGoal 转换

`Agenda.peek(now)` 内部：
1. 过滤 `now >= notBefore && now < expiresAt`
2. 转 PetGoal 时设置 `source: 'agenda'`、`cooldownKey: kind`、保留 LLM 给的 priority
3. 走 `enrichBubbleText` 对 `bubble` 做 LLM 润色（与现有规则 goal 同样的路径）

### 反馈共享

- `drive-engine.ts` 在执行任意 `bubble` goal（无论 source）时已经把 `goal.kind` 推入 `recentBubbleKinds`，**无需改动**。
- `onBubbleCleared()` 在用户清通知时遍历 `recentBubbleKinds` 调 `feedbackPositive`，agenda goal 的 kind 自然加分。
- `feedbackPositive/Negative` 通过 multiplier 影响 `applyModifiers`，两路 goal 共用一套反馈分数。
- 后果：用户点开 LLM goal 的气泡 → 同 kind 的规则 goal 下一轮也会被加分；反之亦然。这是预期行为，让两路相互校准。

### 合并后规则可能赢

如果 LLM 想 `comfort`（priority 50）但规则 `system_check`（priority 75 × mood 1.4 = 105），本轮执行规则 goal，LLM 那条留在队列下一轮再争。这是预期行为——硬规则继续兜底，LLM 在它没被规则盖过的地方主导。

---

## 6. 错误处理与安全网

### 4 道护栏

| 层 | 失败/异常 | 行为 |
|---|---|---|
| API key 没配 | `getApiKey()` 返回 null | Agenda 整个不启动；纯规则模式；日志一次 |
| LLM 超时/网络错 | 8 秒超时 | 本轮 silent，不抛、不重试，下个 tick 再来 |
| LLM 返回非法 JSON | schema 校验失败 | 整批丢弃，记 `agenda_parse_fail` event |
| LLM 失控（一次产 20 个 goal） | 后处理截断 | 只取 priority 最高 3 个，其余丢弃 |

### 两个圣域（LLM 永远不能直接做）

- 不能直接 `wm.showBubble`——必须走 DriveEngine 的 cooldown
- 不能直接执行 `agent_task`——`agentGoal` 字符串仍进 AgentScheduler 现有的审批 / `maxRounds` 限制

### 可观测

每次 `agenda.tick` 记一条事件：

```typescript
{
  type:   'agenda_tick',
  source: 'agenda',
  data:   {
    reason:         'idle' | 'event',
    goalsProposed:  number,
    goalsAccepted:  number,    // 截断后
    llmMs:          number,
    silentReason?:  string,
  }
}
```

InsightsPanel（已有，本 spec 不改）后续可以读这个 event 类型展示。

### 回滚开关

环境变量 `PET_AGENDA_OFF=1`：`main.ts` 启动时跳过 `new Agenda(...)`，DriveEngine 退化为纯规则。秒级关停。

---

## 7. 测试策略

### 单元测试（mock LLM）`tests/agenda.test.ts`

- `peek()` 时间窗：`notBefore` 没到 → 不返回；过期 → 不返回；正常 → 返回
- `consume()` 标记后不再 peek
- LLM 返回 5 个 goal → 后处理截到 3 个
- LLM 返回非法 JSON → 整批丢，记 `agenda_parse_fail` event
- `onEvent()` 防抖：3 分钟内多次触发只 tick 一次
- `inflight` 互斥：tick 进行中再调直接 return
- 持久化：写盘后重建 → 未过期 goal 还在；consume 标记保留

### 集成测试 `tests/drive-engine-with-agenda.test.ts`

- 规则 + agenda 合流：两路 goal 同时存在，按 priority 排序
- agenda goal 执行后 `consume()` 被调用
- cooldown 共享：规则 goal 占用某 kind 后，agenda 同 kind goal 被 dedup 掉
- 反馈共享：clear bubble 触发 `feedbackPositive`，agenda goal 的 kind 也加分

### 场景回放（真 LLM，手工跑，不进 CI）`tests/agenda.replay.ts`

5 个固定场景：
1. **闲场景**：30 分钟无事件，cpu < 30%
2. **忙场景**：用户密集交互，cpu > 70%
3. **刚被夸**：最近一条事件是 `user_praise`
4. **刚被骂**：最近一条事件是 `user_complain`
5. **系统报错连出 3 次**：3 条 `hook_error` event

每个场景跑 5 次（同 prompt 不同 seed），统计 goal 分布。输出 markdown 报告到 `/tmp/agenda-replay-<timestamp>.md`。

**人工验收**：
- 「忙」场景是否倾向 silent？
- 「被骂」之后是否退缩（更低 priority、更长 delay）而非变本加厉？
- goal 的 `reason` 字段是否合理？

---

## 8. 实施分期

| 期 | 内容 | 目标 |
|---|---|---|
| **P1** | Agenda 骨架 + `planAgenda` + 闲心跳并联 + 单元测试 | 跑通无工具版，LLM goal 能在 event 流里看到 |
| **P2** | 事件触发 + 持久化 + feedback 共享 | 行为可感知地「主动」 |
| **P3** | 只读工具（`read_recent_events` / `search_facts`） | 决策质量提升（单独 spec） |
| **P4** | 场景回放报告 + 上线 | 验证后默认开启（单独 spec） |

**本 spec 只覆盖 P1 + P2**。P3、P4 各自单独 spec/plan。

---

## 9. 涉及文件改动一览

| 文件 | 改动 |
|---|---|
| `electron/agenda.ts` | **新增**：Agenda 类、PendingGoal 类型 |
| `electron/ai.ts` | 新增 `planAgenda(input)` 方法 |
| `electron/drive-engine.ts` | tick() 内并联 agenda.peek()；consume() 调用 |
| `electron/event-store.ts` | 加 `addListener(fn)` / `removeListener(fn)`，`append()` 后通知 |
| `electron/main.ts` | 实例化 Agenda、传入 DriveEngine deps、注册到 EventStore listener、读 `PET_AGENDA_OFF` |
| `src-shared/types.ts` | `PetGoal` 加 `source?: 'rule' \| 'agenda'` |
| `tests/agenda.test.ts` | **新增**：单元测试 |
| `tests/drive-engine-with-agenda.test.ts` | **新增**：集成测试 |
| `tests/agenda.replay.ts` | **新增**：场景回放（手工，不进 CI） |

---

## 10. 成功标准

P1 + P2 完成后：

1. 单元测试 + 集成测试全绿
2. 启动应用 30 分钟内能在 event 流里看到至少一条 `agenda_tick` event
3. 闲场景下能看到至少一条 `source: 'agenda'` 的 goal 被执行（气泡内容与现有规则 7 条 if 的模板池都不重合，且 reason 字段能解释为什么提）
4. 设置 `PET_AGENDA_OFF=1` 启动 → 行为与改动前完全一致（回归测试）
5. 场景回放报告人工验收通过：「忙」场景大多 silent，「被骂」后明显退缩
