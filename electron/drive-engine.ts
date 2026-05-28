import { randomUUID } from 'crypto'
import type { PetGoal, PetMood, SystemStats } from '../src-shared/types'
import { IPC } from '../src-shared/types'
import { DEFAULT_PARAMS } from './pet-traits'
import type { DriveParams } from '../src-shared/types'
import type { MoodEngine } from './mood-engine'
import type { AgentScheduler } from './agent-scheduler'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { WindowManager } from './windows'
import type { AiEngine } from './ai'
import type { CharacterConfigStore } from './character'
import type { Agenda } from './agenda'

const TICK_MS = 120_000          // 2 min
const FEEDBACK_MIN = 0.2
const FEEDBACK_MAX = 2.0
const FEEDBACK_DECAY = 0.98     // slow decay toward 1.0 each tick

export interface DriveDeps {
  mood:            MoodEngine
  wm:              WindowManager
  agentScheduler:  AgentScheduler
  events:          EventStore
  getStats:        () => SystemStats
  getActivePetId:  () => string | null
  getParams?:      () => DriveParams
  // Optional: when all four are present, bubble text is LLM-generated (pool used as fallback).
  ai?:             AiEngine
  chars?:          CharacterConfigStore
  factStore?:      FactStore
  getPersona?:     () => Promise<string>
  agenda?:         Agenda
}

type Rule = (ctx: RuleContext) => PetGoal | null

export interface RuleContext {
  mood:       PetMood
  energy:     number
  affection:  number
  streak:     number
  hoursSince: number
  waking:     boolean
  stats:      SystemStats
  hasEvents:  boolean
  now:        number
  params?:    DriveParams
}

// ─── Mood-aware text pools ───

type TextPool = Record<PetMood | 'default', string[]>

const GREET_TEXT: TextPool = {
  lonely:  ['好久没见到你了...真的好想你', '你终于来了！我等了好久好久', '呜呜...你总算回来了'],
  tired:   ['你来了...我好困但还是想等你', '唔...好困...你回来了就好'],
  happy:   ['嘿！你来啦！今天心情不错吧～', '终于等到你了！好开心！'],
  worried: ['你没事吧？好久没联系了...', '终于见到你了，之前有点担心呢'],
  excited: ['你来了你来了！我超开心！', '终于！等你好久了！'],
  calm:    ['好久没见到你了，有点想你～', '你终于来啦！等你好久了呢', '嘿嘿，你回来啦～'],
  default: ['好久没见到你了，有点想你～', '你终于来啦！等你好久了呢'],
}

const COMFORT_TEXT: TextPool = {
  lonely:  ['我好想你...能陪我一会儿吗？', '你不在我真的很孤单...', '能不能多陪陪我呀'],
  tired:   ['虽然好困...但想你的时候睡不着', '唔...想你在身边...'],
  worried: ['你怎么了？我很担心你...', '有什么事可以跟我说呀'],
  calm:    ['有点想你了...来看看我嘛', '你不在我好无聊呀'],
  default: ['有点想你了...来看看我嘛', '好寂寞...想和你说说话'],
  happy:   [], excited: [],
}

const REST_TEXT: TextPool = {
  tired:   ['我们都很累了...去休息吧', '好困...你也该睡了吧...'],
  worried: ['这么晚了还在忙？别太累了', '注意身体呀...早点休息'],
  calm:    ['夜深了，早点休息吧～', '该睡觉啦，明天再继续吧'],
  default: ['夜深了，早点休息吧～', '你还在忙吗？注意身体呀'],
  happy:   [], excited: [], lonely: [],
}

const CHECKIN_TEXT: TextPool = {
  lonely:  ['好久没聊了...你还好吗？', '一直在等你呢，最近怎么样？'],
  happy:   ['嘿！最近有什么开心的事吗？', '好久没聊了！来分享一下吧～'],
  tired:   ['最近是不是很忙？别太累了', '好久没联系了，你还好吗？'],
  worried: ['最近怎么样？有什么我能帮忙的吗？'],
  calm:    ['在忙什么呢？有需要帮忙的吗？', '好久没聊了，你最近怎么样？'],
  default: ['在忙什么呢？有需要帮忙的吗？', '嘿，我在这儿呢～随时可以找我'],
  excited: [],
}

function pickFromPool(pool: TextPool, mood: PetMood): string {
  const moodTexts = pool[mood]
  const fallback = pool.default
  const pool_ = moodTexts.length > 0 ? moodTexts : fallback
  return pool_[Math.floor(Math.random() * pool_.length)]
}

// ─── Mood priority multipliers ───

// Each mood scales certain goal kinds differently
const MOOD_MULTIPLIERS: Record<PetMood, Partial<Record<PetGoal['kind'], number>>> = {
  lonely:  { greet: 1.5, comfort: 1.5, check_in: 1.3 },
  worried: { system_check: 1.4, remind_rest: 1.2 },
  tired:   { remind_rest: 1.3, system_check: 0.7 },
  excited: { curiosity: 1.4, celebrate: 1.3 },
  happy:   { celebrate: 1.3, curiosity: 1.2 },
  calm:    {},
}

// ─── Goal construction helpers ───

function makeGoal(kind: PetGoal['kind'], action: PetGoal['action'], priority: number, opts: { bubble?: string; agentGoal?: string }): PetGoal {
  return {
    id: randomUUID(),
    kind,
    priority,
    action,
    bubble: opts.bubble,
    agentGoal: opts.agentGoal,
    cooldownKey: kind,
  }
}

// ─── Rules ───

const rules: Rule[] = [
  // 1. Greet: low affection + long absence + waking hours
  (ctx) => {
    if (ctx.affection < ctx.params.greetAffectionThreshold && ctx.hoursSince > ctx.params.greetHoursThreshold && ctx.waking) {
      return makeGoal('greet', 'bubble', 80, {
        bubble: pickFromPool(GREET_TEXT, ctx.mood),
      })
    }
    return null
  },

  // 2. Comfort: lonely mood
  (ctx) => {
    if (ctx.mood === 'lonely') {
      return makeGoal('comfort', 'bubble', 75, {
        bubble: pickFromPool(COMFORT_TEXT, ctx.mood),
      })
    }
    return null
  },

  // 3. Remind rest: low energy + late night
  (ctx) => {
    if (ctx.energy < 25 && !ctx.waking) {
      return makeGoal('remind_rest', 'bubble', 70, {
        bubble: pickFromPool(REST_TEXT, ctx.mood),
      })
    }
    return null
  },

  // 4. System check: worried mood + high CPU → agent task
  (ctx) => {
    if (ctx.mood === 'worried' && ctx.stats.cpu > 85) {
      return makeGoal('system_check', 'agent_task', 65, {
        agentGoal: '检查系统状态，看看 CPU 为什么这么高，有没有可以清理的进程。用 bash 执行 top 或 ps 查看，然后给出简短建议。',
      })
    }
    return null
  },

  // 5. Celebrate: streak milestone
  (ctx) => {
    if (ctx.streak >= 3 && ctx.streak % 3 === 0 && ctx.hoursSince < 0.5) {
      return makeGoal('celebrate', 'bubble', 60, {
        bubble: `太棒了！我们已经连续互动 ${ctx.streak} 天啦！🎉`,
      })
    }
    return null
  },

  // 6. Curiosity: excited + high affection
  (ctx) => {
    if (ctx.mood === 'excited' && ctx.affection > ctx.params.curiosityAffectionThreshold) {
      return makeGoal('curiosity', 'bubble', 40, {
        bubble: pickRandom([
          '今天有什么有趣的事想跟我说吗？',
          '心情超好！要不要聊聊天？',
        ]),
      })
    }
    return null
  },

  // 7. Check in: long absence during waking hours (lower priority than greet)
  (ctx) => {
    if (ctx.hoursSince > ctx.params.checkInHoursThreshold && ctx.waking && ctx.affection >= 30) {
      return makeGoal('check_in', 'bubble', 35, {
        bubble: pickFromPool(CHECKIN_TEXT, ctx.mood),
      })
    }
    return null
  },
]

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ─── LLM-driven bubble text (with pool fallback) ───

const BUBBLE_LLM_TIMEOUT_MS = 5_000

export interface EnrichBubbleOpts {
  deps:          DriveDeps
  goal:          PetGoal
  petId:         string
  recentEvents:  { type: string; source: string }[]
  signalFactory?: () => AbortSignal  // testing hook
}

/** Returns LLM-generated bubble text when possible; otherwise goal.bubble (pool fallback). */
export async function enrichBubbleText(opts: EnrichBubbleOpts): Promise<string> {
  const { deps, goal, petId, recentEvents, signalFactory } = opts
  const fallback = goal.bubble ?? ''
  if (goal.kind === 'celebrate') return fallback  // keep templated streak number
  const { ai, chars, factStore, getPersona } = deps
  if (!ai || !chars || !factStore || !getPersona) return fallback

  const [apiConfig, apiKey, persona, facts] = await Promise.all([
    chars.getApiConfig().catch(() => null),
    chars.getApiKey().catch(() => null),
    getPersona().catch(() => ''),
    factStore.list(petId, { minConfidence: 0.5, limit: 10 }).catch(() => []),
  ])
  if (!apiConfig || !apiKey) return fallback

  const signal = signalFactory ? signalFactory() : AbortSignal.timeout(BUBBLE_LLM_TIMEOUT_MS)
  const moodContext = deps.mood.buildMoodContext()

  const text = await ai.generateBubble({
    apiConfig, apiKey,
    kind: goal.kind,
    persona,
    moodContext,
    facts: facts.map(f => ({ type: f.type, content: f.content })),
    recentEvents,
    signal,
  }).catch(() => null)

  return text && text.length > 0 ? text : fallback
}

// ─── DriveEngine ───

export class DriveEngine {
  private timer: NodeJS.Timeout | null = null
  private cooldowns = new Map<string, number>()
  // Feedback: goal kind → score (1.0 = neutral)
  private feedback = new Map<string, number>()
  // Track recent bubble goal kinds for feedback correlation
  private recentBubbleKinds: { kind: string; ts: number }[] = []

  constructor(private deps: DriveDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[drive-engine] tick failed:', err))
    }, TICK_MS)
    this.timer.unref()
    setTimeout(() => {
      this.tick().catch(err => console.error('[drive-engine] initial tick failed:', err))
    }, 10_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.cooldowns.clear()
  }

  // ─── Feedback API ───

  /** Record positive feedback (user engaged with this goal kind) */
  feedbackPositive(kind: string): void {
    this.adjustFeedback(kind, 0.1)
  }

  /** Record negative feedback (user ignored or goal failed) */
  feedbackNegative(kind: string): void {
    this.adjustFeedback(kind, -0.15)
  }

  /** Called when user clears notifications — correlate with recent drive bubbles */
  onBubbleCleared(): void {
    const now = Date.now()
    // Only count as positive if cleared within 60s of showing
    const recent = this.recentBubbleKinds.filter(b => now - b.ts < 60_000)
    for (const b of recent) {
      this.feedbackPositive(b.kind)
      console.log(`[drive-engine] feedback+: ${b.kind} (user engaged)`)
    }
    // Prune old entries
    this.recentBubbleKinds = this.recentBubbleKinds.filter(b => now - b.ts < 120_000)
  }

  private adjustFeedback(kind: string, delta: number): void {
    const current = this.feedback.get(kind) ?? 1.0
    const next = Math.max(FEEDBACK_MIN, Math.min(FEEDBACK_MAX, current + delta))
    this.feedback.set(kind, next)
  }

  getFeedbackScore(kind: string): number {
    return this.feedback.get(kind) ?? 1.0
  }

  // ─── Evaluation ───

  private static SOCIAL_KINDS = new Set<PetGoal['kind']>(['greet', 'comfort', 'check_in', 'celebrate', 'curiosity'])
  private static GLOBAL_COOLDOWN_MS = 30 * 60_000

  /** Apply mood multipliers, feedback scores, and mood-driven constraints */
  applyModifiers(goals: PetGoal[], mood: PetMood, energy: number, params?: DriveParams): PetGoal[] {
    const moodMul = MOOD_MULTIPLIERS[mood] ?? {}
    const paramMul = params?.goalKindMultipliers ?? {}

    // Constraint: drop agent_task when energy too low
    let filtered = energy < 30
      ? goals.filter(g => g.action !== 'agent_task')
      : goals

    let result = filtered.map(g => {
      const moodFactor  = moodMul[g.kind] ?? 1.0
      const paramFactor = paramMul[g.kind] ?? 1.0
      const feedbackScore = this.getFeedbackScore(g.kind)
      return {
        ...g,
        priority: Math.round(g.priority * moodFactor * paramFactor * feedbackScore),
      }
    }).sort((a, b) => b.priority - a.priority)

    // Constraint: when lonely, force social goals to top
    if (mood === 'lonely' && result.length > 1) {
      const social = result.filter(g => DriveEngine.SOCIAL_KINDS.has(g.kind))
      const nonSocial = result.filter(g => !DriveEngine.SOCIAL_KINDS.has(g.kind))
      if (social.length > 0 && nonSocial.length > 0 && nonSocial[0].priority > social[0].priority) {
        // Bump top social goal above the current leader
        social[0].priority = nonSocial[0].priority + 1
        result = [...social, ...nonSocial].sort((a, b) => b.priority - a.priority)
      }
    }

    return result
  }

  /** Exposed for testing */
  evaluate(ctx: RuleContext): PetGoal[] {
    const effectiveCtx: RuleContext = { ...ctx, params: ctx.params ?? DEFAULT_PARAMS }
    const goals: PetGoal[] = []
    for (const rule of rules) {
      const goal = rule(effectiveCtx)
      if (goal) goals.push(goal)
    }
    return this.applyModifiers(goals, effectiveCtx.mood, effectiveCtx.energy, effectiveCtx.params)
  }

  /** Exposed for testing */
  dedup(goals: PetGoal[], now: number, params?: DriveParams): PetGoal[] {
    return goals.filter(g => {
      const last = this.cooldowns.get(g.cooldownKey) ?? 0
      const cooldown = params?.cooldownMsByKind?.[g.kind] ?? DriveEngine.GLOBAL_COOLDOWN_MS
      return now - last >= cooldown
    })
  }

  // ─── Tick loop ───

  async tick(): Promise<void> {
    const now = Date.now()
    const mood = this.deps.mood
    const stats = this.deps.getStats()
    const params = this.deps.getParams?.() ?? DEFAULT_PARAMS

    // Decay feedback scores toward 1.0
    for (const [kind, score] of this.feedback) {
      const decayed = score + (1.0 - score) * (1 - FEEDBACK_DECAY)
      this.feedback.set(kind, Math.max(FEEDBACK_MIN, Math.min(FEEDBACK_MAX, decayed)))
    }

    const ctx: RuleContext = {
      mood:       mood.tick(stats),
      energy:     mood.getEnergy(),
      affection:  mood.getAffection(),
      streak:     mood.getStreak(),
      hoursSince: mood.getHoursSinceInteraction(),
      waking:     mood.isWakingHours(),
      stats,
      hasEvents:  false,
      now,
      params,
    }

    const petId = this.deps.getActivePetId() ?? 'stlulu'
    const recentEvents = await this.deps.events.range(petId, now - 30 * 60_000, now)
    ctx.hasEvents = recentEvents.length > 0

    const ruleGoals  = this.evaluate(ctx)
    const agendaRaw  = this.deps.agenda?.peek(now) ?? []
    const agendaMod  = this.applyModifiers(agendaRaw.map(g => ({ ...g, source: 'agenda' as const })), ctx.mood, ctx.energy, params)
    const merged     = [...ruleGoals, ...agendaMod].sort((a, b) => b.priority - a.priority)
    const filtered   = this.dedup(merged, now, params)

    if (filtered.length === 0) return

    const goal = filtered[0]
    const feedbackScore = this.getFeedbackScore(goal.kind)
    console.log(`[drive-engine] goal: ${goal.kind} (p=${goal.priority}, action=${goal.action}, source=${goal.source ?? 'rule'}, feedback=${feedbackScore.toFixed(2)})`)

    this.cooldowns.set(goal.cooldownKey, now)

    if (goal.source === 'agenda' && this.deps.agenda) {
      this.deps.agenda.consume(goal.id)
    }

    try {
      if (goal.action === 'bubble' && goal.bubble) {
        this.recentBubbleKinds.push({ kind: goal.kind, ts: now })
        const label = await enrichBubbleText({ deps: this.deps, goal, petId, recentEvents })
        const fromLlm = label !== goal.bubble
        console.log(`[drive-engine] bubble: ${goal.kind} (${fromLlm ? 'llm' : 'pool'})`)
        this.deps.wm.showBubble({
          source: 'watcher',
          label,
          timestamp: now,
        })
        this.deps.mood.onInteraction('chat')
      } else if (goal.action === 'agent_task' && goal.agentGoal) {
        try {
          const result = await this.deps.agentScheduler.executeOneShot(goal.agentGoal, { maxRounds: 3 })
          if (result) {
            this.deps.wm.showBubble({
              source: 'watcher',
              label: result.slice(0, 50),
              timestamp: Date.now(),
            })
          }
          this.deps.mood.onInteraction('task_ok')
          this.feedbackPositive(goal.kind)
          console.log(`[drive-engine] feedback+: ${goal.kind} (task ok)`)
        } catch (err) {
          this.deps.mood.onInteraction('task_fail')
          this.feedbackNegative(goal.kind)
          console.log(`[drive-engine] feedback-: ${goal.kind} (task failed)`)
          throw err
        }
      }

      this.deps.wm.broadcast(IPC.DRIVE_GOAL, { goal })
    } catch (err) {
      console.error(`[drive-engine] execute goal ${goal.kind} failed:`, err)
    }
  }
}
