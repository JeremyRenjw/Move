import { describe, it, expect, vi, beforeEach } from 'vitest'

const anthropicCreateMock = vi.fn()
const openaiCreateMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreateMock }
  }
}))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreateMock } }
  }
}))

import { AiEngine } from '../electron/ai'
import type { ApiConfig } from '../src-shared/types'

function anthropicResp(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function openaiResp(text: string) {
  return { choices: [{ message: { content: text } }] }
}

const CLAUDE_CFG: ApiConfig = { provider: 'claude', model: 'claude-sonnet-4-6' }
const OPENAI_CFG: ApiConfig = { provider: 'openai', model: 'gpt-4o' }

const BASE_OPTS = {
  recentEvents: [
    { type: 'cli_exit', source: 'claude', data: { exitCode: 0 }, ts: Date.now() - 60_000 }
  ],
  facts: [
    { type: 'preference' as const, content: '喜欢 dark mode', confidence: 0.9 }
  ],
  stats: { cpu: 42, ramUsed: 8e9, ramTotal: 16e9, diskUsed: 55 },
  petPersona: '你是一只叫 lulu 的猫娘。'
}

describe('AiEngine.reflect', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    openaiCreateMock.mockReset()
  })

  it('returns silent for Claude silent response', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('{"action":"silent"}'))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
    expect(anthropicCreateMock).toHaveBeenCalledOnce()
    const callArgs = anthropicCreateMock.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-sonnet-4-6')
    expect(callArgs.max_tokens).toBe(200)
    expect(callArgs.messages[0].content).toContain('你是这个宠物助手')
    expect(callArgs.messages[0].content).toContain('lulu')
  })

  it('returns propose for Claude propose response', async () => {
    anthropicCreateMock.mockResolvedValue(
      anthropicResp('{"action":"propose","bubble":"磁盘快满了","detail":"请清理一下"}')
    )

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'propose', bubble: '磁盘快满了', detail: '请清理一下' })
  })

  it('returns silent for OpenAI silent response', async () => {
    openaiCreateMock.mockResolvedValue(openaiResp('{"action":"silent"}'))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: OPENAI_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
    expect(openaiCreateMock).toHaveBeenCalledOnce()
  })

  it('returns propose for OpenAI propose response', async () => {
    openaiCreateMock.mockResolvedValue(
      openaiResp('{"action":"propose","bubble":"磁盘快满了","detail":"请清理一下"}')
    )

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: OPENAI_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'propose', bubble: '磁盘快满了', detail: '请清理一下' })
  })

  it('falls back to silent on invalid JSON', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('this is not json'))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
  })

  it('falls back to silent on NONE response', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
  })

  it('falls back to silent on empty response', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp(''))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
  })

  it('falls back to silent when API throws', async () => {
    anthropicCreateMock.mockRejectedValue(new Error('network error'))

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
  })

  it('truncates bubble to 28 chars', async () => {
    const longBubble = '这是一段超长的气泡文案肯定超过二十八个字了对吧'
    anthropicCreateMock.mockResolvedValue(
      anthropicResp(JSON.stringify({ action: 'propose', bubble: longBubble, detail: 'ok' }))
    )

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result.action).toBe('propose')
    expect(result.bubble!.length).toBeLessThanOrEqual(28)
  })

  it('falls back to silent when propose has no bubble', async () => {
    anthropicCreateMock.mockResolvedValue(
      anthropicResp('{"action":"propose","detail":"no bubble"}')
    )

    const engine = new AiEngine()
    const result = await engine.reflect({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toEqual({ action: 'silent' })
  })

  it('includes petPersona and stats in the prompt', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('{"action":"silent"}'))

    const engine = new AiEngine()
    await engine.reflect({
      ...BASE_OPTS,
      apiConfig: CLAUDE_CFG,
      apiKey: 'sk-test',
      facts: [
        { type: 'user_profile', content: '开发者', confidence: 0.8 },
        { type: 'preference', content: '喜欢 TypeScript', confidence: 0.95 }
      ]
    })

    const prompt: string = anthropicCreateMock.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('[user_profile] 开发者 (conf=0.8)')
    expect(prompt).toContain('[preference] 喜欢 TypeScript (conf=0.95)')
    expect(prompt).toContain('CPU 42%')
    expect(prompt).toContain('RAM 8.0/16.0GB')
    expect(prompt).toContain('磁盘 55%')
  })
})
