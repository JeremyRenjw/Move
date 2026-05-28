import { useEffect, useMemo, useState } from 'react'
import { IPC } from '@shared/types'
import type { CharacterConfig, Pet, PetTraits } from '@shared/types'

type TraitAdjustment = {
  date: string; axis: string; delta: number; reason: string
}

declare global {
  interface Window {
    ipc: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
  }
}

const DEFAULT_TRAITS: PetTraits = {
  sociability: 0.5, independence: 0.5,
  playfulness: 0.5, energy_volatility: 0.5,
}

// ─── Pure helpers (same logic as electron/pet-traits.ts) ───

function lerp(low: number, high: number, t: number) {
  return low + (high - low) * t
}

function traitsToPreview(traits: PetTraits) {
  return {
    lonelyHours:       lerp(3, 1, traits.sociability),
    greetCooldownMin:  lerp(20, 40, traits.independence),
    curiosityMul:      lerp(0.6, 1.4, traits.playfulness),
    comfortMul:        lerp(0.6, 1.4, traits.sociability) * lerp(1.4, 0.6, traits.independence),
    energyDecayPerH:   lerp(1, 3, traits.energy_volatility),
  }
}

// ─── Personality labels ───

function personalityLabel(traits: PetTraits): string {
  const parts: string[] = []
  if (traits.sociability >= 0.7) parts.push('粘人')
  else if (traits.sociability <= 0.3) parts.push('独立')
  if (traits.independence >= 0.7) parts.push('自主')
  else if (traits.independence <= 0.3) parts.push('依赖')
  if (traits.playfulness >= 0.7) parts.push('活泼')
  else if (traits.playfulness <= 0.3) parts.push('沉稳')
  if (traits.energy_volatility >= 0.7) parts.push('忽冷忽热')
  else if (traits.energy_volatility <= 0.3) parts.push('稳定')
  return parts.length > 0 ? parts.join(' · ') : '平衡'
}

// ─── LLM-style system prompt preview ───

function promptPreview(name: string, traits: PetTraits): string {
  const social = traits.sociability >= 0.7 ? '高依恋型' : traits.sociability <= 0.3 ? '独立型' : '社交适中'
  const indep  = traits.independence >= 0.7 ? '高度自主' : traits.independence <= 0.3 ? '依赖陪伴' : '适度独立'
  const play   = traits.playfulness >= 0.7 ? '爱热闹庆祝' : traits.playfulness <= 0.3 ? '沉稳务实' : '平衡活泼'
  const energy = traits.energy_volatility >= 0.7 ? '精力起伏大' : traits.energy_volatility <= 0.3 ? '体力稳定' : '略有波动'

  return `你是 ${name}，一只${social}、${indep}、${play}的桌面陪伴宠物。
性格标签：${social}，${indep}，${play}，${energy}。
你${traits.sociability >= 0.7 ? '很容易想用户，3 小时没说话就会寂寞' : '心态平和，偶尔主动问候'}。
你${traits.playfulness >= 0.7 ? '爱庆祝小事，完成任务会开心很久' : '完成任务后简短汇报'}。
体力${traits.energy_volatility >= 0.7 ? '变化剧烈，容易累但也容易恢复' : '比较平稳'}。`
}

// ─── Scenario previews ───

type Scenario = { title: string; taotao: string; stlulu: string }

const SCENARIOS: Scenario[] = [
  {
    title: '假设：3 小时没互动…',
    taotao: '呜……三小时啦，你是不是把我忘了？(;ω;)',
    stlulu: '嗨——三小时没说话啦，还在忙吗？',
  },
  {
    title: '假设：build 失败…',
    taotao: '别难过别难过…我陪你看～',
    stlulu: '一行类型错误而已，来，深呼吸。',
  },
  {
    title: '假设：连续互动 7 天…',
    taotao: '我们已经一周啦！我好开心好开心！🎉🎉',
    stlulu: '第七天了，习惯有你在了。',
  },
]

// ─── Slider component ───

function TraitSlider({
  label, sublabel, value, lowLabel, highLabel, effect, onChange,
}: {
  label: string; sublabel: string; value: number
  lowLabel: string; highLabel: string; effect: string
  onChange: (v: number) => void
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {value.toFixed(2)}
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 8 }}>{sublabel}</div>
      <div style={{ position: 'relative', height: 28, display: 'flex', alignItems: 'center' }}>
        <input
          type="range" min={0} max={100} step={1} value={Math.round(value * 100)}
          onChange={e => onChange(Number(e.target.value) / 100)}
          style={{
            width: '100%', height: 4, appearance: 'none', WebkitAppearance: 'none',
            background: 'var(--hairline)', borderRadius: 2, outline: 'none', cursor: 'pointer',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 6, fontStyle: 'italic', lineHeight: 1.5 }}>
        {effect}
      </div>
    </div>
  )
}

// ─── Main component ───

export function TraitEditor() {
  const [activePetId, setActivePetId] = useState<string>('')
  const [charCfg, setCharCfg] = useState<CharacterConfig | null>(null)
  const [traits, setTraits] = useState<PetTraits>({ ...DEFAULT_TRAITS })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [learningLog, setLearningLog] = useState<TraitAdjustment[]>([])
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    window.ipc.invoke(IPC.PET_GET_ACTIVE).then(id => {
      if (typeof id === 'string') setActivePetId(id)
    })
  }, [])

  useEffect(() => {
    if (!activePetId) return
    Promise.all([
      window.ipc.invoke(IPC.PET_LIST),
      window.ipc.invoke(IPC.CHARACTER_GET, activePetId),
    ]).then(([list, cfg]) => {
      const pets = list as Pet[]
      const pet = pets.find(p => p.id === activePetId)
      const c = cfg as CharacterConfig
      setCharCfg(c)
      // Base from pet.json, override from character config
      const base = pet?.traits ?? DEFAULT_TRAITS
      const t = c.traitsOverride ?? {}
      setTraits({
        sociability:       t.sociability       ?? base.sociability,
        independence:      t.independence      ?? base.independence,
        playfulness:       t.playfulness       ?? base.playfulness,
        energy_volatility: t.energy_volatility ?? base.energy_volatility,
      })
    })
    window.ipc.invoke('traits:learning-log').then(d => {
      setLearningLog((d as TraitAdjustment[]).reverse())
    }).catch(() => {})
  }, [activePetId])

  const preview = useMemo(() => traitsToPreview(traits), [traits])
  const personaText = useMemo(() => personalityLabel(traits), [traits])
  const promptText = useMemo(
    () => promptPreview(charCfg?.displayName ?? activePetId, traits),
    [charCfg, activePetId, traits],
  )

  const updateTrait = (key: keyof PetTraits) => (v: number) => {
    setTraits(prev => ({ ...prev, [key]: v }))
    setSaved(false)
  }

  const handleSave = async () => {
    if (!charCfg) return
    setSaving(true)
    try {
      const updated: CharacterConfig = { ...charCfg, traitsOverride: { ...traits } }
      await window.ipc.invoke(IPC.CHARACTER_SAVE, updated)
      setCharCfg(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setTraits({ ...DEFAULT_TRAITS })
    setSaved(false)
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>
        {charCfg?.displayName ?? activePetId} · 性格
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 20px' }}>
        调整 4 个性格轴，实时预览行为差异。保存后立即生效。
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'start' }}>
        {/* Left: sliders */}
        <div>
          <TraitSlider
            label="社交性" sublabel="sociability"
            value={traits.sociability}
            lowLabel="独立冷静" highLabel="想被关注"
            effect="影响：主动问候频率、寂寞阈值、想念你的速度"
            onChange={updateTrait('sociability')}
          />
          <TraitSlider
            label="独立性" sublabel="independence"
            value={traits.independence}
            lowLabel="粘人" highLabel="自给自足"
            effect="影响：问候/安慰的冷却时间"
            onChange={updateTrait('independence')}
          />
          <TraitSlider
            label="玩心" sublabel="playfulness"
            value={traits.playfulness}
            lowLabel="严肃" highLabel="爱闹"
            effect="影响：庆祝热情度、好奇心阈值"
            onChange={updateTrait('playfulness')}
          />
          <TraitSlider
            label="活力波动" sublabel="energy_volatility"
            value={traits.energy_volatility}
            lowLabel="稳定" highLabel="忽冷忽热"
            effect="影响：体力下降/恢复速度"
            onChange={updateTrait('energy_volatility')}
          />

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                background: 'var(--accent)', color: 'var(--text-on-accent)',
                border: 'none', borderRadius: 8, cursor: 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saved ? '已保存' : saving ? '保存中…' : '保存'}
            </button>
            <button
              onClick={handleReset}
              style={{
                padding: '8px 16px', fontSize: 13,
                background: 'transparent', color: 'var(--text-2)',
                border: '1px solid var(--hairline)', borderRadius: 8, cursor: 'pointer',
              }}
            >
              重置默认
            </button>
          </div>
        </div>

        {/* Right: live preview */}
        <div style={{
          background: 'var(--bg-3)', borderRadius: 12,
          border: '1px solid var(--hairline)', padding: '14px 16px',
          display: 'flex', flexDirection: 'column', gap: 14,
          position: 'sticky', top: 0,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
            letterSpacing: '.08em', textTransform: 'uppercase' }}>
            实时预览
          </div>

          {/* Personality badge */}
          <div style={{
            padding: '8px 12px', background: 'var(--accent-soft)',
            borderRadius: 8, border: '1px solid rgba(0,0,0,.04)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>
              {personaText}
            </div>
          </div>

          {/* Key numbers */}
          <div style={{
            padding: '10px 12px', background: 'var(--surface-solid)',
            borderRadius: 8, border: '1px solid var(--hairline)',
            fontSize: 11, lineHeight: 1.8, color: 'var(--text-2)',
          }}>
            <b style={{ color: 'var(--text)' }}>这套性格下：</b><br/>
            寂寞阈值 · <b>{preview.lonelyHours.toFixed(1)}h</b><br/>
            问候冷却 · <b>{preview.greetCooldownMin.toFixed(0)}min</b><br/>
            玩心倾向 · <b>{preview.curiosityMul.toFixed(2)}×</b><br/>
            安慰倾向 · <b>{preview.comfortMul.toFixed(2)}×</b><br/>
            体力衰减 · <b>{preview.energyDecayPerH.toFixed(1)}/h</b>
          </div>

          {/* Scenario previews */}
          {SCENARIOS.map((s, i) => (
            <div key={i} style={{
              padding: '10px 12px', background: 'var(--surface-solid)',
              borderRadius: 8, border: '1px solid var(--hairline)',
            }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 6 }}>
                {s.title}
              </div>
              <div style={{
                fontSize: 12, lineHeight: 1.5, color: 'var(--text)',
                padding: '6px 8px', background: 'var(--bg-3)',
                borderRadius: 6,
              }}>
                {traits.sociability >= 0.6 ? s.taotao : s.stlulu}
              </div>
            </div>
          ))}

          {/* Prompt preview */}
          <div style={{
            padding: '10px 12px', background: 'var(--surface-solid)',
            borderRadius: 8, border: '1px solid var(--hairline)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
              letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>
              生成的 System Prompt
            </div>
            <div style={{
              fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6,
              fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap',
            }}>
              {promptText}
            </div>
          </div>
        </div>
      </div>

      {/* Learning log */}
      {learningLog.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <button
            onClick={() => setShowLog(v => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, color: 'var(--text-2)',
              display: 'flex', alignItems: 'center', gap: 6, padding: 0,
            }}
          >
            <span style={{
              display: 'inline-block', transition: 'transform 0.2s',
              transform: showLog ? 'rotate(90deg)' : 'rotate(0deg)',
            }}>▶</span>
            自动学习日志
            <span style={{
              fontSize: 10, background: 'var(--accent-soft)',
              color: 'var(--accent)', borderRadius: 4, padding: '1px 6px',
            }}>{learningLog.length}</span>
          </button>
          {showLog && (
            <div style={{
              marginTop: 10, padding: '12px 14px',
              background: 'var(--bg-3)', borderRadius: 10,
              border: '1px solid var(--hairline)',
              maxHeight: 200, overflowY: 'auto',
            }}>
              {learningLog.map((entry, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 0', fontSize: 12,
                  borderBottom: i < learningLog.length - 1 ? '1px solid var(--hairline)' : 'none',
                }}>
                  <span style={{
                    fontSize: 10, color: 'var(--text-3)',
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 50,
                  }}>{entry.date.slice(5)}</span>
                  <span style={{
                    fontSize: 12,
                    color: entry.delta > 0 ? 'var(--good)' : entry.delta < 0 ? 'var(--bad)' : 'var(--text-3)',
                    fontWeight: 600, minWidth: 14, textAlign: 'center',
                  }}>
                    {entry.delta > 0 ? '↑' : entry.delta < 0 ? '↓' : '·'}
                  </span>
                  <span style={{ flex: 1, color: 'var(--text-2)' }}>{entry.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
