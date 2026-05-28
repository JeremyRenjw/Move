import { useEffect, useState } from 'react'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      on: (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

type Stats = {
  cpu: number; ramUsed: number; ramTotal: number; diskUsed: number
  claudeRunning: boolean; codexRunning: boolean
}

type MoodState = {
  mood: string; energy: number; affection: number; xp: number; stage: string; streak: number
}

type HookStatus = {
  tool: string; installed: boolean; configured: boolean
}

const MOOD_EMOJI: Record<string, string> = {
  happy: '😊', calm: '😌', tired: '😴', worried: '😟', excited: '🤩', lonely: '🥺',
}
const MOOD_LABEL: Record<string, string> = {
  happy: '开心', calm: '平静', tired: '疲惫', worried: '担心', excited: '兴奋', lonely: '想你',
}
const STAGE_LABEL: Record<string, string> = {
  baby: '幼崽', child: '幼年', teen: '少年', adult: '成年', elder: '长者',
}

function GaugeBar({ label, value, max, color, unit }: {
  label: string; value: number; max: number; color: string; unit?: string
}) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: 'var(--text-2)' }}>{label}</span>
        <span style={{ color: 'var(--text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {unit === '%' ? `${Math.round(value)}%` : `${value.toFixed(1)} ${unit ?? ''}`}
        </span>
      </div>
      <div style={{
        height: 6, borderRadius: 3, background: 'var(--hairline)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 3,
          background: color, transition: 'width 0.5s ease',
        }} />
      </div>
    </div>
  )
}

export function ContextPanel() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [mood, setMood] = useState<MoodState | null>(null)
  const [hooks, setHooks] = useState<HookStatus[]>([])
  const [notifCount, setNotifCount] = useState(0)

  useEffect(() => {
    // Initial load
    Promise.all([
      window.ipc.invoke('context:stats'),
      window.ipc.invoke('context:mood'),
      window.ipc.invoke('context:hooks'),
    ]).then(([s, m, h]) => {
      setStats(s as Stats)
      setMood(m as MoodState)
      setHooks(h as HookStatus[])
    }).catch(() => {})

    // Live stats updates
    const dispose = window.ipc.on('monitor:stats', s => setStats(s as Stats))
    return dispose
  }, [])

  useEffect(() => {
    const d1 = window.ipc.on('notification:unread', (p: unknown) => {
      const payload = p as { count: number }
      setNotifCount(payload.count)
    })
    const d2 = window.ipc.on('notification:clear', () => setNotifCount(0))
    return () => { d1(); d2() }
  }, [])

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>上下文感知</h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        宠物目前能感知到的系统和环境信息。
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* System stats */}
        <Section title="系统状态" icon="💻">
          {stats ? (
            <>
              <GaugeBar label="CPU" value={stats.cpu} max={100} color={stats.cpu > 80 ? 'var(--bad)' : 'var(--accent)'} unit="%" />
              <GaugeBar label="内存" value={(stats.ramUsed / stats.ramTotal) * 100} max={100}
                color={(stats.ramUsed / stats.ramTotal) > 0.9 ? 'var(--bad)' : 'var(--good)'} unit="%" />
              <GaugeBar label="磁盘" value={stats.diskUsed} max={100} color="var(--info)" unit="%" />
            </>
          ) : <Placeholder />}
        </Section>

        {/* Pet mood */}
        <Section title="宠物状态" icon="🐾">
          {mood ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 28 }}>{MOOD_EMOJI[mood.mood] ?? '😌'}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {MOOD_LABEL[mood.mood] ?? mood.mood}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {STAGE_LABEL[mood.stage] ?? mood.stage} · XP {mood.xp}
                  </div>
                </div>
              </div>
              <GaugeBar label="体力" value={mood.energy} max={100} color="var(--good)" unit="%" />
              <GaugeBar label="好感" value={mood.affection} max={100} color="var(--accent)" unit="%" />
              {mood.streak > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  🔥 连续互动 {mood.streak} 天
                </div>
              )}
            </div>
          ) : <Placeholder />}
        </Section>

        {/* Hook status */}
        <Section title="Hook 状态" icon="🔗">
          {hooks.length > 0 ? hooks.map(h => (
            <div key={h.tool} style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              padding: '6px 10px', background: 'var(--bg-3)', borderRadius: 6,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: h.installed ? 'var(--good)' : 'var(--text-3)',
              }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{h.tool}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {h.installed ? '已安装' : '未安装'}
              </span>
            </div>
          )) : <Placeholder />}
        </Section>

        {/* Active processes */}
        <Section title="活跃进程" icon="⚙️">
          {stats ? (
            <div>
              <ProcessRow name="Claude Code" running={stats.claudeRunning} />
              <ProcessRow name="Codex" running={stats.codexRunning} />
              {notifCount > 0 && (
                <div style={{
                  marginTop: 8, padding: '6px 10px',
                  background: 'rgba(232,99,156,.08)', borderRadius: 6,
                  fontSize: 12, color: '#e8639c',
                }}>
                  {notifCount} 条未读通知
                </div>
              )}
            </div>
          ) : <Placeholder />}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--surface-solid)',
      borderRadius: 10,
      border: '1px solid var(--hairline)',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
        marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6,
        textTransform: 'uppercase', letterSpacing: '.06em',
      }}>
        <span>{icon}</span> {title}
      </div>
      {children}
    </div>
  )
}

function ProcessRow({ name, running }: { name: string; running: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: running ? 'var(--good)' : 'var(--text-3)',
        animation: running ? 'blink 1.6s ease-in-out infinite' : 'none',
      }} />
      <span style={{ fontSize: 12, color: running ? 'var(--text)' : 'var(--text-3)' }}>
        {name}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
        {running ? '运行中' : '空闲'}
      </span>
    </div>
  )
}

function Placeholder() {
  return <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>加载中…</div>
}
