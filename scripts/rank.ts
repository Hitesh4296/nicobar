// npm run rank: rebuilds data/recommendations.synthetic.json from the snapshot and config/ranking.json. Offline, no model. --check writes nothing.
// npm run rank -- --preview --run <run_id> --only <customer> [--weights '<json>'] [--state <dir>]: what the weights change against that run's stored plan, at $0. Writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Plan, Product, RecFile, RecRow, Weights } from '../src/contracts/types.ts';
import { ingestTsv } from '../src/lib/ingest.ts';
import { planCustomer } from '../src/lib/plan.ts';
import { parseRecs } from '../src/lib/recs.ts';
import { RANK_RULE, changeOf, checkWeights, poolOf, rankAll, rankConfig, rankCustomer, rankingBy, readCustomers, type RankConfig } from '../src/lib/rank/index.ts';
import { snapshotCatalog } from './eval.ts';

const FILE = 'data/recommendations.synthetic.json', CUSTOMERS = 'data/customers.with-c20.synthetic.tsv';
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { values: v } = parseArgs({ options: { check: { type: 'boolean' }, preview: { type: 'boolean' }, apply: { type: 'boolean' }, run: { type: 'string' }, only: { type: 'string' }, weights: { type: 'string' }, state: { type: 'string', default: '.wrangler/state/v3' } } });

// Draft versions are 1 and 2 only (0001_core.sql), so a sections-only version has no slot. Stops at the design.
const APPLY_DESIGN = `--apply is not built: a new version needs a slot the schema refuses.
What it needs: a migration that rebuilds drafts with CHECK (version >= 1), version stops meaning attempt (jev_events, cost_events, timeline and runReport all read version as attempt), so a new column
  source ('attempt'|'rerank'), and the transition edge that retires the live row first, because one_live allows one in_review row per customer. The new row copies model_json, re-renders catalog and landing, and starts at draft.`;

const cfg0 = () => rankConfig(json('config/ranking.json'), json('data/row_keys.synthetic.json'), json('data/hand_table.synthetic.json').rows);

async function preview(cfg: RankConfig, run_id: string, only: string, weights: Weights) {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy({ persist: { path: v.state! } });
  try {
    const db = (proxy.env as unknown as Env).DB;
    const run = await db.prepare('SELECT snapshot_id, format FROM runs WHERE id = ?').bind(run_id).first<{ snapshot_id: string; format: string }>();
    const row = await db.prepare('SELECT plan_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(run_id, only).first<{ plan_json: string }>();
    if (!run || !row) throw new Error(`no stored plan for ${only} in ${run_id}`);
    const stored = JSON.parse(row.plan_json) as Plan;
    const cat = snapshotCatalog(run.snapshot_id);
    if (!cat) throw new Error(`rank: no out/snapshot/${run.snapshot_id}`);
    const tsv = readFileSync(CUSTOMERS, 'utf8'), c = readCustomers(tsv).find((x) => x.customer_id === only), item = ingestTsv(tsv).find((i) => i.key === only);
    if (!c || !item) throw new Error(`${only} is not in ${CUSTOMERS}`);
    const rec = rankCustomer(c, cat, cfg, weights);
    const next = planCustomer(item, rec, json('data/row_keys.synthetic.json'), cat, stored.pinned, json('config/shapes.json'));
    const change = changeOf(stored, next);
    const name = (id: string) => cat.rows.get(id)?.handle ?? id;
    if (change.kind === 'unchanged') console.log(`${only}: unchanged. $0.`);
    else if (change.kind === 'sections') console.log(`${only}: sections only, no redraft. $0. Rails: ${change.rails.join('; ')}`);
    else {
      const est = await db.prepare('SELECT est_usd FROM cost_events WHERE run_id = ? AND customer_id = ? AND attempt = 1').bind(run_id, only).first<{ est_usd: number | null }>();
      console.log(`${only}: picks or order changed, needs a redraft. Estimate ${est?.est_usd == null ? 'not stored for this run' : `$${est.est_usd.toFixed(4)}, this run's stored first-try estimate`}.`);
      change.after.forEach((id, i) => { if (id !== change.before[i]) console.log(`  p${i + 1}: ${change.before[i] ? name(change.before[i]) : 'none'} -> ${name(id)} [score ${rec.picks[i].score}: ${rec.picks[i].why?.join(' ')}]`); });
    }
    console.log(`weights ${JSON.stringify(weights)}. Nothing written.`);
  } finally { await proxy.dispose(); }
}

if (v.apply) { console.error(APPLY_DESIGN); process.exit(1); }
if (v.preview) {
  if (!v.run || !v.only) throw new Error("usage: rank --preview --run <run_id> --only <customer> [--weights '<json>'] [--state <dir>]");
  const cfg = cfg0();
  await preview(cfg, v.run, v.only, checkWeights({ ...cfg.weights, ...(v.weights ? JSON.parse(v.weights) : {}) }));
  process.exit(0);
}

const old = parseRecs(json(FILE));
const cat = snapshotCatalog(old.snapshot_id);
if (!cat) throw new Error(`rank: no out/snapshot/${old.snapshot_id}. Run npm run build first`);
const customers = readCustomers(readFileSync(CUSTOMERS, 'utf8'));
const cfg = cfg0();
const rows = rankAll(customers, cat, cfg);
const out: RecFile = { version: 'recommendations/v1', synthetic: true, as_of: old.as_of, snapshot_id: old.snapshot_id, rule: RANK_RULE, rows, generated_by: rankingBy(cfg, old.snapshot_id) };
parseRecs(out);

const name = (id: string | undefined) => (id ? (cat.rows.get(id) as Product).handle : 'none');
const was = new Map<string, RecRow>(old.rows.map((r) => [r.customer_id, r]));
for (const c of customers) {
  const r = rows.find((x) => x.customer_id === c.customer_id)!, before = was.get(c.customer_id), x = poolOf(c, cat, cfg);
  const a = r.picks.map((p) => p.product_id), b = before?.picks.map((p) => p.product_id) ?? [];
  const rails = (r.more ?? []).map((s) => `${s.kind === 'occasion' ? 'occasion' : s.label} ${s.product_ids.length}`).join(', ') || 'none';
  console.log(`${c.customer_id} tier1 ${x.tier1.length} past ${x.past.length} allowed ${x.gated.length} | p1 ${name(a[0])} [${r.picks[0]?.why?.join(' ') ?? ''}]${a[0] === b[0] ? '' : ` was ${name(b[0])}`}`);
  console.log(`    in ${a.filter((i) => !b.includes(i)).map(name).join(' ') || '-'} | out ${b.filter((i) => !a.includes(i)).map(name).join(' ') || '-'} | rails ${rails}`);
}
if (v.check) console.log('check only, nothing written');
else { writeFileSync(FILE, JSON.stringify(out, null, 1)); console.log(`wrote ${FILE}`); }
