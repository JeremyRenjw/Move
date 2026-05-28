import fs from 'fs/promises'
import path from 'path'
import { safeStorage } from 'electron'
import type { CharacterConfig, ApiConfig } from '@shared/types'

const API_CONFIG_FILE = 'api-config.json'
const API_KEY_FILE = 'api-key.json'

interface ApiKeyFile {
  encrypted: boolean
  value: string
}

const DEFAULT_CONFIG = (petId: string): CharacterConfig => ({
  petId,
  displayName: petId,
  personality: ['活泼', '可爱'],
  systemPrompt: `你是用户的桌面 AI 助手，名字叫 ${petId}。可以聊任何话题、解释概念、写代码、查资料，和普通 AI 助手一样有问必答。回复保持自然简短，不要刻意卖萌或堆砌 emoji。`,
  greeting: '你好！有什么我能帮你的吗？'
})

const DEFAULT_API: ApiConfig = { provider: 'claude', model: 'claude-opus-4-7' }

export class CharacterConfigStore {
  private dir: string

  constructor(userData: string) {
    this.dir = path.join(userData, 'characters')
  }

  private filePath(petId: string): string {
    return path.join(this.dir, `${petId}.json`)
  }

  private apiConfigPath(): string {
    return path.join(this.dir, API_CONFIG_FILE)
  }

  private apiKeyPath(): string {
    return path.join(this.dir, API_KEY_FILE)
  }

  async get(petId: string): Promise<CharacterConfig> {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const raw = await fs.readFile(this.filePath(petId), 'utf-8')
      const parsed = JSON.parse(raw) as CharacterConfig & { apiConfig?: unknown }
      delete parsed.apiConfig
      return { ...parsed, apiConfig: await this.getApiConfig() } as CharacterConfig
    } catch {
      return { ...DEFAULT_CONFIG(petId), apiConfig: await this.getApiConfig() }
    }
  }

  async save(cfg: CharacterConfig): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    if (cfg.apiConfig) await this.saveApiConfig(cfg.apiConfig)
    const { apiConfig: _apiConfig, ...character } = cfg
    await fs.writeFile(this.filePath(cfg.petId), JSON.stringify(character, null, 2))
  }

  async getApiConfig(): Promise<ApiConfig> {
    try {
      const raw = await fs.readFile(this.apiConfigPath(), 'utf-8')
      return JSON.parse(raw) as ApiConfig
    } catch {
      return DEFAULT_API
    }
  }

  async saveApiConfig(cfg: ApiConfig): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.apiConfigPath(), JSON.stringify(cfg, null, 2))
  }

  async getApiKey(_legacyPetId?: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.apiKeyPath(), 'utf-8')
      const parsed = JSON.parse(raw) as ApiKeyFile
      if (!parsed.value) return null

      if (!parsed.encrypted) return parsed.value
      return safeStorage.decryptString(Buffer.from(parsed.value, 'base64'))
    } catch {
      return null
    }
  }

  async saveApiKey(key: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const payload: ApiKeyFile = safeStorage.isEncryptionAvailable()
      ? { encrypted: true, value: safeStorage.encryptString(key).toString('base64') }
      : { encrypted: false, value: key }
    await fs.writeFile(this.apiKeyPath(), JSON.stringify(payload, null, 2))
  }
}
