import { useEffect, useRef, useCallback } from 'react'
import type { Pet, PetAnimState, PetStage } from '@shared/types'

interface Props {
  pet: Pet
  state: PetAnimState
  size?: number
  mood?: string
  stage?: PetStage
  hovered?: boolean
}

const STATE_SPEED: Record<PetAnimState, number> = {
  idle: 160, talk: 120, working: 180, alert: 100, celebrate: 130, jump: 140, spin: 130, dance: 150, wave: 160,
}

interface StagePersonality {
  restMin: number
  restMax: number
  burstChance: number
}

const STAGE_PERSONALITY: Record<PetStage, StagePersonality> = {
  baby:   { restMin: 2000, restMax: 5000, burstChance: 0.4 },
  child:  { restMin: 2500, restMax: 6000, burstChance: 0.35 },
  teen:   { restMin: 3500, restMax: 7500, burstChance: 0.3 },
  adult:  { restMin: 4000, restMax: 9000, burstChance: 0.25 },
  elder:  { restMin: 5000, restMax: 12000, burstChance: 0.15 },
}

// Procedural animations: CSS transforms, no new frames needed
type ProceduralKind = 'spin' | 'jump' | 'wave' | 'cry' | 'laugh' | 'dance' | 'walk' | 'run' | 'bow' | 'sleep' | 'angry' | 'happy' | 'sad'
const PROCEDURAL_ANIMS: Record<string, ProceduralKind> = {
  spin: 'spin', jump: 'jump', wave: 'wave', cry: 'cry', laugh: 'laugh',
  dance: 'dance', walk: 'walk', run: 'run', bow: 'bow', sleep: 'sleep',
  angry: 'angry', happy: 'happy', sad: 'sad',
}

export function SpritePlayer({ pet, state, size = 80, stage = 'baby', hovered }: Props) {
  const fw = pet.frameSize?.width ?? 80
  const fh = pet.frameSize?.height ?? 80
  const scale = size / fw
  const idle = pet.animations?.idle

  const effectiveState = hovered ? 'celebrate' : state
  const hasFrameAnim = !!pet.animations?.[effectiveState]
  const procedural = !hasFrameAnim ? PROCEDURAL_ANIMS[effectiveState] : undefined
  const anim = hasFrameAnim ? pet.animations![effectiveState as keyof typeof pet.animations] : idle

  const initRow = anim?.row ?? 0
  const initCol = anim?.frames?.[0] ?? 0

  // Stable ref to the inner sprite div — never loses reference
  const elRef = useRef<HTMLDivElement | null>(null)
  const setEl = useCallback((node: HTMLDivElement | null) => { elRef.current = node }, [])

  const timersRef = useRef<number[]>([])
  const aliveRef = useRef(false)
  const animIdRef = useRef('')
  const procRef = useRef('')  // current procedural animation type

  const setBg = (row: number, col: number) => {
    const el = elRef.current
    if (el) el.style.backgroundPosition = `${-col * fw}px ${-row * fh}px`
  }

  // Procedural animation: CSS transforms for spin/jump/wave (no frame data needed)
  useEffect(() => {
    if (!procedural) return
    if (procRef.current === procedural) return
    procRef.current = procedural

    aliveRef.current = false
    timersRef.current.forEach(clearTimeout)
    timersRef.current.length = 0
    aliveRef.current = true

    const el = elRef.current
    if (!el) return

    // Show idle frame as base
    const idleRow = idle?.row ?? 0
    const idleF0 = idle?.frames?.[0] ?? 0
    setBg(idleRow, idleF0)

    let step = 0
    const totalSteps = 12

    const tick = () => {
      if (!aliveRef.current) return
      step = (step + 1) % totalSteps
      const p = step / totalSteps          // 0→1 progress
      const sin = Math.sin(p * Math.PI * 2)
      const abs = Math.abs(sin)

      switch (procedural) {
        case 'spin':
          el.style.transform = `scale(${scale}) rotate(${p * 360}deg)`
          break
        case 'jump':
          el.style.transform = `scale(${scale}) translateY(${Math.sin(p * Math.PI) * -25}px)`
          break
        case 'wave':
          el.style.transform = `scale(${scale}) rotate(${sin * 15}deg)`
          break
        case 'cry':
          el.style.transform = `scale(${scale}) translateY(${abs * 3}px) rotate(${sin * 3}deg)`
          break
        case 'laugh':
          el.style.transform = `scale(${scale}) translateY(${Math.abs(Math.sin(p * Math.PI * 4)) * -10}px)`
          break
        case 'dance':
          el.style.transform = `scale(${scale}) translateY(${Math.sin(p * Math.PI) * -10}px) rotate(${sin * 12}deg)`
          break
        case 'walk':
          el.style.transform = `scale(${scale}) translateX(${sin * 8}px) translateY(${abs * -4}px)`
          break
        case 'run':
          el.style.transform = `scale(${scale}) translateX(${sin * 12}px) translateY(${abs * -8}px) rotate(${sin * 5}deg)`
          break
        case 'bow':
          el.style.transform = `scale(${scale}) scaleY(${1 - Math.sin(p * Math.PI) * 0.3})`
          break
        case 'sleep': {
          const breath = Math.sin(p * Math.PI) * 0.03
          el.style.transform = `scale(${scale + breath}) translateY(${Math.sin(p * Math.PI) * 2}px)`
          break
        }
        case 'angry':
          el.style.transform = `scale(${scale}) translateX(${sin * 5}px) rotate(${sin * 4}deg)`
          break
        case 'happy':
          el.style.transform = `scale(${scale}) translateY(${Math.sin(p * Math.PI) * -12}px) rotate(${sin * 8}deg)`
          break
        case 'sad':
          el.style.transform = `scale(${scale}) translateY(${abs * 5}px) rotate(${sin * 5}deg)`
          break
      }
      const t = window.setTimeout(tick, 80)
      timersRef.current.push(t)
    }
    tick()

    return () => {
      aliveRef.current = false
      procRef.current = ''
      timersRef.current.forEach(clearTimeout)
      timersRef.current.length = 0
      if (el) el.style.transform = `scale(${scale})`
    }
  }, [procedural, scale, idle])

  useEffect(() => {
    if (!anim || anim.frames.length === 0) return
    if (procedural) return  // procedural animation handles this state

    const newId = `${effectiveState}-${hovered}-${stage}`
    if (animIdRef.current === newId) return
    animIdRef.current = newId

    // Stop old loop
    aliveRef.current = false
    timersRef.current.forEach(clearTimeout)
    timersRef.current.length = 0

    aliveRef.current = true
    setBg(anim.row, anim.frames[0])

    const delay = (ms: number, fn: () => void) => {
      if (!aliveRef.current) return
      const t = window.setTimeout(() => {
        const idx = timersRef.current.indexOf(t)
        if (idx >= 0) timersRef.current.splice(idx, 1)
        if (aliveRef.current) fn()
      }, ms)
      timersRef.current.push(t)
    }

    if (effectiveState === 'idle' && !hovered) {
      const personality = STAGE_PERSONALITY[stage] ?? STAGE_PERSONALITY.baby
      const idleRow = idle?.row ?? 0
      const idleF0 = idle?.frames[0] ?? 0

      const doBurst = () => {
        if (!aliveRef.current) return
        let burstAnim = anim
        if (Math.random() < personality.burstChance && pet.animations?.alert) {
          burstAnim = pet.animations.alert
        }
        const frames = burstAnim.frames
        const bRow = burstAnim.row
        let i = 0
        const ms = burstAnim !== anim ? 100 : STATE_SPEED.idle
        const tick = () => {
          if (!aliveRef.current || i >= frames.length) {
            setBg(idleRow, idleF0)
            scheduleRest()
            return
          }
          setBg(bRow, frames[i])
          i++
          delay(ms, tick)
        }
        tick()
      }

      const scheduleRest = () => {
        if (!aliveRef.current) return
        delay(personality.restMin + Math.random() * (personality.restMax - personality.restMin), doBurst)
      }
      scheduleRest()
    } else {
      const frames = anim.frames
      const row = anim.row
      let i = 0
      const ms = STATE_SPEED[effectiveState] ?? 150
      const tick = () => {
        if (!aliveRef.current) return
        i = (i + 1) % frames.length
        setBg(row, frames[i])
        delay(ms, tick)
      }
      delay(ms, tick)
    }

    return () => {
      aliveRef.current = false
      timersRef.current.forEach(clearTimeout)
      timersRef.current.length = 0
    }
  }, [effectiveState, hovered, stage, pet.id, anim, pet.animations, idle, fw, fh])

  return (
    <div style={{ width: size, height: size * (fh / fw), overflow: 'hidden', flexShrink: 0 }}>
      <div
        ref={setEl}
        style={{
          width: fw, height: fh,
          backgroundImage: `url(${pet.spritesheetDataUrl})`,
          backgroundPosition: `${-initCol * fw}px ${-initRow * fh}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: pet.kind === 'generated' ? 'auto' : 'pixelated',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  )
}
