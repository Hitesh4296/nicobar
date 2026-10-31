// The cap, with `E_out`, `S`, `U_*` keyed `both`. Pure but for `retryGate` and the statements `settle` builds.
// Prices: a §6 signature carries no model, so `callWorst` and `settle` price the first model in `prices`; callers narrow with `onePrice`.
import capJson from '../../../config/cap.json' with { type: 'json' };
import rungsJson from '../../../config/rungs.json' with { type: 'json' };
import pricesJson from '../../../config/prices.json' with { type: 'json' };
import type { Admission, AdmissionResult, CapConfig, Estimate, Guarded, PlanPreview, Prices, RunFormat, Rung, Usage } from '../../contracts/types.ts';

export const CAP = capJson as unknown as CapConfig;
export const RUNGS = rungsJson as unknown as Rung[];
export const PRICES = pricesJson as Prices;
export const rungOf = (id: string): Rung => {
  const r = RUNGS.find((x) => x.id === id);
  if (!r) throw new Error(`unknown rung ${id}`);
  return r;
};

export const onePrice = (p: Prices, model: string): Prices => ({ ...p, models: { [model]: p.models[model] } });
const price = (p: Prices) => Object.values(p.models)[0];

/** `input_tokens` here is the suffix: `S` is priced at the write rate. 42 §6's $0.0927 holds only this way. */
export function callWorst(input_tokens: number, max_tokens: number, format: RunFormat, cap: CapConfig, prices: Prices): number {
  const m = price(prices);
  return (cap.S[format] * m.write_5m + input_tokens * m.in + max_tokens * m.out) / 1e6;
}

/** `count_tokens` counts the whole request; the prefix goes at the write rate, the rest at the input rate. */
const suffixOf = (input_tokens: number, format: RunFormat, cap: CapConfig) => Math.max(0, input_tokens - cap.S[format]);
export function est1(input_tokens: number, format: RunFormat, rung: Rung, cap: CapConfig, prices: Prices): number {
  const m = price(onePrice(prices, rung.model));
  return (cap.S[format] * m.write_5m + suffixOf(input_tokens, format, cap) * m.in + cap.E_out[rung.id][format] * m.out) / 1e6;
}

export function capCustomer(format: RunFormat, rung: Rung, cap: CapConfig, prices: Prices): number {
  return 2 * callWorst(cap.U_design_max[format], rung.max_tokens[format], format, cap, onePrice(prices, rung.model));
}

/** `input_tokens < 0` means no estimate. One pass, ascending key. No ladder (out of scope): over the customer cap skips. */
export function admitAll(estimates: Estimate[], cap: CapConfig, rungs: Rung[], start: string, budget_usd: number | null, prices: Prices): AdmissionResult {
  const rung = rungs.find((r) => r.id === start);
  if (!rung) throw new Error(`unknown rung ${start}`);
  const one = onePrice(prices, rung.model);
  const per: Record<string, Admission> = {};
  const admitted: AdmissionResult['admitted'] = [];
  let committed_usd = 0; let stopped = false;
  for (const e of [...estimates].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const skip = (action: 'skip' | 'stop', code: Admission['code'], est_1_usd = 0): Admission =>
      ({ setting: rung.id, input_tokens: Math.max(0, e.input_tokens), est_1_usd, commit_usd: 0, action, code });
    if (!(e.input_tokens >= 0)) { per[e.key] = skip('skip', 'ESTIMATE_FAILED'); continue; }
    const suffix = suffixOf(e.input_tokens, e.format, cap);
    const est_1_usd = est1(e.input_tokens, e.format, rung, cap, prices);
    if (suffix > cap.U_hard[e.format] || 2 * callWorst(suffix, rung.max_tokens[e.format], e.format, cap, one) > capCustomer(e.format, rung, cap, prices)) {
      per[e.key] = skip('skip', 'OVER_CAP', est_1_usd); continue;
    }
    const commit_usd = 2 * est_1_usd;
    if (stopped || (budget_usd !== null && committed_usd + commit_usd > budget_usd)) {
      stopped = true; per[e.key] = skip('stop', 'RUN_CAP', est_1_usd); continue;
    }
    committed_usd += commit_usd;
    per[e.key] = { setting: rung.id, input_tokens: e.input_tokens, est_1_usd, commit_usd, action: 'admit' };
    admitted.push({ key: e.key, format: e.format });
  }
  return { per, admitted, committed_usd };
}

export function capRun(preview: PlanPreview): { ceiling_usd: number; cap_run_usd: number } {
  const ceiling_usd = preview.sum_commit_usd + preview.jev_reserve_usd;
  return { ceiling_usd, cap_run_usd: 1.05 * ceiling_usd };
}

const COST_KEY = 'run_id = ? AND customer_id = ? AND attempt = ?';

/** The gate's result is the attempt 2 row, so a replay reads it and takes nothing. The pool take and the row are one batch. */
export async function retryGate(db: D1Database, run_id: string, key: string, est_retry_usd: number): Promise<boolean> {
  const stored = async () => (await db.prepare(`SELECT action FROM cost_events WHERE ${COST_KEY}`).bind(run_id, key, 2).first<{ action: string }>())?.action;
  const seen = await stored();
  if (seen) return seen === 'retry';
  const run = await db.prepare('SELECT setting, format, spent_usd, cap_run_usd FROM runs WHERE id = ?').bind(run_id).first<{ setting: string; format: RunFormat; spent_usd: number; cap_run_usd: number }>();
  const first = await db.prepare(`SELECT charged_usd FROM cost_events WHERE ${COST_KEY}`).bind(run_id, key, 1).first<{ charged_usd: number | null }>();
  if (!run) throw new Error(`run not found: ${run_id}`);
  const at = new Date().toISOString();
  const block = async (reason: string) => {
    await db.prepare(`INSERT OR IGNORE INTO cost_events (run_id, customer_id, attempt, setting, est_usd, action, call_state, reason, at)
      VALUES (?, ?, 2, ?, ?, 'retry_blocked', 'blocked', ?, ?)`).bind(run_id, key, run.setting, est_retry_usd, reason, at).run();
    return false;
  };
  if ((first?.charged_usd ?? 0) + est_retry_usd > capCustomer(run.format, rungOf(run.setting), CAP, PRICES)) return block('customer_cap');
  if (run.spent_usd + est_retry_usd > run.cap_run_usd) return block('run_cap');
  await db.batch([
    db.prepare('UPDATE runs SET pool_usd = pool_usd - ?1 WHERE id = ?2 AND pool_usd >= ?1').bind(est_retry_usd, run_id),
    db.prepare(`INSERT OR IGNORE INTO cost_events (run_id, customer_id, attempt, setting, est_usd, commit_usd, action, call_state, at)
      SELECT ?, ?, 2, ?, ?, ?, 'retry', 'estimated', ? WHERE changes() = 1`).bind(run_id, key, run.setting, est_retry_usd, est_retry_usd, at),
  ]);
  return (await stored()) === 'retry' || block('pool_empty');
}

interface Charge { charged: number | 'est' | null; billed: boolean; state: 'answered' | 'possibly_billed' | 'unbilled'; from: string[] }
/** One attempt's money, run and unit before the row whose state guards them. A D1 batch is one transaction, so a replay finds the guard moved and changes nothing. */
function money(db: D1Database, run_id: string, key: string, attempt: number, c: Charge): Guarded[] {
  const k = [run_id, key, attempt];
  const guard = `EXISTS (SELECT 1 FROM cost_events WHERE ${COST_KEY} AND call_state IN (${c.from.map(() => '?').join(',')}))`;
  const row = `(SELECT %s FROM cost_events WHERE ${COST_KEY})`;
  const charged = c.charged === 'est' ? row.replace('%s', 'est_usd') : '?';
  const v = c.charged === 'est' ? k : [c.charged ?? 0];
  const items: Guarded[] = [{ expectOne: false, stmt: db.prepare(`UPDATE runs SET spent_usd = spent_usd + ${charged},
      pool_usd = pool_usd + MAX(0, COALESCE(${row.replace('%s', 'commit_usd')}, 0) - ${charged}) WHERE id = ? AND ${guard}`)
    .bind(...v, ...k, ...v, run_id, ...k, ...c.from) }];
  if (c.billed) items.push({ expectOne: false, stmt: db.prepare(`UPDATE units SET billed_attempts = billed_attempts + 1
    WHERE run_id = ? AND customer_id = ? AND billed_attempts < ? AND ${guard}`).bind(run_id, key, attempt, ...k, ...c.from) });
  const set = c.charged === 'est' ? 'charged_usd = est_usd' : 'charged_usd = ?';
  items.push({ expectOne: true, stmt: db.prepare(`UPDATE cost_events SET call_state = ?, ${set} WHERE ${COST_KEY} AND call_state IN (${c.from.map(() => '?').join(',')})`)
    .bind(c.state, ...(c.charged === 'est' ? [] : [c.charged]), ...k, ...c.from) });
  return items;
}

export function settle(db: D1Database, run_id: string, key: string, attempt: number, msg: { usage: Usage; stop_reason?: string; category?: string | null; content_empty: boolean }, prices: Prices): Guarded[] {
  const billed = msg.stop_reason !== 'refusal' || !msg.content_empty || prices.billed_refusal_categories.includes(msg.category ?? '');
  const m = price(prices); const u = msg.usage;
  const charged = billed ? (u.input_tokens * m.in + u.output_tokens * m.out + (u.cache_read_input_tokens ?? 0) * m.read + (u.cache_creation_input_tokens ?? 0) * m.write_5m) / 1e6 : 0;
  return money(db, run_id, key, attempt, { charged, billed, state: 'answered', from: ['calling'] });
}
/** A call that may have completed: charged at the estimate, billed. */
export const settleAtEstimate = (db: D1Database, run_id: string, key: string, attempt: number) =>
  money(db, run_id, key, attempt, { charged: 'est', billed: true, state: 'possibly_billed', from: ['calling'] });
/** A call that cost nothing: the commit goes back to the pool. */
export const settleUnbilled = (db: D1Database, run_id: string, key: string, attempt: number) =>
  money(db, run_id, key, attempt, { charged: null, billed: false, state: 'unbilled', from: ['estimated', 'calling'] });
