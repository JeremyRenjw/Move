# 宠物的"灵智"大脑

日期：2026-05-24
状态：proposed

## 背景

当前宠物有：
- 自由文本长期记忆（`memory/MEMORY.md`，按日期追加 markdown 块）
- 对话原始日志（`sessions.jsonl`，每轮 user+pet 一行）
- CLI 任务运行（slash 命令 + AI tool-call 两条路径，watcher 监督）
- 通知事件流（claude/codex hooks 通过 EventRouter 入栈）
- 系统状态采样（CPU/RAM/disk）

但这些都是孤岛——记忆是只读的自由文本，watcher 看不到 hook 事件，hook 事件看不到对话，对话不知道 CLI 任务结果。宠物"反应式"：只在用户说话时回应，不会主动观察、不会从经验里沉淀方法。

目标：把宠物从"陪聊 + CLI 启动器"升级成有**结构化记忆 + 反思 + 自生成 playbook + 询问式主动**的助理，越用越懂用户。

参考 Hermes Agent 的核心设计思路（learning loop、user model、skill 自生成），用 TS 在 Electron 主进程内重新实现，不引入 Python 依赖。

## 非目标

- **不做自动改文件**——一切写操作都通过 bubble 询问用户
- **不做多平台 messaging**（Telegram/Slack/etc）——宠物就在桌面
- **不做 subagent 委派**（Hermes 那种 isolated subagent）
- **不在第一版做语音、图片、TTS**
- **不替换现有的 stlulu/taotao 人格系统**——新机制叠加，人设保留
- **不在第一版做"自动动手"**——只做询问式主动；自动动手是未来的扩展，需要单独设计 guardrails

## 总体架构

四层叠加，下层是上层的基础设施：

```
┌─────────────────────────────────────────────┐
│  阶段 5: UI（记忆/skill 浏览编辑 + 反馈）        │
├─────────────────────────────────────────────┤
│  阶段 4: Playbook 命中检索 + 注入 system prompt │
├─────────────────────────────────────────────┤
│  阶段 3: Skill / Playbook 自生成                │
├─────────────────────────────────────────────┤
│  阶段 2: Reflector tick（每 30 分钟主动反思）   │
├─────────────────────────────────────────────┤
│  阶段 1: 事件流 + 结构化记忆（基础设施）        │
└─────────────────────────────────────────────┘
```

每个阶段独立 PR、独立可用。每完成一阶段，宠物的"灵智"再厚一层。

---

## 阶段 1：事件流 + 结构化记忆

### 1.1 事件流（`events.jsonl`）

一个统一的 append-only 文件，所有"宠物视角下发生过的事"都进去。每行一个 JSON：

```ts
interface PetEvent {
  id:        string              // uuid
  ts:        number              // epoch ms
  type:      EventType
  source:    string              // 'chat' | 'cli' | 'hook' | 'system' | 'reflector' | 'user'
  data:      Record<string, unknown>
}

type EventType =
  | 'chat_turn'        // 一轮对话结束
  | 'cli_task'         // /codex 或 AI 调起的 CLI 任务跑完
  | 'hook_signal'      // claude/codex 外部进程的 hook 事件
  | 'system_snapshot'  // 周期性系统状态（按 30 分钟采一次，不是 5s 那个）
  | 'reflector_tick'   // reflector 跑了一次（记录跑的结果）
  | 'user_feedback'    // 用户对宠物的赞/纠正
  | 'playbook_created' // 新生成一个 playbook
  | 'playbook_used'    // 一次对话命中并应用了某个 playbook
```

文件路径：`<userData>/memory/<petId>/events.jsonl`

写入接口（新建 `electron/event-store.ts`）：
```ts
class EventStore {
  append(petId: string, ev: Omit<PetEvent, 'id' | 'ts'>): Promise<void>
  // 时间范围查询，给 reflector 用
  range(petId: string, fromTs: number, toTs: number): Promise<PetEvent[]>
  // 最近 N 条，给 UI 用
  recent(petId: string, n: number): Promise<PetEvent[]>
  // 类型过滤
  byType(petId: string, type: EventType, limit: number): Promise<PetEvent[]>
}
```

实现：jsonl 流式读，第一版不做索引（每天事件数量预估几十到几百行，全扫足够快）。文件超过 50MB 时归档为 `events.YYYY-MM.jsonl` 并起新文件。归档文件 reflector 不读（只看当月活跃文件），UI 可在"导出"里打包全部历史。

### 1.2 接入现有写入点

在不改变现有功能的前提下，把所有"事件发生点"接到 EventStore：

| 现有位置 | 加什么 |
|---|---|
| `ipc.ts` `CHAT_SEND` 一轮结束 | `append({ type:'chat_turn', source:'chat', data:{ userMsg, petReply, usedSlash, toolCall } })` |
| `ipc.ts` CLI 任务结束 | `append({ type:'cli_task', source:'cli', data:{ cmd, args, prompt, exitCode, durationMs, outputTail } })` |
| `event-router.ts` `handle()` | `append({ type:'hook_signal', source:'hook', data: ev })`<br>注意：事件流记录**原始** hook 事件（debounce 之前），debounce 是 UI 节流不应丢历史 |
| `monitor.ts` 新增 30min 节流采样 | `append({ type:'system_snapshot', source:'system', data: stats })` |

注意：现有的 5 秒一次的 `MONITOR_STATS` 广播是给 UI 看的，不进事件流（数据量太大）。事件流里的 `system_snapshot` 是 30 分钟一次的快照，给 reflector 用。

### 1.3 结构化记忆（`facts.jsonl`）

替换思路：**保留** 现有的 `MEMORY.md` 用于人类阅读，**新增** `facts.jsonl` 作为机器查询的结构化版。每条 fact：

```ts
interface MemoryFact {
  id:         string
  ts:         number              // 写入时间
  type:       'user_profile' | 'preference' | 'project' | 'event' | 'feedback'
  content:    string              // 一句话事实
  confidence: number              // 0..1，AI 写入时自评，被用户确认/否定后调整
  source:     {
    eventId?: string             // 来自哪个 event
    note?:    string             // 'summarized'|'user-said'|'corrected'
  }
  superseded_by?: string         // 如果被新事实覆盖（"我搬家了" 覆盖旧地址），指向新 id
}
```

文件路径：`<userData>/memory/<petId>/facts.jsonl`

接口（在 `MemoryStore` 上加方法）：
```ts
addFact(petId: string, fact: Omit<MemoryFact, 'id'|'ts'>): Promise<string>
listFacts(petId: string, opts?: { type?, minConfidence?, limit? }): Promise<MemoryFact[]>
supersedeFact(petId: string, oldId: string, newFact: Omit<MemoryFact, 'id'|'ts'>): Promise<string>
deleteFact(petId: string, id: string): Promise<void>
```

### 1.4 改造现有 `summarizeForMemory`

现在 `ai.ts:summarizeForMemory` 一次性产出自由文本附加到 MEMORY.md。改造后：

- prompt 输出**两个**部分：自由文本（继续写 MEMORY.md，给人看）+ 结构化 facts JSON（写 facts.jsonl，给机器用）
- 不改 prompt 的总体结构，只加一段 "另外输出一个 JSON 列表 `{type, content, confidence}`"
- 如果 JSON 解析失败，降级到只写自由文本（不影响现有功能）

### 1.5 阶段 1 验收

- [ ] 启动一周后看 `events.jsonl`，能看到对话/CLI 任务/hook 都被记下
- [ ] `facts.jsonl` 里能看到从对话里抽出的结构化事实
- [ ] 现有 MEMORY.md 继续工作不退化
- [ ] 现有功能（聊天、slash、watcher）全部不受影响

---

## 阶段 2：Reflector tick

### 2.1 核心循环

新模块 `electron/reflector.ts`。一个 setInterval，每 30 分钟跑一次：

```ts
class Reflector {
  constructor(deps: { ai, events: EventStore, memory: MemoryStore, wm: WindowManager })

  // 主循环入口
  async tick(petId: string): Promise<void> {
    const now = Date.now()
    const since = now - 30 * 60_000

    // 1. 拉最近 30 分钟的事件 + 当前系统状态 + 已知 facts
    const recentEvents = await this.events.range(petId, since, now)
    const facts = await this.memory.listFacts(petId, { limit: 30, minConfidence: 0.5 })
    const stats = currentStats()

    // 2. 如果没有"新事情"，直接静默（节约 API 调用）
    if (recentEvents.length === 0) return

    // 3. 询问 AI：要不要主动说点什么 / 提议点什么
    const decision = await this.ai.reflect({ recentEvents, facts, stats })
    // decision: { action: 'silent' } | { action: 'propose', bubble, detail }

    // 4. 记录 reflector_tick 事件
    await this.events.append(petId, {
      type: 'reflector_tick', source: 'reflector',
      data: { decision, eventsCount: recentEvents.length }
    })

    // 5. 如果 propose，冒 bubble
    if (decision.action === 'propose') {
      wm.showBubble({ source: 'reflector', label: decision.bubble, timestamp: now })
      // 用户点 bubble 进 panel 时，把 detail 注入下一次对话（"我刚才想说..."）
    }
  }
}
```

### 2.2 新增 `ai.reflect`

```ts
ai.reflect(opts): Promise<ReflectorDecision>
```

prompt 大意：
> 你是 {pet 人格}。这是最近 30 分钟在用户机器上发生的事 [events]；你已知的关于用户的事实 [facts]；当前系统状态 [stats]。
> **大多数时候你应该回答 silent。** 只在以下情况建议 propose：
> - 发现用户可能需要提醒的东西（系统资源异常、CLI 任务挂了、某事悬而未决）
> - 你想分享一个观察（"你今天 codex 跑了 5 次，要不要写个 alias"）
> - 你注意到某个 fact 跟最近的事冲突（"你说不喜欢长任务，但刚跑了个 20 分钟的"）
>
> 输出 JSON: `{"action":"silent"}` 或 `{"action":"propose","bubble":"<28 字以内冒泡文案>","detail":"<点开后给你的完整说明>"}`

强制保守：默认 silent，宁可漏报也不要骚扰。

### 2.3 触发时机

- 定时：每 30 分钟（可在 settings 里调成 15/60/off）
- **被动唤醒**：收到 hook 事件 `Stop` / `Error` / `PermissionRequest` 时，立即触发一次 tick（不等 30 分钟），因为这些是高价值信号
- **静默时段**：用户可在 settings 配 "22:00-08:00 不要主动冒泡"，期间 tick 只记录不冒泡

### 2.4 阶段 2 验收

- [ ] 跑一天，看 `events.jsonl` 里 `reflector_tick` 的分布，绝大多数 `decision.action === 'silent'`
- [ ] 偶尔（每天 1-3 次）冒一个有用的 bubble
- [ ] 静默时段生效
- [ ] hook Error 事件能在 5 秒内触发 tick

---

## 阶段 3：Skill / Playbook 自生成

### 3.1 Playbook 是什么

`<userData>/memory/<petId>/playbooks/<slug>.md`。每个 playbook 一个文件，带 frontmatter：

```markdown
---
id: pb-cleanup-downloads
title: 清理 Downloads 里的旧 zip/installer
triggers:
  - 用户提到"清理"+"Downloads"
  - 用户提到"~/Downloads"+"满了"
created: 2026-05-25
uses: 3
last_used: 2026-05-30
confidence: 0.7
---

# 怎么做

1. 列出 ~/Downloads 里 30 天没动过的 .zip / .dmg / .pkg / .iso
2. **不要**碰 .pdf .docx .xlsx（用户可能在用）
3. 总大小 > 100MB 时主动提醒
4. 移动到 ~/Downloads/_archive/ 而不是 rm

# 用户偏好

- 用户 2026-05-25 说"别碰 PDF，可能在看"
- 用户喜欢看到 dry-run 列表后再确认
```

### 3.2 触发生成

两个时机：

1. **聊天 turn 结束后异步评估**——给 AI 看刚发生的一轮：
   > 这轮对话/任务里有没有学到一个"下次遇到类似情况可以怎么做"的方法？如果有，输出 playbook（含 triggers + how-to + 偏好备注）。否则输出 NONE。

2. **用户主动让记**——你说"宠物，这个流程记下来下次自动这么做"

prompt 设计上要保守：宁可不生成，也不要生成空泛的 playbook（"做事要小心" 这种）。AI 必须能写出**具体的 triggers + 可执行的步骤**才生成。

### 3.3 新增 `ai.proposePlaybook`

```ts
ai.proposePlaybook(opts: {
  recentTurn: ChatMessage[]
  existingPlaybooks: { id, title, triggers }[]   // 防止重复
  facts: MemoryFact[]
}): Promise<{ slug, frontmatter, body } | null>
```

如果产出非 null，写文件 + append 一个 `playbook_created` 事件。

### 3.4 阶段 3 验收

- [ ] 用一周后，`playbooks/` 下有 3-8 个真有价值的 playbook
- [ ] 没有 "做事要小心" 这种空 playbook
- [ ] 重复触发同类场景不会生成重复 playbook（命中现有就更新而非新建）

---

## 阶段 4：Playbook 命中检索 + 注入

### 4.1 检索

用户每次发消息，在 `ai.chat` 调用前：

```ts
const candidates = await playbookStore.search(petId, userMessage, { topK: 3 })
// 第一版：简单关键词匹配 + AI 判定
// 后续可升级到 embedding 检索
```

第一版实现：把所有 playbook 的 `triggers` 字段塞给一个轻量 prompt，让 Haiku/低成本模型判定 "用户输入命中哪些"。返回 top 3。

### 4.2 注入

命中的 playbook body 拼到 systemPrompt 末尾：

```
[长期记忆]
{MEMORY.md}

[相关 playbook]
{playbook1.body}

{playbook2.body}
```

然后正常调 `ai.chat`。

每次命中记一个 `playbook_used` 事件 + 更新 playbook 的 `uses` / `last_used` 字段。

### 4.3 反馈循环

用户对宠物回复点"赞"或"别这样" → 写 `user_feedback` 事件 → 调整最近命中的 playbook 的 confidence。confidence 长期低于 0.2 的 playbook 自动归档（不删，移到 `playbooks/_archive/`）。

### 4.4 阶段 4 验收

- [ ] 跟宠物说"清理 downloads" → 命中 `pb-cleanup-downloads` → 宠物按 playbook 里写的步骤来，而不是泛泛回答
- [ ] 第二次说同样的话，宠物提到"上次你说过别碰 PDF"
- [ ] playbook 命中率 / uses 数能在事件流里看到

---

## 阶段 5：UI + 反馈

### 5.1 新增 settings tab

`src/settings/MemoryTab.tsx`：
- 看 facts.jsonl（按 type 分组，可删可改 confidence）
- 看 playbooks（列表 + markdown 预览，可禁用/删除/手动改）
- 看最近 reflector tick（哪些 silent、哪些 propose、用户怎么响应）
- 静默时段配置
- "导出"按钮（把 memory 整个目录打包）

### 5.2 panel 内反馈按钮

宠物回复消息下方加 👍 / 👎 / 编辑按钮：
- 👍 → 写 `user_feedback` 事件，最近命中的 playbook confidence +0.1
- 👎 → 写 `user_feedback` 事件，confidence -0.2，并问"哪里不对？" 文本输入会写 fact
- 编辑 → 允许你改写宠物的回复（这条改写成为 facts.jsonl 里的纠正记录）

### 5.3 阶段 5 验收

- [ ] 能从 UI 看到宠物攒了什么
- [ ] 一次反馈循环跑通（点踩 → playbook 降权 → 下次不再用）

---

## 数据流总览

```
用户输入
   ↓
[playbook 命中检索] ← playbooks/*.md
   ↓
[拼 system prompt：人格 + facts + 命中 playbooks]
   ↓
ai.chat → 流式回复 / 调 CLI tool
   ↓
[append chat_turn event] → events.jsonl
   ↓
[summarizeForMemory 异步] → MEMORY.md + facts.jsonl
   ↓
[proposePlaybook 异步] → playbooks/*.md（如果产出）

并行：
[Reflector 每 30 分钟] 读 events + facts
   ↓
silent / propose
   ↓
[append reflector_tick]
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| AI 生成的 playbook 错误率高 | 5.2 反馈循环 + 全部 playbook 用户可见可编辑 |
| Reflector 太吵 | 默认 30 分钟，prompt 强制保守，静默时段，单次 bubble 不超过 28 字 |
| API 成本暴涨 | reflector 30 分钟只调一次小 prompt；playbook 检索用便宜模型；总开销估算 <10x 当前 |
| facts.jsonl 矛盾累积 | `supersedeFact` 机制 + UI 可见可改 |
| 事件流无限增长 | 按月归档 + 50MB rotate |

## 实现工作量

| 阶段 | 估时（工作日） |
|---|---|
| 1. 事件流 + 结构化记忆 | 2-3 |
| 2. Reflector tick | 2-3 |
| 3. Playbook 自生成 | 3-4 |
| 4. 命中检索 + 注入 | 2-3 |
| 5. UI + 反馈 | 2-3 |
| **合计** | **11-16 个工作日，约 2-3 周** |

每阶段独立 PR，可分别 merge 试用。

## 测试策略

每阶段：
- 单元测试：纯函数（EventStore.range、PlaybookStore.search、facts 合并冲突）
- 集成测试：mock AI，验证事件流和文件落盘正确
- 手工验证清单：见每阶段"验收"段
- 项目当前没有 e2e，沿用现有 vitest 风格
