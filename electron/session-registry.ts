import type { PetDisplayState, NotifyToolName, SessionInfo } from '../src-shared/types'

const STALE_THRESHOLD_MS = 90_000

export type SessionMutation = 'added' | 'removed' | 'state_changed' | 'fields_updated'

export class SessionRegistry {
  private sessions = new Map<string, SessionInfo>()
  private listeners: ((mutation: SessionMutation, sessionId: string) => void)[] = []

  onChange(fn: (mutation: SessionMutation, sessionId: string) => void): void {
    this.listeners.push(fn)
  }

  private emit(mutation: SessionMutation, sessionId: string): void {
    for (const fn of this.listeners) fn(mutation, sessionId)
  }

  upsert(id: string, tool: NotifyToolName, cwd: string, now: number): SessionInfo {
    const existing = this.sessions.get(id)
    if (existing) {
      existing.lastActivityAt = now
      existing.cwd = cwd
      this.emit('fields_updated', id)
      return existing
    }
    const session: SessionInfo = {
      id, tool, cwd,
      currentState: 'idle',
      stateSince: now,
      lastActivityAt: now,
    }
    this.sessions.set(id, session)
    this.emit('added', id)
    return session
  }

  remove(id: string): void {
    if (this.sessions.delete(id)) {
      this.emit('removed', id)
    }
  }

  session(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  transition(id: string, newState: PetDisplayState, now: number): void {
    const s = this.sessions.get(id)
    if (!s || s.currentState === newState) return
    s.currentState = newState
    s.stateSince = now
    s.lastActivityAt = now
    this.emit('state_changed', id)
  }

  patch(id: string, fn: (s: SessionInfo) => void): void {
    const s = this.sessions.get(id)
    if (!s) return
    fn(s)
    s.lastActivityAt = Date.now()
    this.emit('fields_updated', id)
  }

  get activeSessions(): SessionInfo[] {
    return [...this.sessions.values()]
  }

  /** Remove sessions with no activity for STALE_THRESHOLD_MS */
  pruneStale(now: number = Date.now()): string[] {
    const victims: string[] = []
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivityAt > STALE_THRESHOLD_MS) {
        victims.push(id)
        this.sessions.delete(id)
        this.emit('removed', id)
      }
    }
    return victims
  }
}
