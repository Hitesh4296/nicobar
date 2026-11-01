// Start a run by hand. The key travels only in the POST body, is checked before anything else, and is never echoed. Every route answers 503 on the link, as the run routes do.
import rowKeys from '../../../data/row_keys.synthetic.json' with { type: 'json' };
import capJson from '../../../config/cap.json' with { type: 'json' };
import shapes from '../../../config/shapes.json' with { type: 'json' };
import stagesJson from '../../../config/stages.json' with { type: 'json' };
import type { CapConfig, JevConfig, Pinned, PromptFiles, RunFormat, ShapesFile } from '../../contracts/types.ts';
import { sha256Hex } from '../../lib/config/bundle.ts';
import { activeVersions } from '../../lib/config/index.ts';
import { PRICES, RUNGS, capRun } from '../../lib/cost/index.ts';
import { loadCatalog } from '../../lib/catalog/index.ts';
import { ingestTsv, onlyCustomer } from '../../lib/ingest.ts';
import { planCustomer } from '../../lib/plan.ts';
import { previewBody } from '../../lib/preview.ts';
import { parseRecs, parseRowKeys } from '../../lib/recs.ts';
import { seam } from '../../lib/state/index.ts';
import { esc } from '../../ui/nb.ts';
import { emptyCard, shell } from '../../ui/shell.ts';
import { checkRunKey } from '../run-key.ts';
import { countTokens } from '../../workflow/steps.ts';
import { createRun } from './runs.ts';
import type { Ctx, Route } from './list.ts';

const L = () => seam.lib ?? { ingestTsv, parseRecs, parseRowKeys, loadCatalog, planCustomer, activeVersions };
const NAME = 'customers.with-c20.synthetic.tsv', FORMAT: RunFormat = 'both';
const page = (body: string, status = 200) => new Response(shell('Start a run', '/review', `<p class="eyebrow">Start a run</p><h1>Start a run</h1>${body}`), { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const refused = (status: number, title: string, why: string) => page(emptyCard(title, why), status);
const locked = () => refused(403, 'Runs are locked', 'No run key is set on this server, so no run can start.');
const off = (h: (c: Ctx) => Promise<Response>) => (c: Ctx) => (c.env.DEPLOYED === '1' ? Response.json({ code: 'MISSING_CONFIG', detail: 'read-only deployment' }, { status: 503 }) : h(c));

async function inputs(env: Ctx['env']) {
  const [t, r] = await Promise.all([env.BUCKET.get('inputs/customers.synthetic.tsv'), env.BUCKET.get('inputs/recommendations.synthetic.json')]);
  return t && r ? { tsv: await t.text(), recs: await r.text() } : null;
}

async function start(c: Ctx): Promise<Response> {
  const { env } = c;
  if (!env.RUN_KEY) return locked();
  const files = await inputs(env);
  if (!files) return refused(503, 'No inputs published', 'Run the build with --publish, then come back.');
  const q = new URL(c.req.url).searchParams, stage = q.get('stage'), only = q.get('only') || null;
  const ids = L().ingestTsv(files.tsv).map((i) => i.key);
  const chooser = `<form method="get" action="/review/start"><label>Customers <select name="only"><option value="">All</option>${ids.map((id) => `<option${id === only ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label> `
    + `<label>Stage <select name="stage">${Object.keys(stagesJson).map((s) => `<option${s === stage ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label> <button class="btn">Preview</button></form>`;
  if (!stage) return page(chooser);
  if (!(stage in stagesJson) || (only && !ids.includes(only))) return refused(400, 'Not a choice', 'Pick a stage and a customer from the lists.');

  const tsv = only ? onlyCustomer(files.tsv, only) : files.tsv;
  const recs = L().parseRecs(JSON.parse(files.recs));
  const cat = await L().loadCatalog(env, recs.snapshot_id);
  const active = await L().activeVersions(env.DB);
  const rung = RUNGS[0];
  const pinned: Pinned = { snapshot_id: cat.snapshot_id, customers_sha256: await sha256Hex(tsv), recs_sha256: await sha256Hex(files.recs), shapes_sha256: await sha256Hex(JSON.stringify(shapes)), run_date: new Date().toISOString().slice(0, 10),
    prompt_version: active.prompt.id, voice_guide_version: active.prompt.voice_guide_version ?? active.prompt.id, jev_model: (active.jev.content as JevConfig).model, jev_config_version: active.jev.id, format: FORMAT };
  const keys = L().parseRowKeys(rowKeys);
  const plans = L().ingestTsv(tsv).map((item) => ({ ...L().planCustomer(item, recs.rows.find((r) => r.customer_id === item.key) ?? null, keys, cat, pinned, shapes as ShapesFile), run_id: 'preview', ...(recs.generated_by ? { generated_by: { ranking: recs.generated_by } } : {}) }));
  const body = await previewBody({ prompt: active.prompt.content as PromptFiles, promptId: active.prompt.id, prompt_sha256: active.prompt.sha256, format: FORMAT, rung, pinned, plans, cat, cap: capJson as unknown as CapConfig, cap_sha256: await sha256Hex(JSON.stringify(capJson)),
    rungs: RUNGS, prices: PRICES, jev_basis_usd: (active.jev.content as JevConfig).basis_usd, count: (req) => countTokens(env, req) });
  const text = JSON.stringify(body), sha = await sha256Hex(text);
  await env.BUCKET.put(`previews/${sha}.json`, text);
  const est = body.plans.reduce((t, p) => t + (p.admission?.est_1_usd ?? 0), 0), { cap_run_usd } = capRun(body);
  const admitted = body.plans.filter((p) => p.admission?.action === 'admit').length;
  const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  return page(`${chooser}<h2>Preview</h2><div class="metrics"><div><span>Customers</span><b>${admitted} of ${body.plans.length}</b></div><div><span>Estimated cost</span><b>$${est.toFixed(4)}</b></div><div><span>Cap</span><b>$${cap_run_usd.toFixed(4)}</b></div></div>`
    + `<p class="note">Prompt ${esc(body.prompt_version)}, ${esc(body.start_rung)}, snapshot ${esc(body.snapshot_id)}. Nothing has been spent.</p>`
    + `<form method="post" action="/review/start">${hidden('stage', stage)}${hidden('only', only ?? '')}${hidden('preview_sha256', sha)}<label>Run key <input type="password" name="run_key" autocomplete="off" required></label> <button class="btn primary">Start the run</button></form>`);
}

async function begin(c: Ctx): Promise<Response> {
  const { env } = c;
  const f = await c.req.formData().catch(() => null);
  const key = f?.get('run_key');
  const r = await checkRunKey(env, key);
  if (r === 'locked') return locked();
  if (r === 'limited') return refused(429, 'Too many tries', 'Wait 15 minutes, then try again.');
  if (r === 'wrong') return refused(403, 'Wrong key', 'Nothing started and nothing was spent.');
  const files = await inputs(env);
  const stage = f?.get('stage'), only = f?.get('only'), preview_sha256 = f?.get('preview_sha256');
  if (!files || typeof stage !== 'string' || typeof preview_sha256 !== 'string') return refused(400, 'Start again', 'The form was incomplete.');
  const run_id = `${env.ANTHROPIC_BASE_URL ? 'stub-' : ''}${stage}-${Date.now().toString(36)}`;
  const res = await createRun(c, { run_id, stage, snapshot_id: L().parseRecs(JSON.parse(files.recs)).snapshot_id, customers_name: NAME, customers_tsv: files.tsv, customers_synthetic: true, recs_json: files.recs, preview_sha256,
    ...(typeof only === 'string' && only ? { only } : {}) });
  if (!res.ok) return refused(res.status, 'The run did not start', ((await res.json()) as { detail?: string; code?: string }).detail ?? 'See the server log.');
  return new Response(null, { status: 303, headers: { location: `/review?run=${encodeURIComponent(run_id)}` } });
}

export const routes: Route[] = [
  { method: 'GET', path: '/review/start', handler: off(start) },
  { method: 'POST', path: '/review/start', origin: true, handler: off(begin) },
];
