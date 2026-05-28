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
    vi.mocked((si.default as any).currentLoad).mockRejectedValueOnce(new Error('fail'))
    const monitor = new SystemMonitor()
    const stats = await monitor.collect()
    expect(stats.cpu).toBe(0)
  })
})
