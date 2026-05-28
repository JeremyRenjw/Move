import { describe, expect, it } from 'vitest'

import { getLocalStatusReply } from '../electron/local-status-replies'
import type { SystemStats } from '../src-shared/types'

const STATS: SystemStats = {
  cpu: 42,
  ramUsed: 8e9,
  ramTotal: 16e9,
  diskUsed: 55,
  claudeRunning: false,
  codexRunning: true,
}

describe('getLocalStatusReply', () => {
  it('answers CPU questions from local stats', () => {
    const reply = getLocalStatusReply('现在 CPU 怎么样', STATS)

    expect(reply).toContain('CPU 42%')
    expect(reply).toContain('正常')
    expect(reply).not.toContain('内存')
  })

  it('answers general status questions with resource summary', () => {
    const reply = getLocalStatusReply('系统状态怎么样', STATS)

    expect(reply).toContain('CPU 42%')
    expect(reply).toContain('内存 8.0GB / 16.0GB')
    expect(reply).toContain('磁盘已用 55%')
    expect(reply).toContain('Codex 正在运行')
  })

  it('ignores unrelated chat', () => {
    expect(getLocalStatusReply('今天吃什么', STATS)).toBeNull()
  })
})
