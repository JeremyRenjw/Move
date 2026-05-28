import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  // Return as default export to match: import fs from 'fs/promises'
  return { default: fs.promises }
})

import { PetManager } from '../electron/pets'
import type { Pet } from '../src-shared/types'
import { DEFAULT_PARAMS, traitsToParams } from '../electron/pet-traits'

const MOCK_PET_JSON = JSON.stringify({
  id: 'stlulu',
  displayName: 'lulu',
  description: 'test pet',
  spritesheetPath: 'spritesheet.webp',
  kind: 'animal'
})

beforeEach(async () => {
  const { vol } = await import('memfs')
  vol.reset()
  vol.fromJSON({
    '/userData/pets/stlulu/pet.json': MOCK_PET_JSON,
    '/userData/pets/stlulu/spritesheet.webp': 'binary'
  })
})

describe('PetManager', () => {
  it('lists pets from userData directory', async () => {
    const mgr = new PetManager('/userData', '/assets')
    const pets = await mgr.list()
    expect(pets).toHaveLength(1)
    expect(pets[0].id).toBe('stlulu')
    expect(pets[0].displayName).toBe('lulu')
  })

  it('returns empty array when no pets dir', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const mgr = new PetManager('/userData', '/assets')
    const pets = await mgr.list()
    expect(pets).toEqual([])
  })

  it('syncs builtin animation metadata for existing builtin pets', async () => {
    const { fs, vol } = await import('memfs')
    const oldPet = JSON.stringify({
      id: 'stlulu',
      displayName: 'custom lulu',
      description: 'custom desc',
      spritesheetPath: 'spritesheet.webp',
      animations: { celebrate: { row: 4, frames: [0, 1, 2, 3, 4, 5] } }
    })
    const fixedPet = JSON.stringify({
      id: 'stlulu',
      displayName: 'lulu',
      description: 'test pet',
      spritesheetPath: 'spritesheet.webp',
      frameSize: { width: 192, height: 208 },
      animations: { celebrate: { row: 4, frames: [0, 1, 2, 3, 4] } }
    })
    const taotao = JSON.stringify({
      id: 'taotao',
      displayName: 'taotao',
      description: 'test pet',
      spritesheetPath: 'spritesheet.webp'
    })
    vol.reset()
    vol.fromJSON({
      '/assets/pets/stlulu/pet.json': fixedPet,
      '/assets/pets/stlulu/spritesheet.webp': 'builtin-binary',
      '/assets/pets/taotao/pet.json': taotao,
      '/assets/pets/taotao/spritesheet.webp': 'builtin-binary',
      '/userData/pets/stlulu/pet.json': oldPet,
      '/userData/pets/stlulu/spritesheet.webp': 'user-binary',
    })

    const mgr = new PetManager('/userData', '/assets')
    await mgr.ensureBuiltins()

    const raw = await fs.promises.readFile('/userData/pets/stlulu/pet.json', 'utf-8')
    const pet = JSON.parse(raw.toString()) as Pet
    expect(pet.displayName).toBe('custom lulu')
    expect(pet.description).toBe('custom desc')
    expect(pet.frameSize).toEqual({ width: 192, height: 208 })
    expect(pet.animations?.celebrate?.frames).toEqual([0, 1, 2, 3, 4])
  })

  it('creates generated png pets with a png data url', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const mgr = new PetManager('/userData', '/assets')

    const pet = await mgr.createGenerated({
      name: '小云',
      description: '白色小狐狸',
      image: Buffer.from('png-bytes')
    })

    expect(pet.id).toMatch(/^pet-/)
    expect(pet.kind).toBe('generated')
    expect(pet.spritesheetPath).toBe('spritesheet.png')
    expect(pet.spritesheetDataUrl).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
    expect(pet.frameSize).toEqual({ width: 192, height: 208 })
    expect(pet.animations?.idle?.frames).toEqual([0, 1, 2, 3, 4, 5])
    expect(pet.animations?.alert).toEqual({ row: 1, frames: [0, 1, 2, 3] })
    expect(pet.animations?.talk).toEqual({ row: 2, frames: [0, 1, 2, 3, 4, 5] })
    expect(pet.animations?.working).toEqual({ row: 3, frames: [0, 1, 2, 3] })
    expect(pet.animations?.celebrate).toEqual({ row: 4, frames: [0, 1, 2, 3, 4] })
  })
})

describe('PetManager.resolveParams', () => {
  const mockChars = (override?: Partial<import('../src-shared/types').PetTraits>) => ({
    get: vi.fn().mockResolvedValue({ traitsOverride: override }),
  })

  it('returns DEFAULT_PARAMS for a pet without traits', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    vol.fromJSON({
      '/userData/pets/stlulu/pet.json': MOCK_PET_JSON,
      '/userData/pets/stlulu/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const params = await mgr.resolveParams('stlulu', mockChars())
    expect(params).toEqual(DEFAULT_PARAMS)
  })

  it('honors pet.json traits when no character override', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const petWithTraits = JSON.stringify({
      id: 'taotao', displayName: '桃桃', description: 'test', spritesheetPath: 'spritesheet.webp',
      traits: { sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 },
    })
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': petWithTraits,
      '/userData/pets/taotao/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const params = await mgr.resolveParams('taotao', mockChars())
    expect(params).toEqual(traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 }))
  })

  it('character override wins over pet.json traits', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const petWithTraits = JSON.stringify({
      id: 'taotao', displayName: '桃桃', description: 'test', spritesheetPath: 'spritesheet.webp',
      traits: { sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 },
    })
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': petWithTraits,
      '/userData/pets/taotao/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const params = await mgr.resolveParams('taotao', mockChars({ sociability: 0.1 }))
    // sociability=0.1 → lerp(3,1,0.1) = 2.8
    expect(params.lonelyHoursThreshold).toBeCloseTo(2.8, 6)
  })

  it('getActiveParams returns DEFAULT_PARAMS before resolveParams', () => {
    const mgr = new PetManager('/userData', '/assets')
    expect(mgr.getActiveParams()).toEqual(DEFAULT_PARAMS)
  })

  it('getActiveParams reflects the most recent resolveParams for the active pet', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': JSON.stringify({
        id: 'taotao', displayName: '桃桃', description: 't', spritesheetPath: 'spritesheet.webp',
        traits: { sociability: 1, independence: 0, playfulness: 0.5, energy_volatility: 0.5 },
      }),
      '/userData/pets/taotao/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    mgr.setActive('taotao')
    await mgr.resolveParams('taotao', mockChars())
    // sociability=1 → lerp(3,1,1) = 1
    expect(mgr.getActiveParams().lonelyHoursThreshold).toBe(1)
  })
})
