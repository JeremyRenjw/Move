import { useEffect, useState, useCallback } from 'react'
import { IPC } from '@shared/types'
import type { HookInstallStatus, NotifyEvent, RuntimeInfo } from '@shared/types'
import { NOTIFICATION_SOURCES } from '@shared/notification-sources'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      on:     (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

export function NotifyTab() {
  const [statuses, setStatuses] = useState<HookInstallStatus[]>([])
  const [recent,   setRecent]   = useState<NotifyEvent[]>([])
  const [rt,       setRt]       = useState<RuntimeInfo | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [sources,  setSources]  = useState<Record<string, boolean>>({})
  const [autoStart, setAutoStart] = useState(false)

  const refresh = useCallback(async () => {
    const [s, r, i, src, as] = await Promise.all([
      window.ipc.invoke(IPC.NOTIFY_HOOK_GET_STATUS) as Promise<HookInstallStatus[]>,
      window.ipc.invoke(IPC.NOTIFY_RECENT_EVENTS)    as Promise<NotifyEvent[]>,
      window.ipc.invoke(IPC.NOTIFY_RUNTIME_INFO)     as Promise<RuntimeInfo>,
      window.ipc.invoke(IPC.NOTIFY_SOURCES_GET)      as Promise<Record<string, boolean>>,
      window.ipc.invoke(IPC.AUTOSTART_GET)           as Promise<boolean>,
    ])
    setStatuses(s); setRecent(r); setRt(i); setSources(src); setAutoStart(as)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const toggleSource = async (key: string) => {
    const next = { ...sources, [key]: !(sources[key] !== false) }
    setSources(next)
    await window.ipc.invoke(IPC.NOTIFY_SOURCES_SAVE, { sources: next })
  }

  const toggleAutoStart = async () => {
    const next = !autoStart
    setAutoStart(next)
    await window.ipc.invoke(IPC.AUTOSTART_SET, next)
  }

  const handleInstall = async (tool: 'claude' | 'codex') => {
    if (!confirm(`即将往 ${statuses.find(s => s.tool === tool)?.configPath} 写入 hook 配置（先备份）。继续？`)) return
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_HOOK_INSTALL, tool); await refresh() }
    catch (err) { alert(`安装失败：${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  const handleUninstall = async (tool: 'claude' | 'codex') => {
    if (!confirm(`即将从 ${statuses.find(s => s.tool === tool)?.configPath} 移除所有 Mote 加的 hook。继续？`)) return
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_HOOK_UNINSTALL, tool); await refresh() }
    catch (err) { alert(`卸载失败：${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  const handleTest = async () => {
    setBusy(true)
    try { await window.ipc.invoke(IPC.NOTIFY_TEST_EVENT); setTimeout(refresh, 500) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>提醒</h2>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>通知源</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {NOTIFICATION_SOURCES.map(s => {
            const on = sources[s.key] !== false
            return (
              <button
                key={s.key}
                onClick={() => toggleSource(s.key)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 10,
                  border: `2px solid ${on ? s.color : 'var(--hairline)'}`,
                  background: on ? `${s.color}18` : 'var(--elev)',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 4, transition: 'all 0.15s ease',
                  opacity: on ? 1 : 0.5,
                }}
              >
                <span style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: on ? s.color : '#999',
                  color: '#fff', fontSize: 10, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                }}>{s.abbr}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{s.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>通用</h3>
        <div
          onClick={toggleAutoStart}
          style={{
            padding: '12px 14px', border: '0.5px solid var(--hairline)', borderRadius: 12,
            background: 'var(--elev)', display: 'flex', alignItems: 'center', gap: 12,
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>开机自启动</div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>电脑重启后自动启动 Mote</div>
          </div>
          <div style={{
            width: 36, height: 20, borderRadius: 10, position: 'relative', flexShrink: 0,
            background: autoStart ? 'var(--good)' : '#666',
            transition: 'background 0.2s',
          }}>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 2,
              left: autoStart ? 18 : 2,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>Hook 状态</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {statuses.map(s => (
            <div key={s.tool} style={{
              padding: 14, border: '0.5px solid var(--hairline)', borderRadius: 12,
              display: 'flex', alignItems: 'center', gap: 12, background: 'var(--elev)'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.tool === 'claude' ? 'Claude Code' : 'Codex CLI'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                  {s.installed
                    ? `✓ 已安装 · ${s.eventCount} 个事件${s.degraded ? ' · ⚠ 降级到 notify（无法区分事件类型）' : ''}`
                    : '⚠ 未安装'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                  {s.configPath}
                </div>
              </div>
              {s.installed
                ? <>
                    <button disabled={busy} onClick={() => handleInstall(s.tool)} style={btn()}>重装</button>
                    <button disabled={busy} onClick={() => handleUninstall(s.tool)} style={btn('danger')}>卸载</button>
                  </>
                : <button disabled={busy} onClick={() => handleInstall(s.tool)} style={btn('primary')}>安装</button>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <button onClick={handleTest} disabled={busy} style={{ ...btn('primary'), width: '100%' }}>
          🧪 测试：触发一条 Stop 事件（应看到宠物冒泡）
        </button>
      </section>

      <section>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', margin: '0 0 8px' }}>
          最近事件 · 仅本次会话 ({recent.length}/20)
        </h3>
        <div style={{ border: '0.5px solid var(--hairline)', borderRadius: 12, background: 'var(--elev)', maxHeight: 200, overflowY: 'auto' }}>
          {recent.length === 0
            ? <div style={{ padding: 14, fontSize: 11, color: 'var(--text-3)' }}>暂无事件</div>
            : recent.map((e, i) => (
              <div key={i} style={{
                padding: '8px 12px', fontSize: 11, fontFamily: 'var(--font-mono)',
                borderBottom: i < recent.length - 1 ? '0.5px solid var(--separator)' : 'none',
                display: 'grid', gridTemplateColumns: '90px 110px 60px 1fr', gap: 8
              }}>
                <span style={{ color: 'var(--text-3)' }}>{new Date(e.ts * 1000).toLocaleTimeString()}</span>
                <span style={{ color: 'var(--text)' }}>{e.event}</span>
                <span style={{ color: 'var(--accent)' }}>{e.tool}</span>
                <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.cwd}</span>
              </div>
            ))}
        </div>
      </section>

      <section>
        <button onClick={() => setAdvanced(!advanced)} style={{ ...btn(), padding: '4px 8px', fontSize: 11 }}>
          {advanced ? '▾ 运行时（高级）' : '▸ 运行时（高级）'}
        </button>
        {advanced && rt && (
          <div style={{
            marginTop: 8, padding: 12, border: '0.5px solid var(--hairline)', borderRadius: 12,
            background: 'var(--elev)', fontSize: 11, fontFamily: 'var(--font-mono)',
            display: 'grid', gridTemplateColumns: '80px 1fr', gap: 6
          }}>
            <span style={{ color: 'var(--text-3)' }}>脚本</span><span>{rt.wrapperPath}</span>
            <span style={{ color: 'var(--text-3)' }}>事件目录</span><span>{rt.eventsDir}</span>
          </div>
        )}
      </section>
    </div>
  )
}

function btn(variant: 'primary' | 'danger' | 'default' = 'default'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', border: '0.5px solid var(--hairline)', whiteSpace: 'nowrap'
  }
  if (variant === 'primary') return { ...base, background: 'var(--accent)', color: 'var(--text-on-accent)', borderColor: 'var(--accent)' }
  if (variant === 'danger')  return { ...base, background: 'transparent', color: 'var(--bad)', borderColor: 'var(--bad)' }
  return { ...base, background: 'var(--elev)', color: 'var(--text)' }
}
