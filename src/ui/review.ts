// Review screens, boards 2.1–2.3, D1–D5. Every value is escaped here; the routes pass plain rows. No script anywhere: forms and links only.
import { emailPreview } from '../lib/render/email.ts';
import shapes from '../../config/shapes.json' with { type: 'json' };
import quotes from '../../config/quotes.json' with { type: 'json' };
import type { CheckResult, DraftStatus, Envelope, FlagView, ModelJson, Part, Plan, RenderedJson, RunFormat, RunReport, Stage, UnitStatus } from '../contracts/types.ts';
import { countMore, readCards } from '../lib/render/catalog.ts';
import { CHECK_GROUPS, explainBlocks, jevNotRun, stoppedLine } from './checks.ts';
import { esc } from './nb.ts';
import { banner, emptyCard, isStub, shell } from './shell.ts';
import { capital, unitWhy } from './timeline.ts';

const STUB = banner('Stub draft', 'Written by the local stub, not a model. The copy is generic on purpose: it shows the path, not the voice. The real checks, approval and publish still apply.', 'warn');

export interface RunRow { id: string; stage: Stage; created_at: string; status: string; snapshot_id: string; jev_disabled_reason: string | null }
export interface UnitView { customer_id: string; status: UnitStatus; code: string | null; plan: Plan | null;
  draft: { id: string; status: DraftStatus; checks: CheckResult[] } | null; flags: FlagView[] | null }
export interface DraftView { id: string; run_id: string; customer_id: string; version: number; format: RunFormat; status: DraftStatus; model: string; snapshot_id: string;
  validator_version: string; envelope: Envelope; model_json: string; rendered: RenderedJson; content_sha256: string; hash_now: string; checks: CheckResult[]; hard_failures: number;
  approved_by: string | null; approved_at: string | null }
export interface EventRow { from_status: string | null; to_status: string; actor_kind: string; actor_email: string | null; at: string; note: string | null }

const PILL: Record<string, string> = { draft: 'Drafted', in_review: 'Review', approved: 'Approved', released: 'Published', rejected: 'Rejected', failed: 'Failed', skipped: 'Skipped' };
const pill = (s: string) => `<span class="pill ${esc(s)}">${esc(PILL[s] ?? s)}</span>`;
const actorName = (email: string | null) => (email === 'seed-demo@local' ? 'seeded' : email ?? 'system');
const usd = (n: number) => `$${n.toFixed(2)}`;
const draftHref = (id: string) => `/review/${encodeURIComponent(id)}`;
const hash6 = (h: string) => esc(h.slice(0, 6));
const who = (p: Plan | null) => p?.display_name ?? null;
const hasPart = (f: RunFormat, part: Part) => part === 'catalog' || f === 'both' || f === part;

function partCell(checks: CheckResult[], format: RunFormat, part: Part): string {
  if (!hasPart(format, part)) return '<td class="soft">—</td>';
  return checks.some((c) => c.part === part && c.severity === 'hard' && !c.pass) ? '<td class="fail">fail</td>' : '<td class="pass">pass</td>';
}

function unitRow(u: UnitView): string {
  const name = who(u.plan);
  const label = `${esc(u.customer_id)}${name ? ` · ${esc(name)}` : ''}`;
  const state = u.draft?.status ?? u.status;
  const dash = '<td class="soft">—</td>';
  if (!u.draft) {
    return `<tr><td><b>${label}</b></td><td>${esc(u.plan?.occasion ?? '—')}</td><td class="soft">${esc(u.plan?.shape ?? '—')}</td>${dash.repeat(5)}`
      + `<td>${pill(u.status)} <span class="note">${u.code ? esc(unitWhy(u.code)) : ''}</span></td></tr>`;
  }
  const { checks } = u.draft;
  const flagged = u.flags?.filter((f) => f.flagged && !f.dismissal).length;
  const format = u.plan?.format ?? 'both';
  return `<tr><td><a href="${draftHref(u.draft.id)}">${label}</a></td><td>${esc(u.plan?.occasion ?? '—')}</td><td class="soft">${esc(u.plan?.shape ?? '—')}</td>`
    + `${partCell(checks, format, 'email')}${partCell(checks, format, 'landing_page')}${partCell(checks, format, 'catalog')}`
    + `<td>${checks.filter((c) => c.pass).length}/${checks.length}</td><td class="${flagged ? 'warn' : ''}">${flagged ?? '—'}</td><td>${pill(state)}</td></tr>`;
}

export function runsPage(runs: RunRow[], run: RunRow | null, report: RunReport | null, units: UnitView[], deployed: boolean, failed = false, runKey = false): string {
  const demo = deployed ? banner('Demo data', 'This link holds a seeded run. Nothing here reaches a customer.')
    : runKey ? '<p><a class="btn primary" href="/review/start">Start a run</a></p>' : banner('Runs are locked', 'No run key is set on this server, so no run can start.', 'warn');
  if (failed) return shell('Runs', '/review', `${demo}${emptyCard("Couldn't load this run", "The database didn't answer. Try again. No state was changed.")}`);
  if (!run || !report) return shell('Runs', '/review', `${demo}${emptyCard('No runs yet', 'Preview a plan, then start a run.')}`);
  const n = (k: string) => report.counts[k] ?? 0;
  const metrics: [string, string, string?][] = [['Results', String(units.length)], ['In review', String(n('draft:in_review'))], ['Approved', String(n('draft:approved')), 'pass'],
    ['Published', String(n('draft:released'))], ['Failed alone', String(n('unit:failed')), n('unit:failed') ? 'fail' : undefined], [`Spend · estimate ${usd(report.est_usd)}`, usd(report.spent_usd)]];
  const firstCode = units.find((u) => u.status === 'failed' || u.status === 'skipped');
  const formats = new Map<string, number>();
  for (const u of units) if (u.plan) formats.set(u.plan.format, (formats.get(u.plan.format) ?? 0) + 1);
  const split = [...formats].map(([f, n2]) => `${esc(f)} ${n2}`).join(' · ');
  const live = run.status === 'preparing' || run.status === 'generating';
  const body = `${isStub(run.id) ? STUB : ''}${demo}${banner('Snapshot', `Frozen on ${report.snapshot_fetched_at.slice(0, 10)}. Nothing is sent to a customer.`, 'warn')}`
    + (run.jev_disabled_reason ? banner('Jev off', `Draft flags did not run for this run: ${run.jev_disabled_reason}. Code checks still applied.`, 'warn') : '')
    + `<p class="runs">${runs.map((r) => `<a href="/review?run=${encodeURIComponent(r.id)}"${r.id === run.id ? ' aria-current="true"' : ''}>${esc(r.id)} · ${esc(r.stage)}</a>`).join('')}</p>`
    + `<div class="top"><div><p class="eyebrow">Runs · ${esc(run.stage)} · ${esc(run.status)} · snapshot ${esc(report.snapshot_fetched_at.slice(0, 10))}</p><h1>${esc(run.id)}</h1></div>`
    + `<div><a class="btn" href="/review/runs/${encodeURIComponent(run.id)}">Timeline</a> <a class="btn" href="/review/runs/${encodeURIComponent(run.id)}/plans">Plans</a> <a class="btn" href="/review/runs/${encodeURIComponent(run.id)}.json">View JSON</a></div></div>`
    + `<div class="metrics">${metrics.map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c ?? ''}">${esc(v)}</b></div>`).join('')}</div>`
    + (live ? emptyCard('Run in progress', `${units.filter((u) => ['drafted', 'failed', 'skipped'].includes(u.status)).length} of ${units.length} done. This page updates on refresh.`) : '')
    + `<p class="note">Showing ${units.length} of ${units.length}.${firstCode ? ` ${esc(firstCode.customer_id)} stopped with ${esc(firstCode.code ?? firstCode.status)}. The other customers carried on.` : ''}${split ? ` Format: ${split}.` : ''} Ceiling ${usd(report.ceiling_usd)}.</p>`
    + `<div class="scroll"><table><thead><tr><th>Customer</th><th>Occasion</th><th>Shape</th><th>Email</th><th>Landing</th><th>Catalog</th><th>Checks</th><th>Jev flags</th><th>State</th></tr></thead>`
    + `<tbody>${units.map(unitRow).join('')}</tbody></table></div>`;
  return shell(`Runs · ${run.id}`, '/review', body);
}

export function plansPage(run_id: string, plans: Plan[], admissions: Record<string, string>): string {
  const rows = plans.map((p) => `<tr><td><b>${esc(p.customer_id)}</b></td><td>${esc(p.format)}</td><td>${esc(p.occasion ?? '—')}</td><td>${esc(p.occasion_key ?? '—')}</td><td>${esc(p.shape ?? '—')}</td>`
    + `<td>${p.new_user ? 'yes' : 'no'}</td><td>${esc(admissions[p.customer_id] ?? p.outcome.kind)}</td><td>${p.picks.map((k) => `${esc(k.slot)} ${esc(k.reason_code)}`).join('<br>')}</td></tr>`).join('');
  return shell(`Plans · ${run_id}`, '/review', `<div class="top"><div><p class="eyebrow">Plans</p><h1>${esc(run_id)}</h1></div><a class="btn" href="/review?run=${encodeURIComponent(run_id)}">Back to the run</a></div>`
    + (plans.length ? `<div class="scroll"><table><thead><tr><th>Customer</th><th>Format</th><th>Occasion</th><th>Key</th><th>Shape</th><th>New user</th><th>Admission</th><th>Picks</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : emptyCard('No plans yet', 'Plans appear once the run has prepared.')));
}

function stepper(status: DraftStatus, checks: CheckResult[]): string {
  const STEPS = [['draft', 'Drafted'], ['in_review', 'In review'], ['approved', 'Approved'], ['released', 'Published']] as const;
  if (status === 'failed' || status === 'rejected') {
    return `<p class="step"><span class="done">✓ Drafted</span><span class="bad">${status === 'failed' ? esc(stoppedLine(checks)) : 'Rejected. Final for this run.'}</span></p>`;
  }
  const at = STEPS.findIndex(([s]) => s === status);
  return `<p class="step">${STEPS.map(([, l], i) => (i < at ? `<span class="done">✓ ${l}</span>` : i === at ? `<span class="now">${l}</span>` : `<span class="next">${l}</span>`)).join('')}</p>`;
}

const notRun = (checks: CheckResult[], ids: string[]) => (checks.some((c) => c.id === 'C1' && !c.pass) ? 'Not run: the draft failed its format check first, so nothing after it ran.'
  : ids.every((id) => id.startsWith('X')) ? 'Not run: the page could not be built, so it was never checked.' : 'Not run: this draft has no stored result for it.');

function jevRow(d: DraftView, flags: FlagView[] | null, jev: DraftOpts['jev']): [string, string] {
  if (d.hard_failures > 0) return ['Not run: a draft that fails a check is not sent to Jev.', 'soft'];
  if (flags === null) return ['Not run: Jev is not built into this environment.', 'soft'];
  if (!flags.length) return [jevNotRun(jev?.reason), 'soft'];
  const flagged = flags.filter((f) => f.flagged && !f.dismissal).length;
  return [`${flagged} flags`, flagged ? 'warn' : 'pass'];
}

function checkRows(d: DraftView, flags: FlagView[] | null, jev: DraftOpts['jev']): string {
  const row = (name: string, value: string, cls: string) => `<div class="row"><span>${esc(name)}</span><span class="${cls}">${esc(value)}</span></div>`;
  const named = CHECK_GROUPS.map(([name, ids]) => {
    const mine = d.checks.filter((c) => ids.includes(c.id));
    return mine.some((c) => !c.pass && c.severity === 'hard') ? row(name, 'Failed, see below', 'fail') : mine.length ? row(name, 'Passed', 'pass') : row(name, notRun(d.checks, ids), 'soft');
  });
  return [...named, row('Jev: quiet, specific', ...jevRow(d, flags, jev))].join('');
}

function outline(d: DraftView, shape: string | null, titles: Map<string, string>): string {
  const sections = (JSON.parse(d.model_json) as ModelJson).landing_page?.sections;
  if (!Array.isArray(sections)) return '';
  const t = (slot: unknown) => titles.get(String(slot)) ?? String(slot);
  const label = (s: Record<string, unknown>) => {
    switch (s.type) {
      case 'hero': case 'feature': return `${s.type} ${t(s.slot)}`;
      case 'product_grid': return `grid (${(s.items as unknown[])?.length ?? 0})`;
      case 'pairing': return `pairing ${((s.slots as unknown[]) ?? []).map(t).join(' + ')}`;
      case 'packing_list': return `packing list (${(s.items as unknown[])?.length ?? 0})`;
      case 'quote': return `quote ${s.quote_id}`;
      default: return String(s.type);
    }
  };
  return `<p class="note">Outline: ${esc(shape ?? 'no shape')} · ${esc((sections as Record<string, unknown>[]).map(label).join(' › '))}</p>`;
}

const shapeRule = (shape: string | null) => shapes.shapes.find((s) => s.id === shape);

function actions(d: DraftView): string {
  const form = (action: string, inner: string) => `<form method="post" action="/api/drafts/${encodeURIComponent(d.id)}/${action}">${inner}</form>`;
  if (d.status === 'in_review') {
    return `<div class="actions">${form('approve', '<button class="btn primary wide">Approve</button>')}`
      + `<details><summary class="btn danger wide">Reject</summary>${form('reject', '<label>Why, for the record<textarea name="note" required></textarea></label><button class="btn danger go wide">Reject with note</button>')}</details></div>`;
  }
  if (d.status === 'approved') {
    return `<div class="actions"><a class="btn primary wide" href="${draftHref(d.id)}?confirm=release">Publish</a>${form('revoke', '<button class="btn wide">Revoke approval</button>')}</div>`
      + `<p class="note">Approved by ${esc(actorName(d.approved_by))}, ${esc(d.approved_at)}. Hash ${hash6(d.content_sha256)} ${d.hash_now === d.content_sha256 ? 'matches' : 'does not match'}. Any change to content blocks publish.</p>`;
  }
  return '';
}

function publishDialog(d: DraftView, name: string): string {
  const matches = d.hash_now === d.content_sha256;
  const row = (k: string, v: string, cls = 'pass') => `<div class="row"><span>${esc(k)}</span><span class="${cls}">${esc(v)}</span></div>`;
  const links = (['email', 'landing_page', 'catalog'] as const).filter((p) => d.rendered[p]).map((p) => `/released/${d.id}?part=${p}`);
  return `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg"><p class="eyebrow">Publish one result</p>`
    + (matches ? `<h3 id="dlg">Publish ${esc(name)}'s result?</h3><p class="note">All parts go together. Nothing is sent to the customer: this stores them at a local address only.</p>`
      : `<h3 id="dlg">This can't be published</h3><p class="note">The content changed after approval. Revoke it and review it again.</p>`)
    + row('Approved by', `${actorName(d.approved_by)}, ${d.approved_at}`) + row('Content hash matches approval', hash6(d.hash_now), matches ? 'pass' : 'fail') + row('Hard failures stored', String(d.hard_failures))
    + row('Snapshot and picks', 'checked again on Publish', 'soft')
    + `<div class="row"><span>Addresses</span><span class="soft">${links.map(esc).join('<br>')}</span></div>`
    + `<div class="buttons"><a class="btn" href="${draftHref(d.id)}">Cancel</a>${matches ? `<form method="post" action="/api/drafts/${encodeURIComponent(d.id)}/release"><button class="btn primary">Publish</button></form>` : ''}</div></div></div>`;
}

const DONE: Record<string, string> = { approved: 'Approved. Nothing is sent.', rejected: 'Rejected. Final for this run.', in_review: 'Approval revoked. Back in review.', released: 'Published. Not sent.' };

export interface DraftOpts { part: string | null; width: number; confirm: boolean; done: string | null; refused: string | null; prev: string | null; next: string | null; jev?: { status: string; reason: string | null } | null; timeline?: string | null; madeBy?: string | null }

export function draftPage(d: DraftView, plan: Plan | null, flags: FlagView[] | null, flagRows: string, events: EventRow[], o: DraftOpts): string {
  const name = plan?.display_name ? capital(plan.display_name) : d.customer_id;
  const tabs = (['email', 'landing_page', 'catalog'] as const).filter((p) => d.rendered[p] !== null && d.rendered[p] !== undefined);
  const part = tabs.find((p) => p === o.part) ?? tabs.find((p) => p === 'landing_page') ?? tabs[0];
  const href = (p: string, w: number) => `${draftHref(d.id)}?part=${p}&amp;width=${w}`;
  const LABEL: Record<Part, string> = { email: 'Email', landing_page: 'Landing page', catalog: 'Catalog' };
  const cards = readCards(d.rendered.catalog ?? '');
  const moreCount = countMore(d.rendered.catalog ?? '');
  const reason = new Map(plan?.picks.map((p) => [p.slot as string, p.reason_code]));
  const titles = new Map(cards.map((c) => [c.slot, c.title]));
  const rule = shapeRule(plan?.shape ?? null);
  const model = JSON.parse(d.model_json) as ModelJson;
  const quoteIds = (Array.isArray(model.landing_page?.sections) ? model.landing_page.sections as Record<string, unknown>[] : []).filter((s) => s.type === 'quote').map((s) => s.quote_id);
  const picks = cards.map((c) => `<div class="pick"><img src="${esc(new URL(c.src).origin + new URL(c.src).pathname)}?width=80" alt="${esc(c.title)}" width="40" height="50" loading="lazy"><div>${esc(c.title)} <small>${esc(reason.get(c.slot) ?? '')}</small>`
    + `<a href="${esc(c.href)}">${esc(c.href.replace('https://www.', ''))}</a></div></div>`).join('');
  const quoteRows = quotes.quotes.filter((q) => quoteIds.includes(q.id)).map((q) => `<div class="pick"><span></span><div>Quote ${esc(q.id)} <small>${esc(q.fetched_at)}</small><a href="https://www.${esc(q.source)}">${esc(q.source)}</a></div></div>`).join('');

  const banners = (isStub(d.id) ? STUB : '') + (o.done && DONE[o.done] ? banner('Done', DONE[o.done]) : '')
    + (o.refused ? banner('Publish refused', `${o.refused}. The state did not change.`, 'fail') : '')
    + (plan?.new_user ? banner('New user', `No purchase history. Signals: ${plan.signals.join(', ') || 'none'}. Copy speaks from the picks' ordinary use.`, 'warn') : '');

  const frame = part
    ? `<div class="scroll"><iframe title="${esc(LABEL[part])}" sandbox="" width="${o.width}" style="width:${o.width}px${o.width > 700 ? ';zoom:.55;height:1380px' : ''}" srcdoc="${esc(part === 'email' ? emailPreview(d.rendered.email!) : d.rendered[part])}"></iframe></div>`
    : emptyCard('Nothing rendered', 'This draft stored no page.');
  const body = `${banners}<div class="top"><div><p class="eyebrow">${esc(d.run_id)} · ${esc(d.customer_id)} · shape ${esc(plan?.shape ?? 'none')}</p>`
    + `<h1>${esc(name)}${plan?.occasion ? `, ${esc(plan.occasion)}` : ''}</h1></div><div>${o.prev ? `<a class="btn" href="${draftHref(o.prev)}">Previous</a> ` : ''}${o.next ? `<a class="btn" href="${draftHref(o.next)}">Next</a>` : ''}</div></div>`
    + (o.timeline ? `<details${d.status === 'failed' ? ' open' : ''}><summary><h2 style="display:inline-block">What happened to this customer, step by step</h2></summary>${o.timeline}</details>` : '')
    + `<div class="draft"><div><div class="tabs"><div>${tabs.map((p) => `<a href="${href(p, o.width)}"${p === part ? ' aria-current="page"' : ''}>${LABEL[p]}</a>`).join('')}</div>`
    + `<div>${[390, 1200].map((w) => `<a href="${href(part ?? 'catalog', w)}"${w === o.width ? ' aria-current="true"' : ''}>${w === 390 ? 'Phone 390' : 'Desktop 1200'}</a>`).join('')}</div></div>`
    + `${frame}${outline(d, plan?.shape ?? null, titles)}<p class="note">Shape ${esc(plan?.shape ?? 'none')}: ${rule ? `/${esc(rule.re)}/${esc(rule.flags)}, ${esc(rule.job)}` : 'no rule matched'}.</p></div>`
    + `<aside>${stepper(d.status, d.checks)}${actions(d)}`
    + `${d.status === 'released' ? `<p class="note">Stored, not sent. ${tabs.map((p) => `<a href="/released/${encodeURIComponent(d.id)}?part=${p}">${LABEL[p]}</a>`).join(' · ')}</p>` : ''}`
    + `<h2>Checks</h2>${checkRows(d, flags, o.jev)}${explainBlocks(d.checks, model, titles)}`
    + (flagRows ? `<h2>Jev flags</h2>${flagRows}` : '')
    + `<h2>Picks and sources</h2>${picks || '<p class="note">No picks in the stored catalog.</p>'}${moreCount ? `<p class="note">${moreCount} more items in the stored catalog.</p>` : ''}${quoteRows}`
    + `<h2>Provenance</h2><div class="row"><span>Snapshot</span><span>${esc(d.snapshot_id)}, ${esc(d.envelope.snapshot_fetched_at?.slice(0, 10))}</span></div><div class="row"><span>Model</span><span>${esc(d.model)}</span></div>`
    + `<div class="row"><span>Prompt · voice</span><span>${esc(d.envelope.prompt_version)} · ${esc(d.envelope.voice_guide_version)}</span></div><div class="row"><span>Hash</span><span>${hash6(d.content_sha256)}</span></div>`
    + (o.madeBy ? `<div class="row"><span>Made by</span><span>${esc(o.madeBy)}</span></div>` : '')
    + `<h2>History</h2>${events.map((e) => `<div class="row"><span>${esc(e.from_status ?? '∅')} → ${esc(e.to_status)}${e.note ? `: ${esc(e.note)}` : ''}</span><span>${esc(actorName(e.actor_email))}, ${esc(e.at)}</span></div>`).join('')}`
    + `<details><summary><h2 style="display:inline-block">Raw model output</h2></summary><pre>${esc(d.model_json)}</pre></details></aside></div>`
    + (o.confirm && d.status === 'approved' ? publishDialog(d, name) : '');
  return shell(`${d.customer_id} · ${d.run_id}`, '/review', body);
}

