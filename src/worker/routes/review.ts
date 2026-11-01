// Calls `transition` and reads rows; holds no state logic and computes no flag.
import { NotBuilt } from '../../contracts/codes.ts';
import type { ErrorCode } from '../../contracts/codes.ts';
import type { AppEnv, CheckResult, DraftStatus, Edge, Envelope, FlagView, JevConfig, Plan, RenderedJson, RunFormat, UnitStatus } from '../../contracts/types.ts';
import { BUNDLE } from '../../lib/config/bundle.ts';
import { loadVersion, reviewFlags } from '../../lib/config/index.ts';
import { runReport, transition } from '../../lib/state/index.ts';
import { landingLink } from '../../lib/render/email.ts';
import { flagRow } from '../../ui/agents/index.ts';
import { shell } from '../../ui/shell.ts';
import { draftPage, plansPage, runsPage } from '../../ui/review.ts';
import type { DraftView, EventRow, RunRow, UnitView } from '../../ui/review.ts';
import { generatedBy, madeByLine } from '../../ui/evidence.ts';
import { runJson } from '../../ui/run-json.ts';
import { customerTimeline, runTimeline } from '../../ui/timeline.ts';
import type { CostIn, CustomerData, DraftIn, EventIn, GenIn, JevIn, RunIn, UnitIn } from '../../ui/timeline.ts';
import type { Ctx, Route } from './list.ts';

// srcdoc inherits this, so the frame has two locks: sandbox="" and script-src 'none'.
const CSP = "default-src 'none'; script-src 'none'; img-src https://cdn.shopify.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// Dynamic: lib.ts binds every module, and a route file must not fail to load under a test's partial vi.mock of one of them.
const contentSha256 = async (e: string, m: string, r: string) => (await import('../../contracts/lib.ts')).contentSha256(e, m, r);
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
const fail = (http: number, code: ErrorCode, detail?: string) => Response.json({ code, detail }, { status: http });
// R109: flagRow takes the draft id.
const rowFor: (f: FlagView, draft_id: string) => string = flagRow;

async function flagsOf(env: AppEnv, id: string): Promise<FlagView[] | null> {
  try { return await reviewFlags(env, id); } catch (e) { if (e instanceof NotBuilt) return null; throw e; }
}
const parseJson = <T>(s: string | null): T | null => (s ? JSON.parse(s) as T : null);
const idOf = (c: Ctx) => { try { return decodeURIComponent(c.params.id); } catch { return c.params.id; } };

async function runs(c: Ctx): Promise<Response> {
  const db = c.env.DB;
  const deployed = c.env.DEPLOYED === '1';
  try {
    const list = (await db.prepare('SELECT id, stage, created_at, status, snapshot_id, jev_disabled_reason FROM runs ORDER BY created_at DESC, id').all<RunRow>()).results;
    const want = new URL(c.req.url).searchParams.get('run');
    const run = list.find((r) => r.id === want) ?? list[0] ?? null;
    if (!run) return html(runsPage([], null, null, [], deployed, false, !!c.env.RUN_KEY));
    const report = await runReport(db, run.id);
    const units = (await db.prepare(`SELECT u.customer_id, u.status, u.code, p.plan_json FROM units u LEFT JOIN plans p ON p.run_id = u.run_id AND p.customer_id = u.customer_id
      WHERE u.run_id = ? ORDER BY u.customer_id`).bind(run.id).all<{ customer_id: string; status: UnitStatus; code: string | null; plan_json: string | null }>()).results;
    const drafts = (await db.prepare('SELECT id, customer_id, status, checks_json FROM drafts WHERE run_id = ? ORDER BY version')
      .bind(run.id).all<{ id: string; customer_id: string; status: DraftStatus; checks_json: string }>()).results;
    const latest = new Map(drafts.map((d) => [d.customer_id, d]));   // ordered by version: the last write is the latest
    const views = await Promise.all(units.map(async (u): Promise<UnitView> => {
      const d = latest.get(u.customer_id);
      return { customer_id: u.customer_id, status: u.status, code: u.code, plan: parseJson<Plan>(u.plan_json),
        draft: d ? { id: d.id, status: d.status, checks: JSON.parse(d.checks_json) as CheckResult[] } : null, flags: d ? await flagsOf(c.env, d.id) : null };
    }));
    return html(runsPage(list, run, report, views, deployed, false, !!c.env.RUN_KEY));
  } catch (e) {
    if (e instanceof NotBuilt) throw e;
    console.error(JSON.stringify({ step: 'review', status: 'error', code: 'INTERNAL_ERROR' }));
    return html(runsPage([], null, null, [], deployed, true));   // ponytail: 200, because an empty local D1 must still load for `npm run smoke`
  }
}

/** The run with its pinned Jev config, so the gates shown are the ones that judged it. No config reads "not recorded". */
export async function runIn(env: AppEnv, id: string): Promise<RunIn | null> {
  const run = await env.DB.prepare('SELECT id, stage, snapshot_id, status, jev_disabled_reason, spent_usd, cap_run_usd, jev_reserve_usd, setting, prompt_version, format, pool_usd, jev_config_version FROM runs WHERE id = ?').bind(id).first<RunIn>();
  if (!run) return null;
  const jev = await loadVersion(env.DB, run.jev_config_version as string, BUNDLE).then((v) => v.content as JevConfig, () => null);
  const prompt_sha256 = await loadVersion(env.DB, run.prompt_version as string, BUNDLE).then((v) => v.sha256, () => null);
  return { ...run, jev, prompt_sha256 };
}

/** One run's recorded trail, per customer. `only` narrows it to one customer for the draft page. */
export async function trail(env: AppEnv, run: RunIn, only: string | null = null): Promise<CustomerData[]> {
  const run_id = run.id;
  const db = env.DB;
  const rows = async <T>(sql: string) => (await db.prepare(sql).bind(run_id, only).all<T>()).results;
  const mine = 'run_id = ?1 AND (?2 IS NULL OR customer_id = ?2)';
  const [units, plans, drafts, costs, jev, events, gens, held] = await Promise.all([
    rows<UnitIn>(`SELECT customer_id, status, code, error_detail FROM units WHERE ${mine} ORDER BY customer_id`),
    rows<{ customer_id: string; plan_json: string; created_at: string }>(`SELECT customer_id, plan_json, created_at FROM plans WHERE ${mine}`),
    rows<DraftIn>(`SELECT id, customer_id, version, status, hard_failures, model_json, json_extract(rendered_json, '$.catalog') AS catalog, json_extract(rendered_json, '$.email') AS email, json_extract(rendered_json, '$.landing_page') AS landing, checks_json, envelope_json, validator_version, model, content_sha256 FROM drafts WHERE ${mine} ORDER BY customer_id, version`),
    rows<CostIn>(`SELECT customer_id, attempt, action, call_state, input_tokens, est_usd, commit_usd, charged_usd, reason, at, setting, request_sha256 FROM cost_events WHERE ${mine}`),
    rows<JevIn>(`SELECT customer_id, attempt, status, reason, charged_usd, at, answers_json, input_tokens, ms FROM jev_events WHERE ${mine}`),
    rows<EventIn>(`SELECT e.draft_id, e.from_status, e.to_status, e.actor_email, e.at, e.note, e.content_sha256 FROM draft_events e JOIN drafts d ON d.id = e.draft_id WHERE d.run_id = ?1 AND (?2 IS NULL OR d.customer_id = ?2) ORDER BY e.id`),
    rows<GenIn>(`SELECT customer_id, attempt, result_type, stop_reason, usage_json, message_json, ms FROM generations WHERE ${mine}`),
    db.prepare(`SELECT customer_id, commit_usd FROM cost_events WHERE run_id = ? AND attempt = 1 AND action = 'admit'`).bind(run_id).all<{ customer_id: string; commit_usd: number }>().then((r) => r.results)]);
  const budget = (run.cap_run_usd ?? 0) - (run.jev_reserve_usd ?? 0);
  const budgetLeft = (key: string) => budget - held.filter((h) => h.customer_id <= key).reduce((t, h) => t + h.commit_usd, 0);   // admitAll's own walk: ascending key
  return Promise.all(units.map(async (unit) => {
    const key = unit.customer_id, plan = plans.find((p) => p.customer_id === key), mineD = drafts.filter((d) => d.customer_id === key), last = mineD.at(-1);
    const flags = last ? (await flagsOf(env, last.id))?.filter((f) => f.flagged && !f.dismissal).map((f) => f.question) ?? [] : [];
    return { unit, plan: parseJson<Plan>(plan?.plan_json ?? null), plan_at: plan?.created_at ?? null, drafts: mineD, costs: costs.filter((x) => x.customer_id === key), jev: jev.filter((x) => x.customer_id === key),
      events: events.filter((e) => mineD.some((d) => d.id === e.draft_id)), flags, gens: gens.filter((g) => g.customer_id === key), budgetLeft: budgetLeft(key) };
  }));
}

async function timeline(c: Ctx): Promise<Response> {
  const id = idOf(c);
  const run = await runIn(c.env, id);
  if (!run) return fail(404, 'NOT_FOUND', 'review run');
  return html(shell(`Timeline · ${run.id}`, '/review', `<p><a class="btn" href="/review?run=${encodeURIComponent(run.id)}">Back to the run</a></p>${runTimeline(run, await trail(c.env, run))}`));
}

/** One run as one document. Guarded by the same `authenticate` as every /review page. */
async function runDoc(c: Ctx): Promise<Response> {
  const run = await runIn(c.env, idOf(c));
  if (!run) return fail(404, 'NOT_FOUND', 'review run');
  const only = new URL(c.req.url).searchParams.get('customer');
  const customers = await trail(c.env, run, only);
  if (only && !customers.length) return fail(404, 'NOT_FOUND', 'review customer');
  return Response.json(runJson(run, customers), { headers: { 'content-security-policy': CSP } });
}

async function plans(c: Ctx): Promise<Response> {
  const id = idOf(c);
  const db = c.env.DB;
  if (!await db.prepare('SELECT 1 FROM runs WHERE id = ?').bind(id).first()) return fail(404, 'NOT_FOUND', 'review plans');
  const rows = (await db.prepare('SELECT customer_id, plan_json, admission_json FROM plans WHERE run_id = ? ORDER BY customer_id')
    .bind(id).all<{ customer_id: string; plan_json: string; admission_json: string | null }>()).results;
  const admissions = Object.fromEntries(rows.flatMap((r) => { const a = parseJson<{ action: string }>(r.admission_json); return a ? [[r.customer_id, a.action]] : []; }));
  return html(plansPage(id, rows.map((r) => JSON.parse(r.plan_json) as Plan), admissions));
}

interface DraftDb { id: string; run_id: string; customer_id: string; version: number; format: RunFormat; status: DraftStatus; model: string; snapshot_id: string; validator_version: string;
  envelope_json: string; model_json: string; rendered_json: string; content_sha256: string; checks_json: string; hard_failures: number; approved_by: string | null; approved_at: string | null;
  approved_sha256: string | null }

async function draft(c: Ctx): Promise<Response> {
  const id = idOf(c);
  const db = c.env.DB;
  let row: DraftDb | null;
  try { row = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftDb>(); } catch { return fail(500, 'INTERNAL_ERROR', 'review draft'); }
  if (!row) return fail(404, 'NOT_FOUND', 'review draft');
  const [planRow, events, siblings, flags, jev] = await Promise.all([
    db.prepare('SELECT plan_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(row.run_id, row.customer_id).first<{ plan_json: string }>(),
    db.prepare('SELECT from_status, to_status, actor_kind, actor_email, at, note FROM draft_events WHERE draft_id = ? ORDER BY id').bind(id).all<EventRow>(),
    db.prepare('SELECT id FROM drafts WHERE run_id = ? ORDER BY customer_id, version').bind(row.run_id).all<{ id: string }>(),
    flagsOf(c.env, id),
    db.prepare('SELECT status, reason FROM jev_events WHERE run_id = ? AND customer_id = ? AND attempt = ?').bind(row.run_id, row.customer_id, row.version).first<{ status: string; reason: string | null }>()]);
  const run = await runIn(c.env, row.run_id);
  const [mine] = run ? await trail(c.env, run, row.customer_id) : [];
  const q = new URL(c.req.url).searchParams;
  const at = siblings.results.findIndex((s) => s.id === id);
  const view: DraftView = { ...row, envelope: JSON.parse(row.envelope_json) as Envelope, rendered: JSON.parse(row.rendered_json) as RenderedJson, checks: JSON.parse(row.checks_json) as CheckResult[],
    hash_now: await contentSha256(row.envelope_json, row.model_json, row.rendered_json) };
  return html(draftPage(view, parseJson<Plan>(planRow?.plan_json ?? null), flags, (flags ?? []).map((f) => rowFor(f, id)).join(''), events.results, {
    part: q.get('part'), width: q.get('width') === '390' ? 390 : 1200, confirm: q.get('confirm') === 'release', done: q.get('done'), refused: q.get('refused'),
    prev: siblings.results[at - 1]?.id ?? null, next: siblings.results[at + 1]?.id ?? null, jev, timeline: run && mine ? customerTimeline(mine, run) : null, madeBy: run && mine ? madeByLine(generatedBy(mine, run, mine.drafts.find((x) => x.id === id))) : null }));
}

const EDGES: Record<string, Edge> = { approve: 'E4', reject: 'E5', revoke: 'E6', release: 'E7' };

async function noteOf(req: Request): Promise<string> {
  if (req.headers.get('content-type')?.includes('json')) {
    const b = await req.json().catch(() => null) as { note?: unknown } | null;
    return typeof b?.note === 'string' ? b.note.trim() : '';
  }
  const f = await req.formData().catch(() => null);
  const note = f?.get('note');
  return typeof note === 'string' ? note.trim() : '';
}

async function act(c: Ctx): Promise<Response> {
  const id = idOf(c);
  const action = c.params.action;
  const note = action === 'reject' ? await noteOf(c.req) : '';
  const page = c.req.headers.get('accept')?.includes('text/html');
  const back = (q: string) => new Response(null, { status: 303, headers: { location: `/review/${encodeURIComponent(id)}?${q}` } });
  if (action === 'reject' && !note) return page ? back('refused=BAD_INPUT') : fail(400, 'BAD_INPUT', 'a note is required');
  const r = await transition(c.env, id, EDGES[action], c.actor, note ? { note } : undefined);
  if (r.ok) return page ? back(`done=${r.status}`) : Response.json({ status: r.status });
  if (page) return back(`refused=${r.code}`);
  return Response.json({ code: r.code, detail: r.detail }, { status: r.http });
}

const PARTS = ['email', 'landing_page', 'catalog'] as const;

/** 200 only if released and the recomputed hash equals the approved one. The part is served with no script, as a sandbox of its own. */
async function released(c: Ctx): Promise<Response> {
  const part = PARTS.find((p) => p === new URL(c.req.url).searchParams.get('part'));
  if (!part) return fail(400, 'BAD_INPUT', 'part');
  const row = await c.env.DB.prepare('SELECT status, approved_sha256, envelope_json, model_json, rendered_json FROM drafts WHERE id = ?').bind(idOf(c)).first<DraftDb>();
  if (!row) return fail(404, 'NOT_FOUND', 'released');
  if (row.status !== 'released') return fail(409, 'WRONG_STATE', row.status);
  if (await contentSha256(row.envelope_json, row.model_json, row.rendered_json) !== row.approved_sha256) return fail(409, 'HASH_MISMATCH');
  const body = (JSON.parse(row.rendered_json) as RenderedJson)[part];
  if (body === null) return fail(404, 'NOT_FOUND', part);
  const page = part === 'email' ? landingLink(body, c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin, idOf(c)) : body;   // after the hash: the stored email stays as approved
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `sandbox; ${CSP}` } });
}

export const routes: Route[] = [
  { method: 'GET', path: '/review', handler: runs },
  { method: 'GET', path: '/review/runs/:id/plans', handler: plans },
  { method: 'GET', path: '/review/runs/:id.json', handler: runDoc },
  { method: 'GET', path: '/review/runs/:id', handler: timeline },
  { method: 'GET', path: '/review/:id', handler: draft },
  { method: 'POST', path: '/api/drafts/:id/:action(approve|reject|revoke|release)', origin: true, handler: act },
  { method: 'GET', path: '/released/:id', handler: released },
];
