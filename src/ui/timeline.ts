// The job as stages. Reads only what units, plans, drafts, cost_events, draft_events and jev_events hold: a time nobody stored reads "not recorded", never a guess.
import type { CheckResult, JevConfig, Plan, RunFormat } from '../contracts/types.ts';
import { explainBlocks, failed, jevNotRun, PART_NAME, QUESTION_NAMES, checkName, stoppedLine } from './checks.ts';
import { capEvidence, checkEvidence, checksOf, details, generatedBy, jsonLinks, madeByLines, EVIDENCE_CSS, eventEvidence, judgeEvidence, kv, modelOf, planEvidence, renderEvidence, retryEvidence, secs, titlesOf, totals, usd, writeEvidence } from './evidence.ts';
import { esc } from './nb.ts';
import { isStub } from './shell.ts';

export interface Strip { name: string; what: string; why: string; lines: [string, string, ...string[]]; bad?: boolean }
export const STAGES = [
  { name: 'Plan', what: 'Match each customer to products, occasion and page shape', why: 'So code, not the model, decides what is sold' },
  { name: 'Estimate', what: 'Count the tokens of each exact request', why: 'So cost is known before any money is spent' },
  { name: 'Cap check', what: 'Admit each customer against the spending cap', why: 'So an oversized request is skipped, never silently billed' },
  { name: 'Write', what: 'The model writes the email and landing page', why: 'The only step that creates words' },
  { name: 'Check', what: 'Code tests every line against the snapshot and rules', why: 'So nothing made up reaches a person' },
  { name: 'Retry', what: 'Rewrite only the part that failed, once', why: 'A fixable miss costs one part, not a customer' },
  { name: 'Render', what: 'Code places titles, images and links', why: 'So every product and image traces to nicobar.com' },
  { name: 'Judge (Jev)', what: 'Jev reads the finished draft', why: 'A cheap second reader on tone and claims. It flags and never blocks' },
  { name: 'Review', what: 'A person reads the draft', why: 'Nothing can leave unread' },
  { name: 'Approve', what: 'A person approves this exact content', why: 'The database refuses anything unapproved' },
  { name: 'Publish', what: 'Release the approved version', why: 'A separate act, and nothing is sent' },
];

export const TIMELINE_CSS = `<style>.big{margin:0;font:400 44px/48px var(--font-display);letter-spacing:-.01em;text-transform:none;color:var(--color-ink)}
.strip{display:flex;overflow-x:auto;margin:24px 0 16px}.strip>div{flex:1 0 102px;padding-right:12px;font-size:13px;line-height:18px}
.strip i{display:flex;align-items:center;margin:0 -12px 12px 0}.strip i::before{content:'';flex:none;width:14px;height:14px;border-radius:50%;background:var(--color-ink)}.strip i::after{content:'';flex:1;height:1px;margin-left:4px;background:var(--color-ink)}
.strip i.bad::before{background:var(--color-fail)}.strip h3{margin:0 0 8px;font:500 15px/20px var(--font-sans)}.strip p{margin:0 0 8px}.strip .why{padding-bottom:8px;border-bottom:1px solid var(--color-line);color:var(--color-ink-soft)}
.strip span,.strip b{display:block}.strip span{color:var(--color-ink-soft)}.strip b{font-weight:500}
.tl-table td,.tl-table th{padding:8px 10px 8px 0;font-size:14px;line-height:20px}.dot{display:inline-block;width:12px;height:12px;border-radius:50%}.dot.passed,.dot.retried{background:var(--color-pass)}.dot.failed{background:var(--color-fail)}.dot.waiting{background:var(--color-warn)}.dot.skipped,.dot.notreached{width:10px;height:1px;border-radius:0;background:var(--color-ink-soft);vertical-align:middle}
.tl-row{display:grid;grid-template-columns:minmax(200px,1.6fr) repeat(7,44px) 64px minmax(260px,3fr);gap:0 12px;align-items:center;min-width:900px;padding:9px 0;border-bottom:1px solid var(--color-line);font-size:14px;line-height:20px}
summary.tl-row{cursor:pointer;list-style:none}summary.tl-row::-webkit-details-marker{display:none}.tl-row.head{border-bottom-color:var(--color-ink);color:var(--color-ink-soft);font-weight:500;font-size:13px}.tl-stop{color:var(--color-fail)}.tl-scroll{overflow-x:auto}
.tl-open{padding:16px 0 24px;border-bottom:1px solid var(--color-line)}
.story{list-style:none;margin:16px 0;padding:0}.story>li{position:relative;display:grid;grid-template-columns:214px minmax(0,1fr) 96px;gap:16px;padding:0 0 24px 38px}.story>li::before{content:'';position:absolute;left:7px;top:6px;bottom:-6px;width:1px;background:var(--color-line)}
.story>li>.dot{position:absolute;left:0;top:4px;width:14px;height:14px;border-radius:50%;background:var(--color-line)}.story>li>.dot.passed,.story>li>.dot.retried{background:var(--color-pass)}.story>li>.dot.failed{background:var(--color-fail)}.story>li>.dot.waiting{background:var(--color-warn)}
.story b{font-weight:500}.story small{display:block;color:var(--color-ink-soft)}.story p{margin:0 0 4px}.story .cost{text-align:right}@media (max-width:749px){.story>li{grid-template-columns:minmax(0,1fr)}.story .cost{text-align:left}.big{font-size:32px;line-height:38px}}
${EVIDENCE_CSS}</style>`;

export const strip = (stages: Strip[]) => `<div class="strip">${stages.map((s) => `<div><i class="${s.bad ? 'bad' : ''}"></i><h3>${esc(s.name)}</h3><p>${esc(s.what)}</p><p class="why">${esc(s.why)}</p>`
  + `<span>${esc(s.lines[0])}</span><b>${esc(s.lines[1])}</b>${s.lines.slice(2).map((l) => `<span>${esc(l)}</span>`).join('')}</div>`).join('')}</div>`;

export interface UnitIn { customer_id: string; status: string; code: string | null; error_detail: string | null }
export interface DraftIn { id: string; customer_id: string; version: number; status: string; hard_failures: number; model_json: string; catalog: string | null; checks_json: string; envelope_json: string;
  validator_version?: string; model?: string; content_sha256?: string; email?: string | null; landing?: string | null }
export interface CostIn { customer_id: string; attempt: number; action: string; call_state: string; input_tokens: number | null; est_usd: number | null; commit_usd?: number | null; charged_usd: number | null; reason: string | null; at: string; setting?: string; request_sha256?: string | null }
export interface GenIn { customer_id: string; attempt: number; result_type: string; stop_reason: string | null; usage_json: string | null; message_json: string | null; ms: number | null }
export interface JevIn { customer_id: string; attempt: number; status: string; reason: string | null; charged_usd: number | null; at: string; answers_json?: string | null; input_tokens?: number | null; ms?: number | null }
export interface EventIn { draft_id: string; from_status: string | null; to_status: string; actor_email: string | null; at: string; note: string | null; content_sha256?: string }
export interface CustomerData { unit: UnitIn; plan: Plan | null; plan_at: string | null; drafts: DraftIn[]; costs: CostIn[]; jev: JevIn[]; events: EventIn[]; flags: string[]; gens?: GenIn[]; budgetLeft?: number | null }
export interface RunIn { id: string; status: string; jev_disabled_reason: string | null; stage?: string; snapshot_id?: string; prompt_sha256?: string | null; spent_usd?: number; cap_run_usd?: number; setting?: string; prompt_version?: string; format?: RunFormat; pool_usd?: number; jev_reserve_usd?: number; jev_config_version?: string; jev?: JevConfig | null }

type State = 'passed' | 'failed' | 'retried' | 'skipped' | 'waiting' | 'not reached';
export interface Stage { name: string; state: State; what: string; why: string; usd: number | null; at: string | null; html?: string }

const UNIT_WHY: Record<string, string> = { COLD_START_NO_HISTORY: 'This customer has no purchase history, so there is nothing to base picks on.', NO_RECOMMENDATION: 'No recommendation exists for this customer.',
  INVALID_PICK: 'A recommended product is not in the catalogue snapshot.', TOO_FEW_CANDIDATES: 'Too few usable products were left to choose from.', INVALID_CUSTOMER: 'The customer row could not be read.', DUPLICATE_CUSTOMER_ID: 'This customer appears twice in the file.',
  CHECKS_FAILED: 'The draft failed its checks on both tries.', UPSTREAM_UNAVAILABLE: 'The model could not give an answer.', INVALID_REQUEST: 'The model refused the request as malformed.', INTERNAL_ERROR: 'Something broke inside the batch for this customer.',
  ESTIMATE_FAILED: 'The token count failed, so nothing was spent on this customer.', OVER_CAP: 'The estimate was over the spending cap for one customer, so the call was never made.', RUN_CAP: 'The estimate would have taken the run over the spending cap, so the call was never made.' };
export const unitWhy = (code: string | null) => (code && UNIT_WHY[code]) ?? 'No reason is recorded.';
const PLAN_CODES = ['COLD_START_NO_HISTORY', 'NO_RECOMMENDATION', 'INVALID_PICK', 'TOO_FEW_CANDIDATES', 'INVALID_CUSTOMER', 'DUPLICATE_CUSTOMER_ID'];

const clock = (t: string | null) => (t === null ? 'not recorded' : /T\d\d:\d\d:\d\d/.test(t) ? t.slice(11, 19) : t);
const copyFails = (d: DraftIn) => failed(checksOf(d)).filter((c) => !c.id.startsWith('X'));
const failBlocks = (d: DraftIn, cs: CheckResult[]) => explainBlocks(cs, modelOf(d), titlesOf(d));
const carriedPart = (d: DraftIn): string | null => { try { return JSON.parse(d.envelope_json).carried_part ?? null; } catch { return null; } };

export function stagesOf(c: CustomerData, run: RunIn): Stage[] {
  const out: Stage[] = [];
  const add = (i: number, state: State, what: string, why: string, usdv: number | null = null, at: string | null = null, html?: string) => out.push({ name: STAGES[i].name, state, what, why, usd: usdv, at, html });
  const rest = () => { while (out.length < STAGES.length) add(out.length, 'not reached', 'Did not get this far.', ''); return out; };
  const { unit, plan, drafts } = c;
  const first = c.costs.find((x) => x.attempt === 1), second = c.costs.find((x) => x.attempt === 2);
  const v1 = drafts.find((d) => d.version === 1), v2 = drafts.find((d) => d.version === 2), latest = v2 ?? v1;

  if (unit.code && PLAN_CODES.includes(unit.code)) { add(0, 'failed', 'No plan could be made.', unitWhy(unit.code), null, c.plan_at); return rest(); }
  add(0, plan ? 'passed' : 'not reached', plan ? `Chose ${plan.picks?.length ?? 0} products${plan.occasion ? ` for ${plan.occasion}` : ''}.` : 'No plan is stored.', '', null, c.plan_at);
  if (!first) return rest();
  const skipped = first.action === 'skip' || first.action === 'stop';
  if (first.reason === 'ESTIMATE_FAILED') { add(1, 'failed', 'The estimate failed.', unitWhy(first.reason), null, first.at); return rest(); }
  add(1, 'passed', `${first.input_tokens ?? 'Unknown'} tokens in, estimated at ${usd(first.est_usd)}.`, '', null, first.at);
  if (skipped) { add(2, 'skipped', 'The call was not made.', unitWhy(first.reason ?? unit.code), null, first.at); return rest(); }
  add(2, 'passed', 'Within the spending cap.', '', null, first.at);
  const wrote = first.call_state === 'answered';
  add(3, wrote ? 'passed' : first.call_state === 'possibly_billed' ? 'failed' : 'waiting', wrote ? 'The model wrote the draft.' : first.call_state === 'possibly_billed' ? 'The call failed and may have been billed.' : 'No answer is stored yet.', wrote ? '' : unit.status === 'failed' ? unitWhy(unit.code) : '', first.charged_usd);
  if (!v1) return rest();
  const atOf = (d: DraftIn) => c.events.filter((e) => e.draft_id === d.id && e.to_status !== 'draft')[0]?.at ?? null;
  const v1Hard = failed(checksOf(v1));
  add(4, v1Hard.length ? 'failed' : 'passed', v1Hard.length ? `${stoppedLine(v1Hard)} on the first try.` : 'Every check passed.', '', null, atOf(v1), v1Hard.length ? failBlocks(v1, v1Hard) : undefined);
  if (v2) {
    const left = failed(checksOf(v2)), carried = carriedPart(v2);
    const fixed = [...new Set(v1Hard.filter((x) => !left.some((y) => y.id === x.id)).map((x) => checkName(x.id)))];
    const kept = carried ? `${PART_NAME[carried as 'email'].replace(/^t/, 'T')} was kept and the failed part rewritten.` : 'The whole draft was rewritten.';
    const changed = `${kept}${fixed.length ? ` Fixed: ${fixed.join(', ')}.` : ''}`;
    add(5, left.length ? 'failed' : 'retried', left.length ? `The second try still failed. ${stoppedLine(left)}.` : 'The second try passed.', changed, second?.charged_usd ?? null, second?.at ?? atOf(v2), left.length ? failBlocks(v2, left) : undefined);
  } else if (second) add(5, 'failed', 'A retry was attempted and left no draft.', unitWhy(unit.code), second.charged_usd, second.at);
  else add(5, v1Hard.length ? 'skipped' : 'not reached', v1Hard.length ? 'No retry was made.' : 'No retry was needed.', v1Hard.length ? unitWhy(unit.code) : '');
  if (!latest || latest.hard_failures > 0) {
    if (copyFails(latest!).length) return rest();
    add(6, 'failed', 'The built pages failed a check.', '', null, null, failBlocks(latest!, failed(checksOf(latest!))));
    return rest();
  }
  const rendered = checksOf(latest).some((x) => x.id.startsWith('X'));
  add(6, rendered ? 'passed' : 'skipped', rendered ? 'Pages built; images and links passed.' : 'No page check is stored for this draft.', '');
  const j = c.jev.find((x) => x.attempt === latest.version);
  if (j?.status === 'answered') add(7, c.flags.length ? 'waiting' : 'passed', c.flags.length ? `Flagged: ${c.flags.map((q) => QUESTION_NAMES[q] ?? q).join(', ')}.` : 'No flags.', c.flags.length ? 'Jev judges the draft as a whole and names no words, so the reviewer reads it.' : '', j.charged_usd, j.at);
  else add(7, 'skipped', jevNotRun(j?.reason ?? run.jev_disabled_reason), '', j?.charged_usd ?? null, j?.at ?? null);
  const seen = (s: string) => c.events.find((e) => e.draft_id === latest.id && e.to_status === s);
  const by = (e?: EventIn) => (e?.actor_email ? ` by ${e.actor_email}` : '');
  const rejected = seen('rejected'), approved = seen('approved'), released = seen('released');
  const inReview = seen('in_review');
  if (rejected) { add(8, 'failed', `Rejected${by(rejected)}.`, rejected.note ?? '', null, rejected.at); return rest(); }
  add(8, approved ? 'passed' : 'waiting', approved ? 'Reviewed.' : 'Waiting for a reviewer.', '', null, inReview?.at ?? null);
  if (!approved) return rest();
  add(9, 'passed', `Approved${by(approved)}.`, '', null, approved.at);
  add(10, released ? 'passed' : 'waiting', released ? `Published${by(released)}. Nothing was sent.` : 'Approved, not published.', '', null, released?.at ?? null);
  return out;
}

const LABEL: Record<State, string> = { passed: 'Passed', failed: 'Failed', retried: 'Fixed by retry', skipped: 'Skipped', waiting: 'Waiting for a person', 'not reached': 'Did not run' };
const dot = (s: State) => `<span class="dot ${s.replace(' ', '')}" role="img" aria-label="${LABEL[s]}" title="${LABEL[s]}"></span>`;
const usd3 = (n: number | null) => (n === null ? '$0' : `$${n.toFixed(3)}`);
const usd2 = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const part = (c: CheckResult) => (c.part === 'email' ? 'Email' : c.part === 'landing_page' ? 'Landing page' : 'Catalog');

/** Display names arrive as typed in the customer file; these screens capitalise them. */
export const capital = (s: string) => s.replace(/(^|[\s-])(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase());
const who = (c: CustomerData) => (c.plan?.display_name ? capital(c.plan.display_name) : c.plan?.new_user ? 'New customer' : c.unit.customer_id);
const label = (c: CustomerData) => `${who(c)}${c.plan?.occasion ? ` · ${c.plan.occasion}` : ''}`;

/** One failed check in a row's width. Reads the check's own detail; the long form is in the story. */
function brief(c: CheckResult): string {
  if (c.code === 'OVER_WORDS') return `${part(c)} ${c.detail} words, limit 120`;
  if (c.code === 'FIELD_WORDS') { const [n, , range] = (c.detail ?? '').split(' not in ').flatMap((x) => [x, '']); return `A line ran ${n} words, allowed ${range}`; }
  if (c.code === 'UNGROUNDED') return `Named "${c.detail}", which the product page does not give`;
  if (c.code === 'UNGROUNDED_COUNT') return `Said "${c.detail}", which the product page does not give`;
  return checkName(c.id);
}
const briefs = (d: DraftIn) => [...new Set(failed(checksOf(d)).map(brief))].join('; ');

function summary(c: CustomerData): { text: string; stopped: boolean } {
  const v1 = c.drafts.find((d) => d.version === 1), last = c.drafts.at(-1);
  if (c.unit.status === 'failed' || c.unit.status === 'skipped') {
    const after = c.drafts.length > 1 ? ', after retry' : '';
    return { text: `${c.unit.status === 'skipped' ? 'Skipped' : 'Stopped'}: ${last && last.hard_failures ? briefs(last) + after : unitWhy(c.unit.code)}`, stopped: true };
  }
  if (!last) return { text: 'Not finished', stopped: false };
  if (c.drafts.length > 1 && v1) return { text: `Fixed by retry: ${briefs(v1)}`, stopped: false };
  return { text: 'Ready: Passed every check first try', stopped: false };
}

function headline(c: CustomerData): { title: string; sub: string } {
  const last = c.drafts.at(-1), bad = last ? failed(checksOf(last)) : [];
  if (c.unit.status === 'failed' && bad.length) {
    const words = bad.find((x) => x.code === 'OVER_WORDS');
    const title = words ? `the ${c.drafts.length > 1 ? 'page' : 'copy'} is ${Number(words.detail) - 120} words too long` : brief(bad[0]);
    return { title: `Stopped${c.drafts.length > 1 ? ' after retry' : ''}: ${title}`, sub: `No draft can be released. ${stoppedLine(bad)}. Rerun this customer, or reject it.` };
  }
  if (c.unit.status === 'failed' || c.unit.status === 'skipped') return { title: `${c.unit.status === 'skipped' ? 'Skipped' : 'Stopped'}: ${unitWhy(c.unit.code)}`, sub: 'No draft can be released. The other customers carried on.' };
  return last ? { title: summary(c).text, sub: 'Nothing goes out until a person approves it.' } : { title: 'Not finished', sub: 'This customer has no draft yet.' };
}

interface StoryRow { name: string; sub: string; state: State; text: string; why: string; html?: string; usd: number | null; at: string | null; timed?: boolean; ev?: string; took?: number | null }

function storyRows(c: CustomerData, run: RunIn): StoryRow[] {
  const by = Object.fromEntries(stagesOf(c, run).map((s) => [s.name, s]));
  const row = (s: Stage, name = s.name, sub = LABEL[s.state]): StoryRow => ({ name, sub, state: s.state, text: s.what, why: s.why, html: s.html, usd: s.usd, at: s.at });
  const rows: StoryRow[] = [];
  const est = by.Estimate, cap = by['Cap check'];
  if (by.Plan.state !== 'not reached') rows.push(row(by.Plan));
  if (est.state === 'failed') rows.push(row(est));
  if (cap.state !== 'not reached') rows.push({ ...row(cap, 'Cap check', cap.state === 'passed' ? 'Admitted' : LABEL[cap.state]), text: `${est.what} ${cap.what}` });
  if (by.Write.state !== 'not reached') rows.push(row(by.Write, c.drafts.length > 1 ? 'Write, first try' : 'Write'));
  if (by.Check.state !== 'not reached') rows.push(row(by.Check));
  const r = by.Retry, v2 = c.drafts.find((d) => d.version === 2);
  if (r.state !== 'not reached' && v2) {
    rows.push({ ...row(r, 'Retry', c.costs.some((x) => x.attempt === 2 && x.call_state === 'answered') ? 'Answered' : LABEL[r.state]), state: 'passed', text: r.why, why: '', html: undefined });
    rows.push({ ...row(r, 'Check, second'), text: r.what, why: '', usd: null });
  } else if (r.state !== 'not reached') rows.push(row(r));
  if (c.unit.status === 'failed') rows.push({ name: 'Stop', sub: 'Customer failed alone', state: 'failed', text: `${unitWhy(c.unit.code)}${c.unit.error_detail ? ` ${c.unit.error_detail}` : ''}`, why: 'One retry is the limit, so the run moved on. The other customers were not affected.', usd: null, at: null });
  for (const n of ['Render', 'Judge (Jev)', 'Review', 'Approve', 'Publish']) if (by[n].state !== 'not reached') rows.push(row(by[n]));
  const unreached = ['Render', 'Judge (Jev)', 'Review', 'Approve', 'Publish'].filter((n) => by[n].state === 'not reached');
  if (unreached.length) rows.push({ name: unreached.join(', '), sub: LABEL['not reached'], state: 'not reached', text: c.unit.status === 'failed' ? 'A failed draft is not judged and cannot be approved.' : 'Not yet.', why: '', usd: null, at: null, timed: false });
  const latest = c.drafts.at(-1), v1 = c.drafts.find((d) => d.version === 1), gen = (n: number) => c.gens?.find((g) => g.attempt === n)?.ms ?? null;
  const j = c.jev.find((x) => x.attempt === latest?.version);
  const of = (...to: string[]) => c.events.filter((e) => e.draft_id === latest?.id && to.includes(e.to_status));
  const ev: Record<string, () => Partial<StoryRow>> = {
    Plan: () => ({ ev: planEvidence(c) }), Estimate: () => ({ ev: capEvidence(c, run) }), 'Cap check': () => ({ ev: capEvidence(c, run) }),
    Write: () => ({ ev: writeEvidence(c, run, 1), took: gen(1) }), 'Write, first try': () => ({ ev: writeEvidence(c, run, 1), took: gen(1) }),
    Check: () => ({ ev: v1 && checkEvidence(v1) }), Retry: () => ({ ev: retryEvidence(c, run), took: gen(2) }), 'Check, second': () => ({ ev: v2 && checkEvidence(v2) }),
    Render: () => ({ ev: latest && renderEvidence(c, latest) }), 'Judge (Jev)': () => ({ ev: judgeEvidence(c, run, j), took: j ? j.ms ?? null : undefined }),
    Review: () => ({ ev: eventEvidence(of('in_review', 'rejected'), 'Who and when') }), Approve: () => ({ ev: eventEvidence(of('approved'), 'Who and when') }), Publish: () => ({ ev: eventEvidence(of('released'), 'Who and when') }) };
  return rows.map((r) => ({ ...r, ...ev[r.name]?.() }));
}

/** One customer, end to end, in words. /review/:id and the open row on the run page. */
export function customerTimeline(c: CustomerData, run: RunIn, css = TIMELINE_CSS): string {
  const { title, sub } = headline(c);
  const rows = storyRows(c, run).map((s) => `<li>${dot(s.state).replace('role=', 'data-s role=')}<div><b>${esc(s.name)}</b><small>${esc(s.sub)}</small></div>`
    + `<div><p>${esc(s.text)}</p>${s.why ? `<p class="note">${esc(s.why)}</p>` : ''}${s.html ?? ''}${s.ev ?? ''}</div><div class="cost">${usd3(s.usd)}${s.timed === false ? '' : `<small>${esc(clock(s.at))}</small>`}${s.took === undefined ? '' : `<small>${s.took === null ? 'Time taken not recorded' : `Took ${secs(s.took)}`}</small>`}</div></li>`).join('');
  return `${css}<p class="eyebrow">${esc(c.unit.customer_id)} · ${esc(label(c))}</p><p class="big">${esc(title)}</p><p>${esc(sub)}</p><ol class="story">${rows}</ol>${details('How each step was made', kv(madeByLines(generatedBy(c, run))))}${jsonLinks(run.id, c.unit.customer_id)}<p class="note">A clock time is the moment a step was recorded. Write and Judge also show how long they took; older runs read "not recorded".</p>`;
}

const paidBy = (c: CustomerData) => [...c.costs, ...c.jev].reduce((t, x) => t + (x.charged_usd ?? 0), 0);
const timeBy = (c: CustomerData) => { const ms = [...(c.gens ?? []), ...c.jev].flatMap((x) => x.ms ?? []); return ms.length ? ms.reduce((a, b) => a + b, 0) : null; };
const top = <T>(xs: T[], by: (x: T) => number) => [...xs].sort((a, b) => by(b) - by(a)).slice(0, 3);

/** Closed per stage, then the whole run. The Write and Retry totals read their own attempt; every other stage spends no tokens on the model. */
function stageDetail(all: { c: CustomerData; stages: Stage[] }[]): string {
  const cs = all.map((a) => a.c), gens = cs.flatMap((c) => c.gens ?? []), costs = cs.flatMap((c) => c.costs), jev = cs.flatMap((c) => c.jev);
  const attempt = (n: number) => kv(totals(gens.filter((g) => g.attempt === n), costs.filter((x) => x.attempt === n)));
  const extra: Record<string, () => string> = { Write: () => attempt(1), Retry: () => attempt(2),
    'Judge (Jev)': () => { const ms = jev.flatMap((j) => j.ms ?? []); return kv([['Jev charged', usd(jev.reduce((t, j) => t + (j.charged_usd ?? 0), 0))], ['Jev input tokens', jev.reduce((t, j) => t + (j.input_tokens ?? 0), 0).toLocaleString('en-US')], ['Jev time', ms.length ? secs(ms.reduce((a, b) => a + b, 0)) : 'not recorded']]); } };
  const steps = STAGES.map((s, i) => {
    const here = all.filter((a) => a.stages[i].state !== 'not reached');
    const states = [...new Set(here.map((a) => a.stages[i].state))];
    const who = states.map((st) => { const names = here.filter((a) => a.stages[i].state === st).map((a) => label(a.c)); return [`${LABEL[st]} (${names.length})`, names.join('; ')] as [string, unknown]; });
    return details(`${s.name} · ${here.length} in this step`, `${who.length ? kv(who) : '<p class="note">Nobody reached this step.</p>'}${extra[s.name]?.() ?? ''}`);
  }).join('');
  const timed = cs.filter((c) => timeBy(c) !== null), paid = cs.filter((c) => paidBy(c) > 0);
  const slowest = top(timed, (c) => timeBy(c)!).map((c) => `${label(c)} ${secs(timeBy(c)!)}`).join('; ') || 'not recorded';
  const costliest = top(paid, paidBy).map((c) => `${label(c)} ${usd2(paidBy(c))}`).join('; ') || 'not recorded';
  return `<h2>Each step in detail</h2>${steps}<h2>The whole run</h2>${kv([...totals(gens, costs), ['Slowest customers', slowest], ['Costliest customers', costliest]])}`;
}

const SHOWN = ['Plan', 'Write', 'Check', 'Retry', 'Render', 'Judge (Jev)', 'Review'];

export function runTimeline(run: RunIn, customers: CustomerData[]): string {
  const all = customers.map((c) => ({ c, stages: stagesOf(c, run) }));
  const stripped: Strip[] = STAGES.map((s, i) => {
    const here = all.map((a) => a.stages[i]).filter((x) => x.state !== 'not reached');
    const n = (...st: State[]) => here.filter((x) => st.includes(x.state)).length;
    const first = here.map((x) => x.at).filter((t): t is string => t !== null).sort()[0] ?? null;
    const spent = here.reduce((t, x) => t + (x.usd ?? 0), 0), held = s.name === 'Cap check' ? customers.reduce((t, c) => t + (c.costs.find((x) => x.attempt === 1)?.commit_usd ?? 0), 0) : 0;
    const open = n('waiting');
    const ok = s.name === 'Retry' ? `${n('retried')} fixed` : s.name === 'Check' ? `${n('passed')} pass` : s.name === 'Review' || s.name === 'Publish' || s.name === 'Approve' ? `${n('passed')} so far` : String(n('passed', 'retried', 'waiting'));
    return { ...s, bad: n('failed') > 0, lines: [`In ${here.length}`, ok, ...(n('failed') ? [`${n('failed')} fail`] : []), ...(n('skipped') ? [`${n('skipped')} skipped`] : []), ...(open && s.name !== 'Judge (Jev)' ? ['Open'] : []),
      held ? `${usd2(held)} held` : spent ? usd2(spent) : '$0', first ? `From ${clock(first)}` : 'Time not recorded'] };
  });
  const lastOf = (c: CustomerData) => c.drafts.at(-1);
  const ready = customers.filter((c) => c.unit.status === 'drafted' && lastOf(c)?.hard_failures === 0).length;
  const firstTry = customers.filter((c) => c.drafts.length === 1 && c.drafts[0].hard_failures === 0).length;
  const retried = customers.filter((c) => c.drafts.length > 1), fixed = retried.filter((c) => lastOf(c)?.hard_failures === 0).length;
  const stopped = customers.filter((c) => c.unit.status === 'failed' || c.unit.status === 'skipped').length;
  const metric = (v: string, k: string) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`;
  const top = `<div class="metrics">${metric(`${ready} of ${customers.length}`, 'Ready for a person')}${metric(String(firstTry), 'Passed first try')}${metric(`${fixed} of ${retried.length}`, 'Fixed by one retry')}`
    + `${metric(usd2(run.spent_usd ?? 0), run.cap_run_usd === undefined ? 'Spent' : `Spent, cap ${usd2(run.cap_run_usd)}`)}</div>`;
  const head = `<div class="tl-row head"><span>Customer</span>${SHOWN.map((n) => `<span>${esc(n.replace(' (Jev)', ''))}</span>`).join('')}<span>Cost</span><span>What happened</span></div>`;
  const rows = all.map(({ c, stages }) => {
    const { text, stopped: bad } = summary(c);
    const paid = stages.reduce((t, s) => t + (s.usd ?? 0), 0);
    return `<details><summary class="tl-row"><span>${esc(label(c))}</span>${SHOWN.map((n) => `<span>${dot(stages.find((s) => s.name === n)!.state)}</span>`).join('')}<span>${usd3(paid)}</span><span class="${bad ? 'tl-stop' : ''}">${esc(text)}</span></summary>`
      + `<div class="tl-open">${customerTimeline(c, run, '')}${c.drafts.length ? `<p><a href="/review/${encodeURIComponent(c.drafts.at(-1)!.id)}">Open this draft</a></p>` : ''}</div></details>`;
  }).join('');
  const stub = isStub(run.id) ? 'stub run, nothing billed' : 'real model';
  const foot = stopped ? `${stopped} ${stopped === 1 ? 'customer' : 'customers'} stopped alone and the other ${customers.length - stopped} finished. Open a row below for why.` : 'No customer stopped.';
  return `${TIMELINE_CSS}<p class="eyebrow">Run · ${esc(run.id)} · ${stub}, ${customers.length} customers</p><h1>What the job did, and why each step exists</h1>${jsonLinks(run.id)}${top}${strip(stripped)}<p class="note">${esc(foot)}</p>${stageDetail(all)}`
    + `<p class="eyebrow" style="margin-top:48px">Run · per customer</p><p class="big">The same steps, one row per customer</p><div class="tl-scroll">${head}${rows}</div>`
    + `<p class="note">Green passed · Red failed · Amber waiting for a person · Dash did not run. Open a row for its full story.</p>`;
}
