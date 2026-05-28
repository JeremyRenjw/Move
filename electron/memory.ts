import fs from 'fs/promises'
import path from 'path'
import type { ChatMessage } from '@shared/types'
import type { FactStore } from './fact-store'
import type { ExtractedFact } from './ai'

const MEMORY_FILE = 'MEMORY.md'
const SESSIONS_FILE = 'sessions.jsonl'
const MAX_MEMORY_CHARS = 8000

export interface MemorySummarizer {
  summarizeForMemory(opts: {
    history: ChatMessage[]
    existingMemory: string
  }): Promise<{ markdown: string; facts: ExtractedFact[] } | null>
}

export class MemoryStore {
  private root: string

  constructor(userData: string, private facts?: FactStore) {
    this.root = path.join(userData, 'memory')
  }

  private petDir(petId: string): string {
    return path.join(this.root, petId)
  }

  async readMemory(petId: string): Promise<string> {
    try {
      const raw = await fs.readFile(path.join(this.petDir(petId), MEMORY_FILE), 'utf-8')
      if (raw.length > MAX_MEMORY_CHARS) return raw.slice(-MAX_MEMORY_CHARS)
      return raw
    } catch {
      return ''
    }
  }

  async appendSession(petId: string, history: ChatMessage[]): Promise<void> {
    if (history.length === 0) return
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify({ ts: Date.now(), history }) + '\n'
    await fs.appendFile(path.join(dir, SESSIONS_FILE), line, 'utf-8')
  }

  /**
   * Read the most recent session's messages for resuming a conversation.
   * Returns the last N messages from the most recent session entry, or []
   * if the file doesn't exist.
   */
  async readSessionHistory(petId: string, maxMessages = 40): Promise<ChatMessage[]> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      if (lines.length === 0) return []
      const last = JSON.parse(lines[lines.length - 1]) as { history?: ChatMessage[] }
      return (last.history ?? []).slice(-maxMessages)
    } catch {
      return []
    }
  }

  /**
   * List recent session rounds for history browsing (paginated).
   * Reads only the last `limit` lines of the file.
   */
  async listSessionRounds(petId: string, limit = 50, offset = 0): Promise<{ ts: number; userMsg: string; petReply: string }[]> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const allLines = raw.trim().split('\n').filter(Boolean)
      const tail = allLines.slice(-(limit + offset)).slice(0, limit)
      return tail.map(line => {
        const entry = JSON.parse(line) as { ts: number; history: ChatMessage[] }
        const userMsg  = entry.history.find(m => m.role === 'user')?.content  ?? ''
        const petReply = entry.history.find(m => m.role === 'pet')?.content  ?? ''
        return {
          ts: entry.ts,
          userMsg:  userMsg.slice(0, 60),
          petReply: petReply.slice(0, 60)
        }
      }).reverse()
    } catch {
      return []
    }
  }

  /**
   * List all session rounds for history browsing.
   * Returns summaries with timestamp and first user/pet message snippets.
   */
  async listSessionRounds(petId: string): Promise<{ ts: number; userMsg: string; petReply: string }[]> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      return raw.trim().split('\n').filter(Boolean).map(line => {
        const entry = JSON.parse(line) as { ts: number; history: ChatMessage[] }
        const userMsg = entry.history.find(m => m.role === 'user')?.content ?? ''
        const petReply = entry.history.find(m => m.role === 'pet')?.content ?? ''
        return {
          ts: entry.ts,
          userMsg: userMsg.slice(0, 60),
          petReply: petReply.slice(0, 60)
        }
      }).reverse()  // newest first
    } catch {
      return []
    }
  }

  /**
   * Read a specific session round's full messages (by index from the end).
   */
  async readSessionRound(petId: string, indexFromEnd: number): Promise<ChatMessage[]> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const idx = lines.length - 1 - indexFromEnd
      if (idx < 0 || idx >= lines.length) return []
      const entry = JSON.parse(lines[idx]) as { history: ChatMessage[] }
      return entry.history ?? []
    } catch {
      return []
    }
  }

  /**
   * Delete a session round by index from the end.
   */
  async deleteSessionRound(petId: string, indexFromEnd: number): Promise<void> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const idx = lines.length - 1 - indexFromEnd
      if (idx < 0 || idx >= lines.length) return
      lines.splice(idx, 1)
      await fs.writeFile(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
    } catch { /* file doesn't exist */ }
  }

  /**
   * Delete all session history for a pet.
   */
  async clearSessionHistory(petId: string): Promise<void> {
    const file = path.join(this.petDir(petId), SESSIONS_FILE)
    try { await fs.unlink(file) } catch { /* file doesn't exist */ }
  }

  async summarizeAndAppend(
    petId: string,
    summarizer: MemorySummarizer,
    history: ChatMessage[]
  ): Promise<void> {
    if (history.length < 2) return
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    const existing = await this.readMemory(petId)
    const result = await summarizer.summarizeForMemory({ history, existingMemory: existing })
    if (!result) return

    if (result.markdown.trim()) {
      const stamp = new Date().toISOString().slice(0, 10)
      const block = `\n## ${stamp}\n${result.markdown.trim()}\n`
      await fs.appendFile(path.join(dir, MEMORY_FILE), block, 'utf-8')
    }

    if (this.facts && result.facts.length > 0) {
      for (const f of result.facts) {
        await this.facts.add(petId, {
          type:       f.type,
          content:    f.content,
          confidence: f.confidence,
          source:     { note: 'summarized' }
        }).catch(err => console.error('[memory] add fact failed:', err))
      }
    }
  }
}
