// page lane test 11: seed --voice re-renders by renderAll, hashes, and loads stage='voice' rows. Test 7: real 390 px layout when a browser exists.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { voiceSql, fixtureSql, fxCase } from '../../scripts/seed.ts';
import { contentSha256 } from '../../src/contracts/lib.ts';
import { fakeLib, fxCatalog } from '../fakes/index.ts';
import type { CheckResult } from '../../src/contracts/types.ts';

const db = () => {
  const d = new DatabaseSync(':memory:');
  d.exec(readFileSync('migrations/0001_core.sql', 'utf8'));
  return d;
};
const cat = fxCatalog();
const voiceFile = (id: string, checks: CheckResult[] = [{ id: 'C1', part: 'landing_page', severity: 'hard', pass: true }]) => {
  const c = fxCase(id);
  return { plan: c.plan, envelope: c.envelope, request_sha256: 'r', message: {}, model_json: c.model, checks };
};

describe('test 11: seed --voice', () => {
  it('loads a voice run the DDL accepts, re-rendered and hashed', async () => {
    const d = db();
    for (const s of await voiceSql([voiceFile('GOOD-c16'), voiceFile('GOOD-c07')], cat, 'first', fakeLib.renderAll)) d.exec(s);
    expect(d.prepare('SELECT stage, status FROM runs').all()).toEqual([{ stage: 'voice', status: 'done' }]);
    const rows = d.prepare('SELECT id, status, envelope_json, model_json, rendered_json, content_sha256 FROM drafts ORDER BY id').all() as Record<string, string>[];
    expect(rows.map((r) => r.status)).toEqual(['in_review', 'in_review']);
    for (const r of rows) {
      expect(r.content_sha256).toBe(await contentSha256(r.envelope_json, r.model_json, r.rendered_json));
      expect(JSON.parse(r.rendered_json).landing_page).toContain('data-part="landing_page"');
    }
    expect(d.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 2 });
  });
  it('with the real renderAll: gen expand, page renderLanding and renderCatalog, name from the envelope', async () => {
    const d = db();
    for (const s of await voiceSql([voiceFile('GOOD-c16')], cat, 'first')) d.exec(s);
    const { landing_page, catalog } = JSON.parse((d.prepare('SELECT rendered_json FROM drafts').get() as { rendered_json: string }).rendered_json);
    expect(landing_page).toContain('>For Aditi<');
    expect(landing_page).not.toMatch(/\{p\d\}/);
    expect(catalog).toContain('data-slot="p6"');
  });
  it('a hard failure loads as failed, its unit as CHECKS_FAILED', async () => {
    const d = db();
    const f = voiceFile('GOOD-c16', [{ id: 'C4', part: 'landing_page', severity: 'hard', pass: false }]);
    for (const s of await voiceSql([f], cat, 'first', fakeLib.renderAll)) d.exec(s);
    expect(d.prepare('SELECT status, hard_failures FROM drafts').get()).toEqual({ status: 'failed', hard_failures: 1 });
    expect(d.prepare('SELECT status, code FROM units').get()).toEqual({ status: 'failed', code: 'CHECKS_FAILED' });
  });
  it('running twice replaces, never duplicates', async () => {
    const d = db();
    const sql = await voiceSql([voiceFile('GOOD-c16')], cat, 'first', fakeLib.renderAll);
    for (const s of [...sql, ...sql]) d.exec(s);
    expect(d.prepare('SELECT COUNT(*) AS n FROM drafts').get()).toEqual({ n: 1 });
    expect(d.prepare('SELECT COUNT(*) AS n FROM draft_events').get()).toEqual({ n: 1 });
  });
  it('model_json on disk may be a string or an object', async () => {
    const d = db();
    const f = { ...voiceFile('GOOD-c16'), model_json: JSON.stringify(fxCase('GOOD-c16').model) };
    for (const s of await voiceSql([f], cat, 'first', fakeLib.renderAll)) d.exec(s);
    expect((d.prepare('SELECT model_json FROM drafts').get() as { model_json: string }).model_json).toBe(JSON.stringify(fxCase('GOOD-c16').model));
  });
});

describe('seed --fixtures', () => {
  it('fits the DDL and holds a seeded approval, a released row, a unit with no draft', async () => {
    const d = db();
    for (const s of await fixtureSql()) d.exec(s);
    const by = Object.fromEntries((d.prepare('SELECT customer_id, status FROM drafts').all() as { customer_id: string; status: string }[]).map((r) => [r.customer_id, r.status]));
    expect(by).toEqual({ c16: 'in_review', c07: 'approved', c02: 'released', c20: 'in_review', c18: 'failed' });
    expect(d.prepare(`SELECT status, code FROM units WHERE customer_id = 'c-nodraft'`).get()).toEqual({ status: 'failed', code: 'COLD_START_NO_HISTORY' });
    expect(d.prepare(`SELECT stage FROM runs`).all()).toEqual([{ stage: 'rehearsal' }]);
    expect(d.prepare(`SELECT COUNT(*) AS n FROM draft_events WHERE actor_email = 'seed-demo@local' AND actor_kind = 'dev'`).get()).toEqual({ n: 3 });
  });
});
