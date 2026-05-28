import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { McpManager } from '../electron/mcp-manager'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-mcp-')) }

describe('McpManager', () => {
  let dir: string

  beforeEach(() => { dir = tmp() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('skips init when mcp.json does not exist', async () => {
    const mgr = new McpManager(dir)
    await mgr.init()
    expect(mgr.getTools()).toEqual([])
    expect(mgr.getStatus()).toEqual([])
  })

  it('skips init when mcp.json has empty mcpServers', async () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    const mgr = new McpManager(dir)
    await mgr.init()
    expect(mgr.getTools()).toEqual([])
    expect(mgr.getStatus()).toEqual([])
  })

  it('handles server spawn failure gracefully', async () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        badserver: {
          command: '/nonexistent-binary-xyz',
          args: []
        }
      }
    }))
    const mgr = new McpManager(dir)
    await mgr.init()
    const status = mgr.getStatus()
    expect(status).toHaveLength(1)
    expect(status[0].name).toBe('badserver')
    expect(status[0].connected).toBe(false)
    expect(status[0].toolCount).toBe(0)
    expect(status[0].error).toBeDefined()
    expect(typeof status[0].error).toBe('string')
  })

  it('returns empty tools array after failed connection', async () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        badserver: {
          command: '/nonexistent-binary-xyz',
          args: []
        }
      }
    }))
    const mgr = new McpManager(dir)
    await mgr.init()
    expect(mgr.getTools()).toEqual([])
  })

  it('callTool throws for unknown server prefix', async () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    const mgr = new McpManager(dir)
    await mgr.init()
    await expect(mgr.callTool('mcp__noserver__some_tool', {}))
      .rejects.toThrow(/no server/i)
  })

  it('callTool throws when tool prefix does not match any server', async () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        filesystem: { command: '/nonexistent-binary-xyz', args: [] }
      }
    }))
    const mgr = new McpManager(dir)
    await mgr.init()
    // Server is not connected, so calling should throw
    await expect(mgr.callTool('mcp__filesystem__read_file', {}))
      .rejects.toThrow(/not connected/i)
  })

  it('callTool parses server name with underscores correctly', async () => {
    // This tests the prefix parsing logic with a server whose name contains underscores.
    // Since we can't easily spawn a real MCP server, we test the routing by checking
    // that it correctly identifies the server name segment.
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        my_server: { command: '/nonexistent-binary-xyz', args: [] }
      }
    }))
    const mgr = new McpManager(dir)
    await mgr.init()
    // Server not connected, but we should reach it (not throw "no server")
    await expect(mgr.callTool('mcp__my_server__read_file', {}))
      .rejects.toThrow(/not connected/i)
  })

  it('shutdown is safe to call without init', async () => {
    const mgr = new McpManager(dir)
    await expect(mgr.shutdown()).resolves.toBeUndefined()
  })
})
