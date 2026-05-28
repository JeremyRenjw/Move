import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  AgentTask,
  AgentTaskCreateInput,
  AgentTaskRun,
  AgentTaskStatus,
  AgentTaskUpdateInput,
} from '@shared/types'

const TASKS_FILE = 'agent-tasks.json'
const RUNS_FILE = 'agent-task-runs.jsonl'
const MIN_INTERVAL_MINUTES = 5
const DEFAULT_INTERVAL_MINUTES = 60
const MAX_RUNS = 200

function now(): number {
  return Date.now()
}

function clampInterval(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_INTERVAL_MINUTES
  return Math.max(MIN_INTERVAL_MINUTES, n)
}

function computeNextRun(task: AgentTask, from = now()): number | undefined {
  if (!task.enabled || !task.approved || task.schedule !== 'interval') return undefined
  return from + clampInterval(task.intervalMinutes) * 60_000
}

function sanitizeCreate(input: AgentTaskCreateInput): AgentTask {
  const ts = now()
  const schedule = input.schedule === 'manual' ? 'manual' : 'interval'
  const task: AgentTask = {
    id: randomUUID(),
    title: input.title.trim().slice(0, 80),
    goal: input.goal.trim().slice(0, 2000),
    schedule,
    intervalMinutes: schedule === 'interval' ? clampInterval(input.intervalMinutes) : undefined,
    enabled: input.enabled ?? true,
    approved: input.approved ?? input.source !== 'ai',
    requireApproval: input.requireApproval ?? input.source === 'ai',
    source: input.source ?? 'user',
    allowedTools: input.allowedTools,
    createdAt: ts,
    updatedAt: ts,
    lastStatus: 'idle',
  }
  task.nextRunAt = computeNextRun(task, ts)
  return task
}

export class AgentTaskStore {
  private dir: string

  constructor(userData: string) {
    this.dir = path.join(userData, 'agent')
  }

  private tasksPath(): string {
    return path.join(this.dir, TASKS_FILE)
  }

  private runsPath(): string {
    return path.join(this.dir, RUNS_FILE)
  }

  async list(): Promise<AgentTask[]> {
    try {
      const raw = await fs.readFile(this.tasksPath(), 'utf-8')
      const tasks = JSON.parse(raw) as AgentTask[]
      return Array.isArray(tasks) ? tasks : []
    } catch {
      return []
    }
  }

  async get(id: string): Promise<AgentTask | null> {
    return (await this.list()).find(t => t.id === id) ?? null
  }

  async create(input: AgentTaskCreateInput): Promise<AgentTask> {
    if (!input.title.trim()) throw new Error('任务标题不能为空')
    if (!input.goal.trim()) throw new Error('任务目标不能为空')
    const task = sanitizeCreate(input)
    await this.saveAll([...(await this.list()), task])
    return task
  }

  async update(id: string, patch: AgentTaskUpdateInput): Promise<AgentTask> {
    const tasks = await this.list()
    const idx = tasks.findIndex(t => t.id === id)
    if (idx < 0) throw new Error(`找不到任务 ${id}`)
    const current = tasks[idx]
    const next: AgentTask = {
      ...current,
      ...patch,
      title: typeof patch.title === 'string' ? patch.title.trim().slice(0, 80) : current.title,
      goal: typeof patch.goal === 'string' ? patch.goal.trim().slice(0, 2000) : current.goal,
      schedule: patch.schedule ?? current.schedule,
      allowedTools: patch.allowedTools ?? current.allowedTools,
      updatedAt: now(),
    }
    if (!next.title) throw new Error('任务标题不能为空')
    if (!next.goal) throw new Error('任务目标不能为空')
    next.intervalMinutes = next.schedule === 'interval'
      ? clampInterval(patch.intervalMinutes ?? current.intervalMinutes)
      : undefined
    next.nextRunAt = computeNextRun(next, next.updatedAt)
    tasks[idx] = next
    await this.saveAll(tasks)
    return next
  }

  async approve(id: string): Promise<AgentTask> {
    return this.update(id, { approved: true, enabled: true })
  }

  async delete(id: string): Promise<void> {
    await this.saveAll((await this.list()).filter(t => t.id !== id))
  }

  async due(at = now()): Promise<AgentTask[]> {
    return (await this.list()).filter(t =>
      t.enabled && t.approved && t.schedule === 'interval' && typeof t.nextRunAt === 'number' && t.nextRunAt <= at
    )
  }

  async markRunStart(id: string): Promise<AgentTask> {
    return this.updateStatus(id, 'running')
  }

  async recordRun(taskId: string, run: Omit<AgentTaskRun, 'id' | 'taskId' | 'ts'>): Promise<AgentTaskRun> {
    const entry: AgentTaskRun = { id: randomUUID(), taskId, ts: now(), ...run }
    await fs.mkdir(this.dir, { recursive: true })
    await fs.appendFile(this.runsPath(), JSON.stringify(entry) + '\n', 'utf-8')

    const tasks = await this.list()
    const idx = tasks.findIndex(t => t.id === taskId)
    if (idx >= 0) {
      const task = tasks[idx]
      const next: AgentTask = {
        ...task,
        lastRunAt: entry.ts,
        lastStatus: entry.status,
        lastResult: entry.result,
        lastError: entry.error,
        nextRunAt: computeNextRun({ ...task, lastRunAt: entry.ts, lastStatus: entry.status }, entry.ts),
        updatedAt: entry.ts,
      }
      tasks[idx] = next
      await this.saveAll(tasks)
    }

    await this.truncateRuns()
    return entry
  }

  async runs(taskId?: string, limit = 50): Promise<AgentTaskRun[]> {
    try {
      const raw = await fs.readFile(this.runsPath(), 'utf-8')
      const runs = raw.trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as AgentTaskRun)
        .filter(run => !taskId || run.taskId === taskId)
      return runs.slice(-limit).reverse()
    } catch {
      return []
    }
  }

  private async updateStatus(id: string, status: AgentTaskStatus): Promise<AgentTask> {
    const tasks = await this.list()
    const idx = tasks.findIndex(t => t.id === id)
    if (idx < 0) throw new Error(`找不到任务 ${id}`)
    tasks[idx] = { ...tasks[idx], lastStatus: status, updatedAt: now() }
    await this.saveAll(tasks)
    return tasks[idx]
  }

  private async saveAll(tasks: AgentTask[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.tasksPath(), JSON.stringify(tasks, null, 2), 'utf-8')
  }

  private async truncateRuns(): Promise<void> {
    try {
      const raw = await fs.readFile(this.runsPath(), 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      if (lines.length <= MAX_RUNS) return
      await fs.writeFile(this.runsPath(), lines.slice(-MAX_RUNS).join('\n') + '\n', 'utf-8')
    } catch { /* ignore */ }
  }
}
