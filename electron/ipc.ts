import { ipcMain, dialog, app } from 'electron'
import { randomUUID } from 'crypto'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { IPC } from '@shared/types'
import type { WindowManager } from './windows'
import type { PetManager } from './pets'
import type { CharacterConfigStore } from './character'
import type { AiEngine } from './ai'
import type { CliRunner, RunHandle } from './runner'
import type { CleanupEngine } from './cleanup'
import type { EventStore } from './event-store'
import type { FactStore } from './fact-store'
import type { PlaybookStore } from './playbook-store'
import type { SystemMonitor } from './monitor'
import type { MemoryStore } from './memory'
import type { CliWatcher } from './watcher'
import type { EventRouter } from './event-router'
import type { EventDirWatcher } from './event-dir-watcher'
import type { RuntimeState } from './runtime-state'
import type { McpManager } from './mcp-manager'
import type { SkillStore } from './skill-store'
import type { AttachmentStore } from './attachments'
import type { AgentTaskStore } from './agent-tasks'
import type { AgentScheduler } from './agent-scheduler'
import type { MoodEngine } from './mood-engine'
import type { DriveEngine } from './drive-engine'
import type { Pomodoro } from './pomodoro'
import type { TraitLearner } from './trait-learner'
import { getLocalStatusReply } from './local-status-replies'
import {
  installClaudeHooks, uninstallClaudeHooks, getClaudeStatus,
  installCodexHooks, uninstallCodexHooks, getCodexStatus
} from './hook-installer'
import type {
  AgentTaskCreateInput,
  AgentTaskUpdateInput,
  SystemStats,
  CharacterConfig,
  ApiConfig,
  ChatMessage,
  WatcherNote,
  HookInstallStatus,
  NotifyEvent,
  ChatAttachment,
  GeneratePetInput
} from '@shared/types'

function detectPetAction(text: string): { action: string; count: number } | null {
  if (!text) return null
  // Extract repetition count from patterns like "跳100下", "跳 3 次", "连续跳10下"
  const countMatch = text.match(/(\d+)\s*[次下遍回]/)
  const count = countMatch ? Math.min(parseInt(countMatch[1]), 50) : 1

  if (/跳舞|跳个舞|来个舞|跳起了|跳吧|开始跳/.test(text)) return { action: 'dance', count }
  if (/转圈|转个圈|旋转|转起来/.test(text)) return { action: 'spin', count }
  if (/挥手|招手|拜拜|再见/.test(text)) return { action: 'wave', count }
  if (/鞠躬|弯腰/.test(text)) return { action: 'bow', count }
  if (/跳[了着]?\d|蹦[了着]?\d|连续跳|跳\b/.test(text)) return { action: 'jump', count }
  if (/庆祝|恭喜|太棒|好耶|耶/.test(text)) return { action: 'celebrate', count }
  return null
}

type SlashCmd = { cmd: 'codex' | 'claude'; prompt: string }

export function parseSlash(msg: string): SlashCmd | null {
  const m = msg.match(/^\/(\w+)\s+(.+)$/s)
  if (!m) return null
  const head = m[1]
  const rest = m[2].trim()
  if (!rest) return null
  if (head === 'codex')  return { cmd: 'codex',  prompt: rest }
  if (head === 'claude') return { cmd: 'claude', prompt: rest }
  if (head === 'run') {
    const m2 = rest.match(/^(codex|claude)\s+(.+)$/s)
    if (!m2) return null
    const sub = m2[2].trim()
    if (!sub) return null
    return { cmd: m2[1] as 'codex' | 'claude', prompt: sub }
  }
  return null
}

export function registerIpcHandlers(deps: {
  wm:          WindowManager
  pets:        PetManager
  chars:       CharacterConfigStore
  ai:          AiEngine
  runner:      CliRunner
  cleanup:     CleanupEngine
  monitor:     SystemMonitor
  memory:      MemoryStore
  watcher:     CliWatcher
  attachments: AttachmentStore
  getStats:    () => SystemStats
  eventRouter:     EventRouter
  eventDirWatcher: EventDirWatcher
  runtimeState:    RuntimeState
  events:      EventStore   // pet brain event stream
  factStore:   FactStore
  playbooks:   PlaybookStore
  mcpManager:  McpManager
  skillStore:  SkillStore
  agentTasks:  AgentTaskStore
  agentScheduler: AgentScheduler
  mood:        MoodEngine
  driveEngine?: DriveEngine
  pomodoro?:   Pomodoro
  traitLearner?: TraitLearner
}): void {
  const { wm, pets, chars, ai, runner, cleanup, memory, watcher, attachments: attachmentStore, getStats, eventRouter, eventDirWatcher, runtimeState, events, factStore, playbooks, mcpManager, skillStore, agentTasks, agentScheduler, mood, driveEngine, pomodoro, traitLearner } = deps
  let activeCli: RunHandle | null = null

  ipcMain.handle(IPC.PET_LIST, async () => {
    const list = await pets.list()
    const activeId = pets.getActiveId()
    if (!activeId) return list
    const activePet = await pets.load(activeId, mood.getStage())
    return activePet ? list.map(p => p.id === activeId ? activePet : p) : list
  })
  ipcMain.handle(IPC.PET_GET_ACTIVE, ()                  => pets.getActiveId())
  ipcMain.handle(IPC.PET_SWITCH,     async (_, petId: string) => {
    pets.setActive(petId)
    const params = await pets.resolveParams(petId, chars)
    mood.setParams(params)
    const pet = await pets.load(petId, mood.getStage())
    if (pet) wm.broadcast(IPC.PET_ACTIVE_CHANGED, pet)
  })
  ipcMain.handle(IPC.PET_IMPORT, (_, dirPath: string) => pets.importFrom(dirPath))
  ipcMain.handle(IPC.PET_GENERATE, async (_, input: GeneratePetInput) => {
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error('请输入宠物名字')
    if (!prompt) throw new Error('请输入宠物描述')

    const [apiConfig, apiKey] = await Promise.all([chars.getApiConfig(), chars.getApiKey()])
    if (!apiKey) throw new Error('请先在 API 设置里保存 OpenAI API Key')

    const image = await ai.generatePetImage({
      apiConfig,
      apiKey,
      name,
      prompt,
      style: input.style,
    })
    const pet = await pets.createGenerated({
      name,
      description: prompt,
      image: image.bytes,
      extension: image.extension,
    })
    pets.setActive(pet.id)
    const params = await pets.resolveParams(pet.id, chars)
    mood.setParams(params)
    wm.broadcast(IPC.PET_ACTIVE_CHANGED, pet)
    return pet
  })

  ipcMain.handle(IPC.CHARACTER_GET,   (_, petId: string)        => chars.get(petId))
  ipcMain.handle(IPC.CHARACTER_SAVE,  async (_, cfg: CharacterConfig) => {
    await chars.save(cfg)
    if (cfg.petId === pets.getActiveId()) {
      const params = await pets.resolveParams(cfg.petId, chars)
      mood.setParams(params)
    }
    wm.broadcast(IPC.CHARACTER_CHANGED, cfg)
  })
  ipcMain.handle(IPC.API_CONFIG_GET,  ()                        => chars.getApiConfig())
  ipcMain.handle(IPC.API_CONFIG_SAVE, (_, cfg: ApiConfig)       => chars.saveApiConfig(cfg))

  ipcMain.handle(IPC.WINDOW_OPEN_PANEL,     () => wm.togglePanel())
  ipcMain.handle(IPC.WINDOW_CLOSE_PANEL,    () => wm.panel?.hide())
  ipcMain.handle(IPC.WINDOW_SET_POSITION,   (_, { dx, dy }: { dx: number; dy: number }) => {
    if (!wm.float) return
    const [x, y] = wm.float.getPosition()
    wm.float.setPosition(x + dx, y + dy)
  })
  ipcMain.handle(IPC.WINDOW_OPEN_SETTINGS,  () => {
    if (!wm.settings || wm.settings.isDestroyed()) wm.createSettings()
    wm.settings?.show()
  })

  ipcMain.handle(IPC.CHAT_SEND, async (_, { message, history, attachments }: { message: string; history: ChatMessage[]; attachments?: ChatAttachment[] }) => {
    mood.onInteraction('chat')
    traitLearner?.record('chat_active', 0.5)
    wm.broadcast(IPC.MOOD_CHANGED, { mood: mood.getMoodState().mood, stage: mood.getStage() })
    const petId = pets.getActiveId() ?? 'stlulu'
    const hydratedAttachments = await attachmentStore.hydrate(attachments)
    const persistedAttachments = await attachmentStore.persist(petId, hydratedAttachments)

    const slash = parseSlash(message)
    if (slash) {
      const [apiConfig, apiKey] = await Promise.all([chars.getApiConfig(), chars.getApiKey()])
      const args = slash.cmd === 'claude'
        ? ['--dangerously-skip-permissions', '--print', slash.prompt]
        : ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', slash.prompt]
      memory.appendSession(petId, [
        { id: randomUUID(), role: 'user', content: message, timestamp: Date.now() }
      ]).catch(err => console.error('[memory] append failed:', err))
      const watch = watcher.start({
        command: `${slash.cmd} ${args.join(' ')}`,
        apiConfig, apiKey: apiKey ?? '',
        onLine: line => wm.broadcast(IPC.CLI_LINE, { line }),
        onNote: (note: WatcherNote) => {
          wm.broadcast(IPC.WATCHER_NOTE, note)
          if (note.status !== 'ok') {
            wm.showBubble({ source: 'watcher', label: note.note.slice(0, 28), timestamp: note.timestamp })
          }
        }
      })
      try {
        const recentBuf: string[] = []
        const cli = runner.run(slash.cmd, args, {
          workdir: os.homedir(),
          onLine: line => {
            watch.pushLine(line)
            recentBuf.push(line)
            if (recentBuf.length > 30) recentBuf.shift()
          },
          onWaiting: async lastLine => {
            if (apiKey) {
              const auto = await ai.suggestStdinReply({
                apiConfig, apiKey, prompt: lastLine, recentLines: recentBuf
              })
              if (auto && activeCli) {
                activeCli.writeInput(auto)
                wm.broadcast(IPC.CLI_LINE, { line: `↳ 宠物自动回答: ${auto}` })
                return
              }
            }
            wm.broadcast(IPC.CLI_WAITING, { prompt: lastLine })
            wm.showBubble({ source: 'watcher', label: `CLI 在等你: ${lastLine.slice(0, 22)}`, timestamp: Date.now() })
          }
        })
        activeCli = cli
        const result = await cli.done
        activeCli = null
        watch.finish()
        wm.broadcast(IPC.CLI_DONE, { exitCode: result.exitCode, output: result.output })
      } catch (err) {
        activeCli = null
        watch.finish()
        wm.broadcast(IPC.CLI_LINE, { line: `错误: ${(err as Error).message}` })
        wm.broadcast(IPC.CLI_DONE, { exitCode: 1, output: '' })
      }
      events.append(petId, {
        type: 'cli_task', source: 'cli',
        data: { cmd: slash.cmd, args, viaSlash: true, prompt: slash.prompt }
      }).catch(err => console.error('[events] append failed:', err))
      wm.broadcast(IPC.CHAT_DONE, {})
      return
    }

    const localStatusReply = getLocalStatusReply(message, getStats())
    if (localStatusReply && (hydratedAttachments?.length ?? 0) === 0) {
      wm.broadcast(IPC.CHAT_CHUNK, { chunk: localStatusReply })
      wm.broadcast(IPC.CHAT_TURN, {})
      const round: ChatMessage[] = [
        { id: randomUUID(), role: 'user', content: message, timestamp: Date.now(), attachments: persistedAttachments },
        { id: randomUUID(), role: 'pet', content: localStatusReply, timestamp: Date.now() }
      ]
      memory.appendSession(petId, round).catch(err => console.error('[memory] append failed:', err))
      events.append(petId, {
        type: 'chat_turn', source: 'chat',
        data: {
          userMsg: message.slice(0, 500),
          petReply: localStatusReply.slice(0, 500),
          localReply: true
        }
      }).catch(err => console.error('[events] append failed:', err))
      wm.broadcast(IPC.CHAT_DONE, {})
      return
    }

    const [cfg, apiConfig, apiKey, mem] = await Promise.all([
      chars.get(petId),
      chars.getApiConfig(),
      chars.getApiKey(),
      memory.readMemory(petId)
    ])
    if (!apiKey) {
      wm.broadcast(IPC.CHAT_ERROR, { message: 'API Key 未配置，请在设置中填写。' })
      return
    }

    // Inject playbook index (Hermes-style: list all enabled playbooks; let the
    // model self-select and tag what it used / wants to save via inline markers
    // it appends to its reply).
    let allPlaybooks: { id: string; title: string; triggers: string[]; body: string }[] = []
    try {
      const list = await playbooks.list({ enabledOnly: true })
      // PlaybookMeta does not include body; fetch bodies lazily only if list is
      // small. For now, also load bodies so the model has full content without
      // a second tool call.
      allPlaybooks = await Promise.all(
        list.map(async m => {
          const full = await playbooks.get(m.id)
          return { id: m.id, title: m.title, triggers: m.triggers, body: full?.body ?? '' }
        })
      )
    } catch { /* non-critical */ }

    let promptParts = [cfg.systemPrompt]
    if (mem) promptParts.push(`[长期记忆 —— 你过去和这个用户对话中沉淀下来的事实]\n${mem}`)
    if (allPlaybooks.length > 0) {
      // Limit to top 10 by confidence, truncate body to 500 chars
      const top = allPlaybooks
        .sort((a, b) => ((b as { confidence?: number }).confidence ?? 0) - ((a as { confidence?: number }).confidence ?? 0))
        .slice(0, 10)
      const skillIndex = top
        .map(p => `### ${p.id} — ${p.title}\nTriggers: ${p.triggers.join('; ')}\n\n${p.body.slice(0, 500)}`)
        .join('\n\n---\n\n')
      const extra = allPlaybooks.length > 10 ? `\n\n... (还有 ${allPlaybooks.length - 10} 个技能未显示，可通过 list_playbooks 查看)` : ''
      promptParts.push(
        `[已学会的技能 —— 用户请求和某条相关时，按它的方法来。宁可多参考不要漏。]\n${skillIndex}${extra}`
      )
    }
    promptParts.push(
      `[行为约定]\n` +
      `- 如果你参考了上面某条技能回答，在回复末尾追加一行：<used_playbook id="pb-xxx"/>（每用一条加一行）\n` +
      `- 如果这轮对话完成了一个非平凡任务（≥5 步操作 / 克服错误 / 用户纠正你 / 用户要求记下），` +
      `在回复末尾追加：<propose_playbook>{"slug":"kebab-case","title":"...","triggers":["..."],"body":"# 怎么做\\n\\n...","confidence":0.7}</propose_playbook>\n` +
      `- 简单一次性闲聊不需要 propose。已存在类似技能不要重复 propose。`
    )
    promptParts.push(
      `[宠物动作 —— 非常重要]\n` +
      `当用户要求你做任何身体动作（跳舞、跳、挥手、鞠躬、转圈、庆祝、蹦跳等），你必须立即调用 pet_action 工具触发对应动画，同时简短回复确认（1-2句话）。不要只回复文字描述动作，一定要调用工具！\n` +
      `- 用户说"跳" → pet_action({ action: 'jump' })\n` +
      `- 用户说"跳舞" → pet_action({ action: 'dance' })\n` +
      `- 用户说"挥手" → pet_action({ action: 'wave' })\n` +
      `- 用户说"转圈" → pet_action({ action: 'spin' })\n` +
      `- 庆祝/高兴 → pet_action({ action: 'celebrate' })`
    )
    promptParts.push(
      `[记忆工具]\n` +
      `除了内置文件工具，你还有记忆工具可以主动管理记忆和技能：\n` +
      `- query_facts: 查询已记住的事实\n` +
      `- remember: 记住新事实（"帮我记住…"\n` +
      `- forget: 删除事实\n` +
      `- list_playbooks / view_playbook / create_playbook / update_playbook: 管理内部 playbook\n\n` +
      `[安装外部技能]\n` +
      `当用户让你安装外部技能（从 GitHub、skillhub、网页等），你必须：\n` +
      `1. 用 bash 或 write_file 把技能内容保存为 ~/.mote/skills/<技能名>.md\n` +
      `2. 文件格式：YAML frontmatter (name, description, triggers) + markdown 正文\n` +
      `3. triggers 字段必须有，用于自动匹配用户消息\n` +
      `4. 不要用 create_playbook，那个是内部机制，不会出现在技能列表里\n\n` +
      `使用原则：能用内置工具的直接用，不需要委托 CLI。bash 的 workdir 默认是用户 home 目录。` +
      `危险操作（rm -rf、git push -f 等）先告诉用户你要做什么，让用户确认。`
    )
    const enrichedCfg = { ...cfg, systemPrompt: promptParts.join('\n\n') }
    let replyText = ''
    const matchedSkills = skillStore.match(message)
    try {
      const agentResult = await ai.agentLoop({
        config: enrichedCfg, apiConfig, apiKey, history,
        userMessage: message, stats: getStats(),
        onChunk: chunk => wm.broadcast(IPC.CHAT_CHUNK, { chunk }),
        workdir: os.homedir(),
        petId, factStore, playbooks,
        mcpTools: mcpManager.getTools(),
        mcpExecutor: (name, input) => mcpManager.callTool(name, input),
        matchedSkills,
        attachments: hydratedAttachments,
        onUpdateCharacter: async (patch) => {
          const current = await chars.get(petId)
          if (!current) return 'Error: 找不到当前角色配置'
          // 只接受真实有值的字段。LLM 经常把 schema 中可选字段填成空串/空数组，
          // 直接展开会清掉用户原有的 personality/greeting/systemPrompt。
          const sanitized: Partial<CharacterConfig> = {}
          if (typeof patch.displayName === 'string' && patch.displayName.trim()) {
            sanitized.displayName = patch.displayName.trim()
          }
          if (Array.isArray(patch.personality) && patch.personality.length > 0) {
            const tags = patch.personality.filter((t): t is string => typeof t === 'string' && t.length > 0)
            if (tags.length > 0) sanitized.personality = tags
          }
          if (typeof patch.greeting === 'string' && patch.greeting.trim()) {
            sanitized.greeting = patch.greeting
          }
          if (typeof patch.systemPrompt === 'string' && patch.systemPrompt.trim()) {
            sanitized.systemPrompt = patch.systemPrompt
          }
          if (Object.keys(sanitized).length === 0) return 'Error: 没有要更新的字段（不要传空值，没改的字段直接省略）'
          const updated = { ...current, ...sanitized }
          await chars.save(updated)
          wm.broadcast(IPC.CHARACTER_CHANGED, updated)
          return `OK: 角色配置已更新${sanitized.displayName ? `，显示名 → ${sanitized.displayName}` : ''}${sanitized.personality ? `，性格 → ${sanitized.personality.join('、')}` : ''}${sanitized.greeting ? `，问候语已更新` : ''}${sanitized.systemPrompt ? `，system prompt 已更新` : ''}`
        },
        onAgentTaskTool: async (tool, input) => {
          if (tool === 'create_agent_task') {
            const title = typeof input.title === 'string' ? input.title : ''
            const goal = typeof input.goal === 'string' ? input.goal : ''
            const schedule = input.schedule === 'manual' ? 'manual' : 'interval'
            const intervalMinutes = typeof input.intervalMinutes === 'number' ? input.intervalMinutes : undefined
            const task = await agentTasks.create({
              title, goal, schedule, intervalMinutes,
              enabled: false,
              approved: false,
              requireApproval: true,
              source: 'ai',
            })
            return `OK: 已创建待审批后台任务「${task.title}」。请到 设置 → Agent 审批后再运行。`
          }
          if (tool === 'list_agent_tasks') {
            const tasks = await agentTasks.list()
            return tasks.length === 0
              ? '暂无后台任务。'
              : tasks.map(t => `- ${t.id} ${t.approved ? '已审批' : '待审批'} ${t.enabled ? '启用' : '停用'} ${t.title}`).join('\n')
          }
          return `Error: 未知 agent task tool "${tool}"`
        },
      })
      replyText = agentResult.text
      wm.broadcast(IPC.CHAT_TURN, {})
      // Chat interaction XP — makes evolution happen naturally
      const evolved = mood.addXp(3, 'chat')
      if (evolved) {
        const pid = pets.getActiveId() ?? 'stlulu'
        pets.load(pid, evolved).then(p => { if (p) wm.broadcast(IPC.PET_ACTIVE_CHANGED, p) })
      }
      // Broadcast pet actions (dance, celebrate, etc.) to float
      // Auto-generate missing animations as fire-and-forget (non-blocking)
      // Extract count from user's original message
      const userCountMatch = message.match(/(\d+)\s*[次下遍回]/)
      const userCount = userCountMatch ? Math.min(parseInt(userCountMatch[1]), 50) : 1

      const handlePetAction = (action: string, count: number) => {
        wm.broadcast(IPC.PET_ACTION, { action, count })
      }

      for (const action of agentResult.petActions) {
        handlePetAction(action, userCount)
      }
      // Fallback: detect action keywords in AI text when pet_action tool wasn't called
      if (agentResult.petActions.length === 0) {
        const fallback = detectPetAction(replyText)
        if (fallback) handlePetAction(fallback.action, fallback.count)
      }
      // Award XP for tool usage (learning milestone)
      const toolCount = agentResult.toolExecutions.length
      if (toolCount > 0) {
        const hasInstallSkill = agentResult.toolExecutions.some(t => t.tool === 'install_skill')
        mood.addXp(toolCount * 5, 'tool_used')
        if (hasInstallSkill) mood.addXp(12, 'skill_installed')
        traitLearner?.record('tool_heavy', Math.min(1, toolCount / 5))
      }
      // Persist this round to sessions.jsonl immediately so memory survives a hard quit.
      const round: ChatMessage[] = [
        { id: randomUUID(), role: 'user', content: message, timestamp: Date.now(), attachments: persistedAttachments },
        { id: randomUUID(), role: 'pet', content: replyText, timestamp: Date.now() }
      ]
      memory.appendSession(petId, round).catch(err => console.error('[memory] append failed:', err))
      // Fire-and-forget summarize updates MEMORY.md + facts in the background.
      memory.summarizeAndAppend(petId, {
        summarizeForMemory: o => ai.summarizeForMemory({ apiConfig, apiKey, ...o })
      }, [...history, ...round]).catch(err => console.error('[memory] summarize failed:', err))
      events.append(petId, {
        type: 'chat_turn', source: 'chat',
        data: {
          userMsg: message.slice(0, 500),
          petReply: replyText.slice(0, 500),
          rounds: agentResult.rounds,
          builtInToolCalls: agentResult.toolExecutions.length,
          toolSummary: agentResult.toolExecutions.map(t => `${t.tool}(${Object.values(t.input)[0]?.slice(0, 30) ?? ''}) → ${t.exitCode}`)
        }
      }).catch(err => console.error('[events] append failed:', err))
      // Handle CLI tool calls (run_claude_code / run_codex) via watcher/runner.
      const cliCalls = agentResult.cliCalls
      if (cliCalls.length > 0) {
        const cliCall = cliCalls[0]
        const cmd  = cliCall.tool === 'run_claude_code' ? 'claude' : 'codex'
        const cliPrompt = (cliCall.input.prompt as string) ?? ''
        const cliWorkdir = (cliCall.input.workdir as string) ?? os.homedir()
        const args = cmd === 'claude'
          ? ['--dangerously-skip-permissions', '--print', cliPrompt]
          : ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', cliPrompt]
        const watch = watcher.start({
          command: `${cmd} ${args.join(' ')}`,
          apiConfig, apiKey,
          onLine: line => wm.broadcast(IPC.CLI_LINE, { line }),
          onNote: (note: WatcherNote) => {
            wm.broadcast(IPC.WATCHER_NOTE, note)
            if (note.status !== 'ok') {
              wm.showBubble({ source: 'watcher', label: note.note.slice(0, 28), timestamp: note.timestamp })
            }
          }
        })
        try {
          const recentBuf: string[] = []
          const cli = runner.run(cmd, args, {
            workdir: cliWorkdir,
            onLine: line => {
              watch.pushLine(line)
              recentBuf.push(line)
              if (recentBuf.length > 30) recentBuf.shift()
            },
            onWaiting: async lastLine => {
              // Ask AI first: safe to auto-answer? If yes, write it directly.
              const auto = await ai.suggestStdinReply({
                apiConfig, apiKey, prompt: lastLine, recentLines: recentBuf
              })
              if (auto && activeCli) {
                activeCli.writeInput(auto)
                wm.broadcast(IPC.CLI_LINE, { line: `↳ 宠物自动回答: ${auto}` })
                return
              }
              wm.broadcast(IPC.CLI_WAITING, { prompt: lastLine })
              wm.showBubble({ source: 'watcher', label: `CLI 在等你: ${lastLine.slice(0, 22)}`, timestamp: Date.now() })
            }
          })
          activeCli = cli
          const result = await cli.done
          activeCli = null
          watch.finish()
          wm.broadcast(IPC.CLI_DONE, { exitCode: result.exitCode, output: result.output })
          events.append(petId, {
            type: 'cli_task', source: 'cli',
            data: {
              cmd, args, viaSlash: false,
              prompt: cliPrompt,
              exitCode: result.exitCode,
              outputTail: result.output.slice(-500)
            }
          }).catch(err => console.error('[events] append failed:', err))
          await ai.chat({
            config: enrichedCfg, apiConfig, apiKey, history: [],
            userMessage: `任务完成，退出码 ${result.exitCode}，输出：\n${result.output.slice(0, 2000)}\n\n请用你的角色简短总结结果。`,
            stats: getStats(),
            onChunk: chunk => wm.broadcast(IPC.CHAT_CHUNK, { chunk })
          })
          wm.broadcast(IPC.CHAT_TURN, {})
        } catch (err) {
          activeCli = null
          watch.finish()
          wm.broadcast(IPC.CLI_LINE, { line: `错误: ${(err as Error).message}` })
          wm.broadcast(IPC.CLI_DONE, { exitCode: 1, output: '' })
        }
      }
    } catch (err) {
      console.error('[ipc] CHAT_SEND error:', err)
      const e = err as Error & { cause?: unknown; status?: number; code?: string }
      const parts: string[] = []
      if (e.status) parts.push(`HTTP ${e.status}`)
      if (e.code) parts.push(e.code)
      parts.push(e.message || String(err))
      if (e.cause) {
        const cause = e.cause as Error & { code?: string }
        const causeMsg = cause.code ? `${cause.code}: ${cause.message}` : cause.message
        if (causeMsg) parts.push(`(${causeMsg})`)
      }
      wm.broadcast(IPC.CHAT_ERROR, { message: parts.join(' ') })
    }
    // Parse inline markers from AI reply (Hermes-style: AI tags what it used
    // and what it wants to save in its own reply, no extra API call).
    const usedIds = Array.from(
      (replyText ?? '').matchAll(/<used_playbook\s+id="([^"]+)"\s*\/>/g),
      m => m[1]
    )
    for (const id of usedIds) {
      playbooks.updateStats(id).catch(() => {})
      mood.addXp(5, 'playbook_used')
      events.append(petId, {
        type: 'playbook_used', source: 'chat',
        data: { playbookId: id }
      }).catch(() => {})
    }

    const proposeMatch = (replyText ?? '').match(/<propose_playbook>([\s\S]*?)<\/propose_playbook>/)
    if (proposeMatch) {
      try {
        const o = JSON.parse(proposeMatch[1]) as {
          slug?: string; title?: string; triggers?: unknown; body?: string; confidence?: number
        }
        if (
          typeof o.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(o.slug)
          && typeof o.title === 'string' && o.title.trim()
          && Array.isArray(o.triggers) && o.triggers.length > 0
          && typeof o.body === 'string' && o.body.trim()
        ) {
          const conf = Math.max(0, Math.min(1, Number(o.confidence ?? 0.7)))
          await playbooks.create(
            { id: `pb-${o.slug}`, title: o.title.trim(), triggers: o.triggers as string[],
              created: new Date().toISOString().slice(0, 10), confidence: conf },
            o.body
          ).catch(() => {})
          mood.addXp(15, 'playbook_created')
          events.append(petId, {
            type: 'playbook_created', source: 'chat',
            data: { slug: o.slug, title: o.title }
          }).catch(() => {})
        }
      } catch { /* malformed inline propose, ignore */ }
    }
    wm.broadcast(IPC.CHAT_DONE, {})
  })

  ipcMain.handle(IPC.CLI_INPUT, (_, { text }: { text: string }) => {
    if (!activeCli) return
    activeCli.writeInput(text)
  })

  ipcMain.handle(IPC.CLI_ABORT, () => {
    if (!activeCli) return
    activeCli.abort()
  })

  ipcMain.handle(IPC.MEMORY_FLUSH, async (_, history: ChatMessage[]) => {
    const petId = pets.getActiveId() ?? 'stlulu'
    if (history.length < 2) return
    const persistedHistory = await attachmentStore.persistMessages(petId, history)
    // Append raw session synchronously; summarize in background so UI doesn't wait.
    await memory.appendSession(petId, persistedHistory)
    const apiConfig = await chars.getApiConfig()
    const apiKey = await chars.getApiKey()
    if (!apiKey) return
    memory.summarizeAndAppend(petId, {
      summarizeForMemory: opts => ai.summarizeForMemory({ apiConfig, apiKey, ...opts })
    }, persistedHistory).catch(err => console.error('[memory] summarize failed:', err))
  })

  ipcMain.handle(IPC.CLEANUP_SCAN,    ()                       => cleanup.scan())
  ipcMain.handle(IPC.CLEANUP_EXECUTE, (_, paths: string[])     => cleanup.execute(paths))

  // Extra handlers needed by settings UI
  ipcMain.handle('dialog:open-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return canceled ? null : filePaths[0]
  })
  ipcMain.handle('dialog:confirm', async (_, message: string) => {
    const { response } = await dialog.showMessageBox({
      type: 'question', message, buttons: ['取消', '确定'], defaultId: 1, cancelId: 0,
    })
    return response === 1
  })
  ipcMain.handle('character:get-api-key',  () => chars.getApiKey())
  ipcMain.handle('character:save-api-key', (_, { key }: { key: string }) => chars.saveApiKey(key))

  // ─── Conversation history ───
  ipcMain.handle('memory:read-history', (_, petId: string) => {
    return memory.readSessionHistory(petId).then(msgs => attachmentStore.hydrateMessages(msgs))
  })

  ipcMain.handle('memory:list-rounds', (_, petId: string) => {
    return memory.listSessionRounds(petId)
  })

  ipcMain.handle('memory:read-round', (_, { petId, indexFromEnd }: { petId: string; indexFromEnd: number }) => {
    return memory.readSessionRound(petId, indexFromEnd).then(msgs => attachmentStore.hydrateMessages(msgs))
  })

  ipcMain.handle('memory:delete-round', async (_, { petId, indexFromEnd }: { petId: string; indexFromEnd: number }) => {
    await memory.deleteSessionRound(petId, indexFromEnd)
  })

  ipcMain.handle('memory:clear-rounds', async (_, petId: string) => {
    await memory.clearSessionHistory(petId)
  })

  ipcMain.handle(IPC.CHAT_NEW, () => {
    wm.broadcast(IPC.CHAT_NEW, {})
  })

  // ─── Memory / Playbook CRUD for settings UI + panel feedback ───
  ipcMain.handle('memory:list-facts', (_, petId: string) => {
    return factStore.list(petId, { includeSuperseded: true })
  })

  ipcMain.handle('memory:delete-fact', async (_, { petId, factId }: { petId: string; factId: string }) => {
    await factStore.delete(petId, factId)
  })

  ipcMain.handle('memory:list-playbooks', () => playbooks.list({ enabledOnly: false }))

  ipcMain.handle('memory:toggle-playbook', async (_, { id, enabled }: { id: string; enabled: boolean }) => {
    if (enabled) {
      await playbooks.updateConfidence(id, 0.7)
    } else {
      await playbooks.disable(id)
    }
  })

  ipcMain.handle('memory:playbook-feedback', async (_, { id, positive }: { id: string; positive: boolean }) => {
    mood.onInteraction(positive ? 'feedback_pos' : 'feedback_neg')
    traitLearner?.record(positive ? 'feedback_pos' : 'feedback_neg', 0.8)
    const pb = await playbooks.get(id)
    if (!pb) return
    const delta = positive ? 0.1 : -0.2
    const newConf = Math.max(0, Math.min(1, pb.confidence + delta))
    await playbooks.updateConfidence(id, newConf)
    if (!positive && newConf < 0.2) await playbooks.disable(id)
  })

  ipcMain.handle('memory:playbook-feedback-last', async (_, { positive }: { positive: boolean }) => {
    mood.onInteraction(positive ? 'feedback_pos' : 'feedback_neg')
    const petId = pets.getActiveId() ?? 'stlulu'
    const usedEvents = await events.byType(petId, 'playbook_used', 1)
    if (usedEvents.length === 0) return
    const playbookId = usedEvents[0].data.playbookId as string
    if (!playbookId) return
    const pb = await playbooks.get(playbookId)
    if (!pb) return
    const delta = positive ? 0.1 : -0.2
    const newConf = Math.max(0, Math.min(1, pb.confidence + delta))
    await playbooks.updateConfidence(playbookId, newConf)
    if (!positive && newConf < 0.2) await playbooks.disable(playbookId)
    await events.append(petId, {
      type: 'user_feedback', source: 'user',
      data: { playbookId, positive, newConfidence: newConf }
    }).catch(() => {})
  })

  // ─── Mood diary (today's events + mood snapshot) ───
  ipcMain.handle('mood:diary-today', async () => {
    const petId = pets.getActiveId() ?? 'stlulu'
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const todayEvents = await events.range(petId, startOfDay, Date.now())
    return {
      mood: mood.getMoodState(),
      events: todayEvents,
    }
  })

  // ─── Mood growth history (14-day chart) ───
  ipcMain.handle('mood:growth-curve', () => mood.getGrowthHistory(14))

  // ─── Trait learning log ───
  ipcMain.handle('traits:learning-log', () => traitLearner?.getLog(7) ?? [])

  // ─── Behavioral insights ───
  ipcMain.handle('insights:list', async () => {
    const { detectInsights } = await import('./insights')
    const petId = pets.getActiveId() ?? 'stlulu'
    return detectInsights(events, petId)
  })
  ipcMain.handle('insights:recent-chat-turns', async () => {
    const petId = pets.getActiveId() ?? 'stlulu'
    return events.byType(petId, 'chat_turn', 20)
  })

  // ─── Context awareness (what the pet "sees") ───
  ipcMain.handle('context:stats', () => getStats())
  ipcMain.handle('context:mood', () => {
    const s = mood.getMoodState()
    return { ...s, streak: mood.getStreak() }
  })
  ipcMain.handle('context:hooks', (): { tool: string; installed: boolean; configured: boolean }[] => {
    const claudeStatus = getClaudeStatus(path.join(os.homedir(), '.claude', 'settings.json'), runtimeState.wrapperPath)
    const codexStatus = getCodexStatus(path.join(os.homedir(), '.codex', 'config.toml'), runtimeState.wrapperPath)
    return [
      { tool: 'Claude Code', installed: claudeStatus.installed, configured: claudeStatus.configured },
      { tool: 'Codex', installed: codexStatus.installed, configured: codexStatus.configured },
    ]
  })

  // ─── Pomodoro timer ───
  if (pomodoro) {
    ipcMain.handle('pomodoro:start', () => { pomodoro.start(); wm.notificationsMuted = true })
    ipcMain.handle('pomodoro:stop',  () => { pomodoro.stop();  wm.notificationsMuted = false })
    ipcMain.handle('pomodoro:skip',  () => { pomodoro.skip() })
    ipcMain.handle('pomodoro:state', () => pomodoro.getState())
    // Auto-unmute on phase change to break/idle
    pomodoro.subscribe(s => { wm.notificationsMuted = s.phase === 'focus' })
  }

  // ─── Notify hooks ───
  const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
  const codexConfig    = path.join(os.homedir(), '.codex',  'config.toml')
  const wrapper        = runtimeState.wrapperPath

  ipcMain.handle(IPC.NOTIFY_HOOK_GET_STATUS, (): HookInstallStatus[] => {
    return [
      getClaudeStatus(claudeSettings, wrapper),
      getCodexStatus(codexConfig, wrapper)
    ]
  })

  ipcMain.handle(IPC.NOTIFY_HOOK_INSTALL, async (_, tool: 'claude' | 'codex' | 'both') => {
    if (tool === 'claude' || tool === 'both') installClaudeHooks(claudeSettings, wrapper)
    if (tool === 'codex'  || tool === 'both') {
      installCodexHooks(codexConfig, wrapper, { degraded: false })
    }
  })

  ipcMain.handle(IPC.NOTIFY_HOOK_UNINSTALL, async (_, tool: 'claude' | 'codex' | 'both') => {
    if (tool === 'claude' || tool === 'both') uninstallClaudeHooks(claudeSettings, wrapper)
    if (tool === 'codex'  || tool === 'both') uninstallCodexHooks(codexConfig, wrapper)
  })

  ipcMain.handle(IPC.NOTIFY_TEST_EVENT, async () => {
    eventDirWatcher.writeEvent({
      event: 'Stop', tool: 'test', cwd: process.cwd(), ts: Math.floor(Date.now() / 1000)
    })
  })

  ipcMain.handle(IPC.NOTIFY_RECENT_EVENTS, (): NotifyEvent[] => eventRouter.recent())

  ipcMain.handle(IPC.NOTIFY_RUNTIME_INFO, () => {
    return { wrapperPath: wrapper, eventsDir: runtimeState.eventsDir }
  })

  // ─── MCP + Skills ───
  ipcMain.handle('mcp:status', () => mcpManager.getStatus())
  ipcMain.handle('mcp:reload', async () => {
    await mcpManager.shutdown()
    await mcpManager.init()
  })

  // ─── Notification unread state ───
  ipcMain.handle(IPC.NOTIFICATION_CLEAR, () => {
    wm.clearUnread()
    driveEngine?.onBubbleCleared()
    traitLearner?.record('greet_engaged', 0.5)
  })

  ipcMain.handle(IPC.AGENT_TASKS_LIST, () => agentTasks.list())
  ipcMain.handle(IPC.AGENT_TASKS_CREATE, (_, input: AgentTaskCreateInput) => {
    return agentTasks.create({ ...input, source: 'user', approved: true, requireApproval: input.requireApproval ?? true })
  })
  ipcMain.handle(IPC.AGENT_TASKS_UPDATE, (_, { id, patch }: { id: string; patch: AgentTaskUpdateInput }) => {
    return agentTasks.update(id, patch)
  })
  ipcMain.handle(IPC.AGENT_TASKS_DELETE, (_, id: string) => agentTasks.delete(id))
  ipcMain.handle(IPC.AGENT_TASKS_APPROVE, (_, id: string) => agentTasks.approve(id))
  ipcMain.handle(IPC.AGENT_TASKS_RUN, (_, id: string) => agentScheduler.run(id))
  ipcMain.handle(IPC.AGENT_TASK_RUNS, (_, taskId?: string) => agentTasks.runs(taskId))

  ipcMain.handle('mcp:read-config', async () => {
    try {
      return await fs.readFile(mcpManager.configPath, 'utf-8')
    } catch {
      return JSON.stringify({ mcpServers: {} }, null, 2)
    }
  })
  ipcMain.handle('mcp:save-config', async (_, content: string) => {
    // Validate JSON before saving
    JSON.parse(content)
    await fs.writeFile(mcpManager.configPath, content, 'utf-8')
    // Reload MCP connections
    await mcpManager.shutdown()
    await mcpManager.init()
  })
  ipcMain.handle('skills:list', () => skillStore.list())
  ipcMain.handle('skills:reload', async () => {
    await skillStore.reload()
  })
}
