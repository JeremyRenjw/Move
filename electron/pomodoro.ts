import { BrowserWindow } from 'electron'

export type PomodoroPhase = 'idle' | 'focus' | 'break'
export type PomodoroState = {
  phase: PomodoroPhase
  remaining: number   // seconds
  total: number       // total seconds for current phase
  rounds: number      // completed focus rounds
}

export type PomodoroListener = (state: PomodoroState) => void

const FOCUS_MIN = 25
const BREAK_MIN = 5
const LONG_BREAK_MIN = 15
const LONG_BREAK_EVERY = 4

export class Pomodoro {
  private phase: PomodoroPhase = 'idle'
  private remaining = 0
  private total = 0
  private rounds = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners: Set<PomodoroListener> = new Set()

  /** Is a focus session currently active? */
  get isActive(): boolean {
    return this.phase === 'focus'
  }

  getState(): PomodoroState {
    return { phase: this.phase, remaining: this.remaining, total: this.total, rounds: this.rounds }
  }

  subscribe(listener: PomodoroListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    const state = this.getState()
    for (const l of this.listeners) l(state)
  }

  private broadcastToWindows(state: PomodoroState): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('pomodoro:state', state)
      }
    }
  }

  start(): void {
    if (this.phase !== 'idle') return
    this.phase = 'focus'
    this.remaining = FOCUS_MIN * 60
    this.total = this.remaining
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.phase = 'idle'
    this.remaining = 0
    this.total = 0
    this.emit()
    this.broadcastToWindows(this.getState())
  }

  reset(): void {
    this.stop()
    this.rounds = 0
  }

  /** Skip to next phase (for manual advancement) */
  skip(): void {
    if (this.phase === 'idle') return
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.phase === 'focus') {
      this.rounds++
      this.startBreak()
    } else {
      this.startFocus()
    }
  }

  private tick(): void {
    if (this.phase === 'idle') return
    this.remaining--
    if (this.remaining <= 0) {
      if (this.phase === 'focus') {
        this.rounds++
        this.startBreak()
      } else {
        this.startFocus()
      }
    }
    const state = this.getState()
    this.emit()
    this.broadcastToWindows(state)
  }

  private startFocus(): void {
    this.phase = 'focus'
    this.remaining = FOCUS_MIN * 60
    this.total = this.remaining
    this.timer = setInterval(() => this.tick(), 1000)
  }

  private startBreak(): void {
    this.phase = 'break'
    const isLong = this.rounds % LONG_BREAK_EVERY === 0
    this.remaining = (isLong ? LONG_BREAK_MIN : BREAK_MIN) * 60
    this.total = this.remaining
    this.timer = setInterval(() => this.tick(), 1000)
  }
}
