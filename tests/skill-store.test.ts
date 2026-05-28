import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SkillStore } from '../electron/skill-store'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-sk-')) }

const GIT_SKILL = `---
name: git-helper
description: Git 操作指导
triggers:
  - git
  - commit
  - branch
  - merge
---

# Git Helper

你是一个 Git 专家。先用 git status 看状态。
`

const BACKUP_SKILL = `---
name: backup-helper
description: 备份操作指导
triggers:
  - backup
  - restore
tools:
  - shell
  - file-manager
---

# Backup Helper

备份重要文件。
`

const INVALID_FRONTMATTER = `---
name: {broken
  not: valid: yaml
---

# Invalid
`

describe('SkillStore', () => {
  let builtinDir: string
  let userDir: string
  let store: SkillStore

  beforeEach(() => {
    builtinDir = tmp()
    userDir = tmp()
  })

  afterEach(() => {
    fs.rmSync(builtinDir, { recursive: true, force: true })
    fs.rmSync(userDir, { recursive: true, force: true })
  })

  it('loads skills from builtin and user directories', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)
    fs.writeFileSync(path.join(userDir, 'backup.md'), BACKUP_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const skills = store.list()
    expect(skills).toHaveLength(2)
    expect(skills.map(s => s.name).sort()).toEqual(['backup-helper', 'git-helper'])
  })

  it('matches skills by trigger keywords', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const matches = store.match('how to commit my changes')
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('git-helper')
  })

  it('matches multiple skills', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)
    fs.writeFileSync(path.join(userDir, 'backup.md'), BACKUP_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const matches = store.match('how to commit and backup')
    expect(matches).toHaveLength(2)
    expect(matches.map(s => s.name).sort()).toEqual(['backup-helper', 'git-helper'])
  })

  it('returns empty array when no triggers match', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const matches = store.match('tell me about cooking')
    expect(matches).toEqual([])
  })

  it('case insensitive matching', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    expect(store.match('GIT status')).toHaveLength(1)
    expect(store.match('Commit changes')).toHaveLength(1)
    expect(store.match('merge branches')).toHaveLength(1)
  })

  it('marks source as builtin or user', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)
    fs.writeFileSync(path.join(userDir, 'backup.md'), BACKUP_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const skills = store.list()
    const gitSkill = skills.find(s => s.name === 'git-helper')!
    const backupSkill = skills.find(s => s.name === 'backup-helper')!

    expect(gitSkill.source).toBe('builtin')
    expect(backupSkill.source).toBe('user')
  })

  it('skips files with invalid frontmatter', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)
    fs.writeFileSync(path.join(builtinDir, 'bad.md'), INVALID_FRONTMATTER)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const skills = store.list()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('git-helper')
  })

  it('handles missing directories gracefully', async () => {
    const missingBuiltin = path.join(os.tmpdir(), 'missing-builtin-' + Date.now())
    const missingUser = path.join(os.tmpdir(), 'missing-user-' + Date.now())

    store = new SkillStore(missingBuiltin, missingUser)
    await store.init()

    expect(store.list()).toEqual([])
    expect(store.match('anything')).toEqual([])
  })

  it('reload refreshes skill list', async () => {
    fs.writeFileSync(path.join(builtinDir, 'git.md'), GIT_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()
    expect(store.list()).toHaveLength(1)

    // Add a new skill file
    fs.writeFileSync(path.join(userDir, 'backup.md'), BACKUP_SKILL)
    await store.reload()

    expect(store.list()).toHaveLength(2)
  })

  it('extracts tools from frontmatter', async () => {
    fs.writeFileSync(path.join(userDir, 'backup.md'), BACKUP_SKILL)

    store = new SkillStore(builtinDir, userDir)
    await store.init()

    const skill = store.list()[0]
    expect(skill.tools).toEqual(['shell', 'file-manager'])
  })
})
