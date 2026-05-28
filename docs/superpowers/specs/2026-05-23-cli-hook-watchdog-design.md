# CLI Hook 看门狗 · 设计文档

**日期**：2026-05-23
**作者**：renjiawei + Claude
**状态**：待实施

## 1. 背景与目标

用户日常工作主要在终端里使用 **Claude Code** 和 **Codex CLI** 跑编码任务。这两个工具一次任务常常需要几十秒到几分钟，用户在等待期间会切去做别的事。当前没有任何提醒机制 — 完成或出错都得手动切回终端检查。

**目标**：让桌宠（Mote）在 Claude Code / Codex CLI 发生关键事件时主动提醒用户，且不强迫用户改变现有的"在自己终端里直接用 CLI"的工作流。

**支持的事件**（v1）：

| 事件 | Claude Code Hook | Codex Hook | 提醒优先级 |
|------|------------------|------------|-----------|
| 任务完成 | `Stop` | `Stop` | 高（弹气泡） |
| 等待用户输入（权限/确认） | `Notification` | `PermissionRequest` | 高（弹气泡） |
| 出错/异常 | `Notification`（带 error） | `Stop` exitCode≠0 | 高（弹气泡 + ⚠️） |
| 会话启动 | `SessionStart` | `SessionStart` | 低（仅记录上下文，不弹） |

## 2. 范围 & 非目标

**做**：
- 自动安装/卸载 hook 配置到 Claude Code 和 Codex CLI
- 本地 HTTP 端口接收 hook 事件，路由到现有的 `WindowManager.showBubble` 弹气泡
- 设置页提供安装状态、测试按钮、最近事件历史

**不做**（v1 显式排除）：
- 不做"宠物建议动作"或"自主动作"（用户明确说只要播报）
- 不做 AI 生成提醒文案，用固定模板（避免 LLM 调用成本/延迟/不稳定）
- 不做静音时段、按事件类型禁用、自定义模板等设置项（等用过一周再决定）
- 不做 Claude/Codex 进程崩溃兜底（hook 不会触发）— 等真发生再加 transcript 监听
- 不做系统健康（温度/CPU）、专注行为（番茄/久坐）等其他"看门"场景（已收敛）
- 不持久化事件历史（隐私 + 简化）

## 3. 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Mote (Electron 主进程)                                       │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │ HookInstaller       │    │ LocalEventServer             │ │
│  │ - merge ~/.claude/  │    │ - http://127.0.0.1:<port>    │ │
│  │   settings.json     │    │ - POST /event/mote           │ │
│  │ - merge ~/.codex/   │    │ - X-Mote-Token 鉴权          │ │
│  │   config.toml       │    │                              │ │
│  │ - 备份/幂等/卸载     │    │                              │ │
│  └────────────────────┘    └──────────┬───────────────────┘ │
│                                       ▼                     │
│                            ┌──────────────────────┐         │
│                            │ EventRouter           │         │
│                            │ - 去抖（10s 同事件）   │         │
│                            │ - 事件→消息模板        │         │
│                            └──────────┬───────────┘         │
│                                       ▼                     │
│                            WindowManager.showBubble (复用)   │
└─────────────────────────────────────────────────────────────┘

终端那一侧：
  Claude/Codex hook 触发
    → ~/.mote/bin/event <Event> <Tool>  （安装时铺好的 wrapper）
    → 读 ~/.mote/runtime.json 拿当前端口和 token
    → curl -s POST http://127.0.0.1:<port>/event/mote || true
```

### 3.1 模块边界

| 模块 | 文件 | 职责 | 依赖 |
|------|------|------|------|
| HookInstaller | `electron/hook-installer.ts` | 解析/merge/写回用户配置文件，备份，幂等扫描，卸载 | Node fs，TOML 库 |
| LocalEventServer | `electron/event-server.ts` | Node http 监听 127.0.0.1，token 校验，转发到 EventRouter | Node http |
| EventRouter | `electron/event-router.ts` | 去抖、事件→消息映射、调 WindowManager | WindowManager |
| Runtime state | `~/.mote/runtime.json` | App 在跑时写入端口/token，退出时删除 | 文件系统 |
| Wrapper script | `~/.mote/bin/event` | hook 调用的 shell 入口，读 runtime.json 后 curl | sh, curl, sed |

每个模块单一职责，相互通过明确接口（函数调用、HTTP、JSON 文件）通信。

## 4. Hook 安装流程

### 4.1 触发时机
- **首次启动检测到未安装**：宠物冒泡"我能帮你盯 Claude/Codex 任务，要不要装？"，点了进设置弹窗确认
- **设置页**永远可点"安装 / 重装 / 卸载"按钮

### 4.2 确认弹窗（首装前必出）

弹窗内容：

- 文件列表：`~/.claude/settings.json`、`~/.codex/config.toml`
- 可展开预览要加的具体 JSON / TOML 片段
- 保护措施说明：
  - 先备份到 `<file>.mote-backup-<ISO-timestamp>`
  - 只 merge，不覆盖已有 hooks
  - Hook 命令带 `|| true`，app 没开不卡用户 CLI
- 按钮：[两边都装] [只装 Claude] [只装 Codex] [取消]

### 4.3 写入内容

**`~/.claude/settings.json`**（4 个事件）：

```json
{
  "hooks": {
    "Stop":         [{ "hooks": [{ "type": "command",
      "command": "$HOME/.mote/bin/event Stop claude" }]}],
    "Notification": [{ "hooks": [{ "type": "command",
      "command": "$HOME/.mote/bin/event Notification claude" }]}],
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "$HOME/.mote/bin/event SessionStart claude" }]}]
  }
}
```

**`~/.codex/config.toml`**（新版 hooks，失败降级到 `notify`）：

```toml
# mote-managed (do not edit manually; removed by Mote uninstaller)

[[hooks.Stop]]
hooks = [{ command = "$HOME/.mote/bin/event Stop codex" }]

[[hooks.PermissionRequest]]
hooks = [{ command = "$HOME/.mote/bin/event PermissionRequest codex" }]

[[hooks.SessionStart]]
hooks = [{ command = "$HOME/.mote/bin/event SessionStart codex" }]
```

降级路径：写入 `[[hooks.Stop]]` 后跑 `codex --version` 校验配置仍可解析，失败则改写为：

```toml
notify = ["sh", "-c", "$HOME/.mote/bin/event Stop codex"]
```

**降级代价（必须告知用户）**：`notify` 只在每轮 agent 结束时触发一次，**无法区分** PermissionRequest / SessionStart 等事件 — 全部归类为 `Stop`。降级时设置页要显示提示："你的 Codex 版本不支持 hooks，只能监听任务完成事件"。

### 4.4 幂等 & 卸载

- **识别我们的 hook**：所有 hook 命令都指向 `$HOME/.mote/bin/event`，扫描时按这个字符串匹配
- **重装**：先卸载（识别移除），再装新版
- **卸载**：扫所有 hooks 数组，剔除含 `.mote/bin/event` 的项；空数组则删 key；写回
- **写入前必须能 parse 原文件**，否则提示"你的配置文件有语法错误，先修一下"并中止

## 5. 本地事件端口

### 5.1 启动流程

1. App 启动时，从 39127 起往后试到第一个可绑端口
2. 生成 32 字节随机 token（base64）
3. 写 `~/.mote/runtime.json`（chmod 600），内容：
   ```json
   {
     "port": 39127,
     "token": "rndAbCd...",
     "pid": 12345,
     "started_at": "2026-05-23T..."
   }
   ```
4. App 退出时删除该文件（用 `app.on('before-quit')`，及 try-catch 兜底）
5. 写 wrapper 脚本到 `~/.mote/bin/event`，chmod 755

### 5.2 Wrapper 脚本

```sh
#!/bin/sh
# mote-managed
RT="$HOME/.mote/runtime.json"
[ -r "$RT" ] || exit 0

# 用 sed 解析 JSON，避免依赖 jq
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$RT")
TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RT")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0

EVENT="$1"
TOOL="$2"
[ -n "$EVENT" ] && [ -n "$TOOL" ] || exit 0

curl -s --max-time 1 -X POST \
  -H "X-Mote-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw "{\"event\":\"$EVENT\",\"tool\":\"$TOOL\",\"cwd\":\"$PWD\",\"ts\":$(date +%s)}" \
  "http://127.0.0.1:$PORT/event/mote" >/dev/null 2>&1 || true
```

### 5.3 HTTP 协议

```
POST http://127.0.0.1:<port>/event/mote
Headers:
  X-Mote-Token: <token>           ← 必填，对不上 401
  Content-Type: application/json
Body (≤ 16KB):
  {
    "event":  "Stop" | "Notification" | "PermissionRequest"
            | "SessionStart",
    "tool":   "claude" | "codex" | "test",
    "cwd":    "/abs/path",
    "ts":     1716468000,
    "extra":  { ... 选填 ... }
  }
Response:
  204 No Content    （hook 不等不读）
  401 if token mismatch
  413 if body > 16KB
  404 for any other path/method
```

### 5.4 安全

- 绑 `127.0.0.1` only
- Token 32 bytes 随机；`runtime.json` chmod 600
- Body 16KB cap
- 同用户的恶意进程能读 token 后伪造 — 不在防御范围（已能读 home，威胁更大）

## 6. EventRouter

### 6.1 去抖

按 `(tool, event, cwd)` 三元组做 10 秒窗口去抖。Codex 一次会话内可能连发多个 Stop（per-turn），不能每次都弹。

### 6.2 事件→消息模板

| 事件 | tool | 文案 |
|------|------|------|
| `Stop` | claude | "Claude 跑完啦，回来看看吧～" |
| `Stop` | codex | "Codex 完成了～" |
| `Notification` | claude | "Claude 在叫你（可能要 y/n）" |
| `PermissionRequest` | codex | "Codex 等你授权" |
| `Error`（由 Stop+exitCode≠0 或 Notification+err 关键字衍生） | * | "⚠️ {tool} 报错了" |
| `SessionStart` | * | （不弹气泡，只更新内存状态） |

模板都写在常量表里，未来想接 LLM 包装时换实现即可。

### 6.3 出错检测

v1 不解析 transcript，仅用 hook 自带信号：
- Codex：`Stop` 事件如带 `extra.exitCode ≠ 0` 则归类为 Error
- Claude Code：`Notification` 事件里 message 含 error / failed / fatal 关键字归类为 Error

更精确的崩溃检测留给 v2（transcript 文件监听）。

## 7. 设置页 UI

### 7.1 新增 tab "提醒"

三块内容：

1. **Hook 状态卡片**（每个工具一张）
   - 工具名 + 状态（✓ 已安装 / ⚠ 未安装）
   - 配置文件路径
   - 安装日期（从备份文件名读）
   - 按钮：[ 安装 ] 或 [ 重装 ] [ 卸载 ]

2. **测试按钮**
   - 点击后 app 自身向 `127.0.0.1:<port>/event/mote` POST 一条 `{event:"Stop", tool:"test"}`
   - 应立刻看到宠物冒泡。失败则链路有问题，便于排错

3. **最近事件**（仅内存，最多 20 条）
   - 时间 / event / tool / cwd
   - 重启清空

4. **运行时（折叠，默认收起）**
   - 端口、token（脱敏显示 + 复制按钮）、wrapper 路径

### 7.2 操作流

- **安装**：弹 4.2 确认弹窗 → merge → 写文件 → 刷新卡片状态
- **重装**：先卸载再安装
- **卸载**：弹"我会扫所有含 `.mote/bin/event` 的 hook 项并删除"确认 → 扫描 → 写回 → 刷新卡片
- **任何写文件失败**：立刻提示、不修改、不更新 UI 状态

## 8. 风险 & 缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 用户配置文件已被手工编辑、语法错误 | 写入失败可能破坏文件 | 先 parse 校验，失败中止；写之前已备份 |
| Codex 不同版本 hook 语法不同 | 写入后 codex 启动报错 | 写后跑 `codex --version` 校验，失败回滚到备份 + 降级到 `notify` |
| 端口冲突 | 起不来 | 从 39127 起循环试 10 个端口 |
| 用户开多个 Mote 实例 | 第二个覆盖 runtime.json | 启动时检测 pid 文件，已有则警告并退出 |
| hook 在 app 没运行时触发 | wrapper 静默退出，不阻塞 CLI | wrapper 第一行 `[ -r runtime.json ] || exit 0` |
| 网络层异常（防火墙等） | curl 卡死 | `--max-time 1` 强制 1 秒超时 |
| app 异常退出未清 runtime.json | wrapper 找过期 port 失败 | wrapper curl 失败本就静默；启动时也覆盖写新文件 |

## 9. 实施顺序建议（供下一步计划参考）

1. LocalEventServer + runtime.json 写入 + wrapper 安装 + 测试按钮接通整链路
2. HookInstaller：先做 Claude Code（JSON 简单），再做 Codex（TOML）
3. 设置页 tab "提醒"
4. EventRouter 接 WindowManager.showBubble
5. 首启动自检引导（冒泡提示"要装吗"）

不必一口气全做完 — 1+2 完成就能跑通"装上后能收到事件"，已经有用。

## 10. 验收标准

- 装上后，在外面终端跑 `claude` 让它做点事，结束后宠物在 3 秒内弹气泡 "Claude 跑完啦"
- 跑 `codex` 触发权限确认时，宠物弹气泡 "Codex 等你授权"
- 关掉 Mote 后再跑 `claude`，CLI 不卡、不报错
- 重新开 Mote 后，新的 `claude` 调用又能正常弹气泡
- 设置页"卸载"后，`~/.claude/settings.json` 里 `.mote/bin/event` 那几条 hook 完全清掉
- 卸载前后，`settings.json` 用 `jq .` 解析仍合法
