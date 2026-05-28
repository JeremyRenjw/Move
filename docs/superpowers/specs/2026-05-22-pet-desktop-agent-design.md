# 桌面宠物 AI 代理 — 设计规格

**日期：** 2026-05-22  
**状态：** 待实现  

---

## 1. 产品概述

一个跨平台桌面宠物应用（macOS + Windows），宠物悬浮在所有窗口之上，兼具系统监控、AI 对话和 CLI 代理三项能力。用户与宠物直接对话，宠物可调用本地 `claude`（Claude Code CLI）或 `codex`（Codex CLI）执行任务，完成后汇报结果。

**技术栈：** Electron + React + TypeScript  
**宠物格式：** 与 Codex 完全兼容（`pet.json` + `spritesheet.webp`）

---

## 2. 核心功能

### 2.1 悬浮宠物窗口

- 透明无边框 always-on-top 窗口，macOS 和 Windows 均支持
- 宠物 sprite 动画，帧状态映射到系统状态：
  - 待机 → 默认循环动画
  - 说话 → 说话动画帧
  - 工作中（CLI 运行）→ 忙碌动画帧
  - CPU/RAM 告警 → 紧张/惊慌动画帧
  - 任务完成 → 庆祝动画帧
- 状态指示点（绿/橙/红）叠加在宠物上
- 右键菜单：打开设置、隐藏宠物、退出
- 可自由拖拽到屏幕任意位置，位置持久化

### 2.2 展开面板（点击宠物触发）

分三个区域：

**系统状态条**
- CPU 使用率、RAM 使用率、磁盘使用率（百分比 + 进度条）
- Claude Code CLI 和 Codex CLI 进程运行状态（运行中 / 未运行）
- 每 2 秒轮询刷新

**对话区**
- 消息气泡形式，宠物消息在左，用户消息在右
- CLI 任务运行时显示内嵌输出块，实时流式显示 stdout
- 任务完成后宠物以角色口吻总结结果

**输入框**
- 单行输入，回车发送
- 发送后宠物先以 AI 角色理解意图，再决定：直接回答 / 调用 CLI

### 2.3 AI 对话引擎

- 支持两种 API 协议：
  - **Claude**：Anthropic SDK，`anthropic` 包
  - **OpenAI 兼容**：`openai` 包，支持自定义 `base_url`
- 每个宠物携带独立的 system prompt（角色设定）
- 系统状态（CPU/RAM/进程）自动注入对话上下文
- 对话历史保留在内存，切换宠物时清空

### 2.4 CLI 代理

宠物通过 AI 决策调用本地 CLI：

1. 用户输入发给 AI，AI 通过 **function calling** 决定是否调用 CLI（工具定义：`run_claude_code(prompt, workdir)` / `run_codex(prompt, workdir)`）
2. AI 选择调用工具时，主进程通过 `child_process.spawn` 执行对应命令
3. stdout / stderr 实时通过 IPC 推送到渲染层展示
4. 进程退出后，AI 读取完整输出生成总结，以宠物角色回复用户
5. 支持 `claude`（Claude Code CLI）和 `codex`（Codex CLI）两种命令
6. 任务超时控制：默认 5 分钟，可配置
7. 同一时刻只运行一个 CLI 任务（队列排队）

### 2.5 系统监控与清理

**监控（每 2 秒轮询，使用 `systeminformation` npm 包）**
- CPU 使用率
- RAM 已用 / 总量
- 磁盘使用率（主分区）
- 进程列表中检测 `claude` / `codex` 进程

**清理（用户主动触发）**
- 扫描系统缓存目录（macOS: `~/Library/Caches`，Windows: `%TEMP%`）
- 扫描结果展示可释放空间，用户确认后删除
- 操作前需二次确认，不自动删除

### 2.6 宠物管理

**宠物格式（与 Codex 兼容）**

```
pets/
  stlulu/
    pet.json          # 见下方格式
    spritesheet.webp  # 精灵图（网格排列，行优先）
```

`pet.json` 格式（扩展 Codex 格式，向后兼容）：

```json
{
  "id": "stlulu",
  "displayName": "lulu",
  "description": "活泼的黄橙色小助手",
  "spritesheetPath": "spritesheet.webp",
  "kind": "animal",
  "frameSize": { "width": 80, "height": 80 },
  "animations": {
    "idle":     { "row": 0, "frames": [0, 1, 2, 3] },
    "talk":     { "row": 1, "frames": [0, 1, 2] },
    "working":  { "row": 2, "frames": [0, 1, 2, 3] },
    "alert":    { "row": 3, "frames": [0, 1] },
    "celebrate":{ "row": 4, "frames": [0, 1, 2] }
  }
}
```

`animations` 字段为可选；缺失时退回静态显示第 0 帧。

**宠物库功能**
- 内置宠物：lulu（stlulu）、桃桃（taotao），开箱可用
- 导入：选择包含 `pet.json` + `spritesheet.webp` 的目录
- 每个宠物可独立配置角色（见 2.7）
- 切换宠物后悬浮窗口立即更新

### 2.7 角色配置

每个宠物携带独立的角色配置，保存为 JSON：

```json
{
  "petId": "stlulu",
  "displayName": "lulu",
  "personality": ["活泼", "可爱", "积极"],
  "systemPrompt": "你是 lulu，一只活泼可爱的助手宠物...",
  "greeting": "你好呀～我是 lulu！",
  "apiConfig": {
    "provider": "claude",
    "model": "claude-opus-4-7",
    "apiKey": "...",
    "baseUrl": ""
  }
}
```

- **性格标签**：多选，内置标签（活泼/严肃/可爱/极客等），影响 AI 生成的 system prompt 提示
- **System Prompt**：用户可直接编辑，完全自由
- **API 配置**：provider（claude / openai）、model、apiKey、baseUrl（可选）
- API Key 存储在系统 Keychain（macOS Keychain / Windows Credential Store）

---

## 3. 技术架构

```
Electron Main Process
├── WindowManager        透明浮窗 + 设置窗口生命周期
├── SystemMonitor        CPU/RAM/Disk/Process 轮询（2s）
├── CliRunner            spawn claude/codex，管理 stdout 流
├── PetManager           加载/切换宠物，读写角色配置
├── CleanupEngine        扫描缓存目录，执行删除
└── IPC Bridge           主进程 ↔ 渲染进程通信

Electron Renderer (React + TypeScript)
├── FloatWindow          悬浮宠物（透明窗口）
│   ├── SpritePlayer     spritesheet 动画播放器
│   └── StatusDot        状态指示点
├── ChatPanel            展开面板
│   ├── StatsBar         系统状态条
│   ├── MessageList      对话消息流
│   ├── TaskOutput       CLI 输出块（流式）
│   └── InputBar         输入框
└── SettingsWindow       设置窗口
    ├── PetLibrary        宠物库 + 导入
    ├── CharacterEditor   角色配置编辑器
    ├── ApiSettings       API 配置
    └── CleanupView       清理面板

数据持久化（路径由 Electron app.getPath('userData') 决定，跨平台自动适配）
├── {userData}/pets/          宠物目录（兼容 Codex 格式）
├── {userData}/characters/    角色配置 JSON
├── {userData}/settings.json  全局配置（窗口位置等）
└── 系统 Keychain              API Key 安全存储（macOS Keychain / Windows Credential Store）
```

---

## 4. 关键数据流

### 用户发消息 → 宠物回复

```
用户输入
  → Renderer IPC → Main
  → AI 引擎（携带 system prompt + 系统状态上下文）
  → AI 判断：直接回答 OR spawn CLI
    ├── 直接回答 → 流式文字 → Renderer 气泡
    └── spawn CLI → 实时 stdout → Renderer 输出块
                 → CLI 退出 → AI 总结 → Renderer 气泡
```

### 系统状态 → 宠物动画

```
SystemMonitor 轮询（2s）
  → IPC 推送状态到 FloatWindow
  → SpritePlayer 根据状态切换动画帧
  → StatusDot 更新颜色
```

---

## 5. 错误处理

- CLI 命令不存在（`claude`/`codex` 未安装）：面板显示安装提示，不崩溃
- API Key 无效：对话区显示错误气泡，不影响系统监控功能
- CLI 超时（> 5 分钟）：自动终止进程，宠物提示超时
- 系统监控失败：静默降级，面板显示 `--` 占位

---

## 6. 不在范围内（本期不做）

- AI 生成宠物 sprite（图像生成）
- 宠物间多角色同时在线
- 云同步角色配置
- 插件系统
- 移动端

---

## 7. 项目结构（初始）

```
pet-monitor-app/
├── package.json
├── electron/
│   ├── main.ts              Electron 入口
│   ├── windowManager.ts
│   ├── systemMonitor.ts
│   ├── cliRunner.ts
│   ├── petManager.ts
│   ├── cleanupEngine.ts
│   └── ipcHandlers.ts
├── src/
│   ├── float/               悬浮窗 React App
│   │   ├── App.tsx
│   │   ├── SpritePlayer.tsx
│   │   └── StatusDot.tsx
│   ├── panel/               展开面板 React App
│   │   ├── ChatPanel.tsx
│   │   ├── StatsBar.tsx
│   │   ├── MessageList.tsx
│   │   └── TaskOutput.tsx
│   └── settings/            设置窗口 React App
│       ├── PetLibrary.tsx
│       ├── CharacterEditor.tsx
│       └── ApiSettings.tsx
├── assets/
│   └── pets/
│       ├── stlulu/
│       └── taotao/
└── docs/
    └── superpowers/specs/
        └── 2026-05-22-pet-desktop-agent-design.md
```
