import { describe, it, expect } from 'vitest'
import { DEFAULT_TRAITS, mergeTraits, traitsToParams, DEFAULT_PARAMS } from '../electron/pet-traits'
import type { PetTraits } from '../src-shared/types'

describe('DEFAULT_TRAITS', () => {
  it('sets every axis to 0.5', () => {
    expect(DEFAULT_TRAITS).toEqual({
      sociability: 0.5,
      independence: 0.5,
      playfulness: 0.5,
      energy_volatility: 0.5,
    })
  })
})

describe('mergeTraits', () => {
  it('returns DEFAULT_TRAITS when both inputs missing', () => {
    expect(mergeTraits(undefined, undefined)).toEqual(DEFAULT_TRAITS)
  })

  it('override wins per axis', () => {
    expect(mergeTraits(
      { sociability: 0.7, independence: 0.2, playfulness: 0.5, energy_volatility: 0.5 },
      { sociability: 0.1 }
    )).toEqual({
      sociability: 0.1, independence: 0.2, playfulness: 0.5, energy_volatility: 0.5,
    })
  })

  it('falls back to petJson then 0.5 for missing override axes', () => {
    expect(mergeTraits(
      { sociability: 0.8 } as Partial<PetTraits>,
      { independence: 0.9 }
    )).toEqual({
      sociability: 0.8, independence: 0.9, playfulness: 0.5, energy_volatility: 0.5,
    })
  })

  it('clamps out-of-range numeric values to [0, 1]', () => {
    expect(mergeTraits(
      { sociability: 1.5, independence: -0.3, playfulness: 0.4, energy_volatility: 2 }
    )).toEqual({
      sociability: 1, independence: 0, playfulness: 0.4, energy_volatility: 1,
    })
  })

  it('treats NaN and non-number as missing (falls back to 0.5)', () => {
    expect(mergeTraits(
      { sociability: NaN, independence: 'x' as unknown as number, playfulness: 0.7, energy_volatility: 0.3 }
    )).toEqual({
      sociability: 0.5, independence: 0.5, playfulness: 0.7, energy_volatility: 0.3,
    })
  })
})

describe('traitsToParams — zero regression', () => {
  it('DEFAULT_TRAITS produces current hardcoded engine values', () => {
    const p = traitsToParams(DEFAULT_TRAITS)
    expect(p.lonelyHoursThreshold).toBe(2)
    expect(p.greetHoursThreshold).toBe(2)
    expect(p.checkInHoursThreshold).toBe(4)
    expect(p.greetAffectionThreshold).toBe(30)
    expect(p.curiosityAffectionThreshold).toBe(80)
    expect(p.energyDecayPerHour).toBe(2)
    expect(p.energyRecoveryChat).toBe(3)
    expect(p.goalKindMultipliers.greet).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.comfort).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.check_in).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.curiosity).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.celebrate).toBeCloseTo(1.0, 6)
    expect(p.cooldownMsByKind.greet).toBe(30 * 60_000)
    expect(p.cooldownMsByKind.comfort).toBe(30 * 60_000)
  })

  it('DEFAULT_PARAMS equals traitsToParams(DEFAULT_TRAITS)', () => {
    expect(DEFAULT_PARAMS).toEqual(traitsToParams(DEFAULT_TRAITS))
  })
})

describe('traitsToParams — directionality and boundaries', () => {
  it('high sociability shortens lonelyHoursThreshold relative to low', () => {
    const high = traitsToParams({ ...DEFAULT_TRAITS, sociability: 1 })
    const low  = traitsToParams({ ...DEFAULT_TRAITS, sociability: 0 })
    expect(high.lonelyHoursThreshold).toBeLessThan(low.lonelyHoursThreshold)
  })

  it('high playfulness boosts curiosity multiplier', () => {
    const high = traitsToParams({ ...DEFAULT_TRAITS, playfulness: 1 })
    const low  = traitsToParams({ ...DEFAULT_TRAITS, playfulness: 0 })
    expect(high.goalKindMultipliers.curiosity!).toBeGreaterThan(low.goalKindMultipliers.curiosity!)
  })

  it('high independence suppresses comfort multiplier', () => {
    const high = traitsToParams({ ...DEFAULT_TRAITS, independence: 1 })
    const low  = traitsToParams({ ...DEFAULT_TRAITS, independence: 0 })
    expect(high.goalKindMultipliers.comfort!).toBeLessThan(low.goalKindMultipliers.comfort!)
  })

  it('high energy_volatility increases decay rate', () => {
    const high = traitsToParams({ ...DEFAULT_TRAITS, energy_volatility: 1 })
    const low  = traitsToParams({ ...DEFAULT_TRAITS, energy_volatility: 0 })
    expect(high.energyDecayPerHour).toBeGreaterThan(low.energyDecayPerHour)
  })

  it('all-zero and all-one traits produce finite positive params', () => {
    for (const t of [
      { sociability: 0, independence: 0, playfulness: 0, energy_volatility: 0 },
      { sociability: 1, independence: 1, playfulness: 1, energy_volatility: 1 },
    ] as PetTraits[]) {
      const p = traitsToParams(t)
      for (const v of [
        p.lonelyHoursThreshold, p.greetHoursThreshold, p.checkInHoursThreshold,
        p.greetAffectionThreshold, p.curiosityAffectionThreshold,
        p.energyDecayPerHour, p.energyRecoveryChat,
      ]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThan(0)
      }
      for (const v of Object.values(p.goalKindMultipliers)) {
        expect(Number.isFinite(v!)).toBe(true)
        expect(v!).toBeGreaterThan(0)
      }
      for (const v of Object.values(p.cooldownMsByKind)) {
        expect(Number.isFinite(v!)).toBe(true)
        expect(v!).toBeGreaterThan(0)
      }
    }
  })
})

describe('traitsToParams — pet snapshots', () => {
  it('taotao traits map to a clingy/lonely-quickly profile', () => {
    const p = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    expect(p.lonelyHoursThreshold).toBeCloseTo(1.4, 6)
    expect(p.goalKindMultipliers.comfort!).toBeGreaterThan(1.4)
  })

  it('stlulu traits map to an independent/balanced profile', () => {
    const p = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })
    expect(p.lonelyHoursThreshold).toBe(2)
    expect(p.goalKindMultipliers.comfort!).toBeLessThan(1.0)
  })
})
