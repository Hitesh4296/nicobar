// The refine page: weights as immutable versions, a preview that writes nothing, activation behind the run key.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Catalog, Plan, Product, RecFile, Weights } from '../../src/contracts/types.ts';
import { BUNDLE } from '../../src/lib/config/bundle.ts';
import { ConfigErr, activateVersion, activeRank, loadVersion, saveVersion } from '../../src/lib/config/index.ts';
import { rankedRecs } from '../../src/lib/rank/live.ts';
import { ingestTsv } from '../../src/lib/ingest.ts';
import { planCustomer } from '../../src/lib/plan.ts';
import { parseRecs } from '../../src/lib/recs.ts';
import { resetRunKeyAttempts } from '../../src/worker/run-key.ts';
import { routes } from '../../src/worker/routes/agents.ts';
import { routes as startRoutes } from '../../src/worker/routes/start.ts';
import { match } from '../../src/worker/routes/list.ts';
import { buildIndex, search } from '../../src/lib/search/index.ts';
import { db, env, migrate } from './run-fx.ts';

const product = (n: number, over: Partial<Product>): Product => ({ id: `w${n}`, handle: `w-${n}`, title: `Piece <${n}>`, url: '', body_text_clean: '', category: ['Accessories'], subcategory: [`S${n}`], class: [`K${n}`], subclass: [],
  wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [], room_or_use: [], collection: [], campaign: [], occasion_keys: [], prior_tags: [], material: null, material_group: null, colours: [], gender: null,
  design_group: null, badges: [], is_bestseller_gift: false, available: true, variants: [], images: [], excluded_reason: null, content_sha256: '', ...over });
const rows = [1, 2, 3, 4, 5].map((n) => product(n, { occasion_keys: ['wedding'], ...(n === 5 ? { badges: ['New'] } : {}) })).concat([product(6, { prior_tags: ['x'] }), product(7, { badges: ['New'] }), product(8, {})]);
const CAT = { snapshot_id: 'snap', fetched_at: 't', rows: new Map(rows.map((p) => [p.id, p])), by_sku: new Map(), usable: rows, rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: [] } } as unknown as Catalog;
vi.mock('../../src/lib/catalog/index.ts', () => ({ loadCatalog: async () => CAT }));

const W: Weights = { occasion: 150, season: 20, bestseller: 15, new: 10, past: 10, merchandising: 30, push_down: 15 };
const dev: Actor = { kind: 'dev', email: 'a@b', sub: 'dev:a@b' };
const KEY = 'test-run-key-9f3a';
const TSV = "customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\nc01\tMeera\tDas\tSister's wedding\tBought the indigo travel shirt last spring.\n";
const RECS: Omit<RecFile, 'rows'> & { rows: [] } = { version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'snap', rule: 'r', rows: [] };

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof ConfigErr) return e.code; throw e; } };
const count = async () => (await db.prepare(`SELECT count(*) AS n FROM config_versions WHERE kind = 'rank'`).first<{ n: number }>())!.n;
const objects = async () => (await env.BUCKET.list()).objects.length;
const qs = (w: Weights, extra = '') => `?${new URLSearchParams(Object.entries(w).map(([k, v]) => [k, String(v)]))}${extra}`;
const hit = (method: string, url: string, e: object = {}, form?: Record<string, string>) => {
  const u = new URL(`https://x.test${url}`), m = match(method, u.pathname, [...routes, ...startRoutes]);
  if (!m) throw new Error(`no route ${method} ${u.pathname}`);
  return m.route.handler({ req: new Request(u, { method, body: form ? new URLSearchParams(form) : undefined }), env: { RUN_KEY: KEY, ...env, ...e } as never, exec: {} as ExecutionContext, actor: dev, params: m.params });
};
const status = async (id: string) => (await db.prepare('SELECT status FROM config_versions WHERE id = ?').bind(id).first<{ status: string }>())?.status;
const seeded = async () => { await saveVersion(db, 'rank', null, W, 'defaults', dev); return activateVersion(db, 'rank-v1', dev); };

beforeAll(migrate);
beforeEach(async () => {
  resetRunKeyAttempts();
  for (const t of ['config_versions', 'runs', 'plans', 'cost_events']) await db.exec(`DELETE FROM ${t}`);
  await env.BUCKET.put('inputs/customers.synthetic.tsv', TSV);
  await env.BUCKET.put('inputs/recommendations.synthetic.json', JSON.stringify(RECS));
});

describe('refused saves', () => {
  it('past at or over occasion, and occasion 0, leave no row', async () => {
    expect(await code(saveVersion(db, 'rank', null, { ...W, past: 100 }, 'n', dev))).toBe('VALIDATION_FAILED');
    expect(await code(saveVersion(db, 'rank', null, { ...W, occasion: 0, past: 0 }, 'n', dev))).toBe('VALIDATION_FAILED');
    expect(await count()).toBe(0);
  });
  it('the form answers in plain words and keeps what was typed', async () => {
    await seeded();
    const r = await hit('POST', '/review/agents/refine/save', {}, { ...Object.fromEntries(Object.entries({ ...W, past: 200 }).map(([k, v]) => [k, String(v)])), note: 'try' });
    expect(r.status).toBe(400);
    const h = await r.text();
    expect(h).toContain('Past purchase must stay below occasion');
    expect(h).toContain('value="200"');
    expect(await count()).toBe(1);
  });
  it('no note, no save', async () => {
    await seeded();
    const r = await hit('POST', '/review/agents/refine/save', {}, Object.fromEntries(Object.entries({ ...W, new: 12 }).map(([k, v]) => [k, String(v)])));
    expect(r.status).toBe(400);
    expect(await count()).toBe(1);
  });
});

describe('a version is immutable', () => {
  it('a change is a new row, with who and when; the old one is byte for byte the same', async () => {
    await seeded();
    const before = await db.prepare(`SELECT content_json, sha256 FROM config_versions WHERE id = 'rank-v1'`).first();
    const v2 = await saveVersion(db, 'rank', 'rank-v1', { ...W, new: 12 }, 'more new', dev);
    expect(v2).toMatchObject({ id: 'rank-v2', status: 'draft', created_by: 'a@b', parent_id: 'rank-v1' });
    expect(v2.created_at).toBeTruthy();
    expect(await db.prepare(`SELECT content_json, sha256 FROM config_versions WHERE id = 'rank-v1'`).first()).toEqual(before);
  });
  it('the table refuses an update to stored weights', async () => {
    await seeded();
    await expect(db.exec(`UPDATE config_versions SET content_json = '{}' WHERE id = 'rank-v1'`)).rejects.toThrow(/immutable/);
  });
  it('the same weights again are refused', async () => {
    await seeded();
    expect(await code(saveVersion(db, 'rank', 'rank-v1', W, 'n', dev))).toBe('UNCHANGED');
  });
  it('still hashes on load', async () => {
    await seeded();
    expect((await loadVersion(db, 'rank-v1', BUNDLE)).content).toEqual(W);
  });
});

describe('the product read (R141)', () => {
  it('route and page return the same ids as search, with counts and paging, and the route stays on the deployed link', async () => {
    rows[0].facets = { class: ['Kurta'] }; rows[1].facets = { class: ['Kurta'] }; rows[2].facets = { class: ['Bag'] };
    const m = (u: string, e = {}) => { const url = new URL(`https://x.test${u}`), r = match('GET', url.pathname)!; return r.route.handler({ req: new Request(url), env: { ...env, ...e } as never, exec: {} as ExecutionContext, actor: dev, params: {} }); };
    try {
      await db.prepare(`INSERT OR IGNORE INTO snapshots (id, fetched_at, product_rows, usable_rows, synthetic) VALUES ('snap', 't', 1, 1, 0)`).run();
      const b = await (await m('/api/products?class=Kurta&limit=1&offset=1', { DEPLOYED: '1' })).json<{ count: number; ids: string[]; products: { id: string }[]; counts: Record<string, { value: string; count: number }[]> }>();
      expect(b.ids).toEqual(search({ all: { class: ['Kurta'] } }, buildIndex(rows)).ids);
      expect(b.count).toBe(2);
      const h = await (await m('/review/search?class=Kurta')).text();
      expect([...h.matchAll(/data-id="([^"]+)"/g)].map((x) => x[1])).toEqual(b.ids);
      expect(h).toContain('class="chip on"');
      expect(h).toContain('Kurta 2');
      expect(h).toContain('Piece &#60;1&#62;');
      expect(b.products.map((p) => p.id)).toEqual([b.ids[1]]);
      expect(b.counts.class).toEqual([{ value: 'Bag', count: 1 }, { value: 'Kurta', count: 2 }].sort((x, y) => y.count - x.count));
    } finally { for (const p of rows.slice(0, 3)) delete p.facets; }
  });
});

describe('preview', () => {
  it('writes nothing: no row, no object', async () => {
    await seeded();
    const rowsBefore = await count(), objs = await objects();
    const r = await hit('GET', `/review/agents/refine${qs({ ...W, season: 60, push_down: 0 }, '&preview=1')}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/Unchanged.*Sections only.*Picks changed/s);
    expect(await count()).toBe(rowsBefore);
    expect(await objects()).toBe(objs);
  });
  it('shows before and after with score and why, escaped, in plain words', async () => {
    await seeded();
    const h = await (await hit('GET', `/review/agents/refine${qs({ ...W, past: 1, season: 0, bestseller: 0, new: 90, push_down: 0 }, '&preview=1&only=c01')}`)).text();
    expect(h).toContain('Picks changed');
    expect(h).toContain('Piece &#60;5&#62;');
    expect(h).toContain('New on the site');
    expect(h).not.toMatch(/prior_tag|occasion_tag|OCCASION_MATCH|FALLBACK|tier/i);
  });
  it('compares with the latest finished run, and prices a redraft from its stored estimates', async () => {
    await seeded();
    const stored = { picks: ['w8', 'w7', 'w6', 'w1'].map((product_id, i) => ({ slot: `p${i + 1}`, product_id, reason_code: 'OCCASION_MATCH', group: 'wear' })) };
    await db.prepare(`INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting, prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status, created_by, created_at)
      VALUES ('old', 'old', 'voice', 'both', 'snap', 'd', 'h', 'k', 1, 'h', 's', 'v1', 'v1', 'h', 'm', 'jev-v1', 1, 1, 'h', 1, 'done', 'e', 't')`).run();
    await db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES ('old', 'c01', ?, 't')`).bind(JSON.stringify(stored)).run();
    await db.prepare(`INSERT INTO cost_events (run_id, customer_id, attempt, setting, est_usd, action, call_state, at) VALUES ('old', 'c01', 1, 's', 0.05, 'admit', 'estimated', 't')`).run();
    const h = await (await hit('GET', `/review/agents/refine${qs(W, '&preview=1')}`)).text();
    expect(h).toContain('$0.0500');
    expect(h).toContain('old');
  });
  it('a stub run is not a baseline, and a one-customer run does not hide an older one', async () => {
    await seeded();
    const run = (id: string, at: string) => db.prepare(`INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting, prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status, created_by, created_at)
      VALUES (?1, ?1, 'voice', 'both', 'snap', 'd', 'h', 'k', 1, 'h', 's', 'v1', 'v1', 'h', 'm', 'jev-v1', 1, 1, 'h', 1, 'done', 'e', ?2)`).bind(id, at).run();
    await run('real-1', '2026-01-01'); await run('stub-later', '2026-02-01');
    for (const id of ['real-1', 'stub-later']) await db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES (?, 'c01', '{"picks":[]}', 't')`).bind(id).run();
    const h = await (await hit('GET', `/review/agents/refine${qs(W, '&preview=1')}`)).text();
    expect(h).toContain('real-1');
    expect(h).not.toContain('stub-later');
  });
  it('names who the push down moves, against the same weights with it off (R138)', async () => {
    const pushed = rows.slice(0, 3);
    for (const p of pushed) p.push_down = true;
    try {
      await seeded();
      const h = await (await hit('GET', `/review/agents/refine${qs({ ...W, push_down: 15 }, '&preview=1&only=c01')}`)).text();
      expect(h).toContain('Moved by push down');
      expect(h.slice(h.lastIndexOf('Moved by push down'))).toContain('<strong>c01</strong>');
      expect(await (await hit('GET', `/review/agents/refine${qs({ ...W, push_down: 0 }, '&preview=1&only=c01')}`)).text()).toContain('Push down is off');
    } finally { for (const p of pushed) delete p.push_down; }
  });
  it('shows the sixth weight, and a version saved with five loads with it at 0', async () => {
    await seeded();
    const { push_down: _, ...five } = W;
    const h = await (await hit('GET', `/review/agents/refine${qs(five)}`)).text();
    expect(h).toMatch(/id="w-push_down"[^>]*value="0"/);
    expect((await hit('GET', `/review/agents/refine${qs(five, '&preview=1&only=c01')}`)).status).toBe(200);
  });
  it('shows the merchandising weight, loads a version saved without it at 0, and says the signal in plain words (R140)', async () => {
    const tagged = rows[0];
    tagged.merch_rank = { 'all-women': 3 };
    try {
      await seeded();
      const { merchandising: _, ...six } = W;
      expect(await (await hit('GET', `/review/agents/refine${qs(six)}`)).text()).toMatch(/id="w-merchandising"[^>]*value="0"/);
      const h = await (await hit('GET', `/review/agents/refine${qs(W, '&preview=1&only=c01')}`)).text();
      expect(h).toContain('Near the top of Nicobar&#39;s All Women');
      expect(h).not.toContain('merch:');
    } finally { delete tagged.merch_rank; }
  });
  it('refuses bad weights and does not rank', async () => {
    await seeded();
    const r = await hit('GET', `/review/agents/refine${qs({ ...W, occasion: 0, past: 0 }, '&preview=1')}`);
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('Picks changed');
  });
});

describe('activation needs the run key', () => {
  const draft = async () => { await seeded(); return saveVersion(db, 'rank', 'rank-v1', { ...W, new: 12 }, 'more new', dev); };
  it('no key, or a wrong one: 403, and it stays a draft, with the key never echoed', async () => {
    await draft();
    expect((await hit('POST', '/review/agents/refine/activate', {}, { id: 'rank-v2' })).status).toBe(403);
    const r = await hit('POST', '/review/agents/refine/activate', {}, { id: 'rank-v2', run_key: 'guess-secret' });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toMatch(/guess-secret|test-run-key/);
    expect(await status('rank-v2')).toBe('draft');
  });
  it('the right key activates, and retires the one before', async () => {
    await draft();
    const r = await hit('POST', '/review/agents/refine/activate', {}, { id: 'rank-v2', run_key: KEY });
    expect(r.status).toBe(303);
    expect(await status('rank-v2')).toBe('active');
    expect(await status('rank-v1')).toBe('retired');
  });
  it('the plain config route cannot be used to go round the key', async () => {
    await draft();
    const r = await hit('POST', '/api/config/rank-v2/activate');
    expect(r.status).toBe(403);
    expect(await status('rank-v2')).toBe('draft');
  });
  it('the first version may be seeded only with the shipped defaults', async () => {
    await saveVersion(db, 'rank', null, W, 'seed', dev);
    expect((await hit('POST', '/api/config/rank-v1/activate')).status).toBe(200);
    await db.exec('DELETE FROM config_versions');
    await saveVersion(db, 'rank', null, { ...W, new: 30 }, 'not the defaults', dev);
    expect((await hit('POST', '/api/config/rank-v1/activate')).status).toBe(403);
  });
  it('no RUN_KEY on the server: locked', async () => {
    await draft();
    const r = await hit('POST', '/review/agents/refine/activate', { RUN_KEY: undefined }, { id: 'rank-v2', run_key: 'x' });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('locked');
  });
});

describe('on the link', () => {
  const link = { DEPLOYED: '1' };
  it('reads, with no form to save or activate and nothing ranked', async () => {
    await seeded();
    const h = await (await hit('GET', `/review/agents/refine${qs({ ...W, season: 60, push_down: 0 }, '&preview=1')}`, link)).text();
    expect(h).toContain('rank-v1');
    expect(h).not.toMatch(/Save draft|type="password"|<script|Picks changed/);
  });
  it('POST is 503', async () => {
    await seeded();
    expect((await hit('POST', '/review/agents/refine/save', link, { note: 'x' })).status).toBe(503);
    expect((await hit('POST', '/review/agents/refine/activate', link, { id: 'rank-v1', run_key: KEY })).status).toBe(503);
  });
});

describe('a run pins the version', () => {
  it('recommendations ranked at the active version carry it to the plan, method weights', async () => {
    const v = await seeded();
    expect(await activeRank(db)).toMatchObject({ id: 'rank-v1' });
    const recs = parseRecs(JSON.parse(rankedRecs(parseRecs(RECS), TSV, CAT, v)));
    expect(recs.generated_by).toMatchObject({ method: 'weights', version: 'rank-v1', weights: W, snapshot_id: 'snap' });
    const plan: Plan = planCustomer(ingestTsv(TSV)[0], recs.rows[0], { c01: { key: 'wedding' } }, CAT, { format: 'both', run_date: 'd' } as never, { version: 'x', default: 'open', shapes: [] });
    expect(plan.picks[0].score).toBe(160);
  });
  it('the same inputs give the same bytes, so a preview stays good at Start', async () => {
    const v = await seeded();
    expect(rankedRecs(parseRecs(RECS), TSV, CAT, v)).toBe(rankedRecs(parseRecs(RECS), TSV, CAT, v));
  });
});

describe('versions that are not prompts', () => {
  it('a rank version has no editor of its own: it opens the refine page', async () => {
    await seeded();
    const r = await hit('GET', '/review/agents/rank-v1');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/review/agents/refine');
  });
  it('the Agents screen links to the page', async () => {
    expect(await (await hit('GET', '/review/agents')).text()).toContain('href="/review/agents/refine"');
  });
});
