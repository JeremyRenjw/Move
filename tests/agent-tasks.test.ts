import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { default: fs.promises }
})

import { AgentTaskStore } from '../electron/agent-tasks'

beforeEach(async () => {
  const { vol } = await import('memfs')
  vol.reset()
})

describe('AgentTaskStore', () => {
  it('creates AI tasks as unapproved by default', async () => {
    const store = new AgentTaskStore('/userData')
    const task = await store.create({
      title: '检查项目状态',
      goal: '每小时总结项目状态',
      schedule: 'interval',
      intervalMinutes: 30,
      source: 'ai',
    })

    expect(task.approved).toBe(false)
    expect(task.requireApproval).toBe(true)
    expect(task.nextRunAt).toBeUndefined()
  })

  it('schedules approved interval tasks', async () => {
    const store = new AgentTaskStore('/userData')
    const task = await store.create({
      title: '检查项目状态',
      goal: '每小时总结项目状态',
      schedule: 'interval',
      intervalMinutes: 30,
      source: 'user',
    })

    expect(task.approved).toBe(true)
    expect(task.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('records runs and moves nextRunAt forward', async () => {
    const store = new AgentTaskStore('/userData')
    const task = await store.create({
      title: '检查项目状态',
      goal: '每小时总结项目状态',
      schedule: 'interval',
      intervalMinutes: 30,
      source: 'user',
    })

    const run = await store.recordRun(task.id, {
      status: 'success',
      durationMs: 12,
      result: '一切正常',
    })
    const updated = await store.get(task.id)

    expect(run.taskId).toBe(task.id)
    expect(updated?.lastStatus).toBe('success')
    expect(updated?.lastResult).toBe('一切正常')
    expect(updated?.nextRunAt).toBeGreaterThan(run.ts)
  })
})
