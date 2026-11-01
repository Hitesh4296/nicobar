# Write-up

**Read this first.** [[SLOT real run: rewrite this paragraph after the real run]] As of this draft, no real model has been called. The batch, the checker and the approval gate have run on real local infrastructure against a scripted stand-in for the model. `npm run demo` reproduces that from a clean clone, with no key, in about 15 seconds. Every result below says which it is. Blanks marked `[[SLOT …]]` wait for a real run, and nothing has been filled in by estimate.

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

- **361 of 361 cases.** 124 checks, 33 blind drafts, 23 image and link, 3 injection, 56 layout, 33 check-v2, 41 fixtures, 48 echo rows.
- **25 of 25 mutants killed.** Each patches `src/lib/check/index.ts` for one run, so production code carries no switches. A check never seen failing would prove nothing.
- **8 cases skipped,** each named with the test that owns it.

**What this does not show.** Those cases shaped the checker, so 361 of 361 says little about drafts it has not seen. It runs on a 50-row fixture catalogue with the real rule set. A held-out set, written once by someone who has not read the rules, is the honest recall figure.

**Held-out v1, scored once on `check-v1`: 22 of 40 caught.** Image 8/8, length 8/8, product 4/8, discount 2/8, echo 0/8. Lists catch the words they were built from, and a fresh writer used other words. That is the published number.

`check-v2` was then fixed against those 40, so they are regression now, not recall. It catches 32 of 40 on them: discount 8/8, echo 4/8, the rest unchanged. Do not read 32 as a score. `reports/eval.json` keeps both under `heldout_v1`, and `npm run eval` reproduces them from a committed slice of 79 rows and the rules, so a clean clone needs no snapshot. A second blind set, written by a session that has seen neither the lists nor these misses, is what scores `check-v2`. [[SLOT held-out v2: not scored yet]]

**Held-out v2, a second blind set scored once on `check-v2`: 33 of 40 caught.** Image 8/8, length 8/8, product 6/8, echo 6/8, discount 5/8. Three of five classes still miss their target. All 7 misses would reach the reviewer.

These are different sets, so 22 to 33 is not a like-for-like rise. This set was easier: every echo caught contains an exact span from the note, and no long body sits near the 121-word boundary. Estimated from the patterns, `check-v1` would score 31 of 40 here, so the new checks added 2 catches. On true paraphrase, echo caught 0 of 2. To score it, drafts were converted from rendered strings, with pick names read as tokens and short bodies padded to pass the schema, so a real run would refuse some of them earlier.

**What this shows.** Each list matches the wording it has seen and misses the next wording over. A third round of list-widening would chase words, so it stopped here. Paraphrased echoes, scarcity in plain words, and wrong variants of a real pick are named known gaps, left to Jev and the human reviewer. A lowercase product-noun check was built and dropped, because it rejected 49 of 73 good drafts.

### Known gaps

Code does not catch these 20. Each is listed by id in `reports/eval.json`, and none can place a wrong image, link, title or price on a page. They reach the advisory judge and the reviewer.

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
| Unselected product named in lower-case nouns. The noun check false-fires on 49 of 73 known-good drafts, so it is not built | H-03, H-04, H-08 |
| Plain-word variant claim, no vocabulary term | H-05 |
| Echo that never uses the past item's head noun | H-25, H-29, H-31 |
| Echo with the head noun and no past-time word | H-28 |
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

`npm run readiness`, $0, no key. It runs a real local Worker and Workflow against a stand-in model. A line counts as PASS only if its assertion failed on planted evidence, failed again on a real run driven red, and held on a real run. Result: **8 of 8 PASS on the stub, 0 FAIL, 0 VOID**, reproduced from a clean clone on 2026-11-01. Nothing here says how a real model behaves.

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
- `R1`'s assertion was changed after a first failure, because it had counted first-time calls as repeats. It was then tightened: each in-flight customer gets exactly one call after the kill, and only those may be billed twice. That clause was seen red on its own, on a run where one of them met a 429.
- Resume on a new instance id is tested with a forced throw only. `restart()` took the same-instance path in the drive.
- Retry blocked by the pool and the exact `2 × callWorst` boundary stand on unit tests.
- `UPDATE drafts SET rendered_json` is not refused by the database. `/released` catches it by hash.

### The approval gate, four layers

No fault or stub can open the gate, so acceptance line 4 was tested by removing it. Each rung is one real run on a patched copy of the source, with one more layer gone. The copy was restored and diffed before the green run, and the repo was not touched.

| removed | release on `in_review` | |
|---|---|---|
| Status check in `transition` | 409 | Held |
| Also the status in the SQL `WHERE` | 409 | Held, but a second approve and release now answer 200: these two layers are also what makes them idempotent |
| Also the hash guard on the release `UPDATE` | 500 | Still closed: the `CHECK` refused the write. Ugly, but nothing was released |
| Also the approval `CHECK` in the table | **200** | **Open. This is the only rung where a draft was released without approval** |

So four layers guard release, and all four had to go.

Two neighbouring clauses are thinner, and the runs show that too. A status-only `UPDATE` takes two `CHECK`s to open: with one dropped it was still refused, with both it applied. `/released` has **one** layer: a single patch removing its hash comparison served changed content with a 200. That is the honest limit of this gate. It is the last read before content leaves, and nothing behind it would catch a bug there.

## A kill bills in-flight customers twice, by design

When a process dies during a model call, the system cannot tell whether Anthropic completed it. It records `possibly_billed` at the estimate, then makes attempt 2. The readiness drive sends `SIGKILL` to the process tree at the seventh answer. d01 to d05 had finished and made 0 further calls. d06 to d09 were in flight, got one more call each, and each shows 2 billed attempts. d10 to d12 made their first calls after the restart, and every unit ended. On a real model that is real money: up to `GEN_CONCURRENCY` (4) customers per kill.

The alternative is to retry without recording, which risks a third call and an unbounded bill, or to fail those customers, which trades a few cents for a missing result. Two attempts is the limit, held by a `CHECK`. A repeated kill loop still ends at 2 per customer.

A stop is different from a kill. `mark-stopped` ends the Workflow, and a generate step that still runs on a stopped run makes no call. If the Workflow could not be terminated and kept going, its remaining units end `failed{UPSTREAM_UNAVAILABLE}`, and `restart` does not regenerate them. I accepted that: they are visible and coded, and a fresh run covers them.

## What code review changed

An independent review of the merged code found 0 blockers and 8 things to fix. All 8 were fixed, tests first, at no added cost per run.

| found | now |
|---|---|
| `DEV_MODE` reaching a deployed Worker with no Access config logged anyone in | `DEPLOYED=1` with any `DEV_MODE` answers 503, first thing |
| Nothing ran the deploy guard, and it passed empty values | `npm run deploy:demo` runs it first, and it refuses an empty `TEAM_DOMAIN` or `database_id`. It refuses today, by design |
| An unset freshness window, or a bad date, passed as fresh | It fails closed: `SNAPSHOT_TOO_OLD` |
| A retry could fire with the run already over its cap, and nothing logged it | Retry refused with `run_cap`. `close` logs `cap_breach` |
| A last try that got an answer and then failed its write was recorded as $0 | `possibly_billed` at the estimate |
| A stopped run could keep calling the model if `terminate()` failed | The generate step reads run status and makes no call |
| The preview's cap check compared a label, so editing `cap.json` went unnoticed | Both sides hash the file. An edit gives `PREVIEW_STALE` |
| `R1` could pass with five repeat calls for one customer | One call each is asserted, as above |

**What is still open after those fixes.**
- `cap_run_usd` is still not a hard bound. First calls can overrun it, and the retry gate does not count calls in flight. A breach is a log line only: it is not stored and not on the run report.
- The stop check is not atomic: a stop landing just after the read can still get one call. An answer already in hand still finishes, which can make one Jev call.
- The deploy guard cannot see secrets or `--var`s. The run-time 503 covers that case.

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

The largest unknown is thinking tokens. The start rung is a run setting. This table's rung, `sonnet-default`, is the default.

**The cap** is enforced before each call from `count_tokens`. Over it, a customer is skipped with `OVER_CAP`, logged, at $0. No downgrade happens, since no cheaper rung has passed the eval. The run cap is computed from the preview, never typed. It stops retries, not first calls, so it is not a spend bound: an attempt running to `max_tokens` costs more than its commit, and the worst case is the figure above. A breach is logged at `close`.

**Before a real run,** `S` in `config/cap.json` needs a measured value. It is a placeholder. A real `count_tokens` figure too far above it would skip customers, at $0 and logged.

[[SLOT real run: measured cost, table below]]

| measure | Sonnet | Haiku |
|---|---|---|
| Actual spend, run | [[SLOT]] | [[SLOT]] |
| Actual ÷ estimate | [[SLOT]] | [[SLOT]] |
| First-try pass, per part | [[SLOT]] | [[SLOT]] |
| Cache hit rate | [[SLOT]] | [[SLOT]] |

**Model choice.** [[SLOT real run: measured model choice]] The rule was set before seeing data: Sonnet stays for this run. Haiku becomes the recommendation at 1,000 only if it is within 2 of Sonnet on first-try pass for each part, has 0 escapes, at most 2 false rejects, and the reviewer picks it or cannot tell on at least 3 of 6 blind pairs.

## What was and was not measured

| | state |
|---|---|
| Checker, offline | **Ran.** Real checks, real renderers, real rule set, fixture catalogue |
| Batch path | **Ran on a stub.** Real Worker, Workflow, D1 and R2, local. The model is a script that fills the plan's slots. `npm run demo` drafts all 20 from a clean clone |
| Approval gate | **Ran on a stub draft,** and red on patched copies of the source, layer by layer |
| Real model call | **None.** 0 paid calls |
| Whether the combined output schema compiles on the API | **Unknown** until one real call |
| Copy quality, voice | **Unmeasured.** No real draft exists |
| Jev | **Never called.** Stubbed transport only, and no real answer has been seen |
| Cost | **Plan only** |
| Deployed Worker, Access, catalogue in Worker memory | **Never run.** No link exists, and `npm run deploy:demo` refuses until `TEAM_DOMAIN` and `database_id` are set |

## Known gaps

- Recommendations come from an internal rules engine on catalogue tags, with hand-set row rules and synthetic inputs. Relevance is untested. A real recommender can replace the file by contract.
- Nothing sends, so no eval here touches conversion or any customer response.
- Voice is one reader's judgment, at n = 20. It does not predict 1,000.
- The snapshot is frozen, so freshness at release proves nothing about today's site. See [ADR 0002](adr/0002-frozen-snapshot.md).
- Price currency is assumed INR and prices are never rendered.
- Nothing was built for the Batches API, a downgrade ladder, a spend gate, or metrics export.
- Workers Paid and the deployed path are design only.

## Trade-offs I would revisit

- **One call for two parts.** Cheaper and simpler, but a pair passes less often than a part, and the email may echo the page. [[SLOT real run: note if the first-try numbers changed this]]
- **Hard checks on vocabulary.** A false reject costs one retry. A false pass could cost a made-up product on a page.
- **Snapshot over live data.** Correct for a reviewed demo. Wrong the day anything really sends.
