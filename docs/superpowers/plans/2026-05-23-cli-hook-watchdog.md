# CLI Hook 看门狗 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宠物在用户自己终端里跑的 Claude Code / Codex CLI 发生关键事件（任务完成、需要输入、出错、会话启动）时，主动弹气泡提醒。

**Architecture:** 在用户首肯下，自动 merge hook 配置到 `~/.claude/settings.json` 和 `~/.codex/config.toml`，hook 调一个本地包装脚本 `~/.mote/bin/event`，脚本读 `~/.mote/runtime.json` 拿当前端口/token，POST 给 Electron 主进程内的本地 HTTP 端口（127.0.0.1，token 鉴权），事件经 EventRouter 去抖+模板映射后调 `WindowManager.showBubble`。

**Tech Stack:** Electron (main process)，Node 内置 `http`，Vitest + memfs（测试），React（Settings UI）。**不引入新 npm 依赖** — Claude 配置走 JSON parse；Codex 配置用 "block marker" 文本块替换（避免 TOML 库 + 保留用户原文格式注释）。

**Spec:** `docs/superpowers/specs/2026-05-23-cli-hook-watchdog-design.md`

---

## File Structure

**Create:**

| 文件 | 职责 |
|------|------|
| `electron/runtime-state.ts` | 管理 `~/.mote/runtime.json` 与 `~/.mote/bin/event` wrapper 脚本的写入/清理 |
| `electron/event-server.ts` | Node http 服务器，绑 127.0.0.1，POST `/event/mote`，token 鉴权 |
| `electron/event-router.ts` | 事件去抖 + 模板映射 + 调 `WindowManager.showBubble`，维护最近事件 ring buffer |
| `electron/hook-installer.ts` | Claude (JSON merge) + Codex (block-marker 文本块) 的 install/uninstall/status 三组函数 |
| `src/settings/NotifyTab.tsx` | 设置页"提醒" tab 的 UI |
| `tests/runtime-state.test.ts` | runtime.json 写入、wrapper 内容、chmod |
| `tests/event-server.test.ts` | HTTP 端到端：token、超大 body、错误路径 |
| `tests/event-router.test.ts` | 去抖、模板映射、错误事件分类 |
| `tests/hook-installer.test.ts` | merge 幂等、备份、卸载、Codex 块替换 |

**Modify:**

| 文件 | 改动 |
|------|------|
| `src-shared/types.ts` | 加 `NotifyEvent`、`HookInstallStatus`、`RuntimeInfo` 类型；扩展 `IPC` 常量加 6 个新通道 |
| `electron/main.ts` | 实例化 RuntimeState/EventServer/EventRouter/HookInstaller，启停生命周期，首启动检测 |
| `electron/ipc.ts` | 加 6 个新 handler；扩 `registerIpcHandlers` deps 类型 |
| `src/settings/App.tsx` | 加 `'notify'` tab，渲染 `<NotifyTab />` |

---

## Task 1: 加共享类型与 IPC 通道名

**Files:**
- Modify: `src-shared/types.ts`

- [ ] **Step 1: 加新类型**

在 `src-shared/types.ts` 末尾追加：

```ts
// ─── CLI Hook 看门狗 ───

export type NotifyEventName =
  | 'Stop'
  | 'Notification'
  | 'PermissionRequest'
  | 'SessionStart'
  | 'Error'   // 内部派生（由 Stop+exitCode≠0 或 Notification+err 推断），hook 端不会直接发

export type NotifyToolName = 'claude' | 'codex' | 'test'

export interface NotifyEvent {
  event:  NotifyEventName
  tool:   NotifyToolName
  cwd:    string
  ts:     number       // unix seconds
  extra?: Record<string, unknown>
}

export interface HookInstallStatus {
  tool:         'claude' | 'codex'
  configPath:   string
  installed:    boolean
  installedAt?: string    // ISO from backup filename, may be absent if backups pruned
  eventCount:   number    // number of our hook entries currently in the file
  degraded?:    boolean   // codex only: true if forced into `notify` fallback
}

export interface RuntimeInfo {
  port:        number
  tokenMasked: string     // e.g. "rndA••••••AbCd"
  wrapperPath: string     // ~/.mote/bin/event
}
```

- [ ] **Step 2: 扩展 IPC 常量**

在 `src-shared/types.ts` 的 `IPC` 对象里追加（在最后一个属性之前加逗号）：

```ts
  // Notify hooks (Renderer → Main)
  NOTIFY_HOOK_GET_STATUS: 'notify:hook:get-status', // → HookInstallStatus[]
  NOTIFY_HOOK_INSTALL:    'notify:hook:install',    // tool: 'claude'|'codex'|'both' → void (throws on user-config parse failure)
  NOTIFY_HOOK_UNINSTALL:  'notify:hook:uninstall',  // tool: 'claude'|'codex'|'both' → void
  NOTIFY_TEST_EVENT:      'notify:test-event',      // → void (POSTs a synthetic Stop event to own server)
  NOTIFY_RECENT_EVENTS:   'notify:recent-events',   // → NotifyEvent[] (最多 20 条，仅内存)
  NOTIFY_RUNTIME_INFO:    'notify:runtime-info',    // → RuntimeInfo
```

- [ ] **Step 3: 编译过一遍**

Run: `npx tsc --noEmit`
Expected: 通过（仅类型/常量新增，不动现有逻辑）

- [ ] **Step 4: Commit**

```bash
git add src-shared/types.ts
git commit -m "feat(notify): add NotifyEvent/HookInstallStatus types and IPC channels"
```

---

## Task 2: RuntimeState — 管 runtime.json 与 wrapper 脚本

**Files:**
- Create: `electron/runtime-state.ts`
- Create: `tests/runtime-state.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/runtime-state.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { RuntimeState } from '../electron/runtime-state'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-rs-'))
}

describe('RuntimeState', () => {
  let home: string
  let rs: RuntimeState

  beforeEach(() => { home = tmpHome(); rs = new RuntimeState(home) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('writes runtime.json with chmod 600', () => {
    rs.write({ port: 39127, token: 'tkn' })
    const file = path.join(home, '.mote', 'runtime.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(data.port).toBe(39127)
    expect(data.token).toBe('tkn')
    expect(data.pid).toBe(process.pid)
    expect(typeof data.started_at).toBe('string')
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clear() removes runtime.json silently when absent', () => {
    expect(() => rs.clear()).not.toThrow()
  })

  it('clear() removes runtime.json when present', () => {
    rs.write({ port: 1, token: 't' })
    rs.clear()
    expect(fs.existsSync(path.join(home, '.mote', 'runtime.json'))).toBe(false)
  })

  it('ensureWrapper() writes script with chmod 755 and parseable shebang', () => {
    rs.ensureWrapper()
    const file = path.join(home, '.mote', 'bin', 'event')
    const body = fs.readFileSync(file, 'utf-8')
    expect(body.startsWith('#!/bin/sh')).toBe(true)
    expect(body).toContain('# mote-managed')
    expect(body).toContain('runtime.json')
    expect(body).toContain('curl')
    expect(body).toContain('--max-time 1')
    expect(body).toContain('|| true')
    expect(body).toContain('/event/mote')
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o755)
  })

  it('ensureWrapper() is idempotent and refreshes content if outdated', () => {
    rs.ensureWrapper()
    const file = path.join(home, '.mote', 'bin', 'event')
    fs.writeFileSync(file, '#!/bin/sh\necho stale\n')
    rs.ensureWrapper()
    expect(fs.readFileSync(file, 'utf-8')).toContain('runtime.json')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/runtime-state.test.ts`
Expected: FAIL — `Cannot find module '../electron/runtime-state'`

- [ ] **Step 3: 写实现**

`electron/runtime-state.ts`：

```ts
import * as fs from 'node:fs'
import * as path from 'node:path'

const WRAPPER_BODY = `#!/bin/sh
# mote-managed (do not edit manually; rewritten by Mote on startup)
RT="$HOME/.mote/runtime.json"
[ -r "$RT" ] || exit 0

# Parse port and token from runtime.json without depending on jq.
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$RT")
TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$RT")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0

EVENT="$1"
TOOL="$2"
[ -n "$EVENT" ] && [ -n "$TOOL" ] || exit 0

# CWD is the directory where claude/codex was invoked.
CWD=$(pwd)
TS=$(date +%s)

curl -s --max-time 1 -X POST \\
  -H "X-Mote-Token: $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-raw "{\\"event\\":\\"$EVENT\\",\\"tool\\":\\"$TOOL\\",\\"cwd\\":\\"$CWD\\",\\"ts\\":$TS}" \\
  "http://127.0.0.1:$PORT/event/mote" >/dev/null 2>&1 || true
`

export interface RuntimePayload {
  port:  number
  token: string
}

export class RuntimeState {
  private dir:     string
  private rtFile:  string
  private binDir:  string
  private wrapper: string

  constructor(home: string = require('node:os').homedir()) {
    this.dir     = path.join(home, '.mote')
    this.rtFile  = path.join(this.dir, 'runtime.json')
    this.binDir  = path.join(this.dir, 'bin')
    this.wrapper = path.join(this.binDir, 'event')
  }

  get wrapperPath(): string { return this.wrapper }

  write(p: RuntimePayload): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const data = {
      port:       p.port,
      token:      p.token,
      pid:        process.pid,
      started_at: new Date().toISOString()
    }
    fs.writeFileSync(this.rtFile, JSON.stringify(data, null, 2), { mode: 0o600 })
    // mode in writeFileSync only applies if file is created; force chmod for safety.
    fs.chmodSync(this.rtFile, 0o600)
  }

  clear(): void {
    try { fs.unlinkSync(this.rtFile) } catch { /* ignore */ }
  }

  ensureWrapper(): void {
    fs.mkdirSync(this.binDir, { recursive: true, mode: 0o755 })
    let needsWrite = true
    try {
      const existing = fs.readFileSync(this.wrapper, 'utf-8')
      if (existing === WRAPPER_BODY) needsWrite = false
    } catch { /* missing — write */ }
    if (needsWrite) {
      fs.writeFileSync(this.wrapper, WRAPPER_BODY, { mode: 0o755 })
      fs.chmodSync(this.wrapper, 0o755)
    }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/runtime-state.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add electron/runtime-state.ts tests/runtime-state.test.ts
git commit -m "feat(notify): runtime.json writer and wrapper script installer"
```

---

## Task 3: LocalEventServer — HTTP + token

**Files:**
- Create: `electron/event-server.ts`
- Create: `tests/event-server.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/event-server.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'node:http'
import { LocalEventServer } from '../electron/event-server'
import type { NotifyEvent } from '../src-shared/types'

function post(port: number, body: string | Buffer, headers: Record<string, string> = {}, path = '/event/mote', method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let buf = ''
      res.setEncoding('utf-8')
      res.on('data', c => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('LocalEventServer', () => {
  let server: LocalEventServer
  let received: NotifyEvent[] = []
  let port: number
  let token: string

  beforeEach(async () => {
    received = []
    server = new LocalEventServer(ev => { received.push(ev) })
    const info = await server.start(0)  // 0 = ephemeral
    port = info.port
    token = info.token
  })

  afterEach(async () => { await server.stop() })

  it('chooses an ephemeral port and generates a non-empty token', () => {
    expect(port).toBeGreaterThan(0)
    expect(token.length).toBeGreaterThanOrEqual(32)
  })

  it('accepts well-formed POST with valid token and calls handler', async () => {
    const body = JSON.stringify({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    const r = await post(port, body, { 'X-Mote-Token': token, 'Content-Type': 'application/json' })
    expect(r.status).toBe(204)
    expect(received.length).toBe(1)
    expect(received[0].event).toBe('Stop')
    expect(received[0].tool).toBe('claude')
  })

  it('returns 401 when token header is missing', async () => {
    const r = await post(port, '{}', { 'Content-Type': 'application/json' })
    expect(r.status).toBe(401)
    expect(received.length).toBe(0)
  })

  it('returns 401 when token does not match', async () => {
    const r = await post(port, '{}', { 'X-Mote-Token': 'wrong' })
    expect(r.status).toBe(401)
  })

  it('returns 413 when body exceeds 16 KB', async () => {
    const big = Buffer.alloc(16 * 1024 + 1, 'a')
    const r = await post(port, big, { 'X-Mote-Token': token, 'Content-Length': String(big.length) })
    expect(r.status).toBe(413)
    expect(received.length).toBe(0)
  })

  it('returns 404 on wrong path', async () => {
    const r = await post(port, '{}', { 'X-Mote-Token': token }, '/wrong')
    expect(r.status).toBe(404)
  })

  it('returns 404 on wrong method', async () => {
    const r = await post(port, '', { 'X-Mote-Token': token }, '/event/mote', 'GET')
    expect(r.status).toBe(404)
  })

  it('returns 400 on invalid JSON', async () => {
    const r = await post(port, 'not json', { 'X-Mote-Token': token })
    expect(r.status).toBe(400)
    expect(received.length).toBe(0)
  })

  it('binds 127.0.0.1 only (cannot reach via 0.0.0.0 listener test omitted; bind addr asserted in metadata)', () => {
    expect(server.boundAddress).toBe('127.0.0.1')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/event-server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

`electron/event-server.ts`：

```ts
import * as http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { NotifyEvent } from '@shared/types'

const MAX_BODY = 16 * 1024
const PORT_RANGE_START = 39127
const PORT_RANGE_TRIES = 10

export interface ServerInfo {
  port:  number
  token: string
}

export class LocalEventServer {
  private server: http.Server | null = null
  private token  = ''
  private port   = 0
  readonly boundAddress = '127.0.0.1'

  constructor(private handler: (ev: NotifyEvent) => void) {}

  async start(preferredPort: number = PORT_RANGE_START): Promise<ServerInfo> {
    this.token  = randomBytes(24).toString('base64url')  // 32 chars
    this.server = http.createServer((req, res) => this.dispatch(req, res))

    // Try ports preferredPort..preferredPort+N-1, or 0 (ephemeral) if preferredPort===0.
    const tries = preferredPort === 0 ? [0] : Array.from(
      { length: PORT_RANGE_TRIES }, (_, i) => preferredPort + i
    )
    for (const p of tries) {
      try {
        await this.listen(p)
        const addr = this.server!.address()
        this.port = (typeof addr === 'object' && addr) ? addr.port : p
        return { port: this.port, token: this.token }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      }
    }
    throw new Error(`No free port in ${preferredPort}..${preferredPort + PORT_RANGE_TRIES - 1}`)
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => { this.server!.off('listening', onListen); reject(err) }
      const onListen = (): void => { this.server!.off('error', onError); resolve() }
      this.server!.once('error', onError)
      this.server!.once('listening', onListen)
      this.server!.listen(port, this.boundAddress)
    })
  }

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/event/mote') {
      res.writeHead(404).end(); return
    }
    if (req.headers['x-mote-token'] !== this.token) {
      res.writeHead(401).end(); return
    }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (res.headersSent) return  // already responded with 413
      const body = Buffer.concat(chunks).toString('utf-8')
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      const ev = parsed as Partial<NotifyEvent>
      if (!ev.event || !ev.tool) { res.writeHead(400).end(); return }
      res.writeHead(204).end()
      try { this.handler(ev as NotifyEvent) }
      catch (err) { console.error('[event-server] handler threw:', err) }
    })
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/event-server.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add electron/event-server.ts tests/event-server.test.ts
git commit -m "feat(notify): local HTTP event server with token auth"
```

---

## Task 4: EventRouter — 去抖 + 模板映射

**Files:**
- Create: `electron/event-router.ts`
- Create: `tests/event-router.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/event-router.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventRouter } from '../electron/event-router'
import type { NotifyEvent } from '../src-shared/types'

describe('EventRouter', () => {
  let bubbles: { label: string; source: string }[]
  let router: EventRouter

  beforeEach(() => {
    bubbles = []
    router = new EventRouter({
      showBubble: (label, source) => { bubbles.push({ label, source }) }
    })
  })

  it('emits a bubble for Stop+claude with the right template', () => {
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].label).toMatch(/Claude.*完/)
  })

  it('emits a bubble for PermissionRequest+codex', () => {
    router.handle({ event: 'PermissionRequest', tool: 'codex', cwd: '/x', ts: 1 })
    expect(bubbles[0].label).toMatch(/Codex.*授权/)
  })

  it('does NOT bubble on SessionStart (only updates context)', () => {
    router.handle({ event: 'SessionStart', tool: 'claude', cwd: '/x', ts: 1 })
    expect(bubbles).toHaveLength(0)
  })

  it('classifies Stop+exitCode≠0 as Error', () => {
    router.handle({ event: 'Stop', tool: 'codex', cwd: '/x', ts: 1, extra: { exitCode: 2 } })
    expect(bubbles[0].label).toMatch(/⚠️.*codex/)
  })

  it('classifies Notification+error-keyword as Error', () => {
    router.handle({ event: 'Notification', tool: 'claude', cwd: '/x', ts: 1, extra: { message: 'fatal failed' } })
    expect(bubbles[0].label).toMatch(/⚠️.*claude/)
  })

  it('debounces same (tool,event,cwd) within 10s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-23T12:00:00Z'))
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 2 })
    expect(bubbles).toHaveLength(1)
    vi.setSystemTime(new Date('2026-05-23T12:00:11Z'))
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/x', ts: 3 })
    expect(bubbles).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not debounce different cwd', () => {
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/a', ts: 1 })
    router.handle({ event: 'Stop', tool: 'claude', cwd: '/b', ts: 2 })
    expect(bubbles).toHaveLength(2)
  })

  it('keeps a recent-events ring buffer (max 20, newest first)', () => {
    for (let i = 0; i < 25; i++) {
      router.handle({ event: 'Stop', tool: 'codex', cwd: `/x${i}`, ts: i })
    }
    const recent = router.recent()
    expect(recent).toHaveLength(20)
    expect(recent[0].cwd).toBe('/x24')
    expect(recent[19].cwd).toBe('/x5')
  })

  it('records SessionStart in recent buffer even though it does not bubble', () => {
    router.handle({ event: 'SessionStart', tool: 'claude', cwd: '/x', ts: 1 })
    expect(router.recent()).toHaveLength(1)
    expect(bubbles).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/event-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

`electron/event-router.ts`：

```ts
import type { NotifyEvent, NotifyEventName, NotifyToolName } from '@shared/types'

const DEBOUNCE_MS = 10_000
const RECENT_MAX  = 20
const ERROR_RX    = /\b(error|failed|fatal|exception|panic)\b/i

interface RouterDeps {
  showBubble: (label: string, source: string) => void
}

interface TemplateKey { event: NotifyEventName; tool: NotifyToolName | '*' }

const TEMPLATES: Array<{ key: TemplateKey; render: (ev: NotifyEvent) => string | null }> = [
  { key: { event: 'SessionStart', tool: '*' },     render: () => null /* never bubble */ },
  { key: { event: 'Error',        tool: '*' },     render: ev => `⚠️ ${ev.tool} 报错了` },
  { key: { event: 'Stop',         tool: 'claude' }, render: () => 'Claude 跑完啦，回来看看吧～' },
  { key: { event: 'Stop',         tool: 'codex' },  render: () => 'Codex 完成了～' },
  { key: { event: 'Stop',         tool: 'test' },   render: () => '✓ 测试事件已收到' },
  { key: { event: 'Notification', tool: 'claude' }, render: () => 'Claude 在叫你（可能要 y/n）' },
  { key: { event: 'Notification', tool: 'codex' },  render: () => 'Codex 在叫你' },
  { key: { event: 'PermissionRequest', tool: '*' }, render: ev => `${ev.tool} 等你授权` },
]

export class EventRouter {
  private lastSent  = new Map<string, number>()
  private recentBuf: NotifyEvent[] = []

  constructor(private deps: RouterDeps) {}

  handle(ev: NotifyEvent): void {
    // Push into recent buffer (newest first) regardless of bubbling.
    this.recentBuf.unshift(ev)
    if (this.recentBuf.length > RECENT_MAX) this.recentBuf.length = RECENT_MAX

    const effective = this.classify(ev)

    const tpl = TEMPLATES.find(t =>
      t.key.event === effective.event &&
      (t.key.tool === '*' || t.key.tool === effective.tool)
    )
    if (!tpl) return
    const label = tpl.render(effective)
    if (label === null) return  // SessionStart etc.

    const key = `${effective.tool}|${effective.event}|${effective.cwd}`
    const now = Date.now()
    const last = this.lastSent.get(key) ?? 0
    if (now - last < DEBOUNCE_MS) return
    this.lastSent.set(key, now)

    this.deps.showBubble(label, `notify:${effective.tool}`)
  }

  recent(): NotifyEvent[] { return [...this.recentBuf] }

  private classify(ev: NotifyEvent): NotifyEvent {
    if (ev.event === 'Stop' && typeof ev.extra?.exitCode === 'number' && ev.extra.exitCode !== 0) {
      return { ...ev, event: 'Error' }
    }
    if (ev.event === 'Notification' && typeof ev.extra?.message === 'string' && ERROR_RX.test(ev.extra.message)) {
      return { ...ev, event: 'Error' }
    }
    return ev
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/event-router.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add electron/event-router.ts tests/event-router.test.ts
git commit -m "feat(notify): EventRouter with debounce, templates, error classification"
```

---

## Task 5: HookInstaller — Claude Code (JSON merge)

**Files:**
- Create: `electron/hook-installer.ts`
- Create: `tests/hook-installer.test.ts`

- [ ] **Step 1: 写失败测试（仅 Claude 部分）**

`tests/hook-installer.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { installClaudeHooks, uninstallClaudeHooks, getClaudeStatus } from '../electron/hook-installer'

const WRAPPER = '$HOME/.mote/bin/event'

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-hi-')) }

describe('hook-installer · Claude', () => {
  let dir: string
  let settings: string

  beforeEach(() => { dir = tmpDir(); settings = path.join(dir, 'settings.json') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('installs into empty (non-existent) settings.json with 4 events', () => {
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const eventNames = Object.keys(json.hooks).sort()
    expect(eventNames).toEqual(['Notification', 'SessionStart', 'Stop'].sort())
    for (const name of eventNames) {
      const cmd = json.hooks[name][0].hooks[0].command
      expect(cmd).toContain(WRAPPER)
      expect(cmd).toContain(name)
    }
  })

  it('creates a backup of existing settings.json before merging', () => {
    fs.writeFileSync(settings, JSON.stringify({ apiKey: 'foo', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }))
    installClaudeHooks(settings, WRAPPER)
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('settings.json.mote-backup-'))
    expect(backups.length).toBe(1)
    const backupJson = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'))
    expect(backupJson.apiKey).toBe('foo')
  })

  it('preserves existing non-mote hook entries when merging', () => {
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-thing' }] }] }
    }))
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(stopCmds).toContain('echo user-thing')
    expect(stopCmds.some((c: string) => c.includes(WRAPPER))).toBe(true)
  })

  it('is idempotent (re-install does not add a duplicate mote entry)', () => {
    installClaudeHooks(settings, WRAPPER)
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    const moteCount = stopCmds.filter((c: string) => c.includes(WRAPPER)).length
    expect(moteCount).toBe(1)
  })

  it('uninstall removes only mote entries; keeps user entries; cleans empty arrays', () => {
    fs.writeFileSync(settings, JSON.stringify({
      apiKey: 'keep',
      hooks: {
        Stop:         [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        Notification: []
      }
    }))
    installClaudeHooks(settings, WRAPPER)
    uninstallClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    expect(json.apiKey).toBe('keep')
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(stopCmds).toEqual(['echo user'])
    // Notification had no user entries → key may be removed
    expect(json.hooks.Notification).toBeUndefined()
  })

  it('uninstall drops `hooks` key entirely when no user entries remain', () => {
    installClaudeHooks(settings, WRAPPER)
    uninstallClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    expect(json.hooks).toBeUndefined()
  })

  it('throws on malformed JSON without writing anything', () => {
    fs.writeFileSync(settings, '{ not valid json')
    expect(() => installClaudeHooks(settings, WRAPPER)).toThrow(/parse|JSON/i)
    expect(fs.readFileSync(settings, 'utf-8')).toBe('{ not valid json')
  })

  it('getClaudeStatus reports installed=false on missing file', () => {
    expect(getClaudeStatus(settings, WRAPPER).installed).toBe(false)
  })

  it('getClaudeStatus reports installed=true and eventCount=3 after install', () => {
    installClaudeHooks(settings, WRAPPER)
    const s = getClaudeStatus(settings, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/hook-installer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现（Claude 部分）**

`electron/hook-installer.ts`（先只写 Claude 部分，Codex 留给 Task 6）：

```ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HookInstallStatus } from '@shared/types'

const CLAUDE_EVENTS = ['Stop', 'Notification', 'SessionStart'] as const
type ClaudeEvent = typeof CLAUDE_EVENTS[number]

interface ClaudeHookCmd {
  type:    'command'
  command: string
}

interface ClaudeHookGroup {
  matcher?: string
  hooks:    ClaudeHookCmd[]
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookGroup[]>>
  [k: string]: unknown
}

function readJson(file: string): ClaudeSettings {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf-8')
  try { return JSON.parse(text) as ClaudeSettings }
  catch (err) { throw new Error(`Cannot parse JSON ${file}: ${(err as Error).message}`) }
}

function writeJsonAtomic(file: string, data: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.mote-backup-${stamp}`
  fs.copyFileSync(file, dest)
}

function buildClaudeCmd(wrapper: string, event: ClaudeEvent): ClaudeHookGroup {
  return {
    hooks: [{ type: 'command', command: `${wrapper} ${event} claude` }]
  }
}

function isMoteCmd(cmd: string, wrapper: string): boolean {
  return cmd.includes(wrapper)
}

export function installClaudeHooks(settingsFile: string, wrapper: string): void {
  const json = readJson(settingsFile)
  backup(settingsFile)
  json.hooks ??= {}
  for (const ev of CLAUDE_EVENTS) {
    const existing = (json.hooks[ev] ?? []) as ClaudeHookGroup[]
    const alreadyHasMote = existing.some(g =>
      g.hooks?.some(h => isMoteCmd(h.command, wrapper))
    )
    if (alreadyHasMote) continue
    json.hooks[ev] = [...existing, buildClaudeCmd(wrapper, ev)]
  }
  writeJsonAtomic(settingsFile, json)
}

export function uninstallClaudeHooks(settingsFile: string, wrapper: string): void {
  if (!fs.existsSync(settingsFile)) return
  const json = readJson(settingsFile)
  if (!json.hooks) return
  for (const ev of Object.keys(json.hooks)) {
    const groups = (json.hooks[ev] ?? []) as ClaudeHookGroup[]
    const filtered = groups
      .map(g => ({ ...g, hooks: g.hooks.filter(h => !isMoteCmd(h.command, wrapper)) }))
      .filter(g => g.hooks.length > 0)
    if (filtered.length === 0) delete json.hooks[ev]
    else json.hooks[ev] = filtered
  }
  if (Object.keys(json.hooks).length === 0) delete json.hooks
  writeJsonAtomic(settingsFile, json)
}

export function getClaudeStatus(settingsFile: string, wrapper: string): HookInstallStatus {
  const base: HookInstallStatus = {
    tool: 'claude',
    configPath: settingsFile,
    installed: false,
    eventCount: 0
  }
  if (!fs.existsSync(settingsFile)) return base
  let json: ClaudeSettings
  try { json = readJson(settingsFile) } catch { return base }
  let count = 0
  for (const ev of Object.keys(json.hooks ?? {})) {
    const groups = (json.hooks?.[ev] ?? []) as ClaudeHookGroup[]
    for (const g of groups) {
      if (g.hooks?.some(h => isMoteCmd(h.command, wrapper))) count++
    }
  }
  const dir = path.dirname(settingsFile)
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.startsWith(path.basename(settingsFile) + '.mote-backup-'))
    : []
  const latest = backups.sort().pop()
  return {
    ...base,
    installed: count > 0,
    eventCount: count,
    installedAt: latest?.replace(path.basename(settingsFile) + '.mote-backup-', '')
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/hook-installer.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add electron/hook-installer.ts tests/hook-installer.test.ts
git commit -m "feat(notify): Claude Code hook install/uninstall/status with merge + backup"
```

---

## Task 6: HookInstaller — Codex (block-marker TOML)

**Files:**
- Modify: `electron/hook-installer.ts`
- Modify: `tests/hook-installer.test.ts`

- [ ] **Step 1: 加 Codex 部分测试**

在 `tests/hook-installer.test.ts` 末尾追加：

```ts
import { installCodexHooks, uninstallCodexHooks, getCodexStatus } from '../electron/hook-installer'

const BEGIN_MARK = '# >>> mote-managed (do not edit) >>>'
const END_MARK   = '# <<< mote-managed <<<'

describe('hook-installer · Codex', () => {
  let dir: string
  let cfg: string

  beforeEach(() => { dir = tmpDir(); cfg = path.join(dir, 'config.toml') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('installs into non-existent config.toml with marker block', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain(BEGIN_MARK)
    expect(body).toContain(END_MARK)
    expect(body).toContain('[[hooks.Stop]]')
    expect(body).toContain('[[hooks.PermissionRequest]]')
    expect(body).toContain('[[hooks.SessionStart]]')
    expect(body).toContain(`${WRAPPER} Stop codex`)
  })

  it('uses notify-only block when degraded=true', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: true })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).not.toContain('[[hooks.')
    expect(body).toContain('notify = ["sh", "-c"')
    expect(body).toContain(`${WRAPPER} Stop codex`)
  })

  it('preserves existing user content before/after marker block', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n[providers.openai]\napi_key = "x"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain('model = "gpt-5"')
    expect(body).toContain('api_key = "x"')
    expect(body).toContain(BEGIN_MARK)
  })

  it('is idempotent — second install replaces the marker block, no duplication', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body.match(/>>> mote-managed/g)?.length).toBe(1)
    expect(body.match(/<<< mote-managed/g)?.length).toBe(1)
  })

  it('creates backup before modifying existing file', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('config.toml.mote-backup-'))
    expect(backups.length).toBe(1)
  })

  it('uninstall removes marker block, leaves user content intact', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    uninstallCodexHooks(cfg, WRAPPER)
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain('model = "gpt-5"')
    expect(body).not.toContain(BEGIN_MARK)
    expect(body).not.toContain('mote/bin/event')
  })

  it('uninstall on file without marker block is no-op (safe)', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    expect(() => uninstallCodexHooks(cfg, WRAPPER)).not.toThrow()
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('getCodexStatus reports installed=true after install with eventCount=3 (non-degraded)', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const s = getCodexStatus(cfg, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(3)
    expect(s.degraded).toBe(false)
  })

  it('getCodexStatus reports degraded=true and eventCount=1 in notify mode', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: true })
    const s = getCodexStatus(cfg, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(1)
    expect(s.degraded).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/hook-installer.test.ts -t 'Codex'`
Expected: FAIL — exports not defined

- [ ] **Step 3: 加 Codex 实现到 `electron/hook-installer.ts`**

在 `electron/hook-installer.ts` 末尾追加：

```ts
// ─── Codex (block-marker TOML) ───
//
// We use marker comments rather than a TOML library so we don't need a new
// dependency AND we never touch user formatting/comments outside our block.

const BEGIN_MARK = '# >>> mote-managed (do not edit) >>>'
const END_MARK   = '# <<< mote-managed <<<'

interface CodexInstallOpts { degraded: boolean }

function buildCodexBlock(wrapper: string, opts: CodexInstallOpts): string {
  if (opts.degraded) {
    return [
      BEGIN_MARK,
      `notify = ["sh", "-c", "${wrapper} Stop codex"]`,
      END_MARK,
      ''
    ].join('\n')
  }
  const evs = ['Stop', 'PermissionRequest', 'SessionStart'] as const
  const tables = evs.map(ev =>
    `[[hooks.${ev}]]\nhooks = [{ command = "${wrapper} ${ev} codex" }]`
  ).join('\n\n')
  return `${BEGIN_MARK}\n${tables}\n${END_MARK}\n`
}

function stripMarkerBlock(text: string): string {
  const begin = text.indexOf(BEGIN_MARK)
  if (begin < 0) return text
  const endStart = text.indexOf(END_MARK, begin)
  if (endStart < 0) return text  // malformed — leave alone
  const endLineEnd = text.indexOf('\n', endStart)
  const cutEnd = endLineEnd < 0 ? text.length : endLineEnd + 1
  // Also eat one preceding newline if block started on its own line.
  let cutStart = begin
  if (cutStart > 0 && text[cutStart - 1] === '\n') cutStart -= 1
  return text.slice(0, cutStart) + text.slice(cutEnd)
}

function writeTextAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

export function installCodexHooks(configFile: string, wrapper: string, opts: CodexInstallOpts): void {
  let existing = ''
  if (fs.existsSync(configFile)) {
    existing = fs.readFileSync(configFile, 'utf-8')
    backup(configFile)
  }
  // Remove any prior mote block, then append fresh one.
  const cleaned = stripMarkerBlock(existing)
  const sep = cleaned.length === 0 || cleaned.endsWith('\n') ? '' : '\n'
  const next = cleaned + sep + buildCodexBlock(wrapper, opts)
  writeTextAtomic(configFile, next)
}

export function uninstallCodexHooks(configFile: string, wrapper: string): void {
  if (!fs.existsSync(configFile)) return
  const existing = fs.readFileSync(configFile, 'utf-8')
  const stripped = stripMarkerBlock(existing)
  if (stripped === existing) return  // nothing to do
  writeTextAtomic(configFile, stripped)
  // wrapper arg unused but kept symmetric with Claude API.
  void wrapper
}

export function getCodexStatus(configFile: string, wrapper: string): HookInstallStatus {
  const base: HookInstallStatus = {
    tool: 'codex',
    configPath: configFile,
    installed: false,
    eventCount: 0
  }
  if (!fs.existsSync(configFile)) return base
  const text = fs.readFileSync(configFile, 'utf-8')
  const beg = text.indexOf(BEGIN_MARK)
  const end = text.indexOf(END_MARK)
  if (beg < 0 || end < 0) return base
  const block = text.slice(beg, end)
  const degraded = block.includes('notify =') && !block.includes('[[hooks.')
  const eventCount = degraded
    ? 1
    : (block.match(/\[\[hooks\./g)?.length ?? 0)
  const dir = path.dirname(configFile)
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.startsWith(path.basename(configFile) + '.mote-backup-'))
    : []
  const latest = backups.sort().pop()
  return {
    ...base,
    installed: eventCount > 0,
    eventCount,
    degraded,
    installedAt: latest?.replace(path.basename(configFile) + '.mote-backup-', '')
  }
  void wrapper
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/hook-installer.test.ts`
Expected: 18 passed (9 Claude + 9 Codex)

- [ ] **Step 5: Commit**

```bash
git add electron/hook-installer.ts tests/hook-installer.test.ts
git commit -m "feat(notify): Codex hook install via block-marker (no TOML lib needed)"
```

---

## Task 7: 主进程接线 — server + router + runtime + 生命周期

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: 在 `main.ts` 顶部 import 新模块**

替换 `electron/main.ts` 顶部的 import 块（在 `import { NotificationWatcher } from './notifications'` 这一行下面追加）：

```ts
import { RuntimeState }      from './runtime-state'
import { LocalEventServer }  from './event-server'
import { EventRouter }       from './event-router'
```

- [ ] **Step 2: 在 `app.whenReady()` 块里实例化并启动**

在 `electron/main.ts` 的 `const watcher = new CliWatcher(ai)` 这行后面追加：

```ts
    const runtimeState = new RuntimeState()
    const eventRouter  = new EventRouter({
      showBubble: (label, source) => wm.showBubble({ source: 'watcher', label, timestamp: Date.now() })
    })
    const eventServer = new LocalEventServer(ev => eventRouter.handle(ev))
```

在现有 `wm.createFloat()` 之前（与其他启动代码并列）插入：

```ts
    // Start local event server + write runtime state for wrapper script to discover.
    try {
      runtimeState.ensureWrapper()
      const { port, token } = await eventServer.start()
      runtimeState.write({ port, token })
      console.log(`[main] event server listening on 127.0.0.1:${port}`)
    } catch (err) {
      console.error('[main] event server failed to start:', err)
      // Continue — bubbles just won't fire from CLI hooks. App still usable.
    }
```

- [ ] **Step 3: 注册 before-quit cleanup**

在 `electron/main.ts` 末尾的 `app.on('before-quit', () => { ... })` 块里写：

```ts
app.on('before-quit', () => {
  runtimeStateRef?.clear()
  eventServerRef?.stop().catch(() => { /* ignore */ })
})
```

并在 `let wm: WindowManager` 下面加：

```ts
let runtimeStateRef: RuntimeState | null = null
let eventServerRef:  LocalEventServer | null = null
```

在实例化后赋值：

```ts
    runtimeStateRef = runtimeState
    eventServerRef  = eventServer
```

> **注意：** 不在本任务里改 `registerIpcHandlers` 调用 — 新依赖（eventRouter/eventServer/runtimeState）等 Task 8 一起加进去。本任务只把它们实例化、启动、cleanup 接好。

- [ ] **Step 4: 编译并手动启动 app 看是否能起来**

Run: `npm run dev`
Expected:
- 控制台打印 `[main] event server listening on 127.0.0.1:39127`（或附近端口）
- App 正常出现
- `cat ~/.mote/runtime.json` 能看到 port、token、pid、started_at
- `ls -la ~/.mote/bin/event` 看到脚本，mode 是 `-rwxr-xr-x`

按 Ctrl-C 关掉 app 后：
- `cat ~/.mote/runtime.json` 报"No such file"

- [ ] **Step 5: 手动端到端验证一次链路**

App 跑着的时候，新开终端：

```bash
~/.mote/bin/event Stop test
```

Expected: 宠物头上立刻弹出气泡"✓ 测试事件已收到"。

如果没出现，看 app 控制台日志（应该能看到 router 处理消息），以及检查 `wm.showBubble` 的逻辑。

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(notify): wire event server + router + runtime state into main process"
```

---

## Task 8: IPC handlers + 暴露给 settings 渲染进程

**Files:**
- Modify: `electron/ipc.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: 扩 `registerIpcHandlers` 的 deps 类型**

修改 `electron/ipc.ts` 头部 import 区，加：

```ts
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import type { EventRouter } from './event-router'
import type { LocalEventServer } from './event-server'
import type { RuntimeState } from './runtime-state'
import {
  installClaudeHooks, uninstallClaudeHooks, getClaudeStatus,
  installCodexHooks, uninstallCodexHooks, getCodexStatus
} from './hook-installer'
import type { HookInstallStatus, NotifyEvent, RuntimeInfo } from '@shared/types'
```

把 deps 接口加 3 个字段：

```ts
  eventRouter:  EventRouter
  eventServer:  LocalEventServer
  runtimeState: RuntimeState
```

并在解构那一行加入它们：

```ts
  const { wm, pets, chars, ai, runner, cleanup, memory, watcher, getStats, eventRouter, eventServer, runtimeState } = deps
```

- [ ] **Step 2: 在 `event-server.ts` 加公开 getter（IPC 需要拿 port/token）**

在 `electron/event-server.ts` 的 class 里，在 `readonly boundAddress = '127.0.0.1'` 这行旁边加：

```ts
  get currentPort():  number { return this.port }
  get currentToken(): string { return this.token }
```

- [ ] **Step 3: 加 6 个新 IPC handler**

在 `electron/ipc.ts` 末尾（在 `ipcMain.handle('character:save-api-key', ...)` 之后）追加：

```ts
  // ─── Notify hooks ───
  const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
  const codexConfig    = path.join(os.homedir(), '.codex',  'config.toml')
  const wrapper        = runtimeState.wrapperPath

  ipcMain.handle(IPC.NOTIFY_HOOK_GET_STATUS, (): HookInstallStatus[] => {
    return [
      getClaudeStatus(claudeSettings, wrapper),
      getCodexStatus(codexConfig, wrapper)
    ]
  })

  ipcMain.handle(IPC.NOTIFY_HOOK_INSTALL, async (_, tool: 'claude' | 'codex' | 'both') => {
    if (tool === 'claude' || tool === 'both') installClaudeHooks(claudeSettings, wrapper)
    if (tool === 'codex'  || tool === 'both') {
      // v1: always install non-degraded; the `codex --version` reactive check is a
      // future enhancement (spec §4.3). Users on too-old codex can manually uninstall + nothing breaks.
      installCodexHooks(codexConfig, wrapper, { degraded: false })
    }
  })

  ipcMain.handle(IPC.NOTIFY_HOOK_UNINSTALL, async (_, tool: 'claude' | 'codex' | 'both') => {
    if (tool === 'claude' || tool === 'both') uninstallClaudeHooks(claudeSettings, wrapper)
    if (tool === 'codex'  || tool === 'both') uninstallCodexHooks(codexConfig, wrapper)
  })

  ipcMain.handle(IPC.NOTIFY_TEST_EVENT, async () => {
    // POST to our own server so the full pipeline (server → router → bubble) is exercised.
    const body = JSON.stringify({ event: 'Stop', tool: 'test', cwd: process.cwd(), ts: Math.floor(Date.now() / 1000) })
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: eventServer.boundAddress,
        port:     eventServer.currentPort,
        path:     '/event/mote',
        method:   'POST',
        headers:  { 'X-Mote-Token': eventServer.currentToken, 'Content-Type': 'application/json' }
      }, res => { res.resume(); res.on('end', () => resolve()) })
      req.on('error', reject)
      req.write(body); req.end()
    })
  })

  ipcMain.handle(IPC.NOTIFY_RECENT_EVENTS, (): NotifyEvent[] => eventRouter.recent())

  ipcMain.handle(IPC.NOTIFY_RUNTIME_INFO, (): RuntimeInfo => {
    const t = eventServer.currentToken
    const masked = t.length > 8 ? `${t.slice(0, 4)}${'•'.repeat(t.length - 8)}${t.slice(-4)}` : '••••••••'
    return { port: eventServer.currentPort, tokenMasked: masked, wrapperPath: wrapper }
  })
```

- [ ] **Step 4: 在 `main.ts` 把新依赖传给 `registerIpcHandlers`**

修改 `electron/main.ts` 里 `registerIpcHandlers({ ... })` 调用，加：

```ts
      wm, pets, chars, ai, runner, cleanup, monitor, memory, watcher,
      getStats: () => latestStats,
      eventRouter, eventServer, runtimeState
```

- [ ] **Step 5: 编译并启动 app，手动验证 IPC 不报错**

Run: `npm run dev`

打开开发者工具的 console（在面板上右键 → 开发者工具），跑：

```js
await window.ipc.invoke('notify:hook:get-status')
// → [{tool:'claude',installed:false,...}, {tool:'codex',installed:false,...}]

await window.ipc.invoke('notify:runtime-info')
// → {port:39127, tokenMasked:"rndA••••••AbCd", wrapperPath:"/Users/.../.mote/bin/event"}

await window.ipc.invoke('notify:test-event')
// → undefined; 同时宠物应该弹气泡
```

- [ ] **Step 6: Commit**

```bash
git add electron/ipc.ts electron/event-server.ts electron/main.ts
git commit -m "feat(notify): IPC handlers for hook status, install, uninstall, test, recent, runtime"
```

---

## Task 9: 设置页 "提醒" tab UI

**Files:**
- Create: `src/settings/NotifyTab.tsx`
- Modify: `src/settings/App.tsx`

- [ ] **Step 1: 创建 `NotifyTab.tsx`**

`src/settings/NotifyTab.tsx`：

```tsx
import { useEffect, useState, useCallback } from 'react'
import { IPC } from '@shared/types'
import type { HookInstallStatus, NotifyEvent, RuntimeInfo } from '@shared/types'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      on:     (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

export function NotifyTab() {
  const [statuses, setStatuses] = useState<HookInstallStatus[]>([])
  const [recent,   setRecent]   = useState<NotifyEvent[]>([])
  const [rt,       setRt]       = useState<RuntimeInfo | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [advanced, setAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    const [s, r, i] = await Promise.all([
      window.ipc.invoke(IPC.NOTIFY_HOOK_GET_STATUS) as Promise<HookInstallStatus[]>,
      window.ipc.invoke(IPC.NOTIFY_RECENT_EVENTS)    as Promise<NotifyEvent[]>,
      window.ipc.invoke(IPC.NOTIFY_RUNTIME_INFO)     as Promise<RuntimeInfo>,
    ])
    setStatuses(s); setRecent(r); setRt(i)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleInstall = async (tool: 'claude' | 'codex') => {
    if (!confirm(`即将往 ${statuses.find(s => s.tool === tool)?.configPath} 写入 hook 配置（先备份）。继续？`)) return
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_HOOK_INSTALL, tool); await refresh() }
    catch (err) { alert(`安装失败：${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  const handleUninstall = async (tool: 'claude' | 'codex') => {
    if (!confirm(`即将从 ${statuses.find(s => s.tool === tool)?.configPath} 移除所有 Mote 加的 hook。继续？`)) return
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_HOOK_UNINSTALL, tool); await refresh() }
    catch (err) { alert(`卸载失败：${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  const handleTest = async () => {
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_TEST_EVENT); setTimeout(refresh, 500) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>提醒</h2>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>Hook 状态</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {statuses.map(s => (
            <div key={s.tool} style={{
              padding: 14, border: '0.5px solid var(--hairline)', borderRadius: 12,
              display: 'flex', alignItems: 'center', gap: 12, background: 'var(--elev)'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.tool === 'claude' ? 'Claude Code' : 'Codex CLI'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                  {s.installed
                    ? `✓ 已安装 · ${s.eventCount} 个事件${s.degraded ? ' · ⚠ 降级到 notify（无法区分事件类型）' : ''}`
                    : '⚠ 未安装'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                  {s.configPath}
                </div>
              </div>
              {s.installed
                ? <>
                    <button disabled={busy} onClick={() => handleInstall(s.tool)} style={btn()}>重装</button>
                    <button disabled={busy} onClick={() => handleUninstall(s.tool)} style={btn('danger')}>卸载</button>
                  </>
                : <button disabled={busy} onClick={() => handleInstall(s.tool)} style={btn('primary')}>安装</button>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <button onClick={handleTest} disabled={busy} style={{ ...btn('primary'), width: '100%' }}>
          🧪 测试：触发一条 Stop 事件（应看到宠物冒泡）
        </button>
      </section>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>
          最近事件 · 仅本次会话 ({recent.length}/20)
        </h3>
        <div style={{ border: '0.5px solid var(--hairline)', borderRadius: 12, background: 'var(--elev)', maxHeight: 200, overflowY: 'auto' }}>
          {recent.length === 0
            ? <div style={{ padding: 14, fontSize: 11, color: 'var(--text-3)' }}>暂无事件</div>
            : recent.map((e, i) => (
              <div key={i} style={{
                padding: '8px 12px', fontSize: 11, fontFamily: 'var(--font-mono)',
                borderBottom: i < recent.length - 1 ? '0.5px solid var(--separator)' : 'none',
                display: 'grid', gridTemplateColumns: '90px 110px 60px 1fr', gap: 8
              }}>
                <span style={{ color: 'var(--text-3)' }}>{new Date(e.ts * 1000).toLocaleTimeString()}</span>
                <span style={{ color: 'var(--text)' }}>{e.event}</span>
                <span style={{ color: 'var(--accent)' }}>{e.tool}</span>
                <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.cwd}</span>
              </div>
            ))}
        </div>
      </section>

      <section>
        <button onClick={() => setAdvanced(!advanced)} style={{ ...btn(), padding: '4px 8px', fontSize: 11 }}>
          {advanced ? '▾ 运行时（高级）' : '▸ 运行时（高级）'}
        </button>
        {advanced && rt && (
          <div style={{
            marginTop: 8, padding: 12, border: '0.5px solid var(--hairline)', borderRadius: 12,
            background: 'var(--elev)', fontSize: 11, fontFamily: 'var(--font-mono)',
            display: 'grid', gridTemplateColumns: '80px 1fr', gap: 6
          }}>
            <span style={{ color: 'var(--text-3)' }}>端口</span><span>{rt.port}</span>
            <span style={{ color: 'var(--text-3)' }}>Token</span><span>{rt.tokenMasked}</span>
            <span style={{ color: 'var(--text-3)' }}>脚本</span><span>{rt.wrapperPath}</span>
          </div>
        )}
      </section>
    </div>
  )
}

function btn(variant: 'primary' | 'danger' | 'default' = 'default'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', border: '0.5px solid var(--hairline)', whiteSpace: 'nowrap'
  }
  if (variant === 'primary') return { ...base, background: 'var(--accent)', color: 'var(--text-on-accent)', borderColor: 'var(--accent)' }
  if (variant === 'danger')  return { ...base, background: 'transparent', color: 'var(--bad)', borderColor: 'var(--bad)' }
  return { ...base, background: 'var(--elev)', color: 'var(--text)' }
}
```

- [ ] **Step 2: 在 `src/settings/App.tsx` 注册 tab**

修改 `src/settings/App.tsx`：

第 1 行加 import：

```tsx
import { NotifyTab } from './NotifyTab'
```

第 7 行类型扩成：

```tsx
type Tab = 'pets' | 'character' | 'api' | 'cleanup' | 'notify'
```

`TAB_DEFS` 数组加一项（放在 cleanup 前更合适）：

```tsx
{ id: 'notify', label: '提醒', subtitle: 'Notify', icon: 'M8 1.5l1.5 4.5L14 6l-3.5 3 1.5 5L8 11.5 4 14l1.5-5L2 6l4.5-.5z' },
```

content 渲染区追加：

```tsx
{tab === 'notify' && <NotifyTab />}
```

- [ ] **Step 3: 启动 app，手动验证**

Run: `npm run dev`

- 点设置 → 左侧应出现"提醒" tab
- 点进去看到两张 Hook 卡片，都是"未安装"
- 点 Claude 的"安装"按钮 → 弹 confirm → 同意后状态变成"✓ 已安装"
- `cat ~/.claude/settings.json` 看到 hooks 块
- 点"测试"按钮 → 宠物头上弹气泡"✓ 测试事件已收到"
- 再回到提醒 tab → "最近事件"列表里有一条 `Stop test`
- 展开"运行时（高级）" → 看到端口、tokenMasked、wrapper 路径
- 点 Claude 的"卸载"→ confirm → 状态回到"未安装"，`settings.json` 里 hooks 块被清掉

- [ ] **Step 4: Commit**

```bash
git add src/settings/NotifyTab.tsx src/settings/App.tsx
git commit -m "feat(notify): settings UI tab with install/uninstall/test/recent/runtime"
```

---

## Task 10: 首启动引导

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: 在 `app.whenReady()` 末尾加首启动检测**

在 `electron/main.ts` 找到 `wm.createBubble()` 那一段后面追加：

```ts
    // First-launch hook install nudge: if neither tool is hooked, prompt once.
    try {
      const { getClaudeStatus, getCodexStatus } = await import('./hook-installer')
      const claudePath = path.join(app.getPath('home'), '.claude', 'settings.json')
      const codexPath  = path.join(app.getPath('home'), '.codex',  'config.toml')
      const cs = getClaudeStatus(claudePath, runtimeState.wrapperPath)
      const xs = getCodexStatus(codexPath, runtimeState.wrapperPath)
      if (!cs.installed && !xs.installed) {
        // Defer a bit so the float window is on screen first.
        setTimeout(() => {
          wm.showBubble({
            source: 'watcher',
            label: '点设置 → 提醒，让我帮你盯 claude/codex',
            timestamp: Date.now()
          })
        }, 3000)
      }
    } catch (err) {
      console.error('[main] first-launch check failed:', err)
    }
```

- [ ] **Step 2: 验证**

清掉 hook 文件做"全新装"模拟：

```bash
rm -f ~/.claude/settings.json ~/.codex/config.toml  # ⚠️ 仅测试时；自己设置过的话先备份
```

重启 app：

```bash
npm run dev
```

Expected: app 启动约 3 秒后，宠物头上弹气泡"点设置 → 提醒，让我帮你盯 claude/codex"。

装上后再重启 → 不再提示。

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat(notify): first-launch bubble nudge when no hooks installed"
```

---

## Task 11: 端到端验收 — 真的跑 claude/codex

**Files:** 无代码变更，仅运行 + 文档化

- [ ] **Step 1: 安装到自己的 Claude Code**

App 跑着：

```bash
# 先看现状（如果之前装过别的 hook，留意一下）
cat ~/.claude/settings.json
```

去 Mote → 设置 → 提醒 → 点 Claude 的"安装"，同意 confirm。

```bash
cat ~/.claude/settings.json   # 应能看到 hooks.Stop / hooks.Notification / hooks.SessionStart 三块
ls ~/.claude/                 # 应有 settings.json.mote-backup-<ts>
```

- [ ] **Step 2: 真跑一次 claude 任务**

新开终端：

```bash
cd /tmp
mkdir mote-test && cd mote-test
claude --print "echo hello world > out.txt"
```

Expected: claude 跑完后约 1 秒内，宠物头上弹气泡"Claude 跑完啦，回来看看吧～"。

- [ ] **Step 3: 装 Codex 并跑一次**

设置 → 提醒 → Codex "安装"。

```bash
codex --print "echo from codex" 2>/dev/null   # 或其他无害命令
```

Expected: codex 退出后宠物弹"Codex 完成了～"。

- [ ] **Step 4: app 没开时不卡用户终端**

退出 Mote。

```bash
claude --print "echo still works"
```

Expected: claude 正常跑完，不卡、不报 hook 错误。

重新打开 Mote → 再次跑 claude → 又能正常弹气泡。

- [ ] **Step 5: 卸载验证清干净**

设置 → 提醒 → Claude "卸载"、Codex "卸载"。

```bash
jq . ~/.claude/settings.json   # 应仍合法 JSON，无 .mote/bin/event 引用
cat ~/.codex/config.toml       # 无 ">>> mote-managed" 段
grep -r ".mote/bin/event" ~/.claude ~/.codex   # 应无输出
```

- [ ] **Step 6: 跑全部测试**

```bash
npm test
```

Expected: 全绿。新增 5 个 test 文件（runtime-state, event-server, event-router, hook-installer × 2 描述块），加旧的 6 个共 11 个文件全过。

- [ ] **Step 7: 把验证结果写进 PR/commit 描述**

记下"已通过验收"的事实即可，不要新建文档。

```bash
git commit --allow-empty -m "chore(notify): manual end-to-end verification passed"
```

---

## 后续（不在本计划范围）

如真用一周后发现这些问题，再各自单独立计划：

1. Claude/Codex 进程崩溃兜底（transcript 文件监听）
2. AI 包装宠物口吻的提醒文案
3. 静音时段 / 按事件类型禁用 / 自定义模板
4. `codex --version` 反应式降级（替代 v1 的"总是非降级安装"）
5. 系统健康、专注行为等 spec §2 已排除的看门场景
