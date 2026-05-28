import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { CharacterConfig } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

const PERSONALITY_TAGS = ['活泼', '可爱', '积极', '严肃', '懒散', '极客', '温柔', '毒舌', '害羞', '高冷']

function Row({ label, hint, children, align = 'center' }: { label: string; hint?: string; children: React.ReactNode; align?: string }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '140px 1fr',
      gap: 16, alignItems: align as 'center' | 'flex-start',
      padding: '8px 0',
      borderBottom: '0.5px solid var(--separator)',
    }}>
      <div style={{ textAlign: 'right', paddingTop: align === 'flex-start' ? 6 : 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

export function CharacterEditor() {
  const [cfg, setCfg] = useState<CharacterConfig | null>(null)
  const [petId] = useState('stlulu')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.ipc.invoke(IPC.CHARACTER_GET, petId).then(c => setCfg(c as CharacterConfig))
  }, [petId])

  const save = async () => {
    if (!cfg) return
    await window.ipc.invoke(IPC.CHARACTER_SAVE, cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const toggleTag = (tag: string) => {
    if (!cfg) return
    const has = cfg.personality.includes(tag)
    setCfg({
      ...cfg,
      personality: has
        ? cfg.personality.filter(t => t !== tag)
        : [...cfg.personality, tag]
    })
  }

  if (!cfg) return <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 20 }}>加载中...</div>

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        角色配置 · {cfg.displayName}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
        每只宠物有独立的人格、问候语和 system prompt
      </div>

      <Row label="显示名">
        <input
          value={cfg.displayName}
          onChange={e => setCfg({ ...cfg, displayName: e.target.value })}
          style={{
            maxWidth: 240,
            fontFamily: 'var(--font)', fontSize: 13,
            height: 30, padding: '0 12px',
            borderRadius: 8, border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)', outline: 'none',
            width: '100%',
            transition: 'border-color 0.12s, box-shadow 0.12s',
          }}
        />
      </Row>

      <Row label="性格标签" hint="多选 · 影响生成的 system prompt">
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {PERSONALITY_TAGS.map(tag => {
            const on = cfg.personality.includes(tag)
            return (
              <div
                key={tag}
                onClick={() => toggleTag(tag)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  height: 22, padding: '0 9px',
                  borderRadius: 999, fontSize: 11, fontWeight: 500,
                  background: on ? 'var(--accent-soft)' : 'var(--hover)',
                  color: on ? 'var(--accent-2)' : 'var(--text-2)',
                  border: on ? '0.5px solid transparent' : '0.5px solid var(--hairline)',
                  cursor: 'pointer',
                  transition: 'all 0.12s',
                }}
              >
                {on && <span style={{ fontSize: 9 }}>✓</span>}
                {tag}
              </div>
            )
          })}
        </div>
      </Row>

      <Row label="问候语">
        <input
          value={cfg.greeting}
          onChange={e => setCfg({ ...cfg, greeting: e.target.value })}
          style={{
            fontFamily: 'var(--font)', fontSize: 13,
            height: 30, padding: '0 12px',
            borderRadius: 8, border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)', outline: 'none',
            width: '100%',
          }}
        />
      </Row>

      <Row label="System Prompt" hint="可直接编辑" align="flex-start">
        <textarea
          value={cfg.systemPrompt}
          onChange={e => setCfg({ ...cfg, systemPrompt: e.target.value })}
          rows={5}
          style={{
            fontFamily: 'var(--font)', fontSize: 13,
            padding: '8px 12px',
            borderRadius: 8, border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)', outline: 'none',
            width: '100%', resize: 'none' as const,
            lineHeight: 1.5,
          }}
        />
      </Row>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button
          onClick={save}
          style={{
            fontFamily: 'var(--font)', fontSize: 13,
            height: 28, padding: '0 14px',
            borderRadius: 7,
            border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--shadow-inset)',
          }}
        >
          重置默认
        </button>
        <button
          onClick={save}
          style={{
            fontFamily: 'var(--font)', fontSize: 13,
            height: 28, padding: '0 14px',
            borderRadius: 7,
            border: 'none',
            background: 'var(--accent)', color: 'var(--text-on-accent)',
            cursor: 'pointer', fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 0 rgba(255,255,255,0.25) inset, 0 2px 6px var(--accent-glow)',
          }}
        >
          {saved ? '✓ 已保存' : '保存'}
        </button>
      </div>
    </div>
  )
}
