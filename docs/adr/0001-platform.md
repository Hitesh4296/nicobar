# ADR 0001: Platform, orchestration and the approval gate

**Status:** hosting owner-approved 2026-10-29. Revised 2026-11-01 to match what was built; the revision is `proposed`.

## Context

A batch writes one result per customer, and a person approves it before release. The test is production behaviour: isolation, retry, cost, approval. Vendor facts below were read from the Cloudflare docs on 2026-10-29 and 2026-10-31.

## Acceptance lines served

1 (one result), 3 (one bad customer fails alone), 4 (release needs approval). Traceability and voice live in the checks and rendering.

## Hosting

| | **A: Cloudflare** Worker, Workflows, D1, R2, Access | B: container, laptop or one small VM |
|---|---|---|
| Fixed cost | $0 local. $5/month Workers Paid for a link. Access $0 under 50 users `[reported]` | $0 on a laptop. About $5.19/month on one VM `[verified 2026-10-29]`, plus auth |
| Failure isolation | Per-customer steps. Completed step results persist | `try…catch` in a loop. A crash loses work in flight |
| Retry | Declared per step, durable | Hand-written, not durable |
| Local development | `wrangler dev` emulates Workflows | Plain node and SQLite |
| Reviewer identity | Verified Access token | Must be built |

B meets lines 1 to 4 on one machine, with the same SQL. A earns its place through durable retries, a verified approver and a hosted link.

**Decision: A.** The core library knows no host. Two seams do: the run shell and the auth adapter.

## Orchestration

| option | isolation | verdict |
|---|---|---|
| **One Workflow per run, named steps per customer** | Step level | **Chosen.** Simple, resumable, one step history |
| One Workflow per customer | Structural | Needs a coordinator. The switch if a run outgrows one instance's step budget |
| Queues | Per message | Retries a whole batch unless acked, and adds a dead-letter path to run |
| Durable Objects, Agents SDK | Hand-built | Built for sessions and live connections. A batch has neither |
| Plain loop in one request | `try…catch` | No resume, and it dies with the request |

Sync calls only. The Batches API is priced at half, but its create call has no idempotency key, so a crash-safe submit needs reconciliation code. At this size that is a poor trade.

## One call or two per customer

| | **One call, combined output** | Two calls |
|---|---|---|
| Per customer | $0.0394 `[derived]` | $0.051 `[derived]` |
| State | No change to edges or keys | Join in `finish`, more attempts per unit |
| Risk | A pair passes less often than a part | More code in the longest build |

**Decision: one call,** with a part-scoped retry. The passing part is carried byte for byte. All parts share one draft row, so one approval binds them, and a passing part is never released alone.

## Approval gate

A UI checkbox would not meet line 4. `released` needs a compare-and-set from `approved`, and row `CHECK`s refuse every other route to it. The approver comes from a verified token, never a body. Approval stores the content hash, and release compares it. Checks re-run at E2, E4 and E7 on the stored model output.

## Cost

| | A | B on a laptop |
|---|---|---|
| Per 20-customer run | $0.79 expected, $3.71 worst `[derived]` | Same model cost |
| Per 1,000 | $39–46 sync `[derived]` | Same |
| Fixed | $0 local, $5/month with a link | $0 |

## Failure modes

| failure | effect | handling |
|---|---|---|
| Local Workflow state lost on a kill | Restart cannot resume | Steps read their own output in D1, so a new instance id gives the same result. Tested with a forced throw only |
| A Workflow step replays | Repeat paid call | `call_state` compare-and-set. An unsure call counts as billed |
| A D1 batch partly applies | Audit gap | Siblings are predicated on the edge's nonce |
| Catalogue exceeds Worker memory on a link | E4 and E7 fail | Unproven at 21.5 MB `[assume]`. A smoke test settles it |
| Local emulation differs from production | Unknown | No deployed run has happened |

## What would reverse this

- No Cloudflare dependency wanted, or the catalogue cannot load in a Worker: move to B with the same core and SQL.
- Volume where the batch discount outweighs the extra code: add the Batches path.
- Over 10,000 steps in a run: one Workflow per customer.

## Decision

Cloudflare, one Workflow per run, sync, one call per customer, one draft row per result, state machine in D1.
