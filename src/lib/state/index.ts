import { notBuilt } from '../../contracts/codes.ts';
import type { Actor, AppEnv, Catalog, CheckResult, DraftRow, DraftStatus, Edge, EdgeResult, Envelope, Format, Freshness, Guarded,
  RunFormat, RunReport, RunStatus, Stage, UnitStatus } from '../../contracts/types.ts';

export async function runBatch(db: D1Database, items: Guarded[]): Promise<void> { notBuilt('runBatch'); }
export function moveUnit(db: D1Database, run_id: string, key: string, from: UnitStatus, to: UnitStatus,
  opts?: { code?: string; detail?: string; nonce?: { draft_id: string; n: string } }): Guarded { notBuilt('moveUnit'); }
export function insertDraft(db: D1Database, row: DraftRow): Guarded { notBuilt('insertDraft'); }
export async function transition(env: AppEnv, draft_id: string, edge: Edge, actor: Actor, opts?: { note?: string }): Promise<EdgeResult> { notBuilt('transition'); }
export function freshness(envelope: Envelope, rendered_paths: Record<string, string>, newest: Catalog, fetched_at: string, now: number, max_age_h: number): Freshness { notBuilt('freshness'); }

interface RunRow { stage: Stage; format: RunFormat; status: RunStatus; expected_usd: number; spent_usd: number; cap_run_usd: number;
  ceiling_usd: number; recs_sha256: string; run_date: string; snapshot_id: string }
interface DraftReportRow { version: number; format: RunFormat; hard_failures: number; status: DraftStatus; envelope_json: string; checks_json: string }

const parts = (f: RunFormat): Format[] => (f === 'both' ? ['email', 'landing_page'] : [f]);

/** M0 stand-in, read-only over runs, units and drafts. `placeholders` names what `run` still has to fill. */
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
  return { run_id, stage: run.stage, format: run.format, status: run.status, counts, first_try_pass, retry_cause, carried_parts,
    jev_fallbacks: {}, est_usd: run.expected_usd, spent_usd: run.spent_usd, jev_usd: 0, cap_run_usd: run.cap_run_usd,
    ceiling_usd: run.ceiling_usd, cache_hit_rate: 0, recs_sha256: run.recs_sha256, run_date: run.run_date,
    snapshot_fetched_at: snap?.fetched_at ?? '', fresh_for_release_h: 0,
    placeholders: ['jev_fallbacks', 'jev_usd', 'cache_hit_rate', 'fresh_for_release_h'] };
}
