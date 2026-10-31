import { loadCatalog } from '../../lib/catalog/index.ts';
import { BUNDLE } from '../../lib/config/bundle.ts';
import { ConfigErr, activateVersion, activeVersions, dismissFlag, evalValidity, listVersions, loadVersion, readVersion, saveVersion, validateVersion } from '../../lib/config/index.ts';
import { j3Input, judgeDraft } from '../../lib/jev/index.ts';
import { agentsPage, versionPage } from '../../ui/agents/index.ts';
import type { ErrorCode } from '../../contracts/codes.ts';
import type { ConfigKind, DraftRow, EvalValidity, JevConfig, Plan } from '../../contracts/types.ts';
import type { Ctx, Route } from './list.ts';

const STATUS: Partial<Record<ErrorCode, number>> = { CONFIG_MISSING: 503, BAD_INPUT: 400, FORBIDDEN: 403, NOT_FOUND: 404 };
const page = (html: string) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const guarded = (h: (c: Ctx) => Promise<Response>) => async (c: Ctx) => {
  try {
    return await h(c);
  } catch (e) {
    if (e instanceof ConfigErr) return Response.json({ code: e.code, detail: e.detail }, { status: STATUS[e.code] ?? 409 });
    throw e;
  }
};
/** Local only: no write to config and no model call on the link. */
const local = (h: (c: Ctx) => Promise<Response>) => guarded((c) => (c.env.DEPLOYED === '1'
  ? Promise.resolve(Response.json({ code: 'MISSING_CONFIG', detail: 'read-only on the link' }, { status: 503 })) : h(c)));

async function body(c: Ctx): Promise<Record<string, unknown>> {
  const b: unknown = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') throw new ConfigErr('BAD_INPUT', 'body');
  return b as Record<string, unknown>;
}
const param = (c: Ctx, name: string) => decodeURIComponent(c.params[name]);

async function validity(db: D1Database): Promise<EvalValidity[]> {
  try {
    return await evalValidity(db);
  } catch (e) {
    if (e instanceof ConfigErr && e.code === 'CONFIG_MISSING') return [];   // nothing seeded yet
    throw e;
  }
}

async function judge(c: Ctx): Promise<Response> {
  const started = Date.now();
  const { draft_id } = await body(c);
  if (typeof draft_id !== 'string') throw new ConfigErr('BAD_INPUT', 'draft_id');
  const v = await loadVersion(c.env.DB, param(c, 'id'), BUNDLE);
  if (v.kind !== 'jev') throw new ConfigErr('BAD_INPUT', 'not a jev version');
  const d = await c.env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(draft_id).first<DraftRow>();
  if (!d) throw new ConfigErr('NOT_FOUND');
  const plan = await c.env.DB.prepare('SELECT plan_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(d.run_id, d.customer_id).first<{ plan_json: string }>();
  if (!plan) throw new ConfigErr('NOT_FOUND', 'plan');
  const cat = await loadCatalog(c.env, d.snapshot_id);
  const outcome = await judgeDraft(c.env, j3Input(d, JSON.parse(plan.plan_json) as Plan, cat), v.content as JevConfig);
  console.log(JSON.stringify({ run_id: d.run_id, key: d.customer_id, step: 'judge', status: outcome.status, ms: Date.now() - started, est_usd: outcome.basis_usd, charged_usd: outcome.charged_usd }));
  await c.env.DB.prepare('INSERT INTO ledger_manual (at, item, usd, note, actor_email) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), 'jev judge', outcome.charged_usd ?? outcome.basis_usd, `${v.id} on ${draft_id}, ${outcome.status}`, c.actor.kind === 'system' ? 'system' : c.actor.email).run();
  return Response.json(outcome);
}

export const routes: Route[] = [
  { method: 'GET', path: '/review/agents', handler: guarded(async (c) => page(agentsPage(await listVersions(c.env.DB), await validity(c.env.DB)))) },
  { method: 'GET', path: '/review/agents/:id', handler: guarded(async (c) => {
    const v = await readVersion(c.env.DB, param(c, 'id'));
    if (!v) throw new ConfigErr('NOT_FOUND');
    const q = new URL(c.req.url).searchParams;
    const baseId = q.get('against') ?? v.parent_id;
    const base = baseId ? await readVersion(c.env.DB, baseId) : null;
    return page(versionPage({ v, baseId, base: base?.kind === v.kind ? base : null, file: q.get('file'), result: validateVersion(v), versions: await listVersions(c.env.DB),
      deployed: c.env.DEPLOYED === '1' }));
  }) },
  { method: 'GET', path: '/api/config/:id', handler: guarded(async (c) => {
    const id = param(c, 'id');
    if (id === 'active') return Response.json(await activeVersions(c.env.DB));   // for `config import`; no version is ever named this
    const v = await readVersion(c.env.DB, id);
    if (!v) throw new ConfigErr('CONFIG_MISSING');
    return Response.json(v);
  }) },
  { method: 'POST', path: '/api/config', origin: true, handler: local(async (c) => {
    const { kind, parent_id, content, note } = await body(c);
    if ((kind !== 'prompt' && kind !== 'jev') || (parent_id !== null && typeof parent_id !== 'string') || typeof note !== 'string') throw new ConfigErr('BAD_INPUT');
    return Response.json(await saveVersion(c.env.DB, kind as ConfigKind, parent_id, content as JevConfig, note, c.actor));   // actor from auth, never the body
  }) },
  { method: 'POST', path: '/api/config/:id/activate', origin: true, handler: local(async (c) => Response.json(await activateVersion(c.env.DB, param(c, 'id'), c.actor))) },
  { method: 'POST', path: '/api/config/:id/judge', origin: true, handler: local(judge) },
  { method: 'POST', path: '/api/drafts/:id/flags/:question/dismiss', origin: true, handler: guarded(async (c) => {
    const id = param(c, 'id');
    const form = !c.req.headers.get('content-type')?.includes('json');   // flagRow's plain form posts urlencoded
    const note = form ? (await c.req.formData()).get('note') : (await body(c)).note;
    if (typeof note !== 'string') throw new ConfigErr('BAD_INPUT', 'note');
    await dismissFlag(c.env, id, param(c, 'question'), note, c.actor);
    return form ? new Response(null, { status: 303, headers: { location: `/review/${encodeURIComponent(id)}` } }) : Response.json({ ok: true });
  }) },
];
