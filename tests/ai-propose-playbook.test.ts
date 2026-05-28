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

import { AiEngine, parseProposedPlaybook } from '../electron/ai'
import type { ApiConfig } from '../src-shared/types'

function anthropicResp(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

const CLAUDE_CFG: ApiConfig = { provider: 'claude', model: 'claude-sonnet-4-6' }
const OPENAI_CFG: ApiConfig = { provider: 'openai', model: 'gpt-4o' }

const VALID_JSON = JSON.stringify({
  slug:       'cleanup-downloads',
  title:      '清理下载文件夹',
  triggers:   ['下载文件夹满了', '磁盘空间不足'],
  body:       '# 怎么做\n\n1. 打开下载文件夹\n2. 删除超过30天的文件\n\n# 用户偏好\n\n- 喜欢自动清理',
  confidence: 0.8
})

const BASE_OPTS = {
  recentTurn: [
    { role: 'user', content: '下载文件夹满了怎么办' },
    { role: 'pet',  content: '你可以定期清理超过30天的文件' }
  ],
  existingPlaybooks: [
    { id: 'git-push', title: '推送代码', triggers: ['push', '推送到远程'] }
  ],
  facts: [
    { type: 'preference', content: '喜欢自动清理' }
  ]
}

describe('parseProposedPlaybook', () => {
  it('returns null for NONE', () => {
    expect(parseProposedPlaybook('NONE')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseProposedPlaybook('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseProposedPlaybook('this is not json')).toBeNull()
  })

  it('returns null for JSON with empty triggers array', () => {
    const json = JSON.stringify({
      slug: 'test-slug', title: 'Test', triggers: [], body: 'body', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for slug with invalid chars (spaces)', () => {
    const json = JSON.stringify({
      slug: 'hello world', title: 'Test', triggers: ['t'], body: 'body', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for slug with uppercase', () => {
    const json = JSON.stringify({
      slug: 'Hello-World', title: 'Test', triggers: ['t'], body: 'body', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for empty title', () => {
    const json = JSON.stringify({
      slug: 'test', title: '', triggers: ['t'], body: 'body', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for empty body', () => {
    const json = JSON.stringify({
      slug: 'test', title: 'Test', triggers: ['t'], body: '', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for confidence > 1', () => {
    const json = JSON.stringify({
      slug: 'test', title: 'Test', triggers: ['t'], body: 'body', confidence: 1.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null for confidence < 0', () => {
    const json = JSON.stringify({
      slug: 'test', title: 'Test', triggers: ['t'], body: 'body', confidence: -0.1
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('returns null when triggers contains non-string', () => {
    const json = JSON.stringify({
      slug: 'test', title: 'Test', triggers: [123], body: 'body', confidence: 0.5
    })
    expect(parseProposedPlaybook(json)).toBeNull()
  })

  it('parses a valid playbook', () => {
    const result = parseProposedPlaybook(VALID_JSON)
    expect(result).toEqual({
      slug:       'cleanup-downloads',
      title:      '清理下载文件夹',
      triggers:   ['下载文件夹满了', '磁盘空间不足'],
      body:       '# 怎么做\n\n1. 打开下载文件夹\n2. 删除超过30天的文件\n\n# 用户偏好\n\n- 喜欢自动清理',
      confidence: 0.8
    })
  })

  it('accepts simple kebab-case slugs', () => {
    const json = JSON.stringify({
      slug: 'a', title: 'x', triggers: ['y'], body: 'z', confidence: 0
    })
    expect(parseProposedPlaybook(json)).not.toBeNull()
  })
})

describe('AiEngine.proposePlaybook', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    openaiCreateMock.mockReset()
  })

  it('returns playbook for valid JSON from Claude', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp(VALID_JSON))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).not.toBeNull()
    expect(result!.slug).toBe('cleanup-downloads')
    expect(anthropicCreateMock).toHaveBeenCalledOnce()
  })

  it('returns null for NONE from Claude', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('returns null for invalid JSON from Claude', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('this is not json'))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('returns null for JSON with empty triggers from Claude', async () => {
    const json = JSON.stringify({
      slug: 'test', title: 'Test', triggers: [], body: 'body', confidence: 0.5
    })
    anthropicCreateMock.mockResolvedValue(anthropicResp(json))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('returns null for slug with invalid chars from Claude', async () => {
    const json = JSON.stringify({
      slug: 'hello world', title: 'Test', triggers: ['t'], body: 'body', confidence: 0.5
    })
    anthropicCreateMock.mockResolvedValue(anthropicResp(json))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('returns null when API throws', async () => {
    anthropicCreateMock.mockRejectedValue(new Error('network error'))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('prompt includes existingPlaybooks list', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    const prompt: string = anthropicCreateMock.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('git-push: 推送代码 (triggers: push, 推送到远程)')
  })

  it('prompt includes recentTurn conversation', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    const prompt: string = anthropicCreateMock.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('用户: 下载文件夹满了怎么办')
    expect(prompt).toContain('宠物: 你可以定期清理超过30天的文件')
  })

  it('prompt includes facts', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    const prompt: string = anthropicCreateMock.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('- 喜欢自动清理')
  })

  it('uses max_tokens 512', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp('NONE'))

    const engine = new AiEngine()
    await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(anthropicCreateMock.mock.calls[0][0].max_tokens).toBe(512)
  })

  it('returns playbook for valid JSON from OpenAI', async () => {
    openaiCreateMock.mockResolvedValue({ choices: [{ message: { content: VALID_JSON } }] })

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: OPENAI_CFG, apiKey: 'sk-test' })

    expect(result).not.toBeNull()
    expect(result!.slug).toBe('cleanup-downloads')
    expect(openaiCreateMock).toHaveBeenCalledOnce()
  })

  it('returns null for NONE from OpenAI', async () => {
    openaiCreateMock.mockResolvedValue({ choices: [{ message: { content: 'NONE' } }] })

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: OPENAI_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('returns null when OpenAI returns empty content', async () => {
    openaiCreateMock.mockResolvedValue({ choices: [{ message: { content: '' } }] })

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: OPENAI_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })

  it('falls back to null on empty response from Claude', async () => {
    anthropicCreateMock.mockResolvedValue(anthropicResp(''))

    const engine = new AiEngine()
    const result = await engine.proposePlaybook({ ...BASE_OPTS, apiConfig: CLAUDE_CFG, apiKey: 'sk-test' })

    expect(result).toBeNull()
  })
})
