# Low-level design

Status: `draft`, compared with the built code on 2026-11-01. [contracts.md](contracts.md) is the contract. This page says where each part lives and how it is tested.

| part | code | contract | tests |
|---|---|---|---|
| Snapshot build | `scripts/build.ts`, `samples/site/`, `src/lib/catalog/` | [Inputs](contracts.md#inputs) | 2,180 usable rows reproduced from the frozen pull |
| Ingest, plan | `src/lib/ingest.ts`, `recs.ts`, `shape.ts`, `plan.ts` | [Inputs](contracts.md#inputs) | Row-level failures; 19 rows and `c20` |
| Request | `src/lib/gen/` | [Model output](contracts.md#model-output) | Prefix byte-identical across customers, formats and attempts; no unfilled placeholder |
| Checks | `src/lib/check/` | [Checks](contracts.md#checks) | `npm run eval` |
| Render | `src/lib/render/` | [Model output](contracts.md#model-output) | No script in frame; 390 px render; link and image integrity |
| Run | `src/workflow/` | [State machines](contracts.md#state-machines) | Line 3 on a real Workflow instance; replay; kill after answer; restart |
| State | `src/lib/state/` | [State machines](contracts.md#state-machines) | Every edge; illegal writes refused by `CHECK` |
| Cost | `src/lib/cost/` | [Cost](contracts.md#cost-and-cap) | Admission, cap, `OVER_CAP`, retry gate |
| Jev | `src/lib/jev/` | [Prompts and Jev](contracts.md#prompts-and-jev-versions) | Stubbed transport only. A flag never changes a check |
| Prompt versions | `src/lib/config/`, `src/ui/agents/` | [Prompts and Jev](contracts.md#prompts-and-jev-versions) | Tamper refused; validators; locked fields |
| Routes, UI | `src/worker/`, `src/ui/` | [Routes](contracts.md#routes) | Route order; 503 on the deployed build; auth fails closed |
| Local run | `scripts/demo.ts`, `scripts/batch.ts`, `scripts/stub-llm.ts` | [Routes](contracts.md#routes) | 20 drafts on the stub from a clean clone; `batch` refuses with no key |
| Demo export | `scripts/export-demo.ts` | [Hosted link](contracts.md#hosted-link) | On fixtures only. Never run end to end |

## Error handling

Coded outcomes are the design: see [codes](contracts.md#codes). A line of JSON is logged per step, keyed by run and customer, with no prompt, body or name.

| failure | handling |
|---|---|
| 429, 5xx, refused connection | Unbilled. Retried by the step |
| Connection lost after send | `possibly_billed`. Never retried blind |
| Last try answered, write failed | `possibly_billed` at the estimate, never $0 |
| Refusal | Not retried. `failed{UPSTREAM_UNAVAILABLE}` |
| Check failure | Failed part retried once, with the failing check ids. Then `failed{CHECKS_FAILED}` |
| `max_tokens` stop or schema failure | Both parts regenerate |
| Process killed | `POST /api/runs/:id/restart` resumes the same run id |
| Run stopped | A generate step makes no call and settles unbilled. A unit that ends failed during the stop stays failed after restart |
| Snapshot missing from R2 | 503 `CATALOG_MISSING` |
| Spend over `cap_run_usd` | Retries refused. `close` logs `cap_breach` |

## Test plan

- `npm test`: unit and worker tests.
- `npm run eval`: offline checker, mutants, known gaps.
- `npm run readiness`: durability, replay, idempotency, isolation, retry, cap, observability and the approval gate, on real local runs against a stub model. A line counts only if its assertion was seen failing. The gate's clauses go red on patched copies of the source under `out/readiness/tree`, restored and diffed before the green run.
- `npm run demo`: the whole path from a clean clone, no key.
- `npm run smoke`: types, both bundles, `/review` loads.
- Real run: [[SLOT real run: id and report]].
