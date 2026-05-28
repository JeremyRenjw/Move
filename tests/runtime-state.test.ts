import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { RuntimeState } from '../electron/runtime-state'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-rs-'))
}

describe('RuntimeState', () => {
  let home: string
  let rs: RuntimeState

  beforeEach(() => { home = tmpHome(); rs = new RuntimeState(home) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('wrapperPath returns path under ~/.mote/bin/event', () => {
    expect(rs.wrapperPath).toBe(path.join(home, '.mote', 'bin', 'event'))
  })

  it('eventsDir returns ~/.mote/events', () => {
    expect(rs.eventsDir).toBe(path.join(home, '.mote', 'events'))
  })

  it('ensureWrapper() writes script with chmod 755 and parseable shebang', () => {
    rs.ensureWrapper()
    const file = path.join(home, '.mote', 'bin', 'event')
    const body = fs.readFileSync(file, 'utf-8')
    expect(body.startsWith('#!/bin/sh')).toBe(true)
    expect(body).toContain('# mote-managed')
    expect(body).toContain('$HOME/.mote/events')
    expect(body).not.toContain('curl')
    expect(body).not.toContain('runtime.json')
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o755)
  })

  it('ensureWrapper() is idempotent and refreshes content if outdated', () => {
    rs.ensureWrapper()
    const file = path.join(home, '.mote', 'bin', 'event')
    fs.writeFileSync(file, '#!/bin/sh\necho stale\n')
    rs.ensureWrapper()
    expect(fs.readFileSync(file, 'utf-8')).toContain('$HOME/.mote/events')
  })
})
