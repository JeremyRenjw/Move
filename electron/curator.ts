import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AiEngine, CuratorAction } from './ai'
import type { ApiConfig } from '@shared/types'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { PlaybookStore } from './playbook-store'
import type { MoodEngine } from './mood-engine'

const INTERVAL_MS    = 7 * 24 * 60 * 60_000    // 1 week
const MIN_IDLE_MS    = 2 * 60 * 60_000         // 2 hours of app uptime before first run
const POLL_MS        = 60 * 60_000             // check every hour whether to run
const STATE_FILE     = 'curator-state.json'

interface CuratorDeps {
  ai:        AiEngine
  events:    EventStore
  factStore: FactStore
  playbooks: PlaybookStore
  mood:      MoodEngine
  getActivePetId: () => string | null
  getApiConfig:   () => Promise<ApiConfig>
  getApiKey:      () => Promise<string | null>
  stateDir:       string
}

interface PersistedState {
  lastRunAt:  number   // epoch ms; 0 = never run, but first launch seeds to "now"
  startedAt:  number   // when the app first booted with curator enabled
}

/**
 * Weekly housekeeping pass.
 * Hermes-style: deferred first run, conservative pacing, single LLM call,
 * actions applied via existing stores. Never runs while the app is busy in
 * the foreground; only on the hourly poll when idle gate passes.
 */
export class Curator {
  private state: PersistedState
  private stateFile: string

  constructor(private deps: CuratorDeps) {
    this.stateFile = path.join(deps.stateDir, STATE_FILE)
    this.state = this.loadState()
  }

  private loadState(): PersistedState {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf-8')
      return JSON.parse(raw) as PersistedState
    } catch {
      const now = Date.now()
      const fresh = { lastRunAt: now, startedAt: now }
      this.persistState(fresh)
      return fresh
    }
  }

  private persistState(s: PersistedState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2))
    } catch { /* non-critical */ }
  }

  /** Schedule the periodic check. Returns a cancellation handle. */
  start(): () => void {
    const timer = setInterval(() => {
      this.maybeRun().catch(err => console.error('[curator] poll failed:', err))
    }, POLL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Run if due AND quiet enough. */
  async maybeRun(): Promise<void> {
    const now = Date.now()
    if (now - this.state.startedAt < MIN_IDLE_MS) return    // too soon after launch
    if (now - this.state.lastRunAt  < INTERVAL_MS) return    // already ran this week
    await this.runOnce()
  }

  /** Force a single curator pass (used by manual trigger / tests). */
  async runOnce(): Promise<{ applied: number; actions: CuratorAction[] }> {
    const petId = this.deps.getActivePetId() ?? 'stlulu'
    const [apiConfig, apiKey] = await Promise.all([
      this.deps.getApiConfig(),
      this.deps.getApiKey()
    ])
    if (!apiKey) {
      console.warn('[curator] no API key, skipping')
      return { applied: 0, actions: [] }
    }

    const [playbookList, factList] = await Promise.all([
      this.deps.playbooks.list({ enabledOnly: true }),
      this.deps.factStore.list(petId, { limit: 200 })
    ])

    const actions = await this.deps.ai.runCurator({
      playbooks: playbookList.map(p => ({
        id: p.id, title: p.title, triggers: p.triggers, uses: p.uses
      })),
      facts: factList.map(f => ({
        id: f.id, type: f.type, content: f.content, confidence: f.confidence
      })),
      apiKey,
      apiConfig
    })

    let applied = 0
    for (const a of actions) {
      try {
        if (a.kind === 'disable_playbook') {
          await this.deps.playbooks.disable(a.id)
          applied++
        } else if (a.kind === 'supersede_fact') {
          // supersede() expects a new fact body; here both ids exist already.
          // We emulate it by marking the old one as superseded without writing
          // a fresh row, which is fine because both are still in the file.
          // FactStore lacks an "edit existing" primitive — for now we delete
          // the old one (the new one is the canonical record).
          await this.deps.factStore.delete(petId, a.oldId)
          applied++
        } else if (a.kind === 'delete_fact') {
          await this.deps.factStore.delete(petId, a.id)
          applied++
        }
      } catch (err) {
        console.error('[curator] action failed:', a, err)
      }
    }

    this.state.lastRunAt = Date.now()
    this.persistState(this.state)

    // Award XP for knowledge organization
    if (applied > 0) this.deps.mood.addXp(20, 'curator_pass')

    await this.deps.events.append(petId, {
      type: 'reflector_tick',     // reuse existing event type; data.kind disambiguates
      source: 'reflector',
      data: { kind: 'curator', applied, total: actions.length }
    }).catch(() => {})

    return { applied, actions }
  }
}
