// The preview body: plans plus the cap's admission. $0: count_tokens only. Used by scripts/preview.ts and the Start a run page.
import type { Admission, AnthropicRequest, CapConfig, Catalog, Estimate, Pinned, Plan, PlanPreview, Prices, PromptFiles, RunFormat, Rung } from '../contracts/types.ts';
import { admitAll } from './cost/index.ts';
import { buildRequest } from './gen/index.ts';

const NO_ESTIMATE = (setting: string): Admission => ({ setting, input_tokens: 0, est_1_usd: 0, commit_usd: 0, action: 'skip', code: 'ESTIMATE_FAILED' });

export interface PreviewIn { prompt: PromptFiles; promptId: string; prompt_sha256: string; format: RunFormat; rung: Rung; pinned: Pinned; plans: Plan[]; cat: Catalog; cap: CapConfig; cap_sha256: string; rungs: Rung[]; prices: Prices;
  jev_basis_usd: number; count: (req: AnthropicRequest) => Promise<number> }

export async function previewBody(o: PreviewIn): Promise<PlanPreview> {
  const ready = o.plans.filter((p) => p.outcome.kind === 'ready');
  const estimates: Estimate[] = (await Promise.all(ready.map(async (plan) => {
    try { return [{ key: plan.customer_id, format: plan.format, rung: o.rung.id, input_tokens: await o.count(buildRequest(plan, o.pinned, o.cat, o.rung, o.prompt)) }]; } catch { return []; }
  }))).flat();
  const adm = admitAll(estimates, o.cap, o.rungs, o.rung.id, null, o.prices);
  return { customers_sha256: o.pinned.customers_sha256, recs_sha256: o.pinned.recs_sha256, snapshot_id: o.pinned.snapshot_id, prompt_version: o.promptId, prompt_sha256: o.prompt_sha256, format: o.format, start_rung: o.rung.id, cap_sha256: o.cap_sha256,
    // J3 only since J2 went: at most 2 requests a customer.
    jev_reserve_usd: adm.admitted.length * 2 * o.jev_basis_usd, sum_commit_usd: adm.committed_usd,
    plans: o.plans.map((p) => (p.outcome.kind === 'ready' ? { ...p, admission: adm.per[p.customer_id] ?? NO_ESTIMATE(o.rung.id) } : p)) };
}
