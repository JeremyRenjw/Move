import { useEffect, useRef, useState } from 'react'

interface Props {
  lines: string[]
  done: boolean
  exitCode?: number
}

export function TaskOutput({ lines, done, exitCode }: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines.length])

  const statusColor = done
    ? (exitCode === 0 ? 'var(--good)' : 'var(--bad)')
    : 'var(--info)'
  const statusLabel = done
    ? (exitCode === 0 ? '完成' : '失败')
    : '运行中'
  const statusIcon = done
    ? (exitCode === 0 ? '✓' : '✗')
    : '⏵'

  return (
    <div style={{
      background: 'var(--elev)',
      border: '0.5px solid var(--hairline)',
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: 'var(--shadow-1)',
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(v => !v)}
        style={{
          padding: '8px 10px',
          display: 'flex', alignItems: 'center', gap: 8,
          background: done
            ? (exitCode === 0 ? 'rgba(52,168,83,0.08)' : 'rgba(226,92,82,0.10)')
            : 'rgba(74,144,226,0.10)',
          borderBottom: expanded ? '0.5px solid var(--separator)' : 'none',
          cursor: 'pointer',
        }}>
        <div style={{
          width: 20, height: 20, borderRadius: 6,
          background: statusColor, color: '#fff',
          display: 'grid', placeItems: 'center',
          fontSize: 11, fontWeight: 700,
          animation: !done ? 'blink 1.6s ease-in-out infinite' : 'none',
        }}>{statusIcon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>CLI 任务</div>
          <div style={{
            fontSize: 10, color: 'var(--text-2)', fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            <span style={{ color: 'var(--accent)' }}>$</span> {lines[0] ?? '...'}
          </div>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 22, padding: '0 9px',
          borderRadius: 999, fontSize: 11, fontWeight: 500,
          background: done
            ? (exitCode === 0 ? 'rgba(52,168,83,0.12)' : 'rgba(226,92,82,0.14)')
            : 'var(--hover)',
          color: statusColor,
          border: '0.5px solid var(--hairline)',
        }}>
          {statusLabel}
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"
          style={{ transform: expanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--text-3)' }}>
          <path d="M1.5 3L5 6.5L8.5 3" />
        </svg>
      </div>

      {/* Lines */}
      {expanded && (
        <div style={{
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.02)',
          maxHeight: 140,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          lineHeight: 1.55,
          color: 'var(--text-2)',
        }}>
          {lines.map((l, i) => {
            const isCmd = l.startsWith('$')
            const isErr = /error|failed/i.test(l)
            const isOk = /done|success|✓/i.test(l)
            return (
              <div key={i} style={{
                color: isCmd ? 'var(--accent)' : isErr ? 'var(--bad)' : isOk ? 'var(--good)' : 'inherit',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{l}</div>
            )
          })}
          {!done && (
            <div style={{ color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 6, height: 12, background: 'var(--info)', animation: 'blink 1s steps(2) infinite' }} />
              <span style={{ opacity: 0.6 }}>运行中...</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Footer */}
      {done && (
        <div style={{
          padding: '6px 10px',
          fontSize: 10,
          color: 'var(--text-3)',
          display: 'flex', alignItems: 'center', gap: 6,
          borderTop: '0.5px solid var(--separator)',
        }}>
          <span style={{ color: statusColor }}>exit {exitCode ?? 0}</span>
          <span>·</span>
          <span>{lines.length} 行输出</span>
        </div>
      )}
    </div>
  )
}
