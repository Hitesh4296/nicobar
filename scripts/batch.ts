// npm run batch -- --stage <s> [--format both|email|landing_page] [--rung <id>] [--only <customer>]. Preview, then POST /api/runs on a running `npm run dev`. RUN_KEY comes from .dev.vars.
// A real run spends: it needs ANTHROPIC_API_KEY in .dev.vars, and the cap comes from the preview. With ANTHROPIC_BASE_URL set the run is a stub run and is labelled so.
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import stages from '../config/stages.json' with { type: 'json' };
import type { RunFormat } from '../src/contracts/types.ts';
import { onlyCustomer } from '../src/lib/ingest.ts';
import { realDeps } from './draft-one.ts';
import { preview } from './preview.ts';
import { PROMPT_DIR, PROMPT_ID, readPromptDir } from './prompt-dir.ts';

const CUSTOMERS = 'data/customers.with-c20.synthetic.tsv';
export interface BatchArgs { stage: string; format: RunFormat; rung?: string; only?: string }

export function parseBatchArgs(argv: string[]): BatchArgs {
  const { values: v } = parseArgs({ args: argv, options: { stage: { type: 'string' }, format: { type: 'string' }, rung: { type: 'string' }, only: { type: 'string' } } });
  if (!v.stage) throw new Error(`usage: batch --stage <${Object.keys(stages).join('|')}> [--format both|email|landing_page] [--rung <id>]`);
  if (!(v.stage in stages)) throw new Error(`unknown stage ${v.stage}`);
  const format = (v.format ?? 'both') as RunFormat;
  if (!['both', 'email', 'landing_page'].includes(format)) throw new Error(`unknown format ${format}`);
  return { stage: v.stage, format, rung: v.rung, only: v.only };
}

export const runId = (stage: string, stamp: string, baseUrl: string | undefined) => `${baseUrl ? 'stub-' : ''}${stage}-${stamp}`;
export const wantsKey = (env: Record<string, string | undefined>) => !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_BASE_URL;

/** Returns the run id once the server has accepted it. The run itself goes on in the server. */
export async function batch(a: BatchArgs, serverUrl: string): Promise<string> {
  const { deps, proxy } = await realDeps();
  try {
    if (wantsKey(process.env)) throw new Error('no ANTHROPIC_API_KEY: put it in .dev.vars, or use `npm run demo`, which needs none');
    if (!process.env.RUN_KEY) throw new Error('no RUN_KEY: put it in .dev.vars');
    const customers_tsv = deps.inputs.customers;
    if (a.only) deps.inputs.customers = onlyCustomer(customers_tsv, a.only);
    const { sha256, body } = await preview({ prompt: readPromptDir(PROMPT_DIR), promptId: PROMPT_ID, format: a.format, rung: a.rung },
      { ...deps, put: (k, t) => (proxy.env as unknown as Env).BUCKET.put(k, t) });
    const run_id = runId(a.stage, Date.now().toString(36), process.env.ANTHROPIC_BASE_URL);
    const res = await fetch(`${serverUrl}/api/runs`, { method: 'POST', headers: { Origin: serverUrl, 'content-type': 'application/json', 'x-run-key': process.env.RUN_KEY }, body: JSON.stringify({
      run_id, stage: a.stage, snapshot_id: body.snapshot_id, customers_name: CUSTOMERS.split('/').at(-1), customers_tsv, ...(a.only ? { only: a.only } : {}), customers_synthetic: true,
      recs_json: deps.inputs.recs, preview_sha256: sha256 }) });
    if (!res.ok) throw new Error(`POST /api/runs ${res.status} ${await res.text()}`);
    console.log(JSON.stringify({ step: 'batch', ...await res.json() as object, start_rung: body.start_rung, sum_commit_usd: body.sum_commit_usd, plans: body.plans.length }));
    return run_id;
  } finally { await proxy.dispose(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.CONFIG_URL ?? 'http://localhost:8787';
  const id = await batch(parseBatchArgs(process.argv.slice(2)), base);
  console.log(`${base}/review?run=${id}`);
}
