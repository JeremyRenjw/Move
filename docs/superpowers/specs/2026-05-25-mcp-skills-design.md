# MCP + Skills 集成设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宠物 AI 能连接外部 MCP Server 扩展工具能力，并通过 Markdown Skill 文件注入领域知识。

**Architecture:** MCP 层用官方 SDK 管理 server 进程和工具路由；Skill 层从文件系统加载 markdown 模板，按关键词匹配注入 system prompt。两层独立运作，都汇聚到 agentLoop 的工具定义和 system prompt 里。

**Tech Stack:** `@modelcontextprotocol/sdk`, `gray-matter` (frontmatter 解析), Electron main process

---

## 1. MCP 集成

### 1.1 配置文件

路径：`~/.mote/mcp.json`

格式兼容 Claude Desktop：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": { "KEY": "value" }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

- 文件不存在时不报错，MCP 功能静默禁用
- 每个 server 定义：`command`（必填）、`args`（可选）、`env`（可选）

### 1.2 McpManager

文件：`electron/mcp-manager.ts`

```typescript
interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpToolInfo {
  name: string           // 原始名，如 "read_file"
  prefixedName: string   // 加 prefix，如 "mcp__filesystem__read_file"
  description: string
  inputSchema: Record<string, unknown>
  serverName: string     // 所属 server 名
}

class McpManager {
  constructor(userDataPath: string)

  /** 启动所有 MCP server，获取工具列表 */
  async init(): Promise<void>

  /** 返回所有 MCP 工具定义（Anthropic.Tool 格式） */
  getTools(): Anthropic.Tool[]

  /** 调用指定 MCP 工具 */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string>

  /** 关闭所有连接 */
  async shutdown(): Promise<void>

  /** 返回 server 状态列表（给 settings UI 用） */
  getStatus(): { name: string; connected: boolean; toolCount: number; error?: string }[]
}
```

**init() 流程：**
1. 读 `~/.mote/mcp.json`，不存在则跳过
2. 对每个 server：`spawn(command, args, { env: { ...process.env, ...env } })`
3. 用 `StdioClientTransport` 连接
4. 调 `client.initialize()` 握手
5. 调 `client.listTools()` 获取工具列表
6. 转换为 `McpToolInfo` 存入内存
7. 单个 server 失败不影响其他 server

**工具名 prefix 规则：**
- 原始名：`read_file`
- 加 prefix：`mcp__{serverName}__read_file`
- 避免跟内置工具冲突

**callTool() 路由：**
1. 解析 prefix 找到对应 server
2. 提取原始工具名
3. 调 `client.callTool({ name, arguments })`
4. 返回结果文本

### 1.3 接入 Agent Loop

修改 `electron/ai.ts` 的 `agentLoop()`：

```typescript
interface AgentLoopOpts {
  // ...existing opts...
  mcpTools?: Anthropic.Tool[]
  mcpExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string>
}
```

**改动点：**
1. `agentLoop` 开头合并工具：`[...AGENT_TOOLS, ...(mcpTools ?? [])]`
2. 工具路由增加 MCP 分支：
   ```
   if (mcpExecutor && prefixedName starts with 'mcp__')
     → mcpExecutor(prefixedName, input)
   ```
3. Claude 分支和 OpenAI 分支都要改（两处工具路由）

### 1.4 IPC 集成

修改 `electron/ipc.ts` 的 CHAT_SEND handler：

```typescript
const agentResult = await ai.agentLoop({
  // ...existing opts...
  mcpTools: mcpManager.getTools(),
  mcpExecutor: (name, input) => mcpManager.callTool(name, input)
})
```

新增 IPC handler（给 settings UI 用）：

```typescript
ipcMain.handle('mcp:status', () => mcpManager.getStatus())
ipcMain.handle('mcp:reload', async () => { await mcpManager.shutdown(); await mcpManager.init() })
```

### 1.5 生命周期

```
main.ts:
  mcpManager = new McpManager(userData)
  await mcpManager.init()   // 启动所有 server
  // ...传给 ipc handlers...
  
app.on('will-quit'):
  await mcpManager.shutdown()
```

### 1.6 Settings UI

在 `src/settings/App.tsx` 新增 "工具" (Tools) tab：

```typescript
type Tab = 'pets' | 'character' | 'api' | 'notify' | 'cleanup' | 'memory' | 'tools'
```

新文件：`src/settings/ToolsTab.tsx`

展示：
- MCP server 列表，每个显示：名称、状态（connected/error）、工具数量
- 失败的 server 显示错误信息
- "重新连接" 按钮调 `mcp:reload`
- "编辑配置" 按钮用系统默认编辑器打开 `~/.mote/mcp.json`
- 下方显示 Skill 列表（见 Part 2）

---

## 2. Skill 系统

### 2.1 Skill 文件格式

Markdown + YAML frontmatter：

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
tools:
  - bash
  - read_file
---

# Git Helper

你是一个 Git 专家。当用户请求 Git 相关操作时：

1. 先用 `bash: git status` 查看当前状态
2. 根据用户需求执行对应操作
3. ...

## 注意事项

- 危险操作必须先警告
- 提交信息用中文
```

**Frontmatter 字段：**
- `name`（必填）：唯一标识符
- `description`（必填）：一句话描述
- `triggers`（必填）：关键词列表，用于匹配
- `tools`（可选）：此 skill 推荐使用的工具（仅作提示）

### 2.2 SkillStore

文件：`electron/skill-store.ts`

```typescript
interface Skill {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  body: string              // frontmatter 之后的 markdown 正文
  source: 'builtin' | 'user'
}

class SkillStore {
  /** 加载所有 skill 文件 */
  async init(): Promise<void>

  /** 根据用户消息匹配相关 skill */
  match(userMessage: string): Skill[]

  /** 列出所有已加载的 skill（给 settings UI 用） */
  list(): Skill[]

  /** 重新加载 skill 文件 */
  async reload(): Promise<void>
}
```

**init() 流程：**
1. 扫描内置目录：`app.getPath('resources')/skills/*.md`
   - dev 模式下用项目根目录的 `electron/skills/*.md`
2. 扫描用户目录：`~/.mote/skills/*.md`
3. 用 `gray-matter` 解析每个文件
4. 构建 skill 列表

**match() 逻辑：**
```typescript
match(userMessage: string): Skill[] {
  const msg = userMessage.toLowerCase()
  return this.skills.filter(skill =>
    skill.triggers.some(t => msg.includes(t.toLowerCase()))
  )
}
```

- 大小写不敏感的子串匹配
- 返回所有匹配的 skill（通常 0-2 个）
- 无匹配时返回空数组（不注入任何 skill）

### 2.3 注入 Agent Loop

修改 `electron/ai.ts` 的 `agentLoop()`：

```typescript
interface AgentLoopOpts {
  // ...existing opts...
  matchedSkills?: Skill[]
}
```

在 system prompt 末尾追加：

```typescript
if (matchedSkills && matchedSkills.length > 0) {
  const skillBlock = matchedSkills.map(s =>
    `<skill name="${s.name}">\n${s.body}\n</skill>`
  ).join('\n\n')
  systemPrompt += `\n\n[当前激活的技能]\n\n${skillBlock}`
}
```

### 2.4 IPC 集成

修改 `electron/ipc.ts` 的 CHAT_SEND handler：

```typescript
const matchedSkills = skillStore.match(message)
const agentResult = await ai.agentLoop({
  // ...existing opts...
  matchedSkills
})
```

新增 IPC handler：

```typescript
ipcMain.handle('skills:list', () => skillStore.list())
ipcMain.handle('skills:reload', async () => { await skillStore.reload() })
ipcMain.handle('skills:open-dir', () => {
  shell.openPath(path.join(userData, 'skills'))
})
```

### 2.5 内置 Skills

目录：`electron/skills/`（dev 模式直接读源码目录，打包后 copy 到 resources）

预置 3 个 skill：

1. **git-helper.md** — Git 操作指导、最佳实践、危险操作警告
2. **code-review.md** — 代码审查 checklist（安全性、性能、可读性）
3. **system-admin.md** — 系统管理（进程、磁盘、网络诊断）

每个 skill 控制在 200 行以内，避免 token 浪费。

### 2.6 Settings UI 扩展

在 `src/settings/ToolsTab.tsx` 的下半部分显示 Skill 列表：

- 列表展示：名称、描述、来源（内置/用户）、触发词数量
- "打开目录" 按钮打开 `~/.mote/skills/`
- "刷新" 按钮调 `skills:reload`

---

## 3. 文件变更汇总

### 新建文件

| 文件 | 说明 |
|------|------|
| `electron/mcp-manager.ts` | MCP server 进程管理和工具路由 |
| `electron/skill-store.ts` | Skill 文件加载和匹配 |
| `electron/skills/git-helper.md` | 内置 Git 技能 |
| `electron/skills/code-review.md` | 内置代码审查技能 |
| `electron/skills/system-admin.md` | 内置系统管理技能 |
| `src/settings/ToolsTab.tsx` | 工具设置页面 |
| `tests/mcp-manager.test.ts` | McpManager 测试 |
| `tests/skill-store.test.ts` | SkillStore 测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `package.json` | 添加 `@modelcontextprotocol/sdk`, `gray-matter` 依赖 |
| `electron/ai.ts` | `agentLoop` 增加 `mcpTools`, `mcpExecutor`, `matchedSkills` 参数 |
| `electron/ipc.ts` | CHAT_SEND 接入 MCP + Skill；新增 mcp/skills IPC handlers |
| `electron/main.ts` | 启动 McpManager + SkillStore，传入 ipc |
| `electron/preload.ts` | 暴露新的 IPC channels |
| `src-shared/types.ts` | 新增 IPC channel 常量 |
| `src/settings/App.tsx` | 新增 "工具" tab |

---

## 4. 测试计划

### 单元测试

**tests/mcp-manager.test.ts：**
- mock StdioClientTransport
- 测试 init() 成功连接 2 个 server
- 测试单个 server 失败不影响其他
- 测试 callTool() 正确路由到目标 server
- 测试 getTools() 返回正确格式
- 测试 shutdown() 关闭所有连接
- 测试 mcp.json 不存在时静默跳过

**tests/skill-store.test.ts：**
- 用 memfs 或 tmpdir 创建测试 skill 文件
- 测试 init() 扫描 builtin + user 目录
- 测试 match() 关键词匹配
- 测试大小写不敏感
- 测试多个 skill 匹配
- 测试无匹配返回空
- 测试 frontmatter 解析失败跳过
- 测试 reload() 重新加载

### 集成验证

1. `npm run dev`，配置一个简单的 MCP server（如 `@modelcontextprotocol/server-filesystem`）
2. 对宠物说"帮我看下 xxx 目录有哪些文件" → 应该用 MCP filesystem 工具
3. 对宠物说"帮我 commit 代码" → 应该触发 git-helper skill
4. Settings → Tools tab 能看到 MCP server 状态和 skill 列表

---

## 5. 安全考虑

- MCP server 以用户权限运行，跟内置 bash 工具同级别
- `mcp.json` 中的 env 可能含 token → 不在 UI 中明文展示
- Skill 文件只注入 system prompt，不执行代码
- MCP 工具调用结果同样截断到 8KB（复用现有 truncate）
