import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { FAILED_CODES, SKIPPED_CODES } from '../../src/contracts/codes.ts';
import { runReport } from '../../src/lib/state/index.ts';

const db = (env as unknown as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
});

const insertDraft = (id: string, status: string, hard = 0, extra = '', extraVals = '') => db.prepare(
  `INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json,
    rendered_json, content_sha256, checks_json, hard_failures, status ${extra})
   VALUES (?, 'r1', ?, 1, 'both', 's', 'v', 'm', '{}', '{}', '{}', 'h', '[]', ?, ? ${extraVals})`).bind(id, id, hard, status).run();
const unit = (key: string, status: string, code: string | null, billed = 0) => db.prepare(
  'INSERT INTO units (run_id, customer_id, status, code, billed_attempts) VALUES (?, ?, ?, ?, ?)').bind('r1', key, status, code, billed).run();

describe('test 1: release needs approval, by CHECK', () => {
  it('a status-only UPDATE to released fails', async () => {
    await insertDraft('d1', 'in_review');
    await expect(db.prepare(`UPDATE drafts SET status = 'released' WHERE id = 'd1'`).run()).rejects.toThrow(/CHECK/);
    const row = await db.prepare(`SELECT status FROM drafts WHERE id = 'd1'`).first<{ status: string }>();
    expect(row?.status).toBe('in_review');
  });
  it('approved with no approval fields fails', async () => {
    await insertDraft('d2', 'in_review');
    await expect(db.prepare(`UPDATE drafts SET status = 'approved' WHERE id = 'd2'`).run()).rejects.toThrow(/CHECK/);
  });
  it('released with a hash other than the approved one fails', async () => {
    await insertDraft('d3', 'approved', 0, ', approved_by, approved_sub, approved_at, approved_sha256', `, 'a', 'b', 'c', 'other'`);
    await expect(db.prepare(`UPDATE drafts SET status = 'released', released_by = 'a', released_at = 'c' WHERE id = 'd3'`).run()).rejects.toThrow(/CHECK/);
  });
  it('a live status with hard failures fails', async () => {
    await expect(insertDraft('d4', 'in_review', 1)).rejects.toThrow(/CHECK/);
  });
  it('second live draft for a customer fails one_live', async () => {
    await insertDraft('d5', 'in_review');
    await expect(db.prepare(`INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json,
      model_json, rendered_json, content_sha256, checks_json, hard_failures, status) VALUES ('d5b','r1','d5',2,'both','s','v','m','{}','{}','{}','h','[]',0,'in_review')`).run())
      .rejects.toThrow(/UNIQUE/);
  });
});

describe('test 2: units refuses an unknown code', () => {
  it('failed with an unknown code', async () => {
    await expect(unit('u1', 'failed', 'MADE_UP')).rejects.toThrow(/CHECK/);
  });
  it('skipped with a failed-only code', async () => {
    await expect(unit('u2', 'skipped', 'INVALID_PICK')).rejects.toThrow(/CHECK/);
  });
  it('a code on a non-terminal status', async () => {
    await expect(unit('u3', 'pending', 'INVALID_PICK')).rejects.toThrow(/CHECK/);
  });
  it('every code in codes.ts is accepted, so the lists match', async () => {
    for (const c of FAILED_CODES) await unit(`f-${c}`, 'failed', c);
    for (const c of SKIPPED_CODES) await unit(`s-${c}`, 'skipped', c);
  });
});

describe('runReport stand-in', () => {
  it('reads units and drafts and names its placeholders', async () => {
    await db.batch([
      db.prepare(`INSERT INTO snapshots VALUES ('s2', '2026-10-29', 1, 1, 0)`),
      db.prepare(`INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic,
        recs_sha256, setting, prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd,
        preview_sha256, expected_usd, status, created_by, created_at) VALUES ('rr','rr','isolation','email','s2','2026-11-01','c','k',1,'rec','s','v1','v1','sh','j','jc',1,1,'p',0.5,'done','me','now')`),
      db.prepare(`INSERT INTO units (run_id, customer_id, status, billed_attempts) VALUES ('rr','a','drafted',1)`),
      db.prepare(`INSERT INTO units (run_id, customer_id, status, code) VALUES ('rr','b','failed','INVALID_PICK')`),
      db.prepare(`INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json,
        content_sha256, checks_json, hard_failures, status) VALUES ('rr:a:v1','rr','a',1,'email','s2','v','m','{"carried_part":null}','{}','{}','h','[]',0,'in_review')`),
    ]);
    const r = await runReport(db, 'rr');
    expect(r.counts).toEqual({ 'unit:drafted': 1, 'unit:failed': 1, 'code:INVALID_PICK': 1, 'draft:in_review': 1 });
    expect(r.first_try_pass.email).toBe(1);
    expect(r.placeholders).toEqual([]);   // cap.json is measured
    expect(r.snapshot_fetched_at).toBe('2026-10-29');
  });
});
