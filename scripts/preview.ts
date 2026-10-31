// Stage 0 and G: plans, count_tokens, admitAll, no budget. $0, no Jev call. Writes R2 `previews/<sha256>.json` and no D1 row.
//   node scripts/preview.ts [--prompt-dir <dir>] [--format both|email|landing_page] [--rung <id>]
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import jev from '../config/jev.json' with { type: 'json' };
import type { Admission, Estimate, PlanPreview, RunFormat } from '../src/contracts/types.ts';
import { canonicalContent } from '../src/lib/gen/canonical.ts';
import { buildRequest } from '../src/lib/gen/index.ts';
import { countTokens, jsonLog, planAll, realDeps, rungOf, sha256Hex, type Common, type Deps } from './draft-one.ts';
import { readPromptDir } from './prompt-dir.ts';

const NO_ESTIMATE = (setting: string): Admission => ({ setting, input_tokens: 0, est_1_usd: 0, commit_usd: 0, action: 'skip', code: 'ESTIMATE_FAILED' });

export async function preview(o: Common, d: Deps & { put: (key: string, text: string) => Promise<unknown> }): Promise<{ sha256: string; body: PlanPreview }> {
  const rung = rungOf(d, o.rung);
  const { pinned, plans } = planAll(o, 'preview', d);
  const ready = plans.filter((p) => p.outcome.kind === 'ready');
  const estimates: Estimate[] = (await Promise.all(ready.map(async (plan) => {
    try {
      const input_tokens = await countTokens(d.client, buildRequest(plan, pinned, d.inputs.cat, rung, o.prompt));
      return [{ key: plan.customer_id, format: plan.format, rung: rung.id, input_tokens }];
    } catch { return []; }
  }))).flat();
  const adm = d.lib.admitAll(estimates, d.cap, d.rungs, rung.id, null, d.prices);
  const body: PlanPreview = { customers_sha256: pinned.customers_sha256, recs_sha256: pinned.recs_sha256, snapshot_id: pinned.snapshot_id, prompt_version: o.promptId,
    prompt_sha256: sha256Hex(canonicalContent(o.prompt)), format: o.format, start_rung: rung.id, cap_sha256: sha256Hex(JSON.stringify(d.cap)),
    // J3 only since J2 went: at most 2 requests a customer.
    jev_reserve_usd: adm.admitted.length * 2 * jev.basis_usd, sum_commit_usd: adm.committed_usd,
    plans: plans.map((p) => (p.outcome.kind === 'ready' ? { ...p, admission: adm.per[p.customer_id] ?? NO_ESTIMATE(rung.id) } : p)) };
  const text = JSON.stringify(body);
  const sha256 = sha256Hex(text);
  await d.put(`previews/${sha256}.json`, text);
  return { sha256, body };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { 'prompt-dir': { type: 'string' }, format: { type: 'string' }, rung: { type: 'string' } } });
  const dir = v['prompt-dir'] ?? 'config/prompt/v1';
  const { deps, proxy } = await realDeps();
  const r = await preview({ prompt: readPromptDir(dir), promptId: dir.split('/').filter(Boolean).at(-1)!, format: (v.format ?? 'both') as RunFormat, rung: v.rung },
    { ...deps, put: (k, t) => (proxy.env as unknown as Env).BUCKET.put(k, t) });
  jsonLog({ step: 'preview', sha256: r.sha256, sum_commit_usd: r.body.sum_commit_usd, plans: r.body.plans.length });
  await proxy.dispose();
}
