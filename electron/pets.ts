import fs from 'fs/promises'
import path from 'path'
import type { Pet, DriveParams, PetTraits } from '@shared/types'
import { mergeTraits, traitsToParams, DEFAULT_PARAMS } from './pet-traits'

type GeneratedPetImageExt = 'png' | 'jpeg' | 'webp'

function slugifyPetId(name: string): string {
  const ascii = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii || `pet-${Date.now().toString(36)}`
}

function imageMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext !== '.webp') throw new Error(`Unsupported pet spritesheet format: ${ext || '(none)'}`)
  return 'image/webp'
}

export class PetManager {
  private petsDir: string
  private assetsDir: string
  private activePetId: string | null = null
  private activeParams: DriveParams = DEFAULT_PARAMS

  constructor(userData: string, assetsDir: string) {
    this.petsDir  = path.join(userData, 'pets')
    this.assetsDir = assetsDir
  }

  async ensureBuiltins(): Promise<void> {
    await fs.mkdir(this.petsDir, { recursive: true })
    const builtins = ['stlulu', 'taotao']
    for (const id of builtins) {
      const dest = path.join(this.petsDir, id)
      const src = path.join(this.assetsDir, 'pets', id)
      try { await fs.access(dest) } catch {
        await fs.cp(src, dest, { recursive: true })
        continue
      }
      await this.syncBuiltinManifest(src, dest)
    }
  }

  private async syncBuiltinManifest(src: string, dest: string): Promise<void> {
    const [srcRaw, destRaw] = await Promise.all([
      fs.readFile(path.join(src, 'pet.json'), 'utf-8'),
      fs.readFile(path.join(dest, 'pet.json'), 'utf-8'),
    ])
    const source = JSON.parse(srcRaw) as Pet
    const current = JSON.parse(destRaw) as Pet
    const next: Pet = {
      ...current,
      spritesheetPath: source.spritesheetPath,
      frameSize: source.frameSize,
      animations: source.animations,
      evolutions: source.evolutions,
      traits: source.traits,
    }

    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await fs.writeFile(path.join(dest, 'pet.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    }
  }

  async list(): Promise<Pet[]> {
    try {
      const entries = await fs.readdir(this.petsDir, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory())
      const pets = await Promise.all(dirs.map(d => this.load(d.name)))
      return pets.filter((p): p is Pet => p !== null)
    } catch { return [] }
  }

  async load(id: string, stage?: string): Promise<Pet | null> {
    try {
      const dir   = path.join(this.petsDir, id)
      const raw   = await fs.readFile(path.join(dir, 'pet.json'), 'utf-8')
      const pet   = JSON.parse(raw) as Pet
      if (pet.kind === 'generated' && path.extname(pet.spritesheetPath).toLowerCase() === '.svg') {
        return null
      }

      // Use evolution-specific spritesheet if available
      const evo = stage && pet.evolutions?.[stage]
      const spritesheetPath = evo?.spritesheetPath ?? pet.spritesheetPath
      const imgBuf = await fs.readFile(path.join(dir, spritesheetPath))
      const mime = imageMimeFromPath(spritesheetPath)
      pet.spritesheetDataUrl = `data:${mime};base64,${imgBuf.toString('base64')}`

      // Override frameSize and animations if the evolution defines them
      if (evo?.frameSize) pet.frameSize = evo.frameSize
      if (evo?.animations) pet.animations = evo.animations

      pet.dir = dir
      return pet
    } catch { return null }
  }

  async importFrom(dirPath: string): Promise<Pet> {
    const jsonPath = path.join(dirPath, 'pet.json')
    const raw  = await fs.readFile(jsonPath, 'utf-8')
    const meta = JSON.parse(raw) as Pet
    const dest = path.join(this.petsDir, meta.id)
    await fs.cp(dirPath, dest, { recursive: true })
    const pet = await this.load(meta.id)
    if (!pet) throw new Error(`Failed to import pet ${meta.id}`)
    return pet
  }

  async createGenerated(input: { name: string; description: string; image: Buffer; extension?: GeneratedPetImageExt }): Promise<Pet> {
    await fs.mkdir(this.petsDir, { recursive: true })
    const baseId = slugifyPetId(input.name)
    let id = baseId
    for (let i = 2; ; i++) {
      try {
        await fs.access(path.join(this.petsDir, id))
        id = `${baseId}-${i}`
      } catch {
        break
      }
    }

    const dest = path.join(this.petsDir, id)
    await fs.mkdir(dest, { recursive: true })
    const ext = input.extension ?? 'png'
    const fileName = ext === 'jpeg' ? 'spritesheet.jpg' : `spritesheet.${ext}`
    const pet: Pet = {
      id,
      displayName: input.name.trim(),
      description: input.description.trim(),
      spritesheetPath: fileName,
      kind: 'generated',
      frameSize: { width: 192, height: 208 },
      animations: {
        idle: { row: 0, frames: [0, 1, 2, 3, 4, 5] },
        alert: { row: 1, frames: [0, 1, 2, 3] },
        talk: { row: 2, frames: [0, 1, 2, 3, 4, 5] },
        working: { row: 3, frames: [0, 1, 2, 3] },
        celebrate: { row: 4, frames: [0, 1, 2, 3, 4] },
      },
      evolutions: {
        baby: { spritesheetPath: fileName },
        child: { spritesheetPath: fileName },
        teen: { spritesheetPath: fileName },
        adult: { spritesheetPath: fileName },
        elder: { spritesheetPath: fileName },
      },
    }

    await fs.writeFile(path.join(dest, 'pet.json'), `${JSON.stringify(pet, null, 2)}\n`, 'utf-8')
    await fs.writeFile(path.join(dest, fileName), input.image)
    const loaded = await this.load(id)
    if (!loaded) throw new Error(`Failed to create generated pet ${id}`)
    return loaded
  }

  setActive(petId: string): void { this.activePetId = petId }
  getActiveId(): string | null   { return this.activePetId }

  /**
   * Load `traits` from pet.json, merge with character override, compute DriveParams.
   * Caches result in activeParams iff this petId is currently active.
   */
  async resolveParams(petId: string, chars: { get(petId: string): Promise<{ traitsOverride?: Partial<PetTraits> }> }): Promise<DriveParams> {
    let petTraits: Partial<PetTraits> | undefined
    try {
      const raw = await fs.readFile(path.join(this.petsDir, petId, 'pet.json'), 'utf-8')
      const pet = JSON.parse(raw) as Pet
      petTraits = pet.traits
    } catch { /* missing pet.json: treat as no traits */ }

    let override: Partial<PetTraits> | undefined
    try {
      const cfg = await chars.get(petId)
      override = cfg.traitsOverride
    } catch { /* no character config yet */ }

    const traits = mergeTraits(petTraits, override)
    const params = traitsToParams(traits)
    if (this.activePetId === petId) this.activeParams = params
    return params
  }

  /** Returns the most recently resolved params for the active pet (or DEFAULT_PARAMS). */
  getActiveParams(): DriveParams { return this.activeParams }
}
