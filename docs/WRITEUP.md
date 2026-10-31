# Write-up

**Read this first.** [[SLOT status: rewrite after the real run]] As of this draft, no real model has been called. The batch, the checker and the approval gate have run on real local infrastructure against a scripted stand-in for the model. Every result below says which it is. Blanks marked `[[SLOT …]]` wait for a real run, and nothing has been filled in by estimate.

## Deep dive: the eval

I chose the eval. A batch reviewed by one person fails quietly: a made-up product that reaches the reviewer costs trust, and a made-up product past the reviewer costs more. Cost matters less at this size, and a short note follows.

**The design has three layers.** The model cannot name a product: it writes slot tokens, and code expands them into snapshot titles. Code then checks the raw output and the render. Only then does an advisory judge and a person read it.

The checks run in one function at three points: offline, before review, and again at approval and release on the stored model output. So a passing eval is a statement about the release gate itself.

### The four named failures

| failure | caught by | offline cases, all caught |
|---|---|---|
| Made-up product | C8, C8d: title cores and capitalised runs absent from the picks | 5 named, plus the blind set |
| Image not on nicobar.com | X2 on the rendered HTML: host, shop path, membership of the pick's images | 14 |
| Discount phrase | C4, unconditional, because the site has no live markdowns | 6 named, plus the blind set |
| Body over 120 words | C3, C3.L, counting the reader's words with titles expanded | 3 named, including 120 passing and 121 failing |

### Results

`npm run eval`, $0, no key, reproduced from a clean clone on 2026-11-01:

- **312 of 312 cases.** 124 checks, 33 blind drafts, 23 image and link, 3 injection, 56 layout, 41 fixtures, 32 echo rows.
- **22 of 22 mutants killed.** Each patches `src/lib/check/index.ts` for one run, so production code carries no switches. A check never seen failing would prove nothing.
- **8 cases skipped,** each named with the test that owns it.

**What this does not show.** Those cases shaped the checker, so 312 of 312 says little about drafts it has not seen. It runs on a 50-row fixture catalogue with the real rule set. A held-out set, written once by someone who has not read the rules, is the honest recall figure. [[SLOT held-out: not written yet. caught/40 per class]]

### Known gaps

Code does not catch these 12. Each is listed by id in `reports/eval.json`, and none can place a wrong image, link, title or price on a page. They reach the advisory judge and the reviewer.

| gap | example |
|---|---|
| Invented product in lower case | BL-D1 |
| Real, unselected product in lower case | BL-D5w, NM8 |
| Pick named in lower or upper case, not by token | NM4, NM5 |
| Invented single capitalised word | NM7, F1-3 |
| Romanised Hindi discount phrase | BL-D9.5 |
| Plain-word claim about a place | N-01b |
| Attribute grounded on the wrong one of two picks in a sentence | GR7 |
| Material outside the vocabulary | GR8 |
| A greeting | N-06 |

A made-up claim in plain words remains the largest gap. Checks catch vocabulary, not facts. A reader counting words on a rendered page will also see more than 120, because code-rendered titles and quotes are outside the count.

### On real drafts

[[SLOT real run: every line below]]

| measure | target | result |
|---|---|---|
| First-try pass, email | at least 17 of 20 | [[SLOT]] |
| First-try pass, landing page | at least 17 of 20 | [[SLOT]] |
| False rejects, reviewer's count | at most 2 of 20 units | [[SLOT]] |
| Made-up claims found by the reviewer | 0 | [[SLOT]] |
| Send as is, or one line off | at least 15 of 20 | [[SLOT]] |
| Distinct landing outlines | at least 12 of 20 | [[SLOT]] |
| Jev flags, against the reviewer | reported | [[SLOT]] |

## Production readiness

`npm run readiness`, $0, no key. It runs a real local Worker and Workflow against a stand-in model. A line counts as PASS only if its assertion failed on planted evidence, failed again on a real run driven red, and held on a real run. Result: **8 PASS, 0 FAIL, 0 VOID**, reproduced from a clean clone on 2026-11-01 with the snapshot input supplied by path.

| line | shown |
|---|---|
| Durability | Killed at the seventh answer. After restart, finished customers made 0 repeat calls and all units ended |
| Replay | Killed after an answer, before the write: attempt 1 `possibly_billed`, no second call for it |
| Idempotency | Second POST of a run id is 409. Double approve and release give one event each |
| Isolation | One run with four bad customers, each failing alone with its own code. The other four drafted |
| Retry | 429 then 200 billed once. Passing part carried byte for byte. Refusal not retried |
| Cap | Oversized customer `OVER_CAP`, 0 calls, $0, logged. `cap_run_usd` in a body is 400 |
| Observability | Every unit of a `done` run has a code or a draft |
| Approval | Release on `in_review` 409. Status-only UPDATE refused. Hash change takes `/released` off 200 |

**Weak spots in that table.**
- The three approval clauses were red only on planted evidence: no fault or stub can open them, so a real-run red needs patched code. [[SLOT approval red: update if the patched run lands]]
- `R1`'s assertion was changed after a first failure, because it had counted first-time calls as repeats. The planted and real reds still fail it.
- Resume on a new instance id is tested with a forced throw only. `restart()` took the same-instance path in the drive.
- Retry blocked by the pool and the exact `2 × callWorst` boundary stand on unit tests.
- `UPDATE drafts SET rendered_json` is not refused by the database. `/released` catches it by hash.

## A kill bills in-flight customers twice, by design

When a process dies during a model call, the system cannot tell whether Anthropic completed it. It records `possibly_billed` at the estimate, then makes attempt 2. In the readiness drive, d06 to d09 were in flight at the kill and each shows 2 billed attempts. On a real model that is real money: up to `GEN_CONCURRENCY` (4) customers per kill.

The alternative is to retry without recording, which risks a third call and an unbounded bill, or to fail those customers, which trades a few cents for a missing result. Two attempts is the limit, held by a `CHECK`. A repeated kill loop still ends at 2 per customer.

## c20

The brief says `c20` has no purchase history and fails alone. The list supplied has 19 rows and no `c20`. Nicobar later said the idea is how to personalise for a new user `[reported]`.

So two things are true, and both are shown.

- **The designed path.** `c20` is a row with four blank fields, labelled synthetic. Nothing was invented. It drafts through the same prompt with shape `open`, six picks from gender-free festive home rows, and no occasion. Checks forbid familiarity phrases and any occasion name. The personalisation is thin: picks only. Wear for a stranger needs a gender signal, and the system refuses to guess one.
- **The written line.** A new user with no recommendation row fails alone with `COLD_START_NO_HISTORY`, at 0 calls. That is `c20-x` in the isolation run, which passes in readiness. Removing `c20`'s row from the recommendation file gives the literal reading on the real list, with no code change.

## Three artifacts, one result

The brief asks for an email or a landing page. This produces both, plus a code-rendered product list. I hold them as **one result**: one unit, one draft row, one content hash, one approval. No part is released alone. Setting `format` to `landing_page` or `email` restores the literal reading with one change. The product list has no model call and no price.

## Cost note

Prices were read from Anthropic's pricing page on 2026-11-01. **Every other figure here is a plan, on placeholder token counts.**

| | Sonnet 5.5, default rung |
|---|---|
| Per customer, expected | $0.0394 |
| 20-customer run, expected | $0.79 |
| 20-customer run, worst by `max_tokens` | $3.71 |
| Per 1,000 | $39–46 |
| Per 1,000 on the Batches API, not built | $22–26 |
| Per 1,000 on Haiku 5.5, voice untested | about $0.7 |
| Per 1,000, Jev | about $0.55 |
| Fixed | $0 local, $5/month for a hosted link |

The largest unknown is thinking tokens. The start rung is also a run setting, and the first rung in `config/rungs.json` is cheaper than this table's.

**The cap** is enforced before each call from `count_tokens`. Over it, a customer is skipped with `OVER_CAP`, logged, at $0. No downgrade happens, since no cheaper rung has passed the eval. The run cap is computed from the preview, never typed. It is not a spend bound: an attempt running to `max_tokens` costs more than its commit, and the worst case is the figure above.

**Before a real run,** `S` in `config/cap.json` needs a measured value. It is a placeholder. A real `count_tokens` figure too far above it would skip customers, at $0 and logged.

[[SLOT cost: measured]]

| measure | Sonnet | Haiku |
|---|---|---|
| Actual spend, run | [[SLOT]] | [[SLOT]] |
| Actual ÷ estimate | [[SLOT]] | [[SLOT]] |
| First-try pass, per part | [[SLOT]] | [[SLOT]] |
| Cache hit rate | [[SLOT]] | [[SLOT]] |

**Model choice.** [[SLOT model: measured choice]] The rule was set before seeing data: Sonnet stays for this run. Haiku becomes the recommendation at 1,000 only if it is within 2 of Sonnet on first-try pass for each part, has 0 escapes, at most 2 false rejects, and the reviewer picks it or cannot tell on at least 3 of 6 blind pairs.

## What was and was not measured

| | state |
|---|---|
| Checker, offline | **Ran.** Real checks, real renderers, real rule set, fixture catalogue |
| Batch path | **Ran on a stub.** Real Worker, Workflow, D1 and R2, local. The model is a script that fills the plan's slots |
| Approval gate | **Ran on a stub draft** |
| Real model call | **None.** 0 paid calls |
| Whether the combined output schema compiles on the API | **Unknown** until one real call |
| Copy quality, voice | **Unmeasured.** No real draft exists |
| Jev | **Never called.** Stubbed transport only, and no real answer has been seen |
| Cost | **Plan only** |
| Deployed Worker, Access, catalogue in Worker memory | **Never run** [[SLOT link: update]] |

## Known gaps

- Recommendations are assumed upstream and synthetic. Relevance is untested.
- Nothing sends, so no eval here touches conversion or any customer response.
- Voice is one reader's judgment, at n = 20. It does not predict 1,000.
- The snapshot is frozen, so freshness at release proves nothing about today's site. See [ADR 0002](adr/0002-frozen-snapshot.md).
- Price currency is assumed INR and prices are never rendered.
- Nothing was built for the Batches API, a downgrade ladder, a spend gate, or metrics export.
- Workers Paid and the deployed path are design only.

## Trade-offs I would revisit

- **One call for two parts.** Cheaper and simpler, but a pair passes less often than a part, and the email may echo the page. [[SLOT combined: note if the first-try numbers changed this]]
- **Hard checks on vocabulary.** A false reject costs one retry. A false pass could cost a made-up product on a page.
- **Snapshot over live data.** Correct for a reviewed demo. Wrong the day anything really sends.
