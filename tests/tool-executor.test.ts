import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ToolExecutor } from '../electron/tool-executor'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mote-te-')) }

describe('ToolExecutor', () => {
  let dir: string
  let exec: ToolExecutor

  beforeEach(() => { dir = tmp(); exec = new ToolExecutor(dir) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  describe('bash', () => {
    it('runs a command and returns output', async () => {
      const r = await exec.execute('bash', { command: 'echo hello' })
      expect(r.output.trim()).toBe('hello')
      expect(r.exitCode).toBe(0)
      expect(r.durationMs).toBeGreaterThan(0)
    })

    it('respects exit code on failure', async () => {
      const r = await exec.execute('bash', { command: 'exit 42' })
      expect(r.exitCode).toBe(42)
    })

    it('captures stderr', async () => {
      const r = await exec.execute('bash', { command: 'echo oops >&2' })
      expect(r.output).toContain('oops')
    })

    it('times out after 30s', async () => {
      const r = await exec.execute('bash', { command: 'sleep 60' })
      expect(r.exitCode).not.toBe(0)
      expect(r.output).toMatch(/timeout|TIMEOUT|killed/i)
    }, 35000)
  })

  describe('read_file', () => {
    it('reads an existing file', async () => {
      fs.writeFileSync(path.join(dir, 'a.txt'), '你好世界')
      const r = await exec.execute('read_file', { path: path.join(dir, 'a.txt') })
      expect(r.output).toBe('你好世界')
      expect(r.exitCode).toBe(0)
    })

    it('returns error for missing file', async () => {
      const r = await exec.execute('read_file', { path: '/nonexistent' })
      expect(r.exitCode).not.toBe(0)
      expect(r.output).toMatch(/ENOENT|no such file/i)
    })
  })

  describe('write_file', () => {
    it('creates a file', async () => {
      const fp = path.join(dir, 'out.txt')
      const r = await exec.execute('write_file', { path: fp, content: 'test content' })
      expect(r.exitCode).toBe(0)
      expect(fs.readFileSync(fp, 'utf-8')).toBe('test content')
    })

    it('creates parent directories', async () => {
      const fp = path.join(dir, 'sub', 'deep', 'file.txt')
      const r = await exec.execute('write_file', { path: fp, content: 'nested' })
      expect(r.exitCode).toBe(0)
      expect(fs.readFileSync(fp, 'utf-8')).toBe('nested')
    })

    it('overwrites existing file', async () => {
      const fp = path.join(dir, 'ow.txt')
      fs.writeFileSync(fp, 'old')
      await exec.execute('write_file', { path: fp, content: 'new' })
      expect(fs.readFileSync(fp, 'utf-8')).toBe('new')
    })
  })

  describe('list_files', () => {
    it('lists directory contents', async () => {
      fs.writeFileSync(path.join(dir, 'a.txt'), '')
      fs.writeFileSync(path.join(dir, 'b.json'), '{}')
      fs.mkdirSync(path.join(dir, 'sub'))
      const r = await exec.execute('list_files', { path: dir })
      expect(r.output).toContain('a.txt')
      expect(r.output).toContain('b.json')
      expect(r.output).toContain('sub/')
      expect(r.exitCode).toBe(0)
    })

    it('returns error for missing dir', async () => {
      const r = await exec.execute('list_files', { path: '/nonexistent' })
      expect(r.exitCode).not.toBe(0)
    })
  })

  describe('unknown tool', () => {
    it('returns error', async () => {
      const r = await exec.execute('unknown_tool', {})
      expect(r.exitCode).not.toBe(0)
      expect(r.output).toMatch(/unknown|unsupported/i)
    })
  })
})
