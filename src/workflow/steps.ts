// Step bodies. The rule for every step: read your own output first, because `restart()` re-enters finished steps.
// No `cloudflare:*` import here: contracts/lib.ts reaches this file and node scripts import that.
import Anthropic from '@anthropic-ai/sdk';
import rowKeys from '../../data/row_keys.synthetic.json' with { type: 'json' };
import shapes from '../../config/shapes.json' with { type: 'json' };
import season from '../../config/season.json' with { type: 'json' };
import { BUNDLE } from '../lib/config/bundle.ts';
import type { Lib } from '../contracts/lib.ts';
import { loadCatalog } from '../lib/catalog/index.ts';
import { VALIDATOR_VERSION, validate } from '../lib/check/index.ts';
import { loadVersion } from '../lib/config/index.ts';
import { ingestTsv } from '../lib/ingest.ts';
import { j3Input, jevPreflight, jevReserveOk, judgeDraft } from '../lib/jev/index.ts';
import { planCustomer } from '../lib/plan.ts';
import { parseRecs, parseRowKeys } from '../lib/recs.ts';
import { renderCatalog } from '../lib/render/catalog.ts';
import { renderAll } from '../lib/render/index.ts';
import { buildRequest, partsOf, retryParts, toModelJson } from '../lib/gen/index.ts';
import { CAP, PRICES, RUNGS, admitAll, est1, onePrice, retryGate, rungOf, settle, settleAtEstimate, settleUnbilled } from '../lib/cost/index.ts';
import { checkRendered, e1Event, insertDraft, insertUnits, moveUnit, runBatch, seam, transition } from '../lib/state/index.ts';
import type { Admission, AnthropicRequest, AppEnv, Catalog, CheckResult, DraftRow, DraftStatus, Envelope, Estimate, Format, Guarded, IngestResult, JevConfig, JevOutcome, ModelDraft, ModelJson,
  Pinned, Plan, PromptFiles, RecFile, RenderedJson, ResultType, RunFormat, Rung, ShapesFile, Stage, UnitStatus, Usage } from '../contracts/types.ts';

// Named imports, not contracts/lib.ts: the Worker entry reaches this file, and that module evaluates every module at load.
const L = (): Pick<Lib, 'ingestTsv' | 'parseRecs' | 'parseRowKeys' | 'loadCatalog' | 'planCustomer' | 'buildRequest' | 'toModelJson' | 'validate' | 'renderAll' | 'renderCatalog' | 'transition'
  | 'j3Input' | 'judgeDraft' | 'jevPreflight' | 'jevReserveOk' | 'loadVersion'> => seam.lib ?? { ingestTsv, parseRecs, parseRowKeys, loadCatalog, planCustomer, buildRequest, toModelJson, validate,
  renderAll, renderCatalog, transition, j3Input, judgeDraft, jevPreflight, jevReserveOk, loadVersion };
const PAUSE_MS = 15 * 60_000;              // past the step timeout: readiness kills the process inside this

export interface RunRow { id: string; instance_id: string; stage: Stage; format: RunFormat; snapshot_id: string; run_date: string; customers_sha256: string; customers_r2_key: string;
  recs_sha256: string; setting: string; prompt_version: string; voice_guide_version: string; shapes_sha256: string; jev_model: string; jev_config_version: string; jev_reserve_usd: number;
  jev_disabled_reason: string | null; cap_run_usd: number; spent_usd: number; committed_usd: number; status: string }

export const log = (o: { run_id: string; key?: string; step: string; status: string; code?: string; ms?: number; est_usd?: number; charged_usd?: number; spent_usd?: number; cap_run_usd?: number }) => console.log(JSON.stringify(o));

const readRun = async (env: AppEnv, run_id: string) => {
  const r = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(run_id).first<RunRow>();
  if (!r) throw new Error(`run not found: ${run_id}`);
  return r;
};
const readPlan = async (env: AppEnv, run_id: string, key: string) => {
  const r = await env.DB.prepare('SELECT plan_json, admission_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(run_id, key)
    .first<{ plan_json: string; admission_json: string | null }>();
  if (!r) return null;
  return { plan: JSON.parse(r.plan_json) as Plan, admission: r.admission_json ? JSON.parse(r.admission_json) as Admission : null };
};
const needPlan = async (env: AppEnv, run_id: string, key: string) => {
  const p = await readPlan(env, run_id, key);
  if (!p) throw new Error(`no plan: ${key}`);
  return p.plan;
};
const unitStatus = async (env: AppEnv, run_id: string, key: string) => (await env.DB.prepare('SELECT status FROM units WHERE run_id = ? AND customer_id = ?').bind(run_id, key)
  .first<{ status: UnitStatus }>())?.status;
const prompt = async (env: AppEnv, run: RunRow) => (await L().loadVersion(env.DB, run.prompt_version, BUNDLE)).content as PromptFiles;
const pinnedOf = (run: RunRow): Pinned => ({ snapshot_id: run.snapshot_id, customers_sha256: run.customers_sha256, recs_sha256: run.recs_sha256, shapes_sha256: run.shapes_sha256,
  run_date: run.run_date, prompt_version: run.prompt_version, voice_guide_version: run.voice_guide_version, jev_model: run.jev_model, jev_config_version: run.jev_config_version, format: run.format });
const customers = async (env: AppEnv, run: RunRow): Promise<IngestResult[]> => {
  const o = await env.BUCKET.get(run.customers_r2_key);
  if (!o) throw new Error(`no customer file: ${run.customers_r2_key}`);
  return L().ingestTsv(await o.text());
};
const recsOf = async (env: AppEnv, run: RunRow): Promise<RecFile> => {
  const o = await env.BUCKET.get(`recs/${run.recs_sha256}.json`);
  if (!o) throw new Error('no rec file');
  return L().parseRecs(JSON.parse(await o.text()));
};
const client = (env: AppEnv) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? 'no-key', baseURL: env.ANTHROPIC_BASE_URL, maxRetries: 0, timeout: 9 * 60_000, fetch: seam.fetch });
const fault = (env: AppEnv, kind: string, key: string) => env.DEV_FAULT === `${kind}:${key}`;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export async function pin(env: AppEnv, run_id: string): Promise<{ keys: string[] }> {
  const done = (await env.DB.prepare('SELECT customer_id FROM units WHERE run_id = ?').bind(run_id).all<{ customer_id: string }>()).results.map((u) => u.customer_id);
  if (done.length) return { keys: done.sort() };
  const run = await readRun(env, run_id);
  const keys = (await customers(env, run)).map((i) => i.key).sort();
  let off: string | null;
  try {
    const cfg = (await L().loadVersion(env.DB, run.jev_config_version, BUNDLE)).content as JevConfig;
    const p = await L().jevPreflight(env, cfg);
    off = p.ok ? null : p.reason;
  } catch (e) { off = e instanceof Error ? e.message : 'jev config'; }
  await runBatch(env.DB, [...insertUnits(env.DB, run_id, keys), { expectOne: true, stmt: env.DB.prepare('UPDATE runs SET season_excluded_json = ?, jev_disabled_reason = ? WHERE id = ?')
    .bind(JSON.stringify(season.excluded_subcategories), off, run_id) }]);
  return { keys };
}

const envelopeOf = (run: RunRow, plan: Plan, cat: Catalog, rung: Rung, carried: Format | null): Envelope => ({ customer_id: plan.customer_id, display_name: plan.display_name, run_id: run.id,
  format: plan.format, picks: plan.picks.map(({ slot, product_id }) => ({ slot, product_id })), occasion_key: plan.occasion_key, shape: plan.shape, snapshot_id: run.snapshot_id,
  snapshot_fetched_at: cat.fetched_at, model: rung.model, setting: rung.id, prompt_version: run.prompt_version, voice_guide_version: run.voice_guide_version,
  validator_version: VALIDATOR_VERSION, carried_from: carried ? 1 : null, carried_part: carried });

/** Prep step 5: the catalog is built here, at $0, so a pick that cannot render fails before admission. */
function catalogFails(run: RunRow, plan: Plan, cat: Catalog): boolean {
  try {
    const rendered = { email: null, landing_page: null, catalog: L().renderCatalog(plan, cat) };
    return checkRendered(rendered, envelopeOf(run, plan, cat, rungOf(run.setting), null), cat, plan).some((c) => c.part === 'catalog' && c.severity === 'hard' && !c.pass);
  } catch { return true; }
}

export async function prep(env: AppEnv, run_id: string, key: string): Promise<'ready' | 'failed'> {
  const seen = await readPlan(env, run_id, key);
  if (seen) return seen.plan.outcome.kind === 'ready' ? 'ready' : 'failed';
  if (fault(env, 'throw', key)) throw Object.assign(new Error(`DEV_FAULT throw:${key}`), { name: 'NonRetryableError' });
  const run = await readRun(env, run_id);
  await prompt(env, run);                  // a tampered version fails here, this unit alone
  const item = (await customers(env, run)).find((i) => i.key === key);
  if (!item) throw new Error(`key not in the file: ${key}`);
  const [recs, cat] = await Promise.all([recsOf(env, run), L().loadCatalog(env, run.snapshot_id)]);
  const keys = L().parseRowKeys(rowKeys);
  const rec = recs.rows.find((r) => r.customer_id === key) ?? null;
  let plan: Plan = { ...L().planCustomer(item, rec, keys, cat, pinnedOf(run), shapes as ShapesFile), run_id, customer_id: key, created_at: new Date().toISOString() };
  if (plan.outcome.kind === 'ready' && catalogFails(run, plan, cat)) plan = { ...plan, outcome: { kind: 'failed', code: 'INVALID_PICK' } };
  const failed = plan.outcome.kind === 'failed' ? plan.outcome.code : null;
  await runBatch(env.DB, [{ expectOne: true, stmt: env.DB.prepare(`INSERT INTO plans (run_id, customer_id, plan_json, occasion_key, shape, new_user, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run_id, key, JSON.stringify(plan), plan.occasion_key, plan.shape, plan.new_user ? 1 : 0, plan.format, plan.created_at) },
    failed ? moveUnit(env.DB, run_id, key, 'pending', 'failed', { code: failed }) : moveUnit(env.DB, run_id, key, 'pending', 'prepared')]);
  return failed ? 'failed' : 'ready';
}

type Retry = { failed: Format[]; checks: CheckResult[] };
const countTokens = async (env: AppEnv, req: AnthropicRequest) => (await client(env).messages.countTokens(
  { model: req.model, system: req.system, messages: req.messages, ...(req.thinking ? { thinking: req.thinking } : {}), output_config: req.output_config } as never)).input_tokens;

export async function estimate(env: AppEnv, run_id: string, key: string): Promise<number> {
  const seen = await readPlan(env, run_id, key);
  if (!seen) throw new Error(`no plan: ${key}`);
  if (seen.admission) return seen.admission.input_tokens;
  const run = await readRun(env, run_id);
  const cat = await L().loadCatalog(env, run.snapshot_id);
  return countTokens(env, L().buildRequest(seen.plan, seen.plan.pinned, cat, rungOf(run.setting), await prompt(env, run)));
}

export async function admit(env: AppEnv, run_id: string, estimates: Record<string, number | null>): Promise<{ admitted: { key: string; format: RunFormat }[] }> {
  const db = env.DB;
  const rows = (await db.prepare('SELECT customer_id, plan_json, admission_json FROM plans WHERE run_id = ?').bind(run_id)
    .all<{ customer_id: string; plan_json: string; admission_json: string | null }>()).results;
  const stored = rows.filter((r) => r.admission_json);
  if (stored.length) {
    return { admitted: stored.filter((r) => (JSON.parse(r.admission_json as string) as Admission).action === 'admit')
      .map((r) => ({ key: r.customer_id, format: (JSON.parse(r.plan_json) as Plan).format })).sort((a, b) => (a.key < b.key ? -1 : 1)) };
  }
  const run = await readRun(env, run_id);
  const ready = rows.map((r) => JSON.parse(r.plan_json) as Plan).filter((p) => p.outcome.kind === 'ready');
  const list: Estimate[] = ready.map((p) => ({ key: p.customer_id, format: p.format, rung: run.setting, input_tokens: estimates[p.customer_id] ?? -1 }));
  const res = admitAll(list, CAP, RUNGS, run.setting, run.cap_run_usd - run.jev_reserve_usd, PRICES);
  const at = new Date().toISOString();
  const items: Guarded[] = ready.flatMap((p) => {
    const a = res.per[p.customer_id]; const key = p.customer_id; const ok = a.action === 'admit';
    log({ run_id, key, step: 'admit', status: ok ? 'admitted' : 'skipped', code: a.code, est_usd: a.est_1_usd });
    return [
      { expectOne: true, stmt: db.prepare('UPDATE plans SET admission_json = ? WHERE run_id = ? AND customer_id = ? AND admission_json IS NULL').bind(JSON.stringify(a), run_id, key) },
      { expectOne: false, stmt: db.prepare(`INSERT OR IGNORE INTO cost_events (run_id, customer_id, attempt, setting, input_tokens, est_usd, commit_usd, action, call_state, reason, at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(run_id, key, a.setting, a.input_tokens, a.est_1_usd, a.commit_usd, a.action, ok ? 'estimated' : 'blocked', a.code ?? null, at) },
      { expectOne: false, stmt: db.prepare('UPDATE units SET setting = ? WHERE run_id = ? AND customer_id = ?').bind(a.setting, run_id, key) },
      moveUnit(db, run_id, key, 'prepared', ok ? 'admitted' : 'skipped', ok ? undefined : { code: a.code }),
    ];
  });
  // Never asserts status past `preparing`: the restart route owns it on a replay.
  items.push({ expectOne: true, stmt: db.prepare(`UPDATE runs SET committed_usd = ?, status = CASE status WHEN 'preparing' THEN 'generating' ELSE status END WHERE id = ?`).bind(res.committed_usd, run_id) });
  await runBatch(db, items);
  return { admitted: res.admitted };
}

interface Generation { result_type: ResultType; stop_reason: string | null; stop_detail: string | null; message_json: string | null }
const readGen = (env: AppEnv, run_id: string, key: string, n: number) => env.DB.prepare('SELECT * FROM generations WHERE run_id = ? AND customer_id = ? AND attempt = ?')
  .bind(run_id, key, n).first<Generation>();
const genRow = (db: D1Database, run_id: string, key: string, n: number, t: ResultType, o: { stop_reason?: string | null; stop_detail?: string | null; message?: unknown; usage?: unknown; ms?: number } = {}): Guarded =>
  ({ expectOne: false, stmt: db.prepare(`INSERT OR IGNORE INTO generations (run_id, customer_id, attempt, result_type, stop_reason, stop_detail, message_json, usage_json, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run_id, key, n, t, o.stop_reason ?? null, o.stop_detail ?? null, o.message ? JSON.stringify(o.message) : null, o.usage ? JSON.stringify(o.usage) : null, o.ms ?? null) });

const readDraft = (env: AppEnv, run_id: string, key: string, v: number) => env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(`${run_id}:${key}:v${v}`)
  .first<DraftRow & { status: DraftStatus }>();

/** What attempt 2 regenerates and what it carries. `retryParts` is gen's rule, so a carried part is never one the request rewrites. */
async function retryOf(env: AppEnv, run_id: string, key: string, format: RunFormat): Promise<{ retry?: Retry; carried: Format | null }> {
  const d1 = await readDraft(env, run_id, key, 1);
  if (!d1) return { carried: null };       // attempt 1 left no output: a fresh request
  const checks = (JSON.parse(d1.checks_json) as CheckResult[]).filter((c) => c.severity === 'hard' && !c.pass);
  const all = partsOf(format);
  const g1 = await readGen(env, run_id, key, 1);
  const named = all.filter((p) => checks.some((c) => c.part === p));
  const failed = g1?.stop_reason === 'max_tokens' || !named.length ? all : named;
  const parts = retryParts(format, { failed, checks });
  return { retry: { failed: parts, checks }, carried: all.find((p) => !parts.includes(p)) ?? null };
}

type Verdict = 'retry' | 'possibly_billed' | 'invalid_request';
/** A retry may only follow a call that cannot have been billed. Anything ambiguous is possibly_billed. */
function classify(e: unknown): Verdict {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'possibly_billed';
  if (e instanceof Anthropic.APIConnectionError) return /refused/i.test(String(e.cause ?? e.message)) ? 'retry' : 'possibly_billed';
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    if (e.status === 429 || e.status === 529) return 'retry';
    if (e.status >= 500) return e.error ? 'possibly_billed' : 'retry';
    return 'invalid_request';
  }
  return 'possibly_billed';
}

export async function gen(env: AppEnv, run_id: string, key: string, n: 1 | 2): Promise<void> {
  const db = env.DB;
  if (await readGen(env, run_id, key, n)) return;
  const ce = await db.prepare('SELECT call_state FROM cost_events WHERE run_id = ? AND customer_id = ? AND attempt = ?').bind(run_id, key, n).first<{ call_state: string }>();
  const possiblyBilled = () => runBatch(db, [genRow(db, run_id, key, n, 'possibly_billed'), ...settleAtEstimate(db, run_id, key, n)]);
  if (ce?.call_state === 'calling') return possiblyBilled();      // killed after the call may have run. Never call again
  if (ce?.call_state !== 'estimated') throw new Error(`gen ${key}:${n} in state ${ce?.call_state}`);

  const run = await readRun(env, run_id);
  if (run.status === 'stopped') return runBatch(db, [genRow(db, run_id, key, n, 'no_completion', { stop_detail: 'run_stopped' }), ...settleUnbilled(db, run_id, key, n)]);   // terminate() is best effort
  const plan = await needPlan(env, run_id, key);
  const rung = rungOf(run.setting);
  const cat = await L().loadCatalog(env, run.snapshot_id);
  const { retry } = n === 2 ? await retryOf(env, run_id, key, plan.format) : { retry: undefined };
  const req = L().buildRequest(plan, plan.pinned, cat, rung, await prompt(env, run), retry);
  const cas = await db.prepare(`UPDATE cost_events SET call_state = 'calling', request_sha256 = ? WHERE run_id = ? AND customer_id = ? AND attempt = ? AND call_state = 'estimated'`)
    .bind(await sha256(JSON.stringify(req)), run_id, key, n).run();
  if (cas.meta.changes !== 1) return possiblyBilled();

  let msg: Anthropic.Message;
  const started = Date.now();
  try {
    msg = await client(env).messages.create(req as never) as Anthropic.Message;
  } catch (e) {
    const v = classify(e);
    if (v === 'possibly_billed') return possiblyBilled();
    if (v === 'invalid_request') {
      await runBatch(db, [genRow(db, run_id, key, n, 'invalid_request', { stop_detail: e instanceof Anthropic.APIError ? String(e.type ?? e.status) : null }), ...settleUnbilled(db, run_id, key, n)]);
      return;
    }
    await db.prepare(`UPDATE cost_events SET call_state = 'estimated' WHERE run_id = ? AND customer_id = ? AND attempt = ? AND call_state = 'calling'`).bind(run_id, key, n).run();
    throw e;
  }
  const ms = Date.now() - started;
  if (fault(env, 'pause_after_answer', key)) await (seam.pause?.() ?? new Promise((ok) => setTimeout(ok, PAUSE_MS)));
  const category = msg.stop_details?.category ?? null;
  const refused = msg.stop_reason === 'refusal';
  await runBatch(db, [genRow(db, run_id, key, n, refused ? 'refusal' : 'answered', { stop_reason: msg.stop_reason, stop_detail: refused ? category ?? 'none' : null, message: msg, usage: msg.usage, ms }),
    ...settle(db, run_id, key, n, { usage: msg.usage as Usage, stop_reason: msg.stop_reason ?? undefined, category, content_empty: msg.content.length === 0 }, onePrice(PRICES, rung.model))]);
}

/** Out of step retries. `calling` means the last try got past the call, so it may be billed; a retry that failed earlier reset to `estimated`. */
export async function genFailed(env: AppEnv, run_id: string, key: string, n: 1 | 2): Promise<void> {
  const db = env.DB;
  const ce = await db.prepare('SELECT call_state FROM cost_events WHERE run_id = ? AND customer_id = ? AND attempt = ?').bind(run_id, key, n).first<{ call_state: string }>();
  await runBatch(db, ce?.call_state === 'calling' ? [genRow(db, run_id, key, n, 'possibly_billed'), ...settleAtEstimate(db, run_id, key, n)]
    : [genRow(db, run_id, key, n, 'no_completion'), ...settleUnbilled(db, run_id, key, n)]);
}

const failOne = (env: AppEnv, run_id: string, key: string, code: string, detail?: string) => runBatch(env.DB, [moveUnit(env.DB, run_id, key, 'admitted', 'failed', { code, detail })]);

/** Retry if the gate allows; else the unit ends with attempt 1's code. Attempt 2 never retries. */
async function retryOrFail(env: AppEnv, run_id: string, key: string, n: 1 | 2, code: string): Promise<{ retry: boolean }> {
  if (n === 1) {
    const stored = await env.DB.prepare('SELECT 1 FROM cost_events WHERE run_id = ? AND customer_id = ? AND attempt = 2').bind(run_id, key).first();
    let est = 0;
    if (!stored) {
      const run = await readRun(env, run_id); const plan = await needPlan(env, run_id, key); const rung = rungOf(run.setting);
      const { retry } = await retryOf(env, run_id, key, plan.format);
      const req = L().buildRequest(plan, plan.pinned, await L().loadCatalog(env, run.snapshot_id), rung, await prompt(env, run), retry);
      est = est1(await countTokens(env, req), plan.format, rung, CAP, PRICES);
    }
    if (await retryGate(env.DB, run_id, key, est)) return { retry: true };
  }
  await failOne(env, run_id, key, code);
  return { retry: false };
}

const textOf = (message_json: string | null) => ((JSON.parse(message_json ?? '{}') as { content?: { type: string; text?: string }[] }).content ?? [])
  .filter((b) => b.type === 'text').map((b) => b.text).join('');

/** E1, with the J3 answer beside it. A replay finds the row and never asks Jev again. */
async function writeDraft(env: AppEnv, run: RunRow, plan: Plan, n: 1 | 2, g: Generation): Promise<void> {
  const key = plan.customer_id; const db = env.DB; const rung = rungOf(run.setting);
  const cat = await L().loadCatalog(env, run.snapshot_id);
  const { retry, carried } = n === 2 ? await retryOf(env, run.id, key, plan.format) : { retry: undefined, carried: null };
  const prior = carried ? JSON.parse((await readDraft(env, run.id, key, 1) as DraftRow).model_json) as ModelJson : null;
  const carry = carried && prior ? { part: carried, model: prior[carried] as ModelDraft } : undefined;
  const model: ModelJson = L().toModelJson(textOf(g.message_json), retry ? retry.failed : partsOf(plan.format), carry);
  const envelope = envelopeOf(run, plan, cat, rung, carried);
  const envelope_json = JSON.stringify(envelope); const model_json = JSON.stringify(model);
  const checks = L().validate(model_json, envelope, cat, plan);
  const hard = () => checks.filter((c) => c.severity === 'hard' && !c.pass).length;
  let rendered: RenderedJson;
  try {
    rendered = L().renderAll(model, plan, envelope, cat);
    checks.push(...checkRendered(rendered, envelope, cat, plan));
  } catch (e) {
    if (!hard()) throw e;                  // a failed draft is still stored: E3 needs a row
    rendered = { email: null, landing_page: null, catalog: L().renderCatalog(plan, cat) };
  }
  const hard_failures = hard();
  const rendered_json = JSON.stringify(rendered);
  const { contentSha256 } = await import('../contracts/lib.ts');
  const row: DraftRow = { id: `${run.id}:${key}:v${n}`, run_id: run.id, customer_id: key, version: n, format: plan.format, snapshot_id: run.snapshot_id, validator_version: VALIDATOR_VERSION,
    model: rung.model, envelope_json, model_json, rendered_json, content_sha256: await contentSha256(envelope_json, model_json, rendered_json), checks_json: JSON.stringify(checks), hard_failures };
  const items = [insertDraft(db, row), e1Event(db, row)];
  if (!hard_failures) items.push(await judged(env, run, plan, row, n, cat));
  await runBatch(db, items);
}

async function judged(env: AppEnv, run: RunRow, plan: Plan, row: DraftRow, n: 1 | 2, cat: Catalog): Promise<Guarded> {
  let cfg: JevConfig | null = null;
  try { cfg = (await L().loadVersion(env.DB, run.jev_config_version, BUNDLE)).content as JevConfig; } catch { /* `unavailable`, below */ }
  const none = (status: JevOutcome['status'], reason: string): JevOutcome => ({ status, reason, model: null, answers: null, input_tokens: null, charged_usd: null, basis_usd: cfg?.basis_usd ?? 0 });
  const skip = !cfg || run.jev_disabled_reason ? none('unavailable', run.jev_disabled_reason ?? 'config')
    : !(await L().jevReserveOk(env.DB, cfg.basis_usd)) ? none('skipped_reserve', 'reserve') : null;
  const started = Date.now();
  const out = skip ?? await L().judgeDraft(env, L().j3Input(row, plan, cat), cfg as JevConfig);
  const ms = skip ? null : Date.now() - started;
  return { expectOne: false, stmt: env.DB.prepare(`INSERT OR IGNORE INTO jev_events (run_id, customer_id, attempt, model_requested, model_returned, status, reason, answers_json, input_tokens, charged_usd, basis_usd, at, ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(run.id, plan.customer_id, n, run.jev_model, out.model, out.status, out.reason, out.answers ? JSON.stringify(out.answers) : null, out.input_tokens,
    out.charged_usd, out.basis_usd, new Date().toISOString(), ms) };
}

export async function finish(env: AppEnv, run_id: string, key: string, n: 1 | 2): Promise<{ retry: boolean }> {
  if (await unitStatus(env, run_id, key) !== 'admitted') return { retry: false };
  const g = await readGen(env, run_id, key, n);
  if (!g) throw new Error(`no generation: ${key}:${n}`);
  switch (g.result_type) {
    case 'refusal': await failOne(env, run_id, key, 'UPSTREAM_UNAVAILABLE', `refusal:${g.stop_detail ?? 'none'}`); return { retry: false };
    case 'invalid_request': await failOne(env, run_id, key, 'INVALID_REQUEST', g.stop_detail ?? undefined); return { retry: false };
    case 'possibly_billed': case 'no_completion': return retryOrFail(env, run_id, key, n, 'UPSTREAM_UNAVAILABLE');
  }
  if (!await readDraft(env, run_id, key, n)) await writeDraft(env, await readRun(env, run_id), await needPlan(env, run_id, key), n, g);
  const d = await readDraft(env, run_id, key, n) as DraftRow & { status: DraftStatus };
  const id = d.id;
  if (d.status === 'draft') {
    const r = await L().transition(env, id, d.hard_failures ? 'E3' : 'E2', { kind: 'system' });
    if (!r.ok) throw new Error(`edge refused: ${r.code}`);
    if (r.status !== 'failed') return { retry: false };
  } else if (d.status !== 'failed') return { retry: false };
  return retryOrFail(env, run_id, key, n, 'CHECKS_FAILED');
}

export async function failUnit(env: AppEnv, run_id: string, key: string, e: unknown): Promise<void> {
  const status = await unitStatus(env, run_id, key);
  if (status !== 'pending' && status !== 'prepared' && status !== 'admitted') return;
  const err = e instanceof Error ? e : new Error(String(e));
  await runBatch(env.DB, [moveUnit(env.DB, run_id, key, status, 'failed', { code: 'INTERNAL_ERROR', detail: `${err.name}: ${err.message}`.slice(0, 500) })]);
}

export async function close(env: AppEnv, run_id: string): Promise<void> {
  const run = await readRun(env, run_id);
  if (run.status === 'done') return;
  if (run.spent_usd > run.cap_run_usd) log({ run_id, step: 'close', status: 'cap_breach', code: 'RUN_CAP', spent_usd: run.spent_usd, cap_run_usd: run.cap_run_usd });
  const units = (await env.DB.prepare('SELECT customer_id, status, code FROM units WHERE run_id = ?').bind(run_id).all<{ customer_id: string; status: UnitStatus; code: string | null }>()).results;
  const list = (await customers(env, run)).map((i) => i.key).sort().join('\n');
  const stranded = await env.DB.prepare(`SELECT 1 FROM drafts d JOIN units u ON u.run_id = d.run_id AND u.customer_id = d.customer_id
    WHERE d.run_id = ? AND d.status = 'draft' AND NOT (u.status = 'failed' AND u.code = 'INTERNAL_ERROR') LIMIT 1`).bind(run_id).first();
  const complete = units.every((u) => ['drafted', 'failed', 'skipped'].includes(u.status)) && !stranded && units.map((u) => u.customer_id).sort().join('\n') === list;
  if (!complete) {
    await env.DB.prepare(`UPDATE runs SET status = 'stopped', stop_reason = 'close_incomplete' WHERE id = ? AND status = 'generating'`).bind(run_id).run();
    return;
  }
  const lines = units.map((u) => `${u.customer_id}|${u.status}|${u.code ?? ''}`).sort().join('\n');
  await env.DB.prepare(`UPDATE runs SET status = 'done', results_sha256 = ? WHERE id = ? AND status = 'generating'`).bind(await sha256(lines), run_id).run();
}
