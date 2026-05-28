import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { CharacterConfig, ApiConfig, SystemStats, ChatMessage, WatcherStatus, ChatAttachment, PetGoalKind } from '@shared/types'
import { ToolExecutor } from './tool-executor'
import type { ToolResult } from './tool-executor'

/** Build multimodal content array for Claude/OpenAI from text + attachments */
function buildUserContent(text: string, attachments?: ChatAttachment[]): string | Anthropic.ContentBlockParam[] {
  if (!attachments || attachments.length === 0) return text

  const blocks: Anthropic.ContentBlockParam[] = [{ type: 'text', text }]

  for (const a of attachments) {
    if (a.type === 'image') {
      if (!a.data) continue
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mime as Anthropic.ImageMediaTypes, data: a.data }
      })
    } else {
      blocks.push({ type: 'text', text: `[附件: ${a.name}]\n${a.data ?? ''}` })
    }
  }

  return blocks
}

/** Convert attachments to OpenAI vision format */
function buildOpenAIContent(text: string, attachments?: ChatAttachment[]): string | OpenAI.ChatCompletionContentPart[] {
  if (!attachments || attachments.length === 0) return text

  const parts: OpenAI.ChatCompletionContentPart[] = [{ type: 'text', text }]

  for (const a of attachments) {
    if (a.type === 'image') {
      if (!a.data) continue
      parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}`, detail: 'auto' } })
    } else {
      parts.push({ type: 'text', text: `[附件: ${a.name}]\n${a.data ?? ''}` })
    }
  }

  return parts
}
import type { FactStore } from './fact-store'
import type { PlaybookStore } from './playbook-store'

/** Convert Anthropic tool definitions to OpenAI function calling format */
function toOpenAITools(tools: Anthropic.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: (t.input_schema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    }
  }))
}

export interface ReflectorDecision {
  action: 'silent' | 'propose'
  bubble?: string
  detail?: string
}

export interface PlannedGoal {
  kind:         PetGoalKind
  bubble?:      string
  agentGoal?:   string
  priority:     number
  delayMinutes: number
  ttlMinutes:   number
  reason:       string
}

export interface PlanAgendaResult {
  goals:         PlannedGoal[]
  silentReason?: string
}

const VALID_KINDS = new Set<PetGoalKind>([
  'greet', 'check_in', 'comfort', 'curiosity', 'celebrate', 'remind_rest', 'system_check'
])

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function extractJsonBlob(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace  = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1)
  return text.trim()
}

export function parsePlanAgendaResponse(raw: string): PlanAgendaResult {
  let parsed: any
  try {
    parsed = JSON.parse(extractJsonBlob(raw))
  } catch {
    return { goals: [], silentReason: 'parse_error' }
  }
  if (!parsed || !Array.isArray(parsed.goals)) {
    return { goals: [], silentReason: 'no_goals_array' }
  }
  const cleaned: PlannedGoal[] = []
  for (const g of parsed.goals) {
    if (!g || typeof g !== 'object') continue
    if (!VALID_KINDS.has(g.kind)) continue
    if (typeof g.priority !== 'number' || typeof g.delayMinutes !== 'number' || typeof g.ttlMinutes !== 'number') continue
    cleaned.push({
      kind:         g.kind,
      bubble:       typeof g.bubble === 'string' ? g.bubble : undefined,
      agentGoal:    typeof g.agentGoal === 'string' ? g.agentGoal : undefined,
      priority:     clamp(Math.round(g.priority), 0, 100),
      delayMinutes: Math.max(0, Math.round(g.delayMinutes)),
      ttlMinutes:   Math.max(1, Math.round(g.ttlMinutes)),
      reason:       typeof g.reason === 'string' ? g.reason : '',
    })
  }
  cleaned.sort((a, b) => b.priority - a.priority)
  const top = cleaned.slice(0, 3)
  const out: PlanAgendaResult = { goals: top }
  if (top.length === 0 && typeof parsed.silentReason === 'string') {
    out.silentReason = parsed.silentReason
  }
  return out
}

const VALID_FACT_TYPES = new Set(['user_profile', 'preference', 'project', 'event', 'feedback'])

export interface ExtractedFact {
  type:       'user_profile' | 'preference' | 'project' | 'event' | 'feedback'
  content:    string
  confidence: number
}

export function parseFactsBlock(text: string): ExtractedFact[] {
  const m = text.match(/```facts\s*\n([\s\S]*?)\n```/)
  if (!m) return []
  let arr: unknown
  try { arr = JSON.parse(m[1]) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const out: ExtractedFact[] = []
  for (const item of arr) {
    const o = item as { type?: string; content?: string; confidence?: number }
    if (!o || typeof o.content !== 'string' || !o.content.trim()) continue
    if (typeof o.type !== 'string' || !VALID_FACT_TYPES.has(o.type)) continue
    const c = Math.max(0, Math.min(1, Number(o.confidence ?? 0.5)))
    out.push({ type: o.type as ExtractedFact['type'], content: o.content.trim(), confidence: c })
  }
  return out
}

export function stripFactsBlock(text: string): string {
  return text.replace(/```facts\s*\n[\s\S]*?\n```\s*/g, '').trim()
}

function parseReply(text: string): string | null {
  const match = text.match(/\{[^}]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { reply?: string | null }
    if (!obj.reply) return null
    const r = String(obj.reply).trim().toLowerCase()
    if (['y', 'yes', 'n', 'no'].includes(r)) return r
    return null
  } catch {
    return null
  }
}

function parseJudge(text: string): { status: WatcherStatus; note: string } | null {
  const match = text.match(/\{[^}]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { status?: string; note?: string }
    const validStatuses: WatcherStatus[] = ['ok', 'stuck', 'error', 'needs_user']
    if (!validStatuses.includes(obj.status as WatcherStatus)) return null
    return { status: obj.status as WatcherStatus, note: String(obj.note ?? '').slice(0, 200) }
  } catch {
    return null
  }
}

function parseReflector(text: string): ReflectorDecision {
  const SILENT: ReflectorDecision = { action: 'silent' }
  if (!text || text === 'NONE') return SILENT
  const match = text.match(/\{[^}]*\}/)
  if (!match) return SILENT
  try {
    const obj = JSON.parse(match[0]) as { action?: string; bubble?: string; detail?: string }
    if (obj.action === 'silent') return SILENT
    if (obj.action === 'propose') {
      const bubble = String(obj.bubble ?? '').slice(0, 28)
      if (!bubble) return SILENT
      return { action: 'propose', bubble, detail: String(obj.detail ?? '') }
    }
    return SILENT
  } catch {
    return SILENT
  }
}

const BUBBLE_KIND_HINTS: Record<string, string> = {
  greet:       '主动打招呼，表达"看到用户回来了"。',
  comfort:     '感到孤单，对用户表达想念和陪伴渴望。',
  remind_rest: '提醒用户该休息了（夜深 / 体力低）。',
  curiosity:   '好奇主动搭话，想分享或了解用户。',
  check_in:    '关心用户最近怎么样，礼貌问候。',
}

const BUBBLE_LEADIN_RE = /^(?:好的|好[，,]|当然|那[，,]?|嗯[，,]|let me|sure[,.]?\s*|here\s+is)\s*/i

export function truncateBubble(text: string): string | null {
  let t = text.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim()
  t = t.replace(/^["「『"'']+|["」』"'']+$/g, '').trim()
  t = t.replace(BUBBLE_LEADIN_RE, '').trim()
  if (t.length > 60) {
    const slice = t.slice(0, 60)
    const lastPunc = Math.max(
      slice.lastIndexOf('。'), slice.lastIndexOf('！'),
      slice.lastIndexOf('？'), slice.lastIndexOf('…'),
      slice.lastIndexOf('~'),  slice.lastIndexOf('～'),
    )
    t = lastPunc > 4 ? slice.slice(0, lastPunc + 1) : slice
  }
  if (t.length < 4) return null
  return t
}

export interface GeneratedPetImage {
  bytes: Buffer
  extension: 'png' | 'jpeg' | 'webp'
}

function imageBase64Payload(value: string): { b64: string; extension?: GeneratedPetImage['extension'] } {
  const match = value.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/)
  if (!match) return { b64: value }
  return {
    b64: match[2],
    extension: match[1] === 'jpg' ? 'jpeg' : match[1] as GeneratedPetImage['extension'],
  }
}

function findGeneratedImageBase64(value: unknown): string | null {
  if (!value) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGeneratedImageBase64(item)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null

  const obj = value as Record<string, unknown>
  if (obj.type === 'image_generation_call' && typeof obj.result === 'string' && obj.result) {
    return obj.result
  }
  if (typeof obj.b64_json === 'string' && obj.b64_json) return obj.b64_json
  if (typeof obj.image_base64 === 'string' && obj.image_base64) return obj.image_base64

  for (const key of ['output', 'data', 'content', 'result', 'image']) {
    const found = findGeneratedImageBase64(obj[key])
    if (found) return found
  }
  return null
}

function generatedImageExtension(value: unknown, fallback: GeneratedPetImage['extension'] = 'png'): GeneratedPetImage['extension'] {
  if (!value || typeof value !== 'object') return fallback
  const obj = value as Record<string, unknown>
  if (obj.output_format === 'webp') return 'webp'
  if (obj.output_format === 'jpeg' || obj.output_format === 'jpg') return 'jpeg'
  if (obj.output_format === 'png') return 'png'
  return fallback
}

function readRasterSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    const data = 20
    if (chunk === 'VP8X' && bytes.length >= data + 10) {
      const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16)
      const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16)
      return { width, height }
    }
    if (chunk === 'VP8 ' && bytes.length >= data + 10) {
      return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff }
    }
    if (chunk === 'VP8L' && bytes.length >= data + 5) {
      const b1 = bytes[data + 1]
      const b2 = bytes[data + 2]
      const b3 = bytes[data + 3]
      const b4 = bytes[data + 4]
      const width = 1 + b1 + ((b2 & 0x3f) << 8)
      const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))
      return { width, height }
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2) return null
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return null
}

function assertAtlasSize(bytes: Buffer): void {
  const size = readRasterSize(bytes)
  if (!size) {
    throw new Error('图片模型返回的数据不是可识别的 PNG/JPEG/WebP spritesheet')
  }
  if (size.width !== 1536 || size.height !== 1872) {
    throw new Error(`图片模型返回了 ${size.width}x${size.height}，不是宠物需要的 1536x1872 spritesheet`)
  }
}

function openAIBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

function openAIRawBaseUrl(baseUrl?: string): string | null {
  if (!baseUrl) return null
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

function extractApiErrorMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 240)
  if (!body || typeof body !== 'object') return ''
  const obj = body as Record<string, unknown>
  const err = obj.error
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e.message === 'string') return e.message
    if (typeof e.type === 'string') return e.type
  }
  if (typeof obj.message === 'string') return obj.message
  return ''
}

function apiErrorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

const MEMORY_INSTRUCTION = `下面是对话历史。请挑出**值得长期记住**的事实，按这些类别合并到现有记忆里：
- 用户偏好（工具、风格、习惯）
- 用户身份/背景（角色、技术栈、项目）
- 重要事件或决定
- 用户给你的反馈（什么该做、什么不该做）

要求：
- markdown 列表格式，每条一行
- 不要保存当前任务细节、闲聊、临时上下文
- 与现有记忆重复的不要写
- 没什么值得记的就回复一个字符串"NONE"

现有记忆：
{{EXISTING}}

对话历史：
{{HISTORY}}

输出格式：先输出 markdown 列表（人类阅读），如果有可结构化的事实，**额外**在末尾追加一个 fenced 代码块：

\`\`\`facts
[
  {"type":"preference|user_profile|project|event|feedback","content":"一句话事实","confidence":0.0-1.0}
]
\`\`\`

如果完全没东西记，只输出 NONE，没别的。`

export interface ProposedPlaybook {
  slug:       string   // kebab-case, e.g. "cleanup-downloads"
  title:      string
  triggers:   string[]
  body:       string   // full markdown body (after frontmatter)
  confidence: number
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function parseProposedPlaybook(text: string): ProposedPlaybook | null {
  if (!text || text.trim() === 'NONE') return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (typeof obj.slug !== 'string' || !KEBAB_RE.test(obj.slug)) return null
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null
  if (!Array.isArray(obj.triggers) || obj.triggers.length === 0) return null
  if (!obj.triggers.every((t: unknown) => typeof t === 'string')) return null
  if (typeof obj.body !== 'string' || !obj.body.trim()) return null
  const conf = Number(obj.confidence)
  if (Number.isNaN(conf) || conf < 0 || conf > 1) return null
  return {
    slug:       obj.slug as string,
    title:      (obj.title as string).trim(),
    triggers:   obj.triggers as string[],
    body:       (obj.body as string).trim(),
    confidence: conf
  }
}

export interface ToolCall {
  tool:  string
  input: Record<string, unknown>
}

export interface ChatResult {
  text:      string
  toolCalls: ToolCall[]
}

export interface AgentResult {
  text:            string
  rounds:          number
  toolExecutions:  ToolResult[]
  cliCalls:        ToolCall[]   // run_claude_code / run_codex to be handled by IPC
  petActions:      string[]     // pet_action names (dance, celebrate, etc.)
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Execute a shell command. Returns stdout and stderr. 30s timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (defaults to home)' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates dirs if needed, overwrites existing).',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List directory contents (dirs end with /).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description: 'Find and replace text in a file. Provide the exact text to find and the replacement. The old_text must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'Absolute file path' },
        old_text: { type: 'string', description: 'Exact text to find and replace' },
        new_text: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'query_facts',
    description: 'Query your memory facts. Returns structured facts about the user, projects, preferences, and events.',
    input_schema: {
      type: 'object',
      properties: {
        type:  { type: 'string', description: 'Filter by type: user_profile|preference|project|event|feedback (optional)' },
        limit: { type: 'number', description: 'Max facts to return (default 20)' }
      }
    }
  },
  {
    name: 'remember',
    description: 'Save a new fact to memory. Use for things the user tells you to remember or things you learn from conversations.',
    input_schema: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: 'One-line fact to remember' },
        type:       { type: 'string', description: 'user_profile|preference|project|event|feedback' },
        confidence: { type: 'number', description: '0-1, how sure you are (default 0.7)' }
      },
      required: ['content', 'type']
    }
  },
  {
    name: 'forget',
    description: 'Delete a fact from memory by its ID.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Fact ID to delete' } },
      required: ['id']
    }
  },
  {
    name: 'list_playbooks',
    description: 'List all learned skills/playbooks with their titles and trigger conditions.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'view_playbook',
    description: 'Read the full content of a playbook by its ID.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Playbook ID' } },
      required: ['id']
    }
  },
  {
    name: 'create_playbook',
    description: 'Create a new playbook with triggers and instructions. Use after completing a non-trivial task that you want to remember how to do.',
    input_schema: {
      type: 'object',
      properties: {
        slug:      { type: 'string', description: 'kebab-case identifier' },
        title:     { type: 'string', description: 'Human-readable title' },
        triggers:  { type: 'array', items: { type: 'string' }, description: 'When this playbook should be used' },
        body:      { type: 'string', description: 'Markdown body with steps and notes' },
        confidence: { type: 'number', description: '0-1 (default 0.7)' }
      },
      required: ['slug', 'title', 'triggers', 'body']
    }
  },
  {
    name: 'update_playbook',
    description: 'Update an existing playbook body. Use when you find better steps or want to add notes.',
    input_schema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Playbook ID' },
        body: { type: 'string', description: 'New markdown body' }
      },
      required: ['id', 'body']
    }
  },
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
  },
  {
    name: 'install_skill',
    description: 'Install an external skill as a markdown file. Use when user asks to install a skill from GitHub, skillhub, URL, or any external source.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Skill name (kebab-case)' },
        description: { type: 'string', description: 'One-line description' },
        triggers:    { type: 'array', items: { type: 'string' }, description: 'Keywords that trigger this skill' },
        content:     { type: 'string', description: 'Full markdown body content' }
      },
      required: ['name', 'description', 'triggers', 'content']
    }
  },
  {
    name: 'update_character',
    description: '修改宠物角色配置。可修改字段：displayName(显示名)、personality(性格标签数组)、greeting(问候语)、systemPrompt(提示词)。只传需要改的字段。',
    input_schema: {
      type: 'object',
      properties: {
        displayName:  { type: 'string', description: '显示名' },
        personality:  { type: 'array', items: { type: 'string' }, description: '性格标签，如 ["活泼","可爱"]' },
        greeting:     { type: 'string', description: '问候语' },
        systemPrompt: { type: 'string', description: 'System prompt' }
      }
    }
  },
  {
    name: 'create_agent_task',
    description: '创建后台 Agent 任务。仅当用户明确要求“以后/定时/持续/后台/每天/每隔一段时间帮我做某事”时使用。创建后默认需要用户在设置里审批。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短任务标题' },
        goal: { type: 'string', description: '后台任务每次运行时要观察、分析或提醒的目标' },
        schedule: { type: 'string', description: 'manual 或 interval' },
        intervalMinutes: { type: 'number', description: 'interval 模式的间隔分钟数，最少 5' }
      },
      required: ['title', 'goal', 'schedule']
    }
  },
  {
    name: 'list_agent_tasks',
    description: '列出现有后台 Agent 任务及其审批/启用状态。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'pet_action',
    description: '触发宠物动画动作。重要：当用户要求跳舞/跳/挥手/鞠躬/转圈/庆祝时，你必须调用此工具，不要只回复文字描述！',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '动画动作名称：dance=跳舞, celebrate=庆祝, wave=挥手, bow=鞠躬, spin=转圈, jump=跳跃, cry=哭, laugh=笑, walk=走路, run=跑步, sleep=睡觉, angry=生气, happy=开心, sad=难过',
          enum: ['dance', 'celebrate', 'wave', 'bow', 'spin', 'jump', 'cry', 'laugh', 'walk', 'run', 'sleep', 'angry', 'happy', 'sad']
        }
      },
      required: ['action']
    }
  }
]

export class AiEngine {
  async generatePetImage(opts: {
    apiConfig: ApiConfig
    apiKey: string
    name: string
    prompt: string
    style?: string
  }): Promise<GeneratedPetImage> {
    const { apiConfig, apiKey, name, prompt, style = 'sticker' } = opts
    if (apiConfig.provider !== 'openai') {
      throw new Error('AI 生成宠物需要在 API 设置中选择 OpenAI 兼容提供方')
    }

    const imagePrompt = [
      `Create one Codex desktop pet spritesheet atlas named ${name}.`,
      `User description: ${prompt}`,
      `Style: ${style}.`,
      'Output a single raster spritesheet image, exactly 1536x1872 pixels.',
      'Use a clean 8 columns by 9 rows atlas layout. Each cell is 192x208 pixels.',
      'Keep unused cells transparent or plain empty, but preserve the full 1536x1872 canvas.',
      'Rows 0-4 must contain this app pet animation set:',
      'row 0 idle: 6 frames, subtle breathing/blink.',
      'row 1 alert: 4 frames, surprised or attentive.',
      'row 2 talk: 6 frames, mouth/face talking motion.',
      'row 3 working: 4 frames, focused task pose.',
      'row 4 celebrate: 5 frames, happy hover/wave pose.',
      'Rows 5-8 may contain compatible extra pet poses.',
      'Every frame must show the same full-body character, centered inside its 192x208 cell.',
      'Use transparent background if possible; otherwise use one flat pale neutral background consistently.',
      'No text, labels, visible grid lines, frame borders, UI, scenery, cast shadows, or detached decorative effects.',
      'The result must look like a spritesheet similar to built-in Codex pets, not a single icon.'
    ].join('\n')

    const baseURL = openAIBaseUrl(apiConfig.baseUrl)
    const errors: string[] = []

    const postJson = async (url: string, body: Record<string, unknown>) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await resp.text()
        let data: unknown = text
        try { data = text ? JSON.parse(text) : {} } catch { /* keep text body */ }
        if (!resp.ok) {
          throw new Error(`${resp.status} ${extractApiErrorMessage(data) || resp.statusText}`)
        }
        return data
      } finally {
        clearTimeout(timer)
      }
    }

    const responsesPayloads: Record<string, unknown>[] = [
      {
        model: 'gpt-image-2',
        input: imagePrompt,
        tools: [{ type: 'image_generation', model: 'gpt-image-2', size: '1536x1872', quality: 'low', output_format: 'png' }],
        tool_choice: { type: 'image_generation' },
        max_tool_calls: 1,
        store: false,
      },
      {
        model: 'gpt-image-2',
        input: imagePrompt,
        tools: [{ type: 'image_generation', size: '1536x1872', quality: 'low', output_format: 'png' }],
        tool_choice: 'required',
        max_tool_calls: 1,
        store: false,
      },
    ]
    if (apiConfig.model && apiConfig.model !== 'gpt-image-2') {
      responsesPayloads.push({
        model: apiConfig.model,
        input: imagePrompt,
        tools: [{ type: 'image_generation', model: 'gpt-image-2', size: '1536x1872', quality: 'low', output_format: 'png' }],
        tool_choice: { type: 'image_generation' },
        max_tool_calls: 1,
        store: false,
      })
    }

    for (const payload of responsesPayloads) {
      try {
        const response = await postJson(`${baseURL}/responses`, payload)
        const raw = findGeneratedImageBase64(response)
        if (!raw) throw new Error('图片生成没有返回图像数据')
        const parsed = imageBase64Payload(raw)
        const out = {
          bytes: Buffer.from(parsed.b64, 'base64'),
          extension: parsed.extension ?? generatedImageExtension(response),
        }
        assertAtlasSize(out.bytes)
        return out
      } catch (err) {
        errors.push(`responses: ${apiErrorSummary(err)}`)
      }
    }

    const rawBaseURL = openAIRawBaseUrl(apiConfig.baseUrl)
    if (rawBaseURL && rawBaseURL !== baseURL) {
      try {
        const response = await postJson(`${rawBaseURL}/responses`, responsesPayloads[0])
        const raw = findGeneratedImageBase64(response)
        if (!raw) throw new Error('图片生成没有返回图像数据')
        const parsed = imageBase64Payload(raw)
        const out = {
          bytes: Buffer.from(parsed.b64, 'base64'),
          extension: parsed.extension ?? generatedImageExtension(response),
        }
        assertAtlasSize(out.bytes)
        return out
      } catch (err) {
        errors.push(`raw responses: ${apiErrorSummary(err)}`)
      }
    }

    try {
      const response = await postJson(`${baseURL}/images/generations`, {
        model: 'gpt-image-2',
        prompt: imagePrompt,
        size: '1536x1872',
        quality: 'low',
        background: 'auto',
        output_format: 'png',
        n: 1,
      })
      const raw = findGeneratedImageBase64(response)
      if (!raw) throw new Error('图片生成没有返回图像数据')
      const parsed = imageBase64Payload(raw)
      const out = {
        bytes: Buffer.from(parsed.b64, 'base64'),
        extension: parsed.extension ?? generatedImageExtension(response),
      }
      assertAtlasSize(out.bytes)
      return out
    } catch (err) {
      errors.push(`images: ${apiErrorSummary(err)}`)
    }

    console.warn('[ai.generatePetImage] pet atlas generation failed:', errors.join(' | '))
    throw new Error(`图片模型没有返回可用的 1536x1872 宠物 spritesheet。${errors.slice(-2).join(' | ')}`)
  }

  buildSystemPrompt(cfg: CharacterConfig, stats: SystemStats): string {
    const ram = `${(stats.ramUsed / 1e9).toFixed(1)}GB / ${(stats.ramTotal / 1e9).toFixed(1)}GB`
    const context = [
      `\n\n[当前系统状态 —— 仅供你参考，用户没问起就不要主动提及或罗列]`,
      `CPU: ${stats.cpu}%`,
      `RAM: ${ram}`,
      `磁盘: ${stats.diskUsed}%`,
      `claude: ${stats.claudeRunning ? '运行中' : '未运行'}`,
      `codex: ${stats.codexRunning ? '运行中' : '未运行'}`
    ].join('\n')
    return cfg.systemPrompt + context
  }

  parseToolCalls(content: unknown[]): ToolCall[] {
    const out: ToolCall[] = []
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      out.push({ tool: b.name, input: b.input ?? {} })
    }
    return out
  }

  async chat(opts: {
    config: CharacterConfig
    apiConfig: ApiConfig
    apiKey: string
    history: ChatMessage[]
    userMessage: string
    stats: SystemStats
    onChunk: (text: string) => void
    messages?: Anthropic.MessageParam[]
    allowTools?: boolean
  }): Promise<ChatResult> {
    const { config, apiConfig, apiKey, history, userMessage, stats, onChunk, messages: existingMessages, allowTools = true } = opts
    const systemPrompt = this.buildSystemPrompt(config, stats)

    const messages: Anthropic.MessageParam[] = existingMessages ?? [
      ...history
        .filter(m => m.role === 'user' || m.role === 'pet')
        .map(m => ({
          role:    (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content
        })),
      { role: 'user', content: userMessage }
    ]

    if (apiConfig.provider === 'claude') {
      const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
      let text = ''

      const stream = await client.messages.stream({
        model:      apiConfig.model,
        max_tokens: 1024,
        system:     systemPrompt,
        ...(allowTools ? { tools: AGENT_TOOLS } : {}),
        messages
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
          onChunk(event.delta.text)
        }
      }

      const finalMsg = await stream.finalMessage()
      const toolCalls = this.parseToolCalls(finalMsg.content)

      return { text, toolCalls }
    }

    // OpenAI SDK appends /chat/completions to baseURL, but proxies expect
    // /v1/chat/completions. Auto-append /v1 when a custom base URL is set.
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const client = new OpenAI({
      apiKey,
      baseURL: openaiBase,
      timeout: 60_000,
      defaultHeaders: { 'x-api-key': apiKey }
    })
    let text = ''
    const streamResp = await client.chat.completions.create({
      model:    apiConfig.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages] as OpenAI.ChatCompletionMessageParam[],
      stream:   true
    })
    for await (const chunk of streamResp) {
      const delta = chunk.choices?.[0]?.delta?.content ?? ''
      text += delta
      if (delta) onChunk(delta)
    }
    return { text, toolCalls: [] }
  }

  async suggestStdinReply(opts: {
    apiConfig: ApiConfig
    apiKey: string
    prompt: string
    recentLines: string[]
  }): Promise<string | null> {
    const { apiConfig, apiKey, prompt, recentLines } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const ask = `一个 CLI 正在等用户输入。判断**是否安全自动回答**。

最近输出:
${recentLines.slice(-15).join('\n')}

CLI 在问: ${prompt}

只有以下情况返回自动回答（且只回 "y" / "yes" / "n" / "no"）:
- 明显是无害的确认（"continue?"、"proceed?"、"are you sure?" 但操作是 git status/log/diff/install 这类只读或安装操作）
- 默认选项已是安全的（[Y/n] 或 (y/N)）

任何涉及以下的一律不要自答（返回 NONE）:
- 删除、覆盖、强制 (rm, force, overwrite, delete)
- 推送、发布 (push, publish, deploy)
- 输入密码、token、密钥
- 不明确的问题
- 自由文本输入

只返回这一行 JSON: {"reply":"y"} 或 {"reply":"n"} 或 {"reply":null}`

    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model,
          max_tokens: 80,
          messages: [{ role: 'user', content: ask }]
        })
        const block = resp.content.find(b => b.type === 'text')
        const text = block && block.type === 'text' ? block.text.trim() : ''
        return parseReply(text)
      }
      const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
      const resp = await client.chat.completions.create({
        model: apiConfig.model,
        max_tokens: 80,
        messages: [{ role: 'user', content: ask }]
      })
      return parseReply(resp.choices?.[0]?.message?.content ?? '')
    } catch {
      return null
    }
  }

  async judge(opts: {
    apiConfig: ApiConfig
    apiKey: string
    command: string             // e.g. "claude --print 'do X'"
    elapsedSec: number
    recentLines: string[]       // last ~30 lines of CLI output
    hadNewOutput: boolean       // true if any new lines since last judge
  }): Promise<{ status: WatcherStatus; note: string } | null> {
    const { apiConfig, apiKey, command, elapsedSec, recentLines, hadNewOutput } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const prompt = `你在监督一个正在跑的 CLI 任务。判断它的状态并用一句话评论。

命令: ${command}
已运行: ${elapsedSec} 秒
最近输出 (${hadNewOutput ? '有' : '无'}新增):
${recentLines.length ? recentLines.slice(-30).join('\n') : '(无输出)'}

只返回一行 JSON，格式: {"status":"ok|stuck|error|needs_user","note":"一句话中文评论"}
- ok: 正常进行中
- stuck: 长时间无新输出，可能卡了
- error: 输出里看到错误/失败/异常
- needs_user: CLI 在等用户输入（看到提示符、问题、Y/N 等）`

    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
        const block = resp.content.find(b => b.type === 'text')
        const text = block && block.type === 'text' ? block.text.trim() : ''
        return parseJudge(text)
      }
      const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
      const resp = await client.chat.completions.create({
        model: apiConfig.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
      return parseJudge(resp.choices?.[0]?.message?.content ?? '')
    } catch {
      return null
    }
  }

  async reflect(opts: {
    apiConfig: ApiConfig
    apiKey: string
    recentEvents: { type: string; source: string; data: Record<string, unknown>; ts: number }[]
    facts: { type: string; content: string; confidence: number }[]
    stats: { cpu: number; ramUsed: number; ramTotal: number; diskUsed: number }
    petPersona: string
    moodContext?: string
  }): Promise<ReflectorDecision> {
    const { apiConfig, apiKey, recentEvents, facts, stats, petPersona, moodContext } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const prompt = `${petPersona}

你是这个宠物助手。这是最近 30 分钟在用户机器上发生的事：
${JSON.stringify(recentEvents.slice(-20))}

你已知的关于用户的事实：
${facts.map(f => `[${f.type}] ${f.content} (conf=${f.confidence})`).join('\n') || '（空）'}

当前系统状态：CPU ${stats.cpu}%，RAM ${(stats.ramUsed/1e9).toFixed(1)}/${(stats.ramTotal/1e9).toFixed(1)}GB，磁盘 ${stats.diskUsed}%
${moodContext ? `\n${moodContext}\n` : ''}
大多数时候你应该回答 {"action":"silent"}。

只在以下情况建议 propose：
- 发现用户可能需要提醒的东西（系统资源异常、CLI 任务挂了、某事悬而未决）
- 你想分享一个有价值的观察（"你今天 codex 跑了 5 次"）
- 你注意到某个 fact 跟最近的事冲突
- 你的"情绪状态"指引你主动关怀用户（比如用户很久没互动了、深夜还在工作）

注意：宁可漏报也不要骚扰。一天不要超过 5 次 propose（情绪关怀不计入限制，但也不要频繁打扰）。

输出一行 JSON: {"action":"silent"} 或 {"action":"propose","bubble":"28字以内文案","detail":"完整说明"}`

    const SILENT: ReflectorDecision = { action: 'silent' }
    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
        const block = resp.content.find(b => b.type === 'text')
        const text = block && block.type === 'text' ? block.text.trim() : ''
        return parseReflector(text)
      }
      const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
      const resp = await client.chat.completions.create({
        model: apiConfig.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
      return parseReflector(resp.choices?.[0]?.message?.content ?? '')
    } catch {
      return SILENT
    }
  }

  async planAgenda(opts: {
    apiConfig:     ApiConfig
    apiKey:        string
    petPersona:    string
    moodContext:   string
    stats:         { cpu: number; ramUsed: number; ramTotal: number; diskUsed: number }
    recentEvents:  { type: string; source: string; data: Record<string, unknown>; ts: number }[]
    todayTimeline: { type: string; source: string; ts: number }[]
    topFacts:      { type: string; content: string; confidence: number }[]
    recentBubbles: string[]
    existingGoals: { kind: string; reason: string }[]
    signal?:       AbortSignal
  }): Promise<PlanAgendaResult> {
    const { apiConfig, apiKey, petPersona, moodContext, stats, recentEvents, todayTimeline, topFacts, recentBubbles, existingGoals, signal } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined

    const prompt = `${petPersona}

你是这个宠物的「议程脑」。你的工作：决定接下来一段时间里宠物想做什么。

可用 goal kind：
- greet:        打招呼/想念
- check_in:     例行关心
- comfort:      安慰
- curiosity:    好奇心驱动的提问
- celebrate:    庆祝成就
- remind_rest:  提醒休息
- system_check: 系统状态异常（agentGoal 是一条 shell 任务描述）

${moodContext ? moodContext + '\n' : ''}
当前系统：CPU ${stats.cpu}%，RAM ${(stats.ramUsed/1e9).toFixed(1)}/${(stats.ramTotal/1e9).toFixed(1)}GB，磁盘 ${stats.diskUsed}%

最近 30 分钟事件：
${JSON.stringify(recentEvents.slice(-30))}

今日时间线摘要：
${JSON.stringify(todayTimeline.slice(-30))}

你已知的事实（按置信度）：
${topFacts.map(f => `[${f.type}] ${f.content} (conf=${f.confidence})`).join('\n') || '（空）'}

最近说过的话（不要重复）：
${recentBubbles.slice(-10).map(b => '- ' + b).join('\n') || '（空）'}

队列里已有但未执行的 goal：
${existingGoals.map(g => `- ${g.kind}: ${g.reason}`).join('\n') || '（空）'}

规则：
1. 最多 3 个 goal，宁少勿多。沉默是默认选项。
2. 已有的类似 goal 不要再加。
3. 用户 5 分钟内有交互 + cpu<70% → 倾向沉默。
4. priority 0-100；delayMinutes 0 为立即；ttlMinutes 决定多久过期。
5. bubble 文案 ≤ 28 字。agentGoal 仅用于 system_check。

只输出一行严格 JSON：
{"goals":[{"kind":"...","bubble":"...","priority":50,"delayMinutes":0,"ttlMinutes":30,"reason":"..."}]}
或：{"goals":[],"silentReason":"..."}`

    const FAIL: PlanAgendaResult = { goals: [], silentReason: 'network_or_timeout' }
    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model,
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }, { signal })
        const block = resp.content.find(b => b.type === 'text')
        const text = block && block.type === 'text' ? block.text.trim() : ''
        return parsePlanAgendaResponse(text)
      }
      const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
      const resp = await client.chat.completions.create({
        model:       apiConfig.model,
        max_tokens:  800,
        messages:    [{ role: 'user', content: prompt }],
      }, { signal })
      return parsePlanAgendaResponse(resp.choices?.[0]?.message?.content ?? '')
    } catch (err) {
      const name = (err as { name?: string })?.name ?? ''
      const isAbort = name === 'AbortError' || name === 'APIUserAbortError' || name === 'TimeoutError'
      if (isAbort) console.warn('[planAgenda] timeout, falling back to silent')
      else console.warn('[planAgenda]', err)
      return FAIL
    }
  }

  async generateBubble(opts: {
    apiConfig: ApiConfig
    apiKey: string
    kind: string
    persona: string
    moodContext: string
    facts: { type: string; content: string }[]
    recentEvents: { type: string; source: string }[]
    signal?: AbortSignal
  }): Promise<string | null> {
    const { apiConfig, apiKey, kind, persona, moodContext, facts, recentEvents, signal } = opts
    if (!apiKey) return null

    const hint = BUBBLE_KIND_HINTS[kind] ?? '主动对用户说一句关心的话。'
    const factLines = facts.length > 0
      ? facts.slice(0, 10).map(f => `- [${f.type}] ${f.content}`).join('\n')
      : '（暂无）'
    const eventLines = recentEvents.length > 0
      ? recentEvents.slice(-5).map(e => `- ${e.type} (${e.source})`).join('\n')
      : '（暂无）'

    const prompt = `${persona}

${moodContext}

最近发生的事件：
${eventLines}

你记得的用户事实：
${factLines}

现在你想主动对用户说一句话。意图：${hint}

要求：
- 一句话，30 个汉字以内（不超过 60 个字符）
- 自然、口语、有性格；避免说教
- 不要复述事实编号；不要 JSON、不要引号、不要前缀（如"好的"、"主人"）
- 不要带 emoji，除非角色设定有这个习惯
- 如果上面的事实或事件里有具体可借的细节，自然带一点；没有就泛指

只输出这一句话，不要别的：`

    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined

    try {
      let raw = ''
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create(
          { model: apiConfig.model, max_tokens: 80, messages: [{ role: 'user', content: prompt }] },
          signal ? { signal } : undefined,
        )
        const block = resp.content.find(b => b.type === 'text')
        raw = block && block.type === 'text' ? block.text : ''
      } else {
        const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
        const resp = await client.chat.completions.create(
          { model: apiConfig.model, max_tokens: 80, messages: [{ role: 'user', content: prompt }] },
          signal ? { signal } : undefined,
        )
        raw = resp.choices?.[0]?.message?.content ?? ''
      }
      return truncateBubble(raw)
    } catch {
      return null
    }
  }

  async summarizeForMemory(opts: {
    apiConfig: ApiConfig
    apiKey: string
    history: ChatMessage[]
    existingMemory: string
  }): Promise<{ markdown: string; facts: ExtractedFact[] } | null> {
    const { apiConfig, apiKey, history, existingMemory } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const historyText = history
      .filter(m => m.role === 'user' || m.role === 'pet')
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n\n')
    const prompt = MEMORY_INSTRUCTION
      .replace('{{EXISTING}}', existingMemory || '（空）')
      .replace('{{HISTORY}}', historyText)

    if (apiConfig.provider === 'claude') {
      const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
      const resp = await client.messages.create({
        model: apiConfig.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      })
      const block = resp.content.find(b => b.type === 'text')
      const text = block && block.type === 'text' ? block.text.trim() : ''
      if (!text || text === 'NONE') return null
      const facts = parseFactsBlock(text)
      const markdown = stripFactsBlock(text)
      if (!markdown && facts.length === 0) return null
      return { markdown, facts }
    }

    const client = new OpenAI({ apiKey, baseURL: apiConfig.baseUrl || undefined })
    const resp = await client.chat.completions.create({
      model: apiConfig.model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = (resp.choices?.[0]?.message?.content ?? '').trim()
    if (!text || text === 'NONE') return null
    const facts = parseFactsBlock(text)
    const markdown = stripFactsBlock(text)
    if (!markdown && facts.length === 0) return null
    return { markdown, facts }
  }

  async proposePlaybook(opts: {
    recentTurn:        { role: string; content: string }[]
    existingPlaybooks: { id: string; title: string; triggers: string[] }[]
    facts:             { type: string; content: string }[]
    apiKey:            string
    apiConfig:         ApiConfig
  }): Promise<ProposedPlaybook | null> {
    const { recentTurn, existingPlaybooks, facts, apiKey, apiConfig } = opts
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined

    const prompt = `你是一个宠物 AI 助手。刚和用户完成了以下对话：

${recentTurn.map(m => `${m.role === 'user' ? '用户' : '宠物'}: ${m.content}`).join('\n')}

你已知的关于用户的事实：
${facts.map(f => `- ${f.content}`).join('\n') || '（空）'}

现有已学会的技能：
${existingPlaybooks.map(p => `- ${p.id}: ${p.title} (triggers: ${p.triggers.join(', ')})`).join('\n') || '（空）'}

判断：这轮对话里有没有值得沉淀成一个"下次遇到类似情况可以怎么做"的 playbook？

要求：
- 只在真正有具体、可执行的步骤时才生成
- 不要生成空泛的 playbook（如"做事要小心"）
- triggers 必须是具体的、能命中同类请求的条件
- body 必须是具体的步骤，不是抽象原则
- 如果这轮对话里学到了新东西（新偏好、新流程、纠正），生成 playbook
- 如果对话只是闲聊、回答一个一次性问题、或跟已有 playbook 重复，输出 NONE

输出格式：只输出一行 JSON 或 NONE。

JSON:
{"slug":"kebab-case-slug","title":"标题","triggers":["trigger1","trigger2"],"body":"# 怎么做\\n\\n1. ...\\n\\n# 用户偏好\\n\\n- ...","confidence":0.7}

NONE: 只输出 NONE 字符串`

    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }]
        })
        const block = resp.content.find(b => b.type === 'text')
        const text = block && block.type === 'text' ? block.text.trim() : ''
        return parseProposedPlaybook(text)
      }
      const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 30_000, defaultHeaders: { 'x-api-key': apiKey } })
      const resp = await client.chat.completions.create({
        model: apiConfig.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      })
      return parseProposedPlaybook(resp.choices?.[0]?.message?.content ?? '')
    } catch {
      return null
    }
  }

  /**
   * Weekly consolidation pass over playbooks + facts.
   *
   * Hermes-style: ship the model the full inventory and let it decide what to
   * merge, supersede, or archive. Returns a list of structured actions for the
   * caller (Curator) to apply against the stores.
   */
  async runCurator(opts: {
    playbooks: { id: string; title: string; triggers: string[]; uses: number }[]
    facts:     { id: string; type: string; content: string; confidence: number }[]
    apiKey:    string
    apiConfig: ApiConfig
  }): Promise<CuratorAction[]> {
    const { playbooks, facts, apiKey, apiConfig } = opts
    if (playbooks.length === 0 && facts.length === 0) return []
    const openaiBase = apiConfig.baseUrl
      ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
      : undefined
    const prompt = `你在做一次周度记忆整理。下面是用户的全部 playbooks 和 facts。

PLAYBOOKS:
${playbooks.map(p => `- ${p.id} | ${p.title} | triggers: ${p.triggers.join(', ')} | uses: ${p.uses}`).join('\n') || '（空）'}

FACTS:
${facts.map(f => `- ${f.id} | [${f.type}] ${f.content} | conf: ${f.confidence}`).join('\n') || '（空）'}

任务：
1. 找重复或高度重叠的 playbook（标题/触发条件实质相同）→ 合并为一条，保留 uses 最高的 id
2. 找冲突或被覆盖的 fact（"住北京" + 后来"住上海"）→ 用 supersede 让后者覆盖前者
3. 找语义重复的 fact（多条说同一件事）→ 删掉低 confidence 的副本

要求：
- 宁可不动也不要错删
- 输出 JSON 数组，每个动作格式：
  {"kind":"disable_playbook","id":"pb-xxx","reason":"..."}
  {"kind":"supersede_fact","oldId":"...","newId":"...","reason":"..."}
  {"kind":"delete_fact","id":"...","reason":"..."}
- 没需要动的就输出 []

只输出 JSON，不要其它文字。`

    let text = ''
    try {
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        const resp = await client.messages.create({
          model: apiConfig.model, max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
        const block = resp.content.find(b => b.type === 'text')
        text = block && block.type === 'text' ? block.text.trim() : ''
      } else {
        const client = new OpenAI({ apiKey, baseURL: openaiBase, timeout: 60_000, defaultHeaders: { 'x-api-key': apiKey } })
        const resp = await client.chat.completions.create({
          model: apiConfig.model, max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
        text = (resp.choices?.[0]?.message?.content ?? '').trim()
      }
    } catch (err) {
      console.error('[ai.runCurator] failed:', err)
      return []
    }

    try {
      const m = text.match(/\[[\s\S]*\]/)
      if (!m) return []
      const arr = JSON.parse(m[0]) as unknown
      if (!Array.isArray(arr)) return []
      const out: CuratorAction[] = []
      for (const item of arr) {
        const o = item as { kind?: string; id?: string; oldId?: string; newId?: string; reason?: string }
        if (o.kind === 'disable_playbook' && typeof o.id === 'string') {
          out.push({ kind: 'disable_playbook', id: o.id, reason: String(o.reason ?? '') })
        } else if (o.kind === 'supersede_fact' && typeof o.oldId === 'string' && typeof o.newId === 'string') {
          out.push({ kind: 'supersede_fact', oldId: o.oldId, newId: o.newId, reason: String(o.reason ?? '') })
        } else if (o.kind === 'delete_fact' && typeof o.id === 'string') {
          out.push({ kind: 'delete_fact', id: o.id, reason: String(o.reason ?? '') })
        }
      }
      return out
    } catch {
      return []
    }
  }

  /**
   * Agent loop: call AI, execute tools, feed results back, repeat until done.
   * Built-in tools (bash/read_file/write_file/list_files) are auto-executed.
   * CLI tools (run_claude_code/run_codex) are NOT auto-executed here — they're
   * handled by the IPC layer which manages the watcher/runner infrastructure.
   */
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
    mcpTools?: Anthropic.Tool[]
    mcpExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string>
    matchedSkills?: { name: string; body: string }[]
    attachments?: ChatAttachment[]
    onUpdateCharacter?: (patch: Record<string, unknown>) => Promise<string>
    onAgentTaskTool?: (tool: string, input: Record<string, unknown>) => Promise<string>
  }): Promise<AgentResult> {
    const { config, apiConfig, apiKey, history, userMessage, stats, onChunk, workdir, petId, factStore, playbooks, maxRounds = 10 } = opts
    const executor = new ToolExecutor(workdir)
    const toolExecutions: AgentResult['toolExecutions'] = []

    let systemPrompt = this.buildSystemPrompt(config, stats)
    if (opts.matchedSkills && opts.matchedSkills.length > 0) {
      const skillBlock = opts.matchedSkills.map(s =>
        `<skill name="${s.name}">\n${s.body}\n</skill>`
      ).join('\n\n')
      systemPrompt += `\n\n[当前激活的技能]\n\n${skillBlock}`
    }

    const allTools: Anthropic.Tool[] = [...AGENT_TOOLS, ...(opts.mcpTools ?? [])]
    const userContent = buildUserContent(userMessage, opts.attachments)
    const messages: Anthropic.MessageParam[] = [
      ...history
        .filter(m => m.role === 'user' || m.role === 'pet')
        .map(m => ({
          role:    (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content
        })),
      { role: 'user', content: userContent }
    ]

    let totalText = ''
    const petActions: string[] = []

    const executorNames = new Set(['bash', 'read_file', 'write_file', 'list_files', 'edit_file', 'install_skill'])
    const memoryNames   = new Set(['query_facts', 'remember', 'forget', 'list_playbooks', 'view_playbook', 'create_playbook', 'update_playbook'])
    const characterNames = new Set(['update_character'])
    const agentTaskNames = new Set(['create_agent_task', 'list_agent_tasks'])
    const petActionNames = new Set(['pet_action'])

    // Build OpenAI messages once; the OpenAI branch appends to this array across
    // rounds so that tool_result messages survive into later iterations.
    const openaiMsgs: OpenAI.ChatCompletionMessageParam[] | undefined =
      apiConfig.provider !== 'claude'
        ? [{ role: 'system', content: systemPrompt },
           ...messages.map((m, i) => ({
             role:    m.role as 'user' | 'assistant',
             content: i === messages.length - 1 && opts.attachments
               ? buildOpenAIContent(userMessage, opts.attachments)
               : typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
           }))]
        : undefined

    for (let round = 0; round < maxRounds; round++) {
      // --- Claude branch ---
      if (apiConfig.provider === 'claude') {
        const client = new Anthropic({ apiKey, baseURL: apiConfig.baseUrl || undefined })
        let roundText = ''

        const stream = await client.messages.stream({
          model:      apiConfig.model,
          max_tokens: 1024,
          system:     systemPrompt,
          tools:      allTools,
          messages
        })

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            roundText += event.delta.text
            onChunk(event.delta.text)
          }
        }

        totalText += roundText
        const finalMsg = await stream.finalMessage()
        const toolCalls = this.parseToolCalls(finalMsg.content)

        // No tool calls → we're done
        if (toolCalls.length === 0) return { text: totalText, rounds: round + 1, toolExecutions, cliCalls: [], petActions }

        const executorCalls = toolCalls.filter(t => executorNames.has(t.tool))
        const memoryCalls   = toolCalls.filter(t => memoryNames.has(t.tool))
        const characterCalls = toolCalls.filter(t => characterNames.has(t.tool))
        const agentTaskCalls = toolCalls.filter(t => agentTaskNames.has(t.tool))
        const petActionCalls = toolCalls.filter(t => petActionNames.has(t.tool))
        const mcpCalls      = toolCalls.filter(t => !executorNames.has(t.tool) && !memoryNames.has(t.tool) && !characterNames.has(t.tool) && !agentTaskNames.has(t.tool) && !petActionNames.has(t.tool) && t.tool.startsWith('mcp__'))
        const cliCalls      = toolCalls.filter(t => !executorNames.has(t.tool) && !memoryNames.has(t.tool) && !characterNames.has(t.tool) && !agentTaskNames.has(t.tool) && !petActionNames.has(t.tool) && !t.tool.startsWith('mcp__'))

        // Execute built-in tools in parallel, then memory tools in parallel
        const resultById = new Map<string, string>()

        await Promise.all(executorCalls.map(async call => {
          const strInput: Record<string, string> = {}
          for (const [k, v] of Object.entries(call.input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
          const label = (strInput.command || strInput.path || strInput[Object.keys(strInput)[0]] || '').slice(0, 60)
          onChunk(`\n<details><summary>🔧 ${call.tool}: ${label}</summary>\n\n`)
          const result = await executor.execute(call.tool, call.input)
          toolExecutions.push(result)
          resultById.set((call as unknown as { id?: string }).id ?? '', result.output)
          onChunk(`${result.output}\n\n</details>\n\n`)
        }))

        await Promise.all(memoryCalls.map(async call => {
          const output = await this.executeMemoryTool(call.tool, call.input, petId, factStore, playbooks)
          resultById.set((call as unknown as { id?: string }).id ?? '', output)
          onChunk(`\n<details><summary>🧠 ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
        }))

        await Promise.all(characterCalls.map(async call => {
          const output = opts.onUpdateCharacter
            ? await opts.onUpdateCharacter(call.input)
            : 'Error: update_character not available'
          resultById.set((call as unknown as { id?: string }).id ?? call.tool, output)
          onChunk(`\n<details><summary>✏️ ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
        }))

        await Promise.all(agentTaskCalls.map(async call => {
          const output = opts.onAgentTaskTool
            ? await opts.onAgentTaskTool(call.tool, call.input)
            : 'Error: agent tasks not available'
          resultById.set((call as unknown as { id?: string }).id ?? call.tool, output)
          onChunk(`\n<details><summary>⏱️ ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
        }))

        // pet_action: collect action names for side-effect broadcast
        for (const call of petActionCalls) {
          const action = typeof call.input.action === 'string' ? call.input.action : 'celebrate'
          resultById.set((call as unknown as { id?: string }).id ?? call.tool, `OK: 触发动画 ${action}`)
          petActions.push(action)
        }

        await Promise.all(mcpCalls.map(async call => {
          const strInput: Record<string, string> = {}
          for (const [k, v] of Object.entries(call.input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
          const label = (strInput.command || strInput.path || strInput[Object.keys(strInput)[0]] || '').slice(0, 60)
          onChunk(`\n<details><summary>🔌 ${call.tool}: ${label}</summary>\n\n`)
          const t0 = Date.now()
          let output = 'Error: MCP not available'
          let exitCode = 1
          try {
            if (opts.mcpExecutor) {
              output = await opts.mcpExecutor(call.tool, call.input)
              exitCode = 0
            }
          } catch (err) {
            output = `Error: ${(err as Error).message ?? String(err)}`
            exitCode = 1
          }
          toolExecutions.push({
            tool: call.tool, input: strInput, output, exitCode,
            durationMs: Date.now() - t0,
          })
          resultById.set((call as unknown as { id?: string }).id ?? call.tool, output)
          onChunk(`${output}\n\n</details>\n\n`)
        }))

        const toolResults: Anthropic.ToolResultBlockParam[] = toolCalls
          .filter(t => executorNames.has(t.tool) || memoryNames.has(t.tool) || characterNames.has(t.tool) || agentTaskNames.has(t.tool) || t.tool.startsWith('mcp__'))
          .map(t => ({
            type: 'tool_result',
            tool_use_id: (t as unknown as { id?: string }).id ?? '',
            content: resultById.get((t as unknown as { id?: string }).id ?? '') ?? 'done'
          }))

        // For CLI tools, return them to the IPC layer (not auto-executed here)
        if (cliCalls.length > 0) {
          return { text: totalText, rounds: round + 1, toolExecutions, cliCalls, petActions }
        }

        // Append results and continue loop
        messages.push({ role: 'assistant', content: finalMsg.content as Anthropic.ContentBlockParam[] })
        messages.push({ role: 'user',    content: toolResults })

        continue
      }

      // --- OpenAI branch: streaming + parallel tools + persistent message array ---
      const openaiBase = apiConfig.baseUrl
        ? (apiConfig.baseUrl.endsWith('/v1') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/v1`)
        : undefined
      const client = new OpenAI({
        apiKey,
        baseURL: openaiBase,
        timeout: 60_000,
        defaultHeaders: { 'x-api-key': apiKey }
      })

      const openaiTools = toOpenAITools(allTools)
      let roundText = ''
      const accToolCalls: Record<number, { id: string; name: string; arguments: string }> = {}

      const stream = await client.chat.completions.create({
        model: apiConfig.model,
        messages: openaiMsgs!,
        tools: openaiTools,
        max_tokens: 1024,
        stream: true
      })

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) { roundText += delta.content; onChunk(delta.content) }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0
            if (!accToolCalls[i]) accToolCalls[i] = { id: tc.id ?? '', name: '', arguments: '' }
            if (tc.id) accToolCalls[i].id = tc.id
            if (tc.function?.name && !accToolCalls[i].name) accToolCalls[i].name = tc.function.name
            if (tc.function?.arguments) accToolCalls[i].arguments += tc.function.arguments
          }
        }
      }

      totalText += roundText
      const openaiToolCalls = Object.values(accToolCalls)

      if (openaiToolCalls.length === 0) return { text: totalText, rounds: round + 1, toolExecutions, cliCalls: [], petActions }

      // Reconstruct full OpenAI tool_calls for message history
      const fullToolCalls = openaiToolCalls.map(tc => ({
        id: tc.id, type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))

      // Map to our ToolCall format for categorization
      const ourToolCalls: ToolCall[] = openaiToolCalls.map(tc => ({
        tool: tc.name,
        input: (() => { try { return JSON.parse(tc.arguments) } catch { return {} } })()
      }))

      const executorCalls = ourToolCalls.filter(t => executorNames.has(t.tool))
      const memoryCalls   = ourToolCalls.filter(t => memoryNames.has(t.tool))
      const characterCalls = ourToolCalls.filter(t => characterNames.has(t.tool))
      const agentTaskCalls = ourToolCalls.filter(t => agentTaskNames.has(t.tool))
      const petActionCalls = ourToolCalls.filter(t => petActionNames.has(t.tool))
      const mcpCalls      = ourToolCalls.filter(t => !executorNames.has(t.tool) && !memoryNames.has(t.tool) && !characterNames.has(t.tool) && !agentTaskNames.has(t.tool) && !petActionNames.has(t.tool) && t.tool.startsWith('mcp__'))
      const cliCalls      = ourToolCalls.filter(t => !executorNames.has(t.tool) && !memoryNames.has(t.tool) && !characterNames.has(t.tool) && !agentTaskNames.has(t.tool) && !petActionNames.has(t.tool) && !t.tool.startsWith('mcp__'))

      if (cliCalls.length > 0) return { text: totalText, rounds: round + 1, toolExecutions, cliCalls, petActions }

      // Execute built-in tools in parallel
      const resultById = new Map<string, string>()

      await Promise.all(executorCalls.map(async call => {
        const strInput: Record<string, string> = {}
        for (const [k, v] of Object.entries(call.input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
        const label = (strInput.command || strInput.path || strInput[Object.keys(strInput)[0]] || '').slice(0, 60)
        onChunk(`\n<details><summary>🔧 ${call.tool}: ${label}</summary>\n\n`)
        const result = await executor.execute(call.tool, call.input)
        toolExecutions.push(result)
        resultById.set(call.tool, result.output)
        onChunk(`${result.output}\n\n</details>\n\n`)
      }))

      // Execute memory tools in parallel
      await Promise.all(memoryCalls.map(async call => {
        const output = await this.executeMemoryTool(call.tool, call.input, petId, factStore, playbooks)
        resultById.set(call.tool, output)
        onChunk(`\n<details><summary>🧠 ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
      }))

      // Execute character tools in parallel
      await Promise.all(characterCalls.map(async call => {
        const output = opts.onUpdateCharacter
          ? await opts.onUpdateCharacter(call.input)
          : 'Error: update_character not available'
        resultById.set(call.tool, output)
        onChunk(`\n<details><summary>✏️ ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
      }))

      await Promise.all(agentTaskCalls.map(async call => {
        const output = opts.onAgentTaskTool
          ? await opts.onAgentTaskTool(call.tool, call.input)
          : 'Error: agent tasks not available'
        resultById.set(call.tool, output)
        onChunk(`\n<details><summary>⏱️ ${call.tool}</summary>\n\n${output}\n\n</details>\n\n`)
      }))

      // pet_action: collect action names for side-effect broadcast
      for (const call of petActionCalls) {
        const action = typeof call.input.action === 'string' ? call.input.action : 'celebrate'
        resultById.set(call.tool, `OK: 触发动画 ${action}`)
        petActions.push(action)
      }

      // Execute MCP tools in parallel
      await Promise.all(mcpCalls.map(async call => {
        const strInput: Record<string, string> = {}
        for (const [k, v] of Object.entries(call.input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
        const label = (strInput.command || strInput.path || strInput[Object.keys(strInput)[0]] || '').slice(0, 60)
        onChunk(`\n<details><summary>🔌 ${call.tool}: ${label}</summary>\n\n`)
        const t0 = Date.now()
        let output = 'Error: MCP not available'
        let exitCode = 1
        try {
          if (opts.mcpExecutor) {
            output = await opts.mcpExecutor(call.tool, call.input)
            exitCode = 0
          }
        } catch (err) {
          output = `Error: ${(err as Error).message ?? String(err)}`
          exitCode = 1
        }
        toolExecutions.push({
          tool: call.tool, input: strInput, output, exitCode,
          durationMs: Date.now() - t0,
        })
        resultById.set(call.tool, output)
        onChunk(`${output}\n\n</details>\n\n`)
      }))

      // Feed assistant message + tool results into the persistent openaiMsgs array
      openaiMsgs!.push({ role: 'assistant', content: roundText, tool_calls: fullToolCalls })
      for (const tc of openaiToolCalls) {
        const output = resultById.get(tc.name) ?? 'done'
        openaiMsgs!.push({ role: 'tool', tool_call_id: tc.id, content: output })
      }

      continue
    }

    return { text: totalText, rounds: maxRounds, toolExecutions, cliCalls: [], petActions }
  }

  /** Execute memory-related tools (facts + playbooks) */
  private async executeMemoryTool(
    tool: string,
    input: Record<string, unknown>,
    petId: string,
    factStore: FactStore,
    playbooks: PlaybookStore
  ): Promise<string> {
    const s = (k: string) => typeof input[k] === 'string' ? input[k] as string : ''
    const n = (k: string) => typeof input[k] === 'number' ? input[k] as number : undefined

    try {
      switch (tool) {
        case 'query_facts': {
          const type = s('type') as import('./fact-store').MemoryFactType | undefined
          const limit = n('limit') ?? 20
          const facts = await factStore.list(petId, { type: type || undefined, limit })
          return facts.length === 0
            ? '没有找到相关事实。'
            : facts.map(f => `- [${f.id}] (${f.type}, conf=${f.confidence}) ${f.content}`).join('\n')
        }
        case 'remember': {
          const content = s('content')
          const type = s('type') as import('./fact-store').MemoryFactType
          const confidence = n('confidence') ?? 0.7
          if (!content || !type) return 'Error: content 和 type 都是必填的'
          const id = await factStore.add(petId, { type, content, confidence, source: { note: 'user-said' } })
          return `OK: 已记住 (id=${id})`
        }
        case 'forget': {
          const id = s('id')
          if (!id) return 'Error: id 是必填的'
          await factStore.delete(petId, id)
          return `OK: 已删除 fact ${id}`
        }
        case 'list_playbooks': {
          const list = await playbooks.list({ enabledOnly: true })
          return list.length === 0
            ? '没有已学习的技能。'
            : list.map(p => `- ${p.id} — ${p.title} (uses: ${p.uses}, conf: ${p.confidence.toFixed(1)})`).join('\n')
        }
        case 'view_playbook': {
          const id = s('id')
          if (!id) return 'Error: id 是必填的'
          const pb = await playbooks.get(id)
          if (!pb) return `Error: 找不到 playbook ${id}`
          return `# ${pb.title}\n\nTriggers:\n${pb.triggers.map(t => `- ${t}`).join('\n')}\n\n${pb.body}`
        }
        case 'create_playbook': {
          const slug = s('slug')
          const title = s('title')
          const triggers = input.triggers as string[] | undefined
          const body = s('body')
          const confidence = n('confidence') ?? 0.7
          if (!slug || !title || !triggers?.length || !body) return 'Error: slug/title/triggers/body 都是必填的'
          const id = await playbooks.create(
            { id: `pb-${slug}`, title, triggers, created: new Date().toISOString().slice(0, 10), confidence },
            body
          )
          return `OK: 已创建 skill ${id}`
        }
        case 'update_playbook': {
          const id = s('id')
          const body = s('body')
          if (!id || !body) return 'Error: id 和 body 都是必填的'
          const pb = await playbooks.get(id)
          if (!pb) return `Error: 找不到 playbook ${id}`
          await playbooks.create(
            { id: pb.id, title: pb.title, triggers: pb.triggers, created: pb.created, confidence: pb.confidence },
            body
          )
          return `OK: 已更新 ${id}`
        }
        default:
          return `Error: 未知 memory tool "${tool}"`
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`
    }
  }
}

export type CuratorAction =
  | { kind: 'disable_playbook'; id: string; reason: string }
  | { kind: 'supersede_fact'; oldId: string; newId: string; reason: string }
  | { kind: 'delete_fact'; id: string; reason: string }
