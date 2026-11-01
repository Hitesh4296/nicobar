// The catalog viewer (R137). Reading is a GET. A draft of switches and items lives in the URL, so nothing is stored until Save, and the Preview writes nothing. On the link it only reads.
import { CatalogMissing } from '../../contracts/codes.ts';
import type { AppEnv, Catalog, CatalogOverride, ConfigVersion, Weights } from '../../contracts/types.ts';
import { loadCatalog } from '../../lib/catalog/index.ts';
import { EMPTY, RULES, isP0, reasonsOf, sets, statusOf, type Status } from '../../lib/catalog/override.ts';
import { ConfigErr, activateVersion, activeCatalog, activeRank, listVersions, saveVersion } from '../../lib/config/index.ts';
import { BASE_WEIGHTS, liveConfig, overridden } from '../../lib/rank/live.ts';
import { changeOf, poolOf, rankAll, readCustomers } from '../../lib/rank/index.ts';
import { parseRecs } from '../../lib/recs.ts';
import { catalogPage, emptyPage, productPage, wordOf, type Filters, type ImpactRow, type ProductRow } from '../../ui/catalog.ts';
import { checkRunKey } from '../run-key.ts';
import type { Ctx, Route } from './list.ts';
import { inputs, plansOf } from './refine.ts';

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const PAGE = 60, MONTHS = ['3', '6', '12'];
const list = (v: string | null | undefined) => [...new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
const back = (fetched_at: string, months: number) => { const d = new Date(fetched_at); d.setUTCMonth(d.getUTCMonth() - months); return d.getTime(); };
const when = (p: { published_at?: string | null }) => (p.published_at ? Date.parse(p.published_at) : 0);

async function snapshotId(env: AppEnv, recs: string | null): Promise<string | null> {
  if (recs) return parseRecs(JSON.parse(recs)).snapshot_id;
  return (await env.DB.prepare('SELECT id FROM snapshots WHERE synthetic = 0 ORDER BY fetched_at DESC LIMIT 1').first<{ id: string }>())?.id ?? null;
}
const giftCards = async (env: AppEnv, id: string) => ((await (await env.BUCKET.get(`snapshots/${id}/report.json`))?.json<{ excluded?: { GIFT_CARD?: number } }>())?.excluded?.GIFT_CARD ?? null);

/** Drops what a draft may not hold, and says why. `applyCatalog` holds the line anyway: this is for the words. */
function clean(cat: Catalog, off: string[], on: string[], out: string[]) {
  const refused: string[] = [];
  const canEnable = on.filter((id) => {
    const p = cat.rows.get(id);
    if (!p) { refused.push(`${id} is not in this snapshot.`); return false; }
    const hard = reasonsOf(p).filter(isP0);
    if (hard.length) refused.push(`${p.title} cannot be enabled: ${hard.map(wordOf).join(', ')}.`);
    return !hard.length;
  });
  const canOff = off.filter((id) => { const ok = RULES.find((r) => r.id === id)?.priority === 'P1'; if (!ok) refused.push(`${id} cannot be switched off.`); return ok; });
  const canOut = out.filter((id) => { const ok = cat.rows.has(id); if (!ok) refused.push(`${id} is not in this snapshot.`); return ok; });
  return { draft: { rules_off: canOff, enabled: canEnable, disabled: canOut.filter((id) => !canEnable.includes(id)) } as CatalogOverride, refused };
}

async function impact(env: AppEnv, files: { tsv: string; recs: string }, cat: Catalog, from: CatalogOverride, to: CatalogOverride) {
  const rank = await activeRank(env.DB), cfg = liveConfig('preview', (rank?.content as Weights | undefined) ?? BASE_WEIGHTS);
  const a = overridden(cat, cfg, { content: from }), b = overridden(cat, cfg, { content: to }), people = readCustomers(files.tsv);
  const before = plansOf(files.tsv, rankAll(people, a.cat, a.cfg), a.cat), after = plansOf(files.tsv, rankAll(people, b.cat, b.cfg), b.cat);
  const title = (id: string) => cat.rows.get(id)?.title ?? id;
  const rows = [...after.entries()].map(([id, x]): ImpactRow => {
    const w = before.get(id)!, kind = changeOf(w, x).kind;
    return { customer_id: id, occasion: x.occasion, kind, before: w.picks.map((p) => title(p.product_id)), after: x.picks.map((p) => title(p.product_id)), failed: x.outcome.kind === 'failed' ? x.outcome.code : null };
  });
  return { rows, usable_before: a.cat.usable.length, usable_after: b.cat.usable.length };
}

interface Form { error?: string; status?: number }
async function render(c: Ctx, f: Form = {}): Promise<Response> {
  const { env } = c, deployed = env.DEPLOYED === '1', q = new URL(c.req.url).searchParams;
  const files = deployed ? null : await inputs(env), id = await snapshotId(env, files?.recs ?? null);
  if (!id) return html(emptyPage('No snapshot', 'Run the build with --publish, then come back.'), 503);
  let cat: Catalog;
  try { cat = await loadCatalog(env, id); } catch (e) {
    if (e instanceof CatalogMissing) return html(emptyPage('The catalog is not here', 'This snapshot has no catalog file in the bucket. Run the build with --publish.'), 503);
    throw e;
  }
  const versions = (await listVersions(env.DB)).filter((v) => v.kind === 'catalog'), active = versions.find((v) => v.status === 'active');
  const live = (active?.content as CatalogOverride | undefined) ?? EMPTY;
  const hasDraft = !deployed && q.has('draft');
  const { draft, refused } = hasDraft ? clean(cat, list(q.get('off')), list(q.get('en')), list(q.get('dis'))) : { draft: live, refused: [] as string[] };

  const shown = sets(draft), liveSets = sets(live), all: ProductRow[] = [];
  const counts: Record<string, { hit: number; only: number }> = {}, byStatus: Record<Status, number> = { usable: 0, p0: 0, p1: 0, enabled: 0, disabled: 0 }, year = back(cat.fetched_at, 12);
  let sold = 0, usableNow = 0, usableDraft = 0;
  for (const p of cat.rows.values()) {
    const reasons = reasonsOf(p), status = statusOf(p, shown, reasons), now = statusOf(p, liveSets, reasons);
    for (const r of reasons) { (counts[r] ??= { hit: 0, only: 0 }).hit++; if (reasons.length === 1) counts[r].only++; }
    byStatus[now]++;
    if (now === 'usable' || now === 'enabled') usableNow++;
    if (status === 'usable' || status === 'enabled') usableDraft++;
    if (reasons.includes('NOT_AVAILABLE') && when(p) >= year) sold++;
    all.push({ p, reasons, status });
  }
  const filters: Filters = { q: q.get('q') ?? '', status: q.get('status') ?? '', reason: q.get('reason') ?? '', category: q.get('category') ?? '', occasion: q.get('occasion') ?? '', sort: q.get('sort') === 'title' ? 'title' : 'newest', months: MONTHS.includes(q.get('months') ?? '') ? q.get('months')! : '' };
  const words = filters.q.toLowerCase(), since = filters.months ? back(cat.fetched_at, Number(filters.months)) : 0;
  const occasions = (x: ProductRow) => [...x.p.occasion_keys, ...x.p.wear_occasion, ...x.p.gift_occasion];
  const hits = all.filter((x) => (!words || x.p.title.toLowerCase().includes(words)) && (!filters.status || x.status === filters.status) && (!filters.reason || x.reasons.includes(filters.reason))
    && (!filters.category || x.p.category.includes(filters.category)) && (!filters.occasion || occasions(x).includes(filters.occasion)) && (!since || when(x.p) >= since));
  hits.sort(filters.sort === 'title' ? (a, b) => a.p.title.localeCompare(b.p.title) : (a, b) => when(b.p) - when(a.p) || (a.p.id < b.p.id ? -1 : 1));
  const pages = Math.max(1, Math.ceil(hits.length / PAGE)), page = Math.min(pages, Math.max(1, Math.floor(Number(q.get('page'))) || 1));

  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const preview = hasDraft && q.has('preview') && files ? await impact(env, files, cat, live, draft) : null;
  return html(catalogPage({ snapshot_id: cat.snapshot_id, fetched_at: cat.fetched_at, total: cat.rows.size, gift_cards: await giftCards(env, cat.snapshot_id), usableNow, usableDraft, hasDraft, byStatus, counts, soldRecent: sold,
    rows: hits.slice((page - 1) * PAGE, page * PAGE), found: hits.length, page, pages, filters, categories: uniq(all.flatMap((x) => x.p.category)), occasions: uniq(all.flatMap(occasions)), draft, live, title: (i) => cat.rows.get(i)?.title ?? i,
    versions, active: active ?? null, refused, error: f.error ?? null, preview, deployed, locked: !env.RUN_KEY, query: q }), f.status);
}

// ponytail: one snapshot's side file held per isolate; a second snapshot replaces it.
let held: { id: string; detail: Record<string, { tags: string[]; text: string }> } | null = null;
async function sideFile(env: AppEnv, id: string) {
  if (held?.id === id) return held.detail;
  const detail = await (await env.BUCKET.get(`snapshots/${id}/detail.json`))?.json<Record<string, { tags: string[]; text: string }>>();
  if (detail) held = { id, detail };
  return detail ?? null;
}

async function reach(env: AppEnv, cat: Catalog, active: ConfigVersion | undefined, id: string) {
  const files = await inputs(env);
  if (!files) return null;
  const rank = await activeRank(env.DB), base = liveConfig('count', (rank?.content as Weights | undefined) ?? BASE_WEIGHTS), { cat: live, cfg } = overridden(cat, base, active ?? null);
  const people = readCustomers(files.tsv).filter((p) => cfg.rows[p.customer_id]), recs = rankAll(people, live, cfg);
  return { customers: people.length, picks: recs.filter((r) => r.picks.some((k) => k.product_id === id)).length, sections: recs.filter((r) => r.more?.some((s) => s.product_ids.includes(id))).length,
    pool: people.filter((p) => poolOf(p, live, cfg).gated.some((x) => x.id === id)).length };
}

async function product(c: Ctx): Promise<Response> {
  const { env } = c, deployed = env.DEPLOYED === '1', files = deployed ? null : await inputs(env), id = await snapshotId(env, files?.recs ?? null);
  const none = () => html(emptyPage('Not in this snapshot', 'No product has this id.'), 404);
  if (!id) return none();
  const cat = await loadCatalog(env, id), p = cat.rows.get(c.params.id);
  if (!p) return none();
  const active = (await listVersions(env.DB)).find((v) => v.kind === 'catalog' && v.status === 'active');
  const side = (await sideFile(env, id))?.[p.id] ?? null, reasons = reasonsOf(p);
  return html(productPage({ p, reasons, status: statusOf(p, sets((active?.content as CatalogOverride | undefined) ?? EMPTY), reasons), side, reach: deployed ? null : await reach(env, cat, active, p.id), deployed }));
}

const WORDS: Partial<Record<ConfigErr['code'], string>> = { UNCHANGED: 'That is the active version. Nothing to save.', STALE_PARENT: 'The active version changed. Save this again from the new one.', WRONG_STATE: 'Only a draft can be activated.', NOT_FOUND: 'No such version.', TAMPERED: 'That version no longer matches its hash.', CONFIG_MISSING: 'No such version.', VALIDATION_FAILED: 'That version does not hold together.' };
const worded = async (c: Ctx, h: () => Promise<unknown>) => {
  try { await h(); return new Response(null, { status: 303, headers: { location: '/review/catalog' } }); } catch (e) {
    if (e instanceof ConfigErr) return render(c, { error: WORDS[e.code] ?? e.code, status: 409 });
    throw e;
  }
};

async function save(c: Ctx): Promise<Response> {
  const { env } = c, f = await c.req.formData(), get = (k: string) => { const v = f.get(k); return typeof v === 'string' ? v : null; };
  const note = get('note') ?? '', files = await inputs(env), id = await snapshotId(env, files?.recs ?? null);
  if (!id) return render(c, { error: 'No snapshot.', status: 503 });
  const { draft, refused } = clean(await loadCatalog(env, id), list(get('off')), list(get('en')), list(get('dis')));
  const bad = refused[0] ?? (note.trim() ? null : 'A note is needed to save.');
  if (bad) return render(c, { error: bad, status: 400 });
  const active = await activeCatalog(env.DB);
  if (!active && !draft.rules_off.length && !draft.enabled.length && !draft.disabled.length) return render(c, { error: 'No change. Nothing to save.', status: 400 });
  return worded(c, () => saveVersion(env.DB, 'catalog', active?.id ?? null, draft, note, c.actor));
}

async function activate(c: Ctx): Promise<Response> {
  const f = await c.req.formData().catch(() => null);
  const r = await checkRunKey(c.env, f?.get('run_key'));
  if (r === 'locked') return render(c, { error: 'Runs are locked: no run key is set on this server.', status: 403 });
  if (r === 'limited') return render(c, { error: 'Too many tries. Wait 15 minutes, then try again.', status: 429 });
  if (r === 'wrong') return render(c, { error: 'Wrong key. Nothing was activated.', status: 403 });
  const id = f?.get('id');
  if (typeof id !== 'string' || !/^catalog-v\d+$/.test(id)) return render(c, { error: WORDS.NOT_FOUND, status: 400 });
  return worded(c, () => activateVersion(c.env.DB, id, c.actor));
}

const off = (h: (c: Ctx) => Promise<Response>) => (c: Ctx) => (c.env.DEPLOYED === '1' ? Response.json({ code: 'MISSING_CONFIG', detail: 'read-only on the link' }, { status: 503 }) : h(c));

export const routes: Route[] = [
  { method: 'GET', path: '/review/catalog', handler: (c) => render(c) },
  { method: 'POST', path: '/review/catalog/save', origin: true, handler: off(save) },
  { method: 'POST', path: '/review/catalog/activate', origin: true, handler: off(activate) },
  { method: 'GET', path: '/review/catalog/:id', handler: product },
];
