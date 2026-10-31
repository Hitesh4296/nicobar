import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLE } from '../../src/lib/config/bundle.ts';
import type { Actor, AppEnv, JevConfig, PromptFiles } from '../../src/contracts/types.ts';
import { activateVersion, activeVersions, ConfigErr, dismissFlag, evalValidity, loadVersion, reviewFlags, saveVersion } from '../../src/lib/config/index.ts';
import { ROUTES, match } from '../../src/worker/routes/list.ts';

vi.mock('../../src/lib/gen/canonical.ts', async () => ({ canonicalContent: (await import('../fakes/config.ts')).fxCanonical }));
vi.mock('../../src/lib/gen/index.ts', async () => {
  const f = await import('../fakes/config.ts');
  return { assemblePrefix: f.fxPrefix, renderSuffix: f.fxSuffix };
});
vi.mock('../../src/lib/jev/index.ts', async () => {
  const f = await import('../fakes/config.ts');
  return { flaggedQuestions: f.fxFlagged,
    j3Input: () => ({ email: 'e', landing_page: null, quote: null, picks: [], occasion: null, occasion_key: null, new_user: false }),
    judgeDraft: vi.fn(async (_e: unknown, _i: unknown, cfg: JevConfig) => ({ status: 'answered', reason: null, model: cfg.model, answers: {}, input_tokens: 9, charged_usd: 0.0005, basis_usd: cfg.basis_usd })) };
});
vi.mock('../../src/lib/catalog/index.ts', () => ({ loadCatalog: async () => ({}) }));

const db = (env as unknown as { DB: D1Database }).DB;
const dev: Actor = { kind: 'dev', email: 'a@b', sub: 'dev:a@b' };
const prompt = (extra = ''): PromptFiles => ({ role: 'r'.repeat(9000) + extra, voice_card: 'v', email: 'e', landing: 'l',
  task: '{{parts}} {{n}} {{occasion_key}} {{shape}} {{title_words}} {{title_words_email}} {{occasion}} {{picks}} {{quotes}}', retry: '{{parts}} {{checks}}' });
const jev = (edit: (c: JevConfig) => void = () => {}) => { const c = structuredClone(BUNDLE.jevBase); edit(c); return c; };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof ConfigErr) return e.code; throw e; } };

beforeAll(async () => { await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS); });
beforeEach(async () => { for (const t of ['config_versions', 'jev_dismissals', 'runs', 'drafts', 'jev_events', 'ledger_manual', 'plans']) await db.exec(`DELETE FROM ${t}`); });

const seedPrompt = async () => { await saveVersion(db, 'prompt', null, prompt(), 'first', dev); return activateVersion(db, 'v1', dev); };
const seedJev = async () => { await saveVersion(db, 'jev', null, jev(), 'first', dev); return activateVersion(db, 'jev-v1', dev); };
const run = (id: string, stage: string, status: string, p: string, j: string, at = '2026-11-01T00:00:00Z') => db.prepare(
  `INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting,
    prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status,
    stop_reason, created_by, created_at) VALUES (?, ?, ?, 'both', 's', 'd', 'h', 'k', 1, 'h', 's', ?, 'v1', 'h', 'm', ?, 1, 1, 'h', 1, ?, ?, 'e', ?)`)
  .bind(id, id, stage, p, j, status, status === 'stopped' ? 'x' : null, at).run();
const draft = (id: string, status: string) => db.prepare(
  `INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json,
    content_sha256, checks_json, hard_failures, status) VALUES (?, 'r1', 'c1', 1, 'both', 's', 'v', 'm', '{}', '{}', '{}', 'h', '[]', 0, ?)`).bind(id, status).run();
const answers = (json: object) => db.prepare(
  `INSERT INTO jev_events (run_id, customer_id, attempt, model_requested, status, answers_json, basis_usd, at) VALUES ('r1', 'c1', 1, 'm', 'answered', ?, 0.1, 't')`)
  .bind(JSON.stringify(json)).run();

describe('test 1 and 2: loadVersion', () => {
  it('returns the content it stored', async () => {
    await seedPrompt();
    expect((await loadVersion(db, 'v1', BUNDLE)).content).toEqual(prompt());
  });
  it('a changed content_json → TAMPERED', async () => {
    await seedPrompt();
    await db.exec(`UPDATE config_versions SET content_json = replace(content_json, 'rrr', 'xxx') WHERE id = 'v1'`);
    expect(await code(loadVersion(db, 'v1', BUNDLE))).toBe('TAMPERED');
  });
  it('a changed bundled schema → BASE_CHANGED', async () => {
    await seedPrompt();
    expect(await code(loadVersion(db, 'v1', { ...BUNDLE, schemas: [{ changed: true }] }))).toBe('BASE_CHANGED');
  });
  it('a changed locked jev field in the bundle → BASE_CHANGED; an editable one does not', async () => {
    await seedJev();
    expect(await code(loadVersion(db, 'jev-v1', { ...BUNDLE, jevBase: jev((c) => { c.model = 'x'; }) }))).toBe('BASE_CHANGED');
    expect(await code(loadVersion(db, 'jev-v1', { ...BUNDLE, jevBase: jev((c) => { c.flag_gate = 0.4; }) }))).toBe('ok');
  });
  it('unknown id → CONFIG_MISSING, activeVersions too', async () => {
    expect(await code(loadVersion(db, 'v9', BUNDLE))).toBe('CONFIG_MISSING');
    await seedPrompt();
    expect(await code(activeVersions(db))).toBe('CONFIG_MISSING');
  });
});

describe('saveVersion', () => {
  it('allocates ids per kind, normalises CRLF, hashes after', async () => {
    await seedPrompt();
    const v2 = await saveVersion(db, 'prompt', 'v1', { ...prompt('x\r\ny'), voice_card: 'v2' }, 'n', dev);
    expect(v2).toMatchObject({ id: 'v2', status: 'draft', parent_id: 'v1', voice_guide_version: 'v2' });
    expect((v2.content as PromptFiles).role.endsWith('x\ny')).toBe(true);
    await seedJev();
    expect((await saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.flag_gate = 0.4; }), 'n', dev)).id).toBe('jev-v2');
  });
  it('voice_guide_version stays on the version that last changed the card', async () => {
    await seedPrompt();
    expect((await saveVersion(db, 'prompt', 'v1', prompt('y'), 'n', dev)).voice_guide_version).toBe('v1');
  });
  it('same content as the parent → UNCHANGED, jev version field ignored', async () => {
    await seedPrompt();
    expect(await code(saveVersion(db, 'prompt', 'v1', prompt(), 'n', dev))).toBe('UNCHANGED');
    await seedJev();
    expect(await code(saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.version = 'other'; }), 'n', dev))).toBe('UNCHANGED');
  });
  it('jev version becomes the row id', async () => {
    await seedJev();
    const v = await saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.flag_gate = 0.4; }), 'n', dev);
    expect((v.content as JevConfig).version).toBe('jev-v2');
  });
  it('parent not active → STALE_PARENT; a draft may fail validation', async () => {
    await seedPrompt();
    expect(await code(saveVersion(db, 'prompt', null, prompt('z'), 'n', dev))).toBe('STALE_PARENT');
    expect((await saveVersion(db, 'prompt', 'v1', { ...prompt(), role: 'short' }, 'n', dev)).status).toBe('draft');
  });
  it('a blank note or wrong file set → BAD_INPUT', async () => {
    expect(await code(saveVersion(db, 'prompt', null, prompt(), '  ', dev))).toBe('BAD_INPUT');
    expect(await code(saveVersion(db, 'prompt', null, { role: 'x' } as PromptFiles, 'n', dev))).toBe('BAD_INPUT');
  });
});

describe('test 5, 6, 10a: activation', () => {
  it('a second active is refused by one_active', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', prompt('a'), 'n', dev);
    await expect(db.exec(`UPDATE config_versions SET status = 'active', activated_by = 'e', activated_sub = 's', activated_at = 't', validation_json = '{}' WHERE id = 'v2'`)).rejects.toThrow(/UNIQUE/);
  });
  it('swaps in one batch: old retired, new active, validation stored', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', prompt('a'), 'n', dev);
    const v2 = await activateVersion(db, 'v2', dev);
    expect(v2).toMatchObject({ status: 'active', activated_by: 'a@b' });
    const rows = await db.prepare('SELECT id, status, validation_json FROM config_versions ORDER BY id').all<{ id: string; status: string; validation_json: string }>();
    expect(rows.results.map((r) => r.status)).toEqual(['retired', 'active']);
    expect(JSON.parse(rows.results[1].validation_json)).toMatchObject({ ok: true });
  });
  it('a one_active clash rolls the batch back: the old active stands', async () => {
    await seedPrompt(); await saveVersion(db, 'prompt', 'v1', prompt('a'), 'n', dev); await saveVersion(db, 'prompt', 'v1', prompt('b'), 'n', dev);
    await activateVersion(db, 'v2', dev);
    expect(await code(activateVersion(db, 'v3', dev))).toBe('STALE_PARENT');
    expect((await activeVersions(db).catch(() => null))).toBeNull();
    expect((await db.prepare(`SELECT id FROM config_versions WHERE status = 'active'`).first<{ id: string }>())?.id).toBe('v2');
  });
  it('10a: parent no longer active → STALE_PARENT', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', prompt('a'), 'n', dev);
    await saveVersion(db, 'prompt', 'v1', prompt('b'), 'n', dev);
    await activateVersion(db, 'v3', dev);
    expect(await code(activateVersion(db, 'v2', dev))).toBe('STALE_PARENT');
  });
  it('fails validation → VALIDATION_FAILED with the failures, nothing moves', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', { ...prompt(), role: 'short' }, 'n', dev);
    const e = await activateVersion(db, 'v2', dev).catch((x) => x);
    expect(e.code).toBe('VALIDATION_FAILED'); expect(e.detail[0].rule).toBe('prefix_size');
    expect((await loadVersion(db, 'v1', BUNDLE)).status).toBe('active');
  });
  it('an active or retired row → WRONG_STATE', async () => {
    await seedPrompt();
    expect(await code(activateVersion(db, 'v1', dev))).toBe('WRONG_STATE');
  });
  it('tampered row cannot activate', async () => {
    await saveVersion(db, 'prompt', null, prompt(), 'n', dev);
    await db.exec(`UPDATE config_versions SET content_json = replace(content_json, 'rrr', 'xxx')`);
    expect(await code(activateVersion(db, 'v1', dev))).toBe('TAMPERED');
  });
  it('6: system cannot activate or save', async () => {
    await saveVersion(db, 'prompt', null, prompt(), 'n', dev);
    expect(await code(activateVersion(db, 'v1', { kind: 'system' }))).toBe('FORBIDDEN');
    expect(await code(saveVersion(db, 'prompt', null, prompt('q'), 'n', { kind: 'system' }))).toBe('FORBIDDEN');
  });
});

const post = (path: string, body: unknown, extra: Record<string, string> = {}) => exports.default.fetch(new Request(`https://x.test${path}`,
  { method: 'POST', headers: { Origin: 'https://x.test', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }));
const get = (path: string) => exports.default.fetch(new Request(`https://x.test${path}`));
/** Direct call with the link's env; index.ts adds auth and Origin only. */
const onLink = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const hit = match(method, path, ROUTES)!;
  const req = new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return hit.route.handler({ req, env: { ...env, DEPLOYED: '1' } as unknown as AppEnv, exec: {} as ExecutionContext, actor: dev, params: hit.params });
};

describe('routes', () => {
  it('6: a body cannot set the actor', async () => {
    const res = await post('/api/config', { kind: 'prompt', parent_id: null, content: prompt(), note: 'n', actor: { kind: 'system' }, created_by: 'evil' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'v1', created_by: 'test@local' });
  });
  it('codes map to http: 409, 400, 503', async () => {
    expect((await post('/api/config', { kind: 'prompt', parent_id: 'v8', content: prompt(), note: 'n' })).status).toBe(409);
    expect((await post('/api/config', { kind: 'nope', parent_id: null, content: prompt(), note: 'n' })).status).toBe(400);
    expect((await get('/api/config/v9')).status).toBe(503);
  });
  it('a foreign Origin on save is 403', async () => expect((await post('/api/config', {}, { Origin: 'https://evil.test' })).status).toBe(403));
  it('GET /api/config/active gives both', async () => {
    await seedPrompt(); await seedJev();
    expect(await (await get('/api/config/active')).json()).toMatchObject({ prompt: { id: 'v1' }, jev: { id: 'jev-v1' } });
  });

  it('7: DEPLOYED=1, save, activate, judge 503', async () => {
    await seedPrompt();
    for (const [p, b] of [['/api/config', {}], ['/api/config/v1/activate', {}], ['/api/config/v1/judge', { draft_id: 'd' }]] as const)
      expect((await onLink('POST', p, b)).status, p).toBe(503);
  });
  it('7: DEPLOYED=1, GETs work and offer no write control', async () => {
    await seedPrompt(); await seedJev();
    for (const p of ['/review/agents', '/review/agents/v1', '/review/agents/jev-v1', '/api/config/v1'])
      expect((await onLink('GET', p)).status, p).toBe(200);
    const html = await (await onLink('GET', '/review/agents/v1')).text();
    expect(html).not.toContain('data-activate'); expect(html).not.toContain('data-save');
  });
  it('7: DEPLOYED=1, dismiss works', async () => {
    await seedJev(); await run('r1', 'F', 'done', 'v1', 'jev-v1'); await draft('d1', 'in_review'); await answers({ discount: 0.9 });
    expect((await onLink('POST', '/api/drafts/d1/flags/discount/dismiss', { note: 'fine' })).status).toBe(200);
  });

  it('judge: :id\'s config, one ledger row, one log line, no other row', async () => {
    await seedPrompt(); await seedJev(); await run('r1', 'F', 'done', 'v1', 'jev-v1'); await draft('r1:c1:v1', 'in_review');
    await saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.flag_gate = 0.4; }), 'try', dev);
    await db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES ('r1', 'c1', '{}', 't')`).run();
    const { judgeDraft } = await import('../../src/lib/jev/index.ts');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post('/api/config/jev-v2/judge', { draft_id: 'r1:c1:v1' });
    expect(res.status).toBe(200);
    expect(vi.mocked(judgeDraft).mock.lastCall?.[2].flag_gate).toBe(0.4);
    const ledger = await db.prepare('SELECT usd, actor_email FROM ledger_manual').all();
    expect(ledger.results).toEqual([{ usd: 0.0005, actor_email: 'test@local' }]);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('"step":"judge"')).length).toBe(1);
    expect(String(log.mock.lastCall?.[0])).not.toContain('"email"');
    log.mockRestore();
    expect((await db.prepare('SELECT count(*) n FROM jev_events').first<{ n: number }>())?.n).toBe(0);
    expect((await post('/api/config/v1/judge', { draft_id: 'x' })).status).toBe(400);
  });

  it('9: a version screen escapes content', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', prompt('</textarea><script>alert(1)</script>'), 'n<b>', dev);
    const html = await (await get('/review/agents/v2')).text();
    expect(html).not.toContain('<script>alert'); expect(html).not.toContain('n<b>');
  });
  it('10c: a missing parent shows no diff, not an error', async () => {
    await saveVersion(db, 'prompt', null, prompt(), 'n', dev);
    await db.exec(`UPDATE config_versions SET parent_id = 'gone'`);
    const res = await get('/review/agents/v1');
    expect(res.status).toBe(200); expect(await res.text()).toContain('no base here');
    const res2 = await get('/review/agents/v1?against=nope');
    expect(await res2.text()).toContain('no base here');
  });
  it('shows a diff against ?against and the parent by default', async () => {
    await seedPrompt();
    await saveVersion(db, 'prompt', 'v1', { ...prompt(), retry: '{{parts}} {{checks}} more' }, 'n', dev);
    const html = await (await get('/review/agents/v2?file=retry')).text();
    expect(html).toContain('class="add"');
  });
  it('agents screen shows validity and the void note, and survives an empty table', async () => {
    expect((await get('/review/agents')).status).toBe(200);
    await seedPrompt(); await seedJev();
    const html = await (await get('/review/agents')).text();
    expect(html).toContain('Who does what');   // reached agents, not /review/:id
    expect(html).toContain('no_run_yet'); expect(html).toContain('stage 0');
  });
  it('the dismiss form posts back to the draft', async () => {
    await seedJev(); await run('r1', 'F', 'done', 'v1', 'jev-v1'); await draft('r1:c1:v1', 'in_review'); await answers({ discount: 0.9 });
    const res = await exports.default.fetch(new Request('https://x.test/api/drafts/r1%3Ac1%3Av1/flags/discount/dismiss', { method: 'POST', redirect: 'manual',
      headers: { Origin: 'https://x.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'note=seems+fine' }));
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/review/r1%3Ac1%3Av1');
  });
});

describe('test 8, 10b: flags', () => {
  const app = env as unknown as AppEnv;
  beforeEach(async () => { await seedJev(); await run('r1', 'F', 'done', 'v1', 'jev-v1'); await answers({ discount: 0.45, quiet: 0.9 }); });
  it('8: unflagged question → NOT_FLAGGED', async () => {
    await draft('d1', 'in_review');
    expect(await code(dismissFlag(app, 'd1', 'pressure', 'n', dev))).toBe('NOT_FLAGGED');
    expect(await code(dismissFlag(app, 'd1', 'no_such', 'n', dev))).toBe('NOT_FLAGGED');
  });
  for (const s of ['approved', 'rejected', 'draft']) it(`8: on ${s} → WRONG_STATE`, async () => {
    await db.prepare(`INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json,
      content_sha256, checks_json, hard_failures, status, approved_by, approved_sub, approved_at, approved_sha256) VALUES ('d1', 'r1', 'c1', 1, 'both', 's', 'v', 'm', '{}', '{}', '{}', 'h', '[]', 0, ?1, ?2, ?2, ?2, ?2)`)
      .bind(s, s === 'approved' ? 'x' : null).run();
    expect(await code(dismissFlag(app, 'd1', 'quiet', 'n', dev))).toBe('WRONG_STATE');
  });
  it('8: a dismissal leaves the drafts row byte-identical and shows who and why', async () => {
    await draft('d1', 'in_review');
    const before = await db.prepare(`SELECT * FROM drafts WHERE id = 'd1'`).first();
    await dismissFlag(app, 'd1', 'quiet', 'reads fine', dev);
    expect(await db.prepare(`SELECT * FROM drafts WHERE id = 'd1'`).first()).toEqual(before);
    expect((await reviewFlags(app, 'd1')).find((f) => f.question === 'quiet')).toMatchObject({ flagged: true, dismissal: { actor_email: 'a@b', note: 'reads fine' } });
  });
  it('8: a blank note, a second dismissal, a system actor are refused', async () => {
    await draft('d1', 'in_review');
    expect(await code(dismissFlag(app, 'd1', 'quiet', '  ', dev))).toBe('BAD_INPUT');
    await dismissFlag(app, 'd1', 'quiet', 'n', dev);
    expect(await code(dismissFlag(app, 'd1', 'quiet', 'again', dev))).toBe('WRONG_STATE');
    expect(await code(dismissFlag(app, 'd1', 'quiet', 'n', { kind: 'system' }))).toBe('FORBIDDEN');
  });
  it('10b: a past run reads its pinned gate after a gate edit', async () => {
    await draft('d1', 'in_review');
    const flagged = async () => (await reviewFlags(app, 'd1')).filter((f) => f.flagged).map((f) => f.question);
    expect(await flagged()).toEqual(['quiet']);
    await saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.flag_gate = 0.4; }), 'lower', dev);
    await activateVersion(db, 'jev-v2', dev);
    expect(await flagged()).toEqual(['quiet']);
  });
  it('no jev row → no flags', async () => {
    await db.exec('DELETE FROM jev_events'); await draft('d1', 'in_review');
    expect(await reviewFlags(app, 'd1')).toEqual([]);
  });
});

describe('test 11: evalValidity', () => {
  const byGoal = async () => Object.fromEntries((await evalValidity(db)).map((v) => [v.goal, v]));
  beforeEach(async () => { await seedPrompt(); await seedJev(); });
  it('one entry per goal, 10 to 20, each with its stages', async () => {
    const g = await byGoal();
    expect(Object.keys(g).map(Number)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(g[19].stages).toEqual(['F', 'Haiku']); expect(g[10].stages).toEqual(['F']);
    expect(g[15].kind).toBe('jev');
  });
  it('no_run_yet until a done F pins the active ids', async () => {
    expect((await byGoal())[10].state).toBe('no_run_yet');
    await run('f1', 'F', 'done', 'v1', 'jev-v1');
    const g = await byGoal();
    expect(g[10]).toMatchObject({ state: 'current', run_ids: ['f1'] }); expect(g[15].state).toBe('current');
  });
  it('no_run_yet after activation', async () => {
    await run('f1', 'F', 'done', 'v1', 'jev-v1');
    await saveVersion(db, 'prompt', 'v1', prompt('n'), 'n', dev); await activateVersion(db, 'v2', dev);
    const g = await byGoal();
    expect(g[10]).toMatchObject({ state: 'no_run_yet', active_id: 'v2' });
    expect(g[14].state).toBe('no_run_yet');
    expect(g[15].state).toBe('current');
  });
  it('a jev change voids 14 and 15, not 10', async () => {
    await run('f1', 'F', 'done', 'v1', 'jev-v1');
    await saveVersion(db, 'jev', 'jev-v1', jev((c) => { c.flag_gate = 0.4; }), 'n', dev); await activateVersion(db, 'jev-v2', dev);
    const g = await byGoal();
    expect(g[14]).toMatchObject({ state: 'no_run_yet', kind: 'jev', active_id: 'jev-v2' });
    expect(g[15].state).toBe('no_run_yet'); expect(g[10].state).toBe('current');
  });
  it('a voice run never counts; an unfinished F does not count', async () => {
    await run('v', 'voice', 'done', 'v1', 'jev-v1'); await run('f', 'F', 'generating', 'v1', 'jev-v1');
    expect((await byGoal())[10].state).toBe('no_run_yet');
  });
  it('the latest done F decides, not any', async () => {
    await run('f1', 'F', 'done', 'v1', 'jev-v1', '2026-11-01T01:00:00Z');
    await run('f0', 'F', 'done', 'vX', 'jev-v1', '2026-11-01T02:00:00Z');
    expect((await byGoal())[10].state).toBe('no_run_yet');
  });
  it('row 19 needs F and Haiku, both on the active prompt', async () => {
    await run('f1', 'F', 'done', 'v1', 'jev-v1');
    expect((await byGoal())[19].state).toBe('no_run_yet');
    await run('h1', 'Haiku', 'done', 'vX', 'jev-v1');
    expect((await byGoal())[19].state).toBe('no_run_yet');
    await run('h2', 'Haiku', 'done', 'v1', 'jev-v1', '2026-11-02T00:00:00Z');
    expect((await byGoal())[19]).toMatchObject({ state: 'current', run_ids: ['f1', 'h2'] });
  });
});
