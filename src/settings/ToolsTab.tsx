import { useEffect, useState, useRef } from 'react'

interface McpStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

interface SkillInfo {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  source: 'builtin' | 'user'
}

export function ToolsTab() {
  const [mcpServers, setMcpServers] = useState<McpStatus[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [mcpConfig, setMcpConfig] = useState('')
  const [editing, setEditing] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const [mcp, sk, cfg] = await Promise.all([
        window.ipc.invoke('mcp:status') as Promise<McpStatus[]>,
        window.ipc.invoke('skills:list') as Promise<SkillInfo[]>,
        window.ipc.invoke('mcp:read-config') as Promise<string>,
      ])
      setMcpServers(mcp)
      setSkills(sk)
      setMcpConfig(cfg)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const saveConfig = async () => {
    setSaveError('')
    try {
      JSON.parse(mcpConfig)
    } catch (e) {
      setSaveError(`JSON 格式错误: ${(e as Error).message}`)
      return
    }
    setSaving(true)
    try {
      await window.ipc.invoke('mcp:save-config', mcpConfig)
      setEditing(false)
      await refresh()
    } catch (e) {
      setSaveError(`保存失败: ${(e as Error).message}`)
    }
    setSaving(false)
  }

  const reloadSkills = async () => {
    await window.ipc.invoke('skills:reload')
    await refresh()
  }

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 16px' }}>工具</h2>

      {/* MCP Servers */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>MCP Servers</h3>
          {!editing && (
            <button onClick={() => setEditing(true)} style={btnStyle}>编辑配置</button>
          )}
        </div>

        {/* Status cards */}
        {!loading && mcpServers.map(s => (
          <div key={s.name} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: s.connected ? 'var(--good)' : 'var(--bad)'
              }} />
              <span style={{ fontWeight: 500, fontSize: 13 }}>{s.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {s.connected ? `${s.toolCount} 个工具` : '连接失败'}
              </span>
            </div>
            {s.error && <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 4 }}>{s.error}</div>}
          </div>
        ))}

        {/* JSON editor */}
        {editing ? (
          <div style={{ marginTop: 8 }}>
            <textarea
              ref={textareaRef}
              value={mcpConfig}
              onChange={e => { setMcpConfig(e.target.value); setSaveError('') }}
              spellCheck={false}
              autoFocus
              style={{
                width: '100%', minHeight: 200, resize: 'vertical',
                fontFamily: 'var(--font-mono, monospace)', fontSize: 12,
                lineHeight: 1.5, padding: 10,
                background: 'var(--bg)', color: 'var(--text)',
                border: '0.5px solid var(--hairline-strong)',
                borderRadius: 8, outline: 'none',
              }}
            />
            {saveError && (
              <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 4 }}>{saveError}</div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={saveConfig} disabled={saving} style={{
                ...btnStyle, background: 'var(--accent)', color: '#fff',
                opacity: saving ? 0.6 : 1,
              }}>
                {saving ? '保存中...' : '保存并重连'}
              </button>
              <button onClick={() => { setEditing(false); setSaveError(''); refresh() }} style={btnStyle}>
                取消
              </button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
              格式同 Claude Desktop: {'{'}"mcpServers": {'{'}"name": {'{'}"command": "...", "args": [...]{'}'}{'}'}{'}'}
            </div>
          </div>
        ) : !loading && mcpServers.length === 0 && (
          <div style={emptyStyle}>
            暂无配置。点击"编辑配置"添加 MCP Server。
          </div>
        )}
      </section>

      {/* Skills */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>技能 (Skills)</h3>
          <button onClick={reloadSkills} style={btnStyle} title="重新加载技能文件">刷新</button>
        </div>
        {!loading && skills.length === 0 && (
          <div style={emptyStyle}>暂无技能</div>
        )}
        {skills.map(s => (
          <div key={s.name} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 9, padding: '1px 4px', borderRadius: 3,
                background: s.source === 'builtin' ? 'var(--accent-soft)' : 'var(--elev)',
                color: 'var(--text-2)',
              }}>
                {s.source === 'builtin' ? '内置' : '用户'}
              </span>
              <span style={{ fontWeight: 500, fontSize: 13 }}>{s.name}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{s.description}</div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
              触发: {s.triggers.slice(0, 5).join(', ')}{s.triggers.length > 5 ? '...' : ''}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'var(--elev)', border: '0.5px solid var(--hairline-strong)',
  borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer',
  color: 'var(--text-2)',
}

const cardStyle: React.CSSProperties = {
  padding: '8px 12px', marginBottom: 6,
  background: 'var(--elev)', borderRadius: 8,
  border: '0.5px solid var(--hairline)',
}

const emptyStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-3)', padding: '8px 0',
}
