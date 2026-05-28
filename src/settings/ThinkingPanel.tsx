import { useEffect, useState } from 'react'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

type ChatTurnEvent = {
  id: string; type: string; ts: number; petId: string
  data: {
    userMsg?: string; petReply?: string; rounds?: number
    builtInToolCalls?: number; toolSummary?: string[]; localReply?: boolean
  }
}

function ToolChip({ summary }: { summary: string }) {
  // Parse "tool_name(input_preview) → exitCode"
  const match = summary.match(/^(\w+)\(([^)]*)\)\s*→\s*(\d+)$/)
  const name = match?.[1] ?? summary
  const preview = match?.[2] ?? ''
  const code = match?.[3]
  const ok = code === '0'

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, padding: '3px 8px', borderRadius: 6,
      background: ok ? 'rgba(52,168,83,.08)' : 'rgba(232,99,156,.08)',
      color: ok ? '#34a853' : '#e8639c',
      border: `1px solid ${ok ? 'rgba(52,168,83,.15)' : 'rgba(232,99,156,.15)'}`,
      fontFamily: 'var(--font-mono)',
    }}>
      <span style={{ fontWeight: 600 }}>{name}</span>
      {preview && <span style={{ opacity: 0.7 }}>({preview.slice(0, 20)})</span>}
    </span>
  )
}

export function ThinkingPanel() {
  const [events, setEvents] = useState<ChatTurnEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Use mood:diary-today to get recent events, then filter for chat_turn with tool data
    // Actually, let's use a broader approach - query last 3 days via a custom IPC
    window.ipc.invoke('insights:recent-chat-turns').then(d => {
      setEvents((d as ChatTurnEvent[]).filter(e => e.data.builtInToolCalls && e.data.builtInToolCalls > 0))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 40 }}>加载中…</div>

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>思考过程</h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        宠物回答你时使用的工具和推理步骤。
      </p>

      {events.length === 0 ? (
        <div style={{
          padding: 60, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
          background: 'var(--bg-3)', borderRadius: 12,
          border: '1px solid var(--hairline)',
        }}>
          最近的对话没有使用工具。问宠物一些需要查资料或执行任务的问题，这里会展示它的思考过程。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {events.map(ev => {
            const d = new Date(ev.ts)
            const time = d.toLocaleString('zh-CN', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })
            const tools = ev.data.toolSummary ?? []
            return (
              <div key={ev.id} style={{
                padding: '14px 16px',
                background: 'var(--surface-solid)',
                borderRadius: 10,
                border: '1px solid var(--hairline)',
              }}>
                {/* Header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 10,
                }}>
                  <span style={{ fontSize: 14 }}>🧠</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    {ev.data.rounds ?? 1} 轮推理
                  </span>
                  <span style={{
                    fontSize: 10, background: 'var(--accent-soft)',
                    color: 'var(--accent)', borderRadius: 4, padding: '1px 6px',
                    fontWeight: 600,
                  }}>
                    {ev.data.builtInToolCalls} 次工具调用
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{time}</span>
                </div>

                {/* User question preview */}
                {ev.data.userMsg && (
                  <div style={{
                    fontSize: 12, color: 'var(--text-2)', marginBottom: 10,
                    padding: '6px 10px', background: 'var(--bg-3)',
                    borderRadius: 6, lineHeight: 1.5,
                    borderLeft: '3px solid var(--accent-soft)',
                  }}>
                    <span style={{ fontSize: 10, color: 'var(--text-3)', display: 'block', marginBottom: 2 }}>
                      你问了
                    </span>
                    {ev.data.userMsg.length > 100 ? ev.data.userMsg.slice(0, 100) + '…' : ev.data.userMsg}
                  </div>
                )}

                {/* Tool calls */}
                {tools.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {tools.map((t, i) => <ToolChip key={i} summary={t} />)}
                  </div>
                )}

                {/* Reply preview */}
                {ev.data.petReply && (
                  <div style={{
                    fontSize: 12, color: 'var(--text-2)', marginTop: 10,
                    padding: '6px 10px', background: 'var(--bg-3)',
                    borderRadius: 6, lineHeight: 1.5,
                  }}>
                    <span style={{ fontSize: 10, color: 'var(--text-3)', display: 'block', marginBottom: 2 }}>
                      回复
                    </span>
                    {ev.data.petReply.length > 120 ? ev.data.petReply.slice(0, 120) + '…' : ev.data.petReply}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
