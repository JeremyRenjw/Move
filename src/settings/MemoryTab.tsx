import { useEffect, useState, useCallback } from 'react'
import { IPC } from '@shared/types'

const ipc = window.ipc

type Fact = {
  id: string; type: string; content: string; confidence: number
  superseded_by?: string; created_at?: string
}

type Playbook = {
  id: string; title: string; triggers: string[]; uses: number
  confidence: number; enabled: boolean; created?: string
}

const FACT_ICONS: Record<string, string> = {
  preference: '💜', habit: '🔄', schedule: '📅', tool: '🔧',
  goal: '🎯', skill: '⭐', person: '👤', project: '📁',
  default: '📝',
}

const FACT_COLORS: Record<string, string> = {
  preference: '#8b5cf6', habit: '#34a853', schedule: '#4a90e2', tool: '#e89534',
  goal: '#e8639c', skill: '#f5a623', person: '#4a90e2', project: '#34a853',
  default: 'var(--text-2)',
}

function factIcon(type: string): string { return FACT_ICONS[type] ?? FACT_ICONS.default }
function factColor(type: string): string { return FACT_COLORS[type] ?? FACT_COLORS.default }

export function MemoryTab() {
  const [petId, setPetId] = useState<string | null>(null)
  const [facts, setFacts] = useState<Fact[]>([])
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [loading, setLoading] = useState(true)
  const [showSuperseded, setShowSuperseded] = useState(false)

  const reload = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const [f, p] = await Promise.all([
        ipc.invoke('memory:list-facts', id) as Promise<Fact[]>,
        ipc.invoke('memory:list-playbooks') as Promise<Playbook[]>,
      ])
      setFacts(f)
      setPlaybooks(p)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    (async () => {
      const id = await (ipc.invoke(IPC.PET_GET_ACTIVE) as Promise<string | null>)
      const next = id ?? 'stlulu'
      setPetId(next)
      await reload(next)
    })()
    const dispose = ipc.on(IPC.PET_ACTIVE_CHANGED, p => {
      const next = (p as { id?: string })?.id ?? 'stlulu'
      setPetId(next)
      reload(next)
    })
    return dispose
  }, [reload])

  if (loading || !petId) return <div style={{ color: 'var(--text-3)', padding: 40 }}>加载中…</div>

  const activeFacts = facts.filter(f => !f.superseded_by)
  const oldFacts = facts.filter(f => f.superseded_by)

  // Group facts by type
  const grouped: Record<string, Fact[]> = {}
  for (const f of activeFacts) {
    const key = f.type || 'default'
    ;(grouped[key] ??= []).push(f)
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>记忆库</h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        宠物记住的关于你的事实和已学会的技能。
      </p>

      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: 20,
        padding: '10px 14px', background: 'var(--bg-3)',
        borderRadius: 10, border: '1px solid var(--hairline)',
        fontSize: 12,
      }}>
        <span><b style={{ color: 'var(--accent)' }}>{activeFacts.length}</b> 条记忆</span>
        <span><b style={{ color: 'var(--good)' }}>{playbooks.filter(p => p.enabled).length}</b> 个技能</span>
        {oldFacts.length > 0 && (
          <span style={{ color: 'var(--text-3)' }}>{oldFacts.length} 条已过期</span>
        )}
        <span style={{ flex: 1 }} />
        {oldFacts.length > 0 && (
          <button
            onClick={() => setShowSuperseded(v => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 11, color: 'var(--text-3)', textDecoration: 'underline',
            }}
          >
            {showSuperseded ? '隐藏' : '查看'}已过期
          </button>
        )}
      </div>

      {/* Memory cards by type */}
      {Object.keys(grouped).length === 0 && (
        <div style={{
          padding: 40, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
          background: 'var(--bg-3)', borderRadius: 12,
          border: '1px dashed var(--hairline)',
        }}>
          还没有记忆。多和宠物聊天，它会记住关于你的事情。
        </div>
      )}

      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} style={{ marginBottom: 20 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            <span style={{ fontSize: 14 }}>{factIcon(type)}</span>
            <span>{type}</span>
            <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>{items.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map(f => (
              <FactCard
                key={f.id}
                fact={f}
                onDelete={() => {
                  ipc.invoke('memory:delete-fact', { petId, factId: f.id })
                  setFacts(prev => prev.filter(x => x.id !== f.id))
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Superseded facts */}
      {showSuperseded && oldFacts.length > 0 && (
        <div style={{ marginBottom: 20, opacity: 0.6 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: 'var(--text-3)',
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            已过期
          </div>
          {oldFacts.map(f => (
            <div key={f.id} style={{
              padding: '8px 12px', marginBottom: 4,
              background: 'var(--bg-3)', borderRadius: 6,
              fontSize: 12, color: 'var(--text-3)',
              textDecoration: 'line-through',
            }}>
              {f.content}
            </div>
          ))}
        </div>
      )}

      {/* Playbooks section */}
      <h3 style={{
        fontSize: 14, fontWeight: 600, color: 'var(--text)',
        margin: '24px 0 12px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 14 }}>⚡</span> 技能库
      </h3>

      {playbooks.length === 0 && (
        <div style={{
          padding: 24, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 12,
          background: 'var(--bg-3)', borderRadius: 10,
        }}>
          宠物还没学会任何技能。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {playbooks.map(p => (
          <PlaybookCard
            key={p.id}
            playbook={p}
            onToggle={() => {
              const next = !p.enabled
              ipc.invoke('memory:toggle-playbook', { id: p.id, enabled: next })
              setPlaybooks(prev => prev.map(x => x.id === p.id ? { ...x, enabled: next } : x))
            }}
          />
        ))}
      </div>
    </div>
  )
}

function FactCard({ fact, onDelete }: { fact: Fact; onDelete: () => void }) {
  const color = factColor(fact.type)
  return (
    <div style={{
      padding: '10px 14px',
      background: 'var(--surface-solid)',
      borderRadius: 8,
      border: '1px solid var(--hairline)',
      borderLeft: `3px solid ${color}`,
      display: 'flex', alignItems: 'flex-start', gap: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
          {fact.content}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 10, color: 'var(--text-3)' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            置信度 {(fact.confidence * 100).toFixed(0)}%
          </span>
          {fact.created_at && (
            <span>{new Date(fact.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</span>
          )}
        </div>
      </div>
      <button
        onClick={onDelete}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, color: 'var(--text-3)', lineHeight: 1, padding: '2px 4px',
          borderRadius: 4, flexShrink: 0,
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--bad, #e55)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}
        title="删除"
      >×</button>
    </div>
  )
}

function PlaybookCard({ playbook, onToggle }: { playbook: Playbook; onToggle: () => void }) {
  return (
    <div style={{
      padding: '10px 14px',
      background: 'var(--surface-solid)',
      borderRadius: 8,
      border: '1px solid var(--hairline)',
      opacity: playbook.enabled ? 1 : 0.5,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {playbook.title}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '1px 6px',
          background: playbook.enabled ? 'var(--good)' : 'var(--text-3)',
          color: '#fff',
        }}>
          {playbook.enabled ? '启用' : '禁用'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
          用过 {playbook.uses} 次 · {(playbook.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {playbook.triggers.map((t, i) => (
          <span key={i} style={{
            fontSize: 10, background: 'var(--accent-soft)', color: 'var(--accent-deep)',
            borderRadius: 4, padding: '1px 6px',
          }}>
            {t}
          </span>
        ))}
      </div>
      <button
        onClick={onToggle}
        style={{
          fontSize: 11, background: 'none',
          border: '1px solid var(--hairline)', borderRadius: 4,
          color: 'var(--text-3)', cursor: 'pointer', padding: '2px 8px',
        }}
      >
        {playbook.enabled ? '禁用' : '启用'}
      </button>
    </div>
  )
}
