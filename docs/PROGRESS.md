# Progress

PHASE: planning

## Wave 1 (dispatched 2026-10-29)
| # | to | brief | status |
|---|---|---|---|
| 01 | scout | nicobar.com source map, polite-load measurement, UCP read tools | **returned** · awaiting ward |
| 02 | tally | verified price table, first cost model | **returned** · awaiting ward |
| 03 | quill | voice guide from quoted site copy, output schema | **returned** · awaiting ward |
| 04 | sift | snapshot schema, recommendation options | **returned** · awaiting ward |

Dispatched: 05 atlas (2026-10-29). Queued: ADR-0001 hosting + orchestration + approval gate (after 01, 02) ·
06 probe eval design (after 03, 04) · 07 ward review of 05 and 06.

## Decisions
| id | question | state |
|---|---|---|
| D1 | deep dive: eval / cost / other | open, working assumption: eval |
| D2 | output: email / landing page / per customer | open |
| D3 | hosting: Cloudflare vs container | open, waiting on ADR-0001 |
| D4 | c20: fail loudly vs fail plus marked fallback | open |
| D5 | synthetic user data for the recommender | open |
| D6 | ship .claude/ and CLAUDE.md in the repo | open |
| D7 | Jev's role | open |
| D8 | host a public UCP agent profile (live price/stock check before release) | open, owner's call: a public action |
| D9 | snapshot pull identity: identifying user agent vs Web Bot Auth | open, owner's call |

## Wave 1 findings so far (unreviewed)
- 02 tally: prices verified 2026-10-29 and match the seed. Output, including thinking, is ~74% of per-customer cost, so effort is a lever as big as caching. Estimate [unverified]: Sonnet 5.5 cached + batch ≈ $0.27 per 20, $13.45 per 1,000; Opus ≈ 2x; fixed ≈ $5/mo on Cloudflare Workers Paid. Proposed cap: per customer downgrade → skip, plus a run-level stop.

- 01 scout: 16,069 products, of which about 2,250 are usable. The snapshot takes 65 polite requests, with no 429s at about 0.5 req/s, and rate limits are unknown. UCP needs a hosted agent profile. Stale `sale_*` tags are a live risk for the discount eval. Recommendation (proposed): the snapshot is the source of record, and we build no MCP over nicobar.com. Whether to wrap the snapshot in our own read-only tool layer is for atlas.

- 03 quill: a voice guide from 48 quoted examples. The house habit is a "so" clause tying construction to effect, and occasions enter as scenes. Hard-fail lists for discount, urgency and hype, with real-copy negatives ("ward off", "free-size"). The model writes words and ids, and code renders everything else. Proposed: checks C1–C10, at most one retry, code picks email vs landing page.
- 04 sift: no vector DB. Tag rules (A) vs a hybrid (D), with a judged pairwise test at n≤19. Three occasion families that must not be merged. product_type is unreliable. Images match on URL without the query string. Proposed: c20 fails loudly.
- Parent found 5 cross-artifact conflicts (pick count, catalogue size, token model, gift-card rule, id type), sent to ward in brief 07.

## Wave 2 (dispatched 2026-10-29)
| # | to | brief | status |
|---|---|---|---|
| 05 | atlas | ADR-0001 platform | **returned** rev 1 · to ward (09) |
| 06 | probe | eval design | **returned** · reconciling (10) |
| 10 | probe | reconcile eval with quill/sift/atlas revisions | **returned** |
| 11 | atlas | ADR-0001 rev 2 delta (probe A1–A8) | dispatched |
| 09 | ward | challenge ADR-0001 + revisions 08 | **returned**: 2 block, 15 fix, 8 notes + 10 blind drafts |
| 12 | all five | final revision round before owner review | **complete** |
| 07 | ward | challenge wave 1 | **returned**: 2 block, 10 fix, 9 notes |
| 08 | sift, quill, tally | revision round on ward 07 | all three **returned** (all fixes, 0 disputes) |

- 07 ward. Blockers: (B1) nobody owned product selection, and the format rule turned every customer into a landing page; (B2) a made-up product named in the prose passed every check. Corrections: sale_* covers 3,659 products, not 9,015; there are zero live markdowns; the usable count is 2,448. Corrected cost estimate: Sonnet 5.5 batch is about $0.06–0.21 per 20 customers and about $3–10 per 1,000 (tally had $13.45), with thinking/effort as the biggest lever and caching the smallest. Parent rulings R1–R7 are in decisions.md.

- 08 tally: verified ward's model in the docs itself. Sonnet 5.5 batch is $2.96–10.46 per 1,000 (worst case $27), Opus about 2×, judge about $0.60 per 1,000, fixed $5/mo. Thinking is the dominant cost. The retry is now inside the cap. Measuring needs about $2.4 of owner approval.

- 08 sift: exactly-N picks, with "strong" defined as a number; a data-only season rule (flags Rakhi only); 2,356 usable products; no fallback, no embeddings, no campaign bonus.

- 05 atlas ADR-0001 rev 1 (proposed): Cloudflare Worker + one Workflow per run + D1 + R2 + Access, with a hosting-agnostic core; sync for the live demo and batch for scale; a unit result enum plus a draft review machine; release only by a conditional UPDATE from approved; no tools and no MCP. Infra is $5/mo plus Access (unknown). A demo costs about $0.20–0.70 in model spend.

- 08 quill: the model now writes only slot tokens (no ids, names or prices), and code expands them after the checks. C8 can now catch invented and unselected product names, measured on the 2,448 usable products, with one allowlisted phrase ("Gift Box"). The strip rule removes hype from source copy before prompting. Three page-1 claims were corrected ("we", "!" and superlatives do occur in about 1–6% of bodies).

- 06 probe: one validate() used offline, in the pipeline and at release, fail-closed. Default-deny characters, apostrophe normalisation, an image gate on the rendered output, and mutation testing with canaries. Measured catalogue-wide: 39% of usable bodies contain a hard-fail pattern, so stripping source copy is load-bearing. Prototype: 106 cases, 0 mismatches, 9 holes found and fixed along the way. The judge is advisory in v0 (~24 labels give ±15-point intervals).
- tally: Access is $0 for up to 50 users.

- 10 probe: merged checks table; C8 settled on numbers (a case-insensitive match fails "the festive season", a case-sensitive one misses sentence-case slips, so it adopts a data-derived middle rule); quill's "Moonlit Brass Lamp" didn't fire, fixed by C8d; the pronoun ban conflicted with the strip rule (`our` is in 31% of bodies); 8 gaps in the ADR's DB enforcement (A1–A8) sent to atlas. Parent rulings R13–R16.

- 09 ward: (B1) reviewer auth failed open on a misconfigured deploy; (B2) made-up products still passed (lowercase names, "{p2} Mini"). Also: a sync retry can repeat a paid call; a double release wrote a second audit row; release re-checking against the pinned snapshot was a no-op; batch mode and the cap ladder serve no acceptance line if the deep dive is the eval. Rulings R17–R28; final revision round (12) dispatched.

- 12 final round: tally (one cost table, one cap definition), quill (prompt wording, C0 set, mechanical stoplist, R28 counts, prompt outline), atlas (rev 2 delta: CHECK-enforced codes, no repeated paid call, hash-matched release, STALE_PICK, fail-closed auth, sync-only), sift (season rule on the run date), probe (ward's blind drafts: 9/10 caught by code; 3 stated residuals; 17/18 mutants killed). Rulings R30–R33.

## Waiting on the owner
- `data/` customer list
- whether a Cloudflare account with Workers Paid exists (ADR-0001 assumes it; deploying needs your word)
- bundles in or out (157 usable)
- approval to spend about $2.3 (batch from a script) or $4.5 (sync) on the measured eval, k=1 (after the prompt and recommender exist)

## Wave: design pack (briefs 13–18) · 2026-10-29
| brief | child | result |
|---|---|---|
| 13, 14 | atlas | design pack in `.agent/atlas/pack/` (ADR-0001, HLD, LLD, write-up notes); owner decisions D1–D3 folded in |
| 14, 16 | tally | re-cost T1R (sync + batch, both formats, ladder); staged $5 plan, expected ≈$1.94–2.16, ceiling ≈$4.19–4.55; batch saving 20–50% |
| 15 | ward | pack review: 1 block (cost source), 8 fix; all proposed items survive-with-fix |
| 16, 17, 18 | atlas, ward | fixes applied; delta check 0 block; request store dropped in favour of rebuild (R42); abort billing fixed (R43) |
Decision states: owner decisions D1, D2, D3 and spend are owner-approved. Rulings R1–R44 are revised and wait for owner approval on the review page. Owner-open: format threshold (FORMAT_SPLIT), the cited sources (NOTES), CF account and domain, `data/`, PHASE.

## Wave: HLD v2 (briefs 19–21) · 2026-10-29

| brief | child | artifact | result |
|---|---|---|---|
| 19 | sift | .agent/sift/19-data-layer.md | data layer: snapshot, catalogue, ingest contract, behaviour profile, synthetic generator with a frozen persona mix. Measured split: the current rule gives 0 emails, rule C gives 13 landing / 6 email |
| 19t | tally | .agent/tally/19-jev-cost.md | Jev $0.042/MTok input, output free; ≈$0.0004 per customer; pin jev-1.14.0; rate limits unknown |
| 20 | atlas | .agent/atlas/hld-v2/HLD.md | full HLD v2, six layers, a typed Plan, Jev J2/J3 placed and J1 designed |
| 21 | ward, tally | running | challenge HLD v2; stage G re-cost |

Decisions: owner verdicts recorded (12 approved; D7 Jev mandatory; NOTES ship; F2 delegated). R45–R50 are revised and await ward 21. Owner-open: Jev API key, CF account and domain, data/, PACK, PHASE, D4.
