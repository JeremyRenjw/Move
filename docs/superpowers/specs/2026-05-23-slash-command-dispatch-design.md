# Slash 命令直通 CLI

日期：2026-05-23
状态：approved

## 背景

InputBar 的输入建议里有 `/codex 帮我重构`、`/run claude` 这类 slash 命令，但代码里没有任何解析层——这些字符串原样发给 AI 模型，AI 只会当作普通对话生成代码文字，**不会**真的调起 `codex` / `claude` CLI。

当前 app 调起 CLI 的唯一路径是：Claude provider 在 `ai.chat` 时通过 function calling 决定调 `run_codex` / `run_claude_code` tool。OpenAI 分支甚至连 tools 都没传，更不可能触发。

## 目标

让 `/codex`、`/claude`、`/run` 这三种前缀的输入**绕过 AI 模型**，直接 spawn 对应 CLI，沿用现有的 runner/watcher 基础设施。

## 非目标

- 不改 AI tool-calling 路径（自然语言"帮我跑一下 codex"仍走 AI 决策）
- 不给 OpenAI provider 补 tools 参数
- 不动前端 InputBar 的建议文本
- slash 路径不调 AI 做角色化总结（用户已经明确意图，不需要解释）

## 设计

### 改动范围

单文件：`electron/ipc.ts` 里的 `CHAT_SEND` handler。

### Slash 文法

```
/codex <prompt>            → codex --print <prompt>
/claude <prompt>           → claude --dangerously-skip-permissions --print <prompt>
/run codex <prompt>        ≡ /codex <prompt>
/run claude <prompt>       ≡ /claude <prompt>
```

未匹配的输入（裸 `/codex` 无 prompt、`/run foo bar`、`你好`）一律走原 AI 路径。

### 解析函数

```ts
function parseSlash(msg: string): { cmd: 'codex' | 'claude'; prompt: string } | null {
  const m = msg.match(/^\/(\w+)\s+(.+)$/s)
  if (!m) return null
  const [, head, rest] = m
  if (head === 'codex')  return { cmd: 'codex',  prompt: rest.trim() }
  if (head === 'claude') return { cmd: 'claude', prompt: rest.trim() }
  if (head === 'run') {
    const m2 = rest.match(/^(codex|claude)\s+(.+)$/s)
    if (!m2) return null
    return { cmd: m2[1] as 'codex' | 'claude', prompt: m2[2].trim() }
  }
  return null
}
```

放在 ipc.ts 模块顶层（不放进 handler 闭包，便于以后单测）。

### Handler 分支

`CHAT_SEND` handler 进入后，先 `parseSlash(message)`：

**命中 slash**：
1. 把用户输入追加到 sessions.jsonl（保留"用户问过什么"的痕迹）
2. **不** 调 `ai.chat`，**不** 调 `ai.summarizeForMemory`
3. 构造 args：
   - `claude` → `['--dangerously-skip-permissions', '--print', prompt]`
   - `codex`  → `['--print', prompt]`
4. 启动 `watcher.start(...)` + `runner.run(...)`，复用现有的 `onLine` / `onWaiting` 回调
5. 把 `runner.run` 拿到的 handle 赋给闭包变量 `activeCli`（保留现有 CLI_INPUT 处理）
6. 结束后照常 broadcast `CLI_DONE` + `CHAT_DONE`
7. **不** 调 ai.chat 让角色总结

**未命中**：原路径不变。

### 复用现有基础设施

slash 分支用的所有组件都已经存在：
- `runner.run(cmd, args, { workdir, onLine, onWaiting })`
- `watcher.start({ command, apiConfig, apiKey, onLine, onNote })`
- `ai.suggestStdinReply(...)`（CLI 等待用户输入时自动判断 y/n）
- `wm.broadcast(IPC.CLI_LINE, ...)` / `IPC.CLI_DONE` / `IPC.WATCHER_NOTE` / `IPC.CLI_WAITING`
- `activeCli` 闭包变量（CLI_INPUT 写入用）

watcher 仍然需要 `apiConfig` + `apiKey` 来做监督和 stdin 自动回答；走 slash 时 apiKey 缺失就降级——监督和自动回答关掉，但 CLI 本身能跑。

### 错误与边界

| 场景 | 行为 |
|---|---|
| 裸 `/codex` 无 prompt | 走 AI 路径（AI 会解释怎么用） |
| `/run xxx ...`，xxx 不是 codex/claude | 走 AI 路径 |
| 多行 prompt：`/codex 第一行\n第二行` | 整段当 prompt（正则用 `s` 标志） |
| apiKey 未配置 | slash 路径仍可跑（不需要 API Key），但跳过 watcher 监督和 stdin 自动回答 |
| CLI 抛错 | broadcast `CLI_LINE: 错误: ...` + `CLI_DONE exitCode=1`（同现有逻辑） |

### 记忆

- 用户消息照常 `memory.appendSession`，确保"用户问过什么"留痕
- **不**调 `summarizeForMemory`（没有 AI 回复可总结，memory 系统设计上也只总结 user/pet 对话）

## 测试计划

手动：
1. `/codex 写个 hello world` → 看到 `codex --print` 启动、流式输出、CLI_DONE
2. `/run claude pwd` → 看到 `claude --dangerously-skip-permissions --print pwd` 启动
3. `/claude ls` → 同 2
4. `你好` → 仍走 AI 自然语言回复（回归测试）
5. 裸 `/codex` → 走 AI（AI 会解释）
6. `/codex 多行\nprompt` → 整段当一个 prompt

无单测（项目目前没单测基础设施）。

## 实现量级

- ipc.ts 新增约 50 行（parseSlash 函数 + handler 内的 if 分支）
- 零删除、零重构其他文件
