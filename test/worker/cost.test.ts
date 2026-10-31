import { beforeAll, describe, expect, it } from 'vitest';
import capJson from '../../config/cap.json' with { type: 'json' };
import pricesJson from '../../config/prices.json' with { type: 'json' };
import rungsJson from '../../config/rungs.json' with { type: 'json' };
import { admitAll, callWorst, capRun, onePrice, retryGate, settle } from '../../src/lib/cost/index.ts';
import { runBatch } from '../../src/lib/state/index.ts';
import type { CapConfig, Estimate, PlanPreview, Prices, Rung } from '../../src/contracts/types.ts';
import { cost, db, migrate, runRow, seedRun, uid, unit } from './run-fx.ts';

const cap = capJson as unknown as CapConfig; const prices = pricesJson as Prices; const rungs = rungsJson as unknown as Rung[];
const START = 'sonnet-default';
const sonnet = onePrice(prices, 'claude-sonnet-5-5');
const est = (key: string, input_tokens: number): Estimate => ({ key, format: 'both', rung: START, input_tokens });
beforeAll(migrate);

describe('callWorst', () => {
  it('reproduces 42 §6: $0.0927 at U_design_max, 8,250 max_tokens', () => {
    expect(callWorst(1338, 8250, 'both', cap, sonnet)).toBeCloseTo(0.0927, 4);
  });
  it('prices the one model it is handed', () => {
    expect(callWorst(1000, 1000, 'both', cap, onePrice(prices, 'claude-haiku-5-5'))).toBeLessThan(callWorst(1000, 1000, 'both', cap, sonnet) / 10);
  });
});

describe('admitAll', () => {
  it('admits within budget, commit = 2 × est_1, prefix at the write rate', () => {
    const r = admitAll([est('a', 3338)], cap, rungs, START, null, prices);
    const est1 = (3000 * 2.5 + 338 * 2 + 2750 * 10) / 1e6;
    expect(r.per.a.action).toBe('admit');
    expect(r.per.a.est_1_usd).toBeCloseTo(est1, 9);
    expect(r.per.a.commit_usd).toBeCloseTo(2 * est1, 9);
    expect(r.committed_usd).toBeCloseTo(2 * est1, 9);
  });
  it('test 6: over the hard bound → skip OVER_CAP, never admitted', () => {
    const r = admitAll([est('big', 3000 + cap.U_hard.both + 1), est('ok', 3100)], cap, rungs, START, null, prices);
    expect(r.per.big).toMatchObject({ action: 'skip', code: 'OVER_CAP', commit_usd: 0 });
    expect(r.admitted.map((a) => a.key)).toEqual(['ok']);
  });
  it('test 6: over the customer cap, under the hard bound → OVER_CAP (no ladder)', () => {
    expect(admitAll([est('mid', 3000 + cap.U_design_max.both + 1)], cap, rungs, START, null, prices).per.mid).toMatchObject({ action: 'skip', code: 'OVER_CAP' });
  });
  it('no estimate → ESTIMATE_FAILED', () => {
    expect(admitAll([est('none', -1)], cap, rungs, START, null, prices).per.none).toMatchObject({ action: 'skip', code: 'ESTIMATE_FAILED' });
  });
  it('past the budget → stop RUN_CAP for the rest, ascending id, deterministic', () => {
    const one = admitAll([est('a', 3100)], cap, rungs, START, null, prices).per.a.commit_usd;
    const input = [est('c', 3100), est('a', 3100), est('b', 3100)];
    const r = admitAll(input, cap, rungs, START, one * 1.5, prices);
    expect(r.admitted.map((a) => a.key)).toEqual(['a']);
    expect(r.per.b).toMatchObject({ action: 'stop', code: 'RUN_CAP' });
    expect(r.per.c).toMatchObject({ action: 'stop', code: 'RUN_CAP' });
    expect(admitAll([...input].reverse(), cap, rungs, START, one * 1.5, prices)).toEqual(r);
    expect(r.committed_usd).toBeLessThanOrEqual(one * 1.5);
  });
});

describe('capRun', () => {
  const preview = { sum_commit_usd: 1, jev_reserve_usd: 0.1 } as PlanPreview;
  it('ceiling = Σ commit + reserve; cap = 1.05 × that', () => {
    const r = capRun(preview);
    expect(r.ceiling_usd).toBeCloseTo(1.1, 9);
    expect(r.cap_run_usd).toBeCloseTo(1.155, 9);
  });
  it('a fresh preview admits everyone', () => {
    const list = ['a', 'b', 'c'].map((k) => est(k, 3100));
    const p = admitAll(list, cap, rungs, START, null, prices);
    const { cap_run_usd } = capRun({ sum_commit_usd: p.committed_usd, jev_reserve_usd: 0 } as PlanPreview);
    expect(admitAll(list, cap, rungs, START, cap_run_usd, prices).admitted).toHaveLength(3);
  });
});

async function seedAttempt(run: string, key: string, state: string, opts: { est?: number; commit?: number; charged?: number | null; setting?: string } = {}) {
  await db.prepare(`INSERT OR IGNORE INTO units (run_id, customer_id, status) VALUES (?, ?, 'admitted')`).bind(run, key).run();
  await db.prepare(`INSERT INTO cost_events (run_id, customer_id, attempt, setting, est_usd, commit_usd, action, call_state, charged_usd, at)
    VALUES (?, ?, 1, ?, ?, ?, 'admit', ?, ?, 't')`).bind(run, key, opts.setting ?? 'sonnet-between_tools', opts.est ?? 0.02, opts.commit ?? 0.04, state, opts.charged ?? null).run();
}
const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 };
const charge = (1000 * 2 + 500 * 10 + 2000 * 0.1 + 100 * 2.5) / 1e6;

describe('settle', () => {
  it('charges from usage, releases commit − actual, raises billed once on replay', async () => {
    const r = uid(); await seedRun(r); await seedAttempt(r, 'k', 'calling');
    await runBatch(db, settle(db, r, 'k', 1, { usage, content_empty: false }, sonnet));
    expect((await cost(r, 'k', 1))).toMatchObject({ call_state: 'answered' });
    expect((await cost(r, 'k', 1))?.charged_usd).toBeCloseTo(charge, 9);
    const row = await runRow(r);
    expect(row?.spent_usd).toBeCloseTo(charge, 9);
    expect(row?.pool_usd).toBeCloseTo(0.04 - charge, 9);
    expect((await unit(r, 'k'))?.billed_attempts).toBe(1);
    await db.batch(settle(db, r, 'k', 1, { usage, content_empty: false }, sonnet).map((g) => g.stmt));
    expect((await runRow(r))?.spent_usd).toBeCloseTo(charge, 9);
    expect((await unit(r, 'k'))?.billed_attempts).toBe(1);
  });
  it('an attempt above commit releases 0 and does not trip the pool CHECK', async () => {
    const r = uid(); await seedRun(r); await seedAttempt(r, 'k', 'calling', { commit: 0.0001 });
    await runBatch(db, settle(db, r, 'k', 1, { usage, content_empty: false }, sonnet));
    expect((await runRow(r))?.pool_usd).toBe(0);
  });
  it('unbilled refusal: null or general_harms category, empty content → $0, billed unchanged', async () => {
    for (const category of [null, 'general_harms']) {
      const r = uid(); await seedRun(r); await seedAttempt(r, 'k', 'calling');
      await runBatch(db, settle(db, r, 'k', 1, { usage, stop_reason: 'refusal', category, content_empty: true }, sonnet));
      expect((await cost(r, 'k', 1))?.charged_usd).toBe(0);
      expect((await unit(r, 'k'))?.billed_attempts).toBe(0);
      expect((await runRow(r))?.pool_usd).toBeCloseTo(0.04, 9);
    }
  });
  it('billed refusal: bio, or content present → charged and billed', async () => {
    for (const m of [{ category: 'bio', content_empty: true }, { category: null, content_empty: false }]) {
      const r = uid(); await seedRun(r); await seedAttempt(r, 'k', 'calling');
      await runBatch(db, settle(db, r, 'k', 1, { usage, stop_reason: 'refusal', ...m }, sonnet));
      expect((await cost(r, 'k', 1))?.charged_usd).toBeCloseTo(charge, 9);
      expect((await unit(r, 'k'))?.billed_attempts).toBe(1);
    }
  });
});

describe('retryGate', () => {
  it('passes, takes the pool once, writes attempt 2; a replay takes nothing', async () => {
    const r = uid(); await seedRun(r, { pool: 0.05 }); await seedAttempt(r, 'k', 'answered', { charged: 0.01 });
    expect(await retryGate(db, r, 'k', 0.02)).toBe(true);
    expect((await runRow(r))?.pool_usd).toBeCloseTo(0.03, 9);
    expect(await cost(r, 'k', 2)).toMatchObject({ action: 'retry', call_state: 'estimated', est_usd: 0.02, commit_usd: 0.02 });
    expect(await retryGate(db, r, 'k', 0.02)).toBe(true);
    expect((await runRow(r))?.pool_usd).toBeCloseTo(0.03, 9);
  });
  it('blocks on an empty pool, recorded, pool untouched', async () => {
    const r = uid(); await seedRun(r, { pool: 0.01 }); await seedAttempt(r, 'k', 'answered', { charged: 0.01 });
    expect(await retryGate(db, r, 'k', 0.02)).toBe(false);
    expect(await cost(r, 'k', 2)).toMatchObject({ action: 'retry_blocked', call_state: 'blocked', reason: 'pool_empty' });
    expect((await runRow(r))?.pool_usd).toBeCloseTo(0.01, 9);
    expect(await retryGate(db, r, 'k', 0.02)).toBe(false);
  });
  it('blocks on the customer cap', async () => {
    const r = uid(); await seedRun(r, { pool: 5 }); await seedAttempt(r, 'k', 'answered', { charged: 1 });
    expect(await retryGate(db, r, 'k', 0.02)).toBe(false);
    expect(await cost(r, 'k', 2)).toMatchObject({ action: 'retry_blocked', reason: 'customer_cap' });
    expect((await runRow(r))?.pool_usd).toBe(5);
  });
});
