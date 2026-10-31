// Shared harness for the run lane: real state and cost, fakeLib for every other lane, a counting fake model transport.
import { applyD1Migrations } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { seam, transition } from '../../src/lib/state/index.ts';
import type { AppEnv, Pinned, RunFormat } from '../../src/contracts/types.ts';
import { fakeLib, fxModelJson, fxPlan, fxCatalog } from '../fakes/index.ts';

export const env = rawEnv as unknown as AppEnv & { RUN_WORKFLOW: Workflow<{ run_id: string }>; TEST_MIGRATIONS: never };
export const db = env.DB;
export const migrate = () => applyD1Migrations(db, env.TEST_MIGRATIONS);

export const SNAP = fxCatalog().snapshot_id;
export const ACTOR = { kind: 'dev', email: 'test@local', sub: 'dev:test@local' } as const;

let serial = 0;
export const uid = (p = 'r') => `${p}-${Date.now().toString(36)}-${++serial}`;

export function useFakes(over: Partial<typeof fakeLib> = {}) {
  seam.rendered = undefined;
  seam.lib = { ...fakeLib, transition, planCustomer: (item, _r, _k, _c, p: Pinned) => ({ ...fxPlan(item.key), format: p.format, pinned: p }), ...over };
}

export interface Call { path: string; key: string; body: Record<string, unknown> }
export type Script = (key: string, n: number) => Response | Promise<Response> | null;
export const message = (text: string, over: object = {}) => Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content: text ? [{ type: 'text', text }] : [], stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...over });

/** Counts every model call by customer. `script` overrides the answer for one call; null means the default good draft. */
export function fakeLlm(script?: Script): Call[] {
  const calls: Call[] = [];
  seam.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const key = String((body.messages as { content: string }[])[0].content);
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 3100 });
    calls.push({ path: String(url), key, body });
    const n = calls.filter((c) => c.key === key).length;
    return (await script?.(key, n)) ?? message(JSON.stringify(fxModelJson(key)));
  }) as typeof fetch;
  return calls;
}

export interface SeedOpts { status?: string; format?: RunFormat; cap?: number; stage?: string; committed?: number; pool?: number }
export async function seedRun(id: string, o: SeedOpts = {}) {
  await db.prepare(`INSERT OR IGNORE INTO snapshots (id, fetched_at, product_rows, usable_rows) VALUES (?, ?, 50, 50)`)
    .bind(SNAP, fxCatalog().fetched_at).run();
  await env.BUCKET.put(`customers/${id}.tsv`, 'fake');
  await env.BUCKET.put(`recs/${id}.json`, JSON.stringify({ rows: [] }));
  await db.prepare(`INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic,
    recs_sha256, setting, prompt_version, voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256,
    expected_usd, committed_usd, pool_usd, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, '2026-11-01', ?, ?, 1, ?, 'sonnet-between_tools', 'v1', 'v1', 's', 'jev-1.14.0', 'jev-v1', ?, ?, 'p', 0, ?, ?, ?, 'test', 't')`)
    .bind(id, id, o.stage ?? 'isolation', o.format ?? 'both', SNAP, id, `customers/${id}.tsv`, id, o.cap ?? 10, o.cap ?? 10, o.committed ?? 0, o.pool ?? 0, o.status ?? 'preparing').run();
}

export const unit = (run: string, key: string) => db.prepare('SELECT * FROM units WHERE run_id = ? AND customer_id = ?').bind(run, key)
  .first<{ status: string; code: string | null; billed_attempts: number; error_detail: string | null; setting: string | null }>();
export const units = async (run: string) => Object.fromEntries((await db.prepare('SELECT customer_id, status, code FROM units WHERE run_id = ?').bind(run)
  .all<{ customer_id: string; status: string; code: string | null }>()).results.map((u) => [u.customer_id, u.code ? `${u.status}:${u.code}` : u.status]));
export const cost = (run: string, key: string, attempt: number) => db.prepare('SELECT * FROM cost_events WHERE run_id = ? AND customer_id = ? AND attempt = ?')
  .bind(run, key, attempt).first<{ call_state: string; action: string; charged_usd: number | null; est_usd: number; commit_usd: number; reason: string | null; request_sha256: string | null }>();
export const generation = (run: string, key: string, n: number) => db.prepare('SELECT * FROM generations WHERE run_id = ? AND customer_id = ? AND attempt = ?')
  .bind(run, key, n).first<{ result_type: string; stop_detail: string | null }>();
export const runRow = (id: string) => db.prepare('SELECT * FROM runs WHERE id = ?').bind(id)
  .first<{ status: string; stop_reason: string | null; instance_id: string; spent_usd: number; pool_usd: number; committed_usd: number; results_sha256: string | null;
    prompt_version: string; jev_disabled_reason: string | null; cap_run_usd: number; ceiling_usd: number; expected_usd: number; preview_sha256: string }>();
export const draft = (run: string, key: string, v: number) => db.prepare('SELECT * FROM drafts WHERE id = ?').bind(`${run}:${key}:v${v}`)
  .first<{ status: string; model_json: string; content_sha256: string; envelope_json: string; hard_failures: number }>();
