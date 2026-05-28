# 桌面宠物 AI 代理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个跨平台（macOS + Windows）Electron 桌面宠物 App，宠物悬浮在所有窗口之上，支持系统监控、AI 对话（Claude / OpenAI 协议）、调用本地 Claude Code CLI 和 Codex CLI 执行任务。

**Architecture:** 三个 Electron BrowserWindow（浮窗 / 面板 / 设置），主进程托管 SystemMonitor、PetManager、AiEngine、CliRunner、CleanupEngine，通过 IPC 与渲染层通信。宠物使用 spritesheet.webp + pet.json 格式（与 Codex 兼容）。

**Tech Stack:** Electron 28+, electron-vite, React 18, TypeScript, systeminformation, anthropic SDK, openai SDK, keytar, vitest

---

## 文件结构

```
pet-monitor-app/
├── package.json
├── electron-vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── electron/
│   ├── main.ts           # App 入口，生命周期
│   ├── windows.ts        # 三个窗口的创建与管理
│   ├── monitor.ts        # SystemMonitor（systeminformation 轮询）
│   ├── pets.ts           # PetManager（读取 pet.json，复制内置宠物）
│   ├── character.ts      # CharacterConfig（角色 JSON + keytar API Key）
│   ├── ai.ts             # AiEngine（Claude + OpenAI，function calling）
│   ├── runner.ts         # CliRunner（spawn claude/codex，队列，超时）
│   ├── cleanup.ts        # CleanupEngine（扫描缓存，删除）
│   └── ipc.ts            # 所有 IPC handle/on 注册
├── src-shared/
│   └── types.ts          # 主进程与渲染层共享的 TS 类型
├── src/
│   ├── float/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx       # 拖拽逻辑，右键菜单，点击展开面板
│   │   ├── SpritePlayer.tsx
│   │   └── StatusDot.tsx
│   ├── panel/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── StatsBar.tsx
│   │   ├── MessageList.tsx
│   │   ├── TaskOutput.tsx
│   │   └── InputBar.tsx
│   └── settings/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx       # Tab 路由：宠物 / 角色 / API / 清理
│       ├── PetLibrary.tsx
│       ├── CharacterEditor.tsx
│       ├── ApiSettings.tsx
│       └── CleanupView.tsx
├── assets/
│   └── pets/
│       ├── stlulu/
│       │   ├── pet.json
│       │   └── spritesheet.webp   # 从 ~/.codex/pets/stlulu/ 复制
│       └── taotao/
│           ├── pet.json
│           └── spritesheet.webp
└── tests/
    ├── monitor.test.ts
    ├── pets.test.ts
    ├── character.test.ts
    ├── runner.test.ts
    ├── cleanup.test.ts
    └── ai.test.ts
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `electron-vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`

- [ ] **Step 1: 初始化项目**

```bash
cd /Users/renjiawei/work/pet-monitor-app
npm init -y
```

- [ ] **Step 2: 安装依赖**

```bash
npm install electron@28 react react-dom
npm install -D electron-vite vite @vitejs/plugin-react typescript \
  @types/react @types/react-dom @types/node vitest
npm install systeminformation anthropic openai keytar
npm install -D electron-builder @types/keytar
```

- [ ] **Step 3: 创建 `electron-vite.config.ts`**

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src-shared') } }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: 'src/float',
    build: { rollupOptions: { input: { float: resolve('src/float/index.html') } } },
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src-shared') } }
  }
})
```

> electron-vite 默认只支持单 renderer。多窗口需在 vite 里手动配置多 input，或使用独立 vite 实例。最简单的方式：在 `electron-vite.config.ts` 里配置 renderer 多入口。

```typescript
// electron-vite.config.ts（多窗口版本）
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          float:    resolve('src/float/index.html'),
          panel:    resolve('src/panel/index.html'),
          settings: resolve('src/settings/index.html')
        }
      }
    }
  }
})
```

- [ ] **Step 4: 创建 `tsconfig.json`**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

创建 `tsconfig.node.json`：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["electron/**/*", "src-shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src-shared/*"] }
  }
}
```

创建 `tsconfig.web.json`：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": ["src/**/*", "src-shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src-shared/*"] }
  }
}
```

安装 tsconfig 基础包：

```bash
npm install -D @electron-toolkit/tsconfig
```

- [ ] **Step 5: 更新 `package.json` scripts**

```json
{
  "name": "pet-monitor-app",
  "version": "0.1.0",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: 复制宠物资源**

```bash
mkdir -p assets/pets/stlulu assets/pets/taotao
cp ~/.codex/pets/stlulu/pet.json assets/pets/stlulu/
cp ~/.codex/pets/stlulu/spritesheet.webp assets/pets/stlulu/
cp ~/.codex/pets/taotao/pet.json assets/pets/taotao/
cp ~/.codex/pets/taotao/spritesheet.webp assets/pets/taotao/
```

- [ ] **Step 7: 创建各 renderer 入口 HTML（占位）**

创建 `src/float/index.html`：

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Pet</title></head>
<body style="margin:0;background:transparent">
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

创建 `src/panel/index.html`（同上，title 改为 Panel）。  
创建 `src/settings/index.html`（同上，title 改为 Settings）。

- [ ] **Step 8: 验证构建可运行**

```bash
npm run dev
```

预期：Electron 启动，暂时空白窗口，无报错。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: project scaffold with electron-vite + multi-window config"
```

---

## Task 2: 共享类型定义

**Files:**
- Create: `src-shared/types.ts`

- [ ] **Step 1: 创建 `src-shared/types.ts`**

```typescript
// Pet format (Codex-compatible, extended with animations)
export interface PetAnimation {
  row: number
  frames: number[]
}

export interface Pet {
  id: string
  displayName: string
  description: string
  spritesheetPath: string  // relative path inside pet dir
  kind?: string
  frameSize?: { width: number; height: number }
  animations?: {
    idle?: PetAnimation
    talk?: PetAnimation
    working?: PetAnimation
    alert?: PetAnimation
    celebrate?: PetAnimation
  }
  // resolved at runtime, not in JSON
  spritesheetDataUrl?: string
  dir?: string
}

// Character config stored per pet
export interface CharacterConfig {
  petId: string
  displayName: string
  personality: string[]
  systemPrompt: string
  greeting: string
  apiConfig: ApiConfig
}

export interface ApiConfig {
  provider: 'claude' | 'openai'
  model: string
  baseUrl?: string
  // apiKey stored in keychain, not here
}

// System stats (emitted by monitor every 2s)
export interface SystemStats {
  cpu: number          // 0-100
  ramUsed: number      // bytes
  ramTotal: number     // bytes
  diskUsed: number     // 0-100 percent
  claudeRunning: boolean
  codexRunning: boolean
}

// Pet animation state derived from system stats
export type PetAnimState = 'idle' | 'talk' | 'working' | 'alert' | 'celebrate'

// Chat messages
export type MessageRole = 'user' | 'pet' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
}

export interface CliTaskMessage extends ChatMessage {
  role: 'system'
  taskType: 'cli-output'
  lines: string[]
  done: boolean
  exitCode?: number
}

// IPC channel names (use as const for type safety)
export const IPC = {
  // Main → Renderer (via webContents.send)
  MONITOR_STATS:   'monitor:stats',      // SystemStats
  CHAT_CHUNK:      'chat:chunk',         // { chunk: string }
  CHAT_DONE:       'chat:done',          // void
  CHAT_ERROR:      'chat:error',         // { message: string }
  CLI_LINE:        'cli:line',           // { line: string }
  CLI_DONE:        'cli:done',           // { exitCode: number; output: string }

  // Renderer → Main (via ipcRenderer.invoke)
  PET_LIST:           'pet:list',           // → Pet[]
  PET_SWITCH:         'pet:switch',         // petId: string → void
  PET_IMPORT:         'pet:import',         // dirPath: string → Pet
  CHARACTER_GET:      'character:get',      // petId: string → CharacterConfig
  CHARACTER_SAVE:     'character:save',     // CharacterConfig → void
  CHAT_SEND:          'chat:send',          // { message: string; history: ChatMessage[] } → void
  CLEANUP_SCAN:       'cleanup:scan',       // → CleanupItem[]
  CLEANUP_EXECUTE:    'cleanup:execute',    // paths: string[] → void
  WINDOW_OPEN_PANEL:  'window:open-panel',  // → void
  WINDOW_CLOSE_PANEL: 'window:close-panel', // → void
  WINDOW_OPEN_SETTINGS: 'window:open-settings', // → void
  WINDOW_SET_POSITION:  'window:set-position',  // { x, y } → void
} as const

export interface CleanupItem {
  path: string
  size: number       // bytes
  label: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src-shared/ && git commit -m "feat: shared IPC types and constants"
```

---

## Task 3: SystemMonitor

**Files:**
- Create: `electron/monitor.ts`
- Create: `tests/monitor.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/monitor.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('systeminformation', () => ({
  default: {
    currentLoad:    vi.fn().mockResolvedValue({ currentLoad: 42 }),
    mem:            vi.fn().mockResolvedValue({ used: 8e9, total: 16e9 }),
    fsSize:         vi.fn().mockResolvedValue([{ use: 55 }]),
    processes:      vi.fn().mockResolvedValue({
      list: [{ name: 'claude' }, { name: 'node' }]
    })
  }
}))

import { SystemMonitor } from '../electron/monitor'
import type { SystemStats } from '../src-shared/types'

describe('SystemMonitor', () => {
  it('collects stats from systeminformation', async () => {
    const monitor = new SystemMonitor()
    const stats: SystemStats = await monitor.collect()
    expect(stats.cpu).toBe(42)
    expect(stats.ramUsed).toBe(8e9)
    expect(stats.ramTotal).toBe(16e9)
    expect(stats.diskUsed).toBe(55)
    expect(stats.claudeRunning).toBe(true)
    expect(stats.codexRunning).toBe(false)
  })

  it('returns safe defaults when systeminformation throws', async () => {
    const si = await import('systeminformation')
    vi.mocked(si.default.currentLoad).mockRejectedValueOnce(new Error('fail'))
    const monitor = new SystemMonitor()
    const stats = await monitor.collect()
    expect(stats.cpu).toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/monitor.test.ts
```

预期：FAIL — `../electron/monitor` not found

- [ ] **Step 3: 实现 `electron/monitor.ts`**

```typescript
import si from 'systeminformation'
import type { SystemStats } from '@shared/types'

export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null

  async collect(): Promise<SystemStats> {
    try {
      const [load, mem, disk, procs] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.processes()
      ])
      const names = procs.list.map(p => p.name.toLowerCase())
      return {
        cpu:           Math.round(load.currentLoad),
        ramUsed:       mem.used,
        ramTotal:      mem.total,
        diskUsed:      Math.round(disk[0]?.use ?? 0),
        claudeRunning: names.some(n => n.includes('claude')),
        codexRunning:  names.some(n => n.includes('codex'))
      }
    } catch {
      return { cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0, claudeRunning: false, codexRunning: false }
    }
  }

  start(onStats: (s: SystemStats) => void): void {
    this.timer = setInterval(async () => {
      onStats(await this.collect())
    }, 2000)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/monitor.test.ts
```

预期：PASS

- [ ] **Step 5: Commit**

```bash
git add electron/monitor.ts tests/monitor.test.ts
git commit -m "feat: SystemMonitor with systeminformation polling"
```

---

## Task 4: PetManager

**Files:**
- Create: `electron/pets.ts`
- Create: `tests/pets.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/pets.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('fs', () => require('memfs').fs)
vi.mock('fs/promises', () => require('memfs').fs.promises)

import { PetManager } from '../electron/pets'

const MOCK_PET_JSON = JSON.stringify({
  id: 'stlulu',
  displayName: 'lulu',
  description: 'test pet',
  spritesheetPath: 'spritesheet.webp',
  kind: 'animal'
})

beforeEach(() => {
  vol.reset()
  vol.fromJSON({
    '/userData/pets/stlulu/pet.json': MOCK_PET_JSON,
    '/userData/pets/stlulu/spritesheet.webp': 'binary'
  })
})

describe('PetManager', () => {
  it('lists pets from userData directory', async () => {
    const mgr = new PetManager('/userData', '/assets')
    const pets = await mgr.list()
    expect(pets).toHaveLength(1)
    expect(pets[0].id).toBe('stlulu')
    expect(pets[0].displayName).toBe('lulu')
  })

  it('returns empty array when no pets dir', async () => {
    vol.reset()
    const mgr = new PetManager('/userData', '/assets')
    const pets = await mgr.list()
    expect(pets).toEqual([])
  })
})
```

安装 memfs：

```bash
npm install -D memfs
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/pets.test.ts
```

- [ ] **Step 3: 实现 `electron/pets.ts`**

```typescript
import fs from 'fs/promises'
import path from 'path'
import type { Pet } from '@shared/types'

export class PetManager {
  private petsDir: string
  private assetsDir: string
  private activePetId: string | null = null

  constructor(userData: string, assetsDir: string) {
    this.petsDir  = path.join(userData, 'pets')
    this.assetsDir = assetsDir
  }

  async ensureBuiltins(): Promise<void> {
    await fs.mkdir(this.petsDir, { recursive: true })
    const builtins = ['stlulu', 'taotao']
    for (const id of builtins) {
      const dest = path.join(this.petsDir, id)
      try { await fs.access(dest) } catch {
        const src = path.join(this.assetsDir, 'pets', id)
        await fs.cp(src, dest, { recursive: true })
      }
    }
  }

  async list(): Promise<Pet[]> {
    try {
      const entries = await fs.readdir(this.petsDir, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory())
      const pets = await Promise.all(dirs.map(d => this.load(d.name)))
      return pets.filter((p): p is Pet => p !== null)
    } catch { return [] }
  }

  async load(id: string): Promise<Pet | null> {
    try {
      const dir   = path.join(this.petsDir, id)
      const raw   = await fs.readFile(path.join(dir, 'pet.json'), 'utf-8')
      const pet   = JSON.parse(raw) as Pet
      const imgBuf = await fs.readFile(path.join(dir, pet.spritesheetPath))
      pet.spritesheetDataUrl = `data:image/webp;base64,${imgBuf.toString('base64')}`
      pet.dir = dir
      return pet
    } catch { return null }
  }

  async importFrom(dirPath: string): Promise<Pet> {
    const jsonPath = path.join(dirPath, 'pet.json')
    const raw  = await fs.readFile(jsonPath, 'utf-8')
    const meta = JSON.parse(raw) as Pet
    const dest = path.join(this.petsDir, meta.id)
    await fs.cp(dirPath, dest, { recursive: true })
    const pet = await this.load(meta.id)
    if (!pet) throw new Error(`Failed to import pet ${meta.id}`)
    return pet
  }

  setActive(petId: string): void { this.activePetId = petId }
  getActiveId(): string | null   { return this.activePetId }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/pets.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/pets.ts tests/pets.test.ts
git commit -m "feat: PetManager loads pet.json + spritesheet, copies builtins"
```

---

## Task 5: CharacterConfig + API Key 存储

**Files:**
- Create: `electron/character.ts`
- Create: `tests/character.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/character.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { vol } from 'memfs'

vi.mock('fs', () => require('memfs').fs)
vi.mock('fs/promises', () => require('memfs').fs.promises)
vi.mock('keytar', () => ({
  getPassword: vi.fn().mockResolvedValue('test-api-key'),
  setPassword: vi.fn().mockResolvedValue(undefined)
}))

import { CharacterConfigStore } from '../electron/character'

beforeEach(() => vol.reset())

describe('CharacterConfigStore', () => {
  it('returns default config when none saved', async () => {
    const store = new CharacterConfigStore('/userData')
    const cfg = await store.get('stlulu')
    expect(cfg.petId).toBe('stlulu')
    expect(cfg.apiConfig.provider).toBe('claude')
    expect(cfg.apiConfig.model).toBe('claude-opus-4-7')
  })

  it('saves and retrieves config', async () => {
    const store = new CharacterConfigStore('/userData')
    await store.save({ petId: 'stlulu', displayName: 'lulu', personality: ['活泼'],
      systemPrompt: 'You are lulu', greeting: 'Hi!',
      apiConfig: { provider: 'claude', model: 'claude-opus-4-7' } })
    const cfg = await store.get('stlulu')
    expect(cfg.systemPrompt).toBe('You are lulu')
  })

  it('retrieves API key from keychain', async () => {
    const store = new CharacterConfigStore('/userData')
    const key = await store.getApiKey('stlulu')
    expect(key).toBe('test-api-key')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/character.test.ts
```

- [ ] **Step 3: 实现 `electron/character.ts`**

```typescript
import fs from 'fs/promises'
import path from 'path'
import keytar from 'keytar'
import type { CharacterConfig } from '@shared/types'

const SERVICE = 'pet-monitor-app'

const DEFAULT_CONFIG = (petId: string): CharacterConfig => ({
  petId,
  displayName: petId,
  personality: ['活泼', '可爱'],
  systemPrompt: `你是一只可爱的桌面宠物助手。你的名字是 ${petId}。你住在用户的桌面上，帮助监控系统状态和执行任务。说话自然友好。`,
  greeting: '你好！有什么我能帮你的吗？',
  apiConfig: { provider: 'claude', model: 'claude-opus-4-7' }
})

export class CharacterConfigStore {
  private dir: string

  constructor(userData: string) {
    this.dir = path.join(userData, 'characters')
  }

  private filePath(petId: string): string {
    return path.join(this.dir, `${petId}.json`)
  }

  async get(petId: string): Promise<CharacterConfig> {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const raw = await fs.readFile(this.filePath(petId), 'utf-8')
      return JSON.parse(raw) as CharacterConfig
    } catch {
      return DEFAULT_CONFIG(petId)
    }
  }

  async save(cfg: CharacterConfig): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.filePath(cfg.petId), JSON.stringify(cfg, null, 2))
  }

  async getApiKey(petId: string): Promise<string | null> {
    return keytar.getPassword(SERVICE, petId)
  }

  async saveApiKey(petId: string, key: string): Promise<void> {
    await keytar.setPassword(SERVICE, petId, key)
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/character.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/character.ts tests/character.test.ts
git commit -m "feat: CharacterConfigStore with keytar API key storage"
```

---

## Task 6: CliRunner

**Files:**
- Create: `electron/runner.ts`
- Create: `tests/runner.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/runner.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: mockSpawn }))

import { CliRunner } from '../electron/runner'
import { EventEmitter } from 'events'

function makeProc(stdout: string[], exitCode = 0) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setTimeout(() => {
    stdout.forEach(line => proc.stdout.emit('data', Buffer.from(line + '\n')))
    proc.emit('close', exitCode)
  }, 10)
  return proc
}

describe('CliRunner', () => {
  it('runs claude and collects output', async () => {
    mockSpawn.mockReturnValueOnce(makeProc(['line 1', 'line 2']))
    const runner = new CliRunner()
    const lines: string[] = []
    const result = await runner.run('claude', ['--print', 'hello'], {
      onLine: l => lines.push(l)
    })
    expect(lines).toEqual(['line 1', 'line 2'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('line 1')
  })

  it('rejects with timeout error when process hangs', async () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    mockSpawn.mockReturnValueOnce(proc)
    const runner = new CliRunner({ timeoutMs: 50 })
    await expect(
      runner.run('claude', ['--print', 'hang'], {})
    ).rejects.toThrow('timeout')
    expect(proc.kill).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/runner.test.ts
```

- [ ] **Step 3: 实现 `electron/runner.ts`**

```typescript
import { spawn } from 'child_process'

interface RunOptions {
  onLine?: (line: string) => void
  workdir?: string
}

interface RunResult {
  exitCode: number
  output: string
}

interface RunnerConfig {
  timeoutMs?: number
}

export class CliRunner {
  private timeoutMs: number
  private running = false

  constructor(config: RunnerConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 5 * 60 * 1000
  }

  run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd:   opts.workdir,
        shell: false,
        env:   { ...process.env }
      })

      let output = ''
      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error(`CLI task timeout after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const onData = (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          output += line + '\n'
          opts.onLine?.(line)
        }
      }

      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)
      proc.on('close', exitCode => {
        clearTimeout(timer)
        resolve({ exitCode: exitCode ?? 1, output })
      })
      proc.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/runner.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/runner.ts tests/runner.test.ts
git commit -m "feat: CliRunner with spawn, streaming output, timeout"
```

---

## Task 7: AiEngine（Claude + OpenAI，function calling）

**Files:**
- Create: `electron/ai.ts`
- Create: `tests/ai.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/ai.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'

const mockCreate = vi.fn()
vi.mock('anthropic', () => ({
  default: class { messages = { stream: mockCreate } }
}))

import { AiEngine } from '../electron/ai'
import type { CharacterConfig, SystemStats } from '../src-shared/types'

const MOCK_CONFIG: CharacterConfig = {
  petId: 'stlulu', displayName: 'lulu', personality: [],
  systemPrompt: 'You are lulu.',
  greeting: 'Hi!',
  apiConfig: { provider: 'claude', model: 'claude-opus-4-7' }
}

const MOCK_STATS: SystemStats = {
  cpu: 30, ramUsed: 4e9, ramTotal: 16e9,
  diskUsed: 40, claudeRunning: false, codexRunning: false
}

describe('AiEngine', () => {
  it('builds system prompt with stats injected', () => {
    const engine = new AiEngine()
    const prompt = engine.buildSystemPrompt(MOCK_CONFIG, MOCK_STATS)
    expect(prompt).toContain('You are lulu.')
    expect(prompt).toContain('CPU: 30%')
    expect(prompt).toContain('claude: 未运行')
  })

  it('detects tool call in AI response', () => {
    const engine = new AiEngine()
    const toolCall = engine.parseToolCall({
      type: 'tool_use', name: 'run_claude_code',
      input: { prompt: 'fix bug', workdir: '/home' }
    })
    expect(toolCall?.tool).toBe('run_claude_code')
    expect(toolCall?.prompt).toBe('fix bug')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/ai.test.ts
```

- [ ] **Step 3: 实现 `electron/ai.ts`**

```typescript
import Anthropic from 'anthropic'
import OpenAI from 'openai'
import type { CharacterConfig, SystemStats, ChatMessage } from '@shared/types'

export interface ToolCall {
  tool: 'run_claude_code' | 'run_codex'
  prompt: string
  workdir?: string
}

const CLI_TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_claude_code',
    description: 'Run Claude Code CLI to perform coding or file tasks in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        prompt:  { type: 'string', description: 'Task description for Claude Code' },
        workdir: { type: 'string', description: 'Working directory path' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'run_codex',
    description: 'Run Codex CLI to perform tasks.',
    input_schema: {
      type: 'object',
      properties: {
        prompt:  { type: 'string', description: 'Task description for Codex' },
        workdir: { type: 'string', description: 'Working directory path' }
      },
      required: ['prompt']
    }
  }
]

export class AiEngine {
  buildSystemPrompt(cfg: CharacterConfig, stats: SystemStats): string {
    const ram = `${(stats.ramUsed / 1e9).toFixed(1)}GB / ${(stats.ramTotal / 1e9).toFixed(1)}GB`
    const context = [
      `\n\n[系统状态]`,
      `CPU: ${stats.cpu}%`,
      `RAM: ${ram}`,
      `磁盘: ${stats.diskUsed}%`,
      `claude: ${stats.claudeRunning ? '运行中' : '未运行'}`,
      `codex: ${stats.codexRunning ? '运行中' : '未运行'}`
    ].join('\n')
    return cfg.systemPrompt + context
  }

  parseToolCall(block: unknown): ToolCall | null {
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
    if (b?.type !== 'tool_use') return null
    if (b.name !== 'run_claude_code' && b.name !== 'run_codex') return null
    return {
      tool:    b.name as ToolCall['tool'],
      prompt:  b.input?.prompt as string,
      workdir: b.input?.workdir as string | undefined
    }
  }

  async chat(opts: {
    config: CharacterConfig
    apiKey: string
    history: ChatMessage[]
    userMessage: string
    stats: SystemStats
    onChunk: (text: string) => void
  }): Promise<{ text: string; toolCall: ToolCall | null }> {
    const { config, apiKey, history, userMessage, stats, onChunk } = opts
    const systemPrompt = this.buildSystemPrompt(config, stats)

    const messages: Anthropic.MessageParam[] = [
      ...history
        .filter(m => m.role === 'user' || m.role === 'pet')
        .map(m => ({
          role:    (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content
        })),
      { role: 'user', content: userMessage }
    ]

    if (config.apiConfig.provider === 'claude') {
      const client = new Anthropic({ apiKey })
      let text = ''
      let toolCall: ToolCall | null = null

      const stream = client.messages.stream({
        model:      config.apiConfig.model,
        max_tokens: 1024,
        system:     systemPrompt,
        tools:      CLI_TOOLS,
        messages
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
          onChunk(event.delta.text)
        }
        if (event.type === 'content_block_stop') {
          const block = (stream as unknown as { currentMessageSnapshot: Anthropic.Message })
            .currentMessageSnapshot?.content?.find(b => b.type === 'tool_use')
          if (block) toolCall = this.parseToolCall(block)
        }
      }

      return { text, toolCall }
    }

    // OpenAI-compatible
    const client = new OpenAI({
      apiKey,
      baseURL: config.apiConfig.baseUrl || undefined
    })
    let text = ''
    const stream = await client.chat.completions.create({
      model:    config.apiConfig.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream:   true
    })
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      text += delta
      if (delta) onChunk(delta)
    }
    return { text, toolCall: null }
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/ai.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/ai.ts tests/ai.test.ts
git commit -m "feat: AiEngine with Claude/OpenAI streaming and function calling"
```

---

## Task 8: CleanupEngine

**Files:**
- Create: `electron/cleanup.ts`
- Create: `tests/cleanup.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/cleanup.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('fs', () => require('memfs').fs)
vi.mock('fs/promises', () => require('memfs').fs.promises)

import { CleanupEngine } from '../electron/cleanup'

beforeEach(() => {
  vol.reset()
  vol.fromJSON({
    '/tmp/file1.tmp': 'a'.repeat(1000),
    '/tmp/file2.tmp': 'b'.repeat(2000),
    '/tmp/subdir/file3.tmp': 'c'.repeat(500)
  })
})

describe('CleanupEngine', () => {
  it('scans directory and calculates total size', async () => {
    const engine = new CleanupEngine(['/tmp'])
    const items = await engine.scan()
    const total = items.reduce((s, i) => s + i.size, 0)
    expect(total).toBe(3500)
    expect(items.length).toBeGreaterThan(0)
  })

  it('deletes specified paths', async () => {
    const engine = new CleanupEngine(['/tmp'])
    await engine.execute(['/tmp/file1.tmp'])
    await expect(
      require('memfs').fs.promises.access('/tmp/file1.tmp')
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test -- tests/cleanup.test.ts
```

- [ ] **Step 3: 实现 `electron/cleanup.ts`**

```typescript
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { CleanupItem } from '@shared/types'

export function defaultCacheDirs(): string[] {
  return process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Caches')]
    : [os.tmpdir(), path.join(os.homedir(), 'AppData', 'Local', 'Temp')]
}

export class CleanupEngine {
  constructor(private dirs: string[]) {}

  async scan(): Promise<CleanupItem[]> {
    const items: CleanupItem[] = []
    for (const dir of this.dirs) {
      await this.walk(dir, items)
    }
    return items
  }

  private async walk(dir: string, out: CleanupItem[]): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          await this.walk(full, out)
        } else {
          try {
            const stat = await fs.stat(full)
            out.push({ path: full, size: stat.size, label: path.relative(this.dirs[0], full) })
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  async execute(paths: string[]): Promise<void> {
    await Promise.all(paths.map(p => fs.rm(p, { force: true, recursive: true })))
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test -- tests/cleanup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/cleanup.ts tests/cleanup.test.ts
git commit -m "feat: CleanupEngine scans cache dirs and deletes by path"
```

---

## Task 9: WindowManager + Main 入口 + IPC

**Files:**
- Create: `electron/windows.ts`
- Create: `electron/ipc.ts`
- Create: `electron/main.ts`

- [ ] **Step 1: 创建 `electron/windows.ts`**

```typescript
import { BrowserWindow, screen, app } from 'electron'
import path from 'path'

export class WindowManager {
  float:    BrowserWindow | null = null
  panel:    BrowserWindow | null = null
  settings: BrowserWindow | null = null

  createFloat(): BrowserWindow {
    this.float = new BrowserWindow({
      width: 100, height: 120,
      transparent: true, frame: false,
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false, hasShadow: false,
      webPreferences: {
        preload:          path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration:  false
      }
    })
    this.float.setIgnoreMouseEvents(false)
    // Restore saved position
    const { x, y } = this.savedFloatPos()
    this.float.setPosition(x, y)

    if (process.env.ELECTRON_RENDERER_URL) {
      this.float.loadURL(process.env.ELECTRON_RENDERER_URL + '/float/index.html')
    } else {
      this.float.loadFile(path.join(__dirname, '../renderer/float/index.html'))
    }
    return this.float
  }

  createPanel(): BrowserWindow {
    const [fx, fy] = this.float?.getPosition() ?? [100, 100]
    this.panel = new BrowserWindow({
      width: 320, height: 520,
      x: fx + 110, y: fy - 200,
      frame: false, transparent: false,
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload:          path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration:  false
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      this.panel.loadURL(process.env.ELECTRON_RENDERER_URL + '/panel/index.html')
    } else {
      this.panel.loadFile(path.join(__dirname, '../renderer/panel/index.html'))
    }
    return this.panel
  }

  createSettings(): BrowserWindow {
    this.settings = new BrowserWindow({
      width: 720, height: 560,
      frame: true, alwaysOnTop: false,
      webPreferences: {
        preload:          path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration:  false
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      this.settings.loadURL(process.env.ELECTRON_RENDERER_URL + '/settings/index.html')
    } else {
      this.settings.loadFile(path.join(__dirname, '../renderer/settings/index.html'))
    }
    this.settings.on('closed', () => { this.settings = null })
    return this.settings
  }

  togglePanel(): void {
    if (!this.panel) { this.createPanel(); this.panel!.show(); return }
    this.panel.isVisible() ? this.panel.hide() : this.panel.show()
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.float, this.panel, this.settings]) {
      win?.webContents?.send(channel, payload)
    }
  }

  private savedFloatPos(): { x: number; y: number } {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    return { x: width - 120, y: height - 160 }
  }
}
```

- [ ] **Step 2: 创建 preload 脚本 `electron/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron'
import type { IPC } from '@shared/types'

contextBridge.exposeInMainWorld('ipc', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on:     (channel: string, cb: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => cb(...args))
  },
  off:    (channel: string, cb: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, cb as never)
  }
})
```

- [ ] **Step 3: 创建 `electron/ipc.ts`**

```typescript
import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/types'
import type { WindowManager } from './windows'
import type { PetManager }    from './pets'
import type { CharacterConfigStore } from './character'
import type { AiEngine }      from './ai'
import type { CliRunner }     from './runner'
import type { CleanupEngine } from './cleanup'
import type { SystemMonitor } from './monitor'

export function registerIpcHandlers(deps: {
  wm:      WindowManager
  pets:    PetManager
  chars:   CharacterConfigStore
  ai:      AiEngine
  runner:  CliRunner
  cleanup: CleanupEngine
  monitor: SystemMonitor
  getStats: () => import('@shared/types').SystemStats
}): void {
  const { wm, pets, chars, ai, runner, cleanup, getStats } = deps

  ipcMain.handle(IPC.PET_LIST,    ()          => pets.list())
  ipcMain.handle(IPC.PET_SWITCH,  (_, petId)  => { pets.setActive(petId) })
  ipcMain.handle(IPC.PET_IMPORT,  (_, dirPath) => pets.importFrom(dirPath))

  ipcMain.handle(IPC.CHARACTER_GET,  (_, petId) => chars.get(petId))
  ipcMain.handle(IPC.CHARACTER_SAVE, (_, cfg)   => chars.save(cfg))

  ipcMain.handle(IPC.WINDOW_OPEN_PANEL,     () => wm.togglePanel())
  ipcMain.handle(IPC.WINDOW_CLOSE_PANEL,    () => wm.panel?.hide())
  ipcMain.handle(IPC.WINDOW_OPEN_SETTINGS,  () => {
    if (!wm.settings) wm.createSettings()
    wm.settings?.show()
  })
  ipcMain.handle(IPC.WINDOW_SET_POSITION, (_, pos: { x: number; y: number }) => {
    wm.float?.setPosition(pos.x, pos.y)
  })

  ipcMain.handle(IPC.CHAT_SEND, async (_, { message, history }: { message: string; history: import('@shared/types').ChatMessage[] }) => {
    const petId = pets.getActiveId() ?? 'stlulu'
    const [cfg, apiKey] = await Promise.all([chars.get(petId), chars.getApiKey(petId)])
    if (!apiKey) {
      wm.broadcast(IPC.CHAT_ERROR, { message: 'API Key 未配置，请在设置中填写。' })
      return
    }
    const { text, toolCall } = await ai.chat({
      config: cfg, apiKey, history,
      userMessage: message, stats: getStats(),
      onChunk: chunk => wm.broadcast(IPC.CHAT_CHUNK, { chunk })
    })
    if (toolCall) {
      const cmd  = toolCall.tool === 'run_claude_code' ? 'claude' : 'codex'
      const args = ['--print', toolCall.prompt]
      try {
        const result = await runner.run(cmd, args, {
          workdir: toolCall.workdir,
          onLine: line => wm.broadcast(IPC.CLI_LINE, { line })
        })
        wm.broadcast(IPC.CLI_DONE, { exitCode: result.exitCode, output: result.output })
        // Let AI summarize
        await ai.chat({
          config: cfg, apiKey, history: [],
          userMessage: `任务完成，输出：\n${result.output}\n\n请用你的角色总结结果。`,
          stats: getStats(),
          onChunk: chunk => wm.broadcast(IPC.CHAT_CHUNK, { chunk })
        })
      } catch (err) {
        wm.broadcast(IPC.CHAT_ERROR, { message: (err as Error).message })
      }
    }
    wm.broadcast(IPC.CHAT_DONE, {})
  })

  ipcMain.handle(IPC.CLEANUP_SCAN,    () => cleanup.scan())
  ipcMain.handle(IPC.CLEANUP_EXECUTE, (_, paths: string[]) => cleanup.execute(paths))
}
```

- [ ] **Step 4: 创建 `electron/main.ts`**

```typescript
import { app, Menu, Tray } from 'electron'
import path from 'path'
import { WindowManager }        from './windows'
import { SystemMonitor }        from './monitor'
import { PetManager }           from './pets'
import { CharacterConfigStore } from './character'
import { AiEngine }             from './ai'
import { CliRunner }            from './runner'
import { CleanupEngine, defaultCacheDirs } from './cleanup'
import { registerIpcHandlers }  from './ipc'
import { IPC }                  from '@shared/types'
import type { SystemStats }     from '@shared/types'

app.whenReady().then(async () => {
  const userData   = app.getPath('userData')
  const assetsDir  = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets')

  const wm      = new WindowManager()
  const monitor = new SystemMonitor()
  const pets    = new PetManager(userData, assetsDir)
  const chars   = new CharacterConfigStore(userData)
  const ai      = new AiEngine()
  const runner  = new CliRunner()
  const cleanup = new CleanupEngine(defaultCacheDirs())

  await pets.ensureBuiltins()
  pets.setActive('stlulu')

  let latestStats: SystemStats = {
    cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0,
    claudeRunning: false, codexRunning: false
  }

  monitor.start(stats => {
    latestStats = stats
    wm.broadcast(IPC.MONITOR_STATS, stats)
  })

  registerIpcHandlers({
    wm, pets, chars, ai, runner, cleanup, monitor,
    getStats: () => latestStats
  })

  wm.createFloat()
  wm.createPanel()

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
})
```

- [ ] **Step 5: 运行 dev 验证三个窗口加载**

```bash
npm run dev
```

预期：Float 窗口出现在屏幕右下角，无报错。

- [ ] **Step 6: Commit**

```bash
git add electron/
git commit -m "feat: WindowManager, main entry, IPC handlers wired"
```

---

## Task 10: SpritePlayer 组件

**Files:**
- Create: `src/float/SpritePlayer.tsx`
- Create: `src/float/StatusDot.tsx`

- [ ] **Step 1: 创建 `src/float/SpritePlayer.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { Pet, PetAnimState } from '@shared/types'

interface Props {
  pet: Pet
  state: PetAnimState
  size?: number
}

export function SpritePlayer({ pet, state, size = 80 }: Props) {
  const [frame, setFrame] = useState(0)
  const timerRef = useRef<number>(0)

  const anim = pet.animations?.[state] ?? pet.animations?.idle
  const fw = pet.frameSize?.width  ?? 80
  const fh = pet.frameSize?.height ?? 80

  useEffect(() => {
    if (!anim || anim.frames.length <= 1) return
    let i = 0
    timerRef.current = window.setInterval(() => {
      i = (i + 1) % anim.frames.length
      setFrame(anim.frames[i])
    }, 150)
    return () => clearInterval(timerRef.current)
  }, [state, pet.id])

  const col = anim ? anim.frames[frame % anim.frames.length] : 0
  const row = anim?.row ?? 0
  const bgX = -(col * fw)
  const bgY = -(row * fh)
  const scale = size / fw

  return (
    <div style={{
      width:  size, height: size,
      backgroundImage:    `url(${pet.spritesheetDataUrl})`,
      backgroundPosition: `${bgX * scale}px ${bgY * scale}px`,
      backgroundSize:     `auto`,
      imageRendering:     'pixelated',
      transform:          `scale(${scale})`,
      transformOrigin:    'top left',
      overflow:           'hidden'
    }} />
  )
}
```

- [ ] **Step 2: 创建 `src/float/StatusDot.tsx`**

```tsx
import type { SystemStats } from '@shared/types'

function dotColor(stats: SystemStats): string {
  if (stats.cpu > 80 || (stats.ramUsed / stats.ramTotal) > 0.9) return '#ef4444'
  if (stats.cpu > 60 || (stats.ramUsed / stats.ramTotal) > 0.75) return '#f59e0b'
  return '#22c55e'
}

export function StatusDot({ stats }: { stats: SystemStats }) {
  return (
    <div style={{
      width: 10, height: 10,
      borderRadius: '50%',
      background: dotColor(stats),
      border: '2px solid rgba(0,0,0,0.4)',
      position: 'absolute', bottom: 4, right: 4
    }} />
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/float/SpritePlayer.tsx src/float/StatusDot.tsx
git commit -m "feat: SpritePlayer with spritesheet frame animation, StatusDot"
```

---

## Task 11: Float Window React App

**Files:**
- Create: `src/float/main.tsx`
- Create: `src/float/App.tsx`

- [ ] **Step 1: 创建 `src/float/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
)
```

- [ ] **Step 2: 创建 `src/float/App.tsx`**

```tsx
import { useEffect, useState, useCallback } from 'react'
import { SpritePlayer } from './SpritePlayer'
import { StatusDot }    from './StatusDot'
import type { Pet, SystemStats, PetAnimState } from '@shared/types'
import { IPC } from '@shared/types'

declare const window: Window & {
  ipc: {
    invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
    on:  (ch: string, cb: (...a: unknown[]) => void) => void
    off: (ch: string, cb: (...a: unknown[]) => void) => void
  }
}

const DEFAULT_STATS: SystemStats = {
  cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0,
  claudeRunning: false, codexRunning: false
}

export function App() {
  const [pet,       setPet]       = useState<Pet | null>(null)
  const [stats,     setStats]     = useState<SystemStats>(DEFAULT_STATS)
  const [animState, setAnimState] = useState<PetAnimState>('idle')
  const [dragging,  setDragging]  = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  // Load active pet
  useEffect(() => {
    window.ipc.invoke(IPC.PET_LIST).then((pets) => {
      const list = pets as Pet[]
      if (list[0]) setPet(list[0])
    })
  }, [])

  // System stats → animate
  useEffect(() => {
    const handler = (s: unknown) => {
      const stats = s as SystemStats
      setStats(stats)
      if (stats.cpu > 80) setAnimState('alert')
      else setAnimState('idle')
    }
    window.ipc.on(IPC.MONITOR_STATS, handler)
    return () => window.ipc.off(IPC.MONITOR_STATS, handler)
  }, [])

  // CLI running state
  useEffect(() => {
    const onLine  = () => setAnimState('working')
    const onDone  = () => setAnimState('celebrate')
    const onChunk = () => setAnimState('talk')
    window.ipc.on(IPC.CLI_LINE,   onLine)
    window.ipc.on(IPC.CLI_DONE,   onDone)
    window.ipc.on(IPC.CHAT_CHUNK, onChunk)
    window.ipc.on(IPC.CHAT_DONE,  () => setAnimState('idle'))
    return () => {
      window.ipc.off(IPC.CLI_LINE,   onLine)
      window.ipc.off(IPC.CLI_DONE,   onDone)
      window.ipc.off(IPC.CHAT_CHUNK, onChunk)
    }
  }, [])

  const handleClick = useCallback(() => {
    if (!dragging) window.ipc.invoke(IPC.WINDOW_OPEN_PANEL)
  }, [dragging])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setDragging(false)
    setDragStart({ x: e.screenX, y: e.screenY })
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (e.buttons !== 1) return
    const dx = Math.abs(e.screenX - dragStart.x)
    const dy = Math.abs(e.screenY - dragStart.y)
    if (dx > 4 || dy > 4) {
      setDragging(true)
      window.ipc.invoke(IPC.WINDOW_SET_POSITION, { x: e.screenX - 50, y: e.screenY - 60 })
    }
  }, [dragStart])

  if (!pet) return null

  return (
    <div
      style={{ position: 'relative', display: 'inline-block', cursor: 'pointer', userSelect: 'none' }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      <SpritePlayer pet={pet} state={animState} size={80} />
      <StatusDot stats={stats} />
    </div>
  )
}
```

- [ ] **Step 3: 运行并验证宠物可见**

```bash
npm run dev
```

预期：屏幕右下角出现 lulu 的 sprite，状态点绿色。

- [ ] **Step 4: Commit**

```bash
git add src/float/
git commit -m "feat: float window shows animated sprite, reacts to system stats"
```

---

## Task 12: Chat Panel UI

**Files:**
- Create: `src/panel/main.tsx`
- Create: `src/panel/App.tsx`
- Create: `src/panel/StatsBar.tsx`
- Create: `src/panel/MessageList.tsx`
- Create: `src/panel/TaskOutput.tsx`
- Create: `src/panel/InputBar.tsx`

- [ ] **Step 1: 创建 `src/panel/StatsBar.tsx`**

```tsx
import type { SystemStats } from '@shared/types'

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 3, background: '#1e293b', borderRadius: 2, marginTop: 3 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
    </div>
  )
}

export function StatsBar({ stats }: { stats: SystemStats }) {
  const ram = Math.round((stats.ramUsed / stats.ramTotal) * 100)
  return (
    <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid #1e2d45' }}>
      {[
        { label: 'CPU', val: stats.cpu, color: stats.cpu > 80 ? '#ef4444' : '#f59e0b' },
        { label: 'RAM', val: ram,       color: ram > 90 ? '#ef4444' : '#60a5fa' },
        { label: 'Disk', val: stats.diskUsed, color: '#22c55e' }
      ].map(({ label, val, color }) => (
        <div key={label} style={{ flex: 1, background: '#131d30', borderRadius: 6, padding: '5px 7px' }}>
          <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase' }}>{label}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color }}>{val}%</div>
          <Bar pct={val} color={color} />
        </div>
      ))}
      <div style={{ flex: 1, background: '#131d30', borderRadius: 6, padding: '5px 7px' }}>
        <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase' }}>Claude</div>
        <div style={{ fontSize: 11, color: stats.claudeRunning ? '#a78bfa' : '#475569' }}>
          {stats.claudeRunning ? '● 运行' : '○ 停止'}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `src/panel/TaskOutput.tsx`**

```tsx
import { useEffect, useRef } from 'react'

export function TaskOutput({ lines, done }: { lines: string[]; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines.length])
  return (
    <div style={{ background: '#0d1f12', border: '1px solid #1a4a2a', borderRadius: 8, padding: '8px 10px', fontSize: 10, fontFamily: 'monospace' }}>
      <div style={{ color: '#4ade80', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
        {!done && <span style={{ display: 'inline-block', width: 6, height: 6, background: '#4ade80', borderRadius: '50%' }} />}
        {done ? '✓ 完成' : '运行中...'}
      </div>
      <div style={{ color: '#64748b', lineHeight: 1.6, maxHeight: 120, overflowY: 'auto' }}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <div ref={ref} />
    </div>
  )
}
```

- [ ] **Step 3: 创建 `src/panel/MessageList.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import { TaskOutput } from './TaskOutput'
import type { ChatMessage, CliTaskMessage } from '@shared/types'

function isCliTask(m: ChatMessage): m is CliTaskMessage {
  return m.role === 'system' && (m as CliTaskMessage).taskType === 'cli-output'
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {messages.map(m => {
        if (isCliTask(m)) return <TaskOutput key={m.id} lines={m.lines} done={m.done} />
        const isUser = m.role === 'user'
        return (
          <div key={m.id} style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', gap: 8 }}>
            <div style={{
              maxWidth: '75%', borderRadius: 12, padding: '7px 11px',
              fontSize: 12, lineHeight: 1.5,
              background: isUser ? '#7c3aed' : '#1e2d45',
              borderBottomRightRadius: isUser ? 3 : 12,
              borderBottomLeftRadius:  isUser ? 12 : 3
            }}>
              {m.content}
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
```

- [ ] **Step 4: 创建 `src/panel/InputBar.tsx`**

```tsx
import { useState, useCallback } from 'react'

export function InputBar({ onSend, disabled }: { onSend: (msg: string) => void; disabled?: boolean }) {
  const [val, setVal] = useState('')
  const send = useCallback(() => {
    const t = val.trim()
    if (!t || disabled) return
    onSend(t)
    setVal('')
  }, [val, disabled, onSend])
  return (
    <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #1e2d45' }}>
      <input
        value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') send() }}
        placeholder="和宠物说点什么…"
        style={{
          flex: 1, background: '#131d30', border: '1px solid #1e2d45',
          borderRadius: 20, padding: '7px 12px', fontSize: 12, color: '#e2e8f0', outline: 'none'
        }}
      />
      <button onClick={send} disabled={disabled} style={{
        width: 32, height: 32, borderRadius: '50%', background: disabled ? '#334155' : '#7c3aed',
        border: 'none', color: 'white', cursor: disabled ? 'default' : 'pointer', fontSize: 14
      }}>↑</button>
    </div>
  )
}
```

- [ ] **Step 5: 创建 `src/panel/App.tsx`**

```tsx
import { useEffect, useState, useCallback, useRef } from 'react'
import { StatsBar }     from './StatsBar'
import { MessageList }  from './MessageList'
import { InputBar }     from './InputBar'
import { IPC } from '@shared/types'
import type { SystemStats, ChatMessage, CliTaskMessage, Pet } from '@shared/types'

declare const window: Window & {
  ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown>; on: (ch: string, cb: (...a: unknown[]) => void) => void; off: (ch: string, cb: (...a: unknown[]) => void) => void }
}

const DEFAULT_STATS: SystemStats = { cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0, claudeRunning: false, codexRunning: false }

export function App() {
  const [stats,    setStats]    = useState<SystemStats>(DEFAULT_STATS)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending,  setSending]  = useState(false)
  const [pet,      setPet]      = useState<Pet | null>(null)
  const streamBuf  = useRef('')
  const streamId   = useRef('')

  useEffect(() => {
    window.ipc.invoke(IPC.PET_LIST).then(pets => { setPet((pets as Pet[])[0] ?? null) })
  }, [])

  useEffect(() => {
    const onStats = (s: unknown) => setStats(s as SystemStats)
    window.ipc.on(IPC.MONITOR_STATS, onStats)
    return () => window.ipc.off(IPC.MONITOR_STATS, onStats)
  }, [])

  useEffect(() => {
    const onChunk = (payload: unknown) => {
      const { chunk } = payload as { chunk: string }
      streamBuf.current += chunk
      setMessages(msgs => {
        const last = msgs[msgs.length - 1]
        if (last?.id === streamId.current) {
          return [...msgs.slice(0, -1), { ...last, content: streamBuf.current }]
        }
        streamId.current = crypto.randomUUID()
        streamBuf.current = chunk
        return [...msgs, { id: streamId.current, role: 'pet', content: chunk, timestamp: Date.now() }]
      })
    }
    const onDone = () => { setSending(false); streamBuf.current = '' }
    const onLine = (payload: unknown) => {
      const { line } = payload as { line: string }
      setMessages(msgs => {
        const last = msgs[msgs.length - 1] as CliTaskMessage | undefined
        if (last?.taskType === 'cli-output' && !last.done) {
          return [...msgs.slice(0, -1), { ...last, lines: [...last.lines, line] }]
        }
        return [...msgs, { id: crypto.randomUUID(), role: 'system', content: '', timestamp: Date.now(), taskType: 'cli-output', lines: [line], done: false }]
      })
    }
    const onCliDone = (payload: unknown) => {
      const { exitCode } = payload as { exitCode: number }
      setMessages(msgs => {
        const last = msgs[msgs.length - 1] as CliTaskMessage | undefined
        if (last?.taskType === 'cli-output') return [...msgs.slice(0, -1), { ...last, done: true, exitCode }]
        return msgs
      })
    }
    const onError = (payload: unknown) => {
      const { message } = payload as { message: string }
      setSending(false)
      setMessages(msgs => [...msgs, { id: crypto.randomUUID(), role: 'pet', content: `⚠️ ${message}`, timestamp: Date.now() }])
    }
    window.ipc.on(IPC.CHAT_CHUNK, onChunk)
    window.ipc.on(IPC.CHAT_DONE,  onDone)
    window.ipc.on(IPC.CLI_LINE,   onLine)
    window.ipc.on(IPC.CLI_DONE,   onCliDone)
    window.ipc.on(IPC.CHAT_ERROR, onError)
    return () => {
      window.ipc.off(IPC.CHAT_CHUNK, onChunk)
      window.ipc.off(IPC.CHAT_DONE,  onDone)
      window.ipc.off(IPC.CLI_LINE,   onLine)
      window.ipc.off(IPC.CLI_DONE,   onCliDone)
      window.ipc.off(IPC.CHAT_ERROR, onError)
    }
  }, [])

  const handleSend = useCallback((msg: string) => {
    setSending(true)
    setMessages(m => [...m, { id: crypto.randomUUID(), role: 'user', content: msg, timestamp: Date.now() }])
    window.ipc.invoke(IPC.CHAT_SEND, { message: msg, history: messages.slice(-20) })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1629', color: '#e2e8f0', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#131d30', borderBottom: '1px solid #1e2d45' }}>
        <div style={{ fontSize: 20 }}>🐾</div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f5a623' }}>{pet?.displayName ?? '…'}</div>
          <div style={{ fontSize: 10, color: '#64748b' }}>{sending ? '思考中…' : '空闲'}</div>
        </div>
        <button onClick={() => window.ipc.invoke(IPC.WINDOW_CLOSE_PANEL)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#475569', fontSize: 18, cursor: 'pointer' }}>×</button>
      </div>
      <StatsBar stats={stats} />
      <MessageList messages={messages} />
      <InputBar onSend={handleSend} disabled={sending} />
    </div>
  )
}
```

- [ ] **Step 6: 创建 `src/panel/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 7: 运行验证面板**

```bash
npm run dev
```

点击 lulu → 面板弹出，系统状态条显示数据，可输入消息。

- [ ] **Step 8: Commit**

```bash
git add src/panel/
git commit -m "feat: chat panel with stats bar, message list, streaming CLI output"
```

---

## Task 13: Settings UI

**Files:**
- Create: `src/settings/main.tsx`
- Create: `src/settings/App.tsx`
- Create: `src/settings/PetLibrary.tsx`
- Create: `src/settings/CharacterEditor.tsx`
- Create: `src/settings/ApiSettings.tsx`
- Create: `src/settings/CleanupView.tsx`

- [ ] **Step 1: 创建 `src/settings/App.tsx`（Tab 路由骨架）**

```tsx
import { useState } from 'react'
import { PetLibrary }       from './PetLibrary'
import { CharacterEditor }  from './CharacterEditor'
import { ApiSettings }      from './ApiSettings'
import { CleanupView }      from './CleanupView'

type Tab = 'pets' | 'character' | 'api' | 'cleanup'

const TABS: { id: Tab; label: string }[] = [
  { id: 'pets',      label: '🐾 宠物' },
  { id: 'character', label: '🎭 角色' },
  { id: 'api',       label: '🔌 API' },
  { id: 'cleanup',   label: '🗑 清理' }
]

export function App() {
  const [tab, setTab] = useState<Tab>('pets')
  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', background: '#0f172a', color: '#e2e8f0' }}>
      <nav style={{ width: 120, borderRight: '1px solid #1e293b', paddingTop: 16 }}>
        {TABS.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '9px 16px', fontSize: 12, cursor: 'pointer',
            background: tab === t.id ? '#131d30' : 'transparent',
            borderRight: tab === t.id ? '2px solid #7c3aed' : '2px solid transparent',
            color: tab === t.id ? '#e2e8f0' : '#64748b'
          }}>{t.label}</div>
        ))}
      </nav>
      <main style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
        {tab === 'pets'      && <PetLibrary />}
        {tab === 'character' && <CharacterEditor />}
        {tab === 'api'       && <ApiSettings />}
        {tab === 'cleanup'   && <CleanupView />}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `src/settings/PetLibrary.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { Pet } from '@shared/types'

declare const window: Window & { ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }

export function PetLibrary() {
  const [pets, setPets]       = useState<Pet[]>([])
  const [active, setActive]   = useState<string>('')

  useEffect(() => {
    window.ipc.invoke(IPC.PET_LIST).then(list => setPets(list as Pet[]))
  }, [])

  const select = async (petId: string) => {
    await window.ipc.invoke(IPC.PET_SWITCH, petId)
    setActive(petId)
  }

  const importPet = async () => {
    // Open native dir picker via Electron dialog exposed through IPC
    const dirPath = await window.ipc.invoke('dialog:open-dir') as string | null
    if (!dirPath) return
    const pet = await window.ipc.invoke(IPC.PET_IMPORT, dirPath) as Pet
    setPets(p => [...p, pet])
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>宠物库</h2>
        <button onClick={importPet} style={{ background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>导入宠物</button>
      </div>
      {pets.map(pet => (
        <div key={pet.id} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 12px', marginBottom: 8, borderRadius: 8,
          background: '#1e293b', border: `1px solid ${active === pet.id ? '#f5a623' : '#334155'}`
        }}>
          <div style={{ width: 48, height: 48, background: '#0f172a', borderRadius: 8, overflow: 'hidden' }}>
            {pet.spritesheetDataUrl && (
              <img src={pet.spritesheetDataUrl} style={{ width: 48, height: 'auto', imageRendering: 'pixelated' }} />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{pet.displayName}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{pet.description}</div>
          </div>
          <button onClick={() => select(pet.id)} style={{
            background: active === pet.id ? '#7c3aed' : '#0f172a',
            border: '1px solid #334155', color: active === pet.id ? 'white' : '#94a3b8',
            padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer'
          }}>{active === pet.id ? '使用中' : '选择'}</button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 创建 `src/settings/CharacterEditor.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { CharacterConfig } from '@shared/types'

declare const window: Window & { ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }

const PERSONALITY_TAGS = ['活泼', '可爱', '积极', '严肃', '懒散', '极客', '温柔', '毒舌']

export function CharacterEditor() {
  const [cfg, setCfg] = useState<CharacterConfig | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.ipc.invoke(IPC.CHARACTER_GET, 'stlulu').then(c => setCfg(c as CharacterConfig))
  }, [])

  const save = async () => {
    if (!cfg) return
    await window.ipc.invoke(IPC.CHARACTER_SAVE, cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const toggleTag = (tag: string) => {
    if (!cfg) return
    const has = cfg.personality.includes(tag)
    setCfg({ ...cfg, personality: has ? cfg.personality.filter(t => t !== tag) : [...cfg.personality, tag] })
  }

  if (!cfg) return <div style={{ color: '#64748b' }}>加载中…</div>

  const field = (label: string, key: keyof CharacterConfig, multiline = false) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      {multiline
        ? <textarea value={cfg[key] as string} onChange={e => setCfg({ ...cfg, [key]: e.target.value })} rows={5}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} />
        : <input value={cfg[key] as string} onChange={e => setCfg({ ...cfg, [key]: e.target.value })}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 12 }} />
      }
    </div>
  )

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>角色配置</h2>
      {field('显示名称', 'displayName')}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>性格标签</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PERSONALITY_TAGS.map(tag => (
            <span key={tag} onClick={() => toggleTag(tag)} style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
              background: cfg.personality.includes(tag) ? '#7c3aed' : '#0f172a',
              color: cfg.personality.includes(tag) ? 'white' : '#64748b',
              border: `1px solid ${cfg.personality.includes(tag) ? '#7c3aed' : '#1e293b'}`
            }}>{tag}</span>
          ))}
        </div>
      </div>
      {field('系统 Prompt（角色设定）', 'systemPrompt', true)}
      {field('开场白', 'greeting')}
      <button onClick={save} style={{ background: '#7c3aed', border: 'none', color: 'white', padding: '9px 20px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
        {saved ? '✓ 已保存' : '保存'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: 创建 `src/settings/ApiSettings.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { CharacterConfig, ApiConfig } from '@shared/types'

declare const window: Window & { ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }

export function ApiSettings() {
  const [cfg,    setCfg]    = useState<CharacterConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saved,  setSaved]  = useState(false)

  useEffect(() => {
    window.ipc.invoke(IPC.CHARACTER_GET, 'stlulu').then(c => setCfg(c as CharacterConfig))
    window.ipc.invoke('character:get-api-key', 'stlulu').then(k => setApiKey((k as string) ?? ''))
  }, [])

  const save = async () => {
    if (!cfg) return
    await window.ipc.invoke(IPC.CHARACTER_SAVE, cfg)
    if (apiKey) await window.ipc.invoke('character:save-api-key', { petId: 'stlulu', key: apiKey })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!cfg) return null

  const api = cfg.apiConfig
  const setApi = (patch: Partial<ApiConfig>) => setCfg({ ...cfg, apiConfig: { ...api, ...patch } })

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>API 配置</h2>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>提供商</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['claude', 'openai'] as const).map(p => (
            <div key={p} onClick={() => setApi({ provider: p })} style={{
              padding: '5px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
              background: api.provider === p ? '#1a3a5f' : '#0f172a',
              border: `1px solid ${api.provider === p ? '#60a5fa' : '#1e293b'}`,
              color: api.provider === p ? '#60a5fa' : '#94a3b8'
            }}>{p === 'claude' ? 'Claude (Anthropic)' : 'OpenAI 兼容'}</div>
          ))}
        </div>
      </div>

      {[
        { label: '模型',     val: api.model,    set: (v: string) => setApi({ model: v }), placeholder: api.provider === 'claude' ? 'claude-opus-4-7' : 'gpt-4o' },
        { label: 'Base URL', val: api.baseUrl ?? '', set: (v: string) => setApi({ baseUrl: v }), placeholder: '可选，自定义端点' }
      ].map(({ label, val, set, placeholder }) => (
        <div key={label} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
          <input value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
            style={{ width: '100%', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' }} />
        </div>
      ))}

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>API Key（存储于系统 Keychain）</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-... 或 sk-..."
          style={{ width: '100%', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' }} />
      </div>

      <button onClick={save} style={{ background: '#7c3aed', border: 'none', color: 'white', padding: '9px 20px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
        {saved ? '✓ 已保存' : '保存'}
      </button>
    </div>
  )
}
```

- [ ] **Step 5: 创建 `src/settings/CleanupView.tsx`**

```tsx
import { useState } from 'react'
import { IPC } from '@shared/types'
import type { CleanupItem } from '@shared/types'

declare const window: Window & { ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }

function fmt(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

export function CleanupView() {
  const [items,    setItems]    = useState<CleanupItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [done,     setDone]     = useState(false)

  const scan = async () => {
    setScanning(true); setDone(false); setSelected(new Set())
    const result = await window.ipc.invoke(IPC.CLEANUP_SCAN) as CleanupItem[]
    setItems(result); setScanning(false)
  }

  const execute = async () => {
    if (!confirm(`确认删除 ${selected.size} 个文件？此操作不可撤销。`)) return
    await window.ipc.invoke(IPC.CLEANUP_EXECUTE, [...selected])
    setItems(items.filter(i => !selected.has(i.path)))
    setSelected(new Set()); setDone(true)
  }

  const total = items.filter(i => selected.has(i.path)).reduce((s, i) => s + i.size, 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>磁盘清理</h2>
        <button onClick={scan} disabled={scanning} style={{ background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '5px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          {scanning ? '扫描中…' : '扫描缓存'}
        </button>
      </div>
      {done && <div style={{ color: '#4ade80', marginBottom: 12, fontSize: 12 }}>✓ 清理完成</div>}
      {items.length > 0 && (
        <>
          <div style={{ maxHeight: 320, overflowY: 'auto', marginBottom: 12 }}>
            {items.map(item => (
              <label key={item.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: selected.has(item.path) ? '#1e2d45' : 'transparent' }}>
                <input type="checkbox" checked={selected.has(item.path)}
                  onChange={e => { const s = new Set(selected); e.target.checked ? s.add(item.path) : s.delete(item.path); setSelected(s) }} />
                <span style={{ flex: 1, fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>{fmt(item.size)}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>已选 {fmt(total)} 可释放</span>
            <button onClick={execute} disabled={selected.size === 0} style={{
              background: selected.size > 0 ? '#ef4444' : '#1e293b',
              border: 'none', color: selected.size > 0 ? 'white' : '#475569',
              padding: '7px 16px', borderRadius: 6, fontSize: 12, cursor: selected.size > 0 ? 'pointer' : 'default'
            }}>删除所选</button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 6: 创建 `src/settings/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 7: 在 `ipc.ts` 补充 dialog 和 API key IPC**

在 `electron/ipc.ts` 的 `registerIpcHandlers` 函数末尾添加：

```typescript
  // Dialog for pet import
  ipcMain.handle('dialog:open-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return canceled ? null : filePaths[0]
  })

  // API Key IPC (separate from character config)
  ipcMain.handle('character:get-api-key',  (_, petId: string)                 => chars.getApiKey(petId))
  ipcMain.handle('character:save-api-key', (_, { petId, key }: { petId: string; key: string }) => chars.saveApiKey(petId, key))
```

- [ ] **Step 8: 运行验证设置窗口**

```bash
npm run dev
```

右键 lulu → 打开设置 → 检查四个 tab 均可正常渲染。

- [ ] **Step 9: Commit**

```bash
git add src/settings/
git commit -m "feat: settings UI — pet library, character editor, API config, cleanup"
```

---

## Task 14: 右键菜单 + 拖拽位置持久化

**Files:**
- Modify: `electron/windows.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: 在 `electron/windows.ts` 添加右键菜单**

在 `WindowManager` 类中添加：

```typescript
import { Menu, MenuItem } from 'electron'

// 在 createFloat() 末尾添加：
this.float.webContents.on('context-menu', () => {
  Menu.buildFromTemplate([
    { label: '打开设置', click: () => this.createSettings().show() },
    { label: '隐藏宠物', click: () => this.float?.hide() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]).popup({ window: this.float! })
})
```

- [ ] **Step 2: 持久化窗口位置**

在 `electron/main.ts` 中，在 `wm.createFloat()` 之后添加：

```typescript
import fs from 'fs'
import path from 'path'

const settingsFile = path.join(userData, 'settings.json')
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) } catch { return {} }
}
function saveSettings(data: Record<string, unknown>) {
  fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2))
}

const saved = loadSettings()
if (saved.floatX && saved.floatY) wm.float?.setPosition(saved.floatX, saved.floatY)

wm.float?.on('moved', () => {
  const [x, y] = wm.float!.getPosition()
  saveSettings({ ...loadSettings(), floatX: x, floatY: y })
})
```

- [ ] **Step 3: Commit**

```bash
git add electron/windows.ts electron/main.ts
git commit -m "feat: right-click context menu, persist float window position"
```

---

## Task 15: 全部测试通过 + 打包配置

**Files:**
- Create: `electron-builder.yml`

- [ ] **Step 1: 运行全部测试**

```bash
npm test
```

预期：所有 6 个测试文件 PASS。修复任何失败项后继续。

- [ ] **Step 2: 创建 `electron-builder.yml`**

```yaml
appId: com.petmonitor.app
productName: Pet Monitor
directories:
  output: dist

files:
  - out/**/*
  - assets/**/*

extraResources:
  - from: assets/
    to: assets/

mac:
  category: public.app-category.utilities
  target:
    - target: dmg
    - target: zip

win:
  target:
    - target: nsis
    - target: zip

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 3: 更新 `package.json` 添加 build 命令**

```json
"scripts": {
  "dev":   "electron-vite dev",
  "build": "electron-vite build && electron-builder",
  "test":  "vitest run",
  "pack":  "electron-vite build && electron-builder --dir"
}
```

- [ ] **Step 4: 本地打包验证**

```bash
npm run pack
```

预期：`dist/mac/` 或 `dist/win-unpacked/` 下生成可执行文件。

- [ ] **Step 5: Final commit**

```bash
git add electron-builder.yml package.json
git commit -m "feat: electron-builder packaging for macOS and Windows"
```

---

## 完成检查清单

- [ ] `npm test` 全部通过（monitor / pets / character / runner / cleanup / ai）
- [ ] `npm run dev` 启动后 lulu sprite 出现在屏幕右下角
- [ ] 点击 lulu → 面板弹出，系统状态实时刷新
- [ ] 在面板输入消息 → AI 以宠物角色回复（需 API Key）
- [ ] 输入调用 CLI 的指令 → 看到 stdout 流 → 宠物总结
- [ ] 右键 lulu → 设置窗口打开，四个 tab 均正常
- [ ] 设置中切换宠物 → lulu 立即更新
- [ ] API Key 保存到系统 Keychain（不以明文写入文件）
- [ ] 拖拽宠物，重启后位置保持
- [ ] `npm run pack` 生成安装包
