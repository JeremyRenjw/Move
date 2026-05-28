import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { ApiConfig } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

const MODELS: Record<'claude' | 'openai', { label: string; id: string }[]> = {
  claude: [
    { label: 'Claude Opus 4 (1M)', id: 'claude-opus-4-7' },
    { label: 'Claude Sonnet 4', id: 'claude-sonnet-4-6' },
    { label: 'Claude Haiku 4', id: 'claude-haiku-4-5-20251001' },
  ],
  openai: [
    { label: 'GPT-5.5', id: 'gpt-5.5' },
    { label: 'GPT-5.4', id: 'gpt-5.4' },
    { label: 'GPT-5.4 mini', id: 'gpt-5.4-mini' },
    { label: 'GPT-5.3 Codex', id: 'gpt-5.3-codex' },
    { label: 'GPT-5.2', id: 'gpt-5.2' },
    { label: 'GPT-5.2 Pro', id: 'gpt-5.2-pro' },
  ]
}

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

const INPUT_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font)', fontSize: 13,
  height: 30, padding: '0 12px',
  borderRadius: 8, border: '0.5px solid var(--hairline-strong)',
  background: 'var(--elev)', color: 'var(--text)', outline: 'none',
  width: '100%',
  transition: 'border-color 0.12s, box-shadow 0.12s',
}

export function ApiSettings() {
  const [api, setApiState] = useState<ApiConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.ipc.invoke(IPC.API_CONFIG_GET).then(c => setApiState(c as ApiConfig))
    window.ipc.invoke('character:get-api-key').then(k => setApiKey((k as string) ?? ''))
  }, [])

  const save = async () => {
    if (!api) return
    await window.ipc.invoke(IPC.API_CONFIG_SAVE, api)
    if (apiKey) await window.ipc.invoke('character:save-api-key', { key: apiKey })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!api) return null

  const setApi = (patch: Partial<ApiConfig>) => setApiState({ ...api, ...patch })
  const options = MODELS[api.provider]
  const isKnown = options.some(m => m.id === api.model)

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>API 配置</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>密钥安全存储在系统钥匙串中</div>

      <Row label="提供商" hint="Mote 使用">
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            { id: 'claude' as const, label: 'Anthropic', model: 'claude-opus-4-7' },
            { id: 'openai' as const, label: 'OpenAI 兼容', model: 'gpt-5 / 本地' },
          ]).map(p => {
            const isActive = api.provider === p.id
            return (
              <div
                key={p.id}
                onClick={() => setApi({ provider: p.id, model: MODELS[p.id][0].id, baseUrl: undefined })}
                style={{
                  flex: 1, padding: 10,
                  border: isActive ? '1.5px solid var(--accent)' : '0.5px solid var(--hairline)',
                  borderRadius: 10, cursor: 'pointer',
                  background: isActive ? 'var(--accent-soft)' : 'var(--elev)',
                  transition: 'all 0.12s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{
                    width: 13, height: 13, borderRadius: '50%',
                    border: `1.5px solid ${isActive ? 'var(--accent)' : 'var(--hairline-strong)'}`,
                    background: isActive ? 'var(--accent)' : 'transparent',
                    display: 'grid', placeItems: 'center',
                  }}>
                    {isActive && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#fff' }} />}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4, paddingLeft: 19 }}>{p.model}</div>
              </div>
            )
          })}
        </div>
      </Row>

      <Row label="模型">
        <select
          value={isKnown ? api.model : '__custom'}
          onChange={e => {
            if (e.target.value !== '__custom') setApi({ model: e.target.value })
          }}
          style={{ ...INPUT_STYLE, maxWidth: 240, cursor: 'pointer' }}
        >
          {options.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          {!isKnown && api.model && <option value="__custom">自定义: {api.model}</option>}
          <option value="__custom">自定义模型 ID...</option>
        </select>
        {!isKnown && (
          <input
            value={api.model}
            onChange={e => setApi({ model: e.target.value })}
            placeholder="模型 ID"
            style={{ ...INPUT_STYLE, marginTop: 6, maxWidth: 240 }}
          />
        )}
      </Row>

      <Row label="API Key" hint="存储于 macOS Keychain">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-... 或 sk-..."
            style={{ ...INPUT_STYLE, maxWidth: 280 }}
          />
          <button style={{
            fontFamily: 'var(--font)', fontSize: 11,
            height: 22, padding: '0 8px',
            borderRadius: 5, border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)',
            cursor: 'pointer', boxShadow: 'var(--shadow-inset)',
          }}>测试</button>
        </div>
        {apiKey && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--good)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--good)' }} />
            已配置
          </div>
        )}
      </Row>

      <Row label="Base URL" hint="可选 · 用于自托管">
        <input
          value={api.baseUrl ?? ''}
          onChange={e => setApi({ baseUrl: e.target.value || undefined })}
          placeholder={api.provider === 'claude' ? '默认: api.anthropic.com' : '默认: api.openai.com'}
          style={{ ...INPUT_STYLE, maxWidth: 320 }}
        />
      </Row>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button
          onClick={save}
          style={{
            fontFamily: 'var(--font)', fontSize: 13,
            height: 28, padding: '0 14px',
            borderRadius: 7,
            border: 'none',
            background: 'var(--accent)', color: 'var(--text-on-accent)',
            cursor: 'pointer', fontWeight: 600,
            boxShadow: '0 1px 0 rgba(255,255,255,0.25) inset, 0 2px 6px var(--accent-glow)',
          }}
        >
          {saved ? '✓ 已保存' : '保存'}
        </button>
      </div>
    </div>
  )
}
