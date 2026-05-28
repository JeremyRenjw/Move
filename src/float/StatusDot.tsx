import { useState, useEffect } from 'react'
import type { SystemStats } from '@shared/types'
import { FALLBACK_NOTIFICATION_SOURCE, NOTIFICATION_SOURCES } from '@shared/notification-sources'

function glowColor(stats: SystemStats): string {
  const ramPct = stats.ramUsed / stats.ramTotal
  if (stats.cpu > 80 || ramPct > 0.9) return 'rgba(226, 92, 82, 0.4)'
  if (stats.cpu > 60 || ramPct > 0.75) return 'rgba(245, 166, 35, 0.4)'
  return 'rgba(52, 168, 83, 0.32)'
}

const SOURCE = Object.fromEntries(
  NOTIFICATION_SOURCES.map(s => [s.label, { abbr: s.abbr, bg: s.color, short: s.short }])
)

function buildConic(entries: [string, number][]): string {
  if (entries.length === 1) return SOURCE[entries[0][0]]?.bg ?? FALLBACK_NOTIFICATION_SOURCE.color
  const total = entries.reduce((s, [, n]) => s + n, 0)
  const parts: string[] = []
  let acc = 0
  for (const [label, count] of entries) {
    const color = SOURCE[label]?.bg ?? FALLBACK_NOTIFICATION_SOURCE.color
    const end = acc + (count / total) * 360
    parts.push(`${color} ${acc}deg ${end}deg`)
    acc = end
  }
  return `conic-gradient(${parts.join(', ')})`
}

interface StatusDotProps {
  stats: SystemStats
  unreadCount?: number
  unreadItems?: { label: string; ts: number }[]
  onClear?: () => void
}

export function StatusDot({ stats, unreadCount = 0, unreadItems = [], onClear }: StatusDotProps) {
  const [popped, setPopped] = useState(false)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (unreadCount > 0) {
      setPopped(false)
      requestAnimationFrame(() => requestAnimationFrame(() => setPopped(true)))
    }
  }, [unreadCount, unreadItems.length])

  const glow = (
    <div style={{
      position: 'absolute', inset: -8, borderRadius: '50%',
      background: `radial-gradient(circle, ${glowColor(stats)}, transparent 65%)`,
      pointerEvents: 'none', transition: 'background 0.4s',
    }} />
  )

  if (unreadCount === 0) return glow

  const grouped = new Map<string, number>()
  for (const item of unreadItems) grouped.set(item.label, (grouped.get(item.label) ?? 0) + 1)
  const entries = Array.from(grouped.entries())
  const abbr = entries.length === 1 ? (SOURCE[entries[0][0]]?.abbr ?? FALLBACK_NOTIFICATION_SOURCE.abbr) : String(unreadCount)
  const detail = entries.map(([l, n]) => `${SOURCE[l]?.short ?? l}*${n}`).join('  ')
  const conic = buildConic(entries)

  const size = hovered ? 40 : 20

  return (
    <>
      {glow}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); onClear?.() }}
        style={{
          position: 'absolute',
          bottom: hovered ? 4 : 14,
          left: '50%',
          transform: `translateX(-50%) scale(${popped ? 1 : 0.3})`,
          transformOrigin: 'bottom center',
          opacity: popped ? 1 : 0,
          transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease, width 0.2s ease, height 0.2s ease, bottom 0.2s ease, border-radius 0.2s ease, font-size 0.2s ease',
          pointerEvents: 'auto',
          zIndex: 3,
          cursor: 'default',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: hovered ? 'auto' : size,
          minWidth: size,
          height: size,
          borderRadius: hovered ? 12 : '50%',
          padding: hovered ? '4px 10px' : 0,
          background: conic,
          color: '#fff',
          fontSize: hovered ? 10 : 9,
          fontWeight: 700,
          fontFamily: 'var(--font-mono, monospace)',
          letterSpacing: '-0.03em',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 10px rgba(0,0,0,0.2), 0 0 0 1.5px rgba(255,255,255,0.2)',
          animation: popped && !hovered ? 'bob 2s ease-in-out infinite' : 'none',
        }}
      >
        {hovered ? detail : abbr}
      </div>
      <style>{`
        @keyframes bob {
          0%, 100% { transform: translateX(-50%) translateY(0); }
          50% { transform: translateX(-50%) translateY(-3px); }
        }
      `}</style>
    </>
  )
}
