import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import type { MoodState, PetMood, PetStage, SystemStats, DriveParams } from '@shared/types'
import { DEFAULT_PARAMS } from './pet-traits'

const STATE_FILE = 'mood.json'
const HISTORY_FILE = 'mood-history.jsonl'

const DEFAULT_STATE: MoodState = {
  mood: 'calm',
  energy: 80,
  affection: 30,
  xp: 0,
  stage: 'baby',
  lastInteraction: 0,
  streak: 0,
  updated: 0,
}

// ─── Evolution stage config ───

export interface StageConfig {
  label: string
  personality: string[]      // traits to append to CharacterConfig
  greeting: string           // greeting template
  promptModifier: string     // injected into system prompt
}

const STAGE_THRESHOLDS: { stage: PetStage; xp: number }[] = [
  { stage: 'baby',  xp: 0 },
  { stage: 'child', xp: 100 },
  { stage: 'teen',  xp: 300 },
  { stage: 'adult', xp: 700 },
  { stage: 'elder', xp: 1500 },
]

export const STAGE_CONFIG: Record<PetStage, StageConfig> = {
  baby: {
    label: '幼崽',
    personality: ['好奇', '天真'],
    greeting: '嗨～我刚来到这个世界，什么都不太懂，请多关照呀！',
    promptModifier: '你是一个刚出生的宠物幼崽。你对世界充满好奇，说话简单直接，偶尔会问一些天真可爱的问题。',
  },
  child: {
    label: '幼年',
    personality: ['活泼', '好学'],
    greeting: '又见面啦！我最近学了好多新东西，想给你看看！',
    promptModifier: '你是一个成长中的宠物，正在学习各种技能。你活泼好动，喜欢尝试新事物，偶尔会犯小错误但总能从中学到东西。',
  },
  teen: {
    label: '少年',
    personality: ['独立', '有想法'],
    greeting: '嘿，今天有什么有趣的事吗？我有自己的想法了哦～',
    promptModifier: '你是一个有独立思想的少年宠物。你有自己的观点和偏好，偶尔会调皮地反驳用户，但本质善良。能处理更复杂的任务。',
  },
  adult: {
    label: '成年',
    personality: ['可靠', '高效'],
    greeting: '你好，我已经准备好了。有什么需要我帮忙的？',
    promptModifier: '你是一个成熟可靠的成年宠物助手。你高效、有条理，能独立完成复杂任务。对用户既专业又温暖，像一个值得信赖的伙伴。',
  },
  elder: {
    label: '长者',
    personality: ['智慧', '温和'],
    greeting: '你来了。坐下来聊聊吧，我很珍惜我们在一起的时光。',
    promptModifier: '你是一个阅历丰富的长者宠物。你智慧沉稳，说话言简意赅但充满洞察力。你见证了用户的成长，偶尔会分享有价值的回忆和建议。',
  },
}

// XP rewards — learning milestones, not raw interaction counts
export const XP_REWARDS = {
  playbook_created:  15,   // pet learned a new skill
  playbook_used:     5,    // pet successfully applied a skill
  fact_remembered:   8,    // pet learned something about the user
  tool_used:         5,    // pet used a tool in agent loop
  task_ok:          10,    // background task completed successfully
  task_fail:        -2,    // background task failed
  curator_pass:     20,    // pet organized its knowledge
  skill_installed:  12,    // external skill installed
  feedback_neg:     -1,    // user gave negative feedback
  streak_bonus:      3,    // daily streak maintained
} as const

const MOOD_LABELS: Record<PetMood, string> = {
  happy:   '开心',
  calm:    '平静',
  tired:   '疲惫',
  worried: '担心',
  excited: '兴奋',
  lonely:  '想念你',
}

const MOOD_HINTS: Record<PetMood, string> = {
  happy:   '心情不错，语气活泼，可以多用感叹号',
  calm:    '状态平和，语气温和自然',
  tired:   '有点累了，说话简洁，可能会打哈欠',
  worried: '有些担心，语气关心但克制',
  excited: '非常兴奋，语气热情洋溢',
  lonely:  '好久没见到用户了，有点撒娇和想念',
}

export type EvolveCallback = (newStage: PetStage, oldStage: PetStage) => void
export type MoodBroadcastCallback = (mood: PetMood, stage: PetStage) => void

export class MoodEngine {
  private state: MoodState
  private statePath: string
  private historyPath: string
  private onEvolve: EvolveCallback | null = null
  private onBroadcast: MoodBroadcastCallback | null = null
  private params: DriveParams = DEFAULT_PARAMS
  private lastSnapshotDate: string = ''

  constructor(private root: string) {
    this.statePath = path.join(root, STATE_FILE)
    this.historyPath = path.join(root, HISTORY_FILE)
    this.state = this.loadSync()
  }

  /** Register a callback that fires on evolution */
  setEvolveCallback(cb: EvolveCallback): void {
    this.onEvolve = cb
  }

  /** Register a callback that fires when mood/stage changes */
  setMoodBroadcastCallback(cb: MoodBroadcastCallback): void {
    this.onBroadcast = cb
  }

  /** Replace the active DriveParams (called when active pet changes). */
  setParams(p: DriveParams): void {
    this.params = p
  }

  private loadSync(): MoodState {
    try {
      const raw = fsSync.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<MoodState>
      return { ...DEFAULT_STATE, ...parsed }
    } catch {
      return { ...DEFAULT_STATE, updated: Date.now() }
    }
  }

  getMoodState(): MoodState {
    return { ...this.state }
  }

  getStage(): PetStage {
    return this.state.stage
  }

  getStageConfig(): StageConfig {
    return STAGE_CONFIG[this.state.stage]
  }

  /** Compute which stage corresponds to a given XP amount */
  static stageForXp(xp: number): PetStage {
    let result: PetStage = 'baby'
    for (const { stage, xp: threshold } of STAGE_THRESHOLDS) {
      if (xp >= threshold) result = stage
    }
    return result
  }

  /** Add XP and check for evolution. Returns new stage if evolved, null otherwise. Stage never decreases. */
  addXp(amount: number, reason?: string): PetStage | null {
    void reason  // reserved for logging/debugging
    const s = this.state
    s.xp = Math.max(0, s.xp + amount)
    const computedStage = MoodEngine.stageForXp(s.xp)
    // Only evolve forward, never devolve
    const STAGE_ORDER: PetStage[] = ['baby', 'child', 'teen', 'adult', 'elder']
    const currentIdx = STAGE_ORDER.indexOf(s.stage)
    const computedIdx = STAGE_ORDER.indexOf(computedStage)
    if (computedIdx > currentIdx) {
      const oldStage = s.stage
      s.stage = computedStage
      this.save().catch(() => {})
      this.onEvolve?.(computedStage, oldStage)
      return computedStage
    }
    return null
  }

  async save(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    this.state.updated = Date.now()
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8')
  }

  /** Core mood computation — called periodically by reflector */
  tick(stats: SystemStats): PetMood {
    const now = Date.now()
    const s = this.state

    // 1. Energy decays over time, recovers with interaction
    const hoursSinceInteraction = s.lastInteraction > 0
      ? (now - s.lastInteraction) / 3_600_000
      : 999
    s.energy = Math.max(10, Math.min(100, s.energy - hoursSinceInteraction * this.params.energyDecayPerHour))

    // 2. Late night energy drain
    const hour = new Date().getHours()
    if (hour >= 0 && hour < 6) {
      s.energy = Math.max(10, s.energy - 5)
    }

    // 3. Streak tracking
    if (s.lastInteraction > 0) {
      const daysSince = Math.floor((now - s.lastInteraction) / 86_400_000)
      if (daysSince >= 2) {
        s.streak = 0  // streak broken
      }
    }

    // 4. Affection decays slowly (1 point per day without interaction)
    const daysSinceLastInteraction = s.lastInteraction > 0
      ? (now - s.lastInteraction) / 86_400_000
      : 7
    if (daysSinceLastInteraction > 1) {
      s.affection = Math.max(0, s.affection - Math.floor(daysSinceLastInteraction))
    }

    // 5. Compute mood from all factors
    s.mood = this.computeMood(stats, now, hour)

    // 6. Log daily snapshot (once per calendar day)
    this.logDailySnapshot()

    this.onBroadcast?.(s.mood, s.stage)
    return s.mood
  }

  private logDailySnapshot(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this.lastSnapshotDate === today) return
    this.lastSnapshotDate = today
    const s = this.state
    const entry = JSON.stringify({
      date: today,
      mood: s.mood,
      energy: Math.round(s.energy),
      affection: Math.round(s.affection),
      xp: s.xp,
      stage: s.stage,
    })
    fs.appendFile(this.historyPath, entry + '\n', 'utf-8').catch(() => {})
  }

  /** Read the last N days of mood history for the growth curve chart */
  async getGrowthHistory(days: number): Promise<{ date: string; mood: PetMood; energy: number; affection: number; xp: number; stage: PetStage }[]> {
    try {
      const raw = await fs.readFile(this.historyPath, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const entries = lines.map(l => JSON.parse(l))
      return entries.slice(-days)
    } catch {
      return []
    }
  }

  private computeMood(stats: SystemStats, now: number, hour: number): PetMood {
    const s = this.state
    const hoursSinceInteraction = s.lastInteraction > 0
      ? (now - s.lastInteraction) / 3_600_000
      : 999

    // Lonely: no interaction for N+ hours during waking time (trait-driven)
    if (hoursSinceInteraction > this.params.lonelyHoursThreshold && hour >= 8 && hour <= 23) {
      return 'lonely'
    }

    // Tired: late night or low energy
    if ((hour >= 0 && hour < 6) || s.energy < 25) {
      return 'tired'
    }

    // Worried: system overload
    if (stats.cpu > 85 || (stats.ramUsed / stats.ramTotal) > 0.9) {
      return 'worried'
    }

    // Excited: high affection + recent interaction + good system stats
    if (s.affection > 70 && hoursSinceInteraction < 0.5 && stats.cpu < 50) {
      return 'excited'
    }

    // Happy: decent affection or recent positive interaction
    if (s.affection > 50 || s.energy > 70) {
      return 'happy'
    }

    return 'calm'
  }

  /** Record an interaction event (mood changes only, XP awarded separately at call sites) */
  onInteraction(kind: 'chat' | 'feedback_pos' | 'feedback_neg' | 'task_ok' | 'task_fail'): void {
    const now = Date.now()
    const s = this.state
    const hoursSince = s.lastInteraction > 0 ? (now - s.lastInteraction) / 3_600_000 : 999

    // Update streak
    let streakBonus = false
    if (s.lastInteraction > 0) {
      const daysSince = Math.floor((now - s.lastInteraction) / 86_400_000)
      if (daysSince <= 1) {
        if (daysSince === 1) {
          s.streak += 1
          streakBonus = true
        }
      } else {
        s.streak = 1
      }
    } else {
      s.streak = 1
    }

    s.lastInteraction = now

    switch (kind) {
      case 'chat':
        s.affection = Math.min(100, s.affection + 2)
        s.energy = Math.min(100, s.energy + this.params.energyRecoveryChat)
        if (hoursSince > 2) {
          s.affection = Math.min(100, s.affection + 5)
        }
        break
      case 'feedback_pos':
        s.affection = Math.min(100, s.affection + 8)
        s.energy = Math.min(100, s.energy + 5)
        break
      case 'feedback_neg':
        s.affection = Math.max(0, s.affection - 3)
        this.addXp(XP_REWARDS.feedback_neg)
        break
      case 'task_ok':
        s.affection = Math.min(100, s.affection + 3)
        s.energy = Math.min(100, s.energy + 5)
        break
      case 'task_fail':
        s.energy = Math.max(10, s.energy - 10)
        this.addXp(XP_REWARDS.task_fail)
        break
    }

    // Streak bonus XP
    if (streakBonus) this.addXp(XP_REWARDS.streak_bonus)

    this.save().catch(() => {})
    this.onBroadcast?.(s.mood, s.stage)
  }

  /** Generate mood context string for prompt injection */
  buildMoodContext(): string {
    const s = this.state
    const label = MOOD_LABELS[s.mood]
    const hint = MOOD_HINTS[s.mood]
    const energyDesc = s.energy > 70 ? '充沛' : s.energy > 40 ? '一般' : '低落'
    const affectionDesc = s.affection > 70 ? '亲密' : s.affection > 40 ? '友好' : '生疏'
    const stageCfg = STAGE_CONFIG[s.stage]

    let line = `[情绪状态 —— 影响你的语气和行为风格，但不要直接复述这些数字]
你现在的情绪：${label}
体力：${energyDesc}（${s.energy}/100）
和用户的关系：${affectionDesc}（${s.affection}/100）
成长阶段：${stageCfg.label}（${s.stage}）
${stageCfg.promptModifier}
语气指引：${hint}`

    if (s.streak >= 7) {
      line += `\n你和用户已经连续互动 ${s.streak} 天了，你们的关系很稳定，适当表达开心。`
    }

    if (s.lastInteraction > 0) {
      const hoursAgo = Math.floor((Date.now() - s.lastInteraction) / 3_600_000)
      if (hoursAgo >= 2) {
        line += `\n距离上次聊天已经 ${hoursAgo} 小时了，用户回来了，表达一下想念。`
      }
    }

    return line
  }

  getHoursSinceInteraction(): number {
    return this.state.lastInteraction > 0
      ? (Date.now() - this.state.lastInteraction) / 3_600_000
      : 999
  }

  isWakingHours(): boolean {
    const hour = new Date().getHours()
    return hour >= 8 && hour <= 23
  }

  getEnergy(): number {
    return this.state.energy
  }

  getAffection(): number {
    return this.state.affection
  }

  getStreak(): number {
    return this.state.streak
  }

  /** Map mood to pet animation state */
  toAnimState(): 'idle' | 'talk' | 'working' | 'alert' | 'celebrate' {
    switch (this.state.mood) {
      case 'happy':
      case 'excited':
        return Math.random() < 0.3 ? 'celebrate' : 'idle'
      case 'worried':
        return 'alert'
      case 'tired':
        return 'idle'
      case 'lonely':
        return 'idle'
      default:
        return 'idle'
    }
  }
}
