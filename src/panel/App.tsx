import { useEffect, useState, useCallback, useRef } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { IPC } from '@shared/types'
import type { AgentTask, AgentTaskRun, SystemStats, ChatMessage, CliTaskMessage, Pet, WatcherNote, ChatAttachment, CharacterConfig } from '@shared/types'

declare global {
  interface Window {
    ipc: {
      invoke: (ch: string, ...a: unknown[]) => Promise<unknown>
      on: (ch: string, cb: (...a: unknown[]) => void) => () => void
    }
  }
}

const DEFAULT_STATS: SystemStats = {
  cpu: 0,
  ramUsed: 0,
  ramTotal: 1,
  diskUsed: 0,
  claudeRunning: false,
  codexRunning: false
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'var(--good)' },
  thinking: { label: '思考中', color: 'var(--info)' },
  working: { label: '执行任务', color: 'var(--accent)' },
  alert: { label: '系统告警', color: 'var(--bad)' },
}

function freshConversationKey(petId: string): string {
  return `mote:fresh-conversation:${petId}`
}

function setFreshConversation(petId: string, fresh: boolean): void {
  try {
    if (fresh) window.localStorage.setItem(freshConversationKey(petId), '1')
    else window.localStorage.removeItem(freshConversationKey(petId))
  } catch { /* localStorage can be unavailable in restricted contexts */ }
}

function isFreshConversation(petId: string): boolean {
  try {
    return window.localStorage.getItem(freshConversationKey(petId)) === '1'
  } catch {
    return false
  }
}

export function App() {
  const [stats, setStats] = useState<SystemStats>(DEFAULT_STATS)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [pet, setPet] = useState<Pet | null>(null)
  const [charCfg, setCharCfg] = useState<CharacterConfig | null>(null)
  const [unreadItems, setUnreadItems] = useState<{ label: string; ts: number }[]>([])
  const [waitingPrompt, setWaitingPrompt] = useState<string | null>(null)
  const [waitingReply, setWaitingReply] = useState('')
  const [cliRunning, setCliRunning] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyRounds, setHistoryRounds] = useState<{ ts: number; userMsg: string; petReply: string }[]>([])
  const streamBuf = useRef('')
  const streamId = useRef('')
  const messagesRef = useRef<ChatMessage[]>([])

  useEffect(() => { messagesRef.current = messages }, [messages])

  const resetConversation = useCallback(() => {
    messagesRef.current = []
    setMessages([])
    streamBuf.current = ''
    streamId.current = ''
    setSending(false)
    setWaitingPrompt(null)
    setWaitingReply('')
    setCliRunning(false)
  }, [])

  const replaceMessages = useCallback((nextMessages: ChatMessage[]) => {
    messagesRef.current = nextMessages
    setMessages(nextMessages)
    streamBuf.current = ''
    streamId.current = ''
    setSending(false)
    setWaitingPrompt(null)
    setWaitingReply('')
    setCliRunning(false)
  }, [])

  const flushMemory = useCallback(() => {
    if (messagesRef.current.length >= 2) {
      window.ipc.invoke(IPC.MEMORY_FLUSH, messagesRef.current)
    }
  }, [])

  useEffect(() => {
    Promise.all([
      window.ipc.invoke(IPC.PET_LIST) as Promise<Pet[]>,
      window.ipc.invoke(IPC.PET_GET_ACTIVE) as Promise<string | null>
    ]).then(async ([pets, activeId]) => {
      const found = activeId ? pets.find(p => p.id === activeId) : null
      const pet = found ?? pets[0] ?? null
      setPet(pet)
      // Load last session history for this pet
      if (pet) {
        try {
          if (!isFreshConversation(pet.id)) {
            const history = await window.ipc.invoke('memory:read-history', pet.id) as ChatMessage[]
            if (history.length > 0) replaceMessages(history)
          }
        } catch { /* ignore */ }
        try {
          const cfg = await window.ipc.invoke(IPC.CHARACTER_GET, pet.id) as CharacterConfig
          setCharCfg(cfg)
        } catch { /* ignore */ }
      }
    })
  }, [replaceMessages])

  useEffect(() => {
    const dispose = window.ipc.on(IPC.PET_ACTIVE_CHANGED, p => {
      flushMemory()
      setMessages([])
      streamBuf.current = ''
      streamId.current = ''
      const next = p as Pet
      setPet(next)
      window.ipc.invoke(IPC.CHARACTER_GET, next.id)
        .then(c => setCharCfg(c as CharacterConfig))
        .catch(() => {})
    })
    return dispose
  }, [flushMemory])

  useEffect(() => {
    return window.ipc.on(IPC.CHARACTER_CHANGED, c => {
      const cfg = c as CharacterConfig
      setCharCfg(prev => (prev && prev.petId !== cfg.petId ? prev : cfg))
    })
  }, [])

  useEffect(() => {
    const dispose = window.ipc.on(IPC.MONITOR_STATS, s => setStats(s as SystemStats))
    return dispose
  }, [])

  useEffect(() => {
    const dispose = window.ipc.on(IPC.CHAT_NEW, () => {
      resetConversation()
      setShowHistory(false)
    })
    return dispose
  }, [resetConversation])

  useEffect(() => {
    return window.ipc.on('notification:unread', (payload: unknown) => {
      setUnreadItems((payload as { items: { label: string; ts: number }[] }).items)
    })
  }, [])

  useEffect(() => {
    const onChunk = (payload: unknown) => {
      const { chunk } = payload as { chunk: string }
      if (!streamId.current) streamId.current = crypto.randomUUID()
      streamBuf.current += chunk
      const id = streamId.current
      const content = streamBuf.current
      setMessages(msgs => {
        const last = msgs[msgs.length - 1]
        if (last?.id === id) {
          return [...msgs.slice(0, -1), { ...last, content }]
        }
        return [
          ...msgs,
          { id, role: 'pet' as const, content, timestamp: Date.now() }
        ]
      })
    }

    const onDone = () => {
      setSending(false)
      streamBuf.current = ''
      streamId.current = ''
    }

    const onTurn = () => {
      streamBuf.current = ''
      streamId.current = ''
    }

    const onLine = (payload: unknown) => {
      const { line } = payload as { line: string }
      setCliRunning(true)
      setMessages(msgs => {
        const last = msgs[msgs.length - 1] as CliTaskMessage | undefined
        if (last?.taskType === 'cli-output' && !last.done) {
          return [...msgs.slice(0, -1), { ...last, lines: [...last.lines, line] }]
        }
        return [
          ...msgs,
          {
            id: crypto.randomUUID(),
            role: 'system' as const,
            content: '',
            timestamp: Date.now(),
            taskType: 'cli-output' as const,
            lines: [line],
            done: false
          }
        ]
      })
    }

    const onCliDone = (payload: unknown) => {
      const { exitCode } = payload as { exitCode: number }
      setWaitingPrompt(null)
      setWaitingReply('')
      setCliRunning(false)
      setMessages(msgs => {
        const last = msgs[msgs.length - 1] as CliTaskMessage | undefined
        if (last?.taskType === 'cli-output') {
          return [...msgs.slice(0, -1), { ...last, done: true, exitCode }]
        }
        return msgs
      })
    }

    const onWaiting = (payload: unknown) => {
      const { prompt } = payload as { prompt: string }
      setWaitingPrompt(prompt)
    }

    const onError = (payload: unknown) => {
      const { message } = payload as { message: string }
      setSending(false)
      setMessages(msgs => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'pet' as const,
          content: `⚠️ ${message}`,
          timestamp: Date.now()
        }
      ])
    }

    const onWatcher = (payload: unknown) => {
      const note = payload as WatcherNote
      const prefix = note.status === 'ok' ? '👀' : note.status === 'stuck' ? '⏳' : note.status === 'error' ? '⚠️' : '❓'
      setMessages(msgs => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system' as const,
          content: `${prefix} ${note.note}`,
          timestamp: note.timestamp
        }
      ])
    }

    const onAgentTaskRan = (payload: unknown) => {
      const { task, run } = payload as { task: AgentTask; run: AgentTaskRun }
      const text = run.status === 'success'
        ? `后台任务「${task.title}」完成：\n${run.result ?? ''}`
        : `后台任务「${task.title}」${run.status}：${run.error ?? '无详情'}`
      setMessages(msgs => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system' as const,
          content: text,
          timestamp: run.ts,
        }
      ])
    }

    const disposers = [
      window.ipc.on(IPC.CHAT_CHUNK, onChunk),
      window.ipc.on(IPC.CHAT_TURN, onTurn),
      window.ipc.on(IPC.CHAT_DONE, onDone),
      window.ipc.on(IPC.CLI_LINE, onLine),
      window.ipc.on(IPC.CLI_DONE, onCliDone),
      window.ipc.on(IPC.CHAT_ERROR, onError),
      window.ipc.on(IPC.WATCHER_NOTE, onWatcher),
      window.ipc.on(IPC.CLI_WAITING, onWaiting),
      window.ipc.on(IPC.AGENT_TASK_RAN, onAgentTaskRan)
    ]
    return () => disposers.forEach(d => d())
  }, [])

  const handleSend = useCallback(
    (msg: string, attachments?: ChatAttachment[]) => {
      const pid = pet?.id ?? 'stlulu'
      setFreshConversation(pid, false)
      setSending(true)
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: msg,
        timestamp: Date.now(),
        attachments,
      }
      setMessages(m => [...m, userMsg])
      window.ipc.invoke(IPC.CHAT_SEND, {
        message: msg,
        history: [...messages, userMsg].slice(-20),
        attachments,
      })
    },
    [messages, pet?.id]
  )

  const status = sending ? 'thinking' : stats.cpu > 80 ? 'alert' : 'idle'
  const s = STATUS_MAP[status] ?? STATUS_MAP.idle

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100vw',
      height: '100vh',
      background: 'linear-gradient(180deg, #faf8f5 0%, #f5f2ed 100%)',
      border: '0.5px solid var(--hairline)',
      borderRadius: 20,
      overflow: 'hidden',
      fontFamily: 'var(--font)',
      color: 'var(--text)',
      boxShadow: 'var(--shadow-2), var(--shadow-inset)',
    }}>
      {/* Titlebar */}
      <div style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 10,
        borderBottom: '0.5px solid var(--hairline)',
        background: 'linear-gradient(to bottom, rgba(255,255,255,0.18), rgba(255,255,255,0))',
        userSelect: 'none',
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}>
        {/* Traffic lights */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', border: '0.5px solid rgba(0,0,0,0.1)', cursor: 'pointer' }}
            onClick={() => { flushMemory(); window.ipc.invoke(IPC.WINDOW_CLOSE_PANEL) }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e', border: '0.5px solid rgba(0,0,0,0.1)' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840', border: '0.5px solid rgba(0,0,0,0.1)' }} />
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', letterSpacing: '-0.01em' }}>
            {charCfg?.displayName || pet?.displayName || 'Mote'}
          </span>
        </div>
        {/* Unread badge + clear */}
        {unreadItems.length > 0 && (
          <button
            onClick={() => window.ipc.invoke(IPC.NOTIFICATION_CLEAR)}
            style={{
              background: '#e25c52', color: '#fff',
              border: 'none', borderRadius: 10,
              padding: '2px 8px', fontSize: 10, fontWeight: 600,
              cursor: 'pointer', flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
            title={unreadItems.map(i => i.label).join('\n')}
          >
            {unreadItems.length} 未读 · 已读
          </button>
        )}
        {/* Settings button */}
        <button
          onClick={() => window.ipc.invoke(IPC.WINDOW_OPEN_SETTINGS)}
          style={{
            background: 'transparent', border: 'none', color: 'var(--text-3)',
            cursor: 'pointer', padding: '0 4px', display: 'grid', placeItems: 'center',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="8" cy="8" r="2.5" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
          </svg>
        </button>
      </div>

      {/* Chat header with pet info */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--separator)',
        flexShrink: 0,
        background: 'rgba(255,255,255,0.4)',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: 'linear-gradient(135deg, var(--accent-soft), rgba(232,149,52,0.08))',
          overflow: 'hidden', flexShrink: 0,
          border: '0.5px solid var(--hairline)',
          display: 'grid', placeItems: 'center',
        }}>
          <span style={{ fontSize: 20 }}>🐾</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {charCfg?.displayName || pet?.displayName || '...'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-2)' }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: s.color,
              animation: status !== 'idle' ? 'blink 1.6s ease-in-out infinite' : 'none',
            }} />
            {s.label}
          </div>
        </div>
        <button
          onClick={() => {
            const pid = pet?.id ?? 'stlulu'
            if (showHistory) { setShowHistory(false); return }
            window.ipc.invoke('memory:list-rounds', pid).then(rounds => {
              setHistoryRounds(rounds as { ts: number; userMsg: string; petReply: string }[])
              setShowHistory(true)
            })
          }}
          style={{
            background: 'transparent', border: 'none', color: 'var(--text-3)',
            cursor: 'pointer', padding: '0 6px', fontSize: 11,
          }}
          title="历史对话"
        >
          📜
        </button>
        <button
          onClick={() => {
            const pid = pet?.id ?? 'stlulu'
            flushMemory()
            setFreshConversation(pid, true)
            window.ipc.invoke(IPC.CHAT_NEW)
          }}
          style={{
            background: 'transparent', border: 'none', color: 'var(--text-3)',
            cursor: 'pointer', padding: '0 6px', fontSize: 11,
          }}
          title="新建对话"
        >
          +
        </button>
        <button
          onClick={() => { flushMemory(); window.ipc.invoke(IPC.WINDOW_CLOSE_PANEL) }}
          style={{
            background: 'transparent', border: 'none', color: 'var(--text-3)',
            cursor: 'pointer', padding: '0 6px',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 2L10 10M10 2L2 10" />
          </svg>
        </button>
      </div>

      {showHistory && (
        <div style={{
          position: 'absolute', top: 38, left: 0, right: 0, bottom: 50,
          background: 'var(--bg)', zIndex: 10, overflowY: 'auto',
          borderRight: '0.5px solid var(--hairline)',
        }}>
          <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', borderBottom: '0.5px solid var(--hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => setShowHistory(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 11, color: 'var(--text-2)', padding: 0,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >← 返回</button>
            {historyRounds.length > 0 && (
              <button
                onClick={async () => {
                  const ok = await window.ipc.invoke('dialog:confirm', '确定要清空所有历史记录吗？')
                  if (!ok) return
                  const pid = pet?.id ?? 'stlulu'
                  await window.ipc.invoke('memory:clear-rounds', pid)
                  setFreshConversation(pid, true)
                  setHistoryRounds([])
                  resetConversation()
                  setShowHistory(false)
                }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 10, color: 'var(--text-3)', padding: '2px 6px',
                  borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--danger, #e55)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}
              >清空</button>
            )}
          </div>
          {historyRounds.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--text-3)' }}>暂无记录</div>
          )}
          {historyRounds.map((r, i) => (
            <div
              key={i}
              onClick={() => {
                const pid = pet?.id ?? 'stlulu'
                window.ipc.invoke('memory:read-round', { petId: pid, indexFromEnd: i })
                  .then(msgs => {
                    setFreshConversation(pid, false)
                    replaceMessages(msgs as ChatMessage[])
                    setShowHistory(false)
                  })
              }}
              style={{
                padding: '8px 12px', borderBottom: '0.5px solid var(--hairline)',
                cursor: 'pointer', fontSize: 12, position: 'relative',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--elev)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ color: 'var(--text)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {r.userMsg || '(空)'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {new Date(r.ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {r.petReply && ` · ${r.petReply.slice(0, 30)}`}
              </div>
              <button
                onClick={e => {
                  e.stopPropagation()
                  const pid = pet?.id ?? 'stlulu'
                  window.ipc.invoke('memory:delete-round', { petId: pid, indexFromEnd: i })
                    .then(() => setHistoryRounds(prev => prev.filter((_, j) => j !== i)))
                }}
                style={{
                  position: 'absolute', top: 6, right: 8,
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 14, color: 'var(--text-3)', lineHeight: 1,
                  padding: '2px 4px', borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--danger, #e55)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-3)')}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <MessageList messages={messages} />

      {/* CLI waiting input */}
      {waitingPrompt && (
        <div style={{
          padding: '10px 14px',
          background: 'var(--accent-soft)',
          borderTop: '0.5px solid var(--separator)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            CLI 等待输入
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)',
            marginBottom: 6, wordBreak: 'break-all',
          }}>
            {waitingPrompt}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={waitingReply}
              onChange={e => setWaitingReply(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  window.ipc.invoke(IPC.CLI_INPUT, { text: waitingReply })
                  setWaitingReply('')
                  setWaitingPrompt(null)
                }
              }}
              placeholder="回复 (y / n / 文本)"
              style={{
                flex: 1, background: 'var(--elev)', border: '0.5px solid var(--hairline-strong)',
                borderRadius: 8, padding: '6px 10px', color: 'var(--text)', fontSize: 12,
                outline: 'none', fontFamily: 'var(--font)',
              }}
              autoFocus
            />
            {['y', 'n'].map(t => (
              <button key={t}
                onClick={() => {
                  window.ipc.invoke(IPC.CLI_INPUT, { text: t })
                  setWaitingReply('')
                  setWaitingPrompt(null)
                }}
                style={{
                  background: t === 'y' ? 'var(--good)' : 'var(--elev)',
                  border: '0.5px solid var(--hairline)',
                  color: t === 'y' ? '#fff' : 'var(--text)',
                  padding: '6px 12px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
                  fontWeight: 600,
                }}
              >{t}</button>
            ))}
          </div>
        </div>
      )}

      {/* CLI running indicator with abort button */}
      {cliRunning && !waitingPrompt && (
        <div style={{
          padding: '6px 14px',
          background: 'rgba(74,144,226,0.08)',
          borderTop: '0.5px solid var(--separator)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 11, color: 'var(--info)' }}>
            CLI 任务运行中...
          </span>
          <button
            onClick={() => window.ipc.invoke(IPC.CLI_ABORT)}
            style={{
              background: 'var(--bad, #e25c52)', color: '#fff',
              border: 'none', borderRadius: 6,
              padding: '3px 10px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer',
            }}
          >终止</button>
        </div>
      )}

      <InputBar onSend={handleSend} disabled={sending || cliRunning} />
    </div>
  )
}
