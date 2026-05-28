# Personality-Driven Behavior — Design Spec

**Date**: 2026-05-27
**Status**: Draft, awaiting user review
**Author**: brainstorming session (renjiawei + Claude)
**Scope tag**: `feat/personality-traits`

---

## Background

The pet-monitor-app currently runs two pets (`taotao`, `stlulu`) that share the **same** mood/drive engine constants. Although each pet has a `CharacterConfig.personality` array and a custom `systemPrompt`, these only influence the LLM-generated bubble text — they do **not** change *when*, *how often*, or *what kind of* goals the pet pursues. As a result, both pets exhibit identical proactive behavior and feel like skins on a single pet, not distinct characters.

This spec describes how to introduce a small set of high-level personality axes that genuinely drive the `MoodEngine` thresholds and `DriveEngine` rule parameters, so that two pets with different traits produce visibly different proactive behavior under the same external events.

## Goals

- Two pets with different `traits` produce **observably different** proactive behavior under identical event sequences (different `lonely` onset, different greet/comfort frequency, etc.).
- The default traits value (every axis = `0.5`) maps to the **exact** current hardcoded constants, guaranteeing zero behavioral regression for any pet that omits traits.
- Pet authors can ship a default personality with `pet.json`; users can override per-installation via `CharacterConfig.traitsOverride`.
- Pure-function mapping `traitsToParams()` is fully unit-testable without spinning up the engines.

## Non-Goals (explicitly out of scope this round)

- Settings UI sliders for traits (JSON hand-edit only this round).
- Memory → mood feedback loop (separate spec).
- Drive rule **learning** from user engagement beyond the existing `feedback` map.
- Trait-driven animation or sprite changes (this round only modifies mood/drive numerical behavior).

## Architecture

```
┌──────────────────────────────┐     ┌──────────────────────────────────┐
│ assets/pets/<id>/pet.json    │     │ userData/characters/<id>.json    │
│   traits: {                  │     │   traitsOverride?: {             │
│     sociability: 0.7,        │     │     sociability: 0.4             │
│     independence: 0.3,       │     │   }                              │
│     playfulness: 0.5,        │     │                                  │
│     energy_volatility: 0.5   │     │                                  │
│   }                          │     └──────────────────────────────────┘
└────────────┬─────────────────┘                  │
             │           mergeTraits(petJson, override) — override wins, missing → 0.5
             └─────────────┬────────────────────────┘
                           ▼
                    PetTraits  {sociability, independence, playfulness, energy_volatility}
                           │
                           ▼ traitsToParams() — pure function, full unit-test coverage
                           │
                    ┌──────┴──────────────────────────┐
                    │  DriveParams                    │
                    │    lonelyHoursThreshold         │
                    │    energyDecayPerHour           │
                    │    energyRecoveryChat           │
                    │    greetAffectionThreshold      │
                    │    greetHoursThreshold          │
                    │    checkInHoursThreshold        │
                    │    curiosityAffectionThreshold  │
                    │    goalKindMultipliers          │
                    │    cooldownMsByKind             │
                    └──┬──────────────┬───────────────┘
                       │              │
                       ▼              ▼
                 DriveEngine    MoodEngine
            (reads params.* instead of hardcoded constants)

Activation hook: when active pet changes, pet-aggregator resolves the pet,
                 computes params once, and re-injects into mood/drive engines.
```

### Key invariants

1. All trait axes default to `0.5`, which maps to the current hardcoded values → **zero regression**.
2. Two-layer merge: `CharacterConfig.traitsOverride` wins per axis; missing axes fall back to `pet.json.traits`; missing there falls back to `0.5`.
3. When the user switches active pet, the entire `DriveParams` is swapped; engines do not mix params from different pets.

## Data Model

### New types (added to `src-shared/types.ts`)

```ts
export interface PetTraits {
  sociability: number       // 0-1, 默认 0.5 — 对人的依恋/求关注程度
  independence: number      // 0-1, 默认 0.5 — 对独处的耐受度
  playfulness: number       // 0-1, 默认 0.5 — 庆祝/好奇/玩闹倾向
  energy_volatility: number // 0-1, 默认 0.5 — 体力波动剧烈程度
}

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

### Extended existing types

- `Pet` interface (`src-shared/types.ts`): add optional `traits?: PetTraits`.
- `CharacterConfig`: add optional `traitsOverride?: Partial<PetTraits>`.

### Trait → params mapping rules

Each rule is linear interpolation `lerp(low, high, trait)` with ranges **symmetric around the current hardcoded value**, so `trait = 0.5` returns exactly the current hardcoded value (zero-regression invariant).

| Trait axis | Affected parameter | Mapping (trait 0 → 1) | At 0.5 |
|---|---|---|---|
| **sociability** | `lonelyHoursThreshold` | 3h → 1h | 2h |
| | `greetHoursThreshold` | 3h → 1h | 2h |
| | `checkInHoursThreshold` | 6h → 2h | 4h |
| | `greetAffectionThreshold` | 20 → 40 (higher → easier to trigger) | 30 |
| | `goalKindMultipliers.greet` | 0.6 → 1.4 | 1.0 |
| | `goalKindMultipliers.comfort` | 0.6 → 1.4 | 1.0 |
| | `goalKindMultipliers.check_in` | 0.7 → 1.3 | 1.0 |
| **independence** | `goalKindMultipliers.greet` | 1.4 → 0.6 (multiplied with sociability factor) | 1.0 |
| | `goalKindMultipliers.comfort` | 1.4 → 0.6 | 1.0 |
| | `cooldownMsByKind.greet` | 20min → 40min | 30min |
| | `cooldownMsByKind.comfort` | 20min → 40min | 30min |
| **playfulness** | `goalKindMultipliers.curiosity` | 0.6 → 1.4 | 1.0 |
| | `goalKindMultipliers.celebrate` | 0.6 → 1.4 | 1.0 |
| | `curiosityAffectionThreshold` | 90 → 70 (lower → easier to trigger) | 80 |
| **energy_volatility** | `energyDecayPerHour` | 1.0 → 3.0 | 2.0 |
| | `energyRecoveryChat` | 2 → 4 | 3 |

When multiple traits influence the same `goalKindMultipliers.<kind>`, the per-trait contributions are **multiplied** (so a low-sociability + high-independence pet truly suppresses `comfort`). Defaults (no contribution): missing kind = factor `1.0`.

The current global `COOLDOWN_MS = 30 * 60_000` (30 min) is preserved as the fallback for goal kinds not listed in `cooldownMsByKind`.

### Initial trait values for shipped pets

| pet | sociability | independence | playfulness | energy_volatility |
|---|---|---|---|---|
| **taotao** (软萌粘人) | 0.8 | 0.2 | 0.7 | 0.6 |
| **stlulu** (开朗助手) | 0.5 | 0.6 | 0.6 | 0.4 |

## Components & Changes

### New files

#### `electron/pet-traits.ts` (~80 lines)

- `DEFAULT_TRAITS: PetTraits` — every axis at `0.5`.
- `mergeTraits(petJsonTraits?: PetTraits, override?: Partial<PetTraits>): PetTraits` — two-layer merge with `0.5` fallback per axis.
- `traitsToParams(traits: PetTraits): DriveParams` — pure function applying the mapping table above. Uses an internal `lerp(t, low, high)` helper.
- Exports `DEFAULT_PARAMS = traitsToParams(DEFAULT_TRAITS)` as a sanity constant for tests and engines.

#### `tests/pet-traits.test.ts` (~150 lines)

See [Testing](#testing) section.

### Modified files

#### `src-shared/types.ts` (+15 lines)

- Add `PetTraits` and `DriveParams` interfaces.
- `Pet` gains `traits?: PetTraits`.
- `CharacterConfig` gains `traitsOverride?: Partial<PetTraits>`.

#### `electron/mood-engine.ts` (~10 lines changed)

- Add `private params: DriveParams = DEFAULT_PARAMS` field.
- Add public method `setParams(p: DriveParams): void`.
- `tick()`: replace `s.energy - hoursSinceInteraction * 2` with `... * this.params.energyDecayPerHour`.
- `computeMood()`: replace `hoursSinceInteraction > 2` (lonely check) with `> this.params.lonelyHoursThreshold`.
- `onInteraction('chat')`: replace `+ 3` with `+ this.params.energyRecoveryChat`.

#### `electron/drive-engine.ts` (~20 lines changed)

- Extend `DriveDeps` with `getParams: () => DriveParams`.
- Add `params: DriveParams` to `RuleContext`.
- In each of the 7 rules, replace magic numbers with `ctx.params.*`:
  - rule 1 (greet): `ctx.params.greetAffectionThreshold`, `ctx.params.greetHoursThreshold`
  - rule 3 (remind_rest): keep `energy < 25` (energy is already trait-driven)
  - rule 6 (curiosity): `ctx.params.curiosityAffectionThreshold`
  - rule 7 (check_in): `ctx.params.checkInHoursThreshold`
- `applyModifiers()`: stack `params.goalKindMultipliers[g.kind]` **on top of** existing `MOOD_MULTIPLIERS[mood][g.kind]` (multiplied together).
- `dedup()`: replace global `COOLDOWN_MS` with `params.cooldownMsByKind[kind] ?? COOLDOWN_MS`.
- `tick()`: populate `ctx.params = this.deps.getParams()`.

#### `electron/pets.ts` (~25 lines)

- Add `private activeParams: DriveParams = DEFAULT_PARAMS`.
- Add async method `resolveParams(petId, charsStore): Promise<DriveParams>` — loads pet.json `traits`, merges with `charsStore.get(petId).traitsOverride`, returns `traitsToParams(merged)`. Caches the result on `activeParams` when called for the active pet.
- Add `getActiveParams(): DriveParams` — synchronous getter, returns the cached params (used by `DriveEngine.getParams` closure).
- `setActive(petId)` remains synchronous; callers are responsible for invoking `resolveParams` after to keep `activeParams` fresh.

#### `electron/main.ts` (~15 lines)

- After `pets.setActive('stlulu')` at startup: `const params = await pets.resolveParams('stlulu', chars); mood.setParams(params);`.
- Pass `getParams: () => pets.getActiveParams()` into the `DriveEngine` constructor (added to existing `DriveDeps`).

#### `electron/ipc.ts` (~10 lines)

- In `IPC.PET_SWITCH` handler: after `pets.setActive(petId)`, call `const params = await pets.resolveParams(petId, chars); mood.setParams(params);` before broadcasting.
- In `IPC.PET_GENERATE` handler: same after `pets.setActive(pet.id)`.
- In `IPC.CHARACTER_SAVE` handler: if the saved config is for the **active** pet, re-resolve and re-apply params (a `traitsOverride` change must take effect without restart).

#### `assets/pets/taotao/pet.json` and `assets/pets/stlulu/pet.json`

- Add a top-level `"traits": { ... }` field per the table above. No other changes.

### Estimated change size

- New code: ~120 lines
- Modified existing code: ~50 lines
- New tests: ~150 lines
- **No deletions**, **no UI changes**.

## Error Handling & Edge Cases

- **Missing `traits` in pet.json**: handled by `mergeTraits` falling back to `DEFAULT_TRAITS` per axis.
- **Out-of-range values** (e.g., user writes `1.5`): clamp to `[0, 1]` in `mergeTraits` to keep `lerp` outputs bounded. Log a warning when clamping occurs.
- **`NaN` or non-numeric** value in JSON: treated as missing (`0.5` fallback). Logged.
- **Engine startup before pet-aggregator finishes loading**: engines start with `DEFAULT_PARAMS` (already in their initialization), so behavior matches the pre-change hardcoded constants until the first `setParams` call.
- **Pet switch race**: `setParams` is synchronous; `getParams` returns the current closure. No partial-update window.

## Testing

### Unit tests (`tests/pet-traits.test.ts`)

1. **Zero-regression guard**: every field of `traitsToParams(DEFAULT_TRAITS)` strictly equals the current hardcoded engine constants.
2. **Directionality**: `traitsToParams({sociability: 1.0, ...}).lonelyHoursThreshold` is strictly less than the value at `sociability: 0.0`.
3. **Boundary safety**: `traits` at all-`0` and all-`1` produce finite, positive params (no `NaN`/`Infinity`/negative).
4. **Merge priority**: `mergeTraits({sociability: 0.7}, {sociability: 0.2})` returns `0.2`; `mergeTraits(undefined, undefined)` returns all-`0.5`; missing axes pull from petJson.
5. **Clamping**: out-of-range and `NaN` inputs are clamped to `0.5` (with a warning emitted).
6. **Snapshot tests**: capture the actual computed `DriveParams` for taotao and stlulu so future mapping tweaks are explicit in diffs.

### Engine integration tests

7. (`tests/drive-engine.test.ts`) — extend with: feed the same `RuleContext` (mood=`lonely`, affection=20, hoursSince=2.5) using taotao's params vs stlulu's params; assert taotao yields a higher-priority `comfort` goal than stlulu.
8. (`tests/mood-engine.test.ts`) — extend with: after `setParams` with `lonelyHoursThreshold=1` (taotao), `hoursSinceInteraction=1.5` returns `mood='lonely'`; with `lonelyHoursThreshold=5` (stlulu) the same input returns a non-lonely mood.
9. **State isolation**: after `setParams` swap, engines reflect the new params on the next `tick()` without leaking the previous values.

### Acceptance criteria (manual)

- All pre-existing mood/drive tests pass unchanged.
- New tests (1-9) pass.
- Running the app with taotao for a 2-hour idle period: `lonely` triggers and a `comfort`/`greet` bubble shows within the first hour.
- Running the same idle test with stlulu as the active pet: no `lonely` trigger within 2 hours; `system_check`/`remind_rest` remain the dominant proactive goals.

## Open Questions

None at design time. Implementation may surface integration-point questions (e.g., exact wiring in `pet-aggregator`); those will be resolved during the writing-plans phase.

## Out of Scope (recap)

- Settings UI sliders → next iteration
- Memory → mood feedback loop → separate spec
- Drive rule online learning (beyond existing feedback map) → separate spec
- Trait-driven animation/expression changes → separate spec
