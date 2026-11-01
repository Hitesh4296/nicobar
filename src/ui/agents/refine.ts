// The Refine ranking screen. Everything from a row, a query or a catalog passes through esc.
import { lineDiff } from '../../lib/config/index.ts';
import { plainSignal } from '../evidence.ts';
import type { ConfigVersion, Pick as PlanPick, Weights } from '../../contracts/types.ts';
import { diffBlock, esc, shell, table, tag } from './index.ts';

const FIELDS: [keyof Weights, string, string][] = [['occasion', 'Occasion', 'The product is tagged for this occasion, or fits this kind of trip'], ['season', 'Season', 'In the current season on the site'],
  ['bestseller', 'Bestseller', "A gift bestseller on the site; counts on gift rows only"], ['new', 'New', 'New on the site'], ['past', 'Past purchase', 'Goes with something they bought']];
const GUARDS = [['The first product fits the occasion', 'The email and page lead with it, so no score can put an off-occasion product there.'], ['A past purchase never leads', 'The occasion comes first. Past-only products may follow, never open.'],
  ['One product per kind', 'Keeps the row varied.'], ['At most two from one family', 'Keeps a row from being all jewellery while the pool allows it.'], ['No mixing of men\'s and women\'s products', 'A row follows what the customer told us, and only that.'],
  ['Past purchase stays below occasion, and occasion is above 0', 'A save that breaks this is refused.'], ['Set rows do not move', 'Six travel and scene customers and the new customer have set picks. Weights reorder only their sections.']];

export type PreviewPick = Pick<PlanPick, 'product_id'|'score'|'why'> & { title: string };
export interface PreviewRow { customer_id: string; occasion: string|null; kind: 'unchanged'|'sections'|'picks'; before: PreviewPick[]; after: PreviewPick[]; from: string; usd: number|null }
export interface PreviewView { rows: PreviewRow[]; basedOn: string; usd: number|null; unpriced: number }
export interface RefineView { weights: Weights; versions: ConfigVersion[]; customers: string[]; only: string; note: string; error: string|null; preview: PreviewView|null; deployed: boolean; locked: boolean }

const CSS = `<style>.w{display:grid;grid-template-columns:140px minmax(0,1fr) 96px;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}.w small{display:block;color:var(--soft);font-size:14px;line-height:20px}.w input{margin:0}.w input[type=range]{padding:0;border:0;accent-color:var(--ink)}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}.metrics div{border:1px solid var(--line);padding:8px 12px;font-size:14px;line-height:20px;color:var(--soft)}.metrics b{display:block;font-weight:500;font-size:24px;line-height:32px;color:var(--ink)}
select{padding:10px;border:1px solid var(--line);font:inherit;background:#fff}.pk{margin:0 0 8px}.pk small{display:block;color:var(--soft);font-size:12px;line-height:16px}details{margin:8px 0}summary{cursor:pointer}@media(max-width:750px){.w{grid-template-columns:1fr}}</style>`;
const SCRIPT = `<script>for(const r of document.querySelectorAll('.w')){const[a,b]=r.querySelectorAll('input');a.oninput=()=>{b.value=a.value};b.oninput=()=>{a.value=b.value}}</script>`;

const money = (n: number) => `$${n.toFixed(4)}`;
const pretty = (w: Weights) => FIELDS.map(([k, label]) => `${label}: ${w[k]}`).join('\n');
const WORD = { unchanged: 'Unchanged', sections: 'Sections only', picks: 'Picks changed, needs a redraft' };

const pick = (p: PreviewPick) => `<p class="pk">${esc(p.title)}${p.score === undefined ? '' : ` · ${esc(p.score)}`}<small>${esc((p.why ?? []).map(plainSignal).join(' · '))}</small></p>`;

function previewBlock(p: PreviewView): string {
  const n = (k: PreviewRow['kind']) => p.rows.filter((r) => r.kind === k).length;
  const cost = p.usd === null ? 'not stored' : money(p.usd);
  const rows = p.rows.map((r) => [`<strong>${esc(r.customer_id)}</strong><br>${esc(r.occasion ?? '')}`, esc(WORD[r.kind]), r.kind === 'picks' ? r.before.map(pick).join('') : '<span class="fine">Same picks</span>', r.after.map(pick).join(''), r.kind === 'picks' ? (r.usd === null ? 'not stored' : money(r.usd)) : '$0']);
  return `<h2>Preview</h2><div class="metrics"><div><b>${n('unchanged')}</b>Unchanged</div><div><b>${n('sections')}</b>Sections only</div><div><b>${n('picks')}</b>Picks changed</div><div><b>${cost}</b>Estimated redraft</div></div>
<p class="fine">${esc(p.basedOn)}${p.unpriced ? ` ${p.unpriced} changed customers have no stored estimate and are not in the total.` : ''} Nothing was saved and nothing was spent.</p>
${table(['Customer', 'Result', 'Before', 'After, with score', 'Redraft'], rows)}`;
}

function history(vs: ConfigVersion[]): string {
  if (!vs.length) return '<p>No version yet. Run <code>npm run config seed</code> against the local Worker.</p>';
  const by = new Map(vs.map((v) => [v.id, v]));
  const qs = (v: ConfigVersion) => new URLSearchParams(Object.entries(v.content as Weights).map(([k, x]) => [k, String(x)])).toString();
  const rows = vs.map((v) => {
    const parent = v.parent_id ? by.get(v.parent_id) : null;
    const diff = parent ? `<details><summary>Against ${esc(parent.id)}</summary>${diffBlock(lineDiff(pretty(parent.content as Weights), pretty(v.content as Weights)))}</details>` : '<span class="fine">First version</span>';
    return [`${esc(v.id)} ${tag(v.status)}`, esc(v.note), `${esc(v.created_by)}<br>${esc(v.created_at.slice(0, 16).replace('T', ' '))}`, diff, `<a href="/review/agents/refine?${esc(qs(v))}">Load</a>`];
  });
  return table(['Version', 'Note', 'Saved by', 'Change', ''], rows);
}

function activate(vs: ConfigVersion[], locked: boolean): string {
  const drafts = vs.filter((v) => v.status === 'draft');
  if (!drafts.length) return '';
  if (locked) return '<p class="fine">Runs are locked: no run key is set on this server, so no version can be activated.</p>';
  return `<h2>Activate for next run</h2><form method="post" action="/review/agents/refine/activate"><label>Version <select name="id">${drafts.map((v) => `<option>${esc(v.id)}</option>`).join('')}</select></label><label>Run key<input type="password" name="run_key" autocomplete="off" required></label><button class="primary">Activate for next run</button></form>`;
}

export function refinePage(p: RefineView): string {
  const ro = p.deployed ? ' disabled' : '';
  const active = p.versions.find((v) => v.status === 'active');
  const fields = FIELDS.map(([k, label, hint]) => `<div class="w"><label for="w-${k}">${label}<small>${esc(hint)}</small></label><input type="range" min="0" max="200" step="1" value="${esc(p.weights[k])}" aria-label="${label} slider"${ro}><input id="w-${k}" type="number" name="${k}" min="0" step="1" value="${esc(p.weights[k])}"${ro}></div>`).join('');
  const choose = `<label>Customer <select name="only"><option value="">All</option>${p.customers.map((id) => `<option${id === p.only ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label>`;
  const form = `<form method="get" action="/review/agents/refine">${fields}${p.deployed ? '' : `${choose}<button class="primary" name="preview" value="1">Preview</button><span class="fine">Free. Saves nothing.</span>
<label>Note, to save<input name="note" value="${esc(p.note)}" placeholder="What changed, and why"></label><button formmethod="post" formaction="/review/agents/refine/save">Save draft</button>`}</form>`;
  return shell('Refine ranking', `${CSS}<div class="eyebrow">Agents · Ranking</div><h1>Refine ranking</h1>
<p>Products are first filtered for each customer, then scored by these weights, then held to fixed rules. Change a weight, preview what moves, then save it as a new version.${p.deployed ? ' Read-only here.' : ''}</p>
${p.error ? `<p id="err" role="alert" class="fail">${esc(p.error)}</p>` : ''}<h2>Weights</h2>${form}${p.preview ? previewBlock(p.preview) : ''}
<h2>Fixed rules</h2>${table(['Rule', 'Why'], GUARDS.map(([a, b]) => [esc(a), esc(b)]))}
<p class="fine">A new version applies to new runs only. Applying one to a run already written would need a third draft version, which the store does not allow.</p>
${p.deployed ? '' : activate(p.versions, p.locked)}<h2>Active version</h2>${active ? `<p>${esc(active.id)}, activated by ${esc(active.activated_by)} at ${esc(active.activated_at?.slice(0, 16).replace('T', ' '))}. ${esc(pretty(active.content as Weights).replaceAll('\n', ', '))}.</p>` : '<p>None yet.</p>'}
<h2>Version history</h2>${history(p.versions)}${p.deployed ? '' : SCRIPT}`);
}
