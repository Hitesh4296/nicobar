// What each step of a customer's story holds, read from stored rows only. Every value is escaped here; a field nobody stored reads "not recorded".
import type { CheckResult, Envelope, Format, GeneratedBy, JevConfig, ModelJson, Part, Plan, ReasonCode, RunFormat, Usage } from '../contracts/types.ts';
import { CAP, PRICES, capCustomer, rungOf } from '../lib/cost/index.ts';
import { schemaId } from '../lib/gen/index.ts';
import { flaggedQuestions } from '../lib/jev/index.ts';
import { countMore, readCards } from '../lib/render/catalog.ts';
import { PART_NAME, QUESTION_NAMES, checkName, explainBlocks, failed, highlight } from './checks.ts';
import { esc } from './nb.ts';
import type { CostIn, CustomerData, DraftIn, EventIn, GenIn, JevIn, RunIn } from './timeline.ts';

export const EVIDENCE_CSS = `.ev{margin-top:8px;font-size:14px;line-height:20px}.ev>summary{color:var(--color-ink-soft)}.ev h3{margin:12px 0 4px;font:500 14px/20px var(--font-sans)}
.ev-kv{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr);gap:4px 16px;margin:8px 0}.ev-kv dt{color:var(--color-ink-soft)}.ev-kv dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.ev pre{max-height:360px;margin:8px 0;padding:12px;overflow:auto;border:1px solid var(--color-line);background:var(--color-white);font-size:13px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.ev-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:8px 0}.ev-pair p{margin:0 0 4px}@media (max-width:749px){.ev-kv,.ev-pair{grid-template-columns:minmax(0,1fr)}}`;

const NONE = 'not recorded';
const WHY_PICKED: Record<ReasonCode, string> = { OCCASION_MATCH: 'Fits the occasion', SAME_CLASS_NEW: 'A new piece of a kind they have bought', SAME_MATERIAL: 'The same material as a past purchase', TRIP_TAG: 'Marked for travel',
  FALLBACK_NON_OCCASION: 'Nothing fit the occasion, so the next best', HAND_SET: 'Set by hand', NEW_USER_PRIOR: 'New customer: a likely first choice for the season' };
const STOPS: Record<string, string> = { end_turn: 'Finished normally', max_tokens: 'Hit the length limit', refusal: 'The model refused', stop_sequence: 'Finished at a stop marker' };
const RESULTS: Record<string, string> = { answered: 'Answered', refusal: 'Refused', possibly_billed: 'No answer, and it may have been billed', no_completion: 'No answer', invalid_request: 'The request was refused as malformed' };
const DECIDED: Record<string, string> = { admit: 'Let in', skip: 'Skipped', stop: 'Stopped by the run cap', retry: 'Retry allowed', retry_blocked: 'Retry not allowed' };
const NO_RETRY: Record<string, string> = { customer_cap: 'A retry would pass the customer cap.', run_cap: 'A retry would pass the run cap.', pool_empty: 'The pool had too little left for a retry.' };

const parse = <T>(s: string | null | undefined): T | null => { try { return s ? JSON.parse(s) as T : null; } catch { return null; } };
export const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(4)}`);
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const count = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString('en-US') : NONE);
const money = (n: number | null | undefined) => (typeof n === 'number' ? usd(n) : NONE);
export const checksOf = (d: DraftIn) => parse<CheckResult[]>(d.checks_json) ?? [];
export const modelOf = (d: DraftIn) => parse<ModelJson>(d.model_json);
export const envelopeOf = (d: DraftIn | undefined) => parse<Partial<Envelope>>(d?.envelope_json);
export const titlesOf = (d: DraftIn) => new Map(readCards(d.catalog ?? '').map((c) => [c.slot, c.title]));

export const details = (title: string, body: string) => `<details class="ev"><summary>${esc(title)}</summary>${body}</details>`;
export const kv = (pairs: [string, unknown][]) => `<dl class="ev-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? NONE)}</dd>`).join('')}</dl>`;
const table = (head: string[], rows: string[][]) => `<table class="tl-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const OCCASION_WORD: Record<string, string> = { wedding: 'weddings', birthday: 'birthdays', festive: 'festive days', evening: 'evenings', resort: 'holidays', smart: 'smart days', housewarming: 'housewarmings', hosting: 'hosting', everyday: 'every day' };
const SIGNAL: Record<string, string> = { fitted_class: 'Fits this occasion', row_fit: 'Fits this customer', bestseller: "Bestseller, by the site's gift tag", prior_tag: 'In the current season', new_arrival: 'New on the site', fallback: 'No occasion tag', hand_set: 'Set by hand', new_user: 'New-customer pick' };
/** Signal names from the ranker in reviewer's words. No model text ever passes here. */
function plainSignal(s: string): string {
  const [name, word] = s.split(':');
  return name === 'occasion_tag' ? `Tagged for ${OCCASION_WORD[word] ?? word}` : name === 'goes_with' ? `Goes with your ${word}` : SIGNAL[s] ?? s;
}
const railWhy = (why: Record<string, string[]> | undefined) => {
  const n = new Map<string, number>();
  for (const s of Object.values(why ?? {}).flat()) n.set(s, (n.get(s) ?? 0) + 1);
  return [...n].map(([s, k]) => `${plainSignal(s)} ${k}`).join(' · ');
};

export function planEvidence(c: CustomerData): string {
  const p = c.plan as Plan | null;
  if (!p) return '';
  const cards = new Map(readCards(c.drafts.at(-1)?.catalog ?? '').map((x) => [x.slot, x]));
  const picks = (p.picks ?? []).map((k) => {
    const card = cards.get(k.slot), src = card && new URL(card.src);
    const image = src ? `<img src="${esc(src.origin + src.pathname)}?width=80" alt="${esc(card!.title)}" width="40" height="50" loading="lazy">` : '<span></span>';
    return `<div class="pick">${image}<div>${esc(card?.title ?? `Product ${k.product_id}, title not stored`)}<small>${esc(k.why?.map(plainSignal).join(' · ') ?? WHY_PICKED[k.reason_code] ?? NONE)}${k.score === undefined ? '' : ` · Score ${esc(k.score)}`}</small></div></div>`;
  }).join('');
  const rails = (p.more ?? []).map((m) => `${m.heading}: ${m.product_ids.length} ${m.product_ids.length === 1 ? 'product' : 'products'}${m.why ? ` (${railWhy(m.why)})` : ''}`).join('; ');
  return details('What was chosen, and why', `${picks}${kv([['Occasion key', p.occasion_key], ['Shape', p.shape], ['New customer', p.new_user ? 'Yes' : 'No'], ['Extra rails', rails || 'None'], ['Dropped', NONE]])}`);
}

function customerCap(format: RunFormat | undefined, setting: string | null | undefined): number | null {
  try { return format && setting ? capCustomer(format, rungOf(setting), CAP, PRICES) : null; } catch { return null; }
}

export function capEvidence(c: CustomerData, run: RunIn): string {
  const first = c.costs.find((x) => x.attempt === 1);
  if (!first) return '';
  const format = c.plan?.format ?? run.format;
  return details('The estimate and the cap', kv([['Input tokens', count(first.input_tokens)], ['Cached prefix', format ? count(CAP.S[format]) : NONE], ['Estimate', money(first.est_usd)], ['Held for two tries', money(first.commit_usd)],
    ['Customer cap', money(customerCap(format, run.setting))], ['Decision', DECIDED[first.action]], ['Left in the budget', money(c.budgetLeft)], ['Spare pool in the run now', money(run.pool_usd)]]));
}

const rawAnswer = (g: GenIn | undefined) => {
  const blocks = parse<{ content?: { type: string; text?: string }[] }>(g?.message_json)?.content?.filter((b) => b.type === 'text');
  return blocks?.length ? details("The model's raw answer", `<pre>${esc(blocks.map((b) => b.text).join(''))}</pre>`) : kv([['Raw answer', NONE]]);
};
const against = (est: number, charged: number) => (charged > est ? `Over the estimate by ${usd(charged - est)}` : `Under the estimate by ${usd(est - charged)}`);

export function writeEvidence(c: CustomerData, run: RunIn, n: 1 | 2, title = 'The model call'): string {
  const g = c.gens?.find((x) => x.attempt === n), cost = c.costs.find((x) => x.attempt === n), d = c.drafts.find((x) => x.version === n), env = envelopeOf(d);
  if (!g && !cost) return '';
  const u = parse<Usage & { output_tokens_details?: { thinking_tokens?: number } | null }>(g?.usage_json);
  const est = cost?.est_usd ?? null, charged = cost?.charged_usd ?? null;
  return details(title, kv([['Model', env?.model ?? d?.model ?? NONE], ['Setting', cost?.setting ?? env?.setting ?? run.setting ?? NONE], ['Prompt version', env?.prompt_version ?? run.prompt_version ?? NONE], ['Request hash', cost?.request_sha256 ?? NONE],
    ['Result', g ? RESULTS[g.result_type] ?? g.result_type : NONE], ['Input tokens', count(u?.input_tokens)], ['Cached tokens', count(u && (u.cache_read_input_tokens ?? 0))], ['Cache written', count(u && (u.cache_creation_input_tokens ?? 0))], ['Output tokens', count(u?.output_tokens)],
    ['Thinking tokens', count(u?.output_tokens_details?.thinking_tokens)], ['Stop reason', g?.stop_reason ? STOPS[g.stop_reason] ?? g.stop_reason : NONE], ['Charged', money(charged)], ['Estimate', money(est)],
    ['Against the estimate', est !== null && charged !== null ? against(est, charged) : NONE], ['Time taken', typeof g?.ms === 'number' ? secs(g.ms) : NONE]]) + rawAnswer(g));
}

export function checkEvidence(d: DraftIn, title = 'Every check that ran'): string {
  const checks = checksOf(d);
  const groups = (['email', 'landing_page', 'catalog'] as Part[]).flatMap((part) => {
    const mine = checks.filter((x) => x.part === part);
    if (!mine.length) return [];
    const rows = [...new Set(mine.map((x) => x.id))].map((id) => {
      const these = mine.filter((x) => x.id === id);
      return [checkName(id), failed(these).length ? 'Failed' : these.some((x) => !x.pass) ? 'To read' : 'Passed'];
    });
    return [`<h3>${esc(PART_NAME[part].replace(/^the (.)/, (_, x: string) => x.toUpperCase()))}</h3>${table(['Check', 'Result'], rows)}`];
  }).join('');
  const warned = checks.filter((x) => !x.pass && x.severity !== 'hard');
  return details(title, `${kv([['Validator version', d.validator_version ?? NONE]])}${groups || '<p class="note">No check is stored for this draft.</p>'}${warned.length ? explainBlocks(warned, modelOf(d), titlesOf(d)) : ''}`);
}

const SKIP = new Set(['type', 'slot', 'slots', 'quote_id', 'occasion_key']);
const strings = (v: unknown): string[] => (typeof v === 'string' ? (/^p[1-6]$/.test(v) ? [] : [v]) : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === 'object' ? Object.entries(v).filter(([k]) => !SKIP.has(k)).flatMap(([, x]) => strings(x)) : []);
const words = (v: unknown, titles: Map<string, string>) => strings(v).map((s) => `<p>${highlight(s, [], titles)}</p>`).join('') || '<p class="note">No text stored.</p>';

export function retryEvidence(c: CustomerData, run: RunIn): string {
  const v1 = c.drafts.find((d) => d.version === 1), v2 = c.drafts.find((d) => d.version === 2), second = c.costs.find((x) => x.attempt === 2);
  const blocked = second?.action === 'retry_blocked' ? kv([['Why no retry', (second.reason && NO_RETRY[second.reason]) ?? NONE]]) : '';
  if (!v2) return blocked ? details('Why the retry did not run', blocked) : writeEvidence(c, run, 2, 'The retry call');
  const before = v1 ? modelOf(v1) : null, after = modelOf(v2), carried = envelopeOf(v2)?.carried_part ?? null;
  const parts = (['email', 'landing_page'] as const).filter((p) => after?.[p] !== undefined && p !== carried);
  const why = [...new Set((v1 ? failed(checksOf(v1)) : []).map((x) => checkName(x.id)))].join(', ');
  const titles = titlesOf(v2);
  const pairs = parts.map((p) => `<h3>${esc(PART_NAME[p])}</h3><div class="ev-pair"><div><b>Failed text</b>${words(before?.[p], titles)}</div><div><b>New text</b>${words(after?.[p], titles)}</div></div>`).join('');
  return details('What the retry changed', `${kv([['Rewrote', parts.map((p) => PART_NAME[p]).join(' and ') || NONE], ['Because of', why || NONE], ['Carried', carried ? PART_NAME[carried] : 'Nothing']])}${pairs}`) + writeEvidence(c, run, 2, 'The retry call');
}

const tags = (html: string | null | undefined, re: RegExp) => (typeof html === 'string' ? count(html.match(re)?.length ?? 0) : NONE);

export function renderEvidence(c: CustomerData, d: DraftIn): string {
  const x = checksOf(d).filter((k) => k.id.startsWith('X'));
  const more = (c.plan?.more ?? []).map((m) => `${m.heading}: ${m.product_ids.length}`).join('; ');
  const part = (name: string, html: string | null | undefined): [string, unknown][] => [[`${name} images`, tags(html, /<img\b/g)], [`${name} links`, tags(html, /<a\b[^>]*\bhref=/g)]];
  return details('What the build placed and checked', kv([['Image and link checks', `${x.filter((k) => k.pass).length} of ${x.length} passed`], ...part('Email', d.email), ...part('Landing page', d.landing), ...part('Catalog', d.catalog),
    ['More sections', more || 'None'], ['Cards in more sections', typeof d.catalog === 'string' ? count(countMore(d.catalog)) : NONE], ['Content hash', d.content_sha256 ?? NONE]]));
}

type Answer = { noul?: number; probabilities?: Record<string, number>; confidence?: number } | undefined;
const two = (n: number | undefined) => (typeof n === 'number' ? n.toFixed(2) : NONE);

function questionRow(id: string, a: Answer, cfg: JevConfig | null, flagged: boolean, dismissed: boolean): string[] {
  const q = cfg?.j3[id];
  const score = q?.type === 'score' ? `Lowest ${two(a?.probabilities?.['0'])}, confidence ${two(a?.confidence)}`
    : two(typeof a?.noul === 'number' ? (q?.bad === false ? 1 - a.noul : a.noul) : undefined);
  const gate = !cfg || !q ? NONE : q.type === 'score' ? `Lowest is likeliest, confidence ${two(cfg.score_flag_confidence)}` : `Flag at ${two(cfg.flag_gate)}`;
  return [QUESTION_NAMES[id] ?? 'Unnamed question', score, gate, flagged ? (dismissed ? 'Flagged, dismissed' : 'Flagged') : 'Not flagged'];
}

export function judgeEvidence(c: CustomerData, run: RunIn, j: JevIn | undefined): string {
  if (!j) return '';
  const answers = parse<Record<string, unknown>>(j.answers_json), cfg = run.jev ?? null;
  const meta = kv([['Charged', money(j.charged_usd)], ['Input tokens', count(j.input_tokens)], ['Time taken', typeof j.ms === 'number' ? secs(j.ms) : NONE]]);
  if (!answers) return details('What Jev answered', meta);
  const live = cfg ? flaggedQuestions(answers, cfg) : c.flags;
  const rows = Object.keys(cfg?.j3 ?? answers).map((id) => questionRow(id, answers[id] as Answer, cfg, live.includes(id), !c.flags.includes(id)));
  return details('What Jev answered', meta + table(['Question', 'Score', 'Gate', 'Result'], rows));
}

export function eventEvidence(events: EventIn[], title: string): string {
  if (!events.length) return '';
  return details(title, events.map((e) => kv([['Who', e.actor_email ?? 'The system'], ['When', e.at.slice(0, 19).replace('T', ' ')], ['Content hash', e.content_sha256 ?? NONE], ...(e.note ? [['Note', e.note] as [string, unknown]] : [])])).join(''));
}

const PROMPT_FILES = ['role.md', 'voice-card.md', 'email.md', 'landing-v2.md', 'task.md', 'retry.md'];
const MODEL_FIELDS: Record<Format, string[]> = { email: ['subject', 'preheader', 'body'], landing_page: ['sections'] };

/** The one source for `generated_by`, screens and JSON alike. Only stored rows: a value nobody stored is null. Read at view time, because Jev answers after the draft row is hashed. */
export function generatedBy(c: CustomerData, run: RunIn, d: DraftIn | undefined = c.drafts.at(-1)): GeneratedBy {
  const ranking = c.plan?.generated_by?.ranking ?? null;
  if (!d) return { ranking, write: null, checks: null, judge: null };
  const n = d.version, g = c.gens?.find((x) => x.attempt === n), cost = c.costs.find((x) => x.attempt === n), env = envelopeOf(d), j = c.jev.find((x) => x.attempt === n);
  const u = parse<Usage>(g?.usage_json), carried = env?.carried_part ?? null, format = c.plan?.format ?? run.format ?? null;
  const parts = (format === 'both' ? ['email', 'landing_page'] as Format[] : format ? [format] : []).filter((p) => p !== carried);
  const written = parts.length === 2 ? 'both' : parts[0];
  const code = ['titles', 'images', 'links', 'rails', ...(d.email?.includes('data-brand-line') ? ['brand line'] : [])];
  return { ranking,
    write: g || cost ? { model: env?.model ?? d.model ?? null, setting: cost?.setting ?? env?.setting ?? null, prompt_version: env?.prompt_version ?? run.prompt_version ?? null, prompt_sha256: run.prompt_sha256 ?? null, prompt_files: PROMPT_FILES,
      schema: written ? schemaId(written) : null, attempt: n, request_sha256: cost?.request_sha256 ?? null, tokens: { input: u?.input_tokens ?? null, output: u?.output_tokens ?? null, cached: u?.cache_read_input_tokens ?? null, cache_written: u?.cache_creation_input_tokens ?? null },
      stop_reason: g?.stop_reason ?? null, cost: cost?.charged_usd ?? null, written_by_model: parts.flatMap((p) => MODEL_FIELDS[p]), written_by_code: code } : null,
    checks: { validator_version: d.validator_version ?? null, ran: checksOf(d).length, failed: failed(checksOf(d)).length },
    judge: j ? { model: run.jev?.model ?? null, config_version: run.jev_config_version ?? null, questions: Object.keys(run.jev?.j3 ?? {}), gate: run.jev?.flag_gate ?? null, flagged: c.flags, can_block: false } : null };
}

const orNone = (v: unknown) => v ?? NONE;
/** The same blocks in a line each. */
export function madeByLines(g: GeneratedBy): [string, string][] {
  const { ranking: r, write: w, checks: k, judge: j } = g;
  return [['Ranking', r ? `${r.method}, ${r.version}, cost $0` : NONE],
    ['Write', w ? `${orNone(w.model)}, ${orNone(w.setting)}, prompt ${orNone(w.prompt_version)} ${w.prompt_sha256?.slice(0, 6) ?? ''}, attempt ${w.attempt}, ${count(w.tokens.output)} tokens out, ${money(w.cost)}` : NONE],
    ['Checks', k ? `${k.ran} ran, ${k.failed} failed, ${orNone(k.validator_version)}` : NONE],
    ['Judge', j ? `${orNone(j.model)}, ${j.flagged.length} flagged, cannot block` : NONE]];
}
export const madeByLine = (g: GeneratedBy) => madeByLines(g).map(([k, v]) => `${k}: ${v}`).join(' · ');

export const jsonLinks = (run_id: string, customer?: string) => {
  const href = `/review/runs/${encodeURIComponent(run_id)}.json${customer ? `?customer=${encodeURIComponent(customer)}` : ''}`;
  return `<p class="note"><a href="${esc(href)}">View JSON</a> · <a href="${esc(href)}" download="${esc(`${run_id}${customer ? `-${customer}` : ''}.json`)}">Download</a></p>`;
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** One stage's or one run's tokens, money and time. `gens` and `costs` hold the attempts in scope. */
export function totals(gens: GenIn[], costs: CostIn[]): [string, unknown][] {
  const us = gens.flatMap((g) => parse<Usage & { output_tokens_details?: { thinking_tokens?: number } | null }>(g.usage_json) ?? []);
  const called = costs.filter((x): x is CostIn & { charged_usd: number; est_usd: number } => x.charged_usd !== null && x.est_usd !== null);
  const input = sum(us.map((u) => u.input_tokens ?? 0)), read = sum(us.map((u) => u.cache_read_input_tokens ?? 0)), wrote = sum(us.map((u) => u.cache_creation_input_tokens ?? 0));
  const thinking = us.flatMap((u) => u.output_tokens_details?.thinking_tokens ?? []), ms = gens.flatMap((g) => g.ms ?? []);
  const est = sum(called.map((x) => x.est_usd)), charged = sum(called.map((x) => x.charged_usd));
  return [['Input tokens', us.length ? count(input) : NONE], ['Cached tokens', us.length ? count(read) : NONE], ['Cache written', us.length ? count(wrote) : NONE], ['Output tokens', us.length ? count(sum(us.map((u) => u.output_tokens ?? 0))) : NONE], ['Thinking tokens', thinking.length ? count(sum(thinking)) : NONE],
    ['Charged', called.length ? usd(charged) : NONE], ['Estimated', called.length ? usd(est) : NONE], ['Against the estimate', called.length ? against(est, charged) : NONE],
    ['Cache hit rate', input + read + wrote ? `${Math.round(100 * read / (input + read + wrote))}%` : NONE], ['Model time', ms.length ? secs(sum(ms)) : NONE]];
}
