import { introspectWorkflowInstance } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seam, transition } from '../../src/lib/state/index.ts';
import { admit, close, estimate, failUnit, finish, gen, genFailed, pin, prep } from '../../src/workflow/steps.ts';
import { routes } from '../../src/worker/routes/runs.ts';
import type { CheckResult, ModelJson, Plan, RunFormat } from '../../src/contracts/types.ts';
import { FX_KEYS, fakeLib, fxModelJson, fxPlan, fxPrompt } from '../fakes/index.ts';
import { ACTOR, cost, db, draft, env, fakeLlm, generation, message, migrate, runRow, seedRun, uid, unit, units, useFakes } from './run-fx.ts';

const KEY = 'fx-both';
beforeAll(migrate);
beforeEach(() => { useFakes(); seam.fetch = undefined; seam.pause = undefined; });

/** A run walked to admitted by the real steps, ready for `gen`. */
async function admitted(key = KEY, o: { format?: RunFormat; cap?: number; input?: number } = {}) {
  const r = uid(); await seedRun(r, { format: o.format, cap: o.cap ?? 10 });
  useFakes({ ingestTsv: () => [{ key, status: 'ok', record: { customer_id: key, first_name: 'F', occasion: 'o', new_user: false } }] });
  await pin(env, r); await prep(env, r, key);
  await admit(env, r, { [key]: o.input ?? 3100 });
  return r;
}
const allFx = () => useFakes();

function patched(over: Partial<typeof env>) { return { ...env, ...over } as typeof env; }
function route(path: string) { return routes.find((x) => x.path === path)!; }
const call = (path: string, params: Record<string, string>, body: unknown, e = env) => route(path).handler({
  req: new Request('https://x.test/', { method: 'POST', body: JSON.stringify(body) }), env: e, exec: {} as ExecutionContext, actor: ACTOR, params });

async function runToDone(r: string, patch?: (m: Awaited<ReturnType<typeof introspectWorkflowInstance>>) => Promise<void>) {
  await using i = await introspectWorkflowInstance(env.RUN_WORKFLOW, r);
  await i.modify(async (m) => { await m.disableRetryDelays(); });
  await patch?.(i);
  await env.RUN_WORKFLOW.create({ id: r, params: { run_id: r } });
  await i.waitForStatus('complete');
}
const waitDone = (r: string) => vi.waitFor(async () => expect((await runRow(r))?.status).toBe('done'), { timeout: 15000, interval: 100 });

describe('test 1, line 3: isolation on a real Workflow instance', () => {
  it('each bad customer fails alone, the others complete, the run is done', async () => {
    const r = uid('iso'); await seedRun(r);
    const calls = fakeLlm();
    useFakes({ planCustomer: (item, _r, _k, _c, p) => {
      if (item.key === 'fx-throw') throw new Error('boom');
      if (item.key === 'fx-newuser') return { ...fxPlan(item.key), pinned: p, picks: [], outcome: { kind: 'failed', code: 'COLD_START_NO_HISTORY' } };
      return { ...fxPlan(item.key), format: p.format, pinned: p };
    } });
    await runToDone(r);
    expect(await units(r)).toEqual({ 'fx-both': 'drafted', 'fx-email': 'drafted', 'fx-retry': 'drafted', 'fx-newuser': 'failed:COLD_START_NO_HISTORY',
      'fx-throw': 'failed:INTERNAL_ERROR', 'row:3': 'failed:INVALID_CUSTOMER' });
    const row = await runRow(r);
    expect(row).toMatchObject({ status: 'done', stop_reason: null });
    expect(row?.results_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.filter((c) => c.key === 'fx-newuser' || c.key === 'row:3' || c.key === 'fx-throw')).toEqual([]);
    expect((await unit(r, 'fx-throw'))?.error_detail).toMatch(/boom/);
  });
  it('a finish that throws after E1 fails that unit alone and close passes', async () => {
    const r = uid('iso'); await seedRun(r); fakeLlm();
    useFakes({ transition: async (e, id, edge, a, o) => { if (id.includes('fx-email')) throw new Error('after E1'); return transition(e, id, edge, a, o); } });
    await runToDone(r);
    const u = await units(r);
    expect(u['fx-email']).toBe('failed:INTERNAL_ERROR');
    expect(u['fx-both']).toBe('drafted');
    expect((await runRow(r))?.status).toBe('done');
  });
  it('close: a unit left open → stopped close_incomplete, no sha', async () => {
    const r = uid(); await seedRun(r, { status: 'generating' });
    await db.prepare(`INSERT INTO units (run_id, customer_id, status) VALUES (?, 'a', 'admitted')`).bind(r).run();
    useFakes({ ingestTsv: () => [{ key: 'a', status: 'invalid', errors: [] }] });
    await close(env, r);
    expect(await runRow(r)).toMatchObject({ status: 'stopped', stop_reason: 'close_incomplete', results_sha256: null });
  });
});

describe('close: run cap breach', () => {
  const closed = async (spent: number) => {
    const r = uid(); await seedRun(r, { status: 'generating', cap: 1 }); allFx();
    await db.prepare('UPDATE runs SET spent_usd = ? WHERE id = ?').bind(spent, r).run();
    const spy = vi.spyOn(console, 'log');
    await close(env, r);
    const lines = spy.mock.calls.map(([l]) => JSON.parse(String(l)));
    spy.mockRestore();
    return lines.filter((l) => l.status === 'cap_breach').map((l) => ({ ...l, run_id: r === l.run_id }));
  };
  it('logs spent over cap_run_usd', async () => {
    expect(await closed(1.2)).toEqual([{ run_id: true, step: 'close', status: 'cap_breach', code: 'RUN_CAP', spent_usd: 1.2, cap_run_usd: 1 }]);
  });
  it('logs nothing at the cap', async () => expect(await closed(1)).toEqual([]));
});

describe('durations', () => {
  it('a model call and a Jev call each store how long they took', async () => {
    const r = await admitted();
    fakeLlm(); await gen(env, r, KEY, 1);
    expect((await generation(r, KEY, 1) as { ms: unknown } | null)?.ms).toEqual(expect.any(Number));
    await finish(env, r, KEY, 1);
    const j = await db.prepare('SELECT status, ms FROM jev_events WHERE run_id = ? AND customer_id = ?').bind(r, KEY).first<{ status: string; ms: number | null }>();
    expect(j?.ms).toEqual(expect.any(Number));
  });
});

describe('test 3: kill after the answer', () => {
  it('possibly_billed at the estimate, no second call for attempt 1, then attempt 2 runs', async () => {
    const r = await admitted();
    const calls = fakeLlm();
    seam.pause = async () => { throw new Error('killed'); };
    await expect(gen(patched({ DEV_FAULT: `pause_after_answer:${KEY}` }), r, KEY, 1)).rejects.toThrow('killed');
    expect(calls).toHaveLength(1);
    expect(await generation(r, KEY, 1)).toBeNull();
    expect((await cost(r, KEY, 1))?.call_state).toBe('calling');
    seam.pause = undefined;
    await gen(env, r, KEY, 1);                                    // the replay after restart
    expect(calls).toHaveLength(1);
    expect((await generation(r, KEY, 1))?.result_type).toBe('possibly_billed');
    const c = await cost(r, KEY, 1);
    expect(c?.call_state).toBe('possibly_billed');
    expect(c?.charged_usd).toBeCloseTo(c?.est_usd ?? -1, 9);
    expect((await unit(r, KEY))?.billed_attempts).toBe(1);
    expect((await runRow(r))?.spent_usd).toBeCloseTo(c?.est_usd ?? -1, 9);
    expect(await finish(env, r, KEY, 1)).toEqual({ retry: true });
    await gen(env, r, KEY, 2); await finish(env, r, KEY, 2);
    expect(calls).toHaveLength(2);
    expect((await unit(r, KEY))).toMatchObject({ status: 'drafted', billed_attempts: 2 });
  });
});

describe('test 4: replay of every step', () => {
  it('walks the whole run twice: no second call, no second charge, same rows', async () => {
    const r = await admitted('fx-retry');
    const calls = fakeLlm();
    const counts = { judge: 0 };
    useFakes({ ingestTsv: () => [{ key: 'fx-retry', status: 'ok', record: { customer_id: 'fx-retry', first_name: 'F', occasion: 'o', new_user: false } }],
      judgeDraft: async (e, i, c) => { counts.judge++; return fakeLib.judgeDraft(e, i, c); } });
    const walk = async () => {
      await pin(env, r); await prep(env, r, 'fx-retry');
      await expect(estimate(env, r, 'fx-retry')).resolves.toBe(3100);
      const { admitted: a } = await admit(env, r, { 'fx-retry': 3100 });
      expect(a).toEqual([{ key: 'fx-retry', format: 'both' }]);
      await gen(env, r, 'fx-retry', 1);
      const f1 = await finish(env, r, 'fx-retry', 1);
      if (f1.retry) { await gen(env, r, 'fx-retry', 2); await finish(env, r, 'fx-retry', 2); }
      await close(env, r);
    };
    await walk();
    const before = await runRow(r);
    expect(calls).toHaveLength(2);
    expect(before?.status).toBe('done');
    await walk();
    expect(calls).toHaveLength(2);
    expect(counts.judge).toBe(1);
    expect(await runRow(r)).toEqual(before);
    expect((await unit(r, 'fx-retry'))?.billed_attempts).toBe(2);
  });
  it('a replayed finish before the edge ran finishes the edge, without a second Jev call', async () => {
    const r = await admitted();
    fakeLlm(); await gen(env, r, KEY, 1);
    let judged = 0;
    let die = true;
    useFakes({ judgeDraft: async (e, i, c) => { judged++; return fakeLib.judgeDraft(e, i, c); },
      transition: async (e, id, edge, a, o) => { if (die) throw new Error('die'); return transition(e, id, edge, a, o); } });
    await expect(finish(env, r, KEY, 1)).rejects.toThrow('die');
    die = false;
    expect((await draft(r, KEY, 1))?.status).toBe('draft');
    await finish(env, r, KEY, 1);
    expect((await draft(r, KEY, 1))?.status).toBe('in_review');
    expect(judged).toBe(1);
  });
  it('a replayed finish does not take the pool twice', async () => {
    const r = await admitted('fx-retry');
    useFakes({ ingestTsv: () => [] }); fakeLlm();
    await gen(env, r, 'fx-retry', 1);
    await finish(env, r, 'fx-retry', 1);
    const pool = (await runRow(r))?.pool_usd;
    await finish(env, r, 'fx-retry', 1);
    expect((await runRow(r))?.pool_usd).toBe(pool);
  });
});

describe('test 5: part-scoped retry', () => {
  it('the passing part is byte-identical, billed 2, the failed part regenerated', async () => {
    const r = await admitted('fx-retry');
    const good = fxModelJson('fx-retry');
    const first: ModelJson = { ...good, landing_page: { ...good.landing_page, marker: 'attempt-1-landing' } };
    const calls = fakeLlm((_k, n) => (n === 1 ? message(JSON.stringify(first)) : message(JSON.stringify({ email: { ...good.email, marker: 'attempt-2-email' } }))));
    useFakes({ ingestTsv: () => [] });
    let asked: { failed: string[]; checks: CheckResult[] } | undefined;
    useFakes({ buildRequest: (p, q, c, x, y, retry) => { asked = retry ?? asked; return fakeLib.buildRequest(p, q, c, x, y, retry); } });
    await gen(env, r, 'fx-retry', 1);
    expect(await finish(env, r, 'fx-retry', 1)).toEqual({ retry: true });
    await gen(env, r, 'fx-retry', 2);
    expect(await finish(env, r, 'fx-retry', 2)).toEqual({ retry: false });
    expect(calls).toHaveLength(2);
    expect(asked?.failed).toEqual(['email']);
    const v1 = JSON.parse((await draft(r, 'fx-retry', 1))!.model_json) as ModelJson;
    const v2row = await draft(r, 'fx-retry', 2);
    const v2 = JSON.parse(v2row!.model_json) as ModelJson;
    expect(JSON.stringify(v2.landing_page)).toBe(JSON.stringify(v1.landing_page));
    expect(v2.email).toMatchObject({ marker: 'attempt-2-email' });
    expect(JSON.parse(v2row!.envelope_json)).toMatchObject({ carried_from: 1, carried_part: 'landing_page' });
    expect((await draft(r, 'fx-retry', 1))?.status).toBe('failed');
    expect(await unit(r, 'fx-retry')).toMatchObject({ status: 'drafted', billed_attempts: 2 });
  });
  it('a C1 failure regenerates both: nothing carried', async () => {
    const r = await admitted(KEY);
    let c1 = true;
    useFakes({ validate: (_j, e) => (e.carried_from === null && c1 ? [{ id: 'C1', part: 'email', severity: 'hard', pass: false }] : []) });
    fakeLlm((_k, n) => (n === 1 ? message('not json') : null));
    await gen(env, r, KEY, 1); expect(await finish(env, r, KEY, 1)).toEqual({ retry: true });
    c1 = false;
    await gen(env, r, KEY, 2); await finish(env, r, KEY, 2);
    expect(JSON.parse((await draft(r, KEY, 2))!.envelope_json)).toMatchObject({ carried_from: null, carried_part: null });
  });
  it('a max_tokens stop passes both parts in failed: a carried part is never kept', async () => {
    const r = await admitted('fx-retry');
    fakeLlm((_k, n) => (n === 1 ? message(JSON.stringify(fxModelJson('fx-retry')), { stop_reason: 'max_tokens' }) : null));
    let asked: string[] = [];
    useFakes({ buildRequest: (p, q, c, x, y, retry) => { if (retry) asked = retry.failed; return fakeLib.buildRequest(p, q, c, x, y, retry); } });
    await gen(env, r, 'fx-retry', 1); await finish(env, r, 'fx-retry', 1);
    await gen(env, r, 'fx-retry', 2); await finish(env, r, 'fx-retry', 2);
    expect(asked.sort()).toEqual(['email', 'landing_page']);
    expect(JSON.parse((await draft(r, 'fx-retry', 2))!.envelope_json)).toMatchObject({ carried_part: null });
  });
  it('both attempts fail → failed CHECKS_FAILED, billed 2, no third call', async () => {
    const r = await admitted(KEY);
    useFakes({ validate: () => [{ id: 'C3', part: 'email', severity: 'hard', pass: false }] });
    const calls = fakeLlm();
    await gen(env, r, KEY, 1); await finish(env, r, KEY, 1);
    await gen(env, r, KEY, 2); expect(await finish(env, r, KEY, 2)).toEqual({ retry: false });
    expect(calls).toHaveLength(2);
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'CHECKS_FAILED', billed_attempts: 2 });
  });
  it('a blocked retry ends with attempt 1\'s code', async () => {
    const r = await admitted(KEY);
    useFakes({ validate: () => [{ id: 'C3', part: 'email', severity: 'hard', pass: false }] });
    fakeLlm((_k, n) => (n === 1 ? message(JSON.stringify(fxModelJson(KEY)), { usage: { input_tokens: 90000, output_tokens: 90000 } }) : null));
    await gen(env, r, KEY, 1);
    expect(await finish(env, r, KEY, 1)).toEqual({ retry: false });
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'CHECKS_FAILED' });
    expect((await cost(r, KEY, 2))?.action).toBe('retry_blocked');
  });
});

describe('gen outcomes, the finish table', () => {
  const errorRes = (status: number, body?: object) => (body ? Response.json(body, { status }) : new Response('', { status }));
  it('refusal: UPSTREAM_UNAVAILABLE, refusal:<category>, no retry, unbilled when empty', async () => {
    const r = await admitted(KEY);
    const calls = fakeLlm(() => message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }));
    await gen(env, r, KEY, 1);
    expect(await finish(env, r, KEY, 1)).toEqual({ retry: false });
    expect(calls).toHaveLength(1);
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'UPSTREAM_UNAVAILABLE', error_detail: 'refusal:none', billed_attempts: 0 });
    expect((await cost(r, KEY, 1))?.charged_usd).toBe(0);
  });
  it('a 4xx: invalid_request, failed INVALID_REQUEST, unbilled', async () => {
    const r = await admitted(KEY);
    fakeLlm(() => errorRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'no' } }));
    await gen(env, r, KEY, 1);
    expect((await generation(r, KEY, 1))?.result_type).toBe('invalid_request');
    expect((await cost(r, KEY, 1))).toMatchObject({ call_state: 'unbilled', charged_usd: null });
    await finish(env, r, KEY, 1);
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'INVALID_REQUEST', billed_attempts: 0 });
  });
  for (const [name, res] of [['429', () => errorRes(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } })], ['529', () => errorRes(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } })], ['empty 500', () => errorRes(500)]] as const) {
    it(`${name}: resets to estimated and throws, so the step retries`, async () => {
      const r = await admitted(KEY);
      fakeLlm(res);
      await expect(gen(env, r, KEY, 1)).rejects.toThrow();
      expect((await cost(r, KEY, 1))?.call_state).toBe('estimated');
      expect(await generation(r, KEY, 1)).toBeNull();
      fakeLlm(); await gen(env, r, KEY, 1);
      expect((await generation(r, KEY, 1))?.result_type).toBe('answered');
    });
  }
  it('a dropped connection is possibly_billed, never a blind repeat', async () => {
    const r = await admitted(KEY);
    fakeLlm(() => { throw new Error('Network connection lost'); });
    await gen(env, r, KEY, 1);
    expect((await generation(r, KEY, 1))?.result_type).toBe('possibly_billed');
  });
  it('out of retries: no_completion, unbilled, retry, then UPSTREAM_UNAVAILABLE', async () => {
    const r = await admitted(KEY);
    await db.prepare(`UPDATE runs SET pool_usd = 1 WHERE id = ?`).bind(r).run();
    fakeLlm();
    await genFailed(env, r, KEY, 1);
    expect((await cost(r, KEY, 1))).toMatchObject({ call_state: 'unbilled', charged_usd: null });
    expect(await finish(env, r, KEY, 1)).toEqual({ retry: true });
    await genFailed(env, r, KEY, 2);
    expect(await finish(env, r, KEY, 2)).toEqual({ retry: false });
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'UPSTREAM_UNAVAILABLE', billed_attempts: 0 });
  });
  it('last try answered, then the write failed: genFailed charges the estimate, never $0', async () => {
    const r = await admitted(KEY);
    await db.prepare('UPDATE runs SET pool_usd = 1 WHERE id = ?').bind(r).run();
    const calls = fakeLlm();
    const flaky = new Proxy(db, { get: (t, p) => (p === 'batch' ? () => Promise.reject(new Error('D1 down')) : (t as any)[p]?.bind?.(t) ?? (t as any)[p]) });
    await expect(gen(patched({ DB: flaky }), r, KEY, 1)).rejects.toThrow('D1 down');
    expect(calls).toHaveLength(1);
    expect((await cost(r, KEY, 1))?.call_state).toBe('calling');
    const est = (await cost(r, KEY, 1))!.est_usd;
    await genFailed(env, r, KEY, 1);
    expect(await cost(r, KEY, 1)).toMatchObject({ call_state: 'possibly_billed', charged_usd: est });
    expect((await generation(r, KEY, 1))?.result_type).toBe('possibly_billed');
    expect((await runRow(r))?.spent_usd).toBeCloseTo(est, 9);
    expect((await unit(r, KEY))?.billed_attempts).toBe(1);
  });
  it('a stopped run makes no call: unbilled, the commit returns, the unit is not lost', async () => {
    const r = await admitted(KEY);
    const before = (await runRow(r))!.pool_usd;
    const commit = (await cost(r, KEY, 1))!.commit_usd;
    await db.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'operator' WHERE id = ?`).bind(r).run();
    const calls = fakeLlm();
    await gen(env, r, KEY, 1);
    expect(calls).toHaveLength(0);
    expect((await cost(r, KEY, 1))?.call_state).toBe('unbilled');
    expect(await generation(r, KEY, 1)).toMatchObject({ result_type: 'no_completion', stop_detail: 'run_stopped' });
    expect(await runRow(r)).toMatchObject({ spent_usd: 0, status: 'stopped' });
    expect((await runRow(r))!.pool_usd).toBeCloseTo(before + commit, 9);
  });
  it('failUnit is idempotent and leaves a terminal unit alone', async () => {
    const r = await admitted(KEY);
    await failUnit(env, r, KEY, new Error('a'));
    await failUnit(env, r, KEY, new Error('b'));
    expect(await unit(r, KEY)).toMatchObject({ code: 'INTERNAL_ERROR', error_detail: expect.stringContaining('a') });
  });
  it('a Jev outage changes nothing: the unit drafts, the event says why', async () => {
    const r = await admitted(KEY); fakeLlm();
    useFakes({ judgeDraft: async (_e, _i, cfg) => ({ status: 'unavailable', reason: 'timeout', model: null, answers: null, input_tokens: null, charged_usd: null, basis_usd: cfg.basis_usd }) });
    await gen(env, r, KEY, 1); await finish(env, r, KEY, 1);
    expect((await unit(r, KEY))?.status).toBe('drafted');
    expect((await db.prepare('SELECT status, reason FROM jev_events WHERE run_id = ?').bind(r).first())).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});

describe('test 6: OVER_CAP at $0, logged', () => {
  it('no model call, no spend, a cost row and a log line', async () => {
    const log = vi.spyOn(console, 'log');
    const r = await admitted(KEY, { input: 900000 });
    const calls = fakeLlm();
    expect(await unit(r, KEY)).toMatchObject({ status: 'skipped', code: 'OVER_CAP', billed_attempts: 0 });
    expect(await cost(r, KEY, 1)).toMatchObject({ action: 'skip', call_state: 'blocked' });
    expect((await runRow(r))?.spent_usd).toBe(0);
    expect(calls).toEqual([]);
    expect(log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('OVER_CAP'))).toContain(`"run_id":"${r}"`);
    log.mockRestore();
  });
  it('ESTIMATE_FAILED and RUN_CAP land too', async () => {
    const r = await admitted(KEY, { input: -1 });
    expect(await unit(r, KEY)).toMatchObject({ status: 'skipped', code: 'ESTIMATE_FAILED' });
    const s = await admitted(KEY, { cap: 0.001 });
    expect(await unit(s, KEY)).toMatchObject({ status: 'skipped', code: 'RUN_CAP' });
    expect(await cost(s, KEY, 1)).toMatchObject({ action: 'stop' });
  });
  it('admit is the same set on a replay', async () => {
    const r = await admitted(KEY);
    expect((await admit(env, r, {})).admitted).toEqual([{ key: KEY, format: 'both' }]);
  });
});

describe('test 8: each runs.format', () => {
  for (const format of ['both', 'email', 'landing_page'] as const) {
    it(format, async () => {
      const r = await admitted(KEY, { format });
      fakeLlm((k) => {
        const m = fxModelJson(k);
        return message(JSON.stringify(format === 'both' ? m : m[format] ?? m));
      });
      useFakes({ toModelJson: (t, parts) => { const p = JSON.parse(t); expect(parts).toEqual(format === 'both' ? ['email', 'landing_page'] : [format]);
        return parts.length === 1 ? { [parts[0]]: p } : p; } });
      await gen(env, r, KEY, 1); await finish(env, r, KEY, 1);
      expect(Object.keys(JSON.parse((await draft(r, KEY, 1))!.model_json)).sort()).toEqual(format === 'both' ? ['email', 'landing_page'] : [format]);
      expect((await draft(r, KEY, 1))?.status).toBe('in_review');
      expect(JSON.parse((await draft(r, KEY, 1))!.envelope_json)).toMatchObject({ format, display_name: 'Fixture' });
    });
  }
});

describe('test 10: the run machine', () => {
  it('restart from stopped after admit → generating; the replayed run reaches close; no repeat call', async () => {
    const r = uid('rs'); await seedRun(r); const calls = fakeLlm();
    await env.RUN_WORKFLOW.create({ id: r, params: { run_id: r } });   // no introspector: its dispose deletes the instance
    await waitDone(r);
    const n = calls.length;
    await db.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'x', results_sha256 = NULL WHERE id = ?`).bind(r).run();
    const res = await call('/api/runs/:id/restart', { id: r }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'generating', branch: 'restart', instance_id: r });
    await waitDone(r);
    expect(calls).toHaveLength(n);
    expect((await runRow(r))?.stop_reason).toBeNull();
  });
  it('restart before admit wrote → preparing', async () => {
    const r = uid('rs'); await seedRun(r); await seedStopped(r); fakeLlm();
    await env.RUN_WORKFLOW.create({ id: r, params: { run_id: r } });
    const res = await call('/api/runs/:id/restart', { id: r }, {});
    expect(await res.json()).toMatchObject({ status: 'preparing' });
    await waitDone(r);
  });
  it('a lost instance: restart throws → <id>-r1, steps read D1 by run_id, then -r2', async () => {
    const r = uid('rs'); await seedRun(r); const calls = fakeLlm();
    await runToDone(r);
    const n = calls.length;
    await db.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'lost' WHERE id = ?`).bind(r).run();
    const wf = { get: async () => { throw new Error('instance.not_found'); }, create: env.RUN_WORKFLOW.create.bind(env.RUN_WORKFLOW) };
    const res = await call('/api/runs/:id/restart', { id: r }, {}, patched({ RUN_WORKFLOW: wf as never }));
    expect(await res.json()).toMatchObject({ branch: 'new_instance', instance_id: `${r}-r1` });
    await waitDone(r);
    expect((await runRow(r))?.instance_id).toBe(`${r}-r1`);
    expect(calls).toHaveLength(n);
    await db.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'lost' WHERE id = ?`).bind(r).run();
    const again = await call('/api/runs/:id/restart', { id: r }, {}, patched({ RUN_WORKFLOW: wf as never }));
    expect(await again.json()).toMatchObject({ instance_id: `${r}-r2` });
    await waitDone(r);
  });
  it('does not trust status: a running-forever run restarts from generating', async () => {
    const r = uid('rs'); await seedRun(r, { status: 'generating', committed: 1 }); fakeLlm();
    await env.RUN_WORKFLOW.create({ id: r, params: { run_id: r } });
    const res = await call('/api/runs/:id/restart', { id: r }, {});
    expect(res.status).toBe(200);
  });
  it('done → 409', async () => {
    const r = uid(); await seedRun(r, { status: 'done' });
    const res = await call('/api/runs/:id/restart', { id: r }, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WRONG_STATE' });
  });
});

async function seedStopped(r: string) {
  await db.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'x' WHERE id = ?`).bind(r).run();
}

describe('test 11: mark-stopped', () => {
  it('leaves open units open, needs a reason, refuses done', async () => {
    const r = uid(); await seedRun(r, { status: 'generating' });
    await db.prepare(`INSERT INTO units (run_id, customer_id, status) VALUES (?, 'a', 'admitted')`).bind(r).run();
    expect((await call('/api/runs/:id/mark-stopped', { id: r }, {})).status).toBe(400);
    expect((await call('/api/runs/:id/mark-stopped', { id: r }, { reason: 'operator' })).status).toBe(200);
    expect(await runRow(r)).toMatchObject({ status: 'stopped', stop_reason: 'operator' });
    expect((await unit(r, 'a'))?.status).toBe('admitted');
    const d = uid(); await seedRun(d, { status: 'done' });
    expect((await call('/api/runs/:id/mark-stopped', { id: d }, { reason: 'x' })).status).toBe(409);
  });
});

describe('test 12: DEV_FAULT', () => {
  it('throw:<key> throws non-retryable in prep, for that key only', async () => {
    const r = uid(); await seedRun(r); allFx();
    await pin(env, r);
    const e = patched({ DEV_FAULT: 'throw:fx-both' });
    await expect(prep(e, r, 'fx-both')).rejects.toMatchObject({ name: 'NonRetryableError' });
    await expect(prep(e, r, 'fx-email')).resolves.toBe('ready');
  });
  it('pause_after_answer:<key> holds after the answer, before the write, for that key only', async () => {
    const r = await admitted(KEY); fakeLlm();
    let held = 0;
    seam.pause = async () => { held++; };
    await gen(patched({ DEV_FAULT: 'pause_after_answer:other' }), r, KEY, 1);
    expect(held).toBe(0);
    const s = await admitted(KEY); 
    seam.pause = async () => { held++; expect(await generation(s, KEY, 1)).toBeNull(); };
    await gen(patched({ DEV_FAULT: `pause_after_answer:${KEY}` }), s, KEY, 1);
    expect(held).toBe(1);
    expect((await generation(s, KEY, 1))?.result_type).toBe('answered');
  });
});

describe('test 14: a run stays on its pinned version', () => {
  it('activating a new version mid-run leaves requests on the pinned one', async () => {
    const r = await admitted(KEY);
    const asked: string[] = [];
    useFakes({ loadVersion: async (d, id, b) => { asked.push(id); return fakeLib.loadVersion(d, id, b); },
      activeVersions: async () => { throw new Error('a step must not read active'); },
      buildRequest: (p, q, c, x, prompt, retry) => { expect(prompt).toEqual(fxPrompt); expect(q.prompt_version).toBe('v1'); return fakeLib.buildRequest(p, q, c, x, prompt, retry); } });
    fakeLlm(); await gen(env, r, KEY, 1); await finish(env, r, KEY, 1);
    expect(asked).toContain('v1');
    expect(asked).not.toContain('v2');
  });
  it('a tampered version fails that unit INTERNAL_ERROR, alone', async () => {
    const r = uid(); await seedRun(r); allFx();
    useFakes({ loadVersion: async () => { throw new Error('TAMPERED'); } });
    await pin(env, r);                                            // a bad Jev row turns Jev off, it does not end the run
    await expect(prep(env, r, KEY)).rejects.toThrow('TAMPERED');
    await failUnit(env, r, KEY, new Error('TAMPERED'));
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
    await expect(prep(env, r, 'fx-email')).rejects.toThrow();
  });
});

describe('prep', () => {
  it('step 5: a catalog render that throws → failed INVALID_PICK at $0', async () => {
    const r = uid(); await seedRun(r); allFx();
    useFakes({ renderCatalog: () => { throw new Error('no image'); } });
    await pin(env, r);
    await expect(prep(env, r, KEY)).resolves.toBe('failed');
    expect(await unit(r, KEY)).toMatchObject({ status: 'failed', code: 'INVALID_PICK' });
  });
  it('step 5: an X1–X3 failure on the catalog part → failed INVALID_PICK', async () => {
    const r = uid(); await seedRun(r); allFx();
    await pin(env, r);
    seam.rendered = (rendered) => { expect(rendered.email).toBeNull(); return [{ id: 'X2', part: 'catalog', severity: 'hard', pass: false }]; };
    await expect(prep(env, r, KEY)).resolves.toBe('failed');
  });
  it('finish: a rendered failure (X2) counts as a hard failure: stored, E3, retried', async () => {
    const r = await admitted(KEY); fakeLlm();
    seam.rendered = () => [{ id: 'X2', part: 'email', severity: 'hard', pass: false }];
    await db.prepare('UPDATE runs SET pool_usd = 1 WHERE id = ?').bind(r).run();
    await gen(env, r, KEY, 1);
    expect(await finish(env, r, KEY, 1)).toEqual({ retry: true });
    expect(await draft(r, KEY, 1)).toMatchObject({ status: 'failed', hard_failures: 1 });
  });
  it('a plan row is stored for every unit; a replay is read back, not recomputed; run_id and created_at are ours', async () => {
    const r = uid(); await seedRun(r); allFx();
    await pin(env, r);
    let planned = 0;
    useFakes({ planCustomer: (i, _r, _k, _c, p) => { planned++; return { ...fxPlan(i.key), pinned: p, format: p.format, run_id: '', created_at: p.run_date }; } });
    await prep(env, r, 'row:3'); await prep(env, r, KEY); await prep(env, r, KEY);
    expect(planned).toBe(2);
    const row = await db.prepare('SELECT plan_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(r, 'row:3').first<{ plan_json: string }>();
    const stored = JSON.parse(row!.plan_json) as Plan;
    expect(stored.created_at).toMatch(/T.*Z$/);
    expect(stored).toMatchObject({ run_id: r, outcome: { kind: 'failed', code: 'INVALID_CUSTOMER' } });
    expect(await unit(r, 'row:3')).toMatchObject({ status: 'failed', code: 'INVALID_CUSTOMER' });
  });
  it('pin writes one pending unit per item, in ascending key order, and records Jev off', async () => {
    const r = uid(); await seedRun(r); allFx();
    useFakes({ jevPreflight: async () => ({ ok: false, reason: 'no key' }) });
    const { keys } = await pin(env, r);
    expect(keys).toEqual([...FX_KEYS].sort());
    expect(await units(r)).toMatchObject({ 'fx-both': 'pending' });
    expect((await runRow(r))?.jev_disabled_reason).toBe('no key');
  });
});
