import { useState } from 'react'
import { IPC } from '@shared/types'
import type { CleanupItem } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

function fmt(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)}`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)}`
  return `${(bytes / 1e3).toFixed(0)}`
}

function fmtUnit(bytes: number): string {
  if (bytes > 1e9) return 'GB'
  if (bytes > 1e6) return 'MB'
  return 'KB'
}

const ICON_MAP: Record<string, string> = {
  'Xcode': '🔨', 'Chrome': '🌐', 'npm': '📦', 'pip': '🐍',
  'Brew': '🍺', 'log': '📜', 'cache': '🗂',
}

function getIcon(label: string): string {
  for (const [k, v] of Object.entries(ICON_MAP)) {
    if (label.includes(k)) return v
  }
  return '📁'
}

export function CleanupView() {
  const [items, setItems] = useState<CleanupItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [done, setDone] = useState(false)

  const scan = async () => {
    setScanning(true)
    setDone(false)
    setSelected(new Set())
    const result = (await window.ipc.invoke(IPC.CLEANUP_SCAN)) as CleanupItem[]
    setItems(result)
    setScanning(false)
  }

  const execute = async () => {
    if (!window.confirm(`确认删除 ${selected.size} 个文件？此操作不可撤销。`)) return
    await window.ipc.invoke(IPC.CLEANUP_EXECUTE, [...selected])
    setItems(items.filter(i => !selected.has(i.path)))
    setSelected(new Set())
    setDone(true)
  }

  const total = items
    .filter(i => selected.has(i.path))
    .reduce((s, i) => s + i.size, 0)

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>系统清理</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        扫描可释放空间 · 删除前会再次确认
      </div>

      {done && (
        <div style={{
          padding: '10px 14px', marginBottom: 14,
          background: 'rgba(52,168,83,0.08)',
          border: '0.5px solid rgba(52,168,83,0.2)',
          borderRadius: 10,
          fontSize: 12, color: 'var(--good)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontWeight: 700 }}>✓</span> 清理完成
        </div>
      )}

      {/* Summary card */}
      {items.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, var(--accent-soft), transparent)',
          border: '0.5px solid var(--hairline)',
          borderRadius: 14, padding: 14,
          marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'var(--accent)', color: '#fff',
            display: 'grid', placeItems: 'center', fontSize: 24,
          }}>🗑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500 }}>可释放空间</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <div style={{
                fontSize: 28, fontWeight: 700, color: 'var(--text)',
                fontVariantNumeric: 'tabular-nums',
              }}>{fmt(total)}</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-2)' }}>{fmtUnit(total)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 8 }}>
                已选 {selected.size} / {items.length} 项
              </div>
            </div>
          </div>
          <button onClick={scan} disabled={scanning} style={{
            fontFamily: 'var(--font)', fontSize: 11,
            height: 22, padding: '0 8px',
            borderRadius: 5, border: '0.5px solid var(--hairline-strong)',
            background: 'var(--elev)', color: 'var(--text)',
            cursor: scanning ? 'default' : 'pointer',
          }}>
            {scanning ? '扫描中...' : '重新扫描'}
          </button>
          <button onClick={execute} disabled={selected.size === 0} style={{
            fontFamily: 'var(--font)', fontSize: 13,
            height: 28, padding: '0 14px',
            borderRadius: 7, border: 'none',
            background: selected.size > 0 ? 'var(--accent)' : 'var(--separator)',
            color: 'var(--text-on-accent)',
            cursor: selected.size > 0 ? 'pointer' : 'default',
            fontWeight: 600,
            boxShadow: selected.size > 0 ? '0 1px 0 rgba(255,255,255,0.25) inset, 0 2px 6px var(--accent-glow)' : 'none',
          }}>
            释放空间
          </button>
        </div>
      )}

      {/* Scan button when no items */}
      {items.length === 0 && !scanning && (
        <button onClick={scan} style={{
          fontFamily: 'var(--font)', fontSize: 13,
          height: 36, padding: '0 20px',
          borderRadius: 10, border: '0.5px solid var(--hairline-strong)',
          background: 'var(--elev)', color: 'var(--text)',
          cursor: 'pointer', fontWeight: 500,
          boxShadow: 'var(--shadow-inset)',
        }}>
          扫描缓存
        </button>
      )}

      {scanning && (
        <div style={{
          padding: 20, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: '50%',
            border: '2px solid var(--separator)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 10px',
          }} />
          扫描中...
        </div>
      )}

      {/* Item list */}
      {items.length > 0 && (
        <div style={{
          background: 'var(--elev)',
          border: '0.5px solid var(--hairline)',
          borderRadius: 12,
          overflow: 'hidden',
        }}>
          {items.map((it, idx) => {
            const isSel = selected.has(it.path)
            return (
              <div
                key={it.path}
                onClick={() => {
                  const s = new Set(selected)
                  isSel ? s.delete(it.path) : s.add(it.path)
                  setSelected(s)
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px',
                  borderTop: idx === 0 ? 'none' : '0.5px solid var(--separator)',
                  background: isSel ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 4,
                  border: `1.5px solid ${isSel ? 'var(--accent)' : 'var(--hairline-strong)'}`,
                  background: isSel ? 'var(--accent)' : 'transparent',
                  display: 'grid', placeItems: 'center',
                  color: '#fff', fontSize: 11, flexShrink: 0,
                }}>{isSel ? '✓' : ''}</div>
                <div style={{ fontSize: 18 }}>{getIcon(it.label)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{it.label}</div>
                  <div style={{
                    fontSize: 10, color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{it.path}</div>
                </div>
                <div style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--text)',
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 56, textAlign: 'right',
                }}>
                  {fmt(it.size)} <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500 }}>{fmtUnit(it.size)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
