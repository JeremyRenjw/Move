import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { default: fs.promises }
})

import { CleanupEngine } from '../electron/cleanup'

beforeEach(async () => {
  const { vol } = await import('memfs')
  vol.reset()
  vol.fromJSON({
    '/tmp/file1.tmp': 'a'.repeat(1000),
    '/tmp/file2.tmp': 'b'.repeat(2000),
    '/tmp/subdir/file3.tmp': 'c'.repeat(500)
  })
})

describe('CleanupEngine', () => {
  it('scans directory and calculates total size', async () => {
    const engine = new CleanupEngine(['/tmp'])
    const items = await engine.scan()
    const total = items.reduce((s, i) => s + i.size, 0)
    expect(total).toBe(3500)
    expect(items.length).toBeGreaterThan(0)
  })

  it('deletes specified paths', async () => {
    const engine = new CleanupEngine(['/tmp'])
    await engine.execute(['/tmp/file1.tmp'])
    const fs = await import('fs/promises')
    await expect(
      (fs.default as any).access('/tmp/file1.tmp')
    ).rejects.toThrow()
  })
})
