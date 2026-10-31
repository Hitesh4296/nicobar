// J3, flag only. Jev judges prose; code reads the answer. Nothing here can reach a draft row, so a flag cannot change a check.
import quotes from '../../../config/quotes.json' with { type: 'json' };
import type { AppEnv, Catalog, DraftRow, Envelope, Format, J3Input, JevConfig, JevOutcome, JevStatus, ModelJson, Plan, QuotesFile } from '../../contracts/types.ts';
import { expand } from '../render/expand.ts';

const API = 'https://api.typesafe.ai/v1';
const USD_PER_INPUT_TOKEN = 0.042 / 1e6;   // [reported, docs.typesafe.ai/models 2026-10-29]; output is free. Not in config/prices.json
const BACKOFF_MS = 250;
const JEV_RESERVE_USD = 0.25;   // R111

export function j3Input(d: DraftRow, plan: Plan, cat: Catalog): J3Input {
  const envelope = JSON.parse(d.envelope_json) as Envelope;
  const m = JSON.parse(d.model_json) as ModelJson;
  const text = (part: Format) => { const model = m[part]; return model ? expand(model, part, envelope, cat).reader_text : null; };
  const sections = (m.landing_page?.sections ?? []) as { type: string; quote_id?: string }[];
  const quoteId = sections.find((s) => s.type === 'quote')?.quote_id;
  const quote = (quotes as QuotesFile).quotes.find((q) => q.id === quoteId)?.text ?? null;
  const landing = text('landing_page');
  return { email: text('email'),
    // ponytail: exact-match strip, so site copy is never judged as the model's words whatever reader_text holds; drop once gen confirms it excludes quotes
    landing_page: quote ? landing?.replaceAll(quote, '') ?? null : landing,
    quote,
    picks: plan.picks.map(({ product_id }) => {
      const p = cat.rows.get(product_id)!;   // X1 passed before J3 runs
      return { title: p.title, facets: [...new Set([...p.class, ...p.subcategory, ...p.wear_occasion, ...p.collection, ...(p.material_group ? [p.material_group] : [])])] };
    }),
    occasion: plan.occasion, occasion_key: plan.occasion_key, new_user: plan.new_user };
}

const headers = (env: AppEnv) => ({ authorization: `Bearer ${env.JEV_API_KEY}`, 'content-type': 'application/json' });
const failure = (e: unknown) => (e instanceof Error && e.name === 'TimeoutError' ? 'deadline' : e instanceof SyntaxError ? 'bad_response' : 'network');

/** 429 and 529 back off inside the one deadline; anything else, or no time left to wait, returns as it is. */
async function post(env: AppEnv, body: string, deadline_ms: number): Promise<Response> {
  const stop = Date.now() + deadline_ms;
  const signal = AbortSignal.timeout(deadline_ms);
  for (let wait = BACKOFF_MS; ; wait *= 2) {
    const res = await fetch(`${API}/systemone`, { method: 'POST', headers: headers(env), body, signal });
    if ((res.status !== 429 && res.status !== 529) || Date.now() + wait >= stop) return res;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function judgeDraft(env: AppEnv, input: J3Input, cfg: JevConfig): Promise<JevOutcome> {
  const outcome = (status: JevStatus, reason: string | null, over: Partial<JevOutcome> = {}): JevOutcome => ({ status, reason, model: null, answers: null,
    input_tokens: null, charged_usd: cfg.basis_usd, basis_usd: cfg.basis_usd, ...over });   // a sent request with no usage costs the basis, never $0
  if (!env.JEV_API_KEY) return outcome('unavailable', 'no_key', { charged_usd: null });
  try {
    const questions = Object.fromEntries(Object.entries(cfg.j3).map(([id, { type, instructions, criteria }]) => [id, { type, instructions, criteria }]));
    const res = await post(env, JSON.stringify({ model: cfg.model, state: input, questions }), cfg.deadline_ms);
    if (!res.ok) return outcome('unavailable', `http_${res.status}`);
    const body = await res.json() as { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number } } | null;
    const input_tokens = body?.usage?.input_tokens ?? null;
    const billed = { model: body?.model ?? null, input_tokens, charged_usd: input_tokens === null ? cfg.basis_usd : input_tokens * USD_PER_INPUT_TOKEN };
    if (!Object.keys(cfg.j3).every((id) => body?.answers?.[id])) return outcome('unavailable', 'bad_response', billed);
    if (body?.model !== cfg.model) return outcome('model_mismatch', 'model_mismatch', billed);   // a fallback: answers null, so no flag reads them
    return outcome('answered', null, { ...billed, answers: body.answers });
  } catch (e) {
    return outcome('unavailable', failure(e));
  }
}

/** The only reading of a gate. `answers` is `jev_events.answers_json`, raw: read Noul `noul`, Score `probabilities` and `confidence`. A missing answer is no flag. */
export function flaggedQuestions(answers: Record<string, unknown>, cfg: JevConfig): string[] {
  return Object.entries(cfg.j3).filter(([id, q]) => {
    const a = answers[id] as { noul?: number; probabilities?: Record<string, number>; confidence?: number } | null | undefined;
    if (q.type === 'noul') return typeof a?.noul === 'number' && (q.bad ? a.noul : 1 - a.noul) >= cfg.flag_gate;
    const p = a?.probabilities;
    return p?.['0'] !== undefined && p['0'] === Math.max(...Object.values(p)) && (a?.confidence ?? 0) >= cfg.score_flag_confidence;
  }).map(([id]) => id);
}

export const isFlagged = (answers: Record<string, unknown>, cfg: JevConfig): boolean => flaggedQuestions(answers, cfg).length > 0;

export async function jevPreflight(env: AppEnv, cfg: JevConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.JEV_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const res = await fetch(`${API}/models`, { headers: headers(env), signal: AbortSignal.timeout(cfg.deadline_ms) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return (await res.text()).includes(cfg.model) ? { ok: true } : { ok: false, reason: 'model_not_listed' };   // list shape unspecified
  } catch (e) {
    return { ok: false, reason: failure(e) };
  }
}

/** R111: cumulative across every run, $0.25. A row with no request is NULL and adds nothing. */
export async function jevReserveOk(db: D1Database, basis_usd: number): Promise<boolean> {
  const row = await db.prepare('SELECT COALESCE(SUM(charged_usd), 0) AS spent FROM jev_events').first<{ spent: number }>();
  return row!.spent + basis_usd <= JEV_RESERVE_USD;
}
