import * as fsSync from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type Anthropic from '@anthropic-ai/sdk'

function findBin(cmd: string): string | null {
  const candidates = [
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ]
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p
  }
  // Fallback: try which
  try { return execFileSync('which', [cmd], { encoding: 'utf-8', env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin' } }).trim() }
  catch { return null }
}

const RESOLVED: Record<string, string> = {}

export interface McpStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

interface McpServerEntry {
  name: string
  client: Client
  connected: boolean
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  error?: string
}

export class McpManager {
  private entries: McpServerEntry[] = []
  readonly configPath: string

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, 'mcp.json')
  }

  async init(): Promise<void> {
    if (!fsSync.existsSync(this.configPath)) return

    let config: Record<string, unknown>
    try {
      config = JSON.parse(fsSync.readFileSync(this.configPath, 'utf-8'))
    } catch {
      return
    }

    const servers = config.mcpServers as Record<Record<string, unknown>, unknown> | undefined
    if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) return

    const promises = Object.entries(servers).map(([name, cfg]) =>
      this.connectServer(name, cfg as { command: string; args?: string[]; env?: Record<string, string> })
    )
    await Promise.all(promises)
  }

  private async connectServer(name: string, cfg: { command: string; args?: string[]; env?: Record<string, string> }): Promise<void> {
    const entry: McpServerEntry = {
      name,
      client: new Client({ name: 'mote', version: '0.1.0' }),
      connected: false,
      tools: []
    }
    this.entries.push(entry)

    // Resolve absolute path for commands like 'npx' or 'node' (not found in packaged app PATH)
    let command = cfg.command
    if (!path.isAbsolute(command) && !cfg.command.includes('/')) {
      if (!RESOLVED[command]) RESOLVED[command] = findBin(command) ?? command
      command = RESOLVED[command]
    }

    try {
      const extraPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin'
      const transport = new StdioClientTransport({
        command,
        args: cfg.args ?? [],
        env: {
          ...process.env,
          PATH: extraPath + ':' + (process.env.PATH ?? ''),
          ...cfg.env,
        } as Record<string, string>
      })
      await entry.client.connect(transport)
      entry.connected = true

      const result = await entry.client.listTools()
      entry.tools = result.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined
      }))
    } catch (err) {
      entry.connected = false
      entry.error = (err as Error).message
    }
  }

  getTools(): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = []
    for (const entry of this.entries) {
      if (!entry.connected) continue
      for (const tool of entry.tools) {
        tools.push({
          name: `mcp__${entry.name}__${tool.name}`,
          description: `[MCP:${entry.name}] ${tool.description ?? ''}`,
          input_schema: (tool.inputSchema ?? { type: 'object' }) as Anthropic.Tool.InputSchema
        })
      }
    }
    return tools
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const parsed = this.parseToolName(prefixedName)
    if (!parsed) throw new Error(`No server found for prefixed name: ${prefixedName}`)

    const entry = this.entries.find(e => e.name === parsed.serverName)
    if (!entry) throw new Error(`No server found for name: ${parsed.serverName}`)
    if (!entry.connected) throw new Error(`Server ${parsed.serverName} is not connected`)

    const result = await entry.client.callTool({ name: parsed.toolName, arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return content.map(c => c.text ?? '').join('')
  }

  private parseToolName(prefixedName: string): { serverName: string; toolName: string } | null {
    if (!prefixedName.startsWith('mcp__')) return null
    const rest = prefixedName.slice(5) // remove 'mcp__'

    // Try splits from left to find matching server name (server name may contain underscores)
    const serverNames = this.entries.map(e => e.name)
    for (const name of serverNames) {
      if (rest.startsWith(name + '__')) {
        return { serverName: name, toolName: rest.slice(name.length + 2) }
      }
    }
    return null
  }

  getStatus(): McpStatus[] {
    return this.entries.map(e => ({
      name: e.name,
      connected: e.connected,
      toolCount: e.connected ? e.tools.length : 0,
      error: e.error
    }))
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await entry.client.close()
      } catch {
        // ignore close errors
      }
    }
    this.entries = []
  }
}
