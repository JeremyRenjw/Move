import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { PetEvent } from '@shared/types'

const EVENTS_FILE = 'events.jsonl'
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

export type EventListener = (petId: string, ev: PetEvent) => void

export class EventStore {
  private listeners: EventListener[] = []

  constructor(private root: string, private maxBytes: number = DEFAULT_MAX_BYTES) {}

  addListener(fn: EventListener): void {
    this.listeners.push(fn)
  }

  removeListener(fn: EventListener): void {
    this.listeners = this.listeners.filter(l => l !== fn)
  }

  private notify(petId: string, ev: PetEvent): void {
    for (const fn of this.listeners) {
      try { fn(petId, ev) } catch (err) { console.error('[event-store] listener threw:', err) }
    }
  }

  private petDir(petId: string): string {
    return path.join(this.root, petId)
  }

  private activeFile(petId: string): string {
    return path.join(this.petDir(petId), EVENTS_FILE)
  }

  private archiveName(): string {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return `events.${d.getFullYear()}-${mm}.jsonl`
  }

  private async rotateIfNeeded(petId: string): Promise<void> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return
    const stat = await fs.stat(file)
    if (stat.size < this.maxBytes) return
    const archive = path.join(this.petDir(petId), this.archiveName())
    if (fsSync.existsSync(archive)) {
      const tail = await fs.readFile(file, 'utf-8')
      await fs.appendFile(archive, tail, 'utf-8')
      await fs.unlink(file)
    } else {
      await fs.rename(file, archive)
    }
  }

  async append(petId: string, ev: Omit<PetEvent, 'id' | 'ts'>): Promise<string> {
    const full: PetEvent = { id: randomUUID(), ts: Date.now(), ...ev }
    const dir = this.petDir(petId)
    await fs.mkdir(dir, { recursive: true })
    await this.rotateIfNeeded(petId)
    await fs.appendFile(this.activeFile(petId), JSON.stringify(full) + '\n', 'utf-8')
    this.notify(petId, full)
    return full.id
  }

  async recent(petId: string, n: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    return tail.map(l => JSON.parse(l) as PetEvent).reverse()
  }

  async range(petId: string, fromTs: number, toTs: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const out: PetEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      const ev = JSON.parse(line) as PetEvent
      if (ev.ts >= fromTs && ev.ts <= toTs) out.push(ev)
    }
    return out
  }

  async byType(petId: string, type: PetEvent['type'], limit: number): Promise<PetEvent[]> {
    const file = this.activeFile(petId)
    if (!fsSync.existsSync(file)) return []
    const raw = await fs.readFile(file, 'utf-8')
    const out: PetEvent[] = []
    const lines = raw.split('\n').filter(Boolean)
    // 倒着扫，攒够 limit 就停
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const ev = JSON.parse(lines[i]) as PetEvent
      if (ev.type === type) out.push(ev)
    }
    return out
  }
}
