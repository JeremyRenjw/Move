import { useEffect, useState, useCallback } from 'react'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      on: (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

type Phase = 'idle' | 'focus' | 'break'
type State = { phase: Phase; remaining: number; total: number; rounds: number }

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '番茄钟',
  focus: '专注中',
  break: '休息中',
}

const PHASE_COLOR: Record<Phase, string> = {
  idle: 'var(--text-3)',
  focus: 'var(--accent)',
  break: 'var(--good)',
}

export function PomodoroTimer() {
  const [state, setState] = useState<State>({ phase: 'idle', remaining: 0, total: 0, rounds: 0 })

  useEffect(() => {
    window.ipc.invoke('pomodoro:state').then(s => setState(s as State))
    return window.ipc.on('pomodoro:state', s => setState(s as State))
  }, [])

  const handleStart = useCallback(() => window.ipc.invoke('pomodoro:start'), [])
  const handleStop  = useCallback(() => window.ipc.invoke('pomodoro:stop'), [])
  const handleSkip  = useCallback(() => window.ipc.invoke('pomodoro:skip'), [])

  const { phase, remaining, total, rounds } = state
  const progress = total > 0 ? 1 - remaining / total : 0
  const color = PHASE_COLOR[phase]

  // SVG circular progress
  const R = 70, CX = 80, CY = 80
  const circumference = 2 * Math.PI * R
  const dashOffset = circumference * (1 - progress)

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>
        番茄钟
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 24px' }}>
        25 分钟专注 + 5 分钟休息，每 4 轮长休息。专注时通知静音。
      </p>

      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
        padding: '20px 0',
      }}>
        {/* Timer ring */}
        <div style={{ position: 'relative', width: 160, height: 160 }}>
          <svg width="160" height="160" viewBox="0 0 160 160">
            {/* Background track */}
            <circle cx={CX} cy={CY} r={R}
              fill="none" stroke="var(--hairline)" strokeWidth="6" />
            {/* Progress arc */}
            {phase !== 'idle' && (
              <circle cx={CX} cy={CY} r={R}
                fill="none" stroke={color} strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: 'stroke-dashoffset 0.5s linear' }}
              />
            )}
          </svg>
          {/* Center text */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            {phase === 'idle' ? (
              <>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)' }}>25:00</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>点击开始</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 28, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
                  {formatTime(remaining)}
                </div>
                <div style={{ fontSize: 11, color, marginTop: 4, fontWeight: 600 }}>
                  {PHASE_LABEL[phase]}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Round indicator */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i < (rounds % 4) ? 'var(--accent)' : 'var(--hairline)',
              transition: 'background 0.3s',
            }} />
          ))}
          <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>
            {rounds} 轮
          </span>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 10 }}>
          {phase === 'idle' ? (
            <button onClick={handleStart} style={{
              padding: '10px 32px', fontSize: 14, fontWeight: 600,
              background: 'var(--accent)', color: 'var(--text-on-accent)',
              border: 'none', borderRadius: 10, cursor: 'pointer',
            }}>
              开始专注
            </button>
          ) : (
            <>
              <button onClick={handleSkip} style={{
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                background: 'transparent', color: 'var(--text-2)',
                border: '1px solid var(--hairline)', borderRadius: 8, cursor: 'pointer',
              }}>
                跳过
              </button>
              <button onClick={handleStop} style={{
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                background: 'var(--bad, #e25c52)', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
              }}>
                停止
              </button>
            </>
          )}
        </div>

        {/* Info cards */}
        <div style={{ display: 'flex', gap: 12, marginTop: 8, width: '100%', maxWidth: 360 }}>
          <InfoCard icon="🔇" label="通知" value={phase === 'focus' ? '已静音' : '正常'} />
          <InfoCard icon="⏱️" label="模式" value="25+5 分钟" />
          <InfoCard icon="☕" label="长休" value="每 4 轮" />
        </div>
      </div>
    </div>
  )
}

function InfoCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{
      flex: 1, padding: '10px 12px',
      background: 'var(--bg-3)', borderRadius: 8,
      border: '1px solid var(--hairline)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 18 }}>{icon}</div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  )
}
