// lane ship, part 1: the three read-only screens on fixture rows, and test 3.
import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../../src/worker/index.ts';
import { routes } from '../../src/worker/routes/demo.ts';
import { renderEvals } from '../../src/ui/demo/index.ts';
import { NAV } from '../../src/contracts/nav.ts';
import type { AppEnv } from '../../src/contracts/types.ts';
import evalReport from '../../reports/eval.json' with { type: 'json' };
import readiness from '../../reports/readiness.json' with { type: 'json' };

const db = (env as unknown as { DB: D1Database }).DB;
const get = async (path: string) => { const r = await exports.default.fetch(new Request(`https://x.test${path}`)); return { status: r.status, html: await r.text() }; };

function run(id: string, stage: string, spent: number) {
  return db.prepare(`INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting,
    prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, committed_usd, spent_usd, status, created_by, created_at)
    VALUES (?1, ?1, ?2, 'both', 's', 'd', 'c', 'k', 1, 'r', 's', 'v1', 'v1', 'sh', 'j', 'jev-v1', 1.25, 2, 'p', 0.79, 0.9, ?3, 'done', 'o', ?4)`).bind(id, stage, spent, `2026-11-01T0${spent ? 2 : 1}:00:00Z`);
}
function draft(id: string, c: string, status: string, format: string, actor: string) {
  const approved = status === 'approved' || status === 'released';
  return db.prepare(`INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json, content_sha256,
    checks_json, hard_failures, status, approved_by, approved_sub, approved_at, approved_sha256, released_by, released_sub, released_at)
    VALUES (?1, 'run-f', ?2, 1, ?4, 's', 'v', 'm', '{}', '{}', '{}', 'abcdef123456', '[]', 0, ?3, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(id, c, status, format, approved ? actor : null, approved ? 'sub' : null, approved ? 't1' : null, approved ? 'abcdef123456' : null,
      status === 'released' ? actor : null, status === 'released' ? 'sub' : null, status === 'released' ? 't2' : null);
}

beforeAll(async () => {
  await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
  await db.batch([run('run-f', 'F', 0.71), run('run-iso', 'isolation', 0),
    db.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES ('run-f', 'c01', '{"display_name":"<b>Meera</b>"}', 't')`),
    db.prepare(`INSERT INTO cost_events (run_id, customer_id, attempt, setting, action, call_state, charged_usd, at) VALUES ('run-f', 'c01', 1, 's', 'admit', 'answered', 0.03, 't'), ('run-f', 'c02', 1, 's', 'skip', 'blocked', NULL, 't')`),
    db.prepare(`INSERT INTO jev_events (run_id, customer_id, attempt, model_requested, status, charged_usd, basis_usd, at) VALUES ('run-f', 'c01', 1, 'j', 'answered', 0.0005, 0.0005, 't')`),
    draft('run-f:c01:v1', 'c01', 'released', 'both', 'seed-demo@local'), draft('run-f:c02:v1', 'c02', 'released', 'email', 'judge@x.test'),
    draft('stub-x:c05:v1', 'c05', 'released', 'both', 'judge@x.test'), draft('run-f:c03:v1', 'c03', 'approved', 'both', 'seed-demo@local'), draft('run-f:c04:v1', 'c04', 'in_review', 'both', '')]);
});

describe('screens', () => {
  it('demo routes are GET only', () => expect(routes.every((r) => r.method === 'GET')).toBe(true));
  for (const n of NAV.filter((x) => /spend|published|evals/.test(x.href))) {
    it(`${n.href} loads with the nav, its entry current`, async () => {
      const { status, html } = await get(n.href);
      expect(status).toBe(200);
      for (const m of NAV) expect(html).toContain(`href="${m.href}"`);
      expect(html).toContain(`<a href="${n.href}" aria-current="page">`);
    });
  }
  it('spend: every run with its figures, Jev spend, cap actions', async () => {
    const { html } = await get('/review/spend');
    for (const s of ['run-f', 'isolation', '$0.7900', '$0.7100', '$1.2500', '$2.0000', '$0.0005', 'admit 1', 'skip 1']) expect(html).toContain(s);
  });
  it('published: released only, three part links for both, two for email, seeded label, name escaped', async () => {
    const { html } = await get('/review/published');
    expect(html).toContain('/released/run-f%3Ac01%3Av1?part=landing_page');
    expect(html).toContain('/released/run-f%3Ac01%3Av1?part=catalog');
    expect(html).toContain('/released/run-f%3Ac02%3Av1?part=email');
    expect(html).not.toContain('/released/run-f%3Ac02%3Av1?part=landing_page');
    expect(html).not.toContain('c03');
    expect(html).not.toContain('c04');
    expect(html).toContain('seeded');
    expect(html).toContain('judge@x.test');
    expect(html).toContain('&lt;b&gt;Meera&lt;/b&gt;');
    expect(html).toContain('abcdef12');
  });
  it('evals: the page shows the committed reports, not a placeholder', async () => {
    const { html } = await get('/review/evals');
    expect(html).not.toContain('not run yet');
    expect(html).toContain(`cases <code>${evalReport.totals.cases}</code>`);
    for (const l of readiness.lines) expect(html).toMatch(new RegExp(`<td>${l.id}</td>.*?<td>${l.verdict}</td>`));
    for (const n of evalReport.named_failures) expect(html).toContain(n.label);
  });
  it('timeline: a run loads per customer, names escaped; an unknown run is 404', async () => {
    await db.prepare(`INSERT INTO units (run_id, customer_id, status, code, billed_attempts) VALUES ('run-f', 'c01', 'failed', 'CHECKS_FAILED', 1)`).run();
    const { status, html } = await get('/review/runs/run-f');
    expect(status).toBe(200);
    expect(html).toContain('&lt;b&gt;Meera&lt;/b&gt;');
    expect(html).not.toContain('<b>Meera');
    expect(html).toContain('Cap check');
    expect(html).toContain('Each step in detail');
    expect((await get('/review/runs/nope')).status).toBe(404);
  });
  it('published: a stub run is labelled, a real one is not', async () => {
    const { html } = await get('/review/published');
    expect(html.match(/<td>[^<]*<code>c05<\/code> · stub draft/)).not.toBeNull();
    expect(html).not.toMatch(/c02<\/code> · stub/);
  });
  it('evals: shows a report as given, escaped', () => {
    const html = renderEvals({ eval: { cases: 171, note: '<x>', rows: [{ id: 'C2', pass: true }] }, readiness: null });
    expect(html).toContain('171');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('C2');
    expect(html).toContain('not run yet');
  });
});

describe('test 3: run routes answer 503 when deployed', () => {
  const deployed = { ...(env as unknown as AppEnv), DEPLOYED: '1' } as AppEnv;
  const call = (path: string) => worker.fetch(new Request(`https://x.test${path}`, { method: 'POST' }) as never, deployed, {} as ExecutionContext);
  // ponytail: `run` owns routes/runs.ts and its own test 9; these stay `it.fails` on the M0 stub. They go red the moment run merges: then drop `.fails`, part 2.
  for (const p of ['/api/runs', '/api/runs/r/restart', '/api/runs/r/mark-stopped', '/api/ledger']) {
    it(`${p} → 503`, async () => expect((await call(p)).status).toBe(503));
  }
});
