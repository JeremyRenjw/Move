import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import matter from 'gray-matter'

export interface Skill {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  body: string
  source: 'builtin' | 'user'
}

async function scanDir(dir: string, source: 'builtin' | 'user'): Promise<Skill[]> {
  if (!fsSync.existsSync(dir)) return []

  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.md'))
  } catch {
    return []
  }

  const skills: Skill[] = []
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8')
      const parsed = matter(raw)
      const data = parsed.data as Record<string, unknown>

      if (!data.name || !data.triggers || !Array.isArray(data.triggers)) continue

      skills.push({
        name: String(data.name),
        description: String(data.description ?? ''),
        triggers: (data.triggers as unknown[]).map(String),
        tools: Array.isArray(data.tools) ? (data.tools as unknown[]).map(String) : [],
        body: parsed.content.replace(/^\n/, ''),
        source,
      })
    } catch {
      // skip files with invalid frontmatter or read errors
    }
  }

  return skills
}

export class SkillStore {
  private skills: Skill[] = []
  private builtinDir: string
  private userDir: string

  constructor(builtinDir: string, userDir: string) {
    this.builtinDir = builtinDir
    this.userDir = userDir
  }

  async init(): Promise<void> {
    const [builtin, user] = await Promise.all([
      scanDir(this.builtinDir, 'builtin'),
      scanDir(this.userDir, 'user'),
    ])
    this.skills = [...builtin, ...user]
  }

  async reload(): Promise<void> {
    await this.init()
  }

  match(userMessage: string): Skill[] {
    const lower = userMessage.toLowerCase()
    return this.skills.filter(skill =>
      skill.triggers.some(t => lower.includes(t.toLowerCase())),
    )
  }

  list(): Skill[] {
    return [...this.skills]
  }
}
