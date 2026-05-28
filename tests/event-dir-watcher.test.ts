import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { EventDirWatcher } from '../electron/event-dir-watcher'
import type { NotifyEvent } from '../src-shared/types'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-edw-'))
}

function writeEvent(dir: string, ev: Partial<NotifyEvent>): string {
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify(ev))
  return file
}

describe('EventDirWatcher', () => {
  let dir: string
  let received: NotifyEvent[]
  let watcher: EventDirWatcher

  beforeEach(() => {
    dir = tmpDir()
    received = []
    watcher = new EventDirWatcher(dir, ev => received.push(ev))
  })

  afterEach(() => {
    watcher.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('processes existing files on start', () => {
    writeEvent(dir, { event: 'Stop', tool: 'claude', cwd: '/x', ts: 1 })
    writeEvent(dir, { event: 'SessionStart', tool: 'codex', cwd: '/y', ts: 2 })
    watcher.start()
    expect(received.length).toBe(2)
    const events = received.map(e => e.event).sort()
    expect(events).toEqual(['SessionStart', 'Stop'])
    // Files should be deleted after processing
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(0)
  })

  it('processes new files written after start', async () => {
    watcher.start()
    writeEvent(dir, { event: 'Stop', tool: 'claude', cwd: '/z', ts: 3 })
    // Wait for fs.watch debounce (100ms + buffer)
    await new Promise(r => setTimeout(r, 300))
    expect(received.length).toBe(1)
    expect(received[0].tool).toBe('claude')
  })

  it('ignores files with missing event/tool fields', () => {
    writeEvent(dir, { event: 'Stop' }) // missing tool
    writeEvent(dir, { tool: 'claude' }) // missing event
    watcher.start()
    expect(received.length).toBe(0)
    // Files still get cleaned up
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(0)
  })

  it('ignores non-json files', () => {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello')
    watcher.start()
    expect(received.length).toBe(0)
    // Non-json files are left alone
    expect(fs.existsSync(path.join(dir, 'readme.txt'))).toBe(true)
  })

  it('writeEvent() creates a valid event file', () => {
    watcher.writeEvent({ event: 'Stop', tool: 'test', cwd: '/tmp', ts: 99 })
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    expect(files.length).toBe(1)
    const ev = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'))
    expect(ev.event).toBe('Stop')
    expect(ev.tool).toBe('test')
  })

  it('creates events directory if missing', () => {
    const subDir = path.join(dir, 'events')
    const w = new EventDirWatcher(subDir, () => {})
    w.start()
    expect(fs.existsSync(subDir)).toBe(true)
    w.stop()
  })
})
