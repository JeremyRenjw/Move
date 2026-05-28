import { useEffect, useState } from 'react'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

type Insight = {
  id: string
  icon: string
  title: string
  detail: string
  confidence: number
  kind: 'pattern' | 'suggestion' | 'milestone'
}

const KIND_LABEL: Record<string, { label: string; bg: string; color: string }> = {
  pattern:     { label: '规律', bg: 'var(--accent-soft)', color: 'var(--accent)' },
  suggestion:  { label: '建议', bg: 'rgba(232,99,156,.1)', color: '#e8639c' },
  milestone:   { label: '里程碑', bg: 'rgba(52,168,83,.1)', color: '#34a853' },
}

export function InsightsPanel() {
  const [insights, setInsights] = useState<Insight[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.ipc.invoke('insights:list').then(d => {
      setInsights(d as Insight[])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 40 }}>加载中…</div>

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>主动洞察</h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        宠物从你的使用模式中发现的规律和建议。
      </p>

      {insights.length === 0 ? (
        <div style={{
          padding: 60, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
          background: 'var(--bg-3)', borderRadius: 12,
          border: '1px solid var(--hairline)',
        }}>
          还没有足够的数据来发现规律。多用几天后，宠物会告诉你它观察到了什么。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {insights.map(ins => {
            const kind = KIND_LABEL[ins.kind] ?? KIND_LABEL.pattern
            return (
              <div key={ins.id} style={{
                padding: '14px 16px',
                background: 'var(--surface-solid)',
                borderRadius: 10,
                border: '1px solid var(--hairline)',
                display: 'flex', gap: 14, alignItems: 'flex-start',
              }}>
                {/* Icon */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: kind.bg,
                  display: 'grid', placeItems: 'center',
                  fontSize: 18, flexShrink: 0,
                }}>
                  {ins.icon}
                </div>
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {ins.title}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      background: kind.bg, color: kind.color,
                      borderRadius: 4, padding: '1px 6px',
                    }}>
                      {kind.label}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{
                      fontSize: 10, color: 'var(--text-3)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {(ins.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                    {ins.detail}
                  </div>
                </div>
              </div>
            )
          })}

          <div style={{
            marginTop: 8, padding: '10px 14px',
            background: 'var(--accent-soft)', borderRadius: 10,
            fontSize: 11, color: 'var(--accent-deep)', lineHeight: 1.6,
          }}>
            洞察基于过去 7 天的行为数据，随着使用时间增长会越来越准确。
          </div>
        </div>
      )}
    </div>
  )
}
