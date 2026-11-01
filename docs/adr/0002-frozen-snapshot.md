# ADR 0002: Frozen snapshot, no live verification

**Status:** `proposed`, 2026-11-01. A signed live verifier was designed and approved on 2026-10-30, and was **not built**. `config/live.json` and `config/README-live.md` are what remains of it.

## Context

Every product, image and line of copy must trace to nicobar.com. A release should not cite a product that has gone. The first plan paired a signed live verifier with a 24-hour release window. During planning the site returned two 429s to ordinary fetches `[reported]`, and its `/agents.md` asks server-to-server agents to use Web Bot Auth.

## Acceptance lines served

2 (traceability) and 4 (release). Freshness is a release condition, so it sits on line 4's edge.

## Options

| | **A: one frozen snapshot** | B: signed live verifier | C: scheduled refresh |
|---|---|---|---|
| Traceability | Every fact has a URL and a fetch date | Same, plus live availability | Same, fresher |
| Load on the site | None after one pull | Bounded reads, with spacing and a breaker | One pull per refresh |
| Build | Done | A signing key, a key directory on a host we own, a breaker, a tool surface | A signed pull job |
| Fixed cost | $0 | $0 plus a domain | $0 |
| Honest limit | Says nothing about today's site | Signed Worker traffic may still be challenged `[reported]` | Same risk as B |

## Trade-offs

A cannot show that a product is still on sale. E7's freshness check compares a draft with the same snapshot it was built from, so it passes by construction. `FRESH_FOR_RELEASE_H` is 8760 for that reason. The value is printed in the run report and the write-up says so. `title_changed` is not built, because the envelope stores no title baseline.

## Cost

| | A | B | C |
|---|---|---|---|
| Per run, per 1,000 | $0 added | $0 added | $0 added |
| Fixed | $0 | $0 plus a domain | $0 |

## Failure modes

| failure | effect |
|---|---|
| A released draft names a product now gone | Not detected. Nothing is sent, so the exposure is the reviewer's trust |
| Snapshot grows stale past a real campaign | Picks and season drift. `config/season.json` is frozen with it |

## What would reverse this

Real sends. A send needs today's availability, so B or C returns first, with `FRESH_FOR_RELEASE_H` back near 24. A signed egress test decides between them.

## Decision

A. One polite pull, frozen on 2026-10-29, cached, no request at build or run time.

## Update 2026-11-01
Re-pulled on the owner's word and refrozen at 2026-11-01, id `2026-11-01-cdda17faae52`, 2,165 usable. The decision stands: no run fetches the site.
