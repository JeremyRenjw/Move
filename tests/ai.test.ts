import { describe, it, expect, vi } from 'vitest'

vi.mock('anthropic', () => ({
  default: class {
    messages = {
      stream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function*() {},
        finalMessage: vi.fn().mockResolvedValue({ content: [] })
      })
    }
  }
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn() } }
  }
}))

import { AiEngine } from '../electron/ai'
import type { CharacterConfig, SystemStats } from '../src-shared/types'

const MOCK_CONFIG: CharacterConfig = {
  petId: 'stlulu', displayName: 'lulu', personality: [],
  systemPrompt: 'You are lulu.',
  greeting: 'Hi!',
  apiConfig: { provider: 'claude', model: 'claude-opus-4-7' }
}

const MOCK_STATS: SystemStats = {
  cpu: 30, ramUsed: 4e9, ramTotal: 16e9,
  diskUsed: 40, claudeRunning: false, codexRunning: false
}

describe('AiEngine', () => {
  it('builds system prompt with stats injected', () => {
    const engine = new AiEngine()
    const prompt = engine.buildSystemPrompt(MOCK_CONFIG, MOCK_STATS)
    expect(prompt).toContain('You are lulu.')
    expect(prompt).toContain('CPU: 30%')
    expect(prompt).toContain('claude: 未运行')
  })

  it('detects tool calls in AI response', () => {
    const engine = new AiEngine()
    const calls = engine.parseToolCalls([{
      type: 'tool_use', name: 'run_claude_code',
      input: { prompt: 'fix bug', workdir: '/home' }
    }])
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('run_claude_code')
    expect(calls[0].input.prompt).toBe('fix bug')
  })

  it('returns empty array for non-tool-use blocks', () => {
    const engine = new AiEngine()
    expect(engine.parseToolCalls([{ type: 'text', text: 'hello' }])).toEqual([])
    expect(engine.parseToolCalls([{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }])).toHaveLength(1)
  })
})
