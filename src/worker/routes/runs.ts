// Run routes. Every one answers 503 on the link. Actor comes from auth only.
import capJson from '../../../config/cap.json' with { type: 'json' };
import shapes from '../../../config/shapes.json' with { type: 'json' };
import stagesJson from '../../../config/stages.json' with { type: 'json' };
import { NotBuilt } from '../../contracts/codes.ts';
import type { ErrorCode } from '../../contracts/codes.ts';
import type { JevConfig, PlanPreview, Stage, StagesFile } from '../../contracts/types.ts';
import { sha256Hex } from '../../lib/config/bundle.ts';
import { RUNGS, capRun } from '../../lib/cost/index.ts';
import { activeVersions } from '../../lib/config/index.ts';
import { ingestTsv, onlyCustomer } from '../../lib/ingest.ts';
import { parseRecs } from '../../lib/recs.ts';
import { seam } from '../../lib/state/index.ts';
import { isStub } from '../../ui/shell.ts';
import { checkRunKey } from '../run-key.ts';
import type { Ctx, Route } from './list.ts';

const L = () => seam.lib ?? { ingestTsv, parseRecs, activeVersions };
const stages = stagesJson as StagesFile;
const fail = (status: number, code: ErrorCode, detail?: string) => Response.json({ code, detail }, { status });
const bad = (detail: string) => fail(400, 'BAD_INPUT', detail);
const stale = (detail: string) => fail(409, 'PREVIEW_STALE', detail);
const live = (handler: (c: Ctx) => Promise<Response>) => (c: Ctx) => (c.env.DEPLOYED === '1' ? fail(503, 'MISSING_CONFIG', 'read-only deployment') : handler(c));
const json = async (c: Ctx): Promise<Record<string, unknown> | null> => {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
};

/** Header `x-run-key`. Body: `{run_id, stage, snapshot_id, customers_name, customers_tsv, customers_synthetic, recs_json, preview_sha256, only?}`. `only` cuts the file to one customer, and the preview must have been built on that cut. Both files travel as their exact bytes, because the preview hashes the bytes. Format and start rung come from the preview. */
async function create(c: Ctx): Promise<Response> {
  const denied = await keyDenied(c.env, c.req.headers.get('x-run-key'));
  if (denied) return denied;
  const b = await json(c);
  if (!b) return bad('body');
  return createRun(c, b);
}

/** A 403 or 429 before anything else is read, so a wrong key reaches no model, no bucket and no row. */
export async function keyDenied(env: Ctx['env'], given: unknown): Promise<Response | null> {
  const r = await checkRunKey(env, given);
  return r === 'ok' ? null : r === 'limited' ? fail(429, 'TOO_MANY_TRIES') : fail(403, 'FORBIDDEN', 'run key');
}

/** The key has passed. Shared by POST /api/runs and the Start a run form. */
export async function createRun(c: Ctx, b: Record<string, unknown>): Promise<Response> {
  const { env } = c; const db = env.DB;
  if ('cap_run_usd' in b) return bad('cap_run_usd is computed, never sent');
  const { run_id, stage, snapshot_id, customers_name, customers_synthetic, recs_json, preview_sha256, only } = b;
  let customers_tsv = b.customers_tsv;
  if (typeof run_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(run_id)) return bad('run_id');
  if (env.ANTHROPIC_BASE_URL && !isStub(run_id)) return bad('a run on a stub base URL needs a stub- run id, so the page can label it');
  if (typeof stage !== 'string' || !(stage in stages)) return bad('stage');
  if (typeof snapshot_id !== 'string' || typeof customers_name !== 'string' || typeof customers_tsv !== 'string'
    || typeof customers_synthetic !== 'boolean' || typeof preview_sha256 !== 'string' || !/^[0-9a-z-]+$/.test(preview_sha256) || typeof recs_json !== 'string') return bad('fields');
  if (customers_name.includes('.synthetic.') !== customers_synthetic) return bad('customers_synthetic disagrees with the file name');
  if (only !== undefined) {
    if (typeof only !== 'string') return bad('only');
    try { customers_tsv = onlyCustomer(customers_tsv, only); } catch { return bad('only'); }
  }
  const tsv = customers_tsv as string;
  try {
    if (L().ingestTsv(tsv).length === 0) return bad('no rows');
    L().parseRecs(JSON.parse(recs_json));
  } catch (e) {
    if (e instanceof NotBuilt) throw e;
    return bad(e instanceof Error ? e.message : 'file does not parse');
  }

  const snap = await db.prepare('SELECT synthetic FROM snapshots WHERE id = ?').bind(snapshot_id).first<{ synthetic: number }>();
  if (!snap || snap.synthetic) return bad('snapshot');

  let active;
  try { active = await L().activeVersions(db); } catch (e) {
    if ((e as { code?: string }).code === 'CONFIG_MISSING') return fail(503, 'CONFIG_MISSING');
    throw e;
  }
  const obj = await env.BUCKET.get(`previews/${preview_sha256}.json`);
  if (!obj) return stale('no preview');
  const p = JSON.parse(await obj.text()) as PlanPreview;
  const customers_sha256 = await sha256Hex(tsv); const recs_sha256 = await sha256Hex(recs_json);
  const same: [string, unknown, unknown][] = [['customers', p.customers_sha256, customers_sha256], ['recs', p.recs_sha256, recs_sha256], ['snapshot', p.snapshot_id, snapshot_id],
    ['prompt_version', p.prompt_version, active.prompt.id], ['prompt_sha256', p.prompt_sha256, active.prompt.sha256], ['cap', p.cap_sha256, await sha256Hex(JSON.stringify(capJson))]];
  const off = same.find(([, a, b2]) => a !== b2);
  if (off) return stale(off[0]);
  if (!RUNGS.some((r) => r.id === p.start_rung)) return stale('rung');

  const { ceiling_usd, cap_run_usd } = capRun(p);
  const s = stages[stage as Stage];
  const customers_r2_key = `customers/${customers_sha256}.tsv`;
  await Promise.all([env.BUCKET.put(customers_r2_key, tsv), env.BUCKET.put(`recs/${recs_sha256}.json`, recs_json)]);
  const creator = c.actor.kind === 'system' ? 'system' : c.actor.email;
  const res = await db.prepare(`INSERT OR IGNORE INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256,
    setting, prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, jev_reserve_usd, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status, created_by, created_at)
    VALUES (?1, ?1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`).bind(run_id, stage, p.format, snapshot_id, p.plans[0]?.pinned.run_date ?? new Date().toISOString().slice(0, 10),
    customers_sha256, customers_r2_key, customers_synthetic ? 1 : 0, recs_sha256, p.start_rung, active.prompt.id, active.prompt.voice_guide_version, p.plans[0]?.pinned.shapes_sha256 ?? await sha256Hex(JSON.stringify(shapes)),
    (active.jev.content as JevConfig).model, active.jev.id, p.jev_reserve_usd, cap_run_usd, ceiling_usd, preview_sha256, s.expected_usd / s.runs, creator, new Date().toISOString()).run();
  if (res.meta.changes !== 1) return fail(409, 'RUN_ID_REUSED');
  try {
    await env.RUN_WORKFLOW?.create({ id: run_id, params: { run_id } });
  } catch (e) {
    if (/already_exists/.test(String(e))) return fail(409, 'RUN_ID_REUSED');
    throw e;
  }
  return Response.json({ run_id, status: 'preparing', cap_run_usd, ceiling_usd }, { status: 201 });
}

interface RunState { status: string; instance_id: string; committed_usd: number }
const state = (c: Ctx) => c.env.DB.prepare('SELECT status, instance_id, committed_usd FROM runs WHERE id = ?').bind(c.params.id).first<RunState>();

/** Never reads `instance.status()`: a killed instance reports `running` forever. Every step reads its own output, so re-entry is safe on either branch. */
async function restart(c: Ctx): Promise<Response> {
  const { env } = c; const run_id = c.params.id;
  const run = await state(c);
  if (!run) return fail(404, 'NOT_FOUND');
  if (run.status === 'done') return fail(409, 'WRONG_STATE');
  const wrote = run.committed_usd > 0 || !!await env.DB.prepare('SELECT 1 FROM plans WHERE run_id = ? AND admission_json IS NOT NULL LIMIT 1').bind(run_id).first();
  const status = wrote ? 'generating' : 'preparing';
  const up = await env.DB.prepare(`UPDATE runs SET status = ?, stop_reason = NULL WHERE id = ? AND status <> 'done'`).bind(status, run_id).run();
  if (up.meta.changes !== 1) return fail(409, 'WRONG_STATE');
  const wf = env.RUN_WORKFLOW;
  if (!wf) return fail(503, 'MISSING_CONFIG');
  try {
    await (await wf.get(run.instance_id)).restart();
    return Response.json({ run_id, status, branch: 'restart', instance_id: run.instance_id });
  } catch {
    const n = Number(/-r(\d+)$/.exec(run.instance_id)?.[1] ?? 0) + 1;
    const instance_id = `${run_id}-r${n}`;
    await env.DB.prepare('UPDATE runs SET instance_id = ? WHERE id = ?').bind(instance_id, run_id).run();
    await wf.create({ id: instance_id, params: { run_id } });
    return Response.json({ run_id, status, branch: 'new_instance', instance_id });
  }
}

/** Open units stay as they are. The instance is stopped too, best effort, so a stopped run spends nothing more. */
async function markStopped(c: Ctx): Promise<Response> {
  const b = await json(c); const reason = b?.reason;
  if (typeof reason !== 'string' || !reason.trim()) return bad('reason');
  const run = await state(c);
  if (!run) return fail(404, 'NOT_FOUND');
  const up = await c.env.DB.prepare(`UPDATE runs SET status = 'stopped', stop_reason = ? WHERE id = ? AND status IN ('preparing', 'generating')`).bind(reason, c.params.id).run();
  if (up.meta.changes !== 1) return fail(409, 'WRONG_STATE');
  try { await (await c.env.RUN_WORKFLOW?.get(run.instance_id))?.terminate(); } catch { /* a dead or finished instance is the point */ }
  return Response.json({ run_id: c.params.id, status: 'stopped' });
}

async function ledger(c: Ctx): Promise<Response> {
  const b = await json(c);
  if (typeof b?.item !== 'string' || typeof b.usd !== 'number' || !Number.isFinite(b.usd) || typeof b.note !== 'string' || !b.note.trim()) return bad('item, usd, note');
  const email = c.actor.kind === 'system' ? 'system' : c.actor.email;
  await c.env.DB.prepare('INSERT INTO ledger_manual (at, item, usd, note, actor_email) VALUES (?, ?, ?, ?, ?)').bind(new Date().toISOString(), b.item, b.usd, b.note, email).run();
  return Response.json({ ok: true }, { status: 201 });
}

export const routes: Route[] = [
  { method: 'POST', path: '/api/runs', handler: live(create) },
  { method: 'POST', path: '/api/runs/:id/restart', handler: live(restart) },
  { method: 'POST', path: '/api/runs/:id/mark-stopped', handler: live(markStopped) },
  { method: 'POST', path: '/api/ledger', handler: live(ledger) },
];
