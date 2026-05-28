import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface ToolResult {
  tool:      string
  input:     Record<string, string>
  output:    string
  exitCode:  number
  durationMs: number
}

const BASH_TIMEOUT_MS  = 30_000
const MAX_OUTPUT_CHARS = 8192   // 8 KB cap per tool output
const MAX_BASH_LINES   = 500

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n... [truncated at ${MAX_OUTPUT_CHARS} chars, ${text.length - MAX_OUTPUT_CHARS} chars omitted]`
}

function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.platform === 'darwin' && env.LC_ALL === 'C.UTF-8') {
    env.LC_ALL = 'en_US.UTF-8'
  }
  return env
}

/**
 * Executes built-in tools for the agent loop.
 * All tools are auto-executed (no user confirmation required).
 */
export class ToolExecutor {
  constructor(private workdir: string) {}

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now()
    const strInput: Record<string, string> = {}
    for (const [k, v] of Object.entries(input)) {
      strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
    }

    try {
      switch (name) {
        case 'bash':       return await this.bash(strInput, start)
        case 'read_file':  return await this.readFile(strInput, start)
        case 'write_file': return await this.writeFile(strInput, start)
        case 'list_files': return await this.listFiles(strInput, start)
        case 'edit_file': return await this.editFile(strInput, start)
        case 'install_skill': return await this.installSkill(input, start)
        default:
          return { tool: name, input: strInput, output: `Error: unknown tool "${name}"`, exitCode: 1, durationMs: 0 }
      }
    } catch (err) {
      return {
        tool: name, input: strInput,
        output: `Error: ${(err as Error).message}`,
        exitCode: 1, durationMs: Date.now() - start
      }
    }
  }

  private bash(input: Record<string, string>, start: number): Promise<ToolResult> {
    const command = input.command ?? ''
    const cwd = input.workdir || this.workdir

    // Safety: block extremely dangerous commands
    const DANGEROUS_RX = /\b(rm\s+-rf\s+[\/~]|rm\s+-[a-z]*r[a-z]*f[\/~]|mkfs\.|dd\s+if=|:(){ :\|:& };:|sudo\s+rm|git\s+push\s+(-f|--force)|git\s+reset\s+--hard)\b/
    if (DANGEROUS_RX.test(command)) {
      return Promise.resolve({
        tool: 'bash', input, exitCode: 126,
        output: `BLOCKED: 这个命令被认为有危险，已阻止执行。\n如果你确实需要执行，请直接告诉用户你要做什么，让用户确认后再重试。`,
        durationMs: 0
      })
    }

    return new Promise(resolve => {
      const proc = spawn('bash', ['-c', command], {
        cwd, env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d })
      proc.stderr.on('data', (d: Buffer) => { stderr += d })

      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        resolve({
          tool: 'bash', input, exitCode: 124,
          output: `timeout: command killed after ${BASH_TIMEOUT_MS / 1000}s`,
          durationMs: Date.now() - start
        })
      }, BASH_TIMEOUT_MS)

      proc.on('close', code => {
        clearTimeout(timer)
        let output = stdout + (stderr ? '\n[stderr] ' + stderr : '')
        const lines = output.split('\n')
        if (lines.length > MAX_BASH_LINES) {
          const head = lines.slice(0, 200).join('\n')
          const tail = lines.slice(-200).join('\n')
          output = `${head}\n\n... [${lines.length - 400} lines omitted] ...\n\n${tail}`
        }
        resolve({
          tool: 'bash', input,
          output: truncate(output),
          exitCode: code ?? 1,
          durationMs: Date.now() - start
        })
      })

      proc.on('error', err => {
        clearTimeout(timer)
        resolve({
          tool: 'bash', input, exitCode: 1,
          output: `spawn error: ${err.message}`,
          durationMs: Date.now() - start
        })
      })
    })
  }

  private async readFile(input: Record<string, string>, start: number): Promise<ToolResult> {
    const fp = input.path ?? ''
    try {
      const content = await fs.readFile(fp, 'utf-8')
      return { tool: 'read_file', input, output: truncate(content), exitCode: 0, durationMs: Date.now() - start }
    } catch (err) {
      return { tool: 'read_file', input, output: `Error: ${(err as Error).message}`, exitCode: 1, durationMs: Date.now() - start }
    }
  }

  private async writeFile(input: Record<string, string>, start: number): Promise<ToolResult> {
    const fp = input.path ?? ''
    const content = input.content ?? ''
    try {
      // Preview: show old vs new if file exists
      let preview = ''
      try {
        const old = await fs.readFile(fp, 'utf-8')
        if (old !== content) {
          const oldLines = old.split('\n')
          const newLines = content.split('\n')
          const diffLines: string[] = []
          const maxLines = Math.max(oldLines.length, newLines.length)
          for (let i = 0; i < Math.min(maxLines, 20); i++) {
            if (oldLines[i] !== newLines[i]) {
              if (oldLines[i] !== undefined) diffLines.push(`- ${oldLines[i]}`)
              if (newLines[i] !== undefined) diffLines.push(`+ ${newLines[i]}`)
            }
          }
          if (maxLines > 20) diffLines.push(`... (${maxLines - 20} more lines)`)
          preview = diffLines.length > 0
            ? `**Preview diff (${fp}):**\n\`\`\`diff\n${diffLines.join('\n')}\n\`\`\`\n\n`
            : ''
        }
      } catch { /* file doesn't exist yet — no preview needed */ }

      await fs.mkdir(path.dirname(fp), { recursive: true })
      await fs.writeFile(fp, content, 'utf-8')
      return { tool: 'write_file', input, output: `${preview}OK: wrote ${content.length} bytes to ${fp}`, exitCode: 0, durationMs: Date.now() - start }
    } catch (err) {
      return { tool: 'write_file', input, output: `Error: ${(err as Error).message}`, exitCode: 1, durationMs: Date.now() - start }
    }
  }

  private async listFiles(input: Record<string, string>, start: number): Promise<ToolResult> {
    const dirPath = input.path ?? this.workdir
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name)
      return { tool: 'list_files', input, output: truncate(lines.join('\n')), exitCode: 0, durationMs: Date.now() - start }
    } catch (err) {
      return { tool: 'list_files', input, output: `Error: ${(err as Error).message}`, exitCode: 1, durationMs: Date.now() - start }
    }
  }

  private async editFile(input: Record<string, string>, start: number): Promise<ToolResult> {
    const fp = input.path ?? ''
    const oldText = input.old_text ?? ''
    const newText = input.new_text ?? ''
    if (!oldText) return { tool: 'edit_file', input, output: 'Error: old_text is empty', exitCode: 1, durationMs: Date.now() - start }
    try {
      const content = await fs.readFile(fp, 'utf-8')
      if (!content.includes(oldText)) {
        return { tool: 'edit_file', input, output: `Error: old_text not found in ${fp}`, exitCode: 1, durationMs: Date.now() - start }
      }
      const updated = content.replace(oldText, newText)
      await fs.writeFile(fp, updated, 'utf-8')
      return { tool: 'edit_file', input, output: `OK: replaced in ${fp} (${content.length} → ${updated.length} bytes)`, exitCode: 0, durationMs: Date.now() - start }
    } catch (err) {
      return { tool: 'edit_file', input, output: `Error: ${(err as Error).message}`, exitCode: 1, durationMs: Date.now() - start }
    }
  }

  private async installSkill(input: Record<string, unknown>, start: number): Promise<ToolResult> {
    const s = (k: string) => typeof input[k] === 'string' ? input[k] as string : ''
    const triggers = Array.isArray(input.triggers) ? (input.triggers as string[]) : []
    const name = s('name')
    const description = s('description')
    const content = s('content')
    if (!name || !description || triggers.length === 0 || !content) {
      return { tool: 'install_skill', input: {}, output: 'Error: name, description, triggers, content 都是必填的', exitCode: 1, durationMs: 0 }
    }

    const skillDir = path.join(os.homedir(), '.mote', 'skills')
    const skillFile = path.join(skillDir, `${name}.md`)

    // Build YAML frontmatter
    const triggersYaml = triggers.map(t => `  - ${t}`).join('\n')
    const fileContent = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'triggers:',
      triggersYaml,
      '---',
      '',
      content
    ].join('\n')

    try {
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(skillFile, fileContent, 'utf-8')
      const strInput: Record<string, string> = {}
      for (const [k, v] of Object.entries(input)) strInput[k] = typeof v === 'string' ? v : JSON.stringify(v ?? '')
      return { tool: 'install_skill', input: strInput, output: `OK: 已安装技能 ${name} 到 ${skillFile}。重启后在"设置→工具"里可见。`, exitCode: 0, durationMs: Date.now() - start }
    } catch (err) {
      return { tool: 'install_skill', input: {}, output: `Error: ${(err as Error).message}`, exitCode: 1, durationMs: Date.now() - start }
    }
  }
}
