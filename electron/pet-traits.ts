import type { PetTraits, DriveParams } from '@shared/types'

export const DEFAULT_TRAITS: PetTraits = {
  sociability:       0.5,
  independence:      0.5,
  playfulness:       0.5,
  energy_volatility: 0.5,
}

const AXES: (keyof PetTraits)[] = ['sociability', 'independence', 'playfulness', 'energy_volatility']

/** Linear interpolation. trait ∈ [0,1], returns lerp(low, high, trait). */
export function lerp(low: number, high: number, trait: number): number {
  return low + (high - low) * trait
}

function sanitizeAxis(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.max(0, Math.min(1, raw))
}

/**
 * Merge pet.json traits with character-config override.
 * Order: override (if valid) > petJson (if valid) > 0.5.
 */
export function mergeTraits(
  petJson: Partial<PetTraits> | undefined,
  override: Partial<PetTraits> | undefined,
): PetTraits {
  const out = { ...DEFAULT_TRAITS }
  for (const axis of AXES) {
    const fromJson = sanitizeAxis(petJson?.[axis])
    const fromOverride = sanitizeAxis(override?.[axis])
    out[axis] = fromOverride ?? fromJson ?? 0.5
  }
  return out
}

/**
 * Map personality traits to engine runtime parameters.
 * Each mapping uses symmetric linear interpolation around the current
 * hardcoded value, so trait=0.5 → identical behavior to pre-traits code.
 */
export function traitsToParams(t: PetTraits): DriveParams {
  const greetMul     = lerp(0.6, 1.4, t.sociability) * lerp(1.4, 0.6, t.independence)
  const comfortMul   = lerp(0.6, 1.4, t.sociability) * lerp(1.4, 0.6, t.independence)
  const checkInMul   = lerp(0.7, 1.3, t.sociability)
  const curiosityMul = lerp(0.6, 1.4, t.playfulness)
  const celebrateMul = lerp(0.6, 1.4, t.playfulness)

  return {
    lonelyHoursThreshold:        lerp(3, 1, t.sociability),
    greetHoursThreshold:         lerp(3, 1, t.sociability),
    checkInHoursThreshold:       lerp(6, 2, t.sociability),
    greetAffectionThreshold:     lerp(20, 40, t.sociability),
    curiosityAffectionThreshold: lerp(90, 70, t.playfulness),
    energyDecayPerHour:          lerp(1, 3, t.energy_volatility),
    energyRecoveryChat:          lerp(2, 4, t.energy_volatility),
    goalKindMultipliers: {
      greet:     greetMul,
      comfort:   comfortMul,
      check_in:  checkInMul,
      curiosity: curiosityMul,
      celebrate: celebrateMul,
    },
    cooldownMsByKind: {
      greet:   lerp(20, 40, t.independence) * 60_000,
      comfort: lerp(20, 40, t.independence) * 60_000,
    },
  }
}

export const DEFAULT_PARAMS: DriveParams = traitsToParams(DEFAULT_TRAITS)
