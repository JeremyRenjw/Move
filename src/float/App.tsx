import { useEffect, useState, useRef } from 'react'
import { SpritePlayer } from './SpritePlayer'
import { StatusDot } from './StatusDot'
import type { Pet, SystemStats, PetAnimState, PetMood, PetStage, PetDisplayState } from '@shared/types'
import { IPC } from '@shared/types'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      send: (ch: string, ...a: unknown[]) => void
      on: (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

function displayToAnimState(s: PetDisplayState): PetAnimState {
  switch (s) {
    case 'thinking':          return 'working'
    case 'responding':        return 'talk'
    case 'tool_use':          return 'working'
    case 'permission_prompt': return 'alert'
    case 'ask_user':          return 'alert'
    case 'completed':         return 'celebrate'
    case 'error':             return 'alert'
    case 'idle':
    default:                  return 'idle'
  }
}

const DEFAULT_STATS: SystemStats = {
  cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0,
  claudeRunning: false, codexRunning: false,
}

// ─── Confetti + ♥+1 overlay on celebrate ───

const CONFETTI_COLORS = ['#e8639c', '#f5a623', '#8b5cf6', '#34a853', '#4a90e2', '#e89534']

function CelebrateOverlay() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 10 }}>
      {/* Confetti bits */}
      {CONFETTI_COLORS.map((c, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${15 + (i * 14)}%`,
          top: '30%',
          width: 4, height: 7,
          background: c,
          borderRadius: 1,
          animation: `confetti-fall ${1.1 + i * 0.15}s ${i * 0.08}s ease-out infinite`,
          opacity: 0,
        }} />
      ))}
      {/* Heart badge */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '10%',
        transform: 'translateX(-50%)',
        fontSize: 10,
        fontWeight: 700,
        color: '#e8639c',
        background: 'rgba(232,99,156,.15)',
        padding: '2px 6px',
        borderRadius: 10,
        whiteSpace: 'nowrap',
        animation: 'heart-bump 1.8s ease-out forwards',
        opacity: 0,
      }}>
        ♥ +1
      </div>
    </div>
  )
}

export function App() {
  const [pet, setPet] = useState<Pet | null>(null)
  const [stats, setStats] = useState<SystemStats>(DEFAULT_STATS)
  const [animState, setAnimState] = useState<PetAnimState>('idle')
  const [mood, setMood] = useState<PetMood>('calm')
  const [stage, setStage] = useState<PetStage>('baby')
  const [unreadCount, setUnreadCount] = useState(0)
  const [unreadItems, setUnreadItems] = useState<{ label: string; ts: number }[]>([])
  const [hovered, setHovered] = useState(false)
  const [bubbleText, setBubbleText] = useState('')
  const [notifPulse, setNotifPulse] = useState(0)

  const lastPos = useRef<{ x: number; y: number } | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const displayDriven = useRef(false)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubbleBuffer = useRef('')

  const dismissBubble = (delay: number) => {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => { setBubbleText(''); bubbleBuffer.current = '' }, delay)
  }

  const showEventBubble = (text: string, dismissMs = 5000) => {
    bubbleBuffer.current = ''
    setBubbleText(text)
    dismissBubble(dismissMs)
  }

  // Reset notifPulse after animation plays (so it can re-trigger)
  useEffect(() => {
    if (notifPulse > 0) {
      const t = setTimeout(() => setNotifPulse(0), 500)
      return () => clearTimeout(t)
    }
  }, [notifPulse])

  // Mood-based glow color
  const MOOD_GLOW: Record<string, string> = {
    happy:   'rgba(255, 200, 50, 0.35)',
    tired:   'rgba(120, 160, 220, 0.30)',
    worried: 'rgba(220, 80, 80, 0.35)',
    excited: 'rgba(180, 100, 255, 0.40)',
    lonely:  'rgba(100, 150, 220, 0.30)',
    calm:    'rgba(180, 200, 180, 0.15)',
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!lastPos.current || !startPos.current) return
      const dx = e.screenX - lastPos.current.x
      const dy = e.screenY - lastPos.current.y
      const totalDx = Math.abs(e.screenX - startPos.current.x)
      const totalDy = Math.abs(e.screenY - startPos.current.y)
      if (!dragging.current && (totalDx > 4 || totalDy > 4)) {
        dragging.current = true
      }
      if (dragging.current && (dx !== 0 || dy !== 0)) {
        lastPos.current = { x: e.screenX, y: e.screenY }
        window.ipc.invoke(IPC.WINDOW_SET_POSITION, { dx, dy })
      }
    }
    const onUp = () => {
      if (lastPos.current && !dragging.current) {
        window.ipc.invoke(IPC.WINDOW_OPEN_PANEL)
      }
      lastPos.current = null
      startPos.current = null
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startupBubbleShown = useRef(false)

  useEffect(() => {
    Promise.all([
      window.ipc.invoke(IPC.PET_LIST) as Promise<Pet[]>,
      window.ipc.invoke(IPC.PET_GET_ACTIVE) as Promise<string | null>,
    ]).then(([pets, activeId]) => {
      const found = activeId ? pets.find(p => p.id === activeId) : null
      const p = found ?? pets[0] ?? null
      setPet(p)
      if (p && !startupBubbleShown.current) {
        startupBubbleShown.current = true
        showEventBubble(`嗨，我是${p.displayName}`, 5000)
      }
    })
    const d1 = window.ipc.on(IPC.PET_ACTIVE_CHANGED, p => setPet(p as Pet))
    const d2 = window.ipc.on(IPC.PET_EVOLVED, () => {
      window.ipc.invoke(IPC.PET_GET_ACTIVE).then(id => {
        window.ipc.invoke(IPC.PET_LIST).then(pets => {
          const found = (pets as Pet[]).find(p => p.id === id)
          if (found) setPet(found)
        })
      })
    })
    return () => { d1(); d2() }
  }, [])

  useEffect(() => {
    return window.ipc.on(IPC.MOOD_CHANGED, (payload: unknown) => {
      const p = payload as { mood: PetMood; stage?: PetStage }
      setMood(p.mood)
      if (p.stage) setStage(p.stage)
    })
  }, [])

  // State machine driven animation (hook events → PetDisplayState → PetAnimState)
  useEffect(() => {
    return window.ipc.on(IPC.PET_DISPLAY_STATE, (payload: unknown) => {
      const info = payload as { state: PetDisplayState; label?: string }
      displayDriven.current = info.state !== 'idle'
      setAnimState(displayToAnimState(info.state))
    })
  }, [])

  // Pet action animation (dance, celebrate, etc.) — supports repetition count
  useEffect(() => {
    return window.ipc.on(IPC.PET_ACTION, (payload: unknown) => {
      const { action, count = 1 } = payload as { action: string; count?: number }
      const animMap: Record<string, PetAnimState> = {
        dance: 'dance', celebrate: 'celebrate', wave: 'wave',
        bow: 'celebrate', spin: 'spin', jump: 'jump',
      }
      const animState = animMap[action] ?? 'celebrate'
      const speed = 140  // ms per frame
      const frameCount = pet?.animations?.[animState as keyof typeof pet.animations]?.frames?.length ?? 6
      const cycleMs = frameCount * speed
      const repeats = Math.max(1, Math.min(count, 50))
      const totalDuration = repeats * cycleMs

      displayDriven.current = true
      setAnimState(animState)

      setTimeout(() => {
        displayDriven.current = false
        setAnimState('idle')
      }, totalDuration)
    })
  }, [pet])

  useEffect(() => {
    const handler = (s: unknown) => {
      const st = s as SystemStats
      setStats(st)
      // Don't override state-machine driven animation states
      if (displayDriven.current) return
      setAnimState(prev => {
        if (prev === 'working' || prev === 'talk' || prev === 'celebrate') return prev
        return st.cpu > 80 ? 'alert' : 'idle'
      })
    }
    return window.ipc.on(IPC.MONITOR_STATS, handler)
  }, [])

  useEffect(() => {
    let lastNotifTs = 0
    const SOURCE_BUBBLE: Record<string, string> = {
      '微信':       '💬 微信来消息了',
      '企业微信':   '💬 企微来消息了',
      'Claude':     '🤖 Claude 有动静',
      'Codex':      '🤖 Codex 有动静',
    }
    const d1 = window.ipc.on('notification:unread', (payload: unknown) => {
      const p = payload as { count: number; items: { label: string; ts: number }[] }
      setUnreadCount(p.count)
      setUnreadItems(p.items)
      const latest = p.items[p.items.length - 1]
      if (latest && latest.ts > lastNotifTs) {
        lastNotifTs = latest.ts
        const text = SOURCE_BUBBLE[latest.label] ?? `💬 ${latest.label}`
        showEventBubble(text, 6000)
        setNotifPulse(n => n + 1)
      }
    })
    const d2 = window.ipc.on('notification:clear', () => {
      setUnreadCount(0)
      setUnreadItems([])
    })
    return () => { d1(); d2() }
  }, [])

  // Helper: show a semantic event bubble (used by CLI/Chat/Display state events)
  useEffect(() => {
    const onChunk = () => { if (!displayDriven.current) setAnimState('talk') }
    const onDone = () => {
      if (!displayDriven.current) setAnimState('idle')
      showEventBubble('回答好啦～', 4000)
    }
    const onChatError = (payload: unknown) => {
      const { message } = (payload ?? {}) as { message?: string }
      showEventBubble(`出错了：${(message || '未知错误').slice(0, 40)}`, 7000)
    }
    const onLine = () => { if (!displayDriven.current) setAnimState('working') }
    const onCli = (payload: unknown) => {
      if (!displayDriven.current) setAnimState('celebrate')
      const { exitCode } = (payload ?? {}) as { exitCode?: number }
      if (exitCode === 0) showEventBubble('Claude 跑完啦 ✓', 5000)
      else showEventBubble(`Claude 出错了 (code ${exitCode ?? '?'})`, 7000)
    }
    const onCliWaiting = (payload: unknown) => {
      const { prompt } = (payload ?? {}) as { prompt?: string }
      showEventBubble(prompt ? `Claude 在等你：${prompt.slice(0, 30)}` : 'Claude 在等你回应', 8000)
    }
    const disposers = [
      window.ipc.on(IPC.CHAT_CHUNK, onChunk),
      window.ipc.on(IPC.CHAT_DONE, onDone),
      window.ipc.on(IPC.CHAT_ERROR, onChatError),
      window.ipc.on(IPC.CLI_LINE, onLine),
      window.ipc.on(IPC.CLI_DONE, onCli),
      window.ipc.on(IPC.CLI_WAITING, onCliWaiting),
    ]
    return () => disposers.forEach(d => d())
  }, [])

  // Hook event state changes → semantic bubble text
  useEffect(() => {
    const STATE_TEXT: Record<string, string> = {
      thinking:          'Claude 在思考...',
      tool_use:          'Claude 在用工具...',
      permission_prompt: '🔑 需要你授权一下',
      ask_user:          '❓ Claude 在问你',
      error:             '⚠️ Claude 出错了',
      completed:         'Claude 跑完啦 ✓',
    }
    return window.ipc.on(IPC.PET_DISPLAY_STATE, (payload: unknown) => {
      const info = payload as { state: string; label?: string }
      const text = STATE_TEXT[info.state]
      if (text) {
        const dismissMs = info.state === 'permission_prompt' || info.state === 'ask_user' ? 10000 : 5000
        showEventBubble(text, dismissMs)
      }
    })
  }, [])

  useEffect(() => {
    return window.ipc.on(IPC.DRIVE_GOAL, (payload: unknown) => {
      const { goal } = payload as { goal: { bubble?: string } }
      if (goal?.bubble) showEventBubble(goal.bubble, 8000)
    })
  }, [])

  if (!pet) return null

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 20,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'inline-flex',
          cursor: dragging.current ? 'grabbing' : 'grab',
          animation: dragging.current ? 'none'
            : notifPulse > 0
            ? 'pet-float 3s ease-in-out infinite, notif-pulse 0.4s ease-out'
            : 'pet-float 3s ease-in-out infinite',
          pointerEvents: 'auto',
          transform: hovered ? 'translateY(-2px) scale(1.05)' : 'translateY(0) scale(1)',
          transition: 'transform 0.3s ease',
        }}
        onMouseDown={e => {
          lastPos.current = { x: e.screenX, y: e.screenY }
          startPos.current = { x: e.screenX, y: e.screenY }
          dragging.current = false
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <StatusDot stats={stats} unreadCount={unreadCount} unreadItems={unreadItems} onClear={() => window.ipc.invoke(IPC.NOTIFICATION_CLEAR)} />
        <div style={{
          position: 'absolute', left: '50%', bottom: -3,
          width: 50, height: 6,
          background: 'radial-gradient(ellipse, rgba(0,0,0,0.15), transparent 70%)',
          transform: 'translateX(-50%)',
          filter: 'blur(2px)',
          pointerEvents: 'none',
        }} />
        <SpritePlayer
          pet={pet}
          state={animState}
          size={80}
          mood={mood}
          stage={stage}
          hovered={hovered}
        />
        {mood && mood !== 'calm' && (
          <div style={{
            position: 'absolute',
            inset: -8,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${MOOD_GLOW[mood] ?? 'transparent'}, transparent 70%)`,
            pointerEvents: 'none',
            transition: 'background 0.6s ease',
            zIndex: -1,
          }} />
        )}
      </div>

      {bubbleText && (
        <div style={{
          position: 'absolute',
          top: 110,
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: 240,
          padding: '10px 14px',
          background: 'rgba(255,255,255,0.98)',
          borderRadius: 14,
          fontSize: 13,
          lineHeight: 1.45,
          color: '#222',
          textAlign: 'left',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.04)',
          animation: 'bubble-in 0.3s ease-out',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
        }}>
          {bubbleText}
          <div style={{
            position: 'absolute', top: -6, left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
            borderBottom: '6px solid rgba(255,255,255,0.98)',
          }} />
        </div>
      )}

      {animState === 'celebrate' && <CelebrateOverlay />}

      <style>{`
        @keyframes pet-float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-4px); }
        }
        @keyframes notif-pulse {
          0%   { transform: scale(1); }
          30%  { transform: scale(1.12); }
          60%  { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        @keyframes bubble-in {
          0%   { opacity: 0; transform: translateY(6px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes confetti-fall {
          0%   { transform: translateY(-18px) rotate(0); opacity: 0; }
          10%  { opacity: 1; }
          100% { transform: translateY(60px) rotate(360deg); opacity: 0; }
        }
        @keyframes heart-bump {
          0%   { transform: scale(0.7) translateY(0); opacity: 0; }
          30%  { transform: scale(1.1) translateY(-4px); opacity: 1; }
          100% { transform: scale(1) translateY(-18px); opacity: 0; }
        }
      `}</style>
    </div>
  )
}
