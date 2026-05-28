import type { EventStore } from './event-store'
import type { PetEvent } from '@shared/types'

export type Insight = {
  id: string
  icon: string
  title: string
  detail: string
  confidence: number   // 0-1
  kind: 'pattern' | 'suggestion' | 'milestone'
}

/**
 * Analyze the last N days of pet events and return behavioral insights.
 * Pure function — no side effects, no external calls.
 */
export async function detectInsights(
  events: EventStore,
  petId: string,
  days: number = 7,
): Promise<Insight[]> {
  const now = Date.now()
  const from = now - days * 86_400_000
  const evts = await events.range(petId, from, now)
  if (evts.length < 3) return []

  const insights: Insight[] = []

  // 1. Work time pattern — when does the user start working?
  const sessions = evts.filter(e => e.type === 'hook_signal' && e.data.event === 'session_start')
  if (sessions.length >= 3) {
    const hours = sessions.map(e => new Date(e.ts).getHours())
    const avgHour = hours.reduce((a, b) => a + b, 0) / hours.length
    const stdDev = Math.sqrt(hours.reduce((s, h) => s + (h - avgHour) ** 2, 0) / hours.length)
    if (stdDev < 3) {
      const h = Math.round(avgHour)
      insights.push({
        id: 'work-time',
        icon: '⏰',
        title: '工作节奏',
        detail: `你通常在 ${h}:00 左右开始工作`,
        confidence: Math.max(0.4, 1 - stdDev / 5),
        kind: 'pattern',
      })
    }
  }

  // 2. Most active day
  const dayCount: Record<string, number> = {}
  for (const e of evts) {
    const day = new Date(e.ts).toLocaleDateString('zh-CN', { weekday: 'long' })
    dayCount[day] = (dayCount[day] ?? 0) + 1
  }
  const topDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]
  if (topDay && topDay[1] >= 5) {
    insights.push({
      id: 'active-day',
      icon: '📊',
      title: '最活跃的一天',
      detail: `${topDay[0]}是你最忙的时候，共 ${topDay[1]} 个事件`,
      confidence: 0.7,
      kind: 'pattern',
    })
  }

  // 3. Chat frequency
  const chatTurns = evts.filter(e => e.type === 'chat_turn')
  if (chatTurns.length >= 5) {
    const chatDays = new Set(chatTurns.map(e => new Date(e.ts).toISOString().slice(0, 10)))
    insights.push({
      id: 'chat-streak',
      icon: '💬',
      title: '对话频率',
      detail: `过去 ${days} 天有 ${chatDays.size} 天在聊天，共 ${chatTurns.length} 轮`,
      confidence: 0.8,
      kind: 'milestone',
    })
  }

  // 4. Error pattern
  const errors = evts.filter(e =>
    e.type === 'hook_signal' && e.data.event === 'Error'
  )
  if (errors.length >= 3) {
    const errorDays = new Set(errors.map(e => new Date(e.ts).toISOString().slice(0, 10)))
    insights.push({
      id: 'error-freq',
      icon: '⚠️',
      title: '错误频率',
      detail: `${errorDays.size} 天内出现 ${errors.length} 次错误`,
      confidence: 0.6,
      kind: 'suggestion',
    })
  }

  // 5. Tool usage growth
  const toolEvents = evts.filter(e => e.type === 'chat_turn' && e.data.builtInToolCalls > 0)
  if (toolEvents.length >= 3) {
    const mid = Math.floor(toolEvents.length / 2)
    const firstHalfTools = toolEvents.slice(0, mid).reduce((s, e) => s + (e.data.builtInToolCalls ?? 0), 0)
    const secondHalfTools = toolEvents.slice(mid).reduce((s, e) => s + (e.data.builtInToolCalls ?? 0), 0)
    if (secondHalfTools > firstHalfTools * 1.5) {
      insights.push({
        id: 'tool-growth',
        icon: '🔧',
        title: '工具使用增长',
        detail: '最近工具调用频率明显上升，你在更多地利用自动化',
        confidence: 0.6,
        kind: 'milestone',
      })
    }
  }

  // 6. Playbook learning
  const playbookCreated = evts.filter(e => e.type === 'playbook_created')
  const playbookUsed = evts.filter(e => e.type === 'playbook_used')
  if (playbookCreated.length > 0) {
    insights.push({
      id: 'playbook-growth',
      icon: '📚',
      title: '技能成长',
      detail: `学会了 ${playbookCreated.length} 个新技能，使用了 ${playbookUsed.length} 次`,
      confidence: 0.8,
      kind: 'milestone',
    })
  }

  // 7. Late night work
  const lateEvents = evts.filter(e => {
    const h = new Date(e.ts).getHours()
    return h >= 0 && h < 6
  })
  if (lateEvents.length >= 5) {
    insights.push({
      id: 'late-work',
      icon: '🌙',
      title: '深夜工作',
      detail: `${lateEvents.length} 个事件发生在凌晨，注意休息`,
      confidence: 0.7,
      kind: 'suggestion',
    })
  }

  // Sort by confidence descending
  return insights.sort((a, b) => b.confidence - a.confidence)
}
