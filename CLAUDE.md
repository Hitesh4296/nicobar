# nicobar — personalised batch, operating manual

**PHASE: planning.** No application code is written until the owner says, in his own words,
that the phase is now `execution`. Only the owner changes this line. A plan, an ADR, a
research note, a prompt draft or an eval case can be written now. A source file, a package
install, a `wrangler deploy` or a schema migration cannot.

## What we are building

A batch that writes one email **or** landing page per customer in `data/`, using only
products, copy and images from nicobar.com. Then a reviewer approves each draft before it
can be released. These are the acceptance lines from the brief, and every design choice is
checked against them:

1. One run gives each customer one result.
2. Every product, image and line of copy can be traced to nicobar.com.
3. One bad customer does not stop the batch. `c20` has no purchase history. It fails on
   its own, and the other 19 drafts still complete.
4. A draft cannot be released until it has been approved. The system enforces this. A
   checkbox in the UI is not enough.
5. One deep dive, with a short write-up: **eval** (made-up product, an image not on
   nicobar.com, a discount phrase, a body over 120 words), **cost** (a measured model
   choice, and how the cap behaves when the estimate is over it), or something else with a
   reason. The owner picks it. Until he does, the eval is the working assumption.
6. The copy is judged on Nicobar's voice: quiet, specific, tied to the occasion. A made-up
   product, image or claim counts as a failure.

They will judge it as a system: the design, the trade-offs, the stack and model choices,
and a working demo. Breadth does not earn points. Judgment does.

## The sessions (elephant–child model)

The **parent** holds the idea and makes every decision. It does not do the findings work
itself: it dispatches, reads what comes back, decides and records. It is the **only
session that writes outside `.agent/`**, and the only one that commits. It never pushes,
deploys, publishes or sends anything without the owner's word for that specific action.
An approval for one action does not carry over to the next.

Children take smaller or repeatable tasks. They return **findings**, not decisions.

| session | agent | model · effort | owns |
|---|---|---|---|
| scout | `.claude/agents/scout.md` | sonnet · high | outside research: nicobar.com surfaces, vendor docs, prices, limits |
| atlas | `atlas.md` | opus · xhigh | architecture proposals and ADR drafts: hosting, orchestration, storage, approval gate |
| sift | `sift.md` | opus · high | customer data, catalogue snapshot, recommendation and embedding design |
| quill | `quill.md` | opus · high | Nicobar voice guide, generation prompts, output schema |
| smith | `smith.md` | opus · high | code, **execution phase only**, only in the worktree its brief names |
| probe | `probe.md` | sonnet · high | eval cases, adversarial inputs, running checks and reporting actual output |
| ward | `ward.md` | opus · xhigh | review gate: claims, provenance, diffs, copy against the catalogue |
| tally | `tally.md` | sonnet · medium | cost model, token measurement, spend ledger, run reports |

Roster and session ids: `the local harness config`.
Bring the panel up with `hup nicobar`. The parent is not launched by the harness.

### Dispatch rules

- Every dispatch is a brief at `.agent/parent/briefs/<NN>-<child>-<slug>.md`, with the
  goal, what is already ruled out, which files to read, the scope, and the artifact path.
- A child writes its artifact to `.agent/<child>/` and sends the parent **one line** that
  points to it. It never pastes a long report into the message.
- The parent reads the artifact on disk. A summary of an artifact is not the artifact.
- A decision goes into `.agent/parent/decisions.md` with its date, the options weighed,
  the cost, and which artifact it came from. Anything not in that file is not decided.
- Two children working on the same question is deliberate, and used only for redundancy
  on a load-bearing finding (for example, scout and sift both checking a rate limit). It
  does not happen by accident.

## Sources — nothing invented

This rule applies to the system we build and to every session working on it.

- **Every product, price, image URL, collection and line of copy comes from a snapshot
  of nicobar.com**, and carries its source URL and fetch date. When a fact is not in the
  snapshot, the answer is "not in the snapshot". It is never a plausible guess.
- **Label each claim.** `[verified <date>]` means you opened the source yourself.
  `[reported]` means it came from a subagent or another session and you did not re-open
  it. `[assume]` is an assumption you intend to test. A claim with no label is read as
  `[verified]`, so an unlabelled guess is a lie.
- **Model knowledge is not a source** for prices, limits, API shapes, model IDs or a
  vendor's features. Fetch the docs, or use the `claude-api`, `cloudflare`, `agents-sdk`
  or `wrangler` skills, which read the live docs. Then cite what you read.
- **Generated copy is checked against the catalogue by code, not by the model.** A
  product ID, handle or image URL in a draft that is not in the snapshot fails the draft.
  The model can propose. Code decides.
- **No synthetic data passes as real.** Synthetic customers, orders or events go in
  files whose names say so (`*.synthetic.json`), and the write-up says so.
- **Unknown beats wrong.** Mark it `[unknown]` and say how you would find out.
- **Trace it.** Every claim about code points to `file:line`. Every claim about the site
  points to a URL and a date.

## Cost — part of every proposal

Every proposal, brief and ADR states its cost. That covers dollars per run, dollars per
1,000 customers, the fixed monthly cost of the infrastructure, and the cost of the agents
doing this work. Tally owns the numbers. Nobody else quotes a price from memory.

Reference prices, from the `claude-api` skill table dated 2026-10-06 (`[reported]`, and
tally re-checks them against the live pricing page before anything relies on them):

| model | id | input $/MTok | output $/MTok |
|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | 4.00 | 20.00 |
| Sonnet 5.5 | `claude-sonnet-5-5` | 2.00 | 10.00 |
| Haiku 5.5 | `claude-haiku-5-5` | 0.10 | 0.50 |

The levers, in the order to try them: prompt caching on the shared system prompt and the
catalogue slice, the Message Batches API (asynchronous, priced at 50%, which suits a
reviewed batch), a lower `effort` setting, and only then a smaller model. The model choice
is **measured** on the eval set and never assumed. A cap is enforced before the call, from
an estimate, and the system logs what it does when the estimate is over the cap (skip,
downgrade or stop). It never fails silently.

The agent work has a cost too. Opus panes at xhigh are the expensive ones. A finding that a
sonnet child can produce goes to a sonnet child.

## Standing findings

These are seeds, not decisions. Re-verify each one before you build on it.

- nicobar.com runs on Shopify (store `the-darkroast`), fronted by Cloudflare.
  `/products.json?limit=250&page=N` returns titles, handles, `body_html`, tags, variants
  and `cdn.shopify.com` image URLs. `[verified 2026-10-29]`
- Shopify UCP is live. `/.well-known/ucp` points to an MCP endpoint at
  `https://the-darkroast.myshopify.com/api/ucp/mcp` with `search_catalog`,
  `lookup_catalog` and `get_product`, plus cart, checkout and order tools.
  `/api/mcp` exposes only `search_shop_policies_and_faqs`. `[verified 2026-10-29]`
  Rate limits: `[unknown]`.
- `robots.txt` disallows `/search`. Site search is a third-party engine (SearchTap), so
  do not scrape it. `[reported]`
- Catalogue tags carry structure: `Filtercategory_*`, `Filterclass_*`,
  `Filtersubcategory_*`, `COLLECTION_*`, `Campaign_*`, `badge_*` and occasion tags such as
  `Festive_gifts`. `[verified 2026-10-29]`
- **Jev (TypeSafe System One) is a judgment model, not an orchestrator.** It returns a
  probability distribution over options you define, and it does not generate text or run
  steps. It fits as a cheap, calibrated judge inside the eval (voice, occasion fit,
  discount language) and as a routing gate. Orchestration is the parent session here, and
  in the product it is whatever atlas proposes and the parent decides. The skill is at
  `the local harness`.
- `data/` is not in the repo yet. `[unknown]` Its shape is unknown until the owner adds it.

## Never

- Use the UCP cart, checkout or order tools. Read-only catalogue tools only.
- Send an email to a real address, or publish a landing page publicly, without the
  owner's word for that action.
- Put a secret in a file, a prompt or a log. Keys live in `.dev.vars` or Wrangler
  secrets, and both are gitignored.
- Hit nicobar.com in a loop. One polite snapshot (a delay between requests, an
  identifying user agent, cached to disk) serves every later read.
