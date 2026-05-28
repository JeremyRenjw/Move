import { useState, useCallback, useRef } from 'react'
import type { ChatAttachment } from '@shared/types'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const TEXT_EXT = new Set(['txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'py', 'go', 'rs', 'java', 'sh', 'yaml', 'yml', 'toml', 'csv', 'log'])

interface Props {
  onSend: (msg: string, attachments?: ChatAttachment[]) => void
  disabled?: boolean
}

const SUGGESTIONS = ['/run claude', '/codex 帮我重构', '清理缓存', '现在 CPU 怎么样']

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip data:...;base64, prefix
      const base64 = result.split(',')[1] ?? result
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function InputBar({ onSend, disabled }: Props) {
  const [val, setVal] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const items: ChatAttachment[] = []
    for (const file of Array.from(files)) {
      if (IMAGE_TYPES.has(file.type)) {
        const data = await readFileAsBase64(file)
        items.push({ type: 'image', name: file.name, data, mime: file.type })
      } else if (TEXT_EXT.has(extOf(file.name)) || file.type.startsWith('text/')) {
        const data = await readFileAsText(file)
        items.push({ type: 'file', name: file.name, data, mime: file.type || 'text/plain' })
      }
    }
    setAttachments(prev => [...prev, ...items])
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const files: File[] = []
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (files.length > 0) addFiles(files)
  }, [addFiles])

  const send = useCallback(() => {
    const t = val.trim()
    if ((!t && attachments.length === 0) || disabled) return
    onSend(t || '(附件)', attachments.length > 0 ? attachments : undefined)
    setVal('')
    setAttachments([])
  }, [val, disabled, onSend, attachments])

  return (
    <div style={{ padding: '8px 12px 10px', borderTop: '0.5px solid var(--separator)' }}>
      {/* Suggestion chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, overflowX: 'auto' }}>
        {SUGGESTIONS.map((s, i) => (
          <div
            key={i}
            onClick={() => { setVal(s) }}
            style={{
              display: 'inline-flex', alignItems: 'center',
              height: 22, padding: '0 9px',
              borderRadius: 999, fontSize: 11, fontWeight: 500,
              background: 'var(--hover)', color: 'var(--text-2)',
              border: '0.5px solid var(--hairline)',
              cursor: 'pointer', whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >{s}</div>
        ))}
      </div>

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          {attachments.map((a, i) => (
            <div key={i} style={{
              position: 'relative', borderRadius: 8, overflow: 'hidden',
              border: '0.5px solid var(--hairline)',
              background: 'var(--elev)',
            }}>
              {a.type === 'image' ? (
                <img
                  src={`data:${a.mime};base64,${a.data}`}
                  alt={a.name}
                  style={{ width: 60, height: 60, objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-2)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📄 {a.name}
                </div>
              )}
              <div
                onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                style={{
                  position: 'absolute', top: 2, right: 2,
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'rgba(0,0,0,0.5)', color: '#fff',
                  fontSize: 10, display: 'grid', placeItems: 'center',
                  cursor: 'pointer', lineHeight: 1,
                }}
              >×</div>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--elev)',
        border: '0.5px solid var(--hairline-strong)',
        borderRadius: 18,
        padding: '4px 4px 4px 14px',
      }}>
        {/* File upload button */}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.go,.rs,.java,.sh,.yaml,.yml,.toml,.csv,.log"
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          style={{
            width: 28, height: 28, borderRadius: '50%',
            background: 'transparent', border: 'none',
            color: 'var(--text-3)', cursor: disabled ? 'default' : 'pointer',
            display: 'grid', placeItems: 'center', flexShrink: 0,
            fontSize: 16,
          }}
          title="上传文件或图片"
        >+</button>
        <input
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) send()
          }}
          onPaste={handlePaste}
          placeholder="和宠物说点什么..."
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 13,
            color: 'var(--text)',
            padding: '5px 0',
            fontFamily: 'var(--font)',
          }}
        />
        <button
          onClick={send}
          disabled={disabled || (!val.trim() && attachments.length === 0)}
          style={{
            width: 28, height: 28,
            borderRadius: '50%',
            background: (disabled || (!val.trim() && attachments.length === 0)) ? 'var(--separator)' : 'var(--accent)',
            border: 'none',
            color: 'var(--text-on-accent)',
            cursor: disabled ? 'default' : 'pointer',
            display: 'grid', placeItems: 'center',
            flexShrink: 0,
            transition: 'background 0.15s',
            boxShadow: (!disabled && (val.trim() || attachments.length > 0)) ? '0 1px 0 rgba(255,255,255,0.25) inset, 0 2px 6px var(--accent-glow)' : 'none',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 10V2M2 6L6 2L10 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
