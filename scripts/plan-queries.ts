// npm run plan-queries [-- --only c01 --dry --model <id>]: one model call per customer, gated, written to data/queries.synthetic.json with model, prompt hash and date. Rerun only on request.
// --stub writes queries from the row key at $0, no key, labelled model "stub": enough to run the pipeline, not a recommendation.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { readCustomers, type RankCustomer } from '../src/lib/rank/index.ts';
import { gatePlan, type PlanRow, type QueriesFile } from '../src/lib/search/gate.ts';
import { buildIndex } from '../src/lib/search/index.ts';
import { plannerRequest, toFilters } from '../src/lib/search/planner.ts';
import type { Vocabulary } from '../src/lib/search/vocabulary.ts';

const FILE = 'data/queries.synthetic.json', PROMPT = 'config/prompt/recs-v1/system.md';
const { values: v } = parseArgs({ options: { only: { type: 'string' }, dry: { type: 'boolean' }, stub: { type: 'boolean' }, model: { type: 'string', default: 'claude-haiku-5-5' } } });
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const snapshot_id: string = json('data/recommendations.synthetic.json').snapshot_id;
const vocab: Vocabulary = json(`out/snapshot/${snapshot_id}/vocabulary.json`);
const prompt = readFileSync(PROMPT, 'utf8');
const prompt_sha256 = createHash('sha256').update(prompt).digest('hex');
const customers = readCustomers(readFileSync('data/customers.with-c20.synthetic.tsv', 'utf8')).filter((c) => !v.only || c.customer_id === v.only);
const pastItem = (note: string | null) => (note && !/\bgift\b/.test(note) ? note.match(/^Bought the (.+?)(?: (?:last|for|before|as|to|and)\b|\.|$)/)?.[1].split(' ').at(-1) ?? null : null);

const STUB: Record<string, string[]> = { wedding: ['gift_occasion=Wedding'], festive: ['gift_occasion=Festive'], birthday: ['gift_occasion=Birthday'], housewarming: ['gift_occasion=Housewarming'], evening: ['occasion=Evening'], resort: ['occasion=Resort'], smart: ['occasion=Smart'] };
function stubRow(c: RankCustomer, key: string | null, type: string, gendered: boolean): PlanRow {
  const who = /\bfather\b/i.test(c.occasion ?? '') ? ['recipient=him'] : /\bmother\b/i.test(c.occasion ?? '') ? ['recipient=her'] : [];
  return { primary: { purpose: 'stub: the row key', all: toFilters(type === 'wear' && !gendered ? ['category=Accessories', 'category=Jewellery'] : [...(key ? STUB[key] : ['category=House & Home']), ...who]) }, sections: [] };
}

async function call(client: Anthropic, c: RankCustomer): Promise<PlanRow> {
  const req = plannerRequest({ occasion: c.occasion, past_item: pastItem(c.note), new_user: !c.occasion && !c.note }, vocab, prompt, v.model!);
  const r = await client.messages.create(req as never) as Anthropic.Message;
  if (r.stop_reason !== 'end_turn') throw new Error(`${c.customer_id}: stopped on ${r.stop_reason}`);
  const text = r.content.find((b) => b.type === 'text');
  if (text?.type !== 'text') throw new Error(`${c.customer_id}: no text`);
  const out = JSON.parse(text.text) as { primary: { purpose: string; filters: string[]; exclude: string[] }; sections: { purpose: string; filters: string[]; exclude: string[]; from_past: boolean }[] };
  const q = (s: typeof out.primary) => ({ purpose: s.purpose, all: toFilters(s.filters), ...(s.exclude.length ? { not: toFilters(s.exclude) } : {}) });
  console.log(`${c.customer_id} usage ${JSON.stringify({ in: r.usage.input_tokens, out: r.usage.output_tokens, cache_read: r.usage.cache_read_input_tokens, cache_write: r.usage.cache_creation_input_tokens })}`);
  return { primary: q(out.primary), sections: out.sections.map((s) => ({ ...q(s), ...(s.from_past ? { from_past: true } : {}) })) };
}

const keys = json('data/row_keys.synthetic.json'), ranking = json('config/ranking.json');
const client = v.stub ? null : new Anthropic();
const rows: Record<string, PlanRow> = {};
for (const c of customers) {
  const row = client ? await call(client, c) : stubRow(c, keys[c.customer_id]?.key ?? null, ranking.rows[c.customer_id].type, !!ranking.rows[c.customer_id].note_gender);
  rows[c.customer_id] = row;
}
const { snapshotCatalog } = await import('./eval.ts');
const cat = snapshotCatalog(snapshot_id)!, index = buildIndex(cat.usable);
for (const c of customers) {
  const g = gatePlan(rows[c.customer_id], { occasion: c.occasion, past: pastItem(c.note), admit: () => true }, index);
  for (const l of g.log) console.log(`${c.customer_id} ${l}`);
}
if (v.dry) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
const old = v.only ? json(FILE).rows : {};
const file: QueriesFile = { version: 'queries/v1', synthetic: true, model: v.stub ? 'stub' : v.model!, prompt_sha256, date: new Date().toISOString().slice(0, 10), snapshot_id, rows: { ...old, ...rows } };
writeFileSync(FILE, JSON.stringify(file, null, 1));
console.log(`wrote ${FILE}, ${customers.length} rows`);
