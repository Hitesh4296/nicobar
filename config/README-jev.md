# Jev configuration: sources and status

`jev.json` follows `JevConfig` in the contracts. JSON cannot carry comments, so the sources are here. `version` is the value a run pins as `jev_config_version`.

| field | value | status |
|---|---|---|
| `model` | `jev-1.14.0` | pinned by id. The vendor's guidance on order and steering describes 1.13; for 1.14 it is `[unknown]` |
| `deadline_ms` | 20,000 | `[assume]` |
| `flag_gate` | 0.5 | `[assume]`. A Noul of 0.5 means unsure, so this flags for a person and nothing more |
| `act_gate` | 0.9 | `[assume]`. The vendor gives 0.85 for a high-stakes action on a Choice, and nothing for Nouls |
| `score_flag_confidence` | 0.6 | `[assume]` |
| `basis_usd` | $0.000554 | one request at 13,200 tokens (8 questions × 1,650) × $0.042 per million `[estimate]`. Set before the state carried both parts, so it reads low on a `both` run. The first real request shows the true size and whether the state is billed per request or per question |

**`act` is off for every question.** Every J3 answer is a flag for the reviewer, and `hard_failures` never changes. A question's act flag goes on only when the labelled set shows it acts on none of the good drafts and catches what it is meant to catch. The classification question and its gate are gone: the occasion comes from the customer file, so nothing is left for it to choose.

**`bad`** is the answer that counts against a draft: `true`, `false`, or `lowest` for a Score. Only `scene` is `false`.

**State keys** are the fields of `J3Input`: `email`, `landing_page`, `quote`, `picks`, `occasion`, `occasion_key`, `new_user`. A run with one format sends the other part as null, and every question says how to read that. No question reads `quote`, so a quoted site line is not judged as the model's words. `occasion` is the raw string, null on a row with no occasion.

**`claims_customer`** has no customer record to read, because none exists: the model is told the occasion and nothing else. So the question is whether the text goes beyond the words of `occasion`. It also carries the prompt's rule on places, dates and weather. Past purchases need no truth test here: any mention is a failure, held by C8n and C4 `familiarity`.

**`scene`** with a null `occasion` asks about ordinary use, so a new user's draft is not flagged for lacking an occasion the prompt forbids.

**Question text.** No question has met a real Jev request. The labelled set and the reorder check test them.
