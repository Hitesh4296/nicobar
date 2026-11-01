// Filter search over an inverted index (R141). Pure. OR within a family, AND across families.
import type { Product } from '../../contracts/types.ts';

export type Filters = Record<string, string[]>;
export interface Query { all: Filters; not?: Filters; sort?: 'merchandising' }
export interface SearchIndex { ids: string[]; products: Map<string, Product>; postings: Map<string, Set<string>> }

const at = (family: string, value: string) => `${family}\0${value}`;

export function buildIndex(usable: Product[]): SearchIndex {
  const postings = new Map<string, Set<string>>();
  for (const p of usable) for (const [f, vals] of Object.entries(p.facets ?? {})) for (const v of vals) {
    const k = at(f, v), s = postings.get(k);
    if (s) s.add(p.id); else postings.set(k, new Set([p.id]));
  }
  return { ids: usable.map((p) => p.id), products: new Map(usable.map((p) => [p.id, p])), postings };
}

export const known = (index: SearchIndex, family: string, value: string) => index.postings.has(at(family, value));
const union = (index: SearchIndex, family: string, vals: string[]) => new Set(vals.flatMap((v) => [...(index.postings.get(at(family, v)) ?? [])]));
/** Best place in any collection, bestsellers apart. No place sorts last. */
const place = (p: Product) => Math.min(...Object.values(p.merch_rank ?? {}), Infinity);

export function search(q: Query, index: SearchIndex): { ids: string[]; count: number } {
  const ins = Object.entries(q.all).filter(([, v]) => v.length).map(([f, v]) => union(index, f, v));
  const outs = Object.entries(q.not ?? {}).map(([f, v]) => union(index, f, v));
  const ids = index.ids.filter((id) => ins.every((s) => s.has(id)) && !outs.some((s) => s.has(id)));
  if (q.sort === 'merchandising') ids.sort((a, b) => place(index.products.get(a)!) - place(index.products.get(b)!));
  return { ids, count: ids.length };
}

/** Each value's count with that family's own selection set aside, so a chip says what choosing it would give. */
export function counts(q: Query, index: SearchIndex): Record<string, { value: string; count: number }[]> {
  const out: Record<string, { value: string; count: number }[]> = {};
  const by = new Map<string, Map<string, number>>();
  const families = new Set([...index.postings.keys()].map((k) => k.split('\0')[0]));
  for (const f of families) {
    const { [f]: _, ...rest } = q.all, m = new Map<string, number>();
    by.set(f, m);
    for (const id of search({ ...q, all: rest }, index).ids) for (const v of index.products.get(id)!.facets?.[f] ?? []) m.set(v, (m.get(v) ?? 0) + 1);
  }
  for (const [f, m] of by) out[f] = [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  return out;
}

/** The result with counts per filter value, for the route. */
export function readProducts(q: Query, index: SearchIndex) { return { ...search(q, index), counts: counts(q, index) }; }

const PAGING = new Set(['limit', 'offset', 'sort']);
/** `?occasion=Wedding&class=Kurta&class=Dupatta&not.pattern=Solid`. */
export function queryOfParams(p: URLSearchParams): Query {
  const q: Query = { all: {}, not: {} };
  for (const [k, v] of p) {
    if (PAGING.has(k)) continue;
    const into = k.startsWith('not.') ? q.not! : q.all;
    (into[k.replace(/^not\./, '')] ??= []).push(v);
  }
  if (p.get('sort') === 'merchandising') q.sort = 'merchandising';
  return q;
}
