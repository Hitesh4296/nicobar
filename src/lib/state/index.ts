// Unit and draft machines. Only this file writes `units.status`; `transition` is the only way a draft moves.
import capJson from '../../../config/cap.json' with { type: 'json' };
import { validate, validateRendered } from '../check/index.ts';
import { loadCatalog } from '../catalog/index.ts';
import { imagePaths } from '../render/index.ts';
import type { Lib } from '../../contracts/lib.ts';
import type { Actor, AppEnv, Catalog, CheckResult, DraftRow, DraftStatus, Edge, EdgeResult, Envelope, Format, Freshness, Guarded, Plan,
  RenderedJson, RunFormat, RunReport, RunStatus, Stage, UnitStatus } from '../../contracts/types.ts';

/** Test seam: other modules through `L()`, the model's fetch, and the `pause_after_answer` hold. Nothing sets these outside test/. */
export const seam: { lib?: Lib; rendered?: typeof validateRendered; fetch?: typeof fetch; pause?: () => Promise<void> } = {};
/** X1–X4 on the pages. Not in `Lib`. With fakes in place and no override, it passes. */
export const checkRendered: typeof validateRendered = (...a) => (seam.rendered ?? (seam.lib ? () => [] : validateRendered))(...a);
const L = (): Pick<Lib, 'loadCatalog' | 'validate' | 'imagePaths'> => seam.lib ?? { loadCatalog, validate, imagePaths };

const UNIT_MOVES: Record<UnitStatus, UnitStatus[]> = { pending: ['prepared', 'failed'], prepared: ['admitted', 'skipped', 'failed'],
  admitted: ['admitted', 'drafted', 'failed'], drafted: [], failed: [], skipped: [] };

export async function runBatch(db: D1Database, items: Guarded[]): Promise<void> {
  const res = await db.batch(items.map((i) => i.stmt));
  items.forEach((it, i) => {
    if (it.expectOne && res[i].meta.changes !== 1) throw new Error('INTERNAL_ERROR: guarded statement changed no row');
  });
}

export function moveUnit(db: D1Database, run_id: string, key: string, from: UnitStatus, to: UnitStatus,
  opts?: { code?: string; detail?: string; nonce?: { draft_id: string; n: string } }): Guarded {
  if (!UNIT_MOVES[from].includes(to)) throw new Error(`illegal unit move ${from} -> ${to}`);
  const n = opts?.nonce;
  const stmt = db.prepare(`UPDATE units SET status = ?, code = ?, error_detail = ? WHERE run_id = ? AND customer_id = ? AND status = ?
    ${n ? 'AND EXISTS (SELECT 1 FROM drafts WHERE id = ? AND edge_nonce = ?)' : ''}`)
    .bind(to, opts?.code ?? null, opts?.detail ?? null, run_id, key, from, ...(n ? [n.draft_id, n.n] : []));
  return { stmt, expectOne: true };
}

export const insertUnits = (db: D1Database, run_id: string, keys: string[]): Guarded[] => keys.map((key) => ({ expectOne: false,
  stmt: db.prepare(`INSERT OR IGNORE INTO units (run_id, customer_id, status) VALUES (?, ?, 'pending')`).bind(run_id, key) }));

export function insertDraft(db: D1Database, row: DraftRow): Guarded {
  return { expectOne: false, stmt: db.prepare(`INSERT OR IGNORE INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model,
    envelope_json, model_json, rendered_json, content_sha256, checks_json, hard_failures, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
    .bind(row.id, row.run_id, row.customer_id, row.version, row.format, row.snapshot_id, row.validator_version, row.model, row.envelope_json, row.model_json,
      row.rendered_json, row.content_sha256, row.checks_json, row.hard_failures) };
}
/** E1's event, sent beside `insertDraft`. */
export const e1Event = (db: D1Database, row: DraftRow): Guarded => ({ expectOne: false, stmt: db.prepare(`INSERT INTO draft_events (draft_id, from_status, to_status, actor_kind, at, content_sha256, edge_nonce)
  SELECT ?1, NULL, 'draft', 'system', ?2, ?3, 'e1' WHERE NOT EXISTS (SELECT 1 FROM draft_events WHERE draft_id = ?1 AND to_status = 'draft')`)
  .bind(row.id, new Date().toISOString(), row.content_sha256) });

const EDGES: Record<Edge, { from: DraftStatus; to: DraftStatus; who: Actor['kind'][] }> = {
  E2: { from: 'draft', to: 'in_review', who: ['system'] }, E3: { from: 'draft', to: 'failed', who: ['system'] },
  E4: { from: 'in_review', to: 'approved', who: ['human', 'dev'] }, E5: { from: 'in_review', to: 'rejected', who: ['human', 'dev'] },
  E6: { from: 'approved', to: 'in_review', who: ['human', 'dev'] }, E7: { from: 'approved', to: 'released', who: ['human', 'dev'] } };
const wrong = (http: 400 | 409 = 409, detail?: object): EdgeResult => ({ ok: false, http, code: 'WRONG_STATE', detail });
const failedHard = (c: CheckResult[]) => c.filter((x) => x.severity === 'hard' && !x.pass).length;

export async function transition(env: AppEnv, draft_id: string, edge: Edge, actor: Actor, opts?: { note?: string }): Promise<EdgeResult> {
  const e = EDGES[edge]; const db = env.DB;
  const d = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(draft_id).first<DraftRow & { status: DraftStatus }>();
  if (!d || d.status !== e.from || !e.who.includes(actor.kind)) return wrong();
  if (edge === 'E3' && d.hard_failures === 0) return wrong();
  if (edge === 'E5' && !opts?.note?.trim()) return wrong(400, { field: 'note' });

  let evidence: string | null = null;
  if (edge === 'E2' || edge === 'E4' || edge === 'E7') {
    const row = await db.prepare('SELECT plan_json FROM plans WHERE run_id = ? AND customer_id = ?').bind(d.run_id, d.customer_id).first<{ plan_json: string }>();
    if (!row) return wrong();
    const envelope = JSON.parse(d.envelope_json) as Envelope;
    const cat = await L().loadCatalog(env, d.snapshot_id);
    const plan = JSON.parse(row.plan_json) as Plan;
    const checks = [...L().validate(d.model_json, envelope, cat, plan), ...checkRendered(JSON.parse(d.rendered_json) as RenderedJson, envelope, cat, plan)];
    if (d.hard_failures > 0 || failedHard(checks) > 0) return { ok: false, http: 409, code: 'CHECKS_FAILED' };
    const { contentSha256 } = await import('../../contracts/lib.ts');   // dynamic: routes reach this file, and contracts/lib.ts evaluates every module
    if (await contentSha256(d.envelope_json, d.model_json, d.rendered_json) !== d.content_sha256) return { ok: false, http: 409, code: 'HASH_MISMATCH' };
    if (edge === 'E7') {
      const snap = await db.prepare('SELECT id, fetched_at FROM snapshots WHERE synthetic = 0 ORDER BY fetched_at DESC LIMIT 1').first<{ id: string; fetched_at: string }>();
      if (!snap) return { ok: false, http: 409, code: 'SNAPSHOT_TOO_OLD' };
      const newest: Catalog = snap.id === d.snapshot_id ? cat : await L().loadCatalog(env, snap.id);
      const f = freshness(envelope, L().imagePaths(JSON.parse(d.rendered_json) as RenderedJson), newest, snap.fetched_at, Date.now(), Number(env.FRESH_FOR_RELEASE_H));
      if (!f.ok) {
        const { ok: _ok, code, ...detail } = f;
        return { ok: false, http: 409, code, detail };
      }
      evidence = JSON.stringify({ snapshot_id: f.snapshot_id, snapshot_age_s: f.age_s });
    }
  }

  const n = crypto.randomUUID(); const at = new Date().toISOString();
  const human = actor.kind === 'system' ? null : actor;
  const head = {
    E2: ['', []], E3: ['', []], E5: ['', []],
    E4: [', approved_by = ?, approved_sub = ?, approved_at = ?, approved_sha256 = content_sha256', [human?.email, human?.sub, at]],
    E6: [', approved_by = NULL, approved_sub = NULL, approved_at = NULL, approved_sha256 = NULL', []],
    E7: [', released_by = ?, released_sub = ?, released_at = ?', [human?.email, human?.sub, at]],
  }[edge] as [string, unknown[]];
  const guard = edge === 'E2' || edge === 'E4' ? 'AND hard_failures = 0 AND content_sha256 = ?' : edge === 'E7' ? 'AND approved_sha256 = ? AND content_sha256 = approved_sha256' : '';
  const stmts = [
    db.prepare(`UPDATE drafts SET status = ?, edge_nonce = ?${head[0]} WHERE id = ? AND status = ? ${guard}`)
      .bind(e.to, n, ...head[1], draft_id, e.from, ...(guard ? [d.content_sha256] : [])),
    db.prepare(`INSERT INTO draft_events (draft_id, from_status, to_status, actor_kind, actor_email, actor_sub, at, content_sha256, edge_nonce, note, evidence_json)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM drafts WHERE id = ? AND edge_nonce = ?)`)
      .bind(draft_id, e.from, e.to, actor.kind, human?.email ?? null, human?.sub ?? null, at, d.content_sha256, n, opts?.note ?? null, evidence, draft_id, n),
  ];
  if (edge === 'E2') stmts.push(moveUnit(db, d.run_id, d.customer_id, 'admitted', 'drafted', { nonce: { draft_id, n } }).stmt);
  const res = await db.batch(stmts);
  return res[0].meta.changes === 1 ? { ok: true, status: e.to } : wrong();   // lost a race: the head and its siblings all no-op
}

/** Snapshot evidence only, no outbound call. `title_changed` has no baseline: `Envelope` stores no title. */
export function freshness(envelope: Envelope, rendered_paths: Record<string, string>, newest: Catalog, fetched_at: string, now: number, max_age_h: number): Freshness {
  const age_s = Math.round((now - Date.parse(fetched_at)) / 1000);
  if (!(age_s <= max_age_h * 3600)) return { ok: false, code: 'SNAPSHOT_TOO_OLD', age_s };   // negated so a NaN fails closed
  for (const { slot, product_id } of envelope.picks) {
    const stale = (reason: 'gone' | 'unavailable' | 'image_gone'): Freshness => ({ ok: false, code: 'STALE_PICK', product_id, reason });
    const p = newest.rows.get(product_id);
    if (!p) return stale('gone');
    if (!p.variants.some((v) => v.available)) return stale('unavailable');
    const path = rendered_paths[slot];
    if (path && !p.images.some((i) => new URL(i.src_canonical).pathname === path)) return stale('image_gone');
  }
  return { ok: true, snapshot_id: newest.snapshot_id, age_s };
}

interface RunRow { stage: Stage; format: RunFormat; status: RunStatus; expected_usd: number; spent_usd: number; cap_run_usd: number;
  ceiling_usd: number; recs_sha256: string; run_date: string; snapshot_id: string }
interface DraftReportRow { version: number; format: RunFormat; hard_failures: number; status: DraftStatus; envelope_json: string; checks_json: string }

const parts = (f: RunFormat): Format[] => (f === 'both' ? ['email', 'landing_page'] : [f]);

/** Computed on read. `placeholders` names what is not yet measured. */
export async function runReport(db: D1Database, run_id: string): Promise<RunReport> {
  const run = await db.prepare(`SELECT stage, format, status, expected_usd, spent_usd, cap_run_usd, ceiling_usd, recs_sha256, run_date,
    snapshot_id FROM runs WHERE id = ?`).bind(run_id).first<RunRow>();
  if (!run) throw new Error(`run not found: ${run_id}`);
  const snap = await db.prepare('SELECT fetched_at FROM snapshots WHERE id = ?').bind(run.snapshot_id).first<{ fetched_at: string }>();
  const units = (await db.prepare('SELECT status, code, COUNT(*) AS n FROM units WHERE run_id = ? GROUP BY status, code')
    .bind(run_id).all<{ status: UnitStatus; code: string | null; n: number }>()).results;
  const drafts = (await db.prepare('SELECT version, format, hard_failures, status, envelope_json, checks_json FROM drafts WHERE run_id = ?')
    .bind(run_id).all<DraftReportRow>()).results;

  const counts: Record<string, number> = {};
  const add = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  for (const u of units) { add(`unit:${u.status}`, u.n); if (u.code) add(`code:${u.code}`, u.n); }
  for (const d of drafts) add(`draft:${d.status}`);

  const first_try_pass: Record<Format, number> = { email: 0, landing_page: 0 };
  const retry_cause: Record<Format, Record<string, number>> = { email: {}, landing_page: {} };
  let carried_parts = 0;
  for (const d of drafts) {
    if ((JSON.parse(d.envelope_json) as Envelope).carried_part) carried_parts++;
    if (d.version !== 1) continue;
    const hard = (JSON.parse(d.checks_json) as CheckResult[]).filter((c) => c.severity === 'hard' && !c.pass);
    for (const part of parts(d.format)) {
      const failed = hard.filter((c) => c.part === part);
      if (failed.length === 0) first_try_pass[part]++;
      for (const c of failed) retry_cause[part][c.id] = (retry_cause[part][c.id] ?? 0) + 1;
    }
  }
  const est = await db.prepare('SELECT COALESCE(SUM(est_usd), 0) AS est FROM cost_events WHERE run_id = ?').bind(run_id).first<{ est: number }>();
  const jev = (await db.prepare('SELECT status, reason, charged_usd FROM jev_events WHERE run_id = ?').bind(run_id)
    .all<{ status: string; reason: string | null; charged_usd: number | null }>()).results;
  const jev_fallbacks: Record<string, number> = {};
  for (const j of jev) if (j.status !== 'answered') { const k = `${j.status}:${j.reason ?? 'none'}`; jev_fallbacks[k] = (jev_fallbacks[k] ?? 0) + 1; }
  let read = 0; let total = 0;
  for (const { usage_json } of (await db.prepare('SELECT usage_json FROM generations WHERE run_id = ? AND usage_json IS NOT NULL').bind(run_id).all<{ usage_json: string }>()).results) {
    const u = JSON.parse(usage_json) as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    read += u.cache_read_input_tokens ?? 0; total += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return { run_id, stage: run.stage, format: run.format, status: run.status, counts, first_try_pass, retry_cause, carried_parts,
    jev_fallbacks, est_usd: est?.est ?? 0, spent_usd: run.spent_usd, jev_usd: jev.reduce((s, j) => s + (j.charged_usd ?? 0), 0), cap_run_usd: run.cap_run_usd,
    ceiling_usd: run.ceiling_usd, cache_hit_rate: total ? read / total : 0, recs_sha256: run.recs_sha256, run_date: run.run_date,
    snapshot_fetched_at: snap?.fetched_at ?? '', fresh_for_release_h: Number(process.env.FRESH_FOR_RELEASE_H ?? 0),
    placeholders: capJson.measured ? [] : ['cap.json'] };
}
