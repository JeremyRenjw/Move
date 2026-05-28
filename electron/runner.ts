import { spawn, execSync } from 'child_process'

interface RunOptions {
  onLine?: (line: string) => void
  onWaiting?: (lastLine: string) => void
  workdir?: string
  interactive?: boolean  // keep stdin open for the lifetime of the process
}

interface RunResult {
  exitCode: number
  output: string
}

export interface RunHandle {
  done: Promise<RunResult>
  writeInput: (text: string) => void
  abort: () => void
  then: Promise<RunResult>['then']
  catch: Promise<RunResult>['catch']
  finally: Promise<RunResult>['finally']
}

interface RunnerConfig {
  timeoutMs?: number
  silenceMs?: number  // how long without stdout before checking for a prompt
}

function looksLikePrompt(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/[?？]\s*$/.test(trimmed)) return true
  if (/\[[yY]\/[nN]\]|\[[nN]\/[yY]\]|\(y\/n\)|y\/n|yes\/no/i.test(trimmed)) return true
  if (/(请|please).*(确认|输入|选择|continue|confirm)/i.test(trimmed)) return true
  if (/(continue|confirm|proceed)\s*\??$/i.test(trimmed)) return true
  return false
}

export class CliRunner {
  private timeoutMs: number
  private silenceMs: number

  constructor(config: RunnerConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 5 * 60 * 1000
    this.silenceMs = config.silenceMs ?? 4000
  }

  private killProcessTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`)
      } else {
        process.kill(-pid, 'SIGTERM')
      }
    } catch { /* already exited */ }
  }

  run(cmd: string, args: string[], opts: RunOptions): RunHandle {
    const proc = spawn(cmd, args, {
      cwd:   opts.workdir,
      shell: false,
      env:   { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // Most CLI invocations (claude --print, codex --print) are one-shot and won't
    // need stdin. Without closing it, they may block waiting for input that never
    // comes. The interactive flag opts back in for L3 stdin handoff.
    if (!opts.interactive) proc.stdin?.end?.()

    let output = ''
    let lastLine = ''
    let lastOutputAt = Date.now()
    let waitingNotified = false

    const done = new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (proc.pid) this.killProcessTree(proc.pid)
        reject(new Error(`CLI task timeout after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const idleTimer = setInterval(() => {
        if (waitingNotified) return
        const idle = Date.now() - lastOutputAt
        if (idle >= this.silenceMs && lastLine && looksLikePrompt(lastLine)) {
          waitingNotified = true
          opts.onWaiting?.(lastLine)
        }
      }, 1000)

      const onData = (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          output += line + '\n'
          lastLine = line
          lastOutputAt = Date.now()
          waitingNotified = false  // reset on any new output
          opts.onLine?.(line)
        }
      }

      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)
      proc.on('close', exitCode => {
        clearTimeout(timer)
        clearInterval(idleTimer)
        resolve({ exitCode: exitCode ?? 1, output })
      })
      proc.on('error', err => {
        clearTimeout(timer)
        clearInterval(idleTimer)
        reject(err)
      })
    })

    const handle = {
      done,
      writeInput: (text: string) => {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(text.endsWith('\n') ? text : text + '\n')
          waitingNotified = false
          lastOutputAt = Date.now()  // pretend we got output to reset idle timer
        }
      },
      abort: () => {
        if (proc.pid) this.killProcessTree(proc.pid)
      },
      then: done.then.bind(done),
      catch: done.catch.bind(done),
      finally: done.finally.bind(done)
    }
    return handle
  }
}
