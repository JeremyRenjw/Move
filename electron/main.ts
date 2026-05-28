import { app, dialog, ipcMain } from 'electron'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { WindowManager }        from './windows'
import { SystemMonitor }        from './monitor'
import { PetManager }           from './pets'
import { CharacterConfigStore } from './character'
import { AiEngine }             from './ai'
import { CliRunner }            from './runner'
import { CleanupEngine, defaultCacheDirs } from './cleanup'
import { EventStore }           from './event-store'
import { FactStore }            from './fact-store'
import { PlaybookStore }        from './playbook-store'
import { MemoryStore }          from './memory'
import { CliWatcher }           from './watcher'
import { registerIpcHandlers }  from './ipc'
import { NotificationWatcher }  from './notifications'
import { RuntimeState }      from './runtime-state'
import { EventDirWatcher }   from './event-dir-watcher'
import { EventRouter }       from './event-router'
import { SessionRegistry }   from './session-registry'
import { PetAggregator }     from './pet-aggregator'
import { Reflector }         from './reflector'
import { Curator }           from './curator'
import { McpManager }        from './mcp-manager'
import { SkillStore }        from './skill-store'
import { AttachmentStore }   from './attachments'
import { TrayManager }       from './tray'
import { AgentTaskStore }    from './agent-tasks'
import { AgentScheduler }    from './agent-scheduler'
import { MoodEngine }        from './mood-engine'
import { DriveEngine }       from './drive-engine'
import { Agenda }            from './agenda'
import { TraitLearner }      from './trait-learner'
import { IPC }                  from '@shared/types'
import type { SystemStats }     from '@shared/types'
import {
  DEFAULT_NOTIFY_SOURCES,
  getNotificationKeyByLabel,
  getNotificationLabelByKey,
} from '@shared/notification-sources'

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// Respect system HTTP proxy (Node.js undici fetch doesn't read http_proxy by default)
;(async () => {
  const proxyUrl = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY
  if (proxyUrl) {
    try {
      const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici')
      setGlobalDispatcher(new EnvHttpProxyAgent())
      console.log(`[main] proxy configured: ${proxyUrl}`)
    } catch (err) {
      console.warn('[main] failed to configure proxy:', (err as Error).message)
    }
  }
})()

// Suppress EPIPE from systeminformation's internal execSync on macOS/Electron
process.on('uncaughtException', err => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', err => {
  if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return
  console.error('[main] unhandledRejection:', err)
})

// Prevent garbage collection
let wm: WindowManager
let eventDirWatcherRef: EventDirWatcher | null = null
let mcpManagerRef: McpManager | null = null
let trayManagerRef: TrayManager | null = null
let agentSchedulerRef: AgentScheduler | null = null
let reflectorRef: Reflector | null = null
let driveEngineRef: DriveEngine | null = null
let agendaRef: Agenda | null = null

app.setName('Mote')

app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'assets/icon.png')
        : path.join(__dirname, '../../assets/icon.png')
      const { nativeImage } = await import('electron')
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) app.dock?.setIcon(icon)
      app.dock?.hide()
    }
    const userData  = app.getPath('userData')
    const assetsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'assets')
      : path.join(__dirname, '../../assets')

    const settingsFile = path.join(userData, 'settings.json')
    function loadSettings(): Record<string, unknown> {
      try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) } catch { return {} }
    }
    function saveSettings(data: Record<string, unknown>): void {
      fs.mkdirSync(userData, { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2))
    }

    wm = new WindowManager({
      getSourceKey: label => getNotificationKeyByLabel(label) ?? '',
      isSourceEnabled: () => {
        const s = loadSettings() as { notifySources?: Record<string, boolean> }
        return s.notifySources ?? DEFAULT_NOTIFY_SOURCES
      },
    })
    const monitor = new SystemMonitor()
    const pets    = new PetManager(userData, assetsDir)
    const chars   = new CharacterConfigStore(userData)
    const ai      = new AiEngine()
    const runner  = new CliRunner()
    const cleanup = new CleanupEngine(defaultCacheDirs())
    const events  = new EventStore(path.join(userData, 'memory'))
    const facts      = new FactStore(path.join(userData, 'memory'))
    const playbooks  = new PlaybookStore(path.join(userData, 'memory'))
    const memory     = new MemoryStore(userData, facts)
    const watcher = new CliWatcher(ai)
    const attachments = new AttachmentStore(userData)
    const agentTasks = new AgentTaskStore(userData)
    const mood       = new MoodEngine(path.join(userData, 'memory'))

    const mcpManager = new McpManager(userData)
    mcpManagerRef = mcpManager
    const builtinSkillsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'skills')
      : path.join(__dirname, '../electron/skills')
    const userSkillsDir = path.join(os.homedir(), '.mote', 'skills')
    const skillStore = new SkillStore(builtinSkillsDir, userSkillsDir)

    await pets.ensureBuiltins()
    await skillStore.init()
    mcpManager.init().catch(err => console.error('[main] MCP init failed:', err))
    pets.setActive('stlulu')
    const initialParams = await pets.resolveParams('stlulu', chars)
    mood.setParams(initialParams)

    // Wire up mood broadcast (→ float UI)
    mood.setMoodBroadcastCallback((m, s) => {
      wm.broadcast(IPC.MOOD_CHANGED, { mood: m, stage: s })
    })

    // Wire up evolution callback
    mood.setEvolveCallback(async (newStage, oldStage) => {
      const petId = pets.getActiveId() ?? 'stlulu'
      const { STAGE_CONFIG } = await import('./mood-engine')
      const cfg = STAGE_CONFIG[newStage]

      // Update character personality and greeting
      const charCfg = await chars.get(petId)
      if (charCfg) {
        // Merge stage personality traits (avoid duplicates)
        const existing = new Set(charCfg.personality)
        const merged = [...charCfg.personality]
        for (const trait of cfg.personality) {
          if (!existing.has(trait)) merged.push(trait)
        }
        await chars.save({ ...charCfg, personality: merged, greeting: cfg.greeting })
        wm.broadcast(IPC.CHARACTER_CHANGED, { ...charCfg, personality: merged, greeting: cfg.greeting })
      }

      // Broadcast evolution event
      wm.broadcast(IPC.PET_EVOLVED, { stage: newStage, xp: mood.getMoodState().xp })

      // Reload pet with new spritesheet and broadcast
      const pet = await pets.load(petId, newStage)
      if (pet) wm.broadcast(IPC.PET_ACTIVE_CHANGED, pet)

      // Announce evolution
      wm.showBubble({
        source: 'watcher',
        label: `🎉 宠物进化了！${STAGE_CONFIG[oldStage].label} → ${cfg.label}`,
        timestamp: Date.now(),
      })

      events.append(petId, {
        type: 'system_snapshot',
        source: 'system',
        data: { evolution: { from: oldStage, to: newStage, xp: mood.getMoodState().xp } }
      }).catch(() => {})
    })

    let latestStats: SystemStats = {
      cpu: 0, ramUsed: 0, ramTotal: 1, diskUsed: 0,
      claudeRunning: false, codexRunning: false
    }

    // Persona getter shared by Reflector and DriveEngine.
    const getPersona = async (): Promise<string> => {
      const petId = pets.getActiveId() ?? 'stlulu'
      const cfg = await chars.get(petId)
      return cfg?.systemPrompt ?? ''
    }

    // ─── Trait Learner (daily feedback-driven trait adjustment) ───
    const traitLearner = new TraitLearner({ chars, pets, mood }, path.join(userData, 'memory'))

    // ─── Reflector (periodic + event-driven) ───
    // Reflector ticks every 20 minutes with mood awareness, plus on hook errors.
    const reflector = new Reflector({
      ai, events, facts, wm, mood, traitLearner,
      getStats: () => latestStats,
      getActivePetId: () => pets.getActiveId(),
      getPersona,
    })
    reflector.start()
    reflectorRef = reflector

    // ─── Curator (weekly playbook/fact consolidation) ───
    const curator = new Curator({
      ai, events,
      factStore: facts, playbooks, mood,
      getActivePetId: () => pets.getActiveId(),
      getApiConfig: () => chars.getApiConfig(),
      getApiKey:    () => chars.getApiKey(),
      stateDir: path.join(userData, 'memory')
    })
    curator.start()

    const runtimeState = new RuntimeState()
    const sessionRegistry = new SessionRegistry()
    const petAggregator   = new PetAggregator(sessionRegistry, wm)
    const eventRouter     = new EventRouter({
      showBubble: (label, source) => wm.showBubble({ source: 'watcher', label, timestamp: Date.now() }),
      onEvent: ev => {
        const petId = pets.getActiveId() ?? 'stlulu'
        events.append(petId, {
          type: 'hook_signal', source: 'hook', data: ev
        }).catch(err => console.error('[events] hook signal failed:', err))
        // Passive wake: trigger reflect on hook errors
        if (ev.event === 'Error') {
          reflector.tick().catch(err => console.error('[reflector] passive tick failed:', err))
        }
      },
      registry:   sessionRegistry,
      aggregator: petAggregator,
    })
    const eventDirWatcher = new EventDirWatcher(runtimeState.eventsDir, ev => eventRouter.handle(ev))
    const agentScheduler = new AgentScheduler({
      store: agentTasks,
      ai, chars, events, wm, mood,
      factStore: facts,
      playbooks,
      getStats: () => latestStats,
      getActivePetId: () => pets.getActiveId(),
    })
    agentScheduler.start()
    agentSchedulerRef = agentScheduler

    const agendaOff = process.env['PET_AGENDA_OFF'] === '1'
    const agenda = agendaOff ? undefined : new Agenda({
      ai, events, facts, mood, chars,
      getStats:       () => latestStats,
      getPersona,
      getActivePetId: () => pets.getActiveId(),
      getParams:      () => pets.getActiveParams(),
      dataDir:        path.join(userData, 'memory'),
    })
    if (agenda) {
      await agenda.loadFromDisk().catch(err => console.error('[main] agenda load failed:', err))
      events.addListener((_petId, ev) => {
        const kind = ev.source === 'chat' ? 'chat'
          : ev.source === 'hook' ? 'hook'
          : ev.source === 'cli' ? 'task'
          : null
        if (kind) agenda.onEvent(kind)
      })
      agenda.start()
      agendaRef = agenda
      console.log('[main] agenda started')
    } else {
      console.log('[main] agenda disabled via PET_AGENDA_OFF=1')
    }

    const driveEngine = new DriveEngine({
      mood, wm, agentScheduler, events,
      getStats: () => latestStats,
      getActivePetId: () => pets.getActiveId(),
      getParams: () => pets.getActiveParams(),
      ai, chars, factStore: facts, getPersona,
      agenda,
    })
    driveEngine.start()
    driveEngineRef = driveEngine

    monitor.start(stats => {
      latestStats = stats
      wm.broadcast(IPC.MONITOR_STATS, stats)
    })

    const SNAPSHOT_MS = 30 * 60_000
    setInterval(() => {
      const petId = pets.getActiveId() ?? 'stlulu'
      events.append(petId, {
        type: 'system_snapshot', source: 'system', data: latestStats
      }).catch(err => console.error('[events] snapshot failed:', err))
    }, SNAPSHOT_MS).unref()

    ipcMain.handle(IPC.NOTIFY_SOURCES_GET, () => {
      const s = loadSettings() as { notifySources?: Record<string, boolean> }
      return s.notifySources ?? DEFAULT_NOTIFY_SOURCES
    })
    ipcMain.handle(IPC.NOTIFY_SOURCES_SAVE, (_: unknown, { sources }: { sources: Record<string, boolean> }) => {
      saveSettings({ ...loadSettings(), notifySources: sources })
    })

    ipcMain.handle(IPC.AUTOSTART_GET, () => {
      return app.getLoginItemSettings().openAtLogin
    })
    ipcMain.handle(IPC.AUTOSTART_SET, (_: unknown, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: enabled })
    })

    const { Pomodoro } = await import('./pomodoro')
    const pomodoro = new Pomodoro()

    registerIpcHandlers({
      wm, pets, chars, ai, runner, cleanup, monitor, memory, watcher, attachments,
      getStats: () => latestStats,
      eventRouter, eventDirWatcher, runtimeState,
      events, factStore: facts, playbooks,
      mcpManager, skillStore,
      agentTasks, agentScheduler, driveEngine,
      mood, pomodoro, traitLearner,
    })

    // Start file-system event watcher + ensure wrapper script for hooks.
    try {
      runtimeState.ensureWrapper()
      eventDirWatcher.start()
      console.log(`[main] event dir watcher started on ${runtimeState.eventsDir}`)
    } catch (err) {
      console.error('[main] event dir watcher failed to start:', err)
    }

    eventDirWatcherRef = eventDirWatcher

    wm.createFloat()
    wm.createPanel()
    if (process.platform === 'darwin') {
      const tray = new TrayManager(wm, assetsDir)
      tray.create()
      trayManagerRef = tray
      wm.float?.on('show', () => tray.refresh())
      wm.float?.on('hide', () => tray.refresh())
      wm.float?.on('closed', () => tray.refresh())
    }

    // First-launch hook install nudge: if neither tool is hooked, prompt once.
    try {
      const { getClaudeStatus, getCodexStatus } = await import('./hook-installer')
      const claudePath = path.join(app.getPath('home'), '.claude', 'settings.json')
      const codexPath  = path.join(app.getPath('home'), '.codex',  'config.toml')
      const cs = getClaudeStatus(claudePath, runtimeState.wrapperPath)
      const xs = getCodexStatus(codexPath, runtimeState.wrapperPath)
      if (!cs.installed && !xs.installed) {
        setTimeout(() => {
          wm.showBubble({
            source: 'watcher',
            label: '点设置 → 提醒，让我帮你盯 claude/codex',
            timestamp: Date.now()
          })
        }, 3000)
      }
    } catch (err) {
      console.error('[main] first-launch check failed:', err)
    }

    if (process.platform === 'darwin') {
      const notif = new NotificationWatcher(
        ev => wm.showBubble(ev),
        source => wm.clearSource(getNotificationLabelByKey(source) ?? source)
      )
      notif.start().catch(err => console.error('[main] notification watcher start failed:', err))
    }

    const saved = loadSettings()
    if (typeof saved.floatX === 'number' && typeof saved.floatY === 'number') {
      wm.float?.setPosition(saved.floatX, saved.floatY)
    }

    wm.float?.on('moved', () => {
      if (!wm.float || wm.float.isDestroyed()) return
      const [x, y] = wm.float.getPosition()
      saveSettings({ ...loadSettings(), floatX: x, floatY: y })
      // Keep panel next to pet while dragging
      if (wm.panel && !wm.panel.isDestroyed() && wm.panel.isVisible()) {
        wm.repositionPanel()
      }
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })

    app.on('activate', () => {
      if (!wm.float || wm.float.isDestroyed()) {
        wm.createFloat()
      }
    })
  } catch (err) {
    console.error('[main] startup error:', err)
    dialog.showErrorBox('启动错误', String(err))
  }
})

app.on('before-quit', () => {
  trayManagerRef?.destroy()
  agentSchedulerRef?.stop()
  driveEngineRef?.stop()
  agendaRef?.stop()
  reflectorRef?.stop()
  eventDirWatcherRef?.stop()
  mcpManagerRef?.shutdown().catch(() => {})
})
