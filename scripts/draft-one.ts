// Capped model calls for the voice loop, in process, no Workflow. One attempt per customer; `seed.ts --voice` renders later.
//   node scripts/draft-one.ts --limit-usd <n> [--prompt-dir <dir>] [--only <customer_id>] [--label <l>] [--format both|email|landing_page] [--rung <id>]
// ANTHROPIC_BASE_URL at scripts/stub-llm.ts costs $0. Needs `build --publish` for the local catalogue.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import jev from '../config/jev.json' with { type: 'json' };
import type { Lib } from '../src/contracts/lib.ts';
import type { AnthropicRequest, CapConfig, Catalog, Envelope, Pinned, Plan, Prices, PromptFiles, RunFormat, Rung, Usage } from '../src/contracts/types.ts';
import { buildRequest, partsOf, toModelJson } from '../src/lib/gen/index.ts';
import { PROMPT_DIR, readPromptDir } from './prompt-dir.ts';

export interface Inputs { customers: string; recs: string; keys: string; shapes: string; cat: Catalog }   // raw text: the hashes are of the bytes
export interface Deps {
  lib: Pick<Lib, 'ingestTsv' | 'parseRecs' | 'parseRowKeys' | 'planCustomer' | 'validate' | 'callWorst' | 'admitAll'>;
  client: Anthropic; inputs: Inputs; cap: CapConfig; prices: Prices; rungs: Rung[]; log: (line: Record<string, unknown>) => void;
}
export interface Common { prompt: PromptFiles; promptId: string; format: RunFormat; rung?: string }
export interface Options extends Common { limitUsd: number; label: string; outDir: string; only?: string }

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const jsonLog = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export function makeClient(env: Record<string, string | undefined>): Anthropic {
  // A stub needs no key; the SDK refuses an empty one.
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? (env.ANTHROPIC_BASE_URL ? 'stub' : undefined), baseURL: env.ANTHROPIC_BASE_URL, maxRetries: 0 });
}

export function rungOf(d: Deps, id?: string): Rung {
  const r = id ? d.rungs.find((x) => x.id === id) : d.rungs[0];
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

export function planAll(o: Common, run_id: string, d: Deps): { pinned: Pinned; plans: Plan[] } {
  const { customers, recs, keys, shapes, cat } = d.inputs;
  const pinned: Pinned = { snapshot_id: cat.snapshot_id, customers_sha256: sha256Hex(customers), recs_sha256: sha256Hex(recs), shapes_sha256: sha256Hex(shapes),
    run_date: new Date().toISOString().slice(0, 10), prompt_version: o.promptId, voice_guide_version: o.promptId, jev_model: jev.model, jev_config_version: jev.version, format: o.format };
  const file = d.lib.parseRecs(JSON.parse(recs)), rows = file.rows;
  const rowKeys = d.lib.parseRowKeys(JSON.parse(keys));
  const plans = d.lib.ingestTsv(customers).map((item) =>
    ({ ...d.lib.planCustomer(item, rows.find((r) => r.customer_id === item.key) ?? null, rowKeys, cat, pinned, JSON.parse(shapes)), run_id, ...(file.generated_by ? { generated_by: { ranking: file.generated_by } } : {}) }));
  return { pinned, plans };
}

export const countTokens = async (client: Anthropic, req: AnthropicRequest) => {
  const { max_tokens: _omit, ...body } = req;
  return (await client.messages.countTokens(body as never)).input_tokens;
};

export const charged = (u: Usage, p: Prices['models'][string]) =>
  (u.input_tokens * p.in + (u.cache_creation_input_tokens ?? 0) * p.write_5m + (u.cache_read_input_tokens ?? 0) * p.read + u.output_tokens * p.out) / 1e6;

export async function draftOne(o: Options, d: Deps): Promise<{ spent_usd: number; stopped: boolean; written: string[] }> {
  const run_id = `voice-${o.label}`;
  const rung = rungOf(d, o.rung);
  const cat = d.inputs.cat;
  const { pinned, plans } = planAll(o, run_id, d);
  const chosen = o.only ? plans.filter((p) => p.customer_id === o.only) : plans;
  if (o.only && !chosen.length) d.log({ run_id, key: o.only, step: 'plan', status: 'failed', code: 'NOT_IN_INPUT' });
  const dir = join(o.outDir, o.label);
  const written: string[] = [];
  let spent_usd = 0;

  for (const plan of chosen) {
    const key = plan.customer_id;
    if (plan.outcome.kind !== 'ready') {
      d.log({ run_id, key, step: 'plan', status: plan.outcome.kind, code: plan.outcome.code });
      continue;
    }
    const req = buildRequest(plan, pinned, cat, rung, o.prompt);
    let input_tokens: number;
    try { input_tokens = await countTokens(d.client, req); } catch {
      d.log({ run_id, key, step: 'estimate', status: 'skipped', code: 'ESTIMATE_FAILED' });
      continue;
    }
    const est_usd = d.lib.callWorst(input_tokens, req.max_tokens, plan.format, d.cap, d.prices);
    if (spent_usd + est_usd > o.limitUsd) {
      d.log({ run_id, key, step: 'limit', status: 'stopped', code: 'LIMIT', est_usd, spent_usd, limit_usd: o.limitUsd });
      return { spent_usd, stopped: true, written };
    }
    const started = Date.now();
    let message: Anthropic.Message;
    try {
      message = await d.client.messages.create(req as never) as Anthropic.Message;
    } catch (e) {
      spent_usd += est_usd;   // it may have billed, so the limit counts its worst
      d.log({ run_id, key, step: 'gen', status: 'possibly_billed', code: (e as Error).name, ms: Date.now() - started, est_usd, spent_usd });
      continue;
    }
    const charged_usd = charged(message.usage as Usage, d.prices.models[rung.model]);
    spent_usd += charged_usd;
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const model_json = toModelJson(text, partsOf(plan.format));
    const envelope: Envelope = { customer_id: key, display_name: plan.display_name, run_id, format: plan.format, picks: plan.picks.map(({ slot, product_id }) => ({ slot, product_id })),
      occasion_key: plan.occasion_key, shape: plan.shape, snapshot_id: cat.snapshot_id, snapshot_fetched_at: cat.fetched_at, model: rung.model, setting: rung.id,
      prompt_version: o.promptId, voice_guide_version: o.promptId, validator_version: 'unset', carried_from: null, carried_part: null };
    const record = { plan, envelope, request_sha256: sha256Hex(JSON.stringify(req)), message, model_json, checks: null as unknown };
    const file = join(dir, `${key}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(record));   // paid for: on disk before anything else can throw
    written.push(file);
    try {
      record.checks = d.lib.validate(JSON.stringify(model_json), envelope, cat, plan);
      writeFileSync(file, JSON.stringify(record));
    } catch (e) {
      d.log({ run_id, key, step: 'validate', status: 'failed', code: (e as Error).message });
    }
    d.log({ run_id, key, step: 'gen', status: message.stop_reason, ms: Date.now() - started, est_usd, charged_usd, spent_usd });
  }
  return { spent_usd, stopped: false, written };
}

export function parseCli(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, options: { 'limit-usd': { type: 'string' }, 'prompt-dir': { type: 'string' }, only: { type: 'string' },
    label: { type: 'string' }, format: { type: 'string' }, rung: { type: 'string' } } });
  const limitUsd = Number(v['limit-usd']);
  if (!(limitUsd > 0)) throw new Error('--limit-usd <n> is required, above 0');
  const promptDir = v['prompt-dir'] ?? PROMPT_DIR;
  const promptId = basename(promptDir);
  const format = (v.format ?? 'both') as RunFormat;
  if (!['both', 'email', 'landing_page'].includes(format)) throw new Error(`bad --format ${format}`);
  return { limitUsd, promptDir, promptId, label: v.label ?? promptId, only: v.only, format, rung: v.rung };
}

/** Real wiring. The catalogue and bucket are local wrangler state, the same files `build --publish` wrote. `devVars: false` is the demo's: neither this process nor wrangler's proxy opens .dev.vars. */
export async function realDeps(devVars = true) {
  if (devVars) try { process.loadEnvFile('.dev.vars'); } catch { /* no file: stub, or a key already in the environment */ }
  const [{ getPlatformProxy }, ingest, recs, plan, check, cost, catalog] = await Promise.all([import('wrangler'), import('../src/lib/ingest.ts'), import('../src/lib/recs.ts'),
    import('../src/lib/plan.ts'), import('../src/lib/check/index.ts'), import('../src/lib/cost/index.ts'), import('../src/lib/catalog/index.ts')]);
  const read = (f: string) => readFileSync(f, 'utf8');
  const proxy = await getPlatformProxy(devVars ? undefined : { envFiles: ['out/empty.env'] });   // [] would fall back to .dev.vars
  const recsText = read('data/recommendations.synthetic.json');
  const cat = await catalog.loadCatalog(proxy.env as never, JSON.parse(recsText).snapshot_id);
  const deps: Deps = { lib: { ...ingest, ...recs, ...plan, ...check, ...cost }, client: makeClient(process.env), log: jsonLog,
    cap: JSON.parse(read('config/cap.json')), prices: JSON.parse(read('config/prices.json')), rungs: JSON.parse(read('config/rungs.json')),
    inputs: { customers: read('data/customers.with-c20.synthetic.tsv'), recs: recsText, keys: read('data/row_keys.synthetic.json'), shapes: read('config/shapes.json'), cat } };
  return { deps, proxy };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseCli(process.argv.slice(2));
  const { deps, proxy } = await realDeps();
  const r = await draftOne({ ...a, prompt: readPromptDir(a.promptDir), outDir: 'out/voice' }, deps);
  jsonLog({ step: 'done', spent_usd: r.spent_usd, stopped: r.stopped, written: r.written.length });
  await proxy.dispose();
}
