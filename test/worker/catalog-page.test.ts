// The catalog viewer: versions, activation behind the run key, a preview that writes nothing, paging, filters, escaping.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Catalog, Product, RecFile } from '../../src/contracts/types.ts';
import { ConfigErr, activateVersion, activeCatalog, saveVersion } from '../../src/lib/config/index.ts';
import { EMPTY } from '../../src/lib/catalog/override.ts';
import { parseRecs } from '../../src/lib/recs.ts';
import { rankedRecs } from '../../src/lib/rank/live.ts';
import { resetRunKeyAttempts } from '../../src/worker/run-key.ts';
import { routes } from '../../src/worker/routes/catalog.ts';
import { routes as agentRoutes } from '../../src/worker/routes/agents.ts';
import { ROUTES, match } from '../../src/worker/routes/list.ts';
import { db, env, migrate } from './run-fx.ts';

const IMG = { src: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/a.jpg?v=1', src_canonical: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/a.jpg', position: 1, variant_ids: [] };
const product = (id: string, over: Partial<Product>): Product => ({ id, handle: `h-${id}`, title: `Piece ${id}`, url: `https://www.nicobar.com/products/h-${id}`, body_text_clean: 'Body words.', category: ['Accessories'], subcategory: [`S${id}`], class: [`K${id}`], subclass: [],
  wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [], room_or_use: [], collection: [], campaign: [], occasion_keys: ['wedding'], prior_tags: [], material: null, material_group: null, colours: [], gender: null,
  design_group: null, badges: [], is_bestseller_gift: false, available: true, variants: [], images: [IMG], excluded_reason: null, excluded_reasons: [], published_at: '2026-10-01T00:00:00Z', content_sha256: '', ...over });
const fail = (...r: string[]) => ({ excluded_reason: r[0], excluded_reasons: r });
const rows = [...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => product(String(n), {})),
  product('9', { ...fail('NOT_AVAILABLE'), available: false, title: 'Sold <b>out</b>', published_at: '2026-03-01T00:00:00Z' }),
  product('10', { ...fail('NOT_AVAILABLE'), available: false, published_at: '2020-01-01T00:00:00Z' }),
  product('11', { ...fail('BUNDLE', 'THIN_COPY'), published_at: '2026-09-01T00:00:00Z', category: ['Home'] }),
  product('12', { handle: 'alphabet-mug', published_at: '2025-01-01T00:00:00Z', occasion_keys: ['birthday'] }),
  ...Array.from({ length: 70 }, (_, i) => product(String(100 + i), { ...fail('NOT_AVAILABLE'), available: false, title: `Old ${i}`, published_at: '2019-01-01T00:00:00Z' }))];
const CAT = { snapshot_id: 'snap', fetched_at: '2026-10-29T12:00:00Z', rows: new Map(rows.map((p) => [p.id, p])), by_sku: new Map(), usable: rows.filter((p) => p.excluded_reason === null), rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: [] } } as unknown as Catalog;
vi.mock('../../src/lib/catalog/index.ts', () => ({ loadCatalog: async () => CAT }));

const dev: Actor = { kind: 'dev', email: 'a@b', sub: 'dev:a@b' };
const KEY = 'test-run-key-9f3a';
const TSV = "customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\nc01\tMeera\tDas\tSister's wedding\tBought the indigo travel shirt last spring.\n";
const RECS: Omit<RecFile, 'rows'> & { rows: [] } = { version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'snap', rule: 'r', rows: [] };

const hit = (method: string, url: string, e: object = {}, form?: Record<string, string>) => {
  const u = new URL(`https://x.test${url}`), m = match(method, u.pathname, [...routes, ...agentRoutes]);
  if (!m) throw new Error(`no route ${method} ${u.pathname}`);
  return m.route.handler({ req: new Request(u, { method, body: form ? new URLSearchParams(form) : undefined }), env: { RUN_KEY: KEY, ...env, ...e } as never, exec: {} as ExecutionContext, actor: dev, params: m.params });
};
const text = async (url: string, e: object = {}) => (await hit('GET', url, e)).text();
const count = async () => (await db.prepare(`SELECT count(*) AS n FROM config_versions WHERE kind = 'catalog'`).first<{ n: number }>())!.n;
const objects = async () => (await env.BUCKET.list()).objects.length;
const status = async (id: string) => (await db.prepare('SELECT status FROM config_versions WHERE id = ?').bind(id).first<{ status: string }>())?.status;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof ConfigErr) return e.code; throw e; } };

beforeAll(migrate);
beforeEach(async () => {
  resetRunKeyAttempts();
  for (const t of ['config_versions', 'runs', 'plans', 'cost_events', 'snapshots']) await db.exec(`DELETE FROM ${t}`);
  await db.prepare(`INSERT INTO snapshots (id, fetched_at, product_rows, usable_rows, synthetic) VALUES ('snap', '2026-10-29T12:00:00Z', 82, 9, 0)`).run();
  await env.BUCKET.put('inputs/customers.synthetic.tsv', TSV);
  await env.BUCKET.put('inputs/recommendations.synthetic.json', JSON.stringify(RECS));
  await env.BUCKET.put('snapshots/snap/report.json', JSON.stringify({ excluded: { GIFT_CARD: 7131 } }));
  await env.BUCKET.put('snapshots/snap/detail.json', JSON.stringify({ 11: { tags: ['Filterclass_X', '<script>t'], text: 'Long site <copy>.' } }));
});

describe('routing', () => {
  it('comes before /review/:id', () => {
    expect(match('GET', '/review/catalog', ROUTES)?.route.path).toBe('/review/catalog');
    expect(match('GET', '/review/catalog/11', ROUTES)?.route.path).toBe('/review/catalog/:id');
  });
  it('sits in the shared side nav', async () => { expect(await text('/review/catalog')).toMatch(/href="\/review\/catalog" aria-current/); });
});

describe('the top', () => {
  it('shows counts per rule, usable now, and locks P0', async () => {
    const h = await text('/review/catalog');
    expect(h).toContain('Usable now');
    expect(h).toMatch(/Sold out.*?P0.*?72/s);
    expect(h).toContain('7131');
    expect(h).toMatch(/Bundle.*?P1/s);
    expect(h).toContain('Locked');
    expect(h).toContain('Switch off');
  });
  it('counts sold-out products from the last 12 months against the snapshot date, not today', async () => {
    expect(await text('/review/catalog')).toContain('1 from the last 12 months');
  });
});

describe('the list', () => {
  it('pages at 60', async () => {
    const h = await text('/review/catalog');
    expect(h.match(/<tr data-p=/g)?.length).toBe(60);
    expect(h).toContain('Page 1 of 2');
    expect((await text('/review/catalog?page=2')).match(/<tr data-p=/g)?.length).toBe(22);
  });
  it('a junk page number falls back to the first or last', async () => {
    expect(await text('/review/catalog?page=abc')).toContain('Page 1 of 2');
    expect(await text('/review/catalog?page=99')).toContain('Page 2 of 2');
  });
  it('filters by title, status, reason, category, occasion', async () => {
    const n = async (q: string) => (await text(`/review/catalog?${q}`)).match(/<tr data-p=/g)?.length ?? 0;
    expect(await n('q=piece+1')).toBe(4);                 // 1, 10, 11, 12
    expect(await n('status=p1')).toBe(2);
    expect(await n('status=p0')).toBe(60);
    expect(await n('reason=THIN_COPY')).toBe(1);
    expect(await n('category=Home')).toBe(1);
    expect(await n('occasion=birthday')).toBe(1);
  });
  it('sorts newest first and filters by published age against the snapshot date', async () => {
    const h = await text('/review/catalog?months=3');
    expect(h.match(/<tr data-p=/g)?.length).toBe(9);
    const first = (await text('/review/catalog?sort=newest')).match(/<tr data-p="(\d+)"/)![1];
    expect(rows.find((p) => p.id === first)!.published_at).toBe('2026-10-01T00:00:00Z');
    expect(await text('/review/catalog?sort=newest')).toContain('2026-10-01');
    expect((await text('/review/catalog?months=12')).match(/<tr data-p=/g)?.length).toBe(10);
  });
  it('Enable only where every reason is P1; Disable on any usable item', async () => {
    const row = (h: string, id: string) => h.match(new RegExp(`<tr data-p="${id}".*?</tr>`, 's'))![0];
    const h = await text('/review/catalog?months=12'), b = await text('/review/catalog?status=p1');
    expect(row(b, '11')).toContain('Enable');
    expect(row(h, '9')).not.toContain('Enable');
    expect(row(h, '1')).toContain('Disable');
    expect(row(h, '9')).not.toContain('Disable');
  });
  it('shows reasons in plain words and escapes the catalog', async () => {
    const h = await text('/review/catalog?months=12');
    expect(h).toContain('Sold &lt;b&gt;out&lt;/b&gt;');
    expect(h).not.toContain('<b>out</b>');
    expect(await text('/review/catalog?status=p1')).toMatch(/Bundle.*Thin description/s);
  });
  it('escapes what the query carries', async () => {
    const h = await text(`/review/catalog?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(h).not.toContain('<script>alert');
  });
});

describe('one product', () => {
  it('shows raw tags, description, images, a link and the customer count, escaped', async () => {
    const h = await text('/review/catalog/11');
    expect(h).toContain('&lt;script&gt;t');
    expect(h).toContain('Long site &lt;copy&gt;.');
    expect(h).toContain('https://www.nicobar.com/products/h-11');
    expect(h).toContain(IMG.src.replace('?v=1', ''));
    expect(h).toMatch(/customers/);
    expect(h).toContain('2026-09-01');
    expect(h).toContain('Pushed down by the site');
  });
  it('an unknown id is a 404 page', async () => { expect((await hit('GET', '/review/catalog/404404')).status).toBe(404); });
});

describe('versions', () => {
  const save = (o: Partial<typeof EMPTY>, parent: string | null = null) => saveVersion(db, 'catalog', parent, { ...EMPTY, ...o }, 'why', dev);
  it('a change is a new draft row with who and when, and the table refuses an edit', async () => {
    const v = await save({ enabled: ['11'] });
    expect(v).toMatchObject({ id: 'catalog-v1', status: 'draft', created_by: 'a@b', parent_id: null });
    await expect(db.exec(`UPDATE config_versions SET content_json = '{}' WHERE id = 'catalog-v1'`)).rejects.toThrow(/immutable/);
  });
  it('a version that switches a P0 rule off is refused and leaves no row', async () => {
    expect(await code(save({ rules_off: ['NOT_AVAILABLE'] }))).toBe('VALIDATION_FAILED');
    expect(await count()).toBe(0);
  });
  it('the form refuses a P0 item in words, and an item not in the snapshot', async () => {
    const r = await hit('POST', '/review/catalog/save', {}, { en: '9', note: 'try' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Sold');
    expect((await hit('POST', '/review/catalog/save', {}, { dis: '555', note: 'try' })).status).toBe(400);
    expect(await count()).toBe(0);
  });
  it('no note, no save; a draft saves and redirects', async () => {
    expect((await hit('POST', '/review/catalog/save', {}, { en: '11' })).status).toBe(400);
    expect((await hit('POST', '/review/catalog/save', {}, { en: '11', off: 'THIN_COPY', note: 'for the demo' })).status).toBe(303);
    expect(await status('catalog-v1')).toBe('draft');
    expect(await activeCatalog(db)).toBeNull();
  });
  it('the same content twice is refused, order aside', async () => {
    const a = await save({ enabled: ['11', '12'] });
    await activateVersion(db, a.id, dev);
    expect(await code(save({ enabled: ['12', '11'] }, a.id))).toBe('UNCHANGED');
  });
});

describe('activation needs the run key', () => {
  const draft = () => saveVersion(db, 'catalog', null, { ...EMPTY, enabled: ['11'] }, 'n', dev);
  it('no key or a wrong one: 403, still a draft, the key never echoed', async () => {
    await draft();
    expect((await hit('POST', '/review/catalog/activate', {}, { id: 'catalog-v1' })).status).toBe(403);
    const r = await hit('POST', '/review/catalog/activate', {}, { id: 'catalog-v1', run_key: 'guess-secret' });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toMatch(/guess-secret|test-run-key/);
    expect(await status('catalog-v1')).toBe('draft');
  });
  it('the right key activates', async () => {
    await draft();
    expect((await hit('POST', '/review/catalog/activate', {}, { id: 'catalog-v1', run_key: KEY })).status).toBe(303);
    expect(await status('catalog-v1')).toBe('active');
  });
  it('the plain config routes cannot go round the key', async () => {
    await draft();
    expect((await hit('POST', '/api/config/catalog-v1/activate')).status).toBe(403);
    expect(await status('catalog-v1')).toBe('draft');
  });
});

describe('preview', () => {
  it('writes nothing, and shows the usable change and each customer', async () => {
    const before = [await count(), await objects()];
    const h = await text('/review/catalog?draft=1&en=11&dis=1&preview=1');
    expect(h).toContain('Impact');
    expect(h).toContain('c01');
    expect(h).toMatch(/Usable.*?0/s);
    expect(h).toContain('Nothing was saved');
    expect([await count(), await objects()]).toEqual(before);
  });
  it('shows the diff against the active version', async () => {
    expect(await text('/review/catalog?draft=1&off=BUNDLE&en=11')).toMatch(/\+ Rule off: Bundle.*\+ Enabled: Piece 11/s);
  });
  it('a P0 id in the URL changes nothing', async () => {
    const h = await text('/review/catalog?draft=1&en=9&preview=1');
    expect(h).toContain('Sold');
    expect(h).toMatch(/cannot be enabled/);
  });
});

describe('on the link', () => {
  const link = { DEPLOYED: '1' };
  it('reads, with no switch, button, form or preview', async () => {
    await saveVersion(db, 'catalog', null, { ...EMPTY, enabled: ['11'] }, 'n', dev);
    const h = await text('/review/catalog?draft=1&en=11&preview=1', link);
    expect(h).toContain('Usable now');
    expect(h).not.toMatch(/Switch off|type="password"|>Enable<|>Disable<|Impact/);
  });
  it('POST is 503', async () => {
    expect((await hit('POST', '/review/catalog/save', link, { note: 'x' })).status).toBe(503);
    expect((await hit('POST', '/review/catalog/activate', link, { id: 'catalog-v1', run_key: KEY })).status).toBe(503);
  });
});

describe('a run pins the version', () => {
  it('a file ranked at a catalog version carries it, and a bad version cannot enable P0', async () => {
    const v = await saveVersion(db, 'catalog', null, { ...EMPTY, enabled: ['11', '9'] }, 'n', dev);
    const recs = parseRecs(JSON.parse(rankedRecs(parseRecs(RECS), TSV, CAT, { id: 'rank-v1', content: { occasion: 100, season: 20, bestseller: 15, new: 10, past: 10 } }, v)));
    expect(recs.generated_by).toMatchObject({ catalog_version: 'catalog-v1' });
    expect(JSON.stringify(recs.rows)).not.toContain('"9"');
  });
});
