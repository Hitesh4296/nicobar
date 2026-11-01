# Contracts

The code is the authority where it can be. **DDL:** `migrations/0001_core.sql`, `0002_config.sql`. **Types and signatures:** `src/contracts/types.ts`, `lib.ts`, `config.ts`. **Codes:** `src/contracts/codes.ts`. This page holds what those files do not say.

## What lives where

| object | location | writer | notes |
|---|---|---|---|
| Site sample | `samples/site/` | committed once | The frozen pull the build reads, minus gift cards. No image files |
| Snapshot | R2 `snapshots/<id>/catalog.json`, `rules.json`; D1 `snapshots` | `scripts/build.ts --publish` | Frozen 2026-10-29. Catalogue is 21.5 MB `[verified 2026-11-01]` |
| Customer input | `data/*.tsv`; R2 `customers/<sha256>.tsv` | `POST /api/runs` | Immutable by hash. Last names never deploy |
| Rec input | `data/recommendations.synthetic.json`; R2 `recs/<sha256>.json` | `POST /api/runs` | Immutable by hash |
| Occasion keys | `data/row_keys.synthetic.json` | reviewed edit | Keys only. Bundled |
| Plan preview | R2 `previews/<sha256>.json` | `scripts/preview.ts` | A run must quote its hash |
| Run records | D1 | see below | Kept. One run id takes one POST |
| Prompts, Jev config | D1 `config_versions`; import files in `config/prompt/<id>/`, `config/jev.json` | `saveVersion`, `activateVersion` | Content never changes after save |
| Schemas, lists, prices | `config/` | reviewed edit | Bundled |
| Reports | `reports/eval.json`, `reports/readiness.json` | `npm run eval`, `npm run readiness` | Regenerated |
| Secrets | `.dev.vars`, Wrangler secrets | operator | Gitignored. No model key on a deployed link |

| table | only writer |
|---|---|
| `runs` | `POST /api/runs`, `restart`, `mark-stopped`, run steps |
| `units` | `moveUnit`, plus `setting` at `admit` |
| `plans` | `prep` inserts, `admit` updates. Immutable after |
| `cost_events` | `admit`, `gen`, `finish`, through `settle` |
| `generations` | `gen` |
| `drafts` | `insertDraft`, `transition` |
| `draft_events` | `transition`, E1. Append only |
| `jev_events` | `finish` |
| `ledger_manual` | `POST /api/ledger`, `POST /api/config/:id/judge`. Append only |
| `config_versions` | `saveVersion` inserts; `activateVersion` alone updates |
| `jev_dismissals` | `dismissFlag`. Append only |

## Inputs

**`customers/v2`.** UTF-8 TSV, LF. Header exactly `customer_id first_name last_name occasion past_purchase_note`.

| layer | condition | result |
|---|---|---|
| file | no parse, wrong header, 0 rows, or `.synthetic.` in the name disagrees with `customers_synthetic` | 400, no run row |
| row | field count ≠ 5, or id fails `^[A-Za-z0-9_-]{1,64}$` | key `row:<n>`, `failed{INVALID_CUSTOMER}` |
| row | id repeats | every occurrence `row:<n>`, `failed{DUPLICATE_CUSTOMER_ID}` |
| row | occasion blank and not `new_user` | `failed{INVALID_CUSTOMER}` |

`new_user`: the note, trimmed, is blank, `-`, `n/a`, `none`, `null`, or matches `/no (purchase|order|history)/i`. `last_name` stops at ingest. The note sentence stops at ingest. `Customer.note_words` (lowercase words) reaches `planCustomer` only to check a past-purchase rail's label, and no plan holds any of it.

**`recommendations/v1`.** `{version, synthetic, as_of, snapshot_id, rule, rows:[{customer_id, picks:[{product_id, reason_code}]}]}`, ranked, 0–6 picks. No copy, title, image, price or format. Optional `more:[{kind, label, product_ids}]`, up to 6 sections and 60 ids: extra products that code renders on the catalog and landing page under code-set headings, in page order picks, `occasion_category`, `occasion`, `past_purchase`. Email stays picks only. A `past_purchase` section is written only when at least `limits.min_occasion_in_past_rail` of its products also match the occasion. Optional `why`, on a pick as `string[]` and on a section as `{product_id: string[]}`: signal names from a fixed list, shown to the reviewer on the Plan step, never to the model. A file without it parses as before. `src/lib/rank/` writes this file; a real recommender can replace it by this contract.

**`row_keys`.** `{"c01": {"key": "wedding"}, …, "c20": {"key": null}}`. `parseRowKeys` refuses any other field.

**`prep` order, first hit wins:**
1. Row invalid → as above.
2. No rec row → `new_user` ? `failed{COLD_START_NO_HISTORY}` : `failed{NO_RECOMMENDATION}`.
3. Pick not usable, or a duplicate → `failed{INVALID_PICK}`.
4. N < 4 for `both` or `landing_page`, N < 3 for `email` → `failed{TOO_FEW_CANDIDATES}`.
5. Catalog render, X1–X3 → failure is `failed{INVALID_PICK}`, $0.

**A `none` row drafts:** `{{occasion}}` = `none`, key null, shape `open`, no quotes.

## Model output

`config/schemas/draft-both.v1.json` is `{email: draft-email/v2, landing_page: draft-landing/v3}`. `runs.format` (`both`, `email`, `landing_page`) moves the output schema only, never the prompt prefix. Stored shape, always: `ModelJson`, `{email?, landing_page?, unparsed?}`.

- **Email:** `occasion_key`, `subject`, `preheader`, `body`. Fixed template.
- **Landing page:** `occasion_key`, `sections`, from seven components: `hero`, `story`, `feature`, `product_grid`, `pairing`, `packing_list`, `quote`.
- **Shape** is set by code from the occasion: `trip`, `gift`, `home`, `wedding`, `scene`, `open`. The model arranges within it.
- **Slot tokens** `{p1}`…`{p6}` stand for picks. Email uses p1–p3.
- **Product list:** rendered by code from the picks. No model call and no price.
- **Retry:** failed part regenerated, passing part carried byte-identical. A schema failure or `max_tokens` stop regenerates both.

No tools are given to the model.

## Checks

One `validate` runs in `finish` and again at E2, E4 and E7 on the stored `model_json`. `validateRendered` runs on the HTML. Hard failures block review.

| id | catches |
|---|---|
| C0 | Characters outside an explicit set |
| C1 | Schema |
| C2, C2.L1–L7 | Slot use and adjacency; landing layout rules |
| C3, C3.L | Body over 120 words. Counts prose plus titles expanded inside it |
| C4 | Discount, pressure, scarcity, deadline, spend and familiarity phrases |
| C5 | URLs and digit runs |
| C6 | Occasion key equals the plan's |
| C7 | Ungrounded attributes and counts, scoped to the pick |
| C8, C8d, C8d-x, C8c | Product names not among the picks |
| C8n | Echo of a past item |
| C8o | An occasion name on a row with no occasion |
| X1 | Card image, title, alt and link all belong to one pick |
| X2 | Image on the shop's CDN path and in the pick's snapshot images |
| X3 | Link to a pick's handle on nicobar.com |
| X4 | Alt text |
| `J3-*` | Jev flags. Advisory. Never changes `hard_failures` |

## State machines

**Draft.** No `release` edge exists outside `approved`.

| edge | actor | condition |
|---|---|---|
| E1 → `draft` | system | Insert by deterministic id `<run>:<customer>:v<n>` |
| E2 → `in_review` | system | From `draft`, 0 hard failures, hash matches |
| E3 → `failed` | system | From `draft`, hard failures > 0 |
| E4 → `approved` | human | From `in_review`, 0 hard failures, hash matches. Writes approver, time and `approved_sha256` |
| E5 → `rejected` | human | From `in_review`. Note required. Terminal for that run |
| E6 → `in_review` | human | Revoke, from `approved`. Clears approval |
| E7 → `released` | human | From `approved`, `approved_sha256` = `content_sha256`, plus freshness |

Each edge is one D1 batch keyed by a fresh nonce. `transition` returns a result and does not throw on a wrong state. E2, E4 and E7 re-run the checks. `CHECK` constraints refuse `released` without an approval, and any `approved` or `released` row with hard failures.

**Unit.** `pending → prepared|failed`; `prepared → admitted|skipped|failed`; `admitted → admitted (retry)|drafted|failed`.

**Run.** `preparing → generating → done`. `close` with units left open gives `stopped`, reason `close_incomplete`. `mark-stopped` stops a run and leaves open units open. `restart` resumes a stopped run under the same id, and a `done` run answers 409. A generate step on a stopped run makes no call and settles unbilled. If `terminate()` failed and the Workflow kept going, its remaining units end `failed{UPSTREAM_UNAVAILABLE}`, and `restart` does not regenerate them.

**Config version.** `draft → active → retired`, nothing else.

## Codes

`failed`: `COLD_START_NO_HISTORY` (new user, no rec row, 0 calls), `NO_RECOMMENDATION`, `INVALID_PICK`, `TOO_FEW_CANDIDATES`, `INVALID_CUSTOMER`, `DUPLICATE_CUSTOMER_ID`, `CHECKS_FAILED`, `UPSTREAM_UNAVAILABLE`, `INVALID_REQUEST`, `INTERNAL_ERROR`.

`skipped`: `ESTIMATE_FAILED`, `OVER_CAP`, `RUN_CAP`. A skipped unit has no billed attempt, by `CHECK`.

## Routes

Auth runs on every route: a verified Access token, or `DEV_MODE` locally. Missing config answers 503. Mutating routes also check `Origin`. Errors are `{code, detail?}`.

| route | deployed |
|---|---|
| `POST /api/runs` | 503 |
| `POST /api/runs/:id/restart`, `/mark-stopped`, `POST /api/ledger` | 503 |
| `GET /review`, `/review/runs/:id/plans`, `/review/:id` | yes |
| `POST /api/drafts/:id/{approve,reject,revoke,release}` | yes |
| `GET /released/:id?part=email\|landing_page\|catalog` | yes |
| `GET /review/spend`, `/review/published`, `/review/evals` | yes |
| `GET /review/agents`, `/review/agents/:id?against=<id>`, `GET /api/config/:id` | yes |
| `POST /api/config`, `/api/config/:id/activate`, `/api/config/:id/judge` | 503 |
| `POST /api/drafts/:id/flags/:question/dismiss` | yes |

`POST /api/runs` body: `{run_id, stage, snapshot_id, customers_name, customers_tsv, customers_synthetic, recs_json, preview_sha256}`. Both files travel as raw strings, because the preview hashes bytes. `cap_run_usd` in a body is a 400. A changed prompt since the preview is 409 `PREVIEW_STALE`. Format and start rung come from the preview.

## Cost and cap

Enforced before each call, from `count_tokens`:

- `callWorst` = (S × write price + input × input price + `max_tokens` × output price) ÷ 1e6.
- `CAP_CUSTOMER` = 2 × `callWorst` at the design input size.
- `commit` = 2 × the estimate for one call.
- `cap_run_usd` = 1.05 × (Σ commit + Jev reserve), computed from the preview, never typed.

| condition | action |
|---|---|
| No estimate | `skipped{ESTIMATE_FAILED}` |
| Input over `U_hard`, or `2 × callWorst` over `CAP_CUSTOMER` | `skipped{OVER_CAP}`. No truncation and no downgrade |
| Σ commit past the budget | `skipped{RUN_CAP}` for the rest, logged |
| Retry over the customer cap, or `spent + estimate` over `cap_run_usd`, or not covered by the pool | `retry_blocked`, the unit ends failed |

Spend can pass `ceiling_usd` and `cap_run_usd`, because an attempt that runs to `max_tokens` costs more than its commit. `close` then logs `cap_breach`. That is a log line only, not a stored field. Billed attempts cannot pass 2.

## Prompts and Jev versions

A save creates a new immutable row. Activation validates, retires the old version and activates the new one in one batch, and refuses a version whose parent is no longer active. A hash mismatch at load is `TAMPERED`, and the unit fails alone.

| editable | locked |
|---|---|
| Role, voice card, email, landing, task and retry text; Jev question wording and criteria; `flag_gate`, `score_flag_confidence` | Schemas, check lists, Jev model, deadline, `act`, question keys and types |

A prompt may use only named placeholders, so a name or note cannot be requested. A change voids eval results that depend on prompt text until a run pins it. It never touches an approved draft: `approved_sha256` binds the draft. Dismissing a Jev flag writes one row and changes no draft column.

## Records

One JSON log line per step: `{run_id, key, step, status, code?, ms, est_usd?, charged_usd?}`. `runReport` is computed on read: counts, per-part first-try pass, retry cause, estimate against actual, cap.

## Hosted link

One Worker in `env.demo`, behind Access. Seeded from a real run on a copy of local D1, by real `transition` calls under a labelled seed actor. It receives no customer files, last names or model keys. Run and config-write routes answer 503. D1 caps a statement at 100,000 bytes, so `scripts/export-demo.ts` splits large cells. Workers Paid is needed, because E4 and E7 parse the catalogue, which cannot fit the free plan's CPU limit. Not done: no link exists. `npm run deploy:demo` runs `predeploy:check` first, which refuses a `DEV_` var in any scope, an empty `TEAM_DOMAIN` or an empty `database_id`. Both values are empty in `wrangler.jsonc` today. At run time, `DEPLOYED=1` with any `DEV_MODE` answers 503.
