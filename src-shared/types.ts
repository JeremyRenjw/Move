// Pet format (Codex-compatible, extended with animations)
export interface PetAnimation {
  row: number
  frames: number[]
}

export interface PetEvolution {
  spritesheetPath: string
  frameSize?: { width: number; height: number }
  animations?: {
    idle?: PetAnimation
    talk?: PetAnimation
    working?: PetAnimation
    alert?: PetAnimation
    celebrate?: PetAnimation
  }
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
  evolutions?: Record<string, PetEvolution>  // stage → spritesheet config
  traits?: PetTraits
  // resolved at runtime, not in JSON
  spritesheetDataUrl?: string
  dir?: string
}

export interface GeneratePetInput {
  name: string
  prompt: string
  style?: 'sticker' | 'pixel' | 'anime' | 'plush'
}

// Character config stored per pet
export interface CharacterConfig {
  petId: string
  displayName: string
  personality: string[]
  systemPrompt: string
  greeting: string
  apiConfig?: ApiConfig // legacy compatibility; persisted separately via getApiConfig/saveApiConfig
  traitsOverride?: Partial<PetTraits>
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
export type PetAnimState = 'idle' | 'talk' | 'working' | 'alert' | 'celebrate' | 'jump' | 'spin' | 'dance' | 'wave' | 'cry' | 'laugh' | 'walk' | 'run' | 'bow' | 'sleep' | 'angry' | 'happy' | 'sad'

// ─── Pet mood system ───
export type PetMood = 'happy' | 'calm' | 'tired' | 'worried' | 'excited' | 'lonely'
export type PetStage = 'baby' | 'child' | 'teen' | 'adult' | 'elder'

export interface MoodState {
  mood: PetMood
  energy: number       // 0-100
  affection: number    // 0-100
  xp: number           // experience points (never decreases)
  stage: PetStage      // evolution stage
  lastInteraction: number  // epoch ms
  streak: number       // consecutive interaction days
  updated: number      // epoch ms
}

// Chat messages
export type MessageRole = 'user' | 'pet' | 'system'

export interface ChatAttachment {
  type: 'image' | 'file'
  name: string
  data?: string   // transient payload; image: base64, file: text content
  mime: string    // image/png, text/plain 等
  storageId?: string
  size?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  attachments?: ChatAttachment[]
}

export interface CliTaskMessage extends ChatMessage {
  role: 'system'
  taskType: 'cli-output'
  lines: string[]
  done: boolean
  exitCode?: number
}

export type AgentTaskSchedule = 'manual' | 'interval'
export type AgentTaskStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped'

export interface AgentTask {
  id: string
  title: string
  goal: string
  schedule: AgentTaskSchedule
  intervalMinutes?: number
  enabled: boolean
  approved: boolean
  requireApproval: boolean
  source: 'user' | 'ai'
  allowedTools?: string[]   // tool whitelist; undefined = all allowed
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: AgentTaskStatus
  lastResult?: string
  lastError?: string
}

export interface AgentTaskRun {
  id: string
  taskId: string
  ts: number
  durationMs: number
  status: Exclude<AgentTaskStatus, 'idle' | 'running'>
  result?: string
  error?: string
}

export interface AgentTaskCreateInput {
  title: string
  goal: string
  schedule: AgentTaskSchedule
  intervalMinutes?: number
  enabled?: boolean
  approved?: boolean
  requireApproval?: boolean
  source?: 'user' | 'ai'
  allowedTools?: string[]
}

export interface AgentTaskUpdateInput {
  title?: string
  goal?: string
  schedule?: AgentTaskSchedule
  intervalMinutes?: number
  enabled?: boolean
  approved?: boolean
  requireApproval?: boolean
  allowedTools?: string[]
}

// IPC channel names (use as const for type safety)
export const IPC = {
  // Main → Renderer (via webContents.send)
  MONITOR_STATS:   'monitor:stats',      // SystemStats
  CHAT_CHUNK:      'chat:chunk',         // { chunk: string }
  CHAT_TURN:       'chat:turn',          // void — end of one AI turn; reset stream buffer without ending the whole send
  CHAT_DONE:       'chat:done',          // void
  CHAT_ERROR:      'chat:error',         // { message: string }
  CLI_LINE:        'cli:line',           // { line: string }
  CLI_DONE:        'cli:done',           // { exitCode: number; output: string }
  CLI_WAITING:     'cli:waiting',        // { prompt: string } — CLI 正在等用户输入
  WATCHER_NOTE:    'watcher:note',       // WatcherNote — main → renderer, AI's running commentary on the CLI
  CHAT_NEW:        'chat:new',           // void — clear messages, start fresh conversation
  PET_ACTIVE_CHANGED: 'pet:active-changed', // Pet  (main → renderer broadcast)
  CHARACTER_CHANGED:  'character:changed',  // CharacterConfig (main → renderer broadcast，update_character 或 CHARACTER_SAVE 后)
  AGENT_TASK_RAN:      'agent-task:ran',      // { task: AgentTask; run: AgentTaskRun }
  PET_EVOLVED:        'pet:evolved',         // { stage: PetStage, xp: number }
  MOOD_CHANGED:       'mood:changed',        // { mood: PetMood }
  PET_DISPLAY_STATE:  'pet:display-state',   // PetDisplayInfo — state machine driven
  DRIVE_GOAL:         'drive:goal',          // { goal: PetGoal } — main → renderer
  PET_ACTION:         'pet:action',          // { action: string } — main → renderer

  // Renderer → Main (via ipcRenderer.invoke)
  PET_LIST:           'pet:list',           // → Pet[]
  PET_GET_ACTIVE:     'pet:get-active',     // → string | null
  PET_SWITCH:         'pet:switch',         // petId: string → void
  PET_IMPORT:         'pet:import',         // dirPath: string → Pet
  PET_GENERATE:       'pet:generate',       // GeneratePetInput → Pet
  CHARACTER_GET:      'character:get',      // petId: string → CharacterConfig
  CHARACTER_SAVE:     'character:save',     // CharacterConfig → void
  API_CONFIG_GET:     'api-config:get',     // → ApiConfig
  API_CONFIG_SAVE:    'api-config:save',    // ApiConfig → void
  MEMORY_FLUSH:       'memory:flush',       // history: ChatMessage[] → void (renderer → main, fire-and-forget summarize)
  CLI_INPUT:          'cli:input',          // { text: string } → void (renderer → main, deliver stdin to running CLI)
  CLI_ABORT:          'cli:abort',          // → void (renderer → main, kill running CLI)
  CHAT_SEND:          'chat:send',          // { message: string; history: ChatMessage[] } → void
  CLEANUP_SCAN:       'cleanup:scan',       // → CleanupItem[]
  CLEANUP_EXECUTE:    'cleanup:execute',    // paths: string[] → void
  WINDOW_OPEN_PANEL:  'window:open-panel',  // → void
  WINDOW_CLOSE_PANEL: 'window:close-panel', // → void
  WINDOW_OPEN_SETTINGS: 'window:open-settings', // → void
  WINDOW_SET_POSITION:  'window:set-position',  // { x, y } → void

  // Notify hooks (Renderer → Main)
  NOTIFY_HOOK_GET_STATUS: 'notify:hook:get-status', // → HookInstallStatus[]
  NOTIFY_HOOK_INSTALL:    'notify:hook:install',    // tool: 'claude'|'codex'|'both' → void (throws on user-config parse failure)
  NOTIFY_HOOK_UNINSTALL:  'notify:hook:uninstall',  // tool: 'claude'|'codex'|'both' → void
  NOTIFY_TEST_EVENT:      'notify:test-event',      // → void (writes a synthetic Stop event file)
  NOTIFY_RECENT_EVENTS:   'notify:recent-events',   // → NotifyEvent[] (最多 20 条，仅内存)
  NOTIFY_RUNTIME_INFO:    'notify:runtime-info',    // → RuntimeInfo
  NOTIFY_SOURCES_GET:    'notify:sources:get',    // → Record<string, boolean>
  NOTIFY_SOURCES_SAVE:   'notify:sources:save',   // { sources: Record<string, boolean> } → void

  // Auto-start
  AUTOSTART_GET: 'autostart:get',    // → boolean
  AUTOSTART_SET: 'autostart:set',    // enabled: boolean → void

  // Notification unread state (Main → Renderer)
  NOTIFICATION_UNREAD:  'notification:unread',   // { count: number } — broadcast to float
  // Notification clear (Renderer → Main)
  NOTIFICATION_CLEAR:   'notification:clear',    // → void — mark all as read

  // Agent background tasks
  AGENT_TASKS_LIST:    'agent-tasks:list',    // → AgentTask[]
  AGENT_TASKS_CREATE:  'agent-tasks:create',  // AgentTaskCreateInput → AgentTask
  AGENT_TASKS_UPDATE:  'agent-tasks:update',  // { id, patch } → AgentTask
  AGENT_TASKS_DELETE:  'agent-tasks:delete',  // id → void
  AGENT_TASKS_APPROVE: 'agent-tasks:approve', // id → AgentTask
  AGENT_TASKS_RUN:     'agent-tasks:run',     // id → AgentTaskRun
  AGENT_TASK_RUNS:     'agent-tasks:runs',    // taskId? → AgentTaskRun[]
} as const

export interface NotificationEvent {
  source: 'wechat' | 'wework' | 'watcher'
  label: string  // displayed in bubble, e.g. "微信有新消息"
  timestamp: number
}

export type WatcherStatus = 'ok' | 'stuck' | 'error' | 'needs_user'

export interface WatcherNote {
  status: WatcherStatus
  note: string         // 1-sentence human-readable comment
  timestamp: number
}

export interface CleanupItem {
  path: string
  size: number       // bytes
  label: string
}

// ─── CLI Hook 看门狗 ───

export type EventKind =
  | 'session_start' | 'session_end'
  | 'user_prompt'
  | 'pre_tool_use' | 'post_tool_use'
  | 'thinking_start'
  | 'permission_ask' | 'permission_resolved'
  | 'ask_user' | 'ask_user_resolved'
  | 'stop' | 'error'
  | 'notification'

/** @deprecated use EventKind */
export type NotifyEventName =
  | 'Stop'
  | 'Notification'
  | 'PermissionRequest'
  | 'SessionStart'
  | 'Error'

export type NotifyToolName = 'claude' | 'codex' | 'test'

export interface NotifyEvent {
  event:      NotifyEventName
  tool:       NotifyToolName
  cwd:        string
  ts:         number
  sessionId?: string
  payload?:   Record<string, unknown>
  extra?:     Record<string, unknown>
}

// ─── Pet display state machine (inspired by Hopet) ───

export type PetDisplayState =
  | 'idle' | 'thinking' | 'responding' | 'tool_use'
  | 'permission_prompt' | 'ask_user' | 'completed' | 'error'

export const PET_STATE_PRIORITY: Record<PetDisplayState, number> = {
  ask_user:          0,
  permission_prompt: 1,
  error:             2,
  tool_use:          3,
  thinking:          4,
  responding:        5,
  completed:         6,
  idle:              7,
}

export interface PetDisplayInfo {
  state:            PetDisplayState
  drivenBySessionId?: string
  label:            string
}

export interface SessionInfo {
  id:            string
  tool:          NotifyToolName
  cwd:           string
  currentState:  PetDisplayState
  stateSince:    number     // epoch ms
  lastActivityAt: number    // epoch ms
  title?:        string
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
  wrapperPath: string     // ~/.mote/bin/event
  eventsDir:   string     // ~/.mote/events
}

// ─── Pet drive system (autonomous goals) ───

export type PetGoalKind =
  | 'greet'           // 打招呼/想念
  | 'check_in'        // 例行关心
  | 'comfort'         // 安慰
  | 'curiosity'       // 好奇心驱动
  | 'celebrate'       // 庆祝成就
  | 'remind_rest'     // 提醒休息
  | 'system_check'    // 系统状态异常

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

// ─── Pet personality traits ───
export interface PetTraits {
  sociability:       number  // 0-1, default 0.5 — 对人的依恋/求关注程度
  independence:      number  // 0-1, default 0.5 — 对独处的耐受度
  playfulness:       number  // 0-1, default 0.5 — 庆祝/好奇/玩闹倾向
  energy_volatility: number  // 0-1, default 0.5 — 体力波动剧烈程度
}

// Runtime knobs derived from PetTraits via traitsToParams().
// Engines read these instead of hardcoded constants.
export interface DriveParams {
  lonelyHoursThreshold:        number
  energyDecayPerHour:          number
  energyRecoveryChat:          number
  greetAffectionThreshold:     number
  greetHoursThreshold:         number
  checkInHoursThreshold:       number
  curiosityAffectionThreshold: number
  goalKindMultipliers: Partial<Record<PetGoal['kind'], number>>
  cooldownMsByKind:    Partial<Record<PetGoal['kind'], number>>
}

// ─── Pet brain: 事件流 + 结构化记忆 ───

export type EventType =
  | 'chat_turn'
  | 'cli_task'
  | 'agent_task'
  | 'hook_signal'
  | 'system_snapshot'
  | 'reflector_tick'
  | 'agenda_tick'
  | 'user_feedback'
  | 'playbook_created'
  | 'playbook_used'

export type EventSource = 'chat' | 'cli' | 'hook' | 'system' | 'reflector' | 'user'

export interface PetEvent {
  id:     string             // uuid v4
  ts:     number             // epoch ms
  type:   EventType
  source: EventSource
  data:   Record<string, unknown>
}

export type MemoryFactType =
  | 'user_profile'
  | 'preference'
  | 'project'
  | 'event'
  | 'feedback'

export interface MemoryFact {
  id:            string
  ts:            number
  type:          MemoryFactType
  content:       string
  confidence:    number          // 0..1
  source: {
    eventId?: string
    note?:    string             // 'summarized' | 'user-said' | 'corrected'
  }
  superseded_by?: string         // 被新 fact 取代时指向新 id
}
