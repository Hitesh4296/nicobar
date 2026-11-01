// The Start a run page: preview first, then the key. The key never comes back.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRunKeyAttempts } from '../../src/worker/run-key.ts';
import { routes } from '../../src/worker/routes/start.ts';
import { routes as reviewRoutes } from '../../src/worker/routes/review.ts';
import { fakeLib } from '../fakes/index.ts';
import { ACTOR, db, env, fakeLlm, migrate, seedRun, uid, useFakes } from './run-fx.ts';

const ONE = fakeLib.ingestTsv('')[0].key;
const KEY = 'test-run-key-9f3a', go = (method: string, url: string, e: object, form?: Record<string, string>) => {
  const body = form ? new URLSearchParams(form) : undefined;
  return routes.find((r) => r.method === method)!.handler({ req: new Request(`https://x.test${url}`, { method, body }), env: { RUN_KEY: KEY, ...env, ...e } as never, exec: {} as ExecutionContext, actor: ACTOR, params: {} });
};
beforeAll(migrate);
beforeEach(async () => {
  useFakes(); fakeLlm(); resetRunKeyAttempts(); await seedRun(uid('seed'));
  await env.BUCKET.put('inputs/customers.synthetic.tsv', `customer_id\tfirst_name\n${ONE}\ta\n`);
  await env.BUCKET.put('inputs/recommendations.synthetic.json', JSON.stringify({ snapshot_id: 'fx', rows: [] }));
});

describe('Start a run', () => {
  it('is locked with no RUN_KEY, on the page and on the form post', async () => {
    const r = await go('GET', '/review/start', { RUN_KEY: undefined });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('Runs are locked');
    expect((await go('POST', '/review/start', { RUN_KEY: undefined }, { run_key: '' })).status).toBe(403);
  });
  it('is 503 on the link', async () => expect((await go('GET', '/review/start', { DEPLOYED: '1' })).status).toBe(503));
  it('offers All or one customer, and a stage, and asks for no key yet', async () => {
    const h = await (await go('GET', '/review/start', {})).text();
    expect(h).toContain('<option value="">All</option>');
    expect(h).toContain(`<option>${ONE}</option>`);
    expect(h).not.toContain('type="password"');
  });
  it('the preview shows customers, cost and cap, with a password field; the page never holds the key', async () => {
    const h = await (await go('GET', `/review/start?only=${ONE}&stage=voice`, {})).text();
    expect(h).toMatch(/Customers.*Estimated cost.*Cap/s);
    expect(h).toContain('type="password"');
    expect(h).not.toContain(KEY);
  });
  it('a wrong key on the form: 403, no row, no call, nothing echoed or logged', async () => {
    const log = vi.spyOn(console, 'log'), err = vi.spyOn(console, 'error'), calls = fakeLlm();
    const before = (await db.prepare('SELECT count(*) AS n FROM runs').first<{ n: number }>())!.n;
    const r = await go('POST', '/review/start', {}, { run_key: 'guess-secret', stage: 'voice', preview_sha256: 'x' });
    expect(r.status).toBe(403);
    const h = await r.text();
    expect(h).not.toContain('guess-secret');
    expect(h).not.toContain(KEY);
    expect((await db.prepare('SELECT count(*) AS n FROM runs').first<{ n: number }>())!.n).toBe(before);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toMatch(/guess-secret|test-run-key/);
  });
  it('the right key passes the gate and no run row holds it', async () => {
    const r = await go('POST', '/review/start', {}, { run_key: KEY, stage: 'voice', preview_sha256: 'none' });
    expect(r.status).not.toBe(403);     // a stale preview stops it later: the key is through
    const rows = await db.prepare('SELECT * FROM runs').all();
    expect(JSON.stringify(rows.results)).not.toContain(KEY);
  });
});

describe('the /review button', () => {
  const list = (e: object) => reviewRoutes.find((r) => r.path === '/review')!.handler({ req: new Request('https://x.test/review'), env: { ...env, ...e } as never, exec: {} as ExecutionContext, actor: ACTOR, params: {} });
  it('shows Start a run with a key, says locked without', async () => {
    expect(await (await list({ RUN_KEY: KEY })).text()).toContain('href="/review/start"');
    const h = await (await list({ RUN_KEY: undefined })).text();
    expect(h).toContain('Runs are locked');
    expect(h).not.toContain('href="/review/start"');
  });
});
