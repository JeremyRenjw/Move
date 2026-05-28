import { describe, it, expect } from 'vitest'
import { parseFactsBlock, stripFactsBlock } from '../electron/ai'

describe('parseFactsBlock', () => {
  it('extracts a JSON array of facts from a fenced code block', () => {
    const text = `
- 用户偏好 dark mode
- 在做宠物 app

\`\`\`facts
[
  {"type":"preference","content":"喜欢 dark mode","confidence":0.9},
  {"type":"project","content":"在做宠物 app","confidence":0.95}
]
\`\`\`
`
    const out = parseFactsBlock(text)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('preference')
    expect(out[0].confidence).toBe(0.9)
    expect(out[1].content).toBe('在做宠物 app')
  })

  it('returns [] when no facts block', () => {
    expect(parseFactsBlock('just markdown')).toEqual([])
  })

  it('returns [] when block has invalid JSON', () => {
    const text = '```facts\nnot json\n```'
    expect(parseFactsBlock(text)).toEqual([])
  })

  it('filters out entries with unknown type', () => {
    const text = '```facts\n[{"type":"weird","content":"x","confidence":1}]\n```'
    expect(parseFactsBlock(text)).toEqual([])
  })

  it('clamps confidence into [0,1]', () => {
    const text = '```facts\n[{"type":"event","content":"x","confidence":2}]\n```'
    const out = parseFactsBlock(text)
    expect(out[0].confidence).toBe(1)
  })

  it('strips facts block from markdown for the human-readable part', () => {
    const text = `头部
\`\`\`facts
[{"type":"event","content":"x","confidence":0.5}]
\`\`\`
尾部`
    const out = parseFactsBlock(text)
    expect(out).toHaveLength(1)
  })
})

describe('stripFactsBlock', () => {
  it('removes the fenced facts block, keeps surrounding markdown', async () => {
    const text = `头部内容

\`\`\`facts
[{"type":"event","content":"x","confidence":0.5}]
\`\`\`

尾部内容`
    const out = stripFactsBlock(text)
    expect(out).toContain('头部内容')
    expect(out).toContain('尾部内容')
    expect(out).not.toContain('facts')
    expect(out).not.toContain('```')
  })
})
