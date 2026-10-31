# Decision log

Stripped from the working log. Numbers are kept where code, config or docs cite them. "Owner" is the product owner. Later entries win. Options, costs and failure modes for the big calls are in the [ADRs](adr/).

## Owner decisions

| id | date | decision |
|---|---|---|
| D1 | 2026-10-29 | Deep dive: eval and cost both kept. The write-up leads with the eval |
| D3 | 2026-10-29 | Hosting: Cloudflare |
| D5 | 2026-10-29 | Synthetic data allowed, labelled in the file name |
| D7 | 2026-10-29 | Jev is required, for structured judgments only. It never generates text |
| R63 | 2026-10-30 | $5 is a spend target, not a hard stop. Past $6 needs the owner's word |
| R84 | 2026-10-31 | The recommender is an assumed upstream system with a defined contract. Vector search and two-stage ranking leave the build. Supersedes R61, R64 |
| R85 | 2026-10-31 | The bar is the batch: isolation, retry, cap, approval, eval |
| R88 | 2026-10-31 | Supplied customer data replaces synthetic personas. Behaviour modelling and the order-count format rule go |
| R89 | 2026-10-31 | Generative landing pages stay in scope: the model arranges fixed components |
| R90 | 2026-10-31 | Never mention a past item. No gender guessing. Each customer gets email and landing page, held as one result |
| R92 | 2026-10-31 | "Catalog" is the customer's product list: code-rendered, no model prose, reviewed with the result |
| R95 | 2026-10-31 | `c20` becomes a designed new-user path, after Nicobar's later word. The literal line is shown by an isolation fixture. A shareable link is wanted |
| R99 | 2026-10-31 | Snapshot frozen at 2026-10-29. No further fetch from nicobar.com without the owner's word |
| R106 | 2026-11-01 | Prompts and Jev wording are editable as immutable versions. An edit cannot change a run or clear a check |

## Design rulings

| id | decision |
|---|---|
| R1, R2 | Code sets exact picks. The model refers to them only by slot token |
| R3 | No tags in any prompt. Discount language banned unconditionally |
| R4 | No prices rendered |
| R9 | "Limited Edition" in a title renders verbatim: a catalogue fact. The discount check governs model words only |
| R12, R15 | The 120-word limit counts model prose plus titles expanded inside it. Code-rendered headings do not count |
| R14 | Title and capitalised-run checks are hard. A false positive costs a retry, a false negative a demo |
| R16 | Release re-checks stored model output, never rendered HTML |
| R17 | Auth fails closed. Dev mode is explicit and refused by the pre-deploy check |
| R18 | The checker also runs on expanded text with title spans masked, catching `{p2} Mini`. A lowercase invented product remains a stated gap |
| R19 | `rejected` is terminal for that run |
| R21 | One admission pass before any generation |
| R22 | One cap definition, derived, never typed |
| R29 | "a good deal more cheery" fails on purpose: a retry is cheaper than a hole in the ban |
| R30 | Keep the strict word counter, which agrees with a plain whitespace count |
| R31 | Code does not catch every lower-case slip. The write-up lists the residuals |
| R32, R33 | Drop NFKC. One explicit character set shared by checker and strip |
| R40 | `U_hard` is 20 × the design input, a placeholder until measured |
| R50 | A Jev failure never ends a customer's result. Each fallback is logged and shown |
| R71 | The run cap is computed from the plan preview, never typed |
| R87 | The Jev draft check is required but flag-only |
| R93 | One call, one draft row, part-scoped retry |
| R97 | New schema files. The prompt prefix never changes by format. Familiarity phrases banned. An occasion name fails on a row with no occasion |
| R109 | Jev answers are stored raw. Flags are read through the run's pinned config |
| R110 | `restart()` re-runs from the start, so every step reads its own output first |
| R111 | The Jev reserve is global: Σ charged + basis ≤ $0.25 |
| R112 | Code renders the salutation. The model never receives a name |
| R116 | A kill bills in-flight customers twice, by design, at most 2 |

## Superseded

| id | was | why it went |
|---|---|---|
| R23, R36, R41–R44 | Batch mode, cap ladder, crash-safe submit | Designed, then cut to the thin batch |
| R45, R48 | Synthetic personas; order-count format rule | Replaced by supplied data (R88) |
| R53, R55, R57, LV-1–4 | Signed live verifier and tools | Not built. See ADR 0002 |
| R61, R64 | Embeddings, hybrid search, two-stage recommend | Replaced by R84 |
| D2 | Code picks one format per customer | Replaced by R90 |
