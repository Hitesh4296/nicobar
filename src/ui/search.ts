// /review/search. Every value from a row or a query passes through esc.
import type { Product } from '../contracts/types.ts';
import type { Query } from '../lib/search/index.ts';
import { esc, shell } from './agents/index.ts';

export interface SearchView { query: Query; count: number; counts: Record<string, { value: string; count: number }[]>; rows: (Product & { tags: string[] })[] }
const CSS = `<style>.fam{margin:12px 0}.fam b{display:block;font-weight:500}.chip{display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border:1px solid var(--line);font-size:14px;line-height:20px;text-decoration:none;color:var(--ink)}.chip.on{background:var(--ink);color:#fff}
.hit{display:grid;grid-template-columns:80px minmax(0,1fr);gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.hit small{display:block;color:var(--soft);font-size:12px;line-height:16px;overflow-wrap:anywhere}</style>`;
const CHIPS = 30;

/** The link with this value switched on or off. */
function toggled(q: Query, family: string, value: string): string {
  const p = new URLSearchParams();
  for (const [f, vs] of Object.entries(q.all)) for (const v of vs) if (!(f === family && v === value)) p.append(f, v);
  if (!q.all[family]?.includes(value)) p.append(family, value);
  return `/review/search?${p}`;
}

export function searchPage(v: SearchView): string {
  const chip = (f: string, x: { value: string; count: number }) => `<a class="chip${v.query.all[f]?.includes(x.value) ? ' on' : ''}" href="${esc(toggled(v.query, f, x.value))}">${esc(x.value)} ${esc(x.count)}</a>`;
  const fams = Object.entries(v.counts).map(([f, xs]) => `<div class="fam"><b>${esc(f)}</b>${xs.slice(0, CHIPS).map((x) => chip(f, x)).join('')}</div>`).join('');
  const hits = v.rows.map((p) => { const i = p.images[0]; return `<div class="hit" data-id="${esc(p.id)}">${i ? `<img src="${esc(i.src_canonical)}?width=160" alt="${esc(p.title)}" width="80" loading="lazy">` : '<span></span>'}<div>${esc(p.title)}<small>${esc(p.tags.join(' · '))}</small></div></div>`; }).join('');
  return shell('Search', `${CSS}<div class="eyebrow">Agents · Search</div><h1>Search the catalog</h1><p>Filters are Nicobar's own tags. <b>${esc(v.count)}</b> products.</p><h2>Filters</h2>${fams}<h2>Results</h2>${hits || '<p>No product matches.</p>'}`);
}
