import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentSha256 } from '../../src/contracts/lib.ts';
import { freshness, insertDraft, moveUnit, runBatch, runReport, seam, transition } from '../../src/lib/state/index.ts';
import type { Actor, DraftRow, DraftStatus, Edge, Product, RenderedJson, UnitStatus } from '../../src/contracts/types.ts';
import { fxCatalog, fxEnvelope, fxModelJson, fxPlan } from '../fakes/index.ts';
import { ACTOR, SNAP, db, env, migrate, seedRun, uid, unit, useFakes } from './run-fx.ts';

const SYSTEM: Actor = { kind: 'system' };
const STATUSES: UnitStatus[] = ['pending', 'prepared', 'admitted', 'drafted', 'failed', 'skipped'];
const LEGAL = new Set(['pending>prepared', 'pending>failed', 'prepared>admitted', 'prepared>skipped', 'prepared>failed', 'admitted>admitted', 'admitted>drafted', 'admitted>failed']);

beforeAll(migrate);
beforeEach(() => { useFakes(); });

describe('test 2, line 4: unit machine refuses every illegal move', () => {
  for (const from of STATUSES) for (const to of STATUSES) {
    if (LEGAL.has(`${from}>${to}`)) continue;
    it(`${from} → ${to} throws`, () => expect(() => moveUnit(db, 'r', 'k', from, to, { code: 'INTERNAL_ERROR' })).toThrow(/illegal/));
  }
  it('a legal move from the wrong state changes nothing, and runBatch throws', async () => {
    const r = uid();
    await db.prepare(`INSERT INTO units (run_id, customer_id, status) VALUES (?, 'k', 'prepared')`).bind(r).run();
    await expect(runBatch(db, [moveUnit(db, r, 'k', 'pending', 'failed', { code: 'INVALID_PICK' })])).rejects.toThrow(/INTERNAL_ERROR/);
    expect((await unit(r, 'k'))?.status).toBe('prepared');
  });
  it('moves, with code and detail', async () => {
    const r = uid();
    await db.prepare(`INSERT INTO units (run_id, customer_id, status) VALUES (?, 'k', 'pending')`).bind(r).run();
    await runBatch(db, [moveUnit(db, r, 'k', 'pending', 'failed', { code: 'INVALID_PICK', detail: 'd' })]);
    expect(await unit(r, 'k')).toMatchObject({ status: 'failed', code: 'INVALID_PICK', error_detail: 'd' });
  });
  it('a nonce that does not match moves nothing', async () => {
    const r = uid();
    await db.prepare(`INSERT INTO units (run_id, customer_id, status) VALUES (?, 'k', 'admitted')`).bind(r).run();
    await db.batch([moveUnit(db, r, 'k', 'admitted', 'drafted', { nonce: { draft_id: 'none', n: 'n' } }).stmt]);
    expect((await unit(r, 'k'))?.status).toBe('admitted');
  });
});

async function seedDraft(status: DraftStatus = 'draft', hard = 0, key = 'fx-both') {
  const run = uid('d');
  await seedRun(run, { status: 'generating' });
  const plan = { ...fxPlan(key), run_id: run };
  await db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES (?, ?, ?, 't')`).bind(run, key, JSON.stringify(plan)).run();
  await db.prepare(`INSERT INTO units (run_id, customer_id, status, billed_attempts) VALUES (?, ?, 'admitted', 1)`).bind(run, key).run();
  const envelope_json = JSON.stringify(fxEnvelope(key)); const model_json = JSON.stringify(fxModelJson(key));
  const rendered: RenderedJson = { email: '<img data-slot="p1" src="x">', landing_page: null, catalog: '' };
  const rendered_json = JSON.stringify(rendered);
  const row: DraftRow = { id: `${run}:${key}:v1`, run_id: run, customer_id: key, version: 1, format: 'both', snapshot_id: SNAP, validator_version: 'fx', model: 'm',
    envelope_json, model_json, rendered_json, content_sha256: await contentSha256(envelope_json, model_json, rendered_json), checks_json: '[]', hard_failures: hard };
  await runBatch(db, [insertDraft(db, row)]);
  if (status !== 'draft') {
    await db.prepare(`UPDATE drafts SET status = ? WHERE id = ?`).bind(status, row.id).run().catch(async () => {
      await db.prepare(`UPDATE drafts SET status = ?, approved_by='a', approved_sub='s', approved_at='t', approved_sha256=content_sha256${status === 'released' ? `, released_by='a', released_at='t'` : ''} WHERE id = ?`).bind(status, row.id).run(); });
  }
  return { id: row.id, run, key };
}
const status = async (id: string) => (await db.prepare('SELECT status FROM drafts WHERE id = ?').bind(id).first<{ status: string }>())?.status;
const events = async (id: string) => (await db.prepare('SELECT * FROM draft_events WHERE draft_id = ? ORDER BY id').bind(id).all<{ to_status: string; actor_kind: string; content_sha256: string; evidence_json: string | null }>()).results;

describe('test 2, line 4: draft machine', () => {
  const ALL: DraftStatus[] = ['draft', 'in_review', 'approved', 'rejected', 'released', 'failed'];
  const EDGES: Record<Edge, DraftStatus> = { E2: 'draft', E3: 'draft', E4: 'in_review', E5: 'in_review', E6: 'approved', E7: 'approved' };
  for (const [edge, legal] of Object.entries(EDGES) as [Edge, DraftStatus][]) for (const from of ALL) {
    if (from === legal) continue;
    it(`${edge} from ${from} → 409 WRONG_STATE, no event`, async () => {
      const d = await seedDraft(from, from === 'failed' ? 1 : 0);
      const actor = edge === 'E2' || edge === 'E3' ? SYSTEM : ACTOR;
      expect(await transition(env, d.id, edge, actor, { note: 'n' })).toMatchObject({ ok: false, http: 409, code: 'WRONG_STATE' });
      expect(await status(d.id)).toBe(from);
      expect(await events(d.id)).toEqual([]);
    });
  }
  it('E2 moves the unit to drafted, one event', async () => {
    const d = await seedDraft();
    expect(await transition(env, d.id, 'E2', SYSTEM)).toEqual({ ok: true, status: 'in_review' });
    expect((await unit(d.run, d.key))?.status).toBe('drafted');
    expect((await events(d.id)).map((e) => e.actor_kind)).toEqual(['system']);
  });
  it('E2 refuses a stored hard failure; E3 takes it', async () => {
    const d = await seedDraft('draft', 1);
    expect(await transition(env, d.id, 'E2', SYSTEM)).toMatchObject({ ok: false, code: 'CHECKS_FAILED' });
    expect(await transition(env, d.id, 'E3', SYSTEM)).toEqual({ ok: true, status: 'failed' });
  });
  it('E3 on a clean draft is WRONG_STATE', async () => {
    const d = await seedDraft();
    expect(await transition(env, d.id, 'E3', SYSTEM)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
  });
  it('E4 re-validates the stored model output: a failing check → CHECKS_FAILED, stays in_review', async () => {
    const d = await seedDraft('in_review');
    useFakes({ validate: () => [{ id: 'C3', part: 'email', severity: 'hard', pass: false }] });
    expect(await transition(env, d.id, 'E4', ACTOR)).toMatchObject({ ok: false, code: 'CHECKS_FAILED' });
    expect(await status(d.id)).toBe('in_review');
  });
  it('E4 and E7 run the rendered checks too', async () => {
    const d = await seedDraft('in_review');
    seam.rendered = () => [{ id: 'X3', part: 'email', severity: 'hard', pass: false }];
    expect(await transition(env, d.id, 'E4', ACTOR)).toMatchObject({ ok: false, code: 'CHECKS_FAILED' });
    seam.rendered = undefined;
    await transition(env, d.id, 'E4', ACTOR);
    seam.rendered = () => [{ id: 'X1', part: 'catalog', severity: 'hard', pass: false }];
    expect(await transition(env, d.id, 'E7', ACTOR)).toMatchObject({ ok: false, code: 'CHECKS_FAILED' });
  });
  it('E4 refuses bytes that changed: HASH_MISMATCH', async () => {
    const d = await seedDraft('in_review');
    await db.prepare(`UPDATE drafts SET rendered_json = '{"tampered":1}' WHERE id = ?`).bind(d.id).run();
    expect(await transition(env, d.id, 'E4', ACTOR)).toMatchObject({ ok: false, http: 409, code: 'HASH_MISMATCH' });
  });
  it('system cannot approve or release; a person cannot run E2', async () => {
    const d = await seedDraft('in_review');
    expect(await transition(env, d.id, 'E4', SYSTEM)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
    const e = await seedDraft();
    expect(await transition(env, e.id, 'E2', ACTOR)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
  });
  it('E5 needs a note: 400, stays in_review', async () => {
    const d = await seedDraft('in_review');
    expect(await transition(env, d.id, 'E5', ACTOR, { note: '  ' })).toMatchObject({ ok: false, http: 400 });
    expect(await transition(env, d.id, 'E5', ACTOR, { note: 'off voice' })).toEqual({ ok: true, status: 'rejected' });
  });
  it('approve, revoke, approve, release; a double release gives one event', async () => {
    useFakes({ imagePaths: () => ({}) });
    const d = await seedDraft('in_review');
    expect(await transition(env, d.id, 'E4', ACTOR)).toEqual({ ok: true, status: 'approved' });
    expect(await transition(env, d.id, 'E6', ACTOR)).toEqual({ ok: true, status: 'in_review' });
    expect((await db.prepare('SELECT approved_by FROM drafts WHERE id = ?').bind(d.id).first<{ approved_by: string | null }>())?.approved_by).toBeNull();
    await transition(env, d.id, 'E4', ACTOR);
    expect(await transition(env, d.id, 'E7', ACTOR)).toEqual({ ok: true, status: 'released' });
    expect(await transition(env, d.id, 'E7', ACTOR)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
    const ev = await events(d.id);
    expect(ev.map((e) => e.to_status)).toEqual(['approved', 'in_review', 'approved', 'released']);
    expect(JSON.parse(ev[3].evidence_json ?? '{}')).toMatchObject({ snapshot_id: SNAP });
  });
  it('two approvals at once: one wins, one event', async () => {
    const d = await seedDraft('in_review');
    const [a, b] = await Promise.all([transition(env, d.id, 'E4', ACTOR), transition(env, d.id, 'E4', ACTOR)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await events(d.id)).toHaveLength(1);
  });
  it('E7 stale: a gone pick → 409 STALE_PICK, stays approved', async () => {
    const d = await seedDraft('in_review');
    await transition(env, d.id, 'E4', ACTOR);
    useFakes({ loadCatalog: async () => { const c = fxCatalog(); c.rows.clear(); return c; } });
    expect(await transition(env, d.id, 'E7', ACTOR)).toMatchObject({ ok: false, http: 409, code: 'STALE_PICK', detail: { reason: 'gone' } });
    expect(await status(d.id)).toBe('approved');
  });
  it('a missing draft is WRONG_STATE, not a throw', async () => {
    expect(await transition(env, 'nope', 'E4', ACTOR)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
  });
  it('test 13: E7 reads image paths through imagePaths', async () => {
    const d = await seedDraft('in_review');
    await transition(env, d.id, 'E4', ACTOR);
    let seen: RenderedJson | null = null;
    useFakes({ imagePaths: (r) => { seen = r; return { p1: '/not/in/images.jpg' }; } });
    expect(await transition(env, d.id, 'E7', ACTOR)).toMatchObject({ ok: false, code: 'STALE_PICK', detail: { reason: 'image_gone' } });
    expect(seen).toMatchObject({ email: '<img data-slot="p1" src="x">' });
  });
});

describe('freshness', () => {
  const cat = fxCatalog(); const env1 = fxEnvelope('fx-both');
  const p1 = env1.picks[0]; const path = new URL(cat.rows.get(p1.product_id)?.images[0].src_canonical ?? '').pathname;
  const now = Date.parse(cat.fetched_at) + 1000;
  const fresh = (c = cat, paths: Record<string, string> = { p1: path }, t = now, h = 24) => freshness(env1, paths, c, cat.fetched_at, t, h);
  const without = (patch: Partial<Product>) => { const c = fxCatalog(); const p = c.rows.get(p1.product_id) as Product; c.rows.set(p1.product_id, { ...p, ...patch }); return c; };
  it('passes', () => expect(fresh()).toMatchObject({ ok: true, snapshot_id: cat.snapshot_id, age_s: 1 }));
  it('too old', () => expect(fresh(cat, {}, now + 25 * 3600e3)).toMatchObject({ ok: false, code: 'SNAPSHOT_TOO_OLD' }));
  it('gone', () => { const c = fxCatalog(); c.rows.delete(p1.product_id); expect(fresh(c)).toMatchObject({ code: 'STALE_PICK', reason: 'gone' }); });
  it('unavailable', () => expect(fresh(without({ variants: [] }))).toMatchObject({ code: 'STALE_PICK', reason: 'unavailable' }));
  it('image gone', () => expect(fresh(cat, { p1: '/nope.jpg' })).toMatchObject({ code: 'STALE_PICK', reason: 'image_gone' }));
});

describe('runReport', () => {
  it('sums Jev and cost events, reads FRESH_FOR_RELEASE_H', async () => {
    const r = uid(); await seedRun(r);
    await db.prepare(`INSERT INTO cost_events (run_id, customer_id, attempt, setting, est_usd, action, call_state, at) VALUES (?, 'a', 1, 's', 0.5, 'admit', 'estimated', 't')`).bind(r).run();
    await db.prepare(`INSERT INTO jev_events (run_id, customer_id, attempt, model_requested, status, reason, charged_usd, basis_usd, at) VALUES (?, 'a', 1, 'm', 'unavailable', 'timeout', 0.25, 0.1, 't')`).bind(r).run();
    await db.prepare(`INSERT INTO generations (run_id, customer_id, attempt, result_type, usage_json) VALUES (?, 'a', 1, 'answered', ?)`).bind(r, JSON.stringify({ input_tokens: 100, cache_read_input_tokens: 300 })).run();
    const rep = await runReport(db, r);
    expect(rep).toMatchObject({ est_usd: 0.5, jev_usd: 0.25, jev_fallbacks: { 'unavailable:timeout': 1 }, cache_hit_rate: 0.75, fresh_for_release_h: 8760 });
    expect(rep.placeholders).not.toContain('jev_usd');
  });
});
