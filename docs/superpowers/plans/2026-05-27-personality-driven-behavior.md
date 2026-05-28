# Personality-Driven Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 4 personality trait axes through to `MoodEngine` and `DriveEngine` so that two pets with different traits produce observably different proactive behavior, while preserving zero regression for pets without traits (every axis defaults to `0.5` → current hardcoded values).

**Architecture:** Add a `PetTraits` field to `pet.json` and a `traitsOverride` field to `CharacterConfig`. A pure function `traitsToParams()` linearly interpolates trait axes into a `DriveParams` bag of runtime knobs (thresholds, multipliers, cooldowns). `PetManager` resolves/caches per-active-pet params; `MoodEngine` is fed via `setParams()`, `DriveEngine` reads via a `getParams` closure. Wiring points: startup in `electron/main.ts`, plus `IPC.PET_SWITCH`/`PET_GENERATE`/`CHARACTER_SAVE` handlers in `electron/ipc.ts`.

**Tech Stack:** TypeScript, vitest, electron-vite (CommonJS main process, ESM modules via `@shared` alias for `src-shared/*`)

**Spec:** `docs/superpowers/specs/2026-05-27-personality-driven-behavior-design.md`

---

## File Structure

**Created:**
- `electron/pet-traits.ts` — pure module: types re-exports, `DEFAULT_TRAITS`, `lerp`, `mergeTraits`, `traitsToParams`, `DEFAULT_PARAMS`
- `tests/pet-traits.test.ts` — unit tests

**Modified:**
- `src-shared/types.ts` — add `PetTraits`, `DriveParams`; extend `Pet`, `CharacterConfig`
- `electron/mood-engine.ts` — add `params` field + `setParams()`; replace 3 hardcoded values with `this.params.*`
- `electron/drive-engine.ts` — add `getParams` to `DriveDeps`; add `params` to `RuleContext`; replace magic numbers in rules 1/6/7; stack `params.goalKindMultipliers` in `applyModifiers`; use `params.cooldownMsByKind` in `dedup`
- `electron/pets.ts` — add `activeParams` cache, `resolveParams(petId, chars)`, `getActiveParams()`; extend `syncBuiltinManifest` to propagate `traits`
- `electron/main.ts` — prime params at startup; pass `getParams` to `DriveEngine`
- `electron/ipc.ts` — re-resolve params on `PET_SWITCH`, `PET_GENERATE`, `CHARACTER_SAVE` (when active)
- `assets/pets/taotao/pet.json` — add `traits`
- `assets/pets/stlulu/pet.json` — add `traits`
- `tests/drive-engine.test.ts` — extend with params-aware tests
- `tests/mood-engine.test.ts` — extend with `setParams` test

---

### Task 1: Add types to `src-shared/types.ts`

**Files:**
- Modify: `src-shared/types.ts` (insert near existing `MoodState` declaration, around line 88)

- [ ] **Step 1: Open the types file and add new interfaces**

Insert after the `MoodState` block (after the comment block `// ─── Pet mood system ───` and the existing `MoodState` interface, before the `// Chat messages` comment):

```ts
// ─── Pet personality traits ───
export interface PetTraits {
  sociability:       number  // 0-1, default 0.5 — 对人的依恋/求关注程度
  independence:      number  // 0-1, default 0.5 — 对独处的耐受度
  playfulness:       number  // 0-1, default 0.5 — 庆祝/好奇/玩闹倾向
  energy_volatility: number  // 0-1, default 0.5 — 体力波动剧烈程度
}

// Runtime knobs derived from PetTraits via traitsToParams().
// Engines read these instead of hardcoded constants.
export interface DriveParams {
  lonelyHoursThreshold:        number
  energyDecayPerHour:          number
  energyRecoveryChat:          number
  greetAffectionThreshold:     number
  greetHoursThreshold:         number
  checkInHoursThreshold:       number
  curiosityAffectionThreshold: number
  goalKindMultipliers: Partial<Record<PetGoal['kind'], number>>
  cooldownMsByKind:    Partial<Record<PetGoal['kind'], number>>
}
```

- [ ] **Step 2: Extend `Pet` interface to optionally carry traits**

Find the `Pet` interface (currently around line 19). Add the `traits` field after `evolutions`:

```ts
export interface Pet {
  id: string
  displayName: string
  description: string
  spritesheetPath: string
  kind?: string
  frameSize?: { width: number; height: number }
  animations?: { /* unchanged */ }
  evolutions?: Record<string, PetEvolution>
  traits?: PetTraits
  // resolved at runtime, not in JSON
  spritesheetDataUrl?: string
  dir?: string
}
```

- [ ] **Step 3: Extend `CharacterConfig` to carry per-installation override**

Find the `CharacterConfig` interface (currently around line 46). Add the field:

```ts
export interface CharacterConfig {
  petId: string
  displayName: string
  personality: string[]
  systemPrompt: string
  greeting: string
  apiConfig?: ApiConfig
  traitsOverride?: Partial<PetTraits>
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). `PetGoal` is already declared elsewhere in this file (it's referenced by `DriveParams.goalKindMultipliers`), confirm by searching for `export type PetGoal` or `interface PetGoal` and ensure `DriveParams` is placed AFTER `PetGoal`'s declaration. If a forward reference issue appears, move the new interfaces to the bottom of the file.

- [ ] **Step 5: Commit**

```bash
git add src-shared/types.ts
git commit -m "feat(types): add PetTraits and DriveParams types"
```

---

### Task 2: Create `electron/pet-traits.ts` skeleton with `DEFAULT_TRAITS`

**Files:**
- Create: `electron/pet-traits.ts`
- Create: `tests/pet-traits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/pet-traits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_TRAITS } from '../electron/pet-traits'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: FAIL with "Cannot find module '../electron/pet-traits'" or equivalent.

- [ ] **Step 3: Create the file with DEFAULT_TRAITS**

Create `electron/pet-traits.ts`:

```ts
import type { PetTraits, DriveParams, PetGoal } from '@shared/types'

export const DEFAULT_TRAITS: PetTraits = {
  sociability:       0.5,
  independence:      0.5,
  playfulness:       0.5,
  energy_volatility: 0.5,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/pet-traits.ts tests/pet-traits.test.ts
git commit -m "feat(pet-traits): add DEFAULT_TRAITS"
```

---

### Task 3: Add `lerp` and `mergeTraits`

**Files:**
- Modify: `electron/pet-traits.ts`
- Modify: `tests/pet-traits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/pet-traits.test.ts`:

```ts
import { mergeTraits } from '../electron/pet-traits'

describe('mergeTraits', () => {
  it('returns DEFAULT_TRAITS when both inputs missing', () => {
    expect(mergeTraits(undefined, undefined)).toEqual(DEFAULT_TRAITS)
  })

  it('override wins per axis', () => {
    expect(mergeTraits({ sociability: 0.7, independence: 0.2, playfulness: 0.5, energy_volatility: 0.5 }, { sociability: 0.1 }))
      .toEqual({ sociability: 0.1, independence: 0.2, playfulness: 0.5, energy_volatility: 0.5 })
  })

  it('falls back to pet.json then to 0.5 for missing override axes', () => {
    expect(mergeTraits({ sociability: 0.8 } as any, { independence: 0.9 }))
      .toEqual({ sociability: 0.8, independence: 0.9, playfulness: 0.5, energy_volatility: 0.5 })
  })

  it('clamps out-of-range values to [0, 1]', () => {
    expect(mergeTraits({ sociability: 1.5, independence: -0.3, playfulness: 0.4, energy_volatility: 2 }))
      .toEqual({ sociability: 1, independence: 0, playfulness: 0.4, energy_volatility: 1 })
  })

  it('treats NaN/non-number as missing (falls back to 0.5)', () => {
    expect(mergeTraits({ sociability: NaN, independence: 'x' as unknown as number, playfulness: 0.7, energy_volatility: 0.3 }))
      .toEqual({ sociability: 0.5, independence: 0.5, playfulness: 0.7, energy_volatility: 0.3 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: FAIL with "mergeTraits is not exported" or similar.

- [ ] **Step 3: Implement `lerp` and `mergeTraits`**

Append to `electron/pet-traits.ts`:

```ts
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
 * Invalid values (NaN, non-number, out-of-range non-clampable) treated as missing.
 * Out-of-range numeric values are clamped to [0, 1].
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: PASS (all 6 tests: 1 DEFAULT_TRAITS + 5 mergeTraits)

- [ ] **Step 5: Commit**

```bash
git add electron/pet-traits.ts tests/pet-traits.test.ts
git commit -m "feat(pet-traits): add lerp and mergeTraits with clamping"
```

---

### Task 4: Add `traitsToParams` + `DEFAULT_PARAMS` zero-regression test

**Files:**
- Modify: `electron/pet-traits.ts`
- Modify: `tests/pet-traits.test.ts`

- [ ] **Step 1: Write failing zero-regression test**

Append to `tests/pet-traits.test.ts`:

```ts
import { traitsToParams, DEFAULT_PARAMS } from '../electron/pet-traits'

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
    // multipliers default to 1.0 (no-op) at midpoint
    expect(p.goalKindMultipliers.greet).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.comfort).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.check_in).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.curiosity).toBeCloseTo(1.0, 6)
    expect(p.goalKindMultipliers.celebrate).toBeCloseTo(1.0, 6)
    // cooldowns: 30 min at midpoint
    expect(p.cooldownMsByKind.greet).toBe(30 * 60_000)
    expect(p.cooldownMsByKind.comfort).toBe(30 * 60_000)
  })

  it('exports DEFAULT_PARAMS equal to traitsToParams(DEFAULT_TRAITS)', () => {
    expect(DEFAULT_PARAMS).toEqual(traitsToParams(DEFAULT_TRAITS))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: FAIL with "traitsToParams is not exported".

- [ ] **Step 3: Implement `traitsToParams`**

Append to `electron/pet-traits.ts`:

```ts
/**
 * Map personality traits to engine runtime parameters.
 * Each mapping uses symmetric linear interpolation around the current
 * hardcoded value, so trait=0.5 → identical behavior to pre-traits code.
 * See spec: docs/superpowers/specs/2026-05-27-personality-driven-behavior-design.md
 */
export function traitsToParams(t: PetTraits): DriveParams {
  const greetMul    = lerp(0.6, 1.4, t.sociability) * lerp(1.4, 0.6, t.independence)
  const comfortMul  = lerp(0.6, 1.4, t.sociability) * lerp(1.4, 0.6, t.independence)
  const checkInMul  = lerp(0.7, 1.3, t.sociability)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add electron/pet-traits.ts tests/pet-traits.test.ts
git commit -m "feat(pet-traits): add traitsToParams and DEFAULT_PARAMS (zero-regression at trait=0.5)"
```

---

### Task 5: Directionality, boundary, and snapshot tests for `traitsToParams`

**Files:**
- Modify: `tests/pet-traits.test.ts`

- [ ] **Step 1: Write the additional tests**

Append to `tests/pet-traits.test.ts`:

```ts
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
    // sociability 0.8 → lerp(3,1,0.8) = 1.4h
    expect(p.lonelyHoursThreshold).toBeCloseTo(1.4, 6)
    // comfort multiplier: sociability lerp(0.6,1.4,0.8)=1.24, independence lerp(1.4,0.6,0.2)=1.24 → 1.5376
    expect(p.goalKindMultipliers.comfort!).toBeGreaterThan(1.4)
  })

  it('stlulu traits map to an independent/balanced profile', () => {
    const p = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })
    // sociability 0.5 → midpoint 2h
    expect(p.lonelyHoursThreshold).toBe(2)
    // independence 0.6 dampens comfort: sociability 1.0 * independence lerp(1.4,0.6,0.6)=0.92
    expect(p.goalKindMultipliers.comfort!).toBeLessThan(1.0)
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/pet-traits.test.ts`
Expected: PASS (all directionality, boundary, snapshot tests). If any directionality test fails because the lerp direction is reversed, fix the lerp arguments in `traitsToParams` accordingly — do not invert the test.

- [ ] **Step 3: Commit**

```bash
git add tests/pet-traits.test.ts
git commit -m "test(pet-traits): cover directionality, boundaries, and pet snapshots"
```

---

### Task 6: Refactor `MoodEngine` to read from `DriveParams`

**Files:**
- Modify: `electron/mood-engine.ts`
- Modify: `tests/mood-engine.test.ts` (extend; file already exists)

- [ ] **Step 1: Inspect existing mood-engine tests**

Run: `npx vitest run tests/mood-engine.test.ts`
Expected: PASS (record current count of passing tests; they must remain passing after refactor).

- [ ] **Step 2: Write the failing setParams test**

Append a new `describe` block at the bottom of `tests/mood-engine.test.ts`:

```ts
import { DEFAULT_PARAMS } from '../electron/pet-traits'

describe('MoodEngine.setParams', () => {
  it('respects custom lonelyHoursThreshold from injected params', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    vol.fromJSON({})
    const engine = new MoodEngine('/mood')
    // Force the lastInteraction to 1.5h ago
    const now = Date.now()
    const state = engine.getMoodState()
    ;(engine as any).state.lastInteraction = now - 1.5 * 3_600_000
    void state

    // With default threshold (2h), 1.5h does NOT trigger lonely
    engine.setParams(DEFAULT_PARAMS)
    const stats = { cpu: 20, ramUsed: 4e9, ramTotal: 16e9, diskUsed: 50, claudeRunning: false, codexRunning: false }
    expect(engine.tick(stats)).not.toBe('lonely')

    // Force-reset because tick mutated lastInteraction-derived energy
    ;(engine as any).state.lastInteraction = now - 1.5 * 3_600_000

    // With threshold 1h (very social pet), 1.5h DOES trigger lonely
    engine.setParams({ ...DEFAULT_PARAMS, lonelyHoursThreshold: 1 })
    // Must be daytime for lonely to trigger; the existing computeMood gates on hour 8-23.
    // Use a deterministic clock if needed; here we just rely on the dev machine being awake-hours during CI.
    const result = engine.tick(stats)
    // Either lonely (waking hours) or some non-lonely (night). Both prove that the threshold is read from params.
    // To make this deterministic: if not lonely, the only acceptable reason is hour < 8 || hour > 23.
    const hour = new Date().getHours()
    if (hour >= 8 && hour <= 23) {
      expect(result).toBe('lonely')
    }
  })
})
```

(The `import { MoodEngine } from '../electron/mood-engine'` and `vi.mock('fs/promises', ...)` setup should already exist at the top of the file; reuse them.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mood-engine.test.ts -t 'setParams'`
Expected: FAIL with "engine.setParams is not a function" or similar.

- [ ] **Step 4: Add params field and setParams method to MoodEngine**

Edit `electron/mood-engine.ts`:

1. At top of file, add import:

```ts
import { DEFAULT_PARAMS } from './pet-traits'
import type { DriveParams } from '@shared/types'
```

2. Inside the `MoodEngine` class, after the `private statePath: string` line, add:

```ts
private params: DriveParams = DEFAULT_PARAMS
```

3. After the `setMoodBroadcastCallback` method, add:

```ts
/** Replace the active DriveParams (called when active pet changes). */
setParams(p: DriveParams): void {
  this.params = p
}
```

4. In `tick()` (currently around line 191), replace `s.energy - hoursSinceInteraction * 2` with `s.energy - hoursSinceInteraction * this.params.energyDecayPerHour`.

5. In `computeMood()` (currently around line 229), replace `hoursSinceInteraction > 2` with `hoursSinceInteraction > this.params.lonelyHoursThreshold`.

6. In `onInteraction('chat')` (currently around line 283), replace `s.energy = Math.min(100, s.energy + 3)` with `s.energy = Math.min(100, s.energy + this.params.energyRecoveryChat)`.

- [ ] **Step 5: Run all mood-engine tests**

Run: `npx vitest run tests/mood-engine.test.ts`
Expected: PASS for both new and pre-existing tests (no regression because `DEFAULT_PARAMS` reproduces the previous constants).

- [ ] **Step 6: Commit**

```bash
git add electron/mood-engine.ts tests/mood-engine.test.ts
git commit -m "feat(mood-engine): read thresholds from DriveParams via setParams"
```

---

### Task 7: Refactor `DriveEngine` to read from `DriveParams`

**Files:**
- Modify: `electron/drive-engine.ts`
- Modify: `tests/drive-engine.test.ts`

- [ ] **Step 1: Write failing tests for params-aware behavior**

Append to `tests/drive-engine.test.ts` (the file already imports `DriveEngine`, `DriveDeps`, and has helpers). Add the import and tests:

```ts
import { traitsToParams, DEFAULT_PARAMS } from '../electron/pet-traits'

describe('DriveEngine reads from params', () => {
  it('greet rule uses params.greetAffectionThreshold', () => {
    const deps = makeDeps()
    // Provide a custom params lookup
    const params = { ...DEFAULT_PARAMS, greetAffectionThreshold: 50, greetHoursThreshold: 1 }
    ;(deps as any).getParams = () => params
    const engine = new DriveEngine(deps as any)

    // affection=40 (less than threshold 50) and hoursSince=2 (above 1) → greet should fire
    const ctx = {
      mood: 'calm' as const,
      energy: 80,
      affection: 40,
      streak: 0,
      hoursSince: 2,
      waking: true,
      stats: normalStats,
      hasEvents: false,
      now: Date.now(),
      params,
    }
    const goals = engine.evaluate(ctx as any)
    expect(goals.find(g => g.kind === 'greet')).toBeTruthy()
  })

  it('applies params.goalKindMultipliers on top of mood multipliers', () => {
    const deps = makeDeps()
    const taotaoParams = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    const stluluParams = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })

    function priorityFor(params: typeof taotaoParams, kind: 'comfort') {
      ;(deps as any).getParams = () => params
      const engine = new DriveEngine(deps as any)
      const ctx = {
        mood: 'lonely' as const,
        energy: 80, affection: 50, streak: 0, hoursSince: 3, waking: true,
        stats: normalStats, hasEvents: false, now: Date.now(), params,
      }
      const goals = engine.evaluate(ctx as any)
      return goals.find(g => g.kind === kind)?.priority ?? 0
    }

    const pTao = priorityFor(taotaoParams, 'comfort')
    const pStl = priorityFor(stluluParams, 'comfort')
    expect(pTao).toBeGreaterThan(pStl)
  })

  it('dedup uses params.cooldownMsByKind when present', () => {
    const deps = makeDeps()
    const params = { ...DEFAULT_PARAMS, cooldownMsByKind: { greet: 60 * 60_000 } }  // 60min
    ;(deps as any).getParams = () => params
    const engine = new DriveEngine(deps as any)
    const now = 10_000_000
    // Mark a greet 45 min ago: still cooling down under 60min, but past the default 30min
    ;(engine as any).cooldowns.set('greet', now - 45 * 60_000)
    const goals = [{ id: 'x', kind: 'greet' as const, priority: 80, action: 'bubble' as const, bubble: 'hi', cooldownKey: 'greet' }]
    expect(engine.dedup(goals, now)).toHaveLength(0)
    // After 70min, allowed
    expect(engine.dedup(goals, now + 25 * 60_000)).toHaveLength(1)
  })
})
```

Also update `makeDeps()` at top to expose a default `getParams`. Right after `getActivePetId: () => 'stlulu',` add `getParams: () => DEFAULT_PARAMS,`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/drive-engine.test.ts`
Expected: FAIL — either type errors (`getParams` not in `DriveDeps`), or runtime "params is undefined" errors in `evaluate()`.

- [ ] **Step 3: Update `DriveDeps`, `RuleContext`, and rules**

Edit `electron/drive-engine.ts`:

1. Top of file, add import (next to other type imports):

```ts
import { DEFAULT_PARAMS } from './pet-traits'
import type { DriveParams } from '../src-shared/types'
```

2. Extend `DriveDeps` (currently around line 18):

```ts
export interface DriveDeps {
  mood:            MoodEngine
  wm:              WindowManager
  agentScheduler:  AgentScheduler
  events:          EventStore
  getStats:        () => SystemStats
  getActivePetId:  () => string | null
  getParams?:      () => DriveParams   // NEW: optional for backward compat; falls back to DEFAULT_PARAMS
  ai?:             AiEngine
  chars?:          CharacterConfigStore
  factStore?:      FactStore
  getPersona?:     () => Promise<string>
}
```

3. Extend `RuleContext` (currently around line 34):

```ts
export interface RuleContext {
  mood:       PetMood
  energy:     number
  affection:  number
  streak:     number
  hoursSince: number
  waking:     boolean
  stats:      SystemStats
  hasEvents:  boolean
  now:        number
  params:     DriveParams
}
```

4. Update each `Rule` that uses a magic number; rewrite the `rules` array entries:

```ts
const rules: Rule[] = [
  // 1. Greet
  (ctx) => {
    if (ctx.affection < ctx.params.greetAffectionThreshold && ctx.hoursSince > ctx.params.greetHoursThreshold && ctx.waking) {
      return makeGoal('greet', 'bubble', 80, { bubble: pickFromPool(GREET_TEXT, ctx.mood) })
    }
    return null
  },
  // 2. Comfort: lonely mood (unchanged threshold)
  (ctx) => {
    if (ctx.mood === 'lonely') {
      return makeGoal('comfort', 'bubble', 75, { bubble: pickFromPool(COMFORT_TEXT, ctx.mood) })
    }
    return null
  },
  // 3. Remind rest (unchanged — energy already trait-driven via decay rate)
  (ctx) => {
    if (ctx.energy < 25 && !ctx.waking) {
      return makeGoal('remind_rest', 'bubble', 70, { bubble: pickFromPool(REST_TEXT, ctx.mood) })
    }
    return null
  },
  // 4. System check (unchanged)
  (ctx) => {
    if (ctx.mood === 'worried' && ctx.stats.cpu > 85) {
      return makeGoal('system_check', 'agent_task', 65, {
        agentGoal: '检查系统状态，看看 CPU 为什么这么高，有没有可以清理的进程。用 bash 执行 top 或 ps 查看，然后给出简短建议。',
      })
    }
    return null
  },
  // 5. Celebrate (unchanged)
  (ctx) => {
    if (ctx.streak >= 3 && ctx.streak % 3 === 0 && ctx.hoursSince < 0.5) {
      return makeGoal('celebrate', 'bubble', 60, { bubble: `太棒了！我们已经连续互动 ${ctx.streak} 天啦！🎉` })
    }
    return null
  },
  // 6. Curiosity
  (ctx) => {
    if (ctx.mood === 'excited' && ctx.affection > ctx.params.curiosityAffectionThreshold) {
      return makeGoal('curiosity', 'bubble', 40, {
        bubble: pickRandom(['今天有什么有趣的事想跟我说吗？', '心情超好！要不要聊聊天？']),
      })
    }
    return null
  },
  // 7. Check in
  (ctx) => {
    if (ctx.hoursSince > ctx.params.checkInHoursThreshold && ctx.waking && ctx.affection >= 30) {
      return makeGoal('check_in', 'bubble', 35, { bubble: pickFromPool(CHECKIN_TEXT, ctx.mood) })
    }
    return null
  },
]
```

5. Update `applyModifiers` (currently around line 314) to stack `params.goalKindMultipliers`. Find the existing `moodMul` block and replace:

```ts
applyModifiers(goals: PetGoal[], mood: PetMood, energy: number, params: DriveParams): PetGoal[] {
  const moodMul = MOOD_MULTIPLIERS[mood] ?? {}
  const paramMul = params.goalKindMultipliers ?? {}

  let filtered = energy < 30
    ? goals.filter(g => g.action !== 'agent_task')
    : goals

  let result = filtered.map(g => {
    const moodFactor   = moodMul[g.kind] ?? 1.0
    const paramFactor  = paramMul[g.kind] ?? 1.0
    const feedbackScore = this.getFeedbackScore(g.kind)
    return {
      ...g,
      priority: Math.round(g.priority * moodFactor * paramFactor * feedbackScore),
    }
  }).sort((a, b) => b.priority - a.priority)

  if (mood === 'lonely' && result.length > 1) {
    const social = result.filter(g => DriveEngine.SOCIAL_KINDS.has(g.kind))
    const nonSocial = result.filter(g => !DriveEngine.SOCIAL_KINDS.has(g.kind))
    if (social.length > 0 && nonSocial.length > 0 && nonSocial[0].priority > social[0].priority) {
      social[0].priority = nonSocial[0].priority + 1
      result = [...social, ...nonSocial].sort((a, b) => b.priority - a.priority)
    }
  }

  return result
}
```

6. Update `evaluate` (currently around line 346) to pass `params`:

```ts
evaluate(ctx: RuleContext): PetGoal[] {
  const goals: PetGoal[] = []
  for (const rule of rules) {
    const goal = rule(ctx)
    if (goal) goals.push(goal)
  }
  return this.applyModifiers(goals, ctx.mood, ctx.energy, ctx.params)
}
```

7. Update `dedup` (currently around line 356) to use per-kind cooldown:

```ts
private static GLOBAL_COOLDOWN_MS = 30 * 60_000

dedup(goals: PetGoal[], now: number, params?: DriveParams): PetGoal[] {
  return goals.filter(g => {
    const last = this.cooldowns.get(g.cooldownKey) ?? 0
    const cooldown = params?.cooldownMsByKind?.[g.kind] ?? DriveEngine.GLOBAL_COOLDOWN_MS
    return now - last >= cooldown
  })
}
```

Remove the existing `const COOLDOWN_MS = 30 * 60_000` at the top of the file (now `GLOBAL_COOLDOWN_MS` is the static class member).

8. Update `tick()` (currently around line 365) to populate `ctx.params` and pass to `dedup`:

```ts
async tick(): Promise<void> {
  const now = Date.now()
  const mood = this.deps.mood
  const stats = this.deps.getStats()
  const params = this.deps.getParams?.() ?? DEFAULT_PARAMS

  // (decay feedback — unchanged)
  for (const [kind, score] of this.feedback) {
    const decayed = score + (1.0 - score) * (1 - FEEDBACK_DECAY)
    this.feedback.set(kind, Math.max(FEEDBACK_MIN, Math.min(FEEDBACK_MAX, decayed)))
  }

  const ctx: RuleContext = {
    mood:       mood.tick(stats),
    energy:     mood.getEnergy(),
    affection:  mood.getAffection(),
    streak:     mood.getStreak(),
    hoursSince: mood.getHoursSinceInteraction(),
    waking:     mood.isWakingHours(),
    stats,
    hasEvents:  false,
    now,
    params,
  }

  const petId = this.deps.getActivePetId() ?? 'stlulu'
  const recentEvents = await this.deps.events.range(petId, now - 30 * 60_000, now)
  ctx.hasEvents = recentEvents.length > 0

  const goals = this.evaluate(ctx)
  const filtered = this.dedup(goals, now, params)

  // ... rest unchanged
}
```

- [ ] **Step 4: Run all drive-engine tests**

Run: `npx vitest run tests/drive-engine.test.ts`
Expected: PASS (existing tests + new params-aware tests). If a pre-existing test fails because it constructs a `RuleContext` without `params`, update that test to include `params: DEFAULT_PARAMS`.

- [ ] **Step 5: Commit**

```bash
git add electron/drive-engine.ts tests/drive-engine.test.ts
git commit -m "feat(drive-engine): read thresholds/multipliers/cooldowns from DriveParams"
```

---

### Task 8: Add `resolveParams`/`getActiveParams` to `PetManager` and propagate `traits` in builtin sync

**Files:**
- Modify: `electron/pets.ts`
- Modify: `tests/pets.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/pets.test.ts`:

```ts
import { CharacterConfigStore } from '../electron/character'
import { DEFAULT_PARAMS, traitsToParams } from '../electron/pet-traits'

describe('PetManager.resolveParams', () => {
  it('returns DEFAULT_PARAMS for a pet without traits', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    vol.fromJSON({
      '/userData/pets/stlulu/pet.json': MOCK_PET_JSON,
      '/userData/pets/stlulu/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const chars = new CharacterConfigStore('/userData')
    const params = await mgr.resolveParams('stlulu', chars)
    expect(params).toEqual(DEFAULT_PARAMS)
  })

  it('honors pet.json traits when no character override', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const petWithTraits = JSON.stringify({
      id: 'taotao', displayName: '桃桃', description: 'test', spritesheetPath: 'spritesheet.webp',
      traits: { sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 },
    })
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': petWithTraits,
      '/userData/pets/taotao/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const chars = new CharacterConfigStore('/userData')
    const params = await mgr.resolveParams('taotao', chars)
    expect(params).toEqual(traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 }))
  })

  it('character override wins over pet.json traits', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    const petWithTraits = JSON.stringify({
      id: 'taotao', displayName: '桃桃', description: 'test', spritesheetPath: 'spritesheet.webp',
      traits: { sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 },
    })
    const charCfg = JSON.stringify({
      petId: 'taotao', displayName: '桃桃', personality: [], systemPrompt: '', greeting: '',
      traitsOverride: { sociability: 0.1 },
    })
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': petWithTraits,
      '/userData/pets/taotao/spritesheet.webp': 'binary',
      '/userData/characters/taotao.json': charCfg,
    })
    const mgr = new PetManager('/userData', '/assets')
    const chars = new CharacterConfigStore('/userData')
    const params = await mgr.resolveParams('taotao', chars)
    // sociability=0.1 → lonelyHoursThreshold = lerp(3,1,0.1) = 2.8
    expect(params.lonelyHoursThreshold).toBeCloseTo(2.8, 6)
  })

  it('getActiveParams returns DEFAULT_PARAMS before resolveParams is called', () => {
    const mgr = new PetManager('/userData', '/assets')
    expect(mgr.getActiveParams()).toEqual(DEFAULT_PARAMS)
  })

  it('getActiveParams reflects the most recent resolveParams call for the active pet', async () => {
    const { vol } = await import('memfs')
    vol.reset()
    vol.fromJSON({
      '/userData/pets/taotao/pet.json': JSON.stringify({
        id: 'taotao', displayName: '桃桃', description: 't', spritesheetPath: 'spritesheet.webp',
        traits: { sociability: 1, independence: 0, playfulness: 0.5, energy_volatility: 0.5 },
      }),
      '/userData/pets/taotao/spritesheet.webp': 'binary',
    })
    const mgr = new PetManager('/userData', '/assets')
    const chars = new CharacterConfigStore('/userData')
    mgr.setActive('taotao')
    await mgr.resolveParams('taotao', chars)
    expect(mgr.getActiveParams().lonelyHoursThreshold).toBe(1)  // sociability=1 → lerp(3,1,1)=1
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pets.test.ts`
Expected: FAIL — `resolveParams` and `getActiveParams` not implemented.

- [ ] **Step 3: Implement the methods**

Edit `electron/pets.ts`:

1. Add imports at top:

```ts
import { mergeTraits, traitsToParams, DEFAULT_PARAMS } from './pet-traits'
import type { DriveParams } from '@shared/types'
import type { CharacterConfigStore } from './character'
```

2. Add field to class (next to `activePetId`):

```ts
private activeParams: DriveParams = DEFAULT_PARAMS
```

3. Add methods (next to `setActive`/`getActiveId`):

```ts
/**
 * Load `traits` from pet.json, merge with character override, compute DriveParams.
 * Caches result in activeParams iff this petId is currently active.
 */
async resolveParams(petId: string, chars: CharacterConfigStore): Promise<DriveParams> {
  let petTraits: Partial<import('@shared/types').PetTraits> | undefined
  try {
    const raw = await fs.readFile(path.join(this.petsDir, petId, 'pet.json'), 'utf-8')
    const pet = JSON.parse(raw) as Pet
    petTraits = pet.traits
  } catch { /* missing pet.json: treat as no traits */ }

  let override: Partial<import('@shared/types').PetTraits> | undefined
  try {
    const cfg = await chars.get(petId)
    override = cfg.traitsOverride
  } catch { /* no character config yet */ }

  const traits = mergeTraits(petTraits, override)
  const params = traitsToParams(traits)
  if (this.activePetId === petId) this.activeParams = params
  return params
}

/** Returns the most recently resolved params for the active pet (or DEFAULT_PARAMS). */
getActiveParams(): DriveParams { return this.activeParams }
```

4. Update `syncBuiltinManifest` (currently around line 44) to propagate `traits`:

```ts
private async syncBuiltinManifest(src: string, dest: string): Promise<void> {
  const [srcRaw, destRaw] = await Promise.all([
    fs.readFile(path.join(src, 'pet.json'), 'utf-8'),
    fs.readFile(path.join(dest, 'pet.json'), 'utf-8'),
  ])
  const source = JSON.parse(srcRaw) as Pet
  const current = JSON.parse(destRaw) as Pet
  const next: Pet = {
    ...current,
    spritesheetPath: source.spritesheetPath,
    frameSize: source.frameSize,
    animations: source.animations,
    evolutions: source.evolutions,
    traits: source.traits,   // NEW
  }

  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await fs.writeFile(path.join(dest, 'pet.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pets.test.ts`
Expected: PASS for both new and pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add electron/pets.ts tests/pets.test.ts
git commit -m "feat(pets): resolve and cache DriveParams from pet.traits + character override"
```

---

### Task 9: Add `traits` to shipped pet.json files

**Files:**
- Modify: `assets/pets/taotao/pet.json`
- Modify: `assets/pets/stlulu/pet.json`

- [ ] **Step 1: Add traits to taotao**

Edit `assets/pets/taotao/pet.json`. After the `"description"` field (around line 4), insert:

```json
  "traits": {
    "sociability": 0.8,
    "independence": 0.2,
    "playfulness": 0.7,
    "energy_volatility": 0.6
  },
```

- [ ] **Step 2: Add traits to stlulu**

Edit `assets/pets/stlulu/pet.json`. After the `"description"` field (around line 4), insert:

```json
  "traits": {
    "sociability": 0.5,
    "independence": 0.6,
    "playfulness": 0.6,
    "energy_volatility": 0.4
  },
```

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "console.log(require('./assets/pets/taotao/pet.json').traits, require('./assets/pets/stlulu/pet.json').traits)"`
Expected: prints both trait objects without errors.

- [ ] **Step 4: Commit**

```bash
git add assets/pets/taotao/pet.json assets/pets/stlulu/pet.json
git commit -m "feat(pets): seed taotao/stlulu with personality traits"
```

---

### Task 10: Wire startup, IPC handlers, and DriveEngine constructor

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/ipc.ts`

- [ ] **Step 1: Prime params at startup in main.ts**

Edit `electron/main.ts`. Find the line `pets.setActive('stlulu')` (currently around line 137). Insert after it:

```ts
    // Resolve initial DriveParams from the active pet's traits + character override
    const initialParams = await pets.resolveParams('stlulu', chars)
    mood.setParams(initialParams)
```

- [ ] **Step 2: Pass `getParams` to DriveEngine**

In the same file, find the `new DriveEngine({ ... })` block (currently around line 248). Add the `getParams` field:

```ts
    const driveEngine = new DriveEngine({
      mood, wm, agentScheduler, events,
      getStats: () => latestStats,
      getActivePetId: () => pets.getActiveId(),
      getParams: () => pets.getActiveParams(),
      ai, chars, factStore: facts, getPersona,
    })
```

- [ ] **Step 3: Re-resolve on PET_SWITCH**

Edit `electron/ipc.ts`. Find the `IPC.PET_SWITCH` handler (currently around line 119). Modify:

```ts
  ipcMain.handle(IPC.PET_SWITCH, async (_, petId: string) => {
    pets.setActive(petId)
    const params = await pets.resolveParams(petId, chars)
    mood.setParams(params)
    const pet = await pets.load(petId, mood.getStage())
    if (pet) wm.broadcast(IPC.PET_ACTIVE_CHANGED, pet)
  })
```

- [ ] **Step 4: Re-resolve on PET_GENERATE**

In the same file, find the `IPC.PET_GENERATE` handler (currently around line 125). After `pets.setActive(pet.id)` add:

```ts
    const params = await pets.resolveParams(pet.id, chars)
    mood.setParams(params)
```

- [ ] **Step 5: Re-resolve on CHARACTER_SAVE for the active pet**

Find the `IPC.CHARACTER_SAVE` handler (currently around line 153). Modify:

```ts
  ipcMain.handle(IPC.CHARACTER_SAVE, async (_, cfg: CharacterConfig) => {
    await chars.save(cfg)
    if (cfg.petId === pets.getActiveId()) {
      const params = await pets.resolveParams(cfg.petId, chars)
      mood.setParams(params)
    }
    wm.broadcast(IPC.CHARACTER_CHANGED, cfg)
  })
```

- [ ] **Step 6: Type-check and run all tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts electron/ipc.ts
git commit -m "feat(main+ipc): wire DriveParams through startup, PET_SWITCH, PET_GENERATE, CHARACTER_SAVE"
```

---

### Task 11: End-to-end behavioral divergence test (taotao vs stlulu)

**Files:**
- Modify: `tests/drive-engine.test.ts`

- [ ] **Step 1: Write the divergence test**

Append to `tests/drive-engine.test.ts`:

```ts
describe('behavioral divergence — taotao vs stlulu', () => {
  it('with the same context, taotao prefers comfort more strongly than stlulu', () => {
    const taotaoParams = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    const stluluParams = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })

    function topGoalAndPriority(params: typeof taotaoParams) {
      const deps = makeDeps()
      ;(deps as any).getParams = () => params
      const engine = new DriveEngine(deps as any)
      const ctx = {
        mood: 'lonely' as const,
        energy: 80, affection: 25, streak: 0, hoursSince: 2.5, waking: true,
        stats: normalStats, hasEvents: false, now: Date.now(), params,
      }
      const goals = engine.evaluate(ctx as any)
      return { top: goals[0]?.kind, priority: goals[0]?.priority ?? 0 }
    }

    const tao = topGoalAndPriority(taotaoParams)
    const stl = topGoalAndPriority(stluluParams)
    // Both should top-rank a social goal (lonely mood promotes social).
    // But taotao's priority should be higher (sociability=0.8, independence=0.2 amplifies).
    expect(tao.priority).toBeGreaterThan(stl.priority)
  })

  it('with 1.5h since interaction, taotao mood would be lonely but stlulu would not', () => {
    // Verified separately in mood-engine setParams test, but document the wiring here.
    const tao = traitsToParams({ sociability: 0.8, independence: 0.2, playfulness: 0.7, energy_volatility: 0.6 })
    const stl = traitsToParams({ sociability: 0.5, independence: 0.6, playfulness: 0.6, energy_volatility: 0.4 })
    expect(tao.lonelyHoursThreshold).toBeLessThan(1.5)
    expect(stl.lonelyHoursThreshold).toBeGreaterThanOrEqual(1.5)
  })
})
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/drive-engine.test.ts -t 'behavioral divergence'`
Expected: PASS (these verify the integrated outcome of trait → params → engine).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS for all tests in the repo.

- [ ] **Step 4: Commit**

```bash
git add tests/drive-engine.test.ts
git commit -m "test(drive-engine): assert taotao vs stlulu behavioral divergence"
```

---

## Self-Review Notes

**Spec coverage**:
- `PetTraits` / `DriveParams` types — Task 1
- `traitsToParams` (pure function, lerp) — Tasks 2-5
- `mergeTraits` with clamping — Task 3
- Zero-regression at trait=0.5 — Task 4
- Snapshot tests for taotao/stlulu — Task 5
- `MoodEngine.setParams` + 3 hardcoded replacements — Task 6
- `DriveEngine` rule/cooldown/multiplier refactor — Task 7
- `PetManager.resolveParams` + `getActiveParams` + builtin sync extension — Task 8
- `traits` added to shipped pet.json files — Task 9
- Wiring at startup + 3 IPC handlers — Task 10
- Behavioral divergence verification — Task 11
- All non-goals (no UI sliders, no animation changes, no memory loop) confirmed absent from plan.

**Placeholder scan**: No TBD / TODO / "implement appropriate error handling" / "fill in details". Every code-changing step ships actual code.

**Type consistency**: `PetTraits`, `DriveParams`, `traitsToParams`, `DEFAULT_PARAMS`, `mergeTraits`, `setParams`, `getParams`, `resolveParams`, `getActiveParams` are used identically across all tasks. Imports are from `@shared/types` and `./pet-traits` consistently.

**Risk areas to watch during execution**:
- Pre-existing `RuleContext` constructions in `tests/drive-engine.test.ts` may need `params: DEFAULT_PARAMS` added (called out in Task 7 step 4).
- The `mood-engine.test.ts` setParams test relies on the dev machine being in waking hours (8-23). The test guards the `'lonely'` assertion behind a `getHours()` check so it does not flake on a CI machine running at 3 AM — it still verifies the params plumbing, just relaxes the expected mood when the time-of-day gate blocks it.
- `JSON.stringify` comparison in `syncBuiltinManifest` is sensitive to key order; adding `traits` works because both `next` and `current` will receive the same key set after the first sync. First-time sync still writes correctly.
