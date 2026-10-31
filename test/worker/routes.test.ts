import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { authenticate } from '../../src/worker/auth.ts';
import { ROUTES, match } from '../../src/worker/routes/list.ts';
import { NAV } from '../../src/contracts/nav.ts';
import type { AppEnv } from '../../src/contracts/types.ts';

const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://x.test${path}`, init));

describe('test 4: route order', () => {
  for (const path of ['/review/spend', '/review/published', '/review/evals']) {
    it(`${path} reaches demo, not /review/:id`, async () => expect((await get(path)).status).not.toBe(404));
  }
  it('/review/agents reaches the agents list, not /review/:id', async () => {
    const r = await get('/review/agents');
    const b = await r.text();
    expect(b).not.toContain('review/:id');
    expect(r.status).not.toBe(404);
  });
  it('review after demo and agents in the table', () => {
    const at = (p: string) => ROUTES.findIndex((r) => r.path === p);
    expect(at('/review/spend')).toBeLessThan(at('/review/:id'));
    expect(at('/review/agents')).toBeLessThan(at('/review/:id'));
  });
  it('reversed table proves the guard: /review/:id would swallow spend', () => {
    expect(match('GET', '/review/spend', [...ROUTES].reverse())?.route.path).toBe('/review/:id');
  });
  it('dismiss is agents, not a draft action', () => {
    expect(match('POST', '/api/drafts/d/flags/q/dismiss')?.route.path).toBe('/api/drafts/:id/flags/:question/dismiss');
    expect(match('POST', '/api/drafts/d/launch')).toBeNull();
  });
});

describe('a missing catalogue', () => {
  it('approve answers a coded 503, not 500', async () => {
    const db = (env as unknown as AppEnv).DB;
    await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
    const run = `INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting, prompt_version, voice_guide_version,
      shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status, created_by, created_at) VALUES ('nc', 'nc', 'rehearsal', 'both', 'gone', 'd', 'c', 'k', 1, 'r', 's', 'v1', 'v1', 'sh', 'j', 'jev-v1', 1, 1, 'p', 0, 'done', 'o', 't')`;
    await db.batch([db.prepare(`INSERT OR IGNORE INTO snapshots (id, fetched_at, product_rows, usable_rows) VALUES ('gone', 't', 0, 0)`), db.prepare(run),
      db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES ('nc', 'c', '{}', 't')`),
      db.prepare(`INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json, content_sha256, checks_json, hard_failures, status)
        VALUES ('nc:c:v1', 'nc', 'c', 1, 'both', 'gone', 'v', 'm', '{}', '{}', '{}', 'h', '[]', 0, 'in_review')`)]);
    const r = await get('/api/drafts/nc%3Ac%3Av1/approve', { method: 'POST', headers: { Origin: 'https://x.test' } });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'CATALOG_MISSING' });
  });
});

describe('stubs', () => {
  it('/review loads, nav includes every NAV entry', async () => {
    const res = await get('/review');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const n of NAV) expect(html).toContain(n.href);
  });
  it('no route sends or publishes', () => expect(ROUTES.some((r) => /send|publish(?!ed)/.test(r.path))).toBe(false));
  it('.well-known has no bypass', async () => {
    const noauth = { TEAM_DOMAIN: 'https://t.test', ACCESS_AUD: 'a' } as unknown as AppEnv;
    const r = await authenticate(new Request('https://x.test/.well-known/http-message-signatures-directory'), noauth);
    expect(r).toEqual({ http: 403, code: 'FORBIDDEN' });
  });
  it('foreign Origin on a mutating route is 403, same origin passes it', async () => {
    const post = (origin: string) => get('/api/drafts/d/approve', { method: 'POST', headers: { Origin: origin } });
    expect((await post('https://evil.test')).status).toBe(403);
    expect((await post('https://x.test')).status).not.toBe(403);
  });
});

describe('auth matrix', () => {
  const dev = (extra: object) => ({ DEV_MODE: '1', ...extra }) as unknown as AppEnv;
  const prod = { TEAM_DOMAIN: 'https://t.test', ACCESS_AUD: 'aud' } as unknown as AppEnv;
  const req = (token?: string) => new Request('https://x.test/', { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

  it('DEV_MODE with no DEV_ACTOR → 503', async () => expect(await authenticate(req(), dev({}))).toMatchObject({ http: 503 }));
  it('DEV_MODE plus Access config → 503', async () => expect(await authenticate(req(), dev({ DEV_ACTOR: 'a@b', ACCESS_AUD: 'x' }))).toMatchObject({ http: 503 }));
  it('DEV_MODE gives a dev actor with dev: sub', async () => expect(await authenticate(req(), dev({ DEV_ACTOR: 'a@b' })))
    .toEqual({ actor: { kind: 'dev', email: 'a@b', sub: 'dev:a@b' } }));
  it('DEV_MODE on a deployed Worker → 503, even with no Access config', async () => {
    expect(await authenticate(req(), dev({ DEV_ACTOR: 'a@b', DEPLOYED: '1' }))).toMatchObject({ http: 503, code: 'MISSING_CONFIG' });
  });
  it('no Access config → 503', async () => expect(await authenticate(req(), {} as AppEnv)).toMatchObject({ http: 503 }));

  it('JWT: good, wrong audience, wrong issuer, no email', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const sign = (claims: object, aud = 'aud', iss = 'https://t.test') => new SignJWT({ ...claims }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(iss).setAudience(aud).setSubject('u1').setExpirationTime('5m').sign(privateKey);
    const key = () => async () => publicKey;
    expect(await authenticate(req(await sign({ email: 'a@b' })), prod, key)).toEqual({ actor: { kind: 'human', email: 'a@b', sub: 'u1' } });
    expect(await authenticate(req(await sign({ email: 'a@b' }, 'other')), prod, key)).toMatchObject({ http: 403 });
    expect(await authenticate(req(await sign({ email: 'a@b' }, 'aud', 'https://evil.test')), prod, key)).toMatchObject({ http: 403 });
    expect(await authenticate(req(await sign({})), prod, key)).toMatchObject({ http: 403 });
  });
});
