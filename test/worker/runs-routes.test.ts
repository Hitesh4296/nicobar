import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import capJson from '../../config/cap.json' with { type: 'json' };
import { sha256Hex } from '../../src/lib/config/bundle.ts';
import { onlyCustomer } from '../../src/lib/ingest.ts';
import { resetRunKeyAttempts } from '../../src/worker/run-key.ts';
import { routes } from '../../src/worker/routes/runs.ts';
import { ACTOR, SNAP, db, env, fakeLlm, migrate, runRow, seedRun, uid, useFakes } from './run-fx.ts';

const TSV = 'fake tsv';
const RECS = '{ "rows": [] }\n';          // raw bytes: whitespace counts in the hash
beforeAll(migrate);
beforeEach(() => { useFakes(); fakeLlm(); resetRunKeyAttempts(); });

const KEY = 'test-run-key-9f3a';
const post = (path: string, body: unknown, params: Record<string, string> = {}, e: typeof env = env, key: string | null = KEY) => routes.find((r) => r.path === path)!.handler({
  req: new Request('https://x.test/', { method: 'POST', headers: key === null ? {} : { 'x-run-key': key }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env: { RUN_KEY: KEY, ...e }, exec: {} as ExecutionContext, actor: ACTOR, params });

async function preview(over: object = {}) {
  await seedRun(uid('seed'));          // the snapshot row
  const p = { customers_sha256: await sha256Hex(TSV), recs_sha256: await sha256Hex(RECS), snapshot_id: SNAP, prompt_version: 'v1', prompt_sha256: 'fx',
    format: 'both', start_rung: 'sonnet-between_tools', cap_sha256: await sha256Hex(JSON.stringify(capJson)), jev_reserve_usd: 0.1, sum_commit_usd: 1, plans: [], ...over };
  const text = JSON.stringify(p); const sha = await sha256Hex(text);
  await env.BUCKET.put(`previews/${sha}.json`, text);
  return sha;
}
const body = async (over: object = {}, pv: object = {}) => ({ run_id: uid('p'), stage: 'isolation', snapshot_id: SNAP, customers_name: 'customers.fx.synthetic.tsv', customers_tsv: TSV,
  customers_synthetic: true, recs_json: RECS, preview_sha256: await preview(pv), ...over });

describe('the run key', () => {
  const rows = async () => (await db.prepare('SELECT count(*) AS n FROM runs').first<{ n: number }>())!.n;
  beforeEach(resetRunKeyAttempts);
  it('wrong or missing key: 403, no run row, no model call, and the key is not echoed', async () => {
    const calls = fakeLlm(); const b = await body(); const before = await rows();
    for (const k of ['nope', null]) {
      const r = await post('/api/runs', b, {}, env, k);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain('nope');
    }
    expect(await rows()).toBe(before);
    expect(calls).toHaveLength(0);
  });
  it('no RUN_KEY set: locked, even for an empty key', async () => {
    const b = await body();
    expect((await post('/api/runs', b, {}, { ...env, RUN_KEY: undefined } as never, '')).status).toBe(403);
  });
  it('the right key starts; a sixth wrong try is 429 even with the right key', async () => {
    expect((await post('/api/runs', await body())).status).toBe(201);
    for (let i = 0; i < 5; i++) expect((await post('/api/runs', {}, {}, env, 'x')).status).toBe(403);
    expect((await post('/api/runs', await body())).status).toBe(429);
  });
  it('only cuts the file and must match the preview built on that cut', async () => {
    const tsv = 'id\tname\nc01\ta\nc02\tb\n', cut = onlyCustomer(tsv, 'c01');
    expect(cut).toBe('id\tname\nc01\ta\n');
    const sha = await sha256Hex(cut);
    const id = uid('only');
    const ok = await post('/api/runs', await body({ run_id: id, customers_tsv: tsv, only: 'c01' }, { customers_sha256: sha }));
    expect(ok.status).toBe(201);
    const run = await db.prepare('SELECT customers_sha256 FROM runs WHERE id = ?').bind(id).first<{ customers_sha256: string }>();
    expect(run!.customers_sha256).toBe(sha);
    expect((await post('/api/runs', await body({ customers_tsv: tsv, only: 'c01' }))).status).toBe(409);   // the preview was of the whole file
    expect((await post('/api/runs', await body({ customers_tsv: tsv, only: 'zz' }))).status).toBe(400);
  });
});

describe('POST /api/runs', () => {
  it('pins activeVersions ids once, sets cap from the preview, starts an instance', async () => {
    const b = await body();
    const res = await post('/api/runs', b);
    expect(res.status).toBe(201);
    const row = await runRow(b.run_id);
    expect(row).toMatchObject({ prompt_version: 'v1', status: 'preparing', preview_sha256: b.preview_sha256, expected_usd: 0 });
    expect(row?.ceiling_usd).toBeCloseTo(1.1, 9);
    expect(row?.cap_run_usd).toBeCloseTo(1.155, 9);
    expect(await env.BUCKET.head(`customers/${await sha256Hex(TSV)}.tsv`)).not.toBeNull();
    expect(await env.BUCKET.head(`recs/${await sha256Hex(RECS)}.json`)).not.toBeNull();
    expect((await (await env.RUN_WORKFLOW!.get(b.run_id)).status()).status).toBeDefined();
  });
  it('a run on a stub base URL must say so in its id, so the page can label it', async () => {
    const stubbed = { ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' };
    expect((await post('/api/runs', await body(), {}, stubbed)).status).toBe(400);
    expect((await post('/api/runs', await body({ run_id: uid('stub-p') }), {}, stubbed)).status).toBe(201);
  });
  it('test 6: cap_run_usd in the body → 400, no row', async () => {
    const b = await body({ cap_run_usd: 99 });
    expect((await post('/api/runs', b)).status).toBe(400);
    expect(await runRow(b.run_id)).toBeNull();
  });
  it('test 7: the same run id is refused', async () => {
    const b = await body();
    expect((await post('/api/runs', b)).status).toBe(201);
    const res = await post('/api/runs', b);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'RUN_ID_REUSED' });
  });
  for (const [name, pv] of [['customers', { customers_sha256: 'x' }], ['recs', { recs_sha256: 'x' }], ['prompt_version', { prompt_version: 'v0' }], ['prompt_sha256', { prompt_sha256: 'edited' }], ['cap', { cap_sha256: 'x' }], ['rung', { start_rung: 'nope' }]] as const) {
    it(`a preview with another ${name} → 409 PREVIEW_STALE`, async () => {
      const res = await post('/api/runs', await body({}, pv));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PREVIEW_STALE' });
    });
  }
  it('editing cap.json after the preview → 409 PREVIEW_STALE, the label unchanged', async () => {
    const b = await body();
    const S = capJson.S.both;
    capJson.S.both = S + 1;
    try {
      const res = await post('/api/runs', b);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PREVIEW_STALE', detail: 'cap' });
    } finally { capJson.S.both = S; }
  });
  it('a missing preview → 409 PREVIEW_STALE', async () => {
    expect((await post('/api/runs', await body({ preview_sha256: 'nope' }))).status).toBe(409);
  });
  it('a file that does not parse → 400, no row', async () => {
    useFakes({ ingestTsv: () => { throw new Error('bad header'); } });
    const b = await body();
    expect((await post('/api/runs', b)).status).toBe(400);
    expect(await runRow(b.run_id)).toBeNull();
  });
  it('.synthetic. in the name must agree with the flag', async () => {
    expect((await post('/api/runs', await body({ customers_synthetic: false }))).status).toBe(400);
    expect((await post('/api/runs', await body({ customers_name: 'customers.tsv' }))).status).toBe(400);
  });
  it('a synthetic snapshot is refused', async () => {
    const id = uid('syn');
    await db.prepare(`INSERT INTO snapshots (id, fetched_at, product_rows, usable_rows, synthetic) VALUES (?, 't', 1, 1, 1)`).bind(id).run();
    expect((await post('/api/runs', await body({ snapshot_id: id }, { snapshot_id: id }))).status).toBe(400);
  });
  it('bad JSON and an unknown stage → 400', async () => {
    expect((await post('/api/runs', '{')).status).toBe(400);
    expect((await post('/api/runs', await body({ stage: 'B' }))).status).toBe(400);
  });
  it('no active config → 503 CONFIG_MISSING', async () => {
    useFakes({ activeVersions: async () => { throw Object.assign(new Error('CONFIG_MISSING'), { code: 'CONFIG_MISSING' }); } });
    const res = await post('/api/runs', await body());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'CONFIG_MISSING' });
  });
});

describe('POST /api/ledger', () => {
  it('writes a row with the actor from auth, refuses a bad amount', async () => {
    const item = uid('item');
    expect((await post('/api/ledger', { item, usd: 0.5, note: 'n', actor_email: 'evil@x' })).status).toBe(201);
    expect(await db.prepare('SELECT usd, actor_email FROM ledger_manual WHERE item = ?').bind(item).first()).toEqual({ usd: 0.5, actor_email: ACTOR.email });
    expect((await post('/api/ledger', { item, usd: 'x', note: 'n' })).status).toBe(400);
  });
});

describe('test 9: DEPLOYED=1 → 503 on every run route', () => {
  for (const path of ['/api/runs', '/api/runs/:id/restart', '/api/runs/:id/mark-stopped', '/api/ledger']) {
    it(path, async () => {
      const res = await post(path, {}, { id: 'x' }, { ...env, DEPLOYED: '1' });
      expect(res.status).toBe(503);
    });
  }
});
