import { notBuilt } from '../../contracts/codes.ts';
import type { AdmissionResult, CapConfig, Estimate, Guarded, PlanPreview, Prices, RunFormat, Rung, Usage } from '../../contracts/types.ts';

export function callWorst(input_tokens: number, max_tokens: number, format: RunFormat, cap: CapConfig, prices: Prices): number { notBuilt('callWorst'); }
export function admitAll(estimates: Estimate[], cap: CapConfig, rungs: Rung[], start: string, budget_usd: number | null, prices: Prices): AdmissionResult { notBuilt('admitAll'); }
export function capRun(preview: PlanPreview): { ceiling_usd: number; cap_run_usd: number } { notBuilt('capRun'); }
export async function retryGate(db: D1Database, run_id: string, key: string, est_retry_usd: number): Promise<boolean> { notBuilt('retryGate'); }
export function settle(db: D1Database, run_id: string, key: string, attempt: number, msg: { usage: Usage; stop_reason?: string; category?: string | null; content_empty: boolean }, prices: Prices): Guarded[] { notBuilt('settle'); }
