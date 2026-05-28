import type { PetDisplayInfo, PetDisplayState } from '../src-shared/types'
import { PET_STATE_PRIORITY, IPC } from '../src-shared/types'
import type { SessionRegistry } from './session-registry'
import type { WindowManager } from './windows'
import { stateLabel } from './pet-state-machine'

const COMPLETED_DECAY_MS = 3_000
const ERROR_DECAY_MS = 5_000

export class PetAggregator {
  private currentState: PetDisplayState = 'idle'
  private drivenBySessionId: string | null = null
  private decayTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private registry: SessionRegistry,
    private wm: WindowManager,
  ) {
    registry.onChange(() => this.recompute())
  }

  recompute(): void {
    this.cancelDecay()

    const active = this.registry.activeSessions
    let newState: PetDisplayState
    let driverId: string | null

    if (active.length === 0) {
      newState = 'idle'
      driverId = null
    } else {
      // Sort by priority (lower = more urgent), then by stateSince (newest first), then id
      const leader = active.sort((a, b) => {
        const pa = PET_STATE_PRIORITY[a.currentState]
        const pb = PET_STATE_PRIORITY[b.currentState]
        if (pa !== pb) return pa - pb
        if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince
        return a.id < b.id ? -1 : 1
      })[0]
      newState = leader.currentState
      driverId = leader.id
    }

    if (newState === this.currentState && driverId === this.drivenBySessionId) return

    this.currentState = newState
    this.drivenBySessionId = driverId

    const info: PetDisplayInfo = {
      state: newState,
      drivenBySessionId: driverId ?? undefined,
      label: stateLabel(newState),
    }

    console.log(`[pet-aggregator] state → ${newState} (driver=${driverId ?? 'none'})`)
    this.wm.broadcast(IPC.PET_DISPLAY_STATE, info)

    // Auto-decay completed/error back to idle
    if (newState === 'completed') {
      this.decayTimer = setTimeout(() => {
        this.decayTimer = null
        if (this.currentState === 'completed') {
          this.currentState = 'idle'
          this.drivenBySessionId = null
          this.wm.broadcast(IPC.PET_DISPLAY_STATE, {
            state: 'idle', label: stateLabel('idle'),
          } satisfies PetDisplayInfo)
        }
      }, COMPLETED_DECAY_MS)
    } else if (newState === 'error') {
      this.decayTimer = setTimeout(() => {
        this.decayTimer = null
        if (this.currentState === 'error') {
          this.currentState = 'idle'
          this.drivenBySessionId = null
          this.wm.broadcast(IPC.PET_DISPLAY_STATE, {
            state: 'idle', label: stateLabel('idle'),
          } satisfies PetDisplayInfo)
        }
      }, ERROR_DECAY_MS)
    }
  }

  getState(): PetDisplayInfo {
    return {
      state: this.currentState,
      drivenBySessionId: this.drivenBySessionId ?? undefined,
      label: stateLabel(this.currentState),
    }
  }

  private cancelDecay(): void {
    if (this.decayTimer) {
      clearTimeout(this.decayTimer)
      this.decayTimer = null
    }
  }
}
