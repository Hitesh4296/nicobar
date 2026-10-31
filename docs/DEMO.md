# Demo script

Ten steps, about 12 minutes. Beforehand, run `npm run readiness` once (about 4 minutes, so never live), then `npm run demo` (about 15 seconds). Open <http://localhost:8787/review>. It costs $0 and needs no key.

`/review` then holds two labelled runs: `stub-rehearsal-…`, 20 drafts, and `stub-…-r4`, the isolation run. Steps marked **stub today** use them, and their copy is deliberately generic. Once a real run exists, swap them to that run. [[SLOT real run: fill the run id and the two customers to show]]

| # | min | do | show | say |
|---|---|---|---|---|
| 1 | 1:00 | Open `/review`, the 20-draft run | Unit counts by status, and the stub banner | One run, one unit per customer. Every unit ends drafted, failed or skipped with a code |
| 2 | 1:30 | Open the isolation run, **stub today** | Four drafted. `COLD_START_NO_HISTORY`, `INVALID_PICK`, `INVALID_CUSTOMER`, `INTERNAL_ERROR` each alone | One bad customer fails alone. These four failed on purpose, in one run, and the rest finished |
| 3 | 1:00 | Open `/review/runs/<id>/plans` | Picks, shape, reason code per customer, estimate | The plan is stored before any spend. This is the audit trail for why a customer got what they got |
| 4 | 1:30 | In the 20-draft run, open `c16`, **stub today** | Part tabs, source panel, checks | Code placed every title, image and link. The model's raw output is stored and shown beside the render |
| 5 | 0:45 | The draft has no Publish button in review, so POST it: `curl -X POST -H "Origin: http://localhost:8787" localhost:8787/api/drafts/<id>/release` | 409 `WRONG_STATE` | Release has no edge out of anything but `approved`. A hidden button is not the control. Four layers refuse this, and removing them one at a time showed each: two in code and SQL on status, one on the hash, one `CHECK` in the database |
| 6 | 1:00 | Approve, then Publish | `approved`, then `released`, with actor, time and hash on the event | Approval binds this exact content hash, not the draft id. One approval covers all parts |
| 7 | 0:45 | Open `/review/published`, then `/released/<id>?part=landing_page` and `part=catalog` | The cleared content, marked as stub, with who approved it and when | Released means cleared. Nothing was sent, and no send route exists |
| 8 | 1:30 | `npm run eval` in a terminal (about 10 s), then `/review/evals` | `361 of 361`, `25 mutants, 0 survivors`, `heldout_v1 22/40`, the known-gap list | The checks are shown failing on mutated code. The gaps are listed by id, because a clean score alone would oversell it |
| 9 | 1:30 | On `/review/evals`, the readiness lines R1 and R2 | 8 PASS on the stub. A kill at the seventh answer. d06 to d09 billed twice, d01 to d05 not called again | A kill bills in-flight customers twice, by design, never more than twice. An unsure call is treated as paid |
| 10 | 1:30 | Open `/review/spend`, then `/review/agents` | Estimate against actual; prompt versions with diff and hash | Each run pins its prompt version. Editing a prompt cannot change a past run or clear a check |

**If something fails live:** `reports/eval.json` and `reports/readiness.json` are committed. If 8787 is taken, use `PORT=8801 npm run demo`.

**Do not show as voice samples:** stub drafts. [[SLOT samples: link the real drafts chosen for reading]]
