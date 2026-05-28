import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { default: fs.promises }
})
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8'))
  }
}))

import { CharacterConfigStore } from '../electron/character'

beforeEach(async () => {
  const { vol } = await import('memfs')
  vol.reset()
})

describe('CharacterConfigStore', () => {
  it('returns default config when none saved', async () => {
    const store = new CharacterConfigStore('/userData')
    const cfg = await store.get('stlulu')
    expect(cfg.petId).toBe('stlulu')
    expect(cfg.apiConfig.provider).toBe('claude')
    expect(cfg.apiConfig.model).toBe('claude-opus-4-7')
  })

  it('saves and retrieves config', async () => {
    const store = new CharacterConfigStore('/userData')
    await store.save({
      petId: 'stlulu', displayName: 'lulu', personality: ['活泼'],
      systemPrompt: 'You are lulu', greeting: 'Hi!',
      apiConfig: { provider: 'claude', model: 'claude-opus-4-7' }
    })
    const cfg = await store.get('stlulu')
    expect(cfg.systemPrompt).toBe('You are lulu')
  })

  it('saves and retrieves API key', async () => {
    const store = new CharacterConfigStore('/userData')
    await store.saveApiKey('test-api-key')
    const key = await store.getApiKey('stlulu')
    expect(key).toBe('test-api-key')
  })
})
