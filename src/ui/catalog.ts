// The catalog viewer. Everything from a row, a query or a catalog passes through esc. Switches and item buttons are links: a draft lives in the URL until Save.
import type { CatalogOverride, ConfigVersion, Product } from '../contracts/types.ts';
import { RULES, type Status } from '../lib/catalog/override.ts';
import { lineDiff } from '../lib/config/index.ts';
import { esc } from './nb.ts';
import { emptyCard, shell } from './shell.ts';

export interface ProductRow { p: Product; reasons: string[]; status: Status }
export interface Filters { q: string; status: string; reason: string; category: string; occasion: string; sort: 'newest'|'title'; months: string }
export interface ImpactRow { customer_id: string; occasion: string|null; kind: 'unchanged'|'sections'|'picks'; before: string[]; after: string[]; failed: string|null }
export interface CatalogView { snapshot_id: string; fetched_at: string; total: number; gift_cards: number|null; usableNow: number; usableDraft: number; hasDraft: boolean; byStatus: Record<Status, number>; counts: Record<string, { hit: number; only: number }>; soldRecent: number;
  rows: ProductRow[]; found: number; page: number; pages: number; filters: Filters; categories: string[]; occasions: string[]; draft: CatalogOverride; live: CatalogOverride; title: (id: string) => string;
  versions: ConfigVersion[]; active: ConfigVersion|null; refused: string[]; error: string|null; preview: { rows: ImpactRow[]; usable_before: number; usable_after: number }|null; deployed: boolean; locked: boolean; query: URLSearchParams }

const STATUS: Record<Status, string> = { usable: 'Usable', p0: 'Off by P0', p1: 'Off by P1', enabled: 'Enabled by you', disabled: 'Disabled by you' };
const PILL: Record<Status, string> = { usable: 'approved', p0: 'failed', p1: 'skipped', enabled: 'released', disabled: 'rejected' };
const CHANGE = { unchanged: 'Unchanged', sections: 'Sections only', picks: 'Picks changed' };
export const wordOf = (id: string) => RULES.find((r) => r.id === id)?.name ?? id;
const date = (s?: string|null) => (s ? s.slice(0, 10) : 'Not recorded');
const num = (n: number) => n.toLocaleString('en-IN');
const CSS = `<style>.th{width:48px;height:60px;object-fit:cover}.filters{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-end;margin:8px 0 16px}.filters label{display:grid;gap:2px;font-size:13px;color:var(--color-ink-soft)}.filters input,.filters select,.save input,.save select{min-height:44px;padding:0 8px;border:1px solid var(--color-ink);background:var(--color-white);font:inherit}
.link{font-size:14px;white-space:nowrap}.btn.small{min-height:36px;padding:0 12px;font-size:14px}.save{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-end;margin-top:8px}.save label{display:grid;gap:2px;font-size:13px}.gallery{display:flex;flex-wrap:wrap;gap:8px}.gallery img{width:140px;height:175px;object-fit:cover}.tags{font:13px/20px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}.add{color:var(--color-pass)}.del{color:var(--color-fail)}</style>`;
const page = (title: string, body: string) => shell(title, '/review/catalog', `${CSS}${body}`);
export const emptyPage = (title: string, why: string) => page('Catalog', `<p class="eyebrow">Catalog</p><h1>Catalog</h1>${emptyCard(title, why)}`);
const table = (head: string[], rows: string[][]) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const select = (name: string, label: string, value: string, options: [string, string][]) => `<label>${label}<select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;

const pretty = (o: CatalogOverride, title: (id: string) => string) => [...o.rules_off.map((r) => `Rule off: ${wordOf(r)}`), ...o.enabled.map((i) => `Enabled: ${title(i)}`), ...o.disabled.map((i) => `Disabled: ${title(i)}`)].join('\n');
const diff = (a: string, b: string) => `<pre>${lineDiff(a, b).filter((l) => l.op !== '=' && l.text).map((l) => `<span class="${l.op === '+' ? 'add' : 'del'}">${l.op} ${esc(l.text)}</span>`).join('\n') || 'No change'}</pre>`;
const sameContent = (a: CatalogOverride, b: CatalogOverride) => pretty(a, String) === pretty(b, String);

/** The same page with one change to the query. Moving the draft always resets the page number to where it stands. */
const link = (q: URLSearchParams, set: Record<string, string|null>) => { const u = new URLSearchParams(q); u.delete('preview'); for (const [k, v] of Object.entries(set)) { if (v) u.set(k, v); else u.delete(k); } return `/review/catalog?${esc(u.toString())}`; };
const toggled = (q: URLSearchParams, d: CatalogOverride, next: Partial<CatalogOverride>) => { const o = { ...d, ...next }; return link(q, { draft: '1', off: o.rules_off.join(',') || null, en: o.enabled.join(',') || null, dis: o.disabled.join(',') || null }); };
const without = (xs: string[], x: string) => xs.filter((v) => v !== x);

function ruleTable(v: CatalogView): string {
  const rows = RULES.filter((r) => r.id !== 'NOT_RECORDED' || v.counts[r.id]).map((r) => {
    const gift = r.id === 'GIFT_CARD', hit = gift ? (v.gift_cards === null ? 'Not recorded' : String(v.gift_cards)) : num(v.counts[r.id]?.hit ?? 0), only = gift ? 'Not in the snapshot' : num(v.counts[r.id]?.only ?? 0);
    const off = v.draft.rules_off.includes(r.id), locked = `<span class="soft">Locked</span>`;
    const control = r.priority === 'P0' ? locked : v.deployed ? (off ? 'Off' : 'On') : `${off ? 'Off' : 'On'} <a class="btn small" href="${toggled(v.query, v.draft, { rules_off: off ? without(v.draft.rules_off, r.id) : [...v.draft.rules_off, r.id] })}">${off ? 'Switch on' : 'Switch off'}</a>`;
    const extra = r.id === 'NOT_AVAILABLE' ? ` <strong>${num(v.soldRecent)} from the last 12 months</strong> before the snapshot.` : '';
    return [esc(r.name), esc(r.priority), hit, only, `${esc(r.why)}${extra}${r.if_enabled ? `<br><span class="soft">If used: ${esc(r.if_enabled)}</span>` : ''}`, control];
  });
  return `<h2>Rules</h2>${table(['Rule', 'Priority', 'Products', 'This reason alone', 'Why', 'State'], rows)}<p class="note">A product can fail several rules, so the rows add up to more than the products. P0 is locked: enabling one would break a promise to the customer. Switching a P1 rule off brings back only products with no other reason left.</p>`;
}

function listRow(x: ProductRow, v: CatalogView): string {
  const { p, status, reasons } = x, d = v.draft;
  const enable = toggled(v.query, d, { disabled: without(d.disabled, p.id), enabled: reasons.length && !d.enabled.includes(p.id) && status === 'p1' ? [...d.enabled, p.id] : d.enabled });
  const disable = toggled(v.query, d, { enabled: without(d.enabled, p.id), disabled: [...d.disabled, p.id] });
  const action = v.deployed ? '' : status === 'p1' || status === 'disabled' ? `<a class="btn small" href="${enable}">Enable</a>` : status === 'usable' || status === 'enabled' ? `<a class="btn small" href="${disable}">Disable</a>` : '';
  const occ = [...new Set([...p.occasion_keys, ...p.wear_occasion, ...p.gift_occasion])];
  return `<tr data-p="${esc(p.id)}"><td>${p.images[0] ? `<img class="th" loading="lazy" src="${esc(p.images[0].src)}" alt="">` : ''}</td><td><a href="/review/catalog/${esc(p.id)}">${esc(p.title)}</a><br><a class="link" href="${esc(p.url)}" rel="noopener" target="_blank">nicobar.com</a></td>`
    + `<td>${esc(p.category.join(', '))}</td><td>${esc(p.class.join(', '))}</td><td>${esc(p.gender ?? '')}</td><td>${esc(occ.join(', '))}</td><td>${esc(date(p.published_at))}</td><td><span class="pill ${PILL[status]}">${STATUS[status]}</span></td><td>${esc(reasons.map(wordOf).join(', '))}</td><td>${action}</td></tr>`;
}

function filterForm(v: CatalogView): string {
  const f = v.filters, keep = ['draft', 'off', 'en', 'dis'].flatMap((k) => { const x = v.query.get(k); return x === null ? [] : [`<input type="hidden" name="${k}" value="${esc(x)}">`]; }).join('');
  return `<form class="filters" method="get" action="/review/catalog">${keep}<label>Title<input name="q" value="${esc(f.q)}"></label>${select('status', 'Status', f.status, [['', 'All'], ...Object.entries(STATUS)])}${select('reason', 'Reason', f.reason, [['', 'All'], ...RULES.filter((r) => r.id !== 'GIFT_CARD' && r.id !== 'NOT_RECORDED').map((r): [string, string] => [r.id, r.name])])}
${select('category', 'Category', f.category, [['', 'All'], ...v.categories.map((c): [string, string] => [c, c])])}${select('occasion', 'Occasion', f.occasion, [['', 'All'], ...v.occasions.map((c): [string, string] => [c, c])])}${select('months', 'Published', f.months, [['', 'Any time'], ['3', 'Last 3 months'], ['6', 'Last 6 months'], ['12', 'Last 12 months']])}${select('sort', 'Sort', f.sort, [['newest', 'Newest first'], ['title', 'Title']])}<button class="btn">Apply</button></form>`;
}

function draftBlock(v: CatalogView): string {
  if (v.deployed || !v.hasDraft) return '';
  const u = v.draft, same = sameContent(u, v.live), hidden = (n: string, x: string[]) => `<input type="hidden" name="${n}" value="${esc(x.join(','))}">`;
  return `<h2>Draft, not saved</h2><p class="note">${esc(v.active?.id ?? 'No version is active')} against this draft. Nothing here affects a run until a version is saved and activated.</p>${diff(pretty(v.live, v.title), pretty(u, v.title))}
<p><a class="btn" href="${link(v.query, { preview: '1' })}">Preview impact</a> <a class="btn" href="/review/catalog">Drop this draft</a></p>${same ? '' : `<form class="save" method="post" action="/review/catalog/save">${hidden('off', u.rules_off)}${hidden('en', u.enabled)}${hidden('dis', u.disabled)}<label>Note, to save<input name="note" required placeholder="What changed, and why"></label><button class="btn primary">Save draft</button></form>`}`;
}

function impactBlock(v: CatalogView): string {
  const x = v.preview;
  if (!x) return v.hasDraft && v.query.has('preview') ? '<h2>Impact</h2><p class="note">No inputs published. Run the build with --publish, then come back.</p>' : '';
  const n = (k: ImpactRow['kind']) => x.rows.filter((r) => r.kind === k).length, delta = x.usable_after - x.usable_before;
  const rows = x.rows.map((r) => [`<strong>${esc(r.customer_id)}</strong><br>${esc(r.occasion ?? '')}`, r.failed ? `<span class="fail">Fails: ${esc(r.failed)}</span>` : esc(CHANGE[r.kind]), r.kind === 'picks' ? esc(r.before.join(' · ')) : '<span class="soft">Same picks</span>', esc(r.after.join(' · '))]);
  return `<h2>Impact</h2><div class="metrics"><div><span>Usable</span><b>${delta > 0 ? '+' : ''}${delta}</b></div><div><span>Picks changed</span><b>${n('picks')}</b></div><div><span>Sections only</span><b>${n('sections')}</b></div><div><span>Unchanged</span><b>${n('unchanged')}</b></div><div><span>Cost</span><b>$0</b></div></div>
<p class="note">${num(x.usable_before)} usable now, ${num(x.usable_after)} with this draft, ranked at the active weights. Nothing was saved and nothing was spent.</p>${table(['Customer', 'Result', 'Before', 'After'], rows)}`;
}

function history(v: CatalogView): string {
  if (!v.versions.length) return '<p class="note">No version yet. The snapshot and config/ranking.json stand as they are, and the first save becomes catalog-v1.</p>';
  const by = new Map(v.versions.map((x) => [x.id, x]));
  const rows = v.versions.map((x) => {
    const c = x.content as CatalogOverride, parent = x.parent_id ? by.get(x.parent_id)?.content as CatalogOverride | undefined : undefined;
    const load = v.deployed ? '' : `<a href="${link(new URLSearchParams(), { draft: '1', off: c.rules_off.join(',') || null, en: c.enabled.join(',') || null, dis: c.disabled.join(',') || null })}">Load</a>`;
    return [`${esc(x.id)} <span class="pill">${esc(x.status)}</span>`, esc(x.note), `${esc(x.created_by)}<br>${esc(x.created_at.slice(0, 16).replace('T', ' '))}`, `<details><summary>${parent ? `Against ${esc(x.parent_id)}` : 'From the snapshot'}</summary>${diff(pretty(parent ?? { rules_off: [], enabled: [], disabled: [] }, v.title), pretty(c, v.title))}</details>`, load];
  });
  return table(['Version', 'Note', 'Saved by', 'Change', ''], rows);
}

function activateBlock(v: CatalogView): string {
  const drafts = v.versions.filter((x) => x.status === 'draft');
  if (v.deployed || !drafts.length) return '';
  if (v.locked) return '<p class="note">Runs are locked: no run key is set on this server, so no version can be activated.</p>';
  return `<h2>Activate for next run</h2><form class="save" method="post" action="/review/catalog/activate"><label>Version<select name="id">${drafts.map((x) => `<option>${esc(x.id)}</option>`).join('')}</select></label><label>Run key<input type="password" name="run_key" autocomplete="off" required></label><button class="btn primary">Activate for next run</button></form>`;
}

export function catalogPage(v: CatalogView): string {
  const pager = `<p class="note">${num(v.found)} found. Page ${v.page} of ${v.pages}. ${v.page > 1 ? `<a href="${link(v.query, { page: String(v.page - 1) })}">Previous</a> ` : ''}${v.page < v.pages ? `<a href="${link(v.query, { page: String(v.page + 1) })}">Next</a>` : ''}</p>`;
  const delta = v.hasDraft && v.usableDraft !== v.usableNow ? `<div><span>With this draft</span><b>${num(v.usableDraft)}</b></div>` : '';
  const notes = [...(v.error ? [v.error] : []), ...v.refused].map((e) => `<p role="alert" class="banner fail"><b>Refused</b><span>${esc(e)}</span></p>`).join('');
  return page('Catalog', `<p class="eyebrow">Catalog · ${esc(v.snapshot_id)}</p><h1>Catalog</h1>
<p>Every product in the snapshot of ${esc(date(v.fetched_at))}, and why it is or is not used. A product is usable when it can be bought, has a real image and real copy, and no rule holds it back.${v.deployed ? ' Read-only here.' : ''}</p>${notes}
<div class="metrics"><div><span>Usable now</span><b>${num(v.usableNow)}</b></div>${delta}<div><span>In the snapshot</span><b>${num(v.total)}</b></div><div><span>Off by P0</span><b>${num(v.byStatus.p0)}</b></div><div><span>Off by P1</span><b>${num(v.byStatus.p1)}</b></div><div><span>Enabled, disabled</span><b>${num(v.byStatus.enabled)}, ${num(v.byStatus.disabled)}</b></div></div>
<p class="note">Active version: ${esc(v.active?.id ?? 'none, the snapshot stands as built')}. A version applies to new runs only.</p>
${draftBlock(v)}${impactBlock(v)}${ruleTable(v)}${activateBlock(v)}<h2>Version history</h2>${history(v)}
<h2>Products</h2>${filterForm(v)}${pager}${table(['', 'Product', 'Category', 'Class', 'Gender', 'Occasion', 'Published', 'Status', 'Reasons', ''], []).replace('<tbody></tbody>', `<tbody>${v.rows.map((x) => listRow(x, v)).join('')}</tbody>`)}${pager}`);
}

export interface ProductView { p: Product; reasons: string[]; status: Status; side: { tags: string[]; text: string }|null; reach: { customers: number; picks: number; sections: number; pool: number }|null; deployed: boolean }
export function productPage({ p, reasons, status, side, reach, deployed }: ProductView): string {
  const reasonRows = reasons.map((r) => { const x = RULES.find((k) => k.id === r); return [esc(x?.name ?? r), esc(x?.priority ?? ''), esc(x?.why ?? '')]; });
  const count = reach ? `In the picks of ${reach.picks}, the sections of ${reach.sections} and the allowed pool of ${reach.pool} of ${reach.customers} customers, at the active versions.` : deployed ? 'Customers are not counted on the link: it ranks nothing.' : 'Customers are not counted: no inputs are published.';
  const rows: [string, string][] = [['Status', STATUS[status]], ['Published', date(p.published_at)], ['Category', p.category.join(', ')], ['Class', p.class.join(', ')], ['Gender', p.gender ?? ''], ['Sizes and colours on sale', `${p.variants.filter((x) => x.available).length} of ${p.variants.length}`]];
  return page(p.title, `<p class="eyebrow"><a href="/review/catalog">Catalog</a> · ${esc(p.id)}</p><h1>${esc(p.title)}</h1><p><a href="${esc(p.url)}" rel="noopener" target="_blank">${esc(p.url)}</a></p>
<p>${esc(count)}</p>${rows.map(([a, b]) => `<div class="row"><span>${esc(a)}</span><span>${esc(b)}</span></div>`).join('')}
<h2>Why it is out</h2>${reasonRows.length ? table(['Reason', 'Priority', 'Why'], reasonRows) : '<p class="note">No rule holds it back.</p>'}
<h2>Description</h2><p>${esc(side?.text || p.body_text_clean || 'None left after cleaning.')}</p><h2>Images</h2><div class="gallery">${p.images.map((i) => `<img loading="lazy" src="${esc(i.src)}" alt="${esc(p.title)}">`).join('') || '<p class="note">None.</p>'}</div>
<h2>Raw tags</h2><p class="tags">${side ? esc(side.tags.join(' · ')) : 'The side file is not published. Run the build with --publish.'}</p>`);
}
