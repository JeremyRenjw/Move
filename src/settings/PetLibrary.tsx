import { useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { GeneratePetInput, Pet } from '@shared/types'

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

// Pet color mapping (matches design)
const PET_COLORS: Record<string, { color: string; colorSoft: string; personality: string[]; desc: string }> = {
  stlulu: {
    color: '#e89534',
    colorSoft: '#fde7c4',
    personality: ['活泼', '可爱', '积极'],
    desc: '活泼的黄橙色小助手，喜欢咕咕叫，遇到 bug 会皱眉。'
  },
  taotao: {
    color: '#e8639c',
    colorSoft: '#fde0ec',
    personality: ['软萌', '害羞', '俏皮'],
    desc: '粉色外套的猫耳少女，话不多但会偷偷观察你写的代码。'
  },
}

function readableGenerateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  const cleaned = message
    .replace(/^Error invoking remote method 'pet:generate': Error:\s*/, '')
    .trim()
  if (cleaned.includes('Upstream request failed') || cleaned.includes('502')) {
    return '图片模型网关返回 502，未生成可用的宠物 spritesheet。请确认网关的 GPT Image 2 支持 /responses image_generation。'
  }
  if (cleaned.includes('1536x1872') || cleaned.includes('spritesheet')) {
    return cleaned
  }
  return cleaned || '生成失败'
}

export function PetLibrary() {
  const [pets, setPets] = useState<Pet[]>([])
  const [active, setActive] = useState<string>('')
  const [showGenerate, setShowGenerate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [generateForm, setGenerateForm] = useState<GeneratePetInput>({
    name: '',
    prompt: '',
    style: 'sticker',
  })

  useEffect(() => {
    window.ipc.invoke(IPC.PET_LIST).then(list => setPets(list as Pet[]))
    window.ipc.invoke(IPC.PET_GET_ACTIVE).then(id => {
      if (typeof id === 'string') setActive(id)
    })
  }, [])

  const select = async (petId: string) => {
    await window.ipc.invoke(IPC.PET_SWITCH, petId)
    setActive(petId)
  }

  const importPet = async () => {
    const dirPath = (await window.ipc.invoke('dialog:open-dir')) as string | null
    if (!dirPath) return
    try {
      const pet = (await window.ipc.invoke(IPC.PET_IMPORT, dirPath)) as Pet
      setPets(p => [...p, pet])
    } catch (e) {
      alert(`导入失败: ${(e as Error).message}`)
    }
  }

  const generatePet = async () => {
    setGenerateError('')
    setGenerating(true)
    try {
      const pet = (await window.ipc.invoke(IPC.PET_GENERATE, generateForm)) as Pet
      setPets(prev => {
        const rest = prev.filter(p => p.id !== pet.id)
        return [...rest, pet]
      })
      setActive(pet.id)
      setShowGenerate(false)
      setGenerateForm({ name: '', prompt: '', style: 'sticker' })
    } catch (e) {
      setGenerateError(readableGenerateError(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>宠物库</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
          切换当前宠物 · 导入兼容 Codex 格式 · 编辑独立角色
        </div>
      </div>

      <div style={{
        marginBottom: 14,
        padding: 12,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.46)',
        border: '0.5px solid var(--hairline)',
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>进化形态</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
            支持 baby / child / teen / adult / elder。宠物获得 XP 后会切换阶段；如果 pet.json 为不同阶段配置不同 spritesheet，外观会随阶段变化。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {['baby', 'child', 'teen', 'adult', 'elder'].map(stage => (
            <span key={stage} style={{
              height: 22,
              padding: '0 8px',
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              fontSize: 10,
              fontWeight: 600,
              background: 'var(--accent-soft)',
              color: 'var(--accent-2)',
              border: '0.5px solid var(--hairline)',
            }}>{stage}</span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        {pets.map(pet => {
          const isActive = pet.id === active
          const meta = PET_COLORS[pet.id] ?? { color: '#7c3aed', colorSoft: '#ede9fe', personality: [], desc: '' }
          return (
            <div key={pet.id} style={{
              background: 'var(--elev)',
              border: isActive ? `1.5px solid ${meta.color}` : '0.5px solid var(--hairline)',
              borderRadius: 14,
              padding: 12,
              position: 'relative',
              boxShadow: isActive ? `0 8px 24px ${meta.color}33` : 'var(--shadow-1)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
              onClick={() => select(pet.id)}
            >
              {isActive && (
                <div style={{
                  position: 'absolute', top: -7, right: 10,
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 7px', borderRadius: 999,
                  background: meta.color, color: '#fff',
                  textTransform: 'uppercase',
                }}>当前</div>
              )}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 12,
                  background: `linear-gradient(135deg, ${meta.colorSoft}, ${meta.colorSoft}aa)`,
                  overflow: 'hidden', flexShrink: 0,
                  border: '0.5px solid var(--hairline)',
                  display: 'grid', placeItems: 'center',
                }}>
                  {pet.spritesheetDataUrl && (() => {
                    const fw = pet.frameSize?.width ?? 80
                    const fh = pet.frameSize?.height ?? 80
                    const idle = pet.animations?.idle
                    const col = idle?.frames[0] ?? 0
                    const row = idle?.row ?? 0
                    const targetSize = 56
                    const scale = Math.min(targetSize / fw, targetSize / fh)
                    return (
                      <div style={{ width: fw * scale, height: fh * scale, overflow: 'hidden' }}>
                        <div style={{
                          width: fw, height: fh,
                          backgroundImage: `url(${pet.spritesheetDataUrl})`,
                          backgroundPosition: `${-(col * fw)}px ${-(row * fh)}px`,
                          backgroundRepeat: 'no-repeat',
                          imageRendering: pet.kind === 'generated' ? 'auto' as const : 'pixelated' as const,
                          transform: `scale(${scale})`,
                          transformOrigin: 'top left',
                        }} />
                      </div>
                    )
                  })()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{pet.displayName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4, marginTop: 2 }}>
                    {pet.description || meta.desc}
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                    {meta.personality.map(t => (
                      <div key={t} style={{
                        display: 'inline-flex', alignItems: 'center',
                        height: 18, padding: '0 7px',
                        borderRadius: 999, fontSize: 10, fontWeight: 500,
                        background: isActive ? 'var(--accent-soft)' : 'var(--hover)',
                        color: isActive ? 'var(--accent-2)' : 'var(--text-2)',
                        border: '0.5px solid var(--hairline)',
                      }}>{t}</div>
                    ))}
                  </div>
                </div>
              </div>
              {/* Intimacy bar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginTop: 10, paddingTop: 8,
                borderTop: '0.5px solid var(--separator)',
                fontSize: 10, color: 'var(--text-3)',
              }}>
                <span>亲密度</span>
                <div style={{ flex: 1, height: 4, background: 'var(--separator)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{
                    width: isActive ? '64%' : '12%',
                    height: '100%',
                    background: meta.color,
                    borderRadius: 999,
                    transition: 'width 0.3s',
                  }} />
                </div>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-2)' }}>
                  Lv.{isActive ? 7 : 1}
                </span>
              </div>
            </div>
          )
        })}

        {/* Import card */}
        <div
          onClick={importPet}
          style={{
            background: 'transparent',
            border: '1.5px dashed var(--hairline-strong)',
            borderRadius: 14,
            padding: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            minHeight: 130,
            color: 'var(--text-3)',
            cursor: 'pointer',
            transition: 'border-color 0.15s',
          }}
        >
          <div style={{ fontSize: 22, marginBottom: 4 }}>+</div>
          <div style={{ fontSize: 12, fontWeight: 500 }}>导入宠物</div>
          <div style={{ fontSize: 10, marginTop: 2, textAlign: 'center', maxWidth: 140 }}>
            选择含 pet.json + spritesheet 的目录
          </div>
        </div>

        {/* Generate card */}
        <div
          onClick={() => {
            setGenerateError('')
            setShowGenerate(true)
          }}
          style={{
            background: 'var(--elev)',
            border: '0.5px solid var(--hairline)',
            borderRadius: 14,
            padding: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            minHeight: 130,
            color: 'var(--text-2)',
            cursor: 'pointer',
            transition: 'box-shadow 0.15s, transform 0.15s',
            boxShadow: 'var(--shadow-1)',
          }}
        >
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            display: 'grid', placeItems: 'center',
            background: 'var(--accent-soft)',
            color: 'var(--accent-2)',
            fontSize: 18,
            fontWeight: 700,
            marginBottom: 8,
          }}>AI</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>AI 生成宠物</div>
          <div style={{ fontSize: 10, marginTop: 2, textAlign: 'center', maxWidth: 150, lineHeight: 1.4 }}>
            输入名字和外观描述
          </div>
        </div>
      </div>

      {showGenerate && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(26,22,18,0.22)',
          display: 'grid',
          placeItems: 'center',
          zIndex: 20,
          padding: 24,
        }}
          onMouseDown={e => {
            if (e.target === e.currentTarget && !generating) setShowGenerate(false)
          }}
        >
          <div style={{
            width: 'min(520px, 100%)',
            background: 'var(--surface-solid)',
            border: '0.5px solid var(--hairline)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-pop)',
            padding: 18,
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>AI 生成宠物</div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 14 }}>
              生成后会自动加入宠物库并切换为当前宠物。
            </div>

            <label style={{ display: 'block', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>名字</div>
              <input
                value={generateForm.name}
                onChange={e => setGenerateForm(f => ({ ...f, name: e.target.value }))}
                disabled={generating}
                placeholder="例如：小云"
                style={inputStyle}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>外观描述</div>
              <textarea
                value={generateForm.prompt}
                onChange={e => setGenerateForm(f => ({ ...f, prompt: e.target.value }))}
                disabled={generating}
                placeholder="例如：一只戴蓝色围巾、喜欢写代码的白色小狐狸"
                rows={4}
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, minHeight: 92 }}
              />
            </label>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>风格</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  ['sticker', '贴纸'],
                  ['pixel', '像素'],
                  ['anime', '动漫'],
                  ['plush', '毛绒'],
                ].map(([id, label]) => {
                  const selected = generateForm.style === id
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={generating}
                      onClick={() => setGenerateForm(f => ({ ...f, style: id as GeneratePetInput['style'] }))}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 999,
                        border: selected ? '1px solid var(--accent)' : '0.5px solid var(--hairline)',
                        background: selected ? 'var(--accent-soft)' : 'var(--surface)',
                        color: selected ? 'var(--accent-2)' : 'var(--text-2)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: generating ? 'default' : 'pointer',
                      }}
                    >{label}</button>
                  )
                })}
              </div>
            </div>

            {generateError && (
              <div style={{
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(226,92,82,0.08)',
                color: 'var(--bad)',
                fontSize: 11,
                lineHeight: 1.4,
              }}>{generateError}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                disabled={generating}
                onClick={() => setShowGenerate(false)}
                style={secondaryButtonStyle}
              >取消</button>
              <button
                type="button"
                disabled={generating || !generateForm.name.trim() || !generateForm.prompt.trim()}
                onClick={generatePet}
                style={{
                  ...primaryButtonStyle,
                  opacity: generating || !generateForm.name.trim() || !generateForm.prompt.trim() ? 0.55 : 1,
                }}
              >{generating ? '生成中...' : '生成'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '0.5px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--surface)',
  color: 'var(--text)',
  outline: 'none',
  padding: '9px 10px',
  fontSize: 13,
  fontFamily: 'var(--font)',
}

const secondaryButtonStyle: React.CSSProperties = {
  height: 32,
  padding: '0 13px',
  borderRadius: 8,
  border: '0.5px solid var(--hairline)',
  background: 'var(--surface)',
  color: 'var(--text-2)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  border: '0.5px solid var(--accent)',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}
