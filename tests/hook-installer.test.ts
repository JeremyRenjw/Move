import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { installClaudeHooks, uninstallClaudeHooks, getClaudeStatus } from '../electron/hook-installer'

const WRAPPER = '$HOME/.mote/bin/event'

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-hi-')) }

describe('hook-installer · Claude', () => {
  let dir: string
  let settings: string

  beforeEach(() => { dir = tmpDir(); settings = path.join(dir, 'settings.json') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('installs into empty (non-existent) settings.json with 6 events', () => {
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const eventNames = Object.keys(json.hooks).sort()
    expect(eventNames).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort())
    for (const name of eventNames) {
      const cmd = json.hooks[name][0].hooks[0].command
      expect(cmd).toContain(WRAPPER)
      expect(cmd).toContain(name)
    }
  })

  it('creates a backup of existing settings.json before merging', () => {
    fs.writeFileSync(settings, JSON.stringify({ apiKey: 'foo', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }))
    installClaudeHooks(settings, WRAPPER)
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('settings.json.mote-backup-'))
    expect(backups.length).toBe(1)
    const backupJson = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'))
    expect(backupJson.apiKey).toBe('foo')
  })

  it('preserves existing non-mote hook entries when merging', () => {
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-thing' }] }] }
    }))
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(stopCmds).toContain('echo user-thing')
    expect(stopCmds.some((c: string) => c.includes(WRAPPER))).toBe(true)
  })

  it('is idempotent (re-install does not add a duplicate mote entry)', () => {
    installClaudeHooks(settings, WRAPPER)
    installClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    const moteCount = stopCmds.filter((c: string) => c.includes(WRAPPER)).length
    expect(moteCount).toBe(1)
  })

  it('uninstall removes only mote entries; keeps user entries; cleans empty arrays', () => {
    fs.writeFileSync(settings, JSON.stringify({
      apiKey: 'keep',
      hooks: {
        Stop:         [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        Notification: []
      }
    }))
    installClaudeHooks(settings, WRAPPER)
    uninstallClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    expect(json.apiKey).toBe('keep')
    const stopCmds = json.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(stopCmds).toEqual(['echo user'])
    expect(json.hooks.Notification).toBeUndefined()
  })

  it('uninstall drops `hooks` key entirely when no user entries remain', () => {
    installClaudeHooks(settings, WRAPPER)
    uninstallClaudeHooks(settings, WRAPPER)
    const json = JSON.parse(fs.readFileSync(settings, 'utf-8'))
    expect(json.hooks).toBeUndefined()
  })

  it('throws on malformed JSON without writing anything', () => {
    fs.writeFileSync(settings, '{ not valid json')
    expect(() => installClaudeHooks(settings, WRAPPER)).toThrow(/parse|JSON/i)
    expect(fs.readFileSync(settings, 'utf-8')).toBe('{ not valid json')
  })

  it('getClaudeStatus reports installed=false on missing file', () => {
    expect(getClaudeStatus(settings, WRAPPER).installed).toBe(false)
  })

  it('getClaudeStatus reports installed=true and eventCount=6 after install', () => {
    installClaudeHooks(settings, WRAPPER)
    const s = getClaudeStatus(settings, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(6)
  })
})

import { installCodexHooks, uninstallCodexHooks, getCodexStatus } from '../electron/hook-installer'

const BEGIN_MARK = '# >>> mote-managed (do not edit) >>>'
const END_MARK   = '# <<< mote-managed <<<'

describe('hook-installer · Codex', () => {
  let dir: string
  let cfg: string

  beforeEach(() => { dir = tmpDir(); cfg = path.join(dir, 'config.toml') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('installs into non-existent config.toml with marker block', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain(BEGIN_MARK)
    expect(body).toContain(END_MARK)
    expect(body).toContain('[[hooks.Stop]]')
    expect(body).toContain('[[hooks.PermissionRequest]]')
    expect(body).toContain('[[hooks.SessionStart]]')
    expect(body).toContain(`${WRAPPER} Stop codex`)
  })

  it('uses notify-only block when degraded=true', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: true })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).not.toContain('[[hooks.')
    expect(body).toContain('notify = ["sh", "-c"')
    expect(body).toContain(`${WRAPPER} Stop codex`)
  })

  it('preserves existing user content before/after marker block', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n[providers.openai]\napi_key = "x"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain('model = "gpt-5"')
    expect(body).toContain('api_key = "x"')
    expect(body).toContain(BEGIN_MARK)
  })

  it('is idempotent — second install replaces the marker block, no duplication', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body.match(/>>> mote-managed/g)?.length).toBe(1)
    expect(body.match(/<<< mote-managed/g)?.length).toBe(1)
  })

  it('creates backup before modifying existing file', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('config.toml.mote-backup-'))
    expect(backups.length).toBe(1)
  })

  it('uninstall removes marker block, leaves user content intact', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    uninstallCodexHooks(cfg, WRAPPER)
    const body = fs.readFileSync(cfg, 'utf-8')
    expect(body).toContain('model = "gpt-5"')
    expect(body).not.toContain(BEGIN_MARK)
    expect(body).not.toContain('mote/bin/event')
  })

  it('uninstall on file without marker block is no-op (safe)', () => {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n')
    expect(() => uninstallCodexHooks(cfg, WRAPPER)).not.toThrow()
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('getCodexStatus reports installed=true after install with eventCount=3 (non-degraded)', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: false })
    const s = getCodexStatus(cfg, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(3)
    expect(s.degraded).toBe(false)
  })

  it('getCodexStatus reports degraded=true and eventCount=1 in notify mode', () => {
    installCodexHooks(cfg, WRAPPER, { degraded: true })
    const s = getCodexStatus(cfg, WRAPPER)
    expect(s.installed).toBe(true)
    expect(s.eventCount).toBe(1)
    expect(s.degraded).toBe(true)
  })
})
