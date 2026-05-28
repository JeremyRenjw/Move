import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { PlaybookStore } from '../electron/playbook-store'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-pb-')) }

const SAMPLE_BODY = '# 怎么做\n\n1. 列出文件\n2. 删除\n'
const SAMPLE_META = {
  id: 'pb-cleanup-downloads',
  title: '清理 Downloads 里的旧 zip',
  triggers: [
    '用户提到"清理"+"Downloads"',
    '用户提到"~/Downloads"+"满了"',
  ],
  created: '2026-05-25',
  confidence: 0.7,
}

describe('PlaybookStore', () => {
  let dir: string
  let store: PlaybookStore

  beforeEach(() => { dir = tmp(); store = new PlaybookStore(dir) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('creates a playbook file with correct frontmatter', async () => {
    const id = await store.create(SAMPLE_META, SAMPLE_BODY)
    expect(id).toBe('pb-cleanup-downloads')

    const raw = fs.readFileSync(path.join(dir, 'playbooks', 'cleanup-downloads.md'), 'utf-8')
    expect(raw).toContain('id: pb-cleanup-downloads')
    expect(raw).toContain('title: 清理 Downloads 里的旧 zip')
    expect(raw).toContain('  - 用户提到"清理"+"Downloads"')
    expect(raw).toContain('uses: 0')
    expect(raw).toContain('last_used: null')
    expect(raw).toContain('enabled: true')
    expect(raw).toContain('confidence: 0.7')
    expect(raw).toContain(SAMPLE_BODY)
  })

  it('list returns all playbooks sorted by created desc', async () => {
    await store.create({ ...SAMPLE_META, id: 'pb-a', created: '2026-05-01' }, 'body a')
    await store.create({ ...SAMPLE_META, id: 'pb-b', created: '2026-05-20' }, 'body b')
    await store.create({ ...SAMPLE_META, id: 'pb-c', created: '2026-05-10' }, 'body c')

    const list = await store.list()
    expect(list).toHaveLength(3)
    expect(list[0].id).toBe('pb-b')  // newest first
    expect(list[1].id).toBe('pb-c')
    expect(list[2].id).toBe('pb-a')
  })

  it('get returns full Playbook with body', async () => {
    await store.create(SAMPLE_META, SAMPLE_BODY)
    const pb = await store.get('pb-cleanup-downloads')
    expect(pb).not.toBeNull()
    expect(pb!.id).toBe('pb-cleanup-downloads')
    expect(pb!.body).toBe(SAMPLE_BODY)
    expect(pb!.triggers).toHaveLength(2)
    expect(pb!.uses).toBe(0)
    expect(pb!.enabled).toBe(true)
  })

  it('get returns null for nonexistent id', async () => {
    const pb = await store.get('pb-does-not-exist')
    expect(pb).toBeNull()
  })

  it('updateStats increments uses and updates last_used', async () => {
    await store.create(SAMPLE_META, SAMPLE_BODY)
    await store.updateStats('pb-cleanup-downloads')
    await store.updateStats('pb-cleanup-downloads')

    const pb = await store.get('pb-cleanup-downloads')
    expect(pb!.uses).toBe(2)
    expect(pb!.last_used).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('disable sets enabled to false', async () => {
    await store.create(SAMPLE_META, SAMPLE_BODY)
    await store.disable('pb-cleanup-downloads')

    const pb = await store.get('pb-cleanup-downloads')
    expect(pb!.enabled).toBe(false)

    // disabled playbook should not appear in default list
    const list = await store.list()
    expect(list).toHaveLength(0)

    // but should appear with enabledOnly: false
    const all = await store.list({ enabledOnly: false })
    expect(all).toHaveLength(1)
  })

  it('search matches triggers by keyword', async () => {
    await store.create(SAMPLE_META, SAMPLE_BODY)
    await store.create({
      id: 'pb-other',
      title: '其他 playbook',
      triggers: ['用户说"备份"+"照片"'],
      created: '2026-05-20',
      confidence: 0.9,
    }, 'body other')

    const results = await store.search('清理 Downloads')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('pb-cleanup-downloads')
  })

  it('search returns empty when no match', async () => {
    await store.create(SAMPLE_META, SAMPLE_BODY)
    const results = await store.search('不存在的关键词')
    expect(results).toEqual([])
  })
})
