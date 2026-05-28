import os from 'os'
import type { AgentTask, AgentTaskRun, ApiConfig, CharacterConfig, SystemStats } from '@shared/types'
import { IPC } from '@shared/types'
import type { AiEngine } from './ai'
import type { CharacterConfigStore } from './character'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { MoodEngine } from './mood-engine'
import type { WindowManager } from './windows'
import type { AgentTaskStore } from './agent-tasks'
import type { PlaybookStore } from './playbook-store'

const TICK_MS = 30_000
const MAX_RECENT_RESULTS = 5

interface RecentResult {
  title: string
  status: string
  summary: string
  ts: number
}

export interface AgentSchedulerDeps {
  store: AgentTaskStore
  ai: AiEngine
  chars: CharacterConfigStore
  events: EventStore
  factStore: FactStore
  mood: MoodEngine
  wm: WindowManager
  playbooks: PlaybookStore
  getStats: () => SystemStats
  getActivePetId: () => string | null
}

export class AgentScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = new Set<string>()
  private recentResults: RecentResult[] = []

  constructor(private deps: AgentSchedulerDeps) {}

  /** Get recent results for prompt injection (exposed for testing) */
  getRecentResults(): RecentResult[] {
    return [...this.recentResults]
  }

  private pushResult(title: string, status: string, summary: string): void {
    this.recentResults.push({ title, status, summary, ts: Date.now() })
    if (this.recentResults.length > MAX_RECENT_RESULTS) {
      this.recentResults = this.recentResults.slice(-MAX_RECENT_RESULTS)
    }
  }

  private formatRecentResults(): string | null {
    if (this.recentResults.length === 0) return null
    const lines = ['最近执行记录（避免重复操作）：']
    for (const r of this.recentResults) {
      const ago = Math.floor((Date.now() - r.ts) / 60_000)
      lines.push(`- [${r.status}] ${r.title} (${ago}分钟前): ${r.summary.slice(0, 80)}`)
    }
    return lines.join('\n')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick().catch(err => console.error('[agent] tick failed:', err)), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    const due = await this.deps.store.due()
    for (const task of due) {
      if (this.running.has(task.id)) continue
      this.run(task.id).catch(err => console.error('[agent] task failed:', err))
    }
  }

  async run(taskId: string): Promise<AgentTaskRun> {
    const task = await this.deps.store.get(taskId)
    if (!task) throw new Error(`找不到任务 ${taskId}`)
    if (!task.enabled) return this.skip(task, '任务已停用')
    if (!task.approved) return this.skip(task, '任务未审批')
    if (this.running.has(task.id)) return this.skip(task, '任务正在运行')

    this.running.add(task.id)
    const started = Date.now()
    await this.deps.store.markRunStart(task.id)
    try {
      const result = await this.execute(task)
      const run = await this.deps.store.recordRun(task.id, {
        durationMs: Date.now() - started,
        status: 'success',
        result,
      })
      await this.emitResult(task.id, run)
      return run
    } catch (err) {
      const run = await this.deps.store.recordRun(task.id, {
        durationMs: Date.now() - started,
        status: 'error',
        error: (err as Error).message,
      })
      await this.emitResult(task.id, run)
      return run
    } finally {
      this.running.delete(task.id)
    }
  }

  private async skip(task: AgentTask, reason: string): Promise<AgentTaskRun> {
    const run = await this.deps.store.recordRun(task.id, {
      durationMs: 0,
      status: 'skipped',
      error: reason,
    })
    await this.emitResult(task.id, run)
    return run
  }

  /** One-shot execution driven by DriveEngine — no task store, no persistence */
  async executeOneShot(goal: string, opts?: { maxRounds?: number }): Promise<string> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    const [cfg, apiConfig, apiKey] = await Promise.all([
      this.deps.chars.get(petId),
      this.deps.chars.getApiConfig(),
      this.deps.chars.getApiKey(),
    ])
    if (!apiKey) throw new Error('API Key 未配置')

    const stats = this.deps.getStats()
    const moodContext = this.deps.mood.buildMoodContext()
    const recentEvents = await this.deps.events.range(petId, Date.now() - 30 * 60_000, Date.now())

    const lines = [
      '[宠物自主行动]',
      `你想做的事: ${goal}`,
      '',
      moodContext,
      '',
      `当前系统状态：CPU ${stats.cpu}%，RAM ${(stats.ramUsed/1e9).toFixed(1)}/${(stats.ramTotal/1e9).toFixed(1)}GB`,
      '',
      '用你的角色语气来表达。回复控制在 200 字以内。',
    ]
    const history = this.formatRecentResults()
    if (history) lines.push('', history)
    if (recentEvents.length > 0) {
      lines.push('', '最近事件：')
      for (const ev of recentEvents.slice(-3)) {
        lines.push(`- [${ev.type}] ${JSON.stringify(ev.data).slice(0, 80)}`)
      }
    }

    let text = ''
    await this.deps.ai.agentLoop({
      config: cfg,
      apiConfig,
      apiKey,
      history: [],
      userMessage: lines.join('\n'),
      stats,
      onChunk: chunk => { text += chunk },
      workdir: os.homedir(),
      petId,
      factStore: this.deps.factStore,
      playbooks: this.deps.playbooks,
      maxRounds: opts?.maxRounds ?? 3,
    })
    return text.trim()
  }

  private async execute(task: AgentTask): Promise<string> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    const [cfg, apiConfig, apiKey] = await Promise.all([
      this.deps.chars.get(petId),
      this.deps.chars.getApiConfig(),
      this.deps.chars.getApiKey(),
    ])
    if (!apiKey) throw new Error('API Key 未配置')

    const stats = this.deps.getStats()
    const moodContext = this.deps.mood.buildMoodContext()

    // Gather recent events and facts for context
    const now = Date.now()
    const recentEvents = await this.deps.events.range(petId, now - 60 * 60_000, now)
    const facts = await this.deps.factStore.list(petId, { minConfidence: 0.5, limit: 15 })

    const prompt = this.buildPrompt(task, cfg, stats, moodContext, recentEvents, facts)
    let text = ''

    // Use agentLoop for full tool access (enables bash, file ops, memory tools)
    const result = await this.deps.ai.agentLoop({
      config: cfg,
      apiConfig,
      apiKey,
      history: [],
      userMessage: prompt,
      stats,
      onChunk: chunk => { text += chunk },
      workdir: os.homedir(),
      petId,
      factStore: this.deps.factStore,
      playbooks: this.deps.playbooks,
      maxRounds: 5,
    })
    return (result.text || text).trim() || '任务完成，但没有生成摘要。'
  }

  private buildPrompt(
    task: AgentTask,
    _cfg: CharacterConfig,
    stats: SystemStats,
    moodContext: string,
    recentEvents: { type: string; source: string; data: Record<string, unknown>; ts: number }[],
    facts: { type: string; content: string; confidence: number }[],
  ): string {
    const lines = [
      '[后台 Agent 任务]',
      `任务标题: ${task.title}`,
      `任务目标: ${task.goal}`,
      '',
      moodContext,
      '',
      `当前系统状态：CPU ${stats.cpu}%，RAM ${(stats.ramUsed/1e9).toFixed(1)}/${(stats.ramTotal/1e9).toFixed(1)}GB`,
      '',
      '你可以使用 bash、read_file、list_files 等工具来完成任务。',
      '使用 remember 工具记住你发现的有价值的信息。',
      '回复控制在 300 字以内。用你的角色语气来表达，带上当前情绪。',
    ]

    const history = this.formatRecentResults()
    if (history) lines.push('', history)

    if (recentEvents.length > 0) {
      lines.push('', '最近 1 小时事件：')
      for (const ev of recentEvents.slice(-5)) {
        lines.push(`- [${ev.type}] ${JSON.stringify(ev.data).slice(0, 100)}`)
      }
    }

    if (facts.length > 0) {
      lines.push('', '你记得的用户信息：')
      for (const f of facts.slice(0, 5)) {
        lines.push(`- ${f.content}`)
      }
    }

    return lines.join('\n')
  }

  private async emitResult(taskId: string, run: AgentTaskRun): Promise<void> {
    const task = await this.deps.store.get(taskId)
    if (!task) return
    this.pushResult(task.title, run.status, run.result ?? run.error ?? '')
    this.deps.wm.broadcast(IPC.AGENT_TASK_RAN, { task, run })
    if (run.status === 'success') {
      this.deps.mood.onInteraction('task_ok')
      this.deps.wm.showBubble({ source: 'watcher', label: `任务完成: ${task.title}`, timestamp: Date.now() })
    } else if (run.status === 'error') {
      this.deps.mood.onInteraction('task_fail')
      this.deps.wm.showBubble({ source: 'watcher', label: `任务失败: ${task.title}`, timestamp: Date.now() })
    }
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    await this.deps.events.append(petId, {
      type: 'agent_task',
      source: 'system',
      data: {
        taskId: task.id,
        title: task.title,
        status: run.status,
        result: run.result?.slice(0, 500),
        error: run.error,
      },
    }).catch(() => {})
  }
}
