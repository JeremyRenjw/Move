import { useEffect, useState } from 'react'
import type { PetMood, PetStage } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

type Snapshot = {
  date: string
  mood: PetMood
  energy: number
  affection: number
  xp: number
  stage: PetStage
}

const STAGE_LABEL: Record<PetStage, string> = {
  baby: '幼崽', child: '幼年', teen: '少年', adult: '成年', elder: '长者',
}

const MOOD_EMOJI: Record<PetMood, string> = {
  happy: '😊', calm: '😌', tired: '😴', worried: '😟', excited: '🤩', lonely: '🥺',
}

// SVG chart dimensions
const W = 560, H = 200, PAD_L = 32, PAD_R = 12, PAD_T = 10, PAD_B = 28
const CHART_W = W - PAD_L - PAD_R
const CHART_H = H - PAD_T - PAD_B

function toPath(data: Snapshot[], key: 'energy' | 'affection', maxLen: number): string {
  if (data.length === 0) return ''
  const step = CHART_W / Math.max(1, maxLen - 1)
  return data.map((d, i) => {
    const x = PAD_L + i * step
    const y = PAD_T + CHART_H - (d[key] / 100) * CHART_H
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-')
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`
}

export function GrowthCurve() {
  const [data, setData] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.ipc.invoke('mood:growth-curve').then(d => {
      setData(d as Snapshot[])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 40 }}>加载中…</div>

  if (data.length === 0) {
    return (
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>成长曲线</h2>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
          记录宠物的成长轨迹，每天自动采样一次。
        </p>
        <div style={{
          padding: 60, textAlign: 'center',
          color: 'var(--text-3)', fontSize: 13,
          background: 'var(--bg-3)', borderRadius: 12,
          border: '1px solid var(--hairline)',
        }}>
          还没有历史数据。使用宠物几天后，这里会显示成长曲线。
        </div>
      </div>
    )
  }

  const maxLen = Math.max(data.length, 2)
  const step = CHART_W / (maxLen - 1)
  const last = data[data.length - 1]
  const first = data[0]

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>成长曲线</h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        近 {data.length} 天的体力与好感度变化
      </p>

      <div style={{
        background: 'var(--bg-3)', borderRadius: 12,
        border: '1px solid var(--hairline)', padding: '16px 16px 12px',
      }}>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 3, borderRadius: 1.5, background: 'var(--good)' }} />
            体力
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 3, borderRadius: 1.5, background: 'var(--accent)' }} />
            好感
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-3)' }}>
            {STAGE_LABEL[last.stage]} · XP {last.xp}
          </span>
        </div>

        {/* SVG Chart */}
        <svg width={W} height={H} style={{ display: 'block', width: '100%', height: 'auto' }} viewBox={`0 0 ${W} ${H}`}>
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map(v => {
            const y = PAD_T + CHART_H - (v / 100) * CHART_H
            return (
              <g key={v}>
                <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
                  stroke="var(--hairline)" strokeWidth="0.5" />
                <text x={PAD_L - 4} y={y + 3} textAnchor="end"
                  fontSize="8" fill="var(--text-3)">{v}</text>
              </g>
            )
          })}

          {/* X-axis labels */}
          {data.map((d, i) => {
            const x = PAD_L + i * step
            const show = data.length <= 7 || i % 2 === 0 || i === data.length - 1
            if (!show) return null
            return (
              <text key={d.date} x={x} y={H - 4} textAnchor="middle"
                fontSize="8" fill="var(--text-3)">{formatDate(d.date)}</text>
            )
          })}

          {/* Energy line */}
          <path d={toPath(data, 'energy', maxLen)} fill="none"
            stroke="var(--good)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Affection line */}
          <path d={toPath(data, 'affection', maxLen)} fill="none"
            stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Data dots */}
          {data.map((d, i) => {
            const x = PAD_L + i * step
            const yE = PAD_T + CHART_H - (d.energy / 100) * CHART_H
            const yA = PAD_T + CHART_H - (d.affection / 100) * CHART_H
            return (
              <g key={d.date}>
                <circle cx={x} cy={yE} r="3" fill="var(--good)" stroke="var(--surface)" strokeWidth="1" />
                <circle cx={x} cy={yA} r="3" fill="var(--accent)" stroke="var(--surface)" strokeWidth="1" />
              </g>
            )
          })}

          {/* Stage change marker */}
          {data.map((d, i) => {
            if (i === 0) return null
            if (d.stage === data[i - 1].stage) return null
            const x = PAD_L + i * step
            return (
              <g key={`stage-${d.date}`}>
                <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + CHART_H}
                  stroke="var(--accent)" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
                <text x={x} y={PAD_T - 2} textAnchor="middle"
                  fontSize="8" fill="var(--accent)" fontWeight="600">
                  {STAGE_LABEL[d.stage]}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Summary cards */}
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <SummaryCard label="体力" current={last.energy} first={first.energy} color="var(--good)" />
          <SummaryCard label="好感" current={last.affection} first={first.affection} color="var(--accent)" />
          <SummaryCard label="心情" value={MOOD_EMOJI[last.mood]} sub={last.mood} />
          <SummaryCard label="天数" value={`${data.length}`} sub="已记录" />
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, current, first, value, sub, color }: {
  label: string; current?: number; first?: number; value?: string; sub?: string; color?: string
}) {
  const delta = current !== undefined && first !== undefined ? current - first : undefined
  return (
    <div style={{
      flex: 1, padding: '10px 12px',
      background: 'var(--surface-solid)', borderRadius: 8,
      border: '1px solid var(--hairline)',
    }}>
      <div style={{
        fontSize: 9, fontWeight: 600, color: 'var(--text-3)',
        letterSpacing: '.06em', textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
        {value ?? current}
      </div>
      {delta !== undefined && (
        <div style={{ fontSize: 10, color: delta >= 0 ? 'var(--good)' : 'var(--bad)', marginTop: 2 }}>
          {delta >= 0 ? '+' : ''}{delta}
        </div>
      )}
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
