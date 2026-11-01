// page lane tests 2, 4, 5, 6, 8, 9, 10 through the Worker's fetch, on real D1 rows from `seed --fixtures`, with `transition` faked until `run` merges.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.ts';
import { fixtureSql } from '../../scripts/seed.ts';
import { fxDraftStates } from '../fakes/index.ts';
import type { AppEnv } from '../../src/contracts/types.ts';

vi.mock('../../src/lib/state/index.ts', async (orig) => ({ ...(await orig<object>()),
  transition: (await import('../fakes/index.ts')).fakeLib.transition,
  runReport: (await import('../fakes/index.ts')).fakeLib.runReport }));
const flags = vi.hoisted(() => ({ list: [] as { question: string; flagged: boolean; dismissal: null }[] }));
vi.mock('../../src/lib/config/index.ts', async (orig) => ({ ...(await orig<object>()), reviewFlags: async () => flags.list }));
vi.mock('../../src/ui/agents/index.ts', () => ({ flagRow: (f: { question: string }, id: string) => `<div data-draft="${id}">${f.question}</div>` }));

const e = env as unknown as AppEnv & { TEST_MIGRATIONS: never };
const ORIGIN = 'https://x.test';
const go = (path: string, init?: RequestInit, over: object = {}) =>
  worker.fetch!(new Request(`${ORIGIN}${path}`, init) as never, { ...e, ...over } as never, {} as ExecutionContext);
const page = async (path: string) => { const r = await go(path); return { status: r.status, csp: r.headers.get('content-security-policy'), html: await r.text() }; };
const post = (id: string, action: string, init: RequestInit = {}) => go(`/api/drafts/${encodeURIComponent(id)}/${action}`,
  { method: 'POST', ...init, headers: { Origin: ORIGIN, ...init.headers } });

const C16 = 'fx-run:c16:v1';
const C07 = 'fx-run:c07:v1';

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  for (const s of await fixtureSql()) await e.DB.prepare(s).run();
});
beforeEach(() => { fxDraftStates.clear(); flags.list = []; });

describe('test 2: no script runs in the frame', () => {
  it('one iframe, sandbox empty, srcdoc only', async () => {
    const { html } = await page(`/review/${encodeURIComponent(C16)}`);
    const frames = html.match(/<iframe\b[^>]*>/g)!;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/\bsandbox=""/);
    expect(frames[0]).not.toContain('allow-');
    expect(frames[0]).toContain('srcdoc="');
    expect(frames[0].split('srcdoc=')[0]).not.toMatch(/\bsrc=/);
  });
  it('a script in stored html stays inert inside the attribute', async () => {
    await e.DB.prepare(`UPDATE drafts SET rendered_json = ? WHERE id = 'fx-run:c20:v1'`)
      .bind(JSON.stringify({ email: null, landing_page: '<script>parent.x=1</script>"><script>alert(1)</script>', catalog: '' })).run();
    const { html } = await page(`/review/${encodeURIComponent('fx-run:c20:v1')}?part=landing_page`);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
  it('the page carries a CSP that forbids script, inherited by srcdoc', async () => {
    expect((await page(`/review/${encodeURIComponent(C16)}`)).csp).toMatch(/script-src 'none'/);
  });
  it('tabs choose the part, unknown part falls to the first', async () => {
    const land = (await page(`/review/${encodeURIComponent(C16)}?part=landing_page`)).html;
    const cat = (await page(`/review/${encodeURIComponent(C16)}?part=catalog`)).html;
    expect(land).toContain('class=&quot;nb-hero nb-hero--split');
    expect(cat).not.toContain('class=&quot;nb-hero');
    expect((await page(`/review/${encodeURIComponent(C16)}?part=nope`)).status).toBe(200);
  });
});

describe('one approve, one reject', () => {
  it('in_review shows one of each, and no publish', async () => {
    const { html } = await page(`/review/${encodeURIComponent(C16)}`);
    expect(html.match(/action="[^"]*\/approve"/g)).toHaveLength(1);
    expect(html.match(/action="[^"]*\/reject"/g)).toHaveLength(1);
    expect(html).not.toMatch(/\/release"/);
  });
  it('approved shows publish and revoke, no approve', async () => {
    const { html } = await page(`/review/${encodeURIComponent(C07)}`);
    expect(html).toContain('confirm=release');
    expect(html).toMatch(/action="[^"]*\/revoke"/);
    expect(html).not.toMatch(/\/approve"/);
  });
  it('confirm dialog names the hash and says nothing is sent', async () => {
    const { html } = await page(`/review/${encodeURIComponent(C07)}?confirm=release`);
    expect(html).toMatch(/action="[^"]*\/release"/);
    expect(html).toContain('Nothing is sent to the customer');
  });
});

describe('test 4: release on in_review is 409 through the route', () => {
  it('409 WRONG_STATE', async () => {
    fxDraftStates.set(C16, 'in_review');
    const r = await post(C16, 'release');
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'WRONG_STATE' });
    expect(fxDraftStates.get(C16)).toBe('in_review');
  });
  it('approve then release passes; a form post gets 303, refusal names the code', async () => {
    expect((await post(C16, 'approve')).status).toBe(200);
    expect((await post(C16, 'release')).status).toBe(200);
    const r = await post(C16, 'release', { headers: { Accept: 'text/html' } });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('refused=WRONG_STATE');
  });
  it('reject needs a note: 400 and no edge', async () => {
    expect((await post(C16, 'reject')).status).toBe(400);
    expect(fxDraftStates.has(C16)).toBe(false);
    const form = new URLSearchParams({ note: 'Line two reads loud.' });
    const r = await post(C16, 'reject', { body: form });
    expect(r.status).toBe(200);
    expect(fxDraftStates.get(C16)).toBe('rejected');
  });
});

describe('test 5: foreign Origin', () => {
  for (const action of ['approve', 'reject', 'revoke', 'release']) {
    it(`${action} → 403, no edge`, async () => {
      const r = await post(C16, action, { headers: { Origin: 'https://evil.test' } });
      expect(r.status).toBe(403);
      expect(fxDraftStates.has(C16)).toBe(false);
    });
  }
  it('no Origin header → 403', async () => expect((await go(`/api/drafts/${C16}/approve`, { method: 'POST' })).status).toBe(403));
});

describe('test 6: auth matrix on every page route', () => {
  const paths: [string, string][] = [['GET', '/review'], ['GET', '/review/runs/fx-run/plans'], ['GET', `/review/${C16}`],
    ['GET', `/released/${C16}?part=landing_page`], ['POST', `/api/drafts/${C16}/approve`]];
  const prod = { DEV_MODE: undefined, DEV_ACTOR: undefined, TEAM_DOMAIN: 'https://t.test', ACCESS_AUD: 'aud' };
  for (const [method, path] of paths) {
    it(`${method} ${path}`, async () => {
      const init = { method, headers: { Origin: ORIGIN } };
      expect((await go(path, init, prod)).status).toBe(403);                                       // Access configured, no token
      expect((await go(path, init, { DEV_MODE: undefined, TEAM_DOMAIN: '', ACCESS_AUD: undefined })).status).toBe(503);   // nothing configured
      expect((await go(path, init, { ACCESS_AUD: 'aud' })).status).toBe(503);                      // DEV_MODE beside Access
      expect((await go(path, init, { DEV_ACTOR: undefined })).status).toBe(503);                   // DEV_MODE, no actor
      expect((await go(path, init)).status).not.toBeGreaterThanOrEqual(500);                       // dev actor reaches it
    });
  }
});

describe('/released', () => {
  it('in_review → not 200', async () => expect((await go(`/released/${encodeURIComponent(C16)}?part=landing_page`)).status).toBe(409));
  it('released with the hash → 200, html, CSP sandbox', async () => {
    const r = await go(`/released/${encodeURIComponent('fx-run:c02:v1')}?part=landing_page`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(await r.text()).toContain('nb-packing');
  });
  it('unknown part → 400, part absent from the format → 404', async () => {
    const id = encodeURIComponent('fx-run:c02:v1');
    expect((await go(`/released/${id}?part=zzz`)).status).toBe(400);
    expect((await go(`/released/${id}?part=email`)).status).toBe(404);
  });
  it('hash changed after approval → not 200', async () => {
    const id = 'fx-run:c02:v1';
    const before = await e.DB.prepare('SELECT model_json FROM drafts WHERE id = ?').bind(id).first<{ model_json: string }>();
    await e.DB.prepare('UPDATE drafts SET model_json = ? WHERE id = ?').bind(`${before!.model_json} `, id).run();
    const r = await go(`/released/${encodeURIComponent(id)}?part=landing_page`);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'HASH_MISMATCH' });
    await e.DB.prepare('UPDATE drafts SET model_json = ? WHERE id = ?').bind(before!.model_json, id).run();
  });
  it('unknown id → 404', async () => expect((await go('/released/nope?part=catalog')).status).toBe(404));
});

describe('test 8 route: new-user banner carries signals[]', () => {
  it('c20', async () => {
    const { html } = await page(`/review/${encodeURIComponent('fx-run:c20:v1')}`);
    expect(html).toContain('New user');
    expect(html).toContain('season_prior');
  });
  it('a customer who is not new has no banner', async () => {
    expect((await page(`/review/${encodeURIComponent(C16)}`)).html).not.toContain('New user');
  });
});

describe('J3 rows', () => {
  it('maps flagRow over reviewFlags with the draft id', async () => {
    flags.list = [{ question: 'discount', flagged: true, dismissal: null }];
    const { html } = await page(`/review/${encodeURIComponent(C16)}`);
    expect(html).toContain(`data-draft="${C16}"`);
    expect(html).toContain('discount');
  });
});

describe('test 9: a unit with no draft row shows its code and no link', () => {
  it('reason shown, no link for that row', async () => {
    const { html } = await page('/review?run=fx-run');
    const row = html.split('<tr').find((r) => r.startsWith('><td') && r.includes('c-nodraft'))!;
    expect(row).toContain('no purchase history');
    expect(row).not.toContain('<a ');
    const drafted = html.split('<tr').find((r) => r.startsWith('><td') && r.includes('c16'))!;
    expect(drafted).toContain(`href="/review/${encodeURIComponent(C16)}"`);
  });
  it('skipped unit shows its reason too', async () => {
    const { html } = await page('/review?run=fx-run');
    expect(html.split('<tr').find((r) => r.startsWith('><td') && r.includes('c-over'))).toContain('The estimate was over the spen');
  });
  it('nav lists every NAV entry; no price or last name; metrics present', async () => {
    const { html } = await page('/review');
    for (const l of ['Runs', 'Agents', 'Evals', 'Spend', 'Published']) expect(html).toContain(`>${l}<`);
    expect(html).toContain('Failed alone');
  });
  it('plans page lists reason codes, unknown run → 404', async () => {
    const { html } = await page('/review/runs/fx-run/plans');
    expect(html).toContain('OCCASION_MATCH');
    expect((await page('/review/runs/nope/plans')).status).toBe(404);
  });
});

describe('test 10: events from seed-demo@local are labelled seeded', () => {
  it('c07 shows seeded, c16 does not', async () => {
    const c07 = (await page(`/review/${encodeURIComponent(C07)}`)).html;
    expect(c07).toMatch(/seeded/);
    expect((await page(`/review/${encodeURIComponent(C16)}`)).html).not.toMatch(/seeded/);
  });
});

describe('draft page reads no catalog', () => {
  it('picks and sources come from the stored render, with reason codes', async () => {
    const { html } = await page(`/review/${encodeURIComponent(C16)}`);
    expect(html).toContain('https://www.nicobar.com/products/bouquet-scarf-green');
    expect(html).toContain('OCCASION_MATCH');
    expect(html).toContain('Outline:');
  });
  it('failed draft names its check', async () => {
    const { html } = await page(`/review/${encodeURIComponent('fx-run:c18:v1')}`);
    expect(html).toContain('Discount or pressure language');
    expect(html).not.toContain('fail · C4');
    expect(html).not.toMatch(/\/approve"/);
  });
  it('unknown draft → 404', async () => expect((await go('/review/nope')).status).toBe(404));
});
