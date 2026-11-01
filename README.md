# Nicobar personalised batch

One run turns a customer list into one reviewable result per customer: a landing page, an email and a product list, built only from a frozen snapshot of nicobar.com. Nothing leaves the system until a person has approved that exact content, and the database enforces that rule.

The model writes prose. Code places every title, image and link from the snapshot, then checks the prose before a reviewer sees it.

Built on Cloudflare Workers, Workflows, D1 and R2. Design: [docs/HLD.md](docs/HLD.md). Write-up: [docs/WRITEUP.md](docs/WRITEUP.md). Demo script: [docs/DEMO.md](docs/DEMO.md).

## Status

The batch, the checker and the approval gate run end to end, locally. Real model runs exist: two full Workflow runs on Sonnet 5.5, plus 21 earlier script calls. The latest, `voice-mvxmeplv` on prompt v2, drafted all 20 customers first try for $0.68, and one draft was approved and released by the local dev actor. Those runs used the 2026-10-29 snapshot and the earlier ranking, so no real draft exists yet for today's picks, or in the letter email. `npm run demo` uses a stand-in model and its copy is stub. `docs/WRITEUP.md` says exactly what has and has not run.

## Requirements

Node 22.18 or later. Scripts run `.ts` files directly, so an older Node fails. Everything below runs locally. No Cloudflare account is needed.

```sh
npm ci
```

## Run it without a key

Costs $0 and makes no outside request. Nothing to set up: `.dev.vars` is not read, so a key cannot be spent by accident. The demo server makes its own random run key at each launch and shows it nowhere, so a further run from `/review/start` needs `npm run dev` with your own `RUN_KEY`.

```sh
npm run demo
```

Open <http://localhost:8787/review>. If 8787 is taken, use `PORT=8801 npm run demo`. It takes about 20 seconds, then keeps serving until Ctrl-C.

It builds the snapshot from `samples/site/`, seeds the prompt and ranking versions, and runs all 20 customers through the real Worker and Workflow against a local stand-in for the model. The run id starts `stub-`, and every screen labels the drafts as stub. Their copy is deliberately generic. The checks, approve and publish are real.

`npm run demo` shows 20 drafts and no failures. To see customers failing alone, run this first:

```sh
npm run readiness   # about 4 minutes
```

It starts a real local Worker and Workflow, kills it mid-run, restarts it and injects faults. It leaves one labelled isolation run on `/review`, beside the demo run: four drafts and four failures, each with its own code.

## Run it with a key

The real runs went this way. `RUN_KEY` is newer than they are, and is required now.

```sh
cat > .dev.vars <<'VARS'
ANTHROPIC_API_KEY=...
JEV_API_KEY=...
RUN_KEY=...
VARS
node scripts/build.ts --publish
npm run dev
```

In a second terminal:

```sh
npm run config seed
node scripts/draft-one.ts --limit-usd 0.10 --only c16 # one customer, stops at the limit
npm run batch -- --stage <label>                      # preview, then the full run
```

`batch` prints the plan and cost, starts the run on the local server, and prints its `/review` link. `--stage` takes a key of `config/stages.json`, which sets the run's label and its expected-cost line. All 20 customers run whichever key you pick, or one with `--only`. `--format` and `--rung` are optional. Without a key or a stub URL it refuses before any call.

Runs also start from `/review/start`, which previews the cost, ranks at the active version and asks for the run key. The key travels only in the POST and is never echoed. With no `RUN_KEY` on the server, no run can start. If a ranking or catalog version newer than the recommendations file is active, `npm run batch` answers `PREVIEW_STALE`, so use that page, or `npm run rank` first.

`S` in `config/cap.json` is set from a real `count_tokens` reading: 7,152 tokens for both parts. If a real figure is too far above it, the batch skips customers with `OVER_CAP`, at $0 and logged.

`.dev.vars` is gitignored. Keys go nowhere else. `JEV_API_KEY` is optional: without it the Jev step records `no_key` and drafts continue.

## Run the checks

| command | what it does | cost | time |
|---|---|---|---|
| `npm run eval` | 366 offline cases and 29 mutants, plus the held-out regression. Writes `reports/eval.json` | $0 | about 10 s |
| `npm run readiness` | 8 production lines on real local runs. Writes `reports/readiness.json` | $0 | about 4 min |
| `npm test` | 914 unit and worker tests | $0 | about 1 min |
| `npm run rank` | Rebuilds the recommendations file offline. `-- --check` prints scores, p1 and the diff, writes nothing | $0 | seconds |
| `npm run typecheck` | `tsc` | $0 | seconds |

Neither needs a key or anything beyond `npm ci`. Both results are committed in `reports/`, and `/review/evals` shows them.

## What is synthetic

| file | what it is |
|---|---|
| `data/customers.nicobar.tsv` | **Real**, as supplied. 19 rows, verbatim |
| `data/customers.with-c20.synthetic.tsv` | The run input: those 19 rows plus a `c20` row with four blank fields. The supplied list had no `c20` row, so it is labelled synthetic. Nothing was invented for it |
| `data/recommendations.synthetic.json` | Picks per customer, written by the internal ranking engine (`npm run rank`). Filter, then weighted score, then fixed guards, from `config/ranking.json` and the version active on the Refine page. Occasion must outweigh the other signals together, `merchandising` included, with room for the `push_down` penalty, and the hero must fit the occasion. Intent is a model-picked query on the site's own filters per customer, saved in `data/queries.synthetic.json`. `merchandising` reads a product's place in Nicobar's own collection order, from `samples/site/collections.json`. The past rail shows only with at least `min_occasion_in_past_rail` occasion products in it |
| `data/hand_table.synthetic.json` | Hand-set picks merged into that file: `c02`, `c03`, `c06`, `c13`, `c15`, `c18` |
| `data/row_keys.synthetic.json` | Occasion key per customer. Keys only, no guessed gender |
| `test/fixtures/isolation/*.synthetic.*` | Customers built to fail one at a time |

The catalogue is real: 2,165 usable products out of 8,940 non-gift-card rows, frozen on 2026-11-01 and committed in `samples/site/`. The real runs above used the earlier freeze of 2026-10-29, 2,180 usable. `/review/catalog` shows every row, and an override saved there is a version the ranking reads. No request goes to nicobar.com at build or run time.

## What is off, and why

| off | why |
|---|---|
| Sending email, public pages | `released` marks content as cleared and serves it to a signed-in reviewer. There is no send route |
| Message Batches API | Designed and priced, not built. The saving is real at volume; at 20 customers it adds crash-recovery code for cents |
| Downgrade on cap | A customer over the cap is skipped and logged. No rung has passed the eval, so downgrading would ship untested copy |
| Live checks against nicobar.com | Snapshot is frozen, last refrozen 2026-11-01. See [ADR 0002](docs/adr/0002-frozen-snapshot.md) |
| Vector search, learned recommender | The ranking engine is rules on catalogue tags. A real recommender can replace its file by contract |
| Queues, Durable Objects | Workflows steps cover the batch. Each extra component needs an acceptance line to serve |
| Product prices | Never rendered. The snapshot has no currency field and the model never sees a price |
| Deployed runs | No hosted link exists. `npm run deploy:demo` refuses until `TEAM_DOMAIN` and a D1 `database_id` are set in `wrangler.jsonc`. Runs happen locally. A deployed Worker refuses run routes with 503 and holds no model key |
