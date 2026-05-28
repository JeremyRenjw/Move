# MCP + Skills 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宠物 AI 能连接外部 MCP Server 使用它们的工具，并通过 Markdown Skill 文件注入领域知识。

**Architecture:** McpManager 管理 MCP server 子进程和工具路由；SkillStore 从文件系统加载 markdown 技能模板。两层独立，汇聚到 agentLoop 的工具列表和 system prompt。

**Tech Stack:** `@modelcontextprotocol/sdk`, `gray-matter`, Electron main process, Vitest

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `electron/mcp-manager.ts` | MCP server 进程生命周期 + 工具发现 + 调用路由 |
| `electron/skill-store.ts` | Skill 文件加载 + frontmatter 解析 + 关键词匹配 |
| `electron/skills/git-helper.md` | 内置 Git 技能 |
| `electron/skills/code-review.md` | 内置代码审查技能 |
| `electron/skills/system-admin.md` | 内置系统管理技能 |
| `src/settings/ToolsTab.tsx` | 工具设置页面（MCP 状态 + Skill 列表） |
| `tests/mcp-manager.test.ts` | McpManager 单元测试 |
| `tests/skill-store.test.ts` | SkillStore 单元测试 |

### Modified Files

| File | Changes |
|------|---------|
| `package.json:34` | Add `@modelcontextprotocol/sdk`, `gray-matter` |
| `electron/ai.ts:802-816` | agentLoop opts 加 `mcpTools`, `mcpExecutor`, `matchedSkills` |
| `electron/ipc.ts:48-65` | deps 加 `mcpManager`, `skillStore`；CHAT_SEND 接入 |
| `electron/main.ts:26-31` | import + 启动 McpManager/SkillStore |
| `src-shared/types.ts:74-115` | 新增 IPC 常量 |
| `src/settings/App.tsx:9-18` | 新增 'tools' tab |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
cd /Users/renjiawei/work/pet-monitor-app
npm install @modelcontextprotocol/sdk gray-matter
npm install -D @types/gray-matter
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@modelcontextprotocol/sdk'); require('gray-matter'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @modelcontextprotocol/sdk and gray-matter"
```

---

### Task 2: SkillStore (TDD)

**Files:**
- Create: `electron/skill-store.ts`
- Test: `tests/skill-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/skill-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

// We'll test SkillStore after implementing it
let SkillStore: typeof import('../electron/skill-store').SkillStore

const GIT_SKILL = `---
name: git-helper
description: Git 操作指导
triggers:
  - git
  - commit
  - branch
  - merge
---

# Git Helper

你是一个 Git 专家。先用 git status 看状态。`

const REVIEW_SKILL = `---
name: code-review
description: 代码审查
triggers:
  - review
  - "代码审查"
  - "看看代码"
---

# Code Review

审查代码时关注安全性、性能、可读性。`

describe('SkillStore', () => {
  let tmpDir: string
  let builtinDir: string
  let userDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'))
    builtinDir = path.join(tmpDir, 'builtin')
    userDir = path.join(tmpDir, 'user')
    await fs.mkdir(builtinDir, { recursive: true })
    await fs.mkdir(userDir, { recursive: true })
    const mod = await import('../electron/skill-store')
    SkillStore = mod.SkillStore
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('loads skills from builtin and user directories', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    await fs.writeFile(path.join(userDir, 'review.md'), REVIEW_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const all = store.list()
    expect(all).toHaveLength(2)
    expect(all.map(s => s.name).sort()).toEqual(['code-review', 'git-helper'])
  })

  it('matches skills by trigger keywords', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const matched = store.match('帮我 commit 一下代码')
    expect(matched).toHaveLength(1)
    expect(matched[0].name).toBe('git-helper')
  })

  it('matches multiple skills', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    await fs.writeFile(path.join(userDir, 'review.md'), REVIEW_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const matched = store.match('帮我 review 一下这个 git branch 的代码')
    expect(matched).toHaveLength(2)
  })

  it('returns empty array when no triggers match', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const matched = store.match('今天天气怎么样')
    expect(matched).toHaveLength(0)
  })

  it('case insensitive matching', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const matched = store.match('help me with GIT')
    expect(matched).toHaveLength(1)
  })

  it('marks source as builtin or user', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    await fs.writeFile(path.join(userDir, 'review.md'), REVIEW_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    const all = store.list()
    const git = all.find(s => s.name === 'git-helper')!
    const review = all.find(s => s.name === 'code-review')!
    expect(git.source).toBe('builtin')
    expect(review.source).toBe('user')
  })

  it('skips files with invalid frontmatter', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    await fs.writeFile(path.join(builtinDir, 'bad.md'), '# No frontmatter\nJust text')
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    expect(store.list()).toHaveLength(1)
  })

  it('handles missing directories gracefully', async () => {
    const store = new SkillStore('/nonexistent/path', '/also/nonexistent')
    await store.init()
    expect(store.list()).toHaveLength(0)
  })

  it('reload refreshes skill list', async () => {
    await fs.writeFile(path.join(builtinDir, 'git.md'), GIT_SKILL)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    expect(store.list()).toHaveLength(1)

    await fs.writeFile(path.join(userDir, 'review.md'), REVIEW_SKILL)
    await store.reload()
    expect(store.list()).toHaveLength(2)
  })

  it('extracts tools from frontmatter', async () => {
    const skill = `---
name: tester
description: test
triggers:
  - test
tools:
  - bash
  - read_file
---
Body`
    await fs.writeFile(path.join(builtinDir, 't.md'), skill)
    const store = new SkillStore(builtinDir, userDir)
    await store.init()
    expect(store.list()[0].tools).toEqual(['bash', 'read_file'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/skill-store.test.ts
```
Expected: FAIL — cannot import `SkillStore`

- [ ] **Step 3: Implement SkillStore**

```typescript
// electron/skill-store.ts
import * as fs from 'fs/promises'
import * as path from 'path'
import matter from 'gray-matter'

export interface Skill {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  body: string
  source: 'builtin' | 'user'
}

interface SkillFrontmatter {
  name?: string
  description?: string
  triggers?: string[]
  tools?: string[]
}

export class SkillStore {
  private skills: Skill[] = []
  private builtinDir: string
  private userDir: string

  constructor(builtinDir: string, userDir: string) {
    this.builtinDir = builtinDir
    this.userDir = userDir
  }

  async init(): Promise<void> {
    this.skills = []
    await this.loadDir(this.builtinDir, 'builtin')
    await this.loadDir(this.userDir, 'user')
  }

  async reload(): Promise<void> {
    await this.init()
  }

  match(userMessage: string): Skill[] {
    const msg = userMessage.toLowerCase()
    return this.skills.filter(skill =>
      skill.triggers.some(t => msg.includes(t.toLowerCase()))
    )
  }

  list(): Skill[] {
    return [...this.skills]
  }

  private async loadDir(dir: string, source: 'builtin' | 'user'): Promise<void> {
    let entries: string[]
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      entries = dirents.filter(d => d.isFile() && d.name.endsWith('.md')).map(d => d.name)
    } catch {
      return // directory doesn't exist
    }
    for (const filename of entries) {
      try {
        const raw = await fs.readFile(path.join(dir, filename), 'utf-8')
        const parsed = matter(raw)
        const fm = parsed.data as SkillFrontmatter
        if (!fm.name || !fm.description || !Array.isArray(fm.triggers) || fm.triggers.length === 0) continue
        this.skills.push({
          name: fm.name,
          description: fm.description,
          triggers: fm.triggers,
          tools: Array.isArray(fm.tools) ? fm.tools : [],
          body: parsed.content.trim(),
          source
        })
      } catch {
        // skip files that fail to parse
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/skill-store.test.ts
```
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add electron/skill-store.ts tests/skill-store.test.ts
git commit -m "feat(skill-store): load and match markdown skill files"
```

---

### Task 3: Built-in Skills

**Files:**
- Create: `electron/skills/git-helper.md`
- Create: `electron/skills/code-review.md`
- Create: `electron/skills/system-admin.md`

- [ ] **Step 1: Create git-helper.md**

```markdown
---
name: git-helper
description: Git 操作指导和最佳实践
triggers:
  - git
  - commit
  - branch
  - merge
  - rebase
  - "版本控制"
  - "代码提交"
  - "拉代码"
  - "推送"
tools:
  - bash
  - read_file
---

# Git Helper

你是一个 Git 专家助手。当用户请求 Git 相关操作时：

## 流程

1. 先用 `bash: git status` 查看当前状态
2. 用 `bash: git log --oneline -5` 看最近提交
3. 根据用户需求执行对应操作

## 注意事项

- 提交信息用中文，简洁描述改动内容
- 不要自动 push，除非用户明确要求
- 危险操作（force push, reset --hard, clean -fd）必须先警告用户并确认
- merge 前建议先 stash 或 commit 当前修改
- 遇到冲突时帮用户分析冲突内容，给出解决建议

## 常用命令

- 查看分支: `git branch -a`
- 创建并切换: `git checkout -b <name>`
- 暂存: `git stash` / `git stash pop`
- 查看差异: `git diff` / `git diff --cached`
- 撤销工作区: `git checkout -- <file>`
- 撤销暂存: `git reset HEAD <file>`
```

- [ ] **Step 2: Create code-review.md**

```markdown
---
name: code-review
description: 代码审查清单和最佳实践
triggers:
  - review
  - "代码审查"
  - "看看代码"
  - "检查代码"
  - "code review"
tools:
  - bash
  - read_file
  - list_files
---

# Code Review

你是一个代码审查专家。审查代码时按以下维度检查：

## 审查清单

### 安全性
- 是否有 SQL 注入、XSS、命令注入风险
- 敏感信息（密钥、token）是否硬编码
- 输入验证是否充分

### 正确性
- 边界条件是否处理（空值、空数组、溢出）
- 错误处理是否完整（try-catch、错误传播）
- 并发安全（竞态条件、死锁）

### 可读性
- 命名是否清晰表达意图
- 函数是否过长（>50 行考虑拆分）
- 是否有不必要的注释或缺少关键注释

### 性能
- 是否有 N+1 查询
- 是否有不必要的循环或重复计算
- 大数据量时是否需要分页/流式处理

## 输出格式

按严重程度分类：
- **必须修复**: 安全漏洞、逻辑错误
- **建议改进**: 性能优化、可读性提升
- **可选优化**: 代码风格、命名改进
```

- [ ] **Step 3: Create system-admin.md**

```markdown
---
name: system-admin
description: 系统管理和诊断
triggers:
  - 进程
  - 磁盘
  - 内存
  - 网络
  - "系统"
  - "端口"
  - "卡了"
  - "死机"
  - process
  - disk
  - memory
  - network
  - port
tools:
  - bash
---

# System Admin

你是系统管理专家。帮用户诊断和解决系统问题。

## 诊断流程

1. 先收集基本信息：
   - 系统: `uname -a`
   - 磁盘: `df -h`
   - 内存: `vm_stat` (macOS) 或 `free -h` (Linux)
   - 进程: `ps aux --sort=-%cpu | head -20`

2. 根据用户问题深入排查

## 常见场景

### CPU 高占用
`ps aux --sort=-%cpu | head -10`
`top -l 1 -n 10`

### 磁盘空间不足
`du -sh ~/* | sort -rh | head -10`
`docker system prune` (如果有 Docker)

### 端口被占用
`lsof -i :<port>`
`netstat -an | grep <port>`

### 网络问题
`ping -c 3 8.8.8.8`
`curl -I https://www.baidu.com`
`nslookup <domain>`

## 注意事项

- 不要随意 kill 进程，先告诉用户是什么进程
- 涉及 sudo 操作要先确认
- 大文件删除前确认用户意图
```

- [ ] **Step 4: Commit**

```bash
git add electron/skills/
git commit -m "feat(skills): add 3 built-in skill files (git, review, sysadmin)"
```

---

### Task 4: McpManager (TDD)

**Files:**
- Create: `electron/mcp-manager.ts`
- Test: `tests/mcp-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mcp-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

let McpManager: typeof import('../electron/mcp-manager').McpManager

describe('McpManager', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'))
    const mod = await import('../electron/mcp-manager')
    McpManager = mod.McpManager
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('skips init when mcp.json does not exist', async () => {
    const mgr = new McpManager(tmpDir)
    await mgr.init()
    expect(mgr.getTools()).toHaveLength(0)
    expect(mgr.getStatus()).toHaveLength(0)
    await mgr.shutdown()
  })

  it('skips init when mcp.json has empty mcpServers', async () => {
    await fs.writeFile(path.join(tmpDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    const mgr = new McpManager(tmpDir)
    await mgr.init()
    expect(mgr.getTools()).toHaveLength(0)
    await mgr.shutdown()
  })

  it('handles server spawn failure gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        bad: { command: '/nonexistent/binary', args: [] }
      }
    }))
    const mgr = new McpManager(tmpDir)
    await mgr.init() // should not throw
    expect(mgr.getTools()).toHaveLength(0)
    const status = mgr.getStatus()
    expect(status).toHaveLength(1)
    expect(status[0].name).toBe('bad')
    expect(status[0].connected).toBe(false)
    expect(status[0].error).toBeTruthy()
    await mgr.shutdown()
  })

  it('returns prefixed tool names', async () => {
    // This test verifies the prefix naming logic.
    // Real MCP integration is tested manually.
    await fs.writeFile(path.join(tmpDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        test: { command: '/nonexistent/binary', args: [] }
      }
    }))
    const mgr = new McpManager(tmpDir)
    await mgr.init()
    // No tools because server failed, but getStatus shows the entry
    expect(mgr.getStatus()[0].name).toBe('test')
    await mgr.shutdown()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/mcp-manager.test.ts
```
Expected: FAIL — cannot import `McpManager`

- [ ] **Step 3: Implement McpManager**

```typescript
// electron/mcp-manager.ts
import * as fs from 'fs/promises'
import * as path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type Anthropic from '@anthropic-ai/sdk'

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

interface McpServerEntry {
  name: string
  client: Client
  transport: StdioClientTransport
  tools: { name: string; prefixedName: string; description: string; inputSchema: Record<string, unknown> }[]
}

interface McpStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

export class McpManager {
  private configPath: string
  private servers = new Map<string, McpServerEntry>()

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, 'mcp.json')
  }

  async init(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.configPath, 'utf-8')
    } catch {
      return // no config file — MCP disabled
    }

    let config: McpConfig
    try {
      config = JSON.parse(raw)
    } catch (err) {
      console.error('[mcp] failed to parse mcp.json:', err)
      return
    }

    if (!config.mcpServers) return

    const entries = Object.entries(config.mcpServers)
    await Promise.allSettled(entries.map(([name, cfg]) => this.connectServer(name, cfg)))
  }

  private async connectServer(name: string, cfg: McpServerConfig): Promise<void> {
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...process.env, ...cfg.env } as Record<string, string>
      })

      const client = new Client({ name: 'mote', version: '0.1.0' })
      await client.connect(transport)

      const result = await client.listTools()
      const tools = (result.tools ?? []).map(t => ({
        name: t.name,
        prefixedName: `mcp__${name}__${t.name}`,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
      }))

      this.servers.set(name, { name, client, transport, tools })
      console.log(`[mcp] connected ${name}: ${tools.length} tools`)
    } catch (err) {
      console.error(`[mcp] failed to connect ${name}:`, err)
      // Store empty entry for status reporting
      this.servers.set(name, {
        name,
        client: null as unknown as Client,
        transport: null as unknown as StdioClientTransport,
        tools: []
      })
    }
  }

  getTools(): Anthropic.Tool[] {
    const out: Anthropic.Tool[] = []
    for (const entry of this.servers.values()) {
      for (const t of entry.tools) {
        out.push({
          name: t.prefixedName,
          description: `[MCP:${entry.name}] ${t.description}`,
          input_schema: t.inputSchema as Anthropic.Tool['input_schema']
        })
      }
    }
    return out
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    // Parse: mcp__{serverName}__{toolName}
    const match = prefixedName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
    if (!match) return `Error: invalid MCP tool name "${prefixedName}"`

    // The server name might contain underscores, so we need to find the right split.
    // Strategy: try all possible splits, find the one where server name exists.
    const parts = prefixedName.slice('mcp__'.length).split('__')
    if (parts.length < 2) return `Error: invalid MCP tool name "${prefixedName}"`

    // Try from left to find matching server name
    for (let i = 1; i <= parts.length - 1; i++) {
      const serverName = parts.slice(0, i).join('__')
      const toolName = parts.slice(i).join('__')
      const entry = this.servers.get(serverName)
      if (entry && entry.client) {
        try {
          const result = await entry.client.callTool({ name: toolName, arguments: args })
          const content = result.content as { type: string; text: string }[] | undefined
          if (Array.isArray(content)) {
            return content.map(c => c.text ?? JSON.stringify(c)).join('\n')
          }
          return JSON.stringify(result.content)
        } catch (err) {
          return `Error calling MCP tool ${toolName} on ${serverName}: ${(err as Error).message}`
        }
      }
    }
    return `Error: MCP server not found for tool "${prefixedName}"`
  }

  getStatus(): McpStatus[] {
    const out: McpStatus[] = []
    for (const [name, entry] of this.servers) {
      out.push({
        name,
        connected: entry.client !== null && entry.tools.length > 0,
        toolCount: entry.tools.length
      })
    }
    return out
  }

  async shutdown(): Promise<void> {
    for (const [, entry] of this.servers) {
      try {
        if (entry.client) await entry.client.close()
      } catch { /* ignore */ }
    }
    this.servers.clear()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/mcp-manager.test.ts
```
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add electron/mcp-manager.ts tests/mcp-manager.test.ts
git commit -m "feat(mcp-manager): MCP server lifecycle and tool routing"
```

---

### Task 5: AgentLoop Integration — Skill Injection

**Files:**
- Modify: `electron/ai.ts:802-830`

- [ ] **Step 1: Add matchedSkills to agentLoop opts**

In `electron/ai.ts`, add to the `agentLoop` opts type (around line 802):

```typescript
async agentLoop(opts: {
  config: CharacterConfig
  apiConfig: ApiConfig
  apiKey: string
  history: ChatMessage[]
  userMessage: string
  stats: SystemStats
  onChunk: (text: string) => void
  workdir: string
  petId: string
  factStore: FactStore
  playbooks: PlaybookStore
  maxRounds?: number
  mcpTools?: Anthropic.Tool[]               // ← ADD
  mcpExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string>  // ← ADD
  matchedSkills?: { name: string; body: string }[]  // ← ADD
}): Promise<AgentResult> {
```

- [ ] **Step 2: Inject skills into system prompt**

At the start of `agentLoop`, after `const systemPrompt = this.buildSystemPrompt(config, stats)`, add:

```typescript
let effectiveSystemPrompt = systemPrompt
if (opts.matchedSkills && opts.matchedSkills.length > 0) {
  const skillBlock = opts.matchedSkills.map(s =>
    `<skill name="${s.name}">\n${s.body}\n</skill>`
  ).join('\n\n')
  effectiveSystemPrompt += `\n\n[当前激活的技能]\n\n${skillBlock}`
}
```

Replace all uses of `systemPrompt` in the loop with `effectiveSystemPrompt`.

- [ ] **Step 3: Merge MCP tools**

At the start of the agentLoop, after `const executor = new ToolExecutor(workdir)`, add:

```typescript
const allTools: Anthropic.Tool[] = [...AGENT_TOOLS, ...(opts.mcpTools ?? [])]
```

In the Claude branch, change `tools: AGENT_TOOLS` to `tools: allTools`.

In the OpenAI branch, change `const openaiTools = toOpenAITools(AGENT_TOOLS)` to `const openaiTools = toOpenAITools(allTools)`.

- [ ] **Step 4: Add MCP tool routing**

In both Claude and OpenAI branches, after the `executorCalls` / `memoryCalls` / `cliCalls` categorization, add MCP handling. For the Claude branch (around line 877):

```typescript
const mcpCalls = toolCalls.filter(t =>
  !executorNames.has(t.tool) && !memoryNames.has(t.tool) && t.tool.startsWith('mcp__')
)
const actualCliCalls = toolCalls.filter(t =>
  !executorNames.has(t.tool) && !memoryNames.has(t.tool) && !t.tool.startsWith('mcp__')
)
```

After the `Promise.all(memoryCalls.map(...))` block, add:

```typescript
await Promise.all(mcpCalls.map(async call => {
  const strInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(call.input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  const label = (strInput.command || strInput.path || strInput[Object.keys(strInput)[0]] || '').slice(0, 60)
  onChunk(`\n<details><summary>🔌 ${call.tool}: ${label}</summary>\n\n`)
  const output = opts.mcpExecutor
    ? await opts.mcpExecutor(call.tool, call.input)
    : 'Error: MCP not available'
  resultById.set((call as unknown as { id?: string }).id ?? call.tool, output)
  onChunk(`${output}\n\n</details>\n\n`)
}))
```

Update the `cliCalls` return to use `actualCliCalls`.

Do the same for the OpenAI branch.

- [ ] **Step 5: Run existing tests to verify no regressions**

```bash
npx vitest run tests/ai.test.ts
```
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add electron/ai.ts
git commit -m "feat(agent-loop): integrate MCP tools and skill injection"
```

---

### Task 6: IPC Integration

**Files:**
- Modify: `electron/ipc.ts:48-66` (deps type)
- Modify: `electron/ipc.ts:224-230` (agentLoop call)
- Modify: `src-shared/types.ts:74-115` (IPC constants)

- [ ] **Step 1: Add MCP/Skill deps to registerIpcHandlers**

In `electron/ipc.ts`, add imports at the top:

```typescript
import type { McpManager } from './mcp-manager'
import type { SkillStore } from './skill-store'
```

Add to the deps type (line 48):

```typescript
export function registerIpcHandlers(deps: {
  // ...existing deps...
  mcpManager: McpManager     // ← ADD
  skillStore: SkillStore     // ← ADD
}): void {
```

Destructure in the function body (line 66):

```typescript
const { wm, pets, chars, ai, runner, cleanup, memory, watcher, getStats, eventRouter, eventServer, runtimeState, events, factStore, playbooks, mcpManager, skillStore } = deps
```

- [ ] **Step 2: Wire MCP + Skills into CHAT_SEND**

In the CHAT_SEND handler, before the `ai.agentLoop()` call (around line 221), add skill matching:

```typescript
const matchedSkills = skillStore.match(message)
```

Update the `agentLoop` call (line 224) to pass MCP and skill params:

```typescript
const agentResult = await ai.agentLoop({
  config: enrichedCfg, apiConfig, apiKey, history,
  userMessage: message, stats: getStats(),
  onChunk: chunk => wm.broadcast(IPC.CHAT_CHUNK, { chunk }),
  workdir: os.homedir(),
  petId, factStore, playbooks,
  mcpTools: mcpManager.getTools(),                                    // ← ADD
  mcpExecutor: (name, input) => mcpManager.callTool(name, input),     // ← ADD
  matchedSkills                                                        // ← ADD
})
```

- [ ] **Step 3: Add MCP/Skill IPC handlers**

At the end of `registerIpcHandlers`, before the closing `}`:

```typescript
// ─── MCP + Skills ───
ipcMain.handle('mcp:status', () => mcpManager.getStatus())
ipcMain.handle('mcp:reload', async () => {
  await mcpManager.shutdown()
  await mcpManager.init()
})
ipcMain.handle('skills:list', () => skillStore.list())
ipcMain.handle('skills:reload', async () => {
  await skillStore.reload()
})
```

- [ ] **Step 4: Add IPC constants to types.ts**

In `src-shared/types.ts`, add to the IPC object (before the closing `}`):

```typescript
// MCP + Skills (Renderer → Main)
MCP_STATUS:       'mcp:status',       // → McpStatus[]
MCP_RELOAD:       'mcp:reload',       // → void
SKILLS_LIST:      'skills:list',      // → Skill[]
SKILLS_RELOAD:    'skills:reload',    // → void
```

- [ ] **Step 5: Run existing tests**

```bash
npx vitest run
```
Expected: ALL PASS (existing tests may need mock updates for new deps)

- [ ] **Step 6: Commit**

```bash
git add electron/ipc.ts src-shared/types.ts
git commit -m "feat(ipc): wire MCP and Skills into agent loop and IPC"
```

---

### Task 7: Main.ts Wiring

**Files:**
- Modify: `electron/main.ts:1-31` (imports)
- Modify: `electron/main.ts:55-65` (instantiation)
- Modify: `electron/main.ts:126-131` (registerIpcHandlers)
- Modify: `electron/main.ts:214-217` (before-quit)

- [ ] **Step 1: Add imports**

In `electron/main.ts`, add after existing imports (around line 22):

```typescript
import { McpManager }   from './mcp-manager'
import { SkillStore }    from './skill-store'
```

- [ ] **Step 2: Instantiate and init**

After `const watcher = new CliWatcher(ai)` (line 62), add:

```typescript
const mcpManager = new McpManager(userData)

const builtinSkillsDir = app.isPackaged
  ? path.join(process.resourcesPath, 'skills')
  : path.join(__dirname, '../electron/skills')
const userSkillsDir = path.join(userData, 'skills')
const skillStore = new SkillStore(builtinSkillsDir, userSkillsDir)
```

After `await pets.ensureBuiltins()` (line 64), add:

```typescript
await skillStore.init()
mcpManager.init().catch(err => console.error('[main] MCP init failed:', err)) // fire-and-forget
```

- [ ] **Step 3: Pass to registerIpcHandlers**

Update the `registerIpcHandlers` call (line 126):

```typescript
registerIpcHandlers({
  wm, pets, chars, ai, runner, cleanup, monitor, memory, watcher,
  getStats: () => latestStats,
  eventRouter, eventServer, runtimeState,
  events, factStore: facts, playbooks,
  mcpManager, skillStore   // ← ADD
})
```

- [ ] **Step 4: Shutdown on quit**

In the `before-quit` handler (line 214), add:

```typescript
app.on('before-quit', () => {
  runtimeStateRef?.clear()
  eventServerRef?.stop().catch(() => { /* ignore */ })
  mcpManager.shutdown().catch(() => {})   // ← ADD
})
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run
```
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(main): wire McpManager and SkillStore lifecycle"
```

---

### Task 8: Settings UI — Tools Tab

**Files:**
- Create: `src/settings/ToolsTab.tsx`
- Modify: `src/settings/App.tsx:9,11,119`

- [ ] **Step 1: Create ToolsTab component**

```tsx
// src/settings/ToolsTab.tsx
import { useEffect, useState } from 'react'

interface McpStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

interface SkillInfo {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  source: 'builtin' | 'user'
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--good)',
  error: 'var(--bad)',
}

export function ToolsTab() {
  const [mcpServers, setMcpServers] = useState<McpStatus[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)
    try {
      const [mcp, sk] = await Promise.all([
        window.ipc.invoke('mcp:status') as Promise<McpStatus[]>,
        window.ipc.invoke('skills:list') as Promise<SkillInfo[]>,
      ])
      setMcpServers(mcp)
      setSkills(sk)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const reloadMcp = async () => {
    await window.ipc.invoke('mcp:reload')
    await refresh()
  }

  const reloadSkills = async () => {
    await window.ipc.invoke('skills:reload')
    await refresh()
  }

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 16px' }}>工具</h2>

      {/* MCP Servers */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>MCP Servers</h3>
          <button onClick={reloadMcp} style={btnStyle} title="重连所有 MCP server">重连</button>
        </div>
        {loading && <div style={emptyStyle}>加载中...</div>}
        {!loading && mcpServers.length === 0 && (
          <div style={emptyStyle}>
            未配置 MCP Server。在 <code>~/.mote/mcp.json</code> 中添加配置。
          </div>
        )}
        {mcpServers.map(s => (
          <div key={s.name} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: s.connected ? STATUS_COLOR.connected : STATUS_COLOR.error
              }} />
              <span style={{ fontWeight: 500, fontSize: 13 }}>{s.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {s.connected ? `${s.toolCount} 个工具` : '连接失败'}
              </span>
            </div>
            {s.error && <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 4 }}>{s.error}</div>}
          </div>
        ))}
      </section>

      {/* Skills */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>技能 (Skills)</h3>
          <button onClick={reloadSkills} style={btnStyle} title="重新加载技能文件">刷新</button>
        </div>
        {!loading && skills.length === 0 && (
          <div style={emptyStyle}>暂无技能</div>
        )}
        {skills.map(s => (
          <div key={s.name} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 9, padding: '1px 4px', borderRadius: 3,
                background: s.source === 'builtin' ? 'var(--accent-soft)' : 'var(--elev)',
                color: 'var(--text-2)',
              }}>
                {s.source === 'builtin' ? '内置' : '用户'}
              </span>
              <span style={{ fontWeight: 500, fontSize: 13 }}>{s.name}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{s.description}</div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
              触发: {s.triggers.slice(0, 5).join(', ')}{s.triggers.length > 5 ? '...' : ''}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'var(--elev)', border: '0.5px solid var(--hairline-strong)',
  borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer',
  color: 'var(--text-2)',
}

const cardStyle: React.CSSProperties = {
  padding: '8px 12px', marginBottom: 6,
  background: 'var(--elev)', borderRadius: 8,
  border: '0.5px solid var(--hairline)',
}

const emptyStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-3)', padding: '8px 0',
}
```

- [ ] **Step 2: Add 'tools' tab to settings App.tsx**

In `src/settings/App.tsx`:

Add import at top:
```typescript
import { ToolsTab } from './ToolsTab'
```

Update the Tab type (line 9):
```typescript
type Tab = 'pets' | 'character' | 'api' | 'cleanup' | 'notify' | 'memory' | 'tools'
```

Add to TAB_DEFS array (after 'memory' entry):
```typescript
{ id: 'tools', label: '工具', subtitle: 'Tools', icon: 'M3 7l5-4 5 4M3 9l5 4 5-4M3 7v2M13 7v2M8 3v10' },
```

Wait — that icon is already used for 'api'. Use a different one:
```typescript
{ id: 'tools', label: '工具', subtitle: 'Tools', icon: 'M8 2v4M8 10v4M2 8h4M10 8h4M4.5 4.5l2 2M9.5 9.5l2 2M4.5 11.5l2-2M9.5 6.5l2-2' },
```

Add render in content area (after `tab === 'memory'`):
```typescript
{tab === 'tools' && <ToolsTab />}
```

- [ ] **Step 3: Run build check**

```bash
npx electron-vite build 2>&1 | tail -5
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/settings/ToolsTab.tsx src/settings/App.tsx
git commit -m "feat(settings): Tools tab for MCP server status and Skills"
```

---

### Task 9: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```
Expected: ALL PASS

- [ ] **Step 2: Build check**

```bash
npx electron-vite build 2>&1 | tail -10
```
Expected: no errors

- [ ] **Step 3: Manual dev test — Skills**

```bash
npm run dev
```

1. Open the pet chat panel
2. Type "帮我 commit 代码" → verify the AI response uses Git skill guidance
3. Open Settings → Tools tab → verify 3 built-in skills listed
4. Check that MCP section shows "未配置" message

- [ ] **Step 4: Manual dev test — MCP (optional, requires MCP server)**

Create a test `~/.mote/mcp.json`:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

Restart app, then:
1. Settings → Tools → verify filesystem server shows "connected" with N tools
2. Chat: "帮我看下 /tmp 有哪些文件" → verify MCP tool is used

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: integration fixes for MCP + Skills"
```
