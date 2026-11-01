// R143, R144: landing.* serves every released draft and nothing else; nicobar.* stays behind Access.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentSha256 } from '../../src/contracts/lib.ts';
import type { AppEnv } from '../../src/contracts/types.ts';
import worker from '../../src/worker/index.ts';
import { fixtureSql } from '../../scripts/seed.ts';

const e = env as unknown as AppEnv & { TEST_MIGRATIONS: never };
const LANDING = 'https://landing.x.test';
const hit = (url: string, init?: RequestInit, over: object = {}) => worker.fetch!(new Request(url, init) as never, { ...e, PUBLIC_ORIGIN: LANDING, ...over } as never, {} as ExecutionContext);
const land = (path: string, init?: RequestInit) => hit(`${LANDING}${path}`, init);

const ID = 'fx-run:c02:v1';
const row = () => e.DB.prepare('SELECT envelope_json, model_json, rendered_json FROM drafts WHERE id = ?').bind(ID).first<Record<string, string>>();
const PARTS = { email: '<html><body data-part="email"><a data-landing href="?part=landing_page">See your edit</a></body></html>', catalog: '<html><body class="nb">the catalog</body></html>' };

/** Same-row copy under a new key. Column order comes from the table, so a migration cannot break it. */
async function clone(table: string, where: string, over: Record<string, string>) {
  const cols = (await e.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name);
  const vals = cols.map((c) => (c in over ? `'${over[c]}'` : c));
  await e.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) SELECT ${vals.join(',')} FROM ${table} WHERE ${where}`).run();
}
const newRun = (id: string) => clone('runs', `id = 'fx-run'`, { id, instance_id: id, created_at: '2999-01-01T00:00:00Z' });
const dropRun = async (id: string) => {
  await e.DB.prepare('DELETE FROM drafts WHERE run_id = ?').bind(id).run();
  await e.DB.prepare('DELETE FROM runs WHERE id = ?').bind(id).run();
};

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  for (const s of await fixtureSql()) await e.DB.prepare(s).run();
  const r = (await row())!;
  const rendered = JSON.stringify({ ...JSON.parse(r.rendered_json), ...PARTS });
  const hash = await contentSha256(r.envelope_json, r.model_json, rendered);
  await e.DB.prepare('UPDATE drafts SET rendered_json = ?, approved_sha256 = ?, content_sha256 = ? WHERE id = ?').bind(rendered, hash, hash, ID).run();
});
let unknown: { status: number; body: string; type: string | null };
beforeEach(async () => {
  const r = await land('/nobody-here');
  unknown = { status: r.status, body: await r.text(), type: r.headers.get('content-type') };
});
const isUnknown = async (r: Response) => {
  expect({ status: r.status, body: await r.text(), type: r.headers.get('content-type') }).toEqual(unknown);
  expect(r.headers.get('x-robots-tag')).toContain('noindex');
};

describe('landing host: the three parts', () => {
  it('serves the landing page with no auth, script locked, unindexed, labelled', async () => {
    const r = await land('/c02');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/^sandbox;/);
    expect(csp).toContain("script-src 'none'");
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    expect(html).toContain('nb-packing');
    expect(html).toMatch(/<body[^>]*><p [^>]*>[^<]*demo[^<]*synthetic customers/i);
  });
  it('email: the button goes to the public page and the stored row is untouched', async () => {
    const r = await land('/c02/email');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`href="${LANDING}/c02"`);
    expect(JSON.parse((await row())!.rendered_json).email).toContain('href="?part=landing_page"');
  });
  it('catalog', async () => expect(await (await land('/c02/catalog')).text()).toContain('the catalog'));
  it('robots.txt disallows everything', async () => {
    const r = await land('/robots.txt');
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/User-agent: \*\s+Disallow: \//);
  });
});

describe('landing host: nothing else exists', () => {
  for (const p of ['/', '/api/runs', '/api/drafts/x/approve', '/api/products', '/review', '/review/evals', '/review/catalog', `/review/${encodeURIComponent(ID)}`,
    `/released/${encodeURIComponent(ID)}?part=email`, '/c02/other', '/c02/email/x', '/c02/', '/c%30%32', '/review/runs/fx-run.json', '/c02/plan']) {
    it(`GET ${p} is the unknown 404`, async () => isUnknown(await land(p)));
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    it(`${method} /c02 is 404`, async () => expect((await land('/c02', { method, headers: { Origin: LANDING } })).status).toBe(404));
  }
  it('POST to the approve route is 404 and changes nothing', async () => {
    const r = await land(`/api/drafts/${encodeURIComponent('fx-run:c16:v1')}/approve`, { method: 'POST', headers: { Origin: LANDING } });
    expect(r.status).toBe(404);
    expect(await e.DB.prepare('SELECT status FROM drafts WHERE id = ?').bind('fx-run:c16:v1').first('status')).toBe('in_review');
  });
});

describe('landing host: released only, and state does not leak', () => {
  it('an in_review draft is the unknown 404, on all three paths', async () => {
    for (const p of ['/c16', '/c16/email', '/c16/catalog']) await isUnknown(await land(p));
  });
  it('an approved draft, hash good, is the unknown 404 until it is released', async () => {
    await clone('drafts', `id = '${ID}'`, { id: 'fx-run:c99:v1', customer_id: 'c99' });
    await e.DB.prepare(`UPDATE drafts SET status = 'approved', released_by = NULL, released_sub = NULL, released_at = NULL WHERE id = 'fx-run:c99:v1'`).run();
    await isUnknown(await land('/c99'));
    await e.DB.prepare(`DELETE FROM drafts WHERE id = 'fx-run:c99:v1'`).run();
  });
  it('a part the format lacks is the unknown 404', async () => {
    const r = (await row())!, was = await e.DB.prepare('SELECT approved_sha256 FROM drafts WHERE id = ?').bind(ID).first<string>('approved_sha256');
    const rendered = JSON.stringify({ ...JSON.parse(r.rendered_json), catalog: null });
    const hash = await contentSha256(r.envelope_json, r.model_json, rendered), set = 'UPDATE drafts SET rendered_json = ?, approved_sha256 = ?, content_sha256 = ? WHERE id = ?';
    await e.DB.prepare(set).bind(rendered, hash, hash, ID).run();   // hash good, so only the missing part can 404
    await isUnknown(await land('/c02/catalog'));
    await e.DB.prepare(set).bind(r.rendered_json, was, was, ID).run();
  });
  it('a hash mismatch is the unknown 404', async () => {
    const before = (await row())!.model_json;
    await e.DB.prepare('UPDATE drafts SET model_json = ? WHERE id = ?').bind(`${before} `, ID).run();
    await isUnknown(await land('/c02'));
    await e.DB.prepare('UPDATE drafts SET model_json = ? WHERE id = ?').bind(before, ID).run();
    expect((await land('/c02')).status).toBe(200);
  });
});

describe('landing host: across runs', () => {
  const copyDraft = (run: string) => clone('drafts', `id = '${ID}'`, { id: `${run}:c02:v1`, run_id: run });
  it('a stub run never publishes, however new', async () => {
    await newRun('stub-new');
    await copyDraft('stub-new');
    await e.DB.prepare(`UPDATE drafts SET model_json = 'stub' WHERE id = 'stub-new:c02:v1'`).run();   // breaks its hash: if this row were chosen, the page would 404
    expect((await land('/c02')).status).toBe(200);
    await dropRun('stub-new');
  });
  it('a release in a newer run leaves other customers served', async () => {
    await newRun('run-new');
    await clone('drafts', `id = '${ID}'`, { id: 'run-new:c03:v1', run_id: 'run-new', customer_id: 'c03' });
    expect((await land('/c02')).status).toBe(200);
    expect((await land('/c03')).status).toBe(200);
    await dropRun('run-new');
  });
  it("a customer's newer release replaces their older one", async () => {
    await newRun('run-new');
    await clone('drafts', `id = '${ID}'`, { id: 'run-new:c02:v1', run_id: 'run-new', released_at: '2999-01-01T00:00:00Z', model_json: 'stub' });   // bad hash: 404 only if this row was chosen
    expect((await land('/c02')).status).toBe(404);
    await dropRun('run-new');
    expect((await land('/c02')).status).toBe(200);
  });
  it('a newer run with nothing released does not take the page down', async () => {
    await newRun('run-empty');
    expect((await land('/c02')).status).toBe(200);
    await dropRun('run-empty');
  });
});

describe('nicobar host: public demo', () => {
  const PLATFORM = 'https://nicobar.x.test', open = { DEV_MODE: undefined, DEV_ACTOR: undefined, PUBLIC_DEMO: '1' };
  const write = (headers: object = {}) => hit(`${PLATFORM}/api/drafts/${encodeURIComponent('fx-run:c16:v1')}/reject`, { method: 'POST', headers: { Origin: PLATFORM, ...headers } }, open);
  const status = () => e.DB.prepare('SELECT status FROM drafts WHERE id = ?').bind('fx-run:c16:v1').first('status');
  it('reads with no login', async () => expect((await hit(`${PLATFORM}/review`, undefined, open)).status).toBe(200));
  it('a write with no key or a wrong key is 401 and changes nothing', async () => {
    const r = await write();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Basic');
    expect((await write({ Authorization: `Basic ${btoa('x:wrong')}` })).status).toBe(401);
    expect(await status()).toBe('in_review');
  });
  it('the run key as the Basic password gets past the gate', async () => {
    const r = await hit(`${PLATFORM}/api/drafts/no-such/reject`, { method: 'POST', headers: { Origin: PLATFORM, Authorization: `Basic ${btoa(`x:${e.RUN_KEY}`)}` } }, open);
    expect(r.status).not.toBe(401);
  });
});

describe('nicobar host: fails closed', () => {
  const PLATFORM = 'https://nicobar.x.test';
  const prod = { DEV_MODE: undefined, DEV_ACTOR: undefined, DEPLOYED: '1', ACCESS_AUD: 'a', TEAM_DOMAIN: 'https://t.test' };
  it('no token: 403 on the page, the api and the released route, and no public path', async () => {
    for (const p of ['/', '/review', '/c02', '/c02/email', `/released/${encodeURIComponent(ID)}?part=email`, '/robots.txt']) {
      expect((await hit(`${PLATFORM}${p}`, undefined, prod)).status, p).toBe(403);
    }
  });
  it('a bad token: 403', async () => {
    const r = await hit(`${PLATFORM}/review`, { headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' } }, prod);
    expect(r.status).toBe(403);
  });
  it('no AUD or team: 503', async () => {
    expect((await hit(`${PLATFORM}/review`, undefined, { ...prod, ACCESS_AUD: '' })).status).toBe(503);
    expect((await hit(`${PLATFORM}/review`, undefined, { ...prod, TEAM_DOMAIN: '' })).status).toBe(503);
  });
  it('DEV_MODE on a deployed Worker: refused', async () => {
    expect((await hit(`${PLATFORM}/review`, undefined, { ...prod, DEV_MODE: '1', DEV_ACTOR: 'x@y' })).status).toBe(503);
  });
  it('a host that only contains the word landing gets no public route', async () => {
    expect((await hit('https://nicobar-landing.x.test/c02', undefined, prod)).status).toBe(403);
    expect((await hit('https://nicobar.landing.x.test/c02', undefined, prod)).status).toBe(403);
  });
  it('the email on /released also points at the public page, when PUBLIC_ORIGIN is set', async () => {
    const r = await hit(`${PLATFORM}/released/${encodeURIComponent(ID)}?part=email`);
    expect(await r.text()).toContain(`href="${LANDING}/c02"`);
  });
});
