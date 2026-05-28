import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HookInstallStatus } from '../src-shared/types'

const CLAUDE_EVENTS = ['Stop', 'Notification', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const
type ClaudeEvent = typeof CLAUDE_EVENTS[number]

interface ClaudeHookCmd {
  type:    'command'
  command: string
}

interface ClaudeHookGroup {
  matcher?: string
  hooks:    ClaudeHookCmd[]
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookGroup[]>>
  [k: string]: unknown
}

function readJson(file: string): ClaudeSettings {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf-8')
  try { return JSON.parse(text) as ClaudeSettings }
  catch (err) { throw new Error(`Cannot parse JSON ${file}: ${(err as Error).message}`) }
}

function writeJsonAtomic(file: string, data: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.mote-backup-${stamp}`
  fs.copyFileSync(file, dest)
}

function buildClaudeCmd(wrapper: string, event: ClaudeEvent): ClaudeHookGroup {
  return {
    hooks: [{ type: 'command', command: `${wrapper} ${event} claude` }]
  }
}

function isMoteCmd(cmd: string, wrapper: string): boolean {
  return cmd.includes(wrapper)
}

export function installClaudeHooks(settingsFile: string, wrapper: string): void {
  const json = readJson(settingsFile)
  backup(settingsFile)
  json.hooks ??= {}
  for (const ev of CLAUDE_EVENTS) {
    const existing = (json.hooks[ev] ?? []) as ClaudeHookGroup[]
    const alreadyHasMote = existing.some(g =>
      g.hooks?.some(h => isMoteCmd(h.command, wrapper))
    )
    if (alreadyHasMote) continue
    json.hooks[ev] = [...existing, buildClaudeCmd(wrapper, ev)]
  }
  writeJsonAtomic(settingsFile, json)
}

export function uninstallClaudeHooks(settingsFile: string, wrapper: string): void {
  if (!fs.existsSync(settingsFile)) return
  const json = readJson(settingsFile)
  if (!json.hooks) return
  for (const ev of Object.keys(json.hooks)) {
    const groups = (json.hooks[ev] ?? []) as ClaudeHookGroup[]
    const filtered = groups
      .map(g => ({ ...g, hooks: g.hooks.filter(h => !isMoteCmd(h.command, wrapper)) }))
      .filter(g => g.hooks.length > 0)
    if (filtered.length === 0) delete json.hooks[ev]
    else json.hooks[ev] = filtered
  }
  if (Object.keys(json.hooks).length === 0) delete json.hooks
  writeJsonAtomic(settingsFile, json)
}

export function getClaudeStatus(settingsFile: string, wrapper: string): HookInstallStatus {
  const base: HookInstallStatus = {
    tool: 'claude',
    configPath: settingsFile,
    installed: false,
    eventCount: 0
  }
  if (!fs.existsSync(settingsFile)) return base
  let json: ClaudeSettings
  try { json = readJson(settingsFile) } catch { return base }
  let count = 0
  for (const ev of Object.keys(json.hooks ?? {})) {
    const groups = (json.hooks?.[ev] ?? []) as ClaudeHookGroup[]
    for (const g of groups) {
      if (g.hooks?.some(h => isMoteCmd(h.command, wrapper))) count++
    }
  }
  const dir = path.dirname(settingsFile)
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.startsWith(path.basename(settingsFile) + '.mote-backup-'))
    : []
  const latest = backups.sort().pop()
  return {
    ...base,
    installed: count > 0,
    eventCount: count,
    installedAt: latest?.replace(path.basename(settingsFile) + '.mote-backup-', '')
  }
}

// ─── Codex (block-marker TOML) ───
//
// We use marker comments rather than a TOML library so we don't need a new
// dependency AND we never touch user formatting/comments outside our block.

const BEGIN_MARK = '# >>> mote-managed (do not edit) >>>'
const END_MARK   = '# <<< mote-managed <<<'

interface CodexInstallOpts { degraded: boolean }

function buildCodexBlock(wrapper: string, opts: CodexInstallOpts): string {
  if (opts.degraded) {
    return [
      BEGIN_MARK,
      `notify = ["sh", "-c", "${wrapper} Stop codex"]`,
      END_MARK,
      ''
    ].join('\n')
  }
  const evs = ['Stop', 'PermissionRequest', 'SessionStart'] as const
  const tables = evs.map(ev =>
    `[[hooks.${ev}]]\nhooks = [{ type = "command", command = "${wrapper} ${ev} codex" }]`
  ).join('\n\n')
  return `${BEGIN_MARK}\n${tables}\n${END_MARK}\n`
}

function stripMarkerBlock(text: string): string {
  const begin = text.indexOf(BEGIN_MARK)
  if (begin < 0) return text
  const endStart = text.indexOf(END_MARK, begin)
  if (endStart < 0) return text  // malformed — leave alone
  const endLineEnd = text.indexOf('\n', endStart)
  const cutEnd = endLineEnd < 0 ? text.length : endLineEnd + 1
  // Also eat one preceding newline if block started on its own line.
  let cutStart = begin
  if (cutStart > 0 && text[cutStart - 1] === '\n') cutStart -= 1
  return text.slice(0, cutStart) + text.slice(cutEnd)
}

function writeTextAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

export function installCodexHooks(configFile: string, wrapper: string, opts: CodexInstallOpts): void {
  let existing = ''
  if (fs.existsSync(configFile)) {
    existing = fs.readFileSync(configFile, 'utf-8')
    backup(configFile)
  }
  // Remove any prior mote block, then append fresh one.
  const cleaned = stripMarkerBlock(existing)
  const sep = cleaned.length === 0 || cleaned.endsWith('\n') ? '' : '\n'
  const next = cleaned + sep + buildCodexBlock(wrapper, opts)
  writeTextAtomic(configFile, next)
}

export function uninstallCodexHooks(configFile: string, wrapper: string): void {
  if (!fs.existsSync(configFile)) return
  const existing = fs.readFileSync(configFile, 'utf-8')
  const stripped = stripMarkerBlock(existing)
  if (stripped === existing) return  // nothing to do
  writeTextAtomic(configFile, stripped)
  // wrapper arg unused but kept symmetric with Claude API.
  void wrapper
}

export function getCodexStatus(configFile: string, wrapper: string): HookInstallStatus {
  const base: HookInstallStatus = {
    tool: 'codex',
    configPath: configFile,
    installed: false,
    eventCount: 0
  }
  if (!fs.existsSync(configFile)) return base
  const text = fs.readFileSync(configFile, 'utf-8')
  const beg = text.indexOf(BEGIN_MARK)
  const end = text.indexOf(END_MARK)
  if (beg < 0 || end < 0) return base
  const block = text.slice(beg, end)
  const degraded = block.includes('notify =') && !block.includes('[[hooks.')
  const eventCount = degraded
    ? 1
    : (block.match(/\[\[hooks\./g)?.length ?? 0)
  const dir = path.dirname(configFile)
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.startsWith(path.basename(configFile) + '.mote-backup-'))
    : []
  const latest = backups.sort().pop()
  return {
    ...base,
    installed: eventCount > 0,
    eventCount,
    degraded,
    installedAt: latest?.replace(path.basename(configFile) + '.mote-backup-', '')
  }
  void wrapper
}
