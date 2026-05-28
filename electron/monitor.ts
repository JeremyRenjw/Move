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
      const ramUsed = typeof mem.available === 'number'
        ? mem.total - mem.available
        : (mem.used ?? 0)
      return {
        cpu:           Math.round(load.currentLoad),
        ramUsed,
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
    const tick = async () => {
      try { onStats(await this.collect()) } catch { /* swallow */ }
    }
    this.timer = setInterval(tick, 2000)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
