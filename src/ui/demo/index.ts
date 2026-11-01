// Spend, Published, Evals: read-only.
import type { RunFormat, Stage, RunStatus } from '../../contracts/types.ts';
import type { CheckResult, ModelJson } from '../../contracts/types.ts';
import { readCards } from '../../lib/render/catalog.ts';
import { checkName, explain, failed, highlight, QUESTION_NAMES } from '../checks.ts';
import { isStub, shell } from '../shell.ts';
import { strip, TIMELINE_CSS } from '../timeline.ts';

export interface SpendRow { id: string; stage: Stage; status: RunStatus; expected_usd: number; spent_usd: number; jev_usd: number; cap_run_usd: number; ceiling_usd: number;
  created_at: string; actions: string | null }
export interface PublishedRow { id: string; customer_id: string; format: RunFormat; display_name: string | null; approved_by: string; approved_at: string;
  released_by: string; released_at: string; content_sha256: string }

const SEED_ACTOR = 'seed-demo@local';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`.replace('&#38;', '&amp;').replace('&#60;', '&lt;').replace('&#62;', '&gt;'));
const usd = (n: number) => `$${n.toFixed(4)}`;
const actor = (email: string) => (email === SEED_ACTOR ? 'seeded' : esc(email));
const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const page = (href: string, kicker: string, title: string, body: string) =>
  shell(title, href, `<p class="k">${esc(kicker)}</p><h1>${esc(title)}</h1><div class="w">${body}</div>`);

export function renderSpend(rows: SpendRow[], ledger_usd: number): string {
  const body = rows.length === 0 ? '<p>No runs yet.</p>' : table(['Run', 'Stage', 'Status', 'Estimated', 'Spent', 'Jev', 'Cap', 'Ceiling', 'Cap actions'], rows.map((r) => [
    `<code>${esc(r.id)}</code>`, `${esc(r.stage)}${isStub(r.id) ? ' · stub, nothing billed' : ''}`, esc(r.status), usd(r.expected_usd), usd(r.spent_usd), usd(r.jev_usd), usd(r.cap_run_usd), usd(r.ceiling_usd), esc(r.actions ?? 'none')]));
  return page('/review/spend', 'Spend · read-only', 'What each run cost', `${body}<p>Spent outside a run: ${usd(ledger_usd)}</p>`);
}

const PARTS: Record<RunFormat, string[]> = { both: ['email', 'landing_page', 'catalog'], email: ['email', 'catalog'], landing_page: ['landing_page', 'catalog'] };

export function renderPublished(rows: PublishedRow[]): string {
  const body = rows.length === 0 ? '<p>Nothing released yet.</p>' : table(['Customer', 'Approved', 'Released', 'Hash', 'Parts'], rows.map((r) => [
    `${esc(r.display_name ?? r.customer_id)} <code>${esc(r.customer_id)}</code>${isStub(r.id) ? ' · stub draft' : ''}`, `${actor(r.approved_by)}<br>${esc(r.approved_at)}`, `${actor(r.released_by)}<br>${esc(r.released_at)}`,
    `<code>${esc(r.content_sha256.slice(0, 8))}</code>`,
    PARTS[r.format].map((p) => `<a href="/released/${encodeURIComponent(r.id)}?part=${p}">${p.replace('_', ' ')}</a>`).join('<br>')]));
  return page('/review/published', 'Published · nothing is sent', 'Released results', body);
}

const scalar = (v: unknown) => v === null || typeof v !== 'object';
/** An array of rows gets a table of its scalar columns; the nested evidence stays in the file. Anything else is shown as given. */
function cell(v: unknown): string {
  if (scalar(v)) return `<code>${esc(v)}</code>`;
  if (Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object')) {
    const cols = Object.keys(v[0]).filter((k) => scalar(v[0][k]));
    return table(cols.map(esc), v.map((r) => cols.map((k) => esc(r[k]))));
  }
  if (!Array.isArray(v) && Object.values(v as object).every(scalar)) return Object.entries(v as object).map(([k, x]) => `${esc(k)} <code>${esc(x)}</code>`).join(' · ');
  return Array.isArray(v) ? `<code>${esc(JSON.stringify(v))}</code>` : table(['Field', 'Value'], Object.entries(v as object).map(([k, x]) => [esc(k), scalar(x) ? esc(x) : cell(x)]));
}

/** Shows what the report file holds and adds nothing. */
function report(name: string, value: unknown): string {
  const head = `<h2>${name}</h2>`;
  if (value === null || typeof value !== 'object') return `${head}<p>${name} not run yet.</p>`;
  return head + cell(value);
}

export interface Case { id: string; set: string; kind: string; customer: string; occasion: string; past_note: string | null; planted: string[]; why: string; text: string; questions: string[];
  code: { caught: boolean; blocked: boolean; fired: string[]; first_pass_caught?: boolean } }
interface SonnetAnswer { flag: boolean; quote: string; why: string; quote_invalid: boolean }
export interface Judged { id: string; jev: { status: string; flags: string[] }; sonnet: { status: string; answers: Record<string, SonnetAnswer> | null } }
export interface RealDraft { id: string; customer_id: string; version: number; model_json: string; catalog: string | null; checks: CheckResult[]; flags: string[] }
export interface Reports { eval: unknown; readiness: unknown; cases?: { cases: Case[] }; judges?: { cases: unknown[] } }

const NOT_JUDGED = 'not judged yet';
type Call = 'Caught' | 'Missed' | 'Not asked' | typeof NOT_JUDGED;
const jevCall = (c: Case, j?: Judged): Call => (!c.questions.length ? 'Not asked' : j?.jev.status !== 'answered' ? NOT_JUDGED : c.questions.some((q) => j.jev.flags.includes(q)) ? 'Caught' : 'Missed');
const sonnetHit = (c: Case, j?: Judged) => c.questions.map((q) => j?.sonnet.answers?.[q]).find((a) => a?.flag);
/** Code decides: a quote that is not in the text shows nothing, so it is no catch. */
const sonnetCall = (c: Case, j?: Judged): Call => {
  if (!c.questions.length) return 'Not asked';
  if (j?.sonnet.status !== 'answered') return NOT_JUDGED;
  const hit = sonnetHit(c, j);
  return hit && !hit.quote_invalid ? 'Caught' : 'Missed';
};
/** Jev alone: Sonnet is not in the live batch (R124), so what only it finds never reaches a reviewer. */
const verdict = (c: Case, j?: Judged) => (c.code.blocked ? 'Stopped' : jevCall(c, j) === 'Caught' ? 'Flagged for reviewer' : 'Would get through');
const callCell = (v: Call) => `<span class="${v === 'Caught' ? 'pass' : v === 'Missed' ? 'fail' : 'soft'}">${esc(v)}</span>`;
const codeCell = (c: Case) => (c.code.blocked ? `<span class="pass">Caught</span>${c.code.fired.length ? `<br><small>${esc(c.code.fired.map(checkName).join(', '))}</small>` : ''}` : '<span class="fail">Missed</span>');
function sonnetSaid(c: Case, j?: Judged): string {
  const hit = sonnetHit(c, j);
  if (!hit) return '';
  return hit.quote_invalid ? `Quote not found in the draft. ${esc(hit.why)}` : `&ldquo;${esc(hit.quote)}&rdquo; ${esc(hit.why)}`;
}

function caseRows(list: Case[], judged: Map<string, Judged>): string {
  return table(['Problem', 'What the draft said', 'Why it is wrong', 'Code', 'Jev', 'Sonnet', 'Result'], list.map((c) => {
    const j = judged.get(c.id);
    const past = c.past_note ? `<br><small>Past note: ${esc(c.past_note)}</small>` : '';
    return [`${esc(c.id)} · ${esc(c.kind)}<br><small>${esc(c.customer)} · ${esc(c.occasion)}</small>${past}`, highlight(c.text, c.planted), esc(c.why), codeCell(c), callCell(jevCall(c, j)), `${callCell(sonnetCall(c, j))}<br><small>${sonnetSaid(c, j)}</small>`, `<b>${esc(verdict(c, j))}</b>`];
  }));
}

const count = (name: string, n: number | string, of?: number) => `<div><span>${esc(name)}</span><b>${esc(n)}</b>${of === undefined ? '' : `<small>of ${of}</small>`}</div>`;

function realDrafts(drafts: RealDraft[], run: string | null, judged: Map<string, Judged>): string {
  if (!run) return '<p>No real run yet.</p>';
  const rows: string[][] = [];
  const parsed = (d: RealDraft) => { try { return JSON.parse(d.model_json) as ModelJson; } catch { return null; } };
  for (const d of drafts) {
    const next = drafts.find((x) => x.customer_id === d.customer_id && x.version > d.version);
    const titles = new Map(readCards(d.catalog ?? '').map((c) => [c.slot, c.title]));
    const shown = next ? failed(d.checks) : d.checks.filter((c) => !c.pass);
    for (const c of shown) {
      const e = explain(c, parsed(d), titles);
      const todo = next ? (failed(next.checks).length ? 'Retried, failed again' : 'Retried and fixed') : e.hard ? 'Stopped, never reached a reviewer' : 'Reviewer to read';
      rows.push([`${esc(d.customer_id)}, draft ${d.version}`, esc(e.name), e.html ?? '—', esc(e.why), `<b>${esc(todo)}</b>`]);
    }
    if (next) continue;
    for (const q of d.flags) {
      const hit = judged.get(d.id)?.sonnet.answers?.[q];
      rows.push([`${esc(d.customer_id)}, draft ${d.version}`, esc(QUESTION_NAMES[q] ?? q), hit?.flag && !hit.quote_invalid ? `<p>${esc(hit.quote)}</p>` : 'Jev names no words: read the whole draft.', 'Flagged by Jev, which judges the draft as a whole.', '<b>Reviewer to read</b>']);
    }
  }
  return `<p class="note">Latest real run: <code>${esc(run)}</code>.</p>${rows.length ? table(['Draft', 'What was found', 'The exact text', 'Why', 'What to do'], rows) : '<p>Nothing failed or flagged.</p>'}`;
}

export function renderEvals(r: Reports, real: RealDraft[] = [], run: string | null = null): string {
  const cases = r.cases?.cases ?? [];
  const judged = new Map(((r.judges?.cases ?? []) as Judged[]).map((j) => [j.id, j]));
  const stopped = cases.filter((c) => c.code.blocked);
  const through = cases.filter((c) => !c.code.blocked);
  const order = ['Would get through', 'Flagged for reviewer'];
  through.sort((a, b) => order.indexOf(verdict(a, judged.get(a.id))) - order.indexOf(verdict(b, judged.get(b.id))));
  const asked = cases.filter((c) => c.questions.length);
  const by = (call: (c: Case, j?: Judged) => Call) => (judged.size ? asked.filter((c) => call(c, judged.get(c.id)) === 'Caught').length : NOT_JUDGED);
  const firstPass = cases.filter((c) => c.code.first_pass_caught).length;
  const second = cases.filter((c) => c.set === 'Second set');
  const top = `<div class="metrics">${count('Planted problems', cases.length)}${count('Caught by code', stopped.length, cases.length)}${count('Caught by Jev', by(jevCall), asked.length)}${count('Caught by Sonnet', by(sonnetCall), asked.length)}</div>`
    + `<p>Code stops ${stopped.length} of ${cases.length} bad drafts on its own; the other ${through.length} reach a reviewer, so those are the ones that matter. The judges are asked only about copy, so they read ${asked.length}, ${through.length} of which got past code. `
    + `Only Jev runs on a live draft; Sonnet runs here, to check Jev. The checks were tuned on the first set, which scored ${firstPass} of 40 before tuning; the fair figure for code is the second set, ${second.filter((c) => c.code.blocked).length} of ${second.length}, scored once. All customers here are synthetic.</p>`;
  const v = (c: Case) => verdict(c, judged.get(c.id));
  const reached = through.length, none = !judged.size;
  const flaggedN = through.filter((c) => jevCall(c, judged.get(c.id)) === 'Caught').length;
  const gets = through.filter((c) => v(c) === 'Would get through').length;
  const funnel = strip([
    { name: 'Planted', what: 'Fresh writers hid problems in 80 drafts', why: 'So we measure what we did not build for', lines: [`In ${cases.length}`, String(cases.length), `${cases.length - second.length} + ${second.length}, two sets`] },
    { name: 'Code checks', what: 'Rules read every draft', why: 'Free, exact, and blind to paraphrase', lines: [`In ${cases.length}`, `${stopped.length} stopped`, `${reached} through`] },
    { name: 'Jev', what: 'Reads what code let through', why: 'Cheap judgement on meaning', lines: [`In ${reached} of ${asked.length} judged`, none ? 'Not judged yet' : `${flaggedN} flagged`, none ? 'Runs on request' : `${reached - flaggedN} missed`] },
    { name: 'Sonnet', what: 'Second judge quotes the words and says why', why: 'An independent read of the same text, here only', lines: [`In ${reached} of ${asked.length} judged`, none ? 'Not judged yet' : `${through.filter((c) => sonnetCall(c, judged.get(c.id)) === 'Caught').length} caught`, 'Runs on request'] },
    { name: 'Reviewer', what: 'Final call by a person', why: 'Judges only flag', lines: [`In ${reached}`, none ? 'Not judged yet' : `${gets} would get through`, none ? 'Stops at code only so far' : `${reached - gets} flagged for a person`] }]);
  const raw = report('Eval', r.eval) + report('Readiness', r.readiness);
  return page('/review/evals', 'Evals · two sets of planted problems', 'What stops a bad draft, step by step',
    `${TIMELINE_CSS}${funnel}${top}<h2>Reached the reviewer, worst first</h2>${through.length ? caseRows(through, judged) : '<p>No cases loaded.</p>'}`
    + `<details><summary><h2 style="display:inline-block">Stopped by code (${stopped.length})</h2></summary>${caseRows(stopped, judged)}</details>`
    + `<h2>Real drafts</h2>${realDrafts(real, run, judged)}<details><summary><h2 style="display:inline-block">Raw reports</h2></summary>${raw}</details>`);
}
