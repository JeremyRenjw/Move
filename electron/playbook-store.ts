import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

export interface PlaybookMeta {
  id:         string
  title:      string
  triggers:   string[]
  created:    string   // YYYY-MM-DD
  uses:       number
  last_used:  string | null
  confidence: number
  enabled:    boolean
}

export interface Playbook extends PlaybookMeta {
  body: string
}

const PLAYBOOKS_DIR = 'playbooks'

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const lines = raw.split('\n')
  // find first ---
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; continue }
      end = i; break
    }
  }
  if (start === -1 || end === -1) return { meta: {}, body: raw }

  const meta: Record<string, unknown> = {}
  const triggerLines: string[] = []
  let inTriggers = false

  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    if (trimmed.startsWith('- ') && inTriggers) {
      triggerLines.push(trimmed.slice(2).trim())
      continue
    }
    inTriggers = false
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (key === 'triggers') {
      inTriggers = true
      // triggers may have inline value or be followed by list items
      if (val) triggerLines.push(val)
      continue
    }
    if (val === 'null')       { meta[key] = null; continue }
    if (val === 'true')       { meta[key] = true; continue }
    if (val === 'false')      { meta[key] = false; continue }
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) { meta[key] = val; continue }
    const num = Number(val)
    if (!isNaN(num) && val !== '') { meta[key] = num; continue }
    meta[key] = val
  }

  if (triggerLines.length) meta.triggers = triggerLines
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '')
  return { meta, body }
}

function serializeFrontmatter(meta: PlaybookMeta, body: string): string {
  const lines = ['---']
  lines.push(`id: ${meta.id}`)
  lines.push(`title: ${meta.title}`)
  lines.push('triggers:')
  for (const t of meta.triggers) lines.push(`  - ${t}`)
  lines.push(`created: ${meta.created}`)
  lines.push(`uses: ${meta.uses}`)
  lines.push(`last_used: ${meta.last_used ?? 'null'}`)
  lines.push(`confidence: ${meta.confidence}`)
  lines.push(`enabled: ${meta.enabled}`)
  lines.push('---')
  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

function slugFromId(id: string): string {
  return id.replace(/^pb-/, '')
}

function idFromFilename(filename: string): string {
  const slug = filename.replace(/\.md$/, '')
  return slug.startsWith('pb-') ? slug : `pb-${slug}`
}

function todayStr(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export class PlaybookStore {
  constructor(private root: string) {}

  private playbooksDir(): string {
    return path.join(this.root, PLAYBOOKS_DIR)
  }

  private filePath(id: string): string {
    return path.join(this.playbooksDir(), `${slugFromId(id)}.md`)
  }

  private async readFile(id: string): Promise<{ meta: PlaybookMeta; body: string } | null> {
    const fp = this.filePath(id)
    if (!fsSync.existsSync(fp)) return null
    const raw = await fs.readFile(fp, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)
    return {
      meta: {
        id:         (meta.id as string) ?? id,
        title:      (meta.title as string) ?? '',
        triggers:   (meta.triggers as string[]) ?? [],
        created:    (meta.created as string) ?? '',
        uses:       (meta.uses as number) ?? 0,
        last_used:  (meta.last_used as string | null) ?? null,
        confidence: (meta.confidence as number) ?? 0,
        enabled:    (meta.enabled as boolean) ?? true,
      },
      body,
    }
  }

  private async write(id: string, meta: PlaybookMeta, body: string): Promise<void> {
    await fs.mkdir(this.playbooksDir(), { recursive: true })
    await fs.writeFile(this.filePath(id), serializeFrontmatter(meta, body), 'utf-8')
  }

  async create(
    meta: Omit<PlaybookMeta, 'uses' | 'last_used' | 'enabled'>,
    body: string,
  ): Promise<string> {
    const full: PlaybookMeta = { ...meta, uses: 0, last_used: null, enabled: true }
    await this.write(full.id, full, body)
    return full.id
  }

  async list(opts?: { enabledOnly?: boolean }): Promise<PlaybookMeta[]> {
    const dir = this.playbooksDir()
    if (!fsSync.existsSync(dir)) return []
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.md'))
    const results: PlaybookMeta[] = []
    for (const f of files) {
      const id = idFromFilename(f)
      const parsed = await this.readFile(id)
      if (!parsed) continue
      if (opts?.enabledOnly !== false && !parsed.meta.enabled) continue
      results.push(parsed.meta)
    }
    results.sort((a, b) => b.created.localeCompare(a.created))
    return results
  }

  async get(id: string): Promise<Playbook | null> {
    const parsed = await this.readFile(id)
    if (!parsed) return null
    return { ...parsed.meta, body: parsed.body }
  }

  async updateStats(id: string): Promise<void> {
    const parsed = await this.readFile(id)
    if (!parsed) return
    parsed.meta.uses += 1
    parsed.meta.last_used = todayStr()
    await this.write(id, parsed.meta, parsed.body)
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    const parsed = await this.readFile(id)
    if (!parsed) return
    parsed.meta.confidence = confidence
    await this.write(id, parsed.meta, parsed.body)
  }

  async disable(id: string): Promise<void> {
    const parsed = await this.readFile(id)
    if (!parsed) return
    parsed.meta.enabled = false
    await this.write(id, parsed.meta, parsed.body)
  }

  async search(query: string, opts?: { topK?: number }): Promise<Playbook[]> {
    const topK = opts?.topK ?? 3
    const words = query.split(/\s+/).filter(Boolean).map(w => w.toLowerCase())
    const all = await this.list({ enabledOnly: true })
    const matches: Playbook[] = []
    for (const meta of all) {
      const triggerText = meta.triggers.map(t => t.toLowerCase()).join(' ')
      if (words.some(w => triggerText.includes(w))) {
        const full = await this.get(meta.id)
        if (full) matches.push(full)
      }
    }
    matches.sort((a, b) => b.confidence - a.confidence)
    return matches.slice(0, topK)
  }
}
