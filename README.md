# Nicobar personalised batch

One run turns a customer list into one reviewable result per customer: a landing page, an email and a product list, built only from a frozen snapshot of nicobar.com. Nothing leaves the system until a person has approved that exact content, and the database enforces that rule.

The model writes prose. Code places every title, image and link from the snapshot, then checks the prose before a reviewer sees it.

Built on Cloudflare Workers, Workflows, D1 and R2. Design: [docs/HLD.md](docs/HLD.md). Write-up: [docs/WRITEUP.md](docs/WRITEUP.md). Demo script: [docs/DEMO.md](docs/DEMO.md).

## Status

[[SLOT status: replace this paragraph after the first real run]]
The batch has so far run only against a scripted stand-in for the model. No real model has been called, so no real draft exists yet. `docs/WRITEUP.md` says exactly what has and has not run.

## Requirements

Node 22.18 or later. Scripts run `.ts` files directly, so an older Node fails. Everything below runs locally. No Cloudflare account is needed.

```sh
npm ci
```

## Run it without a key

Costs $0 and makes no outside request.

**Look at the review screens (fixture data):**

```sh
node scripts/seed.ts --fixtures && npm run dev
```

Open <http://localhost:8787/review>. The fixture run shows the layout and refuses an early release with 409. Approve needs the catalogue, which this path does not publish. Use the next path to see approve and release work.

**Run the real batch path on the stand-in model:**

```sh
READINESS_CACHE=<absolute path to the snapshot cache> npm run readiness   # about 4 minutes
npm run dev
```

[[SLOT snapshot path: name the committed location of the snapshot input. No one-command wrapper exists yet; add it here if built]]

`readiness` starts a real local Worker and Workflow, kills it mid-run, restarts it and injects faults. It leaves one labelled isolation run on `/review`. Its four drafts can be approved and released. Their copy is deliberately generic stub text.

## Run it with a key

Not yet exercised. Treat these steps as the intended path.

```sh
cat > .dev.vars <<'VARS'
ANTHROPIC_API_KEY=...
JEV_API_KEY=...
VARS
node scripts/build.ts --from-cache <absolute path to the snapshot cache> --publish
npm run dev
npm run config seed                                   # second terminal
node scripts/draft-one.ts --limit-usd 0.10 --only c16 # one customer, stops at the limit
node scripts/preview.ts --format both                 # $0 plan and cost preview
```

A full run is `POST /api/runs` with the preview's hash; the body is in [docs/contracts.md](docs/contracts.md#routes). The review screens have no start button.

**Before the first full run,** `S` in `config/cap.json` must be set from a real `count_tokens` reading. It is a placeholder today. If the real figure is too far above it, the batch skips customers with `OVER_CAP`, at $0 and logged.

`.dev.vars` is gitignored. Keys go nowhere else. `JEV_API_KEY` is optional: without it the Jev step records `unavailable` and drafts continue.

## Run the checks

| command | what it does | cost | time |
|---|---|---|---|
| `npm run eval` | 312 offline cases and 22 mutants. Writes `reports/eval.json` | $0 | about 10 s |
| `npm run readiness` | 8 production lines on real local runs. Writes `reports/readiness.json` | $0 | about 4 min |
| `npm test` | unit and worker tests | $0 | minutes |
| `npm run typecheck` | `tsc` | $0 | seconds |

`eval` needs nothing beyond `npm ci`. `readiness` needs the snapshot input.

## What is synthetic

| file | what it is |
|---|---|
| `data/customers.nicobar.tsv` | **Real**, as supplied. 19 rows, verbatim |
| `data/customers.with-c20.synthetic.tsv` | The run input: those 19 rows plus a `c20` row with four blank fields. The supplied list had no `c20` row, so it is labelled synthetic. Nothing was invented for it |
| `data/recommendations.synthetic.json` | Picks per customer. Stands in for an assumed upstream recommender. No behaviour data sits behind it |
| `data/hand_table.synthetic.json` | Hand-set picks merged into that file: `c02`, `c03`, `c06`, `c13`, `c15`, `c18` |
| `data/row_keys.synthetic.json` | Occasion key per customer. Keys only, no guessed gender |
| `test/fixtures/isolation/*.synthetic.*` | Customers built to fail one at a time |

The catalogue is real: 2,180 usable products out of 8,938 non-gift-card rows, frozen on 2026-10-29. No request goes to nicobar.com at build or run time.

## What is off, and why

| off | why |
|---|---|
| Sending email, public pages | `released` marks content as cleared and serves it to a signed-in reviewer. There is no send route |
| Message Batches API | Designed and priced, not built. The saving is real at volume; at 20 customers it adds crash-recovery code for cents |
| Downgrade on cap | A customer over the cap is skipped and logged. No rung has passed the eval, so downgrading would ship untested copy |
| Live checks against nicobar.com | Snapshot is frozen. See [ADR 0002](docs/adr/0002-frozen-snapshot.md) |
| Vector search, recommender | Recommendations are an assumed upstream contract |
| Queues, Durable Objects | Workflows steps cover the batch. Each extra component needs an acceptance line to serve |
| Product prices | Never rendered. The snapshot has no currency field and the model never sees a price |
| Deployed runs | [[SLOT link: state whether the hosted review link exists]] Runs happen locally. A deployed Worker refuses run routes with 503 and holds no model key |
