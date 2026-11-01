// npm run rank: rebuilds data/recommendations.synthetic.json from the snapshot and config/ranking.json. Offline, no model. --check writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Product, RecFile, RecRow } from '../src/contracts/types.ts';
import { parseRecs } from '../src/lib/recs.ts';
import { poolOf, rankAll, rankConfig, readCustomers } from '../src/lib/rank/index.ts';
import { snapshotCatalog } from './eval.ts';

const FILE = 'data/recommendations.synthetic.json', CUSTOMERS = 'data/customers.with-c20.synthetic.tsv';
const RULE = "Internal ranking engine, src/lib/rank with config/ranking.json. Tiers compared in order, never added: occasion, row fit, past purchase as a tie-break inside the occasion only, site signal, then a stable hash. One per class, at most two per family where the pool allows. Hand table for c02 c03 c06 c13 c15 c18 (HAND_SET), pinned and resorted so p1 obeys the rule; pinned new-user picks for c20 (NEW_USER_PRIOR). Row rules and the complements table are hand-written and synthetic, no behaviour data. A real recommender can replace this file by contract.";
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

const old = parseRecs(json(FILE));
const cat = snapshotCatalog(old.snapshot_id);
if (!cat) throw new Error(`rank: no out/snapshot/${old.snapshot_id}. Run npm run build first`);
const customers = readCustomers(readFileSync(CUSTOMERS, 'utf8'));
const cfg = rankConfig(json('config/ranking.json'), json('data/row_keys.synthetic.json'), json('data/hand_table.synthetic.json').rows);
const rows = rankAll(customers, cat, cfg);
const out: RecFile = { version: 'recommendations/v1', synthetic: true, as_of: old.as_of, snapshot_id: old.snapshot_id, rule: RULE, rows };
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
if (process.argv.includes('--check')) console.log('check only, nothing written');
else { writeFileSync(FILE, JSON.stringify(out, null, 1)); console.log(`wrote ${FILE}`); }
