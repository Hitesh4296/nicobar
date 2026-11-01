// Final evaluation only (R124): Sonnet answers Jev's own j3 questions and must quote what it objects to. Not in the live batch.
//   node scripts/judge.ts --limit-usd <n> [--cases heldout|drafts] [--run <run_id>] [--only <id>]
// Both judges read the same `j3Input`, nothing of the plant label. A rerun skips what is already answered, so a stopped pass resumes without paying twice.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';
import jevConfig from '../config/jev.json' with { type: 'json' };
import { flaggedQuestions, j3Input, judgeDraft } from '../src/lib/jev/index.ts';
import type { AnthropicRequest, AppEnv, DraftRow, Format, J3Input, JevConfig, JevOutcome, Plan, Prices, Usage } from '../src/contracts/types.ts';
import { charged, countTokens, jsonLog, makeClient, realDeps } from './draft-one.ts';
import { heldoutCatalog, heldoutPlan } from './eval.ts';

export const JUDGE_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 2000;
const round = (n: number) => Number(n.toFixed(6));

export interface Item { id: string; source: 'heldout' | 'draft'; customer: string; occasion: string | null; input: J3Input }
export interface JudgeDeps { client: Anthropic; jev: (input: J3Input) => Promise<JevOutcome>; cfg: JevConfig; prices: Prices; log: (l: Record<string, unknown>) => void }
export interface JudgeOpts { limitUsd: number; outDir: string; file: string }
interface Answer { flag: boolean; quote: string; why: string; quote_invalid: boolean }

const flagWhen = (q: JevConfig['j3'][string]) => (q.type === 'score' ? 'flag true when the lowest of these rungs is the best fit' : q.bad ? 'flag true when the answer is yes' : 'flag true when the answer is no');

export function buildJudgeRequest(input: J3Input, cfg: JevConfig) {
  const questions = Object.entries(cfg.j3).map(([id, q]) => JSON.stringify({ id, instructions: q.instructions, criteria: q.criteria, flag_rule: flagWhen(q) })).join('\n');
  const answer = { type: 'object', properties: { flag: { type: 'boolean' }, quote: { type: 'string' }, why: { type: 'string' } }, required: ['flag', 'quote', 'why'], additionalProperties: false };
  const system = `You judge one piece of marketing copy. The user message is a JSON object with \`email\`, \`landing_page\`, \`picks\`, \`occasion\` and \`quote\`. Answer every question below for that object.
flag means something is wrong, by each question's flag_rule. When flag is true, quote the shortest run of words that shows it, copied character for character from \`email\` or \`landing_page\`, and say why in one plain sentence. When flag is false, quote is an empty string.

${questions}`;
  return { model: JUDGE_MODEL, max_tokens: MAX_TOKENS, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], thinking: { type: 'between_tools' },   // the system prompt is the same for every case
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: Object.fromEntries(Object.keys(cfg.j3).map((id) => [id, answer])), required: Object.keys(cfg.j3), additionalProperties: false } } } };
}

/** Code decides, not the model: a quote that is not in the text sent is recorded, and a flag with no quote has shown nothing. */
function readAnswers(text: string, input: J3Input, cfg: JevConfig): Record<string, Answer> | null {
  let parsed: Record<string, Omit<Answer, 'quote_invalid'>>;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Object.keys(cfg.j3).every((q) => typeof parsed?.[q]?.flag === 'boolean')) return null;
  const sent = [input.email, input.landing_page].filter(Boolean).join('\n');
  return Object.fromEntries(Object.keys(cfg.j3).map((q) => {
    const { flag, quote, why } = parsed[q];
    return [q, { flag, quote, why, quote_invalid: quote ? !sent.includes(quote) : flag }];
  }));
}

const readFile = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { cases: { id: string; jev: { status: string }; sonnet: { status: string } }[] } : { cases: [] });
const isDone = (c: { jev: { status: string }; sonnet: { status: string } }) => c.jev.status === 'answered' && c.sonnet.status === 'answered';

export async function judgeAll(items: Item[], o: JudgeOpts, d: JudgeDeps): Promise<{ spent_usd: number; stopped: boolean; judged: number }> {
  const price = d.prices.models[JUDGE_MODEL];
  const out = readFile(o.file);
  const done = new Set(out.cases.filter(isDone).map((c) => c.id));
  mkdirSync(o.outDir, { recursive: true });
  let spent_usd = 0, judged = 0;
  for (const item of items.filter((i) => !done.has(i.id))) {
    const req = buildJudgeRequest(item.input, d.cfg);
    let input_tokens: number;
    try { input_tokens = await countTokens(d.client, req as unknown as AnthropicRequest); } catch {
      d.log({ key: item.id, step: 'estimate', status: 'skipped', code: 'ESTIMATE_FAILED' });
      continue;
    }
    const est_usd = (input_tokens * price.write_5m + MAX_TOKENS * price.out) / 1e6 + d.cfg.basis_usd;
    if (spent_usd + est_usd > o.limitUsd) {
      d.log({ key: item.id, step: 'limit', status: 'stopped', code: 'LIMIT', est_usd, spent_usd, limit_usd: o.limitUsd });
      return { spent_usd, stopped: true, judged };
    }
    const jev = await d.jev(item.input);
    let message: Anthropic.Message;
    try {
      message = await d.client.messages.create(req as never) as Anthropic.Message;
    } catch (e) {
      spent_usd += est_usd;   // it may have billed, so the limit counts its worst
      d.log({ key: item.id, step: 'sonnet', status: 'possibly_billed', code: (e as Error).name, est_usd, spent_usd });
      continue;
    }
    const sonnet_usd = charged(message.usage as Usage, price);
    const jev_usd = jev.charged_usd ?? 0;
    spent_usd += sonnet_usd + jev_usd;
    writeFileSync(join(o.outDir, `${item.id.replaceAll(':', '_')}.json`), JSON.stringify({ message, jev }));   // paid for: on disk before anything else can throw
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const answers = message.stop_reason === 'refusal' ? null : readAnswers(text, item.input, d.cfg);
    const scores = Object.fromEntries(Object.entries(jev.answers ?? {}).map(([q, a]) => { const r = a as { noul?: number; score?: number }; return [q, r.noul ?? r.score ?? null]; }));
    const row = { id: item.id, source: item.source, customer: item.customer, occasion: item.occasion, text: [item.input.email, item.input.landing_page].filter(Boolean).join('\n\n'),
      jev: { status: jev.status, reason: jev.reason, flags: jev.answers ? flaggedQuestions(jev.answers, d.cfg) : [], scores },
      sonnet: { status: message.stop_reason === 'refusal' ? 'refused' : answers ? 'answered' : 'bad_output', answers }, cost: { jev_usd: round(jev_usd), sonnet_usd: round(sonnet_usd) } };
    out.cases = [...out.cases.filter((c) => c.id !== item.id), row];
    writeFileSync(o.file, `${JSON.stringify(out, null, 1)}\n`);
    judged++;
    d.log({ key: item.id, step: 'judged', status: row.sonnet.status, jev: jev.status, sonnet_usd, jev_usd, spent_usd });
  }
  return { spent_usd, stopped: false, judged };
}

/** The questions these cases can answer: a length or an image is code's, and sends nothing. */
export function heldoutItems(): Item[] {
  const cat = heldoutCatalog();
  const rows = new Map((JSON.parse(readFileSync('test/cases/heldout-pack.json', 'utf8')).rows as any[]).map((r) => [r.customer_id, r]));
  return (JSON.parse(readFileSync('reports/cases.json', 'utf8')).cases as any[]).filter((c) => c.questions.length).map((c) => {
    const { plan, envelope } = heldoutPlan(rows.get(c.customer), c.part, cat);
    const row = { envelope_json: JSON.stringify(envelope), model_json: JSON.stringify({ [c.part as Format]: c.model }) } as DraftRow;
    return { id: c.id, source: 'heldout' as const, customer: c.customer, occasion: c.occasion, input: j3Input(row, plan, cat) };
  });
}

/** The latest version of each customer's draft in a run, read from local D1. */
async function draftItems(run?: string) {
  const { deps, proxy } = await realDeps();
  const db = (proxy.env as { DB: D1Database }).DB;
  const run_id = run ?? (await db.prepare(`SELECT id FROM runs WHERE id NOT LIKE 'stub-%' ORDER BY created_at DESC, id LIMIT 1`).first<{ id: string }>())?.id;
  if (!run_id) throw new Error('no real run in local D1');
  const drafts = (await db.prepare('SELECT d.*, p.plan_json FROM drafts d JOIN plans p ON p.run_id = d.run_id AND p.customer_id = d.customer_id WHERE d.run_id = ? ORDER BY d.customer_id, d.version').bind(run_id).all<DraftRow & { plan_json: string }>()).results;
  const latest = [...new Map(drafts.map((r) => [r.customer_id, r])).values()];
  const items = latest.map((r): Item => {
    const plan = JSON.parse(r.plan_json) as Plan;
    return { id: r.id, source: 'draft', customer: r.customer_id, occasion: plan.occasion, input: j3Input(r, plan, deps.inputs.cat) };
  });
  return { items, proxy };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { 'limit-usd': { type: 'string' }, cases: { type: 'string', default: 'heldout' }, run: { type: 'string' }, only: { type: 'string' } } });
  const limitUsd = Number(v['limit-usd']);
  if (!(limitUsd > 0)) throw new Error('--limit-usd <n> is required, above 0');
  if (v.cases !== 'heldout' && v.cases !== 'drafts') throw new Error(`bad --cases ${v.cases}`);
  try { process.loadEnvFile('.dev.vars'); } catch { /* no file: stub, or keys already in the environment */ }
  const found = v.cases === 'drafts' ? await draftItems(v.run) : { items: heldoutItems(), proxy: null };
  const items = v.only ? found.items.filter((i) => i.id === v.only) : found.items;
  if (!items.length) throw new Error('nothing to judge');
  const cfg = jevConfig as unknown as JevConfig;
  const r = await judgeAll(items, { limitUsd, outDir: 'out/judge', file: 'reports/judges.json' }, { client: makeClient(process.env), jev: (input) => judgeDraft(process.env as unknown as AppEnv, input, cfg), cfg,
    prices: JSON.parse(readFileSync('config/prices.json', 'utf8')), log: jsonLog });
  jsonLog({ step: 'done', ...r });
  await found.proxy?.dispose();
}
