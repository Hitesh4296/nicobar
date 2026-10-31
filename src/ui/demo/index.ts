// Spend, Published, Evals: read-only.
import { NAV } from '../../contracts/nav.ts';
import type { RunFormat, Stage, RunStatus } from '../../contracts/types.ts';
import { isStub } from '../shell.ts';

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

function shell(href: string, kicker: string, title: string, body: string): string {
  const nav = NAV.map((n) => `<a ${n.href === href ? 'aria-current="page" ' : ''}href="${n.href}">${n.label}</a>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1b202a;background:#fff}nav{background:#1b202a;padding:16px;display:flex;flex-wrap:wrap;gap:8px}
nav a{color:#d8dbe0;text-decoration:none;padding:6px 12px}nav a[aria-current]{background:#27405e;color:#fff}main{max-width:1000px;margin:0 auto;padding:24px 16px}
.k{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5b616b}h1{font:400 36px/1.2 Georgia,serif;margin:4px 0 24px}h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin:32px 0 8px}
.w{overflow-x:auto}table{border-collapse:collapse;width:100%}th{text-align:left;font-size:13px;color:#5b616b;border-bottom:1px solid #1b202a;padding:6px 16px 6px 0}td{border-bottom:1px solid #e3e3e0;padding:10px 16px 10px 0;vertical-align:top}
a{color:#27405e}code{font-size:13px}</style><nav>${nav}</nav><main><div class="k">${kicker}</div><h1>${title}</h1><div class="w">${body}</div></main></html>`;
}

export function renderSpend(rows: SpendRow[], ledger_usd: number): string {
  const body = rows.length === 0 ? '<p>No runs yet.</p>' : table(['Run', 'Stage', 'Status', 'Estimated', 'Spent', 'Jev', 'Cap', 'Ceiling', 'Cap actions'], rows.map((r) => [
    `<code>${esc(r.id)}</code>`, `${esc(r.stage)}${isStub(r.id) ? ' · stub, nothing billed' : ''}`, esc(r.status), usd(r.expected_usd), usd(r.spent_usd), usd(r.jev_usd), usd(r.cap_run_usd), usd(r.ceiling_usd), esc(r.actions ?? 'none')]));
  return shell('/review/spend', 'Spend · read-only', 'What each run cost', `${body}<p>Spent outside a run: ${usd(ledger_usd)}</p>`);
}

const PARTS: Record<RunFormat, string[]> = { both: ['email', 'landing_page', 'catalog'], email: ['email', 'catalog'], landing_page: ['landing_page', 'catalog'] };

export function renderPublished(rows: PublishedRow[]): string {
  const body = rows.length === 0 ? '<p>Nothing released yet.</p>' : table(['Customer', 'Approved', 'Released', 'Hash', 'Parts'], rows.map((r) => [
    `${esc(r.display_name ?? r.customer_id)} <code>${esc(r.customer_id)}</code>${isStub(r.id) ? ' · stub draft' : ''}`, `${actor(r.approved_by)}<br>${esc(r.approved_at)}`, `${actor(r.released_by)}<br>${esc(r.released_at)}`,
    `<code>${esc(r.content_sha256.slice(0, 8))}</code>`,
    PARTS[r.format].map((p) => `<a href="/released/${encodeURIComponent(r.id)}?part=${p}">${p.replace('_', ' ')}</a>`).join('<br>')]));
  return shell('/review/published', 'Published · nothing is sent', 'Released results', body);
}

const scalar = (v: unknown) => v === null || typeof v !== 'object';
/** An array of rows gets a table of its scalar columns; the nested evidence stays in the file. Anything else is shown as given. */
function cell(v: unknown): string {
  if (scalar(v)) return `<code>${esc(v)}</code>`;
  if (Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object')) {
    const cols = Object.keys(v[0]).filter((k) => scalar(v[0][k]));
    return table(cols.map(esc), v.map((r) => cols.map((k) => esc(r[k]))));
  }
  return Array.isArray(v) ? `<code>${esc(JSON.stringify(v))}</code>` : table(['Field', 'Value'], Object.entries(v as object).map(([k, x]) => [esc(k), scalar(x) ? esc(x) : cell(x)]));
}

/** Shows what the report file holds and adds nothing. */
function report(name: string, value: unknown): string {
  const head = `<h2>${name}</h2>`;
  if (value === null || typeof value !== 'object') return `${head}<p>${name} not run yet.</p>`;
  return head + cell(value);
}

export function renderEvals(reports: { eval: unknown; readiness: unknown }): string {
  return shell('/review/evals', 'Evals · offline · $0 · no key needed', 'Does the batch catch what it should?', report('Eval', reports.eval) + report('Readiness', reports.readiness));
}
