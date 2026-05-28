import type { SystemStats } from '@shared/types'

function percent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  return `${Math.max(0, Math.round(value))}%`
}

function gb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0GB'
  return `${(bytes / 1e9).toFixed(1)}GB`
}

function ramPercent(stats: SystemStats): number {
  if (!Number.isFinite(stats.ramTotal) || stats.ramTotal <= 0) return 0
  return Math.round((stats.ramUsed / stats.ramTotal) * 100)
}

function cpuLabel(cpu: number): string {
  if (cpu >= 85) return '偏高'
  if (cpu >= 60) return '有点忙'
  return '正常'
}

function ramLabel(ram: number): string {
  if (ram >= 90) return '偏高'
  if (ram >= 75) return '有点高'
  return '正常'
}

export function getLocalStatusReply(message: string, stats: SystemStats): string | null {
  const text = message.trim().toLowerCase()
  if (!text) return null

  const asksCpu = /\bcpu\b|处理器|负载/.test(text)
  const asksRam = /内存|\bram\b|memory/.test(text)
  const asksDisk = /磁盘|硬盘|disk|存储/.test(text)
  const asksProcess = /claude|codex|进程|运行/.test(text)
  const asksGeneralStatus = /系统.*(状态|情况)|状态.*(系统|怎么样)|资源.*(占用|状态)|电脑.*(状态|情况)|卡不卡|性能/.test(text)

  if (!asksCpu && !asksRam && !asksDisk && !asksProcess && !asksGeneralStatus) {
    return null
  }

  const ramPct = ramPercent(stats)
  const lines: string[] = []

  if (asksCpu || asksGeneralStatus) {
    lines.push(`CPU ${percent(stats.cpu)}，${cpuLabel(stats.cpu)}。`)
  }
  if (asksRam || asksGeneralStatus) {
    lines.push(`内存 ${gb(stats.ramUsed)} / ${gb(stats.ramTotal)}（${percent(ramPct)}），${ramLabel(ramPct)}。`)
  }
  if (asksDisk || asksGeneralStatus) {
    lines.push(`磁盘已用 ${percent(stats.diskUsed)}。`)
  }
  if (asksProcess || asksGeneralStatus) {
    const running = [
      stats.claudeRunning ? 'Claude' : '',
      stats.codexRunning ? 'Codex' : ''
    ].filter(Boolean)
    lines.push(running.length > 0 ? `${running.join('、')} 正在运行。` : 'Claude / Codex 当前未检测到运行。')
  }

  if (stats.cpu >= 85 || ramPct >= 90) {
    lines.push('如果你觉得机器变慢，可以让我继续看下高占用进程。')
  }

  return lines.join('\n')
}
