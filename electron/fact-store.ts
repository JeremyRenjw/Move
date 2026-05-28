import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { MemoryFact, MemoryFactType } from '@shared/types'

const FACTS_FILE = 'facts.jsonl'

interface ListOpts {
  type?:          MemoryFactType
  minConfidence?: number
  limit?:         number
  includeSuperseded?: boolean
}

export class FactStore {
  constructor(private root: string) {}

  private factFile(petId: string): string {
    return path.join(this.root, petId, FACTS_FILE)
  }

  async add(petId: string, fact: Omit<MemoryFact, 'id' | 'ts'>): Promise<string> {
    const full: MemoryFact = { id: randomUUID(), ts: Date.now(), ...fact }
    const dir = path.join(this.root, petId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(this.factFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    return full.id
  }

  async list(petId: string, opts: ListOpts = {}): Promise<MemoryFact[]> {
    const file = this.factFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    let facts = raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as MemoryFact)
    if (!opts.includeSuperseded) facts = facts.filter(f => !f.superseded_by)
    if (opts.type) facts = facts.filter(f => f.type === opts.type)
    if (opts.minConfidence != null) facts = facts.filter(f => f.confidence >= opts.minConfidence!)
    facts.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))  // newest first, tie-break on id
    if (opts.limit != null) facts = facts.slice(0, opts.limit)
    return facts
  }

  async supersede(petId: string, oldId: string, newFact: Omit<MemoryFact, 'id' | 'ts'>): Promise<string> {
    const newId = await this.add(petId, newFact)
    // 把 oldId 那一行重写
    const file = this.factFile(petId)
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).map(l => {
      const f = JSON.parse(l) as MemoryFact
      if (f.id === oldId) f.superseded_by = newId
      return JSON.stringify(f)
    })
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8')
    return newId
  }

  async delete(petId: string, id: string): Promise<void> {
    const file = this.factFile(petId)
    if (!fsSync.existsSync(file)) return
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).filter(l => {
      const f = JSON.parse(l) as MemoryFact
      return f.id !== id
    })
    await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
  }
}
