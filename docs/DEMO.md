# Demo script

Ten steps, about 12 minutes. Run `npm run readiness` beforehand: it takes about 4 minutes, so it is never run live. Then start `npm run dev` and open <http://localhost:8787/review>.

Steps marked **stub today** use the labelled isolation run, whose copy is deliberately generic. Once a real run exists, swap them to that run. [[SLOT real run: fill the run id and the two customers to show]]

| # | min | do | show | say |
|---|---|---|---|---|
| 1 | 1:00 | Open `/review` | Runs with unit counts by status and code | One run, one unit per customer. Every unit ends drafted, failed or skipped with a code |
| 2 | 1:30 | Open the isolation run, **stub today** | Four drafted. `COLD_START_NO_HISTORY`, `INVALID_PICK`, `INVALID_CUSTOMER`, `INTERNAL_ERROR` each alone | One bad customer fails alone. These four failed on purpose, in one run, and the rest finished |
| 3 | 1:00 | Open `/review/runs/<id>/plans` | Picks, shape, reason code per customer, estimate | The plan is stored before any spend. This is the audit trail for why a customer got what they got |
| 4 | 1:30 | Open a draft, **stub today** | Part tabs, source panel, checks | Code placed every title, image and link. The model's raw output is stored and shown beside the render |
| 5 | 0:45 | Press Publish on `in_review`, or POST release | 409 `WRONG_STATE` | Release has no edge out of anything but `approved`. A hidden button is not the control; the database is |
| 6 | 1:00 | Approve, then Publish | `approved`, then `released`, with actor, time and hash on the event | Approval binds this exact content hash, not the draft id. One approval covers all parts |
| 7 | 0:45 | Open `/released/<id>?part=landing_page`, then `part=catalog` | The cleared content | Released means cleared. Nothing was sent, and no send route exists |
| 8 | 1:30 | `npm run eval` in a terminal | `312 of 312`, `22 mutants, 0 survivors`, the known-gap list in `reports/eval.json` | The checks are shown failing on mutated code. The gaps are listed by id, because a clean score alone would oversell it |
| 9 | 1:30 | Open `reports/readiness.json`, lines R1 and R2 | A kill at the seventh answer. d06 to d09 billed twice, d01 to d05 not called again | A kill bills in-flight customers twice, by design, never more than twice. An unsure call is treated as paid |
| 10 | 1:30 | Open `/review/spend`, then `/review/agents` | Estimate against actual; prompt versions with diff and hash | Each run pins its prompt version. Editing a prompt cannot change a past run or clear a check |

**If something fails live:** `reports/eval.json` and `reports/readiness.json` are committed, and the fixture screens need only `node scripts/seed.ts --fixtures`.

**Do not show as voice samples:** stub drafts. [[SLOT samples: link the real drafts chosen for reading]]
