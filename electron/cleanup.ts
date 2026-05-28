import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { CleanupItem } from '@shared/types'

export function defaultCacheDirs(): string[] {
  return process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Caches')]
    : [os.tmpdir(), path.join(os.homedir(), 'AppData', 'Local', 'Temp')]
}

export class CleanupEngine {
  constructor(private dirs: string[]) {}

  async scan(): Promise<CleanupItem[]> {
    const items: CleanupItem[] = []
    for (const dir of this.dirs) {
      await this.walk(dir, items)
    }
    return items
  }

  private async walk(dir: string, out: CleanupItem[]): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          await this.walk(full, out)
        } else {
          try {
            const stat = await fs.stat(full)
            out.push({ path: full, size: stat.size, label: path.relative(this.dirs[0], full) })
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  async execute(paths: string[]): Promise<void> {
    await Promise.all(paths.map(p => fs.rm(p, { force: true, recursive: true })))
  }
}
