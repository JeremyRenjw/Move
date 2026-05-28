import { useState } from 'react'
import { PetLibrary } from './PetLibrary'
import { CharacterEditor } from './CharacterEditor'
import { ApiSettings } from './ApiSettings'
import { CleanupView } from './CleanupView'
import { NotifyTab } from './NotifyTab'
import { MemoryTab } from './MemoryTab'
import { ToolsTab } from './ToolsTab'
import { AgentTab } from './AgentTab'
import { TraitEditor } from './TraitEditor'
import { MoodDiary } from './MoodDiary'
import { GrowthCurve } from './GrowthCurve'
import { PomodoroTimer } from './PomodoroTimer'
import { InsightsPanel } from './InsightsPanel'
import { ThinkingPanel } from './ThinkingPanel'
import { ContextPanel } from './ContextPanel'

type Tab = 'pets' | 'character' | 'traits' | 'diary' | 'growth' | 'pomodoro' | 'insights' | 'thinking' | 'context' | 'api' | 'cleanup' | 'notify' | 'memory' | 'agent' | 'tools'

const TAB_DEFS: { id: Tab; label: string; subtitle: string; icon: string }[] = [
  { id: 'pets', label: '宠物', subtitle: 'Pets', icon: 'M4 8c0-2 1.8-4 4-4s4 2 4 4M3 7a1 1 0 110-2 1 1 0 010 2zM13 7a1 1 0 110-2 1 1 0 010 2zM5 9.5a1 1 0 110-2 1 1 0 010 2zM11 9.5a1 1 0 110-2 1 1 0 010 2zM8 13c-1.5 0-3-.5-3-2 0-1 1-1.5 3-1.5s3 .5 3 1.5c0 1.5-1.5 2-3 2z' },
  { id: 'character', label: '角色', subtitle: 'Persona', icon: 'M8 9a3 3 0 100-6 3 3 0 000 6zM2.5 14c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4' },
  { id: 'traits', label: '性格', subtitle: 'Personality', icon: 'M8 2L6 6H2l3.5 3-1.5 5L8 11l4 3-1.5-5L14 6h-4z' },
  { id: 'diary', label: '日记', subtitle: 'Diary', icon: 'M4 5a2 2 0 012-2h4a2 2 0 012 2v10a1 1 0 01-1.5.87L8 14.5l-2.5 1.37A1 1 0 014 15V5z M6 6h4 M6 9h3' },
  { id: 'growth', label: '成长', subtitle: 'Growth', icon: 'M2 12L5 6l3 4 3-6 3 4' },
  { id: 'pomodoro', label: '番茄钟', subtitle: 'Focus', icon: 'M8 1a7 7 0 110 14A7 7 0 018 1zM8 3v5l3.5 2' },
  { id: 'insights', label: '洞察', subtitle: 'Insights', icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 5v3M8 10h.01' },
  { id: 'thinking', label: '思考', subtitle: 'Thinking', icon: 'M3 8a5 5 0 0110 0M5 8a3 3 0 016 0M8 13v2M6 15h4' },
  { id: 'context', label: '感知', subtitle: 'Context', icon: 'M2 8h12M2 4h12M2 12h12M2 16h12' },
  { id: 'api', label: 'API', subtitle: 'Models', icon: 'M3 7l5-4 5 4M3 9l5 4 5-4M3 7v2M13 7v2M8 3v10' },
  { id: 'notify', label: '提醒', subtitle: 'Notify', icon: 'M8 1.5l1.5 4.5L14 6l-3.5 3 1.5 5L8 11.5 4 14l1.5-5L2 6l4.5-.5z' },
  { id: 'cleanup', label: '清理', subtitle: 'Storage', icon: 'M2.5 4h11M5 4V2.5h6V4M4 4l1 10h6l1-10' },
  { id: 'memory', label: '记忆', subtitle: 'Memory', icon: 'M4 5a2 2 0 012-2h4a2 2 0 012 2v10a1 1 0 01-1.5.87L8 14.5l-2.5 1.37A1 1 0 014 15V5z' },
  { id: 'agent', label: 'Agent', subtitle: 'Tasks', icon: 'M8 1.5v2M8 12.5v2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M1.5 8h2M12.5 8h2M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z' },
  { id: 'tools', label: '工具', subtitle: 'Tools', icon: 'M8 2v4M8 10v4M2 8h4M10 8h4M4.5 4.5l2 2M9.5 9.5l2 2M4.5 11.5l2-2M9.5 6.5l2-2' },
]

function SidebarIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function App() {
  const [tab, setTab] = useState<Tab>('pets')

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      fontFamily: 'var(--font)',
      background: 'var(--surface)',
      WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      backdropFilter: 'blur(40px) saturate(180%)',
      color: 'var(--text)',
      borderRadius: 20,
      overflow: 'hidden',
      border: '0.5px solid var(--hairline)',
      boxShadow: 'var(--shadow-2), var(--shadow-inset)',
    }}>
      {/* Sidebar */}
      <div style={{
        width: 200,
        padding: '12px 8px',
        background: 'var(--bg-2)',
        borderRight: '0.5px solid var(--separator)',
        display: 'flex', flexDirection: 'column', gap: 1,
        flexShrink: 0,
      }}>
        {/* Titlebar spacer for macOS traffic lights */}
        <div style={{ height: 28 }} />

        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-3)',
          padding: '0 12px 6px',
        }}>Mote</div>

        {TAB_DEFS.map(t => {
          const isActive = tab === t.id
          return (
            <div
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '6px 10px',
                display: 'flex', alignItems: 'center', gap: 9,
                borderRadius: 7,
                background: isActive ? 'var(--accent)' : 'transparent',
                color: isActive ? 'var(--text-on-accent)' : 'var(--text)',
                cursor: 'pointer',
                fontSize: 13,
                transition: 'background 0.12s',
              }}
            >
              <div style={{
                width: 22, height: 22, borderRadius: 5,
                background: isActive ? 'rgba(255,255,255,0.2)' : 'var(--accent-soft)',
                color: isActive ? 'var(--text-on-accent)' : 'var(--accent)',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <SidebarIcon d={t.icon} />
              </div>
              <span style={{ flex: 1 }}>{t.label}</span>
            </div>
          )
        })}

        <div style={{ flex: 1 }} />

        {/* Version info */}
        <div style={{
          padding: '10px 12px', marginTop: 8,
          borderTop: '0.5px solid var(--separator)',
          fontSize: 10, color: 'var(--text-3)',
        }}>
          <div>v0.1.0</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--good)' }} />
            已连接
          </div>
        </div>
      </div>

      {/* Content */}
      <main style={{
        flex: 1, padding: '20px 24px',
        overflowY: 'auto',
      }}>
        {tab === 'pets' && <PetLibrary />}
        {tab === 'character' && <CharacterEditor />}
        {tab === 'traits' && <TraitEditor />}
        {tab === 'diary' && <MoodDiary />}
        {tab === 'growth' && <GrowthCurve />}
        {tab === 'pomodoro' && <PomodoroTimer />}
        {tab === 'insights' && <InsightsPanel />}
        {tab === 'thinking' && <ThinkingPanel />}
        {tab === 'context' && <ContextPanel />}
        {tab === 'api' && <ApiSettings />}
        {tab === 'cleanup' && <CleanupView />}
        {tab === 'notify' && <NotifyTab />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'tools' && <ToolsTab />}
      </main>
    </div>
  )
}
