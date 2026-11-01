# Cost configuration: sources and status

Four files, typed in `src/contracts/types.ts` (`Prices`, `Rung`, `CapConfig`, `StagesFile`). US dollars per million tokens. Every format key is `both`, `email`, `landing_page`. JSON cannot carry comments, so the sources are here. `cap.json`'s S, U and the `sonnet-default` `both` E_out are measured on 2026-11-01 (real `count_tokens` and 21 real calls on prompt v1: S 6,453, suffix 770 to 1,375, output mean 2,961, max 4,035). Email and landing S are derived from count_tokens, not from a cached call. Every other token figure is still `[assume]`.

## `prices.json` `[verified 2026-11-01]`

Opened https://platform.claude.com/docs/en/about-claude/pricing. All rows unchanged from 2026-10-29.

| model | in | out | 5-minute write | read |
|---|---|---|---|---|
| `claude-opus-5-5` | 4.00 | 20.00 | 5.00 | 0.20 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 0.10 |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.01 |

- `batch_factor` and `write_1h` are gone: 46's `Prices` has neither, and Batches are off.
- Haiku above 100K prompt tokens costs 0.50 / 2.50. Unreachable, since `U_hard` is 26,760.
- `billed_refusal_categories` `[verified 2026-11-01]`, https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#how-refusals-are-billed, which dates its list September 2026 and can change.
- Do not read cache prices from the `claude-api` skill's Sonnet paragraph: it says $0.20. The live page says $0.10.

## `rungs.json`, `cap.json`

`E_out = V + T`, `max_tokens = 3 × E_out`. `V`: email 250, landing_page 500, both 750 (the cost plan). One `T` per rung, the same for every format. All `T` are `[assume, placeholder]`.

| rung | T | max_tokens both / email / landing_page | `callWorst` both |
|---|---|---|---|
| `sonnet-between_tools` | 0 | 2,250 / 750 / 1,500 | $0.0327 |
| `sonnet-low` | 500 | 3,750 / 2,250 / 3,000 | $0.0477 |
| `sonnet-medium` | 1,000 | 5,250 / 3,750 / 4,500 | $0.0627 |
| `sonnet-default` | 2,000 | 8,250 / 6,750 / 7,500 | $0.0927 |
| `haiku-disabled` | 0 | 2,250 / 750 / 1,500 | $0.0016 |
| `haiku-medium` | 500 | 3,750 / 2,250 / 3,000 | $0.0024 |
| `opus-default` | 500 | 3,750 / 2,250 / 3,000 | $0.0954 |

`callWorst` = `(S × write_5m + U_design_max × in + max_tokens × out) ÷ 1e6`. Default, both: `(7,500 + 2,676 + 82,500) ÷ 1e6 = $0.0927`.

**6,150 vs 6,000:** 6,150 was an arithmetic error. The old basis gave `3 × (1,500 + 400 + 100) = 6,000`. Both are now superseded: at T 2,000 landing_page is `3 × 2,500 = 7,500`.

| field | value | derivation |
|---|---|---|
| `S` | 3,000, all keys | The cost plan; the prompt came to about 3,100 by chars ÷ 4. One prefix for every format (R97). The schema's injected system prompt is outside that count `[verified 2026-11-01, structured-outputs page: it costs tokens like any system prompt]`. Stage 0 counts it per schema |
| `U_design_max` | 1,338, all keys | 1.25 × 1,070, rounded up. Same suffix for every format |
| `U_hard` | 26,760, all keys | 20 × `U_design_max` (R40) |
| `sha256` | placeholder | stage 0 writes it |

`CAP_CUSTOMER` and `CAP_RUN` are derived, never typed. At these values: `CAP_CUSTOMER = 2 × 0.0927 = $0.1854`; `CAP_RUN` for F `= 1.05 × (20 × 0.07428 + 0.25 Jev) = $1.82`.

## `stages.json` and the bound beside each ceiling

Keys are `Stage`. Stages 0 and G are previews with no run row, so they have no key. `voice` is 2 runs: run 1 0.87, run 2 0.24; dividing gives 0.555 per run, which fits neither, so read the table for per-run figures. Spend, not `stages.json`, is what stops work: 46 has no `spendGate`.

| stage | pairs | expected | forecast ceiling | `max_tokens` bound |
|---|---|---|---|---|
| voice run 1 | 22 | 0.87 | 1.63 | 4.08 |
| voice run 2 | 6 | 0.24 | 0.45 | 1.11 |
| F | 20 | 0.79 | 1.49 | 3.71 |
| rehearsal | 3 | 0.12 | 0.22 | 0.56 |
| Haiku `disabled` | 20 | 0.01 | 0.03 | 0.07 |
| isolation | stub | 0 | 0 | 0 |
| dev calls, not a stage | | 0.50 | 0.50 | 0.50 typed |
| J3, not a stage | | 0.03 | 0.25 | 0.25 reserve |
| **total** | | **2.56** | **4.57** | **10.27** |

Pair: expected `(660 + 2,140 + 27,500) ÷ 1e6 × 1.3 = $0.0394`; forecast `2 × (7,500 + 2,140 + 27,500) ÷ 1e6 = $0.0743`; bound `2 × 0.0927 = $0.1854`. Haiku bound `2 × 0.00163 × 20`. The cost plan says about $10.10; this table gives $10.27. Only the expected and forecast columns reproduce the plan exactly.

## Retry cache miss

A part-scoped retry changes `output_config.format`, and the docs say that invalidates the prompt cache `[verified 2026-11-01, structured-outputs page]`. So a retry cannot read the `both` entry. Each schema has its own entry, and a miss pays `3,000 × (2.50 − 0.22) ÷ 1e6 = $0.00684`.

| at r 0.29, 5.8 retries per 20 | per run |
|---|---|
| one cold write per part schema, the rest read | +$0.012 |
| every retry misses | +$0.040 |
| offset: a retry writes one part, 250–500 fewer output tokens | −$0.015 to −$0.029 |

Net −$0.02 to +$0.03 on F's 0.79, inside the ×1.3. The forecast and bound already charge a write on both calls, so neither moves.

**Larger and avoidable:** `GEN_CONCURRENCY` 4 opens with 4 calls that all write, because an entry is readable only once the first response begins streaming `[verified 2026-11-01, claude-api skill, prompt-caching]`. That is h 80%, not 95%: `3 × 3,000 × 2.4 ÷ 1e6 = +$0.022` per run. Send one call, wait for its first token, then fan out.

## Open

1. `T`, `S` and `U`: stage 0 and the first pairs. Whichever way they fall, reset `cap.json` and `rungs.json` once and restage.
2. Whether the retry adds a new write or the injected prompt sits after the breakpoint: `usage.cache_read_input_tokens` on the first real retry.
3. `$0.17` gap to the cost plan's $10.10 bound: unconfirmed.
4. R2 free allowance for 14 MB: not checked here.
