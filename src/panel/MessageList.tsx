import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { defaultSchema } from 'hast-util-sanitize'
import type { Schema } from 'hast-util-sanitize'
import { TaskOutput } from './TaskOutput'
import type { ChatMessage, CliTaskMessage } from '@shared/types'

function isCliTask(m: ChatMessage): m is CliTaskMessage {
  return m.role === 'system' && (m as CliTaskMessage).taskType === 'cli-output'
}

// Strip Hermes-style inline meta markers the model appends to its replies.
// Markers (e.g. <used_playbook id="…"/>, <propose_playbook>…</propose_playbook>)
// are parsed by the main process for bookkeeping; users should never see them.
function stripMeta(content: string): string {
  return content
    .replace(/<used_playbook\s+id="[^"]+"\s*\/>/g, '')
    .replace(/<propose_playbook>[\s\S]*?<\/propose_playbook>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames!, 'details', 'summary']
}

function ControlledDetails({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e as React.ChangeEvent<HTMLDetailsElement>).target.open)}
      style={{
        margin: '0.4em 0',
        background: 'var(--hover)',
        borderRadius: 8,
        padding: 6,
        fontSize: 11,
        overflow: 'visible',
      }}
    >{children}</details>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, var(--separator), transparent)' }} />
      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, var(--separator), transparent)' }} />
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  const [fedBack, setFedBack] = useState<Set<string>>(() => new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleFeedback = (msgId: string, positive: boolean) => {
    window.ipc.invoke('memory:playbook-feedback-last', { positive })
    setFedBack(prev => new Set(prev).add(msgId))
  }

  let lastDay = ''

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {messages.map(m => {
        // Day divider
        const day = formatDay(m.timestamp)
        let divider = null
        if (day !== lastDay) {
          lastDay = day
          divider = <DayDivider label={day} />
        }

        if (isCliTask(m)) {
          return (
            <div key={m.id}>
              {divider}
              <TaskOutput lines={m.lines} done={m.done} exitCode={m.exitCode} />
            </div>
          )
        }

        const isUser = m.role === 'user'
        return (
          <div key={m.id}>
            {divider}
            <div style={{
              display: 'flex',
              flexDirection: isUser ? 'row-reverse' : 'row',
              gap: 8,
              alignItems: 'flex-end',
            }}>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                gap: 3,
                width: isUser ? 'auto' : '100%',
                maxWidth: isUser ? '85%' : '100%',
                minWidth: 0,
              }}>
                <div style={{
                  padding: '10px 14px',
                  fontSize: 13,
                  lineHeight: 1.6,
                  overflow: 'hidden',
                  color: isUser ? 'var(--text-on-accent)' : 'var(--text)',
                  background: isUser
                    ? 'linear-gradient(135deg, var(--accent), var(--accent-2))'
                    : 'rgba(255,255,255,0.9)',
                  border: isUser ? 'none' : '0.5px solid var(--hairline)',
                  borderRadius: 18,
                  borderBottomRightRadius: isUser ? 6 : 18,
                  borderBottomLeftRadius: isUser ? 18 : 6,
                  boxShadow: isUser ? '0 2px 8px var(--accent-glow)' : '0 1px 4px rgba(0,0,0,0.06)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word' as const,
                  backdropFilter: isUser ? undefined : 'blur(8px)',
                }}>
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
                    components={{
                      p: ({ children }) => <p style={{ margin: '0.15em 0', fontSize: 13, lineHeight: 1.45, color: 'inherit' }}>{children}</p>,
                      h1: ({ children }) => <h1 style={{ fontSize: 15, fontWeight: 700, margin: '0.3em 0 0.15em', color: 'inherit' }}>{children}</h1>,
                      h2: ({ children }) => <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0.25em 0 0.1em', color: 'inherit' }}>{children}</h2>,
                      h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 700, margin: '0.2em 0 0.05em', color: 'inherit' }}>{children}</h3>,
                      strong: ({ children }) => <strong style={{ color: isUser ? 'inherit' : 'var(--text)', fontWeight: 700 }}>{children}</strong>,
                      em: ({ children }) => <em style={{ color: 'var(--text-2)' }}>{children}</em>,
                      a: ({ href, children }) => <a href={href} style={{ color: isUser ? 'rgba(255,255,255,0.85)' : 'var(--accent)', textDecoration: 'underline' }}>{children}</a>,
                      ul: ({ children }) => <ul style={{ margin: '0.1em 0', paddingLeft: 16, lineHeight: 1.45 }}>{children}</ul>,
                      ol: ({ children }) => <ol style={{ margin: '0.1em 0', paddingLeft: 16, lineHeight: 1.45 }}>{children}</ol>,
                      li: ({ children }) => <li style={{ margin: 0, padding: 0, fontSize: 13, lineHeight: 1.4, color: 'inherit' }}>{children}</li>,
                      blockquote: ({ children }) => (
                        <blockquote style={{
                          margin: '0.2em 0', padding: '3px 10px',
                          borderLeft: '3px solid var(--accent)',
                          background: isUser ? 'rgba(0,0,0,0.08)' : 'var(--hover)',
                          borderRadius: '0 6px 6px 0',
                          color: 'var(--text-2)', fontSize: 12, fontStyle: 'italic',
                        }}>{children}</blockquote>
                      ),
                      hr: () => <hr style={{ border: 'none', borderTop: '0.5px solid var(--separator)', margin: '0.3em 0' }} />,
                      code: ({ className, children }) => {
                        const isBlock = className?.startsWith('language-')
                        if (isBlock) {
                          return (
                            <pre style={{
                              background: isUser ? 'rgba(0,0,0,0.18)' : '#1e1e1e',
                              color: isUser ? 'inherit' : '#d4d4d4',
                              borderRadius: 10,
                              padding: '10px 12px',
                              margin: '0.5em 0',
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              overflowX: 'auto',
                              whiteSpace: 'pre' as const,
                              lineHeight: 1.5,
                            }}><code style={{ fontSize: 11 }}>{children}</code></pre>
                          )
                        }
                        return <code style={{
                          background: isUser ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)',
                          borderRadius: 4,
                          padding: '1px 5px',
                          fontSize: 11.5,
                          fontFamily: 'var(--font-mono)',
                          color: 'inherit',
                        }}>{children}</code>
                      },
                      table: ({ children }) => (
                        <div style={{ overflowX: 'auto', margin: '0.5em 0', borderRadius: 8, border: '0.5px solid var(--hairline)' }}>
                          <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>{children}</table>
                        </div>
                      ),
                      th: ({ children }) => (
                        <th style={{ borderBottom: '0.5px solid var(--hairline)', padding: '5px 10px', background: 'var(--hover)', color: 'var(--text-2)', fontSize: 10, fontWeight: 600, textAlign: 'left' }}>{children}</th>
                      ),
                      td: ({ children }) => (
                        <td style={{ borderBottom: '0.5px solid var(--separator)', padding: '5px 10px', fontSize: 11 }}>{children}</td>
                      ),
                      details: ({ children }) => (
                        <ControlledDetails>{children}</ControlledDetails>
                      ),
                      summary: ({ children }) => (
                        <summary style={{ cursor: 'pointer', color: 'var(--text-2)', fontSize: 11, fontWeight: 600 }}>{children}</summary>
                      )
                    }}
                  >
                    {stripMeta(m.content)}
                  </Markdown>
                  {/* Attachment thumbnails */}
                  {m.attachments && m.attachments.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {m.attachments.map((a, i) => (
                        a.type === 'image' && a.data ? (
                          <img
                            key={i}
                            src={`data:${a.mime};base64,${a.data}`}
                            alt={a.name}
                            style={{ maxWidth: 200, maxHeight: 150, borderRadius: 8, objectFit: 'contain', cursor: 'pointer' }}
                            onClick={() => setLightbox(`data:${a.mime};base64,${a.data}`)}
                          />
                        ) : (
                          <div key={i} style={{
                            padding: '3px 8px', borderRadius: 6, fontSize: 10,
                            background: isUser ? 'rgba(255,255,255,0.15)' : 'var(--hover)',
                            color: isUser ? 'rgba(255,255,255,0.8)' : 'var(--text-2)',
                          }}>
                            📄 {a.name}
                          </div>
                        )
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', padding: '0 6px', opacity: 0.7 }}>
                  {formatTime(m.timestamp)}
                </div>
                {!isUser && !isCliTask(m) && (
                  fedBack.has(m.id) ? (
                    <div style={{ fontSize: 10, color: 'var(--text-3)', padding: '0 4px' }}>已反馈</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, padding: '0 4px' }}>
                      <button
                        onClick={() => handleFeedback(m.id, true)}
                        style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, lineHeight: 1 }}
                        title="这个回复有帮助"
                      >👍</button>
                      <button
                        onClick={() => handleFeedback(m.id, false)}
                        style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, lineHeight: 1 }}
                        title="这个回复需要改进"
                      >👎</button>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', backdropFilter: 'blur(8px)',
          }}
        >
          <img
            src={lightbox}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, objectFit: 'contain', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
          />
          <div style={{
            position: 'absolute', top: 16, right: 16,
            width: 32, height: 32, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)', color: '#fff',
            fontSize: 18, display: 'grid', placeItems: 'center',
          }}>×</div>
        </div>
      )}
    </div>
  )
}
