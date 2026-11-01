// The Refine ranking page. Preview is a GET: it ranks in memory and writes nothing. Save and activate answer 503 on the link, and activating passes the run key first, as Start a run does.
import rowKeys from '../../../data/row_keys.synthetic.json' with { type: 'json' };
import shapes from '../../../config/shapes.json' with { type: 'json' };
import { BASE_WEIGHTS, liveConfig, overridden } from '../../lib/rank/live.ts';
import { WEIGHTS, changeOf, rankAll, readCustomers } from '../../lib/rank/index.ts';
import { loadCatalog } from '../../lib/catalog/index.ts';
import { ConfigErr, activateVersion, activeCatalog, listVersions, saveVersion, validateRank } from '../../lib/config/index.ts';
import { ingestTsv, onlyCustomer } from '../../lib/ingest.ts';
import { planCustomer } from '../../lib/plan.ts';
import { parseRecs, parseRowKeys } from '../../lib/recs.ts';
import { refinePage, type PreviewPick, type PreviewRow, type PreviewView, type PushMove } from '../../ui/agents/refine.ts';
import { checkRunKey } from '../run-key.ts';
import type { Catalog, ConfigVersion, Pinned, Plan, RecRow, ShapesFile, Weights } from '../../contracts/types.ts';
import type { Ctx, Route } from './list.ts';

const BOTH = { format: 'both', run_date: '' } as Pinned;
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const RANK = (v: ConfigVersion) => v.kind === 'rank';
/** A link from a version saved before R138 or R140 lacks a weight: it means none. */
const read = (get: (k: string) => string | null | undefined) => Object.fromEntries(WEIGHTS.map((k) => [k, Number(get(k) ?? (k === 'push_down' || k === 'merchandising' ? 0 : NaN))])) as unknown as Weights;
const refused = (w: Weights) => { const r = validateRank(w); return r.ok ? null : `${r.failures[0].detail.charAt(0).toUpperCase()}${r.failures[0].detail.slice(1)}`.replace('Past must', 'Past purchase must'); };

export async function inputs(env: Ctx['env']) {
  const [t, r] = await Promise.all([env.BUCKET.get('inputs/customers.synthetic.tsv'), env.BUCKET.get('inputs/recommendations.synthetic.json')]);
  return t && r ? { tsv: await t.text(), recs: await r.text() } : null;
}

/** Plans from a recs row, so headings and failures are what a run would get. */
export const plansOf = (tsv: string, recs: RecRow[], cat: Catalog) => new Map(ingestTsv(tsv).map((item) => [item.key, planCustomer(item, recs.find((r) => r.customer_id === item.key) ?? null, parseRowKeys(rowKeys), cat, BOTH, shapes as ShapesFile)]));

/** Each customer's newest stored plan from a finished real run, with that run's first-try estimate. A one-customer pilot must not hide the full run before it. */
async function stored(db: D1Database) {
  const { results } = await db.prepare(`SELECT p.run_id, p.customer_id, p.plan_json, c.est_usd FROM plans p JOIN runs r ON r.id = p.run_id LEFT JOIN cost_events c ON c.run_id = p.run_id AND c.customer_id = p.customer_id AND c.attempt = 1
    WHERE r.status = 'done' AND r.id NOT LIKE 'stub-%' ORDER BY r.created_at ASC, r.id ASC`).all<{ run_id: string; customer_id: string; plan_json: string; est_usd: number | null }>();
  return new Map(results.map((r) => [r.customer_id, { run_id: r.run_id, plan: JSON.parse(r.plan_json) as Plan, usd: r.est_usd }]));   // later rows win
}

async function preview(env: Ctx['env'], files: { tsv: string; recs: string }, only: string, w: Weights, active: ConfigVersion | undefined): Promise<PreviewView> {
  const tsv = only ? onlyCustomer(files.tsv, only) : files.tsv;
  const { snapshot_id } = parseRecs(JSON.parse(files.recs));
  const catalog = await activeCatalog(env.DB), { cat, cfg } = overridden(await loadCatalog(env, snapshot_id), liveConfig('preview', w), catalog);
  const customers = readCustomers(tsv), last = await stored(env.DB);
  const next = plansOf(tsv, rankAll(customers, cat, cfg), cat);
  const off = plansOf(tsv, rankAll(customers, cat, { ...cfg, weights: { ...w, push_down: 0 } }), cat);
  const missing = customers.filter((c) => !last.has(c.customer_id));
  const base = missing.length ? plansOf(tsv, rankAll(missing, cat, { ...cfg, weights: active ? active.content as Weights : BASE_WEIGHTS }), cat) : null;
  const view = (p: Plan['picks']): PreviewPick[] => p.map(({ product_id, score, why }) => ({ product_id, score, why, title: cat.rows.get(product_id)?.title ?? 'Not in this snapshot' }));
  const known = [...last.values()].flatMap((r) => (r.usd === null ? [] : [r.usd])), mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const rows = [...next.entries()].map(([id, after]): PreviewRow => {
    const was = last.get(id), before = was?.plan ?? base!.get(id)!;
    return { customer_id: id, occasion: after.occasion, kind: changeOf(before, after).kind, before: view(before.picks), after: view(after.picks), from: was?.run_id ?? '', usd: was?.usd ?? mean };
  });
  const redraft = rows.filter((r) => r.kind === 'picks'), priced = redraft.filter((r) => r.usd !== null);
  const usd = priced.length || !redraft.length ? priced.reduce((t, r) => t + r.usd!, 0) : null;
  const runs = [...new Set(rows.flatMap((r) => r.from || []))], held = rows.filter((r) => r.from).length;
  const basedOn = `${held ? `${held} of ${rows.length} compared with their latest finished run (${runs.join(', ')})` : 'No finished run holds these customers'}${held < rows.length ? `; the others with ${active?.id ?? 'the shipped weights'}` : ''}.${mean === null ? '' : ' Redraft estimates are the stored first-try estimates, or their average where none is stored.'}`;
  const title = (id: string) => cat.rows.get(id)?.title ?? 'Not in this snapshot';
  const moved = [...next.entries()].flatMap(([id, after]): PushMove[] => {
    const was = off.get(id)!, kind = changeOf(was, after).kind, a = was.picks.map((p) => p.product_id), b = after.picks.map((p) => p.product_id);
    return kind === 'unchanged' ? [] : [{ customer_id: id, kind, out: a.filter((x) => !b.includes(x)).map(title), in: b.filter((x) => !a.includes(x)).map(title) }];
  });
  return { rows, basedOn, usd, unpriced: redraft.length - priced.length, moved, push_down: w.push_down ?? 0 };
}

interface Form { weights?: Weights; only?: string; note?: string; error?: string; preview?: PreviewView | null; status?: number }
async function render(c: Ctx, f: Form = {}): Promise<Response> {
  const versions = (await listVersions(c.env.DB)).filter(RANK), deployed = c.env.DEPLOYED === '1';
  const active = versions.find((v) => v.status === 'active');
  const files = deployed ? null : await inputs(c.env);
  return html(refinePage({ weights: f.weights ?? (active?.content as Weights | undefined) ?? BASE_WEIGHTS, versions, customers: files ? ingestTsv(files.tsv).map((i) => i.key) : [], only: f.only ?? '', note: f.note ?? '', error: f.error ?? null, preview: f.preview ?? null, deployed, locked: !c.env.RUN_KEY }), f.status);
}

async function page(c: Ctx): Promise<Response> {
  const q = new URL(c.req.url).searchParams;
  if (c.env.DEPLOYED === '1' || !WEIGHTS.some((k) => q.has(k))) return render(c);   // the link reads; it ranks nothing
  const weights = read((k) => q.get(k)), only = q.get('only') ?? '', note = q.get('note') ?? '';
  if (!q.has('preview')) return render(c, { weights, only, note });
  const bad = refused(weights);
  if (bad) return render(c, { weights, only, note, error: bad, status: 400 });
  const files = await inputs(c.env);
  if (!files) return render(c, { weights, only, note, error: 'No inputs published. Run the build with --publish, then come back.', status: 503 });
  if (only && !ingestTsv(files.tsv).some((i) => i.key === only)) return render(c, { weights, note, error: 'Pick a customer from the list.', status: 400 });
  const active = (await listVersions(c.env.DB)).find((v) => RANK(v) && v.status === 'active');
  return render(c, { weights, only, note, preview: await preview(c.env, files, only, weights, active) });
}

const WORDS: Partial<Record<ConfigErr['code'], string>> = { UNCHANGED: 'Those are the active weights. Nothing to save.', STALE_PARENT: 'The active version changed. Save this again from the new one.', WRONG_STATE: 'Only a draft can be activated.', CONFIG_MISSING: 'Run npm run config seed first.', NOT_FOUND: 'No such version.', TAMPERED: 'That version no longer matches its hash.' };

async function save(c: Ctx): Promise<Response> {
  const f = await c.req.formData(), get = (k: string) => { const v = f.get(k); return typeof v === 'string' ? v : null; };
  const weights = read(get), note = get('note') ?? '', only = get('only') ?? '';
  const bad = refused(weights) ?? (note.trim() ? null : 'A note is needed to save.');
  if (bad) return render(c, { weights, only, note, error: bad, status: 400 });
  const active = (await listVersions(c.env.DB)).find((v) => RANK(v) && v.status === 'active');
  if (!active) return render(c, { weights, only, note, error: WORDS.CONFIG_MISSING, status: 503 });
  try {
    await saveVersion(c.env.DB, 'rank', active.id, weights, note, c.actor);
  } catch (e) {
    if (e instanceof ConfigErr) return render(c, { weights, only, note, error: WORDS[e.code] ?? e.code, status: 409 });
    throw e;
  }
  return new Response(null, { status: 303, headers: { location: '/review/agents/refine' } });
}

async function activate(c: Ctx): Promise<Response> {
  const f = await c.req.formData().catch(() => null);
  const r = await checkRunKey(c.env, f?.get('run_key'));
  if (r === 'locked') return render(c, { error: 'Runs are locked: no run key is set on this server.', status: 403 });
  if (r === 'limited') return render(c, { error: 'Too many tries. Wait 15 minutes, then try again.', status: 429 });
  if (r === 'wrong') return render(c, { error: 'Wrong key. Nothing was activated.', status: 403 });
  const id = f?.get('id');
  if (typeof id !== 'string' || !/^rank-v\d+$/.test(id)) return render(c, { error: WORDS.NOT_FOUND, status: 400 });
  try {
    await activateVersion(c.env.DB, id, c.actor);
  } catch (e) {
    if (e instanceof ConfigErr) return render(c, { error: WORDS[e.code] ?? e.code, status: 409 });
    throw e;
  }
  return new Response(null, { status: 303, headers: { location: '/review/agents/refine' } });
}

const off = (h: (c: Ctx) => Promise<Response>) => (c: Ctx) => (c.env.DEPLOYED === '1' ? Response.json({ code: 'MISSING_CONFIG', detail: 'read-only on the link' }, { status: 503 }) : h(c));

export const routes: Route[] = [
  { method: 'GET', path: '/review/agents/refine', handler: page },
  { method: 'POST', path: '/review/agents/refine/save', origin: true, handler: off(save) },
  { method: 'POST', path: '/review/agents/refine/activate', origin: true, handler: off(activate) },
];
