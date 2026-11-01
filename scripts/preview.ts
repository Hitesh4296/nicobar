// Stage 0 and G: plans, count_tokens, admitAll, no budget. $0, no Jev call. Writes R2 `previews/<sha256>.json` and no D1 row.
//   node scripts/preview.ts [--prompt-dir <dir>] [--format both|email|landing_page] [--rung <id>]
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import jev from '../config/jev.json' with { type: 'json' };
import type { PlanPreview, RunFormat } from '../src/contracts/types.ts';
import { canonicalContent } from '../src/lib/gen/canonical.ts';
import { previewBody } from '../src/lib/preview.ts';
import { countTokens, jsonLog, planAll, realDeps, rungOf, sha256Hex, type Common, type Deps } from './draft-one.ts';
import { PROMPT_DIR, readPromptDir } from './prompt-dir.ts';

export async function preview(o: Common, d: Deps & { put: (key: string, text: string) => Promise<unknown> }): Promise<{ sha256: string; body: PlanPreview }> {
  const { pinned, plans } = planAll(o, 'preview', d);
  const body = await previewBody({ ...o, prompt_sha256: sha256Hex(canonicalContent(o.prompt)), rung: rungOf(d, o.rung), pinned, plans, cat: d.inputs.cat, cap: d.cap, cap_sha256: sha256Hex(JSON.stringify(d.cap)), rungs: d.rungs, prices: d.prices,
    jev_basis_usd: jev.basis_usd, count: (req) => countTokens(d.client, req) });
  const text = JSON.stringify(body);
  const sha256 = sha256Hex(text);
  await d.put(`previews/${sha256}.json`, text);
  return { sha256, body };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { 'prompt-dir': { type: 'string' }, format: { type: 'string' }, rung: { type: 'string' } } });
  const dir = v['prompt-dir'] ?? PROMPT_DIR;
  const { deps, proxy } = await realDeps();
  const r = await preview({ prompt: readPromptDir(dir), promptId: dir.split('/').filter(Boolean).at(-1)!, format: (v.format ?? 'both') as RunFormat, rung: v.rung },
    { ...deps, put: (k, t) => (proxy.env as unknown as Env).BUCKET.put(k, t) });
  jsonLog({ step: 'preview', sha256: r.sha256, sum_commit_usd: r.body.sum_commit_usd, plans: r.body.plans.length });
  await proxy.dispose();
}
