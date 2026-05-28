import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn()
}))

import { CliRunner } from '../electron/runner'
import { spawn, execSync } from 'child_process'

function makeProc(stdout: string[], exitCode = 0) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setTimeout(() => {
    stdout.forEach(line => proc.stdout.emit('data', Buffer.from(line + '\n')))
    proc.emit('close', exitCode)
  }, 10)
  return proc
}

describe('CliRunner', () => {
  it('runs claude and collects output', async () => {
    vi.mocked(spawn).mockReturnValueOnce(makeProc(['line 1', 'line 2']) as any)
    const runner = new CliRunner()
    const lines: string[] = []
    const result = await runner.run('claude', ['--print', 'hello'], {
      onLine: l => lines.push(l)
    })
    expect(lines).toEqual(['line 1', 'line 2'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('line 1')
  })

  it('rejects with timeout error when process hangs', async () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.pid = 1234
    vi.mocked(spawn).mockReturnValueOnce(proc)
    vi.mocked(execSync).mockImplementation(() => {})
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    try {
      const runner = new CliRunner({ timeoutMs: 50 })
      await expect(
        runner.run('claude', ['--print', 'hang'], {})
      ).rejects.toThrow('timeout')
      expect(execSync).toHaveBeenCalledWith('taskkill /F /T /PID 1234')
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true
      })
    }
  })
})
