# Progress

PHASE: execution, since 2026-11-01. The earlier planning log was replaced by this page. It remains in git history.

State as of 2026-11-01. Decisions: [decisions.md](decisions.md). Results and their limits: [WRITEUP.md](WRITEUP.md).

## Built and merged

| part | state |
|---|---|
| Batch: Worker, one Workflow per run, D1, R2 | Done, local |
| Checker | `check-v3`. 366 of 366 offline cases, 29 of 29 mutants |
| Approval gate | Done, enforced in the database |
| Prompt | v2 active |
| Snapshot | Refrozen 2026-11-01: 8,940 rows, 2,165 usable |
| Ranking engine, Refine page | `rank-v1` active |
| Catalog viewer and overrides | Done |
| Email | The letter template, with logo, brand header and footer, and a landing link |
| Run key | Required to start a run. `npm run demo` makes its own per launch |
| Tests | 914: 913 passing, 1 skipped |
| Readiness | 8 of 8 PASS on the stub, regenerated on 2026-11-01 |

## Real runs

Read from local D1, read only. All on the 2026-10-29 snapshot, Sonnet 5.5.

| run | what | prompt | result | Anthropic |
|---|---|---|---|---|
| `voice-voice1` | 20 script calls, stored as a run | v1 | 12 drafted, 8 failed | no ledger row |
| `voice-c01-v2` | 1 script call | v2 by file, v1 on the row | 1 drafted | no ledger row |
| `voice-mvxfzle7` | Workflow run | v1 | 19 drafted, 1 failed | $0.7951 |
| `voice-mvxmeplv` | Workflow run | v2 | 20 drafted first try, `c01` released | $0.6834 |

`stub-rehearsal-mvxe9cqb` is a stub run, and its spend figure is the stub's, not a bill.

## Open

- No real draft exists for today's picks, snapshot or letter email. Needs one real run.
- No blind set has scored `check-v3`.
- Voice, false rejects and model choice are not measured.
- No deployment and no hosted link. `TEAM_DOMAIN` and a D1 `database_id` are unset.
- Nothing sends. No send route exists.
