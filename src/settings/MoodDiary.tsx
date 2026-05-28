import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { PetMood, PetStage, MoodState, PetEvent } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

// ─── Event display config ───

type Tone = 'good' | 'work' | 'alert' | 'celebrate' | 'soft' | 'night' | 'neutral'

const TONE_COLOR: Record<Tone, string> = {
  good:      'var(--good)',
  work:      'var(--accent)',
  alert:     'var(--bad)',
  celebrate: 'var(--accent)',
  soft:      'var(--info)',
  night:     '#8b5cf6',
  neutral:   'var(--text-3)',
}

function classifyEvent(ev: PetEvent): { icon: string; tone: Tone; title: string; sub: string } {
  switch (ev.type) {
    case 'hook_signal': {
      const event = ev.data.event as string
      if (event === 'session_start') return { icon: '⚡', tone: 'work', title: '开始工作', sub: 'Claude Code 会话启动' }
      if (event === 'stop') return { icon: '✅', tone: 'good', title: '会话结束', sub: '任务完成' }
      if (event === 'Error') return { icon: '🔥', tone: 'alert', title: '出错了', sub: ev.data.message as string ?? '有错误发生' }
      return { icon: '⚡', tone: 'work', title: event, sub: ev.data.tool as string ?? '' }
    }
    case 'system_snapshot': {
      const cpu = ev.data.cpu as number | undefined
      if (cpu && cpu > 80) return { icon: '🔥', tone: 'alert', title: '系统负载高', sub: `CPU ${cpu}%` }
      return { icon: '📊', tone: 'neutral', title: '系统快照', sub: cpu ? `CPU ${cpu}%` : '系统状态' }
    }
    case 'chat_turn': return { icon: '💬', tone: 'good', title: '对话', sub: '和宠物聊了一会儿' }
    case 'tool_call': return { icon: '🔧', tone: 'work', title: '使用工具', sub: ev.data.tool as string ?? '' }
    case 'reflector_pass': return { icon: '🧠', tone: 'soft', title: '思考中', sub: '宠物回顾了最近的事' }
    case 'curator_pass': return { icon: '📚', tone: 'soft', title: '整理知识', sub: '宠物整理了记忆和技能' }
    case 'drive_goal': {
      const kind = ev.data.kind as string
      const map: Record<string, { icon: string; title: string }> = {
        greet:        { icon: '👋', title: '打招呼' },
        comfort:      { icon: '💛', title: '安慰你' },
        check_in:     { icon: '💭', title: '关心你' },
        curiosity:    { icon: '✨', title: '好奇' },
        celebrate:    { icon: '🎉', title: '庆祝' },
        remind_rest:  { icon: '🌙', title: '提醒休息' },
        system_check: { icon: '🔍', title: '检查系统' },
      }
      const m = map[kind] ?? { icon: '💭', title: kind }
      return { icon: m.icon, tone: 'celebrate', title: m.title, sub: '' }
    }
    case 'user_feedback': return { icon: '👍', tone: 'good', title: '反馈', sub: ev.data.positive ? '正面反馈' : '改进建议' }
    case 'fact_remembered': return { icon: '📝', tone: 'soft', title: '记住了', sub: ev.data.content as string ?? '新记忆' }
    case 'playbook_used': return { icon: '🎯', tone: 'work', title: '应用技能', sub: '宠物用了一个已学的技能' }
    default: return { icon: '·', tone: 'neutral', title: ev.type, sub: '' }
  }
}

// ─── Component ───

export function MoodDiary() {
  const [state, setState] = useState<MoodState | null>(null)
  const [events, setEvents] = useState<PetEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.ipc.invoke('mood:diary-today').then(data => {
      const d = data as { mood: MoodState; events: PetEvent[] }
      setState(d.mood)
      setEvents(d.events)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 40 }}>加载中…</div>

  const now = new Date()
  const dateStr = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${['日','一','二','三','四','五','六'][now.getDay()]}`

  const moodLabel: Record<PetMood, string> = {
    happy: '开心', calm: '平静', tired: '疲惫', worried: '担心', excited: '兴奋', lonely: '想你',
  }
  const stageLabel: Record<PetStage, string> = {
    baby: '幼崽', child: '幼年', teen: '少年', adult: '成年', elder: '长者',
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
            letterSpacing: '.08em', textTransform: 'uppercase' }}>
            {dateStr}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>
            今日心情
          </h2>
        </div>
        <div style={{ flex: 1 }} />
        {state && (
          <div style={{ display: 'flex', gap: 16 }}>
            <DiaryStat label="情绪" value={moodLabel[state.mood]} color="var(--accent)" />
            <DiaryStat label="体力" value={state.energy} color="var(--good)" />
            <DiaryStat label="好感" value={state.affection} color="var(--accent)" />
            <DiaryStat label="阶段" value={stageLabel[state.stage]} />
          </div>
        )}
      </div>

      {/* Timeline */}
      {events.length === 0 ? (
        <div style={{
          padding: 40, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
        }}>
          今天还没有记录，宠物在安静地等你。
        </div>
      ) : (
        <div style={{ position: 'relative', paddingLeft: 26 }}>
          {/* Vertical line */}
          <div style={{
            position: 'absolute', left: 6, top: 8, bottom: 8,
            width: 2, background: 'var(--hairline)', borderRadius: 1,
          }} />

          {events.map((ev, i) => {
            const { icon, tone, title, sub } = classifyEvent(ev)
            const d = new Date(ev.ts)
            const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            return (
              <div key={ev.id ?? i} style={{
                position: 'relative', marginBottom: 16,
                display: 'flex', gap: 12, alignItems: 'flex-start',
              }}>
                {/* Dot */}
                <div style={{
                  position: 'absolute', left: -26, top: 4,
                  width: 12, height: 12, borderRadius: '50%',
                  background: TONE_COLOR[tone],
                  border: '2px solid var(--surface)',
                  boxShadow: '0 0 0 1px var(--hairline)',
                }} />
                {/* Time */}
                <div style={{
                  fontSize: 11, color: 'var(--text-3)',
                  minWidth: 40, paddingTop: 1,
                  fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                }}>{timeStr}</div>
                {/* Icon */}
                <div style={{ fontSize: 16, lineHeight: 1, paddingTop: 1 }}>{icon}</div>
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
                  {sub && (
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.5 }}>
                      {sub}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Tomorrow teaser */}
      {events.length > 0 && (
        <div style={{
          marginTop: 24, padding: '12px 14px',
          background: 'var(--accent-soft)',
          border: '1px dashed rgba(0,0,0,.06)',
          borderRadius: 10,
          fontSize: 12, color: 'var(--accent-deep)', lineHeight: 1.6,
        }}>
          <b>明天我想跟你说……</b><br />
          <span style={{ color: 'var(--text-2)' }}>
            今天记录了 {events.length} 个时刻，我会继续观察你的节奏。
          </span>
        </div>
      )}
    </div>
  )
}

function DiaryStat({ label, value, color = 'var(--text)' }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{
        fontSize: 9, fontWeight: 600, color: 'var(--text-3)',
        letterSpacing: '.06em', textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{
        fontSize: 14, fontWeight: 600, color, marginTop: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  )
}
